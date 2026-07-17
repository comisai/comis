// SPDX-License-Identifier: Apache-2.0
import { TypedEventBus } from "@comis/core";
import { describe, it, expect, vi } from "vitest";
import type { RpcAdapterDeps } from "../rpc/rpc-adapters.js";
import { createTokenStore } from "../auth/token-auth.js";
import { createSseEndpoint, type SseEndpointDeps } from "./sse-endpoint.js";

/** Create mock RPC adapter deps */
function createMockRpcDeps(overrides?: Partial<RpcAdapterDeps>): RpcAdapterDeps {
  return {
    executeAgent: vi.fn().mockResolvedValue({
      response: "Agent response",
      tokensUsed: 10,
      finishReason: "stop",
    }),
    searchMemory: vi.fn().mockResolvedValue({ results: [] }),
    inspectMemory: vi.fn().mockResolvedValue({ stats: {} }),
    getConfig: vi.fn().mockResolvedValue({}),
    setConfig: vi.fn().mockResolvedValue({ ok: true }),
    logger: { info: vi.fn(), error: vi.fn() },
    ...overrides,
  };
}

/** Create SSE endpoint deps */
function createSseDeps(overrides?: Partial<SseEndpointDeps>): SseEndpointDeps {
  return {
    eventBus: new TypedEventBus(),
    tokenStore: createTokenStore([
      { id: "test-client", secret: "sse-token-123-padded-to-meet-32-chars", scopes: ["rpc", "admin"] },
    ]),
    rpcAdapterDeps: createMockRpcDeps(),
    bodyLimitBytes: 1_048_576,
    ...overrides,
  };
}

function authHeaders(): HeadersInit {
  return { Authorization: "Bearer sse-token-123-padded-to-meet-32-chars" };
}

