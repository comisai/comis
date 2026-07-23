// SPDX-License-Identifier: Apache-2.0
/** Composition layer for durable DAG execution and terminal delivery. */

import {
  createGraphStateMachine,
  restoreGraphStateMachine,
  type GraphExecutionSnapshot,
} from "./graph-state-machine.js";
import {
  safePath,
  type ValidatedGraph,
  type DurableRunRecord,
  systemNowMs,
  systemSetInterval,
  systemClearInterval,
  systemSetTimeout,
  tryGetContext,
  createConversationRef,
  conversationScopeToSessionKey,
  validateAndSortGraph,
  parseDurableRunRecord,
  toSafeErrorLogString,
} from "@comis/core";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { ok, err, type Result } from "@comis/shared";
import {
  createDurableGraphCheckpoint,
  graphRunIdFromCheckpointRef,
  readDurableGraphCheckpoint,
  snapshotToSpawnTree,
  validateGraphCheckpointSummary,
  writeDurableGraphCheckpoint,
} from "./graph-durable-checkpoint.js";
import { computeGraphToolSuperset } from "./graph-tool-superset.js";
import { preWarmGraphCache, type PreWarmSdk } from "./graph-prewarm.js";
import { getModel, completeSimple } from "@earendil-works/pi-ai/compat";

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
import { clearAllTimers, discardGraphState, sweepExpiredGraphs } from "./graph-cleanup.js";
import { computeGraphTimeoutFloorMs } from "./graph-timeout-floor.js";
import { createGraphDurableTransitions } from "./graph-durable-transitions.js";
import { createGraphCompletionTracker } from "./graph-completion-tracker.js";
export type { GraphCoordinatorDeps, GraphRunState, CoordinatorSharedState, CoordinatorConfig } from "./graph-coordinator-state.js";
import type {
  CoordinatorSharedState,
  GraphCoordinatorDeps,
  GraphRunState,
  CoordinatorConfig,
} from "./graph-coordinator-state.js";
import type {
  GraphCoordinator,
  GraphRunParams,
  GraphRunSummary,
} from "./graph-coordinator-contract.js";
export type {
  GraphCoordinator,
  GraphRunParams,
  GraphRunSummary,
} from "./graph-coordinator-contract.js";

