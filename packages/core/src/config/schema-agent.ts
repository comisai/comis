import { z } from "zod";
import { TrustLevelSchema } from "../domain/memory-entry.js";
import { SkillsConfigSchema } from "./schema-skills.js";
import { AgentSecretsConfigSchema } from "./schema-secrets.js";
import { GeminiCacheConfigSchema } from "./schema-gemini-cache.js";
import { NotificationConfigSchema } from "./schema-notification.js";
import { VerbosityConfigSchema } from "./schema-verbosity.js";
import { BackgroundTasksConfigSchema } from "./schema-background-tasks.js";
import { MemoryReviewConfigSchema } from "./schema-memory-review.js";

// ── Model Selection Schemas ─────────────────────────────────────────────

/**
 * Model selection configuration schemas.
 *
 * Owns budget limits, circuit breaker thresholds, model route overrides,
 * fallback model entries, auth profile rotation, and failover configuration.
 */

export const BudgetConfigSchema = z.strictObject({
    /** Max tokens per single execution */
    perExecution: z.number().int().positive().default(2_000_000),
    /** Max tokens per hour (rolling window) */
    perHour: z.number().int().positive().default(10_000_000),
    /** Max tokens per day (rolling window) */
    perDay: z.number().int().positive().default(100_000_000),
  });

export const CircuitBreakerConfigSchema = z.strictObject({
    /** Number of consecutive failures before opening circuit */
    failureThreshold: z.number().int().positive().default(5),
    /** Milliseconds to wait before attempting recovery */
    resetTimeoutMs: z.number().int().positive().default(60_000),
    /** Milliseconds for half-open probe timeout */
    halfOpenTimeoutMs: z.number().int().positive().default(30_000),
  });

export const ToolRetryBreakerConfigSchema = z.strictObject({
    /** Enable tool retry circuit breaker. Default: true. */
    enabled: z.boolean().default(true),
    /** Max consecutive failures for same tool+args before blocking. Default: 3. */
    maxConsecutiveFailures: z.number().int().positive().default(3),
    /** Max total failures for a tool name (any args) before blocking all calls. Default: 5. */
    maxToolFailures: z.number().int().positive().default(5),
    /** Suggest alternative tools in block reason. Default: true. */
    suggestAlternatives: z.boolean().default(true),
    /** Max consecutive same-error-class failures (any args) before blocking. Default: 2.
     *  Stricter than args-based because same error + different args = stronger stuck signal. */
    maxConsecutiveErrorPatterns: z.number().int().positive().default(2),
  });

/**
 * Per-agent model route overrides.
 *
 * Maps task types to specific model identifiers. The `default` key
 * falls back to the agent's top-level `model` field when not set.
 * Additional named routes (e.g. "summarization", "classification")
 * allow task-specific model selection.
 *
 * Uses .catchall(z.string()) for extensibility -- any string key maps
 * to a model identifier string.
 */
export const ModelRoutesSchema = z
  .object({
    /** Default model for unrouted tasks (falls back to agent.model) */
    default: z.string().min(1).optional(),
  })
  .catchall(z.string())
  .default({});

/**
 * Schema for a single fallback model entry (provider + modelId pair).
 */
export const FallbackModelSchema = z.strictObject({
    /** LLM provider (e.g. "anthropic", "openai") */
    provider: z.string().min(1),
    /** Model identifier at the provider */
    modelId: z.string().min(1),
  });

/**
 * Schema for an auth profile entry (key name + provider association).
 *
 * Each profile maps a SecretManager key name to a provider, enabling
 * multiple API keys per provider for rotation during rate limiting.
 */
export const AuthProfileSchema = z.strictObject({
    /** Key name in SecretManager (e.g. "ANTHROPIC_API_KEY_2") */
    keyName: z.string().min(1),
    /** Provider this key belongs to (e.g. "anthropic") */
    provider: z.string().min(1),
  });

