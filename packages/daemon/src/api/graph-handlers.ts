// SPDX-License-Identifier: Apache-2.0
/**
 * Graph RPC handler module.
 * Handles execution graph lifecycle management RPC methods:
 *   graph.define, graph.execute, graph.status, graph.cancel, graph.outputs
 * Named graph persistence RPC methods:
 *   graph.save, graph.load, graph.list, graph.delete
 * Define validates a graph structure and returns node count and execution
 * order without executing. Execute validates then starts a GraphCoordinator
 * run. Status returns per-node state with Map-to-Object serialization and
 * aggregate stats. Cancel stops all running nodes and marks the graph as
 * cancelled.
 *
 * Phase 35 Wave C plan 35-18: refactored to computed-property keys
 * `[<Contract>.method]:` so the bidirectional 1:1 architecture test
 * resolves them to the registry. Per-method pipeline: bespoke pre-Zod
 * guards FIRST (using rawParams reads — preserves user-friendly error
 * messages matching the existing handler-test assertions) →
 * stripInternalFields → request.parse → existing business logic
 * UNCHANGED → dev-mode response.parse (D-10).
 *
 * D-05 LOOSE-RECORD: graph.execute request + response are
 * `z.record(z.string(), z.unknown())` because orchestrator schema
 * authority is not yet stabilized; tightening deferred to a follow-up
 * phase. graph.status response is also loose-record (2-variant
 * discriminated by graphId presence). graph.load response is loose-record
 * (persisted entry shape).
 * @module
 */

import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync, existsSync, statSync, rmSync } from "node:fs";
import {
  parseExecutionGraph,
  safePath,
  validateAndSortGraph,
  type ExecutionGraph,
  GraphDefineContract,
  GraphExecuteContract,
  GraphStatusContract,
  GraphCancelContract,
  GraphSaveContract,
  GraphLoadContract,
  GraphListContract,
  GraphDeleteContract,
  GraphOutputsContract,
  GraphRunsContract,
  GraphRunDetailContract,
  GraphDeleteRunContract,
  stripInternalFields,
  systemGetEnv,
  systemDateFrom,
} from "@comis/core";
import { z } from "zod";
import { extractUserVariables, substituteUserVariables } from "../graph/user-variables.js";
import type { RpcHandler } from "./types.js";

// ---------------------------------------------------------------------------
// Dev-mode response parse helper (D-10)
// ---------------------------------------------------------------------------

/**
 * Run `contract.response.parse(result)` only when NODE_ENV !== "production".
 * Daemon side is the trust boundary; in production the trust check is
 * the in-handler logic, not the contract parse.
 */
const IS_DEV = systemGetEnv("NODE_ENV") !== "production";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

