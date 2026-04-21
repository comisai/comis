// SPDX-License-Identifier: Apache-2.0
import type { GatewayConfig } from "@comis/core";
import { GatewayConfigSchema } from "@comis/core";
import { JSONRPCServer } from "json-rpc-2.0";
import { describe, it, expect, vi } from "vitest";
import type { RpcContext } from "../rpc/method-router.js";
import type { GatewayLogger, GatewayServerDeps } from "./hono-server.js";
import { createTokenStore } from "../auth/token-auth.js";
import { WsConnectionManager } from "../rpc/ws-handler.js";
import { createGatewayServer } from "./hono-server.js";
import { createMockLogger as _createMockLogger } from "../../../../test/support/mock-logger.js";

const createMockLogger = (): GatewayLogger => _createMockLogger() as unknown as GatewayLogger;

/** Parse a default GatewayConfig (all defaults) */
function defaultConfig(overrides?: Partial<GatewayConfig>): GatewayConfig {
  return GatewayConfigSchema.parse(overrides ?? {});
}

/** Create minimal server deps for testing */
function createServerDeps(overrides?: Partial<GatewayServerDeps>): GatewayServerDeps {
  return {
    config: defaultConfig(),
    logger: createMockLogger(),
    tokenStore: createTokenStore([]),
    rpcServer: new JSONRPCServer<RpcContext>(),
    wsConnections: new WsConnectionManager(),
    ...overrides,
  };
}

