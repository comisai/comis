import { describe, expect, it } from "vitest";

import { aggregateLift, computeRankLift } from "./recall-lift-scorer.js";

describe("computeRankLift", () => {
  it("computes 1-based ranks and positive lift when the target moves up", () => {
    // target "t" was 3rd, then became 1st -> lift = 3 - 1 = 2, improved.
    const r = computeRankLift({
      before: ["a", "b", "t"],
      after: ["t", "a", "b"],
      targetId: "t",
    });
    expect(r.rankBefore).toBe(3);
    expect(r.rankAfter).toBe(1);
    expect(r.lift).toBe(2);
    expect(r.improved).toBe(true);
  });

  it("reports a non-positive lift (not improved) when the target moves down", () => {
    // target "t" was 1st, then became 3rd -> lift = 1 - 3 = -2, not improved.
    const r = computeRankLift({
      before: ["t", "a", "b"],
      after: ["a", "b", "t"],
      targetId: "t",
    });
    expect(r.rankBefore).toBe(1);
    expect(r.rankAfter).toBe(3);
    expect(r.lift).toBe(-2);
    expect(r.improved).toBe(false);
  });

  it("treats an absent target as worst rank (Infinity)", () => {
    // Absent before, present (rank 1) after -> moved in from worst, big positive lift.
    const r = computeRankLift({
      before: ["a", "b"],
      after: ["t", "a", "b"],
      targetId: "t",
    });
    expect(r.rankBefore).toBe(Infinity);
    expect(r.rankAfter).toBe(1);
    expect(r.lift).toBe(Infinity);
    expect(r.improved).toBe(true);
  });

  it("yields lift 0 / not improved when the target is absent from BOTH rankings (no NaN)", () => {
    const r = computeRankLift({
      before: ["a", "b"],
      after: ["c", "d"],
      targetId: "t",
    });
    expect(r.rankBefore).toBe(Infinity);
    expect(r.rankAfter).toBe(Infinity);
    expect(r.lift).toBe(0);
    expect(Number.isNaN(r.lift)).toBe(false);
    expect(r.improved).toBe(false);
  });

  it("handles empty rankings: ranks Infinity, lift 0, not improved (no NaN)", () => {
    const r = computeRankLift({ before: [], after: [], targetId: "t" });
    expect(r.rankBefore).toBe(Infinity);
    expect(r.rankAfter).toBe(Infinity);
    expect(r.lift).toBe(0);
    expect(Number.isNaN(r.lift)).toBe(false);
    expect(r.improved).toBe(false);
  });

  it("uses the FIRST occurrence when the target appears more than once", () => {
    const r = computeRankLift({
      before: ["a", "t", "t"],
      after: ["t", "t", "a"],
      targetId: "t",
    });
    expect(r.rankBefore).toBe(2);
    expect(r.rankAfter).toBe(1);
    expect(r.lift).toBe(1);
    expect(r.improved).toBe(true);
  });
});

describe("aggregateLift", () => {
  it("returns zeroed aggregate for empty input (no NaN)", () => {
    const a = aggregateLift([]);
    expect(a.meanLift).toBe(0);
    expect(Number.isNaN(a.meanLift)).toBe(false);
    expect(a.improvedRate).toBe(0);
    expect(a.n).toBe(0);
  });

  it("computes meanLift, improvedRate, and n across results", () => {
    const a = aggregateLift([
      { rankBefore: 3, rankAfter: 1, lift: 2, improved: true },
      { rankBefore: 2, rankAfter: 2, lift: 0, improved: false },
      { rankBefore: 4, rankAfter: 2, lift: 2, improved: true },
      { rankBefore: 1, rankAfter: 3, lift: -2, improved: false },
    ]);
    // mean of [2, 0, 2, -2] = 0.5; improved 2/4 = 0.5; n = 4.
    expect(a.meanLift).toBe(0.5);
    expect(a.improvedRate).toBe(0.5);
    expect(a.n).toBe(4);
  });

  it("computes a full improvedRate of 1 when every result improved", () => {
    const a = aggregateLift([
      { rankBefore: 2, rankAfter: 1, lift: 1, improved: true },
      { rankBefore: 5, rankAfter: 3, lift: 2, improved: true },
    ]);
    expect(a.improvedRate).toBe(1);
    expect(a.meanLift).toBe(1.5);
    expect(a.n).toBe(2);
  });
});
