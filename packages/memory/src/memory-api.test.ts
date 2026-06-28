// SPDX-License-Identifier: Apache-2.0
import type { MemoryEntry, MemoryConfig, SessionKey } from "@comis/core";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createMemoryApi, type MemoryApi } from "./memory-api.js";
import { createSessionStore, type SessionStore } from "./session-store.js";
import { SqliteMemoryAdapter } from "./sqlite-memory-adapter.js";

/** Default test config using in-memory SQLite. */
const testConfig: MemoryConfig = {
  enabled: true,
  dbPath: ":memory:",
  walMode: false, // WAL not supported on :memory:
  // Phase 226: the recall keepers nest under memory.recall (design §5).
  recall: {
    embeddingModel: "test-model",
    embeddingDimensions: 4,
    rerankerModel: "hf:test/reranker.gguf",
  },
  compaction: { enabled: false, threshold: 1000, targetSize: 500 },
  retention: { maxAgeDays: 0 },
  rerankerModelsDir: "models",
  rerankerGpu: "false",
  rerankerThreads: 4,
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
      await adapter.store(entry);
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

    it("filters inspect results by tag-array intersection per memory-api contract", () => {
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

    it("filters inspect results by tenantId for tenant isolation in memory-api", () => {
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

  // ── count (full match count, ignoring limit/offset) ───────────────
  describe("count", () => {
    it("counts ALL matching entries independent of the inspect page limit", () => {
      // 10 entries are seeded (no tenant filter ⇒ all tenants counted). A small
      // page limit must NOT shrink the count — this is the P4 fix: memory.browse
      // needs the FULL total to drive its pagination, not the page length.
      const page = api.inspect({ limit: 3, offset: 0 });
      expect(page.length).toBe(3);

      const total = api.count({ limit: 3, offset: 0 });
      expect(total).toBe(10);
    });

    it("applies the same trust/type/tenant filters as inspect", () => {
      expect(api.count({ trustLevel: "system" })).toBe(api.inspect({ trustLevel: "system", limit: 1000 }).length);
      expect(api.count({ memoryType: "semantic" })).toBe(api.inspect({ memoryType: "semantic", limit: 1000 }).length);
      expect(api.count({ tenantId: "tenant-b" })).toBe(1);
    });

    it("counts the tag-intersection set (matching inspect's tag post-filter)", () => {
      expect(api.count({ trustLevel: "learned", tags: ["animals"] })).toBe(2);
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

    it("clears entries with createdAt older than the olderThan boundary timestamp", () => {
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

    it("clear() does not delete pinned memories (immune like system trust)", async () => {
      // Pinned memories must survive scoped clear() — same immunity as system-trust entries.
      // The WHERE clause must carry `AND pinned != 1` so clear() skips pinned rows.
      const id = crypto.randomUUID();
      adapter.getDb().prepare(
        `INSERT INTO memories (id, tenant_id, agent_id, user_id, content, trust_level, memory_type, source_who, tags, created_at, has_embedding)
         VALUES (?, 'default', 'default', 'user-1', 'pinned standing instruction', 'learned', 'semantic', 'agent', '[]', ?, 0)`,
      ).run(id, Date.now());
      adapter.getDb().prepare("UPDATE memories SET pinned = 1 WHERE id = ?").run(id);

      api.clear({ tenantId: "default", agentId: "default" });

      const rows = adapter.getDb().prepare("SELECT id FROM memories WHERE id = ?").all(id) as { id: string }[];
      expect(rows).toHaveLength(1); // GREEN: immunity predicate added → row survives clear()
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
        await multiAdapter.store(entry);
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

  // NOTE: describe("enforceGuardrails") was removed in a prior port-trim cleanup
  // along with the MemoryApi.enforceGuardrails method + GuardrailResult interface
  // + RetentionConfigSchema.maxEntries Zod field. Retention is now governed only
  // by RetentionConfigSchema.maxAgeDays (whose enforcement path lives elsewhere).

  // ── pin / unpin ────────────────────────────────────────────────────────────
  describe("pin and unpin", () => {
    it("pin returns ok(true) when the memory entry exists in scope", async () => {
      const entry = makeEntry({ tenantId: "tenant-a", agentId: "agent-1" });
      await adapter.store(entry as MemoryEntry);
      const result = await api.pin(entry.id, "tenant-a");
      expect(result.ok).toBe(true);
      expect(result.ok && result.value).toBe(true);
    });

    it("pin returns ok(false) when the id is not found (idempotent no-op)", async () => {
      const result = await api.pin("nonexistent-id-99", "tenant-a");
      expect(result.ok).toBe(true);
      expect(result.ok && result.value).toBe(false);
    });

    it("unpin returns ok(true) when a pinned memory entry is unpinned", async () => {
      const entry = makeEntry({ tenantId: "tenant-b", agentId: "agent-2" });
      await adapter.store(entry as MemoryEntry);
      await api.pin(entry.id, "tenant-b");
      const result = await api.unpin(entry.id, "tenant-b");
      expect(result.ok).toBe(true);
      expect(result.ok && result.value).toBe(true);
    });

    it("unpin returns ok(false) when the id is not found (idempotent no-op)", async () => {
      const result = await api.unpin("nonexistent-id-99", "tenant-b");
      expect(result.ok).toBe(true);
      expect(result.ok && result.value).toBe(false);
    });

    it("pin/unpin with id only (no tenant/agent scope) match the row by id alone", async () => {
      // Exercises the broadest-scope branch: tenantId === undefined → the
      // `WHERE id = ?` single-arg SQL path of pin() and unpin().
      const entry = makeEntry({ tenantId: "tenant-c", agentId: "agent-3" });
      await adapter.store(entry as MemoryEntry);

      const pinned = await api.pin(entry.id);
      expect(pinned.ok && pinned.value).toBe(true);
      const afterPin = adapter.getDb()
        .prepare("SELECT pinned FROM memories WHERE id = ?")
        .get(entry.id) as { pinned: number } | undefined;
      expect(afterPin?.pinned).toBe(1);

      const unpinned = await api.unpin(entry.id);
      expect(unpinned.ok && unpinned.value).toBe(true);
      const afterUnpin = adapter.getDb()
        .prepare("SELECT pinned FROM memories WHERE id = ?")
        .get(entry.id) as { pinned: number } | undefined;
      expect(afterUnpin?.pinned).toBe(0);
    });

    it("CR-01: pin with agentId does NOT pin a same-tenant entry owned by a different agent", async () => {
      // Two entries: same tenant, different agents. Pinning for agent-a must not pin agent-b's entry.
      const entryA = makeEntry({ tenantId: "t-cr01", agentId: "agent-a" });
      const entryB = makeEntry({ tenantId: "t-cr01", agentId: "agent-b" });
      await adapter.store(entryA as MemoryEntry);
      await adapter.store(entryB as MemoryEntry);

      // Pin entryA scoped to agent-a.
      const r = await api.pin(entryA.id, "t-cr01", "agent-a");
      expect(r.ok).toBe(true);
      expect(r.ok && r.value).toBe(true);

      // entryB (agent-b) must remain unpinned.
      const rowB = adapter.getDb()
        .prepare("SELECT pinned FROM memories WHERE id = ?")
        .get(entryB.id) as { pinned: number } | undefined;
      expect(rowB?.pinned).toBe(0);
    });

    it("CR-01: pin with wrong agentId returns ok(false) and leaves the row unpinned", async () => {
      const entry = makeEntry({ tenantId: "t-cr01b", agentId: "agent-b" });
      await adapter.store(entry as MemoryEntry);

      // Try to pin using the wrong agentId → must return false (not found in scope).
      const r = await api.pin(entry.id, "t-cr01b", "agent-a");
      expect(r.ok).toBe(true);
      expect(r.ok && r.value).toBe(false);

      const row = adapter.getDb()
        .prepare("SELECT pinned FROM memories WHERE id = ?")
        .get(entry.id) as { pinned: number } | undefined;
      expect(row?.pinned).toBe(0);
    });
  });

  // ── WR-01: clear() pin immunity unconditional ──────────────────────────────
  describe("WR-01: clear() pin immunity is unconditional (not bypassed by trustLevel scope)", () => {
    it("WR-01: clear() with trustLevel:'external' still spares pinned entries", async () => {
      // The pin immunity `AND pinned != 1` must apply even when scope.trustLevel is set.
      // Pre-patch: the condition is gated on !scope.trustLevel, so clear({ trustLevel: 'external' })
      // deletes the pinned external-trust entry. Post-patch: immunity is unconditional.
      const db = adapter.getDb();
      const pinnedExternalId = crypto.randomUUID();
      db.prepare(
        `INSERT INTO memories (id, tenant_id, agent_id, user_id, content, trust_level, memory_type,
          source_who, tags, created_at, has_embedding)
         VALUES (?, 'default', 'default', 'user-1', 'pinned external', 'external', 'semantic', 'agent', '[]', ?, 0)`,
      ).run(pinnedExternalId, Date.now());
      db.prepare("UPDATE memories SET pinned = 1 WHERE id = ?").run(pinnedExternalId);

      // clear() scoped to external trust — must NOT delete the pinned entry.
      api.clear({ tenantId: "default", trustLevel: "external" });

      const rows = db.prepare("SELECT id FROM memories WHERE id = ?").all(pinnedExternalId) as { id: string }[];
      expect(rows).toHaveLength(1); // pinned entry survives regardless of trustLevel scope
    });
  });
});
