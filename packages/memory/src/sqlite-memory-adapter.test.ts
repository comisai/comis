// SPDX-License-Identifier: Apache-2.0
import type { MemoryEntry, MemoryConfig, SessionKey, EmbeddingPort } from "@comis/core";
import type { Result } from "@comis/shared";
import { ok, err } from "@comis/shared";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { chmodSync, existsSync } from "node:fs";
import { normalizeForSearch } from "@comis/core";
import { isVecAvailable } from "./schema.js";
import { SqliteMemoryAdapter } from "./sqlite-memory-adapter.js";
import { createSqliteMemoryConsolidationStore } from "./sqlite-memory-consolidation-store.js";

/** Default test config using in-memory SQLite. */
const testConfig: MemoryConfig = {
  dbPath: ":memory:",
  walMode: false, // WAL not supported on :memory:
  embeddingModel: "test-model",
  embeddingDimensions: 4,
  compaction: { enabled: false, threshold: 1000, targetSize: 500 },
  retention: { maxAgeDays: 0 },
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
    ...(overrides?.occurredAt !== undefined ? { occurredAt: overrides.occurredAt } : {}),
    ...(overrides?.embedding ? { embedding: overrides.embedding } : {}),
    ...(overrides?.memoryType ? { memoryType: overrides.memoryType } : {}),
  };
}

/** Create a mock EmbeddingPort for testing. */
function createMockEmbeddingPort(dimensions: number = 4): EmbeddingPort {
  return {
    provider: "test",
    dimensions,
    modelId: "test-embed-model",
    async embed(text: string): Promise<Result<number[], Error>> {
      // Simple deterministic embedding based on text length
      const vec = new Array(dimensions).fill(0);
      for (let i = 0; i < text.length && i < dimensions; i++) {
        vec[i] = text.charCodeAt(i) / 256;
      }
      return ok(vec);
    },
    async embedBatch(texts: string[]): Promise<Result<number[][], Error>> {
      const vecs: number[][] = [];
      for (const text of texts) {
        const result = await this.embed(text);
        if (result.ok) vecs.push(result.value);
      }
      return ok(vecs);
    },
  };
}

const testSessionKey: SessionKey = {
  tenantId: "default",
  userId: "user-1",
  channelId: "test-channel",
};

