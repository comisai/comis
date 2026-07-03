// SPDX-License-Identifier: Apache-2.0
/**
 * Stage-A unit tests for stats.ts — statistical gating module.
 *
 * Pure math tests: no filesystem, no network, no real provider calls.
 * Must run with COMIS_LIVE unset (additive test tooling).
 *
 * Note on Clopper-Pearson CI expectations: for small N=3, exact CI bounds
 * are counter-intuitive. 3/3 lower bound ~0.292 (not > 0.5) and 0/3 upper
 * bound ~0.708 (not < 0.5) — both correct given the small sample size.
 * The tests verify the statistically correct bounds, which for such a small
 * sample differ from the intuitive expectation for this well-defined function.
 */
import { describe, it, expect } from "vitest";
import {
  computePassRate,
  computeBinomialCI,
  compareToBaseline,
  buildScenarioModelGrid,
} from "./stats.js";

describe("computePassRate", () => {
  it("returns { rate: 1.0, n: 3 } for all-pass results", () => {
    const result = computePassRate([true, true, true]);
    expect(result.rate).toBe(1.0);
    expect(result.n).toBe(3);
  });

  it("returns { rate: ~0.333, n: 3 } for one-out-of-three passes", () => {
    const result = computePassRate([true, false, false]);
    expect(result.n).toBe(3);
    expect(result.rate).toBeCloseTo(1 / 3, 5);
  });

  it("returns { rate: 0, n: 0 } for empty results", () => {
    const result = computePassRate([]);
    expect(result.rate).toBe(0);
    expect(result.n).toBe(0);
  });
});

describe("computeBinomialCI", () => {
  it("returns [lo, 1.0] with lo > 0 for 3 successes out of 3 (Clopper-Pearson all-pass)", () => {
    const [lo, hi] = computeBinomialCI(3, 3, 0.95);
    // Clopper-Pearson for k=3/n=3: upper=1.0 (all-pass edge case); lower~0.292.
    // Even a perfect run of 3 leaves downward uncertainty to ~29% true rate.
    expect(hi).toBe(1.0);
    expect(lo).toBeGreaterThan(0);
    expect(lo).toBeLessThan(hi);
  });

  it("returns [0, hi] with hi < 1 for 0 successes out of 3 (Clopper-Pearson all-fail)", () => {
    const [lo, hi] = computeBinomialCI(0, 3, 0.95);
    // Clopper-Pearson for k=0/n=3: lower=0 (all-fail edge case); upper~0.708.
    // Even zero successes in 3 cannot rule out true rates up to ~71%.
    expect(lo).toBe(0);
    expect(hi).toBeLessThan(1.0);
    expect(lo).toBeLessThan(hi);
  });

  it("CI bounds are monotone: more successes yield a strictly higher lower bound", () => {
    const [lo0] = computeBinomialCI(0, 3, 0.95);
    const [lo3] = computeBinomialCI(3, 3, 0.95);
    expect(lo0).toBeLessThan(lo3);
  });
});

describe("compareToBaseline", () => {
  it("returns { passed: false } when current rate is below baseline minus tolerance (regression)", () => {
    // current 80%, baseline 90%, tolerance 5% — delta = -10%, exceeds tolerance
    const result = compareToBaseline(
      { rate: 0.80, n: 3 },
      { rate: 0.90, n: 10 },
      0.05,
      0.05,
    );
    expect(result.passed).toBe(false);
    expect(result.current).toBe(0.80);
    expect(result.baseline).toBe(0.90);
    expect(result.delta).toBeCloseTo(-0.10, 5);
  });

  it("returns { passed: true } when current rate is at or above baseline minus tolerance (no regression)", () => {
    // current 95%, baseline 90%, tolerance 5% — delta = +5%, no regression
    const result = compareToBaseline(
      { rate: 0.95, n: 3 },
      { rate: 0.90, n: 10 },
      0.05,
      0.05,
    );
    expect(result.passed).toBe(true);
    expect(result.current).toBe(0.95);
    expect(result.baseline).toBe(0.90);
    expect(result.delta).toBeCloseTo(0.05, 5);
  });
});

describe("buildScenarioModelGrid", () => {
  it("groups run results into a 2D object keyed by scenarioId x model", () => {
    const rows = [
      { scenarioId: "s1", model: "claude", passed: true },
      { scenarioId: "s1", model: "gpt", passed: false },
    ];
    const grid = buildScenarioModelGrid(rows);

    expect(grid).toHaveProperty("s1");
    expect(grid["s1"]).toHaveProperty("claude");
    expect(grid["s1"]).toHaveProperty("gpt");
    expect(grid["s1"]!["claude"]).toEqual({ passed: 1, failed: 0 });
    expect(grid["s1"]!["gpt"]).toEqual({ passed: 0, failed: 1 });
  });
});
