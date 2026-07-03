// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, type Mock } from "vitest";
import { ok, err, type Result } from "@comis/shared";
import type { ComisLogger } from "@comis/core";
import type { MsTeamsIngressDeps } from "./msteams-ingress.js";
import { createMsTeamsIngress } from "./msteams-ingress.js";

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

// A stub validator so the handler test needs no real Bot Framework signing
// keys: only "Bearer good" verifies; every other token is rejected. The
// rejection carries an internal-looking message the opacity assertion proves
// never reaches the 401 response body.
const stubValidator = async (
  authHeader: string | undefined,
): Promise<Result<void, Error>> =>
  authHeader === "Bearer good"
    ? ok(undefined)
    : err(new Error("token signature invalid: kid=rotated-key issuer=api.mismatch"));

interface AppOverrides {
  validateActivityJwt?: MsTeamsIngressDeps["validateActivityJwt"];
  handleWebhookEvents?: Mock;
}

function createApp(overrides: AppOverrides = {}) {
  const handleWebhookEvents: Mock = overrides.handleWebhookEvents ?? vi.fn();
  const app = createMsTeamsIngress({
    validateActivityJwt: overrides.validateActivityJwt ?? stubValidator,
    handleWebhookEvents,
    logger: noopLogger(),
  });
  return { app, handleWebhookEvents };
}

function post(
  app: ReturnType<typeof createMsTeamsIngress>,
  headers: Record<string, string>,
  body: string,
) {
  return app.request("/api/messages", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body,
  });
}

describe("createMsTeamsIngress", () => {
  it("returns 401 and does NOT dispatch when the Authorization header is missing", async () => {
    const { app, handleWebhookEvents } = createApp();

    const res = await post(app, {}, JSON.stringify({ type: "message", text: "hi" }));

    expect(res.status).toBe(401);
    expect(handleWebhookEvents).not.toHaveBeenCalled();
  });

  it("returns 401 with no dispatch and no internal detail when the validator rejects the token", async () => {
    const { app, handleWebhookEvents } = createApp();

    const res = await post(
      app,
      { authorization: "Bearer bad" },
      JSON.stringify({ type: "message", text: "hi" }),
    );

    expect(res.status).toBe(401);
    expect(handleWebhookEvents).not.toHaveBeenCalled();

    // Opacity: the injected validator's error detail must not leak into the body.
    const serialized = JSON.stringify(await res.json());
    expect(serialized).not.toContain("token signature invalid");
    expect(serialized).not.toContain("kid=rotated-key");
    expect(serialized).not.toContain("issuer=");
  });

  it("fast-acks (200/202) and dispatches the activity exactly once on a valid token", async () => {
    const { app, handleWebhookEvents } = createApp();

    const res = await post(
      app,
      { authorization: "Bearer good" },
      JSON.stringify({ type: "message", text: "hi" }),
    );

    expect([200, 202]).toContain(res.status);
    expect(handleWebhookEvents).toHaveBeenCalledOnce();

    const [activities] = handleWebhookEvents.mock.calls[0] as [unknown[]];
    expect(Array.isArray(activities)).toBe(true);
    expect(activities).toHaveLength(1);
    expect(activities[0]).toMatchObject({ type: "message", text: "hi" });
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
      JSON.stringify({ type: "message", text: "hi" }),
    );

    // A throwing downstream must neither break the fast ack nor surface detail.
    expect([200, 202]).toContain(res.status);
    expect(throwing).toHaveBeenCalledOnce();

    const text = await res.text();
    expect(text).not.toContain("pipeline exploded");
    expect(text).not.toContain("10.0.0.5");
  });
});
