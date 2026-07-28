// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { resolveClampedFreshTailTurns } from "./fresh-tail-clamp.js";

describe("resolveClampedFreshTailTurns", () => {
  // ---------------------------------------------------------------------------
  // Infinity effectiveWindow (frontier/mid) → configuredTurns unchanged
  // ---------------------------------------------------------------------------

  it("Infinity window, 8 configured → 8 (frontier byte-identical)", () => {
    expect(resolveClampedFreshTailTurns(Infinity, 8)).toBe(8);
  });

  it("Infinity window, 50 configured → 50 (frontier byte-identical)", () => {
    expect(resolveClampedFreshTailTurns(Infinity, 50)).toBe(50);
  });

  // ---------------------------------------------------------------------------
  // Large effectiveWindow (frontier-range, finite) → clamp never fires
  // For 131072 + 8 steps, must pass avgTokensPerStep explicitly so the test is pinned.
  // budget=floor(131072*0.3)=39321, affordable=floor(39321/500)=78 → min(8,78)=8
  // ---------------------------------------------------------------------------

  it("large window (131072), 8 configured, 500 avg → 8 (clamp never fires)", () => {
    expect(resolveClampedFreshTailTurns(131072, 8, 500)).toBe(8);
  });

  // ---------------------------------------------------------------------------
  // Small window — clamp fires
  // 16000: budget=floor(16000*0.3)=4800, affordable=floor(4800/1000)=4 → min(8,4)=4
  //  8000: budget=floor(8000*0.3)=2400, affordable=floor(2400/1000)=2 → min(8,2)=2
  // ---------------------------------------------------------------------------

  it("small window (16000), 8 configured, 1000 avg → 4 (clamped)", () => {
    expect(resolveClampedFreshTailTurns(16000, 8, 1000)).toBe(4);
  });

  it("small window (8000), 8 configured, 1000 avg → 2 (clamped)", () => {
    expect(resolveClampedFreshTailTurns(8000, 8, 1000)).toBe(2);
  });

  // ---------------------------------------------------------------------------
  // Always returns at least 1 (even if extremely tight window)
  // budget=floor(1000*0.3)=300, affordable=floor(300/99999)=0 → max(1,0)=1
  // ---------------------------------------------------------------------------

  it("floor ≥ 1 even when window is extremely tight (budget/avgTok = 0)", () => {
    expect(resolveClampedFreshTailTurns(1000, 8, 99999)).toBe(1);
  });

  // ---------------------------------------------------------------------------
  // configuredTurns of 1 → always 1 regardless of window
  // min(1, affordable) = 1 (affordable ≥ 1 always)
  // ---------------------------------------------------------------------------

  it("configured=1 → always 1 regardless of window size", () => {
    expect(resolveClampedFreshTailTurns(8000, 1, 500)).toBe(1);
  });

  // ---------------------------------------------------------------------------
  // Default avgTokensPerStep estimation (no explicit value)
  // frontier still byte-identical even with auto-estimate
  // Small window smoke test: must not throw, result ≤ configured
  // ---------------------------------------------------------------------------

  it("Infinity window, no avgTokensPerStep → configuredTurns unchanged (auto-estimate)", () => {
    expect(resolveClampedFreshTailTurns(Infinity, 8)).toBe(8);
  });

  it("small window (16000), 30 configured, no avgTokensPerStep → ≤ 30 (smoke: no throw)", () => {
    const result = resolveClampedFreshTailTurns(16000, 30);
    expect(result).toBeGreaterThanOrEqual(1);
    expect(result).toBeLessThanOrEqual(30);
  });

  // ---------------------------------------------------------------------------
  // THE PRODUCTION PATH (comis-moshe 2026-07-26).
  //
  // Every test above pins the clamp with an EXPLICIT avgTokensPerStep — but
  // `lcd-assembler.ts` calls it with TWO arguments, so production always takes
  // the auto-estimate branch. That branch estimated a step at `W/20` — 5% of the
  // window — which SCALES WITH W, so the ratio 0.3W / (W/20) cancels and the
  // result was the constant 6 for EVERY finite window and EVERY configured
  // value. `contextEngine.freshTailTurns` (schema 1..50, default 8) was
  // therefore unreachable above 6 on every deployment.
  //
  // Live consequence: on a 1M-token window with 87,740 tokens in use (9%), a turn
  // with 4 background-tool cycles (8 steps) slid the user's ORIGINATING request out
  // of the verbatim tail — and the agent apologized to the user for work they had
  // explicitly requested. The two smoke tests above could not catch it: both
  // assertions (>=1, <=configured) hold for a constant 6.
  // ---------------------------------------------------------------------------

  it("does NOT clamp the DEFAULT 8 on a frontier 1M window (the live shape)", () => {
    expect(resolveClampedFreshTailTurns(1_000_000, 8)).toBe(8);
  });

  it("honors a RAISED freshTailTurns on a large window", () => {
    expect(resolveClampedFreshTailTurns(1_000_000, 20)).toBe(20);
    expect(resolveClampedFreshTailTurns(1_000_000, 50)).toBe(50);
  });

  it("does not clamp the default on the common 128K/200K windows", () => {
    expect(resolveClampedFreshTailTurns(128_000, 8)).toBe(8);
    expect(resolveClampedFreshTailTurns(200_000, 8)).toBe(8);
  });

  it("is NOT window-independent — a bigger window must afford at least as many steps", () => {
    // The bug's signature: the auto-estimate returned the SAME number for every
    // window. Monotonic non-decreasing in W is the invariant that kills it.
    const windows = [8_000, 32_000, 128_000, 200_000, 1_000_000, 2_000_000];
    const results = windows.map((w) => resolveClampedFreshTailTurns(w, 50));
    for (let i = 1; i < results.length; i += 1) {
      expect(results[i]!).toBeGreaterThanOrEqual(results[i - 1]!);
    }
    // …and it must actually VARY (a constant is monotonic too).
    expect(new Set(results).size).toBeGreaterThan(1);
  });

  it("STILL clamps on a genuinely small window (the clamp keeps its purpose)", () => {
    // A tiny window cannot let the verbatim tail eat it.
    expect(resolveClampedFreshTailTurns(4_096, 8)).toBeLessThan(8);
    expect(resolveClampedFreshTailTurns(4_096, 8)).toBeGreaterThanOrEqual(1);
    // …and it floors at 1, never 0.
    expect(resolveClampedFreshTailTurns(1_000, 8)).toBe(1);
  });

  it("is NON-REGRESSING at the smallest viable window: 8192 still yields the previous 6", () => {
    // The calibration constant is chosen so no existing deployment loses tail
    // steps — floor(0.3 * 8192 / 400) = 6, exactly what the buggy constant gave.
    expect(resolveClampedFreshTailTurns(8_192, 8)).toBe(6);
  });

  it("never returns FEWER steps than the pre-fix constant 6 at any viable window", () => {
    for (const w of [8_192, 16_000, 32_000, 128_000, 200_000, 1_000_000]) {
      expect(resolveClampedFreshTailTurns(w, 8)).toBeGreaterThanOrEqual(Math.min(8, 6));
    }
  });

  it("never exceeds the configured value, on any window", () => {
    for (const w of [1_000, 8_000, 32_000, 128_000, 1_000_000]) {
      for (const c of [1, 4, 8, 20, 50]) {
        expect(resolveClampedFreshTailTurns(w, c)).toBeLessThanOrEqual(c);
        expect(resolveClampedFreshTailTurns(w, c)).toBeGreaterThanOrEqual(1);
      }
    }
  });
});
