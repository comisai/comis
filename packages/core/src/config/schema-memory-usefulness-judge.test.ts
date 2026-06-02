// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { MemoryUsefulnessJudgeConfigSchema } from "./schema-memory-usefulness-judge.js";
import { PerAgentConfigSchema } from "./schema-agent/index.js";

describe("MemoryUsefulnessJudgeConfigSchema", () => {
  it("parses an empty object to the ON-by-default (v1 opt-out) bounded configuration", () => {
    // v2.9 increment 2 — v1 OPT-OUT posture: the offline usefulness judge defaults ON (a COST
    // feature, still force-disabled by the master kill switch). Bounded tuning constants frozen.
    const result = MemoryUsefulnessJudgeConfigSchema.parse({});
    expect(result).toEqual({
      enabled: true,
      // AFTER social's "0 6" so the judge scores over a fully-settled night
      // (review/consolidation/reasoning/user-repr/social have all run).
      schedule: "0 7 * * *",
      maxSourceMemories: 200,
      maxSourceChars: 24_000,
    });
  });

  it("defaults enabled to true (v1 opt-out posture; gated by the master cost-feature kill switch)", () => {
    expect(MemoryUsefulnessJudgeConfigSchema.parse({}).enabled).toBe(true);
  });

  it("defaults the per-run INPUT bounds (maxSourceMemories / maxSourceChars)", () => {
    const result = MemoryUsefulnessJudgeConfigSchema.parse({});
    expect(result.maxSourceMemories).toBe(200);
    expect(result.maxSourceChars).toBe(24_000);
  });

  it("rejects a non-positive / fractional input bound (the DoS bound is a positive int)", () => {
    expect(() => MemoryUsefulnessJudgeConfigSchema.parse({ maxSourceMemories: 0 })).toThrow();
    expect(() => MemoryUsefulnessJudgeConfigSchema.parse({ maxSourceChars: -1 })).toThrow();
    expect(() => MemoryUsefulnessJudgeConfigSchema.parse({ maxSourceMemories: 1.5 })).toThrow();
  });

  it("overrides only the specified fields and keeps the rest at the bounded defaults", () => {
    const result = MemoryUsefulnessJudgeConfigSchema.parse({
      enabled: true,
      schedule: "30 7 * * 0",
    });
    expect(result.enabled).toBe(true);
    expect(result.schedule).toBe("30 7 * * 0");
    expect(result.maxSourceMemories).toBe(200);
  });

  it("rejects an unknown key (z.strictObject guards config drift)", () => {
    expect(() => MemoryUsefulnessJudgeConfigSchema.parse({ judgeExternal: true })).toThrow();
  });
});

describe("PerAgentConfigSchema memoryUsefulnessJudge field", () => {
  it("accepts a memoryUsefulnessJudge subtree on a per-agent config", () => {
    const result = PerAgentConfigSchema.parse({
      memoryUsefulnessJudge: { enabled: true },
    });
    expect(result.memoryUsefulnessJudge).toBeDefined();
    expect(result.memoryUsefulnessJudge!.enabled).toBe(true);
  });

  it("defaults memoryUsefulnessJudge ON for a bare config (v1 opt-out posture; kill-switch-gated)", () => {
    // v2.9 increment 2 — the subtree is no longer `.optional()`; a bare config gets it populated
    // + enabled. The master cost-feature kill switch still force-disables it at the cron site.
    const result = PerAgentConfigSchema.parse({});
    expect(result.memoryUsefulnessJudge).toBeDefined();
    expect(result.memoryUsefulnessJudge!.enabled).toBe(true);
  });
});
