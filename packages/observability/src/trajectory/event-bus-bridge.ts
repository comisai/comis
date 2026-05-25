// SPDX-License-Identifier: Apache-2.0
/**
 * Trajectory event-bus bridge.
 *
 * Subscribes to the typed `EventBus` and translates each mapped event
 * into a trajectory `recordEvent` call. The bridge avoids N call-site
 * instrumentations — one subscription per session is the entire surface.
 *
 * The mapping is declared as a single `TRAJECTORY_BRIDGE_MAPPING`
 * record so the architecture test (`trajectory-event-types-known.test.ts`)
 * can enumerate it at test time. Every EventBus emit site in
 * `packages/agent` and `packages/orchestrator` whose name is in
 * `EventMap` (compile-time enforced) must EITHER appear as a key here
 * OR appear in the `EVENTS_NOT_TRAJECTORY_MAPPED` allowlist
 * (defined in the architecture test).
 *
 * Dedup contract:
 *   - `tool:executed{errorKind:"timeout"}` AND `tool:timeout` are
 *     BOTH mapped. They share `toolCallId` — downstream consumers
 *     join on that key to dedupe. The architecture test enforces
 *     both events have entries in this table.
 *   - `model:lkw_fallback_attempt` AND `model:fallback_attempt` both
 *     map to `model.fallback_attempt`; the LKW variant emits a
 *     `data.lkw: true` flag so the trajectory consumer can
 *     distinguish.
 *
 * @module
 */

import type { EventMap, TypedEventBus } from "@comis/core";

import type { TrajectoryEventType, TrajectoryRecorder } from "./types.js";

// ---------------------------------------------------------------------------
// Mapping table (EventName → TrajectoryEventType)
// ---------------------------------------------------------------------------

/**
 * Bridge mapping table — keys are `EventMap` event names that the bridge
 * translates into trajectory events. Architecture test enumerates this.
 *
 * NOTE: events not in this table AND not explicitly allowlisted (in the
 * architecture test's `EVENTS_NOT_TRAJECTORY_MAPPED` set) will fail the
 * architecture test if used at an `eventBus.emit(...)` site. Add new
 * entries here when wiring a new EventMap event into the trajectory.
 */
