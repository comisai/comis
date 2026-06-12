// SPDX-License-Identifier: Apache-2.0
/**
 * Centralized constants for the context engine pipeline.
 *
 * ALL thresholds and defaults for all 7 layers are defined here.
 * Each constant uses verbose UPPER_SNAKE_CASE naming and includes
 * a JSDoc comment explaining its purpose and which layer consumes it.
 *
 * Constants are NOT exposed in user config (per locked decision:
 * budget components are internal). Users control the pipeline via
 * ContextEngineConfigSchema (enabled, thinkingKeepTurns).
 *
 * @module
 */

// ---------------------------------------------------------------------------
// Output Headroom (Layer 0: reasoning-aware output floor — Fix 3 / Phase 166)
// ---------------------------------------------------------------------------

/** Minimum visible output tokens guaranteed on every LLM dispatch — the
 *  non-reasoning floor (the answer/tool-call body that must survive after the
 *  thinking block). Used by: output-headroom.ts + config-resolver.ts clamp.
 *  Design ref: design/small-model-context-fidelity.md §4 Fix 3 item 1. */
export const MIN_VISIBLE_OUTPUT_TOKENS = 768;

// ---------------------------------------------------------------------------
// Token Budget Algebra (Layer 0: budget computation)
// ---------------------------------------------------------------------------

/** Safety margin as percentage of context window. Clamp: max(W * SAFETY_MARGIN_PERCENT / 100, MIN_SAFETY_MARGIN_TOKENS). Used by: token budget algebra. */
export const SAFETY_MARGIN_PERCENT = 5;

/** Absolute minimum safety margin in tokens, prevents underflow on small-context models (32K). Used by: token budget algebra. */
export const MIN_SAFETY_MARGIN_TOKENS = 2_048;

/** Reserved tokens for model output generation. Clamped to Math.min(this, model.maxTokens). Used by: token budget algebra. */
export const OUTPUT_RESERVE_TOKENS = 8_192;

/** Context rot buffer as percentage of context window (Chroma 2025: 13.9-85% degradation at limits). Used by: token budget algebra. */
export const CONTEXT_ROT_BUFFER_PERCENT = 25;

// ---------------------------------------------------------------------------
// Layer Pipeline (Layer runner)
// ---------------------------------------------------------------------------

/** Consecutive layer failures before circuit breaker disables the layer for the session. Used by: layer pipeline runner. */
export const LAYER_CIRCUIT_BREAKER_THRESHOLD = 3;

// ---------------------------------------------------------------------------
// Thinking Block Cleaner (Layer 4)
// ---------------------------------------------------------------------------

/** Default number of recent assistant turns that retain thinking blocks. Used by: thinking block cleaner (Layer 4). */
export const DEFAULT_KEEP_WINDOW_TURNS = 10;

// ---------------------------------------------------------------------------
// Microcompaction Guard (Layer 2)
// ---------------------------------------------------------------------------

/** Default inline threshold for tool result microcompaction (chars). Used by: microcompaction guard. */
export const MAX_INLINE_TOOL_RESULT_CHARS = 8_000;

/** MCP tool result inline threshold (chars). Used by: microcompaction guard. */
export const MAX_INLINE_MCP_TOOL_RESULT_CHARS = 15_000;

/** read tool (file read) inline threshold (chars) -- higher for code context. Used by: microcompaction guard. */
export const MAX_INLINE_FILE_READ_RESULT_CHARS = 15_000;

/** Hard cap for tool result size before truncation (chars). Used by: microcompaction guard. */
export const TOOL_RESULT_HARD_CAP_CHARS = 100_000;

// ---------------------------------------------------------------------------
// Content Preview
// ---------------------------------------------------------------------------

/** Head preview chars for offloaded tool results. Used by: microcompaction-guard preview. */
export const PREVIEW_HEAD_CHARS = 1_500;

