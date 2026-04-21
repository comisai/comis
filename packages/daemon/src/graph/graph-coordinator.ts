// SPDX-License-Identifier: Apache-2.0
/**
 * Graph coordinator: thin composition layer wiring 5 focused modules
 * (concurrency, node-lifecycle, driver-handler, completion, cleanup)
 * into a single factory that executes DAG-based execution graphs.
 * @module
 */

import { createGraphStateMachine, type GraphExecutionSnapshot } from "./graph-state-machine.js";
import type { GraphStatus } from "@comis/core";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { ok, err, type Result } from "@comis/shared";
import { computeGraphToolSuperset } from "./graph-tool-superset.js";
import { preWarmGraphCache, type PreWarmSdk } from "./graph-prewarm.js";
import { getModel, completeSimple } from "@mariozechner/pi-ai";

// Module imports
import { globalCompletionHandler, releaseAndDrainQueue } from "./graph-concurrency.js";
import {
  spawnNode as spawnNodeFn,
  spawnReadyNodes as spawnReadyNodesFn,
  startDriverNode as startDriverNodeFn,
  markNodeFailed as markNodeFailedFn,
  handleSubAgentCompleted as handleSubAgentCompletedFn,
} from "./graph-node-lifecycle.js";
import {
  handleDriverTurnCompleted as handleDriverTurnCompletedFn,
  handleDriverTimeout as handleDriverTimeoutFn,
  executeDriverAction as executeDriverActionFn,
} from "./graph-driver-handler.js";
import {
  handleGraphCompletion as handleGraphCompletionFn,
  handleBudgetExceeded as handleBudgetExceededFn,
  handleGraphTimeout as handleGraphTimeoutFn,
} from "./graph-completion.js";
import { clearAllTimers, sweepExpiredGraphs } from "./graph-cleanup.js";

export type { GraphCoordinatorDeps, GraphRunState, CoordinatorSharedState, CoordinatorConfig } from "./graph-coordinator-state.js";
import type {
  CoordinatorSharedState,
  GraphCoordinatorDeps,
  GraphRunState,
  CoordinatorConfig,
} from "./graph-coordinator-state.js";

export interface GraphRunParams {
  graph: import("@comis/core").ValidatedGraph;
  callerSessionKey?: string;
  callerAgentId?: string;
  announceChannelType?: string;
  announceChannelId?: string;
  /** Send per-node completion progress messages to the channel. Default: false. */
  nodeProgress?: boolean;
}

export interface GraphRunSummary {
  graphId: string;
  label?: string;
  status: GraphStatus;
  startedAt: number;
  completedAt?: number;
}

export interface GraphCoordinator {
  run(params: GraphRunParams): Promise<Result<string, string>>;
  getStatus(graphId: string): GraphExecutionSnapshot | undefined;
  cancel(graphId: string): boolean;
  listGraphs(recentMinutes?: number): GraphRunSummary[];
  shutdown(): Promise<void>;
  getConcurrencyStats(): { globalActiveSubAgents: number; maxGlobalSubAgents: number; queueDepth: number };
  /** Direct notification when a graph-owned subagent is killed.
   *  Bypasses event bus for reliability during session cleanup. Idempotent. */
  notifyNodeFailed(graphId: string, nodeId: string, runId: string, error: string): void;
}

