// SPDX-License-Identifier: Apache-2.0
import type { Env } from "hono";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { WebhookMappingConfig } from "@comis/core";
import type { HmacAlgorithm } from "./hmac-verifier.js";
import { createHmacMiddleware } from "./hmac-verifier.js";
import type { WebhookMappingContext } from "./webhook-mapping.js";
import { resolveWebhookMapping, renderTemplate } from "./webhook-mapping.js";
import { systemNowDate } from "@comis/core";
import { suppressError } from "@comis/shared";

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
 * Accepts any JSON payload and routes it to the matching webhook mapping's
 * action handler. HMAC verification is optional (driven by `secret`).
 *
 * The endpoint:
 * 1. Optionally verifies HMAC signature (if `secret` is provided)
 * 2. Parses body as loose JSON (no schema — payloads vary by source)
 * 3. Resolves matching webhook mapping by path (and optional source)
 * 4. For "wake" actions: calls `onWake(mapping)`
 * 5. For "agent" actions: renders templates, then dispatches
 *    `onAgentAction(mapping, message, sessionKey)` in the background (fire-and-forget) —
 *    the turn runs after this endpoint has already acknowledged the request
 * 6. Returns 200 `{ received: true, mapping: id }`
 *
 * Error responses:
 * - 401: Missing or invalid HMAC signature (when secret is configured)
 * - 413: Request body exceeds `maxBodyBytes` (enforced by Hono `bodyLimit`)
 * - 400: Invalid JSON body
 * - 404: No matching webhook mapping for this path
 * - 500: Handler error — `wake` actions only; agent turns run in the background and
 *   never affect the response status (their failures are logged/emitted by the handler)
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
    // Read raw body (either from HMAC middleware context or directly).
    // Body-size limits are enforced upstream by `bodyLimitMw` (411/413 before
    // the handler runs — covered by the "rejects mapped webhook with body
    // over 1MB" test). No second check needed here.
    let rawBody: string;
    if (secret) {
      rawBody = c.get("rawBody");
    } else {
      rawBody = await c.req.text();
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
      now: systemNowDate().toISOString(),
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

        // Dispatch the agent turn WITHOUT awaiting it. A webhook's contract is an
        // acknowledgement on RECEIPT ({ received: true }), not on turn completion — an
        // agent turn can run for many minutes (a driven CLI, a build, a review wait), so
        // awaiting it here would hold the caller's connection open for the whole turn. A
        // polling/service-hook caller then times its own request out and re-delivers,
        // producing a duplicate-fire storm. The turn runs in the background; the handler
        // records its own success/failure and must not surface as this request's status.
        // The handler logs and emits its own failure diagnostics (diagnostic:webhook_delivered);
        // suppressError only guards against an unhandled promise rejection from the detached turn.
        suppressError(
          onAgentAction(mapping, renderedMessage, renderedSessionKey),
          "webhook agent turn dispatched in the background",
        );
      }
    } catch {
      // Error is logged by the handler callback before reaching here
      return c.json({ error: "Internal error" }, 500);
    }

    return c.json({ received: true, mapping: mapping.id ?? null });
  });

  return app;
}
