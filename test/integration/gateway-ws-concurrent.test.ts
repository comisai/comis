// SPDX-License-Identifier: Apache-2.0
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  startTestDaemon,
  type TestDaemonHandle,
} from "../support/daemon-harness.js";
import { openAuthenticatedWebSocket, sendJsonRpc } from "../support/ws-helpers.js";
import { RPC_FAST_MS, ASYNC_SETTLE_MS } from "../support/timeouts.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const CONFIG_PATH = resolve(__dirname, "../config/config.test-gateway-ws-concurrent.yaml");

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("Gateway: Concurrent WebSocket RPC and Close-During-Flight", () => {
  let handle: TestDaemonHandle;

  beforeAll(async () => {
    handle = await startTestDaemon({ configPath: CONFIG_PATH });
  }, 60_000);

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

  // -------------------------------------------------------------------------
  // GW-02 — Concurrent WebSocket RPC per-connection correctness
  // -------------------------------------------------------------------------

  describe("GW-02: Concurrent WebSocket RPC", () => {
    it("3 concurrent WebSocket connections each receive correct per-connection RPC responses", async () => {
      const connections = await Promise.all(
        Array.from({ length: 3 }, () =>
          openAuthenticatedWebSocket(handle.gatewayUrl, handle.authToken),
        ),
      );

      try {
        // Send RPC calls simultaneously on all 3 connections with unique IDs
        const results = await Promise.all(
          connections.map((ws, i) =>
            sendJsonRpc(ws, "config.get", {}, (i + 1) * 100, { timeoutMs: RPC_FAST_MS }),
          ),
        );

        // Verify each response has the correct per-connection ID
        for (let i = 0; i < 3; i++) {
          const res = results[i] as Record<string, unknown>;
          expect(res.jsonrpc).toBe("2.0");
          expect(res.id).toBe((i + 1) * 100);
          expect(res.result).toBeDefined();
          expect(typeof res.result).toBe("object");
        }
      } finally {
        connections.forEach((ws) => ws.close());
      }
    });

    it("5 concurrent WebSocket connections with simultaneous RPC calls all succeed", async () => {
      const connections = await Promise.all(
        Array.from({ length: 5 }, () =>
          openAuthenticatedWebSocket(handle.gatewayUrl, handle.authToken),
        ),
      );

      try {
        // Send RPC calls simultaneously on all 5 connections with unique IDs 1-5
        const results = await Promise.all(
          connections.map((ws, i) =>
            sendJsonRpc(ws, "config.get", {}, i + 1, { timeoutMs: RPC_FAST_MS }),
          ),
        );

        // Verify all 5 responses have correct IDs
        for (let i = 0; i < 5; i++) {
          const res = results[i] as Record<string, unknown>;
          expect(res.jsonrpc).toBe("2.0");
          expect(res.id).toBe(i + 1);
          expect(res.result).toBeDefined();
          expect(typeof res.result).toBe("object");
        }
      } finally {
        connections.forEach((ws) => ws.close());
      }
    });
  });

  // -------------------------------------------------------------------------
  // GW-04 — WebSocket close during in-flight RPC
  // -------------------------------------------------------------------------

  describe("GW-04: WebSocket close during in-flight RPC", () => {
    it("closing WebSocket during in-flight RPC does not crash the gateway", async () => {
      const ws = await openAuthenticatedWebSocket(handle.gatewayUrl, handle.authToken);

      // Send a raw JSON-RPC message directly -- do NOT use sendJsonRpc
      // because we don't want to wait for the response
      ws.send(
        JSON.stringify({
          jsonrpc: "2.0",
          method: "config.get",
          params: {},
          id: 999,
        }),
      );

      // Close immediately without awaiting a response
      ws.close();

      // Wait for the server to process the close event
      await new Promise((resolve) => setTimeout(resolve, ASYNC_SETTLE_MS));

      // Verify gateway is still healthy (no crash)
      const healthRes = await fetch(`${handle.gatewayUrl}/health`);
      expect(healthRes.status).toBe(200);

      // Open a NEW WebSocket connection and send a successful RPC call
      // to verify no orphaned state
      let verifyWs: WebSocket | undefined;
      try {
        verifyWs = await openAuthenticatedWebSocket(handle.gatewayUrl, handle.authToken);
        const response = (await sendJsonRpc(verifyWs, "config.get", {}, 1000, {
          timeoutMs: RPC_FAST_MS,
        })) as Record<string, unknown>;

        expect(response.jsonrpc).toBe("2.0");
        expect(response.id).toBe(1000);
        expect(response.result).toBeDefined();
      } finally {
        verifyWs?.close();
      }
    });

    it("gateway remains stable after multiple rapid connect-send-close cycles", async () => {
      // Loop 3 times: open WS, send config.get immediately, close immediately
      for (let cycle = 0; cycle < 3; cycle++) {
        const ws = await openAuthenticatedWebSocket(handle.gatewayUrl, handle.authToken);

        ws.send(
          JSON.stringify({
            jsonrpc: "2.0",
            method: "config.get",
            params: {},
            id: 2000 + cycle,
          }),
        );

        ws.close();
      }

      // Wait for the server to process all close events
      await new Promise((resolve) => setTimeout(resolve, ASYNC_SETTLE_MS));

      // Verify health endpoint returns 200 after all cycles
      const healthRes = await fetch(`${handle.gatewayUrl}/health`);
      expect(healthRes.status).toBe(200);

      // Verify a new WS connection + RPC call succeeds
      let verifyWs: WebSocket | undefined;
      try {
        verifyWs = await openAuthenticatedWebSocket(handle.gatewayUrl, handle.authToken);
        const response = (await sendJsonRpc(verifyWs, "config.get", {}, 3000, {
          timeoutMs: RPC_FAST_MS,
        })) as Record<string, unknown>;

        expect(response.jsonrpc).toBe("2.0");
        expect(response.id).toBe(3000);
        expect(response.result).toBeDefined();
      } finally {
        verifyWs?.close();
      }
    });
  });
});
