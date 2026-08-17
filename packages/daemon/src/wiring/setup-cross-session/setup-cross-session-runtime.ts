// SPDX-License-Identifier: Apache-2.0
/**
 * Cross-session messaging composition root.
 *
 * Hosts the `setupCrossSession` orchestrator + `CrossSessionResult` type +
 * the cross-session sender / announcement batcher / dead-letter queue /
 * result condenser / narrative caster / lifecycle hooks / sub-agent runner
 * construction. Delegates graph-execution wiring to
 * ./setup-cross-session-graph.js (buildExecuteSubAgent) and proxy typing
 * event listeners to ./setup-cross-session-events.js
 * (registerProxyTypingListeners).
 *
 * @module
 */
import type {
  AgentCapability, AgentConfig, AppContainer, ChannelPort, ClockPort,
  DeliveryService, DeliverToChannelOptions, DurableRunPort,
  FileLockPort, NormalizedMessage, OutwardSendLedgerPort,
  SessionKey, TimerPort, SessionStorePort, ConversationLocator, ConversationRef,
  MemoryWriteEntry, MemoryWriteScope, CitationEvidence, AnnouncementRetirementProducer,
  AnnouncementRetirementProducerState,
} from "@comis/core";
import {
  createConversationRef, createResolvedRequestContext,
  resolveWorkspaceDir, runWithContext, safePath, systemNowMs, tryGetContext,
} from "@comis/core";
import { createResultRefStore } from "@comis/skills/tools";
import type { ComisLogger } from "@comis/infra";
import type { ExecutionResult, SpawnCeilingDecision } from "@comis/agent";
import { createResultCondenser, createNarrativeCaster, createLifecycleHooks, resolveOperationModel, resolveProviderFamily, createSubAgentRunner, createDeliveryDedup, resolvePostureFromSkills } from "@comis/agent";
import {
  createCrossSessionSender,
  createAnnouncementBatcher,
  createAnnouncementDeadLetterQueue,
  isAnnouncementProducerRecoveryOutcome,
  type SendGovernedCompletionAnnouncement,
  type SendRecoverableCompletionAnnouncement,
} from "@comis/orchestrator";
import { randomUUID } from "node:crypto";
import { err, ok, type Result } from "@comis/shared";
import { buildExecuteSubAgent } from "./setup-cross-session-graph.js";
import { registerProxyTypingListeners } from "./setup-cross-session-events.js";
import { createAnnouncementDelivery } from "./governed-announcement-delivery.js";
import {
  createReceiptAwareRecoverableAnnouncementDelivery,
  createRecoverableAnnouncementDelivery,
} from "./recoverable-announcement-delivery.js";
import {
  cleanupCompletionAttachmentSnapshot,
  createCompletionAttachmentPreparer,
  reconcileCompletionAttachmentSnapshots,
  verifyCompletionAttachmentSnapshot,
} from "./completion-attachment.js";
import { createAnnouncementFailureNoticeRenderer } from "./announcement-failure-locale.js";
import { resolvePreservedCrossSessionRoute } from "./cross-session-route.js";
import { createInternalTurnScope } from "./internal-turn-scope.js";
/** Silent fallback for test wiring that omits the production logger. */
const NOOP_LOGGER: ComisLogger = {
  level: "silent",
  trace: () => {},
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  fatal: () => {},
  audit: () => {},
  child: () => NOOP_LOGGER,
};

