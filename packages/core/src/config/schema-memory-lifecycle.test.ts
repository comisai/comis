// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { MemoryLifecycleConfigSchema } from "./schema-memory-lifecycle.js";

describe("MemoryLifecycleConfigSchema (the default-ON lifecycle sweep cron knob)", () => {
  it("parses an empty object to the on-by-default (opt-out) cron config — just enabled + schedule", () => {
    const result = MemoryLifecycleConfigSchema.parse({});
    // This schema is exactly two knobs. The eviction-policy constants live elsewhere:
    // the forget behavior (including maxDormantDays) reads from learning.forget.
    expect(result).toEqual({
      enabled: true,
      // A slot AFTER online-tuning's "0 8" so the FEED + the tuned alphas have
      // fully settled before the lifecycle sweep reads them.
      schedule: "0 9 * * *",
    });
  });

  it("defaults enabled to true (opt-out posture — the keyless sweep is on out of the box)", () => {
    expect(MemoryLifecycleConfigSchema.parse({}).enabled).toBe(true);
  });

  it("defaults the schedule to a slot after online-tuning's 08:00 (0 9 * * *)", () => {
    expect(MemoryLifecycleConfigSchema.parse({}).schedule).toBe("0 9 * * *");
  });

  it("strength-policy constants (θ_promote/θ_demote/durableCap/ephemeralCap/ε_prune) are REJECTED at parse (z.strictObject)", () => {
    // There is no strength-based eviction policy — dormancy + corroborated failure are the
    // only disjuncts. z.strictObject rejects a config carrying strength constants loudly,
    // not a silent ignore.
    expect(() => MemoryLifecycleConfigSchema.parse({ thetaPromote: 0.7 })).toThrow();
    expect(() => MemoryLifecycleConfigSchema.parse({ thetaDemote: 0.3 })).toThrow();
    expect(() => MemoryLifecycleConfigSchema.parse({ durableCap: 1000 })).toThrow();
    expect(() => MemoryLifecycleConfigSchema.parse({ ephemeralCap: 500 })).toThrow();
    expect(() => MemoryLifecycleConfigSchema.parse({ epsilonPrune: 0.05 })).toThrow();
  });

  it("maxDormantDays lives at learning.forget — it is not a memoryLifecycle key (rejected at parse)", () => {
    expect(() => MemoryLifecycleConfigSchema.parse({ maxDormantDays: 90 })).toThrow();
  });

  it("overrides only the specified fields and keeps the rest at the defaults", () => {
    const result = MemoryLifecycleConfigSchema.parse({ enabled: true, schedule: "30 9 * * 0" });
    expect(result.enabled).toBe(true);
    expect(result.schedule).toBe("30 9 * * 0");
  });

  it("rejects an unknown key (z.strictObject guards config drift)", () => {
    expect(() => MemoryLifecycleConfigSchema.parse({ evictNow: true })).toThrow();
  });

  it("STRUCTURALLY REJECTS a smuggled trust knob (the lifecycle sweep never moves trust)", () => {
    // The sweep tiers/decays by strength; trust is NEVER raised by degradation.
    // A `trustLevel`/`trustAlpha` knob on its cron config would be a
    // footgun — z.strictObject rejects it at parse.
    expect(() => MemoryLifecycleConfigSchema.parse({ trustAlpha: 0.9 })).toThrow();
    expect(() => MemoryLifecycleConfigSchema.parse({ trustLevel: "system" })).toThrow();
  });
});
