// SPDX-License-Identifier: Apache-2.0
/**
 * Core context engine pipeline types: budget, layers, metrics, and guards.
 *
 * @module
 */

import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { ComisLogger } from "@comis/infra";
import type { CompactionLayerDeps } from "./types-compaction.js";
import type { RehydrationLayerDeps } from "./types-compaction.js";

// ---------------------------------------------------------------------------
// Token Budget
// ---------------------------------------------------------------------------

/**
 * Token budget breakdown computed by `computeTokenBudget()`.
 *
 * Formula: H = W - S - O - M - R
 * Where:
 * - W = windowTokens (model context window)
 * - S = systemTokens (system prompt + tools estimate)
 * - O = outputReserveTokens (reserved for model output)
 * - M = safetyMarginTokens (percentage-based with absolute floor)
 * - R = contextRotBufferTokens (percentage-based decay buffer)
 * - H = availableHistoryTokens (remaining budget for conversation history)
 */
export interface TokenBudget {
  /** W: model context window size in tokens. */
  windowTokens: number;
  /** S: estimated tokens consumed by system prompt and tool definitions. */
  systemTokens: number;
  /** O: tokens reserved for model output generation. */
  outputReserveTokens: number;
  /** M: safety margin tokens (percentage-based with absolute floor). */
  safetyMarginTokens: number;
  /** R: context rot buffer tokens (percentage-based). */
  contextRotBufferTokens: number;
  /** H: available tokens for conversation history (clamped to >= 0). */
  availableHistoryTokens: number;
  /** Message index at or below which content must not be modified.
   *  -1 means no fence (all messages modifiable). Set from previous turn's
   *  cache breakpoint positions. */
  cacheFenceIndex: number;
}

// ---------------------------------------------------------------------------
// Layer Pipeline
// ---------------------------------------------------------------------------

/**
 * A single context engine layer that transforms messages within a token budget.
 *
 * Each layer receives the current message array and budget, returning a
 * (potentially modified) message array. Layers must NOT mutate the input
 * array or message objects -- always return new arrays/objects.
 */
export interface ContextLayer {
  /** Unique layer name for logging and circuit breaker tracking. */
  name: string;
  /** Transform messages within the given token budget. */
  apply(messages: AgentMessage[], budget: TokenBudget): Promise<AgentMessage[]>;
}

/**
 * Context engine interface returned by `createContextEngine()`.
 *
 * Provides the `transformContext` function compatible with the pi-agent-core
 * `AgentLoopConfig.transformContext` hook signature.
 */
export interface ContextEngine {
  /** Transform context before LLM call. Assigned to `session.agent.transformContext`. */
  transformContext: (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]>;
  /** Metrics from the most recent pipeline run. Undefined before first run. */
  lastMetrics?: ContextEngineMetrics;
  /** Set by executor after each LLM call to track the highest
   *  cache breakpoint position. Used as "fence" on the next turn.
   *  -1 or undefined means no fence. */
  lastBreakpointIndex?: number;
  /** Number of messages trimmed by history-window in the most recent
   *  pipeline run. Used to translate post-CE breakpoint indices back to pre-CE
   *  space. Initialized to 0. */
  lastTrimOffset: number;
  /** Set/clear thinking block stripping ceiling for cache stability.
   *  When set, the cleaner uses min(actual assistant count, ceiling) for cutoff.
   *  Set at execution start, cleared in finally block. */
  setThinkingCeiling?: (n: number | undefined) => void;
}

/**
 * Dependencies injected into `createContextEngine()`.
 *
 * Uses a minimal structural type for the model getter to avoid coupling
 * to pi-ai internals. The model getter is lazy (function) to handle
 * mid-session model switching via `cycleModel()`.
 */
export interface ContextEngineDeps {
  /** Structured logger for the context engine module. */
  logger: ComisLogger;
  /** Lazy getter for the current model's capabilities. */
  getModel: () => {
    /** Whether the model supports extended thinking. */
    reasoning: boolean;
    /** Model context window size in tokens. */
    contextWindow: number;
    /** Maximum output tokens for the model. */
    maxTokens: number;
    /** Optional model identifier (e.g. "claude-opus-4-7"). Used by replay
     *  drift detection downstream of this getter. */
    id?: string;
    /** Optional provider name (e.g. "anthropic"). Used by replay drift
     *  detection downstream of this getter. */
    provider?: string;
    /** Optional API family tag (e.g. "anthropic.messages",
     *  "google.generative_ai.responses"). Used by replay drift detection
     *  downstream of this getter. */
    api?: string;
  };
  /** Channel type for history window per-channel overrides (e.g., "dm", "group"). */
  channelType?: string;
  /** Getter for SessionManager to enable persistent observation masking write-back.
   *  When absent, masking is transient (non-persistent). */
  getSessionManager?: () => unknown;
  /** Optional getter for compaction layer dependencies.
   *  When absent, compaction layer is not added to the pipeline. */
  getCompactionDeps?: () => CompactionLayerDeps;
  /** Optional getter for rehydration layer dependencies.
   *  When absent, rehydration layer is not added. */
  getRehydrationDeps?: () => RehydrationLayerDeps;

