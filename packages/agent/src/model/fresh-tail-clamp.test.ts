// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { resolveClampedFreshTailTurns } from "./fresh-tail-clamp.js";

describe("resolveClampedFreshTailTurns", () => {
  // ---------------------------------------------------------------------------
  // EFF-02-A-1: Infinity effectiveWindow (frontier/mid) → configuredTurns unchanged
  // ---------------------------------------------------------------------------

  it("EFF-02-A-1a: Infinity window, 8 configured → 8 (frontier byte-identical)", () => {
    expect(resolveClampedFreshTailTurns(Infinity, 8)).toBe(8);
  });

  it("EFF-02-A-1b: Infinity window, 50 configured → 50 (frontier byte-identical)", () => {
    expect(resolveClampedFreshTailTurns(Infinity, 50)).toBe(50);
  });

  // ---------------------------------------------------------------------------
  // EFF-02-A-2: Large effectiveWindow (frontier-range, finite) → clamp never fires
  // For 131072 + 8 steps, must pass avgTokensPerStep explicitly so the test is pinned.
  // budget=floor(131072*0.3)=39321, affordable=floor(39321/500)=78 → min(8,78)=8
  // ---------------------------------------------------------------------------

  it("EFF-02-A-2: large window (131072), 8 configured, 500 avg → 8 (clamp never fires)", () => {
    expect(resolveClampedFreshTailTurns(131072, 8, 500)).toBe(8);
  });

  // ---------------------------------------------------------------------------
  // EFF-02-A-3: Small window — clamp fires
  // 16000: budget=floor(16000*0.3)=4800, affordable=floor(4800/1000)=4 → min(8,4)=4
  //  8000: budget=floor(8000*0.3)=2400, affordable=floor(2400/1000)=2 → min(8,2)=2
  // ---------------------------------------------------------------------------

  it("EFF-02-A-3a: small window (16000), 8 configured, 1000 avg → 4 (clamped)", () => {
    expect(resolveClampedFreshTailTurns(16000, 8, 1000)).toBe(4);
  });

  it("EFF-02-A-3b: small window (8000), 8 configured, 1000 avg → 2 (clamped)", () => {
    expect(resolveClampedFreshTailTurns(8000, 8, 1000)).toBe(2);
  });

  // ---------------------------------------------------------------------------
  // EFF-02-A-4: Always returns at least 1 (even if extremely tight window)
  // budget=floor(1000*0.3)=300, affordable=floor(300/99999)=0 → max(1,0)=1
  // ---------------------------------------------------------------------------

  it("EFF-02-A-4: floor ≥ 1 even when window is extremely tight (budget/avgTok = 0)", () => {
    expect(resolveClampedFreshTailTurns(1000, 8, 99999)).toBe(1);
  });

  // ---------------------------------------------------------------------------
  // EFF-02-A-5: configuredTurns of 1 → always 1 regardless of window
  // min(1, affordable) = 1 (affordable ≥ 1 always)
  // ---------------------------------------------------------------------------

  it("EFF-02-A-5: configured=1 → always 1 regardless of window size", () => {
    expect(resolveClampedFreshTailTurns(8000, 1, 500)).toBe(1);
  });

  // ---------------------------------------------------------------------------
  // EFF-02-A-6: Default avgTokensPerStep estimation (no explicit value)
  // frontier still byte-identical even with auto-estimate
  // Small window smoke test: must not throw, result ≤ configured
  // ---------------------------------------------------------------------------

  it("EFF-02-A-6a: Infinity window, no avgTokensPerStep → configuredTurns unchanged (auto-estimate)", () => {
    expect(resolveClampedFreshTailTurns(Infinity, 8)).toBe(8);
  });

  it("EFF-02-A-6b: small window (16000), 30 configured, no avgTokensPerStep → ≤ 30 (smoke: no throw)", () => {
    const result = resolveClampedFreshTailTurns(16000, 30);
    expect(result).toBeGreaterThanOrEqual(1);
    expect(result).toBeLessThanOrEqual(30);
  });
});
