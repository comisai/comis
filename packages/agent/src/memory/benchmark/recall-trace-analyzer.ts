// SPDX-License-Identifier: Apache-2.0
/**
 * PURE read-only fold over the recall-trace JSONL the CLI discarded.
 * Records are ALREADY sanitized on disk at write time
 * (runtime.ts:224-233 / memory-handlers.ts:542-543) — this analyzer does NOT
 * re-sanitize and MUST NOT echo the optional sanitized snippet / raw memory
 * bodies; it reads id + numeric breakdown + closed-union reason only.
 *
 * THE GAP THIS CLOSES: the recall pipeline WRITES a rich per-recall record on
 * every recall (lanes fired, fused order, rerank pre/post scores, the final
 * ranked set with per-memory score breakdowns + include/exclude reasons), but
 * the CLI table view reads only `traceId/sessionKey/finalCount/ts`
 * (memory.ts:276-285) — everything else is "captured-but-unread".
 * This analyzer is the missing reducer: it folds the
 * discarded `ranked[].breakdown`, `rerank.pre/postScores`, `ranked[].reason`,
 * `lanes`, and `degradations` into a `TraceQualityView` — the diagnostic
 * dashboard a future recall@k regression is read against.
 *
 * ARCHITECTURAL CUT (architecture-graph.test.ts:133 — agent depends on
 * {shared,core,observability,scheduler}, NO memory edge): this file imports ONLY
 * the observability package (RecallTraceEventSchema, a VALUE import for
 * `.safeParse`, + the RecallTraceEvent type) + the Node stdlib. It MUST NEVER
 * import the SQLite-backed memory package. The agent↛observability edge is allowed.
 *
 * SECURITY (V5 input validation + Information-Disclosure mitigation): every line
 * passes `RecallTraceEventSchema.safeParse`; lines failing the strict schema
 * (sentinel write-failure markers, foreign JSONL from another stream) and
 * malformed non-JSON lines are SKIPPED, not folded (the daemon precedent,
 * memory-handlers.ts:560-567). The fold is O(lines × ranked) with no nested
 * unbounded loops and no regex on the line text (no ReDoS). The degradation
 * accumulator is indexed ONLY by the Zod-validated closed-enum `kind` and uses a
 * null-prototype object (no prototype-chain write). Every division is guarded
 * (/0 → 0, never NaN — mirrors recallAtK's zero-guard, recall-eval.ts:46).
 *
 * @module
 */

import { RecallTraceEventSchema, type RecallTraceEvent } from "@comis/observability";

/**
 * The offline quality view: numeric aggregates + closed-union kind counts only.
 * No bodies, no previews — see the file-level Information-Disclosure note.
 */
export interface TraceQualityView {
  /** Number of valid recall records folded (malformed/foreign lines excluded). */
  recalls: number;
  /** Count of recalls whose rerank `outcome` was `ran`. */
  rerankRan: number;
  /** Count of recalls whose rerank `outcome` was `fell_back`. */
  rerankFellBack: number;
  /** Count of recalls whose rerank `outcome` was `timed_out`. */
  rerankTimedOut: number;
  /**
   * Fraction of `ran` recalls where the rerank actually moved something — the
   * post-score descending order differs from the pre-score descending order.
   * `liftRealizedCount / rerankRan`; `0` when `rerankRan === 0` (never NaN).
   */
  rerankLiftRealized: number;
  /** Mean over recalls of (`trust_filtered` ranked count / total ranked); 0-ranked recalls contribute 0. */
  trustFilteredRate: number;
  /** Mean over recalls of (`deduped` ranked count / total ranked); 0-ranked recalls contribute 0. */
  dedupedRate: number;
  /**
   * Per-factor distributions gathered from every `included` ranked entry that
   * carries a `breakdown` (entries without a breakdown contribute nothing).
   */
  scoreFactorDist: {
    recency: number[];
    temporal: number[];
    proof: number[];
    trust: number[];
    /** Usefulness factor values from every included entry carrying a breakdown. */
    usefulness: number[];
  };
  /** Summed per-lane candidate counts across all recalls. */
  laneTotals: { fts: number; vector: number; entity: number; temporal: number; causal: number };
  /** Count of recalls with `vectorLaneActive === false` (FTS-only / vec-unavailable). */
  vectorLaneInactiveCount: number;
  /** Tally of `degradations[].kind` occurrences across recalls (null-prototype map). */
  degradationCounts: Record<string, number>;
}

