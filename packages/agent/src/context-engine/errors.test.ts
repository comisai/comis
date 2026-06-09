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
