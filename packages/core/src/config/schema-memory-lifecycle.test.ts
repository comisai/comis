// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { MemoryLifecycleConfigSchema } from "./schema-memory-lifecycle.js";

describe("MemoryLifecycleConfigSchema (the scaffolded, dormant default-ON lifecycle cron knob)", () => {
  it("parses an empty object to the TRIMMED on-by-default (opt-out) cron config (Phase 226 — just enabled + schedule)", () => {
    const result = MemoryLifecycleConfigSchema.parse({});
    // Phase 226 (SIMPLIFY-01) trimmed this schema to its two surviving knobs. The dormant
    // FadeMem constants (θ_promote/θ_demote/durableCap/ephemeralCap/ε_prune) were DELETED and
    // maxDormantDays MOVED to learning.forget.maxDormantDays.
    expect(result).toEqual({
      enabled: true,
      // A slot AFTER online-tuning's "0 8" so the FEED + the tuned alphas have
      // fully settled before the lifecycle sweep reads them.
      schedule: "0 9 * * *",
    });
  });

  it("defaults enabled to true (opt-out — gated by the master cost switch; the sweep itself is SCAFFOLD-DORMANT, evicts/demotes nothing even when enabled)", () => {
    expect(MemoryLifecycleConfigSchema.parse({}).enabled).toBe(true);
  });

  it("defaults the schedule to a slot after online-tuning's 08:00 (0 9 * * *)", () => {
    expect(MemoryLifecycleConfigSchema.parse({}).schedule).toBe("0 9 * * *");
  });

  it("Phase 226: the deleted FadeMem constants (θ_promote/θ_demote/durableCap/ephemeralCap/ε_prune) are REJECTED at parse (z.strictObject — proves the removal)", () => {
    // The dormant policy constants were DELETED (224 removed the strength disjunct — the
    // sweep evicts/demotes nothing on them). z.strictObject now rejects a config still
    // carrying them — the documented removal, not a silent ignore.
    expect(() => MemoryLifecycleConfigSchema.parse({ thetaPromote: 0.7 })).toThrow();
    expect(() => MemoryLifecycleConfigSchema.parse({ thetaDemote: 0.3 })).toThrow();
    expect(() => MemoryLifecycleConfigSchema.parse({ durableCap: 1000 })).toThrow();
    expect(() => MemoryLifecycleConfigSchema.parse({ ephemeralCap: 500 })).toThrow();
    expect(() => MemoryLifecycleConfigSchema.parse({ epsilonPrune: 0.05 })).toThrow();
  });

  it("Phase 226: maxDormantDays MOVED to learning.forget — it is no longer a memoryLifecycle key (rejected at parse)", () => {
    expect(() => MemoryLifecycleConfigSchema.parse({ maxDormantDays: 90 })).toThrow();
  });

  it("overrides only the specified fields and keeps the rest at the trimmed defaults", () => {
    const result = MemoryLifecycleConfigSchema.parse({ enabled: true, schedule: "30 9 * * 0" });
    expect(result.enabled).toBe(true);
    expect(result.schedule).toBe("30 9 * * 0");
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
