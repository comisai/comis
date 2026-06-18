// SPDX-License-Identifier: Apache-2.0
/**
 * Per-agent memory triple-extraction configuration schema (Verified Learning WS7).
 *
 * The CRON knob for the OFFLINE job `runMemoryTripleExtraction`, which extracts
 * S/P/O triples from raw conversation turns via a cheap-model call — COMPLEMENTARY
 * to the deductive/inductive `runMemoryReasoning` cron (higher-recall facts straight
 * from raw turns), NOT redundant with it.
 *
 * DEFAULT ON (opt-out) — `memoryTripleExtraction` defaults `enabled: true`, like
 * every surrounding `memory*` cost feature, so KG triples are extracted out of the
 * box. The master kill-switch `memory.costFeatures.enabled` (default true) ALSO
 * force-disables it at the registration site (setup-schedulers.ts) alongside the
 * other cost crons; set this `enabled: false` to opt a single agent out.
 *
 * Strict (`z.strictObject`) with `.default()` on EVERY field (Playbook 6.4) — a
 * smuggled trust knob is REFUSED at parse; consumers see a fully-defaulted block.
 *
 * @module
 */

import { z } from "zod";

/**
 * MemoryTripleExtractionConfigSchema: Zod schema for the per-agent offline
 * triple-extraction cron.
 *
 * Fields:
 * - enabled: opt-out (default TRUE — complementary to runMemoryReasoning, on out of the box)
 * - schedule: cron expression, default daily at 06:00 UTC (after the night's cost crons)
 * - maxCandidatesPerRun: the per-run write cap (the DoS cost bound on triples written)
 */
export const MemoryTripleExtractionConfigSchema = z.strictObject({
  /** Enable the periodic offline triple-extraction job for this agent. Default: TRUE
   *  (opt-out — on out of the box). Force-disabled when
   *  `memory.costFeatures.enabled: false`. */
  enabled: z.boolean().default(true),
  /** Cron schedule for triple-extraction runs. Default: daily at 06:00 UTC. */
  schedule: z.string().default("0 6 * * *"),
  /** Maximum triple candidates written per run (the DoS cost bound). */
  maxCandidatesPerRun: z.number().int().positive().default(200),
});

export type MemoryTripleExtractionConfig = z.infer<typeof MemoryTripleExtractionConfigSchema>;
