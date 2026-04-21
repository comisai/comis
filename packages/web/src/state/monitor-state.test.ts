// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createMonitorState, type MonitorState } from "./monitor-state.js";
import type { PipelineNode, PipelineEdge, MonitorSnapshot } from "../api/types/index.js";
import type { RpcClient } from "../api/rpc-client.js";
import { createMockRpcClient } from "../test-support/mock-rpc-client.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a minimal PipelineNode for testing */
function makeNode(id: string, x = 0, y = 0): PipelineNode {
  return {
    id,
    task: `Task ${id}`,
    dependsOn: [],
    position: { x, y },
  };
}

/** Create a minimal PipelineEdge */
function makeEdge(source: string, target: string): PipelineEdge {
  return { id: `${source}->${target}`, source, target };
}

/** Build a graph.status RPC response */
function makeStatusResponse(overrides: {
  status?: "running" | "completed" | "failed" | "cancelled";
  isTerminal?: boolean;
  nodes?: Record<string, {
    status: string;
    runId?: string;
    output?: string;
    error?: string;
    startedAt?: number;
    completedAt?: number;
    durationMs?: number;
  }>;
  executionOrder?: string[];
  stats?: {
    total: number;
    completed: number;
    failed: number;
    skipped: number;
    running: number;
    pending: number;
  };
} = {}) {
  return {
    graphId: "graph-1",
    status: overrides.status ?? "running",
    isTerminal: overrides.isTerminal ?? false,
    executionOrder: overrides.executionOrder ?? ["n1", "n2"],
    nodes: overrides.nodes ?? {
      n1: { status: "running", startedAt: 1000 },
      n2: { status: "pending" },
    },
    stats: overrides.stats ?? {
      total: 2,
      completed: 0,
      failed: 0,
      skipped: 0,
      running: 1,
      pending: 1,
    },
  };
}