/**
 * Model failover configuration schema.
 *
 * Controls automatic model failover behavior, auth profile rotation
 * with exponential cooldowns, and model allowlisting.
 */
export const ModelFailoverConfigSchema = z.strictObject({
    /** Ordered list of fallback models to try when primary fails */
    fallbackModels: z.array(FallbackModelSchema).default([]),
    /** Per-provider API key profiles for auth rotation */
    authProfiles: z.array(AuthProfileSchema).default([]),
    /** Model allowlist (empty = allow all models) */
    allowedModels: z.array(z.string().min(1)).default([]),
    /** Maximum total attempts across all models/keys */
    maxAttempts: z.number().int().positive().default(6),
    /** Initial cooldown duration in milliseconds (1 min) */
    cooldownInitialMs: z.number().int().positive().default(60_000),
    /** Exponential cooldown multiplier */
    cooldownMultiplier: z.number().positive().default(5),
    /** Maximum cooldown duration in milliseconds (1 hr) */
    cooldownCapMs: z.number().int().positive().default(3_600_000),
  });

export const PromptTimeoutConfigSchema = z.strictObject({
  /** Wall-clock timeout for primary prompt calls in milliseconds. Default: 180s. */
  promptTimeoutMs: z.number().int().positive().default(180_000),
  /** Wall-clock timeout for retry prompt calls in milliseconds. Default: 60s. */
  retryPromptTimeoutMs: z.number().int().positive().default(60_000),
});

/**
 * Valid operation type keys for model resolution.
 *
 * Named ModelOperationType (not OperationType) to avoid collision with
 * the existing OperationType in packages/daemon/src/observability/latency-recorder.ts.
 */
export type ModelOperationType =
  | "interactive"
  | "cron"
  | "heartbeat"
  | "subagent"
  | "compaction"
  | "taskExtraction"
  | "condensation";

/**
 * Per-operation model entry: groups model override and timeout for a single
 * operation type.
 *
 * Both fields are optional. When model is unset, the resolver uses provider-family
 * smart defaults. When timeout is unset, per-operation timeout defaults apply.
 */
export const OperationModelEntrySchema = z.strictObject({
  /** Model override in "provider:modelId" format, or "primary" to use agent's primary model. */
  model: z.string().min(1).optional(),
  /** Timeout override in milliseconds for this operation type. */
  timeout: z.number().int().positive().optional(),
});

export type OperationModelEntry = z.infer<typeof OperationModelEntrySchema>;

/**
 * Per-operation model override configuration.
 *
 * Each operation type has an optional entry with model and timeout fields.
 * "interactive" is intentionally excluded -- it always uses the agent's
 * primary model.
 *
 * When no entries are set (default: {}), the resolver uses provider-family
 * smart defaults for automatic model tiering.
 */
export const OperationModelsSchema = z.strictObject({
  cron: OperationModelEntrySchema.optional(),
  heartbeat: OperationModelEntrySchema.optional(),
  subagent: OperationModelEntrySchema.optional(),
  compaction: OperationModelEntrySchema.optional(),
  taskExtraction: OperationModelEntrySchema.optional(),
  condensation: OperationModelEntrySchema.optional(),
}).default({});

export type BudgetConfig = z.infer<typeof BudgetConfigSchema>;
export type CircuitBreakerConfig = z.infer<typeof CircuitBreakerConfigSchema>;
export type ToolRetryBreakerConfig = z.infer<typeof ToolRetryBreakerConfigSchema>;
export type ModelRoutes = z.infer<typeof ModelRoutesSchema>;
export type FallbackModel = z.infer<typeof FallbackModelSchema>;
export type AuthProfileEntry = z.infer<typeof AuthProfileSchema>;
export type ModelFailoverConfig = z.infer<typeof ModelFailoverConfigSchema>;
export type PromptTimeoutConfig = z.infer<typeof PromptTimeoutConfigSchema>;
export type OperationModels = z.infer<typeof OperationModelsSchema>;

