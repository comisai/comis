// SPDX-License-Identifier: Apache-2.0
import type { GatewayConfig, TypedEventBus } from "@comis/core";
import { tryGetContext, systemNowDate, isLoopbackHost } from "@comis/core";
import type { WSContext, WSEvents } from "hono/ws";
import type { JSONRPCServer } from "json-rpc-2.0";
import { serve } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";
import { Hono } from "hono";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { createServer as createHttpsServer } from "node:https";
import type { RpcContext } from "../rpc/method-router.js";
import type { RpcAdapterDeps } from "../rpc/rpc-adapters.js";
import { validateCertificates } from "../auth/mtls-verifier.js";
import { extractBearerToken, type TokenClient, type TokenStore } from "../auth/token-auth.js";
import { getConnInfo } from "@hono/node-server/conninfo";
import { createRateLimiter } from "../rate-limit/rate-limiter.js";
import { createWsHandler, WsConnectionManager } from "../rpc/ws-handler.js";
import { createRestApi, ActivityRingBuffer, subscribeActivityBuffer } from "../web/rest-api.js";
import { createSseEndpoint } from "../web/sse-endpoint.js";
import { createStaticMiddleware } from "../web/static-middleware.js";
import { mountMcpServerEndpoint } from "../mcp-server-endpoint.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { GatewayLogger } from "./gateway-logger.js";

export type { GatewayLogger };

/**
 * Dependencies for creating a gateway server.
 */
export interface GatewayServerDeps {
  /** Gateway configuration */
  readonly config: GatewayConfig;
  /** Logger instance */
  readonly logger: GatewayLogger;
  /** Token store for bearer token verification on WS connections */
  readonly tokenStore: TokenStore;
  /** Configured JSON-RPC method router */
  readonly rpcServer: JSONRPCServer<RpcContext>;
  /** WebSocket connection lifecycle tracker */
  readonly wsConnections: WsConnectionManager;
  /** Optional web dashboard deps (mount REST/SSE/static when provided) */
  readonly webDeps?: {
    /** Event bus for SSE streaming and activity buffer */
    eventBus: TypedEventBus;
    /** RPC adapter deps for REST API data access */
    rpcAdapterDeps: RpcAdapterDeps;
    /** Path to @comis/web dist directory for static serving (optional) */
    webDistPath?: string;
    /** Set of suspended agent IDs for status reporting */
    suspendedAgents?: ReadonlySet<string>;
  };
  /** Daemon fingerprint surfaced on /health so clients can verify which
   *  daemon they are actually talking to (defeats local-port-collision
   *  traffic misrouting). Omit for test harnesses. */
  readonly fingerprint?: {
    instanceId: string;
    startedAt: string;
  };
  /** Per-client McpServer factory. When provided, the gateway mounts
   *  `POST /mcp/v1` between the global rate-limit middleware and the
   *  catch-all 404 handler. Omit to leave the route unmounted
   *  (deployments that disable the MCP server). */
  readonly buildMcpServerForClient?: (client: TokenClient) => McpServer;
}

/**
 * Handle returned by createGatewayServer for lifecycle management.
 */
export interface GatewayServerHandle {
  /** The Hono application instance */
  readonly app: Hono;
  /** Start listening on the configured host:port */
  start(): Promise<void>;
  /** Gracefully stop the server */
  stop(): Promise<void>;
}

/**
 * Create a gateway server with Hono.
 *
 * Supports two modes:
 * - **TLS mode**: HTTPS with optional mTLS client certificate verification
 * - **Dev mode**: Plain HTTP with warning log (when tls config is omitted)
 *
 * Routes:
 * - GET /health — health check (always available)
 * - GET /ws — WebSocket with token auth + rate limiting
 * - GET /api/* — REST API + SSE endpoints (if webDeps provided)
 * - GET /app/* — Static web dashboard files (if webDeps.webDistPath provided)
 */
