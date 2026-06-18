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
 * - generalize: GENERAL-01/02 higher-order generalization synthesis block
 *   (enabled default-OFF + minDistinctContexts diversity gate) — opt-in additive
 *   to the merge loop, default behaviour byte-identical when off
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
  /** GENERAL-01/02: higher-order generalization synthesis (cluster → one "user prefers X in general"
   *  semantic memory). Default-ON (opt-out) — additive to the merge loop; rides the same abstain gate
   *  + the minDistinctContexts diversity gate. The block default is the explicit populated object (Zod
   *  v4 does NOT re-run inner field defaults for a bare `.default({})`), so a config omitting
   *  `generalize` still parses to the full shape. */
  generalize: z
    .strictObject({
      enabled: z.boolean().default(true),
      /** Min distinct (sessionKey, sender) contexts in a cluster before it generalizes (anti-domination). */
      minDistinctContexts: z.number().int().positive().default(3),
    })
    // OUTER default is the AUTHORITATIVE value for an absent `generalize` block
    // (Zod v4 does NOT re-run the inner field defaults for a populated `.default`),
    // so it must carry enabled:true to be default-ON out of the box.
    .default({ enabled: true, minDistinctContexts: 3 }),
});

export type MemoryConsolidationConfig = z.infer<typeof MemoryConsolidationConfigSchema>;
