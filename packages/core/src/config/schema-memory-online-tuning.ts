// SPDX-License-Identifier: Apache-2.0
/**
 * Offline online-tuning (learning-to-rank bandit) configuration schema.
 *
 * The CRON knob for the OFFLINE, DETERMINISTIC, LLM-FREE tuned-alpha bandit. The
 * per-feature `enabled` flag defaults ON (opt-out); it is in the operator-facing
 * cost-feature set, so the master switch `memory.costFeatures.enabled` (default
 * `true` = opt-out) force-disables it alongside the LLM crons for a single off-switch.
 * Unlike {@link MemoryUsefulnessJudgeConfigSchema} (an
 * LLM cron), this bandit is KEYLESS: the cron dispatch makes NO model call and
 * needs NO API key (the deletion vs the judge — the bandit reads the already-accrued
 * FEED signal, runs a pure clamped step, and upserts a 4-alpha vector). So enabling
 * it costs nothing in LLM spend; the per-feature gate exists for behavior-opt-in + a
 * bounded write, not cost.
 *
 * OFFLINE only: the bandit runs on a cron and NEVER touches the recall read path
 * (the recall hot path stays LLM-free + deterministic — binding constraint #1). The
 * SEPARATE recall-side apply gate is `rag.onlineTuning.enabled` (schema-agent-prompt);
 * this schema gates only the CRON + the write. A default agent registers NO cron and
 * (with the recall gate also off) reads NO tuned vector — byte-identical to today.
 *
 * Mirrors {@link MemoryUsefulnessJudgeConfigSchema}'s cost-gate cron shape; kept
 * deliberately small — the bandit's only INPUT bound is the candidate-id set it
 * scores (`maxSourceMemories`); the clamp + the per-run STEP are pure-math constants
 * in `computeTunedAlphas`, NOT operator knobs (a tunable step/clamp would
 * be a footgun that could overturn trust-first). It is a `z.strictObject`, so a
 * stray field (e.g. a smuggled trust knob, or the judge's `maxSourceChars`) is
 * REJECTED at parse — the bandit's surface is structurally minimal.
 *
 * @module
 */

import { z } from "zod";

/**
 * MemoryOnlineTuningConfigSchema: Zod schema for the per-agent OFFLINE tuned-alpha
 * bandit cron.
 *
 * Fields:
 * - enabled: default true (opt-out); a behavior gate force-disabled by the master
 *   switch. The bandit is keyless/deterministic, so this is not a COST gate like the
 *   LLM-cron knobs — but it sits in the cost-feature set for a single off-switch.
 * - schedule: cron expression, default daily at 08:00 UTC — AFTER the usefulness
 *   judge's "0 7" slot so the FEED signal it reads is fully settled (the judge's
 *   recordUsage write, if enabled, has run; review/consolidation/reasoning/user-repr/
 *   social are earlier still).
 * - maxSourceMemories: the per-run INPUT bound — the most-recent candidate memory
 *   ids whose FEED signal is read + aggregated into the bounded gradient. Bounds the
 *   read the bandit scores so one run can never grow unbounded over a chatty agent's
 *   full history (the same DoS-bound intent as the judge's read axis).
 */
export const MemoryOnlineTuningConfigSchema = z.strictObject({
  /** Enable the periodic OFFLINE tuned-alpha bandit for this agent. Default: true (opt-out
   *  posture). Keyless/deterministic, but in the operator-facing cost-feature
   *  set — force-disabled when `memory.costFeatures.enabled: false` for a single off-switch. */
  enabled: z.boolean().default(true),
  /** Cron schedule for bandit runs. Default: daily at 08:00 UTC (AFTER the judge's 07:00). */
  schedule: z.string().default("0 8 * * *"),
  /** INPUT bound: max recent candidate memories whose FEED signal is read per run. */
  maxSourceMemories: z.number().int().positive().default(200),
});

export type MemoryOnlineTuningConfig = z.infer<typeof MemoryOnlineTuningConfigSchema>;
