// SPDX-License-Identifier: Apache-2.0
// @allow-throw: RPC handler module — all throws are caught and converted to JSON-RPC error responses by rpc-dispatch.ts:306-321.
/**
 * Graph mutation RPC handlers.
 *
 * Write-side handlers that produce/modify execution graphs:
 *   - graph.define, graph.execute, graph.cancel
 *   - graph.save, graph.delete, graph.deleteRun
 *
 * Pure helpers (transformNodes, validateGraphWarnings, schemaToExample,
 * buildGraphInput, validateTypeConfigs) live in `graph-helpers.ts` to keep
 * this file under the per-file line cap.
 *
 * @module
 */

import { randomUUID } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import {
  safePath,
  GraphDefineContract,
  GraphExecuteContract,
  GraphCancelContract,
  GraphSaveContract,
  GraphDeleteContract,
  GraphDeleteRunContract,
  stripInternalFields,
  systemNowMs,
} from "@comis/core";
import { extractUserVariables, substituteUserVariables } from "../../graph/user-variables.js";
import type { RpcHandler } from "../types.js";
import {
  IS_DEV,
  type GraphHandlerDeps,
  buildGraphInput,
  validateGraphWarnings,
  validateTypeConfigs,
} from "./graph-helpers.js";

// ---------------------------------------------------------------------------
// Mutation handlers
// ---------------------------------------------------------------------------

/**
 * Bind the write-side graph RPC handlers (define / execute / cancel / save /
 * delete / deleteRun). Object-spread compatible with `Record<string, RpcHandler>`.
 */
