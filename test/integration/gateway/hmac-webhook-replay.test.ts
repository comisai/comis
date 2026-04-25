// SPDX-License-Identifier: Apache-2.0
/**
 * HMAC webhook replay-window integration test.
 *
 * Drives a real Hono mapped-webhook endpoint through createMappedWebhookEndpoint
 * with HMAC-secret enabled, and exercises the replay-window guard inside
 * the createHmacMiddleware that the endpoint installs:
 *
 *   - valid signature + valid recent timestamp     -> 200
 *   - valid signature + STALE timestamp (> 5 min)  -> 401
 *   - valid signature + FUTURE timestamp           -> 401
 *   - valid signature + non-numeric timestamp      -> 401
 *   - tampered body but old correct signature      -> 401 (sig won't match)
 *   - missing signature header                     -> 401
 *   - wrong signature                              -> 401
 *   - no timestamp header (default policy: allow)  -> 200 with valid sig
 *
 * No daemon required -- the endpoint is mounted on a transient Hono app
 * and `app.request()` is called in-memory.
 *
 * @module
 */

import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import { Hono } from "hono";
import { createMappedWebhookEndpoint } from "@comis/gateway";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SECRET = "test-webhook-secret-aaaa";

function sign(body: string): string {
  return createHmac("sha256", SECRET).update(body).digest("hex");
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

// ---------------------------------------------------------------------------
// Endpoint factory
// ---------------------------------------------------------------------------

function makeApp() {
  const calls: Array<{ kind: "wake" | "agent"; mappingId: string }> = [];

  const endpoint = createMappedWebhookEndpoint({
    mappings: [
      {
        id: "alpha",
        path: "alpha",
        action: "agent",
        target: { agentId: "default", sessionKey: "test:user_a:chan_001" },
        message: "hello",
      },
    ],
    secret: SECRET,
    onWake: async (m) => {
      calls.push({ kind: "wake", mappingId: m.id });
    },
    onAgentAction: async (m) => {
      calls.push({ kind: "agent", mappingId: m.id });
    },
  });

  const app = new Hono();
  app.route("/webhook", endpoint);
  return { app, calls };
}

async function post(
  app: Hono,
  path: string,
  body: string,
  headers: Record<string, string> = {},
): Promise<Response> {
  return app.request(`/webhook/${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...headers,
    },
    body,
  });
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe("HMAC webhook -- happy path", () => {
  it("accepts a valid signature with a fresh timestamp", async () => {
    const { app, calls } = makeApp();
    const body = JSON.stringify({ payload: "ok" });
    const res = await post(app, "alpha", body, {
      "x-webhook-signature": sign(body),
      "x-webhook-timestamp": String(nowSec()),
    });
    expect(res.status).toBe(200);
    expect(calls.length).toBe(1);
    expect(calls[0]!.kind).toBe("agent");
  });

  it("accepts a valid signature WITHOUT a timestamp header (default policy)", async () => {
    const { app, calls } = makeApp();
    const body = JSON.stringify({ payload: "ok" });
    const res = await post(app, "alpha", body, {
      "x-webhook-signature": sign(body),
    });
    expect(res.status).toBe(200);
    expect(calls.length).toBe(1);
  });
});

describe("HMAC webhook -- replay-window violations", () => {
  it("rejects a STALE timestamp (older than 5 minutes)", async () => {
    const { app, calls } = makeApp();
    const body = JSON.stringify({ payload: "stale" });
    const stale = nowSec() - 600; // 10 minutes ago, well beyond default 300s
    const res = await post(app, "alpha", body, {
      "x-webhook-signature": sign(body),
      "x-webhook-timestamp": String(stale),
    });
    expect(res.status).toBe(401);
    expect(calls.length).toBe(0);
    const json = (await res.json()) as { error?: string };
    expect(json.error ?? "").toMatch(/timestamp/i);
  });

  it("rejects a FUTURE timestamp (clock-skew attack)", async () => {
    const { app, calls } = makeApp();
    const body = JSON.stringify({ payload: "future" });
    const future = nowSec() + 3600; // 1 hour in the future
    const res = await post(app, "alpha", body, {
      "x-webhook-signature": sign(body),
      "x-webhook-timestamp": String(future),
    });
    expect(res.status).toBe(401);
    expect(calls.length).toBe(0);
  });

  it("rejects a non-numeric timestamp", async () => {
    const { app, calls } = makeApp();
    const body = JSON.stringify({ payload: "garbage" });
    const res = await post(app, "alpha", body, {
      "x-webhook-signature": sign(body),
      "x-webhook-timestamp": "not-a-number",
    });
    expect(res.status).toBe(401);
    expect(calls.length).toBe(0);
  });
});

describe("HMAC webhook -- signature integrity", () => {
  it("rejects a request with NO signature header", async () => {
    const { app, calls } = makeApp();
    const body = JSON.stringify({ payload: "x" });
    const res = await post(app, "alpha", body, {
      "x-webhook-timestamp": String(nowSec()),
    });
    expect(res.status).toBe(401);
    expect(calls.length).toBe(0);
  });

  it("rejects a wrong signature", async () => {
    const { app, calls } = makeApp();
    const body = JSON.stringify({ payload: "x" });
    const res = await post(app, "alpha", body, {
      "x-webhook-signature": "deadbeef".repeat(8),
      "x-webhook-timestamp": String(nowSec()),
    });
    expect(res.status).toBe(401);
    expect(calls.length).toBe(0);
  });

  it("rejects a tampered body but stale-correct signature", async () => {
    // The attacker signed the original body; we replay the signature against
    // a tampered body. HMAC verification compares against the NEW body, so
    // the signature mismatch must reject the request.
    const { app, calls } = makeApp();
    const original = JSON.stringify({ payload: "ok" });
    const sig = sign(original); // signature for `original`

    const tampered = JSON.stringify({ payload: "OK!" }); // different bytes
    const res = await post(app, "alpha", tampered, {
      "x-webhook-signature": sig,
      "x-webhook-timestamp": String(nowSec()),
    });
    expect(res.status).toBe(401);
    expect(calls.length).toBe(0);
  });

  it("rejects a uppercased signature when the verifier expects exact match", async () => {
    const { app } = makeApp();
    const body = JSON.stringify({ payload: "ok" });
    const sig = sign(body).toUpperCase(); // hex case-flipped
    const res = await post(app, "alpha", body, {
      "x-webhook-signature": sig,
      "x-webhook-timestamp": String(nowSec()),
    });
    // The current verifier uses byte-exact match on the hex digest.
    // If a future change makes it case-insensitive, this test will catch
    // the regression so reviewers can decide.
    expect(res.status).toBe(401);
  });
});

describe("HMAC webhook -- second wave after a successful first", () => {
  it("accepts independent signed messages on the same endpoint", async () => {
    const { app, calls } = makeApp();
    const bodies = ["one", "two", "three"];
    for (const b of bodies) {
      const body = JSON.stringify({ payload: b });
      const res = await post(app, "alpha", body, {
        "x-webhook-signature": sign(body),
        "x-webhook-timestamp": String(nowSec()),
      });
      expect(res.status).toBe(200);
    }
    expect(calls.length).toBe(3);
  });
});
