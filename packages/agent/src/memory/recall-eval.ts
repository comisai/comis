// SPDX-License-Identifier: Apache-2.0
/**
 * Deterministic recall@k / MRR scorer for the LongMemEval-style eval harness
 * — the reranked-vs-fusion recall-LIFT measurement substrate.
 *
 * PURE MATH (no Result, no throws, no I/O — AGENTS.md §2.1 carve-out for pure
 * functions). recall@k and MRR are standard, deterministic IR metrics; the
 * scorer runs a ranking function over labeled fixtures and macro-averages.
 * The harness compares a BASELINE ranker (caller-provided — typically the
 * fusion-only order via `fuse(...)` in recall-eval.test.ts) against a RERANKED
 * ranker and reports the recall@1 / MRR lift — the number that proves
 * the cross-encoder delivers a measurable recall gain over fusion-only.
 *
 * ARCHITECTURE CUT (architecture.test.ts "agent -> memory"): this production
 * file imports ONLY core types + the in-package fixtures type. It MUST NOT
 * import the memory package (a devDependency). The real-model lift run lives in
 * recall-eval.test.ts, which MAY import the reranker adapter (the .test.ts
 * suffix is excluded from the cut).
 *
 * EXTENSIBILITY: scoreRanking/compareRankings accept any
 * EvalQuery[] — e.g. the "temporal" group or the "entity"
 * group — re-scoring without restructuring.
 *
 * Metric definitions:
 *   recall@k = |relevant ∩ first-k(rankedIds)| / |relevant|       (per query)
 *   RR       = 1 / (1-based rank of first relevant id), 0 if none in list
 *   MRR      = mean RR across queries
 *   *@k / MRR over a query set are MACRO-averaged (mean of per-query values).
 *
 * @module
 */

import type { MemorySearchResult } from "@comis/core";
import type { EvalQuery } from "./__fixtures__/recall-eval-fixtures.js";

/**
 * Recall@k for a single ranked id list against a labeled relevant set.
 *
 * Returns `|relevant ∩ first-k(rankedIds)| / |relevant|`. Each relevant id is
 * counted at most once (duplicate ranked ids do not inflate the numerator). A
 * non-positive `k` or an empty relevant set yields `0` (no ground truth to
 * recall — division by zero is mapped to 0, never NaN).
 */
export function recallAtK(rankedIds: string[], relevantIds: string[], k: number): number {
  const relevant = new Set(relevantIds);
  if (relevant.size === 0 || k <= 0) return 0;
  const topK = new Set(rankedIds.slice(0, k));
  let hits = 0;
  for (const id of relevant) {
    if (topK.has(id)) hits++;
  }
  return hits / relevant.size;
}

/**
 * Reciprocal rank of the first relevant id in a single ranked list.
 *
 * `1 / (1-based position of the first relevant id)`, or `0` if no relevant id
 * appears in the list.
 */
function reciprocalRank(rankedIds: string[], relevantIds: string[]): number {
  const relevant = new Set(relevantIds);
  if (relevant.size === 0) return 0;
  for (let i = 0; i < rankedIds.length; i++) {
    const id = rankedIds[i];
    if (id !== undefined && relevant.has(id)) return 1 / (i + 1);
  }
  return 0;
}

/**
 * Mean reciprocal rank over a set of queries (macro-average of per-query RR).
 *
 * `perQueryRanked[i]` is the ranked id list for query `i`; `perQueryRelevant[i]`
 * its relevant id set. An empty query set yields `0`.
 */
export function meanReciprocalRank(
  perQueryRanked: string[][],
  perQueryRelevant: string[][],
): number {
  const n = perQueryRanked.length;
  if (n === 0) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    sum += reciprocalRank(perQueryRanked[i] ?? [], perQueryRelevant[i] ?? []);
  }
  return sum / n;
}

/** Macro-averaged ranking metrics over an eval query set. */
export interface RankingMetrics {
  /** Mean recall@1 across queries. */
  recallAt1: number;
  /** Mean recall@3 across queries. */
  recallAt3: number;
  /** Mean recall@5 across queries. */
  recallAt5: number;
  /** Mean reciprocal rank across queries. */
  mrr: number;
}

/**
 * Run a ranking function over each fixture query and macro-average recall@1/3/5
 * and MRR.
 *
 * `rankFn` maps a query's `candidates` to a ranked `MemorySearchResult[]`; this
 * scorer extracts the ranked ids via `entry.id` and compares them against the
 * query's `relevantIds`. An empty query set yields all-zero metrics.
 */
export function scoreRanking(
  queries: EvalQuery[],
  rankFn: (q: EvalQuery) => MemorySearchResult[],
): RankingMetrics {
  const n = queries.length;
  if (n === 0) return { recallAt1: 0, recallAt3: 0, recallAt5: 0, mrr: 0 };

  const perQueryRanked: string[][] = [];
  const perQueryRelevant: string[][] = [];
  let r1 = 0;
  let r3 = 0;
  let r5 = 0;

  for (const q of queries) {
    const rankedIds = rankFn(q).map((r) => r.entry.id);
    perQueryRanked.push(rankedIds);
    perQueryRelevant.push(q.relevantIds);
    r1 += recallAtK(rankedIds, q.relevantIds, 1);
    r3 += recallAtK(rankedIds, q.relevantIds, 3);
    r5 += recallAtK(rankedIds, q.relevantIds, 5);
  }

  return {
    recallAt1: r1 / n,
    recallAt3: r3 / n,
    recallAt5: r5 / n,
    mrr: meanReciprocalRank(perQueryRanked, perQueryRelevant),
  };
}

/** The reranked-vs-baseline lift report — the measurable-gain figure. */
export interface LiftReport {
  /** Metrics for the baseline ranker (fusion-only). */
  baseline: RankingMetrics;
  /** Metrics for the reranked ranker (cross-encoder ordering). */
  reranked: RankingMetrics;
  /** reranked.recallAt1 − baseline.recallAt1 (positive = recall gain, 0 = no regression). */
  recallAt1Lift: number;
  /** reranked.mrr − baseline.mrr. */
  mrrLift: number;
}

/**
 * Score a baseline ranker and a reranked ranker over the same query set and
 * report the recall@1 / MRR lift of reranked over baseline.
 *
 * The baseline ranker is the one the CALLER passes as `baselineFn` (typically
 * the fusion-only order via `fuse([{ results: candidates, weight: 1 }])` in the
 * harness); `rerankedFn` is the cross-encoder ordering. A positive
 * `recallAt1Lift` is the measurable gain; a zero lift means reranking
 * did not regress recall on the labeled set.
 */
export function compareRankings(
  queries: EvalQuery[],
  baselineFn: (q: EvalQuery) => MemorySearchResult[],
  rerankedFn: (q: EvalQuery) => MemorySearchResult[],
): LiftReport {
  const baseline = scoreRanking(queries, baselineFn);
  const reranked = scoreRanking(queries, rerankedFn);
  return {
    baseline,
    reranked,
    recallAt1Lift: reranked.recallAt1 - baseline.recallAt1,
    mrrLift: reranked.mrr - baseline.mrr,
  };
}
