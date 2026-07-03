// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { MemoryConfigSchema } from "./schema-memory.js";

const RERANKER_Q8_SLUG =
  "hf:gpustack/bge-reranker-v2-m3-GGUF:bge-reranker-v2-m3-Q8_0.gguf";

describe("MemoryConfigSchema reranker fields", () => {
  it("defaults recall.rerankerModel to the bge-reranker-v2-m3 Q8_0 GGUF slug (nested under memory.recall)", () => {
    const result = MemoryConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.recall.rerankerModel).toBe(RERANKER_Q8_SLUG);
      // Guard the load-bearing quant token explicitly (Q4_K_M measured slower).
      expect(result.data.recall.rerankerModel).toContain("bge-reranker-v2-m3-Q8_0");
    }
  });

  it("defaults rerankerModelsDir to 'models' and rerankerGpu to 'auto'", () => {
    const result = MemoryConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.rerankerModelsDir).toBe("models");
      expect(result.data.rerankerGpu).toBe("auto");
    }
  });

  it("defaults rerankerThreads to 4 (4-8 CPU-contention bound)", () => {
    const result = MemoryConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.rerankerThreads).toBe(4);
    }
  });

  it("accepts a positive-integer rerankerThreads override and rejects non-positive / non-integer", () => {
    expect(MemoryConfigSchema.safeParse({ rerankerThreads: 8 }).success).toBe(true);
    expect(MemoryConfigSchema.safeParse({ rerankerThreads: 0 }).success).toBe(false);
    expect(MemoryConfigSchema.safeParse({ rerankerThreads: -1 }).success).toBe(false);
    expect(MemoryConfigSchema.safeParse({ rerankerThreads: 2.5 }).success).toBe(false);
  });

  it("accepts every valid rerankerGpu enum member", () => {
    for (const gpu of ["auto", "metal", "cuda", "vulkan", "false"] as const) {
      const result = MemoryConfigSchema.safeParse({ rerankerGpu: gpu });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.rerankerGpu).toBe(gpu);
      }
    }
  });

  it("rejects a bogus rerankerGpu value (enum-bounded)", () => {
    const result = MemoryConfigSchema.safeParse({ rerankerGpu: "bogus" });
    expect(result.success).toBe(false);
  });

  it("accepts a local-path recall.rerankerModel override (string, no hf: prefix required)", () => {
    const result = MemoryConfigSchema.safeParse({
      recall: { rerankerModel: "/srv/models/bge-reranker.gguf" },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.recall.rerankerModel).toBe("/srv/models/bge-reranker.gguf");
    }
  });

  it("leaves the existing MemoryConfig defaults untouched (recall keepers nested under memory.recall)", () => {
    const result = MemoryConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.dbPath).toBe("memory.db");
      expect(result.data.walMode).toBe(true);
      expect(result.data.recall.embeddingModel).toBe("text-embedding-3-small");
      expect(result.data.recall.embeddingDimensions).toBe(1536);
      expect(result.data.compaction).toEqual({
        enabled: true,
        threshold: 1000,
        targetSize: 500,
      });
      expect(result.data.retention).toEqual({ maxAgeDays: 0 });
    }
  });

  it("rejects an unknown key (strictObject)", () => {
    const result = MemoryConfigSchema.safeParse({ rerankerUnknown: 1 });
    expect(result.success).toBe(false);
  });

  it("the recall keys only exist nested — a config using flat memory.embeddingModel/rerankerModel is rejected", () => {
    expect(MemoryConfigSchema.safeParse({ embeddingModel: "x" }).success).toBe(false);
    expect(MemoryConfigSchema.safeParse({ rerankerModel: "x" }).success).toBe(false);
    expect(MemoryConfigSchema.safeParse({ embeddingDimensions: 1536 }).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// memory.enabled master kill switch
//
// A single top-level gate that, when `false`, force-disables ALL LLM
// cost-bearing memory + learning features (the crons + the learning layer + the
// dialectic tool) regardless of their per-agent config. Default TRUE (opt-out), so a
// bare config is byte-identical (the gate is on but gates nothing until a per-agent
// feature is enabled). There is NO nested costFeatures block (no alias, no compat shim).
// ---------------------------------------------------------------------------

describe("MemoryConfigSchema enabled master kill switch", () => {
  it("defaults enabled to true (the opt-out posture — operator disables)", () => {
    const result = MemoryConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.enabled).toBe(true);
    }
  });

  it("accepts enabled: false (the operator escape hatch)", () => {
    const result = MemoryConfigSchema.safeParse({ enabled: false });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.enabled).toBe(false);
    }
  });

  it("rejects a non-boolean enabled", () => {
    expect(MemoryConfigSchema.safeParse({ enabled: "nope" }).success).toBe(false);
  });

  it("a costFeatures nested key is rejected — memory.enabled is the only gate (z.strictObject, no compat shim)", () => {
    expect(MemoryConfigSchema.safeParse({ costFeatures: { enabled: true } }).success).toBe(false);
    expect(MemoryConfigSchema.safeParse({ costFeatures: { enabled: false } }).success).toBe(false);
  });
});
