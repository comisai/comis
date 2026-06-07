// SPDX-License-Identifier: Apache-2.0
/**
 * Agent config — Session lifecycle, context engine, and context guard schemas.
 *
 * Owns:
 *   - Session lifecycle: ResetPolicy, SessionResetPolicy, DmScope, Pruning,
 *     SessionCompaction.
 *   - Context engine: ContextEngineConfig (pipeline + DAG modes; output
 *     escalation; post-batch continuation).
 *   - Context guard: ContextPruningConfig, SourceGateConfig.
 *
 * Imports `CircuitBreakerConfigSchema` from the model leaf (the R1 summarizer
 * breaker REUSES it — DRY, mirrors the embedding-resilience breaker) but nothing
 * else from sibling leaves; the dependency graph stays one-directional and
 * acyclic (model has no reverse import of context). The top-level
 * `AgentConfigSchema` in `schema-agent-runtime.ts` composes from this leaf.
 *
 * @module
 */
import { z } from "zod";
import { CircuitBreakerConfigSchema } from "./schema-agent-model.js";

// ── Session Lifecycle Schemas ────────────────────────────────────────────

/**
 * Session lifecycle configuration schemas.
 *
 * Owns session reset policy, DM scope isolation, pruning of oversized
 * tool results, and per-agent compaction thresholds.
 */

/**
 * Per-session-type reset policy override.
 * All fields are optional -- omitted fields inherit from the parent policy.
 */
export const ResetPolicyOverrideSchema = z.strictObject({
  /** Override reset mode for this session type */
  mode: z.enum(["daily", "idle", "hybrid", "none"]).optional(),
  /** Override daily reset hour (0-23) */
  dailyResetHour: z.number().int().min(0).max(23).optional(),
  /** Override IANA timezone for daily reset */
  dailyResetTimezone: z.string().optional(),
  /** Override idle timeout in milliseconds */
  idleTimeoutMs: z.number().int().positive().optional(),
});

/**
 * Session reset policy configuration.
 * Controls automatic session expiry via daily, idle, or hybrid modes.
 */
export const SessionResetPolicySchema = z.strictObject({
  /** Reset mode: daily, idle, hybrid (first-to-expire), or none (disabled) */
  mode: z.enum(["daily", "idle", "hybrid", "none"]).default("daily"),
  /** Hour of day for daily reset (0-23, default 4 = 4 AM) */
  dailyResetHour: z.number().int().min(0).max(23).default(4),
  /** IANA timezone for daily reset (empty string = system local) */
  dailyResetTimezone: z.string().default(""),
  /** Idle timeout in milliseconds (default 4 hours = 14_400_000) */
  idleTimeoutMs: z.number().int().positive().default(14_400_000),
  /** Sweep interval in milliseconds (how often to check sessions, default 5 min) */
  sweepIntervalMs: z.number().int().positive().default(300_000),
  /** Phrases that trigger immediate session reset when sent as a message */
  resetTriggers: z.array(z.string()).default([]),
  /** Per-session-type overrides (dm, group, thread) */
  perType: z.strictObject({
    dm: ResetPolicyOverrideSchema.optional(),
    group: ResetPolicyOverrideSchema.optional(),
    thread: ResetPolicyOverrideSchema.optional(),
  }).default({}),
});

/**
 * DM scope configuration for session key isolation granularity.
 *
 * Controls how DM (direct message) conversations are scoped:
 * - "main": all DMs share a single session (userId="main", channelId="dm")
 * - "per-peer": one session per peer across all channels
 * - "per-channel-peer": one session per channel+peer (default)
 * - "per-account-channel-peer": includes bot account identifier in channel for multi-bot isolation
 */
export const DmScopeConfigSchema = z.strictObject({
  /** DM scope mode controlling session isolation granularity */
  mode: z.enum(["main", "per-peer", "per-channel-peer", "per-account-channel-peer"])
    .default("per-channel-peer"),
  /** Append :thread:<threadId> to session keys for forum/thread isolation */
  threadIsolation: z.boolean().default(true),
});

