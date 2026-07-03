// SPDX-License-Identifier: Apache-2.0
/**
 * Per-agent outcome-signal configuration schema.
 *
 * Records a finished trajectory's net task-outcome into the `outcome_events`
 * ledger so that ALL learning can gate on a real task-outcome signal instead of
 * a text-overlap proxy.
 *
 * DEFAULT ON (opt-out) — `learningOutcome` defaults `enabled: true`, like the
 * surrounding `memory*` cost features, so the loop works out of the box. The
 * master kill-switch `memory.enabled` force-disables it (and every
 * cost feature) at the registration site; set this `enabled: false` to
 * opt a single agent out.
 *
 * Strict (`z.strictObject`) with `.default()` on EVERY field — consumers see a
 * fully-defaulted block; no `config.x ?? fallback` at call sites.
 *
 * @module
 */

import { z } from "zod";

/**
 * LearningOutcomeConfigSchema: Zod schema for the per-agent outcome signal.
 *
 * Fields:
 * - enabled: master switch for this agent (default TRUE / opt-out — on out of the
 *   box; force-disabled when `memory.enabled: false`).
 * - sources: which DETERMINISTIC signals contribute (tool / pipeline). The
 *   optional cost-gated LLM judge is its own `judge` sub-block, not a `sources`
 *   member — deterministic signals always outrank the judge via fusion precedence.
 * - reactionMap: the success/failure emoji → outcome map (consumed by the
 *   reaction source; declared here so the config shape is stable).
 * - judge: the cost-gated `fast`-tier LLM judge. Default ENABLED (opt-out) — it is
 *   the FALLBACK outcome source for a CONVERSATIONAL turn (one with no deterministic
 *   tool/pipeline signal, which would otherwise resolve to `unknown` and derive no
 *   learning). It runs ONE cheap-model pass ONLY when the deterministic resolve is
 *   `unknown` (bounds the cost) and is force-disabled under `memory.enabled`.
 * - correction: the cost-gated correction detector.
 *   Default ENABLED (opt-out) — untrusted follow-up text is `wrapExternalContent`-
 *   fenced before the `fast`-tier judge; force-disabled under `memory.enabled`.
 * - minConfidenceToLearn: the floor a resolved outcome must clear before any
 *   learning is derived (range [0, 1]).
 * - retentionDays: age-based prune horizon for the append-only ledger (anti-DoS).
 *   Positive integer days.
 */
export const LearningOutcomeConfigSchema = z.strictObject({
  /** Enable the outcome signal for this agent. Default: TRUE (opt-out — on out of the
   *  box). Force-disabled when `memory.enabled: false`. */
  enabled: z.boolean().default(true),
  /** Deterministic signal sources that contribute to the resolved outcome. */
  sources: z.array(z.enum(["tool", "pipeline"])).default(["tool", "pipeline"]),
  /** Reaction-emoji → outcome map (consumed by the reaction source; declared here for a stable shape). */
  reactionMap: z
    .strictObject({
      success: z.array(z.string()).default(["👍", "✅"]),
      failure: z.array(z.string()).default(["👎", "❌"]),
    })
    .default(() => ({ success: ["👍", "✅"], failure: ["👎", "❌"] })),
  /** Cost-gated `fast`-tier LLM judge. Default ENABLED (opt-out) — the FALLBACK source
   *  that learns from a CONVERSATIONAL turn (an `unknown` deterministic resolve). Runs ONE
   *  cheap-model pass only on `unknown` (bounds cost); force-disabled under
   *  `memory.enabled`. (Zod v4 does NOT re-run an inner field default when the
   *  OUTER `.default()` supplies a populated object, so the outer default must ALSO set
   *  `enabled: true` — otherwise an absent `judge` block would read `undefined`, not `true`.) */
  judge: z.strictObject({ enabled: z.boolean().default(true) }).default(() => ({ enabled: true })),
  /** Cost-gated correction detector. Default: TRUE (opt-out).
   *  A follow-up "no, do X instead" turn is classified via the cheap `fast`-tier judge (untrusted
   *  text is `wrapExternalContent`-fenced) and emits a `corrected` soft-failure of the prior
   *  trajectory. Force-disabled when `memory.enabled: false`. */
  correction: z.strictObject({ enabled: z.boolean().default(true) }).default(() => ({ enabled: true })),
  /** Confidence floor [0,1] a resolved outcome must clear before learning is derived. */
  minConfidenceToLearn: z.number().min(0).max(1).default(0.6),
  /** Age-based prune horizon (days) for the append-only outcome ledger (anti-DoS). Positive integer.
   *  Default 90 (best-out-of-box: a larger outcome corpus for reflection to learn from — keep a
   *  quarter of history, storage cost ignored). Still a finite anti-DoS horizon. */
  retentionDays: z.number().int().positive().default(90),
});

export type LearningOutcomeConfig = z.infer<typeof LearningOutcomeConfigSchema>;
