// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from "vitest";
import { globalCompletionHandler } from "./graph-concurrency.js";
import type {
  CoordinatorSharedState,
  CoordinatorConfig,
  GraphRunState,
} from "./graph-coordinator-state.js";

// ---------------------------------------------------------------------------
// Local factories — hand-built objects, `as unknown as T`
// when only a subset of GraphRunState fields are touched by the SUT
// ---------------------------------------------------------------------------

function makeState(overrides: Partial<CoordinatorSharedState> = {}): CoordinatorSharedState {
  return {
    graphs: new Map(),
    globalActiveSubAgents: 0,
    spawnQueue: [],
    ...overrides,
  };
}

function makeConfig(
  overrides: Partial<CoordinatorConfig> = {},
): Pick<CoordinatorConfig, "maxGlobalSubAgents"> {
  return { maxGlobalSubAgents: 20, ...overrides };
}

function makeGraph(overrides: Partial<GraphRunState> = {}): GraphRunState {
  // Only the routing maps (`runIdToNode`, `driverRunIdMap`, `syntheticRunResults`)
  // and `completedAt` are touched by globalCompletionHandler / releaseAndDrainQueue.
  // The rest can be neutral defaults under the `as unknown as` cast.
  return {
    graphId: "g-1",
    runIdToNode: new Map(),
    driverRunIdMap: new Map(),
    syntheticRunResults: new Map(),
    ...overrides,
  } as unknown as GraphRunState;
}

function makeCallbacks() {
  return {
    handleDriverTurnCompleted: vi.fn(),
    handleSubAgentCompleted: vi.fn(),
  };
}

