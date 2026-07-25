// SPDX-License-Identifier: Apache-2.0
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

// -- Tests --

const BASE_URL = "http://localhost:3000";
const TOKEN = "test-bearer-token";

describe("createApiClient", () => {
  let client: ApiClient;

  beforeEach(() => {
    mockFetch.mockReset();
    client = createApiClient(BASE_URL, TOKEN);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    // Re-stub after restoreAllMocks since we need it for subsequent tests
    vi.stubGlobal("fetch", mockFetch);
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
    const AUTH = { tenantId: "acme", agentId: "aria" };

    it("URL-encodes query parameter", async () => {
      mockFetch.mockReturnValueOnce(mockJsonResponse({ results: [] }));
      await client.searchMemory("hello world & more", AUTH);

      const callUrl = mockFetch.mock.calls[0][0];
      expect(callUrl).toContain("q=hello%20world%20%26%20more");
    });

    it("passes limit and the explicit tenant/agent scope", async () => {
      mockFetch.mockReturnValueOnce(mockJsonResponse({ results: [] }));
      await client.searchMemory("test", AUTH, 5);

      const callUrl = mockFetch.mock.calls[0][0];
      expect(callUrl).toBe(`${BASE_URL}/api/memory/search?q=test&limit=5&tenant=acme&agent=aria`);
    });

    it("returns results array from response", async () => {
      const results = [{ id: "m1", content: "test", memoryType: "fact", trustLevel: "high", score: 0.9, createdAt: 123 }];
      mockFetch.mockReturnValueOnce(mockJsonResponse({ results }));

      const result = await client.searchMemory("test", AUTH);
      expect(result).toEqual(results);
    });

    it("defaults to empty array when results missing", async () => {
      mockFetch.mockReturnValueOnce(mockJsonResponse({}));

      const result = await client.searchMemory("test", AUTH);
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

  describe("getMemoryStats()", () => {
    it("fetches memory stats from /api/memory/stats with the explicit tenant/agent scope", async () => {
      const stats = { totalEntries: 100, byType: { fact: 50 } };
      mockFetch.mockReturnValueOnce(mockJsonResponse(stats));

      const result = await client.getMemoryStats({ tenantId: "acme", agentId: "aria" });
      expect(result).toEqual(stats);
      expect(mockFetch.mock.calls[0][0]).toBe(`${BASE_URL}/api/memory/stats?tenant=acme&agent=aria`);
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

  describe("listSessions response mapping", () => {
    const EXPECTED_KEYS = [
      "agentId",
      "conversationRef",
      "createdAt",
      "kind",
      "messageCount",
      "totalTokens",
      "updatedAt",
    ];

    const CONTRACT_ITEM = {
      conversationRef: "cv-1",
      agentId: "a",
      kind: "group",
      messageCount: 2,
      totalTokens: 100,
      updatedAt: 1000,
      createdAt: 500,
    } as const;

    function makeRpcCall(): {
      rpcCall: <T>(method: string, params?: unknown) => Promise<T>;
      calls: Array<{ method: string; params: unknown }>;
    } {
      const calls: Array<{ method: string; params: unknown }> = [];
      const rpcCall = <T>(method: string, params?: unknown): Promise<T> => {
        calls.push({ method, params });
        return Promise.resolve({
          sessions: [CONTRACT_ITEM],
          total: 1,
        } as unknown as T);
      };
      return { rpcCall, calls };
    }

    it("returns items with exactly the contract fields", async () => {
      const { rpcCall } = makeRpcCall();
      const rpcClient = createApiClient(BASE_URL, TOKEN, rpcCall);

      const result = await rpcClient.listSessions({ tenantId: "tenant-a", agentId: "a" });
      expect(result).toHaveLength(1);
      const keys = Object.keys(result[0]!).sort();
      expect(keys).toEqual(EXPECTED_KEYS);
    });

    it("does NOT include invented fields (inputTokens, toolCalls, resetCount, lastActiveAt, ...)", async () => {
      const { rpcCall } = makeRpcCall();
      const rpcClient = createApiClient(BASE_URL, TOKEN, rpcCall);

      const result = await rpcClient.listSessions({ tenantId: "tenant-a", agentId: "a" });
      const item = result[0]! as unknown as Record<string, unknown>;
      expect(item).not.toHaveProperty("inputTokens");
      expect(item).not.toHaveProperty("outputTokens");
      expect(item).not.toHaveProperty("toolCalls");
      expect(item).not.toHaveProperty("compactions");
      expect(item).not.toHaveProperty("resetCount");
      expect(item).not.toHaveProperty("lastActiveAt");
      expect(item).not.toHaveProperty("channelType");
      expect(item).not.toHaveProperty("key");
    });

    it("passes through contract field values verbatim (no aliasing, no parsing)", async () => {
      const { rpcCall } = makeRpcCall();
      const rpcClient = createApiClient(BASE_URL, TOKEN, rpcCall);

      const result = await rpcClient.listSessions({ tenantId: "tenant-a", agentId: "a" });
      expect(result[0]).toEqual(CONTRACT_ITEM);
    });
  });
});
