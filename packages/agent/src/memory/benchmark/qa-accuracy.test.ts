// SPDX-License-Identifier: Apache-2.0
/**
 * RED->GREEN unit suite for {@link aggregateAccuracy} (BENCH-03) -- the overall
 * + per-category accuracy aggregator with the LOAD-BEARING invalid-excluded
 * denominator.
 *
 * UNGATED, default-CI: pure deterministic reduction (no LLM, no I/O); imports
 * `qa-accuracy.ts` so it is never a 0%-coverage file under the agent all:true
 * floor.
 *
 * THE LOAD-BEARING INVARIANT (PATTERNS Correction #1, verified vs Hindsight
 * benchmark_runner.py:840-866): accuracy = correct / (total - invalid) * 100 for
 * BOTH overall and per-category. An INVALID verdict is EXCLUDED from the
 * denominator -- it is NOT counted as wrong. Test 2 below is the apples-to-apples
 * integrity proof: 1 correct + 1 invalid yields 100, never 50.
 *
 * ARCHITECTURE: imports only the in-package pure module -- no @comis/memory.
 */

import { describe, it, expect } from "vitest";
import { aggregateAccuracy } from "./qa-accuracy.js";

describe("aggregateAccuracy -- overall + per-category, invalid-excluded denominator (BENCH-03)", () => {
  it("Test 1: 1 correct + 1 wrong (no invalid) -> overall 50, perCategory.a {1,2,0,50}, validTotal 2", () => {
    const r = aggregateAccuracy([
      { category: "a", correct: true, invalid: false },
      { category: "a", correct: false, invalid: false },
    ]);
    expect(r.overall).toBe(50);
    expect(r.correct).toBe(1);
    expect(r.total).toBe(2);
    expect(r.invalid).toBe(0);
    expect(r.validTotal).toBe(2);
    expect(r.perCategory.a).toEqual({ correct: 1, total: 2, invalid: 0, accuracy: 50 });
  });

  it("Test 2 (LOAD-BEARING): 1 correct + 1 invalid -> overall 100, NOT 50; perCategory.a {1,2,1,100}, validTotal 1", () => {
    const r = aggregateAccuracy([
      { category: "a", correct: true, invalid: false },
      { category: "a", correct: false, invalid: true },
    ]);
    // 1 correct / (2 total - 1 invalid) = 100. The invalid verdict is EXCLUDED from
    // the denominator -- it is NOT a wrong answer.
    expect(r.overall).toBe(100);
    expect(r.correct).toBe(1);
    expect(r.total).toBe(2);
    expect(r.invalid).toBe(1);
    expect(r.validTotal).toBe(1);
    expect(r.perCategory.a).toEqual({ correct: 1, total: 2, invalid: 1, accuracy: 100 });
  });

  it("Test 3 (empty set): overall 0, total 0, invalid 0, validTotal 0, perCategory {} -- never NaN", () => {
    const r = aggregateAccuracy([]);
    expect(r.overall).toBe(0);
    expect(r.correct).toBe(0);
    expect(r.total).toBe(0);
    expect(r.invalid).toBe(0);
    expect(r.validTotal).toBe(0);
    expect(r.perCategory).toEqual({});
    expect(Number.isNaN(r.overall)).toBe(false);
  });

  it("Test 4 (all-invalid category): every verdict invalid -> accuracy 0 (validTotal 0 guard), never NaN", () => {
    const r = aggregateAccuracy([
      { category: "x", correct: false, invalid: true },
      { category: "x", correct: true, invalid: true },
    ]);
    expect(r.perCategory.x).toEqual({ correct: 0, total: 2, invalid: 2, accuracy: 0 });
    expect(Number.isNaN(r.perCategory.x?.accuracy)).toBe(false);
    expect(r.overall).toBe(0);
    expect(r.validTotal).toBe(0);
    expect(r.correct).toBe(0);
  });

  it("Test 5 (multi-category): categories aggregate independently; overall uses the global total - invalid", () => {
    const r = aggregateAccuracy([
      { category: "a", correct: true, invalid: false }, // a: valid correct
      { category: "a", correct: false, invalid: true }, // a: invalid (excluded)
      { category: "b", correct: true, invalid: false }, // b: valid correct
      { category: "b", correct: false, invalid: false }, // b: valid wrong
    ]);
    // a: 1 / (2 - 1) = 100 ; b: 1 / (2 - 0) = 50
    expect(r.perCategory.a).toEqual({ correct: 1, total: 2, invalid: 1, accuracy: 100 });
    expect(r.perCategory.b).toEqual({ correct: 1, total: 2, invalid: 0, accuracy: 50 });
    // overall: total 4, invalid 1 -> validTotal 3, correct 2 -> 2/3*100
    expect(r.total).toBe(4);
    expect(r.invalid).toBe(1);
    expect(r.validTotal).toBe(3);
    expect(r.correct).toBe(2);
    expect(r.overall).toBeCloseTo((2 / 3) * 100, 10);
  });

  it("Test 6 (prototype-pollution): a category '__proto__' does not pollute Object.prototype and is keyed safely", () => {
    const r = aggregateAccuracy([
      { category: "__proto__", correct: true, invalid: false },
      { category: "constructor", correct: false, invalid: false },
    ]);
    // No pollution of the global prototype.
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.prototype).not.toHaveProperty("correct");
    // The dangerous keys are recorded as own, enumerable data properties on a
    // null-prototype-derived plain object, not as a prototype mutation.
    expect(Object.prototype.hasOwnProperty.call(r.perCategory, "__proto__")).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(r.perCategory, "constructor")).toBe(true);
    const proto = r.perCategory["__proto__"];
    expect(proto).toEqual({ correct: 1, total: 1, invalid: 0, accuracy: 100 });
    expect(r.overall).toBe(50); // 1 correct / (2 total - 0 invalid)
  });

  it("counts invalid verdicts as invalid regardless of their correct flag", () => {
    // An invalid verdict with correct:true must NOT add to the numerator.
    const r = aggregateAccuracy([
      { category: "a", correct: true, invalid: true },
      { category: "a", correct: true, invalid: false },
    ]);
    expect(r.correct).toBe(1); // only the valid one counts
    expect(r.invalid).toBe(1);
    expect(r.validTotal).toBe(1);
    expect(r.overall).toBe(100);
    expect(r.perCategory.a).toEqual({ correct: 1, total: 2, invalid: 1, accuracy: 100 });
  });
});
