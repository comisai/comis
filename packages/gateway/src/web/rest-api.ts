// SPDX-License-Identifier: Apache-2.0
import {
  CanonicalLocaleSchema,
  type TypedEventBus,
  type EventMap,
  systemNowMs,
  systemNowDate,
} from "@comis/core";
import type { Env } from "hono";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import type { TokenStore } from "../auth/token-auth.js";
import type { RpcAdapterDeps } from "../rpc/rpc-adapters.js";
import { extractBearerToken, checkScope } from "../auth/token-auth.js";
import { projectActivityPayload } from "./activity-projection.js";

interface RestApiEnv extends Env {
  Variables: { clientScopes: string[]; clientId: string };
}

/**
 * Single entry stored in the activity ring buffer.
 */
export interface ActivityEntry {
  readonly id: number;
  readonly event: string;
  readonly payload: Record<string, unknown>;
  readonly timestamp: number;
}

/**
 * Ring buffer for recent system activity events.
 * Captures a configurable maximum number of entries and drops the oldest.
 */
export class ActivityRingBuffer {
  private readonly entries: ActivityEntry[] = [];
  private nextId = 1;

  constructor(private readonly maxSize: number = 100) {}

  push(event: string, payload: Record<string, unknown>): void {
    this.entries.push({
      id: this.nextId++,
      event,
      payload: projectActivityPayload(event, payload),
      timestamp: systemNowMs(),
    });

    if (this.entries.length > this.maxSize) {
      this.entries.shift();
    }
  }

  getRecent(limit: number = 50): readonly ActivityEntry[] {
    const start = Math.max(0, this.entries.length - limit);
    return this.entries.slice(start);
  }

  get size(): number {
    return this.entries.length;
  }

  clear(): void {
    this.entries.length = 0;
  }
}

/**
 * Events that are captured into the activity ring buffer.
 */
const ACTIVITY_EVENTS: ReadonlyArray<keyof EventMap> = [
  "message:received",
  "message:sent",
  "message:streaming",
  "session:created",
  "session:expired",
  "audit:event",
  "skill:loaded",
  "skill:executed",
  "skill:rejected",
  "scheduler:cron_execution_started",
  "scheduler:cron_execution_terminal",
  "scheduler:heartbeat_check",
  "system:error",
];

/**
 * Subscribe the activity ring buffer to relevant event bus events.
 * Returns an unsubscribe function for cleanup.
 */
export function subscribeActivityBuffer(
  eventBus: TypedEventBus,
  buffer: ActivityRingBuffer,
): () => void {
  const handlers: Array<{ event: keyof EventMap; handler: (payload: unknown) => void }> = [];

  for (const event of ACTIVITY_EVENTS) {
    const handler = (payload: unknown): void => {
      buffer.push(event, payload as Record<string, unknown>);
    };
    eventBus.on(event, handler as never);
    handlers.push({ event, handler });
  }

  return () => {
    for (const { event, handler } of handlers) {
      eventBus.off(event, handler as never);
    }
  };
}

/**
 * Dependencies for the REST API.
 */
export interface RestApiDeps {
  /** RPC adapter dependencies for data access */
  readonly rpcAdapterDeps: RpcAdapterDeps;
  /** Token store for bearer token verification */
  readonly tokenStore: TokenStore;
  /** Activity ring buffer for recent events */
  readonly activityBuffer: ActivityRingBuffer;
  /** CORS allowed origins. Empty array = no CORS headers (same-origin only). */
  readonly corsOrigins?: string[];
  /** Maximum request body size in bytes for POST endpoints (default: 1MB). */
  readonly bodyLimitBytes?: number;
  /** Logger for server-side error reporting. */
  readonly logger?: { error(obj: Record<string, unknown>, msg: string): void };
  /** Set of agent IDs currently suspended (optional; when absent all agents report "active"). */
  readonly suspendedAgents?: ReadonlySet<string>;
  /** Daemon fingerprint surfaced on /api/health so clients can confirm which
   *  daemon they are actually talking to. */
  readonly fingerprint?: {
    instanceId: string;
    startedAt: string;
  };
}

/**
 * Create REST API routes for the web dashboard.
 *
 * Mounted at `/api` on the gateway. All endpoints except /health
 * require bearer token authentication via Authorization header only.
 * Query parameter tokens are rejected to prevent leakage via logs and Referrer headers.
 *
 * Endpoints:
 * - GET /health - Health check (no auth)
 * - GET /agents - Agent configuration (routing section)
 * - GET /channels - Channel connection status
 * - GET /activity - Recent activity events from ring buffer
 * - GET /memory/search?q=<query>&limit=<n> - Memory search
 * - GET /memory/stats - Memory statistics
 * - POST /chat - Execute agent turn
 */
