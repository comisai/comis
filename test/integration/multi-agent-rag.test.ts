// SPDX-License-Identifier: Apache-2.0
/**
 * Multi-Agent RAG: Memory Isolation Integration Tests
 *
 * Validates per-agent memory isolation through the RAG pipeline:
 *   MULTI-03a: Alpha stores a unique fact and retrieves it via RAG
 *   MULTI-03b: Beta cannot retrieve alpha's stored fact (memory isolated by agentId)
 *   MULTI-03c: Beta stores and retrieves its own fact independently
 *
 * Uses a multi-agent RAG config (port 8456) with both agents RAG-enabled
 * and a separate memory DB to avoid data contamination.
 *
 * Each agent uses a distinct sessionKey (channelId per agent) to prevent
 * session history bleed between agents via the shared gateway session.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { unlinkSync } from "node:fs";
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
const configPath = resolve(__dirname, "../config/config.test-multi-agent-rag.yaml");

// ---------------------------------------------------------------------------
// Provider detection
// ---------------------------------------------------------------------------

const env = getProviderEnv();
const hasLlmKey = hasAnyProvider(env, PROVIDER_GROUPS.llm);

// ---------------------------------------------------------------------------
// Per-agent session keys to prevent session history bleed
// ---------------------------------------------------------------------------

const ALPHA_SESSION = { userId: "test-alpha", channelId: "rag-alpha", peerId: "test" };
const BETA_SESSION = { userId: "test-beta", channelId: "rag-beta", peerId: "test" };

// ---------------------------------------------------------------------------
// Test suite — tests run sequentially (MULTI-03b depends on MULTI-03a)
// ---------------------------------------------------------------------------

describe.skipIf(!hasLlmKey)("Multi-Agent RAG: Memory Isolation", () => {
  let handle: TestDaemonHandle;

  beforeAll(async () => {
    logProviderAvailability(env);
    // Remove stale DB to ensure clean state (prevents cross-run contamination)
    try { unlinkSync(resolve(process.env["HOME"] ?? "", ".comis/test-memory-multi-agent-rag.db")); } catch { /* ok */ }
    handle = await startTestDaemon({ configPath });
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

  // -------------------------------------------------------------------------
  // MULTI-03a -- Alpha stores and retrieves its own fact
  // -------------------------------------------------------------------------

  it(
    "MULTI-03a: Alpha stores a unique fact and retrieves it via RAG",
    async () => {
      // Step 1: Alpha stores the fact (with alpha-specific session key)
      let ws1: WebSocket | undefined;
      try {
        ws1 = await openAuthenticatedWebSocket(handle.gatewayUrl, handle.authToken);

        const seedResponse = (await sendJsonRpc(ws1, "agent.execute", {
          agentId: "alpha",
          sessionKey: ALPHA_SESSION,
          message: "Please remember this project note: The internal label for Project Alpha is COMIS_ALPHA_CODENAME_PHOENIX. Confirm you have stored this.",
        }, 1)) as Record<string, unknown>;

        expect(seedResponse).toHaveProperty("result");
        expect(seedResponse).not.toHaveProperty("error");
        const seedResult = seedResponse.result as Record<string, unknown>;
        expect(typeof seedResult.response).toBe("string");
        expect((seedResult.response as string).length).toBeGreaterThan(0);
      } finally {
        ws1?.close();
      }

      // Brief delay to ensure memory is flushed to SQLite (decision 29-02: 1s + margin)
      await new Promise((resolve) => setTimeout(resolve, 1_500));

      // Step 2: Alpha retrieves the fact via RAG in a new session
      let ws2: WebSocket | undefined;
      try {
        ws2 = await openAuthenticatedWebSocket(handle.gatewayUrl, handle.authToken);

        // Use a different channelId so RAG (not session history) is the only source
        const queryResponse = (await sendJsonRpc(ws2, "agent.execute", {
          agentId: "alpha",
          sessionKey: { userId: "test-alpha-query", channelId: "rag-alpha-query", peerId: "test" },
          message: "What is the internal label for Project Alpha? Check your memories.",
        }, 2)) as Record<string, unknown>;

        expect(queryResponse).toHaveProperty("result");
        expect(queryResponse).not.toHaveProperty("error");
        const queryResult = queryResponse.result as Record<string, unknown>;
        expect(typeof queryResult.response).toBe("string");

        const responseText = (queryResult.response as string).toUpperCase();
        expect(responseText).toContain("PHOENIX");
      } finally {
        ws2?.close();
      }
    },
    180_000,
  );

  // -------------------------------------------------------------------------
  // MULTI-03b -- Beta cannot retrieve alpha's fact
  // -------------------------------------------------------------------------

  it(
    "MULTI-03b: Beta cannot retrieve alpha's stored fact (memory isolation)",
    async () => {
      let ws: WebSocket | undefined;
      try {
        ws = await openAuthenticatedWebSocket(handle.gatewayUrl, handle.authToken);

        // Beta uses its own session key — no shared session history with alpha
        const response = (await sendJsonRpc(ws, "agent.execute", {
          agentId: "beta",
          sessionKey: BETA_SESSION,
          message: "What is the internal label for Project Alpha? If you don't know, say UNKNOWN.",
        }, 3)) as Record<string, unknown>;

        expect(response).toHaveProperty("result");
        expect(response).not.toHaveProperty("error");

        const result = response.result as Record<string, unknown>;
        const responseText = (result.response as string).toUpperCase();

        // Beta should NOT have access to alpha's memory (stored with agentId: "alpha")
        expect(responseText).not.toContain("PHOENIX");
      } finally {
        ws?.close();
      }
    },
    90_000,
  );

  // -------------------------------------------------------------------------
  // MULTI-03c -- Beta stores and retrieves its own fact independently
  // -------------------------------------------------------------------------

  it(
    "MULTI-03c: Beta stores and retrieves its own fact independently",
    async () => {
      // Step 1: Beta stores its own fact (with beta-specific session key)
      let ws1: WebSocket | undefined;
      try {
        ws1 = await openAuthenticatedWebSocket(handle.gatewayUrl, handle.authToken);

        const seedResponse = (await sendJsonRpc(ws1, "agent.execute", {
          agentId: "beta",
          sessionKey: { userId: "test-beta-seed", channelId: "rag-beta-seed", peerId: "test" },
          message: "Please remember this project note: The internal label for Project Beta is COMIS_BETA_CODENAME_THUNDERHAWK. Confirm you have stored this.",
        }, 4)) as Record<string, unknown>;

        expect(seedResponse).toHaveProperty("result");
        expect(seedResponse).not.toHaveProperty("error");
        const seedResult = seedResponse.result as Record<string, unknown>;
        expect(typeof seedResult.response).toBe("string");
        expect((seedResult.response as string).length).toBeGreaterThan(0);
      } finally {
        ws1?.close();
      }

      // Brief delay for SQLite flush
      await new Promise((resolve) => setTimeout(resolve, 1_500));

      // Step 2: Beta retrieves its own fact in a fresh session (RAG only)
      let ws2: WebSocket | undefined;
      try {
        ws2 = await openAuthenticatedWebSocket(handle.gatewayUrl, handle.authToken);

        const queryResponse = (await sendJsonRpc(ws2, "agent.execute", {
          agentId: "beta",
          sessionKey: { userId: "test-beta-query", channelId: "rag-beta-query", peerId: "test" },
          message: "What is the internal label for Project Beta? Check your memories.",
        }, 5)) as Record<string, unknown>;

        expect(queryResponse).toHaveProperty("result");
        expect(queryResponse).not.toHaveProperty("error");
        const queryResult = queryResponse.result as Record<string, unknown>;
        expect(typeof queryResult.response).toBe("string");

        const responseText = (queryResult.response as string).toUpperCase();
        expect(responseText).toContain("THUNDERHAWK");
      } finally {
        ws2?.close();
      }
    },
    180_000,
  );
});
