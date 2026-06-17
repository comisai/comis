// SPDX-License-Identifier: Apache-2.0
/**
 * Per-agent memory triple-extraction configuration schema (Verified Learning WS7).
 *
 * The CRON knob for the OFFLINE job `runMemoryTripleExtraction`, which extracts
 * S/P/O triples from raw conversation turns via a cheap-model call — COMPLEMENTARY
 * to the deductive/inductive `runMemoryReasoning` cron (higher-recall facts straight
 * from raw turns), NOT redundant with it.
 *
 * DEFAULT OFF — the lone OFF-by-default learning seam alongside `learningOutcome`
 * (every surrounding `memory*` cost feature defaults ON / opt-out). A default agent
 * registers NO triple-extraction job, so it adds ZERO cost and stays byte-identical
 * with the config absent. Enabling it is a deliberate operator opt-in; the master
 * kill-switch `memory.costFeatures.enabled` (default true) ALSO force-disables it at
 * the registration site (setup-schedulers.ts) alongside the other cost crons.
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
 * - enabled: opt-in (default FALSE — complementary to runMemoryReasoning, not back-compat)
 * - schedule: cron expression, default daily at 06:00 UTC (after the night's cost crons)
 * - maxCandidatesPerRun: the per-run write cap (the DoS cost bound on triples written)
 */
export const MemoryTripleExtractionConfigSchema = z.strictObject({
  /** Enable the periodic offline triple-extraction job for this agent. Default: false
   *  (opt-in; the lone OFF-by-default learning seam). Force-disabled when
   *  `memory.costFeatures.enabled: false`. */
  enabled: z.boolean().default(false),
  /** Cron schedule for triple-extraction runs. Default: daily at 06:00 UTC. */
  schedule: z.string().default("0 6 * * *"),
  /** Maximum triple candidates written per run (the DoS cost bound). */
  maxCandidatesPerRun: z.number().int().positive().default(200),
});

export type MemoryTripleExtractionConfig = z.infer<typeof MemoryTripleExtractionConfigSchema>;
