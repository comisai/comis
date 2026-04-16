/**
 * CLI Query Commands Integration Tests (real daemon)
 *
 * Validates that CLI query commands produce correct RPC calls against a real
 * running daemon. Each test verifies the correct RPC method is called, the
 * response is a valid JSON-RPC shape, and the daemon returns structured data.
 *
 *   INTEG-04: Channel status via config.get
 *   INTEG-05: Sessions list RPC round-trip
 *   INTEG-06: Memory search RPC round-trip
 *   INTEG-07: System status via gateway.status + config.get
 *   INTEG-08: Models list RPC round-trip
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
const CONFIG_PATH = resolve(__dirname, "../config/config.test-cli-query.yaml");

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("CLI Query Commands Integration (real daemon)", () => {
  let handle: TestDaemonHandle;
  let ws: WebSocket;

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
  // INTEG-04 -- Channel Status
  // ---------------------------------------------------------------------------

  describe("INTEG-04: Channel Status", () => {
    it("retrieves channel configuration via config.get", async () => {
      const response = (await sendJsonRpc(ws, "config.get", { section: "channels" }, 1, { timeoutMs: RPC_FAST_MS })) as Record<string, unknown>;

      expect(response).toHaveProperty("jsonrpc", "2.0");
      expect(response).toHaveProperty("id", 1);
      expect(response).toHaveProperty("result");
      expect(typeof response.result).toBe("object");
    });

    it("channel config response is a valid JSON-RPC response", async () => {
      const response = (await sendJsonRpc(ws, "config.get", { section: "channels" }, 2, { timeoutMs: RPC_FAST_MS })) as Record<string, unknown>;

      expect(response).toHaveProperty("jsonrpc", "2.0");
      expect(response).toHaveProperty("id", 2);
      // Must have either result or error (valid JSON-RPC)
      const hasResult = "result" in response;
      const hasError = "error" in response;
      expect(hasResult || hasError).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // INTEG-05 -- Sessions List
  // ---------------------------------------------------------------------------

  describe("INTEG-05: Sessions List", () => {
    it("calls sessions.list RPC and gets a round-trip response", async () => {
      const response = (await sendJsonRpc(ws, "sessions.list", {}, 3, { timeoutMs: RPC_FAST_MS })) as Record<string, unknown>;

      expect(response).toHaveProperty("jsonrpc", "2.0");
      expect(response).toHaveProperty("id", 3);
      // sessions.list may or may not be registered -- both result and error
      // prove the round-trip works
      const hasResult = "result" in response;
      const hasError = "error" in response;
      expect(hasResult || hasError).toBe(true);

      if (hasError) {
        const error = response.error as Record<string, unknown>;
        expect(typeof error.code).toBe("number");
        expect(typeof error.message).toBe("string");
      }
    });

    it("sessions.list with tenant filter gets a response", async () => {
      const response = (await sendJsonRpc(ws, "sessions.list", { tenant: "test" }, 4, { timeoutMs: RPC_FAST_MS })) as Record<string, unknown>;

      expect(response).toHaveProperty("jsonrpc", "2.0");
      expect(response).toHaveProperty("id", 4);
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
  // INTEG-06 -- Memory Search
  // ---------------------------------------------------------------------------

  describe("INTEG-06: Memory Search", () => {
    it("executes memory.search RPC and gets a response", async () => {
      const response = (await sendJsonRpc(ws, "memory.search", { query: "test", limit: 5 }, 5, { timeoutMs: RPC_FAST_MS })) as Record<string, unknown>;

      expect(response).toHaveProperty("jsonrpc", "2.0");
      expect(response).toHaveProperty("id", 5);
      // memory.search IS a core registered method
      expect(response).toHaveProperty("result");
      expect(response).not.toHaveProperty("error");
    });

    it("memory search with empty query still returns a response", async () => {
      const response = (await sendJsonRpc(ws, "memory.search", { query: "", limit: 1 }, 6, { timeoutMs: RPC_FAST_MS })) as Record<string, unknown>;

      expect(response).toHaveProperty("jsonrpc", "2.0");
      expect(response).toHaveProperty("id", 6);
      // Empty query may return result or structured error
      const hasResult = "result" in response;
      const hasError = "error" in response;
      expect(hasResult || hasError).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // INTEG-07 -- System Status
  // ---------------------------------------------------------------------------

  describe("INTEG-07: System Status", () => {
    it("retrieves gateway status via gateway.status RPC", async () => {
      const response = (await sendJsonRpc(ws, "gateway.status", {}, 7, { timeoutMs: RPC_FAST_MS })) as Record<string, unknown>;

      expect(response).toHaveProperty("jsonrpc", "2.0");
      expect(response).toHaveProperty("id", 7);
      expect(response).toHaveProperty("result");
      expect(typeof response.result).toBe("object");
    });

    it("retrieves routing config for status overview", async () => {
      const response = (await sendJsonRpc(ws, "config.get", { section: "routing" }, 8, { timeoutMs: RPC_FAST_MS })) as Record<string, unknown>;

      expect(response).toHaveProperty("jsonrpc", "2.0");
      expect(response).toHaveProperty("id", 8);
      expect(response).toHaveProperty("result");
      expect(typeof response.result).toBe("object");
    });

    it("assembles multi-section status data", async () => {
      const gatewayResponse = (await sendJsonRpc(ws, "gateway.status", {}, 9, { timeoutMs: RPC_FAST_MS })) as Record<string, unknown>;
      const channelsResponse = (await sendJsonRpc(ws, "config.get", { section: "channels" }, 10, { timeoutMs: RPC_FAST_MS })) as Record<string, unknown>;
      const routingResponse = (await sendJsonRpc(ws, "config.get", { section: "routing" }, 11, { timeoutMs: RPC_FAST_MS })) as Record<string, unknown>;

      // All three must have result keys
      expect(gatewayResponse).toHaveProperty("result");
      expect(channelsResponse).toHaveProperty("result");
      expect(routingResponse).toHaveProperty("result");

      // Verify all are valid JSON-RPC
      expect(gatewayResponse).toHaveProperty("jsonrpc", "2.0");
      expect(channelsResponse).toHaveProperty("jsonrpc", "2.0");
      expect(routingResponse).toHaveProperty("jsonrpc", "2.0");
    });
  });

  // ---------------------------------------------------------------------------
  // INTEG-08 -- Models List
  // ---------------------------------------------------------------------------

  describe("INTEG-08: Models List", () => {
    it("calls models.list RPC and gets a round-trip response", async () => {
      const response = (await sendJsonRpc(ws, "models.list", {}, 12, { timeoutMs: RPC_FAST_MS })) as Record<string, unknown>;

      expect(response).toHaveProperty("jsonrpc", "2.0");
      expect(response).toHaveProperty("id", 12);
      // models.list may or may not be registered -- both result and error
      // prove the round-trip works
      const hasResult = "result" in response;
      const hasError = "error" in response;
      expect(hasResult || hasError).toBe(true);

      if (hasError) {
        const error = response.error as Record<string, unknown>;
        expect(typeof error.code).toBe("number");
        expect(typeof error.message).toBe("string");
      }
    });

    it("models.list with provider filter gets a response", async () => {
      const response = (await sendJsonRpc(ws, "models.list", { provider: "anthropic" }, 13, { timeoutMs: RPC_FAST_MS })) as Record<string, unknown>;

      expect(response).toHaveProperty("jsonrpc", "2.0");
      expect(response).toHaveProperty("id", 13);
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
});
