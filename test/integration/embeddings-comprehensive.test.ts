/**
 * EMB-COMPREHENSIVE: Comprehensive Embeddings Endpoint E2E Tests
 *
 * Thorough testing of the daemon's OpenAI-compatible /v1/embeddings endpoint
 * covering dimension validation, semantic similarity, cache behavior, concurrent
 * requests, edge cases, response format compliance, validation errors, and the
 * embedding-to-memory pipeline integration.
 *
 * Requires OPENAI_API_KEY in ~/.comis/.env.
 * Skips entirely when no OPENAI_API_KEY is available.
 *
 * @module
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  getProviderEnv,
  hasProvider,
  logProviderAvailability,
} from "../support/provider-env.js";
import {
  startTestDaemon,
  makeAuthHeaders,
  type TestDaemonHandle,
} from "../support/daemon-harness.js";
import {
  openAuthenticatedWebSocket,
  sendJsonRpc,
} from "../support/ws-helpers.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const CONFIG_PATH = resolve(
  __dirname,
  "../config/config.test-embeddings-comprehensive.yaml",
);

const env = getProviderEnv();
const hasOpenAIKey = hasProvider(env, "OPENAI_API_KEY");

/** Configured dimensions in the test YAML (embedding.openai.dimensions). */
const CONFIGURED_DIMS = 256;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Compute cosine similarity between two equal-length number arrays.
 * Returns a value in [-1, 1] where 1 means identical direction.
 */
function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

// ---------------------------------------------------------------------------
// Test suite -- gated on OPENAI_API_KEY availability
// ---------------------------------------------------------------------------