describe("SqliteMemoryAdapter", () => {
  let adapter: SqliteMemoryAdapter;

  beforeEach(() => {
    adapter = new SqliteMemoryAdapter(testConfig);
  });

  afterEach(() => {
    adapter.close();
  });

  // ── Constructor / setup ────────────────────────────────────────

  describe("constructor", () => {
    it("creates adapter with in-memory database", () => {
      expect(adapter).toBeDefined();
      expect(adapter.getDb()).toBeDefined();
    });

    it("enables WAL mode when configured", () => {
      const walAdapter = new SqliteMemoryAdapter({
        ...testConfig,
        dbPath: ":memory:",
        walMode: true,
      });
      // WAL mode on :memory: may not fully apply, but pragma should not error
      expect(walAdapter).toBeDefined();
      walAdapter.close();
    });
  });

  // ── store ──────────────────────────────────────────────────────

  describe("store", () => {
    it("stores a memory entry and returns ok result", async () => {
      const entry = makeEntry();
      const result = await adapter.store(entry);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.id).toBe(entry.id);
        expect(result.value.content).toBe(entry.content);
      }
    });

    it("persists full provenance (who, channel, trust level)", async () => {
      const entry = makeEntry({
        trustLevel: "external",
        source: { who: "web-scraper", channel: "api", sessionKey: "sess-123" },
      });

      await adapter.store(entry);
      // Direct SQL read (adapter.retrieve was removed in a prior port-trim cleanup)
      const row = adapter
        .getDb()
        .prepare("SELECT * FROM memories WHERE id = ?")
        .get(entry.id) as { trust_level: string; source_who: string; source_channel: string; source_session_key: string | null };

      expect(row).toBeDefined();
      expect(row.trust_level).toBe("external");
      expect(row.source_who).toBe("web-scraper");
      expect(row.source_channel).toBe("api");
      expect(row.source_session_key).toBe("sess-123");
    });

    it("stores entry with tags", async () => {
      const entry = makeEntry({ tags: ["important", "project-x"] });
      await adapter.store(entry);

      // Direct SQL read; tags column stores JSON-encoded array
      const row = adapter
        .getDb()
        .prepare("SELECT tags FROM memories WHERE id = ?")
        .get(entry.id) as { tags: string };

      expect(row).toBeDefined();
      expect(JSON.parse(row.tags)).toEqual(["important", "project-x"]);
    });

    it("stores entry with embedding when vec is available", async () => {
      if (!isVecAvailable()) return;

      const entry = makeEntry({ embedding: [0.1, 0.2, 0.3, 0.4] });
      const result = await adapter.store(entry);

      expect(result.ok).toBe(true);

      // Verify embedding was stored via direct vec_memories read
      const row = adapter
        .getDb()
        .prepare("SELECT has_embedding FROM memories WHERE id = ?")
        .get(entry.id) as { has_embedding: number };
      expect(row.has_embedding).toBe(1);

      const vecRow = adapter
        .getDb()
        .prepare("SELECT embedding FROM vec_memories WHERE memory_id = ?")
        .get(entry.id) as { embedding: Buffer } | undefined;
      expect(vecRow).toBeDefined();
      if (vecRow) {
        const float32 = new Float32Array(
          vecRow.embedding.buffer,
          vecRow.embedding.byteOffset,
          vecRow.embedding.byteLength / Float32Array.BYTES_PER_ELEMENT,
        );
        expect(float32.length).toBe(4);
        expect(float32[0]).toBeCloseTo(0.1, 4);
      }
    });

    it("defaults memory_type to semantic", async () => {
      const entry = makeEntry();
      await adapter.store(entry);

      // Query raw DB to check memory_type
      const row = adapter
        .getDb()
        .prepare("SELECT memory_type FROM memories WHERE id = ?")
        .get(entry.id) as { memory_type: string };

      expect(row.memory_type).toBe("semantic");
    });

    it("persists a non-semantic memoryType carried on the entry", async () => {
      // The classified memoryType arrives as a first-class MemoryEntry field — the
      // adapter must write it verbatim, NOT collapse it to the 'semantic' default.
      const entry = makeEntry({ memoryType: "episodic" });
      await adapter.store(entry);

      const row = adapter
        .getDb()
        .prepare("SELECT memory_type FROM memories WHERE id = ?")
        .get(entry.id) as { memory_type: string };

      expect(row.memory_type).toBe("episodic");
    });

    it("round-trips memoryType back through search (read-back is the classified type)", async () => {
      const entry = makeEntry({ content: "user prefers tabs over spaces", memoryType: "procedural" });
      await adapter.store(entry);

      const found = await adapter.search(
        { tenantId: "default", agentId: "default", userId: "user-1" },
        "tabs spaces",
        { limit: 5 },
      );
      expect(found.ok).toBe(true);
      if (found.ok) {
        const hit = found.value.find((r) => r.entry.id === entry.id);
        expect(hit).toBeDefined();
        // rowToEntry surfaces the stored classification, not the 'semantic' default.
        expect((hit?.entry as { memoryType?: string }).memoryType).toBe("procedural");
      }
    });

    it("returns error for duplicate ID", async () => {
      const entry = makeEntry();
      await adapter.store(entry);

      const result = await adapter.store(entry);
      expect(result.ok).toBe(false);
    });

    it("stores entry with expiresAt", async () => {
      const expires = Date.now() + 86400000; // 1 day
      const entry = makeEntry({ expiresAt: expires });
      await adapter.store(entry);

      // Direct SQL read (adapter.retrieve was removed in a prior port-trim cleanup)
      const row = adapter
        .getDb()
        .prepare("SELECT expires_at FROM memories WHERE id = ?")
        .get(entry.id) as { expires_at: number };

      expect(row).toBeDefined();
      expect(row.expires_at).toBe(expires);
    });
  });

  // ── search ─────────────────────────────────────────────────────

  describe("search", () => {
    it("finds entries by text query via FTS5", async () => {
      await adapter.store(makeEntry({ content: "dentist appointment on Tuesday" }));
      await adapter.store(makeEntry({ content: "grocery list for the week" }));

      const result = await adapter.search(testSessionKey, "dentist");

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.length).toBe(1);
        expect(result.value[0]!.entry.content).toBe("dentist appointment on Tuesday");
        expect(result.value[0]!.score).toBeDefined();
      }
    });

    it("finds entries by vector query", async () => {
      if (!isVecAvailable()) return;

      const e1 = makeEntry({ content: "entry one", embedding: [1, 0, 0, 0] });
      const e2 = makeEntry({ content: "entry two", embedding: [0, 1, 0, 0] });
      await adapter.store(e1);
      await adapter.store(e2);

      const result = await adapter.search(testSessionKey, [0.9, 0.1, 0, 0], { limit: 5 });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.length).toBeGreaterThanOrEqual(1);
        // e1 should be closest
        expect(result.value[0]!.entry.id).toBe(e1.id);
        expect(result.value[0]!.score).toBeDefined();
      }
    });

    it("respects limit option", async () => {
      for (let i = 0; i < 5; i++) {
        await adapter.store(makeEntry({ content: `cat memory number ${i}` }));
      }

      const result = await adapter.search(testSessionKey, "cat", { limit: 2 });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.length).toBe(2);
      }
    });

    it("filters by trustLevel", async () => {
      await adapter.store(makeEntry({ content: "system cat fact", trustLevel: "system" }));
      await adapter.store(makeEntry({ content: "external cat data", trustLevel: "external" }));

      const result = await adapter.search(testSessionKey, "cat", {
        trustLevel: "system",
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.length).toBe(1);
        expect(result.value[0]!.entry.trustLevel).toBe("system");
      }
    });

    it("filters search() results by tags array intersection per memory-adapter contract", async () => {
      await adapter.store(
        makeEntry({
          content: "tagged cat memory",
          tags: ["important", "cat-facts"],
        }),
      );
      await adapter.store(makeEntry({ content: "untagged cat memory", tags: [] }));

      const result = await adapter.search(testSessionKey, "cat", {
        tags: ["important"],
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.length).toBe(1);
        expect(result.value[0]!.entry.tags).toContain("important");
      }
    });

    it("returns empty for no matches", async () => {
      await adapter.store(makeEntry({ content: "the quick brown fox" }));

      const result = await adapter.search(testSessionKey, "elephant");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toHaveLength(0);
      }
    });

    it("uses embedding port for hybrid search when available", async () => {
      if (!isVecAvailable()) return;

      const embeddingPort = createMockEmbeddingPort(4);
      const adapterWithEmbed = new SqliteMemoryAdapter(testConfig, embeddingPort);

      try {
        const e1 = makeEntry({
          content: "dentist appointment",
          embedding: [0.25, 0.39, 0.43, 0.4],
        });
        await adapterWithEmbed.store(e1);

        const result = await adapterWithEmbed.search(testSessionKey, "dentist");
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.length).toBeGreaterThanOrEqual(1);
        }
      } finally {
        adapterWithEmbed.close();
      }
    });

    it("truncates long search queries before embedding", async () => {
      const embeddingPort = createMockEmbeddingPort(4);
      const embedSpy = vi.spyOn(embeddingPort, "embed");
      const adapterWithEmbed = new SqliteMemoryAdapter(testConfig, embeddingPort);

      try {
        // Store a memory so search has something to work with
        await adapterWithEmbed.store(makeEntry({ content: "some memory content" }));

        // Create a query longer than the truncation threshold (1536 tokens * 3 chars/token = 4608 chars —
        // the densest-ratio cap so dense queries stay under the 2048-token embedding context).
        const longQuery = "a".repeat(8000);
        const result = await adapterWithEmbed.search(testSessionKey, longQuery);

        expect(result.ok).toBe(true);
        // Verify embed was called with a truncated string at the conservative cap.
        expect(embedSpy).toHaveBeenCalledOnce();
        const passedQuery = embedSpy.mock.calls[0]![0];
        expect(passedQuery.length).toBeLessThanOrEqual(4608);
        expect(passedQuery.length).toBe(4608);
      } finally {
        adapterWithEmbed.close();
      }
    });
  });

  // ── delete ─────────────────────────────────────────────────────

  describe("delete", () => {
    it("deletes existing entry and returns true", async () => {
      const entry = makeEntry();
      await adapter.store(entry);

      const result = await adapter.delete(entry.id);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(true);
      }

      // Verify gone (direct SQL read; adapter.retrieve was removed in a prior port-trim cleanup)
      const row = adapter
        .getDb()
        .prepare("SELECT id FROM memories WHERE id = ?")
        .get(entry.id);
      expect(row).toBeUndefined();
    });

    it("returns false for non-existent entry", async () => {
      const result = await adapter.delete("non-existent");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(false);
      }
    });

    it("scopes delete() by tenantId so foreign-tenant deletions are rejected", async () => {
      const entry = makeEntry({ tenantId: "tenant-x" });
      await adapter.store(entry);

      // Delete with wrong tenant should not remove
      const result = await adapter.delete(entry.id, "tenant-y");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(false);
      }

      // Entry should still exist (direct SQL read; adapter.retrieve was removed in a prior port-trim cleanup)
      const row = adapter
        .getDb()
        .prepare("SELECT id FROM memories WHERE id = ? AND tenant_id = ?")
        .get(entry.id, "tenant-x");
      expect(row).toBeDefined();
    });

    it("removes entry from FTS5 index", async () => {
      const entry = makeEntry({ content: "findable by keyword searchterm" });
      await adapter.store(entry);

      // Verify it's searchable
      const before = await adapter.search(testSessionKey, "searchterm");
      expect(before.ok).toBe(true);
      if (before.ok) {
        expect(before.value.length).toBe(1);
      }

      await adapter.delete(entry.id);

      // Should no longer be searchable
      const after = await adapter.search(testSessionKey, "searchterm");
      expect(after.ok).toBe(true);
      if (after.ok) {
        expect(after.value.length).toBe(0);
      }
    });

    it("removes entry from vec_memories when vec is available", async () => {
      if (!isVecAvailable()) return;

      const entry = makeEntry({ embedding: [0.5, 0.5, 0.5, 0.5] });
      await adapter.store(entry);

      await adapter.delete(entry.id);

      // Check vec_memories directly
      const vecRow = adapter
        .getDb()
        .prepare("SELECT * FROM vec_memories WHERE memory_id = ?")
        .get(entry.id);
      expect(vecRow).toBeUndefined();
    });
  });

  // ── deleteBySessionKey (DIST-05) ─────────────────────────────

  describe("deleteBySessionKey (DIST-05)", () => {
    it("deletes ALL rows for a (sessionKey, tenant, agent) scope and returns the count", async () => {
      // Two memories from the same session + a third from a different session.
      await adapter.store(makeEntry({ content: "a", source: { who: "u", channel: "c", sessionKey: "sess-1" } }));
      await adapter.store(makeEntry({ content: "b", source: { who: "u", channel: "c", sessionKey: "sess-1" } }));
      await adapter.store(makeEntry({ content: "c", source: { who: "u", channel: "c", sessionKey: "sess-2" } }));

      const r = await adapter.deleteBySessionKey!("sess-1", { tenantId: "default", agentId: "default" });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.value).toBe(2);

      const remaining = adapter
        .getDb()
        .prepare("SELECT COUNT(*) AS c FROM memories WHERE source_session_key = ?")
        .get("sess-1") as { c: number };
      expect(remaining.c).toBe(0);
      const other = adapter
        .getDb()
        .prepare("SELECT COUNT(*) AS c FROM memories WHERE source_session_key = ?")
        .get("sess-2") as { c: number };
      expect(other.c).toBe(1); // the other session is untouched
    });

    it("is R4-scoped: never deletes a row from a different tenant or agent", async () => {
      await adapter.store(
        makeEntry({ tenantId: "t-a", agentId: "ag-a", source: { who: "u", channel: "c", sessionKey: "sess-x" } }),
      );
      // Same session key but a DIFFERENT tenant — must survive.
      await adapter.store(
        makeEntry({ tenantId: "t-b", agentId: "ag-a", source: { who: "u", channel: "c", sessionKey: "sess-x" } }),
      );
      // Same session key + tenant but a DIFFERENT agent — must survive.
      await adapter.store(
        makeEntry({ tenantId: "t-a", agentId: "ag-b", source: { who: "u", channel: "c", sessionKey: "sess-x" } }),
      );

      const r = await adapter.deleteBySessionKey!("sess-x", { tenantId: "t-a", agentId: "ag-a" });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.value).toBe(1); // only the (t-a, ag-a) row

      const survivors = adapter
        .getDb()
        .prepare("SELECT COUNT(*) AS c FROM memories WHERE source_session_key = ?")
        .get("sess-x") as { c: number };
      expect(survivors.c).toBe(2); // cross-tenant + cross-agent rows survive
    });

    it("returns 0 when no rows match (no error)", async () => {
      const r = await adapter.deleteBySessionKey!("missing", { tenantId: "default", agentId: "default" });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.value).toBe(0);
    });

    it("removes matching vec_memories rows when vec is available", async () => {
      if (!isVecAvailable()) return;
      await adapter.store(
        makeEntry({ embedding: [0.5, 0.5, 0.5, 0.5], source: { who: "u", channel: "c", sessionKey: "sess-v" } }),
      );
      const before = adapter.getDb().prepare("SELECT COUNT(*) AS c FROM vec_memories").get() as { c: number };
      expect(before.c).toBeGreaterThanOrEqual(1);

      await adapter.deleteBySessionKey!("sess-v", { tenantId: "default", agentId: "default" });

      const remaining = adapter
        .getDb()
        .prepare(
          "SELECT COUNT(*) AS c FROM vec_memories WHERE memory_id IN " +
            "(SELECT id FROM memories WHERE source_session_key = ?)",
        )
        .get("sess-v") as { c: number };
      expect(remaining.c).toBe(0);
    });
  });

  // ── listMemoryIdsBySessionKey (DIST-05, WR-02) ───────────────

  describe("listMemoryIdsBySessionKey (DIST-05, WR-02)", () => {
    it("returns the ids for a (sessionKey, tenant, agent) scope WITHOUT deleting them", async () => {
      const a = makeEntry({ content: "a", source: { who: "u", channel: "c", sessionKey: "sess-list" } });
      const b = makeEntry({ content: "b", source: { who: "u", channel: "c", sessionKey: "sess-list" } });
      await adapter.store(a);
      await adapter.store(b);
      await adapter.store(makeEntry({ content: "c", source: { who: "u", channel: "c", sessionKey: "sess-other" } }));

      const r = await adapter.listMemoryIdsBySessionKey!("sess-list", {
        tenantId: "default",
        agentId: "default",
      });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(new Set(r.value)).toEqual(new Set([a.id, b.id]));
      // Non-destructive: the rows still exist.
      const count = adapter
        .getDb()
        .prepare("SELECT COUNT(*) AS c FROM memories WHERE source_session_key = ?")
        .get("sess-list") as { c: number };
      expect(count.c).toBe(2);
    });

    it("is R4-scoped: excludes ids from a different tenant or agent (matches the delete scope)", async () => {
      const mine = makeEntry({
        tenantId: "t-a",
        agentId: "ag-a",
        source: { who: "u", channel: "c", sessionKey: "sess-iso" },
      });
      await adapter.store(mine);
      // Same session key, different tenant — excluded.
      await adapter.store(
        makeEntry({ tenantId: "t-b", agentId: "ag-a", source: { who: "u", channel: "c", sessionKey: "sess-iso" } }),
      );
      // Same session key + tenant, different agent — excluded.
      await adapter.store(
        makeEntry({ tenantId: "t-a", agentId: "ag-b", source: { who: "u", channel: "c", sessionKey: "sess-iso" } }),
      );

      const r = await adapter.listMemoryIdsBySessionKey!("sess-iso", { tenantId: "t-a", agentId: "ag-a" });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.value).toEqual([mine.id]);
    });

    it("returns an empty array when no rows match (no error)", async () => {
      const r = await adapter.listMemoryIdsBySessionKey!("sess-none", {
        tenantId: "default",
        agentId: "default",
      });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.value).toEqual([]);
    });
  });

  // ── multi-agent memory isolation ─────────────────────────────

  describe("multi-agent memory isolation", () => {
    it("stores and retrieves memory with agentId", async () => {
      const e1 = makeEntry({ agentId: "coder", content: "coder memory about compilers" });
      const e2 = makeEntry({ agentId: "dash", content: "dash memory about dashboards" });
      await adapter.store(e1);
      await adapter.store(e2);

      const coderResults = await adapter.search(testSessionKey, "memory", {
        agentId: "coder",
      });
      expect(coderResults.ok).toBe(true);
      if (coderResults.ok) {
        expect(coderResults.value.length).toBe(1);
        expect(coderResults.value[0]!.entry.content).toContain("compilers");
        expect(coderResults.value[0]!.entry.agentId).toBe("coder");
      }

      const dashResults = await adapter.search(testSessionKey, "memory", {
        agentId: "dash",
      });
      expect(dashResults.ok).toBe(true);
      if (dashResults.ok) {
        expect(dashResults.value.length).toBe(1);
        expect(dashResults.value[0]!.entry.content).toContain("dashboards");
        expect(dashResults.value[0]!.entry.agentId).toBe("dash");
      }
    });

    it("agentId defaults to 'default' when not specified", async () => {
      const entry = makeEntry({ content: "default agent memory content" });
      await adapter.store(entry);

      // Check raw DB to verify agent_id column
      // (adapter.retrieve was removed in a prior port-trim cleanup; direct SQL is
      // the canonical verification path now)
      const row = adapter
        .getDb()
        .prepare("SELECT agent_id FROM memories WHERE id = ?")
        .get(entry.id) as { agent_id: string };

      expect(row.agent_id).toBe("default");
    });

    it("search without agentId returns all agents' memories", async () => {
      await adapter.store(
        makeEntry({ agentId: "agent-a", content: "agent alpha cucumber data" }),
      );
      await adapter.store(
        makeEntry({ agentId: "agent-b", content: "agent bravo cucumber data" }),
      );
      await adapter.store(
        makeEntry({ agentId: "default", content: "default agent cucumber data" }),
      );

      // Search without agentId filter should return all
      const results = await adapter.search(testSessionKey, "cucumber");
      expect(results.ok).toBe(true);
      if (results.ok) {
        expect(results.value.length).toBe(3);
      }
    });
  });

  // ── hybrid search tenant isolation ───────────────────────────────

  describe("hybrid search tenant isolation", () => {
    it("hybrid/text search row fetch filters by tenant_id", async () => {
      // Create entries for two tenants with matching FTS content
      await adapter.store(
        makeEntry({
          tenantId: "tenant-alpha",
          content: "secret recipe for pancakes",
        }),
      );
      await adapter.store(
        makeEntry({
          tenantId: "tenant-beta",
          content: "secret recipe for waffles",
        }),
      );

      // Search as tenant-alpha
      const sessionA: SessionKey = {
        tenantId: "tenant-alpha",
        userId: "user-1",
        channelId: "test",
      };
      const results = await adapter.search(sessionA, "recipe");

      expect(results.ok).toBe(true);
      if (results.ok) {
        // Should only see tenant-alpha's entry, not tenant-beta's
        expect(results.value.length).toBe(1);
        expect(results.value[0]!.entry.content).toBe("secret recipe for pancakes");
        expect(results.value[0]!.entry.tenantId).toBe("tenant-alpha");
      }
    });

    it("hybrid search returns empty for tenant with no matching entries", async () => {
      await adapter.store(
        makeEntry({
          tenantId: "tenant-x",
          content: "unique keyword xylophone",
        }),
      );

      const sessionY: SessionKey = {
        tenantId: "tenant-y",
        userId: "user-1",
        channelId: "test",
      };
      const results = await adapter.search(sessionY, "xylophone");

      expect(results.ok).toBe(true);
      if (results.ok) {
        expect(results.value.length).toBe(0);
      }
    });
  });

  // ── expiry filtering ──────────────────────────────────────────────

  describe("expiry filtering", () => {
    // NOTE: Tests for `adapter.retrieve()` expiry semantics (expired/future/null
    // expiresAt) were removed in a prior port-trim cleanup along with the
    // method itself. The expiry semantics live on the surviving `search`
    // surface — exercised by the two `search excludes expired entries` tests
    // below.

    it("search excludes expired entries from text results", async () => {
      await adapter.store(
        makeEntry({ content: "expired banana fact", expiresAt: Date.now() - 1000 }),
      );
      await adapter.store(
        makeEntry({ content: "fresh banana fact", expiresAt: Date.now() + 60000 }),
      );

      const result = await adapter.search(testSessionKey, "banana");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.length).toBe(1);
        expect(result.value[0]!.entry.content).toBe("fresh banana fact");
      }
    });

    it("search excludes expired entries from vector results", async () => {
      if (!isVecAvailable()) return;

      const expired = makeEntry({
        content: "expired vec entry",
        embedding: [1, 0, 0, 0],
        expiresAt: Date.now() - 1000,
      });
      const fresh = makeEntry({
        content: "fresh vec entry",
        embedding: [0.9, 0.1, 0, 0],
        expiresAt: Date.now() + 60000,
      });
      await adapter.store(expired);
      await adapter.store(fresh);

      const result = await adapter.search(testSessionKey, [1, 0, 0, 0], { limit: 10 });
      expect(result.ok).toBe(true);
      if (result.ok) {
        // Only the fresh entry should appear
        expect(result.value.length).toBe(1);
        expect(result.value[0]!.entry.content).toBe("fresh vec entry");
      }
    });
  });

  // ── edge cases ─────────────────────────────────────────────────

  describe("edge cases", () => {
    it("handles embedding dimension mismatch at runtime", async () => {
      if (!isVecAvailable()) return;

      // Adapter is initialized with embeddingDimensions: 4 (testConfig)
      // Attempt to store an entry with an 8-dimensional embedding
      const entry = makeEntry({
        embedding: [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8],
      });
      const result = await adapter.store(entry);

      // sqlite-vec throws a dimension mismatch error, which the adapter
      // catches and returns as err() (not an unhandled crash)
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain("Dimension mismatch");
      }
    });

    it("handles database error when DB is closed", async () => {
      // Close the underlying DB directly
      adapter.getDb().close();

      // Attempt to store -- should return err(), not crash
      const entry = makeEntry();
      const storeResult = await adapter.store(entry);
      expect(storeResult.ok).toBe(false);
      if (!storeResult.ok) {
        expect(storeResult.error.message).toContain("not open");
      }

      // (adapter.retrieve was removed in a prior port-trim cleanup; the
      // surviving store + search closed-DB error paths are exercised in this
      // same test.)

      // Attempt to search -- should return err(), not crash
      const searchResult = await adapter.search(testSessionKey, "test");
      expect(searchResult.ok).toBe(false);
      if (!searchResult.ok) {
        expect(searchResult.error.message).toContain("not open");
      }
    });

    it("creates parent directory automatically for non-existent path", () => {
      const badPath = `/tmp/comis-nonexist-${Date.now()}/test.db`;
      const { rmSync, existsSync } = require("node:fs") as typeof import("node:fs");
      const parentDir = badPath.substring(0, badPath.lastIndexOf("/"));

      // openSqliteDatabase creates the parent directory automatically
      const tempAdapter = new SqliteMemoryAdapter({ ...testConfig, dbPath: badPath });
      try {
        expect(existsSync(parentDir)).toBe(true);
      } finally {
        tempAdapter.close();
        rmSync(parentDir, { recursive: true, force: true });
      }
    });
  });

  // ── close ──────────────────────────────────────────────────────

  describe("close", () => {
    it("closes the database connection without error", () => {
      const tempAdapter = new SqliteMemoryAdapter(testConfig);
      expect(() => tempAdapter.close()).not.toThrow();
    });
  });

  // ── logging ─────────────────────────────────────────────────────

  describe("logging", () => {
    it("logs database open at DEBUG", () => {
      const mockLogger = { info: vi.fn(), warn: vi.fn(), debug: vi.fn() };
      const loggedAdapter = new SqliteMemoryAdapter(testConfig, undefined, mockLogger);
      expect(mockLogger.debug).toHaveBeenCalledWith(
        expect.objectContaining({ dbPath: expect.any(String) }),
        "Memory database opened",
      );
      loggedAdapter.close();
    });

    it("logs search queries at DEBUG with durationMs", async () => {
      const mockLogger = { info: vi.fn(), warn: vi.fn(), debug: vi.fn() };
      const loggedAdapter = new SqliteMemoryAdapter(testConfig, undefined, mockLogger);
      try {
        await loggedAdapter.store(makeEntry({ content: "searchable content" }));
        await loggedAdapter.search(testSessionKey, "searchable");
        expect(mockLogger.debug).toHaveBeenCalledWith(
          expect.objectContaining({ durationMs: expect.any(Number), op: "search" }),
          "Memory search complete",
        );
      } finally {
        loggedAdapter.close();
      }
    });
  });

  // ── file permission hardening ────────────────────────────────────

  describe("file permission hardening", () => {
    it("applies 0o600 chmod to file-based database", () => {
      const tmpDir = `/tmp/comis-test-perm-${Date.now()}`;
      const { mkdirSync } = require("node:fs") as typeof import("node:fs");
      mkdirSync(tmpDir, { recursive: true });
      const dbPath = `${tmpDir}/test-perms.db`;

      const fileAdapter = new SqliteMemoryAdapter({
        ...testConfig,
        dbPath,
        walMode: true,
      });

      try {
        // Verify the DB file has 0o600 permissions
        const { statSync } = require("node:fs") as typeof import("node:fs");
        const stats = statSync(dbPath);
        const mode = stats.mode & 0o777;
        expect(mode).toBe(0o600);
      } finally {
        fileAdapter.close();
        // Clean up
        const { rmSync } = require("node:fs") as typeof import("node:fs");
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it("does not call chmodSync for :memory: databases", () => {
      // Verify source code skips chmod for in-memory DBs via static analysis.
      // The guard is now in the shared sqlite-adapter-base.ts utility.
      const fs = require("node:fs") as typeof import("node:fs");
      const url = require("node:url") as typeof import("node:url");
      const sourcePath = url.fileURLToPath(
        new URL("./sqlite-adapter-base.ts", import.meta.url),
      );
      const source = fs.readFileSync(sourcePath, "utf-8");

      // The guard condition should check for :memory:
      expect(source).toContain('dbPath !== ":memory:"');
    });

    it("handles chmod failure gracefully (best-effort)", () => {
      // The adapter constructor wraps chmod in try/catch, so creating
      // an in-memory adapter should work without any chmod issues
      const memAdapter = new SqliteMemoryAdapter(testConfig);
      expect(memAdapter).toBeDefined();
      memAdapter.close();
    });

    it("applies chmod to WAL/SHM companions when they exist", () => {
      const tmpDir = `/tmp/comis-test-wal-${Date.now()}`;
      const { mkdirSync: mkDir, statSync: stat, rmSync: rm } =
        require("node:fs") as typeof import("node:fs");
      mkDir(tmpDir, { recursive: true });
      const dbPath = `${tmpDir}/test-wal.db`;

      // Create adapter with WAL mode to generate WAL/SHM files
      const walAdapter = new SqliteMemoryAdapter({
        ...testConfig,
        dbPath,
        walMode: true,
      });

      try {
        // Force a write to trigger WAL file creation
        walAdapter.getDb().prepare("CREATE TABLE IF NOT EXISTS perm_test (id TEXT)").run();
        walAdapter.getDb().prepare("INSERT INTO perm_test VALUES ('x')").run();

        // WAL file should exist after write (WAL mode)
        const walPath = dbPath + "-wal";
        if (existsSync(walPath)) {
          // Re-create adapter to trigger chmod on WAL/SHM
          walAdapter.close();
          const walAdapter2 = new SqliteMemoryAdapter({
            ...testConfig,
            dbPath,
            walMode: true,
          });
          try {
            if (existsSync(walPath)) {
              const walStats = stat(walPath);
              const walMode = walStats.mode & 0o777;
              expect(walMode).toBe(0o600);
            }
          } finally {
            walAdapter2.close();
          }
        }
      } finally {
        try { walAdapter.close(); } catch { /* already closed */ }
        rm(tmpDir, { recursive: true, force: true });
      }
    });
  });
});

// ── searchLanes — the un-fused FTS/vector split ────────────────
//
// searchLanes surfaces the FTS-ranked and vector-ranked candidate lists
// SEPARATELY (NO computeRRF inside the adapter, NO minScore — both move to the
// agent's fuse() / recall layer). The LOAD-BEARING parity guard: fusing the two
// returned lanes at the OLD hardcoded weights {fts:1.0, vector:1.5} via the same
// k=60 RRF math reproduces today's `search()` (= hybridSearch) id order
// byte-for-byte. These tests pin: (a) parity, (b) no in-adapter minScore, (c) the
// limit*2 over-fetch pool, (d) the FTS-only (zero-length-embedding) degrade.

/**
 * In-test re-derivation of the OLD hybrid-search RRF (hybrid-search.ts:205-246,
 * 309-322): k=60, weightFts 1.0 / weightVec 1.5, normalize by (Σw)/(k+1). Used to
 * prove that fusing searchLanes' two lists reproduces the pre-fused order. The two
 * input lists are already in rank order (rank = index+1).
 */
function fuseLanesParity(
  fts: Array<{ id: string }>,
  vector: Array<{ id: string }>,
  weightFts = 1.0,
  weightVec = 1.5,
): string[] {
  const k = 60;
  const merged = new Map<string, number>();
  fts.forEach((r, i) => merged.set(r.id, (merged.get(r.id) ?? 0) + weightFts / (k + (i + 1))));
  vector.forEach((r, i) => merged.set(r.id, (merged.get(r.id) ?? 0) + weightVec / (k + (i + 1))));
  return Array.from(merged.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([id]) => id);
}

describe("SqliteMemoryAdapter.searchLanes (un-fused split)", () => {
  let adapter: SqliteMemoryAdapter;

  afterEach(() => {
    try { adapter.close(); } catch { /* already closed */ }
  });

  it("exposes searchLanes returning two ranked lists { fts, vector }", async () => {
    adapter = new SqliteMemoryAdapter(testConfig);
    await adapter.store(makeEntry({ content: "dentist appointment on Tuesday" }));
    await adapter.store(makeEntry({ content: "grocery list for the week" }));

    // RED on pre-patch: searchLanes does not exist yet (undefined → call throws).
    expect(adapter.searchLanes).toBeDefined();
    const res = await adapter.searchLanes!(testSessionKey, "dentist");
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(Array.isArray(res.value.fts)).toBe(true);
      expect(Array.isArray(res.value.vector)).toBe(true);
      // FTS lane found the dentist memory.
      expect(res.value.fts.some((r) => r.entry.content.includes("dentist"))).toBe(true);
    }
  });

  it("reproduces search() id order byte-for-byte when its two lanes are fused at {1.0,1.5} (PARITY GUARD)", async () => {
    if (!isVecAvailable()) return; // hybrid parity requires the vector lane
    const embeddingPort = createMockEmbeddingPort(4);
    adapter = new SqliteMemoryAdapter(testConfig, embeddingPort);

    // Seed rows that match BOTH the FTS query AND carry embeddings (so both lanes
    // populate). Distinct contents so FTS + vector rank them differently → fusion
    // is non-trivial (a real ordering, not a single-lane identity).
    await adapter.store(makeEntry({ content: "cat sat on the mat", embedding: [0.9, 0.1, 0, 0] }));
    await adapter.store(makeEntry({ content: "cat chased the laser", embedding: [0.1, 0.9, 0, 0] }));
    await adapter.store(makeEntry({ content: "the cat and the dog", embedding: [0.5, 0.5, 0, 0] }));
    await adapter.store(makeEntry({ content: "cat food review", embedding: [0.2, 0.2, 0.6, 0] }));

    // Today's fused order via search() (= hybridSearch with the hardcoded 1.0/1.5).
    const old = await adapter.search(testSessionKey, "cat", { limit: 10 });
    expect(old.ok).toBe(true);
    const oldOrder = old.ok ? old.value.map((r) => r.entry.id) : [];

    // The two lanes via searchLanes, fused IN-TEST at the same {1.0,1.5} weights.
    const lanes = await adapter.searchLanes!(testSessionKey, "cat", { limit: 10 });
    expect(lanes.ok).toBe(true);
    if (lanes.ok) {
      const fusedOrder = fuseLanesParity(
        lanes.value.fts.map((r) => ({ id: r.entry.id })),
        lanes.value.vector.map((r) => ({ id: r.entry.id })),
      ).slice(0, oldOrder.length);
      // Byte-for-byte: the unfused-then-fused order EQUALS today's pre-fused order.
      expect(fusedOrder).toEqual(oldOrder);
      expect(fusedOrder.length).toBeGreaterThan(1); // non-trivial fusion actually happened
    }
  });

  it("returns the RAW hydrated lanes WITHOUT applying minScore (minScore moves to recall)", async () => {
    adapter = new SqliteMemoryAdapter(testConfig);
    await adapter.store(makeEntry({ content: "dentist appointment Tuesday" }));
    await adapter.store(makeEntry({ content: "dentist follow-up Wednesday" }));

    // A minScore far above any realistic score: search() would filter everything,
    // but searchLanes must NOT apply it (the lanes are pre-filter candidate pools).
    const lanes = await adapter.searchLanes!(testSessionKey, "dentist", { limit: 10, minScore: 0.99 });
    expect(lanes.ok).toBe(true);
    if (lanes.ok) {
      expect(lanes.value.fts.length).toBeGreaterThan(0); // present despite minScore
    }
    // search() (with the SAME high minScore) does filter — proving the difference.
    const filtered = await adapter.search(testSessionKey, "dentist", { limit: 10, minScore: 0.99 });
    expect(filtered.ok).toBe(true);
    if (filtered.ok) expect(filtered.value).toHaveLength(0);
  });

  it("over-fetches limit*2 candidates per lane (the pool entering fuse matches today's pool)", async () => {
    adapter = new SqliteMemoryAdapter(testConfig);
    // Store 6 FTS-matching rows; with limit=2 the over-fetch (limit*2=4) must surface
    // MORE than `limit` candidates in the raw FTS lane.
    for (let i = 0; i < 6; i++) {
      await adapter.store(makeEntry({ content: `cat memory number ${i}` }));
    }
    const lanes = await adapter.searchLanes!(testSessionKey, "cat", { limit: 2 });
    expect(lanes.ok).toBe(true);
    if (lanes.ok) {
      // limit*2 = 4 over-fetched (not capped at limit=2; not unbounded at 6).
      expect(lanes.value.fts.length).toBeGreaterThan(2);
      expect(lanes.value.fts.length).toBeLessThanOrEqual(4);
    }
  });

  it("FTS-only (no embedding port) returns an EMPTY vector lane", async () => {
    adapter = new SqliteMemoryAdapter(testConfig); // no embeddingPort → FTS-only
    await adapter.store(makeEntry({ content: "dentist appointment Tuesday" }));

    const lanes = await adapter.searchLanes!(testSessionKey, "dentist", { limit: 10 });
    expect(lanes.ok).toBe(true);
    if (lanes.ok) {
      expect(lanes.value.fts.length).toBeGreaterThan(0);
      expect(lanes.value.vector).toEqual([]); // empty vector lane
    }
  });

  it("scopes lanes to the session tenant (rows of another tenant are excluded)", async () => {
    adapter = new SqliteMemoryAdapter(testConfig);
    await adapter.store(makeEntry({ content: "tenant-A cat note", tenantId: "default" }));
    await adapter.store(makeEntry({ content: "tenant-B cat note", tenantId: "other-tenant" }));

    const lanes = await adapter.searchLanes!(testSessionKey, "cat", { limit: 10 });
    expect(lanes.ok).toBe(true);
    if (lanes.ok) {
      // Only the default-tenant row surfaces (testSessionKey.tenantId === "default").
      expect(lanes.value.fts.every((r) => r.entry.tenantId === "default")).toBe(true);
      expect(lanes.value.fts.some((r) => r.entry.content.includes("tenant-A"))).toBe(true);
      expect(lanes.value.fts.some((r) => r.entry.content.includes("tenant-B"))).toBe(false);
    }
  });

  it("vector-only query (a number[]) populates the vector lane and leaves FTS empty", async () => {
    if (!isVecAvailable()) return; // the vector lane requires sqlite-vec
    const embeddingPort = createMockEmbeddingPort(4);
    adapter = new SqliteMemoryAdapter(testConfig, embeddingPort);
    await adapter.store(makeEntry({ content: "cat sat on the mat", embedding: [0.9, 0.1, 0, 0] }));

    // Passing the embedding ARRAY directly exercises the vector-only branch:
    // no FTS lane runs (the query is not a string), the array IS the embedding.
    const lanes = await adapter.searchLanes!(testSessionKey, [0.9, 0.1, 0, 0], { limit: 10 });
    expect(lanes.ok).toBe(true);
    if (lanes.ok) {
      expect(lanes.value.fts).toEqual([]); // no text query → empty FTS lane
      expect(lanes.value.vector.length).toBeGreaterThan(0); // vector lane populated
    }
  });

  it("returns err (not throw) when the underlying DB query fails", async () => {
    adapter = new SqliteMemoryAdapter(testConfig);
    await adapter.store(makeEntry({ content: "dentist appointment Tuesday" }));
    // Close the handle out from under the adapter → the prepared query throws,
    // which the searchLanes catch must collapse into an err Result (never escape).
    adapter.getDb().close();

    const lanes = await adapter.searchLanes!(testSessionKey, "dentist", { limit: 10 });
    expect(lanes.ok).toBe(false);
    if (!lanes.ok) {
      expect(lanes.error).toBeInstanceOf(Error);
    }
  });

  it("falls back to FTS-only (empty vector lane) when the embedding provider errors", async () => {
    // An embedding port that rejects: searchLanes must NOT fail — it degrades to
    // FTS-only (the vector lane stays empty), mirroring search()'s resilience.
    const failingPort: EmbeddingPort = {
      provider: "test",
      dimensions: 4,
      modelId: "test-embed-model",
      embed: async () => err(new Error("embedding backend down")),
      embedBatch: async () => err(new Error("embedding backend down")),
    };
    adapter = new SqliteMemoryAdapter(testConfig, failingPort);
    await adapter.store(makeEntry({ content: "dentist appointment Tuesday" }));

    const lanes = await adapter.searchLanes!(testSessionKey, "dentist", { limit: 10 });
    expect(lanes.ok).toBe(true);
    if (lanes.ok) {
      expect(lanes.value.fts.length).toBeGreaterThan(0); // FTS lane still works
      expect(lanes.value.vector).toEqual([]); // embedding failed → empty vector lane
    }
  });

  it("falls back to FTS-only when the embedding provider returns a zero-length vector", async () => {
    // A zero-length embedding (short/emoji input) → the FTS-only fallback branch.
    const emptyVecPort: EmbeddingPort = {
      provider: "test",
      dimensions: 4,
      modelId: "test-embed-model",
      embed: async () => ok([] as number[]),
      embedBatch: async () => ok([[]] as number[][]),
    };
    adapter = new SqliteMemoryAdapter(testConfig, emptyVecPort);
    await adapter.store(makeEntry({ content: "dentist appointment Tuesday" }));

    const lanes = await adapter.searchLanes!(testSessionKey, "dentist", { limit: 10 });
    expect(lanes.ok).toBe(true);
    if (lanes.ok) {
      expect(lanes.value.fts.length).toBeGreaterThan(0);
      expect(lanes.value.vector).toEqual([]); // zero-length embedding → no vector lane
    }
  });
});