/** Create a graph coordinator that executes validated graphs end-to-end. */
export function createGraphCoordinator(deps: GraphCoordinatorDeps): GraphCoordinator {
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

  const state: CoordinatorSharedState = {
    graphs: new Map(),
    globalActiveSubAgents: 0,
    spawnQueue: [],
  };
  const graphCompletions = createGraphCompletionTracker(
    (gs) => handleGraphCompletionFn(state, deps, gs), deps.logger,
  );

  /** Persist node state before releasing work; terminal writes await notification delivery. */
  async function checkpointGraph(gs: GraphRunState): Promise<boolean> {
    if (
      !deps.durableRuns
      || gs.rootRunId === undefined
      || gs.callerAgentId === undefined
      || gs.callerConversationLocator === undefined
      || gs.callerPrincipalId === undefined
    ) return true;
    const store = deps.durableRuns;
    const rootRunId = gs.rootRunId;
    const terminal = gs.stateMachine.isTerminal();
    const graphCheckpoint = createDurableGraphCheckpoint(gs);
    const checkpointArtifact = writeDurableGraphCheckpoint(
      deps.dataDir,
      gs.durableArtifactGraphId ?? gs.graphId,
      graphCheckpoint,
    );
    if (!checkpointArtifact.ok) {
      deps.logger?.warn(
        {
          graphId: gs.graphId,
          rootRunId,
          err: toSafeErrorLogString(checkpointArtifact.error),
          hint: "Verify the graph-runs directory is writable; the authority row was not advanced",
          errorKind: "resource" as const,
        },
        "Graph durable checkpoint artifact write failed",
      );
      return false;
    }
    const rootBudget = deps.durableBudgetState?.(rootRunId) ?? {
      startedAtMs: gs.startedAt,
      tokensConsumed: gs.cumulativeTokens,
      usdConsumed: gs.cumulativeCost,
    };
    // Source the run context the same way the flat-run checkpoint path does. The
    // graph run carries no per-node lease/caps record here (those are minted per
    // node), so the checkpoint persists the node-completion snapshot + the stable
    // root; the caps/leaseIds the resumed run rehydrates come from the run record
    // the outward-send path already wrote. Outward sequencing belongs to the
    // separate ledger, so this checkpoint upsert never touches it.
    const record: DurableRunRecord = {
      checkpointId: gs.graphId,
      rootRunId,
      tenantId: gs.callerConversationLocator.conversationScope.tenantId,
      agentId: gs.callerAgentId,
      conversationRef: gs.callerConversationLocator.conversationRef,
      conversationScope: gs.callerConversationLocator.conversationScope,
      principalId: gs.callerPrincipalId,
      deliveryOrigin: gs.callerDeliveryOrigin ?? null,
      spawnTree: snapshotToSpawnTree(gs.stateMachine.snapshot()),
      caps: [...gs.callerCaps],
      leaseIds: [],
      budgetConsumed: rootBudget.usdConsumed,
      rootBudget,
      cronOrigin: null,
      trustLevel: gs.callerTrustLevel,
      status: "running",
      lastHeartbeatAt: systemNowMs(),
      scriptRef: null,
      checkpointRef: checkpointArtifact.value,
      ...(gs.workspacePolicyHash === undefined
        ? {}
        : { workspacePolicyHash: gs.workspacePolicyHash }),
    };
    const persisted = await store.upsertCheckpoint(record);
    if (!persisted.ok) {
      deps.logger?.warn(
        { graphId: gs.graphId, rootRunId, err: toSafeErrorLogString(persisted.error), hint: "Repair the durable authority store; dependent graph work remains parked", errorKind: "resource" as const },
        "Graph durable checkpoint failed",
      );
      return false;
    }
    if (terminal) {
      const completion = await graphCompletions.run(gs);
      if (!completion.ok) return false;
      const completed = await store.terminalize(gs.graphId, "completed");
      if (!completed.ok) {
        deps.logger?.warn(
          { graphId: gs.graphId, rootRunId, err: toSafeErrorLogString(completed.error), hint: "Repair the durable authority store; graph completion remains parked and resumable", errorKind: "resource" as const },
          "Graph durable terminalize failed",
        );
        return false;
      }
      releaseDurableRetention(gs);
    }
    return true;
  }

  function requiresDurableBoundary(gs: GraphRunState): boolean {
    return deps.durableRuns !== undefined
      && gs.rootRunId !== undefined
      && gs.callerAgentId !== undefined
      && gs.callerConversationLocator !== undefined
      && gs.callerPrincipalId !== undefined;
  }

  function releaseDurableRetention(gs: GraphRunState): void {
    if (gs.rootRunId === undefined || gs.durableRetentionReleased === true) return;
    gs.durableRetentionReleased = true;
    deps.releaseDurableRoot?.(gs.rootRunId);
  }
  const durableTransitions = createGraphDurableTransitions({
    requiresBoundary: requiresDurableBoundary,
    checkpoint: checkpointGraph,
    logger: deps.logger,
  });
  const runDurableTransition = durableTransitions.run;
  const persistThen = durableTransitions.persistThen;
  const awaitDurableTransitions = durableTransitions.awaitGraph;

  function completeAfterPersistence(
    gs: GraphRunState,
    afterPersistence: (action: () => void) => void,
  ): void {
    if (!requiresDurableBoundary(gs)) {
      afterPersistence(() => {
        void graphCompletions.run(gs);
      });
    }
  }

  // Continuations release only after crossing the durable authority boundary.
  const callbacks = {
    spawnReadyNodes: (gs: GraphRunState) =>
      spawnReadyNodesFn(state, deps, config, gs, {
        spawnNode: (gs2: GraphRunState, nodeId: string) =>
          callbacks.spawnNode(gs2, nodeId),
      }),

    spawnNode: (gs: GraphRunState, nodeId: string) => {
      spawnNodeFn(state, deps, config, gs, nodeId, {
        markNodeFailed: (gs2, nid, error) => callbacks.markNodeFailed(gs2, nid, error),
        admitRegularNode: (gs2, _nid, launch) => {
          const reservedRunId = randomUUID();
          void runDurableTransition(gs2, (afterPersistence) => {
            if (!launch.reserve(reservedRunId)) {
              launch.cancel();
              return;
            }
            afterPersistence(() => launch.start(reservedRunId));
          }).then((succeeded) => {
            if (!succeeded) launch.cancel(reservedRunId);
          });
        },
        startDriverNode: (gs2, nid, node, driver, task) => {
          void runDurableTransition(gs2, (afterPersistence) => {
            startDriverNodeFn(state, deps, gs2, nid, node, driver, task, {
              markNodeFailed: (gs3, nid2, error) => callbacks.markNodeFailed(gs3, nid2, error),
              executeDriverAction: (gs3, nid2, action) =>
                afterPersistence(() => executeDriverActionFn(state, deps, config, gs3, nid2, action, driverCallbacks)),
              handleDriverTimeout: (gs3, nid2) =>
                handleDriverTimeoutFn(state, deps, config, gs3, nid2, driverCallbacks),
            });
          });
        },
        spawnReadyNodes: (gs2) => callbacks.spawnReadyNodes(gs2),
      });
    },

    markNodeFailed: (gs: GraphRunState, nodeId: string, error: string) => {
      runDurableTransition(gs, (afterPersistence) => {
        markNodeFailedFn(state, deps, gs, nodeId, error, {
          spawnReadyNodes: (gs2) => afterPersistence(() => callbacks.spawnReadyNodes(gs2)),
          handleGraphCompletion: (gs2) => completeAfterPersistence(gs2, afterPersistence),
        });
      });
    },

    handleGraphCompletion: (gs: GraphRunState) => {
      void runDurableTransition(gs, (afterPersistence) => {
        completeAfterPersistence(gs, afterPersistence);
      });
    },

    handleBudgetExceeded: (gs: GraphRunState, reason: string) => {
      runDurableTransition(gs, (afterPersistence) => {
        handleBudgetExceededFn(
          state,
          deps,
          gs,
          reason,
          () => completeAfterPersistence(gs, afterPersistence),
        );
      });
    },

    handleGraphTimeout: (gs: GraphRunState) => {
      runDurableTransition(gs, (afterPersistence) => {
        handleGraphTimeoutFn(
          state,
          deps,
          gs,
          () => completeAfterPersistence(gs, afterPersistence),
        );
      });
    },

    handleSubAgentCompleted: (gs: GraphRunState, event: { runId: string; success: boolean; tokensUsed?: number; cost?: number; cacheReadTokens?: number; cacheWriteTokens?: number }) => {
      runDurableTransition(gs, (afterPersistence) => {
        handleSubAgentCompletedFn(state, deps, config, gs, event, {
          spawnReadyNodes: (gs2) => afterPersistence(() => callbacks.spawnReadyNodes(gs2)),
          handleGraphCompletion: (gs2) => completeAfterPersistence(gs2, afterPersistence),
          handleBudgetExceeded: (gs2, reason) => afterPersistence(() => callbacks.handleBudgetExceeded(gs2, reason)),
        });
      });
    },
  };

  const driverCallbacks = {
    markNodeFailed: (gs: GraphRunState, nodeId: string, error: string) =>
      callbacks.markNodeFailed(gs, nodeId, error),
    handleBudgetExceeded: (gs: GraphRunState, reason: string) =>
      callbacks.handleBudgetExceeded(gs, reason),
    spawnReadyNodes: (gs: GraphRunState) =>
      persistThen(gs, () => callbacks.spawnReadyNodes(gs)),
    handleGraphCompletion: (gs: GraphRunState) =>
      callbacks.handleGraphCompletion(gs),
  };

  function onSubAgentCompleted(event: { runId: string; success: boolean; tokensUsed?: number; cost?: number; cacheReadTokens?: number; cacheWriteTokens?: number }): void {
    globalCompletionHandler(state, config, event, {
      handleDriverTurnCompleted: (gs, nodeId, evt) =>
        handleDriverTurnCompletedFn(state, deps, config, gs, nodeId, evt, driverCallbacks),
      handleSubAgentCompleted: (gs, evt) =>
        callbacks.handleSubAgentCompleted(gs, evt),
    });
  }

  deps.eventBus.on("session:sub_agent_completed", onSubAgentCompleted);

  const sweepInterval = systemSetInterval(() => {
    sweepExpiredGraphs(state, config);
    const activeGraphIds = new Set(state.graphs.keys());
    durableTransitions.prune(activeGraphIds);
    graphCompletions.prune(activeGraphIds);
  }, config.sweepIntervalMs);
  sweepInterval.unref();

  async function run(params: GraphRunParams): Promise<Result<string, string>> {
    const callerContext = tryGetContext();
    if (
      callerContext !== undefined
      && params.callerAgentId !== undefined
      && callerContext.agentId !== params.callerAgentId
    ) {
      deps.logger?.warn({
        method: "graph.run",
        mismatchField: "agent",
        hint: "Reject the graph and verify the in-process RPC injector preserves the active request principal",
        errorKind: "precondition" as const,
      }, "Graph caller context mismatch");
      return err("Graph caller agent does not match the request context");
    }
    if (
      callerContext !== undefined
      && params.callerSessionKey !== undefined
      && callerContext.sessionKey !== params.callerSessionKey
    ) {
      deps.logger?.warn({
        method: "graph.run",
        mismatchField: "session",
        hint: "Reject the graph and verify the in-process RPC injector preserves the active request principal",
        errorKind: "precondition" as const,
      }, "Graph caller context mismatch");
      return err("Graph caller session does not match the request context");
    }
    const declaredTurnScope = params.callerTurnScope;
    if (
      callerContext?.turnScope !== undefined
      && declaredTurnScope !== undefined
      && (
        callerContext.turnScope.conversation.tenantId !== declaredTurnScope.conversation.tenantId
        || callerContext.turnScope.conversation.agentId !== declaredTurnScope.conversation.agentId
        || callerContext.turnScope.principal.principalId !== declaredTurnScope.principal.principalId
        || callerContext.turnScope.endpoint.channelType !== declaredTurnScope.endpoint.channelType
        || callerContext.turnScope.endpoint.channelInstanceId !== declaredTurnScope.endpoint.channelInstanceId
        || callerContext.turnScope.endpoint.conversationId !== declaredTurnScope.endpoint.conversationId
        || callerContext.turnScope.endpoint.threadId !== declaredTurnScope.endpoint.threadId
        || callerContext.turnScope.endpoint.conversationKind !== declaredTurnScope.endpoint.conversationKind
      )
    ) {
      deps.logger?.warn({
        method: "graph.run",
        mismatchField: "turn-scope",
        hint: "Reject the graph and verify the RPC injector preserves canonical conversation authority",
        errorKind: "precondition" as const,
      }, "Graph caller context mismatch");
      return err("Graph caller turn scope does not match the request context");
    }
    const callerAuthorityValid = declaredTurnScope !== undefined
      && params.callerAgentId !== undefined
      && params.callerSessionKey !== undefined
      && declaredTurnScope.conversation.agentId === params.callerAgentId
      && (callerContext === undefined || (
        callerContext.agentId === params.callerAgentId
        && callerContext.sessionKey === params.callerSessionKey
      ));
    const callerTurnScope = callerAuthorityValid ? declaredTurnScope : undefined;
    const callerConversationRef = callerTurnScope === undefined
      ? undefined
      : createConversationRef(callerTurnScope.conversation);
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

    // Every node shares one tree-stable root for budget and kill authority.
    const graphParentRun = params.callerSessionKey
      ? deps.subAgentRunner.getRunBySessionKey?.(params.callerSessionKey)
      : undefined;
    const projectedCallerSession = callerTurnScope === undefined
      ? undefined
      : conversationScopeToSessionKey(callerTurnScope.conversation);
    const graphRootResolution = callerAuthorityValid
      ? params.callerRootRunId
        ?? graphParentRun?.rootRunId
        ?? (
          projectedCallerSession?.ok === true && params.callerAgentId
            ? deps.resolveRootRunId?.(params.callerAgentId, projectedCallerSession.value)
            : undefined
        )
      : undefined;
    if (typeof graphRootResolution !== "string" && graphRootResolution !== undefined && !graphRootResolution.ok) {
      deps.logger?.warn({
        agentId: params.callerAgentId,
        mismatchField: "root-run",
        hint: "Reject the graph and preserve the authenticated caller root through submission",
        errorKind: graphRootResolution.error.errorKind,
      }, "Graph caller root context mismatch");
      return err("Graph caller root does not match the request context");
    }
    const graphRootRunId = typeof graphRootResolution === "string"
      ? graphRootResolution
      : graphRootResolution?.value;

    const gs: GraphRunState = {
      graphId,
      graphTraceId,
      // Capture once at submission. Dependent/queued nodes may start under a
      // child completion callback, so consulting ambient ALS later would read
      // the wrong principal. Only an exact declared caller match can carry
      // authorization or request annotations into the graph.
      callerTrustLevel: callerAuthorityValid && callerContext !== undefined ? callerContext.trustLevel : "guest",
      callerCaps: callerAuthorityValid ? [...(params.callerCaps ?? [])] : [],
      ...(callerAuthorityValid && params.callerLeaseId !== undefined
        ? { parentLeaseId: params.callerLeaseId }
        : {}),
      ...(callerAuthorityValid && params.callerDeliveryOrigin !== undefined
        ? { callerDeliveryOrigin: params.callerDeliveryOrigin }
        : {}),
      ...(callerAuthorityValid && callerContext?.workspacePolicyHash !== undefined
        ? { workspacePolicyHash: callerContext.workspacePolicyHash }
        : {}),
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
      ...(callerConversationRef?.ok === true && callerTurnScope !== undefined
        ? {
            callerConversationLocator: {
              conversationScope: callerTurnScope.conversation,
              conversationRef: callerConversationRef.value,
            },
            callerPrincipalId: callerTurnScope.principal.principalId,
            callerEndpoint: callerTurnScope.endpoint,
          }
        : {}),
      // Graph submission carries no inbound NormalizedMessage, so resolve
      // the reply language once from the caller's RequestContext.resolvedLanguage — set by the
      // parent executor — and thread it to every node envelope via buildContextEnvelope.
      resolvedLanguage: callerAuthorityValid ? callerContext?.resolvedLanguage : undefined,
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

    // Pre-warm awaits the graph-wide tool names and full definitions.
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

    // Raise only configured timeouts to the critical-path makespan; never invent one.
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
      gs.graphTimer = systemSetTimeout(() => callbacks.handleGraphTimeout(gs), effectiveGraphTimeoutMs);
      if (typeof gs.graphTimer === "object" && "unref" in gs.graphTimer) {
        gs.graphTimer.unref();
      }
    }

    if (deps.preWarm && gs.toolSupersetPromise) {
      const toolNames = await gs.toolSupersetPromise;
      if (toolNames.length > 0) {
        const sdk: PreWarmSdk = {
          getModel: getModel as PreWarmSdk["getModel"],
          completeSimple: completeSimple as PreWarmSdk["completeSimple"],
        };
        // Full definitions preserve the exact cache prefix used by sub-agents.
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

    if (
      deps.durableRuns !== undefined
      && gs.rootRunId !== undefined
      && gs.callerSessionKey !== undefined
      && gs.callerAgentId !== undefined
    ) {
      deps.retainDurableRoot?.(gs.rootRunId);
      const initialCheckpoint = await checkpointGraph(gs);
      if (!initialCheckpoint) {
        releaseDurableRetention(gs);
        state.graphs.delete(graphId);
        clearAllTimers(deps, gs);
        return err("Graph could not establish durable authority");
      }
    }

    callbacks.spawnReadyNodes(gs);
    if (!(await awaitDurableTransitions(gs))) {
      discardGraphState(state, deps, gs, releaseDurableRetention);
      return err("Graph durable launch authority failed");
    }

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

    // Stop every queued/in-flight durable transition from releasing a new
    // continuation, then wait for authority writes already in progress. Clearing
    // the tails before they settle could let a post-checkpoint runner launch race
    // with teardown and could drop the write itself on process exit.
    await durableTransitions.blockAllAndDrain(state.graphs.keys());
    await graphCompletions.drain();

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
      releaseDurableRetention(gs);
    }

    // Clear spawn queue and reset global counter
    state.spawnQueue.length = 0;
    state.globalActiveSubAgents = 0;
    durableTransitions.clear();
    graphCompletions.clear();

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
   * re-run; outward uncertainty remains governed by the durable send ledger.
   *
   * The authority row contains only routing metadata; `checkpointRef` points to
   * the protected exact-graph artifact. Resume refuses any missing, malformed,
   * or summary-divergent pair rather than fabricating work.
   */
  async function resumeGraph(
    record: DurableRunRecord,
    authority?: { leaseId: string; bearer: string },
  ): Promise<Result<void, Error>> {
    // Cap/shape guard: a tampered or column-drifted record must not rehydrate.
    const parsed = parseDurableRunRecord(record);
    if (!parsed.ok) {
      return err(new Error(`resumeGraph: record failed parse (cap/shape guard): ${parsed.error.message}`));
    }
    const validRecord = parsed.value;
    const rootRunId = validRecord.rootRunId;
    const checkpointRef = validRecord.checkpointRef;
    if (checkpointRef === null) {
      return err(new Error("resumeGraph: protected graph checkpoint reference is missing"));
    }
    const loaded = readDurableGraphCheckpoint(deps.dataDir, checkpointRef);
    if (!loaded.ok) return err(loaded.error);
    const durableArtifactGraphId = graphRunIdFromCheckpointRef(checkpointRef);
    if (!durableArtifactGraphId.ok) return durableArtifactGraphId;
    const spawnTree = validRecord.spawnTree as Array<{
      nodeId: string;
      status: import("@comis/core").NodeStatus;
      runId?: string;
    }>;
    const summary = validateGraphCheckpointSummary(spawnTree, loaded.value);
    if (!summary.ok) return summary;
    const validatedResult = validateAndSortGraph(loaded.value.graph);
    if (!validatedResult.ok) {
      return err(new Error("resumeGraph: protected graph topology validation failed"));
    }
    const validated: ValidatedGraph = validatedResult.value;
    if (
      validated.executionOrder.length !== loaded.value.executionOrder.length
      || validated.executionOrder.some((nodeId, index) => nodeId !== loaded.value.executionOrder[index])
    ) {
      return err(new Error("resumeGraph: protected graph execution order diverges from topology"));
    }
    const restored = restoreGraphStateMachine(validated, loaded.value.nodes);
    if (!restored.ok) return err(new Error(`resumeGraph: ${restored.error}`));

    const graphId = validRecord.checkpointId;
    const graphTraceId = randomUUID();
    const sharedDir = safePath(
      deps.dataDir,
      "graph-runs",
      durableArtifactGraphId.value,
    );
    mkdirSync(sharedDir, { recursive: true, mode: 0o700 });

    const stateMachine = restored.value;

    const gs: GraphRunState = {
      graphId,
      graphTraceId,
      callerTrustLevel: validRecord.trustLevel,
      callerCaps: [...validRecord.caps],
      ...(authority !== undefined ? { parentLeaseId: authority.leaseId } : {}),
      ...(validRecord.deliveryOrigin !== null
        ? { callerDeliveryOrigin: validRecord.deliveryOrigin }
        : {}),
      ...(validRecord.workspacePolicyHash === undefined
        ? {}
        : { workspacePolicyHash: validRecord.workspacePolicyHash }),
      callerAgentId: validRecord.agentId,
      callerConversationLocator: {
        conversationScope: validRecord.conversationScope,
        conversationRef: validRecord.conversationRef,
      },
      callerPrincipalId: validRecord.principalId,
      ...(() => {
        const partition = validRecord.conversationScope.partition;
        return partition.kind === "endpoint-conversation"
          || partition.kind === "endpoint-conversation-principal"
          ? { callerEndpoint: partition.endpoint }
          : {};
      })(),
      rootRunId, // tree-stable durable key shared by recovered node attempts
      ...(validRecord.deliveryOrigin !== null
        ? {
            announceChannelType: validRecord.deliveryOrigin.channelType,
            announceChannelId: validRecord.deliveryOrigin.channelId,
          }
        : {}),
      graph: validated,
      stateMachine,
      runIdToNode: new Map(),
      nodeOutputs: new Map(loaded.value.nodes.map((node) => [node.nodeId, node.output])),
      nodeTimers: new Map(),
      retryTimers: new Map(),
      graphTimer: undefined,
      startedAt: loaded.value.startedAtMs,
      runningCount: 0,
      resolvedLanguage: tryGetContext()?.resolvedLanguage,
      nodeProgress: false,
      skippedNodesEmitted: new Set(loaded.value.skippedNodesEmitted),
      cumulativeTokens: loaded.value.cumulativeTokens,
      cumulativeCost: loaded.value.cumulativeCost,
      sharedDir,
      durableArtifactGraphId: durableArtifactGraphId.value,
      driverStates: new Map(),
      driverRunIdMap: new Map(),
      waitHandlers: new Map(),
      syntheticRunResults: new Map(),
      nodeCacheData: new Map(loaded.value.nodeCacheData.map(({ nodeId, ...data }) => [nodeId, data])),
      nodeTokenSpend: new Map(loaded.value.nodeTokenSpend.map(({ nodeId, tokens }) => [nodeId, tokens])),
      nodeCost: new Map(loaded.value.nodeCost.map(({ nodeId, cost }) => [nodeId, cost])),
      maxAnnouncementChars: config.maxAnnouncementChars,
    };

    state.graphs.set(graphId, gs);
    deps.retainDurableRoot?.(rootRunId);

    deps.logger?.info(
      {
        graphId,
        rootRunId,
        resumedNodeCount: stateMachine.getReadyNodes().length,
        totalNodeCount: validated.graph.nodes.length,
      },
      "Graph durable resume: re-entering incomplete nodes",
    );
    deps.eventBus.emit("graph:started", {
      graphId,
      label: validated.graph.label,
      nodeCount: validated.graph.nodes.length,
      timestamp: systemNowMs(),
    });

    if (stateMachine.isTerminal()) {
      const completed = await checkpointGraph(gs);
      if (!completed) {
        discardGraphState(state, deps, gs, releaseDurableRetention);
        return err(new Error("resumeGraph: terminal authority could not be persisted"));
      }
      return ok(undefined);
    }

    const timeoutMs = validated.graph.timeoutMs ?? 0;
    if (timeoutMs > 0) {
      const remainingMs = timeoutMs - (systemNowMs() - loaded.value.startedAtMs);
      if (remainingMs <= 0) {
        callbacks.handleGraphTimeout(gs);
        if (!(await awaitDurableTransitions(gs))) {
          discardGraphState(state, deps, gs, releaseDurableRetention);
          return err(new Error("resumeGraph: timeout authority could not be persisted"));
        }
        return ok(undefined);
      }
      gs.graphTimer = systemSetTimeout(
        () => callbacks.handleGraphTimeout(gs),
        remainingMs,
      );
      if (typeof gs.graphTimer === "object" && "unref" in gs.graphTimer) {
        gs.graphTimer.unref();
      }
    }

    // DRIVE only persisted ready nodes. Restored pending nodes keep their exact
    // barriers; completed/skipped/failed nodes retain their terminal state.
    callbacks.spawnReadyNodes(gs);
    if (!(await awaitDurableTransitions(gs))) {
      discardGraphState(state, deps, gs, releaseDurableRetention);
      return err(new Error("resumeGraph: durable launch authority failed"));
    }

    return ok(undefined);
  }

  return { run, getStatus, cancel, listGraphs, shutdown, getConcurrencyStats, notifyNodeFailed, resumeGraph };
}
