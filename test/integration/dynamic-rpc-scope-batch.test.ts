/**
 * SCOPE/BATCH: Dynamic RPC Scope Enforcement & Cross-Namespace Batch Tests
 *
 * Validates scope enforcement across namespaces, cross-namespace batch RPC
 * behavior, and error handling for the DynamicMethodRouter:
 *
 *   SCOPE-ADMIN: Admin-scoped methods (obs.*, config.read, gateway.status)
 *                reject rpc-only tokens with -32603
 *   SCOPE-RPC:   RPC-scoped methods (memory.search) succeed with rpc-only token
 *   ERR:         Unregistered methods return -32601 (method not found)
 *   BATCH:       Cross-namespace batch RPC returns per-method results
 *
 * Uses the dual-token config from Plan 01 (port 8492, admin + rpc-only tokens).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  startTestDaemon,
  type TestDaemonHandle,
} from "../support/daemon-harness.js";
import { openAuthenticatedWebSocket, sendJsonRpc } from "../support/ws-helpers.js";
import { RPC_FAST_MS } from "../support/timeouts.js";

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const CONFIG_PATH = resolve(
  __dirname,
  "../config/config.test-dynamic-rpc.yaml",
);

// ---------------------------------------------------------------------------
// Batch JSON-RPC helper
// ---------------------------------------------------------------------------

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/**
 * Send a JSON-RPC 2.0 batch request over WebSocket and wait for the batch response.
 *
 * Filters heartbeat notifications (same as sendJsonRpc). The json-rpc-2.0
 * library returns batch responses as a JSON array.
 */
