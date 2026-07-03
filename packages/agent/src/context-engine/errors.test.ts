// SPDX-License-Identifier: Apache-2.0
//
// The context-exhaustion signal must survive the bridge boundary.
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
  describeWindowCap,
  parseContextExhaustionCause,
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

// When the effective window is CAPPED below the model's declared
// contextWindow (capabilityClass small/nano), the error must name the raw
// window AND the exact config knob. Otherwise an operator whose config says
// contextWindow=131072 sees "effective window 32000" with nothing connecting
// the two — root-causing would require reading budget-capacity-cap.ts. The
// message itself must carry that link.
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

// "served" is a WindowCapSource of its own. The "raise it
// (0 = uncapped)" remedy is the WRONG knob for a served-bound window — the fix
// lives in Ollama (OLLAMA_CONTEXT_LENGTH env / Modelfile PARAMETER num_ctx),
// not in contextEngine.budget.*. describeWindowCap must branch by source so
// the operator gets the hint that fits the failure class, and the double-cap
// chain (served bound first, class cap tighter) must name BOTH constraints.
describe("describeWindowCap served-window branch", () => {
  it("served source names both Ollama knobs and the TRUE configured number", () => {
    expect(
      describeWindowCap(8_192, { rawContextWindowTokens: 131_072, windowCapSource: "served" }),
    ).toBe(
      " (model contextWindow 131072 but Ollama serves only 8192 — fix: OLLAMA_CONTEXT_LENGTH=131072 ollama serve, or Modelfile 'PARAMETER num_ctx 131072')",
    );
  });

  it("double-cap chain — cap source keeps the knob remedy and the served step is named", () => {
    expect(
      describeWindowCap(32_000, {
        rawContextWindowTokens: 131_072,
        windowCapSource: "effectiveContextCapSmall",
        servedWindowTokens: 50_000,
      }),
    ).toBe(
      " (model contextWindow 131072, Ollama serves 50000, capped to 32000 by contextEngine.budget.effectiveContextCapSmall — raise it (0 = uncapped) or reduce active tool schemas)",
    );
  });

  it("regression pin — the cap-only text (no servedWindowTokens) stays byte-identical", () => {
    expect(
      describeWindowCap(32_000, {
        rawContextWindowTokens: 131_072,
        windowCapSource: "effectiveContextCapSmall",
      }),
    ).toBe(
      " (model contextWindow 131072 capped to 32000 by contextEngine.budget.effectiveContextCapSmall — raise it (0 = uncapped) or reduce active tool schemas)",
    );
  });
});

// When the binding cap is the EXECUTOR-side
// DEFAULT_EFFECTIVE_CAP_BY_CLASS (the operator pinned
// providers.entries.<id>.capabilities.capabilityClass), the budget knob is a
// DEAD lever — pi-executor's cap never reads contextEngine.budget.* — so the
// remedy must name the PIN, not "raise it (0 = uncapped)".
describe("describeWindowCap capabilityClass-pin branch", () => {
  it("a capabilityClass bind names the pin and its remedy, never the budget knob's numeric remedy", () => {
    const text = describeWindowCap(32_000, {
      rawContextWindowTokens: 131_072,
      windowCapSource: "capabilityClass",
    });
    expect(text).toBe(
      " (model contextWindow 131072 capped to 32000 by providers.entries.<id>.capabilities.capabilityClass — pin a higher class (or remove the pin) or reduce active tool schemas)",
    );
    // The dead lever must not appear anywhere in the suffix.
    expect(text).not.toContain("contextEngine.budget.effectiveContextCapSmall");
    expect(text).not.toContain("raise it (0 = uncapped)");
  });

  it("the capabilityClass bind carries the served step when probed (full chain: configured → served → pin)", () => {
    expect(
      describeWindowCap(32_000, {
        rawContextWindowTokens: 131_072,
        windowCapSource: "capabilityClass",
        servedWindowTokens: 50_000,
      }),
    ).toBe(
      " (model contextWindow 131072, Ollama serves 50000, capped to 32000 by providers.entries.<id>.capabilities.capabilityClass — pin a higher class (or remove the pin) or reduce active tool schemas)",
    );
  });
});

// The exhaustion CAUSE must survive
// the same string boundary the prefix does, so the degraded reply can branch
// its advice ("narrow the ask" is misleading when the offender is a
// persisted oversized HISTORY message — the ask may be tiny).
describe("ContextExhaustionError cause tag round-trip", () => {
  it("oversized_input survives constructor → message → parseContextExhaustionCause", () => {
    const err = new ContextExhaustionError(32000, 48000, undefined, "oversized_input");
    expect(parseContextExhaustionCause(err.message)).toBe("oversized_input");
    // The prefix contract is untouched by the tag.
    expect(isContextExhaustionErrorMessage(err.message)).toBe(true);
  });

  it("oversized_history_message survives the round-trip", () => {
    const err = new ContextExhaustionError(32000, 48000, undefined, "oversized_history_message");
    expect(parseContextExhaustionCause(err.message)).toBe("oversized_history_message");
  });

  it("aggregate stays UNMARKED — the untagged message shape is byte-identical", () => {
    const tagged = new ContextExhaustionError(32000, 30525, undefined, "aggregate");
    const untagged = new ContextExhaustionError(32000, 30525);
    expect(tagged.message).toBe(untagged.message);
    expect(tagged.message).not.toContain("[cause:");
    expect(parseContextExhaustionCause(tagged.message)).toBe("aggregate");
  });

  it("parse is tolerant of undefined / untagged / unrelated strings (→ aggregate)", () => {
    expect(parseContextExhaustionCause(undefined)).toBe("aggregate");
    expect(parseContextExhaustionCause("")).toBe("aggregate");
    expect(parseContextExhaustionCause("Unknown LLM error")).toBe("aggregate");
    expect(
      parseContextExhaustionCause(
        "Context exhausted: assembled 30525 tokens leaves no room in effective window 32000",
      ),
    ).toBe("aggregate");
  });
});
