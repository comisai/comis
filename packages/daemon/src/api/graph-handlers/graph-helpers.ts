// SPDX-License-Identifier: Apache-2.0
// @allow-throw: RPC handler module — all throws are caught and converted to JSON-RPC error responses by rpc-dispatch.ts:306-321.
/**
 * Graph handler helpers.
 *
 * Pure helpers shared across the mutate / query / export handler bundles.
 * No closures, no factory: every helper is a pure function or interface so
 * the dependency graph stays one-directional (mutate / query / export →
 * graph-helpers).
 *
 *   - GraphHandlerDeps type re-export (composition of OrchestratorApiDeps)
 *   - ValidationIssue interface (warning record shape)
 *   - transformNodes (snake_case to camelCase node param adapter)
 *   - validateGraphWarnings (soft validation; emits LLM-friendly warnings)
 *   - schemaToExample (Zod schema introspection for LLM hints)
 *   - validateTypeConfigs (typeConfig validation against driver schemas)
 *   - buildGraphInput (RPC params → validated graph + execution order)
 *   - IS_DEV (NODE_ENV !== "production" dev-mode flag)
 *
 * @module
 */

import {
  parseExecutionGraph,
  validateAndSortGraph,
  type ExecutionGraph,
  systemGetEnv,
} from "@comis/core";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Dev-mode response parse helper
// ---------------------------------------------------------------------------

/**
 * Run `contract.response.parse(result)` only when NODE_ENV !== "production".
 * Daemon side is the trust boundary; in production the trust check is
 * the in-handler logic, not the contract parse.
 */
export const IS_DEV = systemGetEnv("NODE_ENV") !== "production";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

// Re-aliased from the cluster slice in api/types.ts.
// Single source of truth: OrchestratorApiDeps (shared with cron, heartbeat,
// subagent handlers). The dispatcher constructs this handler only when at
// least one of `graphCoordinator | namedGraphStore` is defined, so the alias
// narrows `graphCoordinator` to required (matching the handler body's direct
// `deps.graphCoordinator.method()` access).
import type { OrchestratorApiDeps } from "../types.js";
export type GraphHandlerDeps = OrchestratorApiDeps & {
  graphCoordinator: import("../../graph/graph-coordinator.js").GraphCoordinator;
};

/** A single validation issue returned to the LLM for self-correction. */
export interface ValidationIssue {
  nodeId?: string;
  type: string;
  message: string;
  fix: string;
}

// ---------------------------------------------------------------------------
// Pure transforms
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
export function buildGraphInput(params: Record<string, unknown>) {
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
 * When registry has no driver for a typeId, skip validation.
 */
export function validateTypeConfigs(
  graph: ExecutionGraph,
  registry: GraphHandlerDeps["nodeTypeRegistry"],
): void {
  if (!registry) return;
  for (const node of graph.nodes) {
    if (node.typeId) {
      const driver = registry.get(node.typeId);
      if (!driver) continue; // Driver not registered yet
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
