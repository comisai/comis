// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for `estimateSavings` — the pure counterfactual token-savings
 * estimator. RED-first (TDD): fails at suite-load on pre-patch code (the module
 * does not exist) and goes green once `savings-estimate.ts` ships.
 *
 * The estimator is a labeled ESTIMATE (the ~4-bytes-per-token proxy,
 * materialized-only, post-bounce actual) — these cases pin the tolerance shape,
 * the divide-by-zero guard, the never-negative clamp, and the total/pure
 * contract.
 *
 * @module
 */
import { describe, it, expect } from "vitest";
import { estimateSavings } from "./savings-estimate.js";

describe("estimateSavings", () => {
  it("estimates saved tokens for three 40 KB fetches summarized to 2 KB", () => {
    // 120 KB materialized (3 × 40 KB over-threshold returns), 2 KB re-entered.
    const out = estimateSavings(120 * 1024, 2 * 1024);

    expect(out.wouldBeTokens).toBe(Math.round((120 * 1024) / 4)); // 30720
    expect(out.actualTokens).toBe(Math.round((2 * 1024) / 4)); // 512

    // estSavedTokens ≈ (120 KB − 2 KB) / 4 = 30208, within a small rounding tolerance.
    const expectedSaved = (120 * 1024 - 2 * 1024) / 4; // 30208
    expect(Math.abs(out.estSavedTokens - expectedSaved)).toBeLessThanOrEqual(4);

    expect(out.savedRatio).toBeCloseTo(30208 / 30720, 3); // ≈ 0.983
  });

  it("returns zero saved and a guarded ratio when nothing was materialized", () => {
    const out = estimateSavings(0, 5000);

    expect(out.wouldBeTokens).toBe(0);
    expect(out.actualTokens).toBe(Math.round(5000 / 4)); // 1250
    expect(out.estSavedTokens).toBe(0); // max(0, ·)
    expect(out.savedRatio).toBe(0); // divide-by-zero guard on wouldBeTokens = 0
  });

  it("never reports negative savings when re-entry exceeds the materialized bytes", () => {
    const out = estimateSavings(1000, 4000);

    expect(out.wouldBeTokens).toBe(250);
    expect(out.actualTokens).toBe(1000);
    expect(out.estSavedTokens).toBe(0); // clamped at zero, never negative
    expect(out.savedRatio).toBe(0);
  });

  it("counts the full materialized bytes when no stdout re-entered context", () => {
    const out = estimateSavings(40 * 1024 * 3, 0);

    expect(out.wouldBeTokens).toBe(30720);
    expect(out.actualTokens).toBe(0);
    expect(out.estSavedTokens).toBe(Math.round((40 * 1024 * 3) / 4)); // 30720
    expect(out.savedRatio).toBe(1);
  });

  it("is total and deterministic — identical inputs yield identical output", () => {
    const a = estimateSavings(123456, 789);
    const b = estimateSavings(123456, 789);
    expect(a).toEqual(b);

    // A spread of finite non-negative inputs each produce a finite, non-negative
    // estimate with a bounded ratio in [0, 1].
    const cases: ReadonlyArray<readonly [number, number]> = [
      [0, 0],
      [1, 0],
      [15_000, 30_000],
      [8 * 1024 * 1024, 30_000],
    ];
    for (const [materializedBytes, stdoutCharsReentered] of cases) {
      const out = estimateSavings(materializedBytes, stdoutCharsReentered);
      expect(Number.isFinite(out.estSavedTokens)).toBe(true);
      expect(out.estSavedTokens).toBeGreaterThanOrEqual(0);
      expect(out.savedRatio).toBeGreaterThanOrEqual(0);
      expect(out.savedRatio).toBeLessThanOrEqual(1);
    }
  });
});
