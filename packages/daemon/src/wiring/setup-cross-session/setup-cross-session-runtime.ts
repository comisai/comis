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
  DeliveryOrigin, DeliveryService, DeliverToChannelOptions, DurableRunPort,
  FileLockPort, NormalizedMessage, OutwardSendLedgerPort,
  SessionKey, TimerPort, SessionStorePort, ConversationLocator, ConversationRef, ConversationScope,
  ResolvedTurnScope,
  MemoryWriteEntry, MemoryWriteScope,
} from "@comis/core";
import {
  createConversationRef, createResolvedRequestContext, DeliveryOriginSchema, formatSessionKey,
  resolveWorkspaceDir, runWithContext, safePath, systemNowMs, tryGetContext,
} from "@comis/core";
import { createResultRefStore } from "@comis/skills/tools";
import type { ComisLogger } from "@comis/infra";
import type { ExecutionResult } from "@comis/agent";
import { createResultCondenser, createNarrativeCaster, createLifecycleHooks, resolveOperationModel, resolveProviderFamily, createSubAgentRunner, createDeliveryDedup, resolvePostureFromSkills } from "@comis/agent";
import {
  createCrossSessionSender,
  createAnnouncementBatcher,
  createAnnouncementDeadLetterQueue,
  type SendGovernedCompletionAnnouncement,
} from "@comis/orchestrator";
import { randomUUID } from "node:crypto";
import { err, ok } from "@comis/shared";
import { buildExecuteSubAgent } from "./setup-cross-session-graph.js";
import { registerProxyTypingListeners } from "./setup-cross-session-events.js";
import { createAnnouncementDelivery } from "./governed-announcement-delivery.js";
import { createCompletionAttachmentPreparer } from "./completion-attachment.js";

/**
 * A silent {@link ComisLogger} used only when the optional `deps.logger` is
 * absent (test wiring). `createResultRefStore` requires a full ComisLogger; the
 * production composition root always supplies one, so this never logs in
 * production — it exists so the materialize feature is wired regardless.
 */
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

function createInternalTurnScope(conversation: ConversationScope): ResolvedTurnScope {
  const partition = conversation.partition;
  const reference = createConversationRef(conversation);
  const endpoint = partition.kind === "endpoint-conversation"
    || partition.kind === "endpoint-conversation-principal"
    ? partition.endpoint
    : {
        channelType: partition.kind === "channel-principal" ? partition.channelType : "cross-session",
        channelInstanceId: "runtime",
        conversationId: reference.ok
          ? reference.value
          : conversation.agentId,
        conversationKind: "direct" as const,
      };
  const principalId = partition.kind === "principal"
    || partition.kind === "channel-principal"
    || partition.kind === "endpoint-conversation-principal"
    ? partition.principalId
    : `cross-session:${conversation.agentId}`;
  return { conversation, endpoint, principal: { principalId } };
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
  /** Parent session announcement for graph results */
  announceToParent: (callerAgentId: string, callerSessionKey: SessionKey, callerConversation: ConversationLocator, text: string, channelType: string, channelId: string, options?: { threadId?: string; resolvedLanguage?: string }) => Promise<string | undefined>;
  /** Dead-letter queue for failed announcement persistence. */
  deadLetterQueue?: ReturnType<typeof createAnnouncementDeadLetterQueue>;
  /** Announcement batcher for coalescing concurrent graph/sub-agent completions. */
  announcementBatcher: ReturnType<typeof createAnnouncementBatcher>;
  /**
   * Cleanup function for proxy-typing controllers + TTL sweep timer. Threaded
   * to the composition root for invocation via
   * ShutdownDeps.proxyTypingCleanup (replaces eventBus.on(
   * "system:shutdown", ...) indirection that silently no-op'd in production).
   */
  proxyTypingCleanup: () => void;
}

