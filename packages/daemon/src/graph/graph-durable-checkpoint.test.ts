// SPDX-License-Identifier: Apache-2.0
/**
 * Pure-function tests for the DAG durable-checkpoint serialization.
 * These functions are I/O-free so the snapshot ↔
 * durable_runs.spawn_tree round trip + the resume incomplete-node selector are
 * exhaustively unit-testable without a graph coordinator or a SQLite store.
 */
import { describe, it, expect } from "vitest";
import type { NodeExecutionState } from "@comis/core";
import type { GraphExecutionSnapshot } from "./graph-state-machine.js";
import {
  snapshotToSpawnTree,
  incompleteNodes,
  isDagSpawnTree,
  TERMINAL_NODE_STATES,
} from "./graph-durable-checkpoint.js";

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

function nodeState(
  nodeId: string,
  status: NodeExecutionState["status"],
  runId?: string,
): NodeExecutionState {
  return { nodeId, status, ...(runId !== undefined ? { runId } : {}) };
}

function snapshot(states: NodeExecutionState[]): GraphExecutionSnapshot {
  const nodes = new Map<string, NodeExecutionState>();
  for (const s of states) nodes.set(s.nodeId, s);
  return {
    graphStatus: "running",
    nodes,
    executionOrder: states.map((s) => s.nodeId),
    isTerminal: false,
  };
}

// ---------------------------------------------------------------------------
// snapshotToSpawnTree
// ---------------------------------------------------------------------------

describe("snapshotToSpawnTree", () => {
  it("maps every node in the snapshot to a {nodeId, status, runId?} entry", () => {
    const snap = snapshot([
      nodeState("A", "completed"),
      nodeState("B", "running", "run-b"),
      nodeState("C", "pending"),
    ]);

    const tree = snapshotToSpawnTree(snap);

    expect(tree).toHaveLength(3);
    expect(tree).toEqual(
      expect.arrayContaining([
        { nodeId: "A", status: "completed" },
        { nodeId: "B", status: "running", runId: "run-b" },
        { nodeId: "C", status: "pending" },
      ]),
    );
  });

  it("carries the runId for a running node (so resume can correlate the in-flight run)", () => {
    const snap = snapshot([nodeState("B", "running", "run-xyz")]);

    const tree = snapshotToSpawnTree(snap);

    expect(tree[0]).toEqual({ nodeId: "B", status: "running", runId: "run-xyz" });
  });

  it("omits runId for nodes that never started (pending/ready)", () => {
    const snap = snapshot([nodeState("C", "pending"), nodeState("D", "ready")]);

    const tree = snapshotToSpawnTree(snap);

    for (const entry of tree) {
      expect(entry.runId).toBeUndefined();
      expect("runId" in entry).toBe(false);
    }
  });

  it("produces a JSON-serializable array (survives the durable_runs TEXT column)", () => {
    const snap = snapshot([
      nodeState("A", "completed"),
      nodeState("B", "running", "run-b"),
    ]);

    const tree = snapshotToSpawnTree(snap);
    const roundTripped = JSON.parse(JSON.stringify(tree));

    expect(roundTripped).toEqual(tree);
  });

  it("is a first-class DAG spawn_tree (object entries with a status field — the DAG-vs-flat discriminator)", () => {
    const snap = snapshot([nodeState("A", "completed")]);

    const tree = snapshotToSpawnTree(snap);

    // Object-with-status entries ⇒ DAG (vs a flat run's string[]).
    expect(typeof tree[0]).toBe("object");
    expect(tree[0]).toHaveProperty("status");
    expect(tree[0]).not.toBe("A"); // not a bare string
  });
});

// ---------------------------------------------------------------------------
// incompleteNodes
// ---------------------------------------------------------------------------

