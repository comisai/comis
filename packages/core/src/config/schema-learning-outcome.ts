// SPDX-License-Identifier: Apache-2.0
/**
 * Per-agent outcome-signal (Verified Learning WS1) configuration schema.
 *
 * Records a finished trajectory's net task-outcome into the `outcome_events`
 * ledger so that ALL learning can gate on a real task-outcome signal instead of
 * a text-overlap proxy (design §WS1).
 *
 * DEFAULT ON (opt-out) — `learningOutcome` defaults `enabled: true`, like the
 * surrounding `memory*` cost features, so the loop works out of the box. The
 * master kill-switch `memory.costFeatures.enabled` force-disables it (and every
 * cost feature) at the registration site (Plan 04); set this `enabled: false` to
 * opt a single agent out. (Was opt-in during the v2.26 phased rollout; graduated
 * to default-on once the outcome→synthesis→recall loop was verified end-to-end.)
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
 * - enabled: master switch for this agent (default TRUE / opt-out — on out of the
 *   box; force-disabled when `memory.costFeatures.enabled: false`).
 * - sources: which DETERMINISTIC signals contribute (tool / pipeline). The
 *   optional cost-gated LLM judge is its own `judge` sub-block, not a `sources`
 *   member — deterministic signals always outrank the judge via fusion precedence.
 * - reactionMap: the success/failure emoji → outcome map (consumed by the Phase
 *   199 reaction source; declared here so the config shape is stable).
 * - judge: the OPTIONAL cost-gated `fast`-tier LLM judge (default disabled — no
 *   LLM call, no cost; enabling it is a second, separate opt-in).
 * - correction: the cost-gated correction detector (Phase 199, CORRECT-01).
 *   Default ENABLED (opt-out) — untrusted follow-up text is `wrapExternalContent`-
 *   fenced before the `fast`-tier judge; force-disabled under `memory.costFeatures.enabled`.
 * - minConfidenceToLearn: the floor a resolved outcome must clear before any
 *   learning is derived (range [0, 1]).
 * - retentionDays: age-based prune horizon for the append-only ledger (anti-DoS,
 *   OUTCOME-07 / §V12). Positive integer days.
 */
export const LearningOutcomeConfigSchema = z.strictObject({
  /** Enable the outcome signal for this agent. Default: TRUE (opt-out — on out of the
   *  box). Force-disabled when `memory.costFeatures.enabled: false`. */
  enabled: z.boolean().default(true),
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
  /** Cost-gated correction detector (Phase 199, CORRECT-01). Default: TRUE (opt-out).
   *  A follow-up "no, do X instead" turn is classified via the cheap `fast`-tier judge (untrusted
   *  text is `wrapExternalContent`-fenced) and emits a `corrected` soft-failure of the prior
   *  trajectory. Force-disabled when `memory.costFeatures.enabled: false`. */
  correction: z.strictObject({ enabled: z.boolean().default(true) }).default(() => ({ enabled: true })),
  /** Confidence floor [0,1] a resolved outcome must clear before learning is derived. */
  minConfidenceToLearn: z.number().min(0).max(1).default(0.6),
  /** Age-based prune horizon (days) for the append-only ledger. Positive integer. */
  retentionDays: z.number().int().positive().default(30),
});

export type LearningOutcomeConfig = z.infer<typeof LearningOutcomeConfigSchema>;
