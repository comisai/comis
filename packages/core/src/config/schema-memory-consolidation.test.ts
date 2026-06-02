// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { MemoryConsolidationConfigSchema } from "./schema-memory-consolidation.js";
import { PerAgentConfigSchema } from "./schema-agent/index.js";

describe("MemoryConsolidationConfigSchema", () => {
  it("parses an empty object to the ON-by-default (v1 opt-out) bounded configuration", () => {
    // v2.9 increment 2 — v1 OPT-OUT posture: consolidation defaults ON (a COST feature, still
    // force-disabled by the master kill switch). All bounded tuning constants stay frozen.
    const result = MemoryConsolidationConfigSchema.parse({});
    expect(result).toEqual({
      enabled: true,
      schedule: "30 3 * * *",
      similarityThreshold: 0.82,
      dedupThreshold: 0.9,
      maxCandidatesPerRun: 200,
      maxClusterSize: 12,
      maxClustersPerRun: 25,
      maxConsolidationTokens: 1024,
      consolidateExternal: false,
      autoTags: [],
    });
  });

  it("defaults enabled to true (v1 opt-out posture; gated by the master cost-feature kill switch)", () => {
    expect(MemoryConsolidationConfigSchema.parse({}).enabled).toBe(true);
  });

  it("overrides only the specified fields and keeps the rest at defaults", () => {
    const result = MemoryConsolidationConfigSchema.parse({
      enabled: true,
      maxClustersPerRun: 5,
    });
    expect(result.enabled).toBe(true);
    expect(result.maxClustersPerRun).toBe(5);
    expect(result.schedule).toBe("30 3 * * *");
    expect(result.maxCandidatesPerRun).toBe(200);
    expect(result.maxConsolidationTokens).toBe(1024);
  });

  it("rejects an unknown key (z.strictObject guards config drift)", () => {
    expect(() =>
      MemoryConsolidationConfigSchema.parse({ foldThreshold: 0.85 }),
    ).toThrow();
  });

  it("rejects a similarityThreshold above 1", () => {
    expect(() => MemoryConsolidationConfigSchema.parse({ similarityThreshold: 1.5 })).toThrow();
  });

  it("rejects a non-positive maxCandidatesPerRun", () => {
    expect(() => MemoryConsolidationConfigSchema.parse({ maxCandidatesPerRun: 0 })).toThrow();
  });
});

describe("PerAgentConfigSchema memoryConsolidation field", () => {
  it("accepts a memoryConsolidation subtree on a per-agent config", () => {
    const result = PerAgentConfigSchema.parse({
      memoryConsolidation: { enabled: true },
    });
    expect(result.memoryConsolidation).toBeDefined();
    expect(result.memoryConsolidation!.enabled).toBe(true);
  });

  it("defaults memoryConsolidation ON for a bare config (v1 opt-out posture; kill-switch-gated)", () => {
    // v2.9 increment 2 — the subtree is no longer `.optional()`; a bare config gets it populated
    // + enabled. The master cost-feature kill switch still force-disables it at the cron site.
    const result = PerAgentConfigSchema.parse({});
    expect(result.memoryConsolidation).toBeDefined();
    expect(result.memoryConsolidation!.enabled).toBe(true);
  });
});
