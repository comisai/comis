// SPDX-License-Identifier: Apache-2.0
//
// HR-01 (v2.19) — the context-exhaustion signal must survive the bridge boundary.
//
// When ContextExhaustionError is thrown by the pre-flight during a MID-TURN
// continuation, the pi-ai SDK converts it to a turn_end with stopReason:"error"
// and a STRING errorMessage — the `instanceof` is gone. The bridge therefore
// recovers the signal from the message via the SHARED, TESTED predicate below
// (not an ad-hoc literal in the bridge). The constructor and the predicate share
// CONTEXT_EXHAUSTION_MESSAGE_PREFIX so they can never drift.

import { describe, it, expect } from "vitest";
import {
  ContextExhaustionError,
  CONTEXT_EXHAUSTION_MESSAGE_PREFIX,
  isContextExhaustionErrorMessage,
} from "./errors.js";

describe("ContextExhaustionError message contract", () => {
  it("the error message begins with the shared prefix", () => {
    const err = new ContextExhaustionError(32000, 30525);
    expect(err.message.startsWith(CONTEXT_EXHAUSTION_MESSAGE_PREFIX)).toBe(true);
    // Carries the diagnostic numbers (operator needs them in the log).
    expect(err.message).toContain("30525");
    expect(err.message).toContain("32000");
  });

  it("isContextExhaustionErrorMessage matches a real ContextExhaustionError message", () => {
    // The exact live string observed at the bridge:
    expect(
      isContextExhaustionErrorMessage(
        "Context exhausted: assembled 30525 tokens leaves no room in effective window 32000",
      ),
    ).toBe(true);
    expect(isContextExhaustionErrorMessage(new ContextExhaustionError(16000, 20000).message)).toBe(true);
  });

  it("does NOT match generic / unrelated LLM errors", () => {
    expect(isContextExhaustionErrorMessage("Unknown LLM error")).toBe(false);
    expect(isContextExhaustionErrorMessage("429 rate limited")).toBe(false);
    expect(isContextExhaustionErrorMessage("The context was large")).toBe(false);
    expect(isContextExhaustionErrorMessage(undefined)).toBe(false);
    expect(isContextExhaustionErrorMessage("")).toBe(false);
  });
});

// W1 (obs-llm-troubleshooting): when the effective window was CAPPED below the
// model's declared contextWindow (capabilityClass small/nano), the error must
// name the raw window AND the exact config knob. Live incident: the operator's
// config said contextWindow=131072, the error said "effective window 32000",
// and nothing connected the two — root-causing required reading
// budget-capacity-cap.ts. The message itself must carry that link.
describe("ContextExhaustionError capped-window provenance", () => {
  it("names the raw declared window and the small-cap knob when the window was capped", () => {
    const e = new ContextExhaustionError(32_000, 31_572, {
      rawContextWindowTokens: 131_072,
      windowCapSource: "effectiveContextCapSmall",
    });
    expect(e.message.startsWith(CONTEXT_EXHAUSTION_MESSAGE_PREFIX)).toBe(true);
    expect(isContextExhaustionErrorMessage(e.message)).toBe(true);
    expect(e.message).toContain("131072");
    expect(e.message).toContain("contextEngine.budget.effectiveContextCapSmall");
  });

  it("names the nano knob when the nano-class cap clamped the window", () => {
    const e = new ContextExhaustionError(16_000, 15_900, {
      rawContextWindowTokens: 65_536,
      windowCapSource: "effectiveContextCapNano",
    });
    expect(e.message).toContain("65536");
    expect(e.message).toContain("contextEngine.budget.effectiveContextCapNano");
  });

  it("an uncapped capInfo (source none) leaves the message byte-identical to the no-capInfo form", () => {
    const plain = new ContextExhaustionError(32_000, 31_572);
    const uncapped = new ContextExhaustionError(32_000, 31_572, {
      rawContextWindowTokens: 32_000,
      windowCapSource: "none",
    });
    expect(uncapped.message).toBe(plain.message);
  });
});
