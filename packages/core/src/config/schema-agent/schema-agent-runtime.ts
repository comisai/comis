// SPDX-License-Identifier: Apache-2.0
/**
 * Agent config — Top-level runtime composition.
 *
 * Owns the top-level `AgentConfigSchema` (composed from all sibling-leaf
 * primitives), per-agent scheduler/heartbeat schemas, `PerAgentConfigSchema`,
 * and `AgentsMapSchema`.
 *
 * This leaf is the COMPOSITION ROOT — imports from sibling leaves
 * (model/context/prompt) plus external sibling schemas (skills, secrets,
 * gemini-cache, notification, verbosity, background-tasks, memory-review).
 * Imports flow one-directionally: runtime ← {model, context, prompt}; no
 * sibling-leaf imports back.
 *
 * @module
 */
import { z } from "zod";
import { SkillsConfigSchema } from "../schema-skills.js";
import { AgentSecretsConfigSchema } from "../schema-secrets.js";
import { GeminiCacheConfigSchema } from "../schema-gemini-cache.js";
import { NotificationConfigSchema } from "../schema-notification.js";
import { VerbosityConfigSchema } from "../schema-verbosity.js";
import { BackgroundTasksConfigSchema } from "../schema-background-tasks.js";
import { MemoryReviewConfigSchema } from "../schema-memory-review.js";
import { MemoryConsolidationConfigSchema } from "../schema-memory-consolidation.js";
import { MemoryReasoningConfigSchema } from "../schema-memory-reasoning.js";
import { MemoryUserRepresentationConfigSchema } from "../schema-memory-user-representation.js";
import { SocialModelingConfigSchema } from "../schema-social-modeling.js";
import { DialecticConfigSchema } from "../schema-dialectic.js";
import { MemoryUsefulnessJudgeConfigSchema } from "../schema-memory-usefulness-judge.js";
import { MemoryOnlineTuningConfigSchema } from "../schema-memory-online-tuning.js";
import { MemoryLifecycleConfigSchema } from "../schema-memory-lifecycle.js";
import { validateProfileId } from "../../security/profile-id.js";

// Sibling-leaf imports (one-directional dependency graph).
import {
  BudgetConfigSchema,
  CircuitBreakerConfigSchema,
  ToolRetryBreakerConfigSchema,
  ModelRoutesSchema,
  ModelFailoverConfigSchema,
  PromptTimeoutConfigSchema,
  OperationModelsSchema,
} from "./schema-agent-model.js";
import {
  SessionResetPolicySchema,
  DmScopeConfigSchema,
  PruningConfigSchema,
  SessionCompactionConfigSchema,
  ContextEngineConfigSchema,
  ContextPruningConfigSchema,
  SourceGateConfigSchema,
} from "./schema-agent-context.js";
import {
  RoutingBindingSchema,
  RoutingConfigSchema,
  RagConfigSchema,
  BootstrapConfigSchema,
  ConcurrencyConfigSchema,
  BroadcastGroupSchema,
  ElevatedReplyConfigSchema,
  TracingConfigSchema,
  SdkRetryConfigSchema,
  ContextGuardConfigSchema,
  ToolLifecycleConfigSchema,
  DeferredToolsConfigSchema,
  SepConfigSchema,
  GoalAnchorConfigSchema,
  VerificationConfigSchema,
  HonestyConfigSchema,
} from "./schema-agent-prompt.js";

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
    /** Phase 166 Fix 3: thinking-effort governor config.
     *  Controls whether the governor may down-shift thinkingLevel on tight windows. */
    thinking: z.strictObject({
      /** When true (default), the thinking-effort governor may lower thinkingLevel
       *  (high→medium→low) when remaining room < thinkingReserve + MIN_VISIBLE_OUTPUT.
       *  For frontier/mid models the governor is always a no-op (large windows).
       *  Frontier/mid: irrelevant — governor never fires on large windows regardless.
       *  Design ref: design/small-model-context-fidelity.md §4 Fix 3 item 4. */
      downshiftOnTightWindow: z.boolean().default(true),
    }).default({ downshiftOnTightWindow: true }),
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
    /** Advanced cache optimization options for interactive sessions. */
    advancedCacheOptimization: z.object({
      /** When true, the recent-zone message breakpoint may be promoted from
       *  "short" (5m) to "long" (1h) TTL when observed inter-turn gaps
       *  consistently exceed 5 minutes. Prevents repeated cache rewrite costs
       *  in slow-cadence channels like Telegram. Default: true. */
      enableRecentZonePromotion: z.boolean().default(true),
    }).default(() => ({ enableRecentZonePromotion: true })),
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
    /** Reply language for deterministic degraded replies (DET-02). BCP-47 ("he")
     *  or an English display name ("Hebrew"). Omit to auto-detect from the
     *  USER.md preferred language, then the inbound message script (he/ar/ru only). */
    language: z.string().optional(),
  });

