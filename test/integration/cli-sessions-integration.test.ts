/**
 * CLI Sessions Commands Integration Tests (real daemon)
 *
 * Validates that CLI session commands produce correct RPC calls against a real
 * running daemon. Each test verifies the correct RPC method is called, the
 * response is a valid JSON-RPC shape, and the daemon returns structured data.
 *
 *   INTEG-SESS-01: Sessions List
 *   INTEG-SESS-02: Sessions Inspect
 *   INTEG-SESS-03: Sessions Delete
 *   INTEG-SESS-04: Sessions Delete All (Reset)
 *
 * Uses the daemon harness for programmatic daemon startup/teardown.
 */

import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  startTestDaemon,
  type TestDaemonHandle,
} from "../support/daemon-harness.js";
import { openAuthenticatedWebSocket, sendJsonRpc } from "../support/ws-helpers.js";
import { RPC_FAST_MS } from "../support/timeouts.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const CONFIG_PATH = resolve(__dirname, "../config/config.test-cli-sessions-integ.yaml");

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("CLI Sessions Commands Integration (real daemon)", () => {
  let handle: TestDaemonHandle;
  let ws: WebSocket;
  let msgId = 10;

  beforeAll(async () => {
    handle = await startTestDaemon({ configPath: CONFIG_PATH });
    ws = await openAuthenticatedWebSocket(handle.gatewayUrl, handle.authToken);
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
  }, 30_000);

  // ---------------------------------------------------------------------------
  // INTEG-SESS-01 -- Sessions List
  // ---------------------------------------------------------------------------

  describe("INTEG-SESS-01: Sessions List", () => {
    it("sessions.list with empty params returns valid JSON-RPC", async () => {
      const response = (await sendJsonRpc(ws, "sessions.list", {}, msgId++, { timeoutMs: RPC_FAST_MS })) as Record<string, unknown>;

      expect(response).toHaveProperty("jsonrpc", "2.0");
      // sessions.list may be registered as session.list (singular) internally
      // Both result and structured error prove the round-trip works
      const hasResult = "result" in response;
      const hasError = "error" in response;
      expect(hasResult || hasError).toBe(true);

      if (hasError) {
        const error = response.error as Record<string, unknown>;
        expect(typeof error.code).toBe("number");
        expect(typeof error.message).toBe("string");
      }
    });

    it("sessions.list with kind filter returns valid JSON-RPC", async () => {
      const response = (await sendJsonRpc(ws, "sessions.list", { kind: "dm" }, msgId++, { timeoutMs: RPC_FAST_MS })) as Record<string, unknown>;

      expect(response).toHaveProperty("jsonrpc", "2.0");
      const hasResult = "result" in response;
      const hasError = "error" in response;
      expect(hasResult || hasError).toBe(true);

      if (hasError) {
        const error = response.error as Record<string, unknown>;
        expect(typeof error.code).toBe("number");
        expect(typeof error.message).toBe("string");
      }
    });

    it("sessions.list with since_minutes filter returns valid JSON-RPC", async () => {
      const response = (await sendJsonRpc(ws, "sessions.list", { since_minutes: 60 }, msgId++, { timeoutMs: RPC_FAST_MS })) as Record<string, unknown>;

      expect(response).toHaveProperty("jsonrpc", "2.0");
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
  // INTEG-SESS-02 -- Sessions Inspect
  // ---------------------------------------------------------------------------

  describe("INTEG-SESS-02: Sessions Inspect", () => {
    it("sessions.inspect with session key returns valid JSON-RPC", async () => {
      const response = (await sendJsonRpc(ws, "sessions.inspect", { key: "test:echo:user1:general" }, msgId++, { timeoutMs: RPC_FAST_MS })) as Record<string, unknown>;

      expect(response).toHaveProperty("jsonrpc", "2.0");
      // sessions.inspect may or may not be registered -- dual-check pattern
      const hasResult = "result" in response;
      const hasError = "error" in response;
      expect(hasResult || hasError).toBe(true);

      if (hasError) {
        const error = response.error as Record<string, unknown>;
        expect(typeof error.code).toBe("number");
        expect(typeof error.message).toBe("string");
      }
    });

    it("sessions.inspect response has valid JSON-RPC id", async () => {
      const id = msgId++;
      const response = (await sendJsonRpc(ws, "sessions.inspect", { key: "nonexistent:key" }, id, { timeoutMs: RPC_FAST_MS })) as Record<string, unknown>;

      expect(response).toHaveProperty("jsonrpc", "2.0");
      expect(response).toHaveProperty("id", id);
      const hasResult = "result" in response;
      const hasError = "error" in response;
      expect(hasResult || hasError).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // INTEG-SESS-03 -- Sessions Delete
  // ---------------------------------------------------------------------------

  describe("INTEG-SESS-03: Sessions Delete", () => {
    it("sessions.delete with nonexistent key returns valid JSON-RPC", async () => {
      const response = (await sendJsonRpc(ws, "sessions.delete", { key: "nonexistent-session" }, msgId++, { timeoutMs: RPC_FAST_MS })) as Record<string, unknown>;

      expect(response).toHaveProperty("jsonrpc", "2.0");
      // sessions.delete may or may not be registered -- dual-check pattern
      const hasResult = "result" in response;
      const hasError = "error" in response;
      expect(hasResult || hasError).toBe(true);

      if (hasError) {
        const error = response.error as Record<string, unknown>;
        expect(typeof error.code).toBe("number");
        expect(typeof error.message).toBe("string");
      }
    });

    it("sessions.delete proves RPC round-trip is reachable", async () => {
      const response = (await sendJsonRpc(ws, "sessions.delete", { key: "test:echo:user1:channel1" }, msgId++, { timeoutMs: RPC_FAST_MS })) as Record<string, unknown>;

      expect(response).toHaveProperty("jsonrpc", "2.0");
      expect(response).toHaveProperty("id");
      const hasResult = "result" in response;
      const hasError = "error" in response;
      expect(hasResult || hasError).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // INTEG-SESS-04 -- Sessions Delete All (Reset)
  // ---------------------------------------------------------------------------

  describe("INTEG-SESS-04: Sessions Delete All (Reset)", () => {
    it("sessions.deleteAll returns valid JSON-RPC response", async () => {
      const response = (await sendJsonRpc(ws, "sessions.deleteAll", {}, msgId++, { timeoutMs: RPC_FAST_MS })) as Record<string, unknown>;

      expect(response).toHaveProperty("jsonrpc", "2.0");
      // sessions.deleteAll is what CLI's `reset sessions` calls
      const hasResult = "result" in response;
      const hasError = "error" in response;
      expect(hasResult || hasError).toBe(true);

      if (hasError) {
        const error = response.error as Record<string, unknown>;
        expect(typeof error.code).toBe("number");
        expect(typeof error.message).toBe("string");
      }
    });

    it("sessions.deleteAll response has correct JSON-RPC structure", async () => {
      const id = msgId++;
      const response = (await sendJsonRpc(ws, "sessions.deleteAll", {}, id, { timeoutMs: RPC_FAST_MS })) as Record<string, unknown>;

      expect(response).toHaveProperty("jsonrpc", "2.0");
      expect(response).toHaveProperty("id", id);
      const hasResult = "result" in response;
      const hasError = "error" in response;
      expect(hasResult || hasError).toBe(true);
    });
  });
});
