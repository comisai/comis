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

  // Context usage tracking
  lastContextUsage: ContextUsageData | undefined;

  // Text emission tracking
  textEmitted: boolean;
  lastLlmErrorMessage: string | undefined;

  /** Per-turn capture of outbound delivery events. Populated by pi-event-bridge
   *  on tool_execution_end for `message(action='send'|'reply'|'attach')`.
   *  Read by executor-post-execution.ts to make sentinel-aware decisions
   *  (Phase 5 / B26 + B29, R5). Reset at turn start. */
  outboundLog: Array<{ action: string; channelType: string; channelId: string; timestamp: number }>;

  // Tool tracking
  toolStartTimes: Map<string, number>;
  toolCallHistory: string[];
  lastActiveToolName: string | undefined;
  toolArgSnapshots: Map<string, Record<string, unknown>>;
  toolExecResults: Array<{ toolName: string; success: boolean; durationMs: number; errorText?: string }>;
  failedToolCount: number;
  failedToolNames: string[];

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
   * Phase 4 (Plan 15-05 / R4 / T0.15+T0.24+T0.25): per-composite-key drain
   * inflight gate. Owned by the bridge; passed into `drainAt(...)` at the
   * `tool_execution_end` call site (B15 inline-consumption + composite
   * drain).
   *
   * Map keyed by `${agentId}:${channelType}:${channelId}` (composite key).
   * Concurrent calls for the SAME composite key return immediately
   * (single-tick gate, T0.25). Concurrent calls for DIFFERENT composite
   * keys drain independently (T0.24 multi-agent isolation).
   *
   * Entry cleanup: `.delete(formatted)` runs in `.finally(...)` of the
   * drain promise so the Map size remains bounded across long-running
   * sessions (entry removed within one event-loop tick of drain
   * resolution).
   */
  drainInflightByKey: Map<string, Promise<void>>;
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
    lastContextUsage: undefined,
    textEmitted: false,
    lastLlmErrorMessage: undefined,
    outboundLog: [],
    toolStartTimes: new Map(),
    toolCallHistory: [],
    lastActiveToolName: undefined,
    toolArgSnapshots: new Map(),
    toolExecResults: [],
    failedToolCount: 0,
    failedToolNames: [],
    cumulativeToolDurationMs: 0,
    cumulativeToolWallclockMs: 0,
    cumulativeLlmDurationMs: 0,
    turnToolDurationMs: 0,
    consecutiveEmptyTurns: 0,
    turnCount: 0,
    turnStartMs: Date.now(),
    compactionStartMs: 0,
    lastStopReason: undefined,
    ghostCostUsd: 0,
    timedOutRequests: 0,
    sessionCumulativeCostUsd: 0,
    sessionCumulativeCacheSavedUsd: 0,
    totalThinkingTokens: 0,
    budgetWarningEmitted: false,
    thinkingBlockHashes: new Map(),
    thinkingBlockCanonical: new Map(),
    // per-execute diagnostic counters
    hashAssertionsRan: 0,
    hashAssertionMismatches: 0,
    signatureScrubs: 0,
    signatureScrubsToolCallsAffected: 0,
    // Phase 4 / Plan 15-05: per-composite-key drain inflight gate (T0.24+T0.25).
    drainInflightByKey: new Map<string, Promise<void>>(),
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
  toolExecResults?: Array<{ toolName: string; success: boolean; durationMs: number; errorText?: string }>;
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
  };
}
