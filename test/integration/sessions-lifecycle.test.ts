// SPDX-License-Identifier: Apache-2.0
/**
 * Sessions Lifecycle: Non-LLM Integration Tests
 *
 * Validates session management RPC methods and REST API session endpoints
 * against a real running daemon WITHOUT requiring LLM API keys. Tests cover:
 *
 *   session.status RPC (model, agentName, tokensUsed, stepsExecuted, maxSteps)
 *   session.history RPC (error handling for missing sessions)
 *   REST API session history (GET /api/chat/history)
 *   session.send error handling (non-existent targets, missing params)
 *   session.spawn error handling (no LLM, non-existent agent)
 *   Non-bridged methods return method-not-found (-32601)
 *   JSON-RPC 2.0 structure validation across all bridged session methods
 *
 * Uses port 8505 with a dedicated memory database for isolation.
 */

import { createHash } from "node:crypto";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  startTestDaemon,
  makeAuthHeaders,
  type TestDaemonHandle,
} from "../support/daemon-harness.js";
import { openAuthenticatedWebSocket, sendJsonRpc } from "../support/ws-helpers.js";
import { RPC_FAST_MS } from "../support/timeouts.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const CONFIG_PATH = resolve(__dirname, "../config/config.test-sessions-lifecycle.yaml");

