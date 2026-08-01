// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { EmbeddingConfigSchema } from "./schema-embedding.js";

// ---------------------------------------------------------------------------
// The `embedding.multilingual` advisory config key. Fresh configurations use a
// multilingual local model. The advisory remains optional so health reporting
// infers the actual selected model unless an operator explicitly overrides it.
// ---------------------------------------------------------------------------

describe("EmbeddingConfigSchema — multilingual advisory key", () => {
  it("parses multilingual: true and yields multilingual === true", () => {
    const parsed = EmbeddingConfigSchema.parse({ multilingual: true });
    expect(parsed.multilingual).toBe(true);
  });

  it("parses multilingual: false and yields multilingual === false", () => {
    const parsed = EmbeddingConfigSchema.parse({ multilingual: false });
    expect(parsed.multilingual).toBe(false);
  });

  it("defaults to a multilingual local model without forcing the advisory", () => {
    const parsed = EmbeddingConfigSchema.parse({});
    expect(parsed.multilingual).toBeUndefined();
    expect(parsed.local.modelUri).toBe("hf:gpustack/bge-m3-GGUF:bge-m3-Q8_0.gguf");
  });

  it("does not claim an explicitly selected model is multilingual without a declaration", () => {
    const parsed = EmbeddingConfigSchema.parse({
      local: {
        modelUri:
          "hf:nomic-ai/nomic-embed-text-v1.5-GGUF:nomic-embed-text-v1.5.Q8_0.gguf",
      },
    });
    expect(parsed.multilingual).toBeUndefined();
  });

  it("throws on a typo'd key (multiligual) — z.strictObject rejects unknown keys", () => {
    expect(() => EmbeddingConfigSchema.parse({ multiligual: true })).toThrow();
  });
});