/**
 * Session pruning configuration for in-memory tool result trimming.
 *
 * Controls how oversized tool results are trimmed before each LLM call.
 * Pruning operates on copies only -- persisted session data is never affected.
 */
export const PruningConfigSchema = z.strictObject({
  /** Enable session pruning of oversized tool results */
  enabled: z.boolean().default(true),
  /** Character threshold above which tool results are soft-trimmed (head + tail with marker) */
  softTrimThresholdChars: z.number().int().positive().default(8_000),
  /** Character threshold above which tool results are hard-cleared (entire content replaced) */
  hardClearThresholdChars: z.number().int().positive().default(30_000),
  /** Number of characters to preserve at the start of a soft-trimmed result */
  preserveHeadChars: z.number().int().nonnegative().default(500),
  /** Number of characters to preserve at the end of a soft-trimmed result */
  preserveTailChars: z.number().int().nonnegative().default(500),
  /** Tools whose results are eligible for pruning (empty = all tools eligible) */
  pruneableTools: z.array(z.string()).default([]),
  /** Tools whose results are never pruned (takes precedence over pruneableTools) */
  protectedTools: z.array(z.string()).default([]),
  /** Protect tool results containing image content blocks from pruning */
  protectImageBlocks: z.boolean().default(true),
  /** Number of recent messages (from end of array) exempt from pruning */
  preserveRecentCount: z.number().int().nonnegative().default(6),
});

/**
 * Session compaction configuration.
 *
 * Controls when pre-compaction memory flushes and hard compaction triggers
 * fire, based on context window usage ratios. The flushModel option allows
 * using a cheaper model for memory extraction.
 */
export const SessionCompactionConfigSchema = z.strictObject({
  /** Fraction of maxContextChars at which soft flush triggers (memory extraction only) */
  softThresholdRatio: z.number().min(0).max(1).default(0.75),
  /** Fraction of maxContextChars at which hard compaction triggers (flush + trim) */
  hardThresholdRatio: z.number().min(0).max(1).default(0.90),
  /** Model to use for memory extraction during flush (defaults to cheap model) */
  flushModel: z.string().optional(),
  /** Max characters per summarization chunk. Default: 50_000. */
  chunkMaxChars: z.number().int().positive().default(50_000),
  /** Number of overlap messages between chunks. Default: 2. */
  chunkOverlapMessages: z.number().int().nonnegative().default(2),
  /** Whether to merge chunk summaries via LLM. Default: true. */
  chunkMergeSummaries: z.boolean().default(true),
  /** Tokens reserved for summary during SDK auto-compaction. Default: 16384. */
  reserveTokens: z.number().int().positive().default(16384),
  /** Tokens worth of recent messages to keep after SDK auto-compaction. Default: 32768. */
  keepRecentTokens: z.number().int().positive().default(32768),
  /** AGENTS.md section names to re-inject after compaction. */
  postCompactionSections: z.array(z.string()).default(["Session Startup", "Red Lines"]),
});

export type SessionResetPolicyConfig = z.infer<typeof SessionResetPolicySchema>;
export type ResetPolicyOverride = z.infer<typeof ResetPolicyOverrideSchema>;
export type DmScopeConfig = z.infer<typeof DmScopeConfigSchema>;
export type PruningConfig = z.infer<typeof PruningConfigSchema>;
export type SessionCompactionConfig = z.infer<typeof SessionCompactionConfigSchema>;

// ── Context Engine Schema ───────────────────────────────────────────────

/**
 * Context engine configuration schema.
 *
 * Controls the context engine operating in either **pipeline** mode
 * (sequential layer composition: thinking cleaner, history window,
 * dead content evictor, observation masker, LLM compaction, rehydration)
 * or **DAG** mode (graph-based context management with leaf/condensed
 * nodes, incremental recall, and annotation-driven eviction).
 *
 * All fields have sensible defaults so an empty `{}` is always valid.
 * The flat schema validates all fields regardless of the active `version`
 * to prevent invalid saved configurations.
 *
 * Only top-level settings are exposed to users; internal budget
 * components (safety margin, output reserve, rot buffer) are
 * controlled by constants in @comis/agent.
 *
 * @module
 */