export const TRAJECTORY_BRIDGE_MAPPING = {
  // ---- Tool lifecycle ----
  "tool:started": "tool.call",
  "tool:executed": "tool.result",
  "tool:timeout": "tool.timeout",
  "tool:policy_filtered": "tool.policy_filtered",

  // ---- Model lifecycle ----
  // `observability:token_usage` is reused as `model.completed` — the
  // token-usage event already carries everything the trajectory needs
  // for a model-completed record. `model:fallback_attempt` and the LKW
  // variant both map to `model.fallback_attempt`; the LKW variant
  // attaches `lkw: true`.
  "observability:token_usage": "model.completed",
  "model:fallback_attempt": "model.fallback_attempt",
  "model:lkw_fallback_attempt": "model.fallback_attempt",
  "model:fallback_exhausted": "model.fallback_exhausted",
  "model:auth_cooldown": "model.auth_cooldown",

  // ---- Skill observability ----
  "skill:prompt_loaded": "skill.prompt_loaded",
  "skill:prompt_invoked": "skill.prompt_invoked",

  // ---- Session + prompt lifecycle ----
  "prompt:submitted": "prompt.submitted",
  "session:started": "session.started",
  "session:ended": "session.ended",
  "memory:injected": "memory.injected",

  // ---- Delivery lifecycle ----
  "delivery:enqueued": "delivery.queued",
  "delivery:complete": "delivery.dispatched",

  // ---- Context engine ----
  // Context pipeline runs once per turn (pre-LLM context assembly).
  // Mapping table entry: "(executor) prompt assembled (or context layer)
  // → context.compiled". The post-LLM `context:pipeline:cache` patch
  // event is NOT mapped here; its cache fields land in this initial
  // pipeline snapshot at emit time (the producer reuses the same
  // payload-fence semantics for both events).
  "context:pipeline": "context.compiled",

  // ---- Queue / Execution / Sender (D6) ----
  // BRIDGE-01: Queue lifecycle — events-channel.ts
  "queue:enqueued": "queue.enqueued",
  "queue:dequeued": "queue.dequeued",
  "queue:overflow": "queue.overflow",
  "queue:coalesced": "queue.coalesced",

  // BRIDGE-03: Execution control — events-messaging.ts
  "execution:aborted": "execution.aborted",
  "execution:budget_warning": "execution.budget_warning",
  "execution:prompt_timeout": "execution.prompt_timeout",
  "execution:output_escalated": "execution.output_escalated",
  // Maps to "execution.replay_recovered" (NOT "execution.signed_replay_recovered")
  // per research table canonical name (design §13 Appendix B).
  "execution:signed_replay_recovered": "execution.replay_recovered",

  // BRIDGE-04 (scanned subset): Security + Sender
  // patterns[] and senderId are intentionally omitted in translatePayload (L4/L2).
  "security:injection_detected": "security.injection_detected",
  "sender:blocked": "sender.blocked",

  // BRIDGE-02: Delivery retry (events-channel.ts; emitter packages/core/delivery — not arch-scanned)
  // chatId (Telegram long-decimal ID, L3) and channelId are intentionally omitted (T-02-09).
  "retry:attempted": "delivery.retry",
  "retry:exhausted": "delivery.retry_exhausted",
  "retry:markdown_fallback": "delivery.markdown_fallback",

  // BRIDGE-05: MCP server reliability (events-infra.ts; emitter packages/skills — not arch-scanned)
  "mcp:server:disconnected": "mcp.disconnected",
  "mcp:server:reconnecting": "mcp.reconnecting",
  "mcp:server:reconnect_failed": "mcp.reconnect_failed",
  "mcp:server:reconnected": "mcp.reconnected",
  "mcp:server:tools_changed": "mcp.tools_changed",

  // BRIDGE-06: Channel lifecycle + health (events-channel.ts; emitter packages/channels — not arch-scanned)
  // Both channel:registered and channel:deregistered map to the same trajectory type.
  // Translator adds a synthetic `event` discriminator: "registered" | "deregistered".
  // Precedent: model:fallback_attempt + model:lkw_fallback_attempt share model.fallback_attempt.
  "channel:health_changed": "channel.health_changed",
  "channel:registered": "channel.lifecycle",
  "channel:deregistered": "channel.lifecycle",

  // BRIDGE-04 rest: Security (non-scanned emitters — packages/daemon + packages/core/security)
  // SECURITY INVARIANT: patterns[] (verbatim taint strings — L4) and message (may reference
  // secret names/config paths — L5) are intentionally NOT forwarded.
  "security:memory_tainted": "security.memory_tainted",
  "security:warn": "security.warn",

  // BRIDGE-07: Compaction signals (events-messaging.ts; emitters in packages/agent — arch-scanned)
  // All 3 are in EVENTS_NOT_TRAJECTORY_MAPPED and must be removed when bridged (L7).
  "compaction:started": "compaction.started",
  "compaction:flush": "compaction.flush",
  "compaction:recommended": "compaction.recommended",

  // BRIDGE-07: Context engine internals (events-messaging.ts; emitters in packages/agent — arch-scanned)
  // 5 of 6 are in EVENTS_NOT_TRAJECTORY_MAPPED and must be removed when bridged.
  // context:integrity uses optional chaining (?.emit) — not in arch-test scope; no allowlist change needed.
  "context:evicted": "context.evicted",
  "context:masked": "context.masked",
  "context:reread": "context.reread",
  "context:overflow": "context.overflow",
  "context:integrity": "context.integrity",
  "context:rehydrated": "context.rehydrated",

  // BRIDGE-08: Approval / human-in-the-loop (events-infra.ts; emitter packages/core/approval — not arch-scanned)
  // SECURITY INVARIANT (T-02-11): approval:requested.params is raw unconstrained tool arguments
  // (file paths, message bodies, credentials — HIGHEST risk field in the phase, L2).
  // Translator MUST omit params entirely — sanitizeForPersistence is defense-in-depth only.
  "approval:requested": "approval.requested",
  "approval:resolved": "approval.resolved",

  // DEDUP-03 (D12): Duplicate inbound detection (events-channel.ts; emitter packages/orchestrator — arch-scanned)
  // firstSeenAt and duplicateAt omitted by translator — envelope ts covers timing (design §13 Appendix B).
  "dedup:duplicate_inbound": "dedup.duplicate_inbound",

  // ALERT-01 (D16): Health budget exceeded (events-infra.ts; emitter packages/observability/health-aggregator)
  // timestamp is envelope-only per design §6.2 — stripped from data.
  "health:budget_exceeded": "health.budget_exceeded",
} as const satisfies Record<string, TrajectoryEventType>;

