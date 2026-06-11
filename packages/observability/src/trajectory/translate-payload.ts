// SPDX-License-Identifier: Apache-2.0
/**
 * Trajectory bridge payload translators (event-specific shape massaging).
 *
 * Extracted from `event-bus-bridge.ts` to keep that module under the
 * file-size cap. `translatePayload` is the exhaustive switch that maps each
 * mapped EventBus payload into the `data` payload of a trajectory event; the
 * `TrajectoryBridgedEventName` union (the switch's exhaustiveness key) and the
 * `TRAJECTORY_BRIDGE_MAPPING` table stay in `event-bus-bridge.ts` (the bridge
 * imports `translatePayload` back from here). No behavior change.
 *
 * SECURITY INVARIANTS are enforced HERE: each translator is the PRIMARY
 * control deciding which payload fields cross into the persisted trajectory.
 * Correlation keys (`traceId`, `agentId`, `sessionKey`, `sessionId`) are
 * envelope-only and MUST NOT be echoed into `data`; verbatim taint strings
 * (`patterns[]`), raw tool arguments (`approval:requested.params`), user
 * identifiers, and message bodies are intentionally omitted. The downstream
 * `sanitizeForPersistence` pass is a defense-in-depth backstop, not a
 * substitute for translator omission.
 *
 * @module
 */

import type { TrajectoryBridgedEventName } from "./event-bus-bridge.js";

/**
 * Translate one EventBus payload into the `data` payload of a trajectory event.
 *
 * Correlation keys (`traceId`, `agentId`, `sessionKey`, `sessionId`) are
 * envelope-only (trajectory envelope shape). Bridge payload translators MUST NOT
 * echo them into `data` — the recorder's envelope already carries them
 * via `TrajectoryRecorderInit` + AsyncLocalStorage.
 */
