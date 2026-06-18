// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { MemoryLifecycleConfigSchema } from "./schema-memory-lifecycle.js";

describe("MemoryLifecycleConfigSchema (the scaffolded, dormant default-ON lifecycle cron knob)", () => {
  it("parses an empty object to the on-by-default (opt-out) dormant policy configuration", () => {
    const result = MemoryLifecycleConfigSchema.parse({});
    expect(result).toEqual({
      enabled: true,
      // A slot AFTER online-tuning's "0 8" so the FEED + the tuned alphas have
      // fully settled before the lifecycle sweep reads them.
      schedule: "0 9 * * *",
      // The hysteresis dead-band (θ_promote 0.7 > θ_demote 0.3) — the dormant
      // policy constants the live step (deferred) would apply.
      thetaPromote: 0.7,
      thetaDemote: 0.3,
      durableCap: 1000,
      ephemeralCap: 500,
      epsilonPrune: 0.05,
      maxDormantDays: 90,
    });
  });

  it("defaults enabled to true (opt-out — gated by the master cost switch; the sweep itself is SCAFFOLD-DORMANT, evicts/demotes nothing even when enabled)", () => {
    expect(MemoryLifecycleConfigSchema.parse({}).enabled).toBe(true);
  });

  it("defaults the schedule to a slot after online-tuning's 08:00 (0 9 * * *)", () => {
    expect(MemoryLifecycleConfigSchema.parse({}).schedule).toBe("0 9 * * *");
  });

  it("defaults the hysteresis dead-band θ_promote 0.7 > θ_demote 0.3 (FadeMem Eq.3)", () => {
    const cfg = MemoryLifecycleConfigSchema.parse({});
    expect(cfg.thetaPromote).toBe(0.7);
    expect(cfg.thetaDemote).toBe(0.3);
    // The promote threshold must sit ABOVE the demote threshold — the no-flap band.
    expect(cfg.thetaPromote).toBeGreaterThan(cfg.thetaDemote);
  });

  it("defaults the capacity caps + the prune/dormancy constants (the dormant eviction policy)", () => {
    const cfg = MemoryLifecycleConfigSchema.parse({});
    expect(cfg.durableCap).toBe(1000);
    expect(cfg.ephemeralCap).toBe(500);
    expect(cfg.epsilonPrune).toBe(0.05);
    expect(cfg.maxDormantDays).toBe(90);
  });

  it("clamps the θ bands + ε_prune to [0,1] (a probability-like constant)", () => {
    expect(() => MemoryLifecycleConfigSchema.parse({ thetaPromote: 1.5 })).toThrow();
    expect(() => MemoryLifecycleConfigSchema.parse({ thetaDemote: -0.1 })).toThrow();
    expect(() => MemoryLifecycleConfigSchema.parse({ epsilonPrune: 2 })).toThrow();
  });

  it("rejects a non-positive / fractional cap or dormancy window (the bounded eviction policy)", () => {
    expect(() => MemoryLifecycleConfigSchema.parse({ durableCap: 0 })).toThrow();
    expect(() => MemoryLifecycleConfigSchema.parse({ ephemeralCap: -1 })).toThrow();
    expect(() => MemoryLifecycleConfigSchema.parse({ maxDormantDays: 1.5 })).toThrow();
  });

  it("overrides only the specified fields and keeps the rest at the dormant defaults", () => {
    const result = MemoryLifecycleConfigSchema.parse({ enabled: true, schedule: "30 9 * * 0" });
    expect(result.enabled).toBe(true);
    expect(result.schedule).toBe("30 9 * * 0");
    expect(result.thetaPromote).toBe(0.7);
    expect(result.durableCap).toBe(1000);
  });

  it("rejects an unknown key (z.strictObject guards config drift)", () => {
    expect(() => MemoryLifecycleConfigSchema.parse({ evictNow: true })).toThrow();
  });

  it("STRUCTURALLY REJECTS a smuggled trust knob (the lifecycle sweep never moves trust — design C2)", () => {
    // The sweep tiers/decays by strength; trust is NEVER raised by degradation
    // (design C2). A `trustLevel`/`trustAlpha` knob on its cron config would be a
    // footgun — z.strictObject rejects it at parse.
    expect(() => MemoryLifecycleConfigSchema.parse({ trustAlpha: 0.9 })).toThrow();
    expect(() => MemoryLifecycleConfigSchema.parse({ trustLevel: "system" })).toThrow();
  });
});
