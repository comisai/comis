// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import type { IncidentSignals } from "@comis/core";
import { freshTailClampedVerdict } from "./obs-explain-fresh-tail-verdict.js";

/** The live budget shape from comis-moshe 2026-07-26, seq 293 (the false apology). */
function signals(over: Record<string, unknown> = {}): IncidentSignals {
  return {
    contextBudget: {
      windowTokens: 1_000_000,
      rawContextWindowTokens: 1_000_000,
      windowCapSource: "none",
      systemTokens: 54_477,
      freshTailTokens: 712,
      budgetedHistoryTokens: 32_551,
      keptCount: 76,
      assembledInputTokens: 87_740,
      outputHeadroom: 3_840,
      verdict: "fits",
      freshTailSteps: 6,
      freshTailStepsConfigured: 8,
      ...over,
    },
  } as unknown as IncidentSignals;
}

describe("freshTailClampedVerdict", () => {
  it("fires when the effective step bound is below the configured freshTailTurns", () => {
    const v = freshTailClampedVerdict(signals());
    expect(v).not.toBeNull();
    expect(v!.code).toBe("fresh_tail_clamped");
  });

  it("names BOTH numbers and the knob (so the operator does not have to grep DEBUG)", () => {
    const v = freshTailClampedVerdict(signals())!;
    expect(v.detail).toContain("contextEngine.freshTailTurns");
    expect(v.detail).toContain("6");
    expect(v.detail).toContain("8");
  });

  it("states that the token budget was NOT the constraint (the 'fits' trap)", () => {
    const v = freshTailClampedVerdict(signals())!;
    // 87,740 / 1,000,000 = 9% — the window was nearly empty while the request slid out.
    expect(v.detail).toMatch(/9% of the window/);
    expect(v.detail).toMatch(/NOT the constraint/i);
  });

  it("stays silent when the configured value is honored", () => {
    expect(freshTailClampedVerdict(signals({ freshTailSteps: 8 }))).toBeNull();
    expect(freshTailClampedVerdict(signals({ freshTailSteps: 12 }))).toBeNull();
  });

  it("stays silent on a trajectory that predates the signal (both fields absent)", () => {
    expect(
      freshTailClampedVerdict(
        signals({ freshTailSteps: undefined, freshTailStepsConfigured: undefined }),
      ),
    ).toBeNull();
  });

  it("stays silent when there is no budget evidence at all", () => {
    expect(freshTailClampedVerdict({} as unknown as IncidentSignals)).toBeNull();
  });
});