// ── Session Lifecycle Schemas ────────────���──────────────────────────────

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
  /** Prepend agent:<agentId>: to session keys for multi-agent isolation */
  agentPrefix: z.boolean().default(false),
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

// ── Context Engine Schema ────────────────────────────────────────���──────

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
  /** Operating mode: "pipeline" for sequential layer composition, "dag" for graph-based context management. */
  version: z.enum(["pipeline", "dag"]).default("pipeline"),

  // --- Shared (both modes) ---

  /** Number of recent assistant turns that retain thinking blocks (older turns get stripped). */
  thinkingKeepTurns: z.number().int().min(1).max(50).default(10),
  /** Model for LLM compaction in "provider:modelId" format. Defaults to Haiku for cost efficiency. Empty string falls through to session model. */
  compactionModel: z.string().default("anthropic:claude-haiku-4-5-20250929"),
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
});

export type ContextEngineConfig = z.infer<typeof ContextEngineConfigSchema>;

// ── Context Guard Schemas ──────────────────────────────────────���────────

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

// ── Agent Configuration Schema ─────────────────────────────────────────

/**
 * Agent configuration schema.
 *
 * Defines agent identity, model selection, execution limits,
 * workspace paths, and per-agent feature configuration.
 */

/** Routing binding: maps channel/peer/guild patterns to a specific agent. */
export const RoutingBindingSchema = z.strictObject({
    /** Channel type to match (e.g. "telegram", "discord") */
    channelType: z.string().optional(),
    /** Channel identifier to match */
    channelId: z.string().optional(),
    /** Peer (user) identifier to match */
    peerId: z.string().optional(),
    /** Guild (server/group) identifier to match */
    guildId: z.string().optional(),
    /** Agent ID to route to when this binding matches */
    agentId: z.string().min(1),
  });

/** Routing configuration for multi-agent dispatch. */
export const RoutingConfigSchema = z.strictObject({
    /** Agent ID to use when no routing binding matches */
    defaultAgentId: z.string().min(1).default("default"),
    /** Ordered list of routing bindings (first match wins) */
    bindings: z.array(RoutingBindingSchema).default([]),
  });

/** RAG (Retrieval-Augmented Generation) configuration for automatic memory retrieval before LLM calls. */
export const RagConfigSchema = z.strictObject({
    /** Enable automatic memory retrieval before LLM calls */
    enabled: z.boolean().default(true),
    /** Maximum number of memory results to retrieve */
    maxResults: z.number().int().positive().default(5),
    /** Maximum characters of memory context to inject into system prompt */
    maxContextChars: z.number().int().positive().default(4000),
    /** Minimum RRF score threshold (0-1) to include a memory result */
    minScore: z.number().min(0).max(1).default(0.1),
    /** Trust levels to include in retrieval (external excluded by default for security) */
    includeTrustLevels: z.array(TrustLevelSchema).default(["system", "learned"]),
  });

export type RagConfig = z.infer<typeof RagConfigSchema>;

/** Bootstrap configuration for workspace file injection into system prompts. */
export const BootstrapConfigSchema = z.strictObject({
    /** Per-file character limit for workspace files injected into system prompt */
    maxChars: z.number().int().positive().default(20_000),
    /** System prompt verbosity mode: full (all sections), minimal (sub-agents), none (identity only) */
    promptMode: z.enum(["full", "minimal", "none"]).default("full"),
    /** When true, USER.md is excluded from bootstrap context in group chat sessions (privacy). Default: true. */
    groupChatFiltering: z.boolean().default(true),
  });

export type BootstrapConfig = z.infer<typeof BootstrapConfigSchema>;

/** Per-agent concurrency limits (maxConcurrentRuns controls session serialization). */
export const ConcurrencyConfigSchema = z.strictObject({
    /** Maximum concurrent agent runs for this agent (default: 4) */
    maxConcurrentRuns: z.number().int().positive().default(4),
    /** Maximum queued messages per session before overflow (default: 50) */
    maxQueuedPerSession: z.number().int().positive().default(50),
  });