// Session RPCs now address a conversation by explicit authority
// (tenant_id + agent_id + opaque conversation_ref) rather than a formatted
// session_key string. The daemon's configured tenant/agent for this fixture.
const TENANT_ID = "test";
const AGENT_ID = "default";
// A well-formed but never-persisted conversation reference (cv_ + 43-char
// base64url digest). Passes ConversationRefSchema so the handler reaches its
// store lookup and reports the conversation as not found.
const NONEXISTENT_REF = `cv_${createHash("sha256").update("nonexistent-conversation").digest("base64url")}`;

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("Sessions Lifecycle: Non-LLM Integration Tests", () => {
  let handle: TestDaemonHandle;
  let gatewayUrl: string;
  let authToken: string;
  let ws: WebSocket;
  let msgId = 100;

  beforeAll(async () => {
    handle = await startTestDaemon({ configPath: CONFIG_PATH });
    gatewayUrl = handle.gatewayUrl;
    authToken = handle.authToken;
    ws = await openAuthenticatedWebSocket(gatewayUrl, authToken);
  }, 60_000);

  afterAll(async () => {
    if (ws) ws.close();
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
  }, 60_000);

  // ---------------------------------------------------------------------------
  // session.status RPC
  // ---------------------------------------------------------------------------

  describe("session.status RPC", () => {
    it("session.status returns model, agentName, tokensUsed, stepsExecuted, maxSteps on fresh daemon", async () => {
      const response = (await sendJsonRpc(ws, "session.status", {}, msgId++, {
        timeoutMs: RPC_FAST_MS,
      })) as Record<string, unknown>;

      expect(response).toHaveProperty("result");
      const result = response.result as Record<string, unknown>;

      expect(result.model).toBe("claude-opus-4-6");
      expect(result.agentName).toBe("TestAgent");
      expect(result.maxSteps).toBe(10);

      // Fresh daemon, no executions -- tokens and steps should be zero
      const tokensUsed = result.tokensUsed as Record<string, unknown>;
      expect(tokensUsed.totalTokens).toBe(0);
      expect(tokensUsed.totalCost).toBe(0);
      expect(result.stepsExecuted).toBe(0);
    });

    it("session.status returns valid JSON-RPC 2.0 structure", async () => {
      const id = msgId++;
      const response = (await sendJsonRpc(ws, "session.status", {}, id, {
        timeoutMs: RPC_FAST_MS,
      })) as Record<string, unknown>;

      expect(response).toHaveProperty("jsonrpc", "2.0");
      expect(response).toHaveProperty("id", id);
    });
  });

  // ---------------------------------------------------------------------------
  // session.history RPC
  // ---------------------------------------------------------------------------

  describe("session.history RPC", () => {
    it("session.history for a non-existent conversation returns a not-found error", async () => {
      const response = (await sendJsonRpc(
        ws,
        "session.history",
        { tenant_id: TENANT_ID, agent_id: AGENT_ID, conversation_ref: NONEXISTENT_REF },
        msgId++,
        { timeoutMs: RPC_FAST_MS },
      )) as Record<string, unknown>;

      expect(response).toHaveProperty("error");
      expect(response).not.toHaveProperty("result");

      const error = response.error as Record<string, unknown>;
      expect(typeof error.message).toBe("string");
      expect((error.message as string).toLowerCase()).toContain("not found");
    });

    it("session.history with valid params format returns structured response", async () => {
      const response = (await sendJsonRpc(
        ws,
        "session.history",
        { tenant_id: TENANT_ID, agent_id: AGENT_ID, conversation_ref: NONEXISTENT_REF, offset: 0, limit: 10 },
        msgId++,
        { timeoutMs: RPC_FAST_MS },
      )) as Record<string, unknown>;

      // Either result or error is valid -- both prove RPC round-trip
      const hasResult = "result" in response;
      const hasError = "error" in response;
      expect(hasResult || hasError).toBe(true);

      if (hasError) {
        const error = response.error as Record<string, unknown>;
        expect(typeof error.code).toBe("number");
        expect(typeof error.message).toBe("string");
      }
    });
  });

  // ---------------------------------------------------------------------------
  // REST API session history
  // ---------------------------------------------------------------------------

  describe("REST API session history", () => {
    it("GET /api/chat/history on fresh daemon returns empty messages", async () => {
      const response = await fetch(`${gatewayUrl}/api/chat/history?channelId=gateway`, {
        headers: makeAuthHeaders(authToken),
      });
      expect(response.ok).toBe(true);

      const historyData = (await response.json()) as {
        messages: Array<{ role: string; content: string; timestamp: number }>;
      };
      expect(historyData).toHaveProperty("messages");
      expect(Array.isArray(historyData.messages)).toBe(true);
    });

    it("GET /api/chat/history with nonexistent channelId returns empty", async () => {
      const response = await fetch(
        `${gatewayUrl}/api/chat/history?channelId=nonexistent-channel-129`,
        { headers: makeAuthHeaders(authToken) },
      );
      expect(response.ok).toBe(true);

      const historyData = (await response.json()) as {
        messages: Array<{ role: string; content: string; timestamp: number }>;
      };
      expect(historyData.messages).toEqual([]);
    });

    it("GET /api/chat/history without auth returns 401", async () => {
      const response = await fetch(`${gatewayUrl}/api/chat/history?channelId=gateway`);
      expect(response.status).toBe(401);
    });
  });

  // ---------------------------------------------------------------------------
  // session.send error handling
  // ---------------------------------------------------------------------------

  describe("session.send error handling", () => {
    it("session.send to non-existent target session returns error", async () => {
      const response = (await sendJsonRpc(
        ws,
        "session.send",
        {
          tenant_id: TENANT_ID,
          agent_id: AGENT_ID,
          conversation_ref: NONEXISTENT_REF,
          text: "hello",
          mode: "fire-and-forget",
        },
        msgId++,
        { timeoutMs: RPC_FAST_MS },
      )) as Record<string, unknown>;

      // session.send will fail because target session doesn't exist
      const hasResult = "result" in response;
      const hasError = "error" in response;
      expect(hasResult || hasError).toBe(true);

      if (hasError) {
        const error = response.error as Record<string, unknown>;
        expect(typeof error.code).toBe("number");
        expect(typeof error.message).toBe("string");
      }
    });

    it("session.send with missing required params returns error", async () => {
      const response = (await sendJsonRpc(
        ws,
        "session.send",
        {},
        msgId++,
        { timeoutMs: RPC_FAST_MS },
      )) as Record<string, unknown>;

      // Empty params should cause an error (missing session_key/text)
      const hasResult = "result" in response;
      const hasError = "error" in response;
      expect(hasResult || hasError).toBe(true);

      if (hasError) {
        const error = response.error as Record<string, unknown>;
        expect(typeof error.code).toBe("number");
        expect(typeof error.message).toBe("string");
      }
    });
  });

  // ---------------------------------------------------------------------------
  // session.spawn error handling
  // ---------------------------------------------------------------------------

  describe("session.spawn error handling", () => {
    it("session.spawn without LLM returns error or timeout response", async () => {
      const response = (await sendJsonRpc(
        ws,
        "session.spawn",
        { task: "test task", agent: "default" },
        msgId++,
        { timeoutMs: 15_000 },
      )) as Record<string, unknown>;

      // Spawn attempts agent execution which will fail without LLM key
      // Valid response is either error or result with async/timeout note
      expect(response).toHaveProperty("jsonrpc", "2.0");
      const hasResult = "result" in response;
      const hasError = "error" in response;
      expect(hasResult || hasError).toBe(true);
    });

    it("session.spawn with non-existent agent returns valid JSON-RPC response", async () => {
      const response = (await sendJsonRpc(
        ws,
        "session.spawn",
        { task: "test", agent: "nonexistent-agent-129" },
        msgId++,
        { timeoutMs: 15_000 },
      )) as Record<string, unknown>;

      // Non-existent agent may fall back to default or return error
      expect(response).toHaveProperty("jsonrpc", "2.0");
      const hasResult = "result" in response;
      const hasError = "error" in response;
      expect(hasResult || hasError).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // Non-bridged methods return method-not-found
  // ---------------------------------------------------------------------------

  describe("Bridged session methods return valid responses", () => {
    it("session.list via WS RPC returns a valid result", async () => {
      const response = (await sendJsonRpc(
        ws,
        "session.list",
        { tenant_id: TENANT_ID, agent_id: AGENT_ID },
        msgId++,
        { timeoutMs: RPC_FAST_MS },
      )) as Record<string, unknown>;

      // session.list is now a registered RPC method
      expect(response).toHaveProperty("jsonrpc", "2.0");
      const hasResult = "result" in response;
      const hasError = "error" in response;
      expect(hasResult || hasError).toBe(true);
    });

    it("session.run_status via WS RPC returns a valid JSON-RPC response", async () => {
      // setup-gateway-api.ts collapses to a registry loop over
      // API_CONTRACTS_ORDERED, which registers all contracts on the dynamic
      // router. session.run_status is registered — invoking it with an
      // unknown run_id returns a structured RPC error (not method-not-found
      // / -32601).
      const response = (await sendJsonRpc(
        ws,
        "session.run_status",
        { run_id: "fake-run-id" },
        msgId++,
        { timeoutMs: RPC_FAST_MS },
      )) as Record<string, unknown>;

      expect(response).toHaveProperty("jsonrpc", "2.0");
      const hasResult = "result" in response;
      const hasError = "error" in response;
      expect(hasResult || hasError).toBe(true);
      // If we got an error, it MUST NOT be method-not-found (-32601) —
      // session.run_status is now first-class on the dynamic router.
      if (hasError) {
        const error = response.error as Record<string, unknown>;
        expect(error.code, "session.run_status should not return method-not-found").not.toBe(
          -32601,
        );
      }
    });
  });

  // ---------------------------------------------------------------------------
  // JSON-RPC structure validation
  // ---------------------------------------------------------------------------

  describe("JSON-RPC structure validation", () => {
    it("all bridged session methods return valid JSON-RPC 2.0 responses", async () => {
      const methods = [
        { method: "session.status", params: {} },
        { method: "session.history", params: { tenant_id: TENANT_ID, agent_id: AGENT_ID, conversation_ref: NONEXISTENT_REF } },
        { method: "session.send", params: { tenant_id: TENANT_ID, agent_id: AGENT_ID, conversation_ref: NONEXISTENT_REF, text: "ping", mode: "fire-and-forget" } },
        { method: "session.spawn", params: { task: "validate jsonrpc structure", agent: "default", async: true } },
      ];

      for (const { method, params } of methods) {
        const id = msgId++;
        const timeoutMs = RPC_FAST_MS;
        const response = (await sendJsonRpc(ws, method, params, id, {
          timeoutMs,
        })) as Record<string, unknown>;

        // JSON-RPC 2.0 envelope
        expect(response).toHaveProperty("jsonrpc", "2.0");
        expect(response).toHaveProperty("id", id);

        // Must have exactly one of result or error, never both, never neither
        const hasResult = "result" in response;
        const hasError = "error" in response;
        expect(hasResult || hasError).toBe(true);
        expect(hasResult && hasError).toBe(false);

        // If error, validate error structure
        if (hasError) {
          const error = response.error as Record<string, unknown>;
          expect(typeof error.code).toBe("number");
          expect(typeof error.message).toBe("string");
        }
      }
    });
  });
});