export function createRetirementProducerStateResolver(deps: {
  sessionStore: Pick<SessionStorePort, "loadByRef">
    & Partial<Pick<SessionStorePort, "save">>;
  durableRuns?: Pick<DurableRunPort, "getByCheckpoint">;
  graphProducerExists?: (graphId: string) => boolean;
}): (
  producer: AnnouncementRetirementProducer,
) => Promise<Result<AnnouncementRetirementProducerState, Error>> {
  return async (producer) => {
    if (producer.kind === "graph") {
      return ok((deps.graphProducerExists?.(producer.graphId) ?? true)
        ? { status: "active" as const }
        : { status: "absent" as const });
    }
    if (producer.kind === "session") {
      const session = deps.sessionStore.loadByRef({
        tenantId: producer.tenantId,
        agentId: producer.agentId,
      }, producer.conversationRef);
      if (!session.ok) return err(session.error);
      const recoveryHandoff = session.value === undefined
        ? undefined
        : session.value.metadata.announcementProducerRecoveryOutcome;
      const handoffRecord = typeof recoveryHandoff === "object"
        && recoveryHandoff !== null
        && !Array.isArray(recoveryHandoff)
        ? recoveryHandoff as Record<string, unknown>
        : undefined;
      const recoveryOutcome = handoffRecord?.checkpointId === producer.checkpointId
        ? handoffRecord.outcome
        : undefined;
      if (
        isAnnouncementProducerRecoveryOutcome(recoveryOutcome)
        && recoveryOutcome.kind === "session"
      ) {
        return ok({
          status: "terminal" as const,
          terminalReason: recoveryOutcome.terminalReason,
          recoveryOutcome,
        });
      }
      if (!deps.durableRuns) return ok({ status: "absent" as const });
      const checkpoint = await deps.durableRuns.getByCheckpoint(producer.checkpointId);
      if (!checkpoint.ok) return checkpoint;
      if (!checkpoint.value) return ok({ status: "absent" as const });
      if (checkpoint.value.status === "running") return ok({ status: "active" as const });
      return ok({
        status: "terminal" as const,
        ...(checkpoint.value.terminalReason
          ? { terminalReason: checkpoint.value.terminalReason }
          : {}),
      });
    }
    const loaded = deps.sessionStore.loadByRef({
      tenantId: producer.tenantId,
      agentId: producer.agentId,
    }, producer.conversationRef);
    if (!loaded.ok) return err(loaded.error);
    if (!loaded.value) return ok({ status: "absent" as const });
    const committed = loaded.value.messages.some((message) => {
      if (typeof message !== "object" || message === null || Array.isArray(message)) {
        return false;
      }
      const record = message as Record<string, unknown>;
      return record.role === "toolResult" && record.toolCallId === producer.toolCallId;
    });
    const recoveryHandoffs = loaded.value.metadata.announcementToolResultRecoveryHandoffs;
    const handoffsRecord = typeof recoveryHandoffs === "object"
      && recoveryHandoffs !== null
      && !Array.isArray(recoveryHandoffs)
      ? recoveryHandoffs as Record<string, unknown>
      : undefined;
    if (committed) {
      if (handoffsRecord !== undefined && deps.sessionStore.save !== undefined) {
        const remaining = Object.fromEntries(
          Object.entries(handoffsRecord).filter(([key]) => key !== producer.operationId),
        );
        const saved = deps.sessionStore.save(
          loaded.value.conversationScope,
          loaded.value.messages,
          {
            ...loaded.value.metadata,
            announcementToolResultRecoveryHandoffs: remaining,
          },
        );
        if (!saved.ok) return err(saved.error);
      }
      return ok({ status: "terminal" as const });
    }
    const recoveryHandoff = handoffsRecord === undefined
      ? undefined
      : Object.entries(handoffsRecord).find(([key]) => key === producer.operationId)?.[1];
    const handoffRecord = typeof recoveryHandoff === "object"
      && recoveryHandoff !== null
      && !Array.isArray(recoveryHandoff)
      ? recoveryHandoff as Record<string, unknown>
      : undefined;
    const recoveryOutcome = handoffRecord?.operationId === producer.operationId
      && handoffRecord.toolCallId === producer.toolCallId
      ? handoffRecord.outcome
      : undefined;
    if (
      isAnnouncementProducerRecoveryOutcome(recoveryOutcome)
      && recoveryOutcome.kind === "tool_result"
    ) {
      return ok({
        status: "terminal" as const,
        terminalReason: recoveryOutcome.terminalReason,
        recoveryOutcome,
      });
    }
    return ok({ status: "active" as const });
  };
}
/** All services produced by the cross-session messaging setup. */
export interface CrossSessionResult {
  /** Cross-session message sender for agent-to-agent communication. */
  crossSessionSender: ReturnType<typeof createCrossSessionSender>;
  /** Sub-agent task runner for delegated execution. */
  subAgentRunner: ReturnType<typeof createSubAgentRunner>;
  /** Channel message sender for graph completion announcements */
  sendToChannel: (channelType: string, channelId: string, text: string, options?: Omit<DeliverToChannelOptions, "completionMode">) => Promise<boolean>;
  /** Receipt-aware retained-operation boundary for completion announcements. */
  sendGovernedAnnouncement?: SendGovernedCompletionAnnouncement;
  sendRecoverableAnnouncement?: SendRecoverableCompletionAnnouncement;
  /** Parent session announcement for graph results */
  announceToParent: (callerAgentId: string, callerSessionKey: SessionKey, callerConversation: ConversationLocator, text: string, channelType: string, channelId: string, options?: { threadId?: string; resolvedLanguage?: string; citationEvidence?: CitationEvidence }) => Promise<string | undefined>;
  /** Dead-letter queue for failed announcement persistence. */
  deadLetterQueue?: ReturnType<typeof createAnnouncementDeadLetterQueue>;
  /** Announcement batcher for coalescing concurrent graph/sub-agent completions. */
  announcementBatcher: ReturnType<typeof createAnnouncementBatcher>;
  closeAnnouncementAdmission: () => void;
  /**
   * Cleanup function for proxy-typing controllers + TTL sweep timer. Threaded
   * to the composition root for invocation via
   * ShutdownDeps.proxyTypingCleanup (replaces eventBus.on(
   * "system:shutdown", ...) indirection that silently no-op'd in production).
   */
  proxyTypingCleanup: () => void;
}

/**
 * Create cross-session messaging services: cross-session sender + sub-agent runner.
 * The three callback closures (executeInSession, sendToChannel, executeSubAgent)
 * are built internally from the provided dependencies; the graph/sub-agent
 * branch is delegated to setup-cross-session-graph.ts.
 */