export type ConcurrencyConfig = z.infer<typeof ConcurrencyConfigSchema>;

/** Target channel for a broadcast group delivery. */
export const BroadcastTargetSchema = z.strictObject({
    /** Channel type (e.g., "telegram", "discord", "slack") */
    channelType: z.string().min(1),
    /** Channel identifier within the platform */
    channelId: z.string().min(1),
    /** Chat/conversation identifier within the channel */
    chatId: z.string().min(1),
  });

/** Broadcast group for simultaneous multi-channel message delivery. */
export const BroadcastGroupSchema = z.strictObject({
    /** Unique group identifier (referenced in broadcast tool calls) */
    id: z.string().min(1),
    /** Human-readable group name */
    name: z.string().default(""),
    /** Channel targets for simultaneous delivery */
    targets: z.array(BroadcastTargetSchema).default([]),
    /** Whether this broadcast group is active */
    enabled: z.boolean().default(true),
  });

export type BroadcastTarget = z.infer<typeof BroadcastTargetSchema>;
export type BroadcastGroup = z.infer<typeof BroadcastGroupSchema>;

/** Elevated reply mode: routes messages to different models based on sender trust level. */
export const ElevatedReplyConfigSchema = z.strictObject({
  /** Enable trust-based model/prompt routing */
  enabled: z.boolean().default(false),
  /** Map of trust level name to model route name (from modelRoutes) */
  trustModelRoutes: z.record(z.string(), z.string()).default({}),
  /** Map of trust level name to system prompt section override text */
  trustPromptOverrides: z.record(z.string(), z.string()).default({}),
  /** Default trust level for unknown senders */
  defaultTrustLevel: z.string().default("external"),
  /** Per-sender trust level overrides (senderId -> trust level name) */
  senderTrustMap: z.record(z.string(), z.string()).default({}),
});

export type ElevatedReplyConfig = z.infer<typeof ElevatedReplyConfigSchema>;

/** Per-agent JSONL trace configuration (disabled by default). */
export const TracingConfigSchema = z.strictObject({
  /** Enable per-LLM-call JSONL trace files */
  enabled: z.boolean().default(false),
  /** Output directory for JSONL trace files. Supports ~ expansion. Default: ~/.comis/traces */
  outputDir: z.string().default("~/.comis/traces"),
});

export type TracingConfig = z.infer<typeof TracingConfigSchema>;

/** SDK retry configuration: controls exponential backoff for transient errors (429, 5xx).
 *  The SDK handles retry internally; this schema configures its behavior per-agent. */
export const SdkRetryConfigSchema = z.strictObject({
  /** Enable SDK-native retry with exponential backoff */
  enabled: z.boolean().default(true),
  /** Maximum number of retry attempts for transient errors (5 retries = 6 total attempts) */
  maxRetries: z.number().int().nonnegative().default(5),
  /** Base delay in milliseconds before first retry (4s base with exponential backoff: 4s, 8s, 16s, 32s, 60s capped) */
  baseDelayMs: z.number().int().positive().default(4000),
  /** Maximum delay cap in milliseconds between retries */
  maxDelayMs: z.number().int().positive().default(60000),
});

export type SdkRetryConfig = z.infer<typeof SdkRetryConfigSchema>;

/** Context window guard configuration: percent-based warn/block thresholds. */
export const ContextGuardConfigSchema = z.strictObject({
  /** Enable context window guard checks during execution */
  enabled: z.boolean().default(true),
  /** Warn when context usage reaches this percent (0-100). Default: 80. */
  warnPercent: z.number().min(0).max(100).default(80),
  /** Block (abort) execution when context usage reaches this percent (0-100). Default: 95. */
  blockPercent: z.number().min(0).max(100).default(95),
});

export type ContextGuardConfig = z.infer<typeof ContextGuardConfigSchema>;

