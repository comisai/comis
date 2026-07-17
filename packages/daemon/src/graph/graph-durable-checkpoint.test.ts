// SPDX-License-Identifier: Apache-2.0
/**
 * DAG durable-checkpoint serialization and real-layout artifact tests. Pure
 * snapshot/routing helpers are exercised without I/O; artifact tests build the
 * live `graph-runs/<graphId>/<content-addressed checkpoint>` layout so path
 * resolution is pinned to the filesystem contract used by resume.
 */
import { describe, it, expect } from "vitest";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DurableGraphCheckpoint, NodeExecutionState } from "@comis/core";
import type { GraphExecutionSnapshot } from "./graph-state-machine.js";
import {
  snapshotToSpawnTree,
  incompleteNodes,
  isDagSpawnTree,
  graphRunIdFromCheckpointRef,
  readDurableGraphCheckpoint,
  TERMINAL_NODE_STATES,
  validateGraphCheckpointSummary,
  writeDurableGraphCheckpoint,
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

  it("produces a JSON-serializable array (survives the durable_run_checkpoints TEXT column)", () => {
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

  it("treats a running node as incomplete so recovery can re-enter it after the outward uncertainty gate clears", () => {
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

describe("round-trip through the durable_run_checkpoints JSON column", () => {
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

describe("protected exact-graph checkpoint artifact", () => {
  const checkpoint: DurableGraphCheckpoint = {
    graph: {
      nodes: [
        {
          nodeId: "A",
          task: "private task sentinel",
          dependsOn: [],
          barrierMode: "all",
          retries: 1,
          contextMode: "full",
          mcpServers: [],
        },
        {
          nodeId: "B",
          task: "consume {{A.result}}",
          dependsOn: ["A"],
          barrierMode: "all",
          retries: 2,
          contextMode: "full",
          mcpServers: [],
        },
      ],
      onFailure: "fail-fast",
      timeoutMs: 60_000,
    },
    executionOrder: ["A", "B"],
    nodes: [
      { nodeId: "A", status: "completed", output: "private output sentinel", retryAttempt: 1, retriesRemaining: 0 },
      { nodeId: "B", status: "running", runId: "old-b", retryAttempt: 1, retriesRemaining: 1 },
    ],
    startedAtMs: 10_000,
    cumulativeTokens: 500,
    cumulativeCost: 1.5,
    nodeCacheData: [{ nodeId: "A", cacheReadTokens: 10, cacheWriteTokens: 5 }],
    nodeTokenSpend: [{ nodeId: "A", tokens: 500 }],
    nodeCost: [{ nodeId: "A", cost: 1.5 }],
    skippedNodesEmitted: [],
  };

  it("round-trips exact topology outputs retries and ledgers through an owner-only file", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "comis-graph-checkpoint-"));
    mkdirSync(join(dataDir, "graph-runs", "graph-a"), { recursive: true, mode: 0o700 });
    try {
      const written = writeDurableGraphCheckpoint(dataDir, "graph-a", checkpoint);
      expect(written.ok).toBe(true);
      if (!written.ok) return;
      const read = readDurableGraphCheckpoint(dataDir, written.value);
      expect(read).toEqual({ ok: true, value: checkpoint });
      const workspaceIdentity = graphRunIdFromCheckpointRef(written.value);
      expect(workspaceIdentity).toEqual({
        ok: true,
        value: "graph-a",
      });
      if (workspaceIdentity.ok) {
        expect(join(dataDir, "graph-runs", workspaceIdentity.value)).toBe(
          join(dataDir, "graph-runs", "graph-a"),
        );
        expect(join(dataDir, "graph-runs", workspaceIdentity.value)).not.toBe(
          join(dataDir, "graph-runs", "resume-replacement-authority"),
        );
      }
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("rejects a checkpoint reference that does not identify one graph-run directory", () => {
    expect(graphRunIdFromCheckpointRef("results/durable-checkpoint.json").ok).toBe(false);
    expect(graphRunIdFromCheckpointRef("graph-runs/a/nested/durable-checkpoint.json").ok).toBe(false);
    expect(graphRunIdFromCheckpointRef("graph-runs/../durable-checkpoint.json").ok).toBe(false);
    expect(graphRunIdFromCheckpointRef(`graph-runs/%2e%2e/durable-checkpoint-${"a".repeat(64)}.json`).ok).toBe(false);
    expect(graphRunIdFromCheckpointRef(`graph-runs/graph\\escape/durable-checkpoint-${"a".repeat(64)}.json`).ok).toBe(false);
    expect(graphRunIdFromCheckpointRef("graph-runs/graph-a/durable-checkpoint.json").ok).toBe(false);
  });

  it("rejects checkpoint bytes that do not match the content-addressed reference", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "comis-graph-checkpoint-integrity-"));
    mkdirSync(join(dataDir, "graph-runs", "graph-integrity"), { recursive: true, mode: 0o700 });
    try {
      const written = writeDurableGraphCheckpoint(dataDir, "graph-integrity", checkpoint);
      expect(written.ok).toBe(true);
      if (!written.ok) return;

      const changed: DurableGraphCheckpoint = {
        ...checkpoint,
        cumulativeTokens: checkpoint.cumulativeTokens + 1,
      };
      writeFileSync(join(dataDir, ...written.value.split("/")), JSON.stringify(changed), { mode: 0o600 });

      const read = readDurableGraphCheckpoint(dataDir, written.value);
      expect(read.ok).toBe(false);
      if (!read.ok) expect(read.error.message).toContain("digest");
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("preserves the prior artifact until its authority row can advance", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "comis-graph-checkpoint-version-"));
    mkdirSync(join(dataDir, "graph-runs", "graph-versioned"), { recursive: true, mode: 0o700 });
    try {
      const first = writeDurableGraphCheckpoint(dataDir, "graph-versioned", checkpoint);
      expect(first.ok).toBe(true);
      if (!first.ok) return;
      const advanced: DurableGraphCheckpoint = {
        ...checkpoint,
        nodes: checkpoint.nodes.map((node) =>
          node.nodeId === "B"
            ? { ...node, status: "completed", output: "second checkpoint output" }
            : node
        ),
        cumulativeTokens: 900,
        cumulativeCost: 2,
      };

      const second = writeDurableGraphCheckpoint(dataDir, "graph-versioned", advanced);
      expect(second.ok).toBe(true);
      if (!second.ok) return;

      expect(second.value).not.toBe(first.value);
      expect(readDurableGraphCheckpoint(dataDir, first.value)).toEqual({
        ok: true,
        value: checkpoint,
      });
      expect(readDurableGraphCheckpoint(dataDir, second.value)).toEqual({
        ok: true,
        value: advanced,
      });
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("rejects a routing summary whose status or run id diverges from the artifact", () => {
    expect(validateGraphCheckpointSummary([
      { nodeId: "A", status: "completed" },
      { nodeId: "B", status: "ready" },
    ], checkpoint).ok).toBe(false);
  });

  it("refuses an artifact larger than the bounded restart reader can load", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "comis-graph-checkpoint-cap-"));
    const graphDir = join(dataDir, "graph-runs", "graph-large");
    mkdirSync(graphDir, { recursive: true, mode: 0o700 });
    const oversized: DurableGraphCheckpoint = {
      ...checkpoint,
      graph: {
        ...checkpoint.graph,
        nodes: checkpoint.graph.nodes.map((node, index) =>
          index === 0 ? { ...node, task: "x".repeat(8 * 1024 * 1024) } : node
        ),
      },
    };
    try {
      const written = writeDurableGraphCheckpoint(dataDir, "graph-large", oversized);
      expect(written.ok).toBe(false);
      expect(existsSync(join(graphDir, "durable-checkpoint.json"))).toBe(false);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
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
