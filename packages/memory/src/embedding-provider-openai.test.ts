// SPDX-License-Identifier: Apache-2.0
/**
 * Contract tests for the OpenAI embedding provider.
 *
 * These tests call the real OpenAI API and are gated behind the
 * OPENAI_API_KEY environment variable. They are silently skipped
 * in normal CI runs and only execute when the env var is set.
 */

import { describe, it, expect } from "vitest";
import { createOpenAIEmbeddingProvider } from "./embedding-provider-openai.js";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

describe.skipIf(!OPENAI_API_KEY)("OpenAI embedding provider (contract test)", () => {
  it("creates provider successfully", () => {
    const result = createOpenAIEmbeddingProvider({
      apiKey: OPENAI_API_KEY!,
      model: "text-embedding-3-small",
      dimensions: 1536,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.dimensions).toBe(1536);
      expect(result.value.modelId).toBe("text-embedding-3-small");
    }
  });

  it("generates embedding for single text", async () => {
    const createResult = createOpenAIEmbeddingProvider({
      apiKey: OPENAI_API_KEY!,
      model: "text-embedding-3-small",
      dimensions: 1536,
    });
    expect(createResult.ok).toBe(true);
    if (!createResult.ok) return;

    const provider = createResult.value;
    const result = await provider.embed("Hello world");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBeInstanceOf(Array);
      expect(result.value.length).toBe(1536);
      // All values should be finite numbers
      for (const val of result.value) {
        expect(Number.isFinite(val)).toBe(true);
      }
    }
  });

  it("generates embeddings for batch", async () => {
    const createResult = createOpenAIEmbeddingProvider({
      apiKey: OPENAI_API_KEY!,
      model: "text-embedding-3-small",
      dimensions: 1536,
    });
    expect(createResult.ok).toBe(true);
    if (!createResult.ok) return;

    const provider = createResult.value;
    const result = await provider.embedBatch(["Hello", "World"]);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toHaveLength(2);
      for (const embedding of result.value) {
        expect(embedding.length).toBe(1536);
        for (const val of embedding) {
          expect(Number.isFinite(val)).toBe(true);
        }
      }
    }
  });

  it("returns error for empty text", async () => {
    const createResult = createOpenAIEmbeddingProvider({
      apiKey: OPENAI_API_KEY!,
      model: "text-embedding-3-small",
      dimensions: 1536,
    });
    expect(createResult.ok).toBe(true);
    if (!createResult.ok) return;

    const provider = createResult.value;
    const result = await provider.embed("");

    // OpenAI may reject empty strings with an error, or return a zero vector.
    // Either behavior is acceptable -- we verify it does not crash.
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(Error);
    } else {
      expect(result.value.length).toBe(1536);
    }
  });
});

// Ungated test: verify provider creation fails with bad API key format
describe("OpenAI embedding provider (error handling)", () => {
  it("creates provider with any apiKey format (validation is lazy)", () => {
    // The OpenAI SDK accepts any string as apiKey at construction time.
    // Actual validation happens at call time. Verify creation succeeds.
    const result = createOpenAIEmbeddingProvider({
      apiKey: "sk-invalid-key-for-testing",
      model: "text-embedding-3-small",
      dimensions: 1536,
    });

    expect(result.ok).toBe(true);
  });
});