/** Tail preview chars for offloaded tool results. Used by: microcompaction-guard preview. */
export const PREVIEW_TAIL_CHARS = 500;

// ---------------------------------------------------------------------------
// Post-Compact Skill Restoration
// ---------------------------------------------------------------------------

/** Maximum total chars for rehydrated prompt skills XML. Used by: rehydration skill restoration. */
export const MAX_REHYDRATION_SKILL_CHARS = 15_000;

/** Maximum number of individual skills to restore after compaction. Used by: rehydration skill restoration. */
export const MAX_REHYDRATION_SKILLS = 10;

// ---------------------------------------------------------------------------
// Observation Masker (Layer 3)
// ---------------------------------------------------------------------------

/** Default observation masking keep window (most recent N tool uses retained). Used by: observation masker. */
export const DEFAULT_OBSERVATION_KEEP_WINDOW = 15;

/** Char threshold before observation masking activates. Used by: observation masker. */
export const OBSERVATION_MASKING_CHAR_THRESHOLD = 80_000;

/** Deactivation threshold for observation masking hysteresis.
 *  Once masking activates at OBSERVATION_MASKING_CHAR_THRESHOLD (80K), it stays
 *  active until context drops below this lower threshold (50K). The 30K gap
 *  between activation and deactivation prevents toggling near the boundary.
 *  Used by: observation masker. */
export const OBSERVATION_MASKING_DEACTIVATION_CHARS = 50_000;

// ---------------------------------------------------------------------------
// Tool Masking Tiers
// ---------------------------------------------------------------------------

/** Masking tier for a tool. Protected = never masked, standard = existing keep window, ephemeral = short keep window. */
export type ToolMaskingTier = "protected" | "standard" | "ephemeral";

/**
 * Explicit tier assignments for known tools.
 * Tools not in this map default to "standard" via resolveToolMaskingTier().
 */
export const TOOL_MASKING_TIERS: ReadonlyMap<string, ToolMaskingTier> = new Map([
  // Protected: never masked
  ["memory_search", "protected"],
  ["memory_get", "protected"],
  ["memory_store", "protected"],
  ["read", "protected"],
  ["session_search", "protected"],
  // Ephemeral: short keep window
  ["web_search", "ephemeral"],
  ["brave_search", "ephemeral"],
  ["web_fetch", "ephemeral"],
  ["link_reader", "ephemeral"],
  ["fetch_url", "ephemeral"],
]);

/** Default keep window for ephemeral-tier tools. Used by: observation masker, DAG annotator. */
export const EPHEMERAL_TOOL_KEEP_WINDOW = 10;

/**
 * Resolve the masking tier for a tool. MCP tools (mcp__ or mcp: prefix) default to
 * "ephemeral"; unknowns default to "standard".
 * Single source of truth consumed by both pipeline observation masker and DAG annotator.
 *
 * @param toolName - The tool name to classify
 * @returns The masking tier: "protected" (never mask), "standard" (existing window), "ephemeral" (short window)
 */
export function resolveToolMaskingTier(toolName: string): ToolMaskingTier {
  const explicit = TOOL_MASKING_TIERS.get(toolName);
  if (explicit !== undefined) return explicit;
  if (toolName.startsWith("mcp__") || toolName.startsWith("mcp:")) return "ephemeral";
  return "standard";
}

// ---------------------------------------------------------------------------
// Token Estimation (shared utility)
// ---------------------------------------------------------------------------

/** Chars-per-token estimation ratio for natural language text.
 *  3.5 better matches Anthropic's tokenizer (measured 38.8% overcount at 4.0
 *  against production dashboard data). Aligned with estimateBlockTokens().
 *
 *  Ratios are Latin-calibrated and stay flat here; since Phase 179 (TOK-01),
 *  call sites with source text in scope modulate the divisor by
 *  scriptTokenFactor(text) from @comis/core (dense scripts — Hebrew/Arabic/
 *  CJK/etc — carry ~2-3× tokens per char). Sites without text in scope are
 *  marked flat-by-design at the call site. */