/** Tool lifecycle management: per-turn usage tracking and automatic demotion of unused tools. */
export const ToolLifecycleConfigSchema = z.strictObject({
  /** Whether tool lifecycle management is enabled. When false, no usage tracking or demotion occurs. */
  enabled: z.boolean().default(true),
  /** Number of turns of non-use before a tool is demoted (schema-stripped). */
  demotionThreshold: z.number().int().positive().default(20),
});

export type ToolLifecycleConfig = z.infer<typeof ToolLifecycleConfigSchema>;

/** Deferred tools configuration: operator control over tool deferral behavior per-agent. */
export const DeferredToolsConfigSchema = z.strictObject({
  /** Deferral mode: "always" defers all non-core tools, "auto" uses rule+budget heuristics, "never" disables deferral. */
  mode: z.enum(["always", "auto", "never"]).default("auto"),
  /** Tool names that must never be deferred (force-loaded into active context). Glob patterns NOT supported -- exact names only. */
  neverDefer: z.array(z.string()).default([]),
  /** Tool names that must always be deferred (force-deferred regardless of rules). Glob patterns NOT supported -- exact names only. */
  alwaysDefer: z.array(z.string()).default([]),
});

export type DeferredToolsConfig = z.infer<typeof DeferredToolsConfigSchema>;

/** Silent Execution Planner (SEP) configuration: in-memory checklist system for multi-step task tracking. */
export const SepConfigSchema = z.strictObject({
  /** Enable/disable SEP. Default: true. */
  enabled: z.boolean().default(true),
  /** Minimum estimated steps to activate planning (below this threshold, overhead isn't worth it). */
  minSteps: z.number().int().min(2).max(10).default(3),
  /** Whether to inject a verification nudge when all steps complete. Default: true. */
  verificationNudge: z.boolean().default(true),
  /** Maximum plan steps to track (prevents runaway extraction on vague requests). */
  maxSteps: z.number().int().min(3).max(30).default(15),
  /** Whether to include progress in user-visible response. Default: false. */
  userVisibleProgress: z.boolean().default(false),
});

export type SepConfig = z.infer<typeof SepConfigSchema>;