// Re-aliased from the cluster slice in api/types.ts (Plan 34-08a).
// Single source of truth: OrchestratorApiDeps (shared with cron, heartbeat,
// subagent handlers). The dispatcher constructs this handler only when at
// least one of `graphCoordinator | namedGraphStore` is defined, so the alias
// narrows `graphCoordinator` to required (matching the handler body's direct
// `deps.graphCoordinator.method()` access). DAEMON-API-03 Option A retarget
// + 34-08b narrowing — handler bodies unchanged.
import type { OrchestratorApiDeps } from "./types.js";
export type GraphHandlerDeps = OrchestratorApiDeps & {
  graphCoordinator: import("../graph/graph-coordinator.js").GraphCoordinator;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Transform snake_case tool parameters to camelCase for parseExecutionGraph.
 * The pipeline tool uses snake_case for LLM parameter conventions. The Zod
 * schemas in @comis/core use camelCase. This function bridges the gap.
 */
export function transformNodes(rawNodes: unknown[]): unknown[] {
  return rawNodes.map((raw) => {
    const node = raw as Record<string, unknown>;
    return {
      nodeId: node.node_id ?? node.nodeId,
      task: node.task,
      agentId: node.agent ?? node.agentId,
      model: node.model,
      dependsOn: node.depends_on ?? node.dependsOn,
      timeoutMs: node.timeout_ms ?? node.timeoutMs,
      maxSteps: node.max_steps ?? node.maxSteps,
      ...(node.barrier_mode ?? node.barrierMode
        ? { barrierMode: node.barrier_mode ?? node.barrierMode } : {}),
      ...(node.retries !== undefined ? { retries: node.retries } : {}),
      ...(node.context_mode ?? node.contextMode
        ? { contextMode: node.context_mode ?? node.contextMode } : {}),
      ...(node.type_id ?? node.typeId
        ? { typeId: node.type_id ?? node.typeId } : {}),
      ...(node.type_config ?? node.typeConfig
        ? { typeConfig: node.type_config ?? node.typeConfig } : {}),
    };
  });
}

/**
 * Build a validated graph from RPC params.
 * Extracts and transforms common graph params from RPC input, parses with
 * parseExecutionGraph, and validates with validateAndSortGraph. Throws
 * descriptive errors on parse or validation failure.
 */
function buildGraphInput(params: Record<string, unknown>) {
  const rawNodes = params.nodes as unknown[];
  if (!rawNodes || !Array.isArray(rawNodes) || rawNodes.length === 0) {
    throw new Error("Missing required parameter: nodes");
  }

  const rawGraph = {
    nodes: transformNodes(rawNodes),
    label: params.label as string | undefined,
    onFailure: params.onFailure ?? params.on_failure,
    timeoutMs: params.timeoutMs ?? params.timeout_ms,
    budget: params.budget,
  };

  const parseResult = parseExecutionGraph(rawGraph);
  if (!parseResult.ok) {
    const issues = parseResult.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    throw new Error(`Graph validation failed: ${issues}`);
  }

  const validateResult = validateAndSortGraph(parseResult.value);
  if (!validateResult.ok) {
    throw new Error(`Graph validation failed: ${validateResult.error.message}`);
  }

  return validateResult.value;
}

// ---------------------------------------------------------------------------
// Graph Warnings (soft validation)
// ---------------------------------------------------------------------------

/** A single validation issue returned to the LLM for self-correction. */
export interface ValidationIssue {
  nodeId?: string;
  type: string;
  message: string;
  fix: string;
}

/**
 * Produce LLM-friendly warnings for a structurally valid graph.
 * Hard errors (cycles, missing deps) are already caught by
 * `validateAndSortGraph`. This layer detects soft issues that an LLM
 * can fix before execution: orphan nodes, unnecessary barrier modes,
 * missing agentId/typeId, typed-node agentId conflicts,
 * information bottleneck (downstream loses upstream visibility)
 * (typed_node_agentid_ignored), expensive retries on typed nodes
 * (typed_node_expensive_retry), and approval-gate retry
 * (typed_node_approval_retry).
 * Returns `errors: []` always — structural errors never reach here.
 */
export function validateGraphWarnings(
  graph: ExecutionGraph,
): { warnings: ValidationIssue[]; errors: ValidationIssue[] } {
  const warnings: ValidationIssue[] = [];

  // 1. unresolved_template — {{nodeId.result}} where nodeId is not in dependsOn
  for (const node of graph.nodes) {
    const templateRe = /\{\{([\w-]+)\.result\}\}/g;
    let match: RegExpExecArray | null;
    while ((match = templateRe.exec(node.task)) !== null) {
      const referencedId = match[1]!;
      if (!node.dependsOn.includes(referencedId)) {
        warnings.push({
          nodeId: node.nodeId,
          type: "unresolved_template",
          message: `Node "${node.nodeId}" references {{${referencedId}.result}} but "${referencedId}" is not in its dependsOn`,
          fix: `Add "${referencedId}" to dependsOn, or remove the template reference.`,
        });
      }
    }
  }

  // 2. orphan_node — disconnected node in multi-node graph
  if (graph.nodes.length > 1) {
    const dependedUpon = new Set<string>();
    for (const node of graph.nodes) {
      for (const dep of node.dependsOn) {
        dependedUpon.add(dep);
      }
    }

    for (const node of graph.nodes) {
      if (node.dependsOn.length === 0 && !dependedUpon.has(node.nodeId)) {
        warnings.push({
          nodeId: node.nodeId,
          type: "orphan_node",
          message: `Node "${node.nodeId}" is disconnected — no dependsOn and nothing depends on it`,
          fix: "Add this node to another node's dependsOn, or add a dependsOn referencing an upstream node.",
        });
      }
    }
  }

  // 3. barrier_mode_low_deps — barrierMode set but <=1 dependency
  for (const node of graph.nodes) {
    // barrierMode defaults to "all" via Zod, so only warn when explicitly
    // set to a non-default value OR when explicitly set at all.  We detect
    // "explicitly set" by checking for a value other than "all" (the
    // default). If someone explicitly sets "all" with 0-1 deps, it's
    // harmless so we don't warn.
    if (node.barrierMode !== "all" && node.dependsOn.length <= 1) {
      warnings.push({
        nodeId: node.nodeId,
        type: "barrier_mode_low_deps",
        message: `Node "${node.nodeId}" uses barrierMode "${node.barrierMode}" but has only ${node.dependsOn.length} dependency — barrier mode only matters with 2+ dependencies`,
        fix: "Add more dependsOn entries for fan-in, or remove barrierMode.",
      });
    }
  }

  // 4. no_agent_id — only when both agentId AND typeId are absent
  for (const node of graph.nodes) {
    if (!node.agentId && !node.typeId) {
      warnings.push({
        nodeId: node.nodeId,
        type: "no_agent_id",
        message: `Node "${node.nodeId}" has no agentId and no typeId -- will use the calling agent by default`,
        fix: "Set agentId to a specific agent, or set type_id + type_config to use a built-in node type.",
      });
    }
  }

  // 5. typed_node_agentid_ignored — typeId set but agentId also set
  for (const node of graph.nodes) {
    if (node.typeId && node.agentId) {
      warnings.push({
        nodeId: node.nodeId,
        type: "typed_node_agentid_ignored",
        message: `Node "${node.nodeId}" has both typeId "${node.typeId}" and agentId -- agentId is ignored for typed nodes (agents come from type_config)`,
        fix: "Remove the agentId field from this typed node.",
      });
    }
  }

  // 6. typed_node_expensive_retry — typeId set and retries > 0
  for (const node of graph.nodes) {
    if (node.typeId && node.retries > 0) {
      warnings.push({
        nodeId: node.nodeId,
        type: "typed_node_expensive_retry",
        message: `Node "${node.nodeId}" has type "${node.typeId}" with retries=${node.retries} -- retrying re-runs the entire driver from scratch`,
        fix: "Consider setting retries to 0 for typed nodes, or accept the cost of full re-execution.",
      });
    }
  }

  // 7. typed_node_approval_retry — approval-gate with retries (subset of above but more specific)
  for (const node of graph.nodes) {
    if (node.typeId === "approval-gate" && node.retries > 0) {
      warnings.push({
        nodeId: node.nodeId,
        type: "typed_node_approval_retry",
        message: `Node "${node.nodeId}" is an approval-gate with retries=${node.retries} -- retry will re-prompt the user`,
        fix: "Set retries to 0 for approval-gate nodes.",
      });
    }
  }

  // 8. information_bottleneck — downstream node loses access to upstream outputs
  //    that its dependency could see (because dependsOn is the SOLE data scoping).
  //    A node receives ONLY the outputs from nodes in its direct dependsOn.
  //    If dep D has transitive upstream nodes that are NOT in N's dependsOn,
  //    N loses visibility into those upstream outputs.
  const nodeIds = new Set(graph.nodes.map((n) => n.nodeId));
  const nodeMap = new Map(graph.nodes.map((n) => [n.nodeId, n]));

  // Build transitive upstream set for each node (memoized).
  const transitiveCache = new Map<string, Set<string>>();
  function getTransitiveUpstream(nodeId: string): Set<string> {
    const cached = transitiveCache.get(nodeId);
    if (cached) return cached;
    const result = new Set<string>();
    const node = nodeMap.get(nodeId);
    if (node) {
      for (const dep of node.dependsOn) {
        if (nodeIds.has(dep)) {
          result.add(dep);
          for (const transitive of getTransitiveUpstream(dep)) {
            result.add(transitive);
          }
        }
      }
    }
    transitiveCache.set(nodeId, result);
    return result;
  }

  for (const node of graph.nodes) {
    if (node.dependsOn.length === 0) continue;
    // N's direct dependsOn is the set of nodes whose output N actually receives.
    const directDeps = new Set(node.dependsOn);
    // Aggregate lost nodes across ALL deps to emit one warning per node (not per dep).
    const aggregatedLost = new Set<string>();
    for (const dep of node.dependsOn) {
      if (!nodeIds.has(dep)) continue;
      const depReachable = getTransitiveUpstream(dep);
      for (const id of depReachable) {
        if (!directDeps.has(id) && id !== dep) {
          aggregatedLost.add(id);
        }
      }
    }
    if (aggregatedLost.size > 0) {
      const lost = [...aggregatedLost];
      warnings.push({
        nodeId: node.nodeId,
        type: "information_bottleneck",
        message: `Node "${node.nodeId}" loses access to ${lost.length} upstream node(s) reachable through its dependencies: ${lost.join(", ")}`,
        fix: `Add [${lost.map((id) => `"${id}"`).join(", ")}] to "${node.nodeId}"'s dependsOn to preserve data flow from all upstream sources.`,
      });
    }
  }

  return { warnings, errors: [] };
}

// ---------------------------------------------------------------------------
// Type Config Validation Helpers
// ---------------------------------------------------------------------------

/**
 * Generate an example object from a Zod schema's shape for LLM self-correction hints.
 * Uses instanceof checks against Zod v4 class hierarchy (not _def.typeName).
 * For ZodDefault, uses _def.innerType (no public API alternative).
 */
export function schemaToExample(schema: z.ZodObject<z.ZodRawShape>): Record<string, string> {
  const shape = schema.shape;
  const result: Record<string, string> = {};
  for (const [key, type] of Object.entries(shape)) {
    const t = type as z.ZodTypeAny;
    if (t.description) { result[key] = t.description; continue; }
    const inner = t instanceof z.ZodOptional ? t.unwrap()
                : t instanceof z.ZodDefault  ? (t as unknown as { _def: { innerType: z.ZodTypeAny } })._def.innerType
                : t;
    if (inner instanceof z.ZodString)       result[key] = "string";
    else if (inner instanceof z.ZodNumber)  result[key] = "number";
    else if (inner instanceof z.ZodBoolean) result[key] = "boolean";
    else if (inner instanceof z.ZodArray)   result[key] = "array";
    else if (inner instanceof z.ZodObject)  result[key] = "object";
    else                                    result[key] = "unknown";
    if (t instanceof z.ZodOptional) result[key] += " (optional)";
  }
  return result;
}

/**
 * Validate typeConfig for all typed nodes against driver config schemas.
 * Called in graph.define and graph.execute handlers after buildGraphInput().
 * Throws on validation failure with a schemaToExample hint for LLM self-correction.
 * When registry has no driver for a typeId, skip validation (drivers registered in Phases 455-456).
 */
function validateTypeConfigs(
  graph: ExecutionGraph,
  registry: GraphHandlerDeps["nodeTypeRegistry"],
): void {
  if (!registry) return;
  for (const node of graph.nodes) {
    if (node.typeId) {
      const driver = registry.get(node.typeId);
      if (!driver) continue; // Driver not registered yet (Phases 455-456)
      const result = driver.configSchema.safeParse(node.typeConfig ?? {});
      if (!result.success) {
        const errors = result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
        const schemaHint = ` Expected: ${JSON.stringify(schemaToExample(driver.configSchema))}`;
        throw new Error(
          `Node "${node.nodeId}" type_config invalid: ${errors.join("; ")}.${schemaHint}`
        );
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a record of graph RPC handlers bound to the given deps.
 */
export function createGraphHandlers(deps: GraphHandlerDeps): Record<string, RpcHandler> {
  const handlers: Record<string, RpcHandler> = {
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

      const validated = buildGraphInput(userParams);
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

      const validated = buildGraphInput(userParams);
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
        hint: "Graph is running asynchronously and survives independently of this session. You will be automatically notified with results when it completes — do NOT poll with status/cron. Just tell the user it's running.",
        ...(unresolvedWarnings.length > 0 && { warnings: unresolvedWarnings }),
      };
      if (IS_DEV) GraphExecuteContract.response.parse(result);
      return result;
    },

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
      const validated = buildGraphInput(userParams);
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

    [GraphLoadContract.method]: async (rawParams) => {
      // Bespoke pre-Zod validation FIRST.
      if (!deps.namedGraphStore) {
        throw new Error("Named graph storage not available");
      }

      const id = rawParams.id as string | undefined;
      if (!id) {
        throw new Error("Missing required parameter: id");
      }

      const userParams = stripInternalFields(rawParams);
      GraphLoadContract.request.parse(userParams);

      const tenantId = deps.tenantId ?? "default";
      const entry = deps.namedGraphStore.load(id, tenantId);
      if (!entry) {
        throw new Error("Named graph not found");
      }

      // Strip inputFrom/inputMapping from persisted graph JSON
      const migratedNodes = (entry.nodes as Record<string, unknown>[]).map(node => {
        const { inputFrom: _inputFrom, input_from: _input_from, ...rest } = node as Record<string, unknown>;
        return rest;
      });
      const migratedEdges = (entry.edges as Record<string, unknown>[]).map(edge => {
        const { inputMapping: _inputMapping, input_mapping: _input_mapping, ...rest } = edge as Record<string, unknown>;
        return rest;
      });
      const result = { ...entry, nodes: migratedNodes, edges: migratedEdges };
      if (IS_DEV) GraphLoadContract.response.parse(result);
      return result;
    },

    [GraphListContract.method]: async (rawParams) => {
      // Bespoke pre-Zod validation FIRST.
      if (!deps.namedGraphStore) {
        throw new Error("Named graph storage not available");
      }

      const userParams = stripInternalFields(rawParams);
      const params = GraphListContract.request.parse(userParams);

      const tenantId = deps.tenantId ?? "default";
      const listResult = deps.namedGraphStore.list(tenantId, {
        limit: params.limit,
        offset: params.offset,
      });

      const result = { entries: listResult.entries, total: listResult.total };
      if (IS_DEV) GraphListContract.response.parse(result);
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
  return handlers;
}
