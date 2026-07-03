// SPDX-License-Identifier: Apache-2.0
/**
 * Pure recall-outcome learning-lift rank scorer.
 *
 * THE METRIC: given the gold doc's 0-based rank in the recalled, ranked list on
 * each FEED episode (lower = better; `undefined` = the gold was not recalled at
 * all that episode), measure how far the gold doc's rank IMPROVED from the first
 * episode to the last. This is the leapfrog Hindsight structurally cannot follow
 * (its `access_count` is dead schema): over N episodes of the SAME query, recording
 * the gold doc as "used" should raise its rank (within the bounded
 * `usefulnessAlpha` in score.ts) — a positive `rankLift` is that learning.
 *
 * rankLift = firstRank − lastRank  (POSITIVE = the gold moved UP the list = the
 * FEED loop helped; negative = it got worse; 0 = unchanged). An `undefined` rank
 * is normalized to `null` in the per-episode `ranks` output and treated as a
 * worst-case `absentSentinel` for the lift arithmetic — the caller passes the
 * candidate-pool size so "not recalled" ranks strictly worse than any real rank
 * (the gated harness passes `scenario.docs.length`); the module default is a fixed
 * large constant {@link DEFAULT_ABSENT_SENTINEL} so a unit caller need not supply one.
 *
 * PURE: NO clock, NO I/O, NO @comis/memory import — mirrors recall-eval.ts. A
 * gated harness feeds it the per-episode gold
 * ranks from the live recall pipeline; the unit test pins the math.
 *
 * @module
 */

/**
 * The worst-case rank used for an episode where the gold doc was NOT recalled, when
 * the caller does not pass one. The harness passes the candidate-pool size
 * (`scenario.docs.length`) so an absent gold ranks strictly worse than any present
 * rank; this fixed fallback keeps the pure unit math total without a pool size.
 */
export const DEFAULT_ABSENT_SENTINEL = 1000;

/** The first→last learning-lift result over a sequence of per-episode gold ranks. */
export interface LearningLiftScore {
  /** Number of episodes scored (= `ranksPerEpisode.length`). */
  readonly episodes: number;
  /** The gold doc's 0-based rank on the FIRST episode; `null` if it was absent. */
  readonly firstRank: number | null;
  /** The gold doc's 0-based rank on the LAST episode; `null` if it was absent. */
  readonly lastRank: number | null;
  /**
   * `firstRank − lastRank`, using {@link DEFAULT_ABSENT_SENTINEL} (or the caller's
   * `absentSentinel`) for an absent first/last rank. POSITIVE = the gold moved up
   * (the FEED loop helped). `0` for empty input (never NaN).
   */
  readonly rankLift: number;
  /** Per-episode gold ranks, with `undefined` normalized to `null`. */
  readonly ranks: ReadonlyArray<number | null>;
}

/**
 * Score the first→last rank lift over a sequence of per-episode gold ranks.
 *
 * @param ranksPerEpisode - each entry is the gold doc's 0-based rank that episode,
 *   or `undefined` if it was not recalled.
 * @param absentSentinel - the worst-case rank substituted for an absent first/last
 *   rank in the lift arithmetic (the harness passes the candidate-pool size);
 *   defaults to {@link DEFAULT_ABSENT_SENTINEL}.
 */
export function scoreLearningLift(
  ranksPerEpisode: ReadonlyArray<number | undefined>,
  absentSentinel: number = DEFAULT_ABSENT_SENTINEL,
): LearningLiftScore {
  const episodes = ranksPerEpisode.length;
  // Normalize undefined → null for the reported per-episode ranks.
  const ranks: Array<number | null> = ranksPerEpisode.map((r) => (r === undefined ? null : r));

  if (episodes === 0) {
    return { episodes: 0, firstRank: null, lastRank: null, rankLift: 0, ranks: [] };
  }

  const firstRank = ranks[0] ?? null;
  const lastRank = ranks[episodes - 1] ?? null;
  // Substitute the worst-case sentinel for an absent (null) endpoint so "not
  // recalled" counts as the worst rank in the delta (never produces NaN).
  const firstForLift = firstRank ?? absentSentinel;
  const lastForLift = lastRank ?? absentSentinel;

  return {
    episodes,
    firstRank,
    lastRank,
    rankLift: firstForLift - lastForLift,
    ranks,
  };
}
