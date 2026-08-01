// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { EmbeddingConfigSchema } from "./schema-embedding.js";

// ---------------------------------------------------------------------------
// The `embedding.multilingual` advisory config key. Fresh configurations use a
// multilingual local model and report that posture without relying on a model-id
// heuristic. Explicit overrides remain available for other embedders.
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

  it("defaults to a multilingual posture when omitted", () => {
    const parsed = EmbeddingConfigSchema.parse({});
    expect(parsed.multilingual).toBe(true);
    expect(parsed.local.modelUri).toBe("hf:gpustack/bge-m3-GGUF:bge-m3-Q8_0.gguf");
  });

  it("throws on a typo'd key (multiligual) — z.strictObject rejects unknown keys", () => {
    expect(() => EmbeddingConfigSchema.parse({ multiligual: true })).toThrow();
  });
});
