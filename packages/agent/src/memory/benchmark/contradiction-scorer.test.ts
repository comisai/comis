// SPDX-License-Identifier: Apache-2.0
/**
 * Unit test for the pure trust-first contradiction-correctness scorer. RED first:
 * pins the trust-first-correct rate = correct /
 * validTotal * 100, where `correct` means "answered with the OLDER high-trust
 * fact" (NOT the newer low-trust claim). Invalid verdicts are excluded from the
 * denominator (the qa-accuracy doctrine).
 *
 * This is the metric the KG gate consumes — freeze it.
 */

import { describe, expect, it } from "vitest";

import { scoreContradiction } from "./contradiction-scorer.js";
import type { CategorizedVerdict } from "./qa-accuracy.js";

function v(category: string, correct: boolean, invalid = false): CategorizedVerdict {
  return { category, correct, invalid };
}

describe("scoreContradiction", () => {
  it("returns 0 trust-first-correct rate (never NaN) for empty verdicts", () => {
    const score = scoreContradiction([]);
    expect(score.trustFirstCorrectRate).toBe(0);
    expect(score.total).toBe(0);
    expect(score.invalid).toBe(0);
    expect(score.validTotal).toBe(0);
  });

  it("reports 100 when trust-first always won (every answer was the older high-trust fact)", () => {
    const score = scoreContradiction([
      v("trust-first-contradiction", true),
      v("trust-first-contradiction", true),
    ]);
    expect(score.trustFirstCorrectRate).toBe(100);
    expect(score.total).toBe(2);
    expect(score.validTotal).toBe(2);
  });

  it("reports 0 when the newer low-trust claim always wrongly won (the failure KG must fix)", () => {
    const score = scoreContradiction([
      v("trust-first-contradiction", false),
      v("trust-first-contradiction", false),
    ]);
    expect(score.trustFirstCorrectRate).toBe(0);
    expect(score.validTotal).toBe(2);
  });

  it("excludes invalid verdicts from the trust-first denominator", () => {
    const score = scoreContradiction([
      v("trust-first-contradiction", true),
      v("trust-first-contradiction", false),
      v("trust-first-contradiction", false, true),
    ]);
    // validTotal = 2 (1 trust-first-correct, 1 lost) → rate 50.
    expect(score.trustFirstCorrectRate).toBe(50);
    expect(score.total).toBe(3);
    expect(score.invalid).toBe(1);
    expect(score.validTotal).toBe(2);
  });

  it("breaks down the trust-first-correct rate per probe type (a __proto__ key stays safe)", () => {
    const score = scoreContradiction([
      v("home-city", true),
      v("home-city", false),
      v("diet", true),
      v("__proto__", false),
    ]);
    expect(score.perProbeType["home-city"]?.trustFirstCorrectRate).toBe(50);
    expect(score.perProbeType["diet"]?.trustFirstCorrectRate).toBe(100);
    expect(score.perProbeType["__proto__"]?.trustFirstCorrectRate).toBe(0);
    // Prototype-pollution safety: the malicious category did not mutate the proto.
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    // Overall rate folds all valid probes: 2 correct / 4 valid = 50.
    expect(score.trustFirstCorrectRate).toBe(50);
  });
});