/**
 * Closed string union of every EventBus event name the bridge maps.
 * Useful for callers that want to type-narrow without re-listing.
 */
export type TrajectoryBridgedEventName = keyof typeof TRAJECTORY_BRIDGE_MAPPING;

// ---------------------------------------------------------------------------
// Attach
// ---------------------------------------------------------------------------

/** Parameters for `attachTrajectoryToEventBus`. */
export interface AttachTrajectoryParams {
  /** Typed event bus to subscribe to. */
  readonly eventBus: TypedEventBus;
  /** Per-session recorder built by `createTrajectoryRecorder`. */
  readonly recorder: TrajectoryRecorder;
  /**
   * Optional filter: when present, only event names that pass the
   * predicate are subscribed. The predicate runs ONCE per event name
   * at attach time — it does not run per event emit.
   */
  readonly filter?: (eventName: TrajectoryBridgedEventName) => boolean;
}

/**
 * Subscribe the bridge to the given event bus. Returns a single
 * `unsubscribe` function that removes every handler registered by
 * this call.
 *
 * Per-session lifecycle: pi-executor calls this once after `formattedKey`
 * materializes; the returned `unsubscribe()` runs in the `try/finally`
 * covering the runner block.
 */
export function attachTrajectoryToEventBus(
  params: AttachTrajectoryParams,
): () => void {
  const { eventBus, recorder, filter } = params;

  // Per-handler bag so unsubscribe can pop them all in one call.
  const subscriptions: Array<{
    eventName: TrajectoryBridgedEventName;
    handler: (payload: unknown) => void;
  }> = [];

  // Type assertion narrowing: the as-const mapping makes Object.entries
  // lose precision, so iterate over the typed keys instead.
  for (const eventName of Object.keys(TRAJECTORY_BRIDGE_MAPPING) as Array<TrajectoryBridgedEventName>) {
    if (filter !== undefined && !filter(eventName)) continue;

    const handler = (payload: unknown) => {
      const data = translatePayload(eventName, payload);
      const trajectoryType = TRAJECTORY_BRIDGE_MAPPING[eventName];
      recorder.recordEvent(trajectoryType, data);
    };

    // The `on` overload requires a typed handler per event key. Cast
    // here at the trust boundary: handler is typed against `unknown`
    // and translatePayload narrows internally.
    (eventBus as TypedEventBus).on(
      eventName as keyof EventMap,
      handler as (payload: EventMap[keyof EventMap]) => void,
    );
    subscriptions.push({ eventName, handler });
  }

  return function unsubscribe(): void {
    for (const sub of subscriptions) {
      eventBus.off(
        sub.eventName as keyof EventMap,
        sub.handler as (payload: EventMap[keyof EventMap]) => void,
      );
    }
    subscriptions.length = 0;
  };
}

// ---------------------------------------------------------------------------
// Payload translators (event-specific shape massaging)
// ---------------------------------------------------------------------------

/**
 * Translate one EventBus payload into the `data` payload of a trajectory event.
 *
 * Correlation keys (`traceId`, `agentId`, `sessionKey`, `sessionId`) are
 * envelope-only per design §6.2. Bridge payload translators MUST NOT
 * echo them into `data` — the recorder's envelope already carries them
 * via `TrajectoryRecorderInit` + AsyncLocalStorage.
 */
