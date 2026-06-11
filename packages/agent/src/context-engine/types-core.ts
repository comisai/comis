// SPDX-License-Identifier: Apache-2.0
/**
 * Core context engine pipeline types: budget, layers, metrics, and guards.
 *
 * @module
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ComisLogger } from "@comis/core";
import type { CompactionLayerDeps } from "./types-compaction.js";
import type { RehydrationLayerDeps } from "./types-compaction.js";
import type { TokenAnchor } from "./types-anchor.js";

export type { TokenAnchor };

// ---------------------------------------------------------------------------
// Token Budget
// ---------------------------------------------------------------------------

/**
 * Token budget breakdown computed by `computeTokenBudget()`.
 *
 * Formula: H = W - S - O - M - R - P
 * Where:
 * - W = windowTokens (model context window)
 * - S = systemTokens (system prompt + tools estimate)
 * - O = outputReserveTokens (reserved for model output)
 * - M = safetyMarginTokens (percentage-based with absolute floor)
 * - R = contextRotBufferTokens (percentage-based decay buffer)
 * - P = freshTailPreambleTokens (the WHOLE fresh-tail preamble estimate; I1/WR-01)
 * - H = availableHistoryTokens (remaining budget for conversation history)
 */
/**
 * What clamped the effective window below the model's configured contextWindow.
 * "none" = no clamp (frontier/mid, explicit 0 = uncapped, or the configured
 * window already fits). Closed union — but the member names are NO LONGER all
 * `contextEngine.budget.*` knob names (KNOB-02 ended that invariant):
 * `effectiveContextCapSmall` / `effectiveContextCapNano` ARE knob names (the
 * budget's OWN cap bit — raising that config key genuinely works), while
 * `"served"` means the Ollama-served window bound (its knobs live in Ollama:
 * the `OLLAMA_CONTEXT_LENGTH` env on `ollama serve`, or a Modelfile
 * `PARAMETER num_ctx`) and `"capabilityClass"` (WR-01) means the EXECUTOR-side
 * `DEFAULT_EFFECTIVE_CAP_BY_CLASS` cap bound upstream because the operator
 * pinned `providers.entries.<id>.capabilities.capabilityClass` — that pin is
 * the only working lever; the budget knob is inert on this branch. Consumers
 * MUST build knob strings via the errors.ts branching helpers
 * (`describeWindowCap` / `CAP_KNOB_BY_SOURCE`) — NEVER template
 * `contextEngine.budget.${source}` (renders a nonsense knob for "served" /
 * "capabilityClass").
 */
export type WindowCapSource =
  | "effectiveContextCapSmall"
  | "effectiveContextCapNano"
  | "served"
  | "capabilityClass"
  | "none";

/**
 * Window provenance threaded from the executor's resolveEffectiveContextWindow
 * reconcile (pi-executor) into computeTokenBudgetForProfile (KNOB-02). Absent ⇒
 * byte-identical pre-provenance behavior (I3 frontier/mid pin). reconcileSource
 * reuses the EffectiveContextWindowResult.source vocabulary.
 */
export interface WindowProvenance {
  /** The model's TRUE configured contextWindow (registry-enriched), BEFORE the
   *  executor overwrote profile.contextWindow with the reconciled value. */
  configuredWindow: number;
  /** The Ollama-served num_ctx discovered by the boot probe (absent when no
   *  probe result exists for the provider). */
  served?: number;
  /** Which constraint won the executor-side reconcile. */
  reconcileSource: "configured" | "served" | "capability";
}

/**
 * Capped-window provenance carried into the exhaustion throw / WARN / events
 * (W1 obs-llm-troubleshooting). A strict subset of TokenBudget so call sites
 * can pass the budget's own fields without re-deriving anything.
 * servedWindowTokens (KNOB-02) lets the double-cap message name the whole
 * chain (configured → served → class cap).
 */
export type ContextWindowCapInfo = Pick<
  TokenBudget,
  "rawContextWindowTokens" | "windowCapSource" | "servedWindowTokens"
>;

