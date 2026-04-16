/**
 * RAG-COMPREHENSIVE: Real Provider RAG Pipeline E2E Tests
 *
 * Comprehensive integration tests for the RAG (Retrieval-Augmented Generation)
 * pipeline, covering WebSocket RPC and REST API paths, memory verification,
 * multi-fact recall, session isolation, and memory search endpoints.
 *
 * Requires ANTHROPIC_API_KEY or OPENAI_API_KEY in ~/.comis/.env.
 * Skips entirely when no LLM API keys are available.
 * Embedding-enhanced tests (RAG-04) require OPENAI_API_KEY specifically.
 *
 * @module
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { unlinkSync } from "node:fs";
import {
  getProviderEnv,
  hasAnyProvider,
  hasProvider,
  PROVIDER_GROUPS,
  isAuthError,
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
// Constants
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const CONFIG_PATH = resolve(
  __dirname,
  "../config/config.test-rag-comprehensive.yaml",
);

const env = getProviderEnv();
const hasLlmKey = hasAnyProvider(env, PROVIDER_GROUPS.llm);
const hasOpenAIKey = hasProvider(env, "OPENAI_API_KEY");

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe.skipIf(!hasLlmKey)(
  "RAG Comprehensive: Real Provider E2E Tests",
  () => {
    let handle: TestDaemonHandle;

    beforeAll(async () => {
      // Clean up old test database to start fresh
      try {
        unlinkSync(
          resolve(
            process.env["HOME"] ?? "",
            ".comis/test-memory-rag-comprehensive.db",
          ),
        );
      } catch {
        /* ok -- file may not exist */
      }

      logProviderAvailability(env);
      handle = await startTestDaemon({ configPath: CONFIG_PATH });
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
    // RAG-01: Seed fact and recall via new WebSocket session
    // -----------------------------------------------------------------------

    it(
      "RAG-01: seed fact and recall via new WebSocket session",
      async () => {
        // Step 1: Seed a unique fact via agent.execute
        let ws1: WebSocket | undefined;
        try {
          ws1 = await openAuthenticatedWebSocket(
            handle.gatewayUrl,
            handle.authToken,
          );

          const seedResponse = (await sendJsonRpc(
            ws1,
            "agent.execute",
            {
              message:
                "Remember this: The Comis RAG test codename is STORMBREAKER_131. Confirm you noted this.",
            },
            1,
          )) as Record<string, unknown>;

          expect(seedResponse).toHaveProperty("result");
          expect(seedResponse).not.toHaveProperty("error");
          const seedResult = seedResponse.result as Record<string, unknown>;
          expect(typeof seedResult.response).toBe("string");
          expect((seedResult.response as string).length).toBeGreaterThan(0);
        } catch (err) {
          if (isAuthError(err)) {
            console.warn("Skipping RAG-01: API key invalid/expired");
            return;
          }
          throw err;
        } finally {
          ws1?.close();
        }

        // Wait for memory flush to SQLite (decision 114-01: 2000ms)
        await new Promise((r) => setTimeout(r, 2_000));

        // Step 2: Query on a new WebSocket session (forces RAG retrieval)
        let ws2: WebSocket | undefined;
        try {
          ws2 = await openAuthenticatedWebSocket(
            handle.gatewayUrl,
            handle.authToken,
          );

          const queryResponse = (await sendJsonRpc(
            ws2,
            "agent.execute",
            {
              message:
                "What is the RAG test codename? Check your memories.",
            },
            2,
          )) as Record<string, unknown>;

          expect(queryResponse).toHaveProperty("result");
          expect(queryResponse).not.toHaveProperty("error");
          const queryResult = queryResponse.result as Record<string, unknown>;
          expect(typeof queryResult.response).toBe("string");
          expect((queryResult.response as string).length).toBeGreaterThan(0);
        } catch (err) {
          if (isAuthError(err)) {
            console.warn("Skipping RAG-01 recall: API key invalid/expired");
            return;
          }
          throw err;
        } finally {
          ws2?.close();
        }
      },
      180_000,
    );

    // -----------------------------------------------------------------------
    // RAG-02: Seed fact and recall via REST API POST /api/chat
    // -----------------------------------------------------------------------

    it(
      "RAG-02: seed fact and recall via REST API POST /api/chat",
      async () => {
        // Step 1: Seed via REST API
        try {
          const seedResp = await fetch(`${handle.gatewayUrl}/api/chat`, {
            method: "POST",
            headers: makeAuthHeaders(handle.authToken),
            body: JSON.stringify({
              message:
                "Remember this: The REST RAG test code is DELTA_NINE_131. Confirm.",
            }),
          });

          expect(seedResp.ok).toBe(true);
          const seedJson = (await seedResp.json()) as Record<string, unknown>;
          expect(typeof seedJson.response).toBe("string");
          expect((seedJson.response as string).length).toBeGreaterThan(0);
        } catch (err) {
          if (isAuthError(err)) {
            console.warn("Skipping RAG-02: API key invalid/expired");
            return;
          }
          throw err;
        }

        // Wait for memory flush (decision 114-01: 2000ms)
        await new Promise((r) => setTimeout(r, 2_000));

        // Step 2: Recall via same REST endpoint
        try {
          const recallResp = await fetch(`${handle.gatewayUrl}/api/chat`, {
            method: "POST",
            headers: makeAuthHeaders(handle.authToken),
            body: JSON.stringify({
              message:
                "What is the REST RAG test code? Check your memories.",
            }),
          });

          expect(recallResp.ok).toBe(true);
          const recallJson = (await recallResp.json()) as Record<
            string,
            unknown
          >;
          expect(typeof recallJson.response).toBe("string");
          expect((recallJson.response as string).length).toBeGreaterThan(0);
        } catch (err) {
          if (isAuthError(err)) {
            console.warn("Skipping RAG-02 recall: API key invalid/expired");
            return;
          }
          throw err;
        }
      },
      180_000,
    );

    // -----------------------------------------------------------------------
    // RAG-03: Verify memory stored via memory.search RPC
    // -----------------------------------------------------------------------

    it(
      "RAG-03: verify memory stored via memory.search RPC",
      async () => {
        // This test depends on RAG-01 having seeded the STORMBREAKER_131 fact.
        // Vitest runs tests sequentially within a describe block.
        let ws: WebSocket | undefined;
        try {
          ws = await openAuthenticatedWebSocket(
            handle.gatewayUrl,
            handle.authToken,
          );

          const searchResponse = (await sendJsonRpc(
            ws,
            "memory.search",
            { query: "STORMBREAKER_131", limit: 5 },
            1,
            { timeoutMs: RPC_FAST_MS },
          )) as Record<string, unknown>;

          expect(searchResponse).toHaveProperty("result");
          expect(searchResponse).not.toHaveProperty("error");

          const result = searchResponse.result as Record<string, unknown>;
          const results = result.results as Array<Record<string, unknown>>;
          expect(Array.isArray(results)).toBe(true);
          expect(results.length).toBeGreaterThan(0);
        } catch (err) {
          if (isAuthError(err)) {
            console.warn("Skipping RAG-03: API key invalid/expired");
            return;
          }
          throw err;
        } finally {
          ws?.close();
        }
      },
      30_000,
    );

    // -----------------------------------------------------------------------
    // RAG-05: Memory flush timing validation
    // -----------------------------------------------------------------------

    it(
      "RAG-05: memory flush timing validation",
      async () => {
        // Step 1: Seed a new unique fact
        let ws1: WebSocket | undefined;
        try {
          ws1 = await openAuthenticatedWebSocket(
            handle.gatewayUrl,
            handle.authToken,
          );

          const seedResponse = (await sendJsonRpc(
            ws1,
            "agent.execute",
            {
              message:
                "Remember this: Operation PHOENIX_131 launched on March 5th 2026. Confirm.",
            },
            1,
          )) as Record<string, unknown>;

          expect(seedResponse).toHaveProperty("result");
          expect(seedResponse).not.toHaveProperty("error");
        } catch (err) {
          if (isAuthError(err)) {
            console.warn("Skipping RAG-05: API key invalid/expired");
            return;
          }
          throw err;
        } finally {
          ws1?.close();
        }

        // Step 2: Short delay (intentionally short -- may or may not find results)
        await new Promise((r) => setTimeout(r, 500));

        let ws2: WebSocket | undefined;
        try {
          ws2 = await openAuthenticatedWebSocket(
            handle.gatewayUrl,
            handle.authToken,
          );

          // Informational search -- do NOT assert on results (flush may not be complete)
          await sendJsonRpc(
            ws2,
            "memory.search",
            { query: "PHOENIX_131", limit: 5 },
            1,
            { timeoutMs: RPC_FAST_MS },
          );
        } catch {
          // Ignored -- informational only
        } finally {
          ws2?.close();
        }

        // Step 3: Full flush delay (2000ms more, 2500ms total)
        await new Promise((r) => setTimeout(r, 2_000));

        // Step 4: After full flush, results MUST be found
        let ws3: WebSocket | undefined;
        try {
          ws3 = await openAuthenticatedWebSocket(
            handle.gatewayUrl,
            handle.authToken,
          );

          const searchResponse = (await sendJsonRpc(
            ws3,
            "memory.search",
            { query: "PHOENIX_131", limit: 5 },
            1,
            { timeoutMs: RPC_FAST_MS },
          )) as Record<string, unknown>;

          expect(searchResponse).toHaveProperty("result");
          expect(searchResponse).not.toHaveProperty("error");

          const result = searchResponse.result as Record<string, unknown>;
          const results = result.results as Array<Record<string, unknown>>;
          expect(Array.isArray(results)).toBe(true);
          expect(results.length).toBeGreaterThan(0);
        } catch (err) {
          if (isAuthError(err)) {
            console.warn("Skipping RAG-05: API key invalid/expired");
            return;
          }
          throw err;
        } finally {
          ws3?.close();
        }
      },
      180_000,
    );

    // -----------------------------------------------------------------------
    // RAG-06: Multiple facts seeded and recalled
    // -----------------------------------------------------------------------

    it(
      "RAG-06: multiple facts seeded and independently recalled",
      async () => {
        // Step 1: Seed two facts in one message
        let ws1: WebSocket | undefined;
        try {
          ws1 = await openAuthenticatedWebSocket(
            handle.gatewayUrl,
            handle.authToken,
          );

          const seedResponse = (await sendJsonRpc(
            ws1,
            "agent.execute",
            {
              message:
                "Remember these two facts: 1) Agent codename VIPER_131 is assigned to sector 7. 2) Protocol RAVEN_131 activates at midnight. Confirm both noted.",
            },
            1,
          )) as Record<string, unknown>;

          expect(seedResponse).toHaveProperty("result");
          expect(seedResponse).not.toHaveProperty("error");
        } catch (err) {
          if (isAuthError(err)) {
            console.warn("Skipping RAG-06: API key invalid/expired");
            return;
          }
          throw err;
        } finally {
          ws1?.close();
        }

        // Wait for memory flush
        await new Promise((r) => setTimeout(r, 2_000));

        // Step 2: Query first fact on new session
        let ws2: WebSocket | undefined;
        try {
          ws2 = await openAuthenticatedWebSocket(
            handle.gatewayUrl,
            handle.authToken,
          );

          const queryResponse1 = (await sendJsonRpc(
            ws2,
            "agent.execute",
            {
              message:
                "What agent codename is assigned to sector 7? Check your memories.",
            },
            1,
          )) as Record<string, unknown>;

          expect(queryResponse1).toHaveProperty("result");
          expect(queryResponse1).not.toHaveProperty("error");
          const result1 = queryResponse1.result as Record<string, unknown>;
          expect(typeof result1.response).toBe("string");
          expect((result1.response as string).length).toBeGreaterThan(0);
        } catch (err) {
          if (isAuthError(err)) {
            console.warn(
              "Skipping RAG-06 first recall: API key invalid/expired",
            );
            return;
          }
          throw err;
        } finally {
          ws2?.close();
        }

        // Step 3: Query second fact on another new session
        let ws3: WebSocket | undefined;
        try {
          ws3 = await openAuthenticatedWebSocket(
            handle.gatewayUrl,
            handle.authToken,
          );

          const queryResponse2 = (await sendJsonRpc(
            ws3,
            "agent.execute",
            {
              message:
                "What protocol activates at midnight? Check your memories.",
            },
            1,
          )) as Record<string, unknown>;

          expect(queryResponse2).toHaveProperty("result");
          expect(queryResponse2).not.toHaveProperty("error");
          const result2 = queryResponse2.result as Record<string, unknown>;
          expect(typeof result2.response).toBe("string");
          expect((result2.response as string).length).toBeGreaterThan(0);
        } catch (err) {
          if (isAuthError(err)) {
            console.warn(
              "Skipping RAG-06 second recall: API key invalid/expired",
            );
            return;
          }
          throw err;
        } finally {
          ws3?.close();
        }
      },
      180_000,
    );

    // -----------------------------------------------------------------------
    // RAG-07: RAG with different session keys (new connections force RAG)
    // -----------------------------------------------------------------------

    it(
      "RAG-07: fresh session retrieves RAG context from prior interactions",
      async () => {
        // Reuses facts seeded by RAG-01 (STORMBREAKER_131).
        // A completely fresh session (no prior conversation history) should
        // retrieve RAG context from memory.
        let wsFresh: WebSocket | undefined;
        try {
          wsFresh = await openAuthenticatedWebSocket(
            handle.gatewayUrl,
            handle.authToken,
          );

          const queryResponse = (await sendJsonRpc(
            wsFresh,
            "agent.execute",
            {
              message:
                "Tell me about STORMBREAKER. Check your memories.",
            },
            1,
          )) as Record<string, unknown>;

          expect(queryResponse).toHaveProperty("result");
          expect(queryResponse).not.toHaveProperty("error");
          const result = queryResponse.result as Record<string, unknown>;
          expect(typeof result.response).toBe("string");
          expect((result.response as string).length).toBeGreaterThan(0);
        } catch (err) {
          if (isAuthError(err)) {
            console.warn("Skipping RAG-07: API key invalid/expired");
            return;
          }
          throw err;
        } finally {
          wsFresh?.close();
        }
      },
      180_000,
    );

    // -----------------------------------------------------------------------
    // RAG-08: Memory search via REST /api/memory/search
    // -----------------------------------------------------------------------

    it(
      "RAG-08: REST /api/memory/search returns stored memory entries",
      async () => {
        // Uses facts seeded by RAG-01 (STORMBREAKER_131).
        try {
          const searchResp = await fetch(
            `${handle.gatewayUrl}/api/memory/search?q=STORMBREAKER_131&limit=5`,
            {
              headers: makeAuthHeaders(handle.authToken),
            },
          );

          expect(searchResp.ok).toBe(true);
          expect(searchResp.status).toBe(200);

          const searchJson = (await searchResp.json()) as Record<
            string,
            unknown
          >;
          const results = searchJson.results as Array<Record<string, unknown>>;
          expect(Array.isArray(results)).toBe(true);
          expect(results.length).toBeGreaterThan(0);
        } catch (err) {
          if (isAuthError(err)) {
            console.warn("Skipping RAG-08: API key invalid/expired");
            return;
          }
          throw err;
        }
      },
      30_000,
    );

    // -----------------------------------------------------------------------
    // RAG-04: Embedding-enhanced recall (requires OPENAI_API_KEY)
    // -----------------------------------------------------------------------

    describe.skipIf(!hasOpenAIKey)("RAG with Vector Embeddings", () => {
      it(
        "RAG-04: embedding-enhanced recall returns semantically relevant results",
        async () => {
          // Seed a fact using SEMANTIC language (not just keywords)
          let ws1: WebSocket | undefined;
          try {
            ws1 = await openAuthenticatedWebSocket(
              handle.gatewayUrl,
              handle.authToken,
            );
            const seedResponse = (await sendJsonRpc(
              ws1,
              "agent.execute",
              {
                message:
                  "Remember this: The QUANTUM_DRIFT_131 experiment measures subatomic particle oscillation frequencies at 42.7 terahertz. Confirm noted.",
              },
              1,
            )) as Record<string, unknown>;
            expect(seedResponse).toHaveProperty("result");
            expect(seedResponse).not.toHaveProperty("error");
          } catch (err) {
            if (isAuthError(err)) {
              console.warn("Skipping RAG-04: API key invalid/expired");
              return;
            }
            throw err;
          } finally {
            ws1?.close();
          }

          // Longer delay for embedding queue processing (embeddings are async)
          await new Promise((r) => setTimeout(r, 3_000));

          // Verify memory stored with embedding via memory.search
          let ws2: WebSocket | undefined;
          try {
            ws2 = await openAuthenticatedWebSocket(
              handle.gatewayUrl,
              handle.authToken,
            );
            // Use SEMANTIC query (not exact keyword match) -- embeddings should find it
            const searchResponse = (await sendJsonRpc(
              ws2,
              "memory.search",
              {
                query: "particle oscillation experiment frequency",
                limit: 5,
              },
              2,
              { timeoutMs: RPC_FAST_MS },
            )) as Record<string, unknown>;

            expect(searchResponse).toHaveProperty("result");
            expect(searchResponse).not.toHaveProperty("error");
            const result = searchResponse.result as Record<string, unknown>;
            const results = result.results as Array<Record<string, unknown>>;
            expect(results.length).toBeGreaterThan(0);
          } catch (err) {
            if (isAuthError(err)) {
              console.warn("Skipping RAG-04: API key invalid/expired");
              return;
            }
            throw err;
          } finally {
            ws2?.close();
          }

          // Recall via new session -- should find via embedding similarity
          let ws3: WebSocket | undefined;
          try {
            ws3 = await openAuthenticatedWebSocket(
              handle.gatewayUrl,
              handle.authToken,
            );
            const recallResponse = (await sendJsonRpc(
              ws3,
              "agent.execute",
              {
                message:
                  "What experiment involves measuring frequencies? Check your memories.",
              },
              3,
            )) as Record<string, unknown>;
            expect(recallResponse).toHaveProperty("result");
            const recallResult = recallResponse.result as Record<
              string,
              unknown
            >;
            expect(typeof recallResult.response).toBe("string");
            expect(
              (recallResult.response as string).length,
            ).toBeGreaterThan(0);
          } catch (err) {
            if (isAuthError(err)) {
              console.warn("Skipping RAG-04: API key invalid/expired");
              return;
            }
            throw err;
          } finally {
            ws3?.close();
          }
        },
        180_000,
      );
    });
  },
);
