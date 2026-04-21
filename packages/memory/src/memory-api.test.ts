// SPDX-License-Identifier: Apache-2.0
import type { MemoryEntry, MemoryConfig, SessionKey } from "@comis/core";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createMemoryApi, type MemoryApi } from "./memory-api.js";
import { createSessionStore, type SessionStore } from "./session-store.js";
import { SqliteMemoryAdapter } from "./sqlite-memory-adapter.js";

/** Default test config using in-memory SQLite. */
const testConfig: MemoryConfig = {
  dbPath: ":memory:",
  walMode: false, // WAL not supported on :memory:
  embeddingModel: "test-model",
  embeddingDimensions: 4,
  compaction: { enabled: false, threshold: 1000, targetSize: 500 },
  retention: { maxAgeDays: 0, maxEntries: 0 },
};

/** Create a minimal valid MemoryEntry for testing. */
function makeEntry(
  overrides?: Partial<MemoryEntry> & { memoryType?: string },
): MemoryEntry & { memoryType?: string } {
  return {
    id: overrides?.id ?? crypto.randomUUID(),
    tenantId: overrides?.tenantId ?? "default",
    agentId: overrides?.agentId ?? "default",
    userId: overrides?.userId ?? "user-1",
    content: overrides?.content ?? "test memory content",
    trustLevel: overrides?.trustLevel ?? "learned",
    source: overrides?.source ?? { who: "agent", channel: "telegram" },
    tags: overrides?.tags ?? [],
    createdAt: overrides?.createdAt ?? Date.now(),
    ...(overrides?.updatedAt !== undefined ? { updatedAt: overrides.updatedAt } : {}),
    ...(overrides?.expiresAt !== undefined ? { expiresAt: overrides.expiresAt } : {}),
    ...(overrides?.embedding ? { embedding: overrides.embedding } : {}),
    ...(overrides?.memoryType ? { memoryType: overrides.memoryType } : {}),
  };
}

