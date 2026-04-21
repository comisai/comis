// SPDX-License-Identifier: Apache-2.0
/**
 * Timer cleanup and graph sweep for the graph coordinator.
 * Handles clearing all per-node and graph-level timers when a graph
 * completes/cancels, and periodic sweeping of expired completed graphs
 * from the coordinator's map.
 * @module
 */

import type { CoordinatorSharedState, GraphCoordinatorDeps, GraphRunState, CoordinatorConfig } from "./graph-coordinator-state.js";

// ---------------------------------------------------------------------------
// Timer cleanup
// ---------------------------------------------------------------------------

/**
 * Clear all timers for a GraphRunState: node timers, retry timers,
 * graph-level timer, driver state cleanup, and wait handler cleanup.
 */
export function clearAllTimers(
  deps: Pick<GraphCoordinatorDeps, "eventBus">,
  gs: GraphRunState,
): void {
  for (const timer of gs.nodeTimers.values()) {
    clearTimeout(timer);
  }
  gs.nodeTimers.clear();
  // Clear retry timers
  for (const timer of gs.retryTimers.values()) {
    clearTimeout(timer);
  }
  gs.retryTimers.clear();
  if (gs.graphTimer !== undefined) {
    clearTimeout(gs.graphTimer);
    gs.graphTimer = undefined;
  }
  // Clean up driver state
  for (const ds of gs.driverStates.values()) {
    if (ds.currentRunId) {
      gs.driverRunIdMap.delete(ds.currentRunId);
    }
  }
  gs.driverStates.clear();
  gs.driverRunIdMap.clear();
  // Clean up wait handlers
  for (const [_nodeId, handler] of gs.waitHandlers) {
    deps.eventBus.off("message:received", handler);
  }
  gs.waitHandlers.clear();
  gs.syntheticRunResults.clear();
}

// ---------------------------------------------------------------------------
// Graph sweep
// ---------------------------------------------------------------------------

/**
 * Remove expired completed graphs from the coordinator's map.
 * Also enforces the MAX_GRAPHS cap by removing oldest completed first.
 */
export function sweepExpiredGraphs(
  state: CoordinatorSharedState,
  config: Pick<CoordinatorConfig, "graphRetentionMs" | "maxGraphs">,
): void {
  const now = Date.now();
  for (const [graphId, gs] of state.graphs) {
    if (gs.completedAt !== undefined && now - gs.completedAt > config.graphRetentionMs) {
      state.graphs.delete(graphId);
    }
  }

  // Cap at maxGraphs: remove oldest completed first
  if (state.graphs.size > config.maxGraphs) {
    const completedGraphs = [...state.graphs.entries()]
      .filter(([, gs]) => gs.completedAt !== undefined)
      .sort((a, b) => (a[1].completedAt ?? 0) - (b[1].completedAt ?? 0));

    const toRemove = state.graphs.size - config.maxGraphs;
    for (let i = 0; i < toRemove && i < completedGraphs.length; i++) {
      state.graphs.delete(completedGraphs[i]![0]);
    }
  }
}