/** Context engine configuration (per-agent). */
export const ContextEngineConfigSchema = z.strictObject({
  // --- Core ---

  /** Master toggle for the context engine pipeline (enabled by default). */
  enabled: z.boolean().default(true),
  /** Operating mode: "dag" (= the v2.12 LCD engine) is the DEFAULT
   *  working-context engine — it keeps a lossless verbatim history (full faithful
   *  reconstruction via the parts codec + a verbatim fresh tail of the last N
   *  steps + transcript repair, multi-tier zoomable compaction, and the in-session
   *  expansion loop) instead of dropping/masking old content. "pipeline" is the
   *  first-class opt-in (`version: "pipeline"`): the simpler sequential-layer
   *  engine, retained as the fallback. The daemon injects the ContextStorePort
   *  unconditionally, so "dag" "just works" for every daemon agent; a storeless
   *  context (a non-daemon unit caller) falls back to pipeline with a logged
   *  warning — behaviorally identical, never a crash. */
  version: z.enum(["pipeline", "dag"]).default("dag"),

  // --- Shared (both modes) ---

  /** Number of recent assistant turns that retain thinking blocks (older turns get stripped). */
  thinkingKeepTurns: z.number().int().min(1).max(50).default(10),
  /** Idle gap (ms) above which signed thinking state is treated as drifted and
   *  scrubbed pre-send to avoid provider replay-rejection. Default 30 min —
   *  below long-TTL caches and below the 74-min production incident gap. Also
   *  triggers on model id / provider / api change (those checks are
   *  unconditional regardless of this idle threshold). Range: 1 min .. 24 h. */
  replayDriftIdleMs: z.number().int().min(60_000).max(24 * 60 * 60_000).default(30 * 60_000),
  /** Model for LLM compaction in "provider:modelId" format. Empty string
   *  (the default) triggers runtime resolution against the agent's primary
   *  provider via pi-ai catalog (fast-tier cost model). Avoids pinning a
   *  hardcoded Anthropic literal that goes stale on pi-ai upgrades and
   *  cross-routes background ops to Claude when primary is OpenRouter/Google/etc. */
  compactionModel: z.string().default(""),
  /** Minimum age (in tool result positions) before content is eligible for dead content eviction. */
  evictionMinAge: z.number().int().min(3).max(50).default(15),

  // --- Pipeline mode ---

  /** Number of recent user turns to keep in context (default 15). */
  historyTurns: z.number().int().min(3).max(100).default(15),
  /** Per-agent or per-channel-type turn count overrides (e.g., { dm: 10, "trader-1": 30 }). */
  historyTurnOverrides: z.record(
    z.string(),
    z.number().int().min(1).max(100),
  ).optional(),
  /** Number of most recent tool uses that retain full content (older ones are masked). */
  observationKeepWindow: z.number().int().min(1).max(50).default(25),
  /** Character threshold before observation masking activates (below this, masking is skipped). */
  observationTriggerChars: z.number().int().min(50_000).max(1_000_000).default(120_000),
  /** Character threshold below which observation masking deactivates (hysteresis). */
  observationDeactivationChars: z.number().int().min(20_000).max(500_000).default(80_000),
  /** Keep window for ephemeral-tier tools (web_search, brave_search, web_fetch, link_reader, fetch_url). Shorter than observationKeepWindow. Default: 10. */
  ephemeralKeepWindow: z.number().int().min(1).max(50).default(10),
  /** Turns to wait before re-triggering LLM compaction after a successful compaction. */
  compactionCooldownTurns: z.number().int().min(1).max(50).default(5),
  /** Number of user-turn cycles at the head of conversation to preserve during
   *  LLM compaction for cache prefix stability. 0 = old behavior
   *  (summarize everything, keep tail only). */
  compactionPrefixAnchorTurns: z.number().int().min(0).max(10).default(2),

  /** Output escalation configuration: auto-retry with higher output budget on max_tokens truncation. */
  outputEscalation: z.strictObject({
    /** Master toggle for output escalation. When false, max_tokens truncation is not retried. */
    enabled: z.boolean().default(true),
    /** Escalated max output tokens for the retry attempt. Must be between 4096 and 128000. */
    escalatedMaxTokens: z.number().int().min(4096).max(128_000).default(32_768),
  }).default({ enabled: true, escalatedMaxTokens: 32_768 }),

  // --- DAG mode ---

  /** Number of most recent STEPS (assistant + tool round-trips, NOT user-turns)
   *  always included verbatim in the dag/LCD context (A1). A step = one assistant
   *  message plus the tool results it triggered; the last N steps are kept as the
   *  ORIGINAL structured blocks (never reconstructed-from-text) and are never
   *  evicted. Default 8 is a safe production floor; the tuned value comes from
   *  real-LLM measurement in a later phase. */
  freshTailTurns: z.number().int().min(1).max(50).default(8),
  /** Context utilization fraction that triggers DAG leaf summarization (0.1 to
   *  0.95). LIVE in dag/LCD mode (Phase 129): at the end of a turn, when total
   *  context tokens / model window exceeds this fraction, the oldest out-of-tail
   *  chunk is summarized into a leaf summary + the context is assembled under the
   *  token budget. Inert in pipeline mode. */
  contextThreshold: z.number().min(0.1).max(0.95).default(0.75),
  /** Minimum fan-out for leaf nodes in the DAG. */
  leafMinFanout: z.number().int().min(2).max(20).default(8),
  /** Minimum fan-out for condensed (non-leaf) nodes in the DAG. */
  condensedMinFanout: z.number().int().min(2).max(20).default(4),
  /** Hard minimum fan-out for condensed nodes (lowest allowed). */
  condensedMinFanoutHard: z.number().int().min(2).max(10).default(2),
  /** Maximum depth for incremental DAG rebuilds (-1 = full rebuild). */
  incrementalMaxDepth: z.number().int().min(-1).max(10).default(0),
  /** Token budget for leaf node chunks in the DAG. */
  leafChunkTokens: z.number().int().min(1000).max(100_000).default(20_000),
  /** Target token size for leaf node summaries. */
  leafTargetTokens: z.number().int().min(96).max(5_000).default(1_200),
  /** Target token size for condensed node summaries. */
  condensedTargetTokens: z.number().int().min(256).max(10_000).default(2_000),
  /** Maximum tokens for expanded context retrieval. */
  maxExpandTokens: z.number().int().min(500).max(50_000).default(4_000),
  /** Maximum recall operations per day per agent. */
  maxRecallsPerDay: z.number().int().min(1).max(100).default(10),
  /** Timeout for recall operations in milliseconds. */
  recallTimeoutMs: z.number().int().min(10_000).max(600_000).default(120_000),
  /** Token threshold above which a file is considered "large" for DAG processing. */
  largeFileTokenThreshold: z.number().int().min(1000).max(200_000).default(25_000),
  /** Number of most recent annotations retained in DAG mode (analogous to observationKeepWindow). */
  annotationKeepWindow: z.number().int().min(1).max(50).default(15),
  /** Character threshold before annotation eviction activates in DAG mode. */
  annotationTriggerChars: z.number().int().min(10_000).max(1_000_000).default(200_000),
  /** Optional model override for DAG summary generation in "provider:modelId" format. */
  summaryModel: z.string().optional(),
  /** Optional provider override for DAG summary generation. */
  summaryProvider: z.string().optional(),

  // --- DAG robustness / spend / deferred compaction (Phase 132 C4 + R1) ---

  /** When true (default), the afterTurn leaf + condense passes are deferred onto
   *  the per-conversation serializer and never block the turn's afterTurn hook
   *  (C4). When false, they run inline (the pre-132 behaviour) for deterministic
   *  tests. */
  deferCompaction: z.boolean().default(true),
  /** Per-tenant rolling-window ceilings on summarizer LLM input+output tokens
   *  (R1). When a ceiling is exceeded the summarizer seam is bypassed →
   *  truncation-only assembly (no LLM call), NOT a turn failure. Consumed by
   *  plans 132-05/132-06. */
  summarizerSpend: z.strictObject({
    /** Rolling-hour per-tenant summarizer token ceiling. 0 disables the hourly
     *  cap. Default 500_000 — a few hundred-thousand tokens/hour, well below the
     *  primary per-hour execution budget (10M) since this is a background seam. */
    maxTokensPerTenantPerHour: z.number().int().min(0).default(500_000),
    /** Rolling-day per-tenant summarizer token ceiling. 0 disables the daily cap.
     *  Default 5_000_000 — 10× the hourly default (≥ the hourly ceiling) and
     *  below the 100M primary per-day execution budget. */
    maxTokensPerTenantPerDay: z.number().int().min(0).default(5_000_000),
    // Fully-populated default object (NOT `.default({})`) so an empty config
    // resolves to the real ceilings — mirrors outputEscalation/postBatchContinuation
    // in this file. Zod uses a `.default(value)` verbatim and does NOT re-parse it
    // through the inner field defaults, so `{}` would leave the ceilings undefined.
  }).default({ maxTokensPerTenantPerHour: 500_000, maxTokensPerTenantPerDay: 5_000_000 }),
  /** Circuit breaker for the per-tenant summarizer seam (R1). N consecutive
   *  summarizer failures open the breaker → truncation-only assembly until
   *  resetTimeoutMs elapses. Mirrors the embedding-resilience breaker
   *  (setup-memory.ts); REUSES CircuitBreakerConfigSchema (failureThreshold /
   *  resetTimeoutMs / halfOpenTimeoutMs) rather than re-declaring the fields. The
   *  fully-populated default object mirrors the inner CircuitBreakerConfigSchema
   *  defaults (a bare `.default({})` would not re-parse the inner field defaults). */
  summarizerBreaker: CircuitBreakerConfigSchema.default({
    failureThreshold: 5,
    resetTimeoutMs: 60_000,
    halfOpenTimeoutMs: 30_000,
  }),

  // --- Post-batch continuation (replaces SEP nudge enforcement) ---

  /** Post-batch continuation handler: when the LLM emits an empty final
   *  turn after a successful tool batch, fire a directive followUp with
   *  multi-shot retry. Replaces the legacy SEP one-shot completeness nudge
   *  (whose enforcement role was superseded; SEP plan extraction + step
   *  counting remain intact for observability). */
  postBatchContinuation: z.strictObject({
    /** Master toggle. When false, handler returns
     *  {recovered: false, outcome: "disabled"} without calling followUp. */
    enabled: z.boolean().default(true),
    /** Maximum directive followUp attempts before falling through to L3
     *  synthesis. 0 = disabled. */
    maxRetries: z.number().int().min(0).max(5).default(2),
  }).default({ enabled: true, maxRetries: 2 }),

  // --- Phase 152: Capacity + Prompt-Security (C1, C2/S1, C4/S4) ---

  /** C1: Effective-context cap by capability class. For small/nano models with a large
   *  contextWindow, caps effective context before computing H to prevent 256K overfill.
   *  frontier/mid always receive the full contextWindow. Config-driven so operators can
   *  tune per their model's measured comprehension limit. */
  budget: z.strictObject({
    /** Max effective context tokens for capabilityClass="small". 0 = no cap (use raw contextWindow). */
    effectiveContextCapSmall: z.number().int().nonnegative().default(32_000),
    /** Max effective context tokens for capabilityClass="nano". 0 = no cap. */
    effectiveContextCapNano: z.number().int().nonnegative().default(16_000),
    // Fully-populated default object (NOT `.default({})`) — see summarizerSpend pattern above.
    // Zod does NOT re-parse inner field defaults from `.default({})`.
  }).default({ effectiveContextCapSmall: 32_000, effectiveContextCapNano: 16_000 }),

  /** C4: Capability-routed compaction. For small/nano capabilityClass, prefer eviction
   *  or a configured stronger summarizer over same-model LLM summarization (which degrades). */
  compaction: z.strictObject({
    /** When true (default): small/nano → eviction-first (or strongerSummarizerModel if set).
     *  When false: operator opt-out — small/nano keep same-model LLM summarization. */
    preferEvictionByCapability: z.boolean().default(true),
    /** Optional "provider:modelId" string for a stronger summarizer for small/nano.
     *  Empty string (default) = pure eviction/deterministic fallback. */
    strongerSummarizerModel: z.string().default(""),
  }).default({ preferEvictionByCapability: true, strongerSummarizerModel: "" }),

  /** C2/S1: Compact-secure prompt for small/nano. Retains safety core + sender-trust +
   *  config-secret; drops interactive-only sections. NEVER uses buildSafetySection(true). */
  compactPrompt: z.strictObject({
    /** Enable compact-secure promptMode for small/nano capabilityClass. Default: true. */
    enabled: z.boolean().default(true),
    /** Soft token target for the compact prompt (chars/3.5). Default 3000 tokens ≈ 10500 chars. */
    targetTokens: z.number().int().min(500).max(8_000).default(3_000),
  }).default({ enabled: true, targetTokens: 3_000 }),
});

