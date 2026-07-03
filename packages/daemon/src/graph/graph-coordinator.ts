// SPDX-License-Identifier: Apache-2.0
/**
 * Graph coordinator: thin composition layer wiring 5 focused modules
 * (concurrency, node-lifecycle, driver-handler, completion, cleanup)
 * into a single factory that executes DAG-based execution graphs.
 * @module
 */

import { createGraphStateMachine, type GraphExecutionSnapshot } from "./graph-state-machine.js";
import { safePath, type GraphStatus, type ValidatedGraph, type DurableRunRecord, systemNowMs, systemSetInterval, systemClearInterval, systemSetTimeout, tryGetContext, parseFormattedSessionKey, validateAndSortGraph, parseDurableRunRecord, ExecutionGraphSchema } from "@comis/core";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { ok, err, type Result } from "@comis/shared";
import { snapshotToSpawnTree, incompleteNodes } from "./graph-durable-checkpoint.js";
import { computeGraphToolSuperset } from "./graph-tool-superset.js";
import { preWarmGraphCache, type PreWarmSdk } from "./graph-prewarm.js";
import { getModel, completeSimple } from "@earendil-works/pi-ai";

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
import { computeGraphTimeoutFloorMs } from "./graph-timeout-floor.js";

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
  /**
   * Resume a DAG run from its durable
   * checkpoint after a daemon restart. Re-enters ONLY the nodes that were NOT
   * terminal at crash time (`incompleteNodes(record.spawnTree)`) and DRIVES them
   * to execution via the node-lifecycle path (`spawnReadyNodes` → `spawnNode`),
   * so the re-entered node's sub-agent spawn actually fires — it does not merely
   * re-mark the node ready. Completed/skipped/failed nodes are NOT re-run; a
   * re-run node's outward sends are deduped by the ONCE ledger, so
   * node-boundary resume is exactly-once-safe without persisting intra-node
   * state. The durable resume engine routes a DAG-shaped record here via its
   * resume dispatch.
   */
  resumeGraph(record: DurableRunRecord): Promise<Result<void, Error>>;
}