// ── The ALWAYS-ON evicted_at IS NULL exclusion on the LIVE recall paths (CR-01) ──
//
// FORGET-01's central guarantee — "a soft-evicted memory (evicted_at set) is
// EXCLUDED from EVERY recall path" — was enforced ONLY in hybridSearch (the
// search() string-query fallback), but the agent's LIVE recall pipeline PREFERS
// searchLanes → hydrateLane (memory-recall.ts:183), which had NO evicted_at guard,
// and the vector-only search() per-id read (:137) was likewise unfiltered. So a
// soft-evicted memory kept being recalled+injected on the dominant path. These
// tests RED on the pre-patch hydrateLane / vector-only read and GREEN once the
// `AND evicted_at IS NULL` exclusion is applied to BOTH live reads — while the
// inspect/asOf raw read stays UNFILTERED (eviction is soft + asOf-resolvable).
describe("SqliteMemoryAdapter recall excludes soft-evicted rows on the LIVE paths (CR-01)", () => {
  let adapter: SqliteMemoryAdapter;

  /** Set the evicted_at soft-close marker (NULL = live). Mirrors the lifecycle sweep's softEvict. */
  function markEvicted(memoryId: string, at: number): void {
    adapter.getDb().prepare("UPDATE memories SET evicted_at = ? WHERE id = ?").run(at, memoryId);
  }

  afterEach(() => {
    try { adapter.close(); } catch { /* already closed */ }
  });

  it("searchLanes (the LIVE createMemoryRecall path) omits a soft-evicted FTS row", async () => {
    adapter = new SqliteMemoryAdapter(testConfig);
    await adapter.store(makeEntry({ id: "live", content: "the quick brown fox jumps" }));
    await adapter.store(makeEntry({ id: "evicted", content: "the quick brown fox runs" }));
    markEvicted("evicted", Date.now());

    const lanes = await adapter.searchLanes!(testSessionKey, "fox", { limit: 10 });
    expect(lanes.ok).toBe(true);
    if (lanes.ok) {
      const ids = lanes.value.fts.map((r) => r.entry.id);
      expect(ids).toContain("live");
      expect(ids).not.toContain("evicted"); // ← the always-on evicted_at IS NULL exclusion
    }
  });

  it("searchLanes omits a soft-evicted row from the VECTOR lane too", async () => {
    if (!isVecAvailable()) return; // the vector lane requires sqlite-vec
    const embeddingPort = createMockEmbeddingPort(4);
    adapter = new SqliteMemoryAdapter(testConfig, embeddingPort);
    await adapter.store(makeEntry({ id: "live", content: "cat sat on the mat", embedding: [0.9, 0.1, 0, 0] }));
    await adapter.store(makeEntry({ id: "evicted", content: "cat chased the mouse", embedding: [0.9, 0.1, 0, 0] }));
    markEvicted("evicted", Date.now());

    const lanes = await adapter.searchLanes!(testSessionKey, [0.9, 0.1, 0, 0], { limit: 10 });
    expect(lanes.ok).toBe(true);
    if (lanes.ok) {
      const ids = lanes.value.vector.map((r) => r.entry.id);
      expect(ids).toContain("live");
      expect(ids).not.toContain("evicted");
    }
  });

  it("vector-only search() (the fallback per-id read) omits a soft-evicted row", async () => {
    if (!isVecAvailable()) return; // vector-only search requires sqlite-vec
    const embeddingPort = createMockEmbeddingPort(4);
    adapter = new SqliteMemoryAdapter(testConfig, embeddingPort);
    await adapter.store(makeEntry({ id: "live", content: "dog naps in the sun", embedding: [0.1, 0.9, 0, 0] }));
    await adapter.store(makeEntry({ id: "evicted", content: "dog barks at noon", embedding: [0.1, 0.9, 0, 0] }));
    markEvicted("evicted", Date.now());

    // A number[] query exercises the vector-only branch (search :122-164).
    const res = await adapter.search(testSessionKey, [0.1, 0.9, 0, 0], { limit: 10 });
    expect(res.ok).toBe(true);
    if (res.ok) {
      const ids = res.value.map((r) => r.entry.id);
      expect(ids).toContain("live");
      expect(ids).not.toContain("evicted");
    }
  });

  it("the evicted row is STILL resolvable via an unfiltered inspect/asOf raw read (soft eviction)", async () => {
    adapter = new SqliteMemoryAdapter(testConfig);
    await adapter.store(makeEntry({ id: "evicted", content: "an audited but evicted fact about foxes" }));
    markEvicted("evicted", Date.now());

    // Recall (the live searchLanes path) excludes it…
    const lanes = await adapter.searchLanes!(testSessionKey, "foxes", { limit: 10 });
    expect(lanes.ok).toBe(true);
    if (lanes.ok) {
      expect(lanes.value.fts.map((r) => r.entry.id)).not.toContain("evicted");
    }
    // …but the raw inspect/asOf read does NOT add the filter, so the row survives.
    const raw = adapter
      .getDb()
      .prepare("SELECT id, evicted_at FROM memories WHERE id = 'evicted'")
      .get() as { id: string; evicted_at: number | null };
    expect(raw.id).toBe("evicted");
    expect(raw.evicted_at).not.toBeNull();
  });

  it("a NON-evicted row is recalled normally on searchLanes (no regression)", async () => {
    adapter = new SqliteMemoryAdapter(testConfig);
    await adapter.store(makeEntry({ id: "m1", content: "rabbit hops over the log" }));
    await adapter.store(makeEntry({ id: "m2", content: "rabbit nibbles the carrot" }));

    const lanes = await adapter.searchLanes!(testSessionKey, "rabbit", { limit: 10 });
    expect(lanes.ok).toBe(true);
    if (lanes.ok) {
      expect(lanes.value.fts.map((r) => r.entry.id).sort()).toEqual(["m1", "m2"]);
    }
  });
});

