// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import type { IncidentSignals } from "@comis/core";
import { freshTailOriginLostVerdict } from "./obs-explain-fresh-tail-verdict.js";

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
      originatingRequestRetained: false,
      freshTailTrimmedCount: 3,
      ...over,
    },
  } as unknown as IncidentSignals;
}

describe("freshTailOriginLostVerdict", () => {
  it("fires when the budget record proves the originating request was lost", () => {
    const v = freshTailOriginLostVerdict(signals());
    expect(v).not.toBeNull();
    expect(v!.code).toBe("fresh_tail_origin_lost");
  });

  it("names BOTH numbers and the knob (so the operator does not have to grep DEBUG)", () => {
    const v = freshTailOriginLostVerdict(signals())!;
    expect(v.detail).toContain("contextEngine.freshTailTurns");
    expect(v.detail).toContain("6");
    expect(v.detail).toContain("8");
  });

  it("reports actual trim evidence and window use", () => {
    const v = freshTailOriginLostVerdict(signals())!;
    // 87,740 / 1,000,000 = 9% — the window was nearly empty while the request slid out.
    expect(v.detail).toMatch(/9% of the window/);
    expect(v.detail).toMatch(/3 messages were trimmed/i);
  });

  it("stays silent when a clamp occurred but the request was retained", () => {
    expect(freshTailOriginLostVerdict(signals({ originatingRequestRetained: true }))).toBeNull();
  });

  it("fires on actual loss even when no clamp occurred", () => {
    expect(freshTailOriginLostVerdict(signals({ freshTailSteps: 8 }))).not.toBeNull();
  });

  it("stays silent when direct origin-retention evidence is absent", () => {
    expect(
      freshTailOriginLostVerdict(
        signals({
          freshTailSteps: undefined,
          freshTailStepsConfigured: undefined,
          originatingRequestRetained: undefined,
        }),
      ),
    ).toBeNull();
  });

  it("stays silent when there is no budget evidence at all", () => {
    expect(freshTailOriginLostVerdict({} as unknown as IncidentSignals)).toBeNull();
  });
});
