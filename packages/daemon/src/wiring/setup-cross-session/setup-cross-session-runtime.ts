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

import type { NormalizedMessage, SessionKey, DeliveryService, DeliverToChannelOptions, ClockPort, TimerPort, AppContainer, FileLockPort, ChannelPort, DurableRunPort, OutwardSendLedgerPort, AgentCapability } from "@comis/core";
import { tryGetContext, safePath, systemNowMs } from "@comis/core";
import type { ComisLogger } from "@comis/infra";
import { createResultCondenser, createNarrativeCaster, createLifecycleHooks, resolveOperationModel, resolveProviderFamily, createSubAgentRunner, classifyErrorContext, createDeliveryDedup, resolvePostureFromSkills } from "@comis/agent";
import {
  createCrossSessionSender,
  createAnnouncementBatcher,
  createAnnouncementDeadLetterQueue,
} from "@comis/orchestrator";
import { randomUUID } from "node:crypto";
import { computeRetryBackoff } from "../../graph/graph-node-lifecycle.js";
import { buildExecuteSubAgent } from "./setup-cross-session-graph.js";
import { registerProxyTypingListeners } from "./setup-cross-session-events.js";

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

/** All services produced by the cross-session messaging setup. */
export interface CrossSessionResult {
  /** Cross-session message sender for agent-to-agent communication. */
  crossSessionSender: ReturnType<typeof createCrossSessionSender>;
  /** Sub-agent task runner for delegated execution. */
  subAgentRunner: ReturnType<typeof createSubAgentRunner>;
  /** Channel message sender for graph completion announcements */
  sendToChannel: (channelType: string, channelId: string, text: string, options?: DeliverToChannelOptions) => Promise<boolean>;
  /** Parent session announcement for graph results */
  announceToParent: (callerAgentId: string, callerSessionKey: SessionKey, text: string, channelType: string, channelId: string) => Promise<void>;
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
  sessionStore: {
    loadByFormattedKey(key: string): { messages: unknown[]; metadata: Record<string, unknown> } | undefined;
    save(key: SessionKey, messages: unknown[], metadata: Record<string, unknown>): void;
    delete(key: SessionKey): void;
  };
  container: AppContainer;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- AgentTool generic requires complex type parameters from pi-ai SDK
  assembleToolsForAgent: (agentId: string, options?: import("../setup-tools.js").AssembleToolsOptions) => Promise<any[]>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- AgentExecutor.execute has complex signature crossing package boundaries
  getExecutor: (agentId: string) => { execute: (...args: any[]) => Promise<any> };
  adaptersByType: Map<string, { sendMessage(channelId: string, text: string, options?: import("@comis/core").SendMessageOptions): Promise<import("@comis/shared").Result<string, Error>>; channelType: string; platformAction?(action: string, params: Record<string, unknown>): Promise<import("@comis/shared").Result<unknown, Error>> }>;
  /** Optional structured logger for cross-session subsystem. */
  logger?: ComisLogger;
  /** Optional memory adapter for persisting sub-agent completion summaries. */
  memoryAdapter?: {
    store(entry: Record<string, unknown>): Promise<{ ok: boolean }>;
  };
  /** Deferred gateway send callback (wired after setupGateway). */
  gatewaySend?: { ref?: (channelId: string, text: string) => boolean };
  /** Optional active run registry for aborting in-flight SDK sessions on kill. */
  activeRunRegistry?: {
    get(sessionKey: string): { abort(): Promise<void> } | undefined;
  };
  /** Optional composite-key resolver for sub-agent abort paths. */
  sessionResolver?: {
    resolveActiveSession(key: { agentId: string; channelType: string; channelId: string }): { abort(): Promise<void> } | undefined;
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
   * Phase 213 (CEIL-01): the tree-wide spawn ceiling consult, threaded into the
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
   * Phase 213 (CR-02): the symmetric release of a slot reserved by
   * {@link checkSpawnCeiling}, threaded into the runner's `releaseSpawnCeiling`
   * so a completed run frees its tree-wide slot (paired 1:1 with the acquire).
   * Bound to `boundedAutonomy.releaseSpawn` by the daemon; absent ⇒ the runner's
   * release is inert (matches an absent `checkSpawnCeiling`).
   */
  releaseSpawnCeiling?: (rootRunId: string) => void;
  /**
   * Phase 216 (DUR-01 / HB-01): the durable-run store + its keep-alive thresholds
   * + the leaseId/budget facts resolver, threaded into the sub-agent runner so it
   * writes a per-root checkpoint at the spawn boundary + a heartbeat on the
   * injected timer. All optional; absent ⇒ the runner's durable path is inert (the
   * byte-identical default). The daemon wires them ONLY when durability is enabled.
   */
  durableRuns?: DurableRunPort;
  durability?: { keepAliveMs: number; staleHeartbeatMs: number };
  durableRunFacts?: (
    rootRunId: string,
    agentId: string,
  ) => { caps: readonly AgentCapability[]; leaseIds: readonly string[]; budgetConsumed: number } | undefined;
  /**
   * Phase 216 (HIGH-2 / ONCE-01..04): the three-state outward-send ledger + the
   * announce-origin rootRunId resolver, threaded into BOTH `createCrossSessionSender`
   * (the announce() ledger wrap, Plan 10 Task 1) AND the announcement dead-letter
   * queue (the drain committed-skip, Plan 10 Task 2) so the completion-announcement
   * outward path is ledgered exactly-once (no restart double-notify). All optional;
   * absent ⇒ both paths are pure pass-throughs (the byte-identical default). The
   * daemon (Plan 12, the sole daemon.ts editor) wires them ONLY when durability is on,
   * reusing the SAME store instances Plan 07 built (one ledger, one durable store).
   */
  outwardLedger?: OutwardSendLedgerPort;
  resolveRootRunId?: (sessionKey: SessionKey) => string;
}): CrossSessionResult {
  const { sessionStore, container, assembleToolsForAgent, getExecutor, adaptersByType } = deps;

  // Build the three callback closures from injected deps.
  const executeInSession = async (
    agentId: string,
    sessionKey: SessionKey,
    text: string,
  ): Promise<{ response: string; tokensUsed: { total: number }; cost: { total: number } }> => {
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
    const tools = await assembleToolsForAgent(agentId);
    const result = await getExecutor(agentId).execute(msg, sessionKey, tools, undefined, agentId);
    return { response: result.response, tokensUsed: result.tokensUsed, cost: result.cost };
  };

  const sendToChannel = async (
    channelType: string,
    channelId: string,
    text: string,
    options?: DeliverToChannelOptions,
  ): Promise<boolean> => {
    deps.logger?.debug({
      channelType,
      channelId,
      textLength: text.length,
      hasOptions: !!options,
    }, "sendToChannel delivery attempt");

    // Gateway messages route through WebSocket push, not adapter lookup
    if (channelType === "gateway" && deps.gatewaySend?.ref) {
      try {
        const ok = deps.gatewaySend.ref(channelId, text);
        deps.logger?.debug({ channelType, channelId, success: ok, gateway: true }, "sendToChannel delivery outcome");
        return ok;
      } catch {
        deps.logger?.debug({ channelType, channelId, success: false, gateway: true }, "sendToChannel delivery outcome");
        return false;
      }
    }
    const adapter = adaptersByType.get(channelType);
    if (!adapter) {
      deps.logger?.debug({ channelType, channelId, success: false, gateway: false }, "sendToChannel delivery outcome: no adapter");
      return false;
    }
    // Delegate to the DeliveryService method form for format + chunk + retry + events.
    const result = await deps.deliveryService.deliverToChannel(adapter, channelId, text, options);
    const success = result.ok && result.value.ok;
    deps.logger?.debug({ channelType, channelId, success, gateway: false }, "sendToChannel delivery outcome");
    if (!result.ok) return false;
    return result.value.ok;
  };

  // executeSubAgent built via setup-cross-session-graph.ts.
  const executeSubAgent = buildExecuteSubAgent({
    container,
    sessionStore: { loadByFormattedKey: (k) => sessionStore.loadByFormattedKey(k) },
    assembleToolsForAgent,
    getExecutor,
    fileLock: deps.fileLock,
    logger: deps.logger,
  });

  // Cross-session sender — fire-and-forget, wait, or ping-pong messaging
  const crossSessionSender = createCrossSessionSender({
    sessionStore: {
      loadByFormattedKey: (key: string) => sessionStore.loadByFormattedKey(key),
      save: (key: SessionKey, messages: unknown[], metadata: Record<string, unknown>) =>
        sessionStore.save(key, messages, metadata),
    },
    executeInSession,
    sendToChannel,
    eventBus: container.eventBus,
    config: container.config.security.agentToAgent,
    // Phase 216 HIGH-2 (ONCE-01/02): the announce() send is routed through the
    // SAME three-state exactly-once ledger as message.send when the durable
    // store + a resolvable rootRunId are wired — a restart-driven re-announce of
    // an already-committed announcement is then a no-op. Absent ⇒ pass-through.
    ...(deps.outwardLedger ? { outwardLedger: deps.outwardLedger } : {}),
    ...(deps.durableRuns ? { durableRuns: deps.durableRuns } : {}),
    ...(deps.resolveRootRunId ? { resolveRootRunId: deps.resolveRootRunId } : {}),
  });

  // Announce to parent session by injecting [System Message] and executing parent agent.
  const announceToParent = async (
    callerAgentId: string,
    callerSessionKey: SessionKey,
    text: string,
    channelType: string,
    channelId: string,
  ): Promise<void> => {
    deps.logger?.debug({
      callerAgentId,
      channelId: callerSessionKey.channelId,
      textLength: text.length,
      channelType,
      targetChannelId: channelId,
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
      const result = await executeInSession(callerAgentId, callerSessionKey, text);
      const trimmed = result.response.trim();
      const isNoReply = !trimmed || trimmed === "NO_REPLY" || trimmed.startsWith("NO_REPLY");
      deps.logger?.debug({
        callerAgentId,
        responseLength: trimmed.length,
        willDeliver: !isNoReply,
        isNoReply,
      }, "announceToParent execution result");
      if (!isNoReply) {
        // Extract thread context from ALS delivery origin so announcements
        // land in the correct Telegram topic / thread.
        const ctx = tryGetContext();
        const threadId = ctx?.deliveryOrigin?.threadId;
        await sendToChannel(channelType, channelId, trimmed, threadId ? { threadId } : undefined);
      }
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
  // AGENTS §2.2: paths via safePath; safePath requires absolute base; fall back to
  // process.cwd() (not banned — only process.env + node:path's join/resolve are).
  const deadLetterFilePath = safePath(container.config.dataDir || process.cwd(), "dead-letters.jsonl");
  const deadLetterQueue = createAnnouncementDeadLetterQueue({
    filePath: deadLetterFilePath,
    maxRetries: 5,
    retryIntervalMs: 60_000,
    maxAgeMs: 3_600_000,
    maxEntries: 100,
    eventBus: container.eventBus,
    logger: deps.logger?.child({ submodule: "dead-letter-queue" }),
    // Phase 216 HIGH-2 (ONCE-03/04): the SAME ledger instance — drain consults it
    // BEFORE re-delivering, so a committed announcement is SKIPPED across a restart
    // (the in-memory deliveredKeys set rebuilds empty on boot; the durable ledger
    // is the authoritative no-double-notify signal). Absent ⇒ legacy at-least-once.
    ...(deps.outwardLedger ? { outwardLedger: deps.outwardLedger } : {}),
  });

  // WR-02/WR-03: ONE bounded delivered-key store shared across every
  // completion-delivery surface — the batcher success path, the no-batcher
  // success branches in deliverAnnouncement, the failure path
  // (deliverFailureNotification), and DLQ recovery (WR-01). A single instance is
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
    // DELIVERY-02: inject the transient/permanent classifier + backoff so the
    // batcher self-heals transient fallback failures (retry-with-backoff) and
    // fast-paths permanent ones to the DLQ. computeRetryBackoff is an
    // intra-package import (daemon owns it); classifyErrorContext comes from
    // @comis/agent — both injected here so the orchestrator never imports either
    // (no dependency inversion). The batcher only ever classifies transport
    // errors, so endReason is bound to "failed".
    classifyErrorContext: (msg: string) => classifyErrorContext(msg, "failed"),
    computeRetryBackoff,
    maxRetries: container.config.security.agentToAgent.delivery.maxRetries,
    eventBus: container.eventBus,
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

  // Create lifecycle hooks for spawn preparation and completion
  const lifecycleHooks = createLifecycleHooks({
    logger: deps.logger
      ? { info: deps.logger.info.bind(deps.logger), warn: deps.logger.warn.bind(deps.logger), debug: deps.logger.debug.bind(deps.logger) }
      : { info: () => {}, warn: () => {}, debug: () => {} },
    eventBus: container.eventBus,
  });

  // Sub-agent runner — async sub-agent spawning with allowlist + auto-archive
  const subAgentRunner = createSubAgentRunner({
    sessionStore: {
      save: (key: SessionKey, messages: unknown[], metadata: Record<string, unknown>) =>
        sessionStore.save(key, messages, metadata),
      delete: (key: SessionKey) => sessionStore.delete(key),
    },
    executeAgent: executeSubAgent,
    sendToChannel,
    announceToParent,
    eventBus: container.eventBus,
    config: container.config.security.agentToAgent,
    // Sandbox no-downgrade posture resolver (SANDBOX-02). The runner is a
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
    activeRunRegistry: deps.activeRunRegistry,
    sessionResolver: deps.sessionResolver,
    resultCondenser,
    condenserModel: condenserApiKey ? { id: condensationResolution.modelId, provider: condensationResolution.provider } as unknown : undefined,
    condenserApiKey: condenserApiKey || undefined,
    narrativeCaster,
    lifecycleHooks,
    deadLetterQueue,
    deliveryDedup,
    clock: deps.clock,
    timers: deps.timers,
    // Phase 213 CEIL-01: the tree-wide spawn ceiling (bound to
    // boundedAutonomy.tryAcquireSpawn by the daemon). Inert when absent.
    ...(deps.checkSpawnCeiling ? { checkSpawnCeiling: deps.checkSpawnCeiling } : {}),
    // Phase 213 CR-02: the symmetric release (boundedAutonomy.releaseSpawn).
    ...(deps.releaseSpawnCeiling ? { releaseSpawnCeiling: deps.releaseSpawnCeiling } : {}),
    // Phase 216 DUR-01/HB-01: the durable checkpoint store + thresholds + facts
    // resolver (the runner writes a per-root checkpoint + heartbeat). Inert when
    // absent (the byte-identical default; the daemon wires these only when on).
    ...(deps.durableRuns ? { durableRuns: deps.durableRuns } : {}),
    ...(deps.durability ? { durability: deps.durability } : {}),
    ...(deps.durableRunFacts ? { durableRunFacts: deps.durableRunFacts } : {}),
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

  return { crossSessionSender, subAgentRunner, sendToChannel, announceToParent, deadLetterQueue, announcementBatcher, proxyTypingCleanup };
}
