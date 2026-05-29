// SPDX-License-Identifier: Apache-2.0
/**
 * Memory consolidation configuration schema (Phase 84).
 *
 * Controls the periodic background job that clusters repeated/near-duplicate
 * raw memories into a single observation row (`proof_count IS NOT NULL`) via a
 * cheap-model LLM merge. The job is OFF by default — enabling it is a COST
 * opt-in (it runs an LLM cron), a deliberate operator choice (CONS-07), not a
 * default behavior. Every per-run cost axis is bounded here so an operator cannot
 * accidentally unbound the LLM spend (threat T-84-02 — bounds defined here,
 * enforced by the job in a later plan).
 *
 * Mirrors {@link MemoryReviewConfigSchema}'s shape and conventions.
 *
 * @module
 */

import { z } from "zod";

/**
 * MemoryConsolidationConfigSchema: Zod schema for per-agent consolidation
 * settings (design §6.4).
 *
 * Fields:
 * - enabled: opt-in (default false — a cost gate, CONS-07)
 * - schedule: cron expression, after memory-review's "0 2" daily slot
 * - similarityThreshold: cluster neighbour cosine (greedy single-link)
 * - dedupThreshold: secondary content-similarity dedup guard (CONS-04)
 * - maxCandidatesPerRun / maxClusterSize / maxClustersPerRun /
 *   maxConsolidationTokens: per-run cost bounds (CONS-07 / T-84-02)
 * - consolidateExternal: include external-trust memories (default false — the
 *   trust-hardening default; external excluded, CONS-02)
 * - autoTags: extra tags applied to created observations
 *
 * A fold-into-existing threshold is intentionally OMITTED — fold-into-existing
 * is deferred; this phase is create-only.
 */
export const MemoryConsolidationConfigSchema = z.strictObject({
  /** Enable periodic consolidation for this agent. Default: false (cost opt-in, CONS-07). */
  enabled: z.boolean().default(false),
  /** Cron schedule for consolidation runs. Default: daily at 03:30 UTC (after review's 02:00). */
  schedule: z.string().default("30 3 * * *"),
  /** Cluster-neighbour cosine threshold (0-1) for greedy single-link clustering. */
  similarityThreshold: z.number().min(0).max(1).default(0.82),
  /** Secondary content-similarity threshold (0-1) for the deterministic dedup pre-check (CONS-04). */
  dedupThreshold: z.number().min(0).max(1).default(0.9),
  /** Maximum raw candidates fetched per run (cost bound, CONS-07). */
  maxCandidatesPerRun: z.number().int().positive().default(200),
  /** Maximum candidates folded into one observation (cost bound, CONS-07). */
  maxClusterSize: z.number().int().positive().default(12),
  /** Maximum clusters consolidated per run (cost bound, CONS-07). */
  maxClustersPerRun: z.number().int().positive().default(25),
  /** Maximum LLM response tokens for one merge call (cost bound, CONS-07). */
  maxConsolidationTokens: z.number().int().positive().default(1024),
  /** Include external-trust memories in consolidation. Default: false (CONS-02 hardening). */
  consolidateExternal: z.boolean().default(false),
  /** Extra tags applied to every created observation. */
  autoTags: z.array(z.string()).default([]),
});

export type MemoryConsolidationConfig = z.infer<typeof MemoryConsolidationConfigSchema>;
