// SPDX-License-Identifier: Apache-2.0
/**
 * Contract tests for the local (node-llama-cpp) embedding provider.
 *
 * Tests gated behind LLAMA_MODEL_PATH are silently skipped in normal
 * CI runs and only execute when the env var points to a valid GGUF model.
 * The invalid-model-path error handling test runs unconditionally.
 */

import { describe, it, expect } from "vitest";
import { createLocalEmbeddingProvider } from "./embedding-provider-local.js";

const LLAMA_MODEL_PATH = process.env.LLAMA_MODEL_PATH;

describe.skipIf(!LLAMA_MODEL_PATH)("Local embedding provider (contract test)", () => {
  it("creates provider successfully with valid model path", async () => {
    const result = await createLocalEmbeddingProvider({
      modelUri: LLAMA_MODEL_PATH!,
      modelsDir: "/tmp/comis-test-models",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.dimensions).toBeGreaterThan(0);
      expect(result.value.modelId).toBe(LLAMA_MODEL_PATH);
    }
  });

  it("generates embedding with correct dimensions", async () => {
    const createResult = await createLocalEmbeddingProvider({
      modelUri: LLAMA_MODEL_PATH!,
      modelsDir: "/tmp/comis-test-models",
    });
    expect(createResult.ok).toBe(true);
    if (!createResult.ok) return;

    const provider = createResult.value;
    const result = await provider.embed("Test text for local embedding");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBeInstanceOf(Array);
      expect(result.value.length).toBe(provider.dimensions);
      // All values should be finite numbers
      for (const val of result.value) {
        expect(Number.isFinite(val)).toBe(true);
      }
    }
  });

  it("generates batch embeddings", async () => {
    const createResult = await createLocalEmbeddingProvider({
      modelUri: LLAMA_MODEL_PATH!,
      modelsDir: "/tmp/comis-test-models",
    });
    expect(createResult.ok).toBe(true);
    if (!createResult.ok) return;

    const provider = createResult.value;
    const result = await provider.embedBatch(["Hello", "World"]);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toHaveLength(2);
      for (const embedding of result.value) {
        expect(embedding.length).toBe(provider.dimensions);
      }
    }
  });
});

// Ungated test: verify error handling with invalid model path
describe("Local embedding provider (error handling)", () => {
  it("handles invalid model path gracefully", async () => {
    const result = await createLocalEmbeddingProvider({
      modelUri: "/nonexistent/model.gguf",
      modelsDir: "/tmp/comis-test-models",
    });

    // Should return err() with a meaningful error, not crash
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(Error);
      expect(result.error.message.length).toBeGreaterThan(0);
    }
  });
});