// ---------------------------------------------------------------------------
// Setup function
// ---------------------------------------------------------------------------

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
  adaptersByType: Map<string, { sendMessage(channelId: string, text: string, options?: import("@comis/core").SendMessageOptions): Promise<import("@comis/shared").Result<string, Error>>; channelType: string; platformAction?(action: string, params: Record<string, unknown>): Promise<import("@comis/shared").Result<unknown, Error>> }>;
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
  ) => { ok: true } | { ok: false; reason: string };
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
  /**
   * Release a child session's trajectory recorder when its run settles
   * (bound to `SessionTrajectoryHandleRegistry.close` by the daemon).
   * Absent means the runner's teardown is inert; without it
   * a terminal child's recorder stays bus-subscribed for the daemon's
   * lifetime and keeps ingesting events into the dead child's trajectory.
   */
  closeTrajectory?: (formattedSessionKey: string) => Promise<void>;
}): CrossSessionResult {
  const { sessionStore, container, assembleToolsForAgent, getExecutor, adaptersByType } = deps;

  // Build the three callback closures from injected deps.
  const executeInSession = async (
    agentId: string,
    sessionKey: SessionKey,
    conversation: ConversationLocator,
    text: string,
    fixedTools?: Awaited<ReturnType<typeof assembleToolsForAgent>>,
    resolvedLanguage?: string,
  ): Promise<{ response: string; tokensUsed: { total: number }; cost: { total: number } }> => {
    const targetSessionKey = { ...sessionKey, agentId };
    const formattedTargetSessionKey = formatSessionKey(targetSessionKey);
    const ambientContext = tryGetContext();
    const parsedOrigin = DeliveryOriginSchema.safeParse(ambientContext?.deliveryOrigin);
    const candidateOrigin = parsedOrigin.success ? parsedOrigin.data : undefined;
    const targetOrigin: DeliveryOrigin | undefined = candidateOrigin !== undefined
      && ambientContext?.tenantId === sessionKey.tenantId
      && ambientContext.userId === sessionKey.userId
      && ambientContext.sessionKey === formattedTargetSessionKey
      && ambientContext.channelType === candidateOrigin.channelType
      && candidateOrigin.tenantId === sessionKey.tenantId
      && candidateOrigin.userId === sessionKey.userId
      && candidateOrigin.channelId === sessionKey.channelId
      && candidateOrigin.threadId === sessionKey.threadId
      ? Object.freeze(candidateOrigin)
      : undefined;
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
      turnScope: createInternalTurnScope(conversation.conversationScope),
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
        metadata: { crossSession: true },
      };
      const tools = fixedTools ?? await assembleToolsForAgent(agentId);
      const result = await getExecutor(agentId).execute(msg, targetSessionKey, tools, undefined, agentId);
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
  const {
    sendToChannelWithReceipt,
    sendToChannel,
    sendGovernedAnnouncement,
  } = createAnnouncementDelivery({
    adaptersByType,
    deliveryService: deps.deliveryService,
    eventBus: container.eventBus,
    ...(deps.gatewaySend ? { gatewaySend: deps.gatewaySend } : {}),
    ...(deps.logger ? { logger: deps.logger } : {}),
    ...(deps.outwardLedger ? { outwardLedger: deps.outwardLedger } : {}),
    ...(deps.resolveRootRunId ? { resolveRootRunId: deps.resolveRootRunId } : {}),
    prepareCompletionAttachment: createCompletionAttachmentPreparer({
      dataDir: container.config.dataDir,
      agents: container.config.agents,
    }),
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

  // Cross-session sender — fire-and-forget, wait, or ping-pong messaging
  const crossSessionSender = createCrossSessionSender({
    sessionStore,
    executeInSession,
    sendToChannel,
    eventBus: container.eventBus,
    config: container.config.security.agentToAgent,
    logger: deps.logger,
    ...(sendGovernedAnnouncement ? { sendGovernedAnnouncement } : {}),
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
    options?: { threadId?: string; resolvedLanguage?: string },
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
        [],
        options?.resolvedLanguage,
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
    maxRetries: 5,
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
    ...(deps.outwardLedger ? { governedSendToChannel: sendToChannelWithReceipt } : {}),
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
    announceToParent,
    sendToChannel,
    logger: deps.logger?.child({ submodule: "announcement-batcher" }),
    deadLetterQueue,
    deliveryDedup,
    ...(sendGovernedAnnouncement ? { sendGovernedAnnouncement } : {}),
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

  // Create lifecycle hooks for spawn preparation and completion
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
    deliveryDedup,
    ...(sendGovernedAnnouncement ? { sendGovernedAnnouncement } : {}),
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
      resolveWorkspacePolicySnapshot: (agentId: string, policyHash: string) => {
        const snapshot = container.workspacePolicyPort?.get(policyHash);
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
    announceToParent,
    deadLetterQueue,
    announcementBatcher,
    proxyTypingCleanup,
  };
}