describe("incompleteNodes", () => {
  it("returns exactly the nodeIds whose status is NOT terminal — [A:completed, B:running, C:pending] → [B, C]", () => {
    const tree = [
      { nodeId: "A", status: "completed" },
      { nodeId: "B", status: "running" },
      { nodeId: "C", status: "pending" },
    ];

    expect(incompleteNodes(tree)).toEqual(["B", "C"]);
  });

  it("treats a 'running' node (in-flight at crash) as incomplete (re-run on resume; safe via ledger dedup)", () => {
    const tree = [{ nodeId: "B", status: "running", runId: "run-b" }];

    expect(incompleteNodes(tree)).toEqual(["B"]);
  });

  it("treats 'ready' and 'pending' as incomplete (never started)", () => {
    const tree = [
      { nodeId: "A", status: "ready" },
      { nodeId: "B", status: "pending" },
    ];

    expect(incompleteNodes(tree)).toEqual(["A", "B"]);
  });

  it("excludes completed, skipped, and failed (the terminal set) from the incomplete frontier", () => {
    const tree = [
      { nodeId: "A", status: "completed" },
      { nodeId: "B", status: "skipped" },
      { nodeId: "C", status: "failed" },
      { nodeId: "D", status: "running" },
    ];

    expect(incompleteNodes(tree)).toEqual(["D"]);
  });

  it("returns [] for a fully-completed graph (nothing to resume — markCompleted territory)", () => {
    const tree = [
      { nodeId: "A", status: "completed" },
      { nodeId: "B", status: "completed" },
      { nodeId: "C", status: "skipped" },
    ];

    expect(incompleteNodes(tree)).toEqual([]);
  });

  it("returns [] for an empty spawn tree", () => {
    expect(incompleteNodes([])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Round-trip: snapshot → JSON → parse → incompleteNodes
// ---------------------------------------------------------------------------

describe("round-trip through the durable_runs JSON column", () => {
  it("reflects the original incomplete set after JSON.stringify → JSON.parse", () => {
    const snap = snapshot([
      nodeState("A", "completed"),
      nodeState("B", "running", "run-b"),
      nodeState("C", "pending"),
      nodeState("D", "skipped"),
    ]);

    const tree = snapshotToSpawnTree(snap);
    const persisted = JSON.parse(JSON.stringify(tree)) as Array<{ nodeId: string; status: string }>;

    expect(incompleteNodes(persisted)).toEqual(["B", "C"]);
  });
});

// ---------------------------------------------------------------------------
// TERMINAL_NODE_STATES (the closed set, explicit)
// ---------------------------------------------------------------------------

describe("TERMINAL_NODE_STATES", () => {
  it("is the closed completed/skipped/failed set", () => {
    expect(TERMINAL_NODE_STATES.has("completed")).toBe(true);
    expect(TERMINAL_NODE_STATES.has("skipped")).toBe(true);
    expect(TERMINAL_NODE_STATES.has("failed")).toBe(true);
  });

  it("does NOT include the active states (pending/ready/running)", () => {
    expect(TERMINAL_NODE_STATES.has("pending")).toBe(false);
    expect(TERMINAL_NODE_STATES.has("ready")).toBe(false);
    expect(TERMINAL_NODE_STATES.has("running")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isDagSpawnTree (the DAG-vs-flat discriminator) — resume-engine dispatch routing.
// A DAG run's spawn_tree entries are OBJECTS carrying a `status` field
// ({nodeId,status,runId?} — the snapshotToSpawnTree shape); a FLAT run's are a
// plain string[] of node/lease ids (`spawnTree: z.array(z.string())`).
// The resume engine routes to coordinator.resumeGraph IFF this returns true, so a
// flat run can NEVER mis-route to the graph resume.
// ---------------------------------------------------------------------------

describe("isDagSpawnTree (DAG-vs-flat discriminator)", () => {
  it("is TRUE for object entries carrying a `status` field (a DAG record)", () => {
    expect(isDagSpawnTree([{ nodeId: "A", status: "completed" }, { nodeId: "B", status: "running", runId: "r1" }])).toBe(true);
  });

  it("is FALSE for a plain string[] spawn_tree (a flat sub-agent run)", () => {
    expect(isDagSpawnTree(["lease-1", "lease-2"])).toBe(false);
    expect(isDagSpawnTree(["root-run-id"])).toBe(false);
  });

  it("is FALSE for an empty spawn_tree (no entries ⇒ not a DAG to route)", () => {
    expect(isDagSpawnTree([])).toBe(false);
  });

  it("is the EXPLICIT entry-has-`status` check, not a length/type heuristic (a single DAG node routes; a single flat id does not)", () => {
    expect(isDagSpawnTree([{ nodeId: "only", status: "pending" }])).toBe(true);
    expect(isDagSpawnTree(["only-flat-id"])).toBe(false);
  });
});
