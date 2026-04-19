import type { TypedEventBus, EventMap } from "@comis/core";
import type { Env } from "hono";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { suppressError } from "@comis/shared";
import type { TokenStore } from "../auth/token-auth.js";
import type { RpcAdapterDeps } from "../rpc/rpc-adapters.js";
import { extractBearerToken } from "../auth/token-auth.js";

interface SseEnv extends Env {
  Variables: { clientScopes: string[] };
}

/**
 * Events forwarded to the SSE event stream.
 */
const SSE_EVENTS: ReadonlyArray<keyof EventMap> = [
  "message:received",
  "message:sent",
  "message:streaming",
  "session:created",
  "session:expired",
  "audit:event",
  "skill:executed",
  "skill:rejected",
  "observability:metrics",
  "observability:token_usage",
  "scheduler:job_started",
  "scheduler:job_completed",
  "scheduler:heartbeat_check",
  "system:error",
  // Approval gate events
  "approval:requested",
  "approval:resolved",
  // Graph execution events
  "graph:started",
  "graph:node_updated",
  "graph:completed",
  // Additional real-time event types
  "config:patched",
  "diagnostic:channel_health",
  "diagnostic:billing_snapshot",
  "scheduler:heartbeat_delivered",
  "scheduler:heartbeat_alert",
  "scheduler:task_extracted",
  "skill:loaded",
  "skill:registry_reset",
  "model:catalog_loaded",
  "observability:reset",
  "channel:registered",
  "channel:deregistered",
  // Agent hot-add/remove lifecycle events
  "agent:hot_added",
  "agent:hot_removed",
  // Security and provider monitoring
  "security:injection_detected",
  "security:injection_rate_exceeded",
  "security:memory_tainted",
  "security:warn",
  "secret:accessed",
  "secret:modified",
  "model:fallback_attempt",
  "model:fallback_exhausted",
  "model:auth_cooldown",
  "provider:degraded",
  "provider:recovered",
  // Sub-agent lifecycle events
  "session:sub_agent_spawned",
  "session:sub_agent_completed",
  "session:sub_agent_archived",
  "session:sub_agent_spawn_rejected",
  "session:sub_agent_spawn_started",
  "session:sub_agent_spawn_queued",
  "session:sub_agent_lifecycle_ended",
];

/**
 * Dependencies for the SSE endpoint.
 */
export interface SseEndpointDeps {
  /** Event bus to subscribe to for streaming */
  readonly eventBus: TypedEventBus;
  /** Token store for authentication */
  readonly tokenStore: TokenStore;
  /** RPC adapter deps for chat streaming */
  readonly rpcAdapterDeps: RpcAdapterDeps;
}

/** Keep-alive ping interval in milliseconds */
const KEEPALIVE_MS = 15_000;

/** SSE retry directive in milliseconds */
const RETRY_MS = 3_000;

/**
 * Create SSE streaming endpoints for real-time event delivery.
 *
 * Endpoints:
 * - GET /api/events - SSE stream of all system events
 * - GET /api/chat/stream?sessionId=<id>&message=<msg> - Streaming chat SSE
 *
 * Both endpoints require bearer token authentication.
 */
export function createSseEndpoint(deps: SseEndpointDeps): Hono<SseEnv> {
  const { eventBus, tokenStore, rpcAdapterDeps } = deps;
  const sse = new Hono<SseEnv>();

  // Token auth middleware for SSE endpoints (scoped to /api/* to avoid
  // interfering with other sub-apps when this Hono instance is mounted at root)
  sse.use("/api/*", async (c, next) => {
    const authHeader = c.req.header("authorization") ?? "";
    const token = extractBearerToken(authHeader) ?? c.req.query("token") ?? "";
    const client = tokenStore.verify(token);

    if (!client) {
      return c.json({ error: "Unauthorized" }, 401);
    }

    // Store client scopes on context for downstream handlers
    c.set("clientScopes", client.scopes as string[]);

    return next();
  });

  // GET /api/events - SSE stream of system events
  sse.get("/api/events", (c) => {
    return streamSSE(c, async (stream) => {
      let eventId = 0;

      // Send retry directive
      await stream.writeSSE({
        data: "",
        event: "retry",
        id: String(eventId++),
        retry: RETRY_MS,
      });

      // Subscribe to all SSE-relevant events
      const handlers: Array<{
        event: keyof EventMap;
        handler: (payload: unknown) => void;
      }> = [];

      for (const event of SSE_EVENTS) {
        const handler = (payload: unknown): void => {
          suppressError(
            stream.writeSSE({
              data: JSON.stringify(payload),
              event,
              id: String(eventId++),
            }),
            "Stream already closed -- ignore write errors",
          );
        };
        eventBus.on(event, handler as never);
        handlers.push({ event, handler });
      }

      // Clean up on abort
      stream.onAbort(() => {
        for (const { event, handler } of handlers) {
          eventBus.off(event, handler as never);
        }
      });

      // Keep-alive ping loop
       
      while (true) {
        await stream.sleep(KEEPALIVE_MS);
        await stream.writeSSE({
          data: "",
          event: "ping",
          id: String(eventId++),
        });
      }
    });
  });

  // GET /api/chat/stream?sessionId=<id>&message=<msg> - Streaming chat via SSE
  sse.get("/api/chat/stream", (c) => {
    const message = c.req.query("message") ?? "";
    if (!message) {
      return c.json({ error: "Missing required query parameter: message" }, 400);
    }

    const agentId = c.req.query("agentId");

    return streamSSE(c, async (stream) => {
      let eventId = 0;
      let accumulated = "";

      const onDelta = (delta: string): void => {
        accumulated += delta;
        suppressError(
          stream.writeSSE({
            data: JSON.stringify({ delta, accumulated }),
            event: "token",
            id: String(eventId++),
          }),
          "Stream closed",
        );
      };

      try {
        const scopes = c.get("clientScopes") as readonly string[] | undefined;
        const result = await rpcAdapterDeps.executeAgent({
          message,
          agentId: agentId ?? undefined,
          scopes,
          onDelta,
        });

        await stream.writeSSE({
          data: JSON.stringify(result),
          event: "done",
          id: String(eventId++),
        });
      } catch {
        await stream.writeSSE({
          data: JSON.stringify({
            error: "Internal error",
          }),
          event: "error",
          id: String(eventId++),
        });
      }
    });
  });

  return sse;
}
