// SPDX-License-Identifier: Apache-2.0
/**
 * N-lane Reciprocal Rank Fusion.
 *
 * Generalizes the existing 2-lane `computeRRF` (packages/memory/src/hybrid-search.ts,
 * k=60, FTS weight 1.0 / vector weight 1.5) to an arbitrary number of candidate
 * lanes of {@link MemorySearchResult}, keyed by `entry.id`. The k=60 RRF formula
 * and the `(Σ weights)/(k+1)` normalization are PORTED here, NOT imported — the
 * agent-package production source must not import the memory package (forbidden by
 * architecture.test.ts "agent -> memory cut"; the memory package is a devDependency
 * only). Precedent for pure ranking math living in the agent package:
 * executor/tool-deferral.ts (inline BM25). This file imports only @comis/core types.
 *
 * Math (mirrors hybrid-search.ts:205-246, 309-322):
 *   score(d)  = Σ_lanes  weight_i / (k + rank_i)        k = 60, rank 1-based
 *   maxScore  = (Σ weights) / (k + 1)                   theoretical max (rank-1 in all lanes)
 *   normalized = min(1, score(d) / maxScore)            → (0, 1]
 *
 * With a SINGLE lane this is a PASS-THROUGH: the lane's incoming order is
 * preserved AND each result's incoming `score` is carried through unchanged. The
 * upstream adapter (SqliteMemoryAdapter.search) already returns RRF-normalized
 * relevance scores with a genuine distribution (a strong top hit vs. a weak tail);
 * recomputing a fresh score from array rank here would collapse that distribution to
 * a near-flat ramp (1.0/0.984/…) and flip the downstream inlineMinScore=0.7 gate on
 * the DEFAULT (rerank-off) path. So single-lane fusion is the identity on BOTH order
 * and score. Only the multi-lane case (the entity-lane seam) runs the RRF
 * rank math, where rebasing onto a common rank scale is exactly the point.
 *
 * @module
 */

import type { MemorySearchResult } from "@comis/core";

/** Standard RRF smoothing constant (mirrors computeRRF's internal k). */
const K = 60;

/** A single candidate lane: MemorySearchResult[] in descending relevance (rank 1 = first). */
export interface FusionLane {
  /** Lane results, most-relevant first. */
  results: MemorySearchResult[];
  /** RRF weight for this lane (e.g. FTS 1.0, vector 1.5). */
  weight: number;
}

interface FusionAccumulator {
  /** The MemorySearchResult kept from this entry's FIRST occurrence across lanes. */
  result: MemorySearchResult;
  /** Accumulated Σ weight/(k+rank) across every lane the entry appears in. */
  rrf: number;
  /** First-seen ordinal — a deterministic, lane-order-independent stable tie-break. */
  order: number;
}

/**
 * Fuse N candidate lanes via weighted Reciprocal Rank Fusion.
 *
 * Deduplicates by `entry.id` (an entry present in multiple lanes contributes its
 * per-lane term to a single accumulated score and appears once in the output).
 * Scores are normalized to `(0, 1]` and assigned onto `result.score`. Results are
 * sorted by descending fused score; equal scores fall back to first-seen order so
 * fusing the same lanes in a different lane order yields the same final ranking
 * (RRF is commutative over lanes).
 *
 * SINGLE-LANE PASS-THROUGH: with exactly one lane the upstream adapter score
 * is preserved verbatim (order and `score` both untouched) — see the module doc for
 * why rebuilding a rank-ramp score would regress the inline-injection gate.
 */
export function fuse(lanes: FusionLane[]): MemorySearchResult[] {
  // Single lane: pass the adapter's relevance score (and order) straight through.
  // Skip empty holes to match the multi-lane path's `result === undefined` guard.
  if (lanes.length === 1) {
    const only = lanes[0];
    if (only === undefined) return [];
    return only.results.filter((r): r is MemorySearchResult => r !== undefined);
  }

  const merged = new Map<string, FusionAccumulator>();
  let totalWeight = 0;
  let nextOrder = 0;

  for (const lane of lanes) {
    totalWeight += lane.weight;
    for (let i = 0; i < lane.results.length; i++) {
      const result = lane.results[i];
      if (result === undefined) continue;
      const rank = i + 1; // 1-based rank
      const term = lane.weight / (K + rank);
      const id = result.entry.id;
      const existing = merged.get(id);
      if (existing === undefined) {
        merged.set(id, { result, rrf: term, order: nextOrder++ });
      } else {
        // Same entry from another lane: sum the RRF contribution; keep the
        // first-seen result object and its first-seen order.
        existing.rrf += term;
      }
    }
  }

  if (merged.size === 0) return [];

  // Normalize by the theoretical maximum (rank-1 in every lane) and clamp to 1.0.
  const maxScore = totalWeight / (K + 1);

  const fused = Array.from(merged.values());
  fused.sort((a, b) => {
    if (b.rrf !== a.rrf) return b.rrf - a.rrf;
    return a.order - b.order; // deterministic, lane-order-independent tie-break
  });

  return fused.map((acc) => ({
    ...acc.result,
    score: maxScore > 0 ? Math.min(1, acc.rrf / maxScore) : 0,
  }));
}