export function createRestApi(deps: RestApiDeps): Hono<RestApiEnv> {
  const { rpcAdapterDeps, tokenStore, activityBuffer } = deps;
  const api = new Hono<RestApiEnv>();

  // CORS middleware: config-driven origins
  // Hono's cors() treats origin:"*" (string) as a wildcard that always matches,
  // but origin:["*"] (array) does a literal .includes() check against the request
  // Origin header, which never matches. Detect the wildcard case and pass a string.
  const corsOrigins = deps.corsOrigins ?? [];
  if (corsOrigins.length > 0) {
    const originOption: string | string[] =
      corsOrigins.length === 1 && corsOrigins[0] === "*" ? "*" : corsOrigins;
    api.use(
      "*",
      cors({
        origin: originOption,
        allowMethods: ["GET", "POST", "OPTIONS"],
        allowHeaders: ["Authorization", "Content-Type"],
        maxAge: 3600,
      }),
    );
  }
  // When corsOrigins is empty: no CORS middleware mounted.
  // Browsers enforce same-origin policy when no Access-Control-Allow-Origin header is present.

  // Health endpoint (no auth required).
  // Mirrors /health at the gateway root -- includes the daemon fingerprint
  // (instanceId, startedAt) when provided so external clients can verify
  // which daemon they are actually reaching.
  api.get("/health", (c) => {
    return c.json({
      status: "ok",
      timestamp: systemNowDate().toISOString(),
      ...(deps.fingerprint && {
        instanceId: deps.fingerprint.instanceId,
        startedAt: deps.fingerprint.startedAt,
      }),
    });
  });

  // Token auth middleware for all other routes
  api.use("*", async (c, next) => {
    // Skip auth for health (already handled above)
    if (c.req.path.endsWith("/health")) {
      return next();
    }
    // Skip auth for paths handled by the SSE endpoint, which enforces its own
    // Authorization bearer-header and scope checks.
    if (
      c.req.path.includes("/chat/stream") ||
      c.req.path.endsWith("/events")
    ) {
      return next();
    }

    const authHeader = c.req.header("authorization") ?? "";
    const token = extractBearerToken(authHeader) ?? "";
    const client = tokenStore.verify(token);

    if (!client) {
      return c.json({ error: "Unauthorized" }, 401);
    }

    // Enforce scope: REST API requires at least "rpc" scope
    if (!checkScope(client.scopes, "rpc")) {
      return c.json({ error: "Forbidden: insufficient scope" }, 403);
    }

    // Store authenticated identity and scopes for downstream handlers.
    c.set("clientId", client.id);
    c.set("clientScopes", client.scopes as string[]);

    return next();
  });

  // GET /agents - Non-secret agent listing (id/name/provider/model/status).
  //
  // Sources from rpcAdapterDeps.listAgentSummaries, NOT getConfig: §17.8
  // removed `agents` from getConfig's non-secret allowlist, so
  // getConfig now returns the safe default with no `agents` key. The dedicated
  // projection returns only non-secret identity/model fields, so this listing
  // works without re-opening the secret-egress path getConfig closed.
  api.get("/agents", async (c) => {
    try {
      const summaries = rpcAdapterDeps.listAgentSummaries?.() ?? [];
      const agents = summaries.map((a) => ({
        id: a.id,
        name: a.name,
        provider: a.provider,
        model: a.model,
        status: deps.suspendedAgents?.has(a.id) ? "suspended" : "active",
      }));

      return c.json({ agents });
    } catch (err) {
      deps.logger?.error({ err, hint: "Check config adapter and agent configuration", errorKind: "internal" as const }, "GET /agents error");
      return c.json({ error: "Internal error" }, 500);
    }
  });

  // GET /channels - Channel connection status (non-secret name/enabled only).
  //
  // Sources from rpcAdapterDeps.listChannelSummaries, NOT getConfig:
  // `channels` was removed from getConfig's allowlist (mirrors /agents). The
  // projection already excludes the internal healthCheck block and every
  // credential field; here we surface only the enabled adapters.
  api.get("/channels", async (c) => {
    try {
      const channels = (rpcAdapterDeps.listChannelSummaries?.() ?? [])
        .filter((ch) => ch.enabled)
        .map((ch) => ({
          type: ch.name,
          name: ch.name,
          enabled: true,
          status: "connected" as const,
        }));

      return c.json({ channels });
    } catch (err) {
      deps.logger?.error({ err, hint: "Check config adapter and channel configuration", errorKind: "internal" as const }, "GET /channels error");
      return c.json({ error: "Internal error" }, 500);
    }
  });

  // GET /activity - Recent activity events
  api.get("/activity", (c) => {
    const limitParam = c.req.query("limit");
    const limit = limitParam ? Math.min(Math.max(1, parseInt(limitParam, 10) || 50), 100) : 50;
    const entries = activityBuffer.getRecent(limit);
    return c.json({ entries, count: entries.length });
  });

  // GET /memory/search?q=<query>&limit=<n> - Memory search
  api.get("/memory/search", async (c) => {
    const query = c.req.query("q") ?? "";
    if (!query) {
      return c.json({ error: "Missing required query parameter: q" }, 400);
    }

    const limitParam = c.req.query("limit");
    const limit = limitParam ? Math.min(Math.max(1, parseInt(limitParam, 10) || 10), 100) : 10;
    const tenantId = c.req.query("tenant") ?? "";
    const agentId = c.req.query("agent") ?? "";
    if (!tenantId || !agentId) {
      return c.json({ error: "Missing required query parameters: tenant and agent" }, 400);
    }

    try {
      const result = await rpcAdapterDeps.searchMemory({ query, limit, tenantId, agentId });
      return c.json(result);
    } catch (err) {
      deps.logger?.error({ err, hint: "Verify memory database path and search index integrity", errorKind: "internal" as const }, "GET /memory/search error");
      return c.json({ error: "Internal error" }, 500);
    }
  });

  // GET /memory/stats - Memory statistics
  api.get("/memory/stats", async (c) => {
    const tenantId = c.req.query("tenant") ?? "";
    const agentId = c.req.query("agent") ?? "";
    if (!tenantId || !agentId) {
      return c.json({ error: "Missing required query parameters: tenant and agent" }, 400);
    }
    try {
      const result = await rpcAdapterDeps.inspectMemory({ tenantId, agentId });
      return c.json(result);
    } catch (err) {
      deps.logger?.error({ err, hint: "Verify memory database path and entry existence", errorKind: "internal" as const }, "GET /memory/stats error");
      return c.json({ error: "Internal error" }, 500);
    }
  });

  // GET /chat/history - Load chat session history
  api.get("/chat/history", async (c) => {
    try {
      const channelId = c.req.query("channelId") ?? undefined;
      const peerId = c.req.query("peerId") ?? undefined;
      const result = await rpcAdapterDeps.getSessionHistory({
        channelId,
        peerId,
        clientId: c.get("clientId"),
      });
      return c.json(result);
    } catch (err) {
      deps.logger?.error({ err, hint: "Check session history adapter and channel ID validity", errorKind: "internal" as const }, "GET /chat/history error");
      return c.json({ error: "Internal error" }, 500);
    }
  });

  // Body size limit on POST /chat (default 1MB)
  const bodyLimitMw = bodyLimit({
    maxSize: deps.bodyLimitBytes ?? 1_048_576,
    onError: (c) => {
      return c.json({ error: "Request body too large" }, 413);
    },
  });

  // POST /chat - Execute agent turn
  api.post("/chat", bodyLimitMw, async (c) => {
    const contentType = c.req.header("content-type") ?? "";
    if (!contentType.includes("application/json")) {
      return c.json({ error: "Content-Type must be application/json" }, 415);
    }

    let body: Record<string, unknown>;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    const message = typeof body.message === "string" ? body.message : "";
    if (!message) {
      return c.json({ error: "Missing required field: message (string)" }, 400);
    }

    const agentId = typeof body.agentId === "string" ? body.agentId : undefined;
    const rawSessionKey = typeof body.sessionKey === "string" ? body.sessionKey : undefined;
    const localeResult = body.locale === undefined
      ? undefined
      : CanonicalLocaleSchema.safeParse(body.locale);
    if (localeResult !== undefined && !localeResult.success) {
      return c.json({ error: "Field locale must be a canonical BCP-47 language tag" }, 400);
    }
    const locale = localeResult?.data;

    const sessionKey = rawSessionKey
      ? {
          userId: "web-user",
          channelId: rawSessionKey,
          peerId: "web-user",
        }
      : undefined;

    if (agentId && rpcAdapterDeps.isValidAgentId && !rpcAdapterDeps.isValidAgentId(agentId)) {
      return c.json({ error: `Unknown agent: ${agentId}` }, 400);
    }

    const scopes = c.get("clientScopes") as readonly string[] | undefined;
    const clientId = c.get("clientId");

    const cmdResult = await rpcAdapterDeps.handleSlashCommand?.({
      message,
      agentId,
      sessionKey,
      clientId,
      scopes,
    });
    if (cmdResult?.handled && cmdResult.response) {
      return c.json({ response: cmdResult.response, tokensUsed: { input: 0, output: 0, total: 0 }, finishReason: "command" });
    }

    try {
      const result = await rpcAdapterDeps.executeAgent({
        message,
        ...(locale === undefined ? {} : { locale }),
        agentId,
        sessionKey,
        clientId,
        scopes,
      });
      return c.json(result);
    } catch (err) {
      deps.logger?.error({ err, hint: "Check agent executor logs for details or verify LLM provider connectivity", errorKind: "internal" as const }, "POST /chat error");
      return c.json({ error: "Internal error" }, 500);
    }
  });

  return api;
}
