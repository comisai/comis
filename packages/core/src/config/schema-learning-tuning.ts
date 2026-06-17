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
 * DEFAULT OFF — like `learningOutcome` and unlike the surrounding `memory*` cost
 * features (which default ON / opt-out), `learningTuning` defaults
 * `enabled: false`. Enabling it is a deliberate operator opt-in, and the phase's
 * byte-identity guarantee (zero behavior change with the default config) depends
 * on the default being disabled. The master kill-switch
 * `memory.costFeatures.enabled` force-disables it at the daemon registration site
 * (a later plan), exactly like the other cost features.
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
 * - enabled: master opt-in for this agent (default FALSE — the phase's
 *   byte-identity depends on it). Force-disabled when `memory.costFeatures.enabled: false`.
 * - learner: which alpha-update strategy to use. `bandit` is the FORWARD default
 *   (I8, NOT a back-compat toggle); `nudge` is the conservative deterministic
 *   STEP=0.05 fallback. Only `bandit` | `nudge` — a smuggled `thompson` is rejected.
 * - perIntent: learn a per-`(tenant, agent, intent)` alpha vector (default true).
 * - exploration: the UCB confidence-weight (range [0, 1]; resolved decision #2).
 *   NOT a tunable clamp/STEP — those are pure-math constants in `tuned-alpha-update.ts`.
 */
export const LearningTuningConfigSchema = z.strictObject({
  /** Enable outcome-rewarded per-intent tuning for this agent. Default: false
   *  (the phase's byte-identity precondition). Force-disabled when `memory.costFeatures.enabled: false`. */
  enabled: z.boolean().default(false),
  /** Alpha-update strategy. `bandit` = the FORWARD default (I8); `nudge` = the conservative
   *  deterministic STEP=0.05 fallback. NOT a back-compat toggle. */
  learner: z.enum(["bandit", "nudge"]).default("bandit"),
  /** Learn a per-`(tenant, agent, intent)` alpha vector (vs a single global vector). */
  perIntent: z.boolean().default(true),
  /** UCB confidence-weight [0,1] (resolved decision #2). NOT a tunable STEP/clamp knob. */
  exploration: z.number().min(0).max(1).default(0.1),
});

export type LearningTuningConfig = z.infer<typeof LearningTuningConfigSchema>;
