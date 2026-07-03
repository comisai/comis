// SPDX-License-Identifier: Apache-2.0
/**
 * RED→GREEN unit test for the pure learning-lift rank scorer. Pins the
 * first→last rank-delta math a gated FEED-loop harness
 * drives over the SHIPPED recall-outcome
 * loop. Mirrors the recall-eval.test.ts pure-math discipline.
 *
 * ARCHITECTURE: imports only the in-package pure module — no @comis/memory.
 */
import { describe, it, expect } from "vitest";

import { scoreLearningLift, type LearningLiftScore } from "./learning-lift-scorer.js";

describe("scoreLearningLift", () => {
  it("returns the full per-episode shape with first/last ranks and the first→last lift", () => {
    // Gold doc seen at rank 3 then rank 1: lift = firstRank - lastRank = 3 - 1 = 2.
    const score: LearningLiftScore = scoreLearningLift([3, 2, 1]);
    expect(score.episodes).toBe(3);
    expect(score.firstRank).toBe(3);
    expect(score.lastRank).toBe(1);
    expect(score.rankLift).toBe(2);
    expect(score.ranks).toEqual([3, 2, 1]);
  });

  it("reports a positive rankLift of 3 for a monotonically-improving [3,2,1,0]", () => {
    const score = scoreLearningLift([3, 2, 1, 0]);
    expect(score.rankLift).toBe(3);
    expect(score.firstRank).toBe(3);
    expect(score.lastRank).toBe(0);
  });

  it("reports a flat rankLift of 0 for an unchanging [2,2,2]", () => {
    const score = scoreLearningLift([2, 2, 2]);
    expect(score.rankLift).toBe(0);
    expect(score.firstRank).toBe(2);
    expect(score.lastRank).toBe(2);
  });

  it("reports a negative rankLift of -2 for a regressing [0,1,2] (got worse)", () => {
    const score = scoreLearningLift([0, 1, 2]);
    expect(score.rankLift).toBe(-2);
    expect(score.firstRank).toBe(0);
    expect(score.lastRank).toBe(2);
  });

  it("returns a zeroed, never-NaN result for empty input", () => {
    const score = scoreLearningLift([]);
    expect(score).toEqual({
      episodes: 0,
      firstRank: null,
      lastRank: null,
      rankLift: 0,
      ranks: [],
    });
    expect(Number.isNaN(score.rankLift)).toBe(false);
  });

  it("normalizes an absent (undefined) rank to null in `ranks` and uses the sentinel for the lift", () => {
    // Gold recalled (rank 4) on episode 1, then NOT recalled on the last episode.
    // The default sentinel (1000) is the worst-case rank for the absent last episode:
    // lift = firstRank(4) - lastRank-sentinel(1000) = -996 (a big regression).
    const score = scoreLearningLift([4, undefined]);
    expect(score.ranks).toEqual([4, null]);
    expect(score.firstRank).toBe(4);
    expect(score.lastRank).toBeNull();
    expect(score.rankLift).toBe(4 - 1000);
  });

  it("rewards moving IN from absent: undefined first episode, recalled last, with a caller sentinel", () => {
    // Gold NOT recalled on episode 1, then rank 0 on the last — a big improvement.
    // Caller passes the candidate-pool size (10) as the sentinel for the absent first.
    const score = scoreLearningLift([undefined, 0], 10);
    expect(score.ranks).toEqual([null, 0]);
    expect(score.firstRank).toBeNull();
    expect(score.lastRank).toBe(0);
    // lift = firstRank-sentinel(10) - lastRank(0) = 10 (moved in from the worst rank).
    expect(score.rankLift).toBe(10);
  });

  it("treats a single episode as zero lift (first === last)", () => {
    const score = scoreLearningLift([2]);
    expect(score.episodes).toBe(1);
    expect(score.firstRank).toBe(2);
    expect(score.lastRank).toBe(2);
    expect(score.rankLift).toBe(0);
  });
});
