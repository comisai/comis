import { z } from "zod";

// ---------------------------------------------------------------------------
// Subagent Context Config Schema
// ---------------------------------------------------------------------------

/**
 * Configuration schema for the subagent context lifecycle.
 *
 * Controls spawn limits, condensation behavior, context injection,
 * and result handling. All fields have sensible defaults so an empty
 * object produces a valid configuration.
 *
 * Composed into AgentToAgentConfigSchema via `.extend()` in
 * `config/schema-security.ts`.
 */
export const SubagentContextConfigSchema = z.strictObject({
  /** Maximum spawn depth (parent -> child -> grandchild). 1 = no nesting. */
  maxSpawnDepth: z.number().int().min(1).max(10).default(3),
  /** Maximum concurrent active children per parent agent */
  maxChildrenPerAgent: z.number().int().min(1).max(20).default(5),
  /** Token threshold: below = passthrough (L1), above = LLM condensation (L2) */
  maxResultTokens: z.number().int().min(100).max(100_000).default(4_000),
  /** Result file retention in ms (auto-sweep after this) */
  resultRetentionMs: z.number().int().positive().default(86_400_000),
  /** Condensation strategy: "auto" selects level based on token count */
  condensationStrategy: z.enum(["auto", "always", "never"]).default("auto"),
  /** Parent history mode: "none" = no parent context, "summary" = LLM summary */
  includeParentHistory: z.enum(["none", "summary"]).default("none"),
  /** Inject objective statement that survives compaction */
  objectiveReinforcement: z.boolean().default(true),
  /** Pass artifact references to subagent (file paths, not inline content) */
  artifactPassthrough: z.boolean().default(true),
  /** Context fill ratio that triggers auto-compaction (0-1) */
  autoCompactThreshold: z.number().min(0.5).max(1.0).default(0.95),
  /** Preserve error details in condensed results */
  errorPreservation: z.boolean().default(true),
  /** Apply narrative casting tags to subagent results */
  narrativeCasting: z.boolean().default(true),
  /** Tag prefix for narrative casting of subagent results */
  resultTagPrefix: z.string().min(1).max(100).default("Subagent Result"),
  /** Maximum tokens for parent context summary (when includeParentHistory = "summary") */
  parentSummaryMaxTokens: z.number().int().min(100).max(10_000).default(1_000),
  /** Maximum queued spawns per caller before true backpressure rejection. 0 disables queuing (preserves old throw behavior). */
  maxQueuedPerAgent: z.number().int().min(0).max(50).default(10),
  /** How long a queued spawn waits before failing with timeout (ms). */
  queueTimeoutMs: z.number().int().min(1000).max(600_000).default(120_000),
  /** Maximum wall-clock time for a single sub-agent run before watchdog force-fail (ms). */
  maxRunTimeoutMs: z.number().int().positive().default(600_000),
  /** Per-step timeout used to compute dynamic watchdog: min(max_steps * perStepTimeoutMs, maxRunTimeoutMs). */
  perStepTimeoutMs: z.number().int().positive().default(60_000),
  /** Health-tick stuck kill threshold for graph sub-agents (ms). Graph spawns do multi-step
   *  analytical work that routinely exceeds the regular threshold. Falls back to
   *  stuckKillThresholdMs if unset. Set to 0 to disable for graph runs. */
  graphStuckKillThresholdMs: z.number().int().min(0).default(600_000),
  /** Health-tick stuck kill threshold for regular (non-graph) sub-agents (ms).
   *  Set to 0 to disable. */
  stuckKillThresholdMs: z.number().int().min(0).default(180_000),
});

export type SubagentContextConfig = z.infer<typeof SubagentContextConfigSchema>;
