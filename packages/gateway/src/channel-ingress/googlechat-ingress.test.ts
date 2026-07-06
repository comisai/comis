// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, type Mock } from "vitest";
import { ok, err, type Result } from "@comis/shared";
import type { ComisLogger } from "@comis/core";
import type { GoogleChatIngressDeps } from "./googlechat-ingress.js";
import { createGoogleChatIngress } from "./googlechat-ingress.js";

/** A no-op logger satisfying the structural ComisLogger contract. */
function noopLogger(): ComisLogger {
  const noop = (): void => {};
  return {
    level: "silent",
    trace: noop,
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    fatal: noop,
    audit: noop,
    child: () => noopLogger(),
  };
}

// A stub validator so the handler test needs no real signing keys: only
// "Bearer good" verifies; every other token is rejected. The rejection carries
// an internal-looking message the opacity assertion proves never reaches the
// 401 response body.
const stubValidator = async (
  authHeader: string | undefined,
): Promise<Result<void, Error>> =>
  authHeader === "Bearer good"
    ? ok(undefined)
    : err(new Error("token signature invalid: kid=rotated-key issuer=api.mismatch"));

interface AppOverrides {
  validateInboundJwt?: GoogleChatIngressDeps["validateInboundJwt"];
  handleWebhookEvents?: Mock;
  onAuthRejected?: Mock;
}

function createApp(overrides: AppOverrides = {}) {
  const handleWebhookEvents: Mock = overrides.handleWebhookEvents ?? vi.fn();
  // The auth-reject hook is OPTIONAL: it is threaded only when a test supplies
  // it, so the existing cases exercise the no-op-when-absent composition path.
  const deps: GoogleChatIngressDeps = {
    validateInboundJwt: overrides.validateInboundJwt ?? stubValidator,
    handleWebhookEvents,
    logger: noopLogger(),
    ...(overrides.onAuthRejected ? { onAuthRejected: overrides.onAuthRejected } : {}),
  };
  const app = createGoogleChatIngress(deps);
  return { app, handleWebhookEvents, onAuthRejected: overrides.onAuthRejected };
}

function post(
  app: ReturnType<typeof createGoogleChatIngress>,
  headers: Record<string, string>,
  body: string,
) {
  return app.request("/", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body,
  });
}

describe("createGoogleChatIngress", () => {
  it("returns 401 and does NOT dispatch when the Authorization header is missing", async () => {
    const { app, handleWebhookEvents } = createApp();

    const res = await post(app, {}, JSON.stringify({ message: { text: "hi" } }));

    expect(res.status).toBe(401);
    expect(handleWebhookEvents).not.toHaveBeenCalled();
  });

  it("returns 401 with no dispatch and no internal detail when the validator rejects the token", async () => {
    const { app, handleWebhookEvents } = createApp();

    const res = await post(
      app,
      { authorization: "Bearer bad" },
      JSON.stringify({ message: { text: "hi" } }),
    );

    expect(res.status).toBe(401);
    expect(handleWebhookEvents).not.toHaveBeenCalled();

    // Opacity: the injected validator's error detail must not leak into the body.
    const serialized = JSON.stringify(await res.json());
    expect(serialized).not.toContain("token signature invalid");
    expect(serialized).not.toContain("kid=rotated-key");
    expect(serialized).not.toContain("issuer=");
  });

  it("fast-acks (200/202) and dispatches the event exactly once on a valid token", async () => {
    const { app, handleWebhookEvents } = createApp();

    const res = await post(
      app,
      { authorization: "Bearer good" },
      JSON.stringify({ type: "MESSAGE", message: { text: "hi" } }),
    );

    expect([200, 202]).toContain(res.status);
    expect(handleWebhookEvents).toHaveBeenCalledOnce();

    const [events] = handleWebhookEvents.mock.calls[0] as [unknown[]];
    expect(Array.isArray(events)).toBe(true);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "MESSAGE", message: { text: "hi" } });
  });

  it("rejects a malformed JSON body with a 4xx and does not dispatch garbage", async () => {
    const { app, handleWebhookEvents } = createApp();

    const res = await post(app, { authorization: "Bearer good" }, "not-json{{{");

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    expect(handleWebhookEvents).not.toHaveBeenCalled();
  });

  it("still fast-acks and leaks nothing when the injected dispatch throws", async () => {
    const throwing: Mock = vi.fn(() => {
      throw new Error("pipeline exploded at 10.0.0.5: connection refused");
    });
    const { app } = createApp({ handleWebhookEvents: throwing });

    const res = await post(
      app,
      { authorization: "Bearer good" },
      JSON.stringify({ type: "MESSAGE", message: { text: "hi" } }),
    );

    // A throwing downstream must neither break the fast ack nor surface detail.
    expect([200, 202]).toContain(res.status);
    expect(throwing).toHaveBeenCalledOnce();

    const text = await res.text();
    expect(text).not.toContain("pipeline exploded");
    expect(text).not.toContain("10.0.0.5");
  });
});

