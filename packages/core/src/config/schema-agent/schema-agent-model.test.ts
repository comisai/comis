// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { PromptTimeoutConfigSchema } from "./schema-agent-model.js";

// ---------------------------------------------------------------------------
// LAT-02 (Phase 177): `stallCeilingMultiplier` -- the ONE new config key the
// phase sanctions. The makespan ceiling is promptTimeoutMs x
// stallCeilingMultiplier (R-1 non-optional: a pure stall-reset deadline never
// kills a streaming runaway -- gemma4 16x/810s receipt,
// scripts/bench-small-model/README.md). Default 10; positive non-integers
// allowed (the cooldownMultiplier precedent in the same file); strictObject
// keeps rejecting junk keys.
//
// These cases fail on the pre-patch schema (the key is missing, so
// strictObject rejects it and parse({}) lacks the default) -- RED proof.
// ---------------------------------------------------------------------------

describe("PromptTimeoutConfigSchema.stallCeilingMultiplier (LAT-02)", () => {
  it("LAT-02-S1: parse({}) applies all three defaults including stallCeilingMultiplier 10", () => {
    const result = PromptTimeoutConfigSchema.parse({});
    expect(result).toEqual({
      promptTimeoutMs: 180_000,
      retryPromptTimeoutMs: 60_000,
      stallCeilingMultiplier: 10,
    });
  });

  it("LAT-02-S2: accepts a positive non-integer multiplier (cooldownMultiplier precedent)", () => {
    const result = PromptTimeoutConfigSchema.parse({ stallCeilingMultiplier: 2.5 });
    expect(result.stallCeilingMultiplier).toBe(2.5);
  });

  it("LAT-02-S3: rejects zero (a 0 multiplier would disable the ceiling -- T-177-03)", () => {
    expect(PromptTimeoutConfigSchema.safeParse({ stallCeilingMultiplier: 0 }).success).toBe(false);
  });

  it("LAT-02-S4: rejects negative multipliers", () => {
    expect(PromptTimeoutConfigSchema.safeParse({ stallCeilingMultiplier: -1 }).success).toBe(false);
  });

  it("LAT-02-S5: strictObject rejects unknown keys (typo guard)", () => {
    expect(PromptTimeoutConfigSchema.safeParse({ stallCielingMultiplier: 10 }).success).toBe(false);
  });

  // 177-REVIEW WR-02: the multiplier needs hard bounds. A value in (0, 1)
  // INVERTS the semantics -- the makespan fires before the stall budget can
  // ever elapse, so every timeout (including genuine provider hangs) is
  // classified makespan and SUPPRESSED from providerHealth: a one-key
  // misconfiguration silently disables both the stall semantics and
  // provider-degraded detection. At the other end, an absurd multiplier
  // overflows Node's 32-bit setTimeout (promptTimeoutMs x multiplier >
  // 2^31-1 clamps the delay to 1ms -- every prompt killed instantly).
  it("177-REVIEW WR-02: rejects fractional multipliers below 1 (0.5 would invert stall/makespan and blind providerHealth)", () => {
    expect(PromptTimeoutConfigSchema.safeParse({ stallCeilingMultiplier: 0.5 }).success).toBe(false);
    expect(PromptTimeoutConfigSchema.safeParse({ stallCeilingMultiplier: 0.99 }).success).toBe(false);
  });

  it("177-REVIEW WR-02: rejects multipliers above 100 (overflow guard) and accepts the 1 and 100 boundary values", () => {
    expect(PromptTimeoutConfigSchema.safeParse({ stallCeilingMultiplier: 101 }).success).toBe(false);
    expect(PromptTimeoutConfigSchema.safeParse({ stallCeilingMultiplier: 4_000 }).success).toBe(false);
    expect(PromptTimeoutConfigSchema.parse({ stallCeilingMultiplier: 1 }).stallCeilingMultiplier).toBe(1);
    expect(PromptTimeoutConfigSchema.parse({ stallCeilingMultiplier: 100 }).stallCeilingMultiplier).toBe(100);
  });
});
