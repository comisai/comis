/**
 * Driver node handling for graph coordinator.
 * Manages the multi-turn driver lifecycle: turn completion routing,
 * timeout handling, action dispatch (spawn, spawn_all, complete, fail,
 * wait, wait_for_input, progress), and parallel turn aggregation.
 * @module
 */

import {
  type NodeDriverAction,
  type SessionKey,
  type NormalizedMessage,
  parseFormattedSessionKey,
} from "@comis/core";
import { suppressError } from "@comis/shared";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { gatedSpawn } from "./graph-concurrency.js";
import { resolveFileReferenceOutput, persistArtifacts } from "./graph-node-lifecycle.js";
import type {
  CoordinatorSharedState,
  GraphCoordinatorDeps,
  GraphRunState,
  CoordinatorConfig,
} from "./graph-coordinator-state.js";

// ---------------------------------------------------------------------------
// Driver turn completion
// ---------------------------------------------------------------------------

/**
 * Process a driver node's turn completion. Handles budget accumulation,
 * result capture, parallel turn aggregation, timeout refresh, and
 * dispatches the next driver action.
 */
export function handleDriverTurnCompleted(
  state: CoordinatorSharedState,
  deps: Pick<GraphCoordinatorDeps, "subAgentRunner" | "eventBus" | "logger" | "sendToChannel">,
  config: Pick<CoordinatorConfig, "maxGlobalSubAgents" | "maxParallelSpawns">,
  gs: GraphRunState,
  nodeId: string,
  event: { runId: string; success: boolean; tokensUsed?: number; cost?: number; cacheReadTokens?: number; cacheWriteTokens?: number },
  callbacks: {
    markNodeFailed: (gs: GraphRunState, nodeId: string, error: string) => void;
    handleBudgetExceeded: (gs: GraphRunState, reason: string) => void;
    spawnReadyNodes: (gs: GraphRunState) => void;
    handleGraphCompletion: (gs: GraphRunState) => void;
  },
): void {
  const ds = gs.driverStates.get(nodeId);
  if (!ds) return;

  // Budget accumulation
  gs.cumulativeTokens += event.tokensUsed ?? 0;
  gs.cumulativeCost += event.cost ?? 0;

  // Accumulate per-node cache data across driver turns
  const cacheRead = event.cacheReadTokens ?? 0;
  const cacheWrite = event.cacheWriteTokens ?? 0;
  if (cacheRead > 0 || cacheWrite > 0) {
    const existing = gs.nodeCacheData.get(nodeId);
    gs.nodeCacheData.set(nodeId, {
      cacheReadTokens: (existing?.cacheReadTokens ?? 0) + cacheRead,
      cacheWriteTokens: (existing?.cacheWriteTokens ?? 0) + cacheWrite,
    });
  }

  // Capture result immediately (capture before sweep)
  const run = deps.subAgentRunner.getRunStatus(event.runId);

  // Capture the first round's session key for driver reuse on subsequent rounds.
  // This MUST happen here (not in executeDriverAction) because spawn() sets run.sessionKey
  // asynchronously inside startExecution via queueMicrotask. By the time handleDriverTurnCompleted
  // fires, the run has completed and sessionKey is guaranteed populated.
  if (ds && !ds.persistentSessionKey && run?.sessionKey) {
    ds.persistentSessionKey = run.sessionKey;
    deps.logger?.debug(
      { graphId: gs.graphId, nodeId, persistentSessionKey: run.sessionKey },
      "Captured persistent session key from first driver round",
    );
  }

  // Check for synthetic runId (wait_for_input reply)
  const syntheticReply = gs.syntheticRunResults.get(event.runId);
  if (syntheticReply !== undefined) {
    gs.syntheticRunResults.delete(event.runId);
  }

  // Budget check BEFORE driver callbacks
  const budget = gs.graph.graph.budget;
  if (budget && !gs.stateMachine.isTerminal()) {
    const tokenExceeded = budget.maxTokens !== undefined && gs.cumulativeTokens > budget.maxTokens;
    const costExceeded = budget.maxCost !== undefined && gs.cumulativeCost > budget.maxCost;
    if (tokenExceeded || costExceeded) {
      ds.driver.onAbort(ds.ctx);
      deps.eventBus.emit("graph:driver_lifecycle", {
        graphId: gs.graphId,
        nodeId,
        typeId: ds.driver.typeId,
        phase: "aborted",
      });
      gs.driverStates.delete(nodeId);
      gs.runningCount--;
      const timer = gs.nodeTimers.get(nodeId);
      if (timer) { clearTimeout(timer); gs.nodeTimers.delete(nodeId); }
      callbacks.handleBudgetExceeded(gs, tokenExceeded ? "tokens" : "cost");
      return;
    }
  }

  // Determine the output text
  let output = syntheticReply ?? run?.result?.response ?? "";

  // Resolve degenerate file-reference outputs
  if (gs.sharedDir && output) {
    output = resolveFileReferenceOutput(output, gs.sharedDir);
  }

  // Remove runId from tracking
  gs.driverRunIdMap.delete(event.runId);

  if (!event.success && syntheticReply === undefined) {
    // Check for partial output BEFORE onAbort (driver state must be accessible)
    const partialOutput = ds.driver.getPartialOutput?.(ds.ctx);

    // Turn failure: call onAbort and clean up driver state
    ds.driver.onAbort(ds.ctx);

    if (partialOutput) {
      // Partial completion: driver accumulated meaningful work before failure
      deps.logger?.info(
        { graphId: gs.graphId, nodeId, typeId: ds.driver.typeId, hint: "Driver turn failed but partial output recovered", errorKind: "internal" as const },
        "Driver node partial completion recovered",
      );

      // Persist partial output to shared dir
      if (gs.sharedDir) {
        try {
          writeFileSync(join(gs.sharedDir, `${nodeId}-output.md`), partialOutput, "utf8");
        } catch { /* best-effort */ }
      }

      gs.nodeOutputs.set(nodeId, partialOutput);
      gs.stateMachine.markNodeCompleted(nodeId, partialOutput);
      gs.runningCount--;

      const timer = gs.nodeTimers.get(nodeId);
      if (timer) { clearTimeout(timer); gs.nodeTimers.delete(nodeId); }

      deps.eventBus.emit("graph:driver_lifecycle", {
        graphId: gs.graphId,
        nodeId,
        typeId: ds.driver.typeId,
        phase: "partial_complete",
      });

      gs.driverStates.delete(nodeId);

      deps.eventBus.emit("graph:node_updated", {
        graphId: gs.graphId,
        nodeId,
        status: "completed" as const,
        timestamp: Date.now(),
      });

      if (gs.stateMachine.isTerminal()) {
        callbacks.handleGraphCompletion(gs);
        return;
      }
      queueMicrotask(() => callbacks.spawnReadyNodes(gs));
      return;
    }

    // No partial output -- original failure path
    deps.eventBus.emit("graph:driver_lifecycle", {
      graphId: gs.graphId,
      nodeId,
      typeId: ds.driver.typeId,
      phase: "failed",
    });
    gs.driverStates.delete(nodeId);
    gs.runningCount--;
    const timer = gs.nodeTimers.get(nodeId);
    if (timer) { clearTimeout(timer); gs.nodeTimers.delete(nodeId); }
    gs.nodeOutputs.set(nodeId, output || undefined);
    callbacks.markNodeFailed(gs, nodeId, run?.error ?? "Driver turn failed");
    return;
  }

  // Route to the appropriate driver callback
  let nextAction: NodeDriverAction;

  if (ds.pendingParallel) {
    // Parallel turn completion -- find the agentId for this runId
    let agentId = "unknown";
    for (const [rid, info] of ds.pendingParallel) {
      if (rid === event.runId) {
        agentId = info.agentId;
        ds.pendingParallel.delete(rid);
        break;
      }
    }

    ds.parallelCompleted = (ds.parallelCompleted ?? 0) + 1;

    // Accumulate this output for aggregation
    ds.parallelOutputs = ds.parallelOutputs ?? [];
    ds.parallelOutputs.push({ agentId, output });

    if (ds.pendingParallel.size === 0) {
      // All parallel turns done -- call onParallelTurnComplete with ALL accumulated outputs
      if (!ds.driver.onParallelTurnComplete) {
        callbacks.markNodeFailed(gs, nodeId, `Driver ${ds.driver.typeId} missing onParallelTurnComplete`);
        return;
      }
      nextAction = ds.driver.onParallelTurnComplete(ds.ctx, ds.parallelOutputs);
      ds.pendingParallel = undefined;
      ds.parallelCompleted = undefined;
      ds.parallelOutputs = undefined;
    } else {
      // Still waiting for more parallel completions
      return;
    }
  } else {
    // Sequential turn completion
    ds.currentRunId = undefined;
    nextAction = ds.driver.onTurnComplete(ds.ctx, output);
  }

  // Initialize accumulated discoveries for carry-forward robustness.
  // The primary mechanism is the persistent session key; this is a fallback
  // for edge cases where the session is cleaned up between rounds.
  if (!ds.accumulatedDiscoveries) {
    const turnNode = gs.graph.graph.nodes.find((n) => n.nodeId === nodeId);
    const turnMcpServers = turnNode?.mcpServers ?? [];
    if (turnMcpServers.length > 0 && gs.graphToolNames) {
      const prefixes = turnMcpServers.map(s => `mcp__${s}--`);
      ds.accumulatedDiscoveries = gs.graphToolNames.filter(t =>
        prefixes.some(p => t.startsWith(p))
      );
    }
  }

  // Refresh per-node timeout
  const node = gs.graph.graph.nodes.find((n) => n.nodeId === nodeId);
  const timeoutMs = node?.timeoutMs ?? ds.driver.defaultTimeoutMs;
  if (timeoutMs > 0) {
    const existingTimer = gs.nodeTimers.get(nodeId);
    if (existingTimer) clearTimeout(existingTimer);
    const newTimer = setTimeout(() => handleDriverTimeout(state, deps, config, gs, nodeId, callbacks), timeoutMs);
    if (typeof newTimer === "object" && "unref" in newTimer) {
      newTimer.unref();
    }
    gs.nodeTimers.set(nodeId, newTimer);
  }

  // Check if graph was cancelled during this turn
  if (gs.stateMachine.isTerminal()) return;

  // Execute the next action (deferred to prevent re-entrancy)
  queueMicrotask(() => executeDriverAction(state, deps, config, gs, nodeId, nextAction, callbacks));
}

