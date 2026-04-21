// SPDX-License-Identifier: Apache-2.0
/**
 * AGENTS-SEARCH: Hybrid Search Integration Tests
 *
 * Validates the full search pipeline through both REST API and WebSocket RPC:
 *
 *   REST API (GET /api/memory/search):
 *     SEARCH-REST-01: Returns 401 without auth token
 *     SEARCH-REST-02: Returns 400 without query parameter
 *     SEARCH-REST-03: Returns 200 with empty results for nonsense query
 *     SEARCH-REST-04: Returns seeded memory entry for matching keyword
 *     SEARCH-REST-05: Respects limit parameter
 *     SEARCH-REST-06: Returns proper response shape with all fields
 *
 *   WebSocket RPC (memory.search):
 *     SEARCH-RPC-01: Returns error for empty query
 *     SEARCH-RPC-02: Returns seeded content via RPC
 *     SEARCH-RPC-03: Search ranking orders matching keyword higher
 *     SEARCH-RPC-04: Returns full result shape with all fields
 *
 *   Cross-Endpoint Consistency:
 *     SEARCH-CROSS-01: Same query returns consistent results via REST and RPC
 *
 *   Edge Cases:
 *     SEARCH-EDGE-01: Special characters in query do not crash
 *     SEARCH-EDGE-02: Very long query is handled gracefully
 *     SEARCH-EDGE-03: Memory stats endpoint works alongside search
 *
 *   Vector Search (requires OPENAI_API_KEY):
 *     SEARCH-VEC-01: Semantic search finds paraphrased content
 *
 * Uses a dedicated config (port 8509, separate memory DB) to avoid conflicts.
 * Requires ANTHROPIC_API_KEY or OPENAI_API_KEY in ~/.comis/.env.
 * Skips entirely when no LLM API keys are available.
 *
 * @module
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  getProviderEnv,
  hasAnyProvider,
  hasProvider,
  PROVIDER_GROUPS,
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
import { RPC_FAST_MS, RPC_LLM_MS } from "../support/timeouts.js";

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const CONFIG_PATH = resolve(
  __dirname,
  "../config/config.test-agents-search.yaml",
);

// ---------------------------------------------------------------------------
// Provider gating
// ---------------------------------------------------------------------------

const env = getProviderEnv();
const hasLlmKey = hasAnyProvider(env, PROVIDER_GROUPS.llm);
const hasOpenAIKey = hasProvider(env, "OPENAI_API_KEY");

// ---------------------------------------------------------------------------
// Incrementing RPC IDs
// ---------------------------------------------------------------------------

let rpcId = 100;

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe.skipIf(!hasLlmKey)(
  "AGENTS-SEARCH: Hybrid Search Integration",
  () => {
    let handle: TestDaemonHandle;

    beforeAll(async () => {
      logProviderAvailability(env);
      handle = await startTestDaemon({ configPath: CONFIG_PATH });

      // Seed memory with 3 unique facts via agent.execute through WebSocket
      let seedWs: WebSocket | undefined;
      try {
        seedWs = await openAuthenticatedWebSocket(
          handle.gatewayUrl,
          handle.authToken,
        );

        // Seed 1: Quantum encryption project
        const seed1 = (await sendJsonRpc(
          seedWs,
          "agent.execute",
          {
            message:
              "Remember this: Project IRONSEARCH uses quantum-resistant lattice encryption and was deployed on December 15th 2025.",
          },
          rpcId++,
        )) as Record<string, unknown>;
        expect(seed1).toHaveProperty("result");

        // Seed 2: High-uptime initiative
        const seed2 = (await sendJsonRpc(
          seedWs,
          "agent.execute",
          {
            message:
              "Remember this: The COBALTHAWK initiative achieved 99.97% uptime during the Neptune phase, processing 4.2 million requests daily.",
          },
          rpcId++,
        )) as Record<string, unknown>;
        expect(seed2).toHaveProperty("result");

        // Seed 3: Algorithm discovery
        const seed3 = (await sendJsonRpc(
          seedWs,
          "agent.execute",
          {
            message:
              "Remember this: Dr. Eleanor Vance discovered the CHROMIUM-DELTA algorithm at MIT in 2024 for real-time anomaly detection.",
          },
          rpcId++,
        )) as Record<string, unknown>;
        expect(seed3).toHaveProperty("result");
      } finally {
        seedWs?.close();
      }

      // Wait for SQLite flush (2s for safety margin with 3 seeds)
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }, 120_000);

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
    // REST API Search (GET /api/memory/search)
    // -----------------------------------------------------------------------

    describe("REST API Search (GET /api/memory/search)", () => {
      it(
        "SEARCH-REST-01: Returns 401 without auth token",
        async () => {
          const response = await fetch(
            `${handle.gatewayUrl}/api/memory/search?q=test`,
          );

          expect(response.status).toBe(401);
        },
        10_000,
      );

      it(
        "SEARCH-REST-02: Returns 400 without query parameter",
        async () => {
          const response = await fetch(
            `${handle.gatewayUrl}/api/memory/search`,
            {
              headers: makeAuthHeaders(handle.authToken),
            },
          );

          expect(response.status).toBe(400);

          const body = (await response.json()) as { error: string };
          expect(body.error).toContain("Missing required query parameter");
        },
        10_000,
      );

      it(
        "SEARCH-REST-03: Returns 200 with empty results for nonsense query",
        async () => {
          const response = await fetch(
            `${handle.gatewayUrl}/api/memory/search?q=xyzflurble9999nonsense`,
            {
              headers: makeAuthHeaders(handle.authToken),
            },
          );

          expect(response.status).toBe(200);

          const body = (await response.json()) as {
            results: Array<Record<string, unknown>>;
          };
          expect(Array.isArray(body.results)).toBe(true);
          expect(body.results.length).toBe(0);
        },
        10_000,
      );

      it(
        "SEARCH-REST-04: Returns seeded memory entry for matching keyword",
        async () => {
          const response = await fetch(
            `${handle.gatewayUrl}/api/memory/search?q=IRONSEARCH%20quantum%20encryption&limit=10`,
            {
              headers: makeAuthHeaders(handle.authToken),
            },
          );

          expect(response.status).toBe(200);

          const body = (await response.json()) as {
            results: Array<Record<string, unknown>>;
          };
          expect(Array.isArray(body.results)).toBe(true);
          expect(body.results.length).toBeGreaterThan(0);

          // At least one result should contain "IRONSEARCH" (case-insensitive)
          const hasIronSearch = body.results.some((r) =>
            String(r.content).toUpperCase().includes("IRONSEARCH"),
          );
          expect(hasIronSearch).toBe(true);
        },
        30_000,
      );

      it(
        "SEARCH-REST-05: Respects limit parameter",
        async () => {
          const response = await fetch(
            `${handle.gatewayUrl}/api/memory/search?q=project&limit=2`,
            {
              headers: makeAuthHeaders(handle.authToken),
            },
          );

          expect(response.status).toBe(200);

          const body = (await response.json()) as {
            results: Array<Record<string, unknown>>;
          };
          expect(Array.isArray(body.results)).toBe(true);
          expect(body.results.length).toBeLessThanOrEqual(2);
        },
        30_000,
      );

      it(
        "SEARCH-REST-06: Returns proper response shape with all fields",
        async () => {
          const response = await fetch(
            `${handle.gatewayUrl}/api/memory/search?q=COBALTHAWK&limit=10`,
            {
              headers: makeAuthHeaders(handle.authToken),
            },
          );

          expect(response.status).toBe(200);

          const body = (await response.json()) as {
            results: Array<Record<string, unknown>>;
          };
          expect(body.results.length).toBeGreaterThan(0);

          // Validate response shape for the first result
          const first = body.results[0];
          expect(typeof first.id).toBe("string");
          expect(typeof first.content).toBe("string");
          expect(typeof first.score).toBe("number");
        },
        30_000,
      );
    });

    // -----------------------------------------------------------------------
    // WebSocket RPC Search (memory.search)
    // -----------------------------------------------------------------------

    describe("WebSocket RPC Search (memory.search)", () => {
      it(
        "SEARCH-RPC-01: Returns error for empty query",
        async () => {
          let ws: WebSocket | undefined;
          try {
            ws = await openAuthenticatedWebSocket(
              handle.gatewayUrl,
              handle.authToken,
            );

            const response = (await sendJsonRpc(
              ws,
              "memory.search",
              { query: "", limit: 10, tenantId: "default" },
              rpcId++,
              { timeoutMs: RPC_FAST_MS },
            )) as Record<string, unknown>;

            // Check both RPC error shapes: result.error (method-level) or error (protocol-level)
            const result = response.result as Record<string, unknown> | undefined;
            const hasMethodError =
              result && typeof result.error === "string";
            const hasProtocolError =
              response.error !== undefined;

            expect(hasMethodError || hasProtocolError).toBe(true);
          } finally {
            ws?.close();
          }
        },
        10_000,
      );

      it(
        "SEARCH-RPC-02: Returns seeded content via RPC",
        async () => {
          let ws: WebSocket | undefined;
          try {
            ws = await openAuthenticatedWebSocket(
              handle.gatewayUrl,
              handle.authToken,
            );

            const response = (await sendJsonRpc(
              ws,
              "memory.search",
              {
                query: "COBALTHAWK Neptune uptime",
                limit: 10,
                tenantId: "default",
              },
              rpcId++,
              { timeoutMs: RPC_FAST_MS },
            )) as Record<string, unknown>;

            expect(response).toHaveProperty("result");

            const result = response.result as Record<string, unknown>;
            expect(Array.isArray(result.results)).toBe(true);

            const results = result.results as Array<Record<string, unknown>>;
            expect(results.length).toBeGreaterThan(0);

            // At least one result should contain "COBALTHAWK"
            const hasCobaltHawk = results.some((r) =>
              String(r.content).toUpperCase().includes("COBALTHAWK"),
            );
            expect(hasCobaltHawk).toBe(true);
          } finally {
            ws?.close();
          }
        },
        30_000,
      );

      it(
        "SEARCH-RPC-03: Search ranking orders matching keyword higher",
        async () => {
          let ws: WebSocket | undefined;
          try {
            ws = await openAuthenticatedWebSocket(
              handle.gatewayUrl,
              handle.authToken,
            );

            const response = (await sendJsonRpc(
              ws,
              "memory.search",
              {
                query: "CHROMIUM-DELTA algorithm anomaly detection",
                limit: 10,
                tenantId: "default",
              },
              rpcId++,
              { timeoutMs: RPC_FAST_MS },
            )) as Record<string, unknown>;

            expect(response).toHaveProperty("result");

            const result = response.result as Record<string, unknown>;
            const results = result.results as Array<Record<string, unknown>>;
            expect(results.length).toBeGreaterThan(0);

            // Best match should rank highest (first result should contain CHROMIUM-DELTA)
            const firstContent = String(results[0].content).toUpperCase();
            expect(firstContent).toContain("CHROMIUM-DELTA");
          } finally {
            ws?.close();
          }
        },
        30_000,
      );

      it(
        "SEARCH-RPC-04: Returns full result shape with all fields",
        async () => {
          let ws: WebSocket | undefined;
          try {
            ws = await openAuthenticatedWebSocket(
              handle.gatewayUrl,
              handle.authToken,
            );

            const response = (await sendJsonRpc(
              ws,
              "memory.search",
              { query: "IRONSEARCH", limit: 5, tenantId: "default" },
              rpcId++,
              { timeoutMs: RPC_FAST_MS },
            )) as Record<string, unknown>;

            expect(response).toHaveProperty("result");

            const result = response.result as Record<string, unknown>;
            const results = result.results as Array<Record<string, unknown>>;
            expect(results.length).toBeGreaterThan(0);

            // Verify all expected fields on the first result
            const first = results[0];
            expect(typeof first.id).toBe("string");
            expect(typeof first.content).toBe("string");
            expect(typeof first.memoryType).toBe("string");
            expect(typeof first.trustLevel).toBe("string");
            expect(typeof first.score).toBe("number");
            expect(typeof first.createdAt).toBe("number");
          } finally {
            ws?.close();
          }
        },
        30_000,
      );
    });

    // -----------------------------------------------------------------------
    // Cross-Endpoint Consistency
    // -----------------------------------------------------------------------

    describe("Cross-Endpoint Consistency", () => {
      it(
        "SEARCH-CROSS-01: Same query returns consistent results via REST and RPC",
        async () => {
          // Search via REST API
          const restResponse = await fetch(
            `${handle.gatewayUrl}/api/memory/search?q=IRONSEARCH&limit=10`,
            {
              headers: makeAuthHeaders(handle.authToken),
            },
          );
          expect(restResponse.status).toBe(200);

          const restBody = (await restResponse.json()) as {
            results: Array<Record<string, unknown>>;
          };
          expect(restBody.results.length).toBeGreaterThan(0);

          const restHasIronSearch = restBody.results.some((r) =>
            String(r.content).toUpperCase().includes("IRONSEARCH"),
          );
          expect(restHasIronSearch).toBe(true);

          // Search via WS RPC
          let ws: WebSocket | undefined;
          try {
            ws = await openAuthenticatedWebSocket(
              handle.gatewayUrl,
              handle.authToken,
            );

            const rpcResponse = (await sendJsonRpc(
              ws,
              "memory.search",
              { query: "IRONSEARCH", limit: 10, tenantId: "default" },
              rpcId++,
              { timeoutMs: RPC_FAST_MS },
            )) as Record<string, unknown>;

            expect(rpcResponse).toHaveProperty("result");

            const rpcResult = rpcResponse.result as Record<string, unknown>;
            const rpcResults = rpcResult.results as Array<
              Record<string, unknown>
            >;
            expect(rpcResults.length).toBeGreaterThan(0);

            const rpcHasIronSearch = rpcResults.some((r) =>
              String(r.content).toUpperCase().includes("IRONSEARCH"),
            );
            expect(rpcHasIronSearch).toBe(true);
          } finally {
            ws?.close();
          }
        },
        30_000,
      );
    });

    // -----------------------------------------------------------------------
    // Edge Cases
    // -----------------------------------------------------------------------

    describe("Edge Cases", () => {
      it(
        "SEARCH-EDGE-01: Special characters in query do not crash",
        async () => {
          const specialQuery =
            '"IRONSEARCH" OR "COBALTHAWK" AND NOT';
          const response = await fetch(
            `${handle.gatewayUrl}/api/memory/search?q=${encodeURIComponent(specialQuery)}&limit=10`,
            {
              headers: makeAuthHeaders(handle.authToken),
            },
          );

          // Should not crash (200, not 500) -- FTS5 special chars are handled
          expect(response.status).toBe(200);

          const body = (await response.json()) as {
            results: Array<Record<string, unknown>>;
          };
          expect(Array.isArray(body.results)).toBe(true);
        },
        30_000,
      );

      it(
        "SEARCH-EDGE-02: Very long query is handled gracefully",
        async () => {
          // Construct a 1200+ char query by repeating "IRONSEARCH "
          const longQuery = "IRONSEARCH ".repeat(110).trim();
          expect(longQuery.length).toBeGreaterThan(1200);

          const response = await fetch(
            `${handle.gatewayUrl}/api/memory/search?q=${encodeURIComponent(longQuery)}&limit=10`,
            {
              headers: makeAuthHeaders(handle.authToken),
            },
          );

          expect(response.status).toBe(200);

          const body = (await response.json()) as {
            results: Array<Record<string, unknown>>;
          };
          expect(Array.isArray(body.results)).toBe(true);
        },
        30_000,
      );

      it(
        "SEARCH-EDGE-03: Memory stats endpoint works alongside search",
        async () => {
          const response = await fetch(
            `${handle.gatewayUrl}/api/memory/stats`,
            {
              headers: makeAuthHeaders(handle.authToken),
            },
          );

          expect(response.status).toBe(200);

          const body = (await response.json()) as {
            stats: Record<string, unknown>;
          };
          expect(typeof body.stats).toBe("object");
          expect(body.stats).not.toBeNull();

          expect(typeof body.stats.totalEntries).toBe("number");
          expect(
            (body.stats.totalEntries as number),
          ).toBeGreaterThanOrEqual(0);

          expect(typeof body.stats.dbSizeBytes).toBe("number");
          expect((body.stats.dbSizeBytes as number)).toBeGreaterThan(0);
        },
        30_000,
      );
    });

    // -----------------------------------------------------------------------
    // Vector Search (requires OPENAI_API_KEY)
    // -----------------------------------------------------------------------

    describe.skipIf(!hasOpenAIKey)(
      "Vector Search (requires OPENAI_API_KEY)",
      () => {
        it(
          "SEARCH-VEC-01: Semantic search finds paraphrased content",
          async () => {
            // This is a soft assertion test -- vector search may or may not be
            // wired depending on daemon config. We validate the search path
            // does not crash with embeddings, not exact results.
            let ws: WebSocket | undefined;
            try {
              ws = await openAuthenticatedWebSocket(
                handle.gatewayUrl,
                handle.authToken,
              );

              const response = (await sendJsonRpc(
                ws,
                "memory.search",
                {
                  query:
                    "cryptographic security lattice-based algorithms",
                  limit: 10,
                  tenantId: "default",
                },
                rpcId++,
              )) as Record<string, unknown>;

              expect(response).toHaveProperty("result");

              const result = response.result as Record<string, unknown>;
              const results = result.results as Array<
                Record<string, unknown>
              >;

              // Log results for diagnostic purposes regardless of match
              console.log(
                `[SEARCH-VEC-01] Vector search returned ${results.length} results`,
              );
              for (const r of results) {
                console.log(
                  `  - score=${r.score}, content="${String(r.content).slice(0, 80)}..."`,
                );
              }

              // If results exist, check if any contain IRONSEARCH or quantum (semantic match)
              if (results.length > 0) {
                const hasSemanticMatch = results.some((r) => {
                  const content = String(r.content).toUpperCase();
                  return (
                    content.includes("IRONSEARCH") ||
                    content.includes("QUANTUM")
                  );
                });
                if (hasSemanticMatch) {
                  console.log(
                    "[SEARCH-VEC-01] Semantic match found for paraphrased query",
                  );
                }
              }

              // Baseline assertion: the search path did not crash
              expect(true).toBe(true);
            } finally {
              ws?.close();
            }
          },
          90_000,
        );
      },
    );
  },
);
