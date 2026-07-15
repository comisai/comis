// SPDX-License-Identifier: Apache-2.0
import { createHmac } from "node:crypto";
import { describe, it, expect, vi } from "vitest";
import type { MappedWebhookEndpointDeps } from "./webhook-endpoint.js";
import { createMappedWebhookEndpoint } from "./webhook-endpoint.js";
import type { WebhookMappingConfig } from "@comis/core";

const TEST_SECRET = "webhook-test-secret-xyz";

function signBody(body: string, secret = TEST_SECRET): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

// ---------------------------------------------------------------------------
// createMappedWebhookEndpoint
// ---------------------------------------------------------------------------

describe("createMappedWebhookEndpoint", () => {
  const gmailMapping: WebhookMappingConfig = {
    id: "gmail",
    match: { path: "gmail" },
    action: "agent",
    wakeMode: "now",
    sessionKey: "hook:gmail:{{payload.messageId}}",
    messageTemplate: "New email from {{payload.from}}: {{payload.subject}}",
  };

  const wakeMapping: WebhookMappingConfig = {
    id: "heartbeat",
    match: { path: "wake" },
    action: "wake",
    wakeMode: "now",
  };

  function createMappedApp(
    overrides: Partial<MappedWebhookEndpointDeps> = {},
  ) {
    const onWake = vi.fn().mockResolvedValue(undefined);
    const onAgentAction = vi.fn().mockResolvedValue(undefined);
    const mappings = overrides.mappings ?? [gmailMapping, wakeMapping];

    const app = createMappedWebhookEndpoint({
      mappings,
      onWake,
      onAgentAction,
      ...overrides,
    });

    return { app, onWake, onAgentAction };
  }

  function makeMappedRequest(
    app: ReturnType<typeof createMappedWebhookEndpoint>,
    path: string,
    body: string,
    extraHeaders: Record<string, string> = {},
  ) {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      ...extraHeaders,
    };
    return app.request(`/${path}`, {
      method: "POST",
      headers,
      body,
    });
  }

  it("routes to matching path and calls onAgentAction with rendered template", async () => {
    const { app, onAgentAction } = createMappedApp();
    const body = JSON.stringify({
      messageId: "msg-123",
      from: "alice@example.com",
      subject: "Hello World",
    });

    const res = await makeMappedRequest(app, "gmail", body);
    expect(res.status).toBe(200);

    const json = await res.json();
    expect(json.received).toBe(true);
    expect(json.mapping).toBe("gmail");

    expect(onAgentAction).toHaveBeenCalledOnce();
    const [mapping, renderedMessage, renderedSessionKey] = onAgentAction.mock.calls[0];
    expect(mapping.id).toBe("gmail");
    expect(renderedMessage).toBe("New email from alice@example.com: Hello World");
    expect(renderedSessionKey).toBe("hook:gmail:msg-123");
  });

  it("returns 404 for unmatched path", async () => {
    const { app } = createMappedApp({
      mappings: [gmailMapping], // only gmail, no catch-all
    });
    const body = JSON.stringify({ data: "test" });

    const res = await makeMappedRequest(app, "unknown", body);
    expect(res.status).toBe(404);

    const json = await res.json();
    expect(json.error).toBe("No matching webhook mapping");
  });

  it("wake action calls onWake", async () => {
    const { app, onWake, onAgentAction } = createMappedApp();
    const body = JSON.stringify({ ping: true });

    const res = await makeMappedRequest(app, "wake", body);
    expect(res.status).toBe(200);

    expect(onWake).toHaveBeenCalledOnce();
    expect(onWake.mock.calls[0][0].id).toBe("heartbeat");
    expect(onAgentAction).not.toHaveBeenCalled();
  });

  it("verifies HMAC when secret is provided", async () => {
    const { app } = createMappedApp({ secret: TEST_SECRET });
    const body = JSON.stringify({ messageId: "msg-1", from: "test", subject: "test" });

    // Without signature -> 401
    const res1 = await makeMappedRequest(app, "gmail", body);
    expect(res1.status).toBe(401);

    // With valid signature -> 200
    const sig = signBody(body);
    const res2 = await makeMappedRequest(app, "gmail", body, {
      "x-webhook-signature": sig,
    });
    expect(res2.status).toBe(200);
  });

  it("resolves template variables correctly in message and session key", async () => {
    const mapping: WebhookMappingConfig = {
      id: "custom",
      match: { path: "custom" },
      action: "agent",
      wakeMode: "now",
      sessionKey: "hook:custom:{{payload.id}}:{{path}}",
      messageTemplate: "Event at {{now}} on path {{path}}: {{payload.data.value}}",
    };
    const { app, onAgentAction } = createMappedApp({ mappings: [mapping] });
    const body = JSON.stringify({ id: "evt-42", data: { value: "important" } });

    const res = await makeMappedRequest(app, "custom", body);
    expect(res.status).toBe(200);

    const [, renderedMessage, renderedSessionKey] = onAgentAction.mock.calls[0];
    expect(renderedSessionKey).toContain("hook:custom:evt-42:custom");
    expect(renderedMessage).toContain("important");
    expect(renderedMessage).toContain("custom");
    // {{now}} should be an ISO timestamp
    expect(renderedMessage).toMatch(/\d{4}-\d{2}-\d{2}T/);
  });

  it("returns 400 for invalid JSON body", async () => {
    const { app } = createMappedApp();
    const res = await makeMappedRequest(app, "gmail", "not-json{{{");

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe("Invalid JSON body");
  });

  it("acks on receipt without awaiting the agent turn (background dispatch)", async () => {
    let turnCompleted = false;
    let releaseTurn!: () => void;
    const turnGate = new Promise<void>((resolve) => {
      releaseTurn = resolve;
    });
    const onAgentAction = vi.fn(async () => {
      await turnGate;
      turnCompleted = true;
    });
    const { app } = createMappedApp({ onAgentAction });
    const body = JSON.stringify({ messageId: "m1", from: "a", subject: "b" });

    // The endpoint must respond BEFORE the (still-in-flight) turn completes. An agent
    // turn can run for minutes; awaiting it here would hang the caller and — at its
    // request timeout — trigger a re-delivery storm.
    const res = await makeMappedRequest(app, "gmail", body);
    expect(res.status).toBe(200);
    expect((await res.json()).received).toBe(true);
    expect(onAgentAction).toHaveBeenCalledOnce();
    expect(turnCompleted).toBe(false); // the ack did not wait for the turn

    // Let the background turn finish so the test leaves no dangling promise.
    releaseTurn();
    await turnGate;
  });

  it("agent action acks 200 even when the background turn rejects (failure logged, not returned)", async () => {
    const { app } = createMappedApp({
      onAgentAction: vi.fn().mockRejectedValue(new Error("Handler failed: connection refused at 10.0.0.1:5432")),
    });
    const body = JSON.stringify({ messageId: "x", from: "a", subject: "b" });

    const res = await makeMappedRequest(app, "gmail", body);
    // The turn runs in the background; its failure never becomes this request's status.
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.received).toBe(true);
    // And it must never leak handler internals into the ack.
    expect(JSON.stringify(json)).not.toContain("Handler failed");
    expect(JSON.stringify(json)).not.toContain("10.0.0.1");
  });

  it("wake action returns 500 with generic error when onWake throws", async () => {
    const { app } = createMappedApp({
      onWake: vi.fn().mockRejectedValue(new Error("Wake failed: connection refused at 10.0.0.1:5432")),
    });
    const body = JSON.stringify({ ping: true });

    const res = await makeMappedRequest(app, "wake", body);
    expect(res.status).toBe(500);
    const json = await res.json();
    expect(json.error).toBe("Internal error");
    // Must NOT leak handler internals
    expect(JSON.stringify(json)).not.toContain("Wake failed");
    expect(JSON.stringify(json)).not.toContain("10.0.0.1");
  });

  it("handles agent action with no messageTemplate gracefully", async () => {
    const mapping: WebhookMappingConfig = {
      id: "bare",
      match: { path: "bare" },
      action: "agent",
      wakeMode: "now",
      // No messageTemplate or sessionKey
    };
    const { app, onAgentAction } = createMappedApp({ mappings: [mapping] });
    const body = JSON.stringify({ data: "test" });

    const res = await makeMappedRequest(app, "bare", body);
    expect(res.status).toBe(200);

    const [, renderedMessage, renderedSessionKey] = onAgentAction.mock.calls[0];
    expect(renderedMessage).toBe("");
    expect(renderedSessionKey).toBe("");
  });

  it("rejects mapped webhook with body over 1MB via content-length", async () => {
    const { app } = createMappedApp();
    const body = JSON.stringify({ data: "small" });
    // Fake a content-length that exceeds 1MB
    const res = await app.request("/gmail", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": String(2 * 1024 * 1024),
      },
      body,
    });

    expect(res.status).toBe(413);
  });

  it("applies body limit before HMAC processing on mapped webhook", async () => {
    const { app } = createMappedApp({ secret: TEST_SECRET });
    const body = JSON.stringify({ data: "small" });
    // Fake a content-length that exceeds 1MB -- should be rejected BEFORE HMAC check
    const res = await app.request("/gmail", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": String(2 * 1024 * 1024),
      },
      body,
    });

    // Should get 413 (body limit) NOT 401 (missing signature)
    expect(res.status).toBe(413);
  });
});