// ---------------------------------------------------------------------------
// Driver timeout
// ---------------------------------------------------------------------------

/**
 * Handle driver node timeout: kill current/pending runs, call onAbort,
 * clean up state, and mark the node as failed.
 */
export function handleDriverTimeout(
  state: CoordinatorSharedState,
  deps: Pick<GraphCoordinatorDeps, "subAgentRunner" | "eventBus" | "logger" | "sendToChannel">,
  config: Pick<CoordinatorConfig, "maxGlobalSubAgents" | "maxParallelSpawns">,
  gs: GraphRunState,
  nodeId: string,
  callbacks: {
    markNodeFailed: (gs: GraphRunState, nodeId: string, error: string) => void;
    handleBudgetExceeded: (gs: GraphRunState, reason: string) => void;
    spawnReadyNodes: (gs: GraphRunState) => void;
    handleGraphCompletion: (gs: GraphRunState) => void;
  },
): void {
  const ds = gs.driverStates.get(nodeId);
  if (!ds) return;

  // Kill the current turn if running
  if (ds.currentRunId) {
    deps.subAgentRunner.killRun(ds.currentRunId);
    gs.driverRunIdMap.delete(ds.currentRunId);
  }

  // Kill any pending parallel runs
  if (ds.pendingParallel) {
    for (const [runId] of ds.pendingParallel) {
      deps.subAgentRunner.killRun(runId);
      gs.driverRunIdMap.delete(runId);
    }
  }

  // Remove queued spawns for this node from global queue
  for (let i = state.spawnQueue.length - 1; i >= 0; i--) {
    if (state.spawnQueue[i]!.graphId === gs.graphId && state.spawnQueue[i]!.nodeId === nodeId) {
      state.spawnQueue.splice(i, 1);
    }
  }

  // Check for partial output BEFORE onAbort (driver state must be accessible)
  const partialOutput = ds.driver.getPartialOutput?.(ds.ctx);

  // Call driver onAbort
  ds.driver.onAbort(ds.ctx);

  if (partialOutput) {
    // Partial completion: driver accumulated meaningful work before timeout
    deps.logger?.info(
      { graphId: gs.graphId, nodeId, typeId: ds.driver.typeId, hint: "Driver timed out but partial output recovered", errorKind: "internal" as const },
      "Driver node timeout partial completion recovered",
    );

    // Persist partial output to shared dir
    if (gs.sharedDir) {
      try {
        writeFileSync(join(gs.sharedDir, `${nodeId}-output.md`), partialOutput, "utf8");
      } catch { /* best-effort */ }
    }

    gs.nodeOutputs.set(nodeId, partialOutput);
    gs.stateMachine.markNodeCompleted(nodeId, partialOutput);

    deps.eventBus.emit("graph:driver_lifecycle", {
      graphId: gs.graphId,
      nodeId,
      typeId: ds.driver.typeId,
      phase: "partial_complete",
    });

    gs.driverStates.delete(nodeId);

    // Clean up wait handler if exists
    const waitHandler = gs.waitHandlers.get(nodeId);
    if (waitHandler) {
      deps.eventBus.off("message:received", waitHandler);
      gs.waitHandlers.delete(nodeId);
    }

    gs.runningCount--;
    gs.nodeTimers.delete(nodeId);

    deps.eventBus.emit("graph:node_updated", {
      graphId: gs.graphId,
      nodeId,
      status: "completed" as const,
      timestamp: Date.now(),
    });

    if (gs.stateMachine.isTerminal()) {
      callbacks.handleGraphCompletion(gs);
      return;
    }
    queueMicrotask(() => callbacks.spawnReadyNodes(gs));
    return;
  }

  // Emit lifecycle: aborted (no partial output -- original path)
  deps.eventBus.emit("graph:driver_lifecycle", {
    graphId: gs.graphId,
    nodeId,
    typeId: ds.driver.typeId,
    phase: "aborted",
  });

  // Clean up
  gs.driverStates.delete(nodeId);

  // Clean up wait handler if exists
  const waitHandler = gs.waitHandlers.get(nodeId);
  if (waitHandler) {
    deps.eventBus.off("message:received", waitHandler);
    gs.waitHandlers.delete(nodeId);
  }

  // Decrement running count and clear timer
  gs.runningCount--;
  gs.nodeTimers.delete(nodeId);

  // Mark node failed
  gs.stateMachine.markNodeFailed(nodeId, "Driver node timeout");

  deps.eventBus.emit("graph:node_updated", {
    graphId: gs.graphId,
    nodeId,
    status: "failed" as const,
    error: "Driver node timeout",
    timestamp: Date.now(),
  });

  if (gs.stateMachine.isTerminal()) {
    callbacks.handleGraphCompletion(gs);
    return;
  }
  queueMicrotask(() => callbacks.spawnReadyNodes(gs));
}

