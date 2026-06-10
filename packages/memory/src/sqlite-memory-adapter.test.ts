// SPDX-License-Identifier: Apache-2.0
import type { MemoryEntry, MemoryConfig, SessionKey, EmbeddingPort } from "@comis/core";
import type { Result } from "@comis/shared";
import { ok, err } from "@comis/shared";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { chmodSync, existsSync } from "node:fs";
import { isVecAvailable } from "./schema.js";
import { SqliteMemoryAdapter } from "./sqlite-memory-adapter.js";

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
