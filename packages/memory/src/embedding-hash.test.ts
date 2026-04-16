import { createHash } from "node:crypto";
import { describe, it, expect } from "vitest";
import { computeEmbeddingIdentityHash } from "./embedding-hash.js";

describe("computeEmbeddingIdentityHash", () => {
  it("produces SHA-256 of modelId:dimensions", () => {
    const expected = createHash("sha256")
      .update("text-embedding-3-small:1536")
      .digest("hex");
    expect(computeEmbeddingIdentityHash("text-embedding-3-small", 1536)).toBe(expected);
  });

  it("returns full 64-char hex (no truncation)", () => {
    const hash = computeEmbeddingIdentityHash("any-model", 768);
    expect(hash).toHaveLength(64);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is deterministic (same input = same output)", () => {
    const a = computeEmbeddingIdentityHash("nomic-embed-text", 384);
    const b = computeEmbeddingIdentityHash("nomic-embed-text", 384);
    expect(a).toBe(b);
  });

  it("differs when modelId differs", () => {
    const a = computeEmbeddingIdentityHash("model-a", 768);
    const b = computeEmbeddingIdentityHash("model-b", 768);
    expect(a).not.toBe(b);
  });

  it("differs when dimensions differ", () => {
    const a = computeEmbeddingIdentityHash("text-embedding-3-small", 768);
    const b = computeEmbeddingIdentityHash("text-embedding-3-small", 1536);
    expect(a).not.toBe(b);
  });
});