export const CHARS_PER_TOKEN_RATIO = 3.5;

/** Chars-per-token estimation ratio for structured content (JSON, code, tool results).
 *  Code and JSON tokenize at ~2.5-3 chars/token due to punctuation, short identifiers,
 *  and special characters each consuming full tokens. 3:1 is a conservative improvement
 *  over the flat 4:1 ratio. Used by: content-aware token estimation. */
export const CHARS_PER_TOKEN_RATIO_STRUCTURED = 3;

// ---------------------------------------------------------------------------
// Cache Optimization
// ---------------------------------------------------------------------------

/** Length of truncated SHA-256 digest for system prompt hash comparison. Used by: prompt-assembly hash validation. */
export const SYSTEM_PROMPT_HASH_LENGTH = 16;

/**
 * Warn if bootstrap content exceeds this percentage of estimated total prompt input.
 *
 * F4: denominator is `systemPromptChars + toolDefOverheadChars` (system prompt + tool schemas),
 * not raw system prompt alone. Threshold lowered from 85→40: fires only when bootstrap is
 * genuinely disproportionate to the full assembled input, eliminating the 100% false-alarm
 * rate on small-model turns (compact-secure system prompt ~2.8K vs ~12K bootstrap).
 *
 * Used by: prompt-assembly budget tracking.
 */
export const BOOTSTRAP_BUDGET_WARN_PERCENT = 40;

/**
 * Minimum cacheable token thresholds by model family prefix.
 * Used by: cache breakpoint placement.
 *
 * Values are Anthropic's official API minimums.
 * Setting lower causes silent no-ops (breakpoints ignored, tokens not cached).
 */
export const MIN_CACHEABLE_TOKENS: Record<string, number> = {
  "claude-opus-4-6": 4096,
  "claude-opus-4-5": 4096,
  "claude-opus-4-1": 1024,
  "claude-opus-4-": 1024,
  "claude-sonnet-4-6": 2048,
  "claude-sonnet-4-5": 1024,
  "claude-sonnet-4-": 1024,
  "claude-sonnet-3-7": 1024,
  "claude-haiku-4-5": 4096,
  "claude-haiku-3-5": 2048,
  "claude-haiku-3": 2048,
};

/** Default minimum cacheable tokens (conservative fallback). Used by: cache breakpoint placement. */
export const DEFAULT_MIN_CACHEABLE_TOKENS = 1024;

/** MCP tool deferral threshold as fraction of context window. Used by: MCP tool deferred loading. */
export const MCP_DEFERRAL_THRESHOLD = 0.10;

/** Anthropic cache lookback window size (message blocks). Breakpoints more than
 *  this many blocks apart cannot see each other for prefix matching.
 *  Used by: lookback window enforcement in stream-wrappers.ts. */
export const CACHE_LOOKBACK_WINDOW = 20;

/** Maximum message blocks before cache-aware compaction trigger.
 *  With 4 breakpoints (3 Comis + 1 SDK) and a 20-block lookback window,
 *  optimal coverage spans 4 × 20 = 80 blocks. Trigger when the count
 *  *exceeds* 60 (i.e. first fires at 61 blocks — 75% of theoretical max)
 *  to leave headroom for multi-call turns.
 *
 *  APPROXIMATION NOTE: `messages.length` (AgentMessage[]) approximates
 *  Anthropic's request-body `messages[]` block count but is not strictly 1:1.
 *  Treat 60 as a defensive setpoint, not a calibrated threshold.
 *  Used by: llm-compaction layer cache-aware trigger. */
export const CACHE_AWARE_COMPACTION_BLOCK_THRESHOLD = 60;

// ---------------------------------------------------------------------------
// LLM Compaction (Layer 5)
// ---------------------------------------------------------------------------

/** Context utilization percentage that triggers LLM compaction. Used by: llm-compaction layer. */
export const COMPACTION_TRIGGER_PERCENT = 85;

