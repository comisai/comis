// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { createGraphStateMachine } from "./graph-state-machine.js";
import {
  type ExecutionGraph,
  type ValidatedGraph,
  validateAndSortGraph,
} from "@comis/core";

// ---------------------------------------------------------------------------
// Test helper: build a ValidatedGraph from simple node definitions
// ---------------------------------------------------------------------------

interface SimpleNode {
  nodeId: string;
  task?: string;
  dependsOn?: string[];
  barrierMode?: "all" | "majority" | "best-effort";
  retries?: number;
}

function buildGraph(nodes: SimpleNode[], opts?: Partial<ExecutionGraph>): ValidatedGraph {
  const graph: ExecutionGraph = {
    nodes: nodes.map((n) => ({
      nodeId: n.nodeId,
      task: n.task ?? `Task ${n.nodeId}`,
      dependsOn: n.dependsOn ?? [],
      ...(n.barrierMode ? { barrierMode: n.barrierMode } : {}),
      retries: n.retries ?? 0,
    })),
    onFailure: opts?.onFailure ?? "fail-fast",
    ...opts,
  };
  const result = validateAndSortGraph(graph);
  if (!result.ok) {
    throw new Error(`Invalid test graph: ${result.error.message}`);
  }
  return result.value;
}

// ---------------------------------------------------------------------------
// Initialization
// ---------------------------------------------------------------------------

