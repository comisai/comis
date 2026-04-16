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
 * Releases a concurrency slot, then routes the completion to the correct
 * graph (driver turn, synthetic reply, or regular node).
 * Returns the { gs, nodeId } for a regular node completion, or undefined
 * if the event was handled by a driver or synthetic path.
 */
export function globalCompletionHandler(
  state: CoordinatorSharedState,
  config: Pick<CoordinatorConfig, "maxGlobalSubAgents">,
  event: { runId: string; success: boolean; tokensUsed?: number; cost?: number; cacheReadTokens?: number; cacheWriteTokens?: number },
  callbacks: {
    handleDriverTurnCompleted: (gs: GraphRunState, nodeId: string, event: { runId: string; success: boolean; tokensUsed?: number; cost?: number; cacheReadTokens?: number; cacheWriteTokens?: number }) => void;
    handleSubAgentCompleted: (gs: GraphRunState, event: { runId: string; success: boolean; tokensUsed?: number; cost?: number; cacheReadTokens?: number; cacheWriteTokens?: number }) => void;
  },
  deps?: { logger?: { warn(obj: Record<string, unknown>, msg: string): void } },
): void {
  // Release global slot and drain queue FIRST
  releaseAndDrainQueue(state, config);

  for (const gs of state.graphs.values()) {
    // Check driver-managed turns first
    const driverRunInfo = gs.driverRunIdMap.get(event.runId);
    if (driverRunInfo !== undefined) {
      callbacks.handleDriverTurnCompleted(gs, driverRunInfo.nodeId, event);
      return;
    }
    // Check synthetic runIds (wait_for_input replies)
    if (gs.syntheticRunResults.has(event.runId)) {
      return;
    }
    // Regular node completion
    if (gs.runIdToNode.has(event.runId)) {
      callbacks.handleSubAgentCompleted(gs, event);
      return;
    }
  }

  // Log when completion event not routed to any graph
  if (deps?.logger) {
    deps.logger.warn({
      runId: event.runId,
      success: event.success,
      hint: "Sub-agent completion event not routed to any graph — possible event ordering issue or non-graph completion",
      errorKind: "internal",
    }, "Orphaned graph sub-agent completion");
  }
}
