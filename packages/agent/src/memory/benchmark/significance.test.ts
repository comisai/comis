// SPDX-License-Identifier: Apache-2.0
/**
 * RED->GREEN unit suite for {@link wilsonInterval} + {@link twoProportionTest}
 * -- the N + statistical-significance layer every published number must carry.
 *
 * WHY THIS MODULE EXISTS: the believability requirement
 * that every headline number
 * report N + a significance flag. No prior statistical test exists in the repo
 * (only `accuracyOf`, a plain fold). This is the only genuinely net-new
 * algorithm here: a Wilson 95% confidence interval for a single accuracy
 * + a two-proportion z-test for an A-vs-B delta, over integer {correct, total}
 * counts.
 *
 * UNGATED, default-CI: pure deterministic math (no LLM, no I/O, no clock, no
 * env); imports `significance.ts` so it is never a 0%-coverage file under the
 * agent all:true floor.
 *
 * KNOWN-VALUE CHECKS (qa-accuracy.test.ts style): the Wilson bounds at n=100,
 * p=0.5 are the textbook (0.404, 0.596); the two-proportion test flips
 * significant true->false between n=100 and n=20 for a comparable gap (the
 * j1-baseline "n=20 -> ~+-11pt SE" rationale -- a 19pt gap is significant at
 * n=100, a ~6pt gap is noise at n=20).
 *
 * NEVER-NaN GUARDS: n=0 -> all-zero CI; a zero denominator / zero
 * pooled SE -> pValue 1, significant false -- a degenerate count can never
 * silently produce a fabricated-looking "significant" or a NaN that reads as a
 * missing number.
 *
 * ARCHITECTURE: imports only the in-package pure module -- no @comis/memory
 * (architecture-graph.test.ts:133 -- the agent->memory cut).
 */

import { describe, it, expect } from "vitest";
import {
  wilsonInterval,
  twoProportionTest,
  type AccuracyCI,
  type ProportionTest,
} from "./significance.js";

describe("wilsonInterval -- Wilson 95% CI over integer {correct,total} counts", () => {
  it("Test 1: the empty set (0,0) yields all-zero, never NaN (the empty-set guard)", () => {
    const ci = wilsonInterval(0, 0);
    expect(ci).toEqual<AccuracyCI>({ n: 0, pHat: 0, lo: 0, hi: 0 });
    expect(Number.isNaN(ci.lo)).toBe(false);
    expect(Number.isNaN(ci.hi)).toBe(false);
  });

  it("Test 2: (50,100) -> pHat 0.5 with the textbook Wilson bounds ~0.404 / ~0.596 (z=1.96)", () => {
    const ci = wilsonInterval(50, 100);
    expect(ci.n).toBe(100);
    expect(ci.pHat).toBeCloseTo(0.5, 10);
    expect(ci.lo).toBeCloseTo(0.404, 2); // 0.4038315...
    expect(ci.hi).toBeCloseTo(0.596, 2); // 0.5961684...
    // symmetry about 0.5 for p=0.5
    expect(ci.lo + ci.hi).toBeCloseTo(1, 6);
  });

  it("Test 3: all-correct (20,20) -> pHat 1.0 with hi clamped to <=1.0 and lo strictly below 1.0", () => {
    const ci = wilsonInterval(20, 20);
    expect(ci.pHat).toBe(1);
    expect(ci.hi).toBe(1); // clamped, never above 1.0
    expect(ci.lo).toBeLessThan(1);
    expect(ci.lo).toBeGreaterThan(0);
    expect(ci.lo).toBeCloseTo(0.839, 2); // 0.8388748...
  });

  it("Test 4: all-wrong (0,10) -> pHat 0 with lo clamped to >=0 and hi strictly above 0", () => {
    const ci = wilsonInterval(0, 10);
    expect(ci.pHat).toBe(0);
    expect(ci.lo).toBe(0); // clamped, never below 0
    expect(ci.hi).toBeGreaterThan(0);
    expect(ci.hi).toBeCloseTo(0.278, 2); // 0.2775327...
    expect(Number.isNaN(ci.hi)).toBe(false);
  });
});

describe("twoProportionTest -- two-proportion z-test reporting N + significance", () => {
  it("Test 5: a 19pt gap at n=100 (71/100 vs 52/100) is significant at p<0.05", () => {
    const r = twoProportionTest({ correct: 71, total: 100 }, { correct: 52, total: 100 });
    expect(r.n).toBe(200);
    expect(r.pValue).toBeLessThan(0.05);
    expect(r.pValue).toBeCloseTo(0.0058, 3);
    expect(r.significant).toBe(true);
  });

  it("Test 6: a comparable gap at small N (14/20 vs 13/20, ~71 vs 65) is NOT significant (n=20 noise)", () => {
    const r = twoProportionTest({ correct: 14, total: 20 }, { correct: 13, total: 20 });
    expect(r.n).toBe(40);
    expect(r.pValue).toBeGreaterThan(0.05);
    expect(r.significant).toBe(false); // the j1-baseline "n=20 -> ~+-11pt SE" rationale
  });

  it("Test 7: the SAME proportion in both arms is never significant (z=0 -> pValue ~1)", () => {
    const r = twoProportionTest({ correct: 50, total: 100 }, { correct: 50, total: 100 });
    expect(r.significant).toBe(false);
    expect(r.pValue).toBeCloseTo(1, 6);
    expect(Number.isNaN(r.pValue)).toBe(false);
  });

  it("Test 8 (NEVER-NaN GUARD): a zero denominator yields pValue 1, significant false (no divide-by-zero)", () => {
    const r = twoProportionTest({ correct: 0, total: 0 }, { correct: 5, total: 10 });
    expect(r).toEqual<ProportionTest>({ n: 10, pValue: 1, significant: false });
    expect(Number.isNaN(r.pValue)).toBe(false);
  });

  it("Test 9 (NEVER-NaN GUARD): both arms all-correct (pooled p=1 -> zero SE) yields pValue 1, not significant", () => {
    const r = twoProportionTest({ correct: 10, total: 10 }, { correct: 10, total: 10 });
    expect(r.n).toBe(20);
    expect(r.pValue).toBe(1);
    expect(r.significant).toBe(false);
    expect(Number.isNaN(r.pValue)).toBe(false);
  });

  it("never spreads its input -- a secret-shaped extra field on a count arg cannot reach the output", () => {
    const a = { correct: 71, total: 100, apiKey: "sk-SHOULD-NOT-APPEAR" } as unknown as {
      correct: number;
      total: number;
    };
    const r = twoProportionTest(a, { correct: 52, total: 100 });
    expect(JSON.stringify(r)).not.toMatch(/apiKey|sk-|Bearer/);
    expect(r.significant).toBe(true);
  });
});
