// SPDX-License-Identifier: Apache-2.0
/**
 * DAG durable-checkpoint serialization.
 *
 * A graph (DAG) run is made durable at NODE-boundary granularity: at every node
 * transition the coordinator persists the node-completion state of its
 * {@link GraphExecutionSnapshot} into the durable run record's `spawn_tree`
 * column (a JSON array), keyed on the graph's tree-stable `graphRootRunId`. On
 * a daemon restart the resume engine re-enters ONLY the nodes that were NOT
 * terminal at crash time.
 *
 * These two functions are the pure, I/O-free core of that mechanism:
 *   - {@link snapshotToSpawnTree} serializes a live snapshot to the DAG
 *     `{nodeId,status,runId?}[]` shape (the DAG-vs-flat discriminator — object
 *     entries with a `status` field mark a DAG record vs a flat run's
 *     `string[]`, so a flat run never mis-routes to `resumeGraph`).
 *   - {@link incompleteNodes} is the resume selector: the nodes whose status is
 *     NOT in {@link TERMINAL_NODE_STATES} — the frontier to re-run.
 *
 * NODE-BOUNDARY GRANULARITY: a node that was mid-execution (`running`) at crash
 * time is treated as incomplete and re-run from its start; its outward sends
 * are deduped by the ONCE ledger (a committed `(rootRunId, stepIndex)` is a
 * no-op), so re-running is exactly-once-safe WITHOUT persisting intra-node
 * LLM/tool state (out of scope).
 *
 * @module
 */

import type { NodeExecutionState } from "@comis/core";
import type { GraphExecutionSnapshot } from "./graph-state-machine.js";

/**
 * A single DAG spawn-tree entry — the durable `spawn_tree` array element for a
 * graph run (matches `DurableRunRecord.spawnTree`'s DAG arm in @comis/core).
 */
export interface SpawnTreeNode {
  nodeId: string;
  status: string;
  runId?: string;
}

/**
 * The closed set of TERMINAL node statuses — a node here is DONE and is NOT
 * re-entered on resume. Conservative set: `completed` and `skipped` are
 * unambiguously terminal; `failed` is terminal too because the graph state
 * machine has already exhausted a node's retry budget by the time it reaches
 * `failed` (a retry-eligible failure transitions the node back to `ready`, NOT
 * `failed` — see graph-state-machine.ts markNodeFailed), so a persisted
 * `failed` status means no retry remained. Everything else
 * (`pending`/`ready`/`running`) is the incomplete frontier.
 */
export const TERMINAL_NODE_STATES: ReadonlySet<string> = new Set<string>([
  "completed",
  "skipped",
  "failed",
]);

/**
 * Serialize a graph execution snapshot to the durable `spawn_tree` array.
 *
 * Maps each {@link NodeExecutionState} in `snapshot.nodes` to a
 * `{nodeId, status, runId?}` entry. `runId` is included only when the node has
 * one (running/completed nodes), so a never-started node serializes without it.
 * The result is plain JSON-serializable data that survives the durable_runs TEXT
 * column round trip.
 */
export function snapshotToSpawnTree(snapshot: GraphExecutionSnapshot): SpawnTreeNode[] {
  const tree: SpawnTreeNode[] = [];
  for (const state of snapshot.nodes.values() as IterableIterator<NodeExecutionState>) {
    tree.push({
      nodeId: state.nodeId,
      status: state.status,
      ...(state.runId !== undefined ? { runId: state.runId } : {}),
    });
  }
  return tree;
}

/**
 * The resume selector: the nodeIds whose status is NOT terminal — the frontier
 * a restarting daemon must re-enter. A fully-completed graph yields `[]`
 * (nothing to resume). Accepts the persisted (JSON-parsed) spawn-tree shape, so
 * it composes directly with a `DurableRunRecord.spawnTree` read off disk.
 */
export function incompleteNodes(spawnTree: ReadonlyArray<{ nodeId: string; status: string }>): string[] {
  return spawnTree
    .filter((entry) => !TERMINAL_NODE_STATES.has(entry.status))
    .map((entry) => entry.nodeId);
}

/**
 * The DAG-vs-flat discriminator for the resume engine's dispatch routing.
 * A DAG/graph run's `spawn_tree` entries are OBJECTS carrying a
 * `status` field (`{nodeId,status,runId?}` — the {@link snapshotToSpawnTree}
 * shape); a FLAT sub-agent run's `spawn_tree` is a plain `string[]` of node/lease
 * ids (the flat `spawnTree: z.array(z.string())` shape). This is the EXPLICIT
 * entry-has-`status` check — NOT a length or array-type heuristic — so the resume
 * engine routes to `coordinator.resumeGraph` IFF this returns true. A flat run
 * (string entries) can therefore NEVER mis-route to the graph resume, and a DAG
 * record always re-enters via node re-entry. An empty `spawn_tree` is NOT a DAG
 * (there is no graph frontier to resume).
 */
export function isDagSpawnTree(
  spawnTree: ReadonlyArray<string | { nodeId: string; status: string; runId?: string }>,
): spawnTree is ReadonlyArray<{ nodeId: string; status: string; runId?: string }> {
  return (
    Array.isArray(spawnTree) &&
    spawnTree.length > 0 &&
    typeof spawnTree[0] === "object" &&
    spawnTree[0] !== null &&
    "status" in spawnTree[0]
  );
}
