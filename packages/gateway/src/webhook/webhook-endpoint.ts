import type { Env } from "hono";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import type { WebhookMappingConfig } from "@comis/core";
import type { HmacAlgorithm } from "./hmac-verifier.js";
import { createHmacMiddleware } from "./hmac-verifier.js";
import type { WebhookMappingContext } from "./webhook-mapping.js";
import { resolveWebhookMapping, renderTemplate } from "./webhook-mapping.js";

/** Default maximum webhook body size: 1MB */
const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;

/**
 * Hono environment type for webhook routes.
 * Declares the rawBody variable set by HMAC middleware.
 */
interface WebhookEnv extends Env {
  Variables: {
    rawBody: string;
  };
}

/**
 * Zod schema for webhook payloads.
 *
 * Validates incoming webhook requests to ensure they contain
 * the required fields before passing to the handler.
 */
export const WebhookPayloadSchema = z.strictObject({
    /** Event type (e.g., "deployment.completed", "alert.fired") */
    event: z.string().min(1, "Event type is required"),
    /** Source system identifier */
    source: z.string().min(1, "Source is required"),
    /** Arbitrary event data */
    data: z.record(z.string(), z.unknown()),
    /** Optional ISO 8601 timestamp */
    timestamp: z.string().optional(),
  });

/**
 * Parsed webhook payload type.
 */
export type WebhookPayload = z.infer<typeof WebhookPayloadSchema>;

/**
 * Handler function called when a valid webhook is received.
 */
export type WebhookHandler = (payload: WebhookPayload) => Promise<void>;

/**
 * Dependencies for creating a webhook endpoint.
 */
export interface WebhookEndpointDeps {
  /** Shared secret for HMAC verification */
  readonly secret: string;
  /** Callback invoked with validated webhook payload */
  readonly onWebhook: WebhookHandler;
  /** HMAC algorithm (default: "sha256") */
  readonly algorithm?: HmacAlgorithm;
  /** Signature header name (default: "x-webhook-signature") */
  readonly headerName?: string;
}

/**
 * Create a Hono sub-application for receiving webhooks.
 *
 * The endpoint:
 * 1. Verifies HMAC signature using the shared secret
 * 2. Validates payload against WebhookPayloadSchema (Zod)
 * 3. Calls the onWebhook handler
 * 4. Returns 200 { received: true }
 *
 * Error responses:
 * - 401: Missing or invalid signature
 * - 400: Invalid JSON body
 * - 422: Payload validation failed (missing/invalid fields)
 * - 500: Handler error
 *
 * @param deps - Webhook endpoint dependencies
 * @returns Hono sub-application to be mounted at desired path
 */
export function createWebhookEndpoint(deps: WebhookEndpointDeps): Hono<WebhookEnv> {
  const { secret, onWebhook, algorithm, headerName } = deps;
  const app = new Hono<WebhookEnv>();

  const hmacMiddleware = createHmacMiddleware({
    secret,
    headerName,
    algorithm,
  });

  const bodyLimitMw = bodyLimit({ maxSize: DEFAULT_MAX_BODY_BYTES });

  app.post("/webhook", bodyLimitMw, hmacMiddleware, async (c) => {
    // rawBody was set by HMAC middleware
    const rawBody = c.get("rawBody");

    // Parse JSON from raw body
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBody);
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    // Validate against schema
    const result = WebhookPayloadSchema.safeParse(parsed);
    if (!result.success) {
      const issues = result.error.issues.map((i) => ({
        path: i.path.join("."),
        message: i.message,
      }));
      return c.json({ error: "Validation failed", issues }, 422);
    }

    // Call handler
    try {
      await onWebhook(result.data);
    } catch {
      // Error is logged by the handler callback before reaching here
      return c.json({ error: "Internal error" }, 500);
    }

    return c.json({ received: true });
  });

  return app;
}

/**
 * Dependencies for creating a mapped webhook endpoint.
 */
export interface MappedWebhookEndpointDeps {
  /** Webhook mapping configurations (evaluated in order, first match wins) */
  readonly mappings: WebhookMappingConfig[];
  /** Optional shared secret for HMAC verification */
  readonly secret?: string;
  /** HMAC algorithm (default: "sha256") */
  readonly algorithm?: HmacAlgorithm;
  /** Signature header name (default: "x-webhook-signature") */
  readonly headerName?: string;
  /** Callback invoked when a "wake" action mapping matches */
  readonly onWake: (mapping: WebhookMappingConfig) => Promise<void>;
  /** Callback invoked when an "agent" action mapping matches */
  readonly onAgentAction: (
    mapping: WebhookMappingConfig,
    renderedMessage: string,
    renderedSessionKey: string,
  ) => Promise<void>;
  /** Maximum request body size in bytes (default: 1MB) */
  readonly maxBodyBytes?: number;
}