/** Create a graph coordinator that executes validated graphs end-to-end. */
export function createGraphCoordinator(deps: GraphCoordinatorDeps): GraphCoordinator {
  // Resolve configuration from deps
  const config: CoordinatorConfig = {
    maxConcurrency: deps.maxConcurrency ?? 4,
    maxResultLength: deps.maxResultLength ?? 12000,
    graphRetentionMs: deps.graphRetentionMs ?? 3_600_000,
    maxGlobalSubAgents: deps.maxGlobalSubAgents ?? 20,
    maxParallelSpawns: deps.maxParallelSpawns ?? 10,
    spawnStaggerMs: deps.spawnStaggerMs ?? 4000,
    cacheWriteTimeoutMs: deps.cacheWriteTimeoutMs ?? 30_000,
    maxGraphs: 100,
    sweepIntervalMs: 300_000,
    maxAnnouncementChars: deps.maxAnnouncementChars ?? 3000,
  };

  // Create shared mutable state
  const state: CoordinatorSharedState = {
    graphs: new Map(),
    globalActiveSubAgents: 0,
    spawnQueue: [],
  };

  // Callback wiring: bind module functions with closed-over state/deps/config
  const callbacks = {
    spawnReadyNodes: (gs: GraphRunState) =>
      spawnReadyNodesFn(state, deps, config, gs, {
        spawnNode: (gs2: GraphRunState, nodeId: string) =>
          callbacks.spawnNode(gs2, nodeId),
      }),

    spawnNode: (gs: GraphRunState, nodeId: string) =>
      spawnNodeFn(state, deps, config, gs, nodeId, {
        markNodeFailed: (gs2, nid, error) => callbacks.markNodeFailed(gs2, nid, error),
        startDriverNode: (gs2, nid, node, driver, task) =>
          startDriverNodeFn(state, deps, gs2, nid, node, driver, task, {
            markNodeFailed: (gs3, nid2, error) => callbacks.markNodeFailed(gs3, nid2, error),
            executeDriverAction: (gs3, nid2, action) =>
              executeDriverActionFn(state, deps, config, gs3, nid2, action, driverCallbacks),
            handleDriverTimeout: (gs3, nid2) =>
              handleDriverTimeoutFn(state, deps, config, gs3, nid2, driverCallbacks),
          }),
        spawnReadyNodes: (gs2) => callbacks.spawnReadyNodes(gs2),
      }),

    markNodeFailed: (gs: GraphRunState, nodeId: string, error: string) =>
      markNodeFailedFn(state, deps, gs, nodeId, error, {
        spawnReadyNodes: (gs2) => callbacks.spawnReadyNodes(gs2),
        handleGraphCompletion: (gs2) => callbacks.handleGraphCompletion(gs2),
      }),

    handleGraphCompletion: (gs: GraphRunState) =>
      handleGraphCompletionFn(state, deps, gs),

    handleBudgetExceeded: (gs: GraphRunState, reason: string) =>
      handleBudgetExceededFn(state, deps, gs, reason),

    handleSubAgentCompleted: (gs: GraphRunState, event: { runId: string; success: boolean; tokensUsed?: number; cost?: number; cacheReadTokens?: number; cacheWriteTokens?: number }) =>
      handleSubAgentCompletedFn(state, deps, config, gs, event, {
        spawnReadyNodes: (gs2) => callbacks.spawnReadyNodes(gs2),
        handleGraphCompletion: (gs2) => callbacks.handleGraphCompletion(gs2),
        handleBudgetExceeded: (gs2, reason) => callbacks.handleBudgetExceeded(gs2, reason),
      }),
  };

  // Driver-specific callbacks (shared between driver handler functions)
  const driverCallbacks = {
    markNodeFailed: (gs: GraphRunState, nodeId: string, error: string) =>
      callbacks.markNodeFailed(gs, nodeId, error),
    handleBudgetExceeded: (gs: GraphRunState, reason: string) =>
      callbacks.handleBudgetExceeded(gs, reason),
    spawnReadyNodes: (gs: GraphRunState) =>
      callbacks.spawnReadyNodes(gs),
    handleGraphCompletion: (gs: GraphRunState) =>
      callbacks.handleGraphCompletion(gs),
  };

  // Global event listener (single handler, no per-graph listener growth)
  function onSubAgentCompleted(event: { runId: string; success: boolean; tokensUsed?: number; cost?: number; cacheReadTokens?: number; cacheWriteTokens?: number }): void {
    globalCompletionHandler(state, config, event, {
      handleDriverTurnCompleted: (gs, nodeId, evt) =>
        handleDriverTurnCompletedFn(state, deps, config, gs, nodeId, evt, driverCallbacks),
      handleSubAgentCompleted: (gs, evt) =>
        callbacks.handleSubAgentCompleted(gs, evt),
    }, { logger: deps.logger });
  }

  deps.eventBus.on("session:sub_agent_completed", onSubAgentCompleted);

  // Sweep interval: remove expired completed graphs
  const sweepInterval = setInterval(() => {
    sweepExpiredGraphs(state, config);
  }, config.sweepIntervalMs);
  sweepInterval.unref();

  // Public API
  async function run(params: GraphRunParams): Promise<Result<string, string>> {
    const graphId = randomUUID();
    const graphTraceId = randomUUID();

    const sharedDir = join(deps.dataDir, "graph-runs", graphId);
    mkdirSync(sharedDir, { recursive: true, mode: 0o700 });

    if (state.graphs.size >= config.maxGraphs) {
      sweepExpiredGraphs(state, config);
      if (state.graphs.size >= config.maxGraphs) {
        return err("Too many active graphs");
      }
    }

    const stateMachine = createGraphStateMachine(params.graph);

    const gs: GraphRunState = {
      graphId,
      graphTraceId,
      graph: params.graph,
      stateMachine,
      runIdToNode: new Map(),
      nodeOutputs: new Map(),
      nodeTimers: new Map(),
      retryTimers: new Map(),
      graphTimer: undefined,
      startedAt: Date.now(),
      runningCount: 0,
      callerSessionKey: params.callerSessionKey,
      callerAgentId: params.callerAgentId,
      announceChannelType: params.announceChannelType,
      announceChannelId: params.announceChannelId,
      nodeProgress: params.nodeProgress ?? false,
      skippedNodesEmitted: new Set(),
      cumulativeTokens: 0,
      cumulativeCost: 0,
      sharedDir,
      driverStates: new Map(),
      driverRunIdMap: new Map(),
      waitHandlers: new Map(),
      syntheticRunResults: new Map(),
      nodeCacheData: new Map(),
      maxAnnouncementChars: config.maxAnnouncementChars,
    };

    state.graphs.set(graphId, gs);

    // Compute graph-wide tool superset. Stored as awaitable promise
    // so pre-warm can wait for tools before making the API call.
    // Also captures full tool definitions (description + inputSchema) for prewarm.
    if (deps.assembleToolsForAgent) {
      const assembleToolsFn = deps.assembleToolsForAgent;
      gs.toolSupersetPromise = (async () => {
        // First assemble full tool definitions for the default agent
        try {
          const fullTools = await assembleToolsFn(deps.defaultAgentId);
          gs.graphToolDefs = fullTools;  // Store full defs for prewarm
        } catch {
          // Best-effort: prewarm will use bare names as fallback
        }
        // Then compute the superset (names only, intersection/union logic)
        const toolNames = await computeGraphToolSuperset(params.graph, deps.defaultAgentId, assembleToolsFn);
        gs.graphToolNames = toolNames;
        deps.logger?.debug(
          { graphId, toolCount: toolNames.length },
          "Graph tool superset computed for cache prefix sharing",
        );
        return toolNames;
      })().catch(() => {
        deps.logger?.debug(
          { graphId },
          "Graph tool superset computation failed; nodes will use independent tool sets",
        );
        return [] as string[];
      });
    }

    // Warn when graph lacks announce channel for completion delivery
    if (!params.announceChannelType || !params.announceChannelId) {
      deps.logger?.warn({
        graphId,
        callerSessionKey: params.callerSessionKey,
        hint: "Graph has no announce channel — completion results will not be delivered to user",
        errorKind: "configuration",
      }, "Graph created without announce channel");
    }

    deps.eventBus.emit("graph:started", {
      graphId,
      label: params.graph.graph.label,
      nodeCount: params.graph.graph.nodes.length,
      timestamp: Date.now(),
    });

    deps.logger?.info(
      { graphId, graphTraceId, nodeCount: params.graph.graph.nodes.length },
      "Graph run assigned traceId for sub-agent correlation",
    );

    if (params.graph.graph.timeoutMs !== undefined && params.graph.graph.timeoutMs > 0) {
      gs.graphTimer = setTimeout(() => handleGraphTimeoutFn(state, deps, gs), params.graph.graph.timeoutMs);
      if (typeof gs.graphTimer === "object" && "unref" in gs.graphTimer) {
        gs.graphTimer.unref();
      }
    }

    // Optional pre-warm API call to seed cache before node spawns
    if (deps.preWarm && gs.toolSupersetPromise) {
      const toolNames = await gs.toolSupersetPromise;
      if (toolNames.length > 0) {
        const sdk: PreWarmSdk = {
          getModel: getModel as PreWarmSdk["getModel"],
          completeSimple: completeSimple as PreWarmSdk["completeSimple"],
        };
        // Use full tool definitions from graphToolDefs (with description + inputSchema).
        // Bare names produce minimal tool schemas that may be below the minimum cacheable tokens.
        // Full definitions ensure the prewarm prefix is large enough to cache AND byte-identical
        // to what sub-agents will send, maximizing cache hit rates.
        const preWarmTools: Array<{ name: string; description?: string; inputSchema?: unknown }> =
          gs.graphToolDefs && gs.graphToolDefs.length > 0
            ? gs.graphToolDefs.filter(t => toolNames.includes(t.name))
            : toolNames.map((name) => ({ name }));
        const preWarmResult = await preWarmGraphCache({
          provider: deps.preWarm.provider,
          modelId: deps.preWarm.modelId,
          apiKey: deps.preWarm.apiKey,
          systemPrompt: deps.preWarm.systemPrompt,
          tools: preWarmTools,
          logger: deps.logger,
        }, sdk);

        // Accumulate pre-warm cost in graph budget
        gs.cumulativeTokens += preWarmResult.tokensUsed;
        gs.cumulativeCost += preWarmResult.cost;

        if (preWarmResult.success) {
          gs.cachePrewarmed = true;
          deps.logger?.debug(
            { graphId, cacheWriteTokens: preWarmResult.cacheWriteTokens },
            "Pre-warm successful, all nodes will read from cache",
          );
        }
        // On failure (including skipped): fall through to spawnReadyNodes with event-driven stagger
      }
    }

    callbacks.spawnReadyNodes(gs);

    return ok(graphId);
  }

  function getStatus(graphId: string): GraphExecutionSnapshot | undefined {
    const gs = state.graphs.get(graphId);
    return gs?.stateMachine.snapshot();
  }

  function cancel(graphId: string): boolean {
    const gs = state.graphs.get(graphId);
    if (!gs) return false;
    if (gs.stateMachine.isTerminal()) return false;

    gs.cancelReason = "manual";

    // Clean up event-driven spawn gate on cancel
    gs.cacheWarmCleanup?.();

    // Kill all running regular nodes
    for (const [runId, nodeId] of gs.runIdToNode) {
      deps.subAgentRunner.killRun(runId);
      gs.stateMachine.markNodeFailed(nodeId, "Cancelled");
    }
    gs.runIdToNode.clear();

    // Kill active driver runs, call onAbort, clean state
    for (const [nodeId, ds] of gs.driverStates) {
      if (ds.currentRunId) {
        deps.subAgentRunner.killRun(ds.currentRunId);
        gs.driverRunIdMap.delete(ds.currentRunId);
      }
      if (ds.pendingParallel) {
        for (const [runId] of ds.pendingParallel) {
          deps.subAgentRunner.killRun(runId);
          gs.driverRunIdMap.delete(runId);
        }
      }
      ds.driver.onAbort(ds.ctx);
      deps.eventBus.emit("graph:driver_lifecycle", {
        graphId: gs.graphId,
        nodeId,
        typeId: ds.driver.typeId,
        phase: "aborted",
      });
      gs.stateMachine.markNodeFailed(nodeId, "Cancelled");
    }
    gs.driverStates.clear();
    gs.driverRunIdMap.clear();

    // Remove queued spawns for this graph from global queue
    for (let i = state.spawnQueue.length - 1; i >= 0; i--) {
      if (state.spawnQueue[i]!.graphId === graphId) {
        state.spawnQueue.splice(i, 1);
      }
    }

    // Clean up wait handlers
    for (const [_nodeId, handler] of gs.waitHandlers) {
      deps.eventBus.off("message:received", handler);
    }
    gs.waitHandlers.clear();
    gs.syntheticRunResults.clear();

    gs.runningCount = 0;
    gs.stateMachine.cancel();
    callbacks.handleGraphCompletion(gs);

    return true;
  }

  function listGraphs(recentMinutes?: number): GraphRunSummary[] {
    const cutoff = recentMinutes && recentMinutes > 0
      ? Date.now() - recentMinutes * 60_000
      : 0;

    return [...state.graphs.values()]
      .filter((gs) => gs.startedAt >= cutoff)
      .sort((a, b) => b.startedAt - a.startedAt)
      .map((gs) => ({
        graphId: gs.graphId,
        label: gs.graph.graph.label,
        status: gs.stateMachine.getGraphStatus(),
        startedAt: gs.startedAt,
        completedAt: gs.completedAt,
      }));
  }

  async function shutdown(): Promise<void> {
    deps.eventBus.off("session:sub_agent_completed", onSubAgentCompleted);

    for (const gs of state.graphs.values()) {
      if (!gs.stateMachine.isTerminal()) {
        // Clean up event-driven spawn gate on shutdown
        gs.cacheWarmCleanup?.();
        for (const [runId] of gs.runIdToNode) {
          deps.subAgentRunner.killRun(runId);
        }
        for (const [, ds] of gs.driverStates) {
          if (ds.currentRunId) {
            deps.subAgentRunner.killRun(ds.currentRunId);
          }
          if (ds.pendingParallel) {
            for (const [runId] of ds.pendingParallel) {
              deps.subAgentRunner.killRun(runId);
            }
          }
          ds.driver.onAbort(ds.ctx);
        }
        gs.driverStates.clear();
        gs.driverRunIdMap.clear();

        for (const [, handler] of gs.waitHandlers) {
          deps.eventBus.off("message:received", handler);
        }
        gs.waitHandlers.clear();
        gs.syntheticRunResults.clear();

        gs.stateMachine.cancel();
        clearAllTimers(deps, gs);
        gs.completedAt = Date.now();
      }
    }

    // Clear spawn queue and reset global counter
    state.spawnQueue.length = 0;
    state.globalActiveSubAgents = 0;

    clearInterval(sweepInterval);
  }

  function getConcurrencyStats(): { globalActiveSubAgents: number; maxGlobalSubAgents: number; queueDepth: number } {
    return { globalActiveSubAgents: state.globalActiveSubAgents, maxGlobalSubAgents: config.maxGlobalSubAgents, queueDepth: state.spawnQueue.length };
  }

  /** Direct notification when a graph-owned subagent is killed.
   *  Bypasses event bus for reliability during session cleanup. Idempotent. */
  function notifyNodeFailed(graphId: string, _nodeId: string, runId: string, _error: string): void {
    const gs = state.graphs.get(graphId);
    if (!gs || gs.completedAt !== undefined) return; // graph already terminal -- idempotent

    const existingNode = gs.runIdToNode.get(runId);
    if (!existingNode) return; // runId not tracked -- already processed or wrong graph

    // Release global concurrency slot (normally done by globalCompletionHandler via event bus,
    // but since notifyNodeFailed skips the event emit for graph-owned kills, we must do it here)
    releaseAndDrainQueue(state, config);

    // Delegate to full callback chain (handles runIdToNode cleanup, runningCount--,
    // timer cleanup, result capture, state machine update, cascade, and terminal check)
    callbacks.handleSubAgentCompleted(gs, { runId, success: false });
  }

  return { run, getStatus, cancel, listGraphs, shutdown, getConcurrencyStats, notifyNodeFailed };
}
