// SPDX-License-Identifier: Apache-2.0
// @allow-throw: RPC handler module — all throws are caught and converted to JSON-RPC error responses by rpc-dispatch.ts:306-321.
/**
 * Graph query RPC handlers.
 *
 * Read-side handlers that report graph status / history without mutation:
 *   - graph.status (per-graphId snapshot OR recent-graphs list)
 *   - graph.list (named graph persistence: list saved graphs)
 *   - graph.outputs (in-memory snapshot OR disk fallback)
 *   - graph.runs (graph-runs directory enumeration)
 *   - graph.runDetail (full per-graph file detail)
 *
 * @module
 */

import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import {
  safePath,
  GraphStatusContract,
  GraphListContract,
  GraphOutputsContract,
  GraphRunsContract,
  GraphRunDetailContract,
  stripInternalFields,
  systemDateFrom,
} from "@comis/core";
import type { RpcHandler } from "../types.js";
import { IS_DEV, type GraphHandlerDeps } from "./graph-helpers.js";

// ---------------------------------------------------------------------------
// Query handlers
// ---------------------------------------------------------------------------

/**
 * Bind the read-side graph RPC handlers (status / list / outputs / runs /
 * runDetail). Object-spread compatible with `Record<string, RpcHandler>`.
 *
 * Note: `graph.outputs` performs a self-recursion to handle the label-fallback
 * case. The closure captures the local `handlers` map so the recursion
 * preserves byte-identical behavior post-split.
 */
