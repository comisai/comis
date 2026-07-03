// SPDX-License-Identifier: Apache-2.0
/**
 * RED->GREEN unit suite for {@link compareToBaseline} -- the pure per-category
 * regression-vs-baseline verdict that backs the SCHEDULED CI regression gate
 * (`.github/workflows/bench-regression.yml`).
 *
 * WHY THIS MODULE EXISTS: the per-release gate needs a TESTED, reproducible
 * comparison of a CURRENT run's per-category
 * accuracy against the committed J1 baseline
 * (`benchmarks/results/2026-05-31-j1-baseline/qa-report.judge-a.json`). A category
 * "regresses" ONLY when the current accuracy is BELOW baseline beyond a tolerance
 * AND the drop is statistically significant -- so per-category n=20 noise (the
 * ~±11pt binomial SE the j1-baseline rationale documents) is never mistaken for a
 * real regression. This reuses {@link twoProportionTest} from significance.ts (no
 * new statistical test) and the `CategoryAccuracy` count shape from
 * qa-accuracy.ts.
 *
 * UNGATED, default-CI: pure deterministic math (no LLM, no I/O, no clock, no env);
 * imports `regression-gate.ts` so it is never a 0%-coverage file under the agent
 * all:true floor.
 *
 * THE SIGNIFICANCE GUARD (the whole point): a 6pt drop at n=20 is NOT a regression
 * (small-N noise -> not significant); a 19pt drop at n=100 IS. Test 3/4 pin both
 * directions. A bare-threshold gate (drop > tolerance, no significance) would
 * red-light on noise; this one does not.
 *
 * SECURITY -- structural secret omission + prototype-pollution discipline (the
 * cross-judge-spread.ts / qa-accuracy.ts doctrine): the verdict may be embedded in
 * a manifest written via writeRegularFile, OUTSIDE Pino's redaction net, so the
 * fold must (1) NEVER spread an input map value -- every output field rebuilt from
 * numeric scalars + a copied primitive category string, and (2) build its
 * intermediate over a null-prototype map so a `__proto__`/`constructor` category
 * key is an inert own data property. Test 7/8 are those gates.
 *
 * ARCHITECTURE: imports only the in-package pure modules (significance.ts +
 * qa-accuracy.ts types) -- no @comis/memory (architecture-graph.test.ts:133 -- the
 * agent->memory cut).
 */

import { describe, it, expect } from "vitest";
import {
  compareToBaseline,
  REGRESSION_TOLERANCE_PTS,
  type RegressionVerdict,
  type CategoryRegression,
} from "./regression-gate.js";
import type { CategoryAccuracy } from "./qa-accuracy.js";

/** Build a `CategoryAccuracy` from raw counts (accuracy = correct/validTotal — the qa-accuracy rule). */
function cat(correct: number, total: number, invalid = 0): CategoryAccuracy {
  const validTotal = total - invalid;
  return {
    correct,
    total,
    invalid,
    accuracy: validTotal > 0 ? (correct / validTotal) * 100 : 0,
  };
}

