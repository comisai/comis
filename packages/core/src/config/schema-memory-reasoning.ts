// SPDX-License-Identifier: Apache-2.0
/**
 * Memory reasoning configuration schema.
 *
 * Controls the offline reasoning job (deductive + inductive observation
 * generation) that runs over consolidated memories on a cron. The per-feature
 * `enabled` flag defaults ON (opt-out); the job is a COST feature gated by the master
 * switch `memory.costFeatures.enabled` (default `true` = opt-out) — turning that master
 * switch OFF force-disables it. Every per-run cost axis is bounded here — the surprisal
 * gate (`surprisalTopFraction`) plus
 * `maxCandidatesPerRun` / `maxObservationsPerRun` / `maxReasoningTokens` — so an
 * operator cannot accidentally unbound the LLM spend (the unbounded-spend threat —
 * bounds defined here, enforced by the job in a later plan).
 *
 * Mirrors {@link MemoryConsolidationConfigSchema}'s shape and conventions.
 *
 * @module
 */

import { z } from "zod";

/**
 * MemoryReasoningConfigSchema: Zod schema for per-agent reasoning-job settings.
 *
 * Fields:
 * - enabled: default true (opt-out); a cost gate force-disabled by the master switch
 * - schedule: cron expression, after consolidation's "30 3" daily slot so
 *   reasoning runs over freshly-consolidated observations
 * - maxCandidatesPerRun: candidate pool cap (cost bound)
 * - surprisalTopFraction: keep the top fraction by surprisal score — the
 *   surprisal gate that bounds how many candidates reach the LLM (design S-H3)
 * - knnK: neighbours per surprisal score (the corpus-wide k-NN read width)
 * - maxObservationsPerRun: max observations written per run (DoS cost bound)
 * - maxReasoningTokens: per-call LLM output bound (cost bound)
 * - reasonExternal: include external-trust memories (default false — the
 *   trust-hardening default; external excluded, mirrors consolidateExternal)
 * - autoTags: extra tags applied to created observations
 */
export const MemoryReasoningConfigSchema = z.strictObject({
  /** Enable the periodic reasoning job for this agent. Default: true (opt-out posture).
   *  A COST feature — force-disabled when `memory.costFeatures.enabled: false`. */
  enabled: z.boolean().default(true),
  /** Cron schedule for reasoning runs. Default: daily at 04:00 UTC (after consolidation's 03:30). */
  schedule: z.string().default("0 4 * * *"),
  /** Maximum raw candidates fetched per run (cost bound). */
  maxCandidatesPerRun: z.number().int().positive().default(200),
  /** Keep the top fraction (0-1) of candidates by surprisal score — the surprisal gate (design S-H3). */
  surprisalTopFraction: z.number().min(0).max(1).default(0.1),
  /** Neighbour count for the corpus-wide k-NN surprisal score (positive int). */
  knnK: z.number().int().positive().default(10),
  /** Maximum observations written per run (DoS cost bound). */
  maxObservationsPerRun: z.number().int().positive().default(25),
  /** Maximum LLM response tokens for one reasoning call (cost bound). */
  maxReasoningTokens: z.number().int().positive().default(1024),
  /** Include external-trust memories in reasoning. Default: false (trust hardening, mirrors consolidateExternal). */
  reasonExternal: z.boolean().default(false),
  /** Extra tags applied to every created observation. */
  autoTags: z.array(z.string()).default([]),
});

export type MemoryReasoningConfig = z.infer<typeof MemoryReasoningConfigSchema>;
