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
// Thinking Block Cleaner (Layer 4: )
// ---------------------------------------------------------------------------

/** Default number of recent assistant turns that retain thinking blocks. Used by: thinking block cleaner (Layer 4). */
export const DEFAULT_KEEP_WINDOW_TURNS = 10;

// ---------------------------------------------------------------------------
// Microcompaction Guard (Layer 2: )
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
// Observation Masker (Layer 3: )
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
  ["file_read", "protected"], // legacy alias — upstream SDK may emit this name
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
 *  against production dashboard data). Aligned with estimateBlockTokens(). */
export const CHARS_PER_TOKEN_RATIO = 3.5;

/** Chars-per-token estimation ratio for structured content (JSON, code, tool results).
 *  Code and JSON tokenize at ~2.5-3 chars/token due to punctuation, short identifiers,
 *  and special characters each consuming full tokens. 3:1 is a conservative improvement
 *  over the flat 4:1 ratio. Used by: content-aware token estimation. */
export const CHARS_PER_TOKEN_RATIO_STRUCTURED = 3;

// ---------------------------------------------------------------------------
// Cache Optimization (Layer: )
// ---------------------------------------------------------------------------

/** Length of truncated SHA-256 digest for system prompt hash comparison. Used by: prompt-assembly hash validation. */
export const SYSTEM_PROMPT_HASH_LENGTH = 16;

/** Warn if bootstrap content exceeds this percentage of system prompt. Used by: prompt-assembly budget tracking. */
export const BOOTSTRAP_BUDGET_WARN_PERCENT = 85;

/**
 * Minimum cacheable token thresholds by model family prefix.
 * Used by: cache breakpoint placement.
 *
 * Values are Anthropic's official API minimums verified 2026-03-30.
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
// LLM Compaction (Layer 5: )
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

// ---------------------------------------------------------------------------
// Post-Compaction Rehydration (Layer 6: )
// ---------------------------------------------------------------------------

/** Maximum number of recently-accessed files to re-inject after compaction. Used by: rehydration layer. */
export const MAX_REHYDRATION_FILES = 5;

/** Maximum chars per rehydrated file content before truncation. Used by: rehydration layer. */
export const MAX_REHYDRATION_FILE_CHARS = 8_000;

/** Maximum total chars for all rehydration content (safety cap). Used by: rehydration overflow check. */
export const MAX_REHYDRATION_TOTAL_CHARS = 30_000;

/** Maximum chars per individual skill in rehydration restoration (POST-COMPACT-BUDGET).
 *  Skills exceeding this limit are truncated at the boundary with closing tag repair.
 *  Used by: rehydration layer buildSkillsContent(). */
export const MAX_REHYDRATION_CHARS_PER_SKILL = 5_000;

/** Maximum total chars for all rehydration content combined (POST-COMPACT-BUDGET).
 *  This is the token-budgeted restoration cap (50K chars ~ 12,500 tokens at 4:1 ratio).
 *  Used by: rehydration layer overflow check. */
export const MAX_REHYDRATION_TOKEN_BUDGET_CHARS = 50_000;

// ---------------------------------------------------------------------------
// Dead Content Evictor (Layer: )
// ---------------------------------------------------------------------------

/**
 * Default minimum age (in tool result positions) before content is eligible
 * for eviction. Used by: dead content evictor layer.
 */
export const DEAD_CONTENT_EVICTION_MIN_AGE = 10;

// ---------------------------------------------------------------------------
// DAG Compaction
// ---------------------------------------------------------------------------

/**
 * Depth-aware summarization prompts for the DAG compaction engine.
 *
 * Each depth level has a "normal" (Tier 1) and "aggressive" (Tier 2) prompt.
 * Depth 0 = operational detail, depth 1 = session summary, depth 2 = phase summary,
 * depth 3+ = project memory (durable decisions, architectural choices).
 *
 * Used by: `getDepthPrompt()` in `dag-compaction.ts`.
 */
export const DEPTH_PROMPTS: Record<number, { normal: string; aggressive: string }> = {
  0: {
    normal: `Summarize this conversation segment, preserving:
- Decisions made and their rationale
- Tool outputs and their significance
- File changes and paths
- Error messages and resolutions
- Blockers and constraints identified
Drop: filler, greetings, repetition, verbose tool output formatting.
Target: concise operational summary.`,
    aggressive: `Create a tight summary of this conversation segment.
Keep ONLY: key decisions, critical file paths, error resolutions, active constraints.
Drop everything else. Be extremely concise.`,
  },
  1: {
    normal: `Summarize this session, preserving:
- Decision chains and their outcomes
- Active constraints and requirements
- Completed work items
- Unresolved issues
Drop: individual tool calls, intermediate states, process details.
Target: session-level summary.`,
    aggressive: `Create a tight session summary.
Keep ONLY: final decisions, outcomes, active constraints.
Drop all process detail.`,
  },
  2: {
    normal: `Summarize this phase of work, preserving:
- Overall trajectory and direction changes
- Evolved decisions and why they changed
- Completed milestones
- Outstanding work
Drop: session-specific details, individual identifiers.
Target: phase-level summary.`,
    aggressive: `Create a tight phase summary.
Keep ONLY: trajectory, key decisions, milestones.`,
  },
  3: {
    normal: `Summarize this body of work as project memory, preserving:
- Durable decisions and architectural choices
- Lessons learned
- Key relationships and dependencies
Drop: process details, method specifics, temporal references.
Target: long-term project knowledge.`,
    aggressive: `Distill to essential project knowledge.
Keep ONLY: architectural decisions, lessons, critical dependencies.`,
  },
};

/** Multiplier beyond target tokens that triggers escalation to next tier. Used by: three-tier escalation in dag-compaction.ts. */
export const DAG_ESCALATION_OVERRUN_TOLERANCE = 1.5;

/** Prefix for generated summary IDs (e.g., "sum_a1b2c3d4e5f6a7b8"). Used by: dag-compaction.ts ID generation. */
export const DAG_SUMMARY_ID_PREFIX = "sum_";

/** Number of random bytes for summary ID generation (produces 16 hex characters). Used by: dag-compaction.ts ID generation. */
export const DAG_SUMMARY_ID_BYTES = 8;

// ---------------------------------------------------------------------------
// DAG Assembly
// ---------------------------------------------------------------------------

/** Estimated token overhead per XML-wrapped summary (accounts for `<context_summary>` tag, attributes, closing tag). Used by: dag-assembler.ts budget selection. */
export const XML_WRAPPER_OVERHEAD_TOKENS = 40;

/** Recall tool guidance injected as the first message in assembled DAG output. Used by: dag-assembler.ts recall guidance injection. */
export const RECALL_GUIDANCE = `You have access to a context DAG containing your full conversation history. Summaries marked with <context_summary> tags contain compressed versions of earlier exchanges. To view full details of any summarized content, use the ctx_inspect tool with the summary ID. For broader recall across your history, use ctx_search with a text query.`;

// ---------------------------------------------------------------------------
// Cache Break Detection
// ---------------------------------------------------------------------------

/** Relative threshold for cache break detection. Break detected when cacheRead
 *  drops by more than this fraction of the previous baseline.
 *  Used by: cache break detector Phase 2 check. */
export const CACHE_BREAK_RELATIVE_THRESHOLD = 0.05;

/** Absolute threshold for cache break detection (tokens). Break detected when
 *  cacheRead drops by more than this many tokens from the previous baseline.
 *  Both relative AND absolute thresholds must be exceeded to trigger detection.
 *  Used by: cache break detector Phase 2 check. */
export const CACHE_BREAK_ABSOLUTE_THRESHOLD = 2_000;
