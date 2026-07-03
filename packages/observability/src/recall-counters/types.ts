// SPDX-License-Identifier: Apache-2.0
/**
 * In-process recall counter registry types.
 *
 * The counter registry is a process-lifetime GAUGE: it
 * accumulates lane usage, rerank runs/fallbacks, consolidation throughput,
 * and recall hit-rate inputs in plain numeric accumulators that RESET ON
 * RESTART. It is deliberately NOT a durable SQLite table (unlike the
 * cache-stats `obs_token_usage` table) — these are health/metrics gauges
 * derivable from the live `memory:*` events, and a durable table would need
 * a schema migration + write path for no operational gain.
 *
 * Threat note (disposition: accept): the counters are integers only
 * — no content, no ids, no PII. Process-lifetime in-memory; no disk, no
 * cross-process leak surface.
 *
 * @module
 */

/**
 * A point-in-time snapshot of the in-process recall counters.
 *
 * Derived rates (computed by the reader, not stored):
 *   - rerankFallbackRate = rerankFallbacks / rerankRuns
 *   - recallHitRate       = recallsWithHits / recalls
 *
 * Both denominators may be 0 (a fresh process) — the reader guards the
 * divide-by-zero.
 */
export interface RecallCountersSnapshot {
  /** Cumulative candidate counts contributed per retrieval lane. */
  laneUsage: { fts: number; vector: number; entity: number };
  /** Total rerank attempts (ran + fell-back + timed-out). */
  rerankRuns: number;
  /** Rerank attempts that fell back to fusion order (err OR timeout). */
  rerankFallbacks: number;
  /** Cumulative consolidation clusters processed (throughput numerator). */
  consolidationClusters: number;
  /** Cumulative observations created by consolidation (throughput). */
  observationsCreated: number;
  /** Total recalls (hit-rate denominator). */
  recalls: number;
  /** Recalls that returned at least one memory (hit-rate numerator). */
  recallsWithHits: number;
}

/** Input to `onRecalled` — counts-only, never content/ids/query text. */
export interface RecalledCounterInput {
  /** Per-lane candidate counts for this recall. */
  readonly lanes: { readonly fts: number; readonly vector: number; readonly entity: number };
  /** Size of the final ranked set (0 ⇒ no hit). */
  readonly finalCount: number;
  /** Whether the cross-encoder reranker was available for this recall. */
  readonly rerankerAvailable: boolean;
}

/** Input to `onReranked` — the rerank outcome flags for one recall. */
export interface RerankedCounterInput {
  /** True when the reranker returned err and the recall used the fusion order. */
  readonly fellBack: boolean;
  /** True when the reranker exceeded its budget and the recall used the fusion order. */
  readonly timedOut: boolean;
}

/** Input to `onConsolidated` — one consolidation run's throughput. */
export interface ConsolidatedCounterInput {
  /** Clusters processed in this consolidation run. */
  readonly clustersProcessed: number;
  /** Observations created in this consolidation run. */
  readonly observationsCreated: number;
}

/**
 * The in-process counter registry surface. Each `createRecallCounters()`
 * call owns its own accumulators (no shared module-global state), so two
 * registries are independent.
 */
export interface RecallCounters {
  /** Record one recall: per-lane counts + recall/hit tallies. */
  onRecalled(input: RecalledCounterInput): void;
  /** Record one rerank attempt: run + (conditionally) fallback. */
  onReranked(input: RerankedCounterInput): void;
  /** Record one consolidation run's throughput. */
  onConsolidated(input: ConsolidatedCounterInput): void;
  /** Return a defensive copy of the current counter values. */
  snapshot(): RecallCountersSnapshot;
}
