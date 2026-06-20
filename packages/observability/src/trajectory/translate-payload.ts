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
import { translateCacheBreakPayload } from "./translate-cache-break-payload.js";
import { translateImagePayload } from "./translate-image-payload.js";
import { translateOrchestrationPayload } from "./translate-orchestration-payload.js";
import { translateVideoPayload } from "./translate-video-payload.js";
import { translateVisionPayload } from "./translate-vision-payload.js";
import { translateVoicePayload } from "./translate-voice-payload.js";

/**
 * Translate one EventBus payload into the `data` payload of a trajectory event.
 *
 * Correlation keys (`traceId`, `agentId`, `sessionKey`, `sessionId`) are envelope-only;
 * translators MUST NOT echo them into `data` (the recorder envelope carries them via
 * `TrajectoryRecorderInit` + AsyncLocalStorage).
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
        // refusals/length-stops appear on model.completed (no undefined keys). A FIELD-ONLY
        // add to the already-mapped token_usage case (no new mapping key / case).
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

    case "memory:recalled":
      // RECALL-01: per-recall lane/candidate/final counts (the #1 blind spot, now on
      // the explain/trace timeline). Counts/booleans ONLY — never query text or memory
      // bodies; agentId/sessionKey/traceId are envelope correlation ids (§2.7 / H1).
      return {
        lanes: payload.lanes,
        ftsCandidates: payload.ftsCandidates,
        vectorCandidates: payload.vectorCandidates,
        entityCandidates: payload.entityCandidates,
        finalCount: payload.finalCount,
        rerankerAvailable: payload.rerankerAvailable,
        durationMs: payload.durationMs,
      };

    case "memory:reranked":
      // RECALL-01: rerank candidate/hit counts + the graceful-degradation flags
      // (timedOut/fellBack) — counts/booleans ONLY (§2.7 / H1).
      return {
        candidateCount: payload.candidateCount,
        hitCount: payload.hitCount,
        rerankerAvailable: payload.rerankerAvailable,
        timedOut: payload.timedOut,
        fellBack: payload.fellBack,
        durationMs: payload.durationMs,
      };

    case "memory:generation_quality":
      // GENQ-01: which pass + the source/output dominant scripts + the issue flags.
      // Closed enums + booleans ONLY — never the source or generated body; agentId/
      // sessionKey are envelope correlation ids (§2.7 / H1).
      return {
        pass: payload.pass,
        sourceScript: payload.sourceScript,
        outputScript: payload.outputScript,
        languageMismatch: payload.languageMismatch,
        emptyOutput: payload.emptyOutput,
        formatViolation: payload.formatViolation,
      };

    // PERSIST-01 (+AUDIT-05 est-$): content-free reason/counts/digest + computed est-$;
    // delegated to translate-cache-break-payload.ts (file-size split).
    case "observability:cache_break":
      return translateCacheBreakPayload(payload);

    // ---- v2.27 authoring / sub-agent orchestration (TELEM-01 + AUTHOR-01/02 + STEER-01) ---- delegated to translate-orchestration-payload.ts (file-size split, Phase 175; content-free + envelope-stripped — closed enums + numbers/booleans + a run id ONLY, never a graph body, the synthesis INTENT TEXT, or the steer MESSAGE BODY; §2.7 / H1).
    // ORCH-OBS appends three previously-dark sub-agent-lifecycle events (sandbox-downgrade
    // refusal / dead-lettered delivery / per-node budget breach) to the SAME content-free,
    // orchestration-translator-delegated group.
    case "pipeline:authored":
    case "graph:repaired":
    case "graph:synthesized_from_intent":
    case "subagent:steered":
    case "security:sandbox_downgrade_refused":
    case "subagent:delivery_deadlettered":
    case "subagent:budget_exceeded":
      return translateOrchestrationPayload(eventName, payload);

    case "learning:outcome_observed": // OUTCOME-08: trajectoryId + closed-enum outcome/source + numeric confidence ONLY (no body/alpha/recalled ids; agentId/sessionKey/traceId envelope-only — §2.7 / SEC-01).
      return { trajectoryId: payload.trajectoryId, outcome: payload.outcome, source: payload.source, confidence: payload.confidence };
    case "memory:online_tuning_applied": // RANK-06: bandit-applied COUNTS + the per-intent dim ONLY — NEVER an alpha value or FEED content (§2.7 / SEC-01); agentId/timestamp envelope-only.
      return { updated: payload.updated, clampHits: payload.clampHits, signalCount: payload.signalCount, intent: payload.intent, durationMs: payload.durationMs };
    case "learning:memory_demoted":
    case "learning:memory_evicted":
    case "learning:skill_synthesized":
    case "learning:skill_promoted": // SURFACE-06: counts ONLY (SEC-01)
    case "learning:skill_demoted": // SURFACE-06: counts ONLY (SEC-01)
      // FORGET-06 / SKILL-09 / SURFACE-06: the soft-eviction / admitted / promoted / demoted COUNT ONLY — never an id-list, procedure body, or script (§2.7 / SEC-01); the record TYPE conveys which transition.
      return { count: payload.count };
    case "learning:skill_validated": // SKILL-09: the verdict BOOLEANS + coverage CLOSED-ENUM ONLY — NEVER a field name/finding/script (SEC-01).
      return { staticOk: payload.staticOk, dynamicOk: payload.dynamicOk, coverage: payload.coverage };
    // REVISE-/GENERAL- (203): COUNTS + durationMs ONLY — never a profile/memory body, entryType, or source id (SEC-01 / T-203-leak).
    case "learning:user_model_revised": return { superseded: payload.superseded, corroborated: payload.corroborated, inserted: payload.inserted, durationMs: payload.durationMs };
    case "learning:memory_generalized": return { generalized: payload.generalized, clustersConsidered: payload.clustersConsidered, durationMs: payload.durationMs };
    // T2.2 (F9): closed ids + durationMs ONLY — agentId/origin are envelope ids; no result/
    // error body crosses the bus (§2.7 / H1); the record TYPE conveys promoted/completed/failed.
    case "background_task:promoted":
      return { taskId: payload.taskId, toolName: payload.toolName };
    case "background_task:completed":
      return { taskId: payload.taskId, toolName: payload.toolName, durationMs: payload.durationMs };
    case "background_task:failed":
      return { taskId: payload.taskId, toolName: payload.toolName, durationMs: payload.durationMs };

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
      // LAT-04 (177): stall/makespan attribution fields forward verbatim — content-free
      // (numbers + closed enums + the config-KEY bindingKnob string, never delta text or env
      // values; I7). The signals reader safeParses the row wholesale so the explain verdict
      // names the binding knob with actual numbers. agentId/sessionKey/timestamp stripped.
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
      // GBNF-02 strip-retry self-heal. Content-free (tool + keyword NAMES only, never schema
      // bodies — I7), so all five diagnostic fields forward verbatim — `reason` (WR-05) is the
      // closed branch discriminator (stripped | nothing_to_strip | gate_closed).
      // agentId/sessionKey/timestamp are envelope-only and stripped.
      return {
        toolNames: payload.toolNames,
        strippedKeywords: payload.strippedKeywords,
        retried: payload.retried,
        succeeded: payload.succeeded,
        reason: payload.reason,
      };

    // ---- Security + Sender (scanned subset) ----
    // SECURITY INVARIANT: patterns[] (verbatim injection strings) and senderId (user id) are
    // intentionally NOT forwarded — the translator is the primary control (sanitizeForPersistence
    // is a defense-in-depth backstop).

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
    // SECURITY INVARIANT: chatId (Telegram long-decimal ID) and channelId are intentionally
    // NOT forwarded — only retry telemetry enters the trajectory (translator omission is the
    // primary control; sanitizeForPersistence backstops the error strings).

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
    // SECURITY INVARIANT: patterns[] (verbatim taint strings) and message (may reference
    // secret names/config paths) are intentionally NOT forwarded (sanitizeForPersistence backstops).

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

    // OBS-01 (Phase 180): the multilingual signals. Closed ScriptClass/lane
    // enums + identifiers ONLY — never query text or summary bodies. agentId +
    // sessionKey are envelope-only and stripped (the budget_computed precedent);
    // conversationId is the DAG conversation identifier (an id, not content) and
    // is forwarded so the explain timeline can join the zero-hit to its session.
    case "context:script_zero_hit":
      return {
        scriptClass: payload.scriptClass,
        lane: payload.lane,
        conversationId: payload.conversationId,
      };

    case "context:summary_language_mismatch":
      return {
        sourceScript: payload.sourceScript,
        summaryScript: payload.summaryScript,
        depth: payload.depth,
      };

    // ---- Approval / human-in-the-loop ----
    // SECURITY INVARIANT: approval:requested.params is raw unconstrained tool arguments
    // (file paths, message bodies, credentials) — MUST be omitted entirely. agentId/
    // sessionKey/createdAt/resolvedAt are envelope-only (stripped); channelType +
    // approval:resolved.reason are optional (conditional spread).

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

    // ---- Image generation (OBS-04, Phase 186) ---- delegated to translate-image-payload.ts (file-size split; content-free + envelope-stripped, the precedent the vision/video/voice arms below mirror — image was the last media lifecycle still inline).
    case "image:requested":
    case "image:generated":
    case "image:delivered":
    case "image:failed":
      return translateImagePayload(eventName, payload);

    // ---- Vision analysis (VIS-04, Phase 187) ---- delegated to translate-vision-payload.ts (file-size split, Phase 196; content-free + envelope-stripped, mirroring the image:* arms above + the video:* delegation below). The `path` label is VIS-03's "which path" signal; `costUsd` rides media.vision:completed (VIS-04 Route a).
    case "media.vision:requested":
    case "media.vision:completed":
    case "media.vision:failed":
      return translateVisionPayload(eventName, payload);

    // ---- Video generation (OBS-04, Phase 192) ---- delegated to translate-video-payload.ts (file-size split; content-free + envelope-stripped, mirroring the image:*/media.vision:* arms above).
    case "video:requested":
    case "video:submitted":
    case "video:generated":
    case "video:delivered":
    case "video:failed":
      return translateVideoPayload(eventName, payload);

    // ---- Voice STT/TTS (OBS-02/03, Phase 196) ---- delegated to translate-voice-payload.ts (file-size split; content-free + envelope-stripped, mirroring the image:*/media.vision:*/video:* arms above). media.*:completed carries costUsd (keyless = 0 explicit — OBS-05 Route a); media.*:requested carries the onSkip reasons (OBS-03).
    case "media.stt:requested":
    case "media.stt:completed":
    case "media.stt:failed":
    case "media.tts:requested":
    case "media.tts:completed":
    case "media.tts:failed":
      return translateVoicePayload(eventName, payload);

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
