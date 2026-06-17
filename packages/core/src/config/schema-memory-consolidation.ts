// SPDX-License-Identifier: Apache-2.0
/**
 * Memory consolidation configuration schema.
 *
 * Controls the periodic background job that clusters repeated/near-duplicate
 * raw memories into a single observation row (`proof_count IS NOT NULL`) via a
 * cheap-model LLM merge. The per-feature `enabled` flag defaults ON (opt-out); the
 * job is a COST feature gated by the master switch `memory.costFeatures.enabled`
 * (default `true` = opt-out) — turning that master switch OFF force-disables this
 * cron (and the other five cost crons) at its registration site. Every per-run cost
 * axis is bounded here so an operator cannot accidentally unbound the LLM spend
 * (bounds defined here, enforced by the job).
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
 * - enabled: default true (opt-out); a cost gate force-disabled by the master switch
 * - schedule: cron expression, after memory-review's "0 2" daily slot
 * - similarityThreshold: cluster neighbour cosine (greedy single-link)
 * - dedupThreshold: secondary content-similarity dedup guard
 * - maxCandidatesPerRun / maxClusterSize / maxClustersPerRun /
 *   maxConsolidationTokens: per-run cost bounds
 * - consolidateExternal: include external-trust memories (default false — the
 *   trust-hardening default; external excluded)
 * - autoTags: extra tags applied to created observations
 *
 * A fold-into-existing threshold is intentionally OMITTED — fold-into-existing
 * is deferred; this schema is create-only.
 */
export const MemoryConsolidationConfigSchema = z.strictObject({
  /** Enable periodic consolidation for this agent. Default: true (opt-out posture).
   *  A COST feature — force-disabled when `memory.costFeatures.enabled: false`. */
  enabled: z.boolean().default(true),
  /** Cron schedule for consolidation runs. Default: daily at 03:30 UTC (after review's 02:00). */
  schedule: z.string().default("30 3 * * *"),
  /** Cluster-neighbour cosine threshold (0-1) for greedy single-link clustering. */
  similarityThreshold: z.number().min(0).max(1).default(0.82),
  /** Secondary content-similarity threshold (0-1) for the deterministic dedup pre-check. */
  dedupThreshold: z.number().min(0).max(1).default(0.9),
  /** Maximum raw candidates fetched per run (cost bound). */
  maxCandidatesPerRun: z.number().int().positive().default(200),
  /** Maximum candidates folded into one observation (cost bound). */
  maxClusterSize: z.number().int().positive().default(12),
  /** Maximum clusters consolidated per run (cost bound). */
  maxClustersPerRun: z.number().int().positive().default(25),
  /** Maximum LLM response tokens for one merge call (cost bound). */
  maxConsolidationTokens: z.number().int().positive().default(1024),
  /** Include external-trust memories in consolidation. Default: false (trust hardening). */
  consolidateExternal: z.boolean().default(false),
  /** Extra tags applied to every created observation. */
  autoTags: z.array(z.string()).default([]),
});

export type MemoryConsolidationConfig = z.infer<typeof MemoryConsolidationConfigSchema>;
