// SPDX-License-Identifier: Apache-2.0
/**
 * Bridge metrics accumulation module.
 *
 * Manages token/cost accumulation, tool duration tracking, failure counters,
 * and result building for PiEventBridge.
 *
 * Extracted from pi-event-bridge.ts to isolate metrics concerns.
 *
 * @module
 */

import { systemNowMs } from "@comis/core";
import type { ErrorKind } from "@comis/core";
import type { ExecutionResult } from "../executor/types.js";
import type { ContextUsageData } from "../safety/context-window-guard.js";
import type { ThinkingBlockHash } from "./thinking-block-hash-invariant.js";

// ---------------------------------------------------------------------------
// Metrics state
// ---------------------------------------------------------------------------

/** Internal metrics state managed by the bridge. */
export interface BridgeMetricsState {
  // Token accumulators
  totalInputTokens: number;
  totalOutputTokens: number;
  totalTokens: number;
  totalCost: number;
  totalCacheReadTokens: number;
  totalCacheWriteTokens: number;
  totalCacheSaved: number;
  llmCallCount: number;

  // Finish reason and abort tracking
  finishReason: ExecutionResult["finishReason"];
  aborted: boolean;
  /** R2: Abort redirect message set at abort sites (max_steps, budget_exceeded, etc.).
   *  Overrides result.response in executor-post-execution when finishReason is non-stop. */
  abortResponse: string | undefined;

  // Context usage tracking
  lastContextUsage: ContextUsageData | undefined;

  // Text emission tracking
  textEmitted: boolean;
  lastLlmErrorMessage: string | undefined;

  /** Per-turn capture of outbound delivery events. Populated by pi-event-bridge
   *  on tool_execution_end for `message(action='send'|'reply'|'attach')`.
   *  Read by executor-post-execution.ts to make sentinel-aware decisions.
   *  Reset at turn start. */
  outboundLog: Array<{ action: string; channelType: string; channelId: string; timestamp: number }>;

  // Tool tracking
  toolStartTimes: Map<string, number>;
  toolCallHistory: string[];
  lastActiveToolName: string | undefined;
  toolArgSnapshots: Map<string, Record<string, unknown>>;
  /** Raw (un-sanitized) tool args captured at tool_execution_start, keyed by
   *  toolCallId. Forwarded through `redactValue()` into the redacted `params`
   *  field of the paired `tool:executed` emit. Distinct from
   *  `toolArgSnapshots` (which holds the `sanitizeToolArgs` failure-diagnostic
   *  snapshot); deleted in lockstep with `toolArgSnapshots` at tool_execution_end. */
  toolRawArgs: Map<string, unknown>;
  toolExecResults: Array<{ toolName: string; success: boolean; durationMs: number; errorText?: string; errorKind?: ErrorKind }>;
  /** ATTR-01 (skill-use attribution): the named per-turn carrier. The bridge
   *  adds a skillName here when a `read`'s path matches a frozen learned-skill
   *  `<location>` (resolved via getSessionPromptSkillLocations). The executor
   *  reads it back at the postExecution call site and threads it onto the
   *  `memory:skill_used` write-back event. Empty by default (no skill match) →
   *  zero behavior change. Bounded by reads-per-turn; reset at turn start. */
  turnUsedSkillIds: Set<string>;
  failedToolCount: number;
  failedToolNames: string[];
  /** Per-execution count of breaker-open transitions (`tool:breaker_opened`).
   *  Incremented in pi-event-bridge's opened branch; forwarded as
   *  `bridgeResult.breakerTripCount` for the session-health rollup (D5/F1). */
  breakerTripCount: number;

  // TTL-split cache write token tracking (estimated, normalized to SDK total)
  totalCacheWrite5mTokens: number;
  totalCacheWrite1hTokens: number;

  // Duration trackers
  cumulativeToolDurationMs: number;
  /** Wallclock-capped tool duration: per-turn tool time capped to turn wallclock, accumulated across turns.
   *  Prevents parallel tool overlap from inflating the tool duration used in overhead decomposition. */
  cumulativeToolWallclockMs: number;
  cumulativeLlmDurationMs: number;
  turnToolDurationMs: number;

  // Empty turn detection
  consecutiveEmptyTurns: number;

  // SEP turn counter
  turnCount: number;