export const AgentConfigSchema = z.strictObject({
    /** Display name for the agent */
    name: z.string().min(1).default("Comis"),
    /** LLM model identifier — "default" resolves via models.defaultModel (e.g. "claude-sonnet-4-5-20250929") */
    model: z.string().min(1).default("default"),
    /** LLM provider — "default" resolves via models.defaultProvider (e.g. "anthropic", "openai") */
    provider: z.string().min(1).default("default"),
    /** Maximum reasoning steps per execution */
    maxSteps: z.number().int().positive().default(150),
    /** SDK thinking level override (off/minimal/low/medium/high/xhigh). Optional -- only overrides when set. */
    thinkingLevel: z.enum(["off", "minimal", "low", "medium", "high", "xhigh"]).optional(),
    /** SDK max tokens override. Optional -- only overrides when set. */
    maxTokens: z.number().int().positive().optional(),
    /** SDK temperature override (0-2). Optional -- only overrides when set. */
    temperature: z.number().min(0).max(2).optional(),
    /**
     * Prompt cache retention hint (none/short/long). Default: "long".
     *
     * Anthropic: Controls cache_control TTL marker injection.
     * - "none": no caching markers added
     * - "short": 5-minute ephemeral TTL (all Anthropic providers)
     * - "long": 1-hour TTL on api.anthropic.com; Bedrock and Vertex silently fall back to 5-minute TTL
     *
     * Gemini: This field is NOT used for Gemini explicit caching (CachedContent API).
     * Gemini cache TTL is controlled by geminiCache config and the GeminiCacheManager's
     * ttlSeconds parameter (default: 3600s). Active sessions get TTL refresh at 50% interval.
     * The cacheRetention value has no effect on Gemini providers.
     */
    cacheRetention: z.enum(["none", "short", "long"]).default("long"),
    /** Per-model family cache retention overrides. Keys are model ID prefixes
     *  (e.g., "claude-haiku", "claude-sonnet-4-6"). Longest-prefix-first matching.
     *  Overrides the agent-level cacheRetention for matching models.
     *  Set a model family to "none" to disable caching for debugging/testing. */
    cacheRetentionOverrides: z.record(
      z.string(),
      z.enum(["none", "short", "long"]),
    ).optional(),
    /** When true, use adaptive cache retention (cold-start "short" -> "long" after N turns).
     *  When false, use static retention from cacheRetention field.
     *  Default: true -- adaptive retention saves ~$4/MTok on cold-start Opus calls. */
    adaptiveCacheRetention: z.boolean().default(true),
    /** Cache breakpoint strategy. 'single' (default) minimizes KV page waste.
     *  'auto' resolves to 'single' for direct Anthropic and 'multi-zone' for Bedrock/Vertex.
     *  'multi-zone' places breakpoints across system, tools, and messages. */
    cacheBreakpointStrategy: z.enum(["auto", "multi-zone", "single"]).default("single"),
    /** Gemini explicit cache configuration (CachedContent lifecycle). */
    geminiCache: GeminiCacheConfigSchema.default(() => GeminiCacheConfigSchema.parse({})),
    /** When true, only content inside <final> blocks reaches users (streaming + non-streaming). Default: false. */
    enforceFinalTag: z.boolean().default(false),
    /** When true, enables fast/cheap model routing for simple requests. Default: false. */
    fastMode: z.boolean().default(false),
    /** When true, OpenAI store: true is injected for completions storage. Default: false (privacy). */
    storeCompletions: z.boolean().default(false),
    /** Maximum total characters for context window. Default: 100_000 (~25k tokens). */
    maxContextChars: z.number().int().positive().default(100_000),
    /** Maximum characters per tool result before truncation. Default: 50_000. */
    maxToolResultChars: z.number().int().positive().default(50_000),
    /** Minimum number of recent messages to always preserve during compaction. Default: 4. */
    preserveRecent: z.number().int().nonnegative().default(4),
    /** Token budget limits */
    budgets: BudgetConfigSchema.default(() => BudgetConfigSchema.parse({})),
    /** Circuit breaker for provider failures */
    circuitBreaker: CircuitBreakerConfigSchema.default(() => CircuitBreakerConfigSchema.parse({})),
    /** Tool retry circuit breaker for blocking repeatedly-failing tools. */
    toolRetryBreaker: ToolRetryBreakerConfigSchema.default(() => ToolRetryBreakerConfigSchema.parse({})),
    /** Workspace profile and settings */
    workspace: z.strictObject({
      profile: z.enum(["full", "specialist"]).default("full").describe(
        "Workspace profile. 'full' injects all platform instructions (~9K tokens). " +
        "'specialist' injects minimal instructions (~800 tokens) for purpose-built task workers."
      ),
    }).default({ profile: "full" }),
    /** Path to agent workspace directory containing identity files */
    workspacePath: z.string().optional(),
    /** Per-task model route overrides */
    modelRoutes: ModelRoutesSchema,
    /** RAG (Retrieval-Augmented Generation) memory context settings */
    rag: RagConfigSchema.default(() => RagConfigSchema.parse({})),
    /** Bootstrap workspace file injection settings */
    bootstrap: BootstrapConfigSchema.default(() => BootstrapConfigSchema.parse({})),
    /** Reaction frequency mode: minimal (1 per 5-10 exchanges) or extensive (react freely). Omit to disable reaction guidance. */
    reactionLevel: z.enum(["minimal", "extensive"]).optional(),
    /** Model failover and auth rotation settings */
    modelFailover: ModelFailoverConfigSchema.default(() => ModelFailoverConfigSchema.parse({})),
    /** SDK retry configuration (exponential backoff for 429/5xx transient errors) */
    sdkRetry: SdkRetryConfigSchema.default(() => SdkRetryConfigSchema.parse({})),
    /** Prompt timeout configuration (wall-clock timeouts for LLM calls) */
    promptTimeout: PromptTimeoutConfigSchema.default(() => PromptTimeoutConfigSchema.parse({})),
    /** Per-operation model override configuration (model tiering). */
    operationModels: OperationModelsSchema,
  });

