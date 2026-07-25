// SPDX-License-Identifier: Apache-2.0
/**
 * DAG durable-checkpoint serialization.
 *
 * A graph run is made durable at node-boundary granularity. At each transition,
 * the coordinator writes the exact graph, node states, outputs, retry counters,
 * and accounting ledgers to a protected artifact before updating the authority
 * row. The row's `spawn_tree` column is only a content-free routing summary.
 *
 * These two functions are the pure, I/O-free core of that mechanism:
 *   - {@link snapshotToSpawnTree} serializes a live snapshot to the DAG
 *     `{nodeId,status,runId?}[]` shape (the DAG-vs-flat discriminator — object
 *     entries with a `status` field mark a DAG record vs a flat run's
 *     `string[]`, so a flat run never mis-routes to `resumeGraph`).
 *   - {@link incompleteNodes} is the resume selector: the nodes whose status is
 *     NOT in {@link TERMINAL_NODE_STATES} — the frontier to re-run.
 *
 * A node that was running when the process stopped is eligible to restart from
 * its beginning only after root-wide outward-effect uncertainty has been
 * cleared. A terminal node is restored exactly and is never re-entered.
 *
 * @module
 */

import {
  parseDurableGraphCheckpoint,
  safePath,
  type DurableGraphCheckpoint,
  type NodeExecutionState,
  type NodeStatus,
} from "@comis/core";
import { err, ok, tryCatch, type Result } from "@comis/shared";
import { readRegularFile, writeRegularFile } from "@comis/observability";
import { createHash } from "node:crypto";
import type { GraphExecutionSnapshot } from "./graph-state-machine.js";
import type { GraphRunState } from "./graph-coordinator-state.js";

const MAX_GRAPH_CHECKPOINT_BYTES = 8 * 1024 * 1024;
const GRAPH_RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const CHECKPOINT_FILE_PATTERN = /^durable-checkpoint-([a-f0-9]{64})\.json$/;

function parseCheckpointRef(
  checkpointRef: string,
): Result<{ graphId: string; digest: string }, Error> {
  const segments = checkpointRef.split("/");
  const graphId = segments[1];
  const fileName = segments[2];
  const fileMatch = fileName === undefined
    ? null
    : CHECKPOINT_FILE_PATTERN.exec(fileName);
  if (
    segments.length !== 3
    || segments[0] !== "graph-runs"
    || graphId === undefined
    || !GRAPH_RUN_ID_PATTERN.test(graphId)
    || fileMatch === null
    || fileMatch[1] === undefined
  ) {
    return err(new Error("graph checkpoint reference does not identify one canonical graph-run artifact"));
  }
  return ok({ graphId, digest: fileMatch[1] });
}

/**
 * Resolve the stable graph-run directory identity carried by a protected
 * checkpoint reference. Resume authority rows receive a fresh checkpoint id,
 * so the row id cannot identify the workspace that existing node artifacts use.
 */
export function graphRunIdFromCheckpointRef(
  checkpointRef: string,
): Result<string, Error> {
  const parsed = parseCheckpointRef(checkpointRef);
  return parsed.ok ? ok(parsed.value.graphId) : parsed;
}

/**
 * A single DAG spawn-tree entry — the durable `spawn_tree` array element for a
 * graph run (matches `DurableRunRecord.spawnTree`'s DAG arm in @comis/core).
 */