export type ContextEngineConfig = z.infer<typeof ContextEngineConfigSchema>;

// ── Context Guard Schemas ───────────────────────────────────────────────

/**
 * Context guard configuration schemas.
 *
 * ContextPruningConfigSchema -- progressive context pruning layer settings
 * (soft-trim at ratio threshold, hard-clear at higher ratio).
 *
 * SourceGateConfigSchema -- HTTP source gate layer settings
 * (byte cap and hidden HTML stripping).
 */

/** Progressive context pruning configuration (per-agent). */
export const ContextPruningConfigSchema = z.strictObject({
  /** Master toggle for progressive context pruning */
  enabled: z.boolean().default(true),
  /** Context ratio at which soft-trim begins (head+tail preservation) */
  softTrimRatio: z.number().min(0).max(1).default(0.3),
  /** Context ratio at which hard-clear begins (full placeholder replacement) */
  hardClearRatio: z.number().min(0).max(1).default(0.5),
  /** Number of recent assistant messages to protect from pruning */
  keepLastAssistants: z.number().int().nonnegative().default(3),
  /** Minimum tool result size in characters eligible for soft-trim */
  minPrunableToolChars: z.number().int().positive().default(4000),
  /** Tool names never pruned (strings in config, converted to RegExp patterns at runtime by consumer) */
  protectedTools: z.array(z.string()).default(["memory_search", "memory_get", "memory_store", "file_read"]),
}).refine(
  (data) => data.softTrimRatio < data.hardClearRatio,
  { message: "softTrimRatio must be less than hardClearRatio" },
);

/** Source gate configuration for HTTP response size and sanitization (per-agent). */
export const SourceGateConfigSchema = z.strictObject({
  /** Default byte cap for HTTP responses (matches DEFAULT_SOURCE_PROFILES.web_fetch.maxResponseBytes) */
  maxResponseBytes: z.number().int().positive().default(2_000_000),
  /** Whether to strip hidden HTML before extraction */
  stripHiddenHtml: z.boolean().default(true),
});

export type ContextPruningConfig = z.infer<typeof ContextPruningConfigSchema>;
export type SourceGateConfig = z.infer<typeof SourceGateConfigSchema>;
