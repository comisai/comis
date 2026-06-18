// SPDX-License-Identifier: Apache-2.0
/**
 * Per-agent learning-tuning (Verified Learning WS3 / ranking) configuration schema.
 *
 * The on/off switch + tunables for the outcome-rewarded, per-intent tuned-alpha
 * learner. Every later Phase-200 plan reads this block: the daemon reward seam
 * (RANK-01), the bandit job (RANK-03), and the per-intent recall apply (RANK-02)
 * all gate on `learningTuning.enabled`. It composes WITH — does NOT replace — the
 * existing `memoryOnlineTuning.enabled` (the cron-schedule gate) and
 * `rag.onlineTuning.enabled` (the recall-apply gate); all three AND together.
 *
 * DEFAULT ON (opt-out) — `learningTuning` defaults `enabled: true`, like the
 * surrounding `memory*` cost features, so outcome-rewarded ranking works out of the
 * box. The master kill-switch `memory.costFeatures.enabled` force-disables it (and
 * every cost feature) at the daemon registration site; set this `enabled: false` to
 * opt a single agent out. (Was opt-in during the v2.26 phased rollout.)
 *
 * Strict (`z.strictObject`) with `.default()` on EVERY field (Playbook 6.4) —
 * consumers see a fully-defaulted block; no `config.x ?? fallback` at call sites.
 * `z.strictObject` is also a SEC-01 control: a smuggled `trustAlpha`/trust knob
 * (or a tunable `step`) is REJECTED at parse, so a trust weight can never enter
 * the bandit via config (the four trust-freeze belts stay intact).
 *
 * @module
 */

import { z } from "zod";

/**
 * LearningTuningConfigSchema: Zod schema for the per-agent tuned-alpha learner.
 *
 * Fields:
 * - enabled: master switch for this agent (default TRUE / opt-out — on out of the
 *   box). Force-disabled when `memory.costFeatures.enabled: false`.
 * - learner: which alpha-update strategy to use. `bandit` is the FORWARD default
 *   (I8, NOT a back-compat toggle); `nudge` is the conservative deterministic
 *   STEP=0.05 fallback. Only `bandit` | `nudge` — a smuggled `thompson` is rejected.
 * - perIntent: learn a per-`(tenant, agent, intent)` alpha vector (default true).
 * - exploration: the UCB confidence-weight (range [0, 1]; resolved decision #2).
 *   NOT a tunable clamp/STEP — those are pure-math constants in `tuned-alpha-update.ts`.
 */
export const LearningTuningConfigSchema = z.strictObject({
  /** Enable outcome-rewarded per-intent tuning for this agent. Default: TRUE (opt-out
   *  — on out of the box). Force-disabled when `memory.costFeatures.enabled: false`. */
  enabled: z.boolean().default(true),
  /** Alpha-update strategy. `bandit` = the FORWARD default (I8); `nudge` = the conservative
   *  deterministic STEP=0.05 fallback. NOT a back-compat toggle. */
  learner: z.enum(["bandit", "nudge"]).default("bandit"),
  /** Learn a per-`(tenant, agent, intent)` alpha vector (vs a single global vector). */
  perIntent: z.boolean().default(true),
  /** UCB confidence-weight [0,1] (resolved decision #2). NOT a tunable STEP/clamp knob. */
  exploration: z.number().min(0).max(1).default(0.1),
});

export type LearningTuningConfig = z.infer<typeof LearningTuningConfigSchema>;
