// SPDX-License-Identifier: Apache-2.0
/**
 * Global concurrency control for graph coordinator.
 * Manages the global sub-agent concurrency limit across all active graphs,
 * with FIFO queue drain when slots become available.
 * @module
 */

import type { CoordinatorSharedState, GraphCoordinatorDeps, GraphRunState, CoordinatorConfig } from "./graph-coordinator-state.js";

// ---------------------------------------------------------------------------
// Concurrency gating
// ---------------------------------------------------------------------------

/**
 * Gate a sub-agent spawn through the global concurrency limit.
 * If under capacity, spawns immediately and increments counter.
 * If at capacity, queues for FIFO drain as other agents complete.
 */
export function gatedSpawn(
  state: CoordinatorSharedState,
  deps: Pick<GraphCoordinatorDeps, "logger">,
  config: Pick<CoordinatorConfig, "maxGlobalSubAgents">,
  gs: GraphRunState,
  nodeId: string,
  spawnFn: () => void,
): boolean {
  if (state.globalActiveSubAgents < config.maxGlobalSubAgents) {
    state.globalActiveSubAgents++;
    spawnFn();
    return true;
  }
  state.spawnQueue.push({ graphId: gs.graphId, nodeId, execute: spawnFn });
  deps.logger?.debug(
    { graphId: gs.graphId, nodeId, queueDepth: state.spawnQueue.length, globalActiveSubAgents: state.globalActiveSubAgents, maxGlobalSubAgents: config.maxGlobalSubAgents },
    "Spawn queued (global limit reached)",
  );
  return false;
}

/**
 * Release one global concurrency slot and drain the FIFO spawn queue.
 * Skips entries for cancelled/completed graphs (stale entries).
 */
export function releaseAndDrainQueue(
  state: CoordinatorSharedState,
  config: Pick<CoordinatorConfig, "maxGlobalSubAgents">,
): void {
  state.globalActiveSubAgents = Math.max(0, state.globalActiveSubAgents - 1);
  while (state.spawnQueue.length > 0 && state.globalActiveSubAgents < config.maxGlobalSubAgents) {
    const next = state.spawnQueue.shift()!;
    const gs = state.graphs.get(next.graphId);
    if (!gs || gs.completedAt !== undefined) continue; // stale entry
    state.globalActiveSubAgents++;
    next.execute();
  }
}

/**
 * Global completion handler for the session:sub_agent_completed event.
 *
 * The event subscription fires for ALL sub-agent completions (graph nodes AND
 * `sessions_spawn` calls). This handler filters to graph-owned runIds only:
 * non-graph completions bail immediately, preserving the global concurrency
 * counters (which only track gatedSpawn-claimed slots).
 *
 * Routes graph-owned completions to:
 *   - handleDriverTurnCompleted (driver-managed turn)
 *   - handleSubAgentCompleted (regular node)
 *   - (silent return for synthetic wait_for_input replies — never consumed a slot)
 *
 * releaseAndDrainQueue runs ONLY when a graph claimed the runId via gatedSpawn,
 * matching the invariant that release is paired one-to-one with claim.
 */
export function globalCompletionHandler(
  state: CoordinatorSharedState,
  config: Pick<CoordinatorConfig, "maxGlobalSubAgents">,
  event: { runId: string; success: boolean; tokensUsed?: number; cost?: number; cacheReadTokens?: number; cacheWriteTokens?: number },
  callbacks: {
    handleDriverTurnCompleted: (gs: GraphRunState, nodeId: string, event: { runId: string; success: boolean; tokensUsed?: number; cost?: number; cacheReadTokens?: number; cacheWriteTokens?: number }) => void;
    handleSubAgentCompleted: (gs: GraphRunState, event: { runId: string; success: boolean; tokensUsed?: number; cost?: number; cacheReadTokens?: number; cacheWriteTokens?: number }) => void;
  },
): void {
  // Ownership-first filter: scan all graphs for the runId.
  // Non-graph completions (e.g. `sessions_spawn` runs) MUST NOT touch the global
  // concurrency counters — those slots belong to graph spawns gated through gatedSpawn.
  for (const gs of state.graphs.values()) {
    // Driver-managed turn
    const driverRunInfo = gs.driverRunIdMap.get(event.runId);
    if (driverRunInfo !== undefined) {
      releaseAndDrainQueue(state, config);
      callbacks.handleDriverTurnCompleted(gs, driverRunInfo.nodeId, event);
      return;
    }
    // Synthetic wait_for_input reply — never claimed a gatedSpawn slot, do NOT release one.
    if (gs.syntheticRunResults.has(event.runId)) {
      return;
    }
    // Regular node completion
    if (gs.runIdToNode.has(event.runId)) {
      releaseAndDrainQueue(state, config);
      callbacks.handleSubAgentCompleted(gs, event);
      return;
    }
  }
  // Non-graph runId (e.g. sessions_spawn) — silently ignore. No log, no release.
  // The "Orphaned graph sub-agent completion" warn that previously lived here was
  // speculative defensive code guarding against an event-ordering race that cannot
  // occur: graph-node-lifecycle.ts and graph-driver-handler.ts both populate the
  // routing maps SYNCHRONOUSLY inside the gatedSpawn callback, immediately after
  // subAgentRunner.spawn() returns the runId, so the event can never fire before
  // the map entry is set.
}