export interface TokenBudget {
  /** W: model context window size in tokens. */
  windowTokens: number;
  /** The model's DECLARED contextWindow before any capability-class cap was
   *  applied (== windowTokens when no cap bit). Lets the exhaustion error and
   *  budget logs name the clamp instead of reporting a window the operator
   *  never configured (W1 obs-llm-troubleshooting). */
  rawContextWindowTokens: number;
  /** Which knob clamped windowTokens below rawContextWindowTokens ("none" when
   *  uncapped). See WindowCapSource. */
  windowCapSource: WindowCapSource;
  /** Ollama-served num_ctx when served-window provenance was threaded
   *  (KNOB-02); absent otherwise. */
  servedWindowTokens?: number;
  /** S: estimated tokens consumed by system prompt and tool definitions. */
  systemTokens: number;
  /** O: tokens reserved for model output generation. */
  outputReserveTokens: number;
  /** M: safety margin tokens (percentage-based with absolute floor). */
  safetyMarginTokens: number;
  /** R: context rot buffer tokens (percentage-based). */
  contextRotBufferTokens: number;
  /** P: fresh-tail preamble tokens subtracted from H (I1 / WR-01) — the WHOLE
   *  `dynamicPreamble` + `inlineMemory` block prepended into the latest user
   *  message by envelope-wrapper (skills XML, MCP instructions, deferred-tools
   *  context, date/channel lines, recalled memory, …), NOT just recalled memory.
   *  Counting the whole preamble is deliberate: that blob rides the
   *  unconditionally-shipped fresh tail and is reserved nowhere else, so this is
   *  the only window-headroom reservation for it. A SEPARATE term, never folded
   *  into S (preserves the recall-dag-budget partition invariant). Clamped to >= 0. */
  freshTailPreambleTokens: number;
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
  /** Agent ID for event attribution and structured logging. Also the R4 read
   *  scope (132-03): the dag assembler builds a ContextStoreScope from it so LCD
   *  reads are agent-isolated (WR-02). */
  agentId?: string;
  /** Formatted session key for event correlation and structured logging. */
  sessionKey?: string;
  /** Tenant ID for the R4 LCD read scope (132-03). The dag assembler builds a
   *  ContextStoreScope { conversationId, agentId, tenantId, sessionKey } from it
   *  so reads filter by tenant + agent (WR-02). Threaded from
   *  executor-context-engine-setup.ts (the same source executor-post-execution
   *  uses: deps.tenantId ?? sessionKey.tenantId). */
  tenantId?: string;

  // --- Objective reinforcement ---
  /** Subagent objective for post-compaction reinforcement. */
  objective?: string;

  // --- System token budget fix ---
  /** Lazy getter for the estimated system prompt + tool definition tokens.
   *  Called on each pipeline run so the value can update after prompt assembly.
   *  Returns 0 when not provided (backward-compatible). */
  getSystemTokensEstimate?: () => number;

  // --- I1 / WR-01: fresh-tail preamble budget seam ---
  /** Lazy getter for the WHOLE fresh-tail preamble token estimate (the
   *  `dynamicPreamble` + `inlineMemory` block prepended by envelope-wrapper —
   *  skills XML, MCP instructions, deferred-tools context, date/channel lines,
   *  recalled memory, …, NOT just recall; see WR-01). Called on each run.
   *  Subtracted from H as a SEPARATE budget term (NOT folded into S — preserves
   *  the recall-dag-budget-partition invariant). Returns 0 when not provided. */
  getFreshTailPreambleTokensEstimate?: () => number;

  // --- G-09: Content modification notification ---
  /** Called when observation masking modifies content (maskedCount > 0).
   *  Used by cache break detector to suppress false-positive CacheBreakEvents. */
  onContentModified?: () => void;

  // --- signature-replay scrub counter accumulation ---
  /** Optional sink for the signature-replay scrubber's per-apply stats.
   *  Receives the SAME shape the scrubber emits to its `onScrubbed` callback,
   *  so callers can accumulate per-execute totals without the scrubber owning
   *  the accumulator. Canonical field names: `blocksAffected` (signed thinking
   *  blocks removed) and `toolCallsAffected` (tool-call `thoughtSignature`
   *  fields stripped). */
  onSignatureReplayScrubbed?: (stats: {
    scrubbedAssistantMessages: number;
    blocksAffected: number;
    toolCallsAffected: number;
    latestAssistantIdx: number;
  }) => void;

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

  // --- LCD dag-mode assembly (Phase 128) ---
  /** Injected core ContextStorePort (the LCD lossless store) for dag-mode
   *  assembly. TYPE-only from `@comis/core` — the agent NEVER imports
   *  `@comis/memory` (the agent↛memory architecture cut); the daemon injects
   *  the concrete `createLcdStore`. Absent ⇒ dag falls back to the pipeline. */
  contextStore?: import("@comis/core").ContextStorePort;
  /** Conversation id for the dag-mode store read (= `formatSessionKey(sessionKey)`).
   *  Absent ⇒ dag falls back to the pipeline. */
  conversationId?: string;
  /** Injected wall-clock for the dag-mode assembler's timestamps (assembly
   *  duration + the synthesized-tool-result `timestamp` in transcript repair).
   *  Production code never calls `Date.now()` directly (the globals gate); the
   *  daemon threads its `ClockPort` here via setupContextEngine. Falls back to
   *  `Date.now()` only when absent (a unit context with no injected clock). */
  clock?: import("@comis/core").ClockPort;
  /** C1 (Phase 152/165): the resolved ModelProfile for the current turn.
   *  Used by the dag assembler to call computeTokenBudgetForProfile (profile-aware
   *  budget with 8K-starvation fix and 256K-overfill cap for small/nano).
   *  Absent ⇒ lcd-assembler applies the fail-closed nano cap + emits a config WARN. */
  modelProfile?: import("../executor/model-profile.js").ModelProfile;
  /** KNOB-02 (Phase 176): window provenance from the executor's
   *  resolveEffectiveContextWindow reconcile, passed as the 7th argument to
   *  computeTokenBudgetForProfile so a served-bound budget reports the TRUE
   *  configured window and names "served" as the cap source.
   *  Absent ⇒ budget reports profile.contextWindow as raw (pre-KNOB-02 behavior). */
  windowProvenance?: WindowProvenance;

