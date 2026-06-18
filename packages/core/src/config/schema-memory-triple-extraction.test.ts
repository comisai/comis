// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { MemoryTripleExtractionConfigSchema } from "./schema-memory-triple-extraction.js";
import { PerAgentConfigSchema } from "./schema-agent/index.js";

describe("MemoryTripleExtractionConfigSchema", () => {
  it("parses empty object with DEFAULT-ON defaults (opt-out — gated by the master cost switch)", () => {
    // Like the other cost jobs, triple extraction now defaults ON (opt-out) so the
    // complementary higher-recall S/P/O extraction from raw turns runs out of the box;
    // the master kill switch `memory.costFeatures.enabled` (default true) is the real gate.
    const result = MemoryTripleExtractionConfigSchema.parse({});
    expect(result).toEqual({
      enabled: true,
      schedule: "0 6 * * *",
      maxCandidatesPerRun: 200,
    });
  });

  it("defaults enabled to true", () => {
    expect(MemoryTripleExtractionConfigSchema.parse({}).enabled).toBe(true);
  });

  it("overrides only specified fields", () => {
    const result = MemoryTripleExtractionConfigSchema.parse({ enabled: true, maxCandidatesPerRun: 50 });
    expect(result.enabled).toBe(true);
    expect(result.maxCandidatesPerRun).toBe(50);
    expect(result.schedule).toBe("0 6 * * *");
  });

  it("rejects a non-positive maxCandidatesPerRun", () => {
    expect(() => MemoryTripleExtractionConfigSchema.parse({ maxCandidatesPerRun: 0 })).toThrow();
    expect(() => MemoryTripleExtractionConfigSchema.parse({ maxCandidatesPerRun: -1 })).toThrow();
  });

  it("rejects an unknown field (strictObject — a smuggled knob is refused at parse)", () => {
    expect(() => MemoryTripleExtractionConfigSchema.parse({ trust: "system" })).toThrow();
  });
});

describe("PerAgentConfigSchema memoryTripleExtraction field", () => {
  it("attaches memoryTripleExtraction (default-ON) without clobbering Plan 01's learningOutcome", () => {
    const result = PerAgentConfigSchema.parse({});
    // The new field lands beside learningOutcome (Plan 01) — both present, both default-ON (opt-out).
    expect(result.memoryTripleExtraction).toBeDefined();
    expect(result.memoryTripleExtraction!.enabled).toBe(true);
    expect(result.learningOutcome).toBeDefined();
    expect(result.learningOutcome!.enabled).toBe(true);
  });

  it("accepts an explicit memoryTripleExtraction opt-in", () => {
    const result = PerAgentConfigSchema.parse({ memoryTripleExtraction: { enabled: true } });
    expect(result.memoryTripleExtraction!.enabled).toBe(true);
  });
});