export type AgentConfig = z.infer<typeof AgentConfigSchema>;
export type RoutingBinding = z.infer<typeof RoutingBindingSchema>;
export type RoutingConfig = z.infer<typeof RoutingConfigSchema>;

/** Per-agent cron configuration (enabled defaults to true). */
export const PerAgentCronConfigSchema = z.strictObject({
    /** Enable cron job scheduling for this agent */
    enabled: z.boolean().default(true),
    /** Maximum concurrent cron job runs for this agent */
    maxConcurrentRuns: z.number().int().positive().default(3),
    /** Default timezone for cron expressions (empty = UTC) */
    defaultTimezone: z.string().default(""),
    /** Maximum number of cron jobs allowed for this agent (0 = unlimited) */
    maxJobs: z.number().int().nonnegative().default(100),
    /** Maximum consecutive errors before auto-suspending a cron job (0 = never suspend). Per-agent override. */
    maxConsecutiveErrors: z.number().int().nonnegative().default(5),
  });

/** Per-agent heartbeat delivery target (which channel to send heartbeat notifications to). */
export const HeartbeatTargetSchema = z.strictObject({
    /** Channel type (e.g., "telegram", "discord") */
    channelType: z.string().min(1),
    /** Channel identifier within the platform */
    channelId: z.string().min(1),
    /** Chat/conversation identifier */
    chatId: z.string().min(1),
    /** Whether this target is a DM conversation (for DM delivery policy) */
    isDm: z.boolean().optional(),
  });

/** Per-agent heartbeat config: all fields optional (inherit from global scheduler.heartbeat). */
export const PerAgentHeartbeatConfigSchema = z.strictObject({
    /** Override heartbeat enabled state for this agent */
    enabled: z.boolean().optional(),
    /** Override heartbeat interval in milliseconds */
    intervalMs: z.number().int().positive().optional(),
    /** Override show OK status */
    showOk: z.boolean().optional(),
    /** Override show alerts */
    showAlerts: z.boolean().optional(),
    /** Delivery target channel for this agent's heartbeat notifications */
    target: HeartbeatTargetSchema.optional(),
    /** Custom heartbeat prompt for this agent */
    prompt: z.string().optional(),
    /** Session key for heartbeat conversation isolation */
    session: z.string().min(1).optional(),
    /** Whether heartbeat alerts can be delivered to DM conversations (default: true) */
    allowDm: z.boolean().optional(),
    /** When true, heartbeat bootstrap context includes ONLY HEARTBEAT.md (cost optimization) */
    lightContext: z.boolean().optional(),
    /** Maximum characters for soft acknowledgment threshold (default applied in scheduler, not schema) */
    ackMaxChars: z.number().int().positive().optional(),
    /** Prefix to strip from LLM responses before delivery */
    responsePrefix: z.string().optional(),
    /** Whether to suppress delivery of HEARTBEAT_OK-only responses from cron triggers (default applied in scheduler) */
    skipHeartbeatOnlyDelivery: z.boolean().optional(),
    /** Override consecutive failure threshold for alerting (per-agent) */
    alertThreshold: z.number().int().positive().optional(),
    /** Override alert cooldown period in ms (per-agent) */
    alertCooldownMs: z.number().int().positive().optional(),
    /** Override stuck detection timeout in ms (per-agent) */
    staleMs: z.number().int().positive().optional(),
  });

export type HeartbeatTarget = z.infer<typeof HeartbeatTargetSchema>;
export type PerAgentHeartbeatConfig = z.infer<typeof PerAgentHeartbeatConfigSchema>;