// ---------------------------------------------------------------------------
// Wait for input
// ---------------------------------------------------------------------------

/**
 * Handle the wait_for_input driver action: send a prompt to a chat channel
 * and block until the identified user replies or timeout.
 * Critical ordering: register listener BEFORE sending prompt.
 */
export function handleWaitForInput(
  state: CoordinatorSharedState,
  deps: Pick<GraphCoordinatorDeps, "subAgentRunner" | "eventBus" | "logger" | "sendToChannel">,
  config: Pick<CoordinatorConfig, "maxGlobalSubAgents" | "maxParallelSpawns">,
  gs: GraphRunState,
  nodeId: string,
  action: { action: "wait_for_input"; message: string; timeoutMs: number },
  callbacks: {
    markNodeFailed: (gs: GraphRunState, nodeId: string, error: string) => void;
    handleBudgetExceeded: (gs: GraphRunState, reason: string) => void;
    spawnReadyNodes: (gs: GraphRunState) => void;
    handleGraphCompletion: (gs: GraphRunState) => void;
  },
): void {
  const ds = gs.driverStates.get(nodeId);
  if (!ds) return;

  // Validate that we have a channel to send to
  if (!gs.announceChannelType || !gs.announceChannelId) {
    callbacks.markNodeFailed(gs, nodeId, "wait_for_input requires announceChannelType and announceChannelId on the graph run");
    return;
  }

  // Extract the caller's userId for identity matching
  let callerUserId: string | undefined;
  if (gs.callerSessionKey) {
    const parsed = parseFormattedSessionKey(gs.callerSessionKey);
    callerUserId = parsed?.userId;
  }

  // Create synthetic runId for routing the reply through handleDriverTurnCompleted
  const syntheticRunId = `__user_reply__:${nodeId}`;

  // 1. Register listener BEFORE sending prompt
  const handler = (payload: { message: NormalizedMessage; sessionKey: SessionKey }) => {
    // Match by channel type + channel ID
    if (payload.message.channelType !== gs.announceChannelType) return;
    if (payload.sessionKey.channelId !== gs.announceChannelId) return;

    // Match by user identity (if we have one)
    if (callerUserId && payload.sessionKey.userId !== callerUserId) return;

    // Got a match -- clean up listener and timers
    deps.eventBus.off("message:received", handler);
    gs.waitHandlers.delete(nodeId);

    // Clear timeout and reminder timers
    const timeoutTimer = gs.nodeTimers.get(`${nodeId}:wait_timeout`);
    if (timeoutTimer) {
      clearTimeout(timeoutTimer);
      gs.nodeTimers.delete(`${nodeId}:wait_timeout`);
    }
    const reminderTimer = gs.nodeTimers.get(`${nodeId}:wait_reminder`);
    if (reminderTimer) {
      clearTimeout(reminderTimer);
      gs.nodeTimers.delete(`${nodeId}:wait_reminder`);
    }

    // Store the reply text for pickup in handleDriverTurnCompleted
    gs.syntheticRunResults.set(syntheticRunId, payload.message.text);

    // Route through the standard completion path as a synthetic event
    handleDriverTurnCompleted(state, deps, config, gs, nodeId, {
      runId: syntheticRunId,
      success: true,
      tokensUsed: 0,
      cost: 0,
    }, callbacks);
  };

  deps.eventBus.on("message:received", handler);
  gs.waitHandlers.set(nodeId, handler);

  // 2. Send the prompt to the channel
  deps.sendToChannel(gs.announceChannelType, gs.announceChannelId, action.message).catch((sendErr: unknown) => {
    deps.logger?.warn(
      { graphId: gs.graphId, nodeId, err: sendErr, hint: "Failed to send wait_for_input prompt", errorKind: "network" },
      "wait_for_input prompt delivery failed",
    );
  });

  // 3. Set up 50% reminder timer
  const reminderMs = Math.floor(action.timeoutMs * 0.5);
  if (reminderMs > 0) {
    const reminderTimer = setTimeout(() => {
      if (!gs.waitHandlers.has(nodeId)) return;
      if (gs.announceChannelType && gs.announceChannelId) {
        const remainingSeconds = Math.ceil((action.timeoutMs - reminderMs) / 1000);
        suppressError(
          deps.sendToChannel(
            gs.announceChannelType,
            gs.announceChannelId,
            `Reminder: waiting for your response. ${remainingSeconds}s remaining.`,
          ),
          "best-effort wait reminder announcement",
        );
      }
    }, reminderMs);
    if (typeof reminderTimer === "object" && "unref" in reminderTimer) {
      reminderTimer.unref();
    }
    gs.nodeTimers.set(`${nodeId}:wait_reminder`, reminderTimer);
  }

  // 4. Set up timeout timer
  const timeoutTimer = setTimeout(() => {
    if (!gs.waitHandlers.has(nodeId)) return;

    deps.eventBus.off("message:received", handler);
    gs.waitHandlers.delete(nodeId);

    const rTimer = gs.nodeTimers.get(`${nodeId}:wait_reminder`);
    if (rTimer) {
      clearTimeout(rTimer);
      gs.nodeTimers.delete(`${nodeId}:wait_reminder`);
    }
    gs.nodeTimers.delete(`${nodeId}:wait_timeout`);

    // Route as a failed completion
    handleDriverTurnCompleted(state, deps, config, gs, nodeId, {
      runId: syntheticRunId,
      success: false,
      tokensUsed: 0,
      cost: 0,
    }, callbacks);
  }, action.timeoutMs);
  if (typeof timeoutTimer === "object" && "unref" in timeoutTimer) {
    timeoutTimer.unref();
  }
  gs.nodeTimers.set(`${nodeId}:wait_timeout`, timeoutTimer);

  deps.logger?.debug(
    { graphId: gs.graphId, nodeId, timeoutMs: action.timeoutMs, channel: gs.announceChannelType },
    "Waiting for user input",
  );
}