describe("createGraphStateMachine", () => {
  describe("initialization", () => {
    it("root nodes start as ready", () => {
      const sm = createGraphStateMachine(buildGraph([
        { nodeId: "A" },
        { nodeId: "B", dependsOn: ["A"] },
      ]));
      expect(sm.getNodeState("A")?.status).toBe("ready");
    });

    it("non-root nodes start as pending", () => {
      const sm = createGraphStateMachine(buildGraph([
        { nodeId: "A" },
        { nodeId: "B", dependsOn: ["A"] },
      ]));
      expect(sm.getNodeState("B")?.status).toBe("pending");
    });

    it("getReadyNodes returns only root nodes initially", () => {
      const sm = createGraphStateMachine(buildGraph([
        { nodeId: "A" },
        { nodeId: "B" },
        { nodeId: "C", dependsOn: ["A", "B"] },
      ]));
      const ready = sm.getReadyNodes();
      expect(ready).toHaveLength(2);
      expect(ready).toContain("A");
      expect(ready).toContain("B");
    });

    it("getGraphStatus returns running initially", () => {
      const sm = createGraphStateMachine(buildGraph([{ nodeId: "A" }]));
      expect(sm.getGraphStatus()).toBe("running");
    });

    it("isTerminal returns false initially", () => {
      const sm = createGraphStateMachine(buildGraph([{ nodeId: "A" }]));
      expect(sm.isTerminal()).toBe(false);
    });

    it("getExecutionOrder returns topological order", () => {
      const sm = createGraphStateMachine(buildGraph([
        { nodeId: "A" },
        { nodeId: "B", dependsOn: ["A"] },
        { nodeId: "C", dependsOn: ["B"] },
      ]));
      expect(sm.getExecutionOrder()).toEqual(["A", "B", "C"]);
    });
  });

  // -------------------------------------------------------------------------
  // markNodeRunning
  // -------------------------------------------------------------------------

  describe("markNodeRunning", () => {
    it("transitions ready node to running with runId", () => {
      const sm = createGraphStateMachine(buildGraph([{ nodeId: "A" }]));
      const result = sm.markNodeRunning("A", "run-1");
      expect(result.ok).toBe(true);
      expect(sm.getNodeState("A")?.status).toBe("running");
      expect(sm.getNodeState("A")?.runId).toBe("run-1");
    });

    it("sets startedAt timestamp", () => {
      const sm = createGraphStateMachine(buildGraph([{ nodeId: "A" }]));
      sm.markNodeRunning("A", "run-1");
      expect(sm.getNodeState("A")?.startedAt).toBeTypeOf("number");
    });

    it("returns err for non-existent nodeId", () => {
      const sm = createGraphStateMachine(buildGraph([{ nodeId: "A" }]));
      const result = sm.markNodeRunning("Z", "run-1");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("not found");
      }
    });

    it("returns err for node not in ready state (pending)", () => {
      const sm = createGraphStateMachine(buildGraph([
        { nodeId: "A" },
        { nodeId: "B", dependsOn: ["A"] },
      ]));
      const result = sm.markNodeRunning("B", "run-1");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("pending");
      }
    });
  });

  // -------------------------------------------------------------------------
  // markNodeCompleted
  // -------------------------------------------------------------------------

  describe("markNodeCompleted", () => {
    it("transitions running node to completed with output", () => {
      const sm = createGraphStateMachine(buildGraph([{ nodeId: "A" }]));
      sm.markNodeRunning("A", "run-1");
      const result = sm.markNodeCompleted("A", "result data");
      expect(result.ok).toBe(true);
      expect(sm.getNodeState("A")?.status).toBe("completed");
      expect(sm.getNodeState("A")?.output).toBe("result data");
    });

    it("sets completedAt timestamp", () => {
      const sm = createGraphStateMachine(buildGraph([{ nodeId: "A" }]));
      sm.markNodeRunning("A", "run-1");
      sm.markNodeCompleted("A");
      expect(sm.getNodeState("A")?.completedAt).toBeTypeOf("number");
    });

    it("returns newly ready downstream nodes", () => {
      const sm = createGraphStateMachine(buildGraph([
        { nodeId: "A" },
        { nodeId: "B", dependsOn: ["A"] },
      ]));
      sm.markNodeRunning("A", "run-1");
      const result = sm.markNodeCompleted("A");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toEqual(["B"]);
      }
    });

    it("returns err for node not in running state", () => {
      const sm = createGraphStateMachine(buildGraph([{ nodeId: "A" }]));
      const result = sm.markNodeCompleted("A");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("ready");
      }
    });

    it("linear chain: completing A makes B ready, completing B makes C ready", () => {
      const sm = createGraphStateMachine(buildGraph([
        { nodeId: "A" },
        { nodeId: "B", dependsOn: ["A"] },
        { nodeId: "C", dependsOn: ["B"] },
      ]));

      sm.markNodeRunning("A", "run-1");
      const r1 = sm.markNodeCompleted("A");
      expect(r1.ok && r1.value).toEqual(["B"]);

      sm.markNodeRunning("B", "run-2");
      const r2 = sm.markNodeCompleted("B");
      expect(r2.ok && r2.value).toEqual(["C"]);
    });

    it("diamond: completing B does NOT make D ready; completing C after B makes D ready", () => {
      // A -> B -> D
      // A -> C -> D
      const sm = createGraphStateMachine(buildGraph([
        { nodeId: "A" },
        { nodeId: "B", dependsOn: ["A"] },
        { nodeId: "C", dependsOn: ["A"] },
        { nodeId: "D", dependsOn: ["B", "C"] },
      ]));

      sm.markNodeRunning("A", "run-1");
      sm.markNodeCompleted("A"); // B and C become ready

      sm.markNodeRunning("B", "run-2");
      const r1 = sm.markNodeCompleted("B");
      expect(r1.ok && r1.value).toEqual([]); // D not ready, C still pending

      sm.markNodeRunning("C", "run-3");
      const r2 = sm.markNodeCompleted("C");
      expect(r2.ok && r2.value).toEqual(["D"]); // Now D ready
    });
  });

  // -------------------------------------------------------------------------
  // markNodeFailed
  // -------------------------------------------------------------------------

  describe("markNodeFailed", () => {
    it("transitions running node to failed with error message", () => {
      const sm = createGraphStateMachine(buildGraph([{ nodeId: "A" }]));
      sm.markNodeRunning("A", "run-1");
      const result = sm.markNodeFailed("A", "something broke");
      expect(result.ok).toBe(true);
      expect(sm.getNodeState("A")?.status).toBe("failed");
      expect(sm.getNodeState("A")?.error).toBe("something broke");
    });

    it("sets completedAt on the failed node", () => {
      const sm = createGraphStateMachine(buildGraph([{ nodeId: "A" }]));
      sm.markNodeRunning("A", "run-1");
      sm.markNodeFailed("A", "error");
      expect(sm.getNodeState("A")?.completedAt).toBeTypeOf("number");
    });

    it("failure cascade (direct): A fails -> B (depends on A) skipped", () => {
      const sm = createGraphStateMachine(buildGraph([
        { nodeId: "A" },
        { nodeId: "B", dependsOn: ["A"] },
      ]));
      sm.markNodeRunning("A", "run-1");
      const result = sm.markNodeFailed("A", "error");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.skipped).toEqual(["B"]);
        expect(result.value.newlyReady).toEqual([]);
      }
      expect(sm.getNodeState("B")?.status).toBe("skipped");
    });

    it("failure cascade (transitive): A fails -> B skipped -> C skipped", () => {
      const sm = createGraphStateMachine(buildGraph([
        { nodeId: "A" },
        { nodeId: "B", dependsOn: ["A"] },
        { nodeId: "C", dependsOn: ["B"] },
      ]));
      sm.markNodeRunning("A", "run-1");
      const result = sm.markNodeFailed("A", "error");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.skipped).toContain("B");
        expect(result.value.skipped).toContain("C");
        expect(result.value.skipped).toHaveLength(2);
        expect(result.value.newlyReady).toEqual([]);
      }
      expect(sm.getNodeState("B")?.status).toBe("skipped");
      expect(sm.getNodeState("C")?.status).toBe("skipped");
    });

    it("failure cascade (partial): only affected branches skipped", () => {
      // A and B are roots
      // C depends on A (will be skipped)
      // D depends on B (unaffected)
      // E depends on C and D (skipped because C is skipped)
      const sm = createGraphStateMachine(buildGraph([
        { nodeId: "A" },
        { nodeId: "B" },
        { nodeId: "C", dependsOn: ["A"] },
        { nodeId: "D", dependsOn: ["B"] },
        { nodeId: "E", dependsOn: ["C", "D"] },
      ]));

      sm.markNodeRunning("A", "run-1");
      const result = sm.markNodeFailed("A", "error");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.skipped).toContain("C");
        expect(result.value.skipped).toContain("E");
        expect(result.value.skipped).not.toContain("D");
      }
      expect(sm.getNodeState("C")?.status).toBe("skipped");
      expect(sm.getNodeState("D")?.status).toBe("pending"); // unaffected
      expect(sm.getNodeState("E")?.status).toBe("skipped");
    });

    it("sets completedAt on all skipped nodes", () => {
      const sm = createGraphStateMachine(buildGraph([
        { nodeId: "A" },
        { nodeId: "B", dependsOn: ["A"] },
        { nodeId: "C", dependsOn: ["B"] },
      ]));
      sm.markNodeRunning("A", "run-1");
      sm.markNodeFailed("A", "error");
      expect(sm.getNodeState("B")?.completedAt).toBeTypeOf("number");
      expect(sm.getNodeState("C")?.completedAt).toBeTypeOf("number");
    });

    it("returns err for node not in running state", () => {
      const sm = createGraphStateMachine(buildGraph([{ nodeId: "A" }]));
      const result = sm.markNodeFailed("A", "error");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("ready");
      }
    });
  });

  // -------------------------------------------------------------------------
  // Invalid transitions
  // -------------------------------------------------------------------------

  describe("invalid transitions", () => {
    it("cannot transition completed -> running", () => {
      const sm = createGraphStateMachine(buildGraph([{ nodeId: "A" }]));
      sm.markNodeRunning("A", "run-1");
      sm.markNodeCompleted("A");
      const result = sm.markNodeRunning("A", "run-2");
      expect(result.ok).toBe(false);
    });

    it("cannot transition failed -> running", () => {
      const sm = createGraphStateMachine(buildGraph([{ nodeId: "A" }]));
      sm.markNodeRunning("A", "run-1");
      sm.markNodeFailed("A", "error");
      const result = sm.markNodeRunning("A", "run-2");
      expect(result.ok).toBe(false);
    });

    it("cannot transition skipped -> running", () => {
      const sm = createGraphStateMachine(buildGraph([
        { nodeId: "A" },
        { nodeId: "B", dependsOn: ["A"] },
      ]));
      sm.markNodeRunning("A", "run-1");
      sm.markNodeFailed("A", "error");
      // B is now skipped via cascade
      const result = sm.markNodeRunning("B", "run-2");
      expect(result.ok).toBe(false);
    });

    it("cannot markNodeCompleted on a ready node", () => {
      const sm = createGraphStateMachine(buildGraph([{ nodeId: "A" }]));
      const result = sm.markNodeCompleted("A");
      expect(result.ok).toBe(false);
    });

    it("cannot markNodeFailed on a pending node", () => {
      const sm = createGraphStateMachine(buildGraph([
        { nodeId: "A" },
        { nodeId: "B", dependsOn: ["A"] },
      ]));
      const result = sm.markNodeFailed("B", "error");
      expect(result.ok).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Graph status
  // -------------------------------------------------------------------------

  describe("getGraphStatus", () => {
    it("returns running when nodes are still active", () => {
      const sm = createGraphStateMachine(buildGraph([
        { nodeId: "A" },
        { nodeId: "B", dependsOn: ["A"] },
      ]));
      expect(sm.getGraphStatus()).toBe("running");
    });

    it("returns completed when all terminal with at least one completed", () => {
      const sm = createGraphStateMachine(buildGraph([{ nodeId: "A" }]));
      sm.markNodeRunning("A", "run-1");
      sm.markNodeCompleted("A");
      expect(sm.getGraphStatus()).toBe("completed");
    });

    it("returns completed when mix of completed and skipped", () => {
      const sm = createGraphStateMachine(buildGraph([
        { nodeId: "A" },
        { nodeId: "B" },
        { nodeId: "C", dependsOn: ["A"] },
      ]));
      sm.markNodeRunning("A", "run-1");
      sm.markNodeCompleted("A"); // C becomes ready
      sm.markNodeRunning("B", "run-2");
      sm.markNodeFailed("B", "error"); // B failed, no cascade (C doesn't depend on B)
      sm.markNodeRunning("C", "run-3");
      sm.markNodeCompleted("C");
      // A=completed, B=failed, C=completed
      // All terminal, at least one completed
      expect(sm.getGraphStatus()).toBe("completed");
    });

    it("returns failed when all terminal and none completed", () => {
      const sm = createGraphStateMachine(buildGraph([
        { nodeId: "A" },
        { nodeId: "B", dependsOn: ["A"] },
      ]));
      sm.markNodeRunning("A", "run-1");
      sm.markNodeFailed("A", "error"); // B cascades to skipped
      // A=failed, B=skipped. None completed.
      expect(sm.getGraphStatus()).toBe("failed");
    });
  });

  // -------------------------------------------------------------------------
  // Terminal detection
  // -------------------------------------------------------------------------

  describe("isTerminal", () => {
    it("not terminal with pending nodes", () => {
      const sm = createGraphStateMachine(buildGraph([
        { nodeId: "A" },
        { nodeId: "B", dependsOn: ["A"] },
      ]));
      sm.markNodeRunning("A", "run-1");
      sm.markNodeCompleted("A");
      // B is now ready, not terminal
      expect(sm.isTerminal()).toBe(false);
    });

    it("not terminal with ready nodes", () => {
      const sm = createGraphStateMachine(buildGraph([{ nodeId: "A" }]));
      expect(sm.isTerminal()).toBe(false);
    });

    it("not terminal with running nodes", () => {
      const sm = createGraphStateMachine(buildGraph([{ nodeId: "A" }]));
      sm.markNodeRunning("A", "run-1");
      expect(sm.isTerminal()).toBe(false);
    });

    it("terminal when all completed", () => {
      const sm = createGraphStateMachine(buildGraph([
        { nodeId: "A" },
        { nodeId: "B", dependsOn: ["A"] },
      ]));
      sm.markNodeRunning("A", "run-1");
      sm.markNodeCompleted("A");
      sm.markNodeRunning("B", "run-2");
      sm.markNodeCompleted("B");
      expect(sm.isTerminal()).toBe(true);
    });

    it("terminal when mix of completed + skipped", () => {
      const sm = createGraphStateMachine(buildGraph([
        { nodeId: "A" },
        { nodeId: "B" },
        { nodeId: "C", dependsOn: ["B"] },
      ]));
      sm.markNodeRunning("A", "run-1");
      sm.markNodeCompleted("A");
      sm.markNodeRunning("B", "run-2");
      sm.markNodeFailed("B", "error"); // C skipped
      expect(sm.isTerminal()).toBe(true);
    });

    it("terminal when all failed + skipped", () => {
      const sm = createGraphStateMachine(buildGraph([
        { nodeId: "A" },
        { nodeId: "B", dependsOn: ["A"] },
      ]));
      sm.markNodeRunning("A", "run-1");
      sm.markNodeFailed("A", "error"); // B skipped
      expect(sm.isTerminal()).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // cancel
  // -------------------------------------------------------------------------

  describe("cancel", () => {
    it("marks all pending and ready nodes as skipped", () => {
      const sm = createGraphStateMachine(buildGraph([
        { nodeId: "A" },
        { nodeId: "B" },
        { nodeId: "C", dependsOn: ["A"] },
      ]));
      const cancelled = sm.cancel();
      expect(cancelled).toHaveLength(3);
      expect(cancelled).toContain("A");
      expect(cancelled).toContain("B");
      expect(cancelled).toContain("C");
      expect(sm.getNodeState("A")?.status).toBe("skipped");
      expect(sm.getNodeState("B")?.status).toBe("skipped");
      expect(sm.getNodeState("C")?.status).toBe("skipped");
    });

    it("returns the IDs of cancelled nodes", () => {
      const sm = createGraphStateMachine(buildGraph([{ nodeId: "A" }]));
      const cancelled = sm.cancel();
      expect(cancelled).toEqual(["A"]);
    });

    it("does not affect running nodes", () => {
      const sm = createGraphStateMachine(buildGraph([
        { nodeId: "A" },
        { nodeId: "B" },
        { nodeId: "C", dependsOn: ["A"] },
      ]));
      sm.markNodeRunning("A", "run-1");
      const cancelled = sm.cancel();
      expect(cancelled).toContain("B");
      expect(cancelled).toContain("C");
      expect(cancelled).not.toContain("A");
      expect(sm.getNodeState("A")?.status).toBe("running");
    });

    it("after cancel + running nodes complete, isTerminal is true", () => {
      const sm = createGraphStateMachine(buildGraph([
        { nodeId: "A" },
        { nodeId: "B" },
      ]));
      sm.markNodeRunning("A", "run-1");
      sm.cancel(); // B becomes skipped, A still running
      expect(sm.isTerminal()).toBe(false);
      sm.markNodeCompleted("A");
      expect(sm.isTerminal()).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // snapshot
  // -------------------------------------------------------------------------

  describe("snapshot", () => {
    it("returns a clone (modifying snapshot does not affect state machine)", () => {
      const sm = createGraphStateMachine(buildGraph([{ nodeId: "A" }]));
      const snap = sm.snapshot();
      // Mutate the snapshot
      snap.nodes.get("A")!.status = "completed";
      // Original should be unaffected
      expect(sm.getNodeState("A")?.status).toBe("ready");
    });

    it("contains all node states, graphStatus, executionOrder, isTerminal", () => {
      const sm = createGraphStateMachine(buildGraph([
        { nodeId: "A" },
        { nodeId: "B", dependsOn: ["A"] },
      ]));
      const snap = sm.snapshot();
      expect(snap.graphStatus).toBe("running");
      expect(snap.nodes.size).toBe(2);
      expect(snap.executionOrder).toEqual(["A", "B"]);
      expect(snap.isTerminal).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // End-to-end scenario
  // -------------------------------------------------------------------------

  // -------------------------------------------------------------------------
  // Barrier modes
  // -------------------------------------------------------------------------

  describe("barrier modes", () => {
    it("all barrier (default): requires all deps completed", () => {
      // A, B, C roots. D depends on all three with default barrier (all).
      const sm = createGraphStateMachine(buildGraph([
        { nodeId: "A" },
        { nodeId: "B" },
        { nodeId: "C" },
        { nodeId: "D", dependsOn: ["A", "B", "C"] },
      ]));

      sm.markNodeRunning("A", "r1");
      sm.markNodeCompleted("A");
      expect(sm.getNodeState("D")?.status).toBe("pending"); // not all deps done

      sm.markNodeRunning("B", "r2");
      sm.markNodeCompleted("B");
      expect(sm.getNodeState("D")?.status).toBe("pending"); // still waiting for C

      sm.markNodeRunning("C", "r3");
      sm.markNodeCompleted("C");
      expect(sm.getNodeState("D")?.status).toBe("ready"); // now all 3 completed
    });

    it("majority barrier: fires when >50% of deps completed and all terminal", () => {
      // A, B, C roots. D depends on all three with majority barrier.
      const sm = createGraphStateMachine(buildGraph([
        { nodeId: "A" },
        { nodeId: "B" },
        { nodeId: "C" },
        { nodeId: "D", dependsOn: ["A", "B", "C"], barrierMode: "majority" },
      ], { onFailure: "continue" }));

      // Complete A, fail B, complete C -> 2/3 completed (>50%), all terminal
      sm.markNodeRunning("A", "r1");
      sm.markNodeCompleted("A");
      expect(sm.getNodeState("D")?.status).toBe("pending");

      sm.markNodeRunning("B", "r2");
      sm.markNodeFailed("B", "error");
      expect(sm.getNodeState("D")?.status).toBe("pending"); // C still running

      sm.markNodeRunning("C", "r3");
      sm.markNodeCompleted("C");
      // Now all deps terminal: A=completed, B=failed, C=completed
      // 2/3 completed > 50% -> D should be ready
      expect(sm.getNodeState("D")?.status).toBe("ready");
    });

    it("majority barrier does NOT fire early when deps still running", () => {
      const sm = createGraphStateMachine(buildGraph([
        { nodeId: "A" },
        { nodeId: "B" },
        { nodeId: "C" },
        { nodeId: "D", dependsOn: ["A", "B", "C"], barrierMode: "majority" },
      ], { onFailure: "continue" }));

      sm.markNodeRunning("A", "r1");
      sm.markNodeCompleted("A");
      sm.markNodeRunning("B", "r2");
      sm.markNodeCompleted("B");
      // 2/3 completed (>50%) but C is still ready (not terminal)
      expect(sm.getNodeState("D")?.status).toBe("pending");
    });

    it("majority with 2 deps: both must complete (>50% of 2 requires > 1)", () => {
      const sm = createGraphStateMachine(buildGraph([
        { nodeId: "A" },
        { nodeId: "B" },
        { nodeId: "C", dependsOn: ["A", "B"], barrierMode: "majority" },
      ], { onFailure: "continue" }));

      sm.markNodeRunning("A", "r1");
      sm.markNodeCompleted("A");
      sm.markNodeRunning("B", "r2");
      sm.markNodeFailed("B", "error");
      // 1/2 completed = 50%, not >50% -> C stays pending/skipped
      expect(sm.getNodeState("C")?.status).not.toBe("ready");
    });

    it("majority with 4 deps: 3 must complete (>50% of 4 requires > 2)", () => {
      const sm = createGraphStateMachine(buildGraph([
        { nodeId: "A" },
        { nodeId: "B" },
        { nodeId: "C" },
        { nodeId: "D" },
        { nodeId: "E", dependsOn: ["A", "B", "C", "D"], barrierMode: "majority" },
      ], { onFailure: "continue" }));

      sm.markNodeRunning("A", "r1");
      sm.markNodeCompleted("A");
      sm.markNodeRunning("B", "r2");
      sm.markNodeCompleted("B");
      sm.markNodeRunning("C", "r3");
      sm.markNodeFailed("C", "error");
      // 2 completed, 1 failed, D still running -> not all terminal
      expect(sm.getNodeState("E")?.status).toBe("pending");

      sm.markNodeRunning("D", "r4");
      sm.markNodeCompleted("D");
      // Now 3/4 completed > 50%, all terminal -> E ready
      expect(sm.getNodeState("E")?.status).toBe("ready");
    });

    it("best-effort barrier: fires when all deps terminal and at least 1 completed", () => {
      const sm = createGraphStateMachine(buildGraph([
        { nodeId: "A" },
        { nodeId: "B" },
        { nodeId: "C" },
        { nodeId: "D", dependsOn: ["A", "B", "C"], barrierMode: "best-effort" },
      ], { onFailure: "continue" }));

      // Complete A, fail B and C -> all terminal, 1 completed
      sm.markNodeRunning("A", "r1");
      sm.markNodeCompleted("A");
      sm.markNodeRunning("B", "r2");
      sm.markNodeFailed("B", "error");
      expect(sm.getNodeState("D")?.status).toBe("pending"); // C still pending

      sm.markNodeRunning("C", "r3");
      sm.markNodeFailed("C", "error");
      // All terminal: A=completed, B=failed, C=failed. 1 completed >= 1 -> D ready
      expect(sm.getNodeState("D")?.status).toBe("ready");
    });

    it("best-effort with all deps failed: D skipped (0 completed)", () => {
      const sm = createGraphStateMachine(buildGraph([
        { nodeId: "A" },
        { nodeId: "B" },
        { nodeId: "D", dependsOn: ["A", "B"], barrierMode: "best-effort" },
      ], { onFailure: "continue" }));

      sm.markNodeRunning("A", "r1");
      sm.markNodeFailed("A", "error");
      sm.markNodeRunning("B", "r2");
      sm.markNodeFailed("B", "error");
      // All terminal but 0 completed -> D should be skipped
      expect(sm.getNodeState("D")?.status).toBe("skipped");
    });

    it("best-effort does NOT fire early when deps still running", () => {
      const sm = createGraphStateMachine(buildGraph([
        { nodeId: "A" },
        { nodeId: "B" },
        { nodeId: "C", dependsOn: ["A", "B"], barrierMode: "best-effort" },
      ], { onFailure: "continue" }));

      sm.markNodeRunning("A", "r1");
      sm.markNodeCompleted("A");
      // A completed but B still ready (not terminal) -> C stays pending
      expect(sm.getNodeState("C")?.status).toBe("pending");
    });
  });

  // -------------------------------------------------------------------------
  // Barrier mode x failure policy combinations (6 combinations)
  // -------------------------------------------------------------------------

  describe("barrier mode x failure policy combinations", () => {
    // Graph: A, B, C are roots. D depends on [A, B, C].
    // Scenario: A=completed, B=failed, C=completed

    it("all + fail-fast: D skipped (B failed)", () => {
      const sm = createGraphStateMachine(buildGraph([
        { nodeId: "A" },
        { nodeId: "B" },
        { nodeId: "C" },
        { nodeId: "D", dependsOn: ["A", "B", "C"], barrierMode: "all" },
      ], { onFailure: "fail-fast" }));

      sm.markNodeRunning("A", "r1");
      sm.markNodeCompleted("A");
      sm.markNodeRunning("C", "r3");
      sm.markNodeCompleted("C");
      sm.markNodeRunning("B", "r2");
      const result = sm.markNodeFailed("B", "error");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.skipped).toContain("D");
      }
      expect(sm.getNodeState("D")?.status).toBe("skipped");
    });

    it("all + continue: D skipped (needs all 3 completed, impossible)", () => {
      const sm = createGraphStateMachine(buildGraph([
        { nodeId: "A" },
        { nodeId: "B" },
        { nodeId: "C" },
        { nodeId: "D", dependsOn: ["A", "B", "C"], barrierMode: "all" },
      ], { onFailure: "continue" }));

      sm.markNodeRunning("A", "r1");
      sm.markNodeCompleted("A");
      sm.markNodeRunning("C", "r3");
      sm.markNodeCompleted("C");
      sm.markNodeRunning("B", "r2");
      const result = sm.markNodeFailed("B", "error");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.skipped).toContain("D");
      }
      expect(sm.getNodeState("D")?.status).toBe("skipped");
    });

    it("majority + fail-fast: D skipped (B failed, fail-fast cascades)", () => {
      const sm = createGraphStateMachine(buildGraph([
        { nodeId: "A" },
        { nodeId: "B" },
        { nodeId: "C" },
        { nodeId: "D", dependsOn: ["A", "B", "C"], barrierMode: "majority" },
      ], { onFailure: "fail-fast" }));

      sm.markNodeRunning("A", "r1");
      sm.markNodeCompleted("A");
      sm.markNodeRunning("C", "r3");
      sm.markNodeCompleted("C");
      sm.markNodeRunning("B", "r2");
      const result = sm.markNodeFailed("B", "error");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.skipped).toContain("D");
      }
      expect(sm.getNodeState("D")?.status).toBe("skipped");
    });

    it("majority + continue: D ready (2/3 completed > 50%, all terminal)", () => {
      const sm = createGraphStateMachine(buildGraph([
        { nodeId: "A" },
        { nodeId: "B" },
        { nodeId: "C" },
        { nodeId: "D", dependsOn: ["A", "B", "C"], barrierMode: "majority" },
      ], { onFailure: "continue" }));

      sm.markNodeRunning("A", "r1");
      sm.markNodeCompleted("A");
      sm.markNodeRunning("C", "r3");
      sm.markNodeCompleted("C");
      sm.markNodeRunning("B", "r2");
      const result = sm.markNodeFailed("B", "error");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.newlyReady).toContain("D");
        expect(result.value.skipped).not.toContain("D");
      }
      expect(sm.getNodeState("D")?.status).toBe("ready");
    });

    it("best-effort + fail-fast: D skipped (B failed, fail-fast cascades)", () => {
      const sm = createGraphStateMachine(buildGraph([
        { nodeId: "A" },
        { nodeId: "B" },
        { nodeId: "C" },
        { nodeId: "D", dependsOn: ["A", "B", "C"], barrierMode: "best-effort" },
      ], { onFailure: "fail-fast" }));

      sm.markNodeRunning("A", "r1");
      sm.markNodeCompleted("A");
      sm.markNodeRunning("C", "r3");
      sm.markNodeCompleted("C");
      sm.markNodeRunning("B", "r2");
      const result = sm.markNodeFailed("B", "error");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.skipped).toContain("D");
      }
      expect(sm.getNodeState("D")?.status).toBe("skipped");
    });

    it("best-effort + continue: D ready (all terminal, 2 completed >= 1)", () => {
      const sm = createGraphStateMachine(buildGraph([
        { nodeId: "A" },
        { nodeId: "B" },
        { nodeId: "C" },
        { nodeId: "D", dependsOn: ["A", "B", "C"], barrierMode: "best-effort" },
      ], { onFailure: "continue" }));

      sm.markNodeRunning("A", "r1");
      sm.markNodeCompleted("A");
      sm.markNodeRunning("C", "r3");
      sm.markNodeCompleted("C");
      sm.markNodeRunning("B", "r2");
      const result = sm.markNodeFailed("B", "error");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.newlyReady).toContain("D");
        expect(result.value.skipped).not.toContain("D");
      }
      expect(sm.getNodeState("D")?.status).toBe("ready");
    });
  });

  // -------------------------------------------------------------------------
  // Continue-on-failure policy
  // -------------------------------------------------------------------------

  describe("continue-on-failure policy", () => {
    it("independent branch unaffected by failure in other branch", () => {
      // Branch 1: A -> C
      // Branch 2: B -> D -> E
      // A fails -> C skipped. B->D->E completely unaffected.
      const sm = createGraphStateMachine(buildGraph([
        { nodeId: "A" },
        { nodeId: "B" },
        { nodeId: "C", dependsOn: ["A"] },
        { nodeId: "D", dependsOn: ["B"] },
        { nodeId: "E", dependsOn: ["D"] },
      ], { onFailure: "continue" }));

      sm.markNodeRunning("A", "r1");
      const result = sm.markNodeFailed("A", "error");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.skipped).toContain("C");
        expect(result.value.skipped).not.toContain("D");
        expect(result.value.skipped).not.toContain("E");
      }
      expect(sm.getNodeState("D")?.status).toBe("pending"); // unaffected
      expect(sm.getNodeState("E")?.status).toBe("pending"); // unaffected

      // Branch 2 proceeds normally
      sm.markNodeRunning("B", "r2");
      sm.markNodeCompleted("B");
      expect(sm.getNodeState("D")?.status).toBe("ready");
    });

    it("markNodeFailed returns both skipped and newlyReady", () => {
      // A, B roots. C (best-effort) depends on [A, B].
      // D (all) depends on [A].
      // A fails -> D skipped (all barrier, can't satisfy).
      //         -> C stays pending (B still running).
      // Then B completes -> C should become ready via evaluateBarriers.
      const sm = createGraphStateMachine(buildGraph([
        { nodeId: "A" },
        { nodeId: "B" },
        { nodeId: "C", dependsOn: ["A", "B"], barrierMode: "best-effort" },
        { nodeId: "D", dependsOn: ["A"] },
      ], { onFailure: "continue" }));

      sm.markNodeRunning("A", "r1");
      const failResult = sm.markNodeFailed("A", "error");
      expect(failResult.ok).toBe(true);
      if (failResult.ok) {
        // D depends only on A with all barrier, unsatisfiable
        expect(failResult.value.skipped).toContain("D");
        // C still has B pending, so not newly ready yet
        expect(failResult.value.newlyReady).not.toContain("C");
      }

      // B completes -> C should become ready (best-effort: all terminal, 1 completed)
      sm.markNodeRunning("B", "r2");
      const completeResult = sm.markNodeCompleted("B");
      expect(completeResult.ok).toBe(true);
      if (completeResult.ok) {
        expect(completeResult.value).toContain("C");
      }
      expect(sm.getNodeState("C")?.status).toBe("ready");
    });

    it("markNodeFailed returns { skipped, newlyReady } structure", () => {
      const sm = createGraphStateMachine(buildGraph([
        { nodeId: "A" },
        { nodeId: "B", dependsOn: ["A"] },
      ]));
      sm.markNodeRunning("A", "r1");
      const result = sm.markNodeFailed("A", "error");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toHaveProperty("skipped");
        expect(result.value).toHaveProperty("newlyReady");
        expect(Array.isArray(result.value.skipped)).toBe(true);
        expect(Array.isArray(result.value.newlyReady)).toBe(true);
      }
    });
  });

  // -------------------------------------------------------------------------
  // Per-node retry
  // -------------------------------------------------------------------------

  describe("per-node retry", () => {
    it("node with retries transitions back to ready on first failure", () => {
      const sm = createGraphStateMachine(buildGraph([
        { nodeId: "A", retries: 2 },
      ]));

      sm.markNodeRunning("A", "run-1");
      const result = sm.markNodeFailed("A", "transient error");

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.retrying).toEqual(["A"]);
        expect(result.value.skipped).toEqual([]);
        expect(result.value.newlyReady).toEqual([]);
      }

      const state = sm.getNodeState("A");
      expect(state?.status).toBe("ready");
      expect(state?.retryAttempt).toBe(1);
      expect(state?.retriesRemaining).toBe(1);
      expect(state?.error).toBe("transient error");
    });

    it("node exhausts all retries then transitions to failed", () => {
      const sm = createGraphStateMachine(buildGraph([
        { nodeId: "A", retries: 2 },
      ]));

      // Attempt 1: fail -> retry (retryAttempt=1, retriesRemaining=1)
      sm.markNodeRunning("A", "run-1");
      sm.markNodeFailed("A", "error 1");
      expect(sm.getNodeState("A")?.status).toBe("ready");

      // Attempt 2: fail -> retry (retryAttempt=2, retriesRemaining=0)
      sm.markNodeRunning("A", "run-2");
      sm.markNodeFailed("A", "error 2");
      expect(sm.getNodeState("A")?.status).toBe("ready");

      // Attempt 3: fail -> exhausted -> failed
      sm.markNodeRunning("A", "run-3");
      const result = sm.markNodeFailed("A", "error 3");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.retrying).toEqual([]);
      }

      const state = sm.getNodeState("A");
      expect(state?.status).toBe("failed");
      expect(state?.retryAttempt).toBe(2);
      expect(state?.retriesRemaining).toBe(0);
    });

    it("downstream nodes are NOT cascade-skipped during retry", () => {
      const sm = createGraphStateMachine(buildGraph([
        { nodeId: "A", retries: 1 },
        { nodeId: "B", dependsOn: ["A"] },
      ]));

      sm.markNodeRunning("A", "run-1");
      sm.markNodeFailed("A", "transient");

      // A retried -> ready, B should stay pending (NOT skipped)
      expect(sm.getNodeState("A")?.status).toBe("ready");
      expect(sm.getNodeState("B")?.status).toBe("pending");

      // Retry succeeds -> B becomes ready
      sm.markNodeRunning("A", "run-2");
      const result = sm.markNodeCompleted("A", "success");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toEqual(["B"]);
      }
      expect(sm.getNodeState("B")?.status).toBe("ready");
    });

    it("downstream nodes ARE cascade-skipped after retry exhaustion", () => {
      const sm = createGraphStateMachine(buildGraph([
        { nodeId: "A", retries: 1 },
        { nodeId: "B", dependsOn: ["A"] },
        { nodeId: "C", dependsOn: ["B"] },
      ]));

      // First failure: retry
      sm.markNodeRunning("A", "run-1");
      sm.markNodeFailed("A", "error 1");
      expect(sm.getNodeState("A")?.status).toBe("ready");
      expect(sm.getNodeState("B")?.status).toBe("pending");

      // Second failure: exhausted -> cascade
      sm.markNodeRunning("A", "run-2");
      const result = sm.markNodeFailed("A", "error 2");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.skipped).toContain("B");
        expect(result.value.skipped).toContain("C");
        expect(result.value.retrying).toEqual([]);
      }
      expect(sm.getNodeState("B")?.status).toBe("skipped");
      expect(sm.getNodeState("C")?.status).toBe("skipped");
    });

    it("retrying field in FailureResult", () => {
      const sm = createGraphStateMachine(buildGraph([
        { nodeId: "A", retries: 1 },
      ]));

      sm.markNodeRunning("A", "run-1");
      const result = sm.markNodeFailed("A", "error");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.retrying).toEqual(["A"]);
        expect(result.value.skipped).toEqual([]);
        expect(result.value.newlyReady).toEqual([]);
      }
    });

    it("node with retries: 0 behaves as before (no retry)", () => {
      const sm = createGraphStateMachine(buildGraph([
        { nodeId: "A", retries: 0 },
      ]));

      sm.markNodeRunning("A", "run-1");
      const result = sm.markNodeFailed("A", "error");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.retrying).toEqual([]);
      }
      expect(sm.getNodeState("A")?.status).toBe("failed");
    });

    it("retry resets runId and startedAt", () => {
      const sm = createGraphStateMachine(buildGraph([
        { nodeId: "A", retries: 1 },
      ]));

      sm.markNodeRunning("A", "run-1");
      expect(sm.getNodeState("A")?.runId).toBe("run-1");
      expect(sm.getNodeState("A")?.startedAt).toBeTypeOf("number");

      sm.markNodeFailed("A", "error");
      // After retry: runId and startedAt should be cleared
      expect(sm.getNodeState("A")?.runId).toBeUndefined();
      expect(sm.getNodeState("A")?.startedAt).toBeUndefined();

      // Re-run with new runId
      sm.markNodeRunning("A", "run-2");
      expect(sm.getNodeState("A")?.runId).toBe("run-2");
      expect(sm.getNodeState("A")?.startedAt).toBeTypeOf("number");
    });

    it("retry in diamond graph: only retrying node resets, others unaffected", () => {
      // A, B (retries: 1) -> C
      const sm = createGraphStateMachine(buildGraph([
        { nodeId: "A" },
        { nodeId: "B", retries: 1 },
        { nodeId: "C", dependsOn: ["A", "B"] },
      ]));

      // Complete A
      sm.markNodeRunning("A", "run-a");
      sm.markNodeCompleted("A", "done");

      // Run B and fail (has 1 retry)
      sm.markNodeRunning("B", "run-b1");
      sm.markNodeFailed("B", "transient");

      // B should be ready (retrying), A stays completed, C stays pending
      expect(sm.getNodeState("B")?.status).toBe("ready");
      expect(sm.getNodeState("A")?.status).toBe("completed");
      expect(sm.getNodeState("C")?.status).toBe("pending");
    });
  });

  // -------------------------------------------------------------------------
  // Backward compatibility
  // -------------------------------------------------------------------------

  describe("backward compatibility", () => {
    it("default all-barrier + fail-fast behaves exactly as before", () => {
      // Same graph as the original end-to-end test -- no barrier modes, default fail-fast
      const sm = createGraphStateMachine(buildGraph([
        { nodeId: "A" },
        { nodeId: "B", dependsOn: ["A"] },
        { nodeId: "C", dependsOn: ["A"] },
        { nodeId: "D", dependsOn: ["B", "C"] },
      ]));

      sm.markNodeRunning("A", "r1");
      sm.markNodeCompleted("A");
      expect(sm.getNodeState("B")?.status).toBe("ready");
      expect(sm.getNodeState("C")?.status).toBe("ready");

      sm.markNodeRunning("B", "r2");
      sm.markNodeCompleted("B");
      expect(sm.getNodeState("D")?.status).toBe("pending"); // C not done

      sm.markNodeRunning("C", "r3");
      sm.markNodeFailed("C", "error");
      expect(sm.getNodeState("D")?.status).toBe("skipped");
    });

    it("existing all-barrier behavior: evaluateBarriers uses per-node barrier mode", () => {
      // Mix of barrier modes on different nodes
      const sm = createGraphStateMachine(buildGraph([
        { nodeId: "A" },
        { nodeId: "B" },
        { nodeId: "C", dependsOn: ["A", "B"] }, // default "all"
        { nodeId: "D", dependsOn: ["A", "B"], barrierMode: "best-effort" },
      ], { onFailure: "continue" }));

      sm.markNodeRunning("A", "r1");
      sm.markNodeCompleted("A");
      sm.markNodeRunning("B", "r2");
      sm.markNodeFailed("B", "error");

      // C (all barrier): needs all completed -> skipped (B failed)
      expect(sm.getNodeState("C")?.status).toBe("skipped");
      // D (best-effort): all terminal, 1 completed -> ready
      expect(sm.getNodeState("D")?.status).toBe("ready");
    });
  });

  // -------------------------------------------------------------------------
  // End-to-end scenario
  // -------------------------------------------------------------------------

  describe("end-to-end scenario", () => {
    it("5-node graph with mixed completions and failures", () => {
      // A (root) -> B, C
      // B depends on A
      // C depends on A
      // D depends on B, C
      // E depends on D
      const sm = createGraphStateMachine(buildGraph([
        { nodeId: "A" },
        { nodeId: "B", dependsOn: ["A"] },
        { nodeId: "C", dependsOn: ["A"] },
        { nodeId: "D", dependsOn: ["B", "C"] },
        { nodeId: "E", dependsOn: ["D"] },
      ]));

      // Initial: A is ready, others pending
      expect(sm.getReadyNodes()).toEqual(["A"]);
      expect(sm.getGraphStatus()).toBe("running");

      // Mark A running then completed -> B and C become ready
      sm.markNodeRunning("A", "run-A");
      const r1 = sm.markNodeCompleted("A", "output-A");
      expect(r1.ok).toBe(true);
      if (r1.ok) {
        expect(r1.value).toContain("B");
        expect(r1.value).toContain("C");
      }

      // Mark B running then completed -> D not ready (C still pending)
      sm.markNodeRunning("B", "run-B");
      const r2 = sm.markNodeCompleted("B", "output-B");
      expect(r2.ok && r2.value).toEqual([]);
      expect(sm.getNodeState("D")?.status).toBe("pending");

      // Mark C running then failed -> D skipped (C failed), E skipped (D skipped)
      sm.markNodeRunning("C", "run-C");
      const r3 = sm.markNodeFailed("C", "C crashed");
      expect(r3.ok).toBe(true);
      if (r3.ok) {
        expect(r3.value.skipped).toContain("D");
        expect(r3.value.skipped).toContain("E");
        expect(r3.value.newlyReady).toEqual([]);
      }

      // Final states
      expect(sm.getNodeState("A")?.status).toBe("completed");
      expect(sm.getNodeState("B")?.status).toBe("completed");
      expect(sm.getNodeState("C")?.status).toBe("failed");
      expect(sm.getNodeState("D")?.status).toBe("skipped");
      expect(sm.getNodeState("E")?.status).toBe("skipped");

      // All terminal
      expect(sm.isTerminal()).toBe(true);

      // Graph status: all terminal, A and B completed -> "completed"
      // (not "failed" because at least one node completed successfully)
      expect(sm.getGraphStatus()).toBe("completed");

      // Snapshot reflects final state
      const snap = sm.snapshot();
      expect(snap.isTerminal).toBe(true);
      expect(snap.graphStatus).toBe("completed");
      expect(snap.nodes.get("C")?.error).toBe("C crashed");
      expect(snap.nodes.get("A")?.output).toBe("output-A");
    });
  });
});
