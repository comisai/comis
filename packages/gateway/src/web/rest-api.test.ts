// SPDX-License-Identifier: Apache-2.0
import { TypedEventBus } from "@comis/core";
import { describe, it, expect, vi } from "vitest";
import type { RpcAdapterDeps } from "../rpc/rpc-adapters.js";
import { createTokenStore, type TokenStore } from "../auth/token-auth.js";
import {
  createRestApi,
  ActivityRingBuffer,
  subscribeActivityBuffer,
  type RestApiDeps,
} from "./rest-api.js";

/** Create mock RPC adapter deps */
function createMockRpcDeps(overrides?: Partial<RpcAdapterDeps>): RpcAdapterDeps {
  return {
    executeAgent: vi.fn().mockResolvedValue({
      response: "Hello from agent",
      tokensUsed: 42,
      finishReason: "stop",
    }),
    searchMemory: vi.fn().mockResolvedValue({
      results: [{ id: "mem-1", content: "test content", score: 0.95 }],
    }),
    inspectMemory: vi.fn().mockResolvedValue({
      stats: { totalEntries: 10, totalSessions: 2 },
    }),
    getSessionHistory: vi.fn().mockResolvedValue({ messages: [] }),
    getConfig: vi.fn().mockResolvedValue({
      agents: [{ id: "default", provider: "anthropic" }],
    }),
    listAgentSummaries: vi.fn().mockReturnValue([
      { id: "default", name: "Comis", provider: "anthropic", model: "claude-sonnet-4-6" },
    ]),
    listChannelSummaries: vi.fn().mockReturnValue([
      { name: "telegram", enabled: true },
      { name: "discord", enabled: false },
    ]),
    setConfig: vi.fn().mockResolvedValue({ ok: true }),
    logger: { info: vi.fn(), error: vi.fn() },
    ...overrides,
  };
}

/** Create a token store with a test token */
function createTestTokenStore(): TokenStore {
  return createTokenStore([
    { id: "test-client", secret: "test-token-123-padded-to-meet-32-chars", scopes: ["rpc", "admin"] },
  ]);
}

/** Create REST API deps */
function createApiDeps(overrides?: Partial<RestApiDeps>): RestApiDeps {
  return {
    rpcAdapterDeps: createMockRpcDeps(),
    tokenStore: createTestTokenStore(),
    activityBuffer: new ActivityRingBuffer(100),
    corsOrigins: ["*"],
    ...overrides,
  };
}

/** Helper to make authenticated requests */
function authHeaders(): HeadersInit {
  return { Authorization: "Bearer test-token-123-padded-to-meet-32-chars" };
}