/** Default turns to wait before re-triggering compaction. Used by: llm-compaction layer. */
export const COMPACTION_COOLDOWN_TURNS = 5;

/** Maximum retry attempts for compaction quality validation before falling to next level. Used by: llm-compaction layer. */
export const COMPACTION_MAX_RETRIES = 2;

/** Oversized message char threshold for Level 2 fallback filtering. Used by: llm-compaction layer. */
export const OVERSIZED_MESSAGE_CHARS_THRESHOLD = 50_000;

/** Required sections in compaction summary for quality validation. Used by: llm-compaction layer. */
export const COMPACTION_REQUIRED_SECTIONS = [
  "Identifiers", "Primary Request and Intent", "Decisions",
  "Files and Code", "Errors and Resolutions", "User Messages",
  "Constraints", "Active Work", "Next Steps",
] as const;

/** Default number of user-turn cycles preserved at conversation head during
 *  LLM compaction for cache prefix stability.
 *  Used by: llm-compaction layer. */
export const DEFAULT_COMPACTION_PREFIX_ANCHOR_TURNS = 2;

/** Minimum middle-zone messages before LLM summarization is worthwhile.
 *  Below this threshold, compaction is skipped since savings are negligible.
 *  Used by: llm-compaction layer. */
export const MIN_MIDDLE_MESSAGES_FOR_COMPACTION = 3;

/** SUMW-01 (Phase 178): reserved token allowance for the summarizer prompt
 *  TEMPLATE around the input span — the SDK generateSummary instruction
 *  template (order of a few hundred tokens), reserved with margin. The
 *  threaded previousSummary is NOT covered by this constant (review WR-03: it
 *  can itself be ~target-sized — 1_200 leaf / 2_000 condense defaults, and
 *  `condensedTargetTokens` allows 10_000 — so a flat reserve cannot cover it
 *  by its own arithmetic); both LCD clamp sites subtract the ACTUAL
 *  previousSummary tokens separately. The pipeline span clamp threads no
 *  previousSummary, so there this constant covers the whole overhead. The SDK
 *  exposes no overhead number, so this is a deliberate conservative reserve:
 *  too LARGE only shrinks chunks (more bounded drain passes — benign); too
 *  SMALL risks marginal overflow on exactly-window-sized spans. 2_048 matches
 *  the MIN_SAFETY_MARGIN_TOKENS magnitude convention; the
 *  compaction-span-invariant test is the safety net.
 *  Used by: llm-compaction (pipeline span clamp), lcd-compaction-trigger
 *  (leaf chunk clamp), lcd-condense-trigger (condense prefix clamp). */
export const SUMMARIZER_PROMPT_OVERHEAD_TOKENS = 2_048;

// ---------------------------------------------------------------------------
// LCD Leaf Summarization Escalation (Phase 129, C1)
// ---------------------------------------------------------------------------

/** Bounded token target for the deterministic Level-3 leaf-summary truncation —
 *  the guaranteed-shrink floor (LOSSLESS-CLAW §5). When both LLM summarization
 *  levels fail to reduce the chunk (oversized output or throws), Level 3 builds a
 *  count-only note capped at this size so the leaf summary ALWAYS ends up strictly
 *  smaller than the chunk it replaces (the escalation terminator — never loops).
 *  Used by: lcd-leaf-summarizer (Level-3 deterministic truncation). */
export const LEAF_FALLBACK_TARGET_TOKENS = 512;

/** Marker string prefixed onto the deterministic Level-3 leaf truncation output so
 *  a fallback (non-LLM) leaf summary is identifiable downstream (Phase 132
 *  taint-escapes it; the assembler/store record `fallback: true`). The two LLM
 *  levels never emit this marker — its presence means the deterministic floor ran.
 *  Used by: lcd-leaf-summarizer (Level-3 marker). */
export const LEAF_FALLBACK_SUMMARY_MARKER = "[lcd-leaf-fallback]";