describe("compareToBaseline -- per-category regression verdict vs the committed baseline", () => {
  it("Test 1: an identical run never regresses (every category byte-equal -> deltaPts 0, regressed false)", () => {
    const baseline: Record<string, CategoryAccuracy> = {
      "temporal-reasoning": cat(9, 20),
      "knowledge-update": cat(15, 20),
    };
    const current: Record<string, CategoryAccuracy> = {
      "temporal-reasoning": cat(9, 20),
      "knowledge-update": cat(15, 20),
    };
    const v = compareToBaseline(current, baseline);
    expect(v.regressed).toBe(false);
    expect(v.perCategory).toHaveLength(2);
    for (const c of v.perCategory) {
      expect(c.deltaPts).toBeCloseTo(0, 6);
      expect(c.regressed).toBe(false);
    }
  });

  it("Test 2: an IMPROVEMENT never counts as a regression (current well above baseline)", () => {
    const baseline: Record<string, CategoryAccuracy> = { "multi-session": cat(50, 100) };
    const current: Record<string, CategoryAccuracy> = { "multi-session": cat(80, 100) };
    const v = compareToBaseline(current, baseline);
    const c = v.perCategory.find((x) => x.category === "multi-session");
    expect(c?.deltaPts).toBeCloseTo(30, 6);
    expect(c?.regressed).toBe(false);
    expect(v.regressed).toBe(false);
  });

  it("Test 3 (THE GUARD): a SIGNIFICANT large drop at n=100 (71->52) IS a regression", () => {
    const baseline: Record<string, CategoryAccuracy> = { overall: cat(71, 100) };
    const current: Record<string, CategoryAccuracy> = { overall: cat(52, 100) };
    const v = compareToBaseline(current, baseline);
    const c = v.perCategory.find((x) => x.category === "overall");
    expect(c?.baseline).toBeCloseTo(71, 6);
    expect(c?.current).toBeCloseTo(52, 6);
    expect(c?.deltaPts).toBeCloseTo(-19, 6);
    expect(c?.significant).toBe(true); // 19pt @ n=100 -> p<0.05
    expect(c?.regressed).toBe(true);
    expect(v.regressed).toBe(true);
  });

  it("Test 4 (THE GUARD): a comparable drop at small n=20 (14->12, ~10pt) is NOT a regression (n=20 noise)", () => {
    const baseline: Record<string, CategoryAccuracy> = { "multi-session": cat(14, 20) };
    const current: Record<string, CategoryAccuracy> = { "multi-session": cat(12, 20) };
    const v = compareToBaseline(current, baseline);
    const c = v.perCategory.find((x) => x.category === "multi-session");
    expect(c?.deltaPts).toBeLessThan(0); // a real drop in points...
    expect(c?.significant).toBe(false); // ...but NOT statistically significant at n=20
    expect(c?.regressed).toBe(false); // so the gate does NOT red-light on noise
    expect(v.regressed).toBe(false);
  });

  it("Test 5: a tiny drop WITHIN tolerance is never a regression even if significant at huge N", () => {
    // 2pt drop at n=10000 is statistically significant, but it is within the
    // REGRESSION_TOLERANCE_PTS band -> NOT a regression (tolerance gates first).
    expect(REGRESSION_TOLERANCE_PTS).toBeGreaterThan(2);
    const baseline: Record<string, CategoryAccuracy> = { overall: cat(7100, 10000) };
    const current: Record<string, CategoryAccuracy> = { overall: cat(6900, 10000) };
    const v = compareToBaseline(current, baseline);
    const c = v.perCategory.find((x) => x.category === "overall");
    expect(c?.deltaPts).toBeCloseTo(-2, 6);
    expect(c?.significant).toBe(true); // 2pt @ n=10000 IS significant
    expect(c?.regressed).toBe(false); // but within tolerance -> not a regression
    expect(v.regressed).toBe(false);
  });

  it("Test 6: a category PRESENT in baseline but ABSENT in current regresses (a dropped category = a real loss)", () => {
    const baseline: Record<string, CategoryAccuracy> = {
      "temporal-reasoning": cat(18, 20), // 90% baseline, a strong category
    };
    const current: Record<string, CategoryAccuracy> = {}; // the category vanished
    const v = compareToBaseline(current, baseline);
    const c = v.perCategory.find((x) => x.category === "temporal-reasoning");
    expect(c).toBeDefined();
    expect(c?.baseline).toBeCloseTo(90, 6);
    expect(c?.current).toBe(0); // absent -> 0
    expect(c?.deltaPts).toBeCloseTo(-90, 6);
    expect(c?.significant).toBe(true); // 90->0 over n=20 vs n=20 is significant
    expect(c?.regressed).toBe(true);
    expect(v.regressed).toBe(true);
  });

  it("Test 7 (SECRET-OMISSION GATE): a secret-shaped key/value on an input map never reaches JSON.stringify", () => {
    // Hang secret-shaped fields on the baseline map. A real CategoryAccuracy is an
    // object with numeric `accuracy`; a secret-shaped STRING value is non-numeric.
    // The fold copies only NUMERICALLY-COERCED scalars and DROPS any entry whose
    // accuracy is non-finite, so neither the secret string nor the secret-shaped
    // KEY can reach the serialized verdict.
    const baseline = { "temporal-reasoning": cat(9, 20) } as Record<string, CategoryAccuracy>;
    (baseline as unknown as Record<string, unknown>).apiKey = "sk-SHOULD-NOT-APPEAR";
    (baseline as unknown as Record<string, unknown>).base_url =
      "https://evil.example/v1?token=Bearer-SHOULD-NOT-APPEAR";
    const current: Record<string, CategoryAccuracy> = { "temporal-reasoning": cat(9, 20) };
    const v = compareToBaseline(current, baseline);
    const json = JSON.stringify(v);
    expect(json).not.toMatch(/apiKey|sk-|Bearer|base_url/);
    // Only the legitimate numeric category survived.
    expect(v.perCategory).toHaveLength(1);
    expect(v.perCategory[0].category).toBe("temporal-reasoning");
  });

  it("Test 8 (prototype-pollution): a '__proto__' category key is an inert own data property, never a prototype mutation", () => {
    const baseline: Record<string, CategoryAccuracy> = Object.create(null) as Record<
      string,
      CategoryAccuracy
    >;
    baseline["__proto__"] = cat(10, 20);
    baseline["constructor"] = cat(8, 20);
    const current: Record<string, CategoryAccuracy> = Object.create(null) as Record<
      string,
      CategoryAccuracy
    >;
    current["__proto__"] = cat(10, 20);
    current["constructor"] = cat(8, 20);
    const v = compareToBaseline(current, baseline);
    // Object.prototype was not mutated.
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.prototype).not.toHaveProperty("category");
    // The dangerous keys are handled as ordinary categories in the output array.
    const proto = v.perCategory.find((c) => c.category === "__proto__");
    expect(proto).toBeDefined();
    expect(proto?.regressed).toBe(false);
  });

  it("Test 9 (NEVER-NaN): a degenerate baseline category (total 0) never NaNs and never spuriously regresses", () => {
    const baseline: Record<string, CategoryAccuracy> = { empty: cat(0, 0) }; // 0/0 -> accuracy 0
    const current: Record<string, CategoryAccuracy> = { empty: cat(0, 0) };
    const v = compareToBaseline(current, baseline);
    const c = v.perCategory.find((x) => x.category === "empty");
    expect(c).toBeDefined();
    expect(Number.isNaN(c?.deltaPts ?? NaN)).toBe(false);
    expect(c?.significant).toBe(false); // zero-denominator -> twoProportionTest returns not-significant
    expect(c?.regressed).toBe(false);
    expect(v.regressed).toBe(false);
  });

  it("Test 10: the verdict carries an honest secret-free summary string naming any regressed category", () => {
    const baseline: Record<string, CategoryAccuracy> = {
      overall: cat(71, 100),
      "knowledge-update": cat(75, 100),
    };
    const current: Record<string, CategoryAccuracy> = {
      overall: cat(52, 100), // regresses (19pt, significant)
      "knowledge-update": cat(75, 100), // unchanged
    };
    const v = compareToBaseline(current, baseline);
    expect(v.regressed).toBe(true);
    expect(typeof v.summary).toBe("string");
    expect(v.summary).toContain("overall"); // names the regressed category
    expect(v.summary).not.toMatch(/apiKey|sk-|Bearer/);
  });

  it("Test 11: the tolerance is a parameter -- a tighter tolerance can flip a significant-but-small drop to a regression", () => {
    // 4pt drop at n=10000 is significant. Default tolerance (>2) absorbs it; a
    // 0.5pt tolerance does not -> the same drop becomes a regression.
    const baseline: Record<string, CategoryAccuracy> = { overall: cat(7100, 10000) };
    const current: Record<string, CategoryAccuracy> = { overall: cat(6700, 10000) }; // -4pt
    const lenient = compareToBaseline(current, baseline); // default tolerance
    expect(lenient.perCategory[0].regressed).toBe(false);
    const strict = compareToBaseline(current, baseline, 0.5);
    expect(strict.perCategory[0].deltaPts).toBeCloseTo(-4, 6);
    expect(strict.perCategory[0].regressed).toBe(true);
    expect(strict.regressed).toBe(true);
  });

  it("exposes the REGRESSION_TOLERANCE_PTS constant as a documented positive default", () => {
    expect(REGRESSION_TOLERANCE_PTS).toBeGreaterThan(0);
  });

  it("returns a fresh array of fresh objects -- mutating an input map does not change a prior verdict", () => {
    const baseline = { overall: cat(71, 100) };
    const current = { overall: cat(71, 100) };
    const v: RegressionVerdict = compareToBaseline(current, baseline);
    baseline.overall = cat(0, 100);
    current.overall = cat(100, 100);
    const c = v.perCategory.find((x) => x.category === "overall") as CategoryRegression;
    expect(c.baseline).toBeCloseTo(71, 6);
    expect(c.current).toBeCloseTo(71, 6);
  });
});
