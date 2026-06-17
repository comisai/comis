// SPDX-License-Identifier: Apache-2.0
/**
 * Per-agent outcome-signal (Verified Learning WS1) configuration schema.
 *
 * Records a finished trajectory's net task-outcome into the `outcome_events`
 * ledger so that ALL learning can gate on a real task-outcome signal instead of
 * a text-overlap proxy (design §WS1).
 *
 * DEFAULT OFF — unlike every surrounding `memory*` cost feature (which defaults
 * ON / opt-out), `learningOutcome` defaults `enabled: false`. Enabling it is a
 * deliberate operator opt-in, and P0's byte-identity guarantee (zero behavior
 * change with the default config) depends on the default being disabled. The
 * master kill-switch `memory.costFeatures.enabled` force-disables it at the
 * registration site (Plan 04), exactly like the other cost features.
 *
 * Strict (`z.strictObject`) with `.default()` on EVERY field (Playbook 6.4) —
 * consumers see a fully-defaulted block; no `config.x ?? fallback` at call sites.
 *
 * @module
 */

import { z } from "zod";

/**
 * LearningOutcomeConfigSchema: Zod schema for the per-agent outcome signal.
 *
 * Fields:
 * - enabled: master opt-in for this agent (default FALSE — the lone OFF-by-default
 *   memory-adjacent feature; the closing gate's byte-identity depends on it).
 * - sources: which DETERMINISTIC signals contribute (tool / pipeline). The
 *   optional cost-gated LLM judge is its own `judge` sub-block, not a `sources`
 *   member — deterministic signals always outrank the judge via fusion precedence.
 * - reactionMap: the success/failure emoji → outcome map (consumed by the Phase
 *   199 reaction source; declared here so the config shape is stable).
 * - judge: the OPTIONAL cost-gated `fast`-tier LLM judge (default disabled — no
 *   LLM call, no cost; enabling it is a second, separate opt-in).
 * - correction: the OPTIONAL cost-gated correction detector (Phase 199,
 *   CORRECT-01). Default disabled — an LLM over untrusted follow-up text is a
 *   net-new attack surface; force-disabled under `memory.costFeatures.enabled`.
 * - minConfidenceToLearn: the floor a resolved outcome must clear before any
 *   learning is derived (range [0, 1]).
 * - retentionDays: age-based prune horizon for the append-only ledger (anti-DoS,
 *   OUTCOME-07 / §V12). Positive integer days.
 */
export const LearningOutcomeConfigSchema = z.strictObject({
  /** Enable the outcome signal for this agent. Default: false (the lone OFF-by-default
   *  memory-adjacent feature). Force-disabled when `memory.costFeatures.enabled: false`. */
  enabled: z.boolean().default(false),
  /** Deterministic signal sources that contribute to the resolved outcome. */
  sources: z.array(z.enum(["tool", "pipeline"])).default(["tool", "pipeline"]),
  /** Reaction-emoji → outcome map (Phase 199 reaction source; declared here for a stable shape). */
  reactionMap: z
    .strictObject({
      success: z.array(z.string()).default(["👍", "✅"]),
      failure: z.array(z.string()).default(["👎", "❌"]),
    })
    .default(() => ({ success: ["👍", "✅"], failure: ["👎", "❌"] })),
  /** OPTIONAL cost-gated `fast`-tier LLM judge. Default disabled — no LLM call, no cost. */
  judge: z.strictObject({ enabled: z.boolean().default(false) }).default(() => ({ enabled: false })),
  /** OPTIONAL cost-gated correction detector (Phase 199, CORRECT-01). Default disabled — no LLM call, no cost.
   *  A follow-up "no, do X instead" turn is classified via the cheap `fast`-tier judge and emits a `corrected`
   *  soft-failure of the prior trajectory. Force-disabled when `memory.costFeatures.enabled: false`. */
  correction: z.strictObject({ enabled: z.boolean().default(false) }).default(() => ({ enabled: false })),
  /** Confidence floor [0,1] a resolved outcome must clear before learning is derived. */
  minConfidenceToLearn: z.number().min(0).max(1).default(0.6),
  /** Age-based prune horizon (days) for the append-only ledger. Positive integer. */
  retentionDays: z.number().int().positive().default(30),
});

export type LearningOutcomeConfig = z.infer<typeof LearningOutcomeConfigSchema>;
