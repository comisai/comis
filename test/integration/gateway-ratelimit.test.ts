// SPDX-License-Identifier: Apache-2.0
/**
 * Gateway Rate Limiter Boundary + JSON-RPC Error Format Integration Tests
 *
 * Two test suites:
 * 1. Package-level rate limiter tests (app.request() -- no daemon, fast and deterministic)
 *    - GW-05: Exact boundary enforcement
 *    - GW-06: Window reset after expiry
 *    - GW-07: Per-client keying and anonymous sharing
 * 2. Daemon-level JSON-RPC error format tests (real daemon via startTestDaemon)
 *    - GW-09: Parse error, method not found, batch exceeded, insufficient scope
 *
 * @module
 */

import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Hono } from "hono";
import { createRateLimiter } from "@comis/gateway";
import { startTestDaemon, type TestDaemonHandle } from "../support/daemon-harness.js";
import { openAuthenticatedWebSocket, sendJsonRpc } from "../support/ws-helpers.js";
import { RPC_FAST_MS } from "../support/timeouts.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const CONFIG_PATH = resolve(__dirname, "../config/config.test-gateway-ratelimit.yaml");

// ---------------------------------------------------------------------------
// Package-level helper: Hono app with rate limiting for fast boundary tests
// ---------------------------------------------------------------------------

function createTestApp(maxRequests: number, windowMs = 60_000) {
  const app = new Hono();

  // Simulated auth middleware: set clientId from query param
  app.use("*", async (c, next) => {
    const clientId = c.req.query("clientId");
    if (clientId) {
      c.set("clientId", clientId);
    }
    await next();
  });

  // Apply rate limiter
  app.use("*", createRateLimiter({ windowMs, maxRequests }));

  // Test endpoint
  app.post("/rpc", (c) => c.json({ result: "ok" }));

  return app;
}

// ===========================================================================
// DESCRIBE BLOCK 1: Package-level rate limiter tests
// ===========================================================================

describe("Rate Limiter: Boundary, Reset, and Per-Client Keying", () => {
  // -------------------------------------------------------------------------
  // GW-05: Exact boundary enforcement
  // -------------------------------------------------------------------------

  it("exactly maxRequests requests succeed, maxRequests+1 returns 429 with JSON-RPC error", async () => {
    const maxRequests = 5;
    const app = createTestApp(maxRequests);

    // Send exactly maxRequests requests -- all should succeed
    for (let i = 0; i < maxRequests; i++) {
      const res = await app.request("/rpc?clientId=boundary-client", { method: "POST" });
      expect(res.status).toBe(200);
    }

    // The (maxRequests + 1)th request should be rate limited
    const limited = await app.request("/rpc?clientId=boundary-client", { method: "POST" });
    expect(limited.status).toBe(429);

    // Verify the 429 body is a well-formed JSON-RPC error
    const body = await limited.json();
    expect(body.jsonrpc).toBe("2.0");
    expect(body.error.code).toBe(-32000);
    expect(body.error.message).toBe("Rate limit exceeded");
    expect(body.id).toBeNull();
  });

  // -------------------------------------------------------------------------
  // GW-06: Window reset
  // -------------------------------------------------------------------------

  it("rate limit resets after window expiry and allows requests again", async () => {
    const maxRequests = 2;
    const windowMs = 1500; // 1.5 second window for fast testing
    const app = createTestApp(maxRequests, windowMs);

    // Exhaust the rate limit
    for (let i = 0; i < maxRequests; i++) {
      const res = await app.request("/rpc?clientId=reset-client", { method: "POST" });
      expect(res.status).toBe(200);
    }

    // Verify rate limited
    const limited = await app.request("/rpc?clientId=reset-client", { method: "POST" });
    expect(limited.status).toBe(429);

    // Wait for window to expire (windowMs + buffer)
    await new Promise((r) => setTimeout(r, 2000));

    // Should succeed again after window reset
    // MemoryStore resets on next request after window expiry (per Research pitfall 5)
    const reset = await app.request("/rpc?clientId=reset-client", { method: "POST" });
    expect(reset.status).toBe(200);
  });

  // -------------------------------------------------------------------------
  // GW-07: Per-client keying
  // -------------------------------------------------------------------------

  it("separate clientIds have independent rate limits", async () => {
    const maxRequests = 2;
    const app = createTestApp(maxRequests);

    // Client-alpha exhausts its quota
    for (let i = 0; i < maxRequests; i++) {
      const res = await app.request("/rpc?clientId=alpha", { method: "POST" });
      expect(res.status).toBe(200);
    }

    // Client-alpha is now rate limited
    const alphaLimited = await app.request("/rpc?clientId=alpha", { method: "POST" });
    expect(alphaLimited.status).toBe(429);

    // Client-beta should still have its own independent quota
    const betaOk = await app.request("/rpc?clientId=beta", { method: "POST" });
    expect(betaOk.status).toBe(200);
  });

  it("requests without clientId share a single rate limit key", async () => {
    const maxRequests = 2;
    const app = createTestApp(maxRequests);

    // Send 2 requests WITHOUT clientId -- both should succeed
    for (let i = 0; i < maxRequests; i++) {
      const res = await app.request("/rpc", { method: "POST" });
      expect(res.status).toBe(200);
    }

    // Third request without clientId should be rate limited (shared IP-based key)
    const limited = await app.request("/rpc", { method: "POST" });
    expect(limited.status).toBe(429);
  });
});

// ===========================================================================
// DESCRIBE BLOCK 2: Daemon-level JSON-RPC error format tests (GW-09)
// ===========================================================================

