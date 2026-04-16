/**
 * Graph-wide tool superset computation for cache prefix sharing.
 * At graph start time, computes the intersection of all tool names across every
 * unique agent ID referenced by graph nodes. The intersection ensures all nodes
 * render identical tool sets without post-hoc security filtering divergence,
 * enabling byte-identical tool rendering in the Anthropic API payload for
 * prompt cache prefix reuse across sibling subagents.
 * When the intersection is too small (< MIN_INTERSECTION_SIZE tools), falls back
 * to the union of all tools to avoid degrading capability. The result is always
 * deterministically sorted for stable serialization.
 * @module
 */

import type { ValidatedGraph } from "@comis/core";
import { fromPromise } from "@comis/shared";

/**
 * Minimum number of tools in the intersection before falling back to union.
 * If agents share fewer than this many tools, the intersection is too narrow
 * to be useful and we revert to union (all tools across all agents).
 */
const MIN_INTERSECTION_SIZE = 2;

/**
 * Compute the sorted tool superset across all unique agents in a graph.
 * Uses an intersection-first strategy: computes the set of tools common to
 * all agents. When the intersection has >= MIN_INTERSECTION_SIZE tools, returns
 * the intersection (ensuring all nodes render identical tool sets). When the
 * intersection is too small, falls back to the union (all tools across all agents).
 * For each unique agent ID (or defaultAgentId for nodes without agentId),
 * calls assembleToolsFn once. Results are always sorted for deterministic ordering.
 * Best-effort: if assembleToolsFn throws for any agent, returns an empty array
 * rather than blocking the graph run.
 * @param graph - The validated graph definition containing node specs
 * @param defaultAgentId - Fallback agent ID for nodes without explicit agentId
 * @param assembleToolsFn - Async function that returns tool objects for a given agent
 * @returns Sorted array of tool names (intersection when >= MIN_INTERSECTION_SIZE, union otherwise)
 */
export async function computeGraphToolSuperset(
  graph: ValidatedGraph,
  defaultAgentId: string,
  assembleToolsFn: (agentId: string) => Promise<Array<{ name: string; description?: string; inputSchema?: unknown }>>,
): Promise<string[]> {
  const nodes = graph.graph.nodes;
  if (nodes.length === 0) return [];

  // Collect unique agent IDs -- deduplicate before calling assembleToolsFn
  // to avoid redundant async calls (especially important when all nodes
  // share the same defaultAgentId)
  const uniqueAgentIds = new Set<string>();
  for (const node of nodes) {
    uniqueAgentIds.add(node.agentId ?? defaultAgentId);
  }

  const perAgentToolSets: Set<string>[] = [];
  const allToolNames = new Set<string>(); // union fallback

  for (const agentId of uniqueAgentIds) {
    const result = await fromPromise(assembleToolsFn(agentId));
    if (!result.ok) {
      // Best-effort: graph should still run even if superset computation fails
      return [];
    }
    const agentTools = new Set<string>();
    for (const tool of result.value) {
      agentTools.add(tool.name);
      allToolNames.add(tool.name);
    }
    perAgentToolSets.push(agentTools);
  }

  // Compute intersection of all agents' tool sets.
  // Intersection ensures all nodes render identical tool sets without
  // post-hoc security filtering divergence.
  if (perAgentToolSets.length === 0) return [];
  let intersection = new Set(perAgentToolSets[0]!);
  for (let i = 1; i < perAgentToolSets.length; i++) {
    intersection = new Set([...intersection].filter(name => perAgentToolSets[i]!.has(name)));
  }

  // Fall back to union if intersection is too small (disjoint tool sets)
  const resultSet = intersection.size >= MIN_INTERSECTION_SIZE ? intersection : allToolNames;
  return [...resultSet].sort();
}
