// SPDX-License-Identifier: Apache-2.0
/**
 * Graph resume from a durable checkpoint.
 *
 * Rehydrates a graph run that outlived the process that started it. Every step
 * is a guard before it is a restore: the record is re-parsed against its cap
 * and shape, the topology is re-validated and compared against the stored
 * execution order, and the checkpoint summary is checked against the spawn
 * tree. A tampered or column-drifted record must not become a running graph,
 * so divergence returns an error rather than resuming on trust.
 *
 * Resume also re-reserves the announcement producer, and unwinds that
 * reservation on every abort path — a resumed graph that dies mid-rehydrate
 * must not leave a producer owning an announcement nothing will send.
 *
 * @module
 */
import { restoreGraphStateMachine } from "./graph-state-machine.js";
import {
  conversationScopeToSessionKey,
  formatSessionKey,
  parseDurableRunRecord,
  safePath,
  systemNowMs,
  systemSetTimeout,
  tryGetContext,
  validateAndSortGraph,
  type AnnouncementProducerReservationOutcome,
  type DurableRunRecord,
  type ValidatedGraph,
} from "@comis/core";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { ok, err, tryCatch, type Result } from "@comis/shared";
import {
  graphRunIdFromCheckpointRef,
  readDurableGraphCheckpoint,
  resolveGraphResumeTurnScope,
  validateGraphCheckpointSummary,
} from "./graph-durable-checkpoint.js";
import { discardGraphState } from "./graph-cleanup.js";
import type {
  CoordinatorConfig,
  CoordinatorSharedState,
  GraphCoordinatorDeps,
  GraphRunState,
} from "./graph-coordinator-state.js";

/** Coordinator internals the resume path needs to drive. */
export interface GraphResumeContext {
  deps: GraphCoordinatorDeps;
  config: CoordinatorConfig;
  state: CoordinatorSharedState;
  announcementLifecycle: AbortController;
  checkpointGraph: (gs: GraphRunState) => Promise<boolean>;
  releaseDurableRetention: (gs: GraphRunState) => void;
  cancelGraphAnnouncementProducer: (graphId: string) => Promise<Result<void, Error>>;
  reserveGraphAnnouncementProducer: (
    gs: GraphRunState,
    reclaimActive?: boolean,
  ) => Promise<Result<AnnouncementProducerReservationOutcome | { status: "not_required" }, Error>>;
  /** Waits for the graph's pending durable writes; false means none landed. */
  awaitDurableTransitions: (gs: GraphRunState) => Promise<boolean>;
  callbacks: {
    spawnReadyNodes: (gs: GraphRunState) => void;
    handleGraphTimeout: (gs: GraphRunState) => void;
  };
}

export function createResumeGraph(ctx: GraphResumeContext): (
  record: DurableRunRecord,
  authority?: { leaseId: string; bearer: string },
) => Promise<Result<void, Error>> {
  const {
    deps,
    config,
    state,
    announcementLifecycle,
    checkpointGraph,
    releaseDurableRetention,
    cancelGraphAnnouncementProducer,
    reserveGraphAnnouncementProducer,
    awaitDurableTransitions,
    callbacks,
  } = ctx;
  return async function resumeGraph(
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

    const announcementProducer = await reserveGraphAnnouncementProducer(gs, true);
    if (!announcementProducer.ok) return announcementProducer;
    if (announcementProducer.value.status === "recovery_owned") {
      if (!deps.durableRuns) {
        return err(new Error("Graph recovery-owned completion lacks durable run authority"));
      }
      const terminalized = await deps.durableRuns.terminalize(
        validRecord.checkpointId,
        "completed",
      );
      return terminalized.ok ? ok(undefined) : terminalized;
    }
    if (announcementLifecycle.signal.aborted) {
      if (gs.announcementProducerReserved) {
        const cancelled = await cancelGraphAnnouncementProducer(graphId);
        if (!cancelled.ok) return cancelled;
      }
      return err(new Error("Graph coordinator is shutting down"));
    }
    const createdSharedDir = tryCatch(() => mkdirSync(sharedDir, { recursive: true, mode: 0o700 }));
    if (!createdSharedDir.ok) {
      if (gs.announcementProducerReserved) {
        const cancelled = await cancelGraphAnnouncementProducer(graphId);
        if (!cancelled.ok) return cancelled;
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
          const cancelled = await cancelGraphAnnouncementProducer(graphId);
          if (!cancelled.ok) return cancelled;
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
            const cancelled = await cancelGraphAnnouncementProducer(graphId);
            if (!cancelled.ok) return cancelled;
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
        const cancelled = await cancelGraphAnnouncementProducer(graphId);
        if (!cancelled.ok) return cancelled;
      }
      return err(new Error("resumeGraph: durable launch authority failed"));
    }

    return ok(undefined);
  }
}
