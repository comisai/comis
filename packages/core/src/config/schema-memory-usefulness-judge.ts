// SPDX-License-Identifier: Apache-2.0
/**
 * Offline usefulness-judge configuration schema (Phase 110 — LEARN-02 OPTIONAL,
 * Track H3).
 *
 * OPTIONAL offline cheap-model judge that POST-HOC scores recalled-memory
 * usefulness, feeding FEED via `recordUsage` (the same per-intent write loop the
 * citation marker drives at 110-04). OFF by default — enabling it is a COST opt-in
 * (it runs an LLM cron), a deliberate operator choice, NOT a default behavior (no
 * back-compat fallback). OFFLINE only: the judge runs on a cron and NEVER touches
 * the recall read path (the recall hot path stays LLM-free — T-110-14).
 *
 * The citation-marker attribution (Plan 110-04) is the KEYLESS core of LEARN-02;
 * this judge is the optional extra. Its costed enablement (the sentinel → seam →
 * recordUsage write) is deferred to Phase 111 — this schema only lands the
 * default-OFF knob so Phase 111 can enable it without new config machinery.
 *
 * Mirrors {@link MemoryUserRepresentationConfigSchema}'s cost-gate cron shape; kept
 * deliberately small — the judge needs no per-run write cap (it writes through the
 * existing recordUsage port, bounded by the source set it scores).
 *
 * @module
 */

import { z } from "zod";

/**
 * MemoryUsefulnessJudgeConfigSchema: Zod schema for the per-agent offline
 * usefulness-judge cron (Phase 110, Track H3 — LEARN-02 OPTIONAL).
 *
 * Fields:
 * - enabled: opt-in (default false — a cost gate, not back-compat)
 * - schedule: cron expression, AFTER social's "0 6" daily slot so the judge scores
 *   recalled-memory usefulness over a fully-settled night (review/consolidation/
 *   reasoning/user-repr/social have all run)
 * - maxSourceMemories / maxSourceChars: the per-run INPUT bound — the most recalled
 *   memories / total chars fed into ONE judge prompt, so an over-context prompt can
 *   never silently fail the judge (the same DoS-bound intent as the userrep seam's
 *   read axis)
 */
export const MemoryUsefulnessJudgeConfigSchema = z.strictObject({
  /** Enable the periodic offline usefulness judge for this agent. Default: false (cost opt-in). */
  enabled: z.boolean().default(false),
  /** Cron schedule for judge runs. Default: daily at 07:00 UTC (after social's 06:00). */
  schedule: z.string().default("0 7 * * *"),
  /** INPUT bound: max recalled memories fed into one judge prompt (newest-first). */
  maxSourceMemories: z.number().int().positive().default(200),
  /** INPUT bound: max total chars of the concatenated judge source text. */
  maxSourceChars: z.number().int().positive().default(24_000),
});

export type MemoryUsefulnessJudgeConfig = z.infer<typeof MemoryUsefulnessJudgeConfigSchema>;