function makeEvent(runId: string, success = true): { runId: string; success: boolean } {
  return { runId, success };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("graph-concurrency", () => {
  describe("globalCompletionHandler", () => {
    it("bails immediately on non-graph runId without warn log or slot release", () => {
      // Pre-fix: the handler ran releaseAndDrainQueue unconditionally and emitted
      // an "Orphaned graph sub-agent completion" warn. Post-fix: non-graph runIds
      // return silently without touching counters, queue, or the log stream.
      const state = makeState({ globalActiveSubAgents: 5 });
      const config = makeConfig();
      const gs = makeGraph({ graphId: "g-1" });
      state.graphs.set("g-1", gs);
      const callbacks = makeCallbacks();

      globalCompletionHandler(state, config, makeEvent("non-graph-runid"), callbacks);

      expect(state.globalActiveSubAgents).toBe(5);
      expect(state.spawnQueue.length).toBe(0);
      expect(callbacks.handleDriverTurnCompleted).toHaveBeenCalledTimes(0);
      expect(callbacks.handleSubAgentCompleted).toHaveBeenCalledTimes(0);
    });

    it("routes regular-node runId to handleSubAgentCompleted and releases exactly one slot", () => {
      const state = makeState({ globalActiveSubAgents: 3 });
      const config = makeConfig();
      const gs = makeGraph({ graphId: "g-1" });
      gs.runIdToNode.set("run-A", "node-A");
      state.graphs.set("g-1", gs);
      const callbacks = makeCallbacks();

      globalCompletionHandler(state, config, makeEvent("run-A"), callbacks);

      expect(state.globalActiveSubAgents).toBe(2);
      expect(callbacks.handleSubAgentCompleted).toHaveBeenCalledTimes(1);
      expect(callbacks.handleSubAgentCompleted).toHaveBeenCalledWith(
        gs,
        expect.objectContaining({ runId: "run-A" }),
      );
      expect(callbacks.handleDriverTurnCompleted).toHaveBeenCalledTimes(0);
    });

    it("routes driver-managed runId to handleDriverTurnCompleted with mapped nodeId", () => {
      const state = makeState({ globalActiveSubAgents: 4 });
      const config = makeConfig();
      const gs = makeGraph({ graphId: "g-1" });
      gs.driverRunIdMap.set("run-D", { nodeId: "driver-node", agentId: "bull" });
      state.graphs.set("g-1", gs);
      const callbacks = makeCallbacks();

      globalCompletionHandler(state, config, makeEvent("run-D"), callbacks);

      expect(state.globalActiveSubAgents).toBe(3);
      expect(callbacks.handleDriverTurnCompleted).toHaveBeenCalledTimes(1);
      expect(callbacks.handleDriverTurnCompleted).toHaveBeenCalledWith(
        gs,
        "driver-node",
        expect.objectContaining({ runId: "run-D" }),
      );
      expect(callbacks.handleSubAgentCompleted).toHaveBeenCalledTimes(0);
    });

    it("synthetic runId returns without callbacks and without slot release", () => {
      const state = makeState({ globalActiveSubAgents: 2 });
      const config = makeConfig();
      const gs = makeGraph({ graphId: "g-1" });
      gs.syntheticRunResults.set("synth-1", "user reply text");
      state.graphs.set("g-1", gs);
      const callbacks = makeCallbacks();

      globalCompletionHandler(state, config, makeEvent("synth-1"), callbacks);

      // Synthetic replies never took a gatedSpawn slot — must NOT release one.
      expect(state.globalActiveSubAgents).toBe(2);
      expect(callbacks.handleDriverTurnCompleted).toHaveBeenCalledTimes(0);
      expect(callbacks.handleSubAgentCompleted).toHaveBeenCalledTimes(0);
    });

    it("does not drain spawnQueue when non-graph runId completes at saturation", () => {
      // Dangerous defect: pre-fix, a non-graph completion at saturation prematurely
      // drains a queued graph spawn, falsely freeing a slot the graph never claimed.
      const state = makeState({ globalActiveSubAgents: 20 });
      const config = makeConfig({ maxGlobalSubAgents: 20 });
      const gs = makeGraph({ graphId: "g-1" });
      state.graphs.set("g-1", gs);
      const queuedExecute = vi.fn();
      state.spawnQueue.push({ graphId: "g-1", nodeId: "queued-node", execute: queuedExecute });
      const callbacks = makeCallbacks();

      globalCompletionHandler(state, config, makeEvent("outside-runid"), callbacks);

      expect(state.globalActiveSubAgents).toBe(20);
      expect(state.spawnQueue.length).toBe(1);
      expect(queuedExecute).toHaveBeenCalledTimes(0);
    });

    it("routes correctly when multiple graphs exist and only one owns the runId", () => {
      const state = makeState({ globalActiveSubAgents: 5 });
      const config = makeConfig();
      const g1 = makeGraph({ graphId: "g-1" });
      const g2 = makeGraph({ graphId: "g-2" });
      g2.runIdToNode.set("run-X", "node-X");
      const g3 = makeGraph({ graphId: "g-3" });
      state.graphs.set("g-1", g1);
      state.graphs.set("g-2", g2);
      state.graphs.set("g-3", g3);
      const callbacks = makeCallbacks();

      globalCompletionHandler(state, config, makeEvent("run-X"), callbacks);

      expect(callbacks.handleSubAgentCompleted).toHaveBeenCalledTimes(1);
      const calledWithGraph = callbacks.handleSubAgentCompleted.mock.calls[0]?.[0] as GraphRunState;
      expect(calledWithGraph.graphId).toBe("g-2");
      expect(callbacks.handleDriverTurnCompleted).toHaveBeenCalledTimes(0);
    });

    it("drains queued graph spawn when a regular-node completion releases the last slot", () => {
      // Positive companion of the queue-protection test — proves release + drain
      // still fires for legitimate graph completions (post-match ordering).
      const state = makeState({ globalActiveSubAgents: 20 });
      const config = makeConfig({ maxGlobalSubAgents: 20 });
      const gs = makeGraph({ graphId: "g-1" });
      gs.runIdToNode.set("run-Y", "node-Y");
      state.graphs.set("g-1", gs);
      const queuedExecute = vi.fn();
      state.spawnQueue.push({ graphId: "g-1", nodeId: "queued-node", execute: queuedExecute });
      const callbacks = makeCallbacks();

      globalCompletionHandler(state, config, makeEvent("run-Y"), callbacks);

      expect(callbacks.handleSubAgentCompleted).toHaveBeenCalledTimes(1);
      expect(queuedExecute).toHaveBeenCalledTimes(1);
      // Release decremented 20 -> 19, then drain re-incremented 19 -> 20 for
      // the now-spawned queued entry. Net unchanged.
      expect(state.globalActiveSubAgents).toBe(20);
      expect(state.spawnQueue.length).toBe(0);
    });
  });
});
