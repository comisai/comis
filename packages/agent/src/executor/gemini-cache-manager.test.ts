// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for GeminiCacheManager.
 *
 * Covers cache creation, hash reuse/invalidation,
 * concurrent dedup, minimum token threshold, and displayName handling.
 *
 * @module
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createGeminiCacheManager,
  computeCacheContentHash,
  GEMINI_MIN_CACHEABLE_TOKENS,
  GEMINI_DEFAULT_MIN_CACHEABLE_TOKENS,
} from "./gemini-cache-manager.js";
import type {
  CacheRequest,
  GeminiCacheManagerConfig,
} from "./gemini-cache-manager.js";

// ---------------------------------------------------------------------------
// Mock @google/genai
// ---------------------------------------------------------------------------

const mockCreate = vi.fn();
const mockUpdate = vi.fn();
const mockDelete = vi.fn();
const mockList = vi.fn();

vi.mock("@google/genai", () => {
  return {
    GoogleGenAI: class MockGoogleGenAI {
      caches = {
        create: mockCreate,
        update: mockUpdate,
        delete: mockDelete,
        list: mockList,
      };
    },
  };
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(overrides?: Partial<GeminiCacheManagerConfig>): GeminiCacheManagerConfig {
  return {
    getApiKey: () => "test-api-key",
    ttlSeconds: 3600,
    maxActiveCachesPerAgent: 20,
    refreshThreshold: 0.5,
    logger: { debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
    ...overrides,
  };
}

function makeRequest(overrides?: Partial<CacheRequest>): CacheRequest {
  return {
    sessionKey: "session-1",
    agentId: "agent-1",
    model: "gemini-2.5-flash",
    provider: "google",
    systemInstruction: "You are a helpful assistant",
    tools: [{ name: "tool1", description: "desc" }],
    toolConfig: { functionCallingConfig: { mode: "AUTO" } },
    contentHash: computeCacheContentHash(
      "You are a helpful assistant",
      [{ name: "tool1", description: "desc" }],
      { functionCallingConfig: { mode: "AUTO" } },
    ),
    estimatedTokens: 5000,
    ...overrides,
  };
}

/** Default mock response from ai.caches.create */
function defaultCreateResponse(overrides?: Record<string, unknown>) {
  return {
    name: "cachedContents/abc123",
    displayName: "comis:agent-1:session-1:abcd1234",
    model: "gemini-2.5-flash",
    createTime: "2026-04-02T20:00:00Z",
    expireTime: "2026-04-02T21:00:00Z",
    usageMetadata: { totalTokenCount: 5000 },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("computeCacheContentHash", () => {
  it("returns deterministic SHA-256 hex string", () => {
    const hash1 = computeCacheContentHash("sys", [{ a: 1 }], { mode: "AUTO" });
    const hash2 = computeCacheContentHash("sys", [{ a: 1 }], { mode: "AUTO" });
    expect(hash1).toBe(hash2);
    expect(hash1).toMatch(/^[a-f0-9]{64}$/);
  });

  it("returns different hash for different inputs", () => {
    const hash1 = computeCacheContentHash("sys1", [], {});
    const hash2 = computeCacheContentHash("sys2", [], {});
    expect(hash1).not.toBe(hash2);
  });
});

describe("GEMINI_MIN_CACHEABLE_TOKENS", () => {
  it("has correct thresholds for Flash and Pro models", () => {
    expect(GEMINI_MIN_CACHEABLE_TOKENS["gemini-2.5-flash"]).toBe(1024);
    expect(GEMINI_MIN_CACHEABLE_TOKENS["gemini-2.5-pro"]).toBe(4096);
    expect(GEMINI_MIN_CACHEABLE_TOKENS["gemini-3-flash"]).toBe(1024);
    expect(GEMINI_MIN_CACHEABLE_TOKENS["gemini-3-pro"]).toBe(4096);
  });

  it("GEMINI_DEFAULT_MIN_CACHEABLE_TOKENS is 2048", () => {
    expect(GEMINI_DEFAULT_MIN_CACHEABLE_TOKENS).toBe(2048);
  });
});

describe("createGeminiCacheManager", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCreate.mockResolvedValue(defaultCreateResponse());
    mockDelete.mockResolvedValue({});
    mockUpdate.mockResolvedValue(defaultCreateResponse());
  });

  // -----------------------------------------------------------------------
  // Create cache entry via SDK
  // -----------------------------------------------------------------------

  describe("create", () => {
    it("creates cache entry via SDK and returns CacheEntry", async () => {
      const manager = createGeminiCacheManager(makeConfig());
      const result = await manager.getOrCreate(makeRequest());

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBeDefined();
        expect(result.value!.name).toBe("cachedContents/abc123");
        expect(result.value!.model).toBe("gemini-2.5-flash");
        expect(result.value!.agentId).toBe("agent-1");
        expect(result.value!.sessionKey).toBe("session-1");
        expect(result.value!.cachedTokens).toBe(5000);
      }
    });

    it("passes systemInstruction, tools, toolConfig, displayName, ttl to SDK create", async () => {
      const manager = createGeminiCacheManager(makeConfig());
      const req = makeRequest();
      await manager.getOrCreate(req);

      expect(mockCreate).toHaveBeenCalledOnce();
      const call = mockCreate.mock.calls[0][0];
      expect(call.model).toBe("gemini-2.5-flash");
      expect(call.config.systemInstruction).toBe("You are a helpful assistant");
      expect(call.config.tools).toEqual([{ name: "tool1", description: "desc" }]);
      expect(call.config.toolConfig).toEqual({ functionCallingConfig: { mode: "AUTO" } });
      expect(call.config.ttl).toBe("3600s");
      expect(call.config.displayName).toMatch(/^comis:agent-1:session-1:/);
    });
  });

  // -----------------------------------------------------------------------
  // Hash reuse and invalidation
  // -----------------------------------------------------------------------

  describe("hash reuse", () => {
    it("reuses existing cache when contentHash matches", async () => {
      const manager = createGeminiCacheManager(makeConfig());
      const req = makeRequest();

      const result1 = await manager.getOrCreate(req);
      const result2 = await manager.getOrCreate(req);

      expect(mockCreate).toHaveBeenCalledOnce();
      expect(result1.ok).toBe(true);
      expect(result2.ok).toBe(true);
      if (result1.ok && result2.ok) {
        expect(result2.value).toBe(result1.value);
      }
    });

    it("replaces cache when contentHash changes", async () => {
      const secondResponse = defaultCreateResponse({
        name: "cachedContents/def456",
      });
      mockCreate
        .mockResolvedValueOnce(defaultCreateResponse())
        .mockResolvedValueOnce(secondResponse);

      const manager = createGeminiCacheManager(makeConfig());
      const req1 = makeRequest();
      await manager.getOrCreate(req1);

      const req2 = makeRequest({
        contentHash: computeCacheContentHash("different system", [], {}),
        systemInstruction: "different system",
      });
      const result2 = await manager.getOrCreate(req2);

      expect(mockCreate).toHaveBeenCalledTimes(2);
      expect(mockDelete).toHaveBeenCalledOnce();
      expect(mockDelete).toHaveBeenCalledWith({ name: "cachedContents/abc123" });
      expect(result2.ok).toBe(true);
      if (result2.ok) {
        expect(result2.value!.name).toBe("cachedContents/def456");
      }
    });
  });

  // -----------------------------------------------------------------------
  // Concurrent dedup
  // -----------------------------------------------------------------------

  describe("concurrent dedup", () => {
    it("deduplicates concurrent creation -- one create call", async () => {
      let resolveCreate!: (value: unknown) => void;
      mockCreate.mockImplementation(
        () => new Promise((resolve) => { resolveCreate = resolve; }),
      );

      const manager = createGeminiCacheManager(makeConfig());
      const req = makeRequest();

      const p1 = manager.getOrCreate(req);
      const p2 = manager.getOrCreate(req);

      resolveCreate(defaultCreateResponse());

      const [r1, r2] = await Promise.all([p1, p2]);

      expect(mockCreate).toHaveBeenCalledOnce();
      expect(r1.ok).toBe(true);
      expect(r2.ok).toBe(true);
      if (r1.ok && r2.ok) {
        expect(r1.value).toBe(r2.value);
      }
    });

    it("cleans up pendingCreation on error", async () => {
      mockCreate
        .mockRejectedValueOnce(new Error("API failure"))
        .mockResolvedValueOnce(defaultCreateResponse());

      const manager = createGeminiCacheManager(makeConfig());
      const req = makeRequest();

      const result1 = await manager.getOrCreate(req);
      expect(result1.ok).toBe(false);

      // Second call should work (no stale pending promise)
      const result2 = await manager.getOrCreate(req);
      expect(result2.ok).toBe(true);
      expect(mockCreate).toHaveBeenCalledTimes(2);
    });
  });

  // -----------------------------------------------------------------------
  // Minimum token enforcement
  // -----------------------------------------------------------------------

  describe("min tokens", () => {
    it("returns undefined for below-minimum tokens (flash)", async () => {
      const manager = createGeminiCacheManager(makeConfig());
      const req = makeRequest({
        model: "gemini-2.5-flash",
        estimatedTokens: 500,
      });
      const result = await manager.getOrCreate(req);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBeUndefined();
      }
      expect(mockCreate).not.toHaveBeenCalled();
    });

    it("returns undefined for below-minimum tokens (pro)", async () => {
      const manager = createGeminiCacheManager(makeConfig());
      const req = makeRequest({
        model: "gemini-2.5-pro",
        estimatedTokens: 2000,
      });
      const result = await manager.getOrCreate(req);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBeUndefined();
      }
      expect(mockCreate).not.toHaveBeenCalled();
    });

    it("allows above-minimum tokens", async () => {
      const manager = createGeminiCacheManager(makeConfig());
      const req = makeRequest({
        model: "gemini-2.5-pro",
        estimatedTokens: 5000,
      });
      const result = await manager.getOrCreate(req);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBeDefined();
      }
      expect(mockCreate).toHaveBeenCalledOnce();
    });

    it("uses default threshold for unknown model", async () => {
      const manager = createGeminiCacheManager(makeConfig());
      const req = makeRequest({
        model: "gemini-future-model",
        estimatedTokens: 1500,
      });
      const result = await manager.getOrCreate(req);

      expect(result.ok).toBe(true);
      if (result.ok) {
        // 1500 < 2048 default threshold
        expect(result.value).toBeUndefined();
      }
      expect(mockCreate).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // displayName convention
  // -----------------------------------------------------------------------

  describe("displayName", () => {
    it("displayName follows comis:{agentId}:{sessionKey}:{hashPrefix} format", async () => {
      const manager = createGeminiCacheManager(makeConfig());
      const req = makeRequest();
      await manager.getOrCreate(req);

      const call = mockCreate.mock.calls[0][0];
      const hashPrefix = req.contentHash.slice(0, 8);
      expect(call.config.displayName).toBe(
        `comis:agent-1:session-1:${hashPrefix}`,
      );
    });

    it("displayName truncated to 128 chars", async () => {
      const manager = createGeminiCacheManager(makeConfig());
      const longAgentId = "a".repeat(100);
      const longSessionKey = "s".repeat(100);
      const req = makeRequest({
        agentId: longAgentId,
        sessionKey: longSessionKey,
      });
      await manager.getOrCreate(req);

      const call = mockCreate.mock.calls[0][0];
      expect(call.config.displayName.length).toBeLessThanOrEqual(128);
    });
  });

  // -----------------------------------------------------------------------
  // API key handling
  // -----------------------------------------------------------------------

  describe("API key handling", () => {
    it("returns ok(undefined) when apiKey is undefined", async () => {
      const manager = createGeminiCacheManager(
        makeConfig({ getApiKey: () => undefined }),
      );
      const result = await manager.getOrCreate(makeRequest());

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBeUndefined();
      }
      expect(mockCreate).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // dispose / disposeAll
  // -----------------------------------------------------------------------

  describe("dispose", () => {
    it("calls SDK delete and removes from map", async () => {
      const manager = createGeminiCacheManager(makeConfig());
      await manager.getOrCreate(makeRequest());
      expect(manager.getActiveCount("agent-1")).toBe(1);

      await manager.dispose("session-1");

      expect(mockDelete).toHaveBeenCalledWith({ name: "cachedContents/abc123" });
      expect(manager.getActiveCount("agent-1")).toBe(0);
    });

    it("no-op when session has no active cache", async () => {
      const manager = createGeminiCacheManager(makeConfig());
      await manager.dispose("nonexistent-session");
      expect(mockDelete).not.toHaveBeenCalled();
    });
  });

  describe("disposeAll", () => {
    it("disposes all entries", async () => {
      mockCreate
        .mockResolvedValueOnce(defaultCreateResponse({ name: "cachedContents/a" }))
        .mockResolvedValueOnce(defaultCreateResponse({ name: "cachedContents/b" }));

      const manager = createGeminiCacheManager(makeConfig());
      await manager.getOrCreate(makeRequest({ sessionKey: "s1" }));
      await manager.getOrCreate(makeRequest({ sessionKey: "s2", contentHash: "different-hash" }));

      expect(manager.getActiveCount("agent-1")).toBe(2);

      await manager.disposeAll();

      expect(manager.getActiveCount("agent-1")).toBe(0);
      // Both entries should have been deleted
      expect(mockDelete).toHaveBeenCalledTimes(2);
    });
  });

  // -----------------------------------------------------------------------
  // getActiveCount
  // -----------------------------------------------------------------------

  describe("getActiveCount", () => {
    it("counts entries per agentId", async () => {
      mockCreate
        .mockResolvedValueOnce(defaultCreateResponse({ name: "cachedContents/a" }))
        .mockResolvedValueOnce(defaultCreateResponse({ name: "cachedContents/b" }));

      const manager = createGeminiCacheManager(makeConfig());
      await manager.getOrCreate(makeRequest({ sessionKey: "s1", agentId: "agent-1" }));
      await manager.getOrCreate(makeRequest({ sessionKey: "s2", agentId: "agent-2", contentHash: "other-hash" }));

      expect(manager.getActiveCount("agent-1")).toBe(1);
      expect(manager.getActiveCount("agent-2")).toBe(1);
      expect(manager.getActiveCount("agent-3")).toBe(0);
    });
  });

  // -----------------------------------------------------------------------
  // TTL refresh
  // -----------------------------------------------------------------------

  describe("refresh", () => {
    it("calls update when >50% TTL elapsed", async () => {
      const now = Date.now();
      const manager = createGeminiCacheManager(makeConfig({ ttlSeconds: 3600 }));

      // Create an entry -- expiresAt will be based on the mock response
      mockCreate.mockResolvedValueOnce({
        name: "cachedContents/refresh-test",
        expireTime: new Date(now + 3_600_000).toISOString(),
        usageMetadata: { totalTokenCount: 5000 },
      });
      await manager.getOrCreate(makeRequest({ sessionKey: "refresh-session" }));

      // Advance time past 50% of TTL (>1800s of 3600s = >1,800,000ms)
      vi.spyOn(Date, "now").mockReturnValue(now + 1_900_000); // ~31.7 min elapsed

      const newExpireTime = new Date(now + 1_900_000 + 3_600_000).toISOString();
      mockUpdate.mockResolvedValueOnce({ expireTime: newExpireTime });

      const result = await manager.refresh("refresh-session");
      expect(result.ok).toBe(true);
      expect(mockUpdate).toHaveBeenCalledWith({
        name: "cachedContents/refresh-test",
        config: { ttl: "3600s" },
      });

      vi.restoreAllMocks();
    });

    it("is no-op when <50% TTL elapsed", async () => {
      const now = Date.now();
      const manager = createGeminiCacheManager(makeConfig({ ttlSeconds: 3600 }));

      mockCreate.mockResolvedValueOnce({
        name: "cachedContents/refresh-noop",
        expireTime: new Date(now + 3_600_000).toISOString(),
        usageMetadata: { totalTokenCount: 5000 },
      });
      await manager.getOrCreate(makeRequest({ sessionKey: "refresh-noop-session" }));

      // Advance time to only 10 minutes (~17% of TTL)
      vi.spyOn(Date, "now").mockReturnValue(now + 600_000);

      mockUpdate.mockClear();
      const result = await manager.refresh("refresh-noop-session");
      expect(result.ok).toBe(true);
      expect(mockUpdate).not.toHaveBeenCalled();

      vi.restoreAllMocks();
    });

    it("is no-op for unknown session", async () => {
      const manager = createGeminiCacheManager(makeConfig());

      const result = await manager.refresh("nonexistent-session");
      expect(result.ok).toBe(true);
      expect(mockUpdate).not.toHaveBeenCalled();
    });

    it("updates entry.expiresAt from API response", async () => {
      const now = Date.now();
      const manager = createGeminiCacheManager(makeConfig({ ttlSeconds: 3600 }));

      mockCreate.mockResolvedValueOnce({
        name: "cachedContents/refresh-update",
        expireTime: new Date(now + 3_600_000).toISOString(),
        usageMetadata: { totalTokenCount: 5000 },
      });
      await manager.getOrCreate(makeRequest({ sessionKey: "refresh-update-session" }));

      // Advance time past 50%
      vi.spyOn(Date, "now").mockReturnValue(now + 2_000_000);

      const newExpireTime = new Date(now + 2_000_000 + 3_600_000).toISOString();
      mockUpdate.mockResolvedValueOnce({ expireTime: newExpireTime });

      await manager.refresh("refresh-update-session");

      // Verify the entry was updated by calling getOrCreate which returns the cached entry
      vi.restoreAllMocks();
      const result = await manager.getOrCreate(makeRequest({ sessionKey: "refresh-update-session" }));
      expect(result.ok).toBe(true);
      if (result.ok && result.value) {
        expect(result.value.expiresAt).toBe(new Date(newExpireTime).getTime());
      }
    });

    // -------------------------------------------------------------------
    // getOrCreate triggers refresh on cache hit
    // -------------------------------------------------------------------

    it("getOrCreate triggers refresh when elapsed > refreshThreshold * TTL", async () => {
      const now = Date.now();
      const cfg = makeConfig({ ttlSeconds: 3600, refreshThreshold: 0.5 });
      const manager = createGeminiCacheManager(cfg);

      // Create an entry -- expiresAt = now + 3600s
      mockCreate.mockResolvedValueOnce({
        name: "cachedContents/refresh-hit",
        expireTime: new Date(now + 3_600_000).toISOString(),
        usageMetadata: { totalTokenCount: 5000 },
      });
      const req = makeRequest({ sessionKey: "refresh-hit-session" });
      await manager.getOrCreate(req);

      // Advance time past 50% of TTL (>1,800,000ms)
      vi.spyOn(Date, "now").mockReturnValue(now + 2_000_000);

      const newExpireTime = new Date(now + 2_000_000 + 3_600_000).toISOString();
      mockUpdate.mockResolvedValueOnce({ expireTime: newExpireTime });

      // Second call with same hash = cache hit -- should trigger refresh
      const result = await manager.getOrCreate(req);
      expect(result.ok).toBe(true);
      expect(mockUpdate).toHaveBeenCalledWith({
        name: "cachedContents/refresh-hit",
        config: { ttl: "3600s" },
      });
      // Verify entry expiresAt was updated
      if (result.ok && result.value) {
        expect(result.value.expiresAt).toBe(new Date(newExpireTime).getTime());
      }

      vi.restoreAllMocks();
    });

    it("getOrCreate does NOT trigger refresh when elapsed <= refreshThreshold * TTL", async () => {
      const now = Date.now();
      const cfg = makeConfig({ ttlSeconds: 3600, refreshThreshold: 0.5 });
      const manager = createGeminiCacheManager(cfg);

      mockCreate.mockResolvedValueOnce({
        name: "cachedContents/no-refresh-hit",
        expireTime: new Date(now + 3_600_000).toISOString(),
        usageMetadata: { totalTokenCount: 5000 },
      });
      const req = makeRequest({ sessionKey: "no-refresh-hit-session" });
      await manager.getOrCreate(req);

      // Advance time to only 25% of TTL (900,000ms) -- should NOT trigger refresh
      vi.spyOn(Date, "now").mockReturnValue(now + 900_000);
      mockUpdate.mockClear();

      const result = await manager.getOrCreate(req);
      expect(result.ok).toBe(true);
      expect(mockUpdate).not.toHaveBeenCalled();

      vi.restoreAllMocks();
    });

    it("getOrCreate logs warning but returns cached entry on refresh failure", async () => {
      const now = Date.now();
      const cfg = makeConfig({ ttlSeconds: 3600, refreshThreshold: 0.5 });
      const manager = createGeminiCacheManager(cfg);

      mockCreate.mockResolvedValueOnce({
        name: "cachedContents/refresh-fail-hit",
        expireTime: new Date(now + 3_600_000).toISOString(),
        usageMetadata: { totalTokenCount: 5000 },
      });
      const req = makeRequest({ sessionKey: "refresh-fail-hit-session" });
      await manager.getOrCreate(req);

      // Advance time past 50%
      vi.spyOn(Date, "now").mockReturnValue(now + 2_000_000);
      mockUpdate.mockRejectedValueOnce(new Error("API refresh failed"));

      // Should return the cached entry despite refresh failure
      const result = await manager.getOrCreate(req);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBeDefined();
        expect(result.value!.name).toBe("cachedContents/refresh-fail-hit");
      }

      // Should have logged a warning
      expect(cfg.logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionKey: "refresh-fail-hit-session",
          name: "cachedContents/refresh-fail-hit",
          hint: "Cache entry still usable, refresh will retry on next call",
          errorKind: "network",
        }),
        expect.any(String),
      );

      vi.restoreAllMocks();
    });

    it("returns err on API failure", async () => {
      const now = Date.now();
      const manager = createGeminiCacheManager(makeConfig({ ttlSeconds: 3600 }));

      mockCreate.mockResolvedValueOnce({
        name: "cachedContents/refresh-fail",
        expireTime: new Date(now + 3_600_000).toISOString(),
        usageMetadata: { totalTokenCount: 5000 },
      });
      await manager.getOrCreate(makeRequest({ sessionKey: "refresh-fail-session" }));

      // Advance time past 50%
      vi.spyOn(Date, "now").mockReturnValue(now + 2_000_000);

      mockUpdate.mockRejectedValueOnce(new Error("API update failed"));

      const result = await manager.refresh("refresh-fail-session");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain("API update failed");
      }

      vi.restoreAllMocks();
    });
  });

  // -----------------------------------------------------------------------
  // Per-agent cache limit with LRU eviction
  // -----------------------------------------------------------------------

  describe("per-agent cache limit", () => {
    it("evicts oldest entry when at limit", async () => {
      const manager = createGeminiCacheManager(makeConfig({ maxActiveCachesPerAgent: 3 }));

      // Create 3 entries for agent-1
      for (let i = 0; i < 3; i++) {
        mockCreate.mockResolvedValueOnce({
          name: `cachedContents/entry-${i}`,
          expireTime: new Date(Date.now() + 3_600_000).toISOString(),
          usageMetadata: { totalTokenCount: 5000 },
        });
        await manager.getOrCreate(makeRequest({
          sessionKey: `session-${i}`,
          agentId: "agent-1",
          contentHash: `hash-${i}`,
        }));
      }

      expect(manager.getActiveCount("agent-1")).toBe(3);

      // 4th entry should trigger eviction of oldest (session-0)
      mockCreate.mockResolvedValueOnce({
        name: "cachedContents/entry-3",
        expireTime: new Date(Date.now() + 3_600_000).toISOString(),
        usageMetadata: { totalTokenCount: 5000 },
      });
      mockDelete.mockResolvedValueOnce({});

      await manager.getOrCreate(makeRequest({
        sessionKey: "session-3",
        agentId: "agent-1",
        contentHash: "hash-3",
      }));

      expect(manager.getActiveCount("agent-1")).toBe(3); // still 3, not 4
      expect(mockDelete).toHaveBeenCalledWith({ name: "cachedContents/entry-0" }); // oldest evicted
    });

    it("evicts entry with earliest createdAt", async () => {
      const manager = createGeminiCacheManager(makeConfig({ maxActiveCachesPerAgent: 2 }));
      const now = Date.now();

      // Entry 0 created at now
      vi.spyOn(Date, "now").mockReturnValue(now);
      mockCreate.mockResolvedValueOnce({
        name: "cachedContents/oldest",
        expireTime: new Date(now + 3_600_000).toISOString(),
        usageMetadata: { totalTokenCount: 5000 },
      });
      await manager.getOrCreate(makeRequest({
        sessionKey: "oldest-session",
        agentId: "agent-1",
        contentHash: "hash-oldest",
      }));

      // Entry 1 created 1 second later
      vi.spyOn(Date, "now").mockReturnValue(now + 1000);
      mockCreate.mockResolvedValueOnce({
        name: "cachedContents/newer",
        expireTime: new Date(now + 1000 + 3_600_000).toISOString(),
        usageMetadata: { totalTokenCount: 5000 },
      });
      await manager.getOrCreate(makeRequest({
        sessionKey: "newer-session",
        agentId: "agent-1",
        contentHash: "hash-newer",
      }));

      // Entry 2 triggers eviction -- should evict "oldest" (created at now)
      vi.spyOn(Date, "now").mockReturnValue(now + 2000);
      mockCreate.mockResolvedValueOnce({
        name: "cachedContents/newest",
        expireTime: new Date(now + 2000 + 3_600_000).toISOString(),
        usageMetadata: { totalTokenCount: 5000 },
      });
      mockDelete.mockResolvedValueOnce({});

      await manager.getOrCreate(makeRequest({
        sessionKey: "newest-session",
        agentId: "agent-1",
        contentHash: "hash-newest",
      }));

      expect(mockDelete).toHaveBeenCalledWith({ name: "cachedContents/oldest" });
      expect(manager.getActiveCount("agent-1")).toBe(2);

      vi.restoreAllMocks();
    });

    it("different agents have independent limits", async () => {
      const manager = createGeminiCacheManager(makeConfig({ maxActiveCachesPerAgent: 2 }));

      // agent-1: 2 entries (at limit)
      for (let i = 0; i < 2; i++) {
        mockCreate.mockResolvedValueOnce({
          name: `cachedContents/a1-${i}`,
          expireTime: new Date(Date.now() + 3_600_000).toISOString(),
          usageMetadata: { totalTokenCount: 5000 },
        });
        await manager.getOrCreate(makeRequest({
          sessionKey: `a1-session-${i}`,
          agentId: "agent-1",
          contentHash: `a1-hash-${i}`,
        }));
      }

      // agent-2: should create without evicting agent-1's entries
      mockCreate.mockResolvedValueOnce({
        name: "cachedContents/a2-0",
        expireTime: new Date(Date.now() + 3_600_000).toISOString(),
        usageMetadata: { totalTokenCount: 5000 },
      });
      await manager.getOrCreate(makeRequest({
        sessionKey: "a2-session-0",
        agentId: "agent-2",
        contentHash: "a2-hash-0",
      }));

      expect(manager.getActiveCount("agent-1")).toBe(2);
      expect(manager.getActiveCount("agent-2")).toBe(1);
      expect(mockDelete).not.toHaveBeenCalled(); // no eviction needed
    });

    it("getActiveCount returns correct count after eviction", async () => {
      const manager = createGeminiCacheManager(makeConfig({ maxActiveCachesPerAgent: 2 }));

      // Fill to limit
      for (let i = 0; i < 2; i++) {
        mockCreate.mockResolvedValueOnce({
          name: `cachedContents/count-${i}`,
          expireTime: new Date(Date.now() + 3_600_000).toISOString(),
          usageMetadata: { totalTokenCount: 5000 },
        });
        await manager.getOrCreate(makeRequest({
          sessionKey: `count-session-${i}`,
          agentId: "agent-1",
          contentHash: `count-hash-${i}`,
        }));
      }
      expect(manager.getActiveCount("agent-1")).toBe(2);

      // Trigger eviction
      mockCreate.mockResolvedValueOnce({
        name: "cachedContents/count-2",
        expireTime: new Date(Date.now() + 3_600_000).toISOString(),
        usageMetadata: { totalTokenCount: 5000 },
      });
      mockDelete.mockResolvedValueOnce({});

      await manager.getOrCreate(makeRequest({
        sessionKey: "count-session-2",
        agentId: "agent-1",
        contentHash: "count-hash-2",
      }));

      // Count should still be 2 (evicted 1, added 1)
      expect(manager.getActiveCount("agent-1")).toBe(2);
    });
  });

  // -----------------------------------------------------------------------
  // cleanupOrphaned -- orphan cache deletion
  // -----------------------------------------------------------------------

  describe("cleanupOrphaned", () => {
    /** Create a mock async iterable pager from an array of items. */
    function createMockPager(items: Array<{ name?: string; displayName?: string }>) {
      return {
        [Symbol.asyncIterator]: async function* () {
          for (const item of items) yield item;
        },
      };
    }

    it("returns { deleted: 0, skipped: 0 } when remote list is empty", async () => {
      mockList.mockReturnValue(createMockPager([]));

      const manager = createGeminiCacheManager(makeConfig());
      const result = await manager.cleanupOrphaned();

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toEqual({ deleted: 0, skipped: 0 });
      }
    });

    it("deletes entries with displayName starting with 'comis:' and returns correct deleted count", async () => {
      mockList.mockReturnValue(createMockPager([
        { name: "cachedContents/orphan1", displayName: "comis:agent-1:session-old:abc12345" },
        { name: "cachedContents/orphan2", displayName: "comis:agent-2:session-old2:def67890" },
      ]));
      mockDelete.mockResolvedValue({});

      const manager = createGeminiCacheManager(makeConfig());
      const result = await manager.cleanupOrphaned();

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.deleted).toBe(2);
        expect(result.value.skipped).toBe(0);
      }
      expect(mockDelete).toHaveBeenCalledTimes(2);
    });

    it("skips entries without 'comis:' displayName prefix and counts them as skipped", async () => {
      mockList.mockReturnValue(createMockPager([
        { name: "cachedContents/orphan1", displayName: "comis:agent-1:session:abc12345" },
        { name: "cachedContents/other1", displayName: "other-app:cache" },
        { name: "cachedContents/other2", displayName: "some-tool-cache" },
      ]));
      mockDelete.mockResolvedValue({});

      const manager = createGeminiCacheManager(makeConfig());
      const result = await manager.cleanupOrphaned();

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.deleted).toBe(1);
        expect(result.value.skipped).toBe(2);
      }
    });

    it("returns ok({ deleted: 0, skipped: 0 }) when no API key is available", async () => {
      const manager = createGeminiCacheManager(
        makeConfig({ getApiKey: () => undefined }),
      );
      const result = await manager.cleanupOrphaned();

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toEqual({ deleted: 0, skipped: 0 });
      }
      expect(mockList).not.toHaveBeenCalled();
    });

    it("logs WARN with hint and errorKind when individual deletion fails and counts as skipped", async () => {
      const logConfig = makeConfig();
      mockList.mockReturnValue(createMockPager([
        { name: "cachedContents/fail1", displayName: "comis:agent-1:session:abc12345" },
        { name: "cachedContents/ok1", displayName: "comis:agent-2:session:def67890" },
      ]));
      mockDelete
        .mockRejectedValueOnce(new Error("API delete failed"))
        .mockResolvedValueOnce({});

      const manager = createGeminiCacheManager(logConfig);
      const result = await manager.cleanupOrphaned();

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.deleted).toBe(1);
        expect(result.value.skipped).toBe(1);
      }
      expect(logConfig.logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "cachedContents/fail1",
          hint: "Orphaned cache will expire via API-side TTL",
          errorKind: "network",
        }),
        expect.any(String),
      );
    });

    it("handles entries with no name field gracefully (skip, don't crash)", async () => {
      mockList.mockReturnValue(createMockPager([
        { displayName: "comis:agent-1:session:abc12345" }, // no name
        { name: "cachedContents/ok1", displayName: "comis:agent-2:session:def67890" },
      ]));
      mockDelete.mockResolvedValue({});

      const manager = createGeminiCacheManager(makeConfig());
      const result = await manager.cleanupOrphaned();

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.deleted).toBe(1);
        expect(result.value.skipped).toBe(1); // no-name entry skipped
      }
    });
  });
});
