import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createApiClient, type ApiClient } from "./api-client.js";

// -- Mock helpers --

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

function mockJsonResponse(data: unknown, status = 200): Promise<Response> {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(data),
    text: () => Promise.resolve(JSON.stringify(data)),
  } as Response);
}

class MockEventSource {
  url: string;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  close = vi.fn();
  addEventListener = vi.fn();
  constructor(url: string) {
    this.url = url;
    MockEventSource.lastInstance = this;
  }
  static lastInstance: MockEventSource | null = null;
}
vi.stubGlobal("EventSource", MockEventSource);

// -- Tests --

const BASE_URL = "http://localhost:3000";
const TOKEN = "test-bearer-token";

describe("createApiClient", () => {
  let client: ApiClient;

  beforeEach(() => {
    mockFetch.mockReset();
    MockEventSource.lastInstance = null;
    client = createApiClient(BASE_URL, TOKEN);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    // Re-stub after restoreAllMocks since we need them for subsequent tests
    vi.stubGlobal("fetch", mockFetch);
    vi.stubGlobal("EventSource", MockEventSource);
  });

  describe("fetchJson (via public methods)", () => {
    it("adds Authorization header with bearer token", async () => {
      mockFetch.mockReturnValueOnce(mockJsonResponse({ agents: [] }));
      await client.getAgents();

      const callArgs = mockFetch.mock.calls[0];
      expect(callArgs[1].headers["Authorization"]).toBe(`Bearer ${TOKEN}`);
    });

    it("adds Content-Type: application/json header", async () => {
      mockFetch.mockReturnValueOnce(mockJsonResponse({ agents: [] }));
      await client.getAgents();

      const callArgs = mockFetch.mock.calls[0];
      expect(callArgs[1].headers["Content-Type"]).toBe("application/json");
    });

    it("throws on non-OK response with status and sanitized body text", async () => {
      mockFetch.mockReturnValueOnce(
        mockJsonResponse({ error: "not found" }, 404),
      );

      await expect(client.getAgents()).rejects.toThrow("Request failed (404)");
    });

    it("redacts API keys in error response bodies", async () => {
      mockFetch.mockReturnValueOnce(
        Promise.resolve({
          ok: false,
          status: 500,
          text: () => Promise.resolve('{"error":"Invalid key sk-abc123def456ghi789jkl012mno345pqr678"}'),
          json: () => Promise.resolve({}),
        } as Response),
      );

      try {
        await client.getAgents();
        expect.fail("Should have thrown");
      } catch (err) {
        const msg = (err as Error).message;
        expect(msg).toContain("Request failed (500)");
        expect(msg).not.toContain("sk-abc123def456ghi789jkl012mno345pqr678");
        expect(msg).toContain("[REDACTED]");
      }
    });

    it("truncates long error response bodies", async () => {
      const longBody = "x".repeat(300);
      mockFetch.mockReturnValueOnce(
        Promise.resolve({
          ok: false,
          status: 500,
          text: () => Promise.resolve(longBody),
          json: () => Promise.resolve({}),
        } as Response),
      );

      try {
        await client.getAgents();
        expect.fail("Should have thrown");
      } catch (err) {
        const msg = (err as Error).message;
        expect(msg).toContain("...");
        expect(msg.length).toBeLessThan(350);
      }
    });

    it("redacts URLs in error response bodies", async () => {
      mockFetch.mockReturnValueOnce(
        Promise.resolve({
          ok: false,
          status: 500,
          text: () => Promise.resolve('Error at https://internal.api.example.com/debug'),
          json: () => Promise.resolve({}),
        } as Response),
      );

      try {
        await client.getAgents();
        expect.fail("Should have thrown");
      } catch (err) {
        const msg = (err as Error).message;
        expect(msg).not.toContain("https://internal.api.example.com");
        expect(msg).toContain("[URL]");
      }
    });

    it("parses JSON response body", async () => {
      const data = { agents: [{ id: "a1", provider: "openai", model: "gpt-4", status: "active" }] };
      mockFetch.mockReturnValueOnce(mockJsonResponse(data));

      const result = await client.getAgents();
      expect(result).toEqual(data.agents);
    });
  });

  describe("getAgents()", () => {
    it("returns agents array when response has agents property", async () => {
      const agents = [{ id: "a1", provider: "openai", model: "gpt-4", status: "active" }];
      mockFetch.mockReturnValueOnce(mockJsonResponse({ agents }));

      const result = await client.getAgents();
      expect(result).toEqual(agents);
    });

    it("falls back to routing.agents path", async () => {
      const agents = [{ id: "a2", provider: "anthropic", model: "claude", status: "active" }];
      mockFetch.mockReturnValueOnce(mockJsonResponse({ routing: { agents } }));

      const result = await client.getAgents();
      expect(result).toEqual(agents);
    });

    it("falls back to Object.entries mapping when agents is non-array", async () => {
      // When agents property is a truthy non-array, the code falls through
      // to Object.entries(result) mapping over all top-level keys
      mockFetch.mockReturnValueOnce(
        mockJsonResponse({
          agents: { agent1: { provider: "openai", model: "gpt-4" } },
        }),
      );

      const result = await client.getAgents();
      // Object.entries maps over top-level result keys: ["agents", {...}]
      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({ id: "agents" });
    });

    it("returns empty array when no agents or routing key present", async () => {
      // No agents, no routing -> ?? fallback yields [] -> Array.isArray([]) -> returns []
      mockFetch.mockReturnValueOnce(
        mockJsonResponse({
          something: { provider: "openai", model: "gpt-4" },
        }),
      );

      const result = await client.getAgents();
      expect(result).toEqual([]);
    });

    it("returns empty array when agents is an empty array", async () => {
      mockFetch.mockReturnValueOnce(mockJsonResponse({ agents: [] }));

      const result = await client.getAgents();
      expect(result).toEqual([]);
    });
  });

  describe("getChannels()", () => {
    it("returns channels array when response has channels property", async () => {
      const channels = [
        { type: "discord", name: "main", enabled: true, status: "connected" },
      ];
      mockFetch.mockReturnValueOnce(mockJsonResponse({ channels }));

      const result = await client.getChannels();
      expect(result).toEqual(channels);
    });

    it("falls back to Object.entries normalization when channels is non-array", async () => {
      // When channels property is a truthy non-array, the code falls through
      // to Object.entries(result) mapping over all top-level keys
      mockFetch.mockReturnValueOnce(
        mockJsonResponse({
          channels: { discord: { type: "discord", enabled: true } },
        }),
      );

      const result = await client.getChannels();
      // Object.entries maps over top-level result keys: ["channels", {...}]
      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({ name: "channels" });
    });

    it("returns empty array when no channels key present", async () => {
      // No channels key -> ?? fallback yields [] -> Array.isArray([]) -> returns []
      mockFetch.mockReturnValueOnce(
        mockJsonResponse({ something: "else" }),
      );

      const result = await client.getChannels();
      expect(result).toEqual([]);
    });
  });

  describe("getActivity()", () => {
    it("passes limit as query parameter", async () => {
      mockFetch.mockReturnValueOnce(mockJsonResponse({ entries: [] }));
      await client.getActivity(25);

      const callUrl = mockFetch.mock.calls[0][0];
      expect(callUrl).toBe(`${BASE_URL}/api/activity?limit=25`);
    });

    it("defaults limit to 50", async () => {
      mockFetch.mockReturnValueOnce(mockJsonResponse({ entries: [] }));
      await client.getActivity();

      const callUrl = mockFetch.mock.calls[0][0];
      expect(callUrl).toBe(`${BASE_URL}/api/activity?limit=50`);
    });

    it("returns entries array from response", async () => {
      const entries = [{ id: 1, event: "test", payload: {}, timestamp: 123 }];
      mockFetch.mockReturnValueOnce(mockJsonResponse({ entries }));

      const result = await client.getActivity();
      expect(result).toEqual(entries);
    });

    it("defaults to empty array when entries missing", async () => {
      mockFetch.mockReturnValueOnce(mockJsonResponse({}));

      const result = await client.getActivity();
      expect(result).toEqual([]);
    });
  });

  describe("searchMemory()", () => {
    it("URL-encodes query parameter", async () => {
      mockFetch.mockReturnValueOnce(mockJsonResponse({ results: [] }));
      await client.searchMemory("hello world & more");

      const callUrl = mockFetch.mock.calls[0][0];
      expect(callUrl).toContain("q=hello%20world%20%26%20more");
    });

    it("passes limit parameter", async () => {
      mockFetch.mockReturnValueOnce(mockJsonResponse({ results: [] }));
      await client.searchMemory("test", 5);

      const callUrl = mockFetch.mock.calls[0][0];
      expect(callUrl).toBe(`${BASE_URL}/api/memory/search?q=test&limit=5`);
    });

    it("returns results array from response", async () => {
      const results = [{ id: "m1", content: "test", memoryType: "fact", trustLevel: "high", score: 0.9, createdAt: 123 }];
      mockFetch.mockReturnValueOnce(mockJsonResponse({ results }));

      const result = await client.searchMemory("test");
      expect(result).toEqual(results);
    });

    it("defaults to empty array when results missing", async () => {
      mockFetch.mockReturnValueOnce(mockJsonResponse({}));

      const result = await client.searchMemory("test");
      expect(result).toEqual([]);
    });
  });

  describe("chat()", () => {
    it("sends POST with JSON body containing message and agentId", async () => {
      mockFetch.mockReturnValueOnce(mockJsonResponse({ response: "hi", sessionId: "s1" }));
      await client.chat("hello", "agent1");

      const callArgs = mockFetch.mock.calls[0];
      expect(callArgs[0]).toBe(`${BASE_URL}/api/chat`);
      expect(callArgs[1].method).toBe("POST");
      expect(JSON.parse(callArgs[1].body)).toEqual({ message: "hello", agentId: "agent1" });
    });

    it("returns ChatResponse", async () => {
      const chatResponse = { response: "Hello back!", sessionId: "sess-123" };
      mockFetch.mockReturnValueOnce(mockJsonResponse(chatResponse));

      const result = await client.chat("hi");
      expect(result).toEqual(chatResponse);
    });
  });

  describe("health()", () => {
    it("does NOT include Authorization header (health is unauthenticated)", async () => {
      mockFetch.mockReturnValueOnce(
        Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ status: "ok", timestamp: "2026-01-01" }),
        }),
      );
      await client.health();

      const callArgs = mockFetch.mock.calls[0];
      expect(callArgs[0]).toBe(`${BASE_URL}/api/health`);
      // health() uses plain fetch (no init.headers with Authorization)
      expect(callArgs[1]).toBeUndefined();
    });

    it("returns parsed JSON response", async () => {
      const healthData = { status: "ok", timestamp: "2026-01-01T00:00:00Z" };
      mockFetch.mockReturnValueOnce(
        Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve(healthData),
        }),
      );

      const result = await client.health();
      expect(result).toEqual(healthData);
    });
  });

  describe("subscribeEvents()", () => {
    it("creates EventSource with token in URL", () => {
      const handler = vi.fn();
      client.subscribeEvents(handler);

      expect(MockEventSource.lastInstance).not.toBeNull();
      expect(MockEventSource.lastInstance!.url).toBe(
        `${BASE_URL}/api/events?token=${encodeURIComponent(TOKEN)}`,
      );
    });

    it("returns a close function", () => {
      const handler = vi.fn();
      const close = client.subscribeEvents(handler);
      expect(typeof close).toBe("function");
    });

    it("calling close function calls source.close()", () => {
      const handler = vi.fn();
      const close = client.subscribeEvents(handler);

      close();
      expect(MockEventSource.lastInstance!.close).toHaveBeenCalledTimes(1);
    });

    it("registers typed event listeners for known event types", () => {
      const handler = vi.fn();
      client.subscribeEvents(handler);

      const instance = MockEventSource.lastInstance!;
      const registeredEvents = instance.addEventListener.mock.calls.map(
        (call: unknown[]) => call[0],
      );

      expect(registeredEvents).toContain("message:received");
      expect(registeredEvents).toContain("message:sent");
      expect(registeredEvents).toContain("ping");
      expect(registeredEvents).toContain("system:error");
    });
  });

  describe("subscribeEvents handler invocation", () => {
    it("onmessage handler parses valid JSON and calls handler with parsed data", () => {
      const handler = vi.fn();
      client.subscribeEvents(handler);

      const instance = MockEventSource.lastInstance!;
      const payload = { event: "agent:response", payload: { text: "hello" } };
      instance.onmessage!({ data: JSON.stringify(payload) } as MessageEvent);

      expect(handler).toHaveBeenCalledWith("message", payload);
    });

    it("onmessage handler falls back to raw data when JSON parsing fails", () => {
      const handler = vi.fn();
      client.subscribeEvents(handler);

      const instance = MockEventSource.lastInstance!;
      instance.onmessage!({ data: "not valid json" } as MessageEvent);

      expect(handler).toHaveBeenCalledWith("message", "not valid json");
    });

    it("onerror handler calls handler with error event", () => {
      const handler = vi.fn();
      client.subscribeEvents(handler);

      const instance = MockEventSource.lastInstance!;
      instance.onerror!();

      expect(handler).toHaveBeenCalledWith("error", { message: "SSE connection error" });
    });

    it("typed event listener parses JSON and dispatches with correct event type", () => {
      const handler = vi.fn();
      client.subscribeEvents(handler);

      const instance = MockEventSource.lastInstance!;

      // Find the listener registered for "message:received"
      const messageReceivedCall = instance.addEventListener.mock.calls.find(
        (call: unknown[]) => call[0] === "message:received",
      );
      expect(messageReceivedCall).toBeDefined();

      const listener = messageReceivedCall![1] as (ev: MessageEvent) => void;
      const payload = { userId: "u1", text: "hi" };
      listener({ data: JSON.stringify(payload) } as MessageEvent);

      expect(handler).toHaveBeenCalledWith("message:received", payload);
    });

    it("typed event listener falls back to raw data on JSON parse failure", () => {
      const handler = vi.fn();
      client.subscribeEvents(handler);

      const instance = MockEventSource.lastInstance!;

      const pingCall = instance.addEventListener.mock.calls.find(
        (call: unknown[]) => call[0] === "ping",
      );
      expect(pingCall).toBeDefined();

      const listener = pingCall![1] as (ev: MessageEvent) => void;
      listener({ data: "not json" } as MessageEvent);

      expect(handler).toHaveBeenCalledWith("ping", "not json");
    });

    it("typed event listener handles empty data as empty object", () => {
      const handler = vi.fn();
      client.subscribeEvents(handler);

      const instance = MockEventSource.lastInstance!;

      const pingCall = instance.addEventListener.mock.calls.find(
        (call: unknown[]) => call[0] === "ping",
      );
      const listener = pingCall![1] as (ev: MessageEvent) => void;
      listener({ data: "" } as MessageEvent);

      expect(handler).toHaveBeenCalledWith("ping", {});
    });
  });

  describe("getMemoryStats()", () => {
    it("fetches memory stats from /api/memory/stats", async () => {
      const stats = { totalEntries: 100, byType: { fact: 50 } };
      mockFetch.mockReturnValueOnce(mockJsonResponse(stats));

      const result = await client.getMemoryStats();
      expect(result).toEqual(stats);
      expect(mockFetch.mock.calls[0][0]).toBe(`${BASE_URL}/api/memory/stats`);
    });
  });

  describe("getChatHistory()", () => {
    it("returns messages array from response", async () => {
      const messages = [{ role: "user", content: "hi", timestamp: 123 }];
      mockFetch.mockReturnValueOnce(mockJsonResponse({ messages }));

      const result = await client.getChatHistory();
      expect(result).toEqual(messages);
    });

    it("defaults to empty array when messages missing", async () => {
      mockFetch.mockReturnValueOnce(mockJsonResponse({}));

      const result = await client.getChatHistory();
      expect(result).toEqual([]);
    });
  });
});