export function bindGraphQueryHandlers(deps: GraphHandlerDeps): Record<string, RpcHandler> {
  const handlers: Record<string, RpcHandler> = {
    [GraphStatusContract.method]: async (rawParams) => {
      const userParams = stripInternalFields(rawParams);
      GraphStatusContract.request.parse(userParams);

      const graphId = userParams.graphId ?? userParams.graph_id;

      if (graphId) {
        const snapshot = deps.graphCoordinator.getStatus(graphId as string);
        if (!snapshot) {
          throw new Error("Graph not found");
        }

        // Convert Map<string, NodeExecutionState> to Record for JSON serialization
        const serializedNodes: Record<string, unknown> = Object.fromEntries(
          [...snapshot.nodes.entries()].map(([id, state]) => [
            id,
            {
              status: state.status,
              runId: state.runId,
              output: state.output
                ? state.output.length > 500
                  ? state.output.slice(0, 500) + "... [truncated]"
                  : state.output
                : undefined,
              error: state.error,
              startedAt: state.startedAt,
              completedAt: state.completedAt,
              durationMs:
                state.completedAt && state.startedAt
                  ? state.completedAt - state.startedAt
                  : undefined,
            },
          ]),
        );

        // Compute aggregate stats
        let completed = 0;
        let failed = 0;
        let skipped = 0;
        let running = 0;
        let pending = 0;
        const total = snapshot.nodes.size;

        for (const state of snapshot.nodes.values()) {
          switch (state.status) {
            case "completed": completed++; break;
            case "failed": failed++; break;
            case "skipped": skipped++; break;
            case "running": running++; break;
            case "pending":
            case "ready":
              pending++; break;
          }
        }

        const result = {
          graphId,
          status: snapshot.graphStatus,
          isTerminal: snapshot.isTerminal,
          executionOrder: snapshot.executionOrder,
          nodes: serializedNodes,
          stats: { total, completed, failed, skipped, running, pending },
        };
        if (IS_DEV) GraphStatusContract.response.parse(result);
        return result;
      }

      // No graphId: list recent graphs + concurrency stats
      const summaries = deps.graphCoordinator.listGraphs(
        userParams.recentMinutes as number | undefined,
      );
      const concurrency = deps.graphCoordinator.getConcurrencyStats();
      const result = { graphs: summaries, concurrency };
      if (IS_DEV) GraphStatusContract.response.parse(result);
      return result;
    },

    [GraphListContract.method]: async (rawParams) => {
      // Bespoke pre-Zod validation FIRST.
      if (!deps.namedGraphStore) {
        throw new Error("Named graph storage not available");
      }

      const userParams = stripInternalFields(rawParams);
      const params = GraphListContract.request.parse(userParams);

      const tenantId = deps.tenantId;
      const listResult = deps.namedGraphStore.list(tenantId, {
        limit: params.limit,
        offset: params.offset,
      });

      const result = { entries: listResult.entries, total: listResult.total };
      if (IS_DEV) GraphListContract.response.parse(result);
      return result;
    },

    // -----------------------------------------------------------------
    // Graph output retrieval
    // -----------------------------------------------------------------

    [GraphOutputsContract.method]: async (rawParams) => {
      // Bespoke pre-Zod validation FIRST.
      const graphId = rawParams.graphId ?? rawParams.graph_id;
      if (!graphId || typeof graphId !== "string") {
        throw new Error("Missing required parameter: graphId");
      }

      const userParams = stripInternalFields(rawParams);
      GraphOutputsContract.request.parse(userParams);

      const maxLen = 12000; // Same as coordinator's maxResultLength default

      // Try in-memory first (graph still in coordinator's retention window)
      const snapshot = deps.graphCoordinator.getStatus(graphId);
      if (snapshot) {
        const outputs: Record<string, string | null> = {};
        for (const [nodeId, state] of snapshot.nodes) {
          if (state.output !== undefined) {
            outputs[nodeId] = state.output.length > maxLen
              ? state.output.slice(0, maxLen) + "... [truncated]"
              : state.output;
          } else {
            outputs[nodeId] = null;
          }
        }
        const result = { graphId, outputs, source: "memory" };
        if (IS_DEV) GraphOutputsContract.response.parse(result);
        return result;
      }

      // Disk fallback: read graph-runs/<graphId>/*-output.md
      if (!deps.dataDir) {
        // Try label match even without dataDir
        const recentGraphs = deps.graphCoordinator.listGraphs();
        const byLabel = recentGraphs.find(
          (g) => g.label?.toLowerCase() === graphId.toLowerCase(),
        );
        if (byLabel) {
          return handlers[GraphOutputsContract.method]!({ graphId: byLabel.graphId });
        }
        throw new Error("Graph not found (no in-memory snapshot and no dataDir configured)");
      }

      const graphDir = safePath(deps.dataDir, "graph-runs", graphId);
      if (!existsSync(graphDir)) {
        // Label fallback: check if graphId matches a recent graph's label
        const recentGraphs = deps.graphCoordinator.listGraphs();
        const byLabel = recentGraphs.find(
          (g) => g.label?.toLowerCase() === graphId.toLowerCase(),
        );
        if (byLabel) {
          // Recurse with resolved UUID (max depth 1 since UUID won't match label again)
          return handlers[GraphOutputsContract.method]!({ graphId: byLabel.graphId });
        }
        throw new Error("Graph not found");
      }

      const outputs: Record<string, string | null> = {};
      try {
        const files = readdirSync(graphDir).filter(f => f.endsWith("-output.md"));
        for (const file of files) {
          const nodeId = file.replace(/-output\.md$/, "");
          const content = readFileSync(safePath(graphDir, file), "utf8");
          outputs[nodeId] = content.length > maxLen
            ? content.slice(0, maxLen) + "... [truncated]"
            : content;
        }
      } catch {
        // Directory read failed -- return empty outputs gracefully
      }

      const result = { graphId, outputs, source: "disk" };
      if (IS_DEV) GraphOutputsContract.response.parse(result);
      return result;
    },

    // -----------------------------------------------------------------
    // Graph run history
    // -----------------------------------------------------------------

    [GraphRunsContract.method]: async (rawParams) => {
      // Bespoke pre-Zod validation FIRST.
      if (!deps.dataDir) {
        throw new Error("dataDir not configured — cannot read graph runs");
      }

      const userParams = stripInternalFields(rawParams);
      GraphRunsContract.request.parse(userParams);

      const runsDir = safePath(deps.dataDir, "graph-runs");
      if (!existsSync(runsDir)) {
        const result = { runs: [] };
        if (IS_DEV) GraphRunsContract.response.parse(result);
        return result;
      }

      const entries = readdirSync(runsDir, { withFileTypes: true });
      const runs: Array<{
        graphId: string;
        name: string;
        status: "completed" | "failed";
        nodeCount: number;
        date: string;
        fileCount: number;
      }> = [];

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        try {
          const graphId = entry.name;
          const graphDir = safePath(runsDir, graphId);
          const dirStat = statSync(graphDir);
          const files = readdirSync(graphDir);
          const fileCount = files.length;
          const nodeCount = files.filter((f) => f.endsWith("-output.md")).length;
          const hasError = files.some((f) => f.includes("-error"));
          const status: "completed" | "failed" = hasError ? "failed" : "completed";

          // Derive name from ticker patterns in filenames
          const tickerCounts = new Map<string, number>();
          for (const f of files) {
            if (f.endsWith("-output.md")) continue;
            const matches = f.match(/[A-Z]{2,5}/g);
            if (matches) {
              for (const ticker of matches) {
                tickerCounts.set(ticker, (tickerCounts.get(ticker) ?? 0) + 1);
              }
            }
          }
          let name: string;
          if (tickerCounts.size > 0) {
            const sorted = [...tickerCounts.entries()].sort((a, b) => b[1] - a[1]);
            name = `${sorted[0]![0]} Analysis`;
          } else {
            name = graphId.slice(0, 8);
          }

          runs.push({ graphId, name, status, nodeCount, date: dirStat.mtime.toISOString(), fileCount });
        } catch {
          // Skip corrupted directories
        }
      }

      // Sort by date descending (most recent first)
      runs.sort((a, b) => systemDateFrom(b.date).getTime() - systemDateFrom(a.date).getTime());

      const result = { runs };
      if (IS_DEV) GraphRunsContract.response.parse(result);
      return result;
    },

    [GraphRunDetailContract.method]: async (rawParams) => {
      // Bespoke pre-Zod validation FIRST.
      const graphId = rawParams.graphId ?? rawParams.graph_id;
      if (!graphId || typeof graphId !== "string") {
        throw new Error("Missing required parameter: graphId");
      }

      if (!deps.dataDir) {
        throw new Error("dataDir not configured — cannot read graph run detail");
      }

      const userParams = stripInternalFields(rawParams);
      GraphRunDetailContract.request.parse(userParams);

      const graphDir = safePath(deps.dataDir, "graph-runs", graphId);
      if (!existsSync(graphDir)) {
        throw new Error("Graph run not found");
      }

      const dirStat = statSync(graphDir);
      const files = readdirSync(graphDir);
      const maxLen = 12000;

      // Group files into nodes
      const nodeMap = new Map<string, { output: string | null; artifacts: Array<{ filename: string; content: string }> }>();

      for (const file of files) {
        if (!file.endsWith(".md")) continue;

        const outputMatch = file.match(/^(.+)-output\.md$/);
        if (outputMatch) {
          const nodeId = outputMatch[1]!;
          if (!nodeMap.has(nodeId)) {
            nodeMap.set(nodeId, { output: null, artifacts: [] });
          }
          let content = readFileSync(safePath(graphDir, file), "utf8");
          if (content.length > maxLen) {
            content = content.slice(0, maxLen) + "... [truncated]";
          }
          nodeMap.get(nodeId)!.output = content;
          continue;
        }

        const artifactMatch = file.match(/^([^_]+)_(.+)\.md$/);
        if (artifactMatch) {
          const nodeId = artifactMatch[1]!;
          if (!nodeMap.has(nodeId)) {
            nodeMap.set(nodeId, { output: null, artifacts: [] });
          }
          let content = readFileSync(safePath(graphDir, file), "utf8");
          if (content.length > maxLen) {
            content = content.slice(0, maxLen) + "... [truncated]";
          }
          nodeMap.get(nodeId)!.artifacts.push({ filename: file, content });
        }
      }

      // Derive run name using same ticker logic
      const tickerCounts = new Map<string, number>();
      for (const f of files) {
        if (f.endsWith("-output.md")) continue;
        const matches = f.match(/[A-Z]{2,5}/g);
        if (matches) {
          for (const ticker of matches) {
            tickerCounts.set(ticker, (tickerCounts.get(ticker) ?? 0) + 1);
          }
        }
      }
      let name: string;
      if (tickerCounts.size > 0) {
        const sorted = [...tickerCounts.entries()].sort((a, b) => b[1] - a[1]);
        name = `${sorted[0]![0]} Analysis`;
      } else {
        name = graphId.slice(0, 8);
      }

      const hasError = files.some((f) => f.includes("-error"));
      const status: "completed" | "failed" = hasError ? "failed" : "completed";

      const nodes = [...nodeMap.entries()].map(([nodeId, data]) => ({
        nodeId,
        output: data.output,
        artifacts: data.artifacts,
      }));

      const result = {
        graphId,
        name,
        status,
        date: dirStat.mtime.toISOString(),
        nodes,
      };
      if (IS_DEV) GraphRunDetailContract.response.parse(result);
      return result;
    },
  };

  // The `GraphLoadContract` (graph.load — export/import roundtrip) lives in
  // `graph-export.ts`. The factory composes both bundles in `index.ts`.

  return handlers;
}
