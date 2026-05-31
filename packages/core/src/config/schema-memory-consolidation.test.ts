// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { MemoryConsolidationConfigSchema } from "./schema-memory-consolidation.js";
import { PerAgentConfigSchema } from "./schema-agent/index.js";

describe("MemoryConsolidationConfigSchema", () => {
  it("parses an empty object to the off-by-default bounded configuration", () => {
    const result = MemoryConsolidationConfigSchema.parse({});
    expect(result).toEqual({
      enabled: false,
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

  it("defaults enabled to false (consolidation is opt-in, a cost gate not back-compat)", () => {
    expect(MemoryConsolidationConfigSchema.parse({}).enabled).toBe(false);
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

  it("treats memoryConsolidation as optional (absent on a bare config)", () => {
    const result = PerAgentConfigSchema.parse({});
    expect(result.memoryConsolidation).toBeUndefined();
  });
});
