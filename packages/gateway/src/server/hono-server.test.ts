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

  // Plain-HTTP boot posture: the default install (loopback bind, no TLS, no
  // config.yaml) must NOT warn about itself — a loopback listener has no
  // off-host exposure, matching the system `tlsOff` posture finding and the
  // gateway-exposure security check (both flag only non-loopback binds). The
  // WARN is reserved for the bind that IS reachable off-host.
  describe("plain-HTTP boot posture (loopback vs non-loopback)", () => {
    it("start() on the default loopback bind logs NO without-TLS warning and no dev-mode label", async () => {
      const logger = createMockLogger();
      // port 0 → ephemeral bind; host stays the schema default 127.0.0.1
      const config = { ...defaultConfig(), port: 0 };
      const handle = createGatewayServer(createServerDeps({ logger, config }));
      await handle.start();
      try {
        const warnMsgs = (logger.warn as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => String(c[1] ?? c[0]));
        expect(warnMsgs.filter((m) => m.includes("without TLS"))).toEqual([]);

        const infoMsgs = (logger.info as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => String(c[1] ?? c[0]));
        const listenLine = infoMsgs.find((m) => m.includes("Gateway listening on http://"));
        expect(listenLine).toBeDefined();
        // A production loopback install is not "dev mode" — the label must state
        // the actual posture (plain HTTP, loopback-only bind).
        expect(listenLine).not.toContain("(dev mode)");
        expect(listenLine).toContain("loopback");
      } finally {
        await handle.stop();
      }
    });

    it("start() on a non-loopback bind without TLS still warns (off-host exposure)", async () => {
      const logger = createMockLogger();
      const config = { ...defaultConfig(), host: "0.0.0.0", port: 0 };
      const handle = createGatewayServer(createServerDeps({ logger, config }));
      await handle.start();
      try {
        expect(logger.warn).toHaveBeenCalledWith(
          expect.objectContaining({ errorKind: "config" }),
          "Gateway running without TLS -- configure gateway.tls for production",
        );
      } finally {
        await handle.stop();
      }
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

    // -----------------------------------------------------------------------
    // mcp-client-scoped tokens MUST NOT open a WebSocket.
    //
    // The /ws upgrade only called tokenStore.verify; no scope check
    // rejected mcp-client-only tokens. Such a token would successfully
    // upgrade and then silently fail every RPC method call with
    // -32603 "Insufficient scope" (because mcp-client satisfies neither
    // "rpc" nor "admin"). Wasting a connection slot, a rate-limit bucket,
    // and a WsConnectionManager entry; also a confusing debugging
    // experience for the credential holder.
    //
    // Fix: reject upgrades whose token has the `mcp-client` scope (which
    // is the SOLE scope of such tokens) at upgrade time, with a structured
    // WARN log and a 4003 close code.
    // -----------------------------------------------------------------------

    it("logs warning when WebSocket connection comes from an mcp-client-scoped token", async () => {
      const logger = createMockLogger();
      const token = "y".repeat(64);
      const handle = createGatewayServer(
        createServerDeps({
          logger,
          tokenStore: createTokenStore([
            {
              id: "mcp-only",
              secret: token,
              scopes: ["mcp-client"],
              mcpClient: {
                allowlist: [],
                sessionAllowlist: [],
                toolRateLimit: {},
              },
            },
          ]),
        }),
      );

      await handle.app.request("/ws", {
        headers: {
          authorization: `Bearer ${token}`,
          upgrade: "websocket",
          connection: "upgrade",
        },
      });

      // The warn log identifies the rejection cause + suggests the
      // correct endpoint for mcp-client tokens.
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          clientId: "mcp-only",
          errorKind: "auth",
          hint: expect.stringContaining("mcp-client"),
        }),
        expect.stringMatching(/mcp-client/i),
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