  // --- Observability event emission ---
  /** Optional event bus for emitting context engine lifecycle events. */
  eventBus?: { emit(event: string, data: unknown): void };
  /** Agent ID for event attribution and structured logging. */
  agentId?: string;
  /** Formatted session key for event correlation and structured logging. */
  sessionKey?: string;

  // --- Objective reinforcement ---
  /** Subagent objective for post-compaction reinforcement. */
  objective?: string;

  // --- System token budget fix ---
  /** Lazy getter for the estimated system prompt + tool definition tokens.
   *  Called on each pipeline run so the value can update after prompt assembly.
   *  Returns 0 when not provided (backward-compatible). */
  getSystemTokensEstimate?: () => number;

  // --- G-09: Content modification notification ---
  /** Called when observation masking modifies content (maskedCount > 0).
   *  Used by cache break detector to suppress false-positive CacheBreakEvents. */
  onContentModified?: () => void;

  // --- API-grounded token estimation ---
  /** Optional getter for the API-grounded token anchor.
   *  Returns the last API response's input_tokens and message count.
   *  When absent or returning null, estimation falls back to char-based heuristics. */
  getTokenAnchor?: () => TokenAnchor | null;
  /** Called when compaction resets the anchor.
   *  The executor uses this to null out its closure-scoped tokenAnchor. */
  onAnchorReset?: () => void;

  // --- Idle-based thinking clear ---
  /** Optional dynamic override for thinking block cleaner keepTurns.
   *  When the getter returns a number (e.g. 0), the cleaner uses that value
   *  instead of the static config keepTurns. When it returns undefined, the
   *  static value is used. Used by idle thinking clear to strip all thinking
   *  blocks when the cache is cold (>1h idle). */
  getThinkingKeepTurnsOverride?: () => number | undefined;

  // --- Replay drift detection (Fix #2) ---
  /** Optional getter for the per-execute() memoized replay drift decision.
   *  When the getter returns a DriftCheck with `drop: true`, the
   *  signature-replay-scrubber layer activates for this pipeline run. When
   *  undefined or `drop: false`, the layer no-ops. The drift result is
   *  memoized at the executor layer so all pipeline runs within a single
   *  execute() see a consistent decision. */
  getReplayDriftMode?: () => import("../executor/replay-drift-detector.js").DriftCheck | undefined;
}

// ---------------------------------------------------------------------------
// Token Anchor
// ---------------------------------------------------------------------------

/**
 * API-grounded token count anchor from the last LLM response.
 *
 * Records the API's `usage.input` value as ground truth, along with the
 * message count at the time of recording. Used by the context engine and
 * compaction layer to replace char-based estimation with anchor + delta.
 *
 * Lifecycle: Set after each `turn_end` event in the pi-event-bridge.
 * Reset to null when compaction fires (message array replaced).
 */
export interface TokenAnchor {
  /** Total input tokens reported by the API (includes cache_read + cache_creation). */
  inputTokens: number;
  /** Number of messages in the context array when this anchor was recorded.
   *  Recorded as messages.length - 1 (before assistant response is appended). */
  messageCount: number;
  /** Timestamp for staleness detection (Date.now() at recording). */
  timestamp: number;
}

// ---------------------------------------------------------------------------
// Metrics & Assembled Context
// ---------------------------------------------------------------------------

/**
 * Metrics collected during a single context engine pipeline run.
 *
 * Extended in later phases as layers are added:
 * - microcompaction metrics
 * - observation masking metrics
 * - cache optimization metrics
 * - full observability dashboard
 */
export interface ContextEngineMetrics {
  /** Number of thinking blocks removed by the thinking cleaner. */
  thinkingBlocksRemoved: number;
  /** Number of layer errors caught and handled. */
  layerErrors: number;
  /** Ratio of history tokens used vs available (0-1). */
  budgetUtilization: number;

