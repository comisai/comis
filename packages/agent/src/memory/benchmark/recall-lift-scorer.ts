/**
 * Recall-outcome rank-lift scorer — Tier-3 memory suite benchmark (SUITE-03).
 *
 * Pure business logic: given a before-ranking and an after-ranking of memory ids (and the
 * target memory id whose rank we track), compute how much the target moved up after the
 * FEED recall-outcome loop reinforced it. Positive lift = the learning loop works.
 *
 * No live store, no cross-package import: this is the genuine, fully-tested metric the gated
 * harness drives. (The @comis/agent ↛ @comis/memory cut means the harness cannot import the
 * live UsefulnessLedger; it models the same EWMA loop in-harness — see the harness file.)
 */

export interface RankLiftInput {
  /** Ranking of memory ids before the FEED loop (index 0 = best). */
  readonly before: readonly string[];
  /** Ranking of memory ids after the FEED loop (index 0 = best). */
  readonly after: readonly string[];
  /** The memory id whose rank-lift we measure. */
  readonly targetId: string;
}

export interface RankLiftResult {
  /** 1-based rank of `targetId` in `before` (Infinity if absent). Lower = better. */
  readonly rankBefore: number;
  /** 1-based rank of `targetId` in `after` (Infinity if absent). Lower = better. */
  readonly rankAfter: number;
  /** `rankBefore - rankAfter`. Positive = moved up = improved. 0 if absent from both. */
  readonly lift: number;
  /** `lift > 0`. */
  readonly improved: boolean;
}

/** 1-based rank of `id` in `ranking` using the FIRST occurrence; Infinity if absent. */
function rankOf(ranking: readonly string[], id: string): number {
  const idx = ranking.indexOf(id);
  return idx === -1 ? Infinity : idx + 1;
}

/**
 * Compute rank-lift for `targetId` between a before- and after-ranking.
 *
 * Edge handling:
 * - absent from a ranking → that rank is `Infinity` (not found ranks worst).
 * - absent from BOTH → `lift = 0`, `improved = false` (avoids `Infinity - Infinity = NaN`).
 * - empty rankings → both ranks `Infinity` → same both-absent path.
 */
export function computeRankLift(input: RankLiftInput): RankLiftResult {
  const rankBefore = rankOf(input.before, input.targetId);
  const rankAfter = rankOf(input.after, input.targetId);
  // Guard the NaN case: Infinity - Infinity is NaN, so short-circuit both-absent to 0.
  const lift =
    rankBefore === Infinity && rankAfter === Infinity ? 0 : rankBefore - rankAfter;
  return { rankBefore, rankAfter, lift, improved: lift > 0 };
}

export interface LiftAggregate {
  /** Mean of `lift` across results (0 for empty input). */
  readonly meanLift: number;
  /** Fraction of results with `improved === true` (0 for empty input). */
  readonly improvedRate: number;
  /** Number of results aggregated. */
  readonly n: number;
}

/**
 * Aggregate rank-lift results: mean lift + improved-rate + count. Zeroed (no NaN) on empty input.
 */
export function aggregateLift(results: readonly RankLiftResult[]): LiftAggregate {
  const n = results.length;
  if (n === 0) return { meanLift: 0, improvedRate: 0, n: 0 };
  const sumLift = results.reduce((acc, r) => acc + r.lift, 0);
  const improvedCount = results.reduce((acc, r) => acc + (r.improved ? 1 : 0), 0);
  return { meanLift: sumLift / n, improvedRate: improvedCount / n, n };
}
