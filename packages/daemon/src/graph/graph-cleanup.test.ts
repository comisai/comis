// SPDX-License-Identifier: Apache-2.0
/**
 * Branch-coverage tests for graph-cleanup (Plan 40-14).
 *
 * Exercises both `clearAllTimers` (no-timer / graph-timer / driver-state /
 * wait-handler permutations) and `sweepExpiredGraphs` (retention + maxGraphs
 * cap branches).
 */
import { describe, it, expect, vi } from "vitest";
import { clearAllTimers, sweepExpiredGraphs } from "./graph-cleanup.js";
import type { GraphRunState, CoordinatorSharedState } from "./graph-coordinator-state.js";

function makeGraph(overrides: Partial<GraphRunState> = {}): GraphRunState {
  return {
    nodeTimers: new Map(),
    retryTimers: new Map(),
    graphTimer: undefined,
    driverStates: new Map(),
    driverRunIdMap: new Map(),
    waitHandlers: new Map(),
    syntheticRunResults: new Map(),
    completedAt: undefined,
    ...overrides,
  } as GraphRunState;
}

describe("clearAllTimers (Plan 40-14)", () => {
  it("clears all node timers in the per-graph nodeTimers map on clearAllTimers", () => {
    const gs = makeGraph({
      nodeTimers: new Map<string, ReturnType<typeof setTimeout>>([
        ["n1", setTimeout(() => undefined, 1_000_000) as ReturnType<typeof setTimeout>],
        ["n2", setTimeout(() => undefined, 1_000_000) as ReturnType<typeof setTimeout>],
      ]),
    });
    const eventBus = { off: vi.fn() } as never;
    clearAllTimers({ eventBus }, gs);
    expect(gs.nodeTimers.size).toBe(0);
  });

  it("clears retry timers map and graph-level timer when both are present on the graph", () => {
    const gs = makeGraph({
      retryTimers: new Map([["r1", setTimeout(() => undefined, 1_000_000) as ReturnType<typeof setTimeout>]]),
      graphTimer: setTimeout(() => undefined, 1_000_000) as ReturnType<typeof setTimeout>,
    });
    clearAllTimers({ eventBus: { off: vi.fn() } as never }, gs);
    expect(gs.retryTimers.size).toBe(0);
    expect(gs.graphTimer).toBeUndefined();
  });

  it("clears driver state and driver-run-id map when driverStates contains active runs", () => {
    const gs = makeGraph({
      driverStates: new Map<string, { currentRunId?: string }>([
        ["d1", { currentRunId: "run-1" }],
        ["d2", { currentRunId: undefined }],
      ]) as never,
      driverRunIdMap: new Map([["run-1", "d1"]]),
    });
    clearAllTimers({ eventBus: { off: vi.fn() } as never }, gs);
    expect(gs.driverStates.size).toBe(0);
    expect(gs.driverRunIdMap.size).toBe(0);
  });

  it("unregisters every wait handler from eventBus when waitHandlers map is populated", () => {
    const handler1 = vi.fn();
    const handler2 = vi.fn();
    const gs = makeGraph({
      waitHandlers: new Map([
        ["n1", handler1],
        ["n2", handler2],
      ]) as never,
    });
    const eventBus = { off: vi.fn() };
    clearAllTimers({ eventBus: eventBus as never }, gs);
    expect(eventBus.off).toHaveBeenCalledTimes(2);
    expect(gs.waitHandlers.size).toBe(0);
  });

  it("handles the no-timers / no-drivers / no-wait-handlers empty-graph base case without errors", () => {
    const gs = makeGraph();
    const eventBus = { off: vi.fn() };
    expect(() => clearAllTimers({ eventBus: eventBus as never }, gs)).not.toThrow();
    expect(eventBus.off).not.toHaveBeenCalled();
  });
});

describe("sweepExpiredGraphs (Plan 40-14)", () => {
  it("removes only completed graphs older than the configured retentionMs", () => {
    const now = Date.now();
    const state = {
      graphs: new Map<string, GraphRunState>([
        ["g-old", makeGraph({ completedAt: now - 1_000_000 })],
        ["g-recent", makeGraph({ completedAt: now - 1000 })],
      ]),
    } as CoordinatorSharedState;
    sweepExpiredGraphs(state, { graphRetentionMs: 60_000, maxGraphs: 100 });
    expect(state.graphs.has("g-old")).toBe(false);
    expect(state.graphs.has("g-recent")).toBe(true);
  });

  it("preserves still-running graphs that have no completedAt timestamp recorded yet", () => {
    const state = {
      graphs: new Map<string, GraphRunState>([
        ["g-running", makeGraph({ completedAt: undefined })],
      ]),
    } as CoordinatorSharedState;
    sweepExpiredGraphs(state, { graphRetentionMs: 0, maxGraphs: 100 });
    expect(state.graphs.has("g-running")).toBe(true);
  });

  it("evicts oldest completed graphs first when total graph count exceeds maxGraphs cap", () => {
    const now = Date.now();
    const state = {
      graphs: new Map<string, GraphRunState>([
        ["g-1", makeGraph({ completedAt: now - 5000 })],
        ["g-2", makeGraph({ completedAt: now - 3000 })],
        ["g-3", makeGraph({ completedAt: now - 1000 })],
      ]),
    } as CoordinatorSharedState;
    sweepExpiredGraphs(state, { graphRetentionMs: 600_000, maxGraphs: 2 });
    // Oldest (g-1) should be evicted to fit within cap of 2
    expect(state.graphs.has("g-1")).toBe(false);
    expect(state.graphs.has("g-2")).toBe(true);
    expect(state.graphs.has("g-3")).toBe(true);
  });

  it("does not evict any graphs from the map when the total count is at or below the maxGraphs cap", () => {
    const now = Date.now();
    const state = {
      graphs: new Map<string, GraphRunState>([
        ["g-1", makeGraph({ completedAt: now - 1000 })],
      ]),
    } as CoordinatorSharedState;
    sweepExpiredGraphs(state, { graphRetentionMs: 600_000, maxGraphs: 5 });
    expect(state.graphs.size).toBe(1);
  });
});
