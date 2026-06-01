// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { MemoryReasoningConfigSchema } from "./schema-memory-reasoning.js";
import { PerAgentConfigSchema } from "./schema-agent/index.js";

describe("MemoryReasoningConfigSchema", () => {
  it("parses an empty object to the off-by-default bounded configuration", () => {
    const result = MemoryReasoningConfigSchema.parse({});
    expect(result).toEqual({
      enabled: false,
      schedule: "0 4 * * *",
      maxCandidatesPerRun: 200,
      surprisalTopFraction: 0.1,
      knnK: 10,
      maxObservationsPerRun: 25,
      maxReasoningTokens: 1024,
      reasonExternal: false,
      autoTags: [],
    });
  });

  it("defaults enabled to false (reasoning is opt-in, a cost gate not back-compat)", () => {
    expect(MemoryReasoningConfigSchema.parse({}).enabled).toBe(false);
  });

  it("defaults reasonExternal to false (external memories excluded — trust hardening)", () => {
    expect(MemoryReasoningConfigSchema.parse({}).reasonExternal).toBe(false);
  });

  it("overrides only the specified fields and keeps the rest at the bounded defaults", () => {
    const result = MemoryReasoningConfigSchema.parse({
      enabled: true,
      maxObservationsPerRun: 5,
    });
    expect(result.enabled).toBe(true);
    expect(result.maxObservationsPerRun).toBe(5);
    expect(result.schedule).toBe("0 4 * * *");
    expect(result.surprisalTopFraction).toBe(0.1);
    expect(result.knnK).toBe(10);
    expect(result.maxReasoningTokens).toBe(1024);
  });

  it("rejects an unknown key (z.strictObject guards config drift)", () => {
    expect(() =>
      MemoryReasoningConfigSchema.parse({ foldThreshold: 0.85 }),
    ).toThrow();
  });

  it("rejects a surprisalTopFraction above 1 (the surprisal gate is a fraction)", () => {
    expect(() => MemoryReasoningConfigSchema.parse({ surprisalTopFraction: 1.5 })).toThrow();
  });

  it("rejects a surprisalTopFraction below 0 (the surprisal gate is a fraction)", () => {
    expect(() => MemoryReasoningConfigSchema.parse({ surprisalTopFraction: -0.1 })).toThrow();
  });

  it("rejects a non-positive knnK (a neighbour count must be a positive int)", () => {
    expect(() => MemoryReasoningConfigSchema.parse({ knnK: 0 })).toThrow();
  });

  it("rejects a non-positive maxObservationsPerRun (the DoS cost bound must be positive)", () => {
    expect(() => MemoryReasoningConfigSchema.parse({ maxObservationsPerRun: 0 })).toThrow();
  });

  it("rejects a non-positive maxCandidatesPerRun (the candidate-pool cap must be positive)", () => {
    expect(() => MemoryReasoningConfigSchema.parse({ maxCandidatesPerRun: 0 })).toThrow();
  });
});

describe("PerAgentConfigSchema memoryReasoning field", () => {
  it("accepts a memoryReasoning subtree on a per-agent config", () => {
    const result = PerAgentConfigSchema.parse({
      memoryReasoning: { enabled: true },
    });
    expect(result.memoryReasoning).toBeDefined();
    expect(result.memoryReasoning!.enabled).toBe(true);
  });

  it("treats memoryReasoning as optional (absent on a bare config)", () => {
    const result = PerAgentConfigSchema.parse({});
    expect(result.memoryReasoning).toBeUndefined();
  });
});
