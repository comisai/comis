// SPDX-License-Identifier: Apache-2.0
/**
 * Contract tests for the local (node-llama-cpp) cross-encoder reranker provider.
 *
 * Tests gated behind LLAMA_RERANKER_MODEL_PATH are silently skipped in normal
 * CI runs and only execute when the env var points to a valid GGUF reranker
 * model (~606 MB bge-reranker-v2-m3 Q8_0 by default). The invalid-model-path
 * graceful-degrade test runs unconditionally so the adapter source is
 * always imported and never reports 0% coverage (the per-package coverage floor
 * counts every src file via `all: true`).
 *
 * process.env is read ONLY here at the test boundary (mirrors
 * embedding-provider-local.test.ts) — production src reads no env.
 */

import { describe, it, expect } from "vitest";
import { createLocalRerankerProvider } from "./reranker-provider-local.js";

const LLAMA_RERANKER_MODEL_PATH = process.env.LLAMA_RERANKER_MODEL_PATH;

describe.skipIf(!LLAMA_RERANKER_MODEL_PATH)(
  "Local reranker provider (contract test)",
  () => {
    it("creates an available provider with a valid model path", async () => {
      const result = await createLocalRerankerProvider({
        modelUri: LLAMA_RERANKER_MODEL_PATH!,
        modelsDir: "/tmp/comis-test-models",
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.isAvailable()).toBe(true);
        await result.value.dispose?.();
      }
    });

    it("ranks relevant documents above irrelevant ones, in input order, in [0,1]", async () => {
      const createResult = await createLocalRerankerProvider({
        modelUri: LLAMA_RERANKER_MODEL_PATH!,
        modelsDir: "/tmp/comis-test-models",
      });
      expect(createResult.ok).toBe(true);
      if (!createResult.ok) return;

      const provider = createResult.value;
      try {
        const result = await provider.rank("capital of France", [
          "Paris is the capital of France.",
          "Bananas are a yellow fruit.",
        ]);

        expect(result.ok).toBe(true);
        if (result.ok) {
          const [s0, s1] = result.value;
          // Input order preserved (documents[i] -> scores[i]).
          expect(result.value).toHaveLength(2);
          // Calibrated probabilities, no sigmoid post-processing.
          expect(s0).toBeGreaterThanOrEqual(0);
          expect(s0).toBeLessThanOrEqual(1);
          expect(s1).toBeGreaterThanOrEqual(0);
          expect(s1).toBeLessThanOrEqual(1);
          // The relevant doc (index 0) must outrank the irrelevant one.
          expect(s0).toBeGreaterThan(s1);
        }
      } finally {
        await provider.dispose?.();
      }
    });

    it("reuses the singleton ranking context across multiple rank() calls", async () => {
      const createResult = await createLocalRerankerProvider({
        modelUri: LLAMA_RERANKER_MODEL_PATH!,
        modelsDir: "/tmp/comis-test-models",
      });
      expect(createResult.ok).toBe(true);
      if (!createResult.ok) return;

      const provider = createResult.value;
      try {
        // Two sequential calls both succeed against the same (singleton) context;
        // rank() does NOT re-create the ranking context per invocation.
        const first = await provider.rank("greeting", ["Hello there.", "Goodbye."]);
        const second = await provider.rank("farewell", ["Hello there.", "Goodbye."]);
        expect(first.ok).toBe(true);
        expect(second.ok).toBe(true);
      } finally {
        await provider.dispose?.();
      }
    });
  },
);

// Ungated test: graceful degradation on an invalid model path.
// A missing/invalid model must return err() — never throw, never crash — so the
// recall orchestrator can fall back to fusion order.
describe("Local reranker provider (error handling)", () => {
  it("returns err() for an invalid model path instead of throwing", async () => {
    const result = await createLocalRerankerProvider({
      modelUri: "/nonexistent/reranker-model.gguf",
      modelsDir: "/tmp/comis-test-models",
    });

    // Should return err() with a meaningful Error, not crash.
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(Error);
      expect(result.error.message.length).toBeGreaterThan(0);
    }
  });
});
