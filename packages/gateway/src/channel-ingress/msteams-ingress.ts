// SPDX-License-Identifier: Apache-2.0
import { Hono } from "hono";
import type { Result } from "@comis/shared";
import { systemNowMs, type ComisLogger } from "@comis/core";

/** Pipeline-stage tag for this boundary's structured logs. */
const INGRESS_STEP = "msteams-ingress";
/** Authorization scheme the inbound activity must carry. */
const BEARER_PREFIX = "Bearer ";

/**
 * Dependencies for the Microsoft Teams inbound ingress.
 *
 * The factory is framework-agnostic over these injected closures: it holds
 * no channel-adapter or JWT-library imports, so the gateway gains no
 * dependency on the channels package. The composition root binds the
 * concrete validator (with the expected audience already closed over) and
 * the adapter's inbound driver.
 */
export interface MsTeamsIngressDeps {
  /**
   * Validates the inbound `Authorization` header (a signed activity token).
   * The caller has already bound the expected audience. Resolves `ok` when
   * the token verifies, `err` otherwise — the handler rejects with 401 and
   * never surfaces the error detail to the caller.
   */
  readonly validateActivityJwt: (
    authHeader: string | undefined,
  ) => Promise<Result<void, Error>>;
  /**
   * Hands the validated activities to the adapter's inbound pipeline. The
   * body is treated as opaque here and cast to the concrete activity type at
   * the adapter boundary.
   */
  readonly handleWebhookEvents: (activities: unknown[]) => void;
  readonly logger: ComisLogger;
}

/**
 * Create the Hono sub-application that receives Microsoft Teams activities.
 *
 * The daemon mounts it at `/channels/msteams`, so the effective public route
 * is `POST /channels/msteams/api/messages`. Every request is untrusted until
 * the injected validator passes:
 *
 * 1. Cheap Bearer-presence pre-gate — a request with no bearer token is
 *    rejected 401 before any validation or body work (avoids expensive work
 *    on unauthenticated floods).
 * 2. Full token validation via `validateActivityJwt` — a forged / unsigned /
 *    wrong-audience token is rejected 401 with the body left unparsed and the
 *    adapter never invoked.
 * 3. Parse guard — a malformed JSON body is rejected 4xx.
 * 4. Fast ack — the handler returns 202 promptly and dispatches the
 *    activities to `handleWebhookEvents` defensively; a throwing dispatch is
 *    contained so it neither blocks the ack nor surfaces internal detail.
 *
 * All error responses are opaque: they carry a fixed message and never the
 * validator's or dispatch's internal error text.
 */
export function createMsTeamsIngress(deps: MsTeamsIngressDeps): Hono {
  const { validateActivityJwt, handleWebhookEvents, logger } = deps;
  const app = new Hono();

  app.post("/api/messages", async (c) => {
    const startedAt = systemNowMs();

    // (1) Bearer-presence pre-gate — reject before any validation or body read.
    const authHeader =
      c.req.header("authorization") ?? c.req.header("Authorization");
    if (authHeader === undefined || !authHeader.startsWith(BEARER_PREFIX)) {
      logger.warn(
        {
          step: INGRESS_STEP,
          hint: "Reject inbound activity without a bearer token",
          errorKind: "auth" as const,
        },
        "Rejected inbound activity: missing bearer token",
      );
      return c.json({ error: "unauthorized" }, 401);
    }

    // (2) Full token validation — no body is processed on failure, and the
    // validator's error detail is never surfaced to the caller.
    logger.debug({ step: INGRESS_STEP }, "Validating inbound activity token");
    const verdict = await validateActivityJwt(authHeader);
    if (!verdict.ok) {
      logger.warn(
        {
          step: INGRESS_STEP,
          hint: "Reject unverified inbound activity",
          errorKind: "auth" as const,
        },
        "Rejected inbound activity: token validation failed",
      );
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
          hint: "Send a JSON activity body",
          errorKind: "validation" as const,
        },
        "Rejected inbound activity: malformed JSON body",
      );
      return c.json({ error: "invalid body" }, 400);
    }

    // A single-activity POST is normalized to the array the adapter expects.
    const activities: unknown[] = Array.isArray(body) ? body : [body];

    // (4) Fast ack. Dispatch defensively so a downstream failure neither
    // blocks the ack nor leaks internal detail through the public endpoint.
    logger.debug(
      { step: INGRESS_STEP, activityCount: activities.length },
      "Dispatching inbound activities",
    );
    try {
      handleWebhookEvents(activities);
    } catch (dispatchErr) {
      logger.error(
        {
          step: INGRESS_STEP,
          err: dispatchErr,
          hint: "Inspect the channel inbound pipeline",
          errorKind: "internal" as const,
        },
        "Inbound activity dispatch failed",
      );
    }

    const durationMs = systemNowMs() - startedAt;
    logger.info(
      { step: INGRESS_STEP, durationMs },
      "Inbound activity accepted",
    );
    return c.body(null, 202);
  });

  return app;
}