export interface SpawnTreeNode {
  nodeId: string;
  status: NodeStatus;
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
 * The result is plain JSON-serializable data that survives the durable_run_checkpoints TEXT
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

/** Capture the exact submitted graph and all restart-relevant runtime ledgers. */
export function createDurableGraphCheckpoint(gs: GraphRunState): DurableGraphCheckpoint {
  const snapshot = gs.stateMachine.snapshot();
  return {
    graph: gs.graph.graph,
    executionOrder: [...snapshot.executionOrder],
    nodes: [...snapshot.nodes.values()].map((state) => ({ ...state })),
    startedAtMs: gs.startedAt,
    cumulativeTokens: gs.cumulativeTokens,
    cumulativeCost: gs.cumulativeCost,
    nodeCacheData: [...gs.nodeCacheData].map(([nodeId, data]) => ({ nodeId, ...data })),
    nodeTokenSpend: [...gs.nodeTokenSpend].map(([nodeId, tokens]) => ({ nodeId, tokens })),
    nodeCost: [...gs.nodeCost].map(([nodeId, cost]) => ({ nodeId, cost })),
    skippedNodesEmitted: [...gs.skippedNodesEmitted],
  };
}

/** Persist content-bearing graph state in an owner-only artifact, never the authority row. */
export function writeDurableGraphCheckpoint(
  dataDir: string,
  graphId: string,
  checkpoint: DurableGraphCheckpoint,
): Result<string, Error> {
  if (!GRAPH_RUN_ID_PATTERN.test(graphId)) {
    return err(new Error("graph checkpoint graph id is not canonical"));
  }
  const content = JSON.stringify(checkpoint);
  if (Buffer.byteLength(content, "utf8") > MAX_GRAPH_CHECKPOINT_BYTES) {
    return err(new Error("graph checkpoint artifact exceeds the restart size limit"));
  }
  const fileName = `durable-checkpoint-${createHash("sha256").update(content).digest("hex")}.json`;
  const resolved = tryCatch(() => {
    const graphDir = safePath(dataDir, "graph-runs", graphId);
    return safePath(graphDir, fileName);
  });
  if (!resolved.ok) return err(new Error("graph checkpoint path validation failed"));
  const existing = readRegularFile({
    path: resolved.value,
    maxFileBytes: MAX_GRAPH_CHECKPOINT_BYTES,
    confinedBaseDir: dataDir,
  });
  if (existing.ok) {
    return existing.value.content.equals(Buffer.from(content, "utf8"))
      ? ok(["graph-runs", graphId, fileName].join("/"))
      : err(new Error("graph checkpoint content-address collision"));
  }
  if ((existing.error as NodeJS.ErrnoException).code !== "ENOENT") {
    return err(new Error("graph checkpoint artifact preflight failed"));
  }
  const written = writeRegularFile({
    path: resolved.value,
    content,
    confinedBaseDir: dataDir,
    fsyncBeforeSuccess: true,
  });
  if (!written.ok) return err(new Error("graph checkpoint artifact write failed"));
  return ok(["graph-runs", graphId, fileName].join("/"));
}

/** Load and schema-validate the protected graph artifact referenced by the authority row. */
export function readDurableGraphCheckpoint(
  dataDir: string,
  checkpointRef: string,
): Result<DurableGraphCheckpoint, Error> {
  const checkpointIdentity = parseCheckpointRef(checkpointRef);
  if (!checkpointIdentity.ok) return checkpointIdentity;
  const resolved = tryCatch(() => safePath(dataDir, checkpointRef));
  if (!resolved.ok) return err(new Error("graph checkpoint path validation failed"));
  const read = readRegularFile({
    path: resolved.value,
    maxFileBytes: MAX_GRAPH_CHECKPOINT_BYTES,
    confinedBaseDir: dataDir,
  });
  if (!read.ok) return err(new Error("graph checkpoint artifact read failed"));
  const contentDigest = createHash("sha256").update(read.value.content).digest("hex");
  if (contentDigest !== checkpointIdentity.value.digest) {
    return err(new Error("graph checkpoint artifact digest does not match its reference"));
  }
  const decoded = tryCatch(() => JSON.parse(read.value.content.toString("utf8")) as unknown);
  if (!decoded.ok) return err(new Error("graph checkpoint artifact JSON is invalid"));
  const parsed = parseDurableGraphCheckpoint(decoded.value);
  return parsed.ok
    ? ok(parsed.value)
    : err(new Error("graph checkpoint artifact schema validation failed"));
}

/** Refuse a row/artifact pair whose duplicated routing summary diverges. */
export function validateGraphCheckpointSummary(
  spawnTree: ReadonlyArray<SpawnTreeNode>,
  checkpoint: DurableGraphCheckpoint,
): Result<void, Error> {
  if (spawnTree.length !== checkpoint.nodes.length) {
    return err(new Error("graph checkpoint routing summary node count mismatch"));
  }
  const summaryByNode = new Map(spawnTree.map((entry) => [entry.nodeId, entry]));
  if (summaryByNode.size !== spawnTree.length) {
    return err(new Error("graph checkpoint routing summary has duplicate nodes"));
  }
  for (const state of checkpoint.nodes) {
    const summary = summaryByNode.get(state.nodeId);
    if (
      summary === undefined
      || summary.status !== state.status
      || summary.runId !== state.runId
    ) {
      return err(new Error("graph checkpoint routing summary diverges from its artifact"));
    }
  }
  return ok(undefined);
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
