// SPDX-License-Identifier: Apache-2.0
/**
 * TDD RED → GREEN: output-headroom primitives (Fix 3 / Phase 166 CWF-02).
 *
 * Pure-function tests with arithmetic proof comments — no side effects, no I/O.
 * The characterization test pins the frontier/mid byte-identity invariant (WR-01 lesson:
 * always assert EXACT values, never merely "> 0").
 */
import { describe, it, expect } from "vitest";
import {
  computeOutputHeadroom,
  downshiftThinkingLevel,
} from "./output-headroom.js";
import { computeTokenBudgetForProfile } from "./budget-capacity-cap.js";
import { FAIL_CLOSED_PROFILE } from "../executor/model-profile.js";

// ---------------------------------------------------------------------------
// computeOutputHeadroom
// ---------------------------------------------------------------------------

describe("computeOutputHeadroom", () => {
  // reasoningStyle "none" → THINKING_RESERVE=0 for all levels, only MIN_VISIBLE_OUTPUT=768
  it('returns 768 for ("none", "off") — no thinking block', () => {
    // 0 + 768 = 768
    expect(computeOutputHeadroom("none", "off")).toBe(768);
  });

  it('returns 768 for ("none", "high") — reasoningStyle:none overrides level', () => {
    // THINKING_RESERVE[none][high] = 0; 0 + 768 = 768
    expect(computeOutputHeadroom("none", "high")).toBe(768);
  });

  it('returns 768 for ("none", "xhigh") — reasoningStyle:none overrides level', () => {
    // THINKING_RESERVE[none][xhigh] = 0; 0 + 768 = 768
    expect(computeOutputHeadroom("none", "xhigh")).toBe(768);
  });

  // reasoningStyle "native" off → same as none: thinking disabled
  it('returns 768 for ("native", "off") — thinking disabled', () => {
    // THINKING_RESERVE[native][off] = 0; 0 + 768 = 768
    expect(computeOutputHeadroom("native", "off")).toBe(768);
  });

  // native with active thinking levels
  it('returns 1280 for ("native", "minimal") — 512 + 768', () => {
    // THINKING_RESERVE[native][minimal] = 512; 512 + 768 = 1280
    expect(computeOutputHeadroom("native", "minimal")).toBe(1_280);
  });

  it('returns 1792 for ("native", "low") — 1024 + 768', () => {
    // THINKING_RESERVE[native][low] = 1024; 1024 + 768 = 1792
    expect(computeOutputHeadroom("native", "low")).toBe(1_792);
  });

  it('returns 3840 for ("native", "medium") — 3072 + 768', () => {
    // THINKING_RESERVE[native][medium] = 3072; 3072 + 768 = 3840
    expect(computeOutputHeadroom("native", "medium")).toBe(3_840);
  });

  it('returns 8960 for ("native", "high") — 8192 + 768', () => {
    // THINKING_RESERVE[native][high] = 8192 (NVDA incident sizing); 8192 + 768 = 8960
    expect(computeOutputHeadroom("native", "high")).toBe(8_960);
  });

  it('returns 13056 for ("native", "xhigh") — 12288 + 768', () => {
    // THINKING_RESERVE[native][xhigh] = 12288; 12288 + 768 = 13056
    expect(computeOutputHeadroom("native", "xhigh")).toBe(13_056);
  });

  it("native/high reserves strictly more headroom than none/high (8960 > 768)", () => {
    // Design invariant: a thinkingLevel:high profile MUST reserve strictly more than non-reasoning
    expect(computeOutputHeadroom("native", "high")).toBeGreaterThan(
      computeOutputHeadroom("none", "high"),
    );
    // Pin exact values (WR-01 lesson — never merely "> 0")
    expect(computeOutputHeadroom("native", "high")).toBe(8_960);
    expect(computeOutputHeadroom("none", "high")).toBe(768);
  });
});

// ---------------------------------------------------------------------------
// downshiftThinkingLevel
// ---------------------------------------------------------------------------

describe("downshiftThinkingLevel", () => {
  it('shifts "xhigh" → "high"', () => {
    expect(downshiftThinkingLevel("xhigh")).toBe("high");
  });

  it('shifts "high" → "medium"', () => {
    expect(downshiftThinkingLevel("high")).toBe("medium");
  });

  it('shifts "medium" → "low"', () => {
    expect(downshiftThinkingLevel("medium")).toBe("low");
  });

  it('returns undefined for "low" — cannot go lower; signals context_exhaustion', () => {
    expect(downshiftThinkingLevel("low")).toBeUndefined();
  });

  it('returns undefined for "minimal" — already minimal-reserve, no down-shift', () => {
    expect(downshiftThinkingLevel("minimal")).toBeUndefined();
  });

  it('returns undefined for "off" — thinking disabled, no down-shift', () => {
    expect(downshiftThinkingLevel("off")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// CHARACTERIZATION: frontier/mid byte-identity invariant (WR-01)
// computeTokenBudgetForProfile on a frontier profile must stay BYTE-IDENTICAL
// to pre-Phase-166 — this plan does NOT touch token-budget.ts or budget-capacity-cap.ts.
// ---------------------------------------------------------------------------

describe("computeTokenBudgetForProfile — frontier byte-identity characterization", () => {
  it("keeps frontier availableHistoryTokens byte-identical at W=200000 S=5000 (126808)", () => {
    // Frontier profile: capabilityClass="frontier" → effectiveWindow=Infinity cap (byte-identical).
    // computeTokenBudget(200000, 5000):
    //   M = max(ceil(200000 * 5 / 100), 2048) = max(10000, 2048) = 10000
    //   R = ceil(200000 * 25 / 100) = 50000
    //   O = 8192
    //   H = 200000 - 5000 - 8192 - 10000 - 50000 = 126808
    const frontierProfile = {
      ...FAIL_CLOSED_PROFILE,
      contextWindow: 200_000,
      maxOutputTokens: 8_192,
      capabilityClass: "frontier" as const,
      scaffoldLevel: "light" as const,
      securityLevel: "standard" as const,
    };
    const budget = computeTokenBudgetForProfile(frontierProfile, 5_000);
    expect(budget.availableHistoryTokens).toBe(126_808);
  });
});
