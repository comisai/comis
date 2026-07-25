// SPDX-License-Identifier: Apache-2.0
import { CanonicalLocaleSchema, type TypedEventBus, type EventMap } from "@comis/core";
import type { Env } from "hono";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { err, ok, suppressError, type Result } from "@comis/shared";
import type { TokenStore } from "../auth/token-auth.js";
import type { RpcAdapterDeps } from "../rpc/rpc-adapters.js";
import { extractBearerToken, checkScope } from "../auth/token-auth.js";
import { projectActivityPayload } from "./activity-projection.js";

interface SseEnv extends Env {
  Variables: { clientScopes: string[]; clientId: string };
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
  "scheduler:cron_execution_started",
  "scheduler:cron_execution_terminal",
  "scheduler:heartbeat_wake_admitted",
  "scheduler:heartbeat_wake_deferred",
  "scheduler:heartbeat_wake_terminal",
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
  "scheduler:heartbeat_alert",
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
  /** Maximum size of a streaming chat JSON body, in bytes */
  readonly bodyLimitBytes: number;
}

/** Keep-alive ping interval in milliseconds */
const KEEPALIVE_MS = 15_000;

/** SSE retry directive in milliseconds */
const RETRY_MS = 3_000;

type ChatBodyReadError =
  | { readonly kind: "invalid" }
  | { readonly kind: "too_large" };

async function readBoundedJsonBody(
  request: Request,
  maxBytes: number,
): Promise<Result<unknown, ChatBodyReadError>> {
  const reader = request.body?.getReader();
  if (!reader) return err({ kind: "invalid" });

  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  try {
    const declaredLength = Number(request.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
      await reader.cancel().then(
        () => undefined,
        () => undefined,
      );
      return err({ kind: "too_large" });
    }

    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      totalBytes += chunk.value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel().then(
          () => undefined,
          () => undefined,
        );
        return err({ kind: "too_large" });
      }
      chunks.push(chunk.value);
    }
  } catch {
    await reader.cancel().then(
      () => undefined,
      () => undefined,
    );
    return err({ kind: "invalid" });
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return ok(JSON.parse(text) as unknown);
  } catch {
    return err({ kind: "invalid" });
  }
}

/**
 * Create SSE streaming endpoints for real-time event delivery.
 *
 * Endpoints:
 * - GET /api/events - SSE stream of all system events
 * - POST /api/chat/stream - Streaming chat SSE with an application/json body
 *
 * Both endpoints require bearer token authentication.
 */
export function createSseEndpoint(deps: SseEndpointDeps): Hono<SseEnv> {
  const { eventBus, tokenStore, rpcAdapterDeps } = deps;
  const sse = new Hono<SseEnv>();

  // Token auth middleware for SSE endpoints (scoped to /api/* to avoid
  // interfering with other sub-apps when this Hono instance is mounted at root)
  sse.use("/api/*", async (c, next) => {
    if (c.req.query("token") !== undefined) {
      return c.json({ error: "Unauthorized" }, 401);
    }
    const authHeader = c.req.header("authorization") ?? "";
    const token = extractBearerToken(authHeader) ?? "";
    const client = tokenStore.verify(token);

    if (!client) {
      return c.json({ error: "Unauthorized" }, 401);
    }

    // Enforce scope: SSE streams the cross-session event firehose and can drive
    // agent turns, so require the same "rpc" scope the REST API does. A
    // sole-scope "mcp-client" token (contained external credential) must NOT
    // reach these surfaces — it is rejected here, matching rest-api.ts.
    if (!checkScope(client.scopes, "rpc")) {
      return c.json({ error: "Forbidden: insufficient scope" }, 403);
    }

    // Store authenticated identity and scopes for downstream handlers.
    c.set("clientId", client.id);
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
              data: JSON.stringify(projectActivityPayload(event, payload)),
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

  // POST /api/chat/stream - Streaming chat via an authenticated JSON body.
  sse.post("/api/chat/stream", async (c) => {
    if (Object.keys(c.req.queries()).length > 0) {
      return c.json({ error: "Query parameters are not accepted" }, 400);
    }

    const contentType = c.req.header("content-type") ?? "";
    const mediaType = contentType.split(";", 1)[0]?.trim().toLowerCase();
    if (mediaType !== "application/json") {
      return c.json({ error: "Content-Type must be application/json" }, 415);
    }

    const rawBodyResult = await readBoundedJsonBody(c.req.raw, deps.bodyLimitBytes);
    if (!rawBodyResult.ok && rawBodyResult.error.kind === "too_large") {
      return c.json({ error: "Request body too large" }, 413);
    }
    if (!rawBodyResult.ok) {
      return c.json({ error: "Invalid JSON body" }, 400);
    }
    const rawBody = rawBodyResult.value;

    if (typeof rawBody !== "object" || rawBody === null || Array.isArray(rawBody)) {
      return c.json({ error: "JSON body must be an object" }, 400);
    }

    const body = rawBody as Record<string, unknown>;
    const message = typeof body.message === "string" ? body.message : "";
    if (!message) {
      return c.json({ error: "Missing required field: message (string)" }, 400);
    }

    if (body.agentId !== undefined && typeof body.agentId !== "string") {
      return c.json({ error: "Field agentId must be a string" }, 400);
    }
    const agentId = body.agentId as string | undefined;
    const localeResult = body.locale === undefined
      ? undefined
      : CanonicalLocaleSchema.safeParse(body.locale);
    if (localeResult !== undefined && !localeResult.success) {
      return c.json({ error: "Field locale must be a canonical BCP-47 language tag" }, 400);
    }
    const locale = localeResult?.data;

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
        const clientId = c.get("clientId");
        const result = await rpcAdapterDeps.executeAgent({
          message,
          ...(locale === undefined ? {} : { locale }),
          agentId,
          clientId,
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