  // Turn timing
  turnStartMs: number;

  /** Wall-clock timestamp when the pi-mono `agent_start` event fired for
   *  this run. Used to compute `durationMs` in the `session:ended` emit.
   *  Undefined until the first `agent_start` for the AgentSession
   *  (matches the bridge's once-per-run lifecycle). */
  agentStartMs: number | undefined;

  // Compaction timing
  compactionStartMs: number;

  // Stop reason for output escalation
  lastStopReason: string | undefined;

  // Ghost cost tracking (timed-out requests)
  ghostCostUsd: number;
  timedOutRequests: number;

  // Session-cumulative cost tracking (accumulated across all turns in the session)
  sessionCumulativeCostUsd: number;
  sessionCumulativeCacheSavedUsd: number;

  // Thinking token tracking (gap between SDK output and visible completion)
  totalThinkingTokens: number;

  // Budget trajectory warning: tracks whether the approaching-exhaustion warning has been emitted
  budgetWarningEmitted: boolean;

  // KEYING-01: tracks whether THIS turn has already re-anchored the per-root
  // wall-clock/token limbs (evictRootIfIdle). State is per-execution (per turn), so
  // the flag fires the re-anchor exactly once per turn — at the turn's first
  // per-root reserve — so an interactive session root measures each turn's
  // wall-clock from that turn's start, not the whole conversation's age.
  perRootReanchored: boolean;

  // Diagnostic: SHA-256 hashes of thinking blocks captured at each
  // assistant turn_end, keyed by responseId. Used to detect cross-turn
  // mutation of signed thinking blocks (logs only -- never alters flow).
  // Capped at 32 entries with FIFO eviction to prevent unbounded growth on
  // long-running sessions.
  thinkingBlockHashes: Map<string, ThinkingBlockHash[]>;

  /** Canonical (pre-mutation) snapshot of each assistant message's full
   *  content array, captured at stream close in lockstep with thinkingBlockHashes.
   *  Keyed by responseId; capped at 32 with FIFO eviction in lockstep with the
   *  hash store. Used by the pre-LLM-call restoration pass to heal cross-turn
   *  mutation of signed thinking blocks before pi-ai serializes the next request. */
  thinkingBlockCanonical: Map<string, ReadonlyArray<unknown>>;

  // Per-execute diagnostic counters rolled up into the "Execution complete"
  // bookend INFO log. Demote per-event INFO emissions (which fire N times per
  // request) to DEBUG and surface aggregate counts in the once-per-request
  // bookend instead.
  /** Number of pre-LLM-call hash-assertion walks performed (one per turn_start). */
  hashAssertionsRan: number;
  /** Total cross-turn thinking-block hash mismatches surfaced across all walks. */
  hashAssertionMismatches: number;
  /** Number of signature-replay scrubber invocations that scrubbed at least one
   *  assistant message in this execute(). Populated via ceSetup.getSignatureScrubCounters
   *  in executor-post-execution; surfaced here for symmetry / future bridge-side use. */
  signatureScrubs: number;
  /** Total tool calls across all signature-replay scrubs whose thoughtSignature
   *  was stripped (post-incident-visibility metric). */
  signatureScrubsToolCallsAffected: number;
  /**
   * Per-composite-key drain inflight gate. Owned by the bridge; passed into
   * `drainAt(...)` at the `tool_execution_end` call site (inline-consumption +
   * composite drain).
   *
   * Map keyed by `${agentId}:${channelType}:${channelId}` (composite key).
   * Concurrent calls for the SAME composite key return immediately
   * (single-tick gate). Concurrent calls for DIFFERENT composite keys drain
   * independently (multi-agent isolation).
   *
   * Entry cleanup: `.delete(formatted)` runs in `.finally(...)` of the
   * drain promise so the Map size remains bounded across long-running
   * sessions (entry removed within one event-loop tick of drain
   * resolution).
   */
  drainInflightByKey: Map<string, Promise<void>>;

  /**
   * Warmup-turn accounting. Counts turns flagged as
   * `warmupTurn` (cacheReadTokens === 0 && cacheWriteTokens > 0) and
   * accumulates the positive-signed `pendingCacheInvestmentUsd` (the
   * deferred cost of the first cache write that has not yet been
   * recouped by a subsequent cached read).
   *
   * Surfaced on the "Execution complete" bookend log so dashboards can
   * pivot on first-turn investment vs ongoing cache spend without
   * having to recompute from token_usage events.
   */
  warmupTurnCount: number;
  totalPendingCacheInvestmentUsd: number;