describe("createRestApi", () => {
  it("returns a Hono instance", () => {
    const api = createRestApi(createApiDeps());
    expect(api).toBeDefined();
    expect(typeof api.fetch).toBe("function");
  });

  describe("GET /health", () => {
    it("returns 200 with status ok without auth", async () => {
      const api = createRestApi(createApiDeps());
      const res = await api.request("/health");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe("ok");
      expect(body.timestamp).toBeDefined();
    });
  });

  describe("CORS", () => {
    it("does not add Access-Control-Allow-Origin header when corsOrigins is empty", async () => {
      const api = createRestApi(createApiDeps({ corsOrigins: [] }));
      const res = await api.request("/health");
      expect(res.status).toBe(200);
      expect(res.headers.get("access-control-allow-origin")).toBeNull();
    });

    it("adds CORS headers when corsOrigins is non-empty", async () => {
      const api = createRestApi(createApiDeps({ corsOrigins: ["http://localhost:3000"] }));
      const res = await api.request("/health", {
        headers: { Origin: "http://localhost:3000" },
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("access-control-allow-origin")).toBe("http://localhost:3000");
    });

    it("sets Access-Control-Max-Age header on preflight", async () => {
      const api = createRestApi(createApiDeps({ corsOrigins: ["http://localhost:3000"] }));
      const res = await api.request("/health", {
        method: "OPTIONS",
        headers: {
          Origin: "http://localhost:3000",
          "Access-Control-Request-Method": "POST",
        },
      });
      // Hono cors() responds to preflight OPTIONS with 204
      expect(res.status).toBeLessThan(300);
      expect(res.headers.get("access-control-max-age")).toBe("3600");
    });

    it("includes Authorization in Access-Control-Allow-Headers on preflight", async () => {
      const api = createRestApi(createApiDeps({ corsOrigins: ["http://localhost:3000"] }));
      const res = await api.request("/chat", {
        method: "OPTIONS",
        headers: {
          Origin: "http://localhost:3000",
          "Access-Control-Request-Method": "POST",
          "Access-Control-Request-Headers": "Authorization, Content-Type",
        },
      });
      expect(res.status).toBeLessThan(300);
      const allowHeaders = res.headers.get("access-control-allow-headers")?.toLowerCase() ?? "";
      expect(allowHeaders).toContain("authorization");
      expect(allowHeaders).toContain("content-type");
    });
  });

  describe("authentication", () => {
    it("returns 401 for unauthenticated requests", async () => {
      const api = createRestApi(createApiDeps());
      const res = await api.request("/agents");
      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.error).toBe("Unauthorized");
    });

    it("accepts bearer token in Authorization header", async () => {
      const api = createRestApi(createApiDeps());
      const res = await api.request("/agents", { headers: authHeaders() });
      expect(res.status).toBe(200);
    });

    it("rejects token in query parameter (header-only auth)", async () => {
      const api = createRestApi(createApiDeps());
      const res = await api.request("/agents?token=test-token-123-padded-to-meet-32-chars");
      expect(res.status).toBe(401);
    });

    it("rejects invalid token", async () => {
      const api = createRestApi(createApiDeps());
      const res = await api.request("/agents", {
        headers: { Authorization: "Bearer wrong-token" },
      });
      expect(res.status).toBe(401);
    });
  });

  describe("GET /agents", () => {
    it("returns non-secret agent summaries via listAgentSummaries", async () => {
      const deps = createApiDeps();
      const api = createRestApi(deps);

      const res = await api.request("/agents", { headers: authHeaders() });
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.agents).toEqual([
        { id: "default", name: "Comis", provider: "anthropic", model: "claude-sonnet-4-6", status: "active" },
      ]);
      // /agents MUST source from the dedicated non-secret projection,
      // NOT getConfig (which no longer egresses the agents section).
      expect(deps.rpcAdapterDeps.listAgentSummaries).toHaveBeenCalled();
      expect(deps.rpcAdapterDeps.getConfig).not.toHaveBeenCalledWith({ section: "agents" });
    });

    it("reports suspended status for suspended agents", async () => {
      const deps = createApiDeps({ suspendedAgents: new Set(["default"]) });
      const api = createRestApi(deps);

      const res = await api.request("/agents", { headers: authHeaders() });
      const body = await res.json();
      expect(body.agents[0].status).toBe("suspended");
    });

    it("returns 500 with generic error on adapter error", async () => {
      const deps = createApiDeps({
        rpcAdapterDeps: createMockRpcDeps({
          listAgentSummaries: vi.fn(() => {
            throw new Error("Config unavailable");
          }),
        }),
      });
      const api = createRestApi(deps);

      const res = await api.request("/agents", { headers: authHeaders() });
      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.error).toBe("Internal error");
      // Must NOT contain the raw error message
      expect(JSON.stringify(body)).not.toContain("Config unavailable");
    });
  });

  describe("GET /channels", () => {
    it("returns only enabled channels via listChannelSummaries", async () => {
      const deps = createApiDeps();
      const api = createRestApi(deps);

      const res = await api.request("/channels", { headers: authHeaders() });
      expect(res.status).toBe(200);

      const body = await res.json();
      // Only enabled channels surface (the mock's discord is disabled).
      expect(body.channels).toEqual([
        { type: "telegram", name: "telegram", enabled: true, status: "connected" },
      ]);
      // /channels MUST source from the dedicated non-secret projection,
      // NOT getConfig (which no longer egresses the channels section).
      expect(deps.rpcAdapterDeps.listChannelSummaries).toHaveBeenCalled();
      expect(deps.rpcAdapterDeps.getConfig).not.toHaveBeenCalledWith({ section: "channels" });
    });

    it("returns 500 with generic error on adapter error", async () => {
      const deps = createApiDeps({
        rpcAdapterDeps: createMockRpcDeps({
          listChannelSummaries: vi.fn(() => {
            throw new Error("Channels unavailable");
          }),
        }),
      });
      const api = createRestApi(deps);

      const res = await api.request("/channels", { headers: authHeaders() });
      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.error).toBe("Internal error");
      expect(JSON.stringify(body)).not.toContain("Channels unavailable");
    });
  });

  describe("GET /activity", () => {
    it("returns recent activity entries", async () => {
      const buffer = new ActivityRingBuffer(100);
      buffer.push("message:received", { channelId: "tg" });
      buffer.push("session:created", { sessionKey: "s1" });

      const deps = createApiDeps({ activityBuffer: buffer });
      const api = createRestApi(deps);

      const res = await api.request("/activity", { headers: authHeaders() });
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.entries).toHaveLength(2);
      expect(body.count).toBe(2);
      expect(body.entries[0].event).toBe("message:received");
    });

    it("respects limit query parameter", async () => {
      const buffer = new ActivityRingBuffer(100);
      for (let i = 0; i < 10; i++) {
        buffer.push("test:event", { i });
      }

      const deps = createApiDeps({ activityBuffer: buffer });
      const api = createRestApi(deps);

      const res = await api.request("/activity?limit=3", { headers: authHeaders() });
      const body = await res.json();
      expect(body.entries).toHaveLength(3);
    });

    it("clamps limit to valid range", async () => {
      const buffer = new ActivityRingBuffer(100);
      const deps = createApiDeps({ activityBuffer: buffer });
      const api = createRestApi(deps);

      // Negative limit should be clamped to 1
      const res = await api.request("/activity?limit=-5", { headers: authHeaders() });
      expect(res.status).toBe(200);
    });

    it("never returns retained message bodies or attachment metadata", async () => {
      const buffer = new ActivityRingBuffer(100);
      buffer.push("message:received", {
        message: {
          id: "message-1",
          channelType: "telegram",
          channelId: "chat-1",
          senderId: "user-1",
          text: "private inbound body",
          attachments: [{ name: "private.pdf", metadata: { secret: "private" } }],
          metadata: { token: "credential" },
          timestamp: 42,
        },
      });

      const api = createRestApi(createApiDeps({ activityBuffer: buffer }));
      const res = await api.request("/activity", { headers: authHeaders() });
      const serialized = JSON.stringify(await res.json());

      expect(serialized).toContain("message-1");
      expect(serialized).not.toContain("private inbound body");
      expect(serialized).not.toContain("private.pdf");
      expect(serialized).not.toContain("credential");
    });
  });

  describe("GET /memory/search", () => {
    it("searches memory with query parameter", async () => {
      const deps = createApiDeps();
      const api = createRestApi(deps);

      const res = await api.request("/memory/search?q=dentist", { headers: authHeaders() });
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.results).toHaveLength(1);
      expect(deps.rpcAdapterDeps.searchMemory).toHaveBeenCalledWith({
        query: "dentist",
        limit: 10,
      });
    });

    it("accepts limit parameter", async () => {
      const deps = createApiDeps();
      const api = createRestApi(deps);

      const res = await api.request("/memory/search?q=test&limit=5", {
        headers: authHeaders(),
      });
      expect(res.status).toBe(200);
      expect(deps.rpcAdapterDeps.searchMemory).toHaveBeenCalledWith({
        query: "test",
        limit: 5,
      });
    });

    it("returns 400 when query is missing", async () => {
      const api = createRestApi(createApiDeps());

      const res = await api.request("/memory/search", { headers: authHeaders() });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toMatch(/Missing.*q/);
    });
  });

  describe("GET /memory/stats", () => {
    it("returns memory statistics", async () => {
      const deps = createApiDeps();
      const api = createRestApi(deps);

      const res = await api.request("/memory/stats", { headers: authHeaders() });
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.stats).toBeDefined();
      expect(deps.rpcAdapterDeps.inspectMemory).toHaveBeenCalledWith({});
    });
  });

  describe("GET /chat/history", () => {
    it("binds history reads to the authenticated gateway client", async () => {
      const getSessionHistory = vi.fn().mockResolvedValue({ messages: [] });
      const rpcAdapterDeps = createMockRpcDeps({ getSessionHistory });
      const api = createRestApi(createApiDeps({ rpcAdapterDeps }));

      const res = await api.request("/chat/history?channelId=shared&peerId=thread-a", {
        headers: authHeaders(),
      });

      expect(res.status).toBe(200);
      expect(getSessionHistory).toHaveBeenCalledWith({
        channelId: "shared",
        peerId: "thread-a",
        clientId: "test-client",
      });
    });
  });

  describe("POST /chat", () => {
    it("executes agent with message", async () => {
      const deps = createApiDeps();
      const api = createRestApi(deps);

      const res = await api.request("/chat", {
        method: "POST",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ message: "Hello agent" }),
      });
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.response).toBe("Hello from agent");
      expect(deps.rpcAdapterDeps.executeAgent).toHaveBeenCalledWith({
        message: "Hello agent",
        agentId: undefined,
        sessionKey: undefined,
        clientId: "test-client",
        scopes: ["rpc", "admin"],
      });
    });

    it("passes agentId when provided", async () => {
      const deps = createApiDeps();
      const api = createRestApi(deps);

      const res = await api.request("/chat", {
        method: "POST",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ message: "Hi", agentId: "agent-2" }),
      });
      expect(res.status).toBe(200);
      expect(deps.rpcAdapterDeps.executeAgent).toHaveBeenCalledWith({
        message: "Hi",
        agentId: "agent-2",
        sessionKey: undefined,
        clientId: "test-client",
        scopes: ["rpc", "admin"],
      });
    });

    it("returns 400 for missing message", async () => {
      const api = createRestApi(createApiDeps());

      const res = await api.request("/chat", {
        method: "POST",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toMatch(/message/);
    });

    it("returns 400 for invalid JSON", async () => {
      const api = createRestApi(createApiDeps());

      const res = await api.request("/chat", {
        method: "POST",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: "not-json",
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toMatch(/Invalid JSON/);
    });

    it("returns 413 when body exceeds configured size limit", async () => {
      // Configure a very small body limit (256 bytes)
      const deps = createApiDeps({ bodyLimitBytes: 256 });
      const api = createRestApi(deps);

      // Create a body larger than 256 bytes.
      // Explicitly set Content-Length since Node.js Request constructor
      // does not set it automatically for string bodies.
      const largeMessage = "x".repeat(512);
      const jsonBody = JSON.stringify({ message: largeMessage });
      const res = await api.request("/chat", {
        method: "POST",
        headers: {
          ...authHeaders(),
          "Content-Type": "application/json",
          "Content-Length": String(Buffer.byteLength(jsonBody)),
        },
        body: jsonBody,
      });
      expect(res.status).toBe(413);
      const body = await res.json();
      expect(body.error).toMatch(/too large/i);
    });

    it("accepts body within configured size limit", async () => {
      const deps = createApiDeps({ bodyLimitBytes: 1_048_576 });
      const api = createRestApi(deps);

      const res = await api.request("/chat", {
        method: "POST",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ message: "small message" }),
      });
      expect(res.status).toBe(200);
    });

    it("returns 500 with generic error on agent execution error", async () => {
      const deps = createApiDeps({
        rpcAdapterDeps: createMockRpcDeps({
          executeAgent: vi.fn().mockRejectedValue(new Error("Budget exceeded")),
        }),
      });
      const api = createRestApi(deps);

      const res = await api.request("/chat", {
        method: "POST",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ message: "test" }),
      });
      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.error).toBe("Internal error");
      // Must NOT leak the raw error message
      expect(JSON.stringify(body)).not.toContain("Budget exceeded");
    });

    it("does not leak filesystem paths or internal details in error response", async () => {
      const deps = createApiDeps({
        rpcAdapterDeps: createMockRpcDeps({
          executeAgent: vi.fn().mockRejectedValue(
            new Error("ENOENT: no such file or directory, open '/secret/path/db.sqlite'"),
          ),
        }),
      });
      const api = createRestApi(deps);

      const res = await api.request("/chat", {
        method: "POST",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ message: "test" }),
      });
      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.error).toBe("Internal error");
      expect(JSON.stringify(body)).not.toContain("ENOENT");
      expect(JSON.stringify(body)).not.toContain("/secret/path");
      expect(JSON.stringify(body)).not.toContain("db.sqlite");
    });
  });
});

