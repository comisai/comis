// SPDX-License-Identifier: Apache-2.0
/**
 * Pure per-ability BEAM recall@k scorer (SUITE-01, Plan 99-06, Task 2).
 *
 * THE METRIC: given the planted per-ability needles (each a `{ability, query,
 * goldDocId}`) and the LIVE ranked recall result per needle (keyed by the needle's
 * `query`), group the needles by ability and macro-average recall@1/3/5 + MRR PER
 * ABILITY (and once overall) — the long-context per-ability aggregation axis BEAM
 * exposes. A high per-ability recall@k is good; a low one shows where recall degrades
 * at scale for that ability class.
 *
 * REUSE, DON'T REIMPLEMENT (the cut-clean seam): recall@k / MRR are computed by
 * {@link scoreRanking} from `../recall-eval.js` — the SAME deterministic IR scorer
 * the retrieval harness uses. This module only GROUPS needles into per-ability
 * {@link EvalQuery} lists (each carrying `relevantIds = [goldDocId]`) and supplies a
 * sync `rankFn` closure reading the `rankedByNeedle` memo, exactly as
 * retrieval-harness.bench.test.ts scores recall.
 *
 * PURE: no clock, no I/O, no @comis/memory import — mirrors recall-eval.ts. The gated
 * harness (beam-harness.bench.test.ts) feeds it the per-needle ranked results from the
 * live recall pipeline; the unit test pins the math.
 *
 * SECURITY — prototype-pollution discipline (sibling of qa-accuracy.ts): although the
 * ability keys are a fixed string-literal union, the `perAbility` map is materialized
 * on an `Object.create(null)` map with literal-keyed writes, so even an unexpected key
 * can never mutate `Object.prototype`.
 *
 * @module
 */

import { scoreRanking, type RankingMetrics } from "../recall-eval.js";
import type { EvalQuery } from "../__fixtures__/recall-eval-fixtures.js";
import type { MemorySearchResult } from "@comis/core";
import type { BeamAbility, BeamNeedle } from "./beam-generator.js";

/** The per-ability + overall BEAM recall@k result. */
export interface BeamScore {
  /**
   * Per-ability recall@k / MRR, keyed by {@link BeamAbility}. A null-prototype map
   * (no inherited `Object.prototype` members). Only abilities present in `needles`
   * appear; an empty `needles` yields an empty map.
   */
  perAbility: Record<BeamAbility, RankingMetrics>;
  /** Recall@k / MRR macro-averaged over ALL needles (every ability folded together). */
  overall: RankingMetrics;
}

/**
 * Build the {@link EvalQuery} list for a set of needles, with a `rankFn`-readable
 * memo: each needle becomes one EvalQuery whose `relevantIds = [goldDocId]` and whose
 * `query` is the memo key the rankFn reads. `group` is a fixed valid tag —
 * `scoreRanking` ignores it (it reads only `relevantIds` + the rankFn result).
 */
function toEvalQueries(needles: ReadonlyArray<BeamNeedle>): EvalQuery[] {
  return needles.map((n) => ({
    group: "reranking",
    query: n.query,
    candidates: [], // unused by scoreRanking — the rankFn supplies the ranked list
    relevantIds: [n.goldDocId],
  }));
}

/**
 * Score per-ability + overall recall@k over the planted needles.
 *
 * Groups `needles` by ability (on a null-prototype map), then for each ability calls
 * {@link scoreRanking} over that ability's {@link EvalQuery} list with a sync `rankFn`
 * that reads `rankedByNeedle.get(query)` (the live ranked result for that needle); the
 * overall metrics fold ALL needles. An empty `needles` yields an empty `perAbility`
 * and a zeroed (never-NaN) `overall` — `scoreRanking([])` returns all-zero metrics.
 *
 * PURE: no I/O, no @comis/memory. Reuses `scoreRanking` — does NOT reimplement recall@k.
 */
export function scoreBeam(
  needles: ReadonlyArray<BeamNeedle>,
  rankedByNeedle: ReadonlyMap<string, MemorySearchResult[]>,
): BeamScore {
  // The sync rankFn reads the live ranked result by the needle's query (the memo key).
  const rankFn = (q: EvalQuery): MemorySearchResult[] => rankedByNeedle.get(q.query) ?? [];

  // Group needles by ability on a null-prototype accumulator (prototype-pollution-safe
  // even though the ability keys are a fixed union).
  const byAbility: Record<string, BeamNeedle[]> = Object.create(null) as Record<
    string,
    BeamNeedle[]
  >;
  for (const n of needles) {
    // Literal-keyed write on the null-proto map — never a prototype mutation.
    (byAbility[n.ability] ??= []).push(n);
  }

  // Materialize per-ability metrics onto a fresh null-prototype map.
  const perAbility: Record<BeamAbility, RankingMetrics> = Object.create(null) as Record<
    BeamAbility,
    RankingMetrics
  >;
  for (const ability of Object.keys(byAbility)) {
    // `Object.keys` yields only present keys; the project does not set
    // noUncheckedIndexedAccess, so the indexed access is a defined BeamNeedle[].
    perAbility[ability as BeamAbility] = scoreRanking(toEvalQueries(byAbility[ability]), rankFn);
  }

  return {
    perAbility,
    overall: scoreRanking(toEvalQueries(needles), rankFn),
  };
}