export function createGatewayServer(deps: GatewayServerDeps): GatewayServerHandle {
  const { config, logger } = deps;
  const app = new Hono();

  // Set up WebSocket support via @hono/node-ws
  const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });

  // HTTP logging middleware — runs before all other middleware
  // Skips health check paths to avoid log flooding from health check polls
  app.use(async (c, next) => {
    if (c.req.path === "/health" || c.req.path === "/api/health") {
      return next();
    }
    const requestId = randomUUID().slice(0, 8);
    const startMs = performance.now();
    await next();
    const durationMs = Math.round(performance.now() - startMs);
    // clientId is set by downstream auth middleware; not in Hono's type system here
    const clientId = (c as unknown as { get(key: string): string | undefined }).get("clientId");
    const ctx = tryGetContext();
    logger.info(
      {
        requestId,
        method: c.req.method,
        path: c.req.path,
        status: c.res.status,
        durationMs,
        ...(clientId ? { clientId } : {}),
        ...(ctx?.traceId ? { traceId: ctx.traceId } : {}),
      },
      "Request completed",
    );
  });

  // Create rate limiter middleware
  const rateLimiterMw = createRateLimiter(config.rateLimit, logger);

  // Apply rate limiter globally to all HTTP endpoints except health checks.
  // Health checks are exempt to avoid false positives from monitoring probes.
  app.use("*", async (c, next) => {
    if (c.req.path === "/health" || c.req.path === "/api/health") {
      return next();
    }
    return rateLimiterMw(c, next);
  });

  // MCP server endpoint. MUST be mounted AFTER the global rate-limit
  // middleware (so layer-1 IP caps apply) and BEFORE the catch-all
  // `app.notFound` handler (so /mcp/v1 doesn't fall through to the 404
  // branch). Per-client tools/list filter is enforced inside
  // `buildMcpServerForClient` via the side-channel mcpExportPolicy registry.
  if (deps.buildMcpServerForClient) {
    mountMcpServerEndpoint(
      // The Hono app is constructed without an explicit Bindings parameter,
      // but `@hono/node-server` injects `{ incoming, outgoing }` into
      // `c.env` at runtime. Cast narrows the public app type to the
      // Bindings-aware shape the endpoint helper expects.
      app as unknown as Parameters<typeof mountMcpServerEndpoint>[0],
      {
        tokenStore: deps.tokenStore,
        buildMcpServerForClient: deps.buildMcpServerForClient,
        logger,
        // Mirror the body-limit ceiling used by `/api/chat`. The bodyLimit
        // middleware fires BEFORE the route handler reads c.req.json(), so
        // an mcp-client cannot exhaust daemon heap by streaming a
        // multi-GB body.
        bodyLimitBytes: config.httpBodyLimitBytes,
      },
    );
  }

  // Health endpoint — always available.
  // Includes daemon fingerprint (instanceId, startedAt) when provided so
  // external clients can verify which daemon they are actually reaching
  // when multiple listeners may be bound to the same port.
  app.get("/health", (c) => {
    return c.json({
      status: "ok",
      timestamp: systemNowDate().toISOString(),
      ...(deps.fingerprint && {
        instanceId: deps.fingerprint.instanceId,
        startedAt: deps.fingerprint.startedAt,
      }),
    });
  });

  // WebSocket route with token auth (rate limiting now handled globally)
  app.get(
    "/ws",
    upgradeWebSocket((c) => {
      // Extract and verify bearer token
      const authHeader = c.req.header("authorization") ?? "";
      const token = extractBearerToken(authHeader) ?? c.req.query("token") ?? "";
      const client = deps.tokenStore.verify(token);

      if (!client) {
        let sourceIp: string;
        try {
          const info = getConnInfo(c);
          sourceIp = info.remote.address ?? "unknown";
        } catch {
          sourceIp = c.req.header("x-real-ip") ?? "unknown";
        }

        logger.warn(
          {
            sourceIp,
            hint: "Verify client token matches a configured gateway.tokens entry",
            errorKind: "auth" as const,
          },
          "WebSocket connection rejected: invalid token",
        );
        // Return WSEvents that immediately close with auth error
        return {
          onOpen(_evt: Event, ws: WSContext) {
            ws.close(4001, "Unauthorized");
          },
        } as WSEvents;
      }

      // Reject mcp-client-scoped tokens at WS upgrade time. mcp-client is
      // the SOLE scope of any token that has it, so `includes("mcp-client")`
      // is sufficient and means "this is an external MCP credential". Such a
      // token does not have rpc/ws/admin and would silently fail every RPC
      // method call after a successful upgrade -- wasting a connection slot,
      // a rate-limit bucket, a WsConnectionManager entry, and giving the
      // credential holder a confusing debugging experience. Close with 4003
      // ("scope not permitted at this endpoint") and surface the correct route.
      if (client.scopes.includes("mcp-client")) {
        logger.warn(
          {
            clientId: client.id,
            errorKind: "auth" as const,
            hint:
              "mcp-client tokens must use POST /mcp/v1 -- mcp-client is the sole scope of its token and cannot be co-issued with rpc/ws/admin",
          },
          "WebSocket connection rejected: mcp-client-scoped token cannot open /ws",
        );
        return {
          onOpen(_evt: Event, ws: WSContext) {
            ws.close(4003, "mcp-client tokens must use POST /mcp/v1");
          },
        } as WSEvents;
      }

      const rpcContext: RpcContext = { clientId: client.id, scopes: client.scopes };
      return createWsHandler(
        {
          rpcServer: deps.rpcServer,
          connections: deps.wsConnections,
          logger: deps.logger,
          maxBatchSize: config.maxBatchSize,
          heartbeatMs: config.wsHeartbeatMs,
          maxMessageBytes: config.wsMaxMessageBytes,
          messageRateLimit: config.wsMessageRateLimit,
        },
        rpcContext,
      );
    }),
  );

  // Mount web dashboard routes (if configured)
  let unsubscribeActivity: (() => void) | undefined;

  if (deps.webDeps) {
    const { eventBus, rpcAdapterDeps, webDistPath } = deps.webDeps;

    // Create activity ring buffer with event bus subscription
    const activityBuffer = new ActivityRingBuffer(100);
    unsubscribeActivity = subscribeActivityBuffer(eventBus, activityBuffer);

    // Redirect root to web dashboard
    app.get("/", (c) => c.redirect("/app/"));

    // Mount static file serving FIRST (no auth required for SPA assets)
    if (webDistPath) {
      const staticApp = createStaticMiddleware(webDistPath, !!config.tls);
      app.route("", staticApp);
    }

    // Mount REST API at /api
    const restApi = createRestApi({
      rpcAdapterDeps,
      tokenStore: deps.tokenStore,
      activityBuffer,
      corsOrigins: config.corsOrigins,
      bodyLimitBytes: config.httpBodyLimitBytes,
      fingerprint: deps.fingerprint,
      suspendedAgents: deps.webDeps.suspendedAgents,
    });
    app.route("/api", restApi);

    // Mount SSE endpoints (shares /api prefix via its own route defs)
    const sseEndpoint = createSseEndpoint({
      eventBus,
      tokenStore: deps.tokenStore,
      rpcAdapterDeps,
      bodyLimitBytes: config.httpBodyLimitBytes,
    });
    app.route("", sseEndpoint);

    logger.debug("Web dashboard routes mounted (REST API, SSE, static)");
  }

  // Catch-all 404 handler for unmatched routes (returns JSON instead of plain text)
  app.notFound((c) => {
    return c.json({ error: "Not Found" }, 404);
  });

  let server: ReturnType<typeof serve> | undefined;

  async function start(): Promise<void> {
    const { host, port, tls } = config;

    if (tls) {
      // TLS mode: HTTPS with optional mTLS
      const certResult = validateCertificates(tls);
      if (!certResult.ok) {
        logger.error(
          {
            err: certResult.error,
            hint: "Check certificate paths in gateway.tls config (certPath, keyPath, caPath) and verify PEM format",
            errorKind: "config" as const,
          },
          "TLS certificate validation failed",
        );
        throw certResult.error;
      }

      const httpsServer = createHttpsServer({
        cert: readFileSync(tls.certPath),
        key: readFileSync(tls.keyPath),
        ca: readFileSync(tls.caPath),
        requestCert: tls.requireClientCert,
        rejectUnauthorized: tls.requireClientCert,
      });

      server = serve({
        fetch: app.fetch,
        port,
        hostname: host,
        createServer: () => httpsServer,
      });

      // Inject WebSocket support into the server
      injectWebSocket(server);

      // Disable HTTP socket idle timeout — WebSocket heartbeat handles liveness.
      // Node.js default (120s in newer versions, varies by version) prematurely
      // kills long-lived WebSocket connections.
      const httpsHandle = (server as unknown as { server?: import("node:http").Server }).server ?? server;
      if ("timeout" in (httpsHandle as object)) {
        (httpsHandle as import("node:http").Server).timeout = 0;
      }
      logger.debug("HTTP socket timeout disabled for WebSocket longevity");

      logger.info(
        { host, port, mtls: tls.requireClientCert },
        `Gateway listening on https://${host}:${port} (mTLS: ${tls.requireClientCert ? "required" : "optional"})`,
      );
    } else {
      // Plain HTTP on a LOOPBACK bind has no off-host exposure — the default
      // install posture, benign per the same judgment the system `tlsOff`
      // config-posture finding and the gateway-exposure security check apply
      // (both flag only non-loopback binds). Warn ONLY when the listener is
      // actually reachable off-host.
      const loopback = isLoopbackHost(host);
      if (!config.allowInsecureHttp && !loopback) {
        logger.warn(
          { host, port, hint: "Set gateway.tls for production or gateway.allowInsecureHttp: true to suppress this warning", errorKind: "config" as const },
          "Gateway running without TLS -- configure gateway.tls for production",
        );
      } else if (config.allowInsecureHttp) {
        logger.info(
          { host, port },
          "Gateway starting in dev mode (plain HTTP) -- allowInsecureHttp is set",
        );
      }

      server = serve({
        fetch: app.fetch,
        port,
        hostname: host,
      });

      // Inject WebSocket support into the server
      injectWebSocket(server);

      // Disable HTTP socket idle timeout — WebSocket heartbeat handles liveness.
      // Node.js default (120s in newer versions, varies by version) prematurely
      // kills long-lived WebSocket connections.
      const httpHandle = (server as unknown as { server?: import("node:http").Server }).server ?? server;
      if ("timeout" in (httpHandle as object)) {
        (httpHandle as import("node:http").Server).timeout = 0;
      }
      logger.debug("HTTP socket timeout disabled for WebSocket longevity");

      logger.info({ host, port }, `Gateway listening on http://${host}:${port} (${loopback ? "plain HTTP, loopback-only" : "plain HTTP"})`);
    }
  }

  async function stop(): Promise<void> {
    // Unsubscribe activity buffer from event bus
    if (unsubscribeActivity) {
      unsubscribeActivity();
      unsubscribeActivity = undefined;
    }

    if (server) {
      // Close all WebSocket connections and wait for close handshakes
      await deps.wsConnections.closeAll();
      server.close();
      server = undefined;
      logger.info("Gateway server stopped");
    }
  }

  return { app, start, stop };
}