  /**
   * Cumulative SDK→corrected cost delta across all turns (sum
   * of per-turn `costCorrectionDelta` where > 0; negative correction is
   * suppressed at the emit site in pi-event-bridge.ts so this counter
   * is monotonically non-decreasing within an execute). Surfaced on the
   * "Execution complete" bookend log so dashboards see the magnitude of
   * SDK underpricing without subscribing to the per-event token_usage
   * stream (which carries the per-turn `costCorrection` breadcrumb at
   * pi-event-bridge.ts:1106-1115).
   */
  totalCostCorrectionDeltaUsd: number;
}

/**
 * Create a fresh metrics state with all counters zeroed.
 */
export function createBridgeMetrics(): BridgeMetricsState {
  return {
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalTokens: 0,
    totalCost: 0,
    totalCacheReadTokens: 0,
    totalCacheWriteTokens: 0,
    totalCacheWrite5mTokens: 0,
    totalCacheWrite1hTokens: 0,
    totalCacheSaved: 0,
    llmCallCount: 0,
    finishReason: "stop",
    aborted: false,
    abortResponse: undefined,
    lastContextUsage: undefined,
    textEmitted: false,
    lastLlmErrorMessage: undefined,
    outboundLog: [],
    toolStartTimes: new Map(),
    toolCallHistory: [],
    lastActiveToolName: undefined,
    toolArgSnapshots: new Map(),
    toolRawArgs: new Map(),
    turnUsedSkillIds: new Set<string>(),
    toolExecResults: [],
    failedToolCount: 0,
    failedToolNames: [],
    breakerTripCount: 0,
    cumulativeToolDurationMs: 0,
    cumulativeToolWallclockMs: 0,
    cumulativeLlmDurationMs: 0,
    turnToolDurationMs: 0,
    consecutiveEmptyTurns: 0,
    turnCount: 0,
    turnStartMs: systemNowMs(),
    agentStartMs: undefined,
    compactionStartMs: 0,
    lastStopReason: undefined,
    ghostCostUsd: 0,
    timedOutRequests: 0,
    sessionCumulativeCostUsd: 0,
    sessionCumulativeCacheSavedUsd: 0,
    totalThinkingTokens: 0,
    budgetWarningEmitted: false,
    perRootReanchored: false,
    thinkingBlockHashes: new Map(),
    thinkingBlockCanonical: new Map(),
    // per-execute diagnostic counters
    hashAssertionsRan: 0,
    hashAssertionMismatches: 0,
    signatureScrubs: 0,
    signatureScrubsToolCallsAffected: 0,
    // per-composite-key drain inflight gate.
    drainInflightByKey: new Map<string, Promise<void>>(),
    // Warmup-turn counters
    warmupTurnCount: 0,
    totalPendingCacheInvestmentUsd: 0,
    // Cumulative SDK→corrected cost delta across all turns
    totalCostCorrectionDeltaUsd: 0,
  };
}

/**
 * Build the execution result object from accumulated metrics state.
 *
 * @param metrics - The accumulated metrics state
 * @param stepCount - Current step count from the step counter
 */
