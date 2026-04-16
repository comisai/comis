import { Hono } from "hono";
import { createHmac } from "node:crypto";
import { describe, it, expect } from "vitest";
import { verifyHmacSignature, createHmacMiddleware } from "./hmac-verifier.js";

const TEST_SECRET = "webhook-secret-abc123";

function computeSignature(secret: string, body: string, algorithm = "sha256"): string {
  return createHmac(algorithm, secret).update(body).digest("hex");
}

describe("verifyHmacSignature", () => {
  const body = '{"event":"test","data":{}}';

  it("returns true for valid signature", () => {
    const sig = computeSignature(TEST_SECRET, body);
    expect(verifyHmacSignature(TEST_SECRET, sig, body)).toBe(true);
  });

  it("returns false for invalid signature", () => {
    const sig = computeSignature(TEST_SECRET, body);
    // Flip last character
    const badSig = sig.slice(0, -1) + (sig.endsWith("0") ? "1" : "0");
    expect(verifyHmacSignature(TEST_SECRET, badSig, body)).toBe(false);
  });

  it("returns false for wrong secret", () => {
    const sig = computeSignature("wrong-secret", body);
    expect(verifyHmacSignature(TEST_SECRET, sig, body)).toBe(false);
  });

  it("returns false for tampered body", () => {
    const sig = computeSignature(TEST_SECRET, body);
    const tampered = '{"event":"hacked","data":{}}';
    expect(verifyHmacSignature(TEST_SECRET, sig, tampered)).toBe(false);
  });

  it("returns false for length mismatch (short signature)", () => {
    expect(verifyHmacSignature(TEST_SECRET, "abc", body)).toBe(false);
  });

  it("returns false for length mismatch (long signature)", () => {
    const sig = computeSignature(TEST_SECRET, body);
    expect(verifyHmacSignature(TEST_SECRET, sig + "extra", body)).toBe(false);
  });

  it("returns false for empty signature", () => {
    expect(verifyHmacSignature(TEST_SECRET, "", body)).toBe(false);
  });

  it("supports sha384 algorithm", () => {
    const sig = computeSignature(TEST_SECRET, body, "sha384");
    expect(verifyHmacSignature(TEST_SECRET, sig, body, "sha384")).toBe(true);
  });

  it("supports sha512 algorithm", () => {
    const sig = computeSignature(TEST_SECRET, body, "sha512");
    expect(verifyHmacSignature(TEST_SECRET, sig, body, "sha512")).toBe(true);
  });

  it("works with Buffer body", () => {
    const bodyBuf = Buffer.from(body, "utf-8");
    const sig = computeSignature(TEST_SECRET, body);
    expect(verifyHmacSignature(TEST_SECRET, sig, bodyBuf)).toBe(true);
  });
});

describe("createHmacMiddleware", () => {
  function createTestApp(secret: string) {
    const app = new Hono();
    const middleware = createHmacMiddleware({ secret });

    app.post("/webhook", middleware, (c) => {
      const rawBody = c.get("rawBody");
      return c.json({ received: true, bodyLength: (rawBody as string).length });
    });

    return app;
  }

  it("returns 401 for missing signature header", async () => {
    const app = createTestApp(TEST_SECRET);
    const res = await app.request("/webhook", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"event":"test"}',
    });

    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.error).toBe("Missing webhook signature");
  });

  it("returns 401 for invalid signature", async () => {
    const app = createTestApp(TEST_SECRET);
    const res = await app.request("/webhook", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-webhook-signature": "invalid-hex-signature",
      },
      body: '{"event":"test"}',
    });

    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.error).toBe("Invalid webhook signature");
  });

  it("passes through with valid signature and stores rawBody", async () => {
    const app = createTestApp(TEST_SECRET);
    const body = '{"event":"test"}';
    const sig = computeSignature(TEST_SECRET, body);

    const res = await app.request("/webhook", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-webhook-signature": sig,
      },
      body,
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.received).toBe(true);
    expect(json.bodyLength).toBe(body.length);
  });

  it("supports custom header name", async () => {
    const app = new Hono();
    const middleware = createHmacMiddleware({
      secret: TEST_SECRET,
      headerName: "x-custom-sig",
    });
    app.post("/webhook", middleware, (c) => c.json({ ok: true }));

    const body = '{"event":"test"}';
    const sig = computeSignature(TEST_SECRET, body);

    const res = await app.request("/webhook", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-custom-sig": sig,
      },
      body,
    });

    expect(res.status).toBe(200);
  });

  it("returns 401 when signature is for different body", async () => {
    const app = createTestApp(TEST_SECRET);
    const sig = computeSignature(TEST_SECRET, '{"event":"original"}');

    const res = await app.request("/webhook", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-webhook-signature": sig,
      },
      body: '{"event":"tampered"}',
    });

    expect(res.status).toBe(401);
  });
});