describe("createGatewayServer", () => {
  it("creates a server handle with app, start, stop", () => {
    const handle = createGatewayServer(createServerDeps());

    expect(handle.app).toBeDefined();
    expect(typeof handle.start).toBe("function");
    expect(typeof handle.stop).toBe("function");
  });

  describe("health endpoint", () => {
    it("GET /health returns 200 with status ok", async () => {
      const handle = createGatewayServer(createServerDeps());

      const res = await handle.app.request("/health");
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.status).toBe("ok");
      expect(body.timestamp).toBeDefined();
    });

    it("GET /health response has valid ISO timestamp", async () => {
      const handle = createGatewayServer(createServerDeps());

      const res = await handle.app.request("/health");
      const body = await res.json();
      const parsed = new Date(body.timestamp);
      expect(parsed.getTime()).not.toBeNaN();
    });
  });

  describe("dev mode (no TLS)", () => {
    it("creates server without TLS config", async () => {
      const handle = createGatewayServer(createServerDeps());

      // Dev mode (no TLS) is the default — verify app works without TLS
      const res = await handle.app.request("/health");
      expect(res.status).toBe(200);
    });
  });

  describe("HTTP logging middleware", () => {
    it("logs Request completed for non-health requests", async () => {
      const logger = createMockLogger();
      const handle = createGatewayServer(createServerDeps({ logger }));

      await handle.app.request("/unknown");

      // Verify single "Request completed" line with method, path, status, durationMs
      expect(logger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          method: "GET",
          path: "/unknown",
          status: 404,
          durationMs: expect.any(Number),
        }),
        "Request completed",
      );
    });

    it("skips logging for /health endpoint", async () => {
      const logger = createMockLogger();
      const handle = createGatewayServer(createServerDeps({ logger }));

      await handle.app.request("/health");

      // logger.info should NOT have been called with "Request completed"
      const infoCalls = (logger.info as ReturnType<typeof vi.fn>).mock.calls;
      const requestCalls = infoCalls.filter(
        (call: unknown[]) => call[1] === "Request completed" || call[0] === "Request completed",
      );
      expect(requestCalls).toHaveLength(0);
    });

    it("skips logging for /api/health endpoint", async () => {
      const logger = createMockLogger();
      const handle = createGatewayServer(createServerDeps({ logger }));

      await handle.app.request("/api/health");

      const infoCalls = (logger.info as ReturnType<typeof vi.fn>).mock.calls;
      const requestCalls = infoCalls.filter(
        (call: unknown[]) => call[1] === "Request completed" || call[0] === "Request completed",
      );
      expect(requestCalls).toHaveLength(0);
    });
  });

  describe("WebSocket auth rejection logging", () => {
    it("logs warning when WebSocket connection has invalid token", async () => {
      const logger = createMockLogger();
      const handle = createGatewayServer(
        createServerDeps({
          logger,
          tokenStore: createTokenStore([]),
        }),
      );

      // Make a request to /ws — the upgrade handler will attempt auth
      // In unit tests, Hono's upgradeWebSocket processes the handler logic
      // but the actual WS upgrade may not complete. The warn log happens
      // before the WSEvents return, so it should fire during request processing.
      await handle.app.request("/ws", {
        headers: {
          authorization: "Bearer invalid-token",
          upgrade: "websocket",
          connection: "upgrade",
        },
      });

      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          sourceIp: expect.any(String),
          hint: "Verify client token matches a configured gateway.tokens entry",
          errorKind: "auth",
        }),
        "WebSocket connection rejected: invalid token",
      );
    });
  });

  describe("global rate limiting", () => {
    it("applies rate limiting to non-health routes", async () => {
      // Configure a very tight rate limit: 2 requests per 60s window
      const config = defaultConfig({
        rateLimit: { windowMs: 60_000, maxRequests: 2 },
      });
      const handle = createGatewayServer(createServerDeps({ config }));

      // First 2 requests should succeed (404 for unknown route, but not 429)
      const res1 = await handle.app.request("/some-endpoint");
      expect(res1.status).not.toBe(429);

      const res2 = await handle.app.request("/some-endpoint");
      expect(res2.status).not.toBe(429);

      // Third request should be rate limited
      const res3 = await handle.app.request("/some-endpoint");
      expect(res3.status).toBe(429);
    });

    it("exempts /health from rate limiting", async () => {
      const config = defaultConfig({
        rateLimit: { windowMs: 60_000, maxRequests: 1 },
      });
      const handle = createGatewayServer(createServerDeps({ config }));

      // Exhaust rate limit with a non-health request
      await handle.app.request("/some-endpoint");

      // Health endpoint should still work
      const res = await handle.app.request("/health");
      expect(res.status).toBe(200);
    });

    it("exempts /api/health from rate limiting", async () => {
      const config = defaultConfig({
        rateLimit: { windowMs: 60_000, maxRequests: 1 },
      });
      const handle = createGatewayServer(createServerDeps({ config }));

      // Exhaust rate limit with a non-health request
      await handle.app.request("/some-endpoint");

      // /api/health should still work (mounted as sub-app, but health exempt applies)
      const res = await handle.app.request("/api/health");
      expect(res.status).not.toBe(429);
    });
  });

  describe("404 for unknown routes", () => {
    it("returns 404 for unknown paths", async () => {
      const handle = createGatewayServer(createServerDeps());

      const res = await handle.app.request("/unknown");
      expect(res.status).toBe(404);
    });
  });

  describe("GatewayConfigSchema", () => {
    it("produces valid defaults from empty object", () => {
      const result = GatewayConfigSchema.safeParse({});
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.enabled).toBe(true);
        expect(result.data.host).toBe("127.0.0.1");
        expect(result.data.port).toBe(4766);
        expect(result.data.tls).toBeUndefined();
        expect(result.data.tokens).toEqual([]);
        expect(result.data.rateLimit.windowMs).toBe(60_000);
        expect(result.data.rateLimit.maxRequests).toBe(100);
        expect(result.data.maxBatchSize).toBe(50);
        expect(result.data.wsHeartbeatMs).toBe(30_000);
        expect(result.data.httpBodyLimitBytes).toBe(1_048_576);
      }
    });

    it("rejects unknown fields (.strict())", () => {
      const result = GatewayConfigSchema.safeParse({
        unknownField: true,
      });
      expect(result.success).toBe(false);
    });

    it("validates port range", () => {
      expect(GatewayConfigSchema.safeParse({ port: 0 }).success).toBe(false);
      expect(GatewayConfigSchema.safeParse({ port: 65536 }).success).toBe(false);
      expect(GatewayConfigSchema.safeParse({ port: 443 }).success).toBe(true);
    });

    it("validates token entries", () => {
      const result = GatewayConfigSchema.safeParse({
        tokens: [{ id: "api-key-1", secret: "s3cret-padded-to-meet-32-char-min", scopes: ["rpc"] }],
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.tokens[0].id).toBe("api-key-1");
        expect(result.data.tokens[0].scopes).toEqual(["rpc"]);
      }
    });

    it("rejects token secret shorter than 32 characters", () => {
      const result = GatewayConfigSchema.safeParse({
        tokens: [{ id: "api-key-1", secret: "too-short", scopes: ["rpc"] }],
      });
      expect(result.success).toBe(false);
    });

    it("accepts token entry without secret (optional)", () => {
      const result = GatewayConfigSchema.safeParse({
        tokens: [{ id: "api-key-1", scopes: ["rpc"] }],
      });
      expect(result.success).toBe(true);
    });
  });
});