function translatePayload(
  eventName: TrajectoryBridgedEventName,
  rawPayload: unknown,
): Record<string, unknown> {
  const payload = rawPayload as Record<string, unknown>;

  switch (eventName) {
    case "tool:started":
      return {
        toolName: payload.toolName,
        toolCallId: payload.toolCallId,
        ...(payload.description !== undefined ? { description: payload.description } : {}),
      };

    case "tool:executed":
      return {
        toolName: payload.toolName,
        toolCallId: payload.toolCallId,
        durationMs: payload.durationMs,
        success: payload.success,
        ...(payload.errorKind !== undefined ? { errorKind: payload.errorKind } : {}),
        ...(payload.errorMessage !== undefined ? { errorMessage: payload.errorMessage } : {}),
        ...(payload.truncated !== undefined ? { truncated: payload.truncated } : {}),
      };

    case "tool:timeout":
      return {
        toolName: payload.toolName,
        toolCallId: payload.toolCallId,
        timeoutMs: payload.timeoutMs,
      };

    case "tool:policy_filtered":
      return {
        profile: payload.profile,
        filtered: payload.filtered,
      };

    case "observability:token_usage": {
      // EventMap shape: { tokens: { prompt, completion, total }, cost, latencyMs, ... }
      // Trajectory model.completed shape: inputTokens/outputTokens/cacheReadTokens/
      // cacheCreationTokens/durationMs.
      const tokens = payload.tokens as { prompt: number; completion: number; total: number };
      return {
        provider: payload.provider,
        modelId: payload.model,
        inputTokens: tokens.prompt,
        outputTokens: tokens.completion,
        cacheReadTokens: payload.cacheReadTokens,
        cacheCreationTokens: payload.cacheWriteTokens,
        durationMs: payload.latencyMs,
      };
    }

    case "model:fallback_attempt":
      return {
        fromProvider: payload.fromProvider,
        fromModel: payload.fromModel,
        toProvider: payload.toProvider,
        toModel: payload.toModel,
        error: payload.error,
        attemptNumber: payload.attemptNumber,
      };

    case "model:lkw_fallback_attempt":
      return {
        lkw: true,
        fromProvider: payload.fromProvider,
        fromModel: payload.fromModel,
        toProvider: payload.toProvider,
        toModel: payload.toModel,
      };

    case "model:fallback_exhausted":
      return {
        provider: payload.provider,
        model: payload.model,
        totalAttempts: payload.totalAttempts,
      };

    case "model:auth_cooldown":
      return {
        keyName: payload.keyName,
        provider: payload.provider,
        cooldownMs: payload.cooldownMs,
        failureCount: payload.failureCount,
      };

    case "skill:prompt_loaded":
      return {
        skillName: payload.skillName,
        source: payload.source,
        bodyLength: payload.bodyLength,
      };

    case "skill:prompt_invoked":
      return {
        skillName: payload.skillName,
        invokedBy: payload.invokedBy,
        args: payload.args,
      };

    case "prompt:submitted":
      return {
        promptChars: payload.promptChars,
        provider: payload.provider,
        modelId: payload.modelId,
        messageCount: payload.messageCount,
        systemDigest: payload.systemDigest,
        messagesDigest: payload.messagesDigest,
      };

    case "session:started":
      return {
        channelType: payload.channelType,
        channelId: payload.channelId,
        ...(payload.accountId !== undefined ? { accountId: payload.accountId } : {}),
      };

    case "session:ended":
      return {
        totalTurns: payload.totalTurns,
        totalInputTokens: payload.totalInputTokens,
        totalOutputTokens: payload.totalOutputTokens,
        durationMs: payload.durationMs,
        exitReason: payload.exitReason,
      };

    case "memory:injected":
      return {
        hitCount: payload.hitCount,
        charsInjected: payload.charsInjected,
        trustTags: payload.trustTags,
      };

    case "delivery:enqueued":
      return {
        entryId: payload.entryId,
        channelType: payload.channelType,
        channelId: payload.channelId,
        origin: payload.origin,
      };

    case "delivery:complete": {
      const totalChunks = (payload.totalChunks as number) ?? 0;
      const deliveredChunks = (payload.deliveredChunks as number) ?? 0;
      const failedChunks = (payload.failedChunks as number) ?? 0;
      let status: "success" | "partial" | "failure";
      if (failedChunks === 0 && deliveredChunks === totalChunks && totalChunks > 0) {
        status = "success";
      } else if (deliveredChunks > 0) {
        status = "partial";
      } else {
        status = "failure";
      }
      return {
        entryId: payload.entryId,
        channelType: payload.channelType,
        channelId: payload.channelId,
        origin: payload.origin,
        strategy: payload.strategy,
        totalChunks,
        deliveredChunks,
        failedChunks,
        totalChars: payload.totalChars,
        durationMs: payload.durationMs,
        status,
      };
    }

    case "context:pipeline":
      // Envelope-only correlation keys (agentId, sessionKey) intentionally
      // stripped per design §6.2. The trajectory envelope carries them
      // via TrajectoryRecorderInit + AsyncLocalStorage.
      return {
        tokensLoaded: payload.tokensLoaded,
        tokensEvicted: payload.tokensEvicted,
        tokensMasked: payload.tokensMasked,
        tokensCompacted: payload.tokensCompacted,
        thinkingBlocksRemoved: payload.thinkingBlocksRemoved,
        budgetUtilization: payload.budgetUtilization,
        evictionCategories: payload.evictionCategories,
        rereadCount: payload.rereadCount,
        rereadTools: payload.rereadTools,
        sessionDepth: payload.sessionDepth,
        sessionToolResults: payload.sessionToolResults,
        cacheHitTokens: payload.cacheHitTokens,
        cacheWriteTokens: payload.cacheWriteTokens,
        cacheMissTokens: payload.cacheMissTokens,
        ...(payload.cacheFenceIndex !== undefined ? { cacheFenceIndex: payload.cacheFenceIndex } : {}),
        durationMs: payload.durationMs,
        layerCount: payload.layerCount,
        layers: payload.layers,
      };

    // ---- Queue lifecycle (BRIDGE-01) ----
    // sessionKey is envelope-only per design §6.2 — stripped from data.

    case "queue:enqueued":
      return {
        channelType: payload.channelType,
        queueDepth: payload.queueDepth,
        mode: payload.mode,
      };

    case "queue:dequeued":
      return {
        channelType: payload.channelType,
        waitTimeMs: payload.waitTimeMs,
      };

    case "queue:overflow":
      return {
        channelType: payload.channelType,
        policy: payload.policy,
        droppedCount: payload.droppedCount,
      };

    case "queue:coalesced":
      return {
        channelType: payload.channelType,
        messageCount: payload.messageCount,
      };

    // ---- Execution control (BRIDGE-03) ----
    // agentId and sessionKey are envelope-only per design §6.2 — stripped from data.

    case "execution:aborted":
      return {
        reason: payload.reason,
      };

    case "execution:budget_warning":
      return {
        totalTokens: payload.totalTokens,
        llmCallCount: payload.llmCallCount,
        projectedCallsLeft: payload.projectedCallsLeft,
      };

    case "execution:prompt_timeout":
      return {
        timeoutMs: payload.timeoutMs,
      };

    case "execution:output_escalated":
      return {
        originalMaxTokens: payload.originalMaxTokens,
        escalatedMaxTokens: payload.escalatedMaxTokens,
      };

    case "execution:signed_replay_recovered":
      return {
        blocksRemoved: payload.blocksRemoved,
        thoughtSignaturesStripped: payload.thoughtSignaturesStripped,
        succeeded: payload.succeeded,
      };

    // ---- Security + Sender (BRIDGE-04 scanned subset) ----
    // SECURITY INVARIANT: patterns[] (verbatim injection strings — L4) and
    // senderId (user identifier — L4/L2) are intentionally NOT forwarded.
    // sanitizeForPersistence is a defense-in-depth backstop but the
    // translator is the primary control.

    case "security:injection_detected":
      // patterns[] must NEVER be forwarded — they are verbatim attacker
      // injection strings. Only source + riskLevel enter the trajectory.
      return {
        source: payload.source,
        riskLevel: payload.riskLevel,
      };

    case "sender:blocked":
      // senderId (user identifier) and channelId must NEVER be forwarded.
      // Only channelType enters the trajectory.
      return {
        channelType: payload.channelType,
      };

    // ---- Delivery retry (BRIDGE-02) ----
    // SECURITY INVARIANT (T-02-09): chatId (Telegram long-decimal ID, L3) and
    // channelId are intentionally NOT forwarded. Only retry telemetry enters the
    // trajectory. sanitizeForPersistence is a defense-in-depth backstop for the
    // error strings (BOUND-01), but translator omission is the primary control.

    case "retry:attempted":
      return {
        attempt: payload.attempt,
        maxAttempts: payload.maxAttempts,
        delayMs: payload.delayMs,
        error: payload.error,
      };

    case "retry:exhausted":
      return {
        totalAttempts: payload.totalAttempts,
        finalError: payload.finalError,
      };

    case "retry:markdown_fallback":
      return {
        originalParseMode: payload.originalParseMode,
      };

    // ---- MCP server reliability (BRIDGE-05) ----
    // serverName + connection telemetry. lastError and reason are
    // connection-error strings — low PII risk; bounded by BOUND-01.

    case "mcp:server:disconnected":
      return {
        serverName: payload.serverName,
        reason: payload.reason,
      };

    case "mcp:server:reconnecting":
      return {
        serverName: payload.serverName,
        attempt: payload.attempt,
        maxAttempts: payload.maxAttempts,
        nextDelayMs: payload.nextDelayMs,
      };

    case "mcp:server:reconnect_failed":
      return {
        serverName: payload.serverName,
        attempts: payload.attempts,
        lastError: payload.lastError,
      };

    case "mcp:server:reconnected":
      return {
        serverName: payload.serverName,
        attempt: payload.attempt,
        toolCount: payload.toolCount,
        durationMs: payload.durationMs,
      };

    case "mcp:server:tools_changed":
      return {
        serverName: payload.serverName,
        previousToolCount: payload.previousToolCount,
        currentToolCount: payload.currentToolCount,
        addedTools: payload.addedTools,
        removedTools: payload.removedTools,
      };

    // ---- Channel lifecycle + health (BRIDGE-06) ----
    // lastMessageAt and timestamp are noise — omitted.
    // error on channel:health_changed may be null — conditional spread only
    // when non-null (match the tool:executed convention for nullable fields).

    case "channel:health_changed":
      return {
        channelType: payload.channelType,
        previousState: payload.previousState,
        currentState: payload.currentState,
        connectionMode: payload.connectionMode,
        ...(payload.error !== null ? { error: payload.error } : {}),
      };

    case "channel:registered":
      // capabilities is omitted (metadata with no diagnostic value for trajectory).
      // Synthetic `event` field distinguishes this from channel:deregistered (both
      // map to channel.lifecycle per the dual-mapping pattern).
      return {
        channelType: payload.channelType,
        pluginId: payload.pluginId,
        event: "registered",
      };

    case "channel:deregistered":
      return {
        channelType: payload.channelType,
        pluginId: payload.pluginId,
        event: "deregistered",
      };

    // ---- Security rest (BRIDGE-04 non-scanned subset) ----
    // SECURITY INVARIANT: patterns[] (verbatim taint strings, L4) and
    // message (may reference secret names/config paths, L5) are intentionally
    // NOT forwarded. sanitizeForPersistence is a defense-in-depth backstop.

    case "security:memory_tainted":
      // patterns[] must NEVER be forwarded — they are verbatim injection strings (L4).
      // Only trust levels + blocked flag enter the trajectory.
      return {
        originalTrustLevel: payload.originalTrustLevel,
        adjustedTrustLevel: payload.adjustedTrustLevel,
        blocked: payload.blocked,
      };

    case "security:warn":
      // message may contain diagnostic text referencing secret names or config paths (L5).
      // Only category enters the trajectory.
      return {
        category: payload.category,
      };

    // ---- Compaction signals (BRIDGE-07) ----
    // agentId and sessionKey are envelope-only per design §6.2 — stripped from data.

    case "compaction:started":
      // All source fields (agentId, sessionKey, timestamp) are envelope-only (L6).
      // Return empty object — event is a pure lifecycle signal; type is the diagnostic.
      return {};

    case "compaction:flush":
      return {
        memoriesWritten: payload.memoriesWritten,
        trigger: payload.trigger,
        success: payload.success,
      };

    case "compaction:recommended":
      return {
        contextPercent: payload.contextPercent,
        contextTokens: payload.contextTokens,
        contextWindow: payload.contextWindow,
      };

    // ---- Context engine internals (BRIDGE-07) ----
    // agentId and sessionKey are envelope-only per design §6.2 — stripped from data.
    // Content fields (message bodies, raw text) are NOT in any of these payloads;
    // only counts, sizes, and category tags are forwarded.

    case "context:evicted":
      return {
        evictedCount: payload.evictedCount,
        evictedChars: payload.evictedChars,
        categories: payload.categories,
      };

    case "context:masked":
      return {
        maskedCount: payload.maskedCount,
        totalChars: payload.totalChars,
        persistedToDisk: payload.persistedToDisk,
      };

    case "context:reread":
      return {
        rereadCount: payload.rereadCount,
        rereadTools: payload.rereadTools,
      };

    case "context:overflow":
      return {
        contextTokens: payload.contextTokens,
        budgetTokens: payload.budgetTokens,
        recoveryAction: payload.recoveryAction,
      };

    case "context:integrity":
      // conversationId is the DAG conversation identifier — not an envelope field.
      // agentId + sessionKey remain envelope-only and are stripped.
      return {
        conversationId: payload.conversationId,
        issueCount: payload.issueCount,
        repairsApplied: payload.repairsApplied,
        errorsLogged: payload.errorsLogged,
        issueTypes: payload.issueTypes,
        durationMs: payload.durationMs,
      };

    case "context:rehydrated":
      return {
        sectionsInjected: payload.sectionsInjected,
        filesInjected: payload.filesInjected,
        skillsInjected: payload.skillsInjected,
        overflowStripped: payload.overflowStripped,
      };

    // ---- Approval / human-in-the-loop (BRIDGE-08) ----
    // SECURITY INVARIANT (T-02-11): approval:requested.params is raw unconstrained
    // tool arguments — file paths, message bodies, or credentials. MUST be omitted
    // entirely. agentId, sessionKey, createdAt are envelope-only — stripped from data.
    // channelType is optional on the source event — conditional spread.
    // approval:resolved.reason is optional — conditional spread.
    // resolvedAt is envelope noise — stripped from data.

    case "approval:requested":
      return {
        requestId: payload.requestId,
        toolName: payload.toolName,
        action: payload.action,
        trustLevel: payload.trustLevel,
        timeoutMs: payload.timeoutMs,
        ...(payload.channelType !== undefined ? { channelType: payload.channelType } : {}),
      };

    case "approval:resolved":
      return {
        requestId: payload.requestId,
        approved: payload.approved,
        approvedBy: payload.approvedBy,
        ...(payload.reason !== undefined ? { reason: payload.reason } : {}),
      };

    // ---- Dedup (DEDUP-03 / D12) ----
    // firstSeenAt and duplicateAt are intentionally omitted — envelope ts covers timing
    // per design §13 Appendix B. chatId redaction is the Phase 5 bundle-boundary concern.

    case "dedup:duplicate_inbound":
      return {
        messageId: payload.messageId,
        channelType: payload.channelType,
        chatId: payload.chatId,
        deltaMs: payload.deltaMs,
        source: payload.source,
      };

    // ---- Health budget (ALERT-01) ----
    // timestamp is envelope-only per design §6.2 — stripped from data.
    case "health:budget_exceeded":
      return {
        kind: payload.kind,
        count: payload.count,
        windowMs: payload.windowMs,
      };

    default: {
      // Exhaustiveness — switch covers every TrajectoryBridgedEventName.
      // If a new bridge entry is added without a translator, TypeScript
      // flags this branch.
      const _exhaustive: never = eventName;
      void _exhaustive;
      return payload;
    }
  }
}