describe("createHmacMiddleware timestamp freshness", () => {
  function createTimestampApp(
    secret: string,
    opts: { timestampHeaderName?: string; maxAgeSec?: number } = {},
  ) {
    const app = new Hono();
    const middleware = createHmacMiddleware({ secret, ...opts });

    app.post("/webhook", middleware, (c) => {
      return c.json({ received: true });
    });

    return app;
  }

  function nowSec(): number {
    return Math.floor(Date.now() / 1000);
  }

  it("passes with valid timestamp within 5 min window", async () => {
    const app = createTimestampApp(TEST_SECRET);
    const body = '{"event":"test"}';
    const sig = computeSignature(TEST_SECRET, body);
    const ts = String(nowSec());

    const res = await app.request("/webhook", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-webhook-signature": sig,
        "x-webhook-timestamp": ts,
      },
      body,
    });

    expect(res.status).toBe(200);
  });

  it("returns 401 for timestamp older than 5 min", async () => {
    const app = createTimestampApp(TEST_SECRET);
    const body = '{"event":"test"}';
    const sig = computeSignature(TEST_SECRET, body);
    // 6 minutes in the past
    const ts = String(nowSec() - 360);

    const res = await app.request("/webhook", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-webhook-signature": sig,
        "x-webhook-timestamp": ts,
      },
      body,
    });

    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.error).toBe("Webhook timestamp expired or invalid");
  });

  it("returns 401 for future timestamp beyond 5 min", async () => {
    const app = createTimestampApp(TEST_SECRET);
    const body = '{"event":"test"}';
    const sig = computeSignature(TEST_SECRET, body);
    // 6 minutes in the future
    const ts = String(nowSec() + 360);

    const res = await app.request("/webhook", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-webhook-signature": sig,
        "x-webhook-timestamp": ts,
      },
      body,
    });

    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.error).toBe("Webhook timestamp expired or invalid");
  });

  it("returns 401 for invalid (NaN) timestamp", async () => {
    const app = createTimestampApp(TEST_SECRET);
    const body = '{"event":"test"}';
    const sig = computeSignature(TEST_SECRET, body);

    const res = await app.request("/webhook", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-webhook-signature": sig,
        "x-webhook-timestamp": "not-a-number",
      },
      body,
    });

    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.error).toBe("Webhook timestamp expired or invalid");
  });

  it("passes with no timestamp header (backward compat)", async () => {
    const app = createTimestampApp(TEST_SECRET);
    const body = '{"event":"test"}';
    const sig = computeSignature(TEST_SECRET, body);

    const res = await app.request("/webhook", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-webhook-signature": sig,
      },
      body,
    });

    expect(res.status).toBe(200);
  });

  it("respects custom maxAgeSec", async () => {
    // Allow only 10 seconds
    const app = createTimestampApp(TEST_SECRET, { maxAgeSec: 10 });
    const body = '{"event":"test"}';
    const sig = computeSignature(TEST_SECRET, body);

    // 15 seconds in the past -- should fail with 10s window
    const ts = String(nowSec() - 15);

    const res = await app.request("/webhook", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-webhook-signature": sig,
        "x-webhook-timestamp": ts,
      },
      body,
    });

    expect(res.status).toBe(401);

    // 5 seconds in the past -- should pass with 10s window
    const ts2 = String(nowSec() - 5);
    const res2 = await app.request("/webhook", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-webhook-signature": sig,
        "x-webhook-timestamp": ts2,
      },
      body,
    });

    expect(res2.status).toBe(200);
  });

  it("returns 401 when requireTimestamp is true and timestamp is missing", async () => {
    const app = new Hono();
    const middleware = createHmacMiddleware({
      secret: TEST_SECRET,
      requireTimestamp: true,
    });
    app.post("/webhook", middleware, (c) => c.json({ received: true }));

    const body = '{"event":"test"}';
    const sig = computeSignature(TEST_SECRET, body);

    // No timestamp header -- should be rejected
    const res = await app.request("/webhook", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-webhook-signature": sig,
      },
      body,
    });

    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.error).toBe("Missing required webhook timestamp");
  });

  it("passes when requireTimestamp is true and valid timestamp is provided", async () => {
    const app = new Hono();
    const middleware = createHmacMiddleware({
      secret: TEST_SECRET,
      requireTimestamp: true,
    });
    app.post("/webhook", middleware, (c) => c.json({ received: true }));

    const body = '{"event":"test"}';
    const sig = computeSignature(TEST_SECRET, body);
    const ts = String(nowSec());

    const res = await app.request("/webhook", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-webhook-signature": sig,
        "x-webhook-timestamp": ts,
      },
      body,
    });

    expect(res.status).toBe(200);
  });

  it("allows missing timestamp when requireTimestamp is false (default)", async () => {
    const app = new Hono();
    const middleware = createHmacMiddleware({
      secret: TEST_SECRET,
      requireTimestamp: false,
    });
    app.post("/webhook", middleware, (c) => c.json({ received: true }));

    const body = '{"event":"test"}';
    const sig = computeSignature(TEST_SECRET, body);

    // No timestamp header -- should be allowed with requireTimestamp: false
    const res = await app.request("/webhook", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-webhook-signature": sig,
      },
      body,
    });

    expect(res.status).toBe(200);
  });

  it("respects custom timestampHeaderName", async () => {
    const app = createTimestampApp(TEST_SECRET, {
      timestampHeaderName: "x-custom-ts",
    });
    const body = '{"event":"test"}';
    const sig = computeSignature(TEST_SECRET, body);

    // Expired timestamp on custom header should be rejected
    const ts = String(nowSec() - 360);

    const res = await app.request("/webhook", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-webhook-signature": sig,
        "x-custom-ts": ts,
      },
      body,
    });

    expect(res.status).toBe(401);

    // Valid timestamp on custom header should pass
    const ts2 = String(nowSec());
    const res2 = await app.request("/webhook", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-webhook-signature": sig,
        "x-custom-ts": ts2,
      },
      body,
    });

    expect(res2.status).toBe(200);
  });
});