describe("MemoryApi", () => {
  let adapter: SqliteMemoryAdapter;
  let sessionStore: SessionStore;
  let api: MemoryApi;

  beforeEach(async () => {
    adapter = new SqliteMemoryAdapter(testConfig);
    sessionStore = createSessionStore(adapter.getDb());
    api = createMemoryApi(adapter.getDb(), adapter, sessionStore, testConfig);

    // Seed varied memory entries
    const now = Date.now();
    const entries: Array<MemoryEntry & { memoryType?: string }> = [
      makeEntry({
        content: "system config alpha",
        trustLevel: "system",
        tags: ["config"],
        createdAt: now - 10000,
        memoryType: "semantic",
      }),
      makeEntry({
        content: "system config beta",
        trustLevel: "system",
        tags: ["config"],
        createdAt: now - 9000,
        memoryType: "semantic",
      }),
      makeEntry({
        content: "learned fact about cats",
        trustLevel: "learned",
        tags: ["animals", "facts"],
        createdAt: now - 8000,
        memoryType: "semantic",
      }),
      makeEntry({
        content: "learned fact about dogs",
        trustLevel: "learned",
        tags: ["animals", "facts"],
        createdAt: now - 7000,
        memoryType: "episodic",
      }),
      makeEntry({
        content: "external web data about weather",
        trustLevel: "external",
        tags: ["weather"],
        createdAt: now - 6000,
        memoryType: "semantic",
      }),
      makeEntry({
        content: "external api response data",
        trustLevel: "external",
        tags: ["api"],
        createdAt: now - 5000,
        memoryType: "working",
      }),
      makeEntry({
        content: "working memory scratch pad",
        trustLevel: "learned",
        tags: [],
        createdAt: now - 4000,
        memoryType: "working",
      }),
      makeEntry({
        content: "episodic conversation summary",
        trustLevel: "learned",
        tags: ["summary"],
        createdAt: now - 3000,
        memoryType: "episodic",
      }),
      makeEntry({
        content: "procedural skill steps for deployment",
        trustLevel: "system",
        tags: ["deployment", "procedure"],
        createdAt: now - 2000,
        memoryType: "procedural",
      }),
      makeEntry({
        content: "tenant b data point",
        trustLevel: "learned",
        tenantId: "tenant-b",
        tags: [],
        createdAt: now - 1000,
        memoryType: "semantic",
      }),
    ];

    for (const entry of entries) {
      const memoryType = entry.memoryType ?? "semantic";
      await adapter.storeWithType(
        entry,
        memoryType as "working" | "episodic" | "semantic" | "procedural",
      );
    }

    // Add a session for stats testing
    const sessionKey: SessionKey = { tenantId: "default", userId: "user-1", channelId: "test" };
    sessionStore.save(sessionKey, [{ role: "user", content: "hello" }]);
  });

  afterEach(() => {
    adapter.close();
  });

  // ── inspect ─────────────────────────────────────────────────────

  describe("inspect", () => {
    it("returns all entries with no filters", () => {
      const entries = api.inspect();
      expect(entries.length).toBe(10);
    });

    it("filters by memoryType", () => {
      const entries = api.inspect({ memoryType: "episodic" });
      expect(entries.length).toBe(2);
      for (const e of entries) {
        // Verify content matches episodic entries
        expect(["learned fact about dogs", "episodic conversation summary"]).toContain(e.content);
      }
    });

    it("filters by trustLevel", () => {
      const entries = api.inspect({ trustLevel: "system" });
      expect(entries.length).toBe(3);
      for (const e of entries) {
        expect(e.trustLevel).toBe("system");
      }
    });

    it("filters by tags", () => {
      const entries = api.inspect({ tags: ["animals"] });
      expect(entries.length).toBe(2);
      for (const e of entries) {
        expect(e.tags).toContain("animals");
      }
    });

    it("filters by multiple tags (AND logic)", () => {
      const entries = api.inspect({ tags: ["animals", "facts"] });
      expect(entries.length).toBe(2);
    });

    it("filters by createdAfter", () => {
      const now = Date.now();
      const entries = api.inspect({ createdAfter: now - 3500 });
      // Should get entries created after now - 3500:
      // episodic conversation summary (now-3000), procedural skill (now-2000), tenant-b (now-1000)
      expect(entries.length).toBe(3);
    });

    it("filters by createdBefore", () => {
      const now = Date.now();
      const entries = api.inspect({ createdBefore: now - 8500 });
      // Should get entries created before now - 8500:
      // system config alpha (now-10000), system config beta (now-9000)
      expect(entries.length).toBe(2);
    });

    it("filters by tenantId", () => {
      const entries = api.inspect({ tenantId: "tenant-b" });
      expect(entries.length).toBe(1);
      expect(entries[0]!.content).toBe("tenant b data point");
    });

    it("respects limit and offset", () => {
      const page1 = api.inspect({ limit: 3, offset: 0 });
      const page2 = api.inspect({ limit: 3, offset: 3 });

      expect(page1.length).toBe(3);
      expect(page2.length).toBe(3);

      // Pages should not overlap (ordered by created_at DESC)
      const ids1 = new Set(page1.map((e) => e.id));
      const ids2 = new Set(page2.map((e) => e.id));
      for (const id of ids2) {
        expect(ids1.has(id)).toBe(false);
      }
    });

    it("combines multiple filters", () => {
      const entries = api.inspect({ trustLevel: "learned", tags: ["animals"] });
      expect(entries.length).toBe(2);
      for (const e of entries) {
        expect(e.trustLevel).toBe("learned");
        expect(e.tags).toContain("animals");
      }
    });
  });

  // ── inspect expiry filtering ──────────────────────────────────────

  describe("inspect expiry filtering", () => {
    it("excludes expired entries from inspect results", async () => {
      // Store an entry with past expiry directly via raw SQL
      const expiredId = crypto.randomUUID();
      adapter.getDb().prepare(
        `INSERT INTO memories (id, tenant_id, agent_id, user_id, content, trust_level, memory_type, source_who, tags, created_at, expires_at, has_embedding)
         VALUES (?, 'default', 'default', 'user-1', 'expired inspect content', 'learned', 'semantic', 'agent', '[]', ?, ?, 0)`,
      ).run(expiredId, Date.now() - 20000, Date.now() - 10000);

      const freshId = crypto.randomUUID();
      adapter.getDb().prepare(
        `INSERT INTO memories (id, tenant_id, agent_id, user_id, content, trust_level, memory_type, source_who, tags, created_at, expires_at, has_embedding)
         VALUES (?, 'default', 'default', 'user-1', 'fresh inspect content', 'learned', 'semantic', 'agent', '[]', ?, ?, 0)`,
      ).run(freshId, Date.now() - 20000, Date.now() + 60000);

      const entries = api.inspect({ tenantId: "default" });
      const ids = entries.map(e => e.id);
      expect(ids).not.toContain(expiredId);
      expect(ids).toContain(freshId);
    });

    it("includes entries with null expiresAt in inspect results", () => {
      // All seeded entries have null expiresAt - they should all appear
      const entries = api.inspect();
      expect(entries.length).toBe(10);
    });
  });

  // ── search ──────────────────────────────────────────────────────

  describe("search", () => {
    it("finds entries by text query", async () => {
      const results = await api.search("cats");
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results[0]!.entry.content).toContain("cats");
    });

    it("respects limit option", async () => {
      // All entries contain "memory" or related terms
      const results = await api.search("data", { limit: 1 });
      expect(results.length).toBeLessThanOrEqual(1);
    });

    it("returns empty for no matches", async () => {
      const results = await api.search("xyznonexistent");
      expect(results).toHaveLength(0);
    });
  });

  // ── clear ───────────────────────────────────────────────────────

  describe("clear", () => {
    it("throws on empty scope (safety)", () => {
      expect(() => api.clear({} as any)).toThrow("requires at least one scope field");
    });

    it("clears by memoryType", () => {
      const removed = api.clear({ memoryType: "working" });
      expect(removed).toBe(2); // external api response + working memory scratch pad

      const remaining = api.inspect();
      for (const e of remaining) {
        // Verify no working entries remain (check by content)
        expect(e.content).not.toContain("scratch pad");
        expect(e.content).not.toContain("api response");
      }
    });

    it("clears by trustLevel (only external allowed)", () => {
      const removed = api.clear({ trustLevel: "external" });
      expect(removed).toBe(2); // external web data + external api response

      const remaining = api.inspect();
      for (const e of remaining) {
        expect(e.trustLevel).not.toBe("external");
      }
    });

    it("clears by olderThan", () => {
      const now = Date.now();
      const removed = api.clear({ olderThan: now - 7500, tenantId: "default" });
      // Entries older than now - 7500:
      // system config alpha (now-10000), system config beta (now-9000), learned fact about cats (now-8000)
      // But system entries are protected! So only learned fact about cats is removed
      expect(removed).toBe(1);
    });

    it("protects system-trust entries from bulk clearing", () => {
      const removed = api.clear({ tenantId: "default" });
      // Should remove all non-system entries for default tenant (7 entries)
      // System entries (3) should be protected
      expect(removed).toBe(6); // 9 default tenant entries - 3 system = 6

      const remaining = api.inspect({ tenantId: "default" });
      expect(remaining.length).toBe(3);
      for (const e of remaining) {
        expect(e.trustLevel).toBe("system");
      }
    });

    it("clears by sessionKey (uses tenantId)", () => {
      const sessionKey: SessionKey = {
        tenantId: "tenant-b",
        userId: "user-1",
        channelId: "test",
      };
      const removed = api.clear({ sessionKey });
      expect(removed).toBe(1); // tenant-b data point (learned, not system)
    });

    it("returns 0 when no entries match scope", () => {
      const removed = api.clear({ tenantId: "nonexistent-tenant" });
      expect(removed).toBe(0);
    });
  });

  // ── stats ───────────────────────────────────────────────────────

  describe("stats", () => {
    it("returns accurate total entries count", () => {
      const s = api.stats();
      expect(s.totalEntries).toBe(10);
    });

    it("returns accurate counts by type", () => {
      const s = api.stats();
      expect(s.byType["semantic"]).toBe(5);
      expect(s.byType["episodic"]).toBe(2);
      expect(s.byType["working"]).toBe(2);
      expect(s.byType["procedural"]).toBe(1);
    });

    it("returns accurate counts by trust level", () => {
      const s = api.stats();
      expect(s.byTrustLevel["system"]).toBe(3);
      expect(s.byTrustLevel["learned"]).toBe(5);
      expect(s.byTrustLevel["external"]).toBe(2);
    });

    it("returns total sessions count", () => {
      const s = api.stats();
      expect(s.totalSessions).toBe(1);
    });

    it("returns embedded entries count", () => {
      const s = api.stats();
      // No embeddings stored in test seed
      expect(s.embeddedEntries).toBe(0);
    });

    it("returns database size in bytes", () => {
      const s = api.stats();
      expect(s.dbSizeBytes).toBeGreaterThan(0);
    });

    it("filters by tenantId when provided", () => {
      const s = api.stats("tenant-b");
      expect(s.totalEntries).toBe(1);
      expect(s.byTrustLevel["learned"]).toBe(1);
    });

    it("returns oldestCreatedAt as earliest entry timestamp", () => {
      const s = api.stats();
      // Oldest seeded entry has createdAt = now - 10000
      expect(s.oldestCreatedAt).toBeTypeOf("number");
      // Should be within 1000ms of (now - 10000)
      const expected = Date.now() - 10000;
      expect(Math.abs(s.oldestCreatedAt! - expected)).toBeLessThan(1000);
    });

    it("returns null oldestCreatedAt for empty store", () => {
      const emptyAdapter = new SqliteMemoryAdapter(testConfig);
      const emptySessionStore = createSessionStore(emptyAdapter.getDb());
      const emptyApi = createMemoryApi(emptyAdapter.getDb(), emptyAdapter, emptySessionStore, testConfig);
      const s = emptyApi.stats();
      expect(s.oldestCreatedAt).toBeNull();
      emptyAdapter.close();
    });
  });

  // ── multi-agent memory isolation ─────────────────────────────

  describe("multi-agent memory isolation", () => {
    let multiApi: MemoryApi;
    let multiAdapter: SqliteMemoryAdapter;
    let multiSessionStore: SessionStore;

    beforeEach(async () => {
      multiAdapter = new SqliteMemoryAdapter(testConfig);
      multiSessionStore = createSessionStore(multiAdapter.getDb());
      multiApi = createMemoryApi(multiAdapter.getDb(), multiAdapter, multiSessionStore, testConfig);

      // Seed entries for two agents
      const now = Date.now();
      const entries: Array<MemoryEntry & { memoryType?: string }> = [
        makeEntry({
          agentId: "coder",
          content: "coder fact about TypeScript",
          trustLevel: "learned",
          createdAt: now - 3000,
          memoryType: "semantic",
        }),
        makeEntry({
          agentId: "coder",
          content: "coder fact about Rust",
          trustLevel: "system",
          createdAt: now - 2000,
          memoryType: "semantic",
        }),
        makeEntry({
          agentId: "dash",
          content: "dash fact about dashboards",
          trustLevel: "learned",
          createdAt: now - 1000,
          memoryType: "episodic",
        }),
      ];

      for (const entry of entries) {
        const memoryType = entry.memoryType ?? "semantic";
        await multiAdapter.storeWithType(
          entry,
          memoryType as "working" | "episodic" | "semantic" | "procedural",
        );
      }
    });

    afterEach(() => {
      multiAdapter.close();
    });

    it("inspect filters by agentId", () => {
      const coderEntries = multiApi.inspect({ agentId: "coder" });
      expect(coderEntries.length).toBe(2);
      for (const e of coderEntries) {
        expect(e.agentId).toBe("coder");
      }

      const dashEntries = multiApi.inspect({ agentId: "dash" });
      expect(dashEntries.length).toBe(1);
      expect(dashEntries[0]!.agentId).toBe("dash");
    });

    it("stats scoped to agentId", () => {
      const coderStats = multiApi.stats(undefined, "coder");
      expect(coderStats.totalEntries).toBe(2);
      expect(coderStats.byTrustLevel["learned"]).toBe(1);
      expect(coderStats.byTrustLevel["system"]).toBe(1);

      const dashStats = multiApi.stats(undefined, "dash");
      expect(dashStats.totalEntries).toBe(1);
      expect(dashStats.byType["episodic"]).toBe(1);
    });

    it("stats returns byAgent breakdown", () => {
      const allStats = multiApi.stats();
      expect(allStats.byAgent["coder"]).toBe(2);
      expect(allStats.byAgent["dash"]).toBe(1);
    });

    it("returns agent-scoped oldestCreatedAt", () => {
      const coderStats = multiApi.stats(undefined, "coder");
      // Oldest coder entry has createdAt = now - 3000
      expect(coderStats.oldestCreatedAt).toBeTypeOf("number");
      const expected = Date.now() - 3000;
      expect(Math.abs(coderStats.oldestCreatedAt! - expected)).toBeLessThan(1000);
    });

    it("clear scoped to agentId", () => {
      // Clear only coder's memories
      const removed = multiApi.clear({ agentId: "coder" });
      // Only learned entries removed (system protected by default)
      expect(removed).toBe(1);

      const remaining = multiApi.inspect();
      // coder system entry + dash entry remain
      expect(remaining.length).toBe(2);
    });
  });

  // ── enforceGuardrails ─────────────────────────────────────────

  describe("enforceGuardrails", () => {
    it("returns null when no limits configured", () => {
      const result = api.enforceGuardrails();
      expect(result).toBeNull();
    });

    it("returns null when within limits", () => {
      // Create api with maxEntries = 20 (we have 10)
      const limitedConfig: MemoryConfig = {
        ...testConfig,
        retention: { maxAgeDays: 0, maxEntries: 20 },
      };
      const limitedApi = createMemoryApi(adapter.getDb(), adapter, sessionStore, limitedConfig);

      const result = limitedApi.enforceGuardrails();
      expect(result).toBeNull();
    });

    it("removes oldest non-system entries when limit exceeded", () => {
      // maxEntries = 7, we have 10 entries, so need to remove 3
      const limitedConfig: MemoryConfig = {
        ...testConfig,
        retention: { maxAgeDays: 0, maxEntries: 7 },
      };
      const limitedApi = createMemoryApi(adapter.getDb(), adapter, sessionStore, limitedConfig);

      const result = limitedApi.enforceGuardrails();
      expect(result).not.toBeNull();
      expect(result!.entriesRemoved).toBe(3);
      expect(result!.reason).toContain("exceeded maxEntries");

      // Verify system entries are preserved
      const remaining = api.inspect({ trustLevel: "system" });
      expect(remaining.length).toBe(3);
    });

    it("preserves system entries even when they are the oldest", () => {
      // Create a scenario where system entries are older than non-system
      // Our seed data has system entries at now-10000, now-9000, now-2000
      // The oldest non-system entry is at now-8000

      // Set maxEntries to 5 (need to remove 5 out of 10)
      const limitedConfig: MemoryConfig = {
        ...testConfig,
        retention: { maxAgeDays: 0, maxEntries: 5 },
      };
      const limitedApi = createMemoryApi(adapter.getDb(), adapter, sessionStore, limitedConfig);

      const result = limitedApi.enforceGuardrails();
      expect(result).not.toBeNull();
      expect(result!.entriesRemoved).toBe(5);

      // All 3 system entries should still be there
      const systemEntries = api.inspect({ trustLevel: "system" });
      expect(systemEntries.length).toBe(3);

      // Total should be 5
      const total = api.inspect();
      expect(total.length).toBe(5);
    });

    it("scopes enforcement to specific tenant", () => {
      // Set maxEntries to 5. Default tenant has 9 entries.
      const limitedConfig: MemoryConfig = {
        ...testConfig,
        retention: { maxAgeDays: 0, maxEntries: 5 },
      };
      const limitedApi = createMemoryApi(adapter.getDb(), adapter, sessionStore, limitedConfig);

      const result = limitedApi.enforceGuardrails("default");
      expect(result).not.toBeNull();
      expect(result!.entriesRemoved).toBe(4); // 9 - 5 = 4 non-system removed

      // tenant-b should be untouched
      const tenantB = api.inspect({ tenantId: "tenant-b" });
      expect(tenantB.length).toBe(1);
    });
  });
});