/** B-2: hard cap on the number of leaf passes one afterTurn drain may fire (the
 *  infinite-loop backstop). The drain loops `runOneLeafPass` — re-resolving the
 *  model-facing view each iteration so utilization reflects the prior pass's
 *  compaction — and terminates on the FIRST of: utilization ≤ contextThreshold
 *  (drained, the success exit), a no-progress guard (no chunk / chunk below
 *  MIN_SHRINKABLE / ordinal-window divergence), OR this cap.
 *
 *  Set LOW (4) deliberately: under `deferCompaction:false` the afterTurn drain runs
 *  INLINE + synchronously, so EACH pass is a real LLM round-trip blocking the live
 *  turn — a turn must NEVER fire unbounded synchronous summarizer calls. Four passes
 *  is enough to drain a few back-to-back large turns' backlog under threshold in one
 *  turn while bounding worst-case added latency; a sustained over-threshold load that
 *  the cap cannot fully drain in one turn simply continues draining on the next
 *  afterTurn (the leaf gate stays armed) rather than stalling at one pass forever
 *  (the B-2 stall this fixes). Used by: lcd-compaction-trigger (the drain loop cap). */
export const LCD_MAX_LEAF_PASSES_PER_TURN = 4;

/** TRUSTED-HEADER marker (R2, Phase 132) appended to a fallback summary's
 *  `summaryRefToMessage` header — OUTSIDE the `wrapExternalContent` untrusted
 *  region — so the model is honestly told the summary is an emergency, degraded
 *  truncation (the breaker/spend-cap floor or the deterministic Level-3 floor
 *  produced it, with no LLM). UNSPOOFABLE by construction: the body lives inside
 *  the per-session random hex delimiter and `replaceMarkers`/`foldMarkerText`
 *  neutralize any forged copy, so a poisoned body can neither forge nor strip
 *  this header marker — only the real `LcdSummary.fallback` row flag drives it.
 *  Distinct concern from {@link LEAF_FALLBACK_SUMMARY_MARKER} (the in-CONTENT
 *  Level-3 prefix); this is the header equivalent. Used by: lcd-assembler. */
export const LCD_FALLBACK_HEADER_MARKER = "fallback=emergency-truncation";

/** B-8: per-tool-RESULT character cap for tool results sitting in the LCD `dag`
 *  assembler's UNCONDITIONAL fresh tail. The dag assembly path runs NEITHER the
 *  pipeline observation masker NOR the dead-content evictor (those are wired only
 *  in the pipeline branch), and the fresh tail is concatenated verbatim and
 *  UNCONDITIONALLY (`[...budgeted, ...freshTail]`, A1/A3) — so a turn whose last
 *  `freshTailTurns` steps carry a huge tool output (a 200K-char file read, a giant
 *  command dump) can overflow the model window before any budget pass sees it.
 *  This cap bounds each oversized fresh-tail tool RESULT's total text via the
 *  shared `createToolResultSizeGuard()` (head+tail+honest marker — NOT hand-rolled)
 *  while every result that fits passes through byte-identical (A1 preserved for
 *  what fits).
 *
 *  Value = {@link TOOL_RESULT_HARD_CAP_CHARS} (100_000), the same absolute
 *  per-result ceiling the pipeline microcompaction guard enforces — chosen for
 *  consistency with the existing tiering rather than the tighter
 *  {@link MAX_INLINE_MCP_TOOL_RESULT_CHARS} (15_000) so the assembler only bounds
 *  genuinely pathological results and leaves normal-large tool outputs intact in
 *  the fresh tail. A SINGLE per-result cap (the simplest correct shape) is used,
 *  not a "then largest-first total-tail budget" tier: 100K chars ≈ 28.6K tokens
 *  per result at {@link CHARS_PER_TOKEN_RATIO}, so even a fresh tail of several
 *  capped results fits any modern window's fresh-tail allowance — masking is
 *  acceptable ONLY because the LCD store keeps the full content losslessly and
 *  `ctx_expand` recovers it. Used by: lcd-assembler (B-8 fresh-tail bounding). */
