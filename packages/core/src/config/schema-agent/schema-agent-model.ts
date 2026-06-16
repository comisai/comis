// SPDX-License-Identifier: Apache-2.0
/**
 * Agent config — Model selection schemas.
 *
 * Owns budget limits, circuit breaker thresholds, model route overrides,
 * fallback model entries, auth profile rotation, model failover
 * configuration, prompt timeouts, and per-operation model overrides.
 *
 * Imports nothing from sibling leaves (model/context/prompt/runtime) —
 * one-directional dependency graph; the top-level `AgentConfigSchema` in
 * `schema-agent-runtime.ts` composes from this leaf.
 *
 * @module
 */
import { z } from "zod";

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
  /**
   * Makespan ceiling multiplier (LAT-02, R-1 non-optional): a
   * streaming-but-runaway generation is aborted at
   * promptTimeoutMs x stallCeilingMultiplier even though stream/tool
   * activity keeps resetting the stall budget (gemma4 16x/810s receipt,
   * scripts/bench-small-model/README.md). Default: 10.
   *
   * Bounded 1..100 (177-REVIEW WR-02): a value below 1 INVERTS the
   * semantics (the makespan fires before the stall budget can ever elapse,
   * so every timeout -- including genuine provider hangs -- is classified
   * makespan and suppressed from providerHealth); a huge value overflows
   * Node's 32-bit setTimeout (promptTimeoutMs x multiplier > 2^31-1 clamps
   * the delay to 1ms -- every prompt killed instantly). The derivation site
   * (model-retry.ts) additionally clamps the product as defense-in-depth.
   */
  stallCeilingMultiplier: z.number().min(1).max(100).default(10),
});

/**
 * Valid operation type keys for model resolution.
 */
export type ModelOperationType =
  | "interactive"
  | "cron"
  | "heartbeat"
  | "subagent"
  | "compaction"
  | "taskExtraction"
  | "condensation"
  | "verification"    // R4: pre-delivery critic (Phase 154)
  | "planning"        // R5: pre-execution planner (Phase 154, deferrable on M2)
  | "outcomeJudge";   // OUTCOME-04: the optional cost-gated outcome judge (fast tier, Phase 198)

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
  verification: OperationModelEntrySchema.optional(),  // R4: pre-delivery critic (Phase 154)
  planning: OperationModelEntrySchema.optional(),       // R5: pre-execution planner (Phase 154)
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