export function buildBridgeResult(
  metrics: BridgeMetricsState,
  stepCount: number,
): Partial<ExecutionResult> & {
  contextUsage?: ContextUsageData;
  textEmitted?: boolean;
  cumulativeLlmDurationMs?: number;
  cumulativeToolDurationMs?: number;
  cumulativeToolWallclockMs?: number;
  toolCallHistory?: string[];
  lastActiveToolName?: string;
  lastLlmErrorMessage?: string;
  failedToolCalls?: number;
  failedTools?: string[];
  toolExecResults?: Array<{ toolName: string; success: boolean; durationMs: number; errorText?: string; errorKind?: ErrorKind }>;
  breakerTripCount?: number;
  turnCount?: number;
  lastStopReason?: string;
  cacheWrite5mTokens?: number;
  cacheWrite1hTokens?: number;
  sessionCostUsd?: number;
  sessionCacheSavedUsd?: number;
  thinkingTokens?: number;
  budgetWarningEmitted?: boolean;
  // diagnostic counters surfaced for the "Execution complete" bookend.
  hashAssertionsRan?: number;
  hashAssertionMismatches?: number;
  signatureScrubs?: number;
  signatureScrubsToolCallsAffected?: number;
  // Warmup-turn counters for the "Execution complete" bookend.
  warmupTurnCount?: number;
  totalPendingCacheInvestmentUsd?: number;
  // Cumulative cost-correction delta surfaced on Execution-complete log
  totalCostCorrectionDeltaUsd?: number;
  /** R2: Abort redirect message set at bridge abort sites; undefined for normal completions. */
  abortResponse?: string;
} {
  return {
    tokensUsed: {
      input: metrics.totalInputTokens,
      output: metrics.totalOutputTokens,
      total: metrics.totalTokens,
      cacheRead: metrics.totalCacheReadTokens,
      cacheWrite: metrics.totalCacheWriteTokens,
    },
    cost: {
      total: metrics.totalCost,
      cacheSaved: metrics.totalCacheSaved,
      // Ghost cost from timed-out requests (additive, not included in total)
      ghostCostUsd: metrics.ghostCostUsd > 0 ? metrics.ghostCostUsd : undefined,
      timedOutRequests: metrics.timedOutRequests > 0 ? metrics.timedOutRequests : undefined,
    },
    stepsExecuted: stepCount,
    llmCalls: metrics.llmCallCount,
    finishReason: metrics.finishReason,
    contextUsage: metrics.lastContextUsage,
    textEmitted: metrics.textEmitted,
    toolCallHistory: metrics.toolCallHistory.length > 0 ? metrics.toolCallHistory : undefined,
    lastActiveToolName: metrics.lastActiveToolName,
    cumulativeLlmDurationMs: metrics.cumulativeLlmDurationMs,
    cumulativeToolDurationMs: metrics.cumulativeToolDurationMs,
    cumulativeToolWallclockMs: metrics.cumulativeToolWallclockMs,
    lastLlmErrorMessage: metrics.lastLlmErrorMessage,
    failedToolCalls: metrics.failedToolCount,
    failedTools: metrics.failedToolNames.length > 0 ? metrics.failedToolNames : undefined,
    toolExecResults: metrics.toolExecResults.length > 0 ? metrics.toolExecResults : undefined,
    breakerTripCount: metrics.breakerTripCount,
    turnCount: metrics.turnCount,
    lastStopReason: metrics.lastStopReason,
    cacheWrite5mTokens: metrics.totalCacheWrite5mTokens,
    cacheWrite1hTokens: metrics.totalCacheWrite1hTokens,
    // Session-cumulative cost fields
    sessionCostUsd: metrics.sessionCumulativeCostUsd,
    sessionCacheSavedUsd: metrics.sessionCumulativeCacheSavedUsd,
    // Thinking tokens (omitted when 0 to avoid log noise)
    thinkingTokens: metrics.totalThinkingTokens > 0 ? metrics.totalThinkingTokens : undefined,
    // Budget trajectory warning flag
    budgetWarningEmitted: metrics.budgetWarningEmitted || undefined,
    // Per-execute diagnostic counters. Always populated (no `> 0` gate) — a
    // `0` in the bookend log is itself meaningful ("no scrubs/assertions
    // this execute") and gating would lose that signal.
    hashAssertionsRan: metrics.hashAssertionsRan,
    hashAssertionMismatches: metrics.hashAssertionMismatches,
    signatureScrubs: metrics.signatureScrubs,
    signatureScrubsToolCallsAffected: metrics.signatureScrubsToolCallsAffected,
    // Warmup-turn counters (always populated — `0` is a meaningful
    // "no warmup turns this execute" signal).
    warmupTurnCount: metrics.warmupTurnCount,
    totalPendingCacheInvestmentUsd: metrics.totalPendingCacheInvestmentUsd,
    // Cumulative cost-correction delta (always populated;
    // the per-call emit at executor-post-execution gates on > 0 to
    // avoid logging zeros).
    totalCostCorrectionDeltaUsd: metrics.totalCostCorrectionDeltaUsd,
    // R2: Abort redirect message — only set at abort sites; omitted for normal completions.
    abortResponse: metrics.abortResponse,
  };
}
