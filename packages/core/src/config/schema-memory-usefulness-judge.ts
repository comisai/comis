// SPDX-License-Identifier: Apache-2.0
/**
 * Offline usefulness-judge configuration schema (OPTIONAL).
 *
 * OPTIONAL offline cheap-model judge that POST-HOC scores recalled-memory
 * usefulness, feeding FEED via `recordUsage` (the same per-intent write loop the
 * citation marker drives). The per-feature `enabled` flag defaults ON (opt-out); the
 * judge is a COST feature gated by the master switch `memory.costFeatures.enabled`
 * (default `true` = opt-out) — turning that master switch OFF force-disables it. OFFLINE
 * only: the judge runs on a cron and NEVER touches the recall read path (the recall
 * hot path stays LLM-free).
 *
 * The citation-marker attribution is the KEYLESS core of this feature;
 * this judge is the optional extra. Its costed enablement (the sentinel → seam →
 * recordUsage write) is deferred — this schema only lands the default-OFF knob so
 * it can later be enabled without new config machinery.
 *
 * Mirrors the cost-gate cron config shape (the pattern the deleted
 * user-representation schema also followed); kept
 * deliberately small — the judge needs no per-run write cap (it writes through the
 * existing recordUsage port, bounded by the source set it scores).
 *
 * @module
 */

import { z } from "zod";

/**
 * MemoryUsefulnessJudgeConfigSchema: Zod schema for the per-agent offline
 * usefulness-judge cron (OPTIONAL).
 *
 * Fields:
 * - enabled: default true (opt-out); a cost gate force-disabled by the master switch
 * - schedule: cron expression, AFTER social's "0 6" daily slot so the judge scores
 *   recalled-memory usefulness over a fully-settled night (review/consolidation/
 *   reasoning/user-repr/social have all run)
 * - maxSourceMemories / maxSourceChars: the per-run INPUT bound — the most recalled
 *   memories / total chars fed into ONE judge prompt, so an over-context prompt can
 *   never silently fail the judge (the same DoS-bound intent as the userrep seam's
 *   read axis)
 */
export const MemoryUsefulnessJudgeConfigSchema = z.strictObject({
  /** Enable the periodic offline usefulness judge for this agent. Default: true (v1 opt-out
   *  posture). A COST feature — force-disabled when
   *  `memory.costFeatures.enabled: false`. */
  enabled: z.boolean().default(true),
  /** Cron schedule for judge runs. Default: daily at 07:00 UTC (after social's 06:00). */
  schedule: z.string().default("0 7 * * *"),
  /** INPUT bound: max recalled memories fed into one judge prompt (newest-first). */
  maxSourceMemories: z.number().int().positive().default(200),
  /** INPUT bound: max total chars of the concatenated judge source text. */
  maxSourceChars: z.number().int().positive().default(24_000),
});

export type MemoryUsefulnessJudgeConfig = z.infer<typeof MemoryUsefulnessJudgeConfigSchema>;