/**
 * Returns true iff the DESCENDING-score index order of `post` differs from that
 * of `pre` — i.e. the rerank permuted the candidates. Pure + total.
 *
 * Ties are broken by original index ascending in BOTH argsorts, so equal scores
 * preserve their relative position and never spuriously register as "differs".
 * Unequal lengths return `true` to keep this a sound TOTAL function in isolation.
 * NOTE: the analyzer's lift-realized path does NOT rely on that branch —
 * it pre-guards equal, non-empty lengths before calling here, so a malformed
 * trace with mismatched lengths is never counted as a realized rerank lift.
 */
export function argsortDiffers(pre: number[], post: number[]): boolean {
  if (pre.length !== post.length) return true;
  const order = (scores: number[]): number[] =>
    scores
      .map((score, index) => ({ score, index }))
      .sort((a, b) => (b.score - a.score !== 0 ? b.score - a.score : a.index - b.index))
      .map((entry) => entry.index);
  const preOrder = order(pre);
  const postOrder = order(post);
  for (let i = 0; i < preOrder.length; i++) {
    if (preOrder[i] !== postOrder[i]) return true;
  }
  return false;
}

/**
 * Fold recall-trace JSONL text into a {@link TraceQualityView}. Pure: takes
 * the JSONL as a STRING (a file-reading wrapper is a separate concern, handled
 * via `resolveRecallTraceFilePath`), so it is trivially unit-testable on a fixture.
 *
 * Uses the daemon's exact line-skip loop (memory-handlers.ts:560-567): split on
 * "\n", skip empty lines, `try JSON.parse / catch continue` (malformed), then
 * `RecallTraceEventSchema.safeParse` with `if (!parsed.success) continue`
 * (foreign/sentinel lines fail the strict schema → skipped).
 */