describe("Gateway: JSON-RPC Error Format Compliance (GW-09)", () => {
  let handle: TestDaemonHandle;
  const rpcOnlyToken = "rpc-only-secret-key-for-ratelimit-tests";

  beforeAll(async () => {
    handle = await startTestDaemon({ configPath: CONFIG_PATH });
  }, 60_000);

  afterAll(async () => {
    if (handle) {
      try {
        await handle.cleanup();
      } catch (err) {
        // Expected: graceful shutdown calls the overridden exit() which throws.
        // "Daemon exit with code 0" is normal shutdown. Suppress it.
        const msg = err instanceof Error ? err.message : String(err);
        if (!msg.includes("Daemon exit with code")) {
          throw err;
        }
      }
    }
  }, 30_000);

  // -------------------------------------------------------------------------
  // GW-09 Test 1: Parse error (-32700)
  // -------------------------------------------------------------------------

  it("invalid JSON over WebSocket returns parse error -32700", async () => {
    const ws = await openAuthenticatedWebSocket(handle.gatewayUrl, handle.authToken);
    try {
      // Send invalid JSON (NOT using sendJsonRpc which constructs valid JSON)
      ws.send("not valid json{{{");

      // Listen for the error response manually (sendJsonRpc expects a matching id)
      const errorMsg = await new Promise<Record<string, unknown>>((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error("No error response within 5s")),
          5000,
        );
        const handler = (evt: MessageEvent) => {
          let msg: Record<string, unknown>;
          try {
            msg = JSON.parse(typeof evt.data === "string" ? evt.data : String(evt.data));
          } catch {
            return; // Ignore non-JSON messages
          }
          if (msg.error) {
            clearTimeout(timeout);
            ws.removeEventListener("message", handler);
            resolve(msg);
          }
        };
        ws.addEventListener("message", handler);
      });

      expect(errorMsg.jsonrpc).toBe("2.0");
      expect((errorMsg.error as Record<string, unknown>).code).toBe(-32700);
      expect((errorMsg.error as Record<string, unknown>).message).toBe("Parse error");
      expect(errorMsg.id).toBeNull();
    } finally {
      ws.close();
    }
  });

  // -------------------------------------------------------------------------
  // GW-09 Test 2: Method not found (-32601)
  // -------------------------------------------------------------------------

  it("nonexistent RPC method returns method not found -32601", async () => {
    const ws = await openAuthenticatedWebSocket(handle.gatewayUrl, handle.authToken);
    try {
      const response = (await sendJsonRpc(ws, "nonexistent.method", {}, 42, {
        timeoutMs: RPC_FAST_MS,
      })) as Record<string, unknown>;

      expect(response.jsonrpc).toBe("2.0");
      expect(response.id).toBe(42);
      expect((response.error as Record<string, unknown>).code).toBe(-32601);
    } finally {
      ws.close();
    }
  });

  // -------------------------------------------------------------------------
  // GW-09 Test 3: Batch size exceeded (-32600)
  // -------------------------------------------------------------------------

  it("oversized batch returns batch size exceeded -32600", async () => {
    const ws = await openAuthenticatedWebSocket(handle.gatewayUrl, handle.authToken);
    try {
      // Send a batch of 4 items (maxBatchSize is 3 in the config)
      ws.send(
        JSON.stringify([
          { jsonrpc: "2.0", method: "config.get", params: {}, id: 1 },
          { jsonrpc: "2.0", method: "config.get", params: {}, id: 2 },
          { jsonrpc: "2.0", method: "config.get", params: {}, id: 3 },
          { jsonrpc: "2.0", method: "config.get", params: {}, id: 4 },
        ]),
      );

      // Listen for the error response manually (batch error has no matching id)
      const errorMsg = await new Promise<Record<string, unknown>>((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error("No error response within 5s")),
          5000,
        );
        const handler = (evt: MessageEvent) => {
          let msg: Record<string, unknown>;
          try {
            msg = JSON.parse(typeof evt.data === "string" ? evt.data : String(evt.data));
          } catch {
            return; // Ignore non-JSON messages
          }
          if (msg.error) {
            clearTimeout(timeout);
            ws.removeEventListener("message", handler);
            resolve(msg);
          }
        };
        ws.addEventListener("message", handler);
      });

      expect(errorMsg.jsonrpc).toBe("2.0");
      expect((errorMsg.error as Record<string, unknown>).code).toBe(-32600);
      const errorMessage = (errorMsg.error as Record<string, unknown>).message as string;
      expect(errorMessage).toContain("Batch size");
      expect(errorMessage).toContain("exceeds maximum");
      expect(errorMsg.id).toBeNull();
    } finally {
      ws.close();
    }
  });

  // -------------------------------------------------------------------------
  // GW-09 Test 4: Insufficient scope (-32603)
  // -------------------------------------------------------------------------

  it("calling admin method with rpc-only token returns insufficient scope -32603", async () => {
    // Connect with the rpc-only token (no "admin" scope)
    const ws = await openAuthenticatedWebSocket(handle.gatewayUrl, rpcOnlyToken);
    try {
      // config.get requires "admin" scope
      const response = (await sendJsonRpc(ws, "config.get", {}, 77, {
        timeoutMs: RPC_FAST_MS,
      })) as Record<string, unknown>;

      expect(response.jsonrpc).toBe("2.0");
      expect(response.id).toBe(77);
      expect((response.error as Record<string, unknown>).code).toBe(-32603);
      const errorMessage = (response.error as Record<string, unknown>).message as string;
      expect(errorMessage).toContain("Insufficient scope");
      expect(errorMessage).toContain("admin");
    } finally {
      ws.close();
    }
  });
});
