// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { MemoryOnlineTuningConfigSchema } from "./schema-memory-online-tuning.js";
import { PerAgentConfigSchema, RagConfigSchema } from "./schema-agent/index.js";

describe("MemoryOnlineTuningConfigSchema (the OFFLINE, KEYLESS bandit cron knob)", () => {
  it("parses an empty object to the ON-by-default (opt-out) bounded configuration", () => {
    // OPT-OUT posture: the bandit cron defaults ON (it is in the
    // operator-facing cost-feature set, so still force-disabled by the kill switch). The bounded
    // schedule + DoS-cap constants stay frozen.
    const result = MemoryOnlineTuningConfigSchema.parse({});
    expect(result).toEqual({
      enabled: true,
      // AFTER the usefulness judge's "0 7" so the FEED signal the bandit reads is
      // fully settled (the judge's recordUsage write, if enabled, has run).
      schedule: "0 8 * * *",
      maxSourceMemories: 200,
    });
  });

  it("defaults enabled to true (opt-out posture; gated by the master cost-feature kill switch)", () => {
    expect(MemoryOnlineTuningConfigSchema.parse({}).enabled).toBe(true);
  });

  it("defaults the per-run INPUT bound (maxSourceMemories — the FEED-read candidate cap)", () => {
    expect(MemoryOnlineTuningConfigSchema.parse({}).maxSourceMemories).toBe(200);
  });

  it("rejects a non-positive / fractional input bound (the DoS bound is a positive int)", () => {
    expect(() => MemoryOnlineTuningConfigSchema.parse({ maxSourceMemories: 0 })).toThrow();
    expect(() => MemoryOnlineTuningConfigSchema.parse({ maxSourceMemories: -1 })).toThrow();
    expect(() => MemoryOnlineTuningConfigSchema.parse({ maxSourceMemories: 1.5 })).toThrow();
  });

  it("overrides only the specified fields and keeps the rest at the bounded defaults", () => {
    const result = MemoryOnlineTuningConfigSchema.parse({ enabled: true, schedule: "30 8 * * 0" });
    expect(result.enabled).toBe(true);
    expect(result.schedule).toBe("30 8 * * 0");
    expect(result.maxSourceMemories).toBe(200);
  });

  it("rejects an unknown key (z.strictObject guards config drift)", () => {
    expect(() => MemoryOnlineTuningConfigSchema.parse({ judgeExternal: true })).toThrow();
  });

  it("STRUCTURALLY REJECTS a smuggled trust knob (the ship-gate — the bandit cannot move trust)", () => {
    // The bandit tunes the four non-trust alphas only; a `trustAlpha` knob on its
    // cron config would be a footgun. z.strictObject rejects it at parse.
    expect(() => MemoryOnlineTuningConfigSchema.parse({ trustAlpha: 0.9 })).toThrow();
  });

  it("REJECTS a tunable step/clamp knob (those are pure-math constants in computeTunedAlphas, not operator knobs)", () => {
    expect(() => MemoryOnlineTuningConfigSchema.parse({ step: 0.5 })).toThrow();
    expect(() => MemoryOnlineTuningConfigSchema.parse({ maxSourceChars: 1000 })).toThrow();
  });
});

describe("RagConfigSchema onlineTuning field (the recall-side apply gate)", () => {
  it("defaults rag.onlineTuning.enabled to true (opt-out posture; the $0 recall-side apply gate)", () => {
    // OPT-OUT posture: the recall-side APPLY gate is $0 at recall (a gated
    // read of the on-device tuned-alpha store), default-ON. It is neutral until the OFFLINE bandit
    // (`memoryOnlineTuning`) writes a tuned vector; trust stays config-sourced (belt #2).
    const result = RagConfigSchema.parse({});
    expect(result.onlineTuning).toEqual({ enabled: true });
  });

  it("accepts rag.onlineTuning.enabled = true", () => {
    const result = RagConfigSchema.parse({ onlineTuning: { enabled: true } });
    expect(result.onlineTuning.enabled).toBe(true);
  });

  it("STRUCTURALLY REJECTS a stray field on rag.onlineTuning (no schedule/trustAlpha here — the cron knob is separate)", () => {
    expect(() => RagConfigSchema.parse({ onlineTuning: { enabled: true, schedule: "0 8 * * *" } })).toThrow();
    expect(() => RagConfigSchema.parse({ onlineTuning: { enabled: true, trustAlpha: 0.9 } })).toThrow();
  });
});

describe("PerAgentConfigSchema memoryOnlineTuning field", () => {
  it("accepts a memoryOnlineTuning subtree on a per-agent config", () => {
    const result = PerAgentConfigSchema.parse({ memoryOnlineTuning: { enabled: true } });
    expect(result.memoryOnlineTuning).toBeDefined();
    expect(result.memoryOnlineTuning!.enabled).toBe(true);
  });

  it("defaults memoryOnlineTuning ON for a bare config (opt-out posture; kill-switch-gated)", () => {
    // OPT-OUT posture: the bandit cron subtree is no longer `.optional()`;
    // a bare config gets it populated + enabled. The master cost-feature kill switch still
    // force-disables it at the cron-registration site when off.
    const result = PerAgentConfigSchema.parse({});
    expect(result.memoryOnlineTuning).toBeDefined();
    expect(result.memoryOnlineTuning!.enabled).toBe(true);
  });
});