export function translatePayload(
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
        // D1 provenance forwarding (Phase 153 obs.explain reads it).
        // matchedToken is already sanitized+bounded at the emit (pi-event-bridge),
        // so every field is forwarded verbatim here.
        ...(payload.classifiedFailureBy !== undefined ? { classifiedFailureBy: payload.classifiedFailureBy } : {}),
        ...(payload.transportOk !== undefined ? { transportOk: payload.transportOk } : {}),
        ...(payload.httpStatus !== undefined ? { httpStatus: payload.httpStatus } : {}),
        ...(payload.matchedRule !== undefined ? { matchedRule: payload.matchedRule } : {}),
        ...(payload.matchedToken !== undefined ? { matchedToken: payload.matchedToken } : {}),
        ...(payload.resultBytes !== undefined ? { resultBytes: payload.resultBytes } : {}),
        ...(payload.resultDigest !== undefined ? { resultDigest: payload.resultDigest } : {}),
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

    case "tool:breaker_opened":
      // ids/counts/typed-reason only — errorTag is the breaker's normalized
      // tag, never raw error text (§2.7 / T-151-01).
      return {
        toolName: payload.toolName,
        consecutiveFailures: payload.consecutiveFailures,
        errorTag: payload.errorTag,
        reason: payload.reason,
        seq: payload.seq,
      };

    case "tool:breaker_reset":
      return {
        toolName: payload.toolName,
        reason: payload.reason,
        seq: payload.seq,
      };

    case "tool:result_offloaded":
      // ids/counts + the WORKSPACE-RELATIVE pointer only — never the offloaded
      // result body and never the absolute host path (§2.7 / T-151-05/06).
      return {
        toolName: payload.toolName,
        toolCallId: payload.toolCallId,
        originalChars: payload.originalChars,
        diskPathRel: payload.diskPathRel,
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
        // B3 (D8): forward the stop/finish dispositions presence-conditionally so
        // refusals/length-stops appear on model.completed (no undefined keys —
        // same pattern Phase 150 used for provenance). This is a FIELD-ONLY add
        // to the already-mapped token_usage case (no new mapping key / case).
        ...(payload.stopReason !== undefined ? { stopReason: payload.stopReason } : {}),
        ...(payload.finishReason !== undefined ? { finishReason: payload.finishReason } : {}),
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

    case "session:summary":
      // Counts/flags ONLY — agentId/sessionKey/traceId are envelope
      // correlation ids handled separately, never in the record data (§2.7).
      return {
        degraded: payload.degraded,
        turnCount: payload.turnCount,
        costUsd: payload.costUsd,
        toolStats: payload.toolStats,
        breakerTripCount: payload.breakerTripCount,
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
      // stripped — the trajectory envelope carries them
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

    // ---- Queue lifecycle ----
    // sessionKey is envelope-only — stripped from data.

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

    // ---- Execution control ----
    // agentId and sessionKey are envelope-only — stripped from data.

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
      // LAT-04 (177): stall/makespan attribution fields forward verbatim — the
      // emit site is content-free (numbers + closed enums + the config-KEY
      // bindingKnob string, never delta text or env values; I7). The signals
      // reader (obs-explain-signals.ts) safeParses the row wholesale, so the
      // explain verdict can name the binding knob with the actual numbers.
      // agentId/sessionKey/timestamp are envelope-only and stripped.
      return {
        timeoutMs: payload.timeoutMs,
        ...(payload.durationMs !== undefined ? { durationMs: payload.durationMs } : {}),
        ...(payload.limit !== undefined ? { limit: payload.limit } : {}),
        ...(payload.source !== undefined ? { source: payload.source } : {}),
        ...(payload.bindingKnob !== undefined ? { bindingKnob: payload.bindingKnob } : {}),
        ...(payload.operationType !== undefined ? { operationType: payload.operationType } : {}),
        ...(payload.stallBudgetMs !== undefined ? { stallBudgetMs: payload.stallBudgetMs } : {}),
        ...(payload.makespanMs !== undefined ? { makespanMs: payload.makespanMs } : {}),
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

    case "execution:tool_schema_unsupported":
      // GBNF-02 strip-retry self-heal. The emit site is already content-free
      // (tool + keyword NAMES only, never schema bodies — I7), so all five
      // diagnostic fields forward verbatim — `reason` (WR-05) is the closed
      // branch discriminator (stripped | nothing_to_strip | gate_closed) that
      // keeps the two terminal branches distinguishable in obs verdicts.
      // agentId/sessionKey/timestamp are envelope-only and stripped.
      return {
        toolNames: payload.toolNames,
        strippedKeywords: payload.strippedKeywords,
        retried: payload.retried,
        succeeded: payload.succeeded,
        reason: payload.reason,
      };

    // ---- Security + Sender (scanned subset) ----
    // SECURITY INVARIANT: patterns[] (verbatim injection strings) and
    // senderId (user identifier) are intentionally NOT forwarded.
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

    // ---- Delivery retry ----
    // SECURITY INVARIANT: chatId (Telegram long-decimal ID) and
    // channelId are intentionally NOT forwarded. Only retry telemetry enters the
    // trajectory. sanitizeForPersistence is a defense-in-depth backstop for the
    // error strings, but translator omission is the primary control.

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

    // ---- MCP server reliability ----
    // serverName + connection telemetry. lastError and reason are
    // connection-error strings — low PII risk; bounded by payload limiter.

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

    // ---- Channel lifecycle + health ----
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

    // ---- Security rest (non-scanned subset) ----
    // SECURITY INVARIANT: patterns[] (verbatim taint strings) and
    // message (may reference secret names/config paths) are intentionally
    // NOT forwarded. sanitizeForPersistence is a defense-in-depth backstop.

    case "security:memory_tainted":
      // patterns[] must NEVER be forwarded — they are verbatim injection strings.
      // Only trust levels + blocked flag enter the trajectory.
      return {
        originalTrustLevel: payload.originalTrustLevel,
        adjustedTrustLevel: payload.adjustedTrustLevel,
        blocked: payload.blocked,
      };

    case "security:warn":
      // message may contain diagnostic text referencing secret names or config paths.
      // Only category enters the trajectory.
      return {
        category: payload.category,
      };

    // ---- Compaction signals ----
    // agentId and sessionKey are envelope-only — stripped from data.

    case "compaction:started":
      // All source fields (agentId, sessionKey, timestamp) are envelope-only.
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

    // ---- Context engine internals ----
    // agentId and sessionKey are envelope-only — stripped from data.
    // Content fields (message bodies, raw text) are NOT in any of these payloads;
    // only counts, sizes, and category tags are forwarded.

    case "context:budget_computed":
      // The full budget equation — token counts + closed unions only, no content.
      return {
        windowTokens: payload.windowTokens,
        rawContextWindowTokens: payload.rawContextWindowTokens,
        windowCapSource: payload.windowCapSource,
        systemTokens: payload.systemTokens,
        freshTailTokens: payload.freshTailTokens,
        budgetedHistoryTokens: payload.budgetedHistoryTokens,
        keptCount: payload.keptCount,
        assembledInputTokens: payload.assembledInputTokens,
        outputHeadroom: payload.outputHeadroom,
        verdict: payload.verdict,
      };

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

    // ---- Approval / human-in-the-loop ----
    // SECURITY INVARIANT: approval:requested.params is raw unconstrained
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

    // ---- Dedup ----
    // firstSeenAt and duplicateAt are intentionally omitted — envelope ts covers timing.
    // chatId redaction is handled at the bundle boundary.

    case "dedup:duplicate_inbound":
      return {
        messageId: payload.messageId,
        channelType: payload.channelType,
        chatId: payload.chatId,
        deltaMs: payload.deltaMs,
        source: payload.source,
      };

    // ---- Health budget ----
    // timestamp is envelope-only — stripped from data.
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