// ── occurredAtRange filter threaded into search + searchLanes ────
//
// The MemorySearchOptions.occurredAtRange field ANDs an `occurred_at BETWEEN`
// onto the ALREADY-scoped query on BOTH the search() and searchLanes() paths
// (recall prefers searchLanes when present, falls back to search — missing one
// is a silent no-op on that path; the MEMORY.md mcp_field_plumbing lesson).
// The range can only NARROW — a multi-agent range query returns
// ONLY the caller's agent's in-window rows. RED on pre-patch (the range is
// ignored on both paths).

describe("SqliteMemoryAdapter occurredAtRange — narrows on search + searchLanes", () => {
  let adapter: SqliteMemoryAdapter;
  const DAY = 86_400_000;
  const T0 = 100 * DAY;

  beforeEach(() => {
    adapter = new SqliteMemoryAdapter(testConfig);
  });

  afterEach(() => {
    try { adapter.close(); } catch { /* already closed */ }
  });

  it("search(): narrows to ONLY the in-window rows (out-of-window dropped)", async () => {
    await adapter.store(makeEntry({ id: "in1", content: "dentist appointment", occurredAt: T0 + 1 * DAY }));
    await adapter.store(makeEntry({ id: "after", content: "dentist appointment", occurredAt: T0 + 30 * DAY }));

    const ranged = await adapter.search(testSessionKey, "dentist", {
      limit: 10,
      occurredAtRange: { start: T0, end: T0 + 7 * DAY },
    });
    expect(ranged.ok).toBe(true);
    if (!ranged.ok) return;
    const ids = ranged.value.map((r) => r.entry.id);
    expect(ids).toContain("in1");
    expect(ids).not.toContain("after");

    // Without the range, both match (proving the range narrowed, not the query).
    const unranged = await adapter.search(testSessionKey, "dentist", { limit: 10 });
    expect(unranged.ok).toBe(true);
    if (unranged.ok) expect(unranged.value.length).toBe(2);
  });

  it("searchLanes(): narrows the FTS lane to ONLY the in-window rows (the recall hot path)", async () => {
    await adapter.store(makeEntry({ id: "in1", content: "dentist appointment", occurredAt: T0 + 1 * DAY }));
    await adapter.store(makeEntry({ id: "after", content: "dentist appointment", occurredAt: T0 + 30 * DAY }));

    const ranged = await adapter.searchLanes!(testSessionKey, "dentist", {
      limit: 10,
      occurredAtRange: { start: T0, end: T0 + 7 * DAY },
    });
    expect(ranged.ok).toBe(true);
    if (!ranged.ok) return;
    const ids = ranged.value.fts.map((r) => r.entry.id);
    expect(ids).toContain("in1");
    expect(ids).not.toContain("after"); // RED on pre-patch: searchLanes ignores the range

    // Without the range, both surface in the FTS lane.
    const unranged = await adapter.searchLanes!(testSessionKey, "dentist", { limit: 10 });
    expect(unranged.ok).toBe(true);
    if (unranged.ok) expect(unranged.value.fts.length).toBe(2);
  });

  it("a NULL occurred_at row drops out of BOTH paths when a range is set", async () => {
    await adapter.store(makeEntry({ id: "timed", content: "dentist appointment", occurredAt: T0 + 1 * DAY }));
    await adapter.store(makeEntry({ id: "untimed", content: "dentist appointment" })); // no occurredAt → NULL

    const s = await adapter.search(testSessionKey, "dentist", {
      limit: 10,
      occurredAtRange: { start: T0, end: T0 + 7 * DAY },
    });
    expect(s.ok).toBe(true);
    if (s.ok) {
      const ids = s.value.map((r) => r.entry.id);
      expect(ids).toContain("timed");
      expect(ids).not.toContain("untimed");
    }

    const l = await adapter.searchLanes!(testSessionKey, "dentist", {
      limit: 10,
      occurredAtRange: { start: T0, end: T0 + 7 * DAY },
    });
    expect(l.ok).toBe(true);
    if (l.ok) {
      const ids = l.value.fts.map((r) => r.entry.id);
      expect(ids).toContain("timed");
      expect(ids).not.toContain("untimed");
    }
  });

  it("range + agent scope returns ONLY the caller's agent's in-window rows (never widens scope)", async () => {
    // Two agents, both with an in-window row at the SAME occurred_at + same text.
    await adapter.store(makeEntry({ id: "mine", agentId: "agent_x", content: "dentist appointment", occurredAt: T0 + 1 * DAY }));
    await adapter.store(makeEntry({ id: "foreign", agentId: "agent_y", content: "dentist appointment", occurredAt: T0 + 1 * DAY }));

    const opts = { limit: 10, agentId: "agent_x", occurredAtRange: { start: T0, end: T0 + 7 * DAY } };

    const s = await adapter.search(testSessionKey, "dentist", opts);
    expect(s.ok).toBe(true);
    if (s.ok) {
      const ids = s.value.map((r) => r.entry.id);
      expect(ids).toContain("mine");
      expect(ids).not.toContain("foreign"); // range did NOT widen past the agent scope
    }

    const l = await adapter.searchLanes!(testSessionKey, "dentist", opts);
    expect(l.ok).toBe(true);
    if (l.ok) {
      const ids = l.value.fts.map((r) => r.entry.id);
      expect(ids).toContain("mine");
      expect(ids).not.toContain("foreign");
    }
  });
});

