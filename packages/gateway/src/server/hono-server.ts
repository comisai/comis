// SPDX-License-Identifier: Apache-2.0
import type { GatewayConfig, TypedEventBus, HookRunner, HookGatewayStartContext, HookGatewayStopContext } from "@comis/core";
import { tryGetContext } from "@comis/core";
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
import type { HmacAlgorithm } from "../webhook/hmac-verifier.js";
import { validateCertificates } from "../auth/mtls-verifier.js";
import { extractBearerToken, type TokenStore } from "../auth/token-auth.js";
import { getConnInfo } from "@hono/node-server/conninfo";
import { createRateLimiter } from "../rate-limit/rate-limiter.js";
import { createWsHandler, WsConnectionManager } from "../rpc/ws-handler.js";
import { createRestApi, ActivityRingBuffer, subscribeActivityBuffer } from "../web/rest-api.js";
import { createSseEndpoint } from "../web/sse-endpoint.js";
import { createStaticMiddleware } from "../web/static-middleware.js";
import { createWebhookEndpoint, type WebhookHandler } from "../webhook/webhook-endpoint.js";
import {
  createOAuthCallbackRoute,
  type PendingFlow,
} from "../oauth/oauth-callback-route.js";
import type { OAuthCredentialStorePort } from "@comis/core";

/**
 * Logger interface for gateway server (minimal pino-compatible).
 */
export interface GatewayLogger {
  debug(msg: string): void;
  debug(obj: Record<string, unknown>, msg: string): void;
  info(msg: string): void;
  info(obj: Record<string, unknown>, msg: string): void;
  warn(msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  error(msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
}

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
  /** Optional webhook configuration (mount only if provided) */
  readonly webhookDeps?: {
    secret: string;
    onWebhook: WebhookHandler;
    algorithm?: HmacAlgorithm;
    headerName?: string;
  };
  /**
   * Phase 11 SC11-2: optional OAuth callback deps. When provided, the
   * gateway mounts GET /oauth/callback/:provider for browser-redirect
   * OAuth flows (web-UI-initiated logins). Pending-flow map is owned by
   * the caller (e.g., setup-gateway.ts in a future phase) so daemon
   * restart cleanly drops all in-flight states.
   */
  readonly oauthCallbackDeps?: {
    credentialStore: OAuthCredentialStorePort;
    eventBus: TypedEventBus;
    pendingFlows: Map<string, PendingFlow>;
  };
  /** Optional hook runner for lifecycle hooks (no-op when absent) */
  readonly hookRunner?: HookRunner;
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
 * - POST /hooks/webhook — HMAC-verified webhook endpoint (if webhookDeps provided)
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

  // Health endpoint — always available.
  // Includes daemon fingerprint (instanceId, startedAt) when provided so
  // external clients can verify which daemon they are actually reaching
  // when multiple listeners may be bound to the same port.
  app.get("/health", (c) => {
    return c.json({
      status: "ok",
      timestamp: new Date().toISOString(),
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

  // Mount webhook endpoint (if configured)
  if (deps.webhookDeps) {
    const webhookApp = createWebhookEndpoint(deps.webhookDeps);
    app.route("/hooks", webhookApp);
  }

  // Phase 11 SC11-2: mount OAuth callback at GET /oauth/callback/:provider
  if (deps.oauthCallbackDeps) {
    const oauthApp = createOAuthCallbackRoute({
      ...deps.oauthCallbackDeps,
      logger,
    });
    app.route("/oauth", oauthApp);
    logger.debug(
      { module: "oauth-callback" },
      "OAuth callback route mounted at /oauth/callback/:provider",
    );
  }

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
      // Warn when running without TLS unless explicitly allowed
      if (!config.allowInsecureHttp) {
        logger.warn(
          { host, port, hint: "Set gateway.tls for production or gateway.allowInsecureHttp: true to suppress this warning", errorKind: "config" as const },
          "Gateway running without TLS -- configure gateway.tls for production",
        );
      } else {
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

      logger.info({ host, port }, `Gateway listening on http://${host}:${port} (dev mode)`);
    }

    // Run gateway_start hook -- observability for server startup
    // Hook errors are caught internally by the runner (catchErrors: true)
    await deps.hookRunner?.runGatewayStart(
      { port, host, tls: !!tls },
      {} as HookGatewayStartContext,
    );
  }

  async function stop(): Promise<void> {
    // Run gateway_stop hook before shutdown
    // Hook errors are caught internally by the runner (catchErrors: true)
    await deps.hookRunner?.runGatewayStop(
      { reason: "shutdown" },
      {} as HookGatewayStopContext,
    );

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