function sendBatchJsonRpc(
  ws: WebSocket,
  requests: JsonRpcRequest[],
  timeoutMs: number,
): Promise<JsonRpcResponse[]> {
  return new Promise<JsonRpcResponse[]>((resolve, reject) => {
    const timeout = setTimeout(() => {
      ws.removeEventListener("message", handler);
      reject(
        new Error(
          `Batch JSON-RPC response timed out after ${timeoutMs / 1000}s`,
        ),
      );
    }, timeoutMs);

    function handler(evt: MessageEvent): void {
      let parsed: unknown;
      try {
        parsed = JSON.parse(
          typeof evt.data === "string" ? evt.data : String(evt.data),
        );
      } catch {
        return; // Ignore non-JSON messages
      }

      // Skip heartbeat notifications (no id, method === "heartbeat")
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        !Array.isArray(parsed) &&
        (parsed as Record<string, unknown>).method === "heartbeat"
      ) {
        return;
      }

      // Batch response is an array
      if (Array.isArray(parsed)) {
        clearTimeout(timeout);
        ws.removeEventListener("message", handler);
        resolve(parsed as JsonRpcResponse[]);
      }
    }

    ws.addEventListener("message", handler);
    ws.send(JSON.stringify(requests));
  });
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("SCOPE/BATCH: Dynamic RPC Scope Enforcement & Batch", () => {
  let handle: TestDaemonHandle;
  let adminWs: WebSocket;
  let rpcWs: WebSocket;

  // Separate RPC ID ranges to avoid collisions between connections
  let adminRpcId = 0;
  let rpcRpcId = 1000;

  beforeAll(async () => {
    handle = await startTestDaemon({ configPath: CONFIG_PATH });

    // Admin token — handle.authToken resolves to the first token's secret
    adminWs = await openAuthenticatedWebSocket(handle.gatewayUrl, handle.authToken);

    // RPC-only token — literal string from config (second token)
    rpcWs = await openAuthenticatedWebSocket(
      handle.gatewayUrl,
      "rpc-secret-for-dynamic-rpc-tests",
    );
  }, 120_000);

  afterAll(async () => {
    if (rpcWs) {
      rpcWs.close();
    }
    if (adminWs) {
      adminWs.close();
    }
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

  // -------------------------------------------------------------------------
  // SCOPE: Admin-scoped method rejection with rpc-only token
  // -------------------------------------------------------------------------

  describe("SCOPE: Admin-scoped method rejection with rpc-only token", () => {
    it("obs.diagnostics rejects rpc-only token", async () => {
      const response = (await sendJsonRpc(
        rpcWs,
        "obs.diagnostics",
        {},
        ++rpcRpcId,
        { timeoutMs: RPC_FAST_MS },
      )) as Record<string, unknown>;

      expect(response).toHaveProperty("error");
      expect(response).not.toHaveProperty("result");

      const error = response.error as Record<string, unknown>;
      expect(error.code).toBe(-32603);
      expect((error.message as string).toLowerCase()).toContain("insufficient scope");
    });

    it("config.read rejects rpc-only token", async () => {
      const response = (await sendJsonRpc(
        rpcWs,
        "config.read",
        {},
        ++rpcRpcId,
        { timeoutMs: RPC_FAST_MS },
      )) as Record<string, unknown>;

      expect(response).toHaveProperty("error");
      expect(response).not.toHaveProperty("result");

      const error = response.error as Record<string, unknown>;
      expect(error.code).toBe(-32603);
      expect((error.message as string).toLowerCase()).toContain("insufficient scope");
    });

    it("gateway.status rejects rpc-only token", async () => {
      const response = (await sendJsonRpc(
        rpcWs,
        "gateway.status",
        {},
        ++rpcRpcId,
        { timeoutMs: RPC_FAST_MS },
      )) as Record<string, unknown>;

      expect(response).toHaveProperty("error");
      expect(response).not.toHaveProperty("result");

      const error = response.error as Record<string, unknown>;
      expect(error.code).toBe(-32603);
      expect((error.message as string).toLowerCase()).toContain("insufficient scope");
    });

    it("admin token can call obs.diagnostics", async () => {
      const response = (await sendJsonRpc(
        adminWs,
        "obs.diagnostics",
        {},
        ++adminRpcId,
        { timeoutMs: RPC_FAST_MS },
      )) as Record<string, unknown>;

      expect(response).toHaveProperty("result");
      expect(response).not.toHaveProperty("error");

      const result = response.result as Record<string, unknown>;
      expect(Array.isArray(result.events)).toBe(true);
      expect(typeof result.counts).toBe("object");
    });
  });

  // -------------------------------------------------------------------------
  // SCOPE: RPC-scoped method access with rpc-only token
  // -------------------------------------------------------------------------

  describe("SCOPE: RPC-scoped method access with rpc-only token", () => {
    it("rpc-only token can access memory.search", async () => {
      const response = (await sendJsonRpc(
        rpcWs,
        "memory.search",
        { query: "test" },
        ++rpcRpcId,
        { timeoutMs: RPC_FAST_MS },
      )) as Record<string, unknown>;

      expect(response).toHaveProperty("result");
      expect(response).not.toHaveProperty("error");

      // memory.search returns results (may be empty on fresh daemon)
      expect(typeof response.result).toBe("object");
    });
  });

  // -------------------------------------------------------------------------
  // ERR: Unregistered method and error edge cases
  // -------------------------------------------------------------------------

  describe("ERR: Unregistered method and error edge cases", () => {
    it("unregistered namespaced method returns -32601", async () => {
      const response = (await sendJsonRpc(
        adminWs,
        "nonexistent.method",
        {},
        ++adminRpcId,
        { timeoutMs: RPC_FAST_MS },
      )) as Record<string, unknown>;

      expect(response).toHaveProperty("error");
      expect(response).not.toHaveProperty("result");

      const error = response.error as Record<string, unknown>;
      expect(error.code).toBe(-32601);
    });

    it("unregistered non-namespaced method returns -32601", async () => {
      const response = (await sendJsonRpc(
        adminWs,
        "bogusmethod",
        {},
        ++adminRpcId,
        { timeoutMs: RPC_FAST_MS },
      )) as Record<string, unknown>;

      expect(response).toHaveProperty("error");
      expect(response).not.toHaveProperty("result");

      const error = response.error as Record<string, unknown>;
      expect(error.code).toBe(-32601);
    });
  });

  // -------------------------------------------------------------------------
  // BATCH: Cross-namespace batch RPC
  // -------------------------------------------------------------------------

  describe("BATCH: Cross-namespace batch RPC", () => {
    it("batch with admin token returns all results", async () => {
      const requests: JsonRpcRequest[] = [
        { jsonrpc: "2.0", id: 500, method: "obs.diagnostics", params: {} },
        { jsonrpc: "2.0", id: 501, method: "gateway.status", params: {} },
        { jsonrpc: "2.0", id: 502, method: "obs.channels.all", params: {} },
      ];

      const responses = await sendBatchJsonRpc(adminWs, requests, RPC_FAST_MS);

      expect(Array.isArray(responses)).toBe(true);
      expect(responses.length).toBe(3);

      // Find each response by id
      const diag = responses.find((r) => r.id === 500);
      const status = responses.find((r) => r.id === 501);
      const channels = responses.find((r) => r.id === 502);

      expect(diag).toBeDefined();
      expect(diag!.result).toBeDefined();
      expect(diag!.error).toBeUndefined();

      expect(status).toBeDefined();
      expect(status!.result).toBeDefined();
      expect(status!.error).toBeUndefined();

      expect(channels).toBeDefined();
      expect(channels!.result).toBeDefined();
      expect(channels!.error).toBeUndefined();
    });

    it("batch with rpc-only token rejects admin methods", async () => {
      const requests: JsonRpcRequest[] = [
        { jsonrpc: "2.0", id: 2000, method: "obs.diagnostics", params: {} },
        { jsonrpc: "2.0", id: 2001, method: "memory.search", params: { query: "test" } },
      ];

      const responses = await sendBatchJsonRpc(rpcWs, requests, RPC_FAST_MS);

      expect(Array.isArray(responses)).toBe(true);
      expect(responses.length).toBe(2);

      // obs.diagnostics should be rejected (admin-scoped)
      const diagResp = responses.find((r) => r.id === 2000);
      expect(diagResp).toBeDefined();
      expect(diagResp!.error).toBeDefined();
      expect(diagResp!.error!.code).toBe(-32603);
      expect(diagResp!.error!.message.toLowerCase()).toContain("insufficient scope");

      // memory.search should succeed (rpc-scoped)
      const searchResp = responses.find((r) => r.id === 2001);
      expect(searchResp).toBeDefined();
      expect(searchResp!.result).toBeDefined();
      expect(searchResp!.error).toBeUndefined();
    });
  });
});