/**
 * Create a Hono sub-application for path-based webhook routing.
 *
 * Unlike `createWebhookEndpoint` (strict payload schema + required HMAC),
 * this endpoint accepts any JSON payload and routes it to the matching
 * webhook mapping's action handler.
 *
 * The endpoint:
 * 1. Optionally verifies HMAC signature (if `secret` is provided)
 * 2. Parses body as loose JSON (no schema — payloads vary by source)
 * 3. Resolves matching webhook mapping by path (and optional source)
 * 4. For "wake" actions: calls `onWake(mapping)`
 * 5. For "agent" actions: renders templates, calls `onAgentAction(mapping, message, sessionKey)`
 * 6. Returns 200 `{ received: true, mapping: id }`
 *
 * Error responses:
 * - 401: Missing or invalid HMAC signature (when secret is configured)
 * - 400: Invalid JSON body or body exceeds maxBodyBytes
 * - 404: No matching webhook mapping for this path
 * - 500: Handler error
 *
 * @param deps - Mapped webhook endpoint dependencies
 * @returns Hono sub-application to be mounted at the webhook base path
 */
export function createMappedWebhookEndpoint(deps: MappedWebhookEndpointDeps): Hono<WebhookEnv> {
  const {
    mappings,
    secret,
    algorithm,
    headerName,
    onWake,
    onAgentAction,
    maxBodyBytes = DEFAULT_MAX_BODY_BYTES,
  } = deps;

  const app = new Hono<WebhookEnv>();
  const bodyLimitMw = bodyLimit({ maxSize: maxBodyBytes });

  // Apply body limit and optional HMAC verification middleware
  if (secret) {
    app.use("/:path{.+}", bodyLimitMw, createHmacMiddleware({ secret, headerName, algorithm }));
  } else {
    app.use("/:path{.+}", bodyLimitMw);
  }

  app.post("/:path{.+}", async (c) => {
    // Read raw body (either from HMAC middleware context or directly)
    let rawBody: string;
    if (secret) {
      rawBody = c.get("rawBody");
    } else {
      rawBody = await c.req.text();
    }

    // Enforce body size limit
    if (rawBody.length > maxBodyBytes) {
      return c.json({ error: "Request body exceeds maximum size" }, 400);
    }

    // Parse JSON (loose — no schema validation)
    let payload: unknown;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    // Extract request path and source
    const reqPath = c.req.param("path") ?? "";
    const source =
      typeof payload === "object" && payload !== null && "source" in payload
        ? String((payload as Record<string, unknown>).source)
        : undefined;

    // Resolve matching mapping
    const mapping = resolveWebhookMapping(mappings, reqPath, source);
    if (!mapping) {
      return c.json({ error: "No matching webhook mapping" }, 404);
    }

    // Build template context
    const headers: Record<string, string> = {};
    c.req.raw.headers.forEach((value, key) => {
      headers[key] = value;
    });

    const queryObj: Record<string, string> = {};
    const url = new URL(c.req.url);
    url.searchParams.forEach((value, key) => {
      queryObj[key] = value;
    });

    const ctx: WebhookMappingContext = {
      payload,
      headers,
      query: queryObj,
      path: reqPath,
      now: new Date().toISOString(),
    };

    try {
      if (mapping.action === "wake") {
        await onWake(mapping);
      } else {
        // Default action is "agent"
        const messageResult = renderTemplate(mapping.messageTemplate ?? "", ctx);
        const sessionKeyResult = renderTemplate(mapping.sessionKey ?? "", ctx);

        const renderedMessage = messageResult.ok ? messageResult.value : "";
        const renderedSessionKey = sessionKeyResult.ok ? sessionKeyResult.value : "";

        await onAgentAction(mapping, renderedMessage, renderedSessionKey);
      }
    } catch {
      // Error is logged by the handler callback before reaching here
      return c.json({ error: "Internal error" }, 500);
    }

    return c.json({ received: true, mapping: mapping.id ?? null });
  });

  return app;
}
