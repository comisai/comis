// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { PromptTimeoutConfigSchema } from "./schema-agent-model.js";

// ---------------------------------------------------------------------------
// `stallCeilingMultiplier`: the makespan ceiling is promptTimeoutMs x
// stallCeilingMultiplier. The ceiling is non-optional because a pure
// stall-reset deadline never kills a streaming runaway (gemma4 was
// measured streaming for 16x the timeout, 810s -- see
// scripts/bench-small-model/README.md). Default 10; positive non-integers
// allowed (the cooldownMultiplier precedent in the same file); strictObject
// keeps rejecting junk keys.
// ---------------------------------------------------------------------------

describe("PromptTimeoutConfigSchema.stallCeilingMultiplier", () => {
  it("parse({}) applies all three defaults including stallCeilingMultiplier 10", () => {
    const result = PromptTimeoutConfigSchema.parse({});
    expect(result).toEqual({
      promptTimeoutMs: 180_000,
      retryPromptTimeoutMs: 60_000,
      stallCeilingMultiplier: 10,
    });
  });

  it("accepts a positive non-integer multiplier (cooldownMultiplier precedent)", () => {
    const result = PromptTimeoutConfigSchema.parse({ stallCeilingMultiplier: 2.5 });
    expect(result.stallCeilingMultiplier).toBe(2.5);
  });

  it("rejects zero (a 0 multiplier would disable the ceiling)", () => {
    expect(PromptTimeoutConfigSchema.safeParse({ stallCeilingMultiplier: 0 }).success).toBe(false);
  });

  it("rejects negative multipliers outright", () => {
    expect(PromptTimeoutConfigSchema.safeParse({ stallCeilingMultiplier: -1 }).success).toBe(false);
  });

  it("strictObject rejects unknown keys (typo guard)", () => {
    expect(PromptTimeoutConfigSchema.safeParse({ stallCielingMultiplier: 10 }).success).toBe(false);
  });

  // The multiplier needs hard bounds. A value in (0, 1)
  // INVERTS the semantics -- the makespan fires before the stall budget can
  // ever elapse, so every timeout (including genuine provider hangs) is
  // classified makespan and SUPPRESSED from providerHealth: a one-key
  // misconfiguration silently disables both the stall semantics and
  // provider-degraded detection. At the other end, an absurd multiplier
  // overflows Node's 32-bit setTimeout (promptTimeoutMs x multiplier >
  // 2^31-1 clamps the delay to 1ms -- every prompt killed instantly).
  it("rejects fractional multipliers below 1 (0.5 would invert stall/makespan and blind providerHealth)", () => {
    expect(PromptTimeoutConfigSchema.safeParse({ stallCeilingMultiplier: 0.5 }).success).toBe(false);
    expect(PromptTimeoutConfigSchema.safeParse({ stallCeilingMultiplier: 0.99 }).success).toBe(false);
  });

  it("rejects multipliers above 100 (overflow guard) and accepts the 1 and 100 boundary values", () => {
    expect(PromptTimeoutConfigSchema.safeParse({ stallCeilingMultiplier: 101 }).success).toBe(false);
    expect(PromptTimeoutConfigSchema.safeParse({ stallCeilingMultiplier: 4_000 }).success).toBe(false);
    expect(PromptTimeoutConfigSchema.parse({ stallCeilingMultiplier: 1 }).stallCeilingMultiplier).toBe(1);
    expect(PromptTimeoutConfigSchema.parse({ stallCeilingMultiplier: 100 }).stallCeilingMultiplier).toBe(100);
  });
});
