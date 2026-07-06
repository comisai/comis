// SPDX-License-Identifier: Apache-2.0
import { Hono } from "hono";
import type { Result } from "@comis/shared";
import { systemNowMs, type ComisLogger } from "@comis/core";

/** Pipeline-stage tag for this boundary's structured logs. */
const INGRESS_STEP = "googlechat-ingress";
/** Authorization scheme the inbound event must carry. */
const BEARER_PREFIX = "Bearer ";

/**
 * The closed rejection class passed to the content-free auth-reject hook.
 * `missing_bearer` — the request carried no bearer token (the cheap pre-gate);
 * `invalid_token` — a bearer token was present but failed signed-token
 * validation (forged / unsigned / expired / wrong-audience). The class is the
 * ONLY thing the hook ever receives — never the token, header, or body.
 */
export type GoogleChatIngressAuthRejectReason = "missing_bearer" | "invalid_token";

/**
 * Dependencies for the Google Chat inbound ingress.
 *
 * The factory is framework-agnostic over these injected closures: it holds
 * no channel-adapter or JWT-library imports, so the gateway gains no
 * dependency on the channels package. The composition root binds the
 * concrete validator (with the expected audience already closed over) and
 * the adapter's inbound driver.
 */
export interface GoogleChatIngressDeps {
  /**
   * Validates the inbound `Authorization` header (a signed bearer token). The
   * caller has already bound the expected audience. Resolves `ok` when the
   * token verifies, `err` otherwise — the handler rejects with 401 and never
   * surfaces the error detail to the caller.
   */
  readonly validateInboundJwt: (
    authHeader: string | undefined,
  ) => Promise<Result<void, Error>>;
  /**
   * Hands the validated events to the adapter's inbound pipeline. The body is
   * treated as opaque here and cast to the concrete event type at the adapter
   * boundary.
   */
  readonly handleWebhookEvents: (events: unknown[]) => void;
  /**
   * Optional content-free hook fired on every auth-gate rejection (before any
   * body parse or adapter dispatch), carrying ONLY the closed rejection class.
   * The composition root binds it to a daemon eventBus emit so an ingress
   * forged/expired/wrong-audience/missing-token FLOOD is COUNTABLE by the fleet
   * lens instead of living only in a raw WARN. A no-op when absent — the gate
   * and its opaque 401 are unchanged either way; the hook NEVER receives the
   * token, the Authorization header, or the request body.
   */
  readonly onAuthRejected?: (reason: GoogleChatIngressAuthRejectReason) => void;
  readonly logger: ComisLogger;
}

/**
 * Create the Hono sub-application that receives Google Chat webhook events.
 *
 * The daemon mounts it at `/channels/googlechat`, so the effective public
 * route is `POST /channels/googlechat/`. Every request is untrusted until the
 * injected validator passes:
 *
 * 1. Cheap Bearer-presence pre-gate — a request with no bearer token is
 *    rejected 401 before any validation or body work (avoids expensive work
 *    on unauthenticated floods).
 * 2. Full token validation via `validateInboundJwt` — a forged / unsigned /
 *    wrong-audience token is rejected 401 with the body left unparsed and the
 *    adapter never reached.
 * 3. Parse guard — a malformed JSON body is rejected 4xx.
 * 4. Ack — the handler dispatches the events to `handleWebhookEvents`
 *    defensively (a throwing dispatch is contained so it neither blocks the
 *    ack nor surfaces internal detail), then acks with a bare 202. Delivery is
 *    fire-and-forget: the normalizer runs out-of-band and any reply reaches the
 *    space asynchronously.
 *
 * All responses are opaque: every error carries a fixed message — neither the
 * validator's nor the dispatch's internal error text is ever surfaced to the
 * caller.
 */
export function createGoogleChatIngress(deps: GoogleChatIngressDeps): Hono {
  const { validateInboundJwt, handleWebhookEvents, onAuthRejected, logger } =
    deps;
  const app = new Hono();

  app.post("/", async (c) => {
    const startedAt = systemNowMs();

    // (1) Bearer-presence pre-gate — reject before any validation or body read.
    const authHeader =
      c.req.header("authorization") ?? c.req.header("Authorization");
    if (authHeader === undefined || !authHeader.startsWith(BEARER_PREFIX)) {
      logger.warn(
        {
          step: INGRESS_STEP,
          hint: "Reject inbound event without a bearer token",
          errorKind: "auth" as const,
        },
        "Rejected inbound event: missing bearer token",
      );
      // Fleet-visible, content-free: the class only — never the (absent) token.
      onAuthRejected?.("missing_bearer");
      return c.json({ error: "unauthorized" }, 401);
    }

    // (2) Full token validation — no body is processed on failure, and the
    // validator's error detail is never surfaced to the caller.
    logger.debug({ step: INGRESS_STEP }, "Validating inbound event token");
    const verdict = await validateInboundJwt(authHeader);
    if (!verdict.ok) {
      logger.warn(
        {
          step: INGRESS_STEP,
          hint: "Reject unverified inbound event",
          errorKind: "auth" as const,
        },
        "Rejected inbound event: token validation failed",
      );
      // Fleet-visible, content-free: the class only — never the forged token.
      onAuthRejected?.("invalid_token");
      return c.json({ error: "unauthorized" }, 401);
    }

    // (3) Parse guard — the body is opaque and only touched after validation.
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      logger.warn(
        {
          step: INGRESS_STEP,
          hint: "Send a JSON event body",
          errorKind: "validation" as const,
        },
        "Rejected inbound event: malformed JSON body",
      );
      return c.json({ error: "invalid body" }, 400);
    }

    // A single-event POST is normalized to the array the adapter expects.
    const events: unknown[] = Array.isArray(body) ? body : [body];

    // (4) Fast ack. Dispatch defensively so a downstream failure neither
    // blocks the ack nor leaks internal detail through the public endpoint.
    logger.debug(
      { step: INGRESS_STEP, eventCount: events.length },
      "Dispatching inbound events",
    );
    try {
      handleWebhookEvents(events);
    } catch (dispatchErr) {
      logger.error(
        {
          step: INGRESS_STEP,
          err: dispatchErr,
          hint: "Inspect the channel inbound pipeline",
          errorKind: "internal" as const,
        },
        "Inbound event dispatch failed",
      );
    }

    const durationMs = systemNowMs() - startedAt;
    logger.info(
      { step: INGRESS_STEP, durationMs },
      "Inbound event accepted",
    );
    return c.body(null, 202);
  });

  return app;
}