export type AgentConfig = z.infer<typeof AgentConfigSchema>;
export type RoutingBinding = z.infer<typeof RoutingBindingSchema>;
export type RoutingConfig = z.infer<typeof RoutingConfigSchema>;

/**
 * Per-agent activity-presentation config (Agent Transparency, §16.3).
 *
 * Controls how much work-in-progress UI the agent renders. Distinct from the
 * top-level `verbosity` (response-style `VerbosityConfigSchema`) — they share
 * only the word "verbosity". This defines the SCHEMA only; kill-switch
 * ENFORCEMENT (`channels.<key>.enabled` / `emergencyDisabled`) is handled
 * elsewhere — not wired here.
 */
export const ActivityConfigSchema = z.strictObject({
    /** How much work-in-progress UI to render. */
    verbosity: z.enum(["silent", "quiet", "normal", "verbose"]).default("normal"),
    /** What to do with activity messages once the turn succeeds.
     *  (onFailure is hardcoded to "keep"; not exposed — §7.3.) */
    onSuccess: z.enum(["delete", "keep", "collapse"]).default("delete"),
    /** Visual theme for activity rendering. */
    theme: z.enum(["default", "terminal-minimal", "playful", "ascii"]).default("default"),
    /** Agent-scoped emergency kill switch (§22.2). When true, no activity
     *  messages are produced for this agent on any channel; lifecycle reactions
     *  and final-message delivery are unaffected. Enforcement is handled elsewhere. */
    emergencyDisabled: z.boolean().default(false),
    /** Renderer-scoped enable map (§22.2), keyed by TurnActivityContext.rendererKey.
     *  A missing entry follows `defaultChannelEnabled` (default true → enabled).
     *  An explicit `enabled` always wins: `true` renders, `false` opts that
     *  renderer out even under default-on (kill-switch safety). */
    channels: z
      .record(z.string(), z.strictObject({ enabled: z.boolean().default(false) }))
      .default({}),
    /** Operator opt-out from DEFAULT-ON (§22.2): when true (the default), any
     *  renderer for this agent that has no explicit `channels[rendererKey]` entry
     *  renders, and the operator opts a specific renderer OUT via
     *  `channels[rendererKey].enabled: false`. Set it to `false` to restore the
     *  fail-closed posture (every renderer off until explicitly enabled).
     *  `emergencyDisabled` overrides it; an agent entirely absent from the config
     *  map still collapses to fail-closed at the kill-switch resolver. */
    defaultChannelEnabled: z.boolean().default(true),
  });

/**
 * Per-agent delivery config (Agent Transparency, §16.3).
 *
 * `visibleReplies` decides what becomes a room-visible assistant reply. It is
 * intentionally separate from `activity` (presentation): "automatic" delivers
 * the assistant's final text; "message_tool" suppresses it unless the model
 * explicitly called the `message` tool. Approval UIs and activity messages
 * still render regardless. Enforcement point is `execution-deliver.ts`;
 * this defines the schema only.
 */
const VisibleRepliesSchema = z.strictObject({
    /** DM default: assistant final text auto-delivers. */
    direct: z.enum(["automatic", "message_tool"]).default("automatic"),
    /** Group default: final text suppressed unless the `message` tool was called. */
    group: z.enum(["automatic", "message_tool"]).default("message_tool"),
  });

export const DeliveryConfigSchema = z.strictObject({
    visibleReplies: VisibleRepliesSchema.default(() => VisibleRepliesSchema.parse({})),
  });