// ── pin / unpin agent-id scoping (CR-01) ─────────────────────────────
describe("SqliteMemoryAdapter — pin/unpin agent-id scoping (CR-01)", () => {
  let adapter: SqliteMemoryAdapter;

  beforeEach(() => {
    adapter = new SqliteMemoryAdapter(testConfig);
  });

  afterEach(() => {
    adapter.close();
  });

  function makeEntry(overrides?: Partial<MemoryEntry>): MemoryEntry {
    return {
      id: overrides?.id ?? crypto.randomUUID(),
      tenantId: overrides?.tenantId ?? "t1",
      agentId: overrides?.agentId ?? "agent-a",
      userId: "user-1",
      content: "test content",
      trustLevel: "learned",
      source: { who: "agent" },
      tags: [],
      createdAt: Date.now(),
    };
  }

  it("CR-01: pin with agentId does NOT pin the same id owned by a different agent", async () => {
    // Two entries with the SAME id prefix but owned by different agents.
    // Pinning for agent-a must NOT pin agent-b's entry.
    const idA = "shared-id-" + crypto.randomUUID();
    const entryA = makeEntry({ id: idA, tenantId: "t1", agentId: "agent-a" });
    const entryB = makeEntry({ id: crypto.randomUUID(), tenantId: "t1", agentId: "agent-b" });
    // Insert both entries directly so we can test scoping.
    await adapter.store(entryA);
    await adapter.store(entryB);

    // Pin agent-a's entry scoped to agent-a.
    const r = await adapter.pin(idA, "t1", "agent-a");
    expect(r.ok).toBe(true);
    expect(r.ok && r.value).toBe(true); // found + pinned

    // Verify entryB is NOT pinned (it belongs to agent-b).
    const pinnedB = adapter.getDb()
      .prepare("SELECT pinned FROM memories WHERE id = ?")
      .get(entryB.id) as { pinned: number } | undefined;
    expect(pinnedB?.pinned).toBe(0);

    // Verify entryA IS pinned.
    const pinnedA = adapter.getDb()
      .prepare("SELECT pinned FROM memories WHERE id = ?")
      .get(idA) as { pinned: number } | undefined;
    expect(pinnedA?.pinned).toBe(1);
  });

  it("CR-01: pin with wrong agentId returns ok(false) — id exists but in different agent scope", async () => {
    // Entry owned by agent-b; trying to pin it as agent-a must return ok(false) (not found in scope).
    const id = crypto.randomUUID();
    const entry = makeEntry({ id, tenantId: "t1", agentId: "agent-b" });
    await adapter.store(entry);

    // Pin with the wrong agentId — must be a no-op (returns false, not an error).
    const r = await adapter.pin(id, "t1", "agent-a");
    expect(r.ok).toBe(true);
    expect(r.ok && r.value).toBe(false); // NOT found in agent-a's scope

    // The entry must remain unpinned.
    const row = adapter.getDb()
      .prepare("SELECT pinned FROM memories WHERE id = ?")
      .get(id) as { pinned: number } | undefined;
    expect(row?.pinned).toBe(0);
  });
});