export function bindGraphMutateHandlers(deps: GraphHandlerDeps): Record<string, RpcHandler> {
  // TELEM-01 (Phase 173-02): emit a counts-only `pipeline:authored` per
  // authoring invocation (define + execute), where schema validity and the
  // resolved capabilityClass tier converge. Counts/ids/closed-enums ONLY — no
  // node task, type_config value, label, or any pipeline body reaches the bus
  // (§2.7 / D-EVENT). The tier is resolved DAEMON-SIDE from the RAW _agentId
  // (Spoofing mitigation T-173-03) via the injected resolver — never a
  // tool-supplied param — and fail-safes to "unknown" when unresolvable
  // (Pitfall 2: record honestly, never silently drop, never default to
  // "frontier"). `repaired` is the literal false: the weak-model repair
  // producer is Phase 174 / AUTHOR-01 and is NOT wired here.
  const emitPipelineAuthored = (
    action: "define" | "execute",
    schemaValid: boolean,
    rawParams: Record<string, unknown>,
  ): void => {
    // WR-01 (Phase 173 review): the emit MUST be best-effort — telemetry can
    // never break the operation it measures. `deps.eventBus.emit` delegates to
    // Node's EventEmitter with NO listener error isolation, and the subscribed
    // `pipeline:authored` listener pushes into the obs diagnostic buffer whose
    // synchronous SQLite flush (on its 50th item) can throw SQLITE_BUSY/FULL/
    // disk-error. On the SUCCESS path this emit is called OUTSIDE the handler's
    // buildGraphInput try (and, for graph.execute, BEFORE graphCoordinator.run),
    // so an unguarded throw here would fail a VALID graph.define/execute purely
    // because a telemetry insert failed — and on the invalid path it would mask
    // the user-facing graph-validation error. Swallow any emit throw and log it
    // at WARN (hint + errorKind) so the measured operation always proceeds.
    try {
      const capabilityClass =
        deps.resolveCapabilityClass?.(rawParams._agentId as string | undefined) ?? "unknown";
      deps.eventBus?.emit("pipeline:authored", {
        action,
        capabilityClass,
        schemaValid,
        repaired: false,
        agentId: rawParams._agentId as string | undefined,
        sessionKey: rawParams._callerSessionKey as string | undefined,
        timestamp: systemNowMs(),
      });
    } catch (err) {
      deps.logger?.warn(
        {
          err,
          action,
          errorKind: "internal" as const,
          hint: "pipeline:authored telemetry emit failed (likely an obs-buffer SQLite flush throw); the graph operation proceeds unaffected",
        },
        "pipeline-authoring telemetry emit failed (best-effort)",
      );
    }
  };

  return {
    [GraphDefineContract.method]: async (rawParams) => {
      // Bespoke pre-Zod validation FIRST (preserves user-friendly error
      // messages matching existing handler-test assertions —
      // "Missing required parameter: nodes" rather than Zod's JSON dump).
      const rawNodes = rawParams.nodes as unknown[];
      if (!rawNodes || !Array.isArray(rawNodes) || rawNodes.length === 0) {
        throw new Error("Missing required parameter: nodes");
      }

      const userParams = stripInternalFields(rawParams);
      GraphDefineContract.request.parse(userParams);

      // O3 (WR-01) producer deferred to Phase 157: no current producer sets
      // capabilityClass on graph RPC params — it is absent from the contract
      // request schema and the pipeline tool does not send it. Until Phase 157
      // wires the producer (the resolved-ModelProfile capabilityClass threaded
      // from the agent's rpcCall boundary) AND the matching weak-model repair
      // consumer (see buildGraphInput / repairDagWithBoundedRetries in
      // graph-helpers.ts), this is always undefined → the capable direct-emit
      // path. The read is intentionally retained so the producer wiring is a
      // single localized change in Phase 157.
      const capabilityClass = userParams.capabilityClass as
        "frontier" | "mid" | "small" | "nano" | undefined;
      // TELEM-01: capture the REAL buildGraphInput parse+validate verdict.
      // buildGraphInput THROWS on parse/validate failure — emit schemaValid:false
      // and re-throw (the existing user-facing error contract is unchanged);
      // on success emit schemaValid:true BEFORE the later type_config/warning
      // logic so a valid-but-otherwise-rejected call still counts as authored.
      let validated;
      try {
        validated = buildGraphInput(userParams, capabilityClass);
      } catch (e) {
        emitPipelineAuthored("define", false, rawParams);
        throw e;
      }
      emitPipelineAuthored("define", true, rawParams);
      validateTypeConfigs(validated.graph, deps.nodeTypeRegistry);
      const { warnings, errors } = validateGraphWarnings(validated.graph);

      const result = {
        valid: true,
        nodeCount: validated.graph.nodes.length,
        executionOrder: validated.executionOrder,
        label: validated.graph.label,
        warnings,
        errors,
        userVariables: extractUserVariables(validated.graph.nodes),
      };
      if (IS_DEV) GraphDefineContract.response.parse(result);
      return result;
    },

    [GraphExecuteContract.method]: async (rawParams) => {
      // Bespoke pre-Zod validation FIRST.
      if (!deps.securityConfig.agentToAgent?.enabled) {
        throw new Error("Agent-to-agent messaging is disabled by policy.");
      }

      const userParams = stripInternalFields(rawParams);
      GraphExecuteContract.request.parse(userParams);

      // O3 (WR-01) producer deferred to Phase 157 — see graph.define above.
      // No producer sets capabilityClass yet, so this is always undefined →
      // capable direct-emit path. Retained as the single Phase-157 wiring point.
      const capabilityClass = userParams.capabilityClass as
        "frontier" | "mid" | "small" | "nano" | undefined;
      // TELEM-01: same try/catch verdict capture as graph.define — emit
      // schemaValid:false on a parse/validate throw (still re-throwing), true
      // on success, before the coordinator dispatch.
      let validated;
      try {
        validated = buildGraphInput(userParams, capabilityClass);
      } catch (e) {
        emitPipelineAuthored("execute", false, rawParams);
        throw e;
      }
      emitPipelineAuthored("execute", true, rawParams);
      validateTypeConfigs(validated.graph, deps.nodeTypeRegistry);

      // Apply user-variable substitution if variables provided
      const variables = userParams.variables as Record<string, string> | undefined;
      let finalValidated = validated;
      if (variables && Object.keys(variables).length > 0) {
        const substitutedNodes = validated.graph.nodes.map((node) => ({
          ...node,
          task: substituteUserVariables(node.task, variables),
        }));
        finalValidated = {
          graph: { ...validated.graph, nodes: substitutedNodes },
          executionOrder: validated.executionOrder,
        };
      }

      // Check for unresolved variables AFTER substitution (execute-time only)
      const unresolvedWarnings: Array<{ nodeId: string; type: string; message: string; fix: string }> = [];
      const varPattern = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
      for (const node of finalValidated.graph.nodes) {
        varPattern.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = varPattern.exec(node.task)) !== null) {
          unresolvedWarnings.push({
            nodeId: node.nodeId,
            type: "unresolved_variable",
            message: `Node "${node.nodeId}" has unresolved variable \${${match[1]}} -- provide a value in the variables parameter`,
            fix: `Provide a value for "${match[1]}" in the variables parameter, or remove the \${${match[1]}} placeholder.`,
          });
        }
      }

      // Pre-execution channel validation for approval-gate nodes
      const hasApprovalGate = finalValidated.graph.nodes.some(n => n.typeId === "approval-gate");
      if (hasApprovalGate) {
        const announceChannelType = rawParams._callerChannelType as string | undefined;
        const announceChannelId = rawParams._callerChannelId as string | undefined;
        if (!announceChannelType || !announceChannelId) {
          throw new Error(
            "Graph contains approval-gate nodes but no announcement channel is configured. " +
            "The graph must be triggered from a channel context (Telegram, Discord, etc.)."
          );
        }
      }

      const coordResult = await deps.graphCoordinator.run({
        graph: finalValidated,
        callerSessionKey: rawParams._callerSessionKey as string | undefined,
        callerAgentId: rawParams._agentId as string | undefined,
        announceChannelType: rawParams._callerChannelType as string | undefined,
        announceChannelId: rawParams._callerChannelId as string | undefined,
        nodeProgress: userParams.node_progress === true,
      });

      if (!coordResult.ok) {
        throw new Error(coordResult.error);
      }

      const graphId = coordResult.value;

      deps.logger?.info(
        { graphId, nodeCount: finalValidated.graph.nodes.length, method: "graph.execute" },
        "Graph execution started",
      );

      const result: Record<string, unknown> = {
        graphId,
        async: true,
        nodeCount: finalValidated.graph.nodes.length,
        label: finalValidated.graph.label,
        hint: "Pipeline launched — your job is now DONE. Tell the user the pipeline is running (and what it will produce), then STOP. Do NOT research this topic yourself, do NOT call more tools, and do NOT poll with status/cron: the sub-agents are doing the work in isolated contexts and you will be notified automatically with results when it completes. Duplicating their research here only exhausts your own context window.",
        ...(unresolvedWarnings.length > 0 && { warnings: unresolvedWarnings }),
      };
      if (IS_DEV) GraphExecuteContract.response.parse(result);
      return result;
    },

    [GraphCancelContract.method]: async (rawParams) => {
      // Bespoke pre-Zod validation FIRST.
      if (!deps.securityConfig.agentToAgent?.enabled) {
        throw new Error("Agent-to-agent messaging is disabled by policy.");
      }

      const cancelGraphId = rawParams.graphId ?? rawParams.graph_id;
      if (!cancelGraphId) {
        throw new Error("Missing required parameter: graphId");
      }

      const userParams = stripInternalFields(rawParams);
      GraphCancelContract.request.parse(userParams);

      const cancelled = deps.graphCoordinator.cancel(cancelGraphId as string);
      if (!cancelled) {
        throw new Error("Graph not found or already terminal");
      }

      deps.logger?.info(
        { graphId: cancelGraphId, method: "graph.cancel" },
        "Graph cancelled",
      );

      const result = { cancelled: true, graphId: cancelGraphId as string };
      if (IS_DEV) GraphCancelContract.response.parse(result);
      return result;
    },

    // -----------------------------------------------------------------
    // Named graph persistence
    // -----------------------------------------------------------------

    [GraphSaveContract.method]: async (rawParams) => {
      // Bespoke pre-Zod validation FIRST.
      if (!deps.namedGraphStore) {
        throw new Error("Named graph storage not available");
      }

      const label = rawParams.label as string | undefined;
      if (!label || typeof label !== "string" || label.trim().length === 0) {
        throw new Error("Missing required parameter: label (non-empty string)");
      }

      const userParams = stripInternalFields(rawParams);
      GraphSaveContract.request.parse(userParams);

      const id = (rawParams.id as string) ?? randomUUID();
      const tenantId = deps.tenantId ?? "default";
      const agentId = (rawParams.agentId as string) ?? deps.defaultAgentId;

      // Validate structure (typeId/typeConfig pairing, DAG sort, Zod schema)
      // O3 (WR-01) producer deferred to Phase 157 — see graph.define above.
      // Always undefined today → capable direct-emit path.
      const capabilityClass = userParams.capabilityClass as
        "frontier" | "mid" | "small" | "nano" | undefined;
      const validated = buildGraphInput(userParams, capabilityClass);
      validateTypeConfigs(validated.graph, deps.nodeTypeRegistry);

      deps.namedGraphStore.save({
        id,
        tenantId,
        agentId,
        label: label.trim(),
        nodes: (rawParams.nodes as unknown[]) ?? [],
        edges: (rawParams.edges as unknown[]) ?? [],
        settings: rawParams.settings ?? {},
      });

      const result = { id, saved: true };
      if (IS_DEV) GraphSaveContract.response.parse(result);
      return result;
    },

    [GraphDeleteContract.method]: async (rawParams) => {
      // Bespoke pre-Zod validation FIRST.
      if (!deps.namedGraphStore) {
        throw new Error("Named graph storage not available");
      }

      const id = rawParams.id as string | undefined;
      if (!id) {
        throw new Error("Missing required parameter: id");
      }

      const userParams = stripInternalFields(rawParams);
      GraphDeleteContract.request.parse(userParams);

      const tenantId = deps.tenantId ?? "default";
      const deleted = deps.namedGraphStore.softDelete(id, tenantId);
      if (!deleted) {
        throw new Error("Named graph not found");
      }

      const result = { id, deleted: true };
      if (IS_DEV) GraphDeleteContract.response.parse(result);
      return result;
    },

    [GraphDeleteRunContract.method]: async (rawParams) => {
      // Bespoke pre-Zod validation FIRST.
      const graphId = rawParams.graphId ?? rawParams.graph_id;
      if (!graphId || typeof graphId !== "string") {
        throw new Error("Missing required parameter: graphId");
      }

      if (!deps.dataDir) {
        throw new Error("dataDir not configured — cannot delete graph run");
      }

      const userParams = stripInternalFields(rawParams);
      GraphDeleteRunContract.request.parse(userParams);

      const graphDir = safePath(deps.dataDir, "graph-runs", graphId);
      if (!existsSync(graphDir)) {
        throw new Error("Graph run not found");
      }

      rmSync(graphDir, { recursive: true, force: true });

      const result = { graphId, deleted: true };
      if (IS_DEV) GraphDeleteRunContract.response.parse(result);
      return result;
    },
  };
}