describe("createSseEndpoint", () => {
  it("returns a Hono instance", () => {
    const sse = createSseEndpoint(createSseDeps());
    expect(sse).toBeDefined();
    expect(typeof sse.fetch).toBe("function");
  });

  describe("authentication", () => {
    it("rejects unauthenticated requests to /api/events", async () => {
      const sse = createSseEndpoint(createSseDeps());
      const res = await sse.request("/api/events");
      expect(res.status).toBe(401);
    });

    it("rejects unauthenticated requests to /api/chat/stream", async () => {
      const sse = createSseEndpoint(createSseDeps());
      const res = await sse.request("/api/chat/stream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "hello" }),
      });
      expect(res.status).toBe(401);
    });

    it("rejects a valid token supplied through the event-stream query string", async () => {
      const deps = createSseDeps();
      const sse = createSseEndpoint(deps);
      const res = await sse.request(
        "/api/events?token=sse-token-123-padded-to-meet-32-chars",
      );

      expect(res.status).toBe(401);
      expect(deps.rpcAdapterDeps.executeAgent).not.toHaveBeenCalled();
    });

    it("rejects a valid token supplied through the chat-stream query string", async () => {
      const deps = createSseDeps();
      const sse = createSseEndpoint(deps);
      const res = await sse.request(
        "/api/chat/stream?token=sse-token-123-padded-to-meet-32-chars",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message: "hello" }),
        },
      );

      expect(res.status).toBe(401);
      expect(deps.rpcAdapterDeps.executeAgent).not.toHaveBeenCalled();
    });

    it("rejects query-token credentials even when a valid bearer header is also present", async () => {
      const deps = createSseDeps();
      const sse = createSseEndpoint(deps);
      const res = await sse.request(
        "/api/events?token=sse-token-123-padded-to-meet-32-chars",
        { headers: authHeaders() },
      );

      expect(res.status).toBe(401);
      expect(deps.rpcAdapterDeps.executeAgent).not.toHaveBeenCalled();
    });

    it("accepts bearer token for /api/events", async () => {
      const sse = createSseEndpoint(createSseDeps());
      const res = await sse.request("/api/events", { headers: authHeaders() });
      // SSE returns 200 with text/event-stream
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/event-stream");
    });
  });

  describe("scope enforcement", () => {
    // Security regression: the SSE middleware only verified the token, never
    // its scope — unlike REST (`rpc`) and the
    // MCP endpoint (`mcp-client`). A sole-scope `mcp-client` token (the most
    // contained external credential) was therefore accepted on the
    // cross-session event firehose (/api/events) and could drive agent turns
    // (/api/chat/stream), bypassing the MCP session-allowlist + rate limits.
    function mcpClientDeps(): SseEndpointDeps {
      return createSseDeps({
        tokenStore: createTokenStore([
          { id: "mcp-only", secret: "mcp-client-token-padded-to-meet-32ch", scopes: ["mcp-client"] },
        ]),
      });
    }
    const mcpHeaders: HeadersInit = { Authorization: "Bearer mcp-client-token-padded-to-meet-32ch" };

    it("rejects an mcp-client scoped token on /api/events with 403", async () => {
      const sse = createSseEndpoint(mcpClientDeps());
      const res = await sse.request("/api/events", { headers: mcpHeaders });
      expect(res.status).toBe(403);
    });

    it("rejects an mcp-client scoped token on /api/chat/stream with 403", async () => {
      const deps = mcpClientDeps();
      const sse = createSseEndpoint(deps);
      const res = await sse.request("/api/chat/stream", {
        method: "POST",
        headers: { ...mcpHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({ message: "hello" }),
      });
      expect(res.status).toBe(403);
      // The agent must never run for an out-of-scope token.
      expect(deps.rpcAdapterDeps.executeAgent).not.toHaveBeenCalled();
    });

    it("still accepts an rpc-scoped token on /api/events", async () => {
      const sse = createSseEndpoint(createSseDeps());
      const res = await sse.request("/api/events", { headers: authHeaders() });
      expect(res.status).toBe(200);
    });
  });

  describe("GET /api/events", () => {
    it("returns text/event-stream content type", async () => {
      const sse = createSseEndpoint(createSseDeps());
      const res = await sse.request("/api/events", { headers: authHeaders() });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/event-stream");
    });

    it("includes graph execution events in the SSE whitelist (smoke)", async () => {
      // Verify the endpoint compiles with graph events in the whitelist.
      // The actual forwarding is validated by the eventBus subscription loop
      // which iterates SSE_EVENTS -- if the names are wrong, TypeScript
      // catches them as invalid EventMap keys at compile time.
      const sse = createSseEndpoint(createSseDeps());
      const res = await sse.request("/api/events", { headers: authHeaders() });
      expect(res.status).toBe(200);
    });

    it("projects event payloads before streaming them to authenticated clients", async () => {
      const deps = createSseDeps();
      const sse = createSseEndpoint(deps);
      const res = await sse.request("/api/events", { headers: authHeaders() });
      const reader = res.body?.getReader();
      expect(reader).toBeDefined();

      const decoder = new TextDecoder();
      let received = "";
      const first = await reader!.read();
      received += decoder.decode(first.value, { stream: true });
      await new Promise<void>((resolve) => setTimeout(resolve, 0));

      deps.eventBus.emit("message:received", {
        message: {
          id: "message-1",
          channelType: "telegram",
          channelId: "chat-1",
          senderId: "user-1",
          text: "private inbound body",
          attachments: [{ name: "private.pdf" }],
          metadata: { token: "credential" },
          timestamp: 42,
        },
        sessionKey: { userId: "user-1", channelId: "chat-1", peerId: "peer-1" },
      } as never);

      while (!received.includes("message-1")) {
        const chunk = await reader!.read();
        if (chunk.done) break;
        received += decoder.decode(chunk.value, { stream: true });
      }
      await reader!.cancel();

      expect(received).toContain("message-1");
      expect(received).not.toContain("private inbound body");
      expect(received).not.toContain("private.pdf");
      expect(received).not.toContain("credential");
    });
  });

  describe("POST /api/chat/stream", () => {
    it("never executes a message supplied through a GET query string", async () => {
      const deps = createSseDeps();
      const sse = createSseEndpoint(deps);
      const res = await sse.request("/api/chat/stream?message=private-prompt", {
        headers: authHeaders(),
      });

      expect(res.status).toBe(404);
      expect(deps.rpcAdapterDeps.executeAgent).not.toHaveBeenCalled();
    });

    it("rejects query parameters on POST before reading or executing the body", async () => {
      const deps = createSseDeps();
      const sse = createSseEndpoint(deps);
      const res = await sse.request("/api/chat/stream?message=private-prompt", {
        method: "POST",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ message: "safe-body" }),
      });

      expect(res.status).toBe(400);
      expect(deps.rpcAdapterDeps.executeAgent).not.toHaveBeenCalled();
    });

    it("returns 400 when the JSON body omits message", async () => {
      const sse = createSseEndpoint(createSseDeps());
      const res = await sse.request("/api/chat/stream", {
        method: "POST",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toMatch(/message/);
    });

    it("returns 415 unless the request body is application/json", async () => {
      const deps = createSseDeps();
      const sse = createSseEndpoint(deps);
      const res = await sse.request("/api/chat/stream", {
        method: "POST",
        headers: authHeaders(),
        body: "private-prompt",
      });

      expect(res.status).toBe(415);
      expect(deps.rpcAdapterDeps.executeAgent).not.toHaveBeenCalled();
    });

    it("rejects media types that merely contain the application/json text", async () => {
      const deps = createSseDeps();
      const sse = createSseEndpoint(deps);
      const res = await sse.request("/api/chat/stream", {
        method: "POST",
        headers: { ...authHeaders(), "Content-Type": "application/jsonp" },
        body: JSON.stringify({ message: "private-prompt" }),
      });

      expect(res.status).toBe(415);
      expect(deps.rpcAdapterDeps.executeAgent).not.toHaveBeenCalled();
    });

    it("returns 413 before parsing a body larger than the configured limit", async () => {
      const deps = createSseDeps({ bodyLimitBytes: 128 });
      const sse = createSseEndpoint(deps);
      const body = JSON.stringify({ message: "x".repeat(512) });
      const res = await sse.request("/api/chat/stream", {
        method: "POST",
        headers: {
          ...authHeaders(),
          "Content-Type": "application/json",
          "Content-Length": String(Buffer.byteLength(body)),
        },
        body,
      });

      expect(res.status).toBe(413);
      expect(deps.rpcAdapterDeps.executeAgent).not.toHaveBeenCalled();
    });

    it("returns 413 for an oversized streamed body without a content-length header", async () => {
      const deps = createSseDeps({ bodyLimitBytes: 128 });
      const sse = createSseEndpoint(deps);
      const res = await sse.request("/api/chat/stream", {
        method: "POST",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ message: "x".repeat(512) }),
      });

      expect(res.status).toBe(413);
      expect(deps.rpcAdapterDeps.executeAgent).not.toHaveBeenCalled();
    });

    it("counts actual bytes and rejects an oversized body with a misleading content-length", async () => {
      const deps = createSseDeps({ bodyLimitBytes: 128 });
      const sse = createSseEndpoint(deps);
      const body = JSON.stringify({ message: "x".repeat(512) });
      const res = await sse.request("/api/chat/stream", {
        method: "POST",
        headers: {
          ...authHeaders(),
          "Content-Type": "application/json",
          "Content-Length": "1",
        },
        body,
      });

      expect(res.status).toBe(413);
      expect(deps.rpcAdapterDeps.executeAgent).not.toHaveBeenCalled();
    });

    it("cancels an oversized request stream before returning 413", async () => {
      const deps = createSseDeps({ bodyLimitBytes: 128 });
      const sse = createSseEndpoint(deps);
      const cancel = vi.fn();
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(JSON.stringify({ message: "x".repeat(512) })));
        },
        cancel() {
          cancel();
        },
      });
      const request = new Request("http://localhost/api/chat/stream", {
        method: "POST",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: stream,
        duplex: "half",
      } as RequestInit & { duplex: "half" });

      const res = await sse.request(request);

      expect(res.status).toBe(413);
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(deps.rpcAdapterDeps.executeAgent).not.toHaveBeenCalled();
    });

    it("returns text/event-stream for valid chat stream request", async () => {
      const sse = createSseEndpoint(createSseDeps());
      const res = await sse.request("/api/chat/stream", {
        method: "POST",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ message: "hello" }),
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/event-stream");
    });

    it("calls executeAgent with the message", async () => {
      const deps = createSseDeps();
      const sse = createSseEndpoint(deps);

      const res = await sse.request("/api/chat/stream", {
        method: "POST",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ message: "hello", agentId: "bot-1" }),
      });

      // Read the response body to trigger execution
      const text = await res.text();
      expect(text).toContain("done");
      expect(deps.rpcAdapterDeps.executeAgent).toHaveBeenCalledWith({
        message: "hello",
        agentId: "bot-1",
        clientId: "test-client",
        scopes: ["rpc", "admin"],
        onDelta: expect.any(Function),
      });
    });

    it("sends generic error event when agent execution fails", async () => {
      const deps = createSseDeps({
        rpcAdapterDeps: createMockRpcDeps({
          executeAgent: vi.fn().mockRejectedValue(new Error("Budget exceeded: /secret/path/db.sqlite")),
        }),
      });
      const sse = createSseEndpoint(deps);

      const res = await sse.request("/api/chat/stream", {
        method: "POST",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ message: "hello" }),
      });

      const text = await res.text();
      expect(text).toContain("error");
      expect(text).toContain("Internal error");
      // Must NOT leak raw error details
      expect(text).not.toContain("Budget exceeded");
      expect(text).not.toContain("/secret/path");
    });

  });

  describe("Last-Event-ID reconnection", () => {
    it("accepts request with Last-Event-ID header (starts from latest events)", async () => {
      // The SSE endpoint does not currently handle Last-Event-ID for replay.
      // It always starts a fresh stream from the current point. This test
      // documents the current behavior: the header is accepted without
      // error, and the stream begins from the latest events.
      const sse = createSseEndpoint(createSseDeps());
      const res = await sse.request("/api/events", {
        headers: {
          ...authHeaders(),
          "Last-Event-ID": "42",
        },
      });
      // The endpoint still returns 200 with text/event-stream
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/event-stream");
    });

    it("chat stream accepts Last-Event-ID header gracefully", async () => {
      const sse = createSseEndpoint(createSseDeps());
      const res = await sse.request("/api/chat/stream", {
        method: "POST",
        headers: {
          ...authHeaders(),
          "Last-Event-ID": "5",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ message: "hello" }),
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/event-stream");

      // Verify done event is still emitted (stream works normally)
      const text = await res.text();
      expect(text).toContain("done");
    });
  });
});