  // --- Phase 166 CWF-02: pre-flight fit check + security-pin threading ---

  /** Phase 166 T-S4: security-pin markers for the dag eviction filter.
   *  When provided, messages containing canaryToken/contentDelimiter/senderTrustPrefix
   *  are NEVER evicted from history, regardless of window pressure.
   *  Source: deps.canaryToken threaded from pi-executor at the setupContextEngine call site.
   *  isSecurityRelevantMessage is fail-closed: absent/empty content → pin. */
  securityPinMarkers?: import("./security-context-pinner.js").SecurityPinMarkers;

  /** Phase 166: callback invoked by the pre-flight fit check when assembled input tokens
   *  are measured. Plan 04 sets a getter here so config-resolver can clamp max_tokens. */
  onAssembledInputTokens?: (tokens: number) => void;

  /** Phase 166: callback invoked when the effective window is known (budget.windowTokens).
   *  Plan 04 sets this to populate effectiveWindowRef for dynamic max_tokens clamping.
   *  ONE callback per transformContext call — emit after budget is computed. */
  onEffectiveWindow?: (windowTokens: number) => void;

  /** Phase 166: callback invoked when the thinking-effort governor down-shifts thinkingLevel.
   *  Plan 04 sets this to call session.setThinkingLevel(level) for the current dispatch.
   *  Wired at the pi-executor.ts setupContextEngine call site where the SDK session object
   *  is in scope (setupStreamWrappers only receives sm: SessionManager, not the SDK session). */
  onThinkingDownshifted?: (level: string) => void;

  /** Phase 166: getter returning the current thinking level for this dispatch.
   *  Source: the agent config's thinkingLevel field, read at call time.
   *  When absent, the pre-flight check falls back to "medium" (conservative). */
  getThinkingLevel?: () => string | undefined;

  /** WR-02 (Phase 166): operator-configurable minimum visible output token floor.
   *  Sourced from contextEngine.budget.minVisibleOutputTokens in the agent config.
   *  When absent, the pre-flight check uses the compile-time constant MIN_VISIBLE_OUTPUT_TOKENS (768).
   *  This makes the schema field live rather than dead config. Frontier/mid: default 768
   *  → byte-identical result (MIN_VISIBLE_OUTPUT_TOKENS=768). */
  minVisibleOutputTokens?: number;

  /** RETR-02/03 (Phase 173): the resolved relevance-first policy signal for this turn.
   *  Resolved ONCE in scaffold-defaults (the capability + supportsPromptCache gate;
   *  explicit > capability-default > off) and threaded from setupContextEngine — the
   *  assembler CONSUMES the boolean, it does NOT recompute the gate. When `true` (small/
   *  nano non-caching, or an explicit opt-in) the dag assembler runs the margin arbiter
   *  (marginArbitrate) at the evict seam instead of evictHistoryUnderBudget; when `false`
   *  or ABSENT (frontier/mid + caching) the existing recency-first eviction runs VERBATIM
   *  — frontier/mid byte-identical (LOCKED #2: the arbiter does not run for them). */
  relevanceFirst?: boolean;

  /** RETR-02 (Phase 173): the shared relevance scorer (scoreRelevance) injected for the
   *  margin arbiter's FUSED-RANK cross-tier allocation. INJECTED from setupContextEngine
   *  (executor/, which may import the rag layer) so the context-engine never imports `rag/`
   *  (the I2 cut). On the C2 assembly path the LTM/KG candidate lanes are EMPTY, so the
   *  scorer is never actually invoked (the history band is recency-ordered within its slot);
   *  it is threaded for forward-compat (Phase 174 flows LTM candidates to assembly). Absent
   *  ⇒ the arbiter uses a no-op identity scorer (safe — never called with empty lanes). */
  relevanceScorer?: import("./margin-arbiter.js").RelevanceScorerFn;
}

// ---------------------------------------------------------------------------
// Token Anchor
// ---------------------------------------------------------------------------


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