export function analyzeRecallTrace(jsonlContent: string): TraceQualityView {
  let recalls = 0;
  let rerankRan = 0;
  let rerankFellBack = 0;
  let rerankTimedOut = 0;
  let liftRealizedCount = 0;
  let trustFilteredRateSum = 0;
  let dedupedRateSum = 0;
  const recency: number[] = [];
  const temporal: number[] = [];
  const proof: number[] = [];
  const trust: number[] = [];
  const usefulness: number[] = [];
  let laneFts = 0;
  let laneVector = 0;
  let laneEntity = 0;
  let laneTemporal = 0;
  let laneCausal = 0;
  let vectorLaneInactiveCount = 0;
  // Null-prototype accumulator: only the Zod-validated closed-enum `kind` is
  // ever used as a key (no untrusted/prototype-chain write).
  const degradationCounts: Record<string, number> = Object.create(null) as Record<string, number>;

  for (const line of jsonlContent.split("\n")) {
    if (!line) continue;
    let rec: Record<string, unknown>;
    try {
      rec = JSON.parse(line) as Record<string, unknown>;
    } catch {
      // Skip malformed JSONL lines per standard JSONL convention.
      continue;
    }
    const parsed = RecallTraceEventSchema.safeParse(rec);
    // Foreign/sentinel lines (e.g. recall_trace.write_failures markers) fail the
    // strict schema (the `traceSchema`/`schemaVersion` literals fence it) → skip.
    if (!parsed.success) continue;
    const event: RecallTraceEvent = parsed.data;
    recalls++;

    // --- rerank outcome counters + lift-realized ---------------------------
    switch (event.rerank.outcome) {
      case "ran": {
        rerankRan++;
        // Attribute realized lift ONLY when both score arrays are present,
        // non-empty, AND equal-length. The schema makes preScores /
        // postScores independently optional with no cross-field length
        // invariant, so a malformed external trace could emit mismatched/empty
        // lengths; argsortDiffers reports a length mismatch as "differs" (a
        // sound TOTAL function in isolation — its own test documents that), but
        // a mismatch is malformed input, not an OBSERVED reordering. Counting it
        // would inflate rerankLiftRealized, a headline quality signal later
        // phases are scored against — so exclude it from the numerator.
        const { preScores, postScores } = event.rerank;
        if (
          preScores !== undefined &&
          postScores !== undefined &&
          preScores.length === postScores.length &&
          preScores.length > 0 &&
          argsortDiffers(preScores, postScores)
        ) {
          liftRealizedCount++;
        }
        break;
      }
      case "fell_back":
        rerankFellBack++;
        break;
      case "timed_out":
        rerankTimedOut++;
        break;
    }

    // --- per-recall trust-filtered / deduped rates -------------------------
    const totalRanked = event.ranked.length;
    let trustFilteredCount = 0;
    let dedupedCount = 0;
    for (const entry of event.ranked) {
      if (entry.reason === "trust_filtered") trustFilteredCount++;
      else if (entry.reason === "deduped") dedupedCount++;
      // Score-factor distributions: only included entries that carry a numeric
      // breakdown. id + numeric breakdown only — never the optional snippet.
      if (entry.reason === "included" && entry.breakdown !== undefined) {
        recency.push(entry.breakdown.recency);
        temporal.push(entry.breakdown.temporal);
        proof.push(entry.breakdown.proof);
        trust.push(entry.breakdown.trust);
        usefulness.push(entry.breakdown.usefulness);
      }
    }
    // Guard the division: a 0-ranked recall contributes 0, never NaN.
    if (totalRanked > 0) {
      trustFilteredRateSum += trustFilteredCount / totalRanked;
      dedupedRateSum += dedupedCount / totalRanked;
    }

    // --- lanes + vector-lane-inactive --------------------------------------
    laneFts += event.lanes.fts;
    laneVector += event.lanes.vector;
    laneEntity += event.lanes.entity;
    laneTemporal += event.lanes.temporal;
    // causal is an APPEND-ONLY optional lane field on the recall-trace event
    // schema, so a pre-causal-lane trace (or an off-lane recall) omits it -> coalesce to 0.
    laneCausal += event.lanes.causal ?? 0;
    if (!event.vectorLaneActive) vectorLaneInactiveCount++;

    // --- degradation kinds -------------------------------------------------
    if (event.degradations !== undefined) {
      for (const degradation of event.degradations) {
        const kind = degradation.kind;
        degradationCounts[kind] = (degradationCounts[kind] ?? 0) + 1;
      }
    }
  }

  return {
    recalls,
    rerankRan,
    rerankFellBack,
    rerankTimedOut,
    // Guard the division: 0 ran recalls -> 0, never NaN.
    rerankLiftRealized: rerankRan > 0 ? liftRealizedCount / rerankRan : 0,
    // Guard the division: 0 recalls -> 0, never NaN.
    trustFilteredRate: recalls > 0 ? trustFilteredRateSum / recalls : 0,
    dedupedRate: recalls > 0 ? dedupedRateSum / recalls : 0,
    scoreFactorDist: { recency, temporal, proof, trust, usefulness },
    laneTotals: { fts: laneFts, vector: laneVector, entity: laneEntity, temporal: laneTemporal, causal: laneCausal },
    vectorLaneInactiveCount,
    // Spread into a plain object so the returned value has a normal prototype
    // for consumers/serializers while the accumulator stayed null-proto.
    degradationCounts: { ...degradationCounts },
  };
}
