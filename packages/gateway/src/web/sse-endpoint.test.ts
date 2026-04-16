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
      const res = await sse.request("/api/chat/stream?message=hello");
      expect(res.status).toBe(401);
    });

    it("accepts bearer token for /api/events", async () => {
      const sse = createSseEndpoint(createSseDeps());
      const res = await sse.request("/api/events", { headers: authHeaders() });
      // SSE returns 200 with text/event-stream
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/event-stream");
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
  });

  describe("GET /api/chat/stream", () => {
    it("returns 400 when message is missing", async () => {
      const sse = createSseEndpoint(createSseDeps());
      const res = await sse.request("/api/chat/stream", { headers: authHeaders() });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toMatch(/message/);
    });

    it("returns text/event-stream for valid chat stream request", async () => {
      const sse = createSseEndpoint(createSseDeps());
      const res = await sse.request("/api/chat/stream?message=hello", {
        headers: authHeaders(),
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/event-stream");
    });

    it("calls executeAgent with the message", async () => {
      const deps = createSseDeps();
      const sse = createSseEndpoint(deps);

      const res = await sse.request("/api/chat/stream?message=hello&agentId=bot-1", {
        headers: authHeaders(),
      });

      // Read the response body to trigger execution
      const text = await res.text();
      expect(text).toContain("done");
      expect(deps.rpcAdapterDeps.executeAgent).toHaveBeenCalledWith({
        message: "hello",
        agentId: "bot-1",
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

      const res = await sse.request("/api/chat/stream?message=hello", {
        headers: authHeaders(),
      });

      const text = await res.text();
      expect(text).toContain("error");
      expect(text).toContain("Internal error");
      // Must NOT leak raw error details
      expect(text).not.toContain("Budget exceeded");
      expect(text).not.toContain("/secret/path");
    });

    it("accepts token via query parameter", async () => {
      const sse = createSseEndpoint(createSseDeps());
      const res = await sse.request("/api/chat/stream?message=hello&token=sse-token-123-padded-to-meet-32-chars");
      expect(res.status).toBe(200);
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
      const res = await sse.request("/api/chat/stream?message=hello", {
        headers: {
          ...authHeaders(),
          "Last-Event-ID": "5",
        },
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/event-stream");

      // Verify done event is still emitted (stream works normally)
      const text = await res.text();
      expect(text).toContain("done");
    });
  });
});
