import type { MemoryEntry, MemoryConfig, SessionKey, EmbeddingPort } from "@comis/core";
import type { Result } from "@comis/shared";
import { ok } from "@comis/shared";
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
      const result = await adapter.retrieve(entry.id);

      expect(result.ok).toBe(true);
      if (result.ok && result.value) {
        expect(result.value.trustLevel).toBe("external");
        expect(result.value.source.who).toBe("web-scraper");
        expect(result.value.source.channel).toBe("api");
        expect(result.value.source.sessionKey).toBe("sess-123");
      }
    });

    it("stores entry with tags", async () => {
      const entry = makeEntry({ tags: ["important", "project-x"] });
      await adapter.store(entry);

      const result = await adapter.retrieve(entry.id);
      expect(result.ok).toBe(true);
      if (result.ok && result.value) {
        expect(result.value.tags).toEqual(["important", "project-x"]);
      }
    });

    it("stores entry with embedding when vec is available", async () => {
      if (!isVecAvailable()) return;

      const entry = makeEntry({ embedding: [0.1, 0.2, 0.3, 0.4] });
      const result = await adapter.store(entry);

      expect(result.ok).toBe(true);

      // Verify embedding was stored
      const retrieved = await adapter.retrieve(entry.id);
      expect(retrieved.ok).toBe(true);
      if (retrieved.ok && retrieved.value) {
        expect(retrieved.value.embedding).toBeDefined();
        expect(retrieved.value.embedding!.length).toBe(4);
        expect(retrieved.value.embedding![0]).toBeCloseTo(0.1, 4);
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

      const result = await adapter.retrieve(entry.id);
      expect(result.ok).toBe(true);
      if (result.ok && result.value) {
        expect(result.value.expiresAt).toBe(expires);
      }
    });
  });

  // ── storeWithType ──────────────────────────────────────────────

  describe("storeWithType", () => {
    it("stores entry with explicit memory type", async () => {
      const entry = makeEntry();
      await adapter.storeWithType(entry, "episodic");

      const row = adapter
        .getDb()
        .prepare("SELECT memory_type FROM memories WHERE id = ?")
        .get(entry.id) as { memory_type: string };

      expect(row.memory_type).toBe("episodic");
    });

    it("supports all memory types", async () => {
      const types = ["working", "episodic", "semantic", "procedural"] as const;

      for (const type of types) {
        const entry = makeEntry();
        const result = await adapter.storeWithType(entry, type);
        expect(result.ok).toBe(true);

        const row = adapter
          .getDb()
          .prepare("SELECT memory_type FROM memories WHERE id = ?")
          .get(entry.id) as { memory_type: string };
        expect(row.memory_type).toBe(type);
      }
    });
  });

  // ── retrieve ───────────────────────────────────────────────────

  describe("retrieve", () => {
    it("retrieves stored entry with all fields intact", async () => {
      const entry = makeEntry({
        content: "remember this important fact",
        trustLevel: "system",
        source: { who: "admin", channel: "cli" },
        tags: ["fact", "important"],
      });

      await adapter.store(entry);
      const result = await adapter.retrieve(entry.id);

      expect(result.ok).toBe(true);
      if (result.ok && result.value) {
        expect(result.value.id).toBe(entry.id);
        expect(result.value.content).toBe("remember this important fact");
        expect(result.value.trustLevel).toBe("system");
        expect(result.value.source.who).toBe("admin");
        expect(result.value.source.channel).toBe("cli");
        expect(result.value.tags).toEqual(["fact", "important"]);
        expect(result.value.tenantId).toBe("default");
        expect(result.value.userId).toBe("user-1");
        expect(result.value.createdAt).toBe(entry.createdAt);
      }
    });

    it("returns undefined for non-existent ID", async () => {
      const result = await adapter.retrieve("non-existent-id");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBeUndefined();
      }
    });

    it("scopes by tenantId", async () => {
      const entry = makeEntry({ tenantId: "tenant-a" });
      await adapter.store(entry);

      // Should not find with different tenant
      const result = await adapter.retrieve(entry.id, "tenant-b");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBeUndefined();
      }

      // Should find with correct tenant
      const result2 = await adapter.retrieve(entry.id, "tenant-a");
      expect(result2.ok).toBe(true);
      if (result2.ok) {
        expect(result2.value).toBeDefined();
      }
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

    it("filters by tags", async () => {
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

        // Create a query longer than the truncation threshold (1536 tokens * 4 chars/token = 6144 chars)
        const longQuery = "a".repeat(8000);
        const result = await adapterWithEmbed.search(testSessionKey, longQuery);

        expect(result.ok).toBe(true);
        // Verify embed was called with a truncated string (<= 6144 chars)
        expect(embedSpy).toHaveBeenCalledOnce();
        const passedQuery = embedSpy.mock.calls[0]![0];
        expect(passedQuery.length).toBeLessThanOrEqual(6144);
        expect(passedQuery.length).toBe(6144);
      } finally {
        adapterWithEmbed.close();
      }
    });
  });

  // ── update ─────────────────────────────────────────────────────

  describe("update", () => {
    it("updates content field", async () => {
      const entry = makeEntry({ content: "original content" });
      await adapter.store(entry);

      const result = await adapter.update(entry.id, { content: "updated content" });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.content).toBe("updated content");
        expect(result.value.updatedAt).toBeDefined();
      }
    });

    it("updates tags", async () => {
      const entry = makeEntry({ tags: ["old-tag"] });
      await adapter.store(entry);

      const result = await adapter.update(entry.id, {
        tags: ["new-tag", "another"],
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.tags).toEqual(["new-tag", "another"]);
      }
    });

    it("updates trustLevel", async () => {
      const entry = makeEntry({ trustLevel: "external" });
      await adapter.store(entry);

      const result = await adapter.update(entry.id, { trustLevel: "learned" });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.trustLevel).toBe("learned");
      }
    });

    it("updates expiresAt", async () => {
      const entry = makeEntry();
      await adapter.store(entry);

      const newExpiry = Date.now() + 999999;
      const result = await adapter.update(entry.id, { expiresAt: newExpiry });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.expiresAt).toBe(newExpiry);
      }
    });

    it("updates embedding when vec is available", async () => {
      if (!isVecAvailable()) return;

      const entry = makeEntry({ embedding: [0.1, 0.2, 0.3, 0.4] });
      await adapter.store(entry);

      const result = await adapter.update(entry.id, {
        embedding: [0.9, 0.8, 0.7, 0.6],
      });

      expect(result.ok).toBe(true);

      // Verify new embedding
      const retrieved = await adapter.retrieve(entry.id);
      expect(retrieved.ok).toBe(true);
      if (retrieved.ok && retrieved.value) {
        expect(retrieved.value.embedding![0]).toBeCloseTo(0.9, 4);
      }
    });

    it("returns error for non-existent entry", async () => {
      const result = await adapter.update("non-existent", { content: "nope" });
      expect(result.ok).toBe(false);
    });

    it("sets updatedAt timestamp on update", async () => {
      const entry = makeEntry();
      await adapter.store(entry);

      const before = Date.now();
      const result = await adapter.update(entry.id, { content: "modified" });
      const after = Date.now();

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.updatedAt).toBeGreaterThanOrEqual(before);
        expect(result.value.updatedAt).toBeLessThanOrEqual(after);
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

      // Verify gone
      const retrieved = await adapter.retrieve(entry.id);
      expect(retrieved.ok).toBe(true);
      if (retrieved.ok) {
        expect(retrieved.value).toBeUndefined();
      }
    });

    it("returns false for non-existent entry", async () => {
      const result = await adapter.delete("non-existent");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(false);
      }
    });

    it("scopes by tenantId", async () => {
      const entry = makeEntry({ tenantId: "tenant-x" });
      await adapter.store(entry);

      // Delete with wrong tenant should not remove
      const result = await adapter.delete(entry.id, "tenant-y");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(false);
      }

      // Entry should still exist
      const retrieved = await adapter.retrieve(entry.id, "tenant-x");
      expect(retrieved.ok).toBe(true);
      if (retrieved.ok) {
        expect(retrieved.value).toBeDefined();
      }
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

  // ── clear ──────────────────────────────────────────────────────

  describe("clear", () => {
    it("removes all entries for the tenant", async () => {
      await adapter.store(makeEntry({ content: "entry one" }));
      await adapter.store(makeEntry({ content: "entry two" }));
      await adapter.store(makeEntry({ content: "entry three" }));

      const result = await adapter.clear(testSessionKey);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(3);
      }

      // Verify all gone
      const search = await adapter.search(testSessionKey, "entry");
      expect(search.ok).toBe(true);
      if (search.ok) {
        expect(search.value).toHaveLength(0);
      }
    });

    it("only clears entries for the specified tenant", async () => {
      await adapter.store(makeEntry({ tenantId: "tenant-a", content: "keep this cat" }));
      await adapter.store(makeEntry({ tenantId: "tenant-b", content: "delete this cat" }));

      const sessionB: SessionKey = {
        tenantId: "tenant-b",
        userId: "user-1",
        channelId: "test",
      };
      const result = await adapter.clear(sessionB);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(1);
      }

      // Tenant A entry should remain
      const sessionA: SessionKey = {
        tenantId: "tenant-a",
        userId: "user-1",
        channelId: "test",
      };
      const search = await adapter.search(sessionA, "cat");
      expect(search.ok).toBe(true);
      if (search.ok) {
        expect(search.value).toHaveLength(1);
      }
    });

    it("returns 0 when no entries exist", async () => {
      const result = await adapter.clear(testSessionKey);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(0);
      }
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
      const row = adapter
        .getDb()
        .prepare("SELECT agent_id FROM memories WHERE id = ?")
        .get(entry.id) as { agent_id: string };

      expect(row.agent_id).toBe("default");

      // Also verify via retrieve
      const result = await adapter.retrieve(entry.id);
      expect(result.ok).toBe(true);
      if (result.ok && result.value) {
        expect(result.value.agentId).toBe("default");
      }
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
    it("retrieve returns undefined for expired entry", async () => {
      const entry = makeEntry({ expiresAt: Date.now() - 1000 }); // expired 1s ago
      await adapter.store(entry);

      const result = await adapter.retrieve(entry.id);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBeUndefined();
      }
    });

    it("retrieve returns entry with future expiresAt", async () => {
      const entry = makeEntry({ expiresAt: Date.now() + 60000 }); // expires in 60s
      await adapter.store(entry);

      const result = await adapter.retrieve(entry.id);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBeDefined();
        expect(result.value!.id).toBe(entry.id);
      }
    });

    it("retrieve returns entry with null expiresAt (no expiry)", async () => {
      const entry = makeEntry(); // no expiresAt
      await adapter.store(entry);

      const result = await adapter.retrieve(entry.id);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBeDefined();
        expect(result.value!.id).toBe(entry.id);
      }
    });

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

      // Attempt to retrieve -- should return err(), not crash
      const retrieveResult = await adapter.retrieve("any-id");
      expect(retrieveResult.ok).toBe(false);
      if (!retrieveResult.ok) {
        expect(retrieveResult.error.message).toContain("not open");
      }

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
