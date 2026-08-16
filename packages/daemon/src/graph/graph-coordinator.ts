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
  formatSessionKey,
  validateAndSortGraph,
  parseDurableRunRecord,
  ResolvedTurnScopeSchema,
  toSafeErrorLogString,
  createStableAnnouncementOperationId,
} from "@comis/core";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { ok, err, tryCatch, type Result } from "@comis/shared";
import {
  createDurableGraphCheckpoint,
  graphRunIdFromCheckpointRef,
  readDurableGraphCheckpoint,
  resolveGraphResumeTurnScope,
  snapshotToSpawnTree,
  validateGraphCheckpointSummary,
  writeDurableGraphCheckpoint,
} from "./graph-durable-checkpoint.js";
import { computeGraphToolSuperset } from "./graph-tool-superset.js";
import { preWarmGraphCache, type PreWarmSdk } from "./graph-prewarm.js";
import { getModel, completeSimple } from "@earendil-works/pi-ai/compat";
import { globalCompletionHandler, releaseAndDrainQueue, type GraphSubAgentCompletionEvent } from "./graph-concurrency.js";
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
import {
  cancelGraphRun,
  cancelGraphsByRootRunId,
} from "./graph-cancellation.js";
import { resolveGraphRunSnapshot, resolveGraphRunStatus } from "./graph-run-status.js";
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
  const announcementLifecycle = new AbortController();
  const pendingAnnouncementAdmissions = new Set<Promise<Result<boolean, Error>>>();
  async function reserveGraphAnnouncementProducerInternal(
    gs: GraphRunState,
  ): Promise<Result<boolean, Error>> {
    if (announcementLifecycle.signal.aborted) {
      return err(new Error("Graph coordinator is shutting down"));
    }
    const hasAnnouncementRoute = gs.announceChannelType !== undefined
      || gs.announceChannelId !== undefined;
    if (!hasAnnouncementRoute || !deps.announcementDeadLetterQueue) return ok(false);
    if (
      gs.announceChannelType === undefined
      || gs.announceChannelId === undefined
      || gs.callerAgentId === undefined
      || gs.callerSessionKey === undefined
      || gs.callerConversationLocator === undefined
      || gs.callerEndpoint === undefined
    ) {
      return err(new Error("Graph announcement producer identity is incomplete"));
    }
    const operationId = createStableAnnouncementOperationId(
      gs.callerAgentId,
      gs.callerSessionKey,
      gs.graphId,
    );
    const reserved = await deps.announcementDeadLetterQueue.reserveProducer({
      idempotencyKey: operationId,
      agentId: gs.callerAgentId,
      runId: gs.graphId,
      sessionKey: gs.callerSessionKey,
      announcementText: "A graph finished, but its completion notification was interrupted before delivery ownership transferred.",
      channelType: gs.announceChannelType,
      channelId: gs.announceChannelId,
      failedAt: systemNowMs(),
      rootRunId: gs.rootRunId ?? `announcement:${gs.callerSessionKey}`,
      deliveryAuthority: {
        tenantId: gs.callerConversationLocator.conversationScope.tenantId,
        agentId: gs.callerAgentId,
        conversationRef: gs.callerConversationLocator.conversationRef,
      },
      destinationEndpoint: gs.callerEndpoint,
      completionKeys: [operationId, gs.graphId],
      retirementKeys: [gs.graphId],
      ...(gs.callerEndpoint.threadId ? { threadId: gs.callerEndpoint.threadId } : {}),
    }, announcementLifecycle.signal);
    if (!reserved.ok) {
      return announcementLifecycle.signal.aborted
        ? err(new Error("Graph coordinator is shutting down"))
        : reserved;
    }
    if (announcementLifecycle.signal.aborted) {
      await deps.announcementDeadLetterQueue.cancelProducer(gs.graphId);
      return err(new Error("Graph coordinator is shutting down"));
    }
    const retirement = await deps.announcementDeadLetterQueue
      .prepareTerminalDecisionRetirement([gs.graphId], {
        kind: "graph",
        tenantId: deps.tenantId,
        graphId: gs.graphId,
      });
    if (!retirement.ok || announcementLifecycle.signal.aborted) {
      await deps.announcementDeadLetterQueue.cancelProducer(gs.graphId);
      return announcementLifecycle.signal.aborted
        ? err(new Error("Graph coordinator is shutting down"))
        : retirement;
    }
    gs.announcementProducerReserved = true;
    return ok(true);
  }
  async function reserveGraphAnnouncementProducer(
    gs: GraphRunState,
  ): Promise<Result<boolean, Error>> {
    const admission = reserveGraphAnnouncementProducerInternal(gs);
    pendingAnnouncementAdmissions.add(admission);
    try {
      return await admission;
    } finally {
      pendingAnnouncementAdmissions.delete(admission);
    }
  }
  /** Persist node state before releasing work; terminal writes await notification delivery. */
  async function checkpointGraph(gs: GraphRunState): Promise<boolean> {
    if (
      !deps.durableRuns
      || gs.rootRunId === undefined
      || gs.callerAgentId === undefined
      || gs.callerConversationLocator === undefined
      || gs.callerPrincipalId === undefined
      || gs.callerEndpoint === undefined
    ) return true;
    const store = deps.durableRuns;
    const rootRunId = gs.rootRunId;
    const terminal = gs.stateMachine.isTerminal();
    const parsedTurnScope = ResolvedTurnScopeSchema.safeParse({
      conversation: gs.callerConversationLocator.conversationScope,
      principal: { principalId: gs.callerPrincipalId },
      endpoint: gs.callerEndpoint,
    });
    if (!parsedTurnScope.success) {
      deps.logger?.warn(
        {
          graphId: gs.graphId,
          rootRunId,
          hint: "Preserve the resolved caller endpoint when submitting the graph; durable authority was not advanced",
          errorKind: "validation" as const,
        },
        "Graph durable turn authority is incomplete",
      );
      return false;
    }
    const graphCheckpoint = createDurableGraphCheckpoint(gs, parsedTurnScope.data);
    const checkpointArtifact = writeDurableGraphCheckpoint(
      deps.dataDir,
      gs.graphId,
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
      checkpointId: gs.durableCheckpointId ?? gs.graphId,
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
      const completed = await store.terminalize(
        gs.durableCheckpointId ?? gs.graphId,
        "completed",
      );
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
      && gs.callerPrincipalId !== undefined
      && gs.callerEndpoint !== undefined;
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

    handleSubAgentCompleted: (gs: GraphRunState, event: GraphSubAgentCompletionEvent) => {
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

  function onSubAgentCompleted(event: GraphSubAgentCompletionEvent): void {
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
    if (announcementLifecycle.signal.aborted) {
      return err("Graph coordinator is shutting down");
    }
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
      ...(callerAuthorityValid && callerContext !== undefined
        ? { callerTraceId: callerContext.traceId }
        : {}),
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

    const announcementProducer = await reserveGraphAnnouncementProducer(gs);
    if (!announcementProducer.ok) return err(announcementProducer.error.message);
    if (announcementLifecycle.signal.aborted) {
      if (gs.announcementProducerReserved) {
        await deps.announcementDeadLetterQueue?.cancelProducer(graphId);
      }
      return err("Graph coordinator is shutting down");
    }

    const createdSharedDir = tryCatch(() => mkdirSync(sharedDir, { recursive: true, mode: 0o700 }));
    if (!createdSharedDir.ok) {
      if (gs.announcementProducerReserved) {
        await deps.announcementDeadLetterQueue?.cancelProducer(graphId);
      }
      return err("Graph shared directory could not be created");
    }
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
        if (gs.announcementProducerReserved) {
          await deps.announcementDeadLetterQueue?.cancelProducer(graphId);
        }
        return err("Graph could not establish durable authority");
      }
    }

    callbacks.spawnReadyNodes(gs);
    if (!(await awaitDurableTransitions(gs))) {
      discardGraphState(state, deps, gs, releaseDurableRetention);
      if (gs.announcementProducerReserved) {
        await deps.announcementDeadLetterQueue?.cancelProducer(graphId);
      }
      return err("Graph durable launch authority failed");
    }

    return ok(graphId);
  }

  function getStatus(graphId: string): GraphExecutionSnapshot | undefined {
    const gs = state.graphs.get(graphId);
    return gs ? resolveGraphRunSnapshot(gs) : undefined;
  }

  function cancel(graphId: string): {
    cancelled: boolean;
    killed: number;
  } {
    return cancelGraphRun(
      state,
      deps,
      graphId,
      callbacks.handleGraphCompletion,
    );
  }

  function cancelByRootRunId(rootRunId: string): {
    graphsCancelled: number;
    killed: number;
  } {
    return cancelGraphsByRootRunId(
      state,
      deps,
      rootRunId,
      callbacks.handleGraphCompletion,
    );
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
        status: resolveGraphRunStatus(gs.cancelReason, gs.stateMachine.getGraphStatus()),
        startedAt: gs.startedAt,
        completedAt: gs.completedAt,
      }));
  }

  async function shutdown(): Promise<void> {
    announcementLifecycle.abort();
    await Promise.all(pendingAnnouncementAdmissions);
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
    if (announcementLifecycle.signal.aborted) {
      return err(new Error("Graph coordinator is shutting down"));
    }
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
    const resumedTurnScope = resolveGraphResumeTurnScope(deps.dataDir, validRecord);
    if (!resumedTurnScope.ok) return resumedTurnScope;
    const callerSession = conversationScopeToSessionKey(
      resumedTurnScope.value.conversation,
    );
    if (!callerSession.ok) return err(callerSession.error);
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

    const graphId = durableArtifactGraphId.value;
    const graphTraceId = randomUUID();
    const sharedDir = safePath(
      deps.dataDir,
      "graph-runs",
      durableArtifactGraphId.value,
    );
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
      callerSessionKey: formatSessionKey(callerSession.value),
      ...(loaded.value.callerTraceId === undefined
        ? {}
        : { callerTraceId: loaded.value.callerTraceId }),
      callerConversationLocator: {
        conversationScope: resumedTurnScope.value.conversation,
        conversationRef: validRecord.conversationRef,
      },
      callerPrincipalId: resumedTurnScope.value.principal.principalId,
      callerEndpoint: resumedTurnScope.value.endpoint,
      rootRunId, // tree-stable durable key shared by recovered node attempts
      announceChannelType: validRecord.deliveryOrigin?.channelType
        ?? resumedTurnScope.value.endpoint.channelType,
      announceChannelId: validRecord.deliveryOrigin?.channelId
        ?? resumedTurnScope.value.endpoint.conversationId,
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
      durableCheckpointId: validRecord.checkpointId,
      driverStates: new Map(),
      driverRunIdMap: new Map(),
      waitHandlers: new Map(),
      syntheticRunResults: new Map(),
      nodeCacheData: new Map(loaded.value.nodeCacheData.map(({ nodeId, ...data }) => [nodeId, data])),
      nodeTokenSpend: new Map(loaded.value.nodeTokenSpend.map(({ nodeId, tokens }) => [nodeId, tokens])),
      nodeCost: new Map(loaded.value.nodeCost.map(({ nodeId, cost }) => [nodeId, cost])),
      maxAnnouncementChars: config.maxAnnouncementChars,
    };

    const announcementProducer = await reserveGraphAnnouncementProducer(gs);
    if (!announcementProducer.ok) return announcementProducer;
    if (announcementLifecycle.signal.aborted) {
      if (gs.announcementProducerReserved) {
        await deps.announcementDeadLetterQueue?.cancelProducer(graphId);
      }
      return err(new Error("Graph coordinator is shutting down"));
    }
    const createdSharedDir = tryCatch(() => mkdirSync(sharedDir, { recursive: true, mode: 0o700 }));
    if (!createdSharedDir.ok) {
      if (gs.announcementProducerReserved) {
        await deps.announcementDeadLetterQueue?.cancelProducer(graphId);
      }
      return err(new Error("resumeGraph: graph shared directory could not be created"));
    }

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
        if (gs.announcementProducerReserved) {
          await deps.announcementDeadLetterQueue?.cancelProducer(graphId);
        }
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
          if (gs.announcementProducerReserved) {
            await deps.announcementDeadLetterQueue?.cancelProducer(graphId);
          }
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
      if (gs.announcementProducerReserved) {
        await deps.announcementDeadLetterQueue?.cancelProducer(graphId);
      }
      return err(new Error("resumeGraph: durable launch authority failed"));
    }

    return ok(undefined);
  }

  return {
    run,
    getStatus,
    cancel,
    cancelByRootRunId,
    listGraphs,
    shutdown,
    getConcurrencyStats,
    notifyNodeFailed,
    resumeGraph,
  };
}