// ---------------------------------------------------------------------------
// Driver action dispatch
// ---------------------------------------------------------------------------

/**
 * Execute a NodeDriverAction returned by a driver callback.
 * Dispatches to spawn, spawn_all, complete, fail, wait, wait_for_input, or progress.
 */
export function executeDriverAction(
  state: CoordinatorSharedState,
  deps: Pick<GraphCoordinatorDeps, "subAgentRunner" | "eventBus" | "logger" | "sendToChannel">,
  config: Pick<CoordinatorConfig, "maxGlobalSubAgents" | "maxParallelSpawns">,
  gs: GraphRunState,
  nodeId: string,
  action: NodeDriverAction,
  callbacks: {
    markNodeFailed: (gs: GraphRunState, nodeId: string, error: string) => void;
    handleBudgetExceeded: (gs: GraphRunState, reason: string) => void;
    spawnReadyNodes: (gs: GraphRunState) => void;
    handleGraphCompletion: (gs: GraphRunState) => void;
  },
): void {
  const ds = gs.driverStates.get(nodeId);
  if (!ds) return;

  // Resolve MCP pre-seeds for this driver node
  const node = gs.graph.graph.nodes.find((n) => n.nodeId === nodeId);
  const mcpServers = node?.mcpServers ?? [];
  let preSeededTools: string[] | undefined;
  if (mcpServers.length > 0 && gs.graphToolNames) {
    const prefixes = mcpServers.map(s => `mcp__${s}--`);
    preSeededTools = gs.graphToolNames.filter(t =>
      prefixes.some(p => t.startsWith(p))
    );
  }
  // Merge pre-seeded tools with accumulated round discoveries
  const discoveredDeferredTools = [
    ...(preSeededTools ?? []),
    ...(ds.accumulatedDiscoveries ?? []),
  ];

  switch (action.action) {
    case "spawn": {
      // Auto-inject persistent session key for multi-round driver reuse.
      // After the first round completes, handleDriverTurnCompleted captures ds.persistentSessionKey.
      // Subsequent spawns reuse that session for cache prefix continuity.
      // If the driver explicitly provides reuseSessionKey, use that instead.
      const effectiveReuseKey = action.reuseSessionKey ?? ds.persistentSessionKey;

      gatedSpawn(state, deps, config, gs, nodeId, () => {
        const runId = deps.subAgentRunner.spawn({
          task: action.task,
          agentId: action.agentId,
          model: action.model,
          max_steps: action.maxSteps,
          callerSessionKey: gs.callerSessionKey,
          callerAgentId: gs.callerAgentId,
          callerType: "graph",
          graphSharedDir: gs.sharedDir,
          graphTraceId: gs.graphTraceId,
          graphId: gs.graphId,
          nodeId,
          graphToolNames: gs.graphToolNames,  // Propagate tool superset for driver spawns
          reuseSessionKey: effectiveReuseKey,  // Undefined on first spawn, populated on subsequent rounds
          ...(discoveredDeferredTools.length > 0 && { discoveredDeferredTools }),
        });
        ds.currentRunId = runId;
        gs.driverRunIdMap.set(runId, { nodeId, agentId: action.agentId });
        deps.logger?.debug(
          { graphId: gs.graphId, nodeId, runId, agentId: action.agentId, reuseSession: !!effectiveReuseKey },
          "Driver spawned sub-agent",
        );
      });
      break;
    }

    case "spawn_all": {
      // Runtime enforcement: spawn_all requires onParallelTurnComplete
      if (!ds.driver.onParallelTurnComplete) {
        callbacks.markNodeFailed(gs, nodeId, `Driver ${ds.driver.typeId} returned spawn_all but does not implement onParallelTurnComplete`);
        return;
      }

      // Cap at maxParallelSpawns
      let spawns = action.spawns;
      if (spawns.length > config.maxParallelSpawns) {
        deps.logger?.warn(
          { graphId: gs.graphId, nodeId, requested: spawns.length, max: config.maxParallelSpawns, hint: "spawn_all array truncated to maxParallelSpawns", errorKind: "limit" },
          "spawn_all exceeded maxParallelSpawns, truncating",
        );
        spawns = spawns.slice(0, config.maxParallelSpawns);
      }

      ds.pendingParallel = new Map();
      ds.parallelCompleted = 0;
      ds.parallelOutputs = [];

      for (let i = 0; i < spawns.length; i++) {
        const s = spawns[i]!;
        gatedSpawn(state, deps, config, gs, nodeId, () => {
          const runId = deps.subAgentRunner.spawn({
            task: s.task,
            agentId: s.agentId,
            model: s.model,
            max_steps: s.maxSteps,
            callerSessionKey: gs.callerSessionKey,
            callerAgentId: gs.callerAgentId,
            callerType: "graph",
            graphSharedDir: gs.sharedDir,
            graphTraceId: gs.graphTraceId,
            graphId: gs.graphId,
            nodeId,
            graphToolNames: gs.graphToolNames,  // Propagate tool superset for driver parallel spawns
            ...(discoveredDeferredTools.length > 0 && { discoveredDeferredTools }),
          });
          ds.pendingParallel!.set(runId, { agentId: s.agentId, index: i, total: spawns.length });
          gs.driverRunIdMap.set(runId, { nodeId, agentId: s.agentId });
        });
      }

      deps.logger?.debug(
        { graphId: gs.graphId, nodeId, count: spawns.length },
        "Driver spawned parallel sub-agents",
      );
      break;
    }

    case "complete": {
      persistArtifacts(deps, gs, nodeId, action.artifacts);
      const output = action.output;

      // Persist output to shared dir
      if (gs.sharedDir && output) {
        try {
          writeFileSync(join(gs.sharedDir, `${nodeId}-output.md`), output, "utf8");
        } catch { /* best-effort */ }
      }

      gs.nodeOutputs.set(nodeId, output);
      gs.stateMachine.markNodeCompleted(nodeId, output);
      gs.runningCount--;

      const timer = gs.nodeTimers.get(nodeId);
      if (timer) { clearTimeout(timer); gs.nodeTimers.delete(nodeId); }

      deps.eventBus.emit("graph:driver_lifecycle", {
        graphId: gs.graphId,
        nodeId,
        typeId: ds.driver.typeId,
        phase: "completed",
      });

      // Session files are left on disk and cleaned up by normal retention sweeps.
      gs.driverStates.delete(nodeId);

      deps.eventBus.emit("graph:node_updated", {
        graphId: gs.graphId,
        nodeId,
        status: "completed" as const,
        timestamp: Date.now(),
      });

      deps.logger?.debug(
        { graphId: gs.graphId, nodeId, typeId: ds.driver.typeId },
        "Driver node completed",
      );

      if (gs.stateMachine.isTerminal()) {
        callbacks.handleGraphCompletion(gs);
        return;
      }
      queueMicrotask(() => callbacks.spawnReadyNodes(gs));
      break;
    }

    case "fail": {
      persistArtifacts(deps, gs, nodeId, action.artifacts);

      deps.eventBus.emit("graph:driver_lifecycle", {
        graphId: gs.graphId,
        nodeId,
        typeId: ds.driver.typeId,
        phase: "failed",
      });

      // Session files are left on disk and cleaned up by normal retention sweeps.
      gs.driverStates.delete(nodeId);
      gs.runningCount--;
      const timer = gs.nodeTimers.get(nodeId);
      if (timer) { clearTimeout(timer); gs.nodeTimers.delete(nodeId); }

      callbacks.markNodeFailed(gs, nodeId, action.error);
      break;
    }

    case "wait": {
      // No-op: driver is waiting for more turns to complete
      break;
    }

    case "wait_for_input": {
      handleWaitForInput(state, deps, config, gs, nodeId, action, callbacks);
      break;
    }

    case "progress": {
      // Format progress and send to channel
      const progressMsg = `[${ds.driver.typeId}] ${action.stage}: ${action.current}/${action.total}${action.detail ? ` - ${action.detail}` : ""}`;

      deps.eventBus.emit("graph:driver_lifecycle", {
        graphId: gs.graphId,
        nodeId,
        typeId: ds.driver.typeId,
        phase: "progress",
      });

      if (gs.announceChannelType && gs.announceChannelId) {
        deps.sendToChannel(gs.announceChannelType, gs.announceChannelId, progressMsg).catch((sendErr: unknown) => {
          deps.logger?.warn(
            { graphId: gs.graphId, nodeId, err: sendErr, hint: "Progress message delivery failed", errorKind: "network" },
            "Driver progress delivery failed",
          );
        });
      }

      deps.logger?.debug(
        { graphId: gs.graphId, nodeId, stage: action.stage, current: action.current, total: action.total },
        "Driver progress",
      );
      break;
    }
  }
}
