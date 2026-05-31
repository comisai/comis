// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { MemoryConfigSchema } from "./schema-memory.js";

const RERANKER_Q8_SLUG =
  "hf:gpustack/bge-reranker-v2-m3-GGUF:bge-reranker-v2-m3-Q8_0.gguf";

describe("MemoryConfigSchema reranker fields", () => {
  it("defaults rerankerModel to the Phase-79 bge-reranker-v2-m3 Q8_0 GGUF slug", () => {
    const result = MemoryConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.rerankerModel).toBe(RERANKER_Q8_SLUG);
      // Guard the load-bearing quant token explicitly (Q4_K_M measured slower).
      expect(result.data.rerankerModel).toContain("bge-reranker-v2-m3-Q8_0");
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

  it("defaults rerankerThreads to 4 (Phase-79 4-8 CPU-contention bound)", () => {
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

  it("accepts a local-path rerankerModel override (string, no hf: prefix required)", () => {
    const result = MemoryConfigSchema.safeParse({
      rerankerModel: "/srv/models/bge-reranker.gguf",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.rerankerModel).toBe("/srv/models/bge-reranker.gguf");
    }
  });

  it("leaves the existing MemoryConfig defaults untouched", () => {
    const result = MemoryConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.dbPath).toBe("memory.db");
      expect(result.data.walMode).toBe(true);
      expect(result.data.embeddingModel).toBe("text-embedding-3-small");
      expect(result.data.embeddingDimensions).toBe(1536);
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
});
