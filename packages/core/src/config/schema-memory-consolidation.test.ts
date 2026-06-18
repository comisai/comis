// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { MemoryConsolidationConfigSchema } from "./schema-memory-consolidation.js";
import { PerAgentConfigSchema } from "./schema-agent/index.js";

describe("MemoryConsolidationConfigSchema", () => {
  it("parses an empty object to the ON-by-default (opt-out) bounded configuration", () => {
    // Opt-out posture: consolidation defaults ON (a COST feature, still
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
      // GENERAL-01/02 higher-order generalization (Phase 203) — default-ON (opt-out).
      generalize: { enabled: true, minDistinctContexts: 3 },
    });
  });

  it("defaults enabled to true (opt-out posture; gated by the master cost-feature kill switch)", () => {
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

  it("defaults the generalize block ON (opt-out) with minDistinctContexts 3 (GENERAL-01/02)", () => {
    // GENERAL-01/02 (v2.26 Phase 203): higher-order generalization synthesis is
    // default-ON (opt-out); the diversity gate still needs ≥3 distinct contexts.
    const result = MemoryConsolidationConfigSchema.parse({});
    expect(result.generalize).toEqual({ enabled: true, minDistinctContexts: 3 });
  });

  it("rejects a non-positive / fractional generalize.minDistinctContexts (the diversity gate is a positive int)", () => {
    expect(() =>
      MemoryConsolidationConfigSchema.parse({ generalize: { minDistinctContexts: 0 } }),
    ).toThrow();
    expect(() =>
      MemoryConsolidationConfigSchema.parse({ generalize: { minDistinctContexts: 1.5 } }),
    ).toThrow();
  });

  it("rejects an unknown key inside the generalize block (z.strictObject guards drift)", () => {
    expect(() =>
      MemoryConsolidationConfigSchema.parse({ generalize: { bogus: true } }),
    ).toThrow();
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

  it("defaults memoryConsolidation ON for a bare config (opt-out posture; kill-switch-gated)", () => {
    // The subtree is no longer `.optional()`; a bare config gets it populated
    // + enabled. The master cost-feature kill switch still force-disables it at the cron site.
    const result = PerAgentConfigSchema.parse({});
    expect(result.memoryConsolidation).toBeDefined();
    expect(result.memoryConsolidation!.enabled).toBe(true);
  });
});