export type ActivityConfig = z.infer<typeof ActivityConfigSchema>;
export type DeliveryConfig = z.infer<typeof DeliveryConfigSchema>;

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
    /** Per-agent heartbeat tool policy override -- matches AgentConfig.toolPolicy shape.
     *
     *  Resolution order: heartbeat.toolPolicy > agentConfig.toolPolicy > passthrough.
     *  Opt-in: omitting this field preserves the agent's interactive tool set for
     *  heartbeat ticks. Use `{ profile: "heartbeat-minimal" }` for the conservative
     *  preset in `packages/skills/src/policy/tool-policy.ts`. */
    toolPolicy: z.object({
      profile: z.string().default("full"),
      allow: z.array(z.string()).default([]),
      deny: z.array(z.string()).default([]),
    }).optional(),
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
  /** GoalAnchor: tail-injects objective + uncompleted steps into system prompt (small/nano models only; enabled=false by default) */
  goalAnchor: GoalAnchorConfigSchema.optional(),
  /** Pre-delivery verification critic (R4, Phase 154): scores completion claims against GoalAnchor checklist. Opt-in; enabled=false by default. */
  verification: VerificationConfigSchema.optional(),
  /** Honesty guardrails (R4/S2, Phase 154): bounds critic retry redirects and enforces honest unmet-list on exhaustion. */
  honesty: HonestyConfigSchema.optional(),
  /** Proactive notification configuration (rate limits, primary channel, dedup) */
  notification: NotificationConfigSchema.optional(),
  /** Channel-aware response-style verbosity hints (KEPT unchanged — distinct
   *  from `activity.verbosity`, which is the work-in-progress UI level). */
  verbosity: VerbosityConfigSchema.optional(),
  /** Per-agent activity-presentation config (Agent Transparency, §16.3). */
  activity: ActivityConfigSchema.default(() => ActivityConfigSchema.parse({})),
  /** Per-agent delivery config: final-assistant-reply visibility (§16.3). */
  delivery: DeliveryConfigSchema.default(() => DeliveryConfigSchema.parse({})),
  /** Deferred tools configuration (deferral mode + force-load/force-defer lists) */
  deferredTools: DeferredToolsConfigSchema.optional(),
  /** Background tasks configuration (auto-promotion of long tool calls) */
  backgroundTasks: BackgroundTasksConfigSchema.optional(),
  /** Periodic memory review configuration (session history extraction). Opt-out posture:
   *  default-ON. A COST feature — force-disabled at its registration site when the
   *  master kill switch `memory.costFeatures.enabled` is false. */
  memoryReview: MemoryReviewConfigSchema.default(() => MemoryReviewConfigSchema.parse({})),
  /** Periodic memory consolidation configuration (observation clustering). Opt-out
   *  posture: default-ON; a COST feature gated by the kill switch at its registration site. */
  memoryConsolidation: MemoryConsolidationConfigSchema.default(() => MemoryConsolidationConfigSchema.parse({})),
  /** Periodic memory reasoning configuration (deductive/inductive observations).
   *  Opt-out posture: default-ON; a COST feature gated by the kill switch at its registration site. */
  memoryReasoning: MemoryReasoningConfigSchema.default(() => MemoryReasoningConfigSchema.parse({})),
  /** Periodic per-user representation profile-builder configuration. Opt-out
   *  posture: default-ON; a COST feature gated by the kill switch at its registration site. */
  memoryUserRepresentation: MemoryUserRepresentationConfigSchema.default(() => MemoryUserRepresentationConfigSchema.parse({})),
  /** Directional relationship-modeling configuration (STAYS OFF — privacy/consent gate
   *  `privacyReviewSignedOffBy`, NOT flipped by the opt-out posture). */
  socialModeling: SocialModelingConfigSchema.optional(),
  /** memory_ask grounded-Q&A tool config — the ONE allowed query-time LLM surface.
   *  Opt-out posture: default-ON; a COST feature gated by the kill switch at its registration site. */
  dialectic: DialecticConfigSchema.default(() => DialecticConfigSchema.parse({})),
  /** Offline usefulness-judge configuration (an OFFLINE cron, never the
   *  recall path). Opt-out posture: default-ON; a COST feature gated by the kill switch. */
  memoryUsefulnessJudge: MemoryUsefulnessJudgeConfigSchema.default(() => MemoryUsefulnessJudgeConfigSchema.parse({})),
  /** Offline tuned-alpha bandit cron (an OFFLINE, DETERMINISTIC, KEYLESS
   *  cron, never the recall path). Opt-out posture: default-ON; in the operator-facing
   *  cost-feature set, so gated by the kill switch at its registration site. */
  memoryOnlineTuning: MemoryOnlineTuningConfigSchema.default(() => MemoryOnlineTuningConfigSchema.parse({})),
  /** SCAFFOLD-DORMANT memory-lifecycle sweep cron (off by default — a KEYLESS cron that evicts/demotes NOTHING until the deferred live policy lands) */
  memoryLifecycle: MemoryLifecycleConfigSchema.optional(),
  /**
   * Per-provider OAuth profile preferences (provider -> profileId map).
   * When set, the OAuthTokenManager resolves the named profile for that
   * provider's LLM calls. Each value must match the `<provider>:<identity>`
   * format enforced by `validateProfileId` from `@comis/core`.
   */
  oauthProfiles: z
    .record(
      z.string().min(1),
      z
        .string()
        .min(1)
        .refine((val) => validateProfileId(val).ok, {
          message:
            'Invalid profile ID: expected "<provider>:<identity>" format (use validateProfileId from @comis/core to verify).',
        }),
    )
    .optional(),
});

/** Agents map: keyed by agent ID string to per-agent configuration. */
export const AgentsMapSchema = z.record(z.string().min(1), PerAgentConfigSchema);

export type PerAgentConfig = z.infer<typeof PerAgentConfigSchema>;
export type PerAgentSchedulerConfig = z.infer<typeof PerAgentSchedulerConfigSchema>;
export type PerAgentCronConfig = z.infer<typeof PerAgentCronConfigSchema>;