export const LCD_FRESH_TAIL_MAX_TOOL_RESULT_CHARS = TOOL_RESULT_HARD_CAP_CHARS;

// ---------------------------------------------------------------------------
// LCD Condensation Escalation (Phase 130, C2) — the depth>0 summary-of-summaries
// ---------------------------------------------------------------------------

/** Bounded token target for the deterministic Level-3 CONDENSATION truncation —
 *  the guaranteed-shrink floor mirroring {@link LEAF_FALLBACK_TARGET_TOKENS}. When
 *  both LLM levels fail to reduce a contiguous run of CHILD summaries (oversized
 *  output or throws), Level 3 builds a count-only note capped at this size so the
 *  condensed summary ALWAYS ends up strictly smaller than the Σ child tokenCount it
 *  replaces (the escalation terminator — never loops).
 *  Used by: lcd-condense (Level-3 deterministic truncation). */
export const CONDENSED_FALLBACK_TARGET_TOKENS = 512;

/** Marker string prefixed onto the deterministic Level-3 condensation truncation
 *  output so a fallback (non-LLM) condensed summary is identifiable downstream
 *  (Phase 132 taint-escapes it; the store records `fallback: true`). The two LLM
 *  levels never emit this marker — its presence means the deterministic floor ran.
 *  Distinct from the leaf marker so the two tiers' floors are separable in logs +
 *  the synthetic-session gate. Used by: lcd-condense (Level-3 marker). */
export const CONDENSED_FALLBACK_SUMMARY_MARKER = "[lcd-condensed-fallback]";

// ---------------------------------------------------------------------------
// Post-Compaction Rehydration (Layer 6)
// ---------------------------------------------------------------------------

/** Maximum number of recently-accessed files to re-inject after compaction. Used by: rehydration layer. */
export const MAX_REHYDRATION_FILES = 5;

/** Maximum chars per rehydrated file content before truncation. Used by: rehydration layer. */
export const MAX_REHYDRATION_FILE_CHARS = 8_000;

/** Maximum total chars for all rehydration content (safety cap). Used by: rehydration overflow check. */
export const MAX_REHYDRATION_TOTAL_CHARS = 30_000;

/** Maximum chars per individual skill in rehydration restoration.
 *  Skills exceeding this limit are truncated at the boundary with closing tag repair.
 *  Used by: rehydration layer buildSkillsContent(). */
export const MAX_REHYDRATION_CHARS_PER_SKILL = 5_000;

/** Maximum total chars for all rehydration content combined.
 *  This is the token-budgeted restoration cap (50K chars ~ 12,500 tokens at 4:1 ratio).
 *  Used by: rehydration layer overflow check. */
export const MAX_REHYDRATION_TOKEN_BUDGET_CHARS = 50_000;

// ---------------------------------------------------------------------------
// Dead Content Evictor
// ---------------------------------------------------------------------------

/**
 * Default minimum age (in tool result positions) before content is eligible
 * for eviction. Used by: dead content evictor layer.
 */
export const DEAD_CONTENT_EVICTION_MIN_AGE = 10;

// ---------------------------------------------------------------------------
// Cache Break Detection
// ---------------------------------------------------------------------------

/** Relative threshold for cache break detection. Break detected when cacheRead
 *  drops by more than this fraction of the previous baseline.
 *  Used by: cache break detector. */
export const CACHE_BREAK_RELATIVE_THRESHOLD = 0.05;

/** Absolute threshold for cache break detection (tokens). Break detected when
 *  cacheRead drops by more than this many tokens from the previous baseline.
 *  Both relative AND absolute thresholds must be exceeded to trigger detection.
 *  Used by: cache break detector. */
export const CACHE_BREAK_ABSOLUTE_THRESHOLD = 2_000;
