/**
 * AGENT-05: RAG Context from Memory
 *
 * Integration test that validates the agent's RAG pipeline:
 *   1. Store a unique fact via agent interaction (memory entry created by daemon)
 *   2. Query the agent about the stored fact in a new connection
 *   3. Verify the agent retrieves and uses RAG-injected memory context
 *
 * Uses a RAG-enabled config (port 8444, separate memory DB) to avoid
 * conflicts with other test suites.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  startTestDaemon,
  type TestDaemonHandle,
} from "../support/daemon-harness.js";
import { openAuthenticatedWebSocket, sendJsonRpc } from "../support/ws-helpers.js";
import {
  getProviderEnv,
  hasAnyProvider,
  PROVIDER_GROUPS,
  logProviderAvailability,
} from "../support/provider-env.js";

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ragConfigPath = resolve(__dirname, "../config/config.test-rag.yaml");

// ---------------------------------------------------------------------------
// Provider detection
// ---------------------------------------------------------------------------

const env = getProviderEnv();
const hasLlmKey = hasAnyProvider(env, PROVIDER_GROUPS.llm);

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe.skipIf(!hasLlmKey)("AGENT-05: RAG Context from Memory", () => {
  let handle: TestDaemonHandle;

  beforeAll(async () => {
    logProviderAvailability(env);
    handle = await startTestDaemon({ configPath: ragConfigPath });
  }, 120_000);

  afterAll(async () => {
    if (handle) {
      try {
        await handle.cleanup();
      } catch (err) {
        // Expected: graceful shutdown calls the overridden exit() which throws.
        const msg = err instanceof Error ? err.message : String(err);
        if (!msg.includes("Daemon exit with code")) {
          throw err;
        }
      }
    }
  }, 30_000);

  it(
    "agent retrieves RAG-injected memory context from a previous interaction",
    async () => {
      // -----------------------------------------------------------------------
      // Step 1: Seed memory — send a unique fact the agent wouldn't know
      // -----------------------------------------------------------------------
      let ws1: WebSocket | undefined;
      try {
        ws1 = await openAuthenticatedWebSocket(handle.gatewayUrl, handle.authToken);

        const seedResponse = (await sendJsonRpc(
          ws1,
          "agent.execute",
          {
            message:
              "Remember this important fact: The Comis project codename is THUNDERHAWK and it was started on January 15th 2025. Acknowledge that you've noted this.",
          },
          1,
        )) as Record<string, unknown>;

        // Verify the seed call succeeded
        expect(seedResponse).toHaveProperty("result");
        expect(seedResponse).not.toHaveProperty("error");
        const seedResult = seedResponse.result as Record<string, unknown>;
        expect(typeof seedResult.response).toBe("string");
        expect((seedResult.response as string).length).toBeGreaterThan(0);
      } finally {
        ws1?.close();
      }

      // Brief delay to ensure memory is flushed to SQLite
      await new Promise((resolve) => setTimeout(resolve, 1_000));

      // -----------------------------------------------------------------------
      // Step 2: Query with RAG — ask about the stored fact in a new connection
      // -----------------------------------------------------------------------
      let ws2: WebSocket | undefined;
      try {
        ws2 = await openAuthenticatedWebSocket(handle.gatewayUrl, handle.authToken);

        const queryResponse = (await sendJsonRpc(
          ws2,
          "agent.execute",
          {
            message:
              "What is the project codename for Comis? When was it started? Check your memories.",
          },
          2,
        )) as Record<string, unknown>;

        // Verify the query call succeeded
        expect(queryResponse).toHaveProperty("result");
        expect(queryResponse).not.toHaveProperty("error");
        const queryResult = queryResponse.result as Record<string, unknown>;
        expect(typeof queryResult.response).toBe("string");

        const responseText = (queryResult.response as string).toUpperCase();

        // -----------------------------------------------------------------------
        // Step 3: Verify — the response should contain the unique fact
        // -----------------------------------------------------------------------
        // The codename "THUNDERHAWK" is a made-up fact that can only come
        // from RAG-injected memory context (the agent's training data doesn't
        // contain this information).
        expect(responseText).toContain("THUNDERHAWK");
      } finally {
        ws2?.close();
      }
    },
    180_000,
  );
});