describe("ActivityRingBuffer", () => {
  it("stores and retrieves content-free entries", () => {
    const buffer = new ActivityRingBuffer(10);
    buffer.push("scheduler:job_started", { jobId: "job-1", status: "running" });
    buffer.push("scheduler:job_started", { jobId: "job-2", status: "running" });

    const entries = buffer.getRecent(10);
    expect(entries).toHaveLength(2);
    expect(entries[0].payload).toEqual({ jobId: "job-1", status: "running" });
    expect(entries[1].payload).toEqual({ jobId: "job-2", status: "running" });
  });

  it("assigns incrementing IDs", () => {
    const buffer = new ActivityRingBuffer(10);
    buffer.push("a", {});
    buffer.push("b", {});

    const entries = buffer.getRecent(10);
    expect(entries[0].id).toBe(1);
    expect(entries[1].id).toBe(2);
  });

  it("drops oldest entries when exceeding maxSize", () => {
    const buffer = new ActivityRingBuffer(3);
    buffer.push("a", { n: 1 });
    buffer.push("b", { n: 2 });
    buffer.push("c", { n: 3 });
    buffer.push("d", { n: 4 });

    expect(buffer.size).toBe(3);
    const entries = buffer.getRecent(10);
    expect(entries[0].event).toBe("b");
    expect(entries[2].event).toBe("d");
  });

  it("respects limit in getRecent", () => {
    const buffer = new ActivityRingBuffer(10);
    for (let i = 0; i < 5; i++) {
      buffer.push("scheduler:job_started", { attempt: i });
    }

    const entries = buffer.getRecent(2);
    expect(entries).toHaveLength(2);
    expect((entries[0].payload as { attempt: number }).attempt).toBe(3);
    expect((entries[1].payload as { attempt: number }).attempt).toBe(4);
  });

  it("clears all entries from the ActivityRingBuffer when clear() is invoked", () => {
    const buffer = new ActivityRingBuffer(10);
    buffer.push("a", {});
    buffer.push("b", {});

    buffer.clear();
    expect(buffer.size).toBe(0);
    expect(buffer.getRecent(10)).toHaveLength(0);
  });

  it("includes timestamps on entries", () => {
    const buffer = new ActivityRingBuffer(10);
    const before = Date.now();
    buffer.push("test", {});
    const after = Date.now();

    const entries = buffer.getRecent(1);
    expect(entries[0].timestamp).toBeGreaterThanOrEqual(before);
    expect(entries[0].timestamp).toBeLessThanOrEqual(after);
  });
});

describe("subscribeActivityBuffer", () => {
  it("captures events into the buffer", () => {
    const eventBus = new TypedEventBus();
    const buffer = new ActivityRingBuffer(100);

    const unsubscribe = subscribeActivityBuffer(eventBus, buffer);

    eventBus.emit("session:created", {
      sessionKey: { userId: "u1", channelId: "tg", peerId: "p1" },
      timestamp: Date.now(),
    });

    expect(buffer.size).toBe(1);
    const entries = buffer.getRecent(1);
    expect(entries[0].event).toBe("session:created");

    unsubscribe();
  });

  it("unsubscribes cleanly", () => {
    const eventBus = new TypedEventBus();
    const buffer = new ActivityRingBuffer(100);

    const unsubscribe = subscribeActivityBuffer(eventBus, buffer);
    unsubscribe();

    eventBus.emit("session:created", {
      sessionKey: { userId: "u1", channelId: "tg", peerId: "p1" },
      timestamp: Date.now(),
    });

    expect(buffer.size).toBe(0);
  });
});