/** Create a mock RpcClient with a controllable call method */

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createMonitorState", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const nodeDefinitions = [makeNode("n1", 100, 200), makeNode("n2", 300, 400)];
  const edges = [makeEdge("n1", "n2")];

  describe("factory", () => {
    it("returns object with subscribe, getSnapshot, selectNode, startPolling, stopPolling, destroy", () => {
      const state = createMonitorState();
      expect(typeof state.subscribe).toBe("function");
      expect(typeof state.getSnapshot).toBe("function");
      expect(typeof state.selectNode).toBe("function");
      expect(typeof state.startPolling).toBe("function");
      expect(typeof state.stopPolling).toBe("function");
      expect(typeof state.destroy).toBe("function");
    });
  });

  describe("initial state", () => {
    it("getSnapshot returns loading=true, empty nodes, no error", () => {
      const state = createMonitorState();
      const snap = state.getSnapshot();

      expect(snap.loading).toBe(true);
      expect(snap.nodes).toEqual([]);
      expect(snap.edges).toEqual([]);
      expect(snap.error).toBeNull();
      expect(snap.selectedNodeId).toBeNull();
      expect(snap.graphStatus).toBe("running");
      expect(snap.isTerminal).toBe(false);
      expect(snap.elapsedMs).toBe(0);
    });

    it("getSnapshot returns frozen object", () => {
      const state = createMonitorState();
      const snap = state.getSnapshot();
      expect(Object.isFrozen(snap)).toBe(true);
    });
  });

  describe("startPolling", () => {
    it("calls graph.status immediately on start (not waiting 2s)", async () => {
      const callFn = vi.fn().mockResolvedValue(makeStatusResponse());
      const rpc = createMockRpcClient(callFn);
      const state = createMonitorState();

      state.startPolling(rpc, "graph-1", nodeDefinitions, edges);

      // Flush the immediate microtask
      await vi.advanceTimersByTimeAsync(0);

      expect(callFn).toHaveBeenCalledTimes(1);
      expect(callFn).toHaveBeenCalledWith("graph.status", { graphId: "graph-1" });
    });

    it("after first poll, nodes are merged and loading=false", async () => {
      const callFn = vi.fn().mockResolvedValue(makeStatusResponse());
      const rpc = createMockRpcClient(callFn);
      const state = createMonitorState();

      state.startPolling(rpc, "graph-1", nodeDefinitions, edges);
      await vi.advanceTimersByTimeAsync(0);

      const snap = state.getSnapshot();
      expect(snap.loading).toBe(false);
      expect(snap.nodes).toHaveLength(2);
      // Node positions come from nodeDefinitions
      expect(snap.nodes[0]!.position).toEqual({ x: 100, y: 200 });
      expect(snap.nodes[1]!.position).toEqual({ x: 300, y: 400 });
      // Runtime status comes from RPC response
      expect(snap.nodes[0]!.status).toBe("running");
      expect(snap.nodes[1]!.status).toBe("pending");
    });

    it("merges node definitions (task, agentId, position) with runtime status", async () => {
      const defsWithAgent: PipelineNode[] = [
        { id: "n1", task: "Summarize", agentId: "agent-1", dependsOn: [], position: { x: 10, y: 20 } },
        { id: "n2", task: "Review", modelId: "claude-3", dependsOn: ["n1"], position: { x: 30, y: 40 } },
      ];
      const response = makeStatusResponse({
        nodes: {
          n1: { status: "completed", runId: "run-1", output: "Summary done", startedAt: 1000, completedAt: 2000, durationMs: 1000 },
          n2: { status: "running", runId: "run-2", startedAt: 2000 },
        },
      });
      const callFn = vi.fn().mockResolvedValue(response);
      const rpc = createMockRpcClient(callFn);
      const state = createMonitorState();

      state.startPolling(rpc, "graph-1", defsWithAgent, edges);
      await vi.advanceTimersByTimeAsync(0);

      const snap = state.getSnapshot();
      // Node 1: definition + runtime merged
      expect(snap.nodes[0]!.task).toBe("Summarize");
      expect(snap.nodes[0]!.agentId).toBe("agent-1");
      expect(snap.nodes[0]!.status).toBe("completed");
      expect(snap.nodes[0]!.runId).toBe("run-1");
      expect(snap.nodes[0]!.output).toBe("Summary done");
      expect(snap.nodes[0]!.durationMs).toBe(1000);
      expect(snap.nodes[0]!.dependsOn).toEqual([]);
      expect(snap.nodes[0]!.position).toEqual({ x: 10, y: 20 });
      // Node 2: definition + runtime merged
      expect(snap.nodes[1]!.task).toBe("Review");
      expect(snap.nodes[1]!.status).toBe("running");
      expect(snap.nodes[1]!.dependsOn).toEqual(["n1"]);
    });

    it("polls every 2000ms after initial call", async () => {
      const callFn = vi.fn().mockResolvedValue(makeStatusResponse());
      const rpc = createMockRpcClient(callFn);
      const state = createMonitorState();

      state.startPolling(rpc, "graph-1", nodeDefinitions, edges);
      await vi.advanceTimersByTimeAsync(0);
      expect(callFn).toHaveBeenCalledTimes(1);

      // Advance 2 seconds
      await vi.advanceTimersByTimeAsync(2000);
      expect(callFn).toHaveBeenCalledTimes(2);

      // Advance another 2 seconds
      await vi.advanceTimersByTimeAsync(2000);
      expect(callFn).toHaveBeenCalledTimes(3);
    });

    it("stores edges from startPolling in snapshot", async () => {
      const callFn = vi.fn().mockResolvedValue(makeStatusResponse());
      const rpc = createMockRpcClient(callFn);
      const state = createMonitorState();

      state.startPolling(rpc, "graph-1", nodeDefinitions, edges);
      await vi.advanceTimersByTimeAsync(0);

      const snap = state.getSnapshot();
      expect(snap.edges).toHaveLength(1);
      expect(snap.edges[0]!.source).toBe("n1");
      expect(snap.edges[0]!.target).toBe("n2");
    });

    it("stores stats from RPC response", async () => {
      const response = makeStatusResponse({
        stats: { total: 5, completed: 2, failed: 1, skipped: 0, running: 1, pending: 1 },
      });
      const callFn = vi.fn().mockResolvedValue(response);
      const rpc = createMockRpcClient(callFn);
      const state = createMonitorState();

      state.startPolling(rpc, "graph-1", nodeDefinitions, edges);
      await vi.advanceTimersByTimeAsync(0);

      const snap = state.getSnapshot();
      expect(snap.stats).toEqual({ total: 5, completed: 2, failed: 1, skipped: 0, running: 1, pending: 1 });
    });

    it("stores executionOrder from RPC response", async () => {
      const response = makeStatusResponse({ executionOrder: ["n2", "n1"] });
      const callFn = vi.fn().mockResolvedValue(response);
      const rpc = createMockRpcClient(callFn);
      const state = createMonitorState();

      state.startPolling(rpc, "graph-1", nodeDefinitions, edges);
      await vi.advanceTimersByTimeAsync(0);

      expect(state.getSnapshot().executionOrder).toEqual(["n2", "n1"]);
    });
  });

  describe("terminal status stops polling", () => {
    it("clears interval when isTerminal=true in response", async () => {
      let callCount = 0;
      const callFn = vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount >= 2) {
          return Promise.resolve(makeStatusResponse({
            status: "completed",
            isTerminal: true,
            stats: { total: 2, completed: 2, failed: 0, skipped: 0, running: 0, pending: 0 },
          }));
        }
        return Promise.resolve(makeStatusResponse());
      });
      const rpc = createMockRpcClient(callFn);
      const state = createMonitorState();

      state.startPolling(rpc, "graph-1", nodeDefinitions, edges);
      await vi.advanceTimersByTimeAsync(0); // first poll (running)
      expect(callFn).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(2000); // second poll (terminal)
      expect(callFn).toHaveBeenCalledTimes(2);

      // Advance 4 more seconds -- should NOT have any additional calls
      await vi.advanceTimersByTimeAsync(4000);
      expect(callFn).toHaveBeenCalledTimes(2);

      // Verify terminal state
      const snap = state.getSnapshot();
      expect(snap.graphStatus).toBe("completed");
      expect(snap.isTerminal).toBe(true);
    });
  });

  describe("selectNode", () => {
    it("updates selectedNodeId in snapshot", () => {
      const state = createMonitorState();
      state.selectNode("n1");
      expect(state.getSnapshot().selectedNodeId).toBe("n1");
    });

    it("null clears selection", () => {
      const state = createMonitorState();
      state.selectNode("n1");
      state.selectNode(null);
      expect(state.getSnapshot().selectedNodeId).toBeNull();
    });

    it("notifies subscribers", () => {
      const state = createMonitorState();
      const handler = vi.fn();
      state.subscribe(handler);

      state.selectNode("n1");

      expect(handler).toHaveBeenCalledTimes(1);
    });
  });

  describe("RPC errors", () => {
    it("sets error field but does NOT stop polling", async () => {
      let callCount = 0;
      const callFn = vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 2) {
          return Promise.reject(new Error("RPC timeout"));
        }
        return Promise.resolve(makeStatusResponse());
      });
      const rpc = createMockRpcClient(callFn);
      const state = createMonitorState();

      state.startPolling(rpc, "graph-1", nodeDefinitions, edges);
      await vi.advanceTimersByTimeAsync(0); // first poll (success)
      expect(state.getSnapshot().error).toBeNull();

      await vi.advanceTimersByTimeAsync(2000); // second poll (error)
      expect(state.getSnapshot().error).toBe("RPC timeout");

      // Polling should continue -- third poll after another 2s
      await vi.advanceTimersByTimeAsync(2000);
      expect(callFn).toHaveBeenCalledTimes(3);

      // Error should clear on successful response
      expect(state.getSnapshot().error).toBeNull();
    });
  });

  describe("elapsed time tracking", () => {
    it("stores _startedAt when first poll has graphStatus=running and computes elapsedMs", async () => {
      const callFn = vi.fn().mockResolvedValue(makeStatusResponse({ status: "running" }));
      const rpc = createMockRpcClient(callFn);
      const state = createMonitorState();

      // Set Date.now() to a known value
      vi.setSystemTime(new Date(10000));

      state.startPolling(rpc, "graph-1", nodeDefinitions, edges);
      await vi.advanceTimersByTimeAsync(0); // first poll

      // After first poll, elapsed should be 0 (just started)
      expect(state.getSnapshot().elapsedMs).toBe(0);

      // Advance 1 second -- elapsed timer should have fired
      await vi.advanceTimersByTimeAsync(1000);
      expect(state.getSnapshot().elapsedMs).toBe(1000);

      // Advance another 2 seconds
      await vi.advanceTimersByTimeAsync(2000);
      expect(state.getSnapshot().elapsedMs).toBe(3000);
    });

    it("elapsed timer clears when terminal status reached", async () => {
      let callCount = 0;
      const callFn = vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount >= 2) {
          return Promise.resolve(makeStatusResponse({ status: "completed", isTerminal: true }));
        }
        return Promise.resolve(makeStatusResponse({ status: "running" }));
      });
      const rpc = createMockRpcClient(callFn);
      const state = createMonitorState();
      const handler = vi.fn();

      vi.setSystemTime(new Date(10000));

      state.startPolling(rpc, "graph-1", nodeDefinitions, edges);
      await vi.advanceTimersByTimeAsync(0); // first poll (running)

      state.subscribe(handler);
      handler.mockClear();

      await vi.advanceTimersByTimeAsync(2000); // second poll (terminal) -- also elapsed updates
      const notifyCountAfterTerminal = handler.mock.calls.length;

      // Advance 5 more seconds -- no more elapsed updates should fire
      handler.mockClear();
      await vi.advanceTimersByTimeAsync(5000);
      expect(handler).not.toHaveBeenCalled();
    });
  });

  describe("subscribers", () => {
    it("notified on every poll response", async () => {
      const callFn = vi.fn().mockResolvedValue(makeStatusResponse());
      const rpc = createMockRpcClient(callFn);
      const state = createMonitorState();
      const handler = vi.fn();
      state.subscribe(handler);

      state.startPolling(rpc, "graph-1", nodeDefinitions, edges);
      await vi.advanceTimersByTimeAsync(0); // first poll
      expect(handler).toHaveBeenCalled();

      handler.mockClear();
      await vi.advanceTimersByTimeAsync(2000); // second poll
      expect(handler).toHaveBeenCalled();
    });

    it("unsubscribe stops notifications", () => {
      const state = createMonitorState();
      const handler = vi.fn();
      const unsub = state.subscribe(handler);

      state.selectNode("n1");
      expect(handler).toHaveBeenCalledTimes(1);

      unsub();

      state.selectNode("n2");
      expect(handler).toHaveBeenCalledTimes(1); // Still 1
    });
  });

  describe("stopPolling", () => {
    it("clears poll interval but preserves last snapshot", async () => {
      const callFn = vi.fn().mockResolvedValue(makeStatusResponse());
      const rpc = createMockRpcClient(callFn);
      const state = createMonitorState();

      state.startPolling(rpc, "graph-1", nodeDefinitions, edges);
      await vi.advanceTimersByTimeAsync(0); // first poll
      expect(callFn).toHaveBeenCalledTimes(1);

      const snapBefore = state.getSnapshot();
      state.stopPolling();

      // Advance time -- no more polls
      await vi.advanceTimersByTimeAsync(6000);
      expect(callFn).toHaveBeenCalledTimes(1);

      // Snapshot preserved
      const snapAfter = state.getSnapshot();
      expect(snapAfter.nodes).toEqual(snapBefore.nodes);
      expect(snapAfter.graphStatus).toBe(snapBefore.graphStatus);
    });
  });

  describe("destroy", () => {
    it("clears all timers -- no calls after destroy + time advance", async () => {
      const callFn = vi.fn().mockResolvedValue(makeStatusResponse());
      const rpc = createMockRpcClient(callFn);
      const state = createMonitorState();
      const handler = vi.fn();
      state.subscribe(handler);

      state.startPolling(rpc, "graph-1", nodeDefinitions, edges);
      await vi.advanceTimersByTimeAsync(0); // first poll

      handler.mockClear();
      state.destroy();

      // Advance a lot of time -- no more polls, no more elapsed updates
      await vi.advanceTimersByTimeAsync(10000);
      expect(handler).not.toHaveBeenCalled();
      expect(callFn).toHaveBeenCalledTimes(1); // only the initial one
    });
  });

  describe("duplicate startPolling clears previous interval", () => {
    it("calling startPolling twice does not stack intervals", async () => {
      const callFn = vi.fn().mockResolvedValue(makeStatusResponse());
      const rpc = createMockRpcClient(callFn);
      const state = createMonitorState();

      state.startPolling(rpc, "graph-1", nodeDefinitions, edges);
      await vi.advanceTimersByTimeAsync(0);
      expect(callFn).toHaveBeenCalledTimes(1);

      // Start again (should clear old interval)
      state.startPolling(rpc, "graph-1", nodeDefinitions, edges);
      await vi.advanceTimersByTimeAsync(0);
      expect(callFn).toHaveBeenCalledTimes(2);

      // After 2s, should only fire once (not twice from stacked intervals)
      await vi.advanceTimersByTimeAsync(2000);
      expect(callFn).toHaveBeenCalledTimes(3); // not 4
    });
  });

  describe("applyEvent", () => {
    it("graph:node_updated updates matching node status and recalculates stats", async () => {
      const callFn = vi.fn().mockResolvedValue(makeStatusResponse());
      const rpc = createMockRpcClient(callFn);
      const state = createMonitorState();

      state.startPolling(rpc, "graph-1", nodeDefinitions, edges);
      await vi.advanceTimersByTimeAsync(0); // first poll

      // n1 is running, n2 is pending -- apply SSE update marking n1 completed
      state.applyEvent("graph:node_updated", {
        graphId: "graph-1",
        nodeId: "n1",
        status: "completed",
        durationMs: 500,
        timestamp: 2000,
      });

      const snap = state.getSnapshot();
      expect(snap.nodes[0]!.status).toBe("completed");
      expect(snap.nodes[0]!.durationMs).toBe(500);
      expect(snap.nodes[0]!.completedAt).toBe(2000);
      expect(snap.stats.completed).toBe(1);
      expect(snap.stats.running).toBe(0);
      expect(snap.stats.pending).toBe(1);
    });

    it("graph:node_updated ignores events for different graphId", async () => {
      const callFn = vi.fn().mockResolvedValue(makeStatusResponse());
      const rpc = createMockRpcClient(callFn);
      const state = createMonitorState();

      state.startPolling(rpc, "graph-1", nodeDefinitions, edges);
      await vi.advanceTimersByTimeAsync(0); // first poll

      const handler = vi.fn();
      state.subscribe(handler);
      handler.mockClear();

      state.applyEvent("graph:node_updated", {
        graphId: "graph-2",
        nodeId: "n1",
        status: "completed",
        timestamp: 2000,
      });

      // Should not have notified (event was for different graph)
      expect(handler).not.toHaveBeenCalled();
      expect(state.getSnapshot().nodes[0]!.status).toBe("running");
    });

    it("graph:completed sets isTerminal, clears timers, updates stats", async () => {
      const callFn = vi.fn().mockResolvedValue(makeStatusResponse({ status: "running" }));
      const rpc = createMockRpcClient(callFn);
      const state = createMonitorState();

      vi.setSystemTime(new Date(10000));

      state.startPolling(rpc, "graph-1", nodeDefinitions, edges);
      await vi.advanceTimersByTimeAsync(0); // first poll (starts elapsed timer)

      const handler = vi.fn();
      state.subscribe(handler);
      handler.mockClear();

      state.applyEvent("graph:completed", {
        graphId: "graph-1",
        status: "completed",
        durationMs: 5000,
        nodeCount: 2,
        nodesCompleted: 2,
        nodesFailed: 0,
        nodesSkipped: 0,
        timestamp: 15000,
      });

      const snap = state.getSnapshot();
      expect(snap.isTerminal).toBe(true);
      expect(snap.graphStatus).toBe("completed");
      expect(snap.stats.completed).toBe(2);
      expect(snap.stats.running).toBe(0);
      expect(snap.stats.pending).toBe(0);
      expect(snap.loading).toBe(false);
      expect(snap.error).toBeNull();

      // No more elapsed timer ticks after terminal
      handler.mockClear();
      await vi.advanceTimersByTimeAsync(5000);
      expect(handler).not.toHaveBeenCalled();
    });

    it("graph:started sets startedAt and begins elapsed timer", async () => {
      const callFn = vi.fn().mockResolvedValue(makeStatusResponse({
        status: "running",
        nodes: { n1: { status: "pending" }, n2: { status: "pending" } },
      }));
      const rpc = createMockRpcClient(callFn);
      const state = createMonitorState();

      vi.setSystemTime(new Date(10000));

      // Mock returns pending nodes (not running), so elapsed timer won't start from poll
      state.startPolling(rpc, "graph-1", nodeDefinitions, edges);
      await vi.advanceTimersByTimeAsync(0); // first poll

      // graph:started should initiate the elapsed timer
      state.applyEvent("graph:started", {
        graphId: "graph-1",
        nodeCount: 2,
        timestamp: 10000,
      });

      // Advance 2 seconds -- elapsed should be tracking
      await vi.advanceTimersByTimeAsync(2000);
      expect(state.getSnapshot().elapsedMs).toBeGreaterThanOrEqual(1000);
    });
  });

  describe("suspendPolling / resumePolling", () => {
    it("suspendPolling stops poll interval but preserves elapsed timer", async () => {
      const callFn = vi.fn().mockResolvedValue(makeStatusResponse({ status: "running" }));
      const rpc = createMockRpcClient(callFn);
      const state = createMonitorState();

      vi.setSystemTime(new Date(10000));

      state.startPolling(rpc, "graph-1", nodeDefinitions, edges);
      await vi.advanceTimersByTimeAsync(0); // first poll (starts elapsed)
      expect(callFn).toHaveBeenCalledTimes(1);

      state.suspendPolling();

      // Advance 4s -- no new RPC calls
      await vi.advanceTimersByTimeAsync(4000);
      expect(callFn).toHaveBeenCalledTimes(1);

      // Elapsed timer should still be running
      expect(state.getSnapshot().elapsedMs).toBeGreaterThanOrEqual(3000);
    });

    it("resumePolling does immediate poll then restarts interval", async () => {
      const callFn = vi.fn().mockResolvedValue(makeStatusResponse());
      const rpc = createMockRpcClient(callFn);
      const state = createMonitorState();

      state.startPolling(rpc, "graph-1", nodeDefinitions, edges);
      await vi.advanceTimersByTimeAsync(0); // first poll
      expect(callFn).toHaveBeenCalledTimes(1);

      state.suspendPolling();

      // Resume -- should do immediate poll
      state.resumePolling();
      await vi.advanceTimersByTimeAsync(0);
      expect(callFn).toHaveBeenCalledTimes(2); // immediate recovery poll

      // Interval should resume -- 2s later, another poll
      await vi.advanceTimersByTimeAsync(2000);
      expect(callFn).toHaveBeenCalledTimes(3);
    });

    it("resumePolling is a no-op when isTerminal", async () => {
      let callCount = 0;
      const callFn = vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount >= 2) {
          return Promise.resolve(makeStatusResponse({
            status: "completed",
            isTerminal: true,
          }));
        }
        return Promise.resolve(makeStatusResponse());
      });
      const rpc = createMockRpcClient(callFn);
      const state = createMonitorState();

      state.startPolling(rpc, "graph-1", nodeDefinitions, edges);
      await vi.advanceTimersByTimeAsync(0); // first poll (running)
      await vi.advanceTimersByTimeAsync(2000); // second poll (terminal)
      expect(callFn).toHaveBeenCalledTimes(2);

      // Resume should be a no-op since terminal
      state.resumePolling();
      await vi.advanceTimersByTimeAsync(4000);
      expect(callFn).toHaveBeenCalledTimes(2); // no new calls
    });
  });
});
