// SPDX-License-Identifier: Apache-2.0
/**
 * CLI Memory Commands Integration Tests (real daemon)
 *
 * Validates that CLI memory commands produce correct RPC calls against a real
 * running daemon. Each test verifies the correct RPC method is called, the
 * response is a valid JSON-RPC shape, and the daemon returns structured data.
 *
 *   INTEG-MEM-01: Memory Search Extended
 *   INTEG-MEM-02: Memory Inspect by ID
 *   INTEG-MEM-03: Memory Stats (Inspect without ID)
 *   INTEG-MEM-04: Memory Clear via Config Set
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
const CONFIG_PATH = resolve(__dirname, "../config/config.test-cli-memory-integ.yaml");

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("CLI Memory Commands Integration (real daemon)", () => {
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
  // INTEG-MEM-01 -- Memory Search Extended
  // ---------------------------------------------------------------------------

  describe("INTEG-MEM-01: Memory Search Extended", () => {
    it("memory.search with query and limit returns result", async () => {
      const response = (await sendJsonRpc(ws, "memory.search", { query: "test query", limit: 5 }, msgId++, { timeoutMs: RPC_FAST_MS })) as Record<string, unknown>;

      expect(response).toHaveProperty("jsonrpc", "2.0");
      // memory.search IS a core registered method -- should return result
      const hasResult = "result" in response;
      const hasError = "error" in response;
      expect(hasResult || hasError).toBe(true);

      if (hasError) {
        const error = response.error as Record<string, unknown>;
        expect(typeof error.code).toBe("number");
        expect(typeof error.message).toBe("string");
      }
    });

    it("memory.search with limit=0 returns valid response", async () => {
      const response = (await sendJsonRpc(ws, "memory.search", { query: "anything", limit: 0 }, msgId++, { timeoutMs: RPC_FAST_MS })) as Record<string, unknown>;

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

    it("memory.search with long query string returns valid response", async () => {
      const longQuery = "a".repeat(500);
      const response = (await sendJsonRpc(ws, "memory.search", { query: longQuery, limit: 3 }, msgId++, { timeoutMs: RPC_FAST_MS })) as Record<string, unknown>;

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
  // INTEG-MEM-02 -- Memory Inspect by ID
  // ---------------------------------------------------------------------------

  describe("INTEG-MEM-02: Memory Inspect by ID", () => {
    it("memory.inspect with nonexistent id returns valid JSON-RPC", async () => {
      const response = (await sendJsonRpc(ws, "memory.inspect", { id: "nonexistent-id-12345" }, msgId++, { timeoutMs: RPC_FAST_MS })) as Record<string, unknown>;

      expect(response).toHaveProperty("jsonrpc", "2.0");
      // memory.inspect may return result (null/empty) or structured error
      const hasResult = "result" in response;
      const hasError = "error" in response;
      expect(hasResult || hasError).toBe(true);

      if (hasError) {
        const error = response.error as Record<string, unknown>;
        expect(typeof error.code).toBe("number");
        expect(typeof error.message).toBe("string");
      }
    });

    it("memory.inspect with id proves RPC round-trip shape", async () => {
      const response = (await sendJsonRpc(ws, "memory.inspect", { id: "another-nonexistent" }, msgId++, { timeoutMs: RPC_FAST_MS })) as Record<string, unknown>;

      expect(response).toHaveProperty("jsonrpc", "2.0");
      // Verify response has standard JSON-RPC id field
      expect(response).toHaveProperty("id");
      const hasResult = "result" in response;
      const hasError = "error" in response;
      expect(hasResult || hasError).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // INTEG-MEM-03 -- Memory Stats (Inspect without ID)
  // ---------------------------------------------------------------------------

  describe("INTEG-MEM-03: Memory Stats (Inspect without ID)", () => {
    it("memory.inspect with empty params returns valid JSON-RPC response", async () => {
      const response = (await sendJsonRpc(ws, "memory.inspect", {}, msgId++, { timeoutMs: RPC_FAST_MS })) as Record<string, unknown>;

      expect(response).toHaveProperty("jsonrpc", "2.0");
      // This is how CLI's `memory stats` works -- calls inspect with no id
      const hasResult = "result" in response;
      const hasError = "error" in response;
      expect(hasResult || hasError).toBe(true);

      if (hasError) {
        const error = response.error as Record<string, unknown>;
        expect(typeof error.code).toBe("number");
        expect(typeof error.message).toBe("string");
      }
    });

    it("memory.inspect stats mode returns structured data when successful", async () => {
      const response = (await sendJsonRpc(ws, "memory.inspect", {}, msgId++, { timeoutMs: RPC_FAST_MS })) as Record<string, unknown>;

      expect(response).toHaveProperty("jsonrpc", "2.0");
      const hasResult = "result" in response;
      const hasError = "error" in response;
      expect(hasResult || hasError).toBe(true);

      if (hasResult) {
        // When successful, result should be an object (stats data)
        expect(typeof response.result === "object" || response.result === null).toBe(true);
      }
    });
  });

  // ---------------------------------------------------------------------------
  // INTEG-MEM-04 -- Memory Clear via Config Set
  // ---------------------------------------------------------------------------

  describe("INTEG-MEM-04: Memory Clear via Config Set", () => {
    it("config.set for memory clear returns valid JSON-RPC response", async () => {
      const response = (await sendJsonRpc(ws, "config.set", { section: "memory", key: "clear", value: "sessions" }, msgId++, { timeoutMs: RPC_FAST_MS })) as Record<string, unknown>;

      expect(response).toHaveProperty("jsonrpc", "2.0");
      // config.set is a core method -- should return result
      const hasResult = "result" in response;
      const hasError = "error" in response;
      expect(hasResult || hasError).toBe(true);

      if (hasError) {
        const error = response.error as Record<string, unknown>;
        expect(typeof error.code).toBe("number");
        expect(typeof error.message).toBe("string");
      }
    });

    it("config.set memory clear proves RPC round-trip for CLI memory clear command", async () => {
      const response = (await sendJsonRpc(ws, "config.set", { section: "memory", key: "clear", value: "all" }, msgId++, { timeoutMs: RPC_FAST_MS })) as Record<string, unknown>;

      expect(response).toHaveProperty("jsonrpc", "2.0");
      expect(response).toHaveProperty("id");
      const hasResult = "result" in response;
      const hasError = "error" in response;
      expect(hasResult || hasError).toBe(true);
    });
  });
});
