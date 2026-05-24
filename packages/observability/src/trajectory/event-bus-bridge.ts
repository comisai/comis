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