// ---------------------------------------------------------------------------
// Content-free auth-reject fleet signal.
//
// Each 401 gate fires an injected content-free hook so a forged / expired /
// wrong-audience / missing-token FLOOD is COUNTABLE by the fleet lens — while
// the rejection behavior and the opaque 401 response stay exactly as they were.
// ---------------------------------------------------------------------------
describe("createGoogleChatIngress — content-free auth-reject signal", () => {
  it("signals reason 'missing_bearer' on the missing-bearer 401, behavior + opaque body unchanged", async () => {
    const onAuthRejected: Mock = vi.fn();
    const { app, handleWebhookEvents } = createApp({ onAuthRejected });

    const res = await post(app, {}, JSON.stringify({ message: { text: "hi" } }));

    // The 401 gate + fixed opaque body are UNCHANGED — the signal is additive.
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
    expect(handleWebhookEvents).not.toHaveBeenCalled();

    // The content-free signal fired exactly once with ONLY the closed reason.
    expect(onAuthRejected).toHaveBeenCalledOnce();
    expect(onAuthRejected).toHaveBeenCalledWith("missing_bearer");
  });

  it("signals reason 'invalid_token' on the JWT-invalid 401 and carries no token material", async () => {
    const onAuthRejected: Mock = vi.fn();
    const { app, handleWebhookEvents } = createApp({ onAuthRejected });

    const res = await post(
      app,
      { authorization: "Bearer bad" },
      JSON.stringify({ message: { text: "hi" } }),
    );

    expect(res.status).toBe(401);
    expect(handleWebhookEvents).not.toHaveBeenCalled();
    expect(onAuthRejected).toHaveBeenCalledOnce();

    // Content-free: the ONLY argument is the closed reason string — no token,
    // no Authorization header, no body can ride the signal.
    const call = onAuthRejected.mock.calls[0] as unknown[];
    expect(call).toEqual(["invalid_token"]);
    expect(JSON.stringify(call)).not.toContain("Bearer");
    expect(JSON.stringify(call)).not.toContain("bad");
  });

  it("does NOT signal on a valid event (no false-positive flood counts)", async () => {
    const onAuthRejected: Mock = vi.fn();
    const { app, handleWebhookEvents } = createApp({ onAuthRejected });

    const res = await post(
      app,
      { authorization: "Bearer good" },
      JSON.stringify({ type: "MESSAGE", message: { text: "hi" } }),
    );

    expect([200, 202]).toContain(res.status);
    expect(handleWebhookEvents).toHaveBeenCalledOnce();
    expect(onAuthRejected).not.toHaveBeenCalled();
  });

  it("still rejects 401 with no onAuthRejected hook injected (no-op when absent)", async () => {
    // The composition path may omit the hook — the gate stays intact and must
    // not throw for a missing bearer or an invalid token.
    const { app, handleWebhookEvents } = createApp(); // no onAuthRejected

    const missing = await post(app, {}, JSON.stringify({ message: { text: "hi" } }));
    expect(missing.status).toBe(401);

    const invalid = await post(
      app,
      { authorization: "Bearer bad" },
      JSON.stringify({ message: { text: "hi" } }),
    );
    expect(invalid.status).toBe(401);
    expect(handleWebhookEvents).not.toHaveBeenCalled();
  });
});