/** Create a graph coordinator that executes validated graphs end-to-end. */
export function createGraphCoordinator(deps: GraphCoordinatorDeps): GraphCoordinator {
  // Resolve configuration from deps
  const config: CoordinatorConfig = {
    maxConcurrency: deps.maxConcurrency ?? 4,
    maxResultLength: deps.maxResultLength ?? 12000,
    subAgentTokenBudget: deps.subAgentTokenBudget ?? null,
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

  /**
   * Checkpoint the graph's per-node
   * completion state to the durable run store at a NODE boundary. Persists the
   * GraphExecutionSnapshot → `spawn_tree` keyed on the graph's tree-stable
   * `rootRunId`. A no-op when no store is wired or the run has no stable
   * root (the durable key). On a terminal graph it flips the record to
   * `completed` so resume skips it. Store errors are logged (WARN, hint +
   * errorKind) but NEVER crash the graph — durability is best-effort overlay on
   * the live run, never a blocker for it.
   */
  function checkpointGraph(gs: GraphRunState): void {
    if (!deps.durableRuns || gs.rootRunId === undefined) return;
    const store = deps.durableRuns;
    const rootRunId = gs.rootRunId;
    const terminal = gs.stateMachine.isTerminal();
    if (terminal) {
      void store.markCompleted(rootRunId).then((res) => {
        if (!res.ok) {
          deps.logger?.warn(
            { graphId: gs.graphId, rootRunId, err: res.error, hint: "durable markCompleted failed; the run stays resumable and will be re-scanned on next boot", errorKind: "resource" as const },
            "Graph durable markCompleted failed",
          );
        }
      });
      return;
    }
    // Source the run context the same way the flat-run checkpoint path does. The
    // graph run carries no per-node lease/caps record here (those are minted per
    // node), so the checkpoint persists the node-completion snapshot + the stable
    // root; the caps/leaseIds the resumed run rehydrates come from the run record
    // the outward-send path already wrote (outward_step is owned by
    // allocateOutwardStep — this upsert deliberately never touches it).
    const record: DurableRunRecord = {
      rootRunId,
      spawnTree: snapshotToSpawnTree(gs.stateMachine.snapshot()),
      caps: [],
      leaseIds: [],
      budgetConsumed: gs.cumulativeCost,
      cronOrigin: null,
      stepIndex: -1,
      status: "running",
      lastHeartbeatAt: systemNowMs(),
    };
    void store.upsertCheckpoint(record).then((res) => {
      if (!res.ok) {
        deps.logger?.warn(
          { graphId: gs.graphId, rootRunId, err: res.error, hint: "durable upsertCheckpoint failed; this node transition is not persisted, resume may re-run more nodes than necessary", errorKind: "resource" as const },
          "Graph durable checkpoint failed",
        );
      }
    });
  }

  // Callback wiring: bind module functions with closed-over state/deps/config.
  // The node-transition entry points (spawnNode →
  // markNodeRunning; handleSubAgentCompleted → markNodeCompleted/markNodeFailed;
  // markNodeFailed) each `checkpointGraph(gs)` AFTER the transition so the
  // durable spawn_tree tracks node completion at every boundary.
  const callbacks = {
    spawnReadyNodes: (gs: GraphRunState) =>
      spawnReadyNodesFn(state, deps, config, gs, {
        spawnNode: (gs2: GraphRunState, nodeId: string) =>
          callbacks.spawnNode(gs2, nodeId),
      }),

    spawnNode: (gs: GraphRunState, nodeId: string) => {
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
      });
      // markNodeRunning fired inside spawnNodeFn (running boundary) — persist it.
      checkpointGraph(gs);
    },

    markNodeFailed: (gs: GraphRunState, nodeId: string, error: string) => {
      markNodeFailedFn(state, deps, gs, nodeId, error, {
        spawnReadyNodes: (gs2) => callbacks.spawnReadyNodes(gs2),
        handleGraphCompletion: (gs2) => callbacks.handleGraphCompletion(gs2),
      });
      checkpointGraph(gs);
    },

    handleGraphCompletion: (gs: GraphRunState) =>
      handleGraphCompletionFn(state, deps, gs),

    handleBudgetExceeded: (gs: GraphRunState, reason: string) =>
      handleBudgetExceededFn(state, deps, gs, reason),

    handleSubAgentCompleted: (gs: GraphRunState, event: { runId: string; success: boolean; tokensUsed?: number; cost?: number; cacheReadTokens?: number; cacheWriteTokens?: number }) => {
      handleSubAgentCompletedFn(state, deps, config, gs, event, {
        spawnReadyNodes: (gs2) => callbacks.spawnReadyNodes(gs2),
        handleGraphCompletion: (gs2) => callbacks.handleGraphCompletion(gs2),
        handleBudgetExceeded: (gs2, reason) => callbacks.handleBudgetExceeded(gs2, reason),
      });
      // markNodeCompleted / markNodeFailed fired inside — persist the boundary.
      checkpointGraph(gs);
    },
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
    });
  }

  deps.eventBus.on("session:sub_agent_completed", onSubAgentCompleted);

  // Sweep interval: remove expired completed graphs
  const sweepInterval = systemSetInterval(() => {
    sweepExpiredGraphs(state, config);
  }, config.sweepIntervalMs);
  sweepInterval.unref();

  // Public API
  async function run(params: GraphRunParams): Promise<Result<string, string>> {
    const graphId = randomUUID();
    const graphTraceId = randomUUID();

    const sharedDir = safePath(deps.dataDir, "graph-runs", graphId);
    mkdirSync(sharedDir, { recursive: true, mode: 0o700 });

    if (state.graphs.size >= config.maxGraphs) {
      sweepExpiredGraphs(state, config);
      if (state.graphs.size >= config.maxGraphs) {
        return err("Too many active graphs");
      }
    }

    const stateMachine = createGraphStateMachine(params.graph);

    // Resolve ONE tree-stable rootRunId for the whole graph run
    // so every node spawn shares it (the tree-wide ceiling + killByRootRun see
    // one tree, not a fresh root per node). A graph submitted BY a sub-agent
    // (its session key maps to a live run) inherits that run's root; a top-level
    // submission resolves the caller session's stable root. Undefined when no
    // resolver is wired (nodes mint per-spawn — graph fan-out is
    // still bounded by the graph concurrency gate).
    const graphParentRun = params.callerSessionKey
      ? deps.subAgentRunner.getRunBySessionKey?.(params.callerSessionKey)
      : undefined;
    const graphParsedCaller = params.callerSessionKey
      ? parseFormattedSessionKey(params.callerSessionKey)
      : undefined;
    const graphRootRunId =
      graphParentRun?.rootRunId
      ?? (graphParsedCaller ? deps.resolveRootRunId?.(graphParsedCaller) : undefined);

    const gs: GraphRunState = {
      graphId,
      graphTraceId,
      ...(graphRootRunId !== undefined ? { rootRunId: graphRootRunId } : {}),
      graph: params.graph,
      stateMachine,
      runIdToNode: new Map(),
      nodeOutputs: new Map(),
      nodeTimers: new Map(),
      retryTimers: new Map(),
      graphTimer: undefined,
      startedAt: systemNowMs(),
      runningCount: 0,
      callerSessionKey: params.callerSessionKey,
      callerAgentId: params.callerAgentId,
      // Graph submission carries no inbound NormalizedMessage, so resolve
      // the reply language once from the caller's RequestContext.resolvedLanguage — set by the
      // parent executor — and thread it to every node envelope via buildContextEnvelope.
      resolvedLanguage: tryGetContext()?.resolvedLanguage,
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
      nodeTokenSpend: new Map(),
      nodeCost: new Map(),
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
        errorKind: "config" as const,
      }, "Graph created without announce channel");
    }

    deps.eventBus.emit("graph:started", {
      graphId,
      label: params.graph.graph.label,
      nodeCount: params.graph.graph.nodes.length,
      timestamp: systemNowMs(),
    });

    deps.logger?.info(
      { graphId, graphTraceId, nodeCount: params.graph.graph.nodes.length },
      "Graph run assigned traceId for sub-agent correlation",
    );

    // Enforce a makespan floor on the graph timeout. A weak model routinely
    // sets it too low for the DAG it just decomposed — observed live: a 6-node NVDA
    // pipeline given 10 min, where the 4 analysts (small-model concurrency = 2)
    // consumed the whole budget and the debate + head-trader were starved. The floor
    // is the critical-path makespan if every node ran to its timeout, accounting for
    // concurrency waves. max(requested, floor) lets the model decompose freely but
    // never starve later phases. See graph-timeout-floor.ts. `gs.graph === params.graph`
    // (state init), so updating timeoutMs keeps the completion-path timeout report accurate.
    // Only RAISE an existing positive timeout — never invent one. A graph with no
    // timeout (timeoutMs undefined/0) keeps the original "no graph-level timer, rely
    // on node timeouts" behavior. In production the schema default (1.5M = 25 min) is
    // always present, so the floor is max(1.5M, makespan) and never shortens anything.
    const requestedGraphTimeoutMs = params.graph.graph.timeoutMs ?? 0;
    if (requestedGraphTimeoutMs > 0) {
      const graphTimeoutFloorMs = computeGraphTimeoutFloorMs(
        params.graph.graph.nodes,
        deps.maxConcurrency ?? 4,
      );
      const effectiveGraphTimeoutMs = Math.max(requestedGraphTimeoutMs, graphTimeoutFloorMs);
      if (effectiveGraphTimeoutMs > requestedGraphTimeoutMs) {
        deps.logger?.warn(
          {
            graphId,
            requestedTimeoutMs: requestedGraphTimeoutMs,
            effectiveTimeoutMs: effectiveGraphTimeoutMs,
            timeoutFloorMs: graphTimeoutFloorMs,
            nodeCount: params.graph.graph.nodes.length,
            maxConcurrency: deps.maxConcurrency ?? 4,
            hint: "graph timeout raised to the DAG makespan floor so later phases (debate/head-trader) are not starved by earlier ones",
            errorKind: "config" as const,
          },
          "Graph timeout raised to makespan floor",
        );
        params.graph.graph.timeoutMs = effectiveGraphTimeoutMs;
      }
      gs.graphTimer = systemSetTimeout(() => handleGraphTimeoutFn(state, deps, gs), effectiveGraphTimeoutMs);
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
      ? systemNowMs() - recentMinutes * 60_000
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
        gs.completedAt = systemNowMs();
      }
    }

    // Clear spawn queue and reset global counter
    state.spawnQueue.length = 0;
    state.globalActiveSubAgents = 0;

    systemClearInterval(sweepInterval);
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

  /**
   * Resume a DAG run from its durable
   * checkpoint after a restart. Re-enters ONLY the incomplete nodes and DRIVES
   * them via the node-lifecycle path so each re-entered node's sub-agent spawn
   * actually fires — not a bare re-mark-ready. Completed nodes are not
   * re-run; a re-run node's outward sends dedupe via the ONCE ledger.
   *
   * The durable record carries node-completion STATE (`spawn_tree`) but not the
   * original graph topology/tasks (full mid-node DAG
   * state persistence is deliberately not attempted). So resume reconstructs a reduced graph from
   * the incomplete frontier: each incomplete node becomes an independent root
   * (dependsOn=[]), immediately `ready`, and is driven to re-execute. Already-
   * terminal nodes (completed/skipped/failed) are excluded from the reconstructed
   * graph, so they are provably not re-run (DoS bound — resume work is the
   * unfinished frontier, not the whole DAG).
   */
  async function resumeGraph(record: DurableRunRecord): Promise<Result<void, Error>> {
    // Cap/shape guard: a tampered or column-drifted record must not rehydrate.
    // parseDurableRunRecord permits the stepIndex=-1 never-sent
    // sentinel, so a legitimate not-yet-sent DAG checkpoint passes.
    const parsed = parseDurableRunRecord(record);
    if (!parsed.ok) {
      return err(new Error(`resumeGraph: record failed parse (cap/shape guard): ${parsed.error.message}`));
    }
    const validRecord = parsed.value;
    const rootRunId = validRecord.rootRunId;

    const toResume = incompleteNodes(validRecord.spawnTree as Array<{ nodeId: string; status: string }>);

    // Nothing incomplete ⇒ the graph already finished; flip it to completed so a
    // later boot scan skips it (markCompleted territory — no nodes to re-run).
    if (toResume.length === 0) {
      if (deps.durableRuns) {
        const res = await deps.durableRuns.markCompleted(rootRunId);
        if (!res.ok) return err(res.error);
      }
      deps.logger?.info(
        { rootRunId, hint: "DAG resume: no incomplete nodes — already complete" },
        "Graph durable resume: nothing to re-enter",
      );
      return ok(undefined);
    }

    // Reconstruct a reduced graph from the incomplete frontier (each node a
    // root). Parse a minimal raw input through ExecutionGraphSchema first to
    // apply node + graph-level defaults (retries=0 here so a re-run does not
    // re-multiply attempts), then topo-sort. validateAndSortGraph does NOT apply
    // defaults — it only sorts — so the parse step is required.
    const parsedGraph = ExecutionGraphSchema.safeParse({
      nodes: toResume.map((nodeId) => ({
        nodeId,
        task: `Resume graph node "${nodeId}" (rootRunId ${rootRunId}) after daemon restart`,
        dependsOn: [],
        retries: 0,
      })),
      onFailure: "continue",
    });
    if (!parsedGraph.success) {
      return err(new Error(`resumeGraph: could not build resume graph: ${parsedGraph.error.message}`));
    }
    const reducedGraph = validateAndSortGraph(parsedGraph.data);
    if (!reducedGraph.ok) {
      return err(new Error(`resumeGraph: could not sort resume graph: ${reducedGraph.error.message}`));
    }
    const validated: ValidatedGraph = reducedGraph.value;

    const graphId = randomUUID();
    const graphTraceId = randomUUID();
    const sharedDir = safePath(deps.dataDir, "graph-runs", graphId);
    mkdirSync(sharedDir, { recursive: true, mode: 0o700 });

    const stateMachine = createGraphStateMachine(validated);

    const gs: GraphRunState = {
      graphId,
      graphTraceId,
      rootRunId, // the tree-stable durable key — re-run nodes share it so the ONCE ledger dedups their outward sends
      graph: validated,
      stateMachine,
      runIdToNode: new Map(),
      nodeOutputs: new Map(),
      nodeTimers: new Map(),
      retryTimers: new Map(),
      graphTimer: undefined,
      startedAt: systemNowMs(),
      runningCount: 0,
      resolvedLanguage: tryGetContext()?.resolvedLanguage,
      nodeProgress: false,
      skippedNodesEmitted: new Set(),
      cumulativeTokens: 0,
      cumulativeCost: validRecord.budgetConsumed,
      sharedDir,
      driverStates: new Map(),
      driverRunIdMap: new Map(),
      waitHandlers: new Map(),
      syntheticRunResults: new Map(),
      nodeCacheData: new Map(),
      nodeTokenSpend: new Map(),
      nodeCost: new Map(),
      maxAnnouncementChars: config.maxAnnouncementChars,
    };

    state.graphs.set(graphId, gs);

    deps.logger?.info(
      { graphId, rootRunId, resumedNodeCount: toResume.length, totalNodeCount: validRecord.spawnTree.length },
      "Graph durable resume: re-entering incomplete nodes",
    );
    deps.eventBus.emit("graph:started", {
      graphId,
      label: validated.graph.label,
      nodeCount: validated.graph.nodes.length,
      timestamp: systemNowMs(),
    });

    // DRIVE the incomplete nodes: spawnReadyNodes → spawnNode →
    // subAgentRunner.spawn + markNodeRunning. The re-entered node actually
    // re-executes; it is NOT merely set ready.
    callbacks.spawnReadyNodes(gs);

    return ok(undefined);
  }

  return { run, getStatus, cancel, listGraphs, shutdown, getConcurrencyStats, notifyNodeFailed, resumeGraph };
}
