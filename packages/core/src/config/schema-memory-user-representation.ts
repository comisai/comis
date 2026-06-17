// SPDX-License-Identifier: Apache-2.0
/**
 * Per-user representation configuration schema.
 *
 * Controls the offline per-user profile-builder job (`runUserRepresentationBuild`)
 * that distills a durable, prefix-typed profile of each user from their HIGH-TRUST
 * source memories on a cron. The per-feature `enabled` flag defaults ON (opt-out); the
 * job is a COST feature gated by the master switch `memory.costFeatures.enabled`
 * (default `true` = opt-out) — turning that master switch OFF force-disables it. The
 * per-run write cap (`maxEntriesPerRun`) is the DoS cost bound — an operator cannot
 * accidentally unbound the LLM spend.
 *
 * Mirrors {@link MemoryReasoningConfigSchema}'s shape and conventions (the cost-gate
 * cron pattern); kept deliberately small — the per-user profile has no surprisal
 * gate / k-NN read (it distills the already-high-trust source set directly).
 *
 * @module
 */

import { z } from "zod";

/**
 * MemoryUserRepresentationConfigSchema: Zod schema for per-agent profile-builder
 * settings.
 *
 * Fields:
 * - enabled: default true (opt-out); a cost gate force-disabled by the master switch
 * - schedule: cron expression, after reasoning's "0 4" daily slot so the profile
 *   is built over freshly-reasoned/consolidated memories the same night
 * - maxEntriesPerRun: max profile entries WRITTEN per run (the DoS cost bound, write axis)
 * - maxSourceMemories / maxSourceChars: the per-build INPUT bound — the most
 *   source memories / total chars fed into ONE distillation prompt, so an over-context
 *   prompt can never silently fail the build (the same DoS-bound intent on the read axis)
 */
export const MemoryUserRepresentationConfigSchema = z.strictObject({
  /** Enable the periodic per-user profile build for this agent. Default: true (v1 opt-out
   *  posture). A COST feature — force-disabled when
   *  `memory.costFeatures.enabled: false`. */
  enabled: z.boolean().default(true),
  /** Cron schedule for profile builds. Default: daily at 05:00 UTC (after reasoning's 04:00). */
  schedule: z.string().default("0 5 * * *"),
  /** Maximum profile entries written per run (the DoS cost bound, write axis). */
  maxEntriesPerRun: z.number().int().positive().default(50),
  /** INPUT bound: max source memories fed into one build() prompt (newest-first). */
  maxSourceMemories: z.number().int().positive().default(200),
  /** INPUT bound: max total chars of the concatenated build() source text. */
  maxSourceChars: z.number().int().positive().default(24_000),
});

export type MemoryUserRepresentationConfig = z.infer<typeof MemoryUserRepresentationConfigSchema>;