// ── listPinned expiry filter (CR-02) ─────────────────────────────────
describe("SqliteMemoryAdapter — listPinned does not return expired pinned entries (CR-02)", () => {
  let adapter: SqliteMemoryAdapter;

  beforeEach(() => {
    adapter = new SqliteMemoryAdapter(testConfig);
  });

  afterEach(() => {
    adapter.close();
  });

  it("CR-02: listPinned excludes an expired pinned entry", async () => {
    const db = adapter.getDb();
    const now = Date.now();
    // Insert a pinned entry that is already expired.
    const expiredId = crypto.randomUUID();
    db.prepare(
      `INSERT INTO memories (id, tenant_id, agent_id, user_id, content, trust_level, memory_type,
        source_who, tags, created_at, expires_at, has_embedding)
       VALUES (?, 't1', 'agent-a', 'user-1', 'expired pinned', 'learned', 'semantic', 'agent', '[]', ?, ?, 0)`,
    ).run(expiredId, now - 10000, now - 1000); // expires_at in the past
    db.prepare("UPDATE memories SET pinned = 1 WHERE id = ?").run(expiredId);

    // Insert a live pinned entry.
    const liveId = crypto.randomUUID();
    db.prepare(
      `INSERT INTO memories (id, tenant_id, agent_id, user_id, content, trust_level, memory_type,
        source_who, tags, created_at, expires_at, has_embedding)
       VALUES (?, 't1', 'agent-a', 'user-1', 'live pinned', 'learned', 'semantic', 'agent', '[]', ?, NULL, 0)`,
    ).run(liveId, now - 5000);
    db.prepare("UPDATE memories SET pinned = 1 WHERE id = ?").run(liveId);

    const result = await adapter.listPinned({ tenantId: "t1", agentId: "agent-a" }, 10);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const ids = result.value.map((r) => r.entry.id);
    expect(ids).toContain(liveId);
    expect(ids).not.toContain(expiredId); // expired entries must NOT appear
  });
});

