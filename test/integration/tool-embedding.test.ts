/**
 * Integration tests for OpenAI embedding provider with real API calls.
 *
 * Validates embed(), embedBatch(), and vector dimensionality. Uses Phase 111
 * provider-env infrastructure. Skips when OPENAI_API_KEY is not available.
 */

import { describe, it, expect } from "vitest";
import {
  getProviderEnv,
  hasProvider,
  isAuthError,
} from "../support/provider-env.js";
import { createOpenAIEmbeddingProvider } from "@comis/memory";

// ---------------------------------------------------------------------------
// Provider detection (synchronous for describe.skipIf)
// ---------------------------------------------------------------------------

const env = getProviderEnv();
const hasOpenAI = hasProvider(env, "OPENAI_API_KEY");

// ---------------------------------------------------------------------------
// TOOL-EMBED: OpenAI Embedding Provider Integration
// ---------------------------------------------------------------------------

describe.skipIf(!hasOpenAI)(
  "TOOL-EMBED: OpenAI Embedding Provider Integration",
  () => {
    // -----------------------------------------------------------------------
    // EMBED-01: embed() returns vector of correct dimensions
    // -----------------------------------------------------------------------
    it(
      "EMBED-01: embed() returns vector of correct dimensions",
      async () => {
        try {
          const factory = createOpenAIEmbeddingProvider({
            apiKey: env.OPENAI_API_KEY!,
            model: "text-embedding-3-small",
            dimensions: 1536,
          });
          expect(factory.ok).toBe(true);
          if (!factory.ok) return;

          const result = await factory.value.embed(
            "Integration test text for embedding",
          );
          expect(result.ok).toBe(true);
          if (!result.ok) return;

          expect(result.value).toHaveLength(1536);
          expect(
            result.value.every(
              (v) => typeof v === "number" && Number.isFinite(v),
            ),
          ).toBe(true);
        } catch (error: unknown) {
          if (isAuthError(error)) {
            console.warn(
              "[EMBED-01] Skipping: OpenAI API key is invalid or expired",
            );
            return;
          }
          throw error;
        }
      },
      30_000,
    );

    // -----------------------------------------------------------------------
    // EMBED-02: embedBatch() returns multiple vectors
    // -----------------------------------------------------------------------
    it(
      "EMBED-02: embedBatch() returns multiple vectors",
      async () => {
        try {
          const factory = createOpenAIEmbeddingProvider({
            apiKey: env.OPENAI_API_KEY!,
            model: "text-embedding-3-small",
            dimensions: 1536,
          });
          expect(factory.ok).toBe(true);
          if (!factory.ok) return;

          const result = await factory.value.embedBatch([
            "Hello world",
            "Embedding test",
            "Integration testing",
          ]);
          expect(result.ok).toBe(true);
          if (!result.ok) return;

          expect(result.value).toHaveLength(3);
          for (const vec of result.value) {
            expect(vec).toHaveLength(1536);
            expect(
              vec.every(
                (v) => typeof v === "number" && Number.isFinite(v),
              ),
            ).toBe(true);
          }
        } catch (error: unknown) {
          if (isAuthError(error)) {
            console.warn(
              "[EMBED-02] Skipping: OpenAI API key is invalid or expired",
            );
            return;
          }
          throw error;
        }
      },
      30_000,
    );

    // -----------------------------------------------------------------------
    // EMBED-03: embed() produces different vectors for semantically different texts
    // -----------------------------------------------------------------------
    it(
      "EMBED-03: embed() produces different vectors for semantically different texts",
      async () => {
        try {
          const factory = createOpenAIEmbeddingProvider({
            apiKey: env.OPENAI_API_KEY!,
            model: "text-embedding-3-small",
            dimensions: 1536,
          });
          expect(factory.ok).toBe(true);
          if (!factory.ok) return;

          const resultA = await factory.value.embed(
            "The cat sat on the mat",
          );
          const resultB = await factory.value.embed(
            "Quantum computing uses qubits",
          );

          expect(resultA.ok).toBe(true);
          expect(resultB.ok).toBe(true);
          if (!resultA.ok || !resultB.ok) return;

          expect(resultA.value).toHaveLength(1536);
          expect(resultB.value).toHaveLength(1536);

          // Compute cosine similarity
          let dot = 0;
          let magA = 0;
          let magB = 0;
          for (let i = 0; i < 1536; i++) {
            dot += resultA.value[i] * resultB.value[i];
            magA += resultA.value[i] * resultA.value[i];
            magB += resultB.value[i] * resultB.value[i];
          }
          const cosineSimilarity = dot / (Math.sqrt(magA) * Math.sqrt(magB));

          // Semantically very different texts should not be near-identical
          expect(cosineSimilarity).toBeLessThan(0.95);
        } catch (error: unknown) {
          if (isAuthError(error)) {
            console.warn(
              "[EMBED-03] Skipping: OpenAI API key is invalid or expired",
            );
            return;
          }
          throw error;
        }
      },
      30_000,
    );

    // -----------------------------------------------------------------------
    // EMBED-04: provider exposes correct dimensions and modelId
    // -----------------------------------------------------------------------
    it(
      "EMBED-04: provider exposes correct dimensions and modelId",
      async () => {
        const factory = createOpenAIEmbeddingProvider({
          apiKey: env.OPENAI_API_KEY!,
          model: "text-embedding-3-small",
          dimensions: 1536,
        });
        expect(factory.ok).toBe(true);
        if (!factory.ok) return;

        expect(factory.value.dimensions).toBe(1536);
        expect(factory.value.modelId).toBe("text-embedding-3-small");
      },
      10_000,
    );
  },
);