/** Per-agent scheduler configuration (wraps cron and heartbeat settings). */
export const PerAgentSchedulerConfigSchema = z.strictObject({
    /** Per-agent cron configuration */
    cron: PerAgentCronConfigSchema.default(() => PerAgentCronConfigSchema.parse({})),
    /** Per-agent heartbeat configuration (optional -- inherits from global scheduler.heartbeat) */
    heartbeat: PerAgentHeartbeatConfigSchema.optional(),
  });

/** Per-agent configuration: extends AgentConfigSchema with skills, scheduler, session, concurrency. */
export const PerAgentConfigSchema = AgentConfigSchema.extend({
  /** Per-agent skills configuration (toolPolicy, builtinTools, discoveryPaths) */
  skills: SkillsConfigSchema.optional(),
  /** Per-agent scheduler configuration (cron settings) */
  scheduler: PerAgentSchedulerConfigSchema.optional(),
  /** Session configuration (reset policy + DM scope + pruning + compaction) */
  session: z.strictObject({
    resetPolicy: SessionResetPolicySchema.optional(),
    dmScope: DmScopeConfigSchema.optional(),
    pruning: PruningConfigSchema.optional(),
    compaction: SessionCompactionConfigSchema.optional(),
  }).optional(),
  /** Per-agent concurrency limits (maxConcurrentRuns, maxQueuedPerSession) */
  concurrency: ConcurrencyConfigSchema.default(() => ConcurrencyConfigSchema.parse({})),
  /** Broadcast groups for simultaneous multi-channel message delivery */
  broadcastGroups: z.array(BroadcastGroupSchema).default([]),
  /** Elevated reply mode: trust-based model/prompt routing */
  elevatedReply: ElevatedReplyConfigSchema.default(() => ElevatedReplyConfigSchema.parse({})),
  /** Per-agent JSONL trace configuration (disabled by default) */
  tracing: TracingConfigSchema.default(() => TracingConfigSchema.parse({})),
  /** Per-agent secret access configuration (glob-based allow list) */
  secrets: AgentSecretsConfigSchema.optional(),
  /** Context window guard thresholds (percent-based warn/block) */
  contextGuard: ContextGuardConfigSchema.default(() => ContextGuardConfigSchema.parse({})),
  /** Progressive context pruning configuration (softTrimRatio/hardClearRatio thresholds) */
  contextPruning: ContextPruningConfigSchema.optional(),
  /** Context engine pipeline configuration (thinking retention, token budget management) */
  contextEngine: ContextEngineConfigSchema.optional(),
  /** Source gate configuration (maxResponseBytes, stripHiddenHtml) */
  sourceGate: SourceGateConfigSchema.optional(),
  /** Tool lifecycle management (per-turn demotion of unused tools) */
  toolLifecycle: ToolLifecycleConfigSchema.default(() => ToolLifecycleConfigSchema.parse({})),
  /** Silent Execution Planner (SEP): in-memory checklist for multi-step task tracking */
  sep: SepConfigSchema.optional(),
  /** Proactive notification configuration (rate limits, primary channel, dedup) */
  notification: NotificationConfigSchema.optional(),
  /** Channel-aware verbosity hints configuration */
  verbosity: VerbosityConfigSchema.optional(),
  /** Deferred tools configuration (deferral mode + force-load/force-defer lists) */
  deferredTools: DeferredToolsConfigSchema.optional(),
  /** Background tasks configuration (auto-promotion of long tool calls) */
  backgroundTasks: BackgroundTasksConfigSchema.optional(),
  /** Periodic memory review configuration (session history extraction) */
  memoryReview: MemoryReviewConfigSchema.optional(),
});

/** Agents map: keyed by agent ID string to per-agent configuration. */
export const AgentsMapSchema = z.record(z.string().min(1), PerAgentConfigSchema);

export type PerAgentConfig = z.infer<typeof PerAgentConfigSchema>;
export type PerAgentSchedulerConfig = z.infer<typeof PerAgentSchedulerConfigSchema>;
export type PerAgentCronConfig = z.infer<typeof PerAgentCronConfigSchema>;