// ── LTM trigram lane: I4 recall + twin writes + R4 + consolidation (180-06) ──
//
// End-to-end through the REAL adapter with NO embedding provider (I4 by
// construction — `new SqliteMemoryAdapter(testConfig)` has no EmbeddingPort, so
// the FTS floor alone must carry recall). RED proof on pre-patch code:
//   - store() does NOT write a memory_fts_tri twin row (row-mapper writes only
//     the base row) → the twin SELECT finds nothing;
//   - searchByText routes ONLY the porter word lane → a non-Latin morphology
//     query returns [] through BOTH search() and searchLanes();
//   - foldIntoExisting() on a REAL content rewrite leaves NO normalized twin row
//     (the 180-02 WHEN-guarded trigger deleted the old one; the TS re-insert is
//     this plan's job) — while the proof-only fold must leave an existing twin
//     row INTACT (the COALESCE(NULL, content) no-op + the WHEN guard).
// All non-Latin glyphs are assembled from codepoints (WR-01).
describe("SqliteMemoryAdapter LTM trigram lane (I4 / twin / R4 / consolidation)", () => {
  // Stored / query pairs (codepoint-assembled).
  const HE_STORED = String.fromCodePoint(0x5d4, 0x5e1, 0x5e4, 0x5e8, 0x5d9, 0x5dd); // הספרים
  const HE_QUERY = String.fromCodePoint(0x5e1, 0x5e4, 0x5e8); // ספר
  const HE_FOLDED = String.fromCodePoint(0x5d4, 0x5e1, 0x5e4, 0x5e8, 0x5d9, 0x5de); // הספרימ (final mem folded)
  const AR_STORED = String.fromCodePoint(0x648, 0x627, 0x644, 0x643, 0x62a, 0x627, 0x628); // والكتاب
  const AR_QUERY = String.fromCodePoint(0x643, 0x62a, 0x627, 0x628); // كتاب
  const RU_STORED = String.fromCodePoint(0x43a, 0x43d, 0x438, 0x433, 0x438); // книги
  const RU_QUERY = String.fromCodePoint(0x43a, 0x43d, 0x438, 0x433, 0x430); // книга
  const CJK_STORED = "我喜欢读中文书籍";
  const CJK_QUERY = "中文书";

  let adapter: SqliteMemoryAdapter;

  beforeEach(() => {
    // NO embedding port → I4 (vector lane absent; FTS floor must carry recall).
    adapter = new SqliteMemoryAdapter(testConfig);
  });

  afterEach(() => {
    adapter.close();
  });

  /** Normalized content of the memory_fts_tri twin row for a memory id (the
   *  twin shares the base rowid), or undefined when no twin row exists. */
  function twinContentOf(id: string): string | undefined {
    const db = adapter.getDb();
    const row = db
      .prepare(
        "SELECT content FROM memory_fts_tri WHERE rowid = (SELECT rowid FROM memories WHERE id = ?)",
      )
      .get(id) as { content: string } | undefined;
    return row?.content;
  }

  // ── twin writes ──────────────────────────────────────────────────

  it("store() writes a NORMALIZED memory_fts_tri twin row (folded finals)", async () => {
    const id = crypto.randomUUID();
    await adapter.store(makeEntry({ id, content: HE_STORED }));
    // הספרים → הספרימ (final mem folds in normalizeForSearch).
    expect(twinContentOf(id)).toBe(HE_FOLDED);
  });

  it("every store() insert path writes a twin row (the insertMemoryRow chokepoint covers v1.7 import)", async () => {
    // The portability/import path inserts through adapter.store() →
    // insertMemoryRow (one chokepoint), so a stored row MUST carry a twin row.
    const id = crypto.randomUUID();
    await adapter.store(makeEntry({ id, content: "docker compose notes" }));
    expect(twinContentOf(id)).toBe(normalizeForSearch("docker compose notes"));
  });

  // ── I4 recall through search() AND searchLanes() ─────────────────

  it("search() recalls he/ar/ru/CJK memories with embeddings disabled (I4)", async () => {
    const he = crypto.randomUUID();
    const ar = crypto.randomUUID();
    const ru = crypto.randomUUID();
    const cjk = crypto.randomUUID();
    await adapter.store(makeEntry({ id: he, content: HE_STORED }));
    await adapter.store(makeEntry({ id: ar, content: AR_STORED }));
    await adapter.store(makeEntry({ id: ru, content: RU_STORED }));
    await adapter.store(makeEntry({ id: cjk, content: CJK_STORED }));

    for (const [query, id] of [
      [HE_QUERY, he],
      [AR_QUERY, ar],
      [RU_QUERY, ru],
      [CJK_QUERY, cjk],
    ] as const) {
      const r = await adapter.search(testSessionKey, query, { limit: 10 });
      expect(r.ok).toBe(true);
      if (!r.ok) continue;
      expect(r.value.map((m) => m.entry.id)).toContain(id);
    }
  });

  it("searchLanes() returns he/ar/ru/CJK memories in the FTS lane with embeddings disabled (I4)", async () => {
    const he = crypto.randomUUID();
    const ru = crypto.randomUUID();
    await adapter.store(makeEntry({ id: he, content: HE_STORED }));
    await adapter.store(makeEntry({ id: ru, content: RU_STORED }));

    const rHe = await adapter.searchLanes(testSessionKey, HE_QUERY, { limit: 10 });
    expect(rHe.ok).toBe(true);
    if (rHe.ok) expect(rHe.value.fts.map((m) => m.entry.id)).toContain(he);

    const rRu = await adapter.searchLanes(testSessionKey, RU_QUERY, { limit: 10 });
    expect(rRu.ok).toBe(true);
    if (rRu.ok) expect(rRu.value.fts.map((m) => m.entry.id)).toContain(ru);
  });

  // ── R4 isolation on the trigram lane, both directions ────────────

  it("R4: search() never returns another AGENT's Hebrew memory (both directions)", async () => {
    const idA = crypto.randomUUID();
    const idB = crypto.randomUUID();
    await adapter.store(makeEntry({ id: idA, agentId: "agent-a", content: HE_STORED }));
    await adapter.store(makeEntry({ id: idB, agentId: "agent-b", content: HE_STORED }));

    const asA = await adapter.search(testSessionKey, HE_QUERY, { limit: 10, agentId: "agent-a" });
    expect(asA.ok).toBe(true);
    if (asA.ok) {
      const ids = asA.value.map((m) => m.entry.id);
      expect(ids).toContain(idA);
      expect(ids).not.toContain(idB);
    }

    const asB = await adapter.search(testSessionKey, HE_QUERY, { limit: 10, agentId: "agent-b" });
    expect(asB.ok).toBe(true);
    if (asB.ok) {
      const ids = asB.value.map((m) => m.entry.id);
      expect(ids).toContain(idB);
      expect(ids).not.toContain(idA);
    }
  });

  it("R4: searchLanes() never returns another AGENT's Hebrew memory (hydration filter)", async () => {
    const idA = crypto.randomUUID();
    const idB = crypto.randomUUID();
    await adapter.store(makeEntry({ id: idA, agentId: "agent-a", content: HE_STORED }));
    await adapter.store(makeEntry({ id: idB, agentId: "agent-b", content: HE_STORED }));

    const lanesA = await adapter.searchLanes(testSessionKey, HE_QUERY, { limit: 10, agentId: "agent-a" });
    expect(lanesA.ok).toBe(true);
    if (lanesA.ok) {
      const ids = lanesA.value.fts.map((m) => m.entry.id);
      expect(ids).toContain(idA);
      expect(ids).not.toContain(idB);
    }
  });

  it("R4: search() never returns another TENANT's Hebrew memory (both directions)", async () => {
    const keyT1: SessionKey = { tenantId: "tenant-1", userId: "u", channelId: "c" };
    const keyT2: SessionKey = { tenantId: "tenant-2", userId: "u", channelId: "c" };
    const id1 = crypto.randomUUID();
    const id2 = crypto.randomUUID();
    await adapter.store(makeEntry({ id: id1, tenantId: "tenant-1", content: HE_STORED }));
    await adapter.store(makeEntry({ id: id2, tenantId: "tenant-2", content: HE_STORED }));

    const t1 = await adapter.search(keyT1, HE_QUERY, { limit: 10 });
    expect(t1.ok).toBe(true);
    if (t1.ok) {
      const ids = t1.value.map((m) => m.entry.id);
      expect(ids).toContain(id1);
      expect(ids).not.toContain(id2);
    }

    const t2 = await adapter.search(keyT2, HE_QUERY, { limit: 10 });
    expect(t2.ok).toBe(true);
    if (t2.ok) {
      const ids = t2.value.map((m) => m.entry.id);
      expect(ids).toContain(id2);
      expect(ids).not.toContain(id1);
    }
  });

  // ── consolidation rewrite re-inserts the normalized twin ─────────

  it("a REAL content rewrite via the consolidation store re-inserts a normalized twin row", async () => {
    const db = adapter.getDb();
    const store = createSqliteMemoryConsolidationStore({ db });

    // Seed an OBSERVATION (proof_count IS NOT NULL) carrying Latin content, then
    // fold in a Hebrew rewrite. After the rewrite the trigger deleted the old
    // twin row; the TS re-insert must restore a twin row with the NEW normalized
    // content (so HE_QUERY recalls it with embeddings disabled).
    // store() writes the base row + its twin; promote it to an observation via a
    // direct proof_count UPDATE (makeEntry does not carry observation fields).
    // The UPDATE does NOT touch content, so the store-written twin survives.
    const obsId = crypto.randomUUID();
    await adapter.store(makeEntry({ id: obsId, content: "original english observation" }));
    db.prepare("UPDATE memories SET proof_count = 1, source_ids = ? WHERE id = ?").run(
      JSON.stringify(["s0"]),
      obsId,
    );

    const fold = await store.foldIntoExisting({
      targetObservationId: obsId,
      newSourceIds: ["s1"],
      trustLevel: "learned",
      confidence: 1,
      occurredAt: 2_000,
      content: HE_STORED, // a REAL rewrite to Hebrew
      tenantId: "default",
      now: 3_000,
    });
    expect(fold.ok).toBe(true);

    // The twin row exists again and holds the NEW normalized content.
    const twin = db
      .prepare(
        "SELECT content FROM memory_fts_tri WHERE rowid = (SELECT rowid FROM memories WHERE id = ?)",
      )
      .get(obsId) as { content: string } | undefined;
    expect(twin?.content).toBe(HE_FOLDED);

    // And recall now bridges the morphology with embeddings disabled.
    const r = await adapter.search(testSessionKey, HE_QUERY, { limit: 10 });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.map((m) => m.entry.id)).toContain(obsId);
  });

  it("a proof-only fold (COALESCE(NULL, content) no-op) leaves the existing twin row INTACT", async () => {
    const db = adapter.getDb();
    const store = createSqliteMemoryConsolidationStore({ db });

    // Seed a Hebrew observation; store() wrote its normalized twin row. Promote
    // it to an observation via a direct proof_count UPDATE (content untouched →
    // the store-written twin survives; makeEntry carries no observation fields).
    const obsId = crypto.randomUUID();
    await adapter.store(makeEntry({ id: obsId, content: HE_STORED }));
    db.prepare("UPDATE memories SET proof_count = 1, source_ids = ? WHERE id = ?").run(
      JSON.stringify(["s0"]),
      obsId,
    );
    expect(twinContentOf(obsId)).toBe(HE_FOLDED);

    // A proof-only fold omits content → growObservation binds null →
    // COALESCE(NULL, content) is a no-op → the WHEN-guarded trigger does NOT
    // fire → the twin row must remain untouched (NOT de-indexed, NOT duplicated).
    const fold = await store.foldIntoExisting({
      targetObservationId: obsId,
      newSourceIds: ["s1"],
      trustLevel: "learned",
      confidence: 1,
      occurredAt: 2_000,
      // content omitted — the proof-only fold
      tenantId: "default",
      now: 3_000,
    });
    expect(fold.ok).toBe(true);

    // Exactly one twin row, still the original normalized content.
    const rows = db
      .prepare(
        "SELECT content FROM memory_fts_tri WHERE rowid = (SELECT rowid FROM memories WHERE id = ?)",
      )
      .all(obsId) as Array<{ content: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.content).toBe(HE_FOLDED);
    // Recall still works (the twin survived the proof-only fold).
    const r = await adapter.search(testSessionKey, HE_QUERY, { limit: 10 });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.map((m) => m.entry.id)).toContain(obsId);
  });
});