  // --- Full observability ---
  /** Estimated tokens in context at pipeline start. */
  tokensLoaded: number;
  /** Estimated tokens saved by observation masking. */
  tokensMasked: number;
  /** Estimated tokens saved by LLM compaction. */
  tokensCompacted: number;
  /** Cache read tokens from Anthropic API (0 = no cache activity). Populated post-pipeline by executor. */
  cacheHitTokens: number;
  /** Cache write tokens from Anthropic API (0 = no cache activity). Populated post-pipeline by executor. */
  cacheWriteTokens: number;
  /** Cache miss tokens: input tokens not served from cache (0 = no cache activity). Populated post-pipeline by executor. */
  cacheMissTokens: number;
  /** Total pipeline execution time in milliseconds. */
  durationMs: number;
  /** Per-layer execution breakdown. */
  layers: Array<{
    name: string;
    durationMs: number;
    messagesIn: number;
    messagesOut: number;
  }>;

  // --- Pipeline observability ---
  /** Estimated tokens removed by dead content evictor. */
  tokensEvicted: number;
  /** Per-category eviction counts: file_read, exec, web, image, error. */
  evictionCategories: Record<string, number>;
  /** Number of exact-match duplicate tool calls detected. */
  rereadCount: number;
  /** Tool names that were re-read (deduplicated). */
  rereadTools: string[];
  /** Total messages in the full session from fileEntries. */
  sessionDepth: number;
  /** Total tool results in the full session. */
  sessionToolResults: number;
}

/**
 * Per-session cache hit rate accumulator.
 *
 * Runtime accumulation deferred -- event infrastructure (observability:token_usage)
 * now carries cacheReadTokens/cacheWriteTokens for downstream consumers to aggregate.
 */
export interface CacheSessionStats {
  totalCalls: number;
  cacheHits: number;
  cacheWrites: number;
  cacheMisses: number;
  totalCacheReadTokens: number;
  totalCacheWriteTokens: number;
}

/**
 * Complete output of the context engine pipeline.
 *
 * Contains the transformed messages, computed budget, and collected metrics.
 * Extended in later phases:
 * - adds cache key and hit/miss stats
 * - adds per-layer timing breakdown
 */
export interface AssembledContext {
  /** Transformed messages after all layers have been applied. */
  messages: AgentMessage[];
  /** Computed token budget used during this pipeline run. */
  budget: TokenBudget;
  /** Metrics collected during this pipeline run. */
  metrics: ContextEngineMetrics;
}

// ---------------------------------------------------------------------------
// Circuit Breaker
// ---------------------------------------------------------------------------

/**
 * Per-layer circuit breaker tracking consecutive failures.
 *
 * After N consecutive failures (configurable via LAYER_CIRCUIT_BREAKER_THRESHOLD),
 * the layer is disabled for the remainder of the session. Reset is session-scoped
 * (new session = fresh circuit breakers).
 */
export interface LayerCircuitBreaker {
  /** Check if a layer has been disabled due to consecutive failures. */
  isDisabled(layerName: string): boolean;
  /** Record a successful layer execution (resets consecutive failure count). */
  recordSuccess(layerName: string): void;
  /** Record a layer failure (increments consecutive failure count). */
  recordFailure(layerName: string): void;
}

// ---------------------------------------------------------------------------
// Forward-Declared Placeholder Types (extended in later phases)
// ---------------------------------------------------------------------------

/**
 * Microcompaction guard interface for per-tool inline threshold resolution.
 *
 * Implemented by `installMicrocompactionGuard()`. Resolves the
 * inline character threshold for a given tool name, controlling which tool
 * results are offloaded to disk vs kept inline in the JSONL session.
 */
export interface MicrocompactionGuard {
  /** Per-tool inline threshold resolution. */
  getInlineThreshold(toolName: string): number;
}

/**
 * Metrics from cache optimization pipeline.
 *
 * Populated by the prompt assembly + cache breakpoint layers during each
 * execution cycle. Used for observability and integration testing.
 */
export interface CacheOptimizationMetrics {
  /** SHA-256 digest of the system prompt (truncated to SYSTEM_PROMPT_HASH_LENGTH). */
  systemPromptDigest: string;
  /** Whether the system prompt changed since the last call in this session. */
  systemPromptChanged: boolean;
  /** Number of cache breakpoints placed in the API payload. */
  breakpointsPlaced: number;
  /** Number of MCP tools deferred behind discovery tool. */
  mcpToolsDeferred: number;
  /** Bootstrap content chars as percentage of system prompt. */
  bootstrapBudgetPercent: number;
}

/**
 * Observation masker metrics from a single pipeline run.
 *
 * Populated by `createObservationMaskerLayer()` after each `apply()` call.
 * Used for observability ( dashboard) and integration testing.
 */
export interface ObservationMasker {
  /** Number of tool results masked in the last pipeline run. */
  maskedCount: number;
  /** Whether persistent write-back occurred in the last run. */
  persistedToDisk: boolean;
}
