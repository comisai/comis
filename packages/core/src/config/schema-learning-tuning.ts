// SPDX-License-Identifier: Apache-2.0
/**
 * Per-agent learning-tuning (Verified Learning WS3 / ranking) configuration schema.
 *
 * The on/off switch for the outcome-rewarded usefulness-feedback write (RANK-01): the
 * daemon reward seam (`setup-learning.ts`) gates the SUCCESS→`recordUsage` /
 * failure→`recordFailure` write to the `usefulnessStore` on `learningTuning.enabled`.
 * That reward write is the FORGET-02 `failure_count` source the lifecycle sweep JOINs on,
 * so this flag is a KEEPER.
 *
 * Phase 224 (v2.31) DELETED the UCB recall bandit. The former `learner` / `perIntent` /
 * `exploration` sub-fields (the bandit knobs) are gone with it, and the recall-apply gate
 * (`rag.onlineTuning`) + the cron gate (`memoryOnlineTuning`) were removed too. This block
 * now carries ONLY `enabled` — the reward-write gate. (Its now-narrow scope rename is
 * deferred to Phase 226.)
 *
 * DEFAULT ON (opt-out) — `learningTuning` defaults `enabled: true`, like the surrounding
 * `memory*` cost features, so the outcome-rewarded usefulness write works out of the box.
 * The master kill-switch `memory.costFeatures.enabled` force-disables it (and every cost
 * feature) at the daemon registration site; set this `enabled: false` to opt a single
 * agent out.
 *
 * Strict (`z.strictObject`) with `.default()` on the field (Playbook 6.4) — consumers see a
 * fully-defaulted block; no `config.x ?? fallback` at call sites. `z.strictObject` is also a
 * SEC-01 control: a smuggled `trustAlpha`/trust knob is REJECTED at parse, so a trust weight
 * can never enter the reward path via config.
 *
 * @module
 */

import { z } from "zod";

/**
 * LearningTuningConfigSchema: Zod schema gating the per-agent outcome-rewarded
 * usefulness-feedback write (RANK-01).
 *
 * Fields:
 * - enabled: master switch for this agent (default TRUE / opt-out — on out of the
 *   box). Force-disabled when `memory.costFeatures.enabled: false`. Gates the
 *   `usefulnessStore.recordUsage`/`recordFailure` write (the FORGET-02 source).
 */
export const LearningTuningConfigSchema = z.strictObject({
  /** Enable the outcome-rewarded usefulness-feedback write for this agent. Default: TRUE
   *  (opt-out — on out of the box). Force-disabled when `memory.costFeatures.enabled: false`.
   *  Gates the daemon `recordUsage`/`recordFailure` write (the FORGET-02 failure_count source). */
  enabled: z.boolean().default(true),
});

export type LearningTuningConfig = z.infer<typeof LearningTuningConfigSchema>;
