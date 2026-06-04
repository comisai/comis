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
 * Imports nothing from sibling leaves (model/context/prompt/runtime) —
 * one-directional dependency graph; the top-level `AgentConfigSchema` in
 * `schema-agent-runtime.ts` composes from this leaf.
 *
 * @module
 */
import { z } from "zod";

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
  /** Operating mode: "pipeline" for sequential layer composition (the default
   *  sequential-layer engine). "dag" (= the v2.12 LCD engine) is being
   *  reimplemented and is NOT currently available — selecting it falls back to
   *  the pipeline engine with a logged warning until it is re-enabled
   *  (Phase 133). The value is retained in the enum as a stub so a config
   *  pinned to "dag" still parses and boots cleanly on pipeline. */
  version: z.enum(["pipeline", "dag"]).default("pipeline"),

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

  /** Number of most recent turns always included verbatim in DAG context. */
  freshTailTurns: z.number().int().min(1).max(50).default(8),
  /** Context utilization fraction that triggers DAG compaction (0.1 to 0.95). */
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
