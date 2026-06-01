// SPDX-License-Identifier: Apache-2.0
/**
 * Memory reasoning configuration schema (Phase 101 — REASON-04).
 *
 * Controls the offline reasoning job (deductive + inductive observation
 * generation) that runs over consolidated memories on a cron. The job is OFF by
 * default — enabling it is a COST opt-in (it runs an LLM cron), a deliberate
 * operator choice (REASON-04), not a default behavior. Every per-run cost axis
 * is bounded here — the surprisal gate (`surprisalTopFraction`) plus
 * `maxCandidatesPerRun` / `maxObservationsPerRun` / `maxReasoningTokens` — so an
 * operator cannot accidentally unbound the LLM spend (threat T-101-02-01 —
 * bounds defined here, enforced by the job in a later plan).
 *
 * Mirrors {@link MemoryConsolidationConfigSchema}'s shape and conventions.
 *
 * @module
 */

import { z } from "zod";

/**
 * MemoryReasoningConfigSchema: Zod schema for per-agent reasoning-job settings
 * (Phase 101, Track D — REASON-04).
 *
 * Fields:
 * - enabled: opt-in (default false — a cost gate, REASON-04)
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
  /** Enable the periodic reasoning job for this agent. Default: false (cost opt-in, REASON-04). */
  enabled: z.boolean().default(false),
  /** Cron schedule for reasoning runs. Default: daily at 04:00 UTC (after consolidation's 03:30). */
  schedule: z.string().default("0 4 * * *"),
  /** Maximum raw candidates fetched per run (cost bound, REASON-04). */
  maxCandidatesPerRun: z.number().int().positive().default(200),
  /** Keep the top fraction (0-1) of candidates by surprisal score — the surprisal gate (design S-H3). */
  surprisalTopFraction: z.number().min(0).max(1).default(0.1),
  /** Neighbour count for the corpus-wide k-NN surprisal score (positive int). */
  knnK: z.number().int().positive().default(10),
  /** Maximum observations written per run (DoS cost bound, REASON-04). */
  maxObservationsPerRun: z.number().int().positive().default(25),
  /** Maximum LLM response tokens for one reasoning call (cost bound, REASON-04). */
  maxReasoningTokens: z.number().int().positive().default(1024),
  /** Include external-trust memories in reasoning. Default: false (trust hardening, mirrors consolidateExternal). */
  reasonExternal: z.boolean().default(false),
  /** Extra tags applied to every created observation. */
  autoTags: z.array(z.string()).default([]),
});

export type MemoryReasoningConfig = z.infer<typeof MemoryReasoningConfigSchema>;