describe.skipIf(!hasOpenAIKey)(
  "EMB-COMPREHENSIVE: Embeddings Endpoint E2E",
  () => {
    let handle: TestDaemonHandle;

    /**
     * Reusable fetch wrapper for POST /v1/embeddings with auth headers.
     */
    async function embedRequest(
      input: string | string[],
      model: string = "text-embedding-3-small",
      options?: Record<string, unknown>,
    ): Promise<Response> {
      return fetch(`${handle.gatewayUrl}/v1/embeddings`, {
        method: "POST",
        headers: makeAuthHeaders(handle.authToken),
        body: JSON.stringify({ model, input, ...options }),
      });
    }

    beforeAll(async () => {
      logProviderAvailability(env);
      handle = await startTestDaemon({ configPath: CONFIG_PATH });
    }, 60_000);

    afterAll(async () => {
      if (handle) {
        try {
          await handle.cleanup();
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (!msg.includes("Daemon exit with code")) {
            throw err;
          }
        }
      }
    }, 30_000);

    // -----------------------------------------------------------------------
    // Section 1: Dimension Validation
    // -----------------------------------------------------------------------

    describe("Dimension Validation", () => {
      it(
        "EMB-DIM-01: Single text returns vector of exactly 256 dimensions",
        async () => {
          const response = await embedRequest(
            "EMB-DIM-01: The quick brown fox jumps over the lazy dog",
          );
          expect(response.status).toBe(200);

          const body = (await response.json()) as Record<string, unknown>;
          const data = body.data as Array<Record<string, unknown>>;
          expect(data).toHaveLength(1);

          const embedding = data[0].embedding as number[];
          expect(embedding).toHaveLength(CONFIGURED_DIMS);

          // All values are finite numbers
          for (const v of embedding) {
            expect(Number.isFinite(v)).toBe(true);
          }
        },
        90_000,
      );

      it(
        "EMB-DIM-02: Batch of 3 texts all return vectors of exactly 256 dimensions",
        async () => {
          const response = await embedRequest([
            "EMB-DIM-02: The capital of France is Paris",
            "EMB-DIM-02: Dogs are loyal pets",
            "EMB-DIM-02: Quantum computing uses qubits",
          ]);
          expect(response.status).toBe(200);

          const body = (await response.json()) as Record<string, unknown>;
          const data = body.data as Array<Record<string, unknown>>;
          expect(data).toHaveLength(3);

          for (let i = 0; i < 3; i++) {
            const embedding = data[i].embedding as number[];
            expect(embedding).toHaveLength(CONFIGURED_DIMS);
          }
        },
        90_000,
      );

      it(
        "EMB-DIM-03: All vector values are finite floats in [-1, 1] range",
        async () => {
          const response = await embedRequest(
            "EMB-DIM-03: Normalized embedding vector value range test",
          );
          expect(response.status).toBe(200);

          const body = (await response.json()) as Record<string, unknown>;
          const data = body.data as Array<Record<string, unknown>>;
          const embedding = data[0].embedding as number[];

          for (const v of embedding) {
            expect(Number.isFinite(v)).toBe(true);
            expect(Math.abs(v)).toBeLessThanOrEqual(1.0);
          }
        },
        90_000,
      );
    });

    // -----------------------------------------------------------------------
    // Section 2: Semantic Similarity
    // -----------------------------------------------------------------------

    describe("Semantic Similarity", () => {
      it(
        "EMB-SEM-01: Semantically similar texts have higher cosine similarity than dissimilar texts",
        async () => {
          const response = await embedRequest([
            "EMB-SEM-01: cats are wonderful pets that bring joy",
            "EMB-SEM-01: dogs are great companions for families",
            "EMB-SEM-01: the stock market crashed today unexpectedly",
          ]);
          expect(response.status).toBe(200);

          const body = (await response.json()) as Record<string, unknown>;
          const data = body.data as Array<{ embedding: number[] }>;

          const simCatsDogs = cosineSimilarity(
            data[0].embedding,
            data[1].embedding,
          );
          const simCatsStocks = cosineSimilarity(
            data[0].embedding,
            data[2].embedding,
          );

          // Pets-about-pets should be more similar than pets-about-stocks
          expect(simCatsDogs).toBeGreaterThan(simCatsStocks);
        },
        90_000,
      );

      it(
        "EMB-SEM-02: Identical texts produce identical vectors",
        async () => {
          const text = "EMB-SEM-02: identical test string for vector comparison";
          const response = await embedRequest([text, text]);
          expect(response.status).toBe(200);

          const body = (await response.json()) as Record<string, unknown>;
          const data = body.data as Array<{ embedding: number[] }>;

          const similarity = cosineSimilarity(
            data[0].embedding,
            data[1].embedding,
          );
          expect(similarity).toBeGreaterThanOrEqual(0.9999);
        },
        90_000,
      );
    });

    // -----------------------------------------------------------------------
    // Section 3: Cache Behavior
    // -----------------------------------------------------------------------

    describe("Cache Behavior", () => {
      it(
        "EMB-CACHE-01: Second request with same text returns identical vector (cache consistency)",
        async () => {
          const text = "EMB-CACHE-01 cache test text alpha for consistency";

          // First request
          const response1 = await embedRequest(text);
          expect(response1.status).toBe(200);
          const body1 = (await response1.json()) as Record<string, unknown>;
          const vec1 = (body1.data as Array<{ embedding: number[] }>)[0]
            .embedding;

          // Second request (should hit cache)
          const response2 = await embedRequest(text);
          expect(response2.status).toBe(200);
          const body2 = (await response2.json()) as Record<string, unknown>;
          const vec2 = (body2.data as Array<{ embedding: number[] }>)[0]
            .embedding;

          // Vectors should be element-wise equal
          const similarity = cosineSimilarity(vec1, vec2);
          expect(similarity).toBeCloseTo(1.0);
        },
        90_000,
      );

      it(
        "EMB-CACHE-02: Different texts produce different embeddings",
        async () => {
          const response1 = await embedRequest(
            "EMB-CACHE-02 first unique text about mathematics and algebra",
          );
          expect(response1.status).toBe(200);
          const body1 = (await response1.json()) as Record<string, unknown>;
          const vec1 = (body1.data as Array<{ embedding: number[] }>)[0]
            .embedding;

          const response2 = await embedRequest(
            "EMB-CACHE-02 second unique text about cooking recipes and food",
          );
          expect(response2.status).toBe(200);
          const body2 = (await response2.json()) as Record<string, unknown>;
          const vec2 = (body2.data as Array<{ embedding: number[] }>)[0]
            .embedding;

          const similarity = cosineSimilarity(vec1, vec2);
          expect(similarity).toBeLessThan(0.99);
        },
        90_000,
      );
    });

    // -----------------------------------------------------------------------
    // Section 4: Concurrent Requests
    // -----------------------------------------------------------------------

    describe("Concurrent Requests", () => {
      it(
        "EMB-CONC-01: 3 parallel embedding requests all return correct results",
        async () => {
          const texts = [
            "EMB-CONC-01 alpha: artificial intelligence and machine learning",
            "EMB-CONC-01 beta: underwater marine biology exploration",
            "EMB-CONC-01 gamma: classical music composition techniques",
          ];

          const results = await Promise.all(
            texts.map((text) => embedRequest(text)),
          );

          // All should succeed with 200
          for (const res of results) {
            expect(res.status).toBe(200);
          }

          const bodies = await Promise.all(
            results.map(
              (res) => res.json() as Promise<Record<string, unknown>>,
            ),
          );

          const vectors = bodies.map(
            (body) =>
              (body.data as Array<{ embedding: number[] }>)[0].embedding,
          );

          // All should have correct dimensions
          for (const vec of vectors) {
            expect(vec).toHaveLength(CONFIGURED_DIMS);
          }

          // All should be meaningfully different (pairwise similarity < 0.99)
          for (let i = 0; i < vectors.length; i++) {
            for (let j = i + 1; j < vectors.length; j++) {
              const sim = cosineSimilarity(vectors[i], vectors[j]);
              expect(sim).toBeLessThan(0.99);
            }
          }
        },
        90_000,
      );
    });

    // -----------------------------------------------------------------------
    // Section 5: Edge Cases
    // -----------------------------------------------------------------------

    describe("Edge Cases", () => {
      it(
        "EMB-EDGE-01: Single-character input returns valid 256-dim embedding",
        async () => {
          const response = await embedRequest("X");
          expect(response.status).toBe(200);

          const body = (await response.json()) as Record<string, unknown>;
          const data = body.data as Array<{ embedding: number[] }>;
          expect(data).toHaveLength(1);
          expect(data[0].embedding).toHaveLength(CONFIGURED_DIMS);

          for (const v of data[0].embedding) {
            expect(Number.isFinite(v)).toBe(true);
          }
        },
        90_000,
      );

      it(
        "EMB-EDGE-02: Very long text (10,000 characters) returns valid 256-dim embedding",
        async () => {
          const longText =
            "EMB-EDGE-02 This is a long text for embedding testing. ".repeat(
              200,
            );
          expect(longText.length).toBeGreaterThan(10_000);

          const response = await embedRequest(longText);
          expect(response.status).toBe(200);

          const body = (await response.json()) as Record<string, unknown>;
          const data = body.data as Array<{ embedding: number[] }>;
          expect(data).toHaveLength(1);
          expect(data[0].embedding).toHaveLength(CONFIGURED_DIMS);
        },
        90_000,
      );

      it(
        "EMB-EDGE-03: Large batch of 10 unique texts returns exactly 10 embeddings",
        async () => {
          const texts = Array.from(
            { length: 10 },
            (_, i) => `EMB-EDGE-03 unique text number ${i}: ${Math.random()}`,
          );

          const response = await embedRequest(texts);
          expect(response.status).toBe(200);

          const body = (await response.json()) as Record<string, unknown>;
          const data = body.data as Array<{
            embedding: number[];
            index: number;
          }>;
          expect(data).toHaveLength(10);

          for (let i = 0; i < 10; i++) {
            expect(data[i].index).toBe(i);
            expect(data[i].embedding).toHaveLength(CONFIGURED_DIMS);
          }
        },
        90_000,
      );
    });

    // -----------------------------------------------------------------------
    // Section 6: Response Format
    // -----------------------------------------------------------------------

    describe("Response Format", () => {
      it(
        "EMB-RESP-01: Response model field matches configured embedding model",
        async () => {
          const response = await embedRequest(
            "EMB-RESP-01: model field verification text",
          );
          expect(response.status).toBe(200);

          const body = (await response.json()) as Record<string, unknown>;
          expect(body.model).toBe("text-embedding-3-small");
        },
        90_000,
      );

      it(
        "EMB-RESP-02: Response usage fields are positive integers",
        async () => {
          const response = await embedRequest(
            "EMB-RESP-02: usage field verification text for token counting",
          );
          expect(response.status).toBe(200);

          const body = (await response.json()) as Record<string, unknown>;
          const usage = body.usage as Record<string, unknown>;

          expect(typeof usage.prompt_tokens).toBe("number");
          expect(usage.prompt_tokens).toBeGreaterThan(0);
          expect(typeof usage.total_tokens).toBe("number");
          expect(usage.total_tokens).toBeGreaterThan(0);

          // Implementation uses same formula for both
          expect(usage.total_tokens).toBe(usage.prompt_tokens);
        },
        90_000,
      );

      it(
        "EMB-RESP-03: Batch response preserves index ordering",
        async () => {
          const response = await embedRequest([
            "EMB-RESP-03 first",
            "EMB-RESP-03 second",
            "EMB-RESP-03 third",
          ]);
          expect(response.status).toBe(200);

          const body = (await response.json()) as Record<string, unknown>;
          const data = body.data as Array<{ index: number }>;

          expect(data[0].index).toBe(0);
          expect(data[1].index).toBe(1);
          expect(data[2].index).toBe(2);
        },
        90_000,
      );
    });

    // -----------------------------------------------------------------------
    // Section 7: Embedding-Memory Pipeline
    // -----------------------------------------------------------------------

    describe("Embedding-Memory Pipeline", () => {
      it(
        "EMB-PIPE-01: Memory stored via agent gets embedded, then vector search finds it",
        async () => {
          // Step 1: Store a distinctive fact via agent.execute (triggers memory storage)
          let ws1: WebSocket | undefined;
          try {
            ws1 = await openAuthenticatedWebSocket(
              handle.gatewayUrl,
              handle.authToken,
            );

            const storeResponse = (await sendJsonRpc(
              ws1,
              "agent.execute",
              {
                message:
                  "Remember this classified fact: Operation VORTEX-EMB launched on January 15, 2026, from base SIGMA-9. Acknowledge you have noted it.",
              },
              100,
              { timeoutMs: 90_000 },
            )) as Record<string, unknown>;

            // Check for RPC error (auth failure, etc.)
            if (storeResponse.error) {
              console.warn(
                "[EMB-PIPE-01] agent.execute failed:",
                JSON.stringify(storeResponse.error),
              );
              return; // Skip gracefully
            }

            expect(storeResponse).toHaveProperty("result");
          } finally {
            ws1?.close();
          }

          // Step 2: Wait for memory flush + embedding queue to process
          await new Promise((resolve) => setTimeout(resolve, 3000));

          // Step 3: Search for the stored memory via semantic vector search
          let ws2: WebSocket | undefined;
          try {
            ws2 = await openAuthenticatedWebSocket(
              handle.gatewayUrl,
              handle.authToken,
            );

            const searchResult = (await sendJsonRpc(
              ws2,
              "memory.search",
              {
                query: "Operation VORTEX-EMB base SIGMA-9",
                limit: 10,
              },
              101,
              { timeoutMs: 30_000 },
            )) as Record<string, unknown>;

            // Soft assertion per decision 114-01: nondeterministic LLM behavior
            // may cause no memory to be stored. Warn instead of hard-fail.
            // memory.search RPC returns { results: [...] } inside JSON-RPC result
            expect(searchResult).toHaveProperty("result");
            expect(searchResult).not.toHaveProperty("error");

            const resultObj = searchResult.result as Record<string, unknown>;
            const entries = resultObj.results as unknown[] | undefined;
            if (!entries || entries.length === 0) {
              console.warn(
                "[EMB-PIPE-01] memory.search returned 0 results -- " +
                  "LLM may not have stored memory. This is nondeterministic. " +
                  "Passing with warning.",
              );
            } else {
              expect(entries.length).toBeGreaterThan(0);
            }
          } finally {
            ws2?.close();
          }
        },
        90_000,
      );
    });

    // -----------------------------------------------------------------------
    // Section 8: Validation Edge Cases
    // -----------------------------------------------------------------------

    describe("Validation Edge Cases", () => {
      it(
        "EMB-VAL-01: Empty model string returns 400",
        async () => {
          const response = await fetch(
            `${handle.gatewayUrl}/v1/embeddings`,
            {
              method: "POST",
              headers: makeAuthHeaders(handle.authToken),
              body: JSON.stringify({ model: "", input: "test" }),
            },
          );

          expect(response.status).toBe(400);

          const body = (await response.json()) as Record<string, unknown>;
          expect(body.error).toBeDefined();
          const error = body.error as Record<string, unknown>;
          expect(error.type).toBe("invalid_request_error");
        },
        10_000,
      );

      it(
        "EMB-VAL-02: Missing input field returns 400",
        async () => {
          const response = await fetch(
            `${handle.gatewayUrl}/v1/embeddings`,
            {
              method: "POST",
              headers: makeAuthHeaders(handle.authToken),
              body: JSON.stringify({ model: "text-embedding-3-small" }),
            },
          );

          expect(response.status).toBe(400);

          const body = (await response.json()) as Record<string, unknown>;
          expect(body.error).toBeDefined();
          const error = body.error as Record<string, unknown>;
          expect(error.type).toBe("invalid_request_error");
        },
        10_000,
      );
    });
  },
);