export function setupCrossSession(deps: {
  sessionStore: SessionStorePort;
  container: AppContainer;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- AgentTool generic requires complex type parameters from pi-ai SDK
  assembleToolsForAgent: (agentId: string, options?: import("../setup-tools.js").AssembleToolsOptions) => Promise<any[]>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- AgentExecutor.execute has complex signature crossing package boundaries
  getExecutor: (agentId: string) => { execute: (...args: any[]) => Promise<ExecutionResult> };
  adaptersByType: Map<string, { readonly channelId: string; sendMessage(channelId: string, text: string, options?: import("@comis/core").SendMessageOptions): Promise<import("@comis/shared").Result<string, Error>>; channelType: string; platformAction?(action: string, params: Record<string, unknown>): Promise<import("@comis/shared").Result<unknown, Error>> }>;
  /** Optional structured logger for cross-session subsystem. */
  logger?: ComisLogger;
  /** Optional memory adapter for persisting sub-agent completion summaries. */
  memoryAdapter?: {
    store(entry: MemoryWriteEntry, scope: MemoryWriteScope): Promise<{ ok: boolean }>;
  };
  /** Deferred gateway send callback (wired after setupGateway). */
  gatewaySend?: { ref?: (channelId: string, text: string) => boolean };
  /** Optional conversation-authority resolver for sub-agent abort paths. */
  sessionResolver?: {
    resolveActiveSession(conversationRef: ConversationRef): { abort(): Promise<void> } | undefined;
  };
  /** Delivery queue for crash-safe persistence */
  deliveryQueue?: import("@comis/core").DeliveryQueuePort;
  /** DeliveryService instance constructed at daemon composition root (setup-channels.ts). */
  deliveryService: DeliveryService;
  /** Canonical FileLockPort adapter, threaded into ephemeral session adapters. */
  fileLock: FileLockPort;
  /** Wall-clock + monotonic time reads. */
  clock: ClockPort;
  /** Timer scheduling. */
  timers: TimerPort;
  /**
   * The lifecycle GitExec the composition root binds (the real
   * execFile-backed `createExecGit` adapted to `{ stdout, exitCode }` via
   * `toLifecycleGitExec`). Threaded into executeSubAgent so a `worktree:true`
   * child runs in an isolated git worktree. Paired with {@link worktreeRegistry}.
   * Absent ⇒ the worktree request is honestly skipped (WARN, not silent no-op).
   */
  worktreeGitExec?: import("@comis/skills/tools").GitExec;
  /** The shared registry the boot/periodic orphan sweep reads (paired with {@link worktreeGitExec}). */
  worktreeRegistry?: import("../setup-worktree-sweep.js").WorktreeRegistry;
  /**
   * The tree-wide spawn ceiling consult, threaded into the
   * sub-agent runner's `checkSpawnCeiling` so every spawn (session.spawn AND
   * graph.* AND the in-process loop) is bounded at the convergence point. Bound
   * to `boundedAutonomy.tryAcquireSpawn` by the daemon; absent when no agent is
   * autonomy-bearing (the runner's consult is then inert — no regression).
   */
  checkSpawnCeiling?: (
    rootRunId: string,
    depth: number,
    fanout: number,
  ) => SpawnCeilingDecision;
  /**
   * The symmetric release of a slot reserved by
   * {@link checkSpawnCeiling}, threaded into the runner's `releaseSpawnCeiling`
   * so a completed run frees its tree-wide slot (paired 1:1 with the acquire).
   * Bound to `boundedAutonomy.releaseSpawn` by the daemon; absent ⇒ the runner's
   * release is inert (matches an absent `checkSpawnCeiling`).
   */
  releaseSpawnCeiling?: (rootRunId: string) => void;
  /**
   * The durable-run store + its keep-alive thresholds
   * + the leaseId/budget facts resolver, threaded into the sub-agent runner so it
   * writes a per-root checkpoint at the spawn boundary + a heartbeat on the
   * injected timer. All optional; absent means the runner's durable path is inert.
   */
  durableRuns?: DurableRunPort;
  durability?: { keepAliveMs: number; staleHeartbeatMs: number };
  durableRunFacts?: (
    rootRunId: string,
    agentId: string,
  ) => {
    caps: readonly AgentCapability[];
    leaseIds: readonly string[];
    rootBudget: import("@comis/core").DurableRootBudget;
  } | undefined;
  /**
   * The closed five-state outward-send uncertainty ledger + the
   * announce-origin rootRunId resolver, threaded into BOTH `createCrossSessionSender`
   * (the announce() ledger wrap) AND the announcement dead-letter
   * queue (the drain committed-skip) so the completion-announcement
   * outward path has one durable operation identity. An ambiguous send parks
   * unresolved and is not replayed. All optional;
   * absent means both paths are pure pass-throughs. The
   * daemon wires them ONLY when durability is on, reusing the SAME store
   * instances built at composition (one ledger, one durable store).
   */
  outwardLedger?: OutwardSendLedgerPort;
  resolveRootRunId?: import("@comis/core").RootRunIdResolver;
  graphProducerExists?: (graphId: string) => boolean;
  /**
   * Release a child session's trajectory recorder when its run settles
   * (bound to `SessionTrajectoryHandleRegistry.close` by the daemon).
   * Absent means the runner's teardown is inert; without it
   * a terminal child's recorder stays bus-subscribed for the daemon's
   * lifetime and keeps ingesting events into the dead child's trajectory.
   */
  closeTrajectory?: (formattedSessionKey: string) => Promise<void>;
  /** Ensures boot/off-turn recovery has a session-scoped trajectory bridge. */
  ensureDeadLetterRecoveryObservation?: (input: {
    agentId: string;
    sessionKey: string;
  }) => import("@comis/shared").Result<void, Error>;
}): CrossSessionResult {
  const { sessionStore, container, assembleToolsForAgent, getExecutor, adaptersByType } = deps;
  // Build the three callback closures from injected deps.
  const executeInSession = async (
    agentId: string,
    sessionKey: SessionKey,
    conversation: ConversationLocator,
    text: string,
    /** Tools to ship INSTEAD of assembling the agent's set. `undefined` = the normal
     *  set; `[]` is taken literally and ships none, which drops the tools block from
     *  the head of the provider cache prefix. For a turn that must not CALL tools,
     *  pass `undefined` and set `noToolCalls`. */
    fixedTools?: Awaited<ReturnType<typeof assembleToolsForAgent>>,
    resolvedLanguage?: string,
    runtimeActionEvidence?: NormalizedMessage["metadata"]["runtimeActionEvidence"],
    citationEvidence?: CitationEvidence,
    /** This turn must not invoke tools — provider-enforced where possible, else by
     *  shipping none. Keeps the cached prefix intact either way. */
    noToolCalls?: boolean,
  ): Promise<{ response: string; tokensUsed: { total: number }; cost: { total: number } }> => {
    const targetSessionKey = { ...sessionKey, agentId };
    const ambientContext = tryGetContext();
    const preservedRoute = resolvePreservedCrossSessionRoute({
      ambientContext,
      agentId,
      sessionKey,
      conversation,
    });
    const targetOrigin = preservedRoute?.origin;
    const targetTurnScope = preservedRoute?.turnScope
      ?? createInternalTurnScope(conversation.conversationScope);
    const targetContextResult = createResolvedRequestContext({
      tenantId: sessionKey.tenantId,
      userId: sessionKey.userId,
      sessionKey: targetSessionKey,
      agentId,
      traceId: randomUUID(),
      startedAt: deps.clock.now(),
      trustLevel: "guest",
      resolvedModel: undefined,
      resolvedLanguage,
      turnScope: targetTurnScope,
      ...(targetOrigin !== undefined
        ? { channelType: targetOrigin.channelType, deliveryOrigin: targetOrigin }
        : {}),
    });
    if (!targetContextResult.ok) return Promise.reject(targetContextResult.error);
    const targetContext = targetContextResult.value;
    return runWithContext(targetContext, async () => {
      const msg: NormalizedMessage = {
        id: randomUUID(),
        channelId: sessionKey.channelId,
        channelType: "cross-session",
        senderId: "cross-session-relay",
        text,
        timestamp: systemNowMs(),
        attachments: [],
        metadata: { crossSession: true, ...(runtimeActionEvidence ? { runtimeActionEvidence } : {}), ...(citationEvidence ? { citationEvidence } : {}) },
      };
      const tools = fixedTools ?? await assembleToolsForAgent(agentId);
      const overrides = noToolCalls ? { operationType: "interactive" as const, toolChoice: "none" as const } : undefined;
      const result = await getExecutor(agentId).execute(msg, targetSessionKey, tools, undefined, agentId, undefined, undefined, overrides);
      if (result.finishReason !== "stop") {
        // The sender already treats a rejected execute callback as a failed RPC
        // operation. Rejecting here preserves the executor's terminal outcome
        // instead of converting its safety/error response into `sent: true`.
        return Promise.reject(
          new Error(`Cross-session target execution ended with ${String(result.finishReason)}`),
        );
      }
      return { response: result.response, tokensUsed: result.tokensUsed, cost: result.cost };
    });
  };
  const prepareCompletionAttachment = createCompletionAttachmentPreparer({
    dataDir: container.config.dataDir,
    agents: container.config.agents,
  });
  const announcementAdmissionAbort = new AbortController();
  let textChunkQueue: ReturnType<typeof createAnnouncementDeadLetterQueue> | undefined;
  const {
    sendToChannelWithReceipt,
    sendSingleTextToChannelWithReceipt,
    sendToChannel,
    sendPreparedAttachmentToChannelWithReceipt,
    sendLedgerAnnouncement,
    sendGovernedTextToChannelWithReceipt,
  } = createAnnouncementDelivery({
    adaptersByType,
    deliveryService: deps.deliveryService,
    eventBus: container.eventBus,
    ...(deps.gatewaySend ? { gatewaySend: deps.gatewaySend } : {}),
    ...(deps.logger ? { logger: deps.logger } : {}),
    ...(deps.outwardLedger ? { outwardLedger: deps.outwardLedger } : {}),
    ...(deps.resolveRootRunId ? { resolveRootRunId: deps.resolveRootRunId } : {}),
    recordTextChunks: (operationId, chunks) => textChunkQueue
      ? textChunkQueue.recordDecisionTextChunks(operationId, chunks)
      : Promise.resolve(err(new Error("Announcement text chunk storage is unavailable"))),
    prepareCompletionAttachment,
    verifyCompletionAttachment: (attachment) => verifyCompletionAttachmentSnapshot(
      container.config.dataDir,
      attachment,
    ),
  });
  // executeSubAgent built via setup-cross-session-graph.ts.
  const executeSubAgent = buildExecuteSubAgent({
    container,
    sessionStore,
    assembleToolsForAgent,
    getExecutor,
    fileLock: deps.fileLock,
    logger: deps.logger,
    // Thread the git-worktree seam + registry so a `worktree:true` child
    // runs in an isolated worktree (auto-clean-if-unchanged). Both absent ⇒ the
    // request is honestly skipped when there is no git seam.
    ...(deps.worktreeGitExec ? { worktreeGitExec: deps.worktreeGitExec } : {}),
    ...(deps.worktreeRegistry ? { worktreeRegistry: deps.worktreeRegistry } : {}),
  });

  // Ask the parent agent to rewrite an announcement. The irreversible platform
  // send remains at the receipt-aware announcement-delivery boundary.
  const announceToParent = async (
    callerAgentId: string,
    callerSessionKey: SessionKey,
    callerConversation: ConversationLocator,
    text: string,
    channelType: string,
    channelId: string,
    options?: { threadId?: string; resolvedLanguage?: string; citationEvidence?: CitationEvidence },
  ): Promise<string | undefined> => {
    deps.logger?.debug({
      callerAgentId,
      channelId: callerSessionKey.channelId,
      textLength: text.length,
      channelType,
      targetChannelId: channelId, resolvedLanguage: options?.resolvedLanguage ?? "unset",
    }, "announceToParent invoked");

    // Emit proxy typing around announcement delivery (not spawn-time).
    const proxyId = `announce-${systemNowMs()}-${Math.random().toString(36).slice(2, 8)}`;
    container.eventBus.emit("typing:proxy_start", {
      runId: proxyId,
      channelType,
      channelId,
      parentSessionKey: typeof callerSessionKey === "string"
        ? callerSessionKey
        : `${callerSessionKey.channelId}:${callerSessionKey.userId}:${callerSessionKey.tenantId}`,
      agentId: callerAgentId,
      timestamp: systemNowMs(),
    });
    try {
      // Candidate rewriting is a text-only boundary. An explicit empty tool
      // set prevents the parent execution from producing platform/tool side
      // effects before the governed delivery decision is durable.
      if (
        callerConversation.conversationScope.tenantId !== callerSessionKey.tenantId
        || callerConversation.conversationScope.agentId !== callerAgentId
      ) {
        deps.logger?.warn({
          callerAgentId,
          hint: "repair the captured parent conversation authority before retrying the announcement",
          errorKind: "precondition" as const,
        }, "Parent announcement conversation authority is inconsistent");
        return undefined;
      }
      const callerRef = createConversationRef(callerConversation.conversationScope);
      if (!callerRef.ok || callerRef.value !== callerConversation.conversationRef) return undefined;
      const result = await executeInSession(
        callerAgentId,
        callerSessionKey,
        callerConversation,
        text,
        // Capability-free: the candidate REWRITE boundary for a background completion,
        // not a work turn — it must not act on the evidence grounding it. Expressed
        // as `noToolCalls`, not an empty tool array: tools are the FIRST element of
        // the provider cache key, so emptying them re-wrote a ~200k prefix on the
        // way in AND again on the way out.
        undefined,
        options?.resolvedLanguage, { kind: "background_completion" }, options?.citationEvidence,
        true,
      );
      const trimmed = result.response.trim();
      const isNoReply = !trimmed || trimmed === "NO_REPLY" || trimmed.startsWith("NO_REPLY");
      deps.logger?.debug({
        callerAgentId,
        responseLength: trimmed.length,
        willDeliver: !isNoReply,
        isNoReply,
      }, "announceToParent execution result");
      return isNoReply ? undefined : trimmed;
    } finally {
      container.eventBus.emit("typing:proxy_stop", {
        runId: proxyId,
        channelType,
        channelId,
        reason: "completed" as const,
        durationMs: 0,
        timestamp: systemNowMs(),
      });
    }
  };

  // Dead-letter queue (created before batcher so batcher can reference it).
  // safePath requires an absolute base; process.cwd() is the fallback.
  const deadLetterFilePath = safePath(container.config.dataDir || process.cwd(), "dead-letters.jsonl");
  const deadLetterQueue = createAnnouncementDeadLetterQueue({
    filePath: deadLetterFilePath,
    maxRetries: container.config.security.agentToAgent.delivery.maxRetries,
    retryIntervalMs: 60_000,
    maxAgeMs: 3_600_000,
    maxEntries: 100,
    eventBus: container.eventBus,
    logger: deps.logger?.child({ submodule: "dead-letter-queue" }),
    // The SAME ledger instance — drain consults it
    // BEFORE re-delivering, so a committed announcement is SKIPPED across a restart
    // (the in-memory deliveredKeys set rebuilds empty on boot; the durable ledger
    // is the authoritative no-double-notify signal). Absent ⇒ at-least-once delivery.
    ...(deps.outwardLedger ? { outwardLedger: deps.outwardLedger } : {}),
    receiptAwareSendToChannel: sendSingleTextToChannelWithReceipt,
    retirementProducerState: createRetirementProducerStateResolver({
      sessionStore,
      ...(deps.durableRuns ? { durableRuns: deps.durableRuns } : {}),
      ...(deps.graphProducerExists ? { graphProducerExists: deps.graphProducerExists } : {}),
    }),
    reconcileAttachments: (referencedPaths) => reconcileCompletionAttachmentSnapshots(
      container.config.dataDir,
      referencedPaths,
    ),
    ...(deps.outwardLedger ? {
      governedSendToChannel: (
        channelType,
        channelId,
        text,
        options,
        attachment,
      ) => {
        if (attachment) {
          const destinationEndpoint = options?.destinationEndpoint;
          if (!destinationEndpoint) {
            return Promise.resolve(err(new Error(
              "Retained attachment has no immutable destination endpoint",
            )));
          }
          return sendPreparedAttachmentToChannelWithReceipt(
            channelType,
            channelId,
            text,
            attachment,
            destinationEndpoint,
            options,
          );
        }
        const governedText = options?.governedText;
        const destinationEndpoint = options?.destinationEndpoint;
        const deliveryAuthority = options?.authority;
        if (
          !governedText
          || !destinationEndpoint
          || !deliveryAuthority
          || !sendGovernedTextToChannelWithReceipt
        ) {
          return Promise.resolve(err(new Error(
            "Retained text announcement has no governed operation identity",
          )));
        }
        const { persistTextChunks, ...governedRequest } = governedText;
        return sendGovernedTextToChannelWithReceipt({
          ...governedRequest,
          channelType,
          channelId,
          text,
          ...(options?.threadId || options?.extra ? {
            options: {
              ...(options?.threadId ? { threadId: options.threadId } : {}),
              ...(options?.extra ? { extra: options.extra } : {}),
            },
          } : {}),
        }, destinationEndpoint, deliveryAuthority, persistTextChunks).then((result) => {
          if (!result.ok) return result;
          const outcome = result.value;
          if (outcome.delivered) {
            return ok({
              delivered: true,
              status: "accepted" as const,
              ...(outcome.platformMessageId
                ? { platformMessageId: outcome.platformMessageId }
                : {}),
            });
          }
          if (
            "terminalDecision" in outcome
            && outcome.terminalDecision === "delivered"
          ) {
            return ok({
              delivered: true,
              status: "accepted" as const,
            });
          }
          return ok({
            delivered: false,
            status: "unknown" as const,
          });
        });
      },
      prepareAttachment: prepareCompletionAttachment,
      cleanupAttachment: (attachment) => cleanupCompletionAttachmentSnapshot(
        container.config.dataDir,
        attachment,
      ),
    } : {}),
    ...(deps.ensureDeadLetterRecoveryObservation
      ? { ensureSessionObservation: deps.ensureDeadLetterRecoveryObservation }
      : {}),
  });
  textChunkQueue = deadLetterQueue;

  const sendGovernedAnnouncement = sendLedgerAnnouncement
    ? createRecoverableAnnouncementDelivery({
        adaptersByType,
        deadLetterQueue,
        send: sendLedgerAnnouncement,
        lifecycleSignal: announcementAdmissionAbort.signal,
        ...(deps.resolveRootRunId ? { resolveRootRunId: deps.resolveRootRunId } : {}),
        ...(deps.logger ? { logger: deps.logger } : {}),
      })
    : undefined;
  const sendRecoverableAnnouncement = sendGovernedAnnouncement
    ? undefined
    : createReceiptAwareRecoverableAnnouncementDelivery({
        adaptersByType,
        deadLetterQueue,
        deliveryService: deps.deliveryService,
        lifecycleSignal: announcementAdmissionAbort.signal,
        ...(deps.logger ? { logger: deps.logger } : {}),
      });
  const crossSessionSender = createCrossSessionSender({
    sessionStore,
    executeInSession,
    sendToChannel,
    eventBus: container.eventBus,
    config: container.config.security.agentToAgent,
    logger: deps.logger,
    reserveAnnouncementProducer: (reservation) => deadLetterQueue.reserveProducer(
      reservation,
      announcementAdmissionAbort.signal,
    ),
    releaseAnnouncementProducer: (producerKey) => deadLetterQueue.releaseProducer(producerKey),
    recordAnnouncementProducerOutcome: (producerKey, outcome) =>
      deadLetterQueue.recordProducerOutcome(
        producerKey,
        outcome,
        announcementAdmissionAbort.signal,
      ),
    lifecycleSignal: announcementAdmissionAbort.signal,
    cancelAnnouncementProducer: (producerKey) => deadLetterQueue.cancelProducer(producerKey),
    suppressAnnouncementProducer: (producerKey) => deadLetterQueue.suppressProducer(producerKey),
    prepareAnnouncementRetirement: (completionKeys, producer) =>
      deadLetterQueue.prepareTerminalDecisionRetirement(completionKeys, producer),
    ...(sendGovernedAnnouncement ? { sendGovernedAnnouncement } : {}),
    ...(sendRecoverableAnnouncement ? { sendRecoverableAnnouncement } : {}),
    resolveRootRunId: deps.resolveRootRunId,
  });

  // ONE bounded delivered-key store shared across every
  // completion-delivery surface — the batcher success path, the no-batcher
  // success branches in deliverAnnouncement, the failure path
  // (deliverFailureNotification), and DLQ recovery. A single instance is
  // what makes cross-path dedup hold whether or not the batcher is on the path;
  // it is bounded (FIFO) so it never leaks for the daemon lifetime.
  const deliveryDedup = createDeliveryDedup();

  // Announcement batcher coalesces near-simultaneous sub-agent completions.
  const announcementBatcher = createAnnouncementBatcher({
    eventBus: container.eventBus,
    announceToParent,
    sendToChannel,
    sendToChannelWithReceipt,
    logger: deps.logger?.child({ submodule: "announcement-batcher" }),
    deadLetterQueue,
    deliveryDedup,
    ...(sendGovernedAnnouncement ? { sendGovernedAnnouncement } : {}),
    ...(sendRecoverableAnnouncement ? { sendRecoverableAnnouncement } : {}),
  });

  // Resolve condensation model via 5-level priority chain
  const subagentCtxConfigForCondenser = container.config.security?.agentToAgent?.subagentContext;
  const defaultAgentConfig = container.config.agents?.["default"];

  const condensationResolution = resolveOperationModel({
    operationType: "condensation",
    agentProvider: defaultAgentConfig?.provider ?? "anthropic",
    agentModel: defaultAgentConfig?.model ?? "default",
    operationModels: defaultAgentConfig?.operationModels ?? {},
    providerFamily: resolveProviderFamily(defaultAgentConfig?.provider ?? "anthropic"),
    agentPromptTimeoutMs: defaultAgentConfig?.promptTimeout?.promptTimeoutMs,
  });

  // Resolve API key from resolution.provider (enables cross-provider condensation)
  const condenserProviderEntry = container.config.providers?.entries?.[condensationResolution.provider];
  const condenserApiKeyName = condenserProviderEntry?.apiKeyName
    || `${condensationResolution.provider.toUpperCase()}_API_KEY`;
  const condenserApiKey = container.secretManager?.get(condenserApiKeyName) ?? "";

  deps.logger?.debug(
    { model: condensationResolution.model, source: condensationResolution.source, provider: condensationResolution.provider },
    "Condensation model resolved",
  );

  const resultCondenser = createResultCondenser({
    maxResultTokens: subagentCtxConfigForCondenser?.maxResultTokens ?? 4000,
    condensationStrategy: subagentCtxConfigForCondenser?.condensationStrategy ?? "auto",
    dataDir: container.config.dataDir || ".",
    logger: deps.logger
      ? { info: deps.logger.info.bind(deps.logger), warn: deps.logger.warn.bind(deps.logger), debug: deps.logger.debug.bind(deps.logger) }
      : { info: () => {}, warn: () => {}, debug: () => {} },
  });

  // Create NarrativeCaster for tagged result announcements
  const narrativeCaster = createNarrativeCaster({
    enabled: subagentCtxConfigForCondenser?.narrativeCasting ?? true,
    tagPrefix: subagentCtxConfigForCondenser?.resultTagPrefix ?? "Subagent Result",
  });

  // The full-output ResultRef store. The runner stays
  // @comis/skills-free (DI) — the daemon owns the store + the child-workspace
  // target selection. The callback resolves the CHILD's OWN jailed workspace
  // from ctx.agentId (mirroring setup-cross-session-graph.ts:358-361), NEVER the
  // lead's; createResultRefStore is additionally safePath-confined to
  // that root, so a traversal returns a MaterializeError the runner degrades on.
  // The store's 3-way union (ResultRef | MaterializeError | undefined) is returned
  // UNCHANGED — the runner's dep contract IS that union, so no mapping is forced.
  const resultRefStore = createResultRefStore({
    logger: deps.logger
      ? deps.logger.child({ submodule: "sub-agent-result-ref" })
      : NOOP_LOGGER,
  });
  const materializeFullOutput = (
    content: string,
    ctx: { runId: string; nowMs: number; agentId: string },
  ) => {
    const childAgentConfig = container.config.agents[ctx.agentId]
      ?? container.config.agents["default"]
      ?? ({} as AgentConfig);
    const childWorkspaceDir = resolveWorkspaceDir(
      childAgentConfig,
      ctx.agentId,
      container.config.dataDir || undefined,
    );
    return resultRefStore.materialize(content, "sessions_spawn", {
      workspacePath: childWorkspaceDir,
      runId: ctx.runId,
      nowMs: ctx.nowMs,
    });
  };

  const lifecycleHooks = createLifecycleHooks({
    logger: deps.logger
      ? { info: deps.logger.info.bind(deps.logger), warn: deps.logger.warn.bind(deps.logger), debug: deps.logger.debug.bind(deps.logger) }
      : { info: () => {}, warn: () => {}, debug: () => {} },
    eventBus: container.eventBus,
  });

  // Sub-agent runner — async sub-agent spawning with allowlist + auto-archive
  const subAgentRunner = createSubAgentRunner({
    sessionStore,
    executeAgent: executeSubAgent,
    sendToChannel,
    announceToParent,
    renderAnnouncementFailureNotice: createAnnouncementFailureNoticeRenderer(container.config.agents),
    eventBus: container.eventBus,
    config: container.config.security.agentToAgent,
    // Sandbox no-downgrade posture resolver. The runner is a
    // @comis/agent leaf with no full-config import, so it CANNOT reach
    // container.config.agents — we inject a closure that resolves each agent's
    // posture from its per-agent skills config. The two-arg form mirrors the
    // effectiveAgentId inherit-caller fallback in setup-cross-session-graph.ts
    // (:197-199): a child with no dedicated config inherits the caller's config,
    // so its resolved posture matches what it will actually run under (equal to
    // the caller ⇒ not a phantom downgrade). resolvePostureFromSkills folds an
    // absent slice to the most-confined default (fail-closed).
    resolvePosture: (agentId: string, callerAgentId?: string) => {
      const effectiveAgentId = (agentId in container.config.agents)
        ? agentId
        : (callerAgentId && callerAgentId in container.config.agents ? callerAgentId : agentId);
      return resolvePostureFromSkills(container.config.agents[effectiveAgentId]?.skills);
    },
    tenantId: container.config.tenantId,
    dataDir: container.config.dataDir || ".",
    logger: deps.logger?.child({ submodule: "sub-agent-runner" }),
    memoryAdapter: deps.memoryAdapter,
    batcher: announcementBatcher,
    sessionResolver: deps.sessionResolver,
    resultCondenser,
    condenserModel: condenserApiKey ? { id: condensationResolution.modelId, provider: condensationResolution.provider } as unknown : undefined,
    condenserApiKey: condenserApiKey || undefined,
    narrativeCaster,
    // The full-output ResultRef materialize, targeting the CHILD's
    // own jailed workspace (resolved from ctx.agentId), returning the store's
    // 3-way union unchanged. An absent wired store IS the no-op (no shim layer).
    materializeFullOutput,
    lifecycleHooks,
    deadLetterQueue,
    ...(deps.resolveRootRunId ? { resolveRootRunId: deps.resolveRootRunId } : {}), deliveryDedup,
    ...(sendGovernedAnnouncement ? { sendGovernedAnnouncement } : {}),
    ...(sendRecoverableAnnouncement ? { sendRecoverableAnnouncement } : {}),
    clock: deps.clock,
    timers: deps.timers,
    // The tree-wide spawn ceiling (bound to
    // boundedAutonomy.tryAcquireSpawn by the daemon). Inert when absent.
    ...(deps.checkSpawnCeiling ? { checkSpawnCeiling: deps.checkSpawnCeiling } : {}),
    // The symmetric release (boundedAutonomy.releaseSpawn).
    ...(deps.releaseSpawnCeiling ? { releaseSpawnCeiling: deps.releaseSpawnCeiling } : {}),
    // The durable checkpoint store + thresholds + facts
    // resolver (the runner writes a per-root checkpoint + heartbeat). Inert when
    // absent; the daemon wires these only when durability is enabled.
    ...(deps.durableRuns ? { durableRuns: deps.durableRuns } : {}),
    ...(deps.durableRuns ? {
      resolveWorkspacePolicySnapshot: async (agentId: string) => {
        const snapshot = await container.workspacePolicyPort?.load(agentId);
        if (snapshot === undefined) return err(new Error("Workspace policy port is unavailable"));
        if (!snapshot.ok) return err(new Error(`Workspace policy snapshot unavailable for ${agentId}`));
        return snapshot.value.agentId === agentId
          ? ok(snapshot.value)
          : err(new Error("Workspace policy snapshot agent mismatch"));
      },
    } : {}),
    ...(deps.durability ? { durability: deps.durability } : {}),
    ...(deps.durableRunFacts ? { durableRunFacts: deps.durableRunFacts } : {}),
    // Trajectory-recorder release on terminal settle (registry.close).
    ...(deps.closeTrajectory ? { closeTrajectory: deps.closeTrajectory } : {}),
  });

  // Register proxy typing event listeners (typing:proxy_start/stop + TTL
  // sweep). Returns a cleanup function the composition root threads into
  // ShutdownDeps.proxyTypingCleanup (replaces the eventBus.on(
  // "system:shutdown", ...) indirection that silently no-op'd in production).
  const proxyTypingCleanup = registerProxyTypingListeners({
    container,
    adaptersByType: adaptersByType as unknown as Map<string, ChannelPort & { platformAction?(action: string, params: Record<string, unknown>): Promise<unknown> }>,
    logger: deps.logger,
  });

  return {
    crossSessionSender,
    subAgentRunner,
    sendToChannel,
    ...(sendGovernedAnnouncement ? { sendGovernedAnnouncement } : {}),
    ...(sendRecoverableAnnouncement ? { sendRecoverableAnnouncement } : {}),
    announceToParent,
    deadLetterQueue,
    announcementBatcher,
    closeAnnouncementAdmission: () => announcementAdmissionAbort.abort(),
    proxyTypingCleanup,
  };
}
