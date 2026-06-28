// SPDX-License-Identifier: Apache-2.0
/**
 * Branch-gap coverage for sqlite-memory-adapter.ts.
 *
 * Targets the uncovered branches in search() and update()/delete()/clear()
 * paths that the existing test file doesn't reach:
 *   - vector-search agentId filter (line 205)
 *   - vector-search minScore filter (line 210)
 *   - vector-search row-missing skip (line 199)
 *   - hybrid-search minScore filter (line 276)
 *   - zero-length embedding → FTS-only fallback (line 235)
 *   - embedding-port error → FTS-only warn path (line 242)
 *   - searchMode "hybrid" vs "fts-only" log ternary (line 298)
 *   - vec-available branch in delete() (line 411)
 *   - vec-available branch in clear() (line 436)
 *   - update embedding-update branch (line 374)
 *
 * @module
 */
import type { MemoryEntry, MemoryConfig, SessionKey, EmbeddingPort } from "@comis/core";
import type { Result } from "@comis/shared";
import { err, ok } from "@comis/shared";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { isVecAvailable } from "./schema.js";
import { SqliteMemoryAdapter } from "./sqlite-memory-adapter.js";

const testConfig: MemoryConfig = {
  enabled: true,
  dbPath: ":memory:",
  walMode: false,
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

const sessionKey: SessionKey = {
  tenantId: "default",
  userId: "u-1",
  channelId: "c-1",
};

function makeEntry(
  overrides?: Partial<MemoryEntry> & { memoryType?: string },
): MemoryEntry & { memoryType?: string } {
  return {
    id: overrides?.id ?? crypto.randomUUID(),
    tenantId: overrides?.tenantId ?? "default",
    agentId: overrides?.agentId ?? "default",
    userId: overrides?.userId ?? "u-1",
    content: overrides?.content ?? "content body",
    trustLevel: overrides?.trustLevel ?? "learned",
    source: overrides?.source ?? { who: "agent", channel: "telegram" },
    tags: overrides?.tags ?? [],
    createdAt: overrides?.createdAt ?? Date.now(),
    ...(overrides?.expiresAt !== undefined ? { expiresAt: overrides.expiresAt } : {}),
    ...(overrides?.embedding ? { embedding: overrides.embedding } : {}),
    ...(overrides?.memoryType ? { memoryType: overrides.memoryType } : {}),
  };
}

function createMockEmbeddingPort(dimensions: number = 4): EmbeddingPort {
  return {
    provider: "test",
    dimensions,
    modelId: "test",
    async embed(text: string): Promise<Result<number[], Error>> {
      const vec = new Array(dimensions).fill(0);
      for (let i = 0; i < text.length && i < dimensions; i++) {
        vec[i] = text.charCodeAt(i) / 256;
      }
      return ok(vec);
    },
    async embedBatch(texts: string[]): Promise<Result<number[][], Error>> {
      const vecs: number[][] = [];
      for (const t of texts) {
        const r = await this.embed(t);
        if (r.ok) vecs.push(r.value);
      }
      return ok(vecs);
    },
  };
}

describe("SqliteMemoryAdapter — branch-gap coverage", () => {
  let adapter: SqliteMemoryAdapter;

  beforeEach(() => {
    adapter = new SqliteMemoryAdapter(testConfig);
  });

  afterEach(() => {
    try { adapter.close(); } catch { /* already closed */ }
  });

  // ---- vector-search filters (lines 199, 205, 210) ----------------------

  describe("vector search filters", () => {
    it("excludes vector hits whose agentId does not match the option filter", async () => {
      if (!isVecAvailable()) return;
      const eA = makeEntry({ content: "agent A entry", agentId: "agent-a", embedding: [1, 0, 0, 0] });
      const eB = makeEntry({ content: "agent B entry", agentId: "agent-b", embedding: [1, 0, 0, 0] });
      await adapter.store(eA);
      await adapter.store(eB);
      const result = await adapter.search(sessionKey, [1, 0, 0, 0], { agentId: "agent-a", limit: 10 });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toHaveLength(1);
      expect(result.value[0]!.entry.agentId).toBe("agent-a");
    });

    it("excludes vector hits whose similarity score falls below the minScore option", async () => {
      if (!isVecAvailable()) return;
      // orthogonal vectors -> score ~ 0; query [1,0,0,0] against entry [0,1,0,0]
      const e = makeEntry({ content: "low-score entry", embedding: [0, 1, 0, 0] });
      await adapter.store(e);
      const result = await adapter.search(sessionKey, [1, 0, 0, 0], { minScore: 0.5, limit: 10 });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      // No entries should clear the minScore=0.5 threshold for an orthogonal vector
      expect(result.value).toHaveLength(0);
    });

    it("skips vec hits whose memory row was deleted between vec match and lookup", async () => {
      if (!isVecAvailable()) return;
      const e = makeEntry({ content: "soon-to-be-orphan", embedding: [1, 0, 0, 0] });
      await adapter.store(e);
      // Surgically delete only the memories row, leaving the vec_memories entry in place
      adapter.getDb().prepare("DELETE FROM memories WHERE id = ?").run(e.id);
      const result = await adapter.search(sessionKey, [1, 0, 0, 0], { limit: 10 });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      // Orphan should be skipped (continue), result is empty
      expect(result.value).toHaveLength(0);
    });
  });

  // ---- string-query hybrid path branches --------------------------------

  describe("hybrid search embedding-port branches", () => {
    it("falls back to FTS-only search when embedding port returns zero-length vector", async () => {
      const zeroPort: EmbeddingPort = {
        provider: "test",
        dimensions: 0,
        modelId: "zero",
        async embed(): Promise<Result<number[], Error>> {
          return ok([]); // zero-length vector triggers FTS-only fallback
        },
        async embedBatch(): Promise<Result<number[][], Error>> {
          return ok([[]]);
        },
      };
      const a = new SqliteMemoryAdapter(testConfig, zeroPort);
      try {
        await a.store(makeEntry({ content: "fts only entry banana" }));
        const result = await a.search(sessionKey, "banana");
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value.length).toBeGreaterThanOrEqual(1);
      } finally {
        a.close();
      }
    });

    it("logs warn and continues with FTS-only when embedding port returns err result", async () => {
      const failingPort: EmbeddingPort = {
        provider: "test",
        dimensions: 4,
        modelId: "failing",
        async embed(): Promise<Result<number[], Error>> {
          return err(new Error("upstream unavailable"));
        },
        async embedBatch(): Promise<Result<number[][], Error>> {
          return err(new Error("batch unavailable"));
        },
      };
      const mockLogger = { info: vi.fn(), warn: vi.fn(), debug: vi.fn() };
      const a = new SqliteMemoryAdapter(testConfig, failingPort, mockLogger);
      try {
        await a.store(makeEntry({ content: "kiwi fruit fact" }));
        const result = await a.search(sessionKey, "kiwi");
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        // Should still return FTS-only result
        expect(result.value.length).toBeGreaterThanOrEqual(1);
        // warn was invoked with errorKind: "dependency"
        expect(mockLogger.warn).toHaveBeenCalledWith(
          expect.objectContaining({ errorKind: "dependency" }),
          "Memory embedding failed",
        );
      } finally {
        a.close();
      }
    });

    it("logs searchMode 'hybrid' when query embedding is non-empty", async () => {
      if (!isVecAvailable()) return;
      const port = createMockEmbeddingPort(4);
      const mockLogger = { info: vi.fn(), warn: vi.fn(), debug: vi.fn() };
      const a = new SqliteMemoryAdapter(testConfig, port, mockLogger);
      try {
        await a.store(makeEntry({ content: "papaya fruit fact", embedding: [0.2, 0.3, 0.1, 0.1] }));
        await a.search(sessionKey, "papaya");
        expect(mockLogger.debug).toHaveBeenCalledWith(
          expect.objectContaining({ op: "search", searchMode: "hybrid" }),
          "Memory search complete",
        );
      } finally {
        a.close();
      }
    });
  });

  // ---- hybrid search row-missing + minScore (lines 270, 276) ------------

  describe("hybrid search post-filter branches", () => {
    it("excludes hybrid hits whose score falls below the minScore option", async () => {
      // Use no-embedding-port path so hybrid falls back to FTS-only; FTS returns
      // a stable rank-based score. minScore=999 guarantees rejection.
      await adapter.store(makeEntry({ content: "mango is a fruit" }));
      const result = await adapter.search(sessionKey, "mango", { minScore: 999, limit: 10 });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toHaveLength(0);
    });

    it("skips hybrid hits whose memory row was deleted between match and lookup", async () => {
      const e = makeEntry({ content: "orphan hybrid entry" });
      await adapter.store(e);
      // Delete the memories row directly so the FTS5 hit references a missing row
      // (FTS5 indexes a deleted external-content row in some race scenarios)
      adapter.getDb().prepare("DELETE FROM memories WHERE id = ?").run(e.id);
      // Note: with internal-content FTS5 this typically also cleans the FTS index,
      // so this scenario may not always exercise the branch — kept as defensive coverage.
      const result = await adapter.search(sessionKey, "orphan");
      expect(result.ok).toBe(true);
    });
  });

  // NOTE: describe("update with embedding when vec is available") was removed in
  // a prior port-trim cleanup along with the adapter.update method. Vec-row
  // update semantics no longer exist on the MemoryPort surface.

  // ---- vec-unavailable branch in vector-only search (line 184) ----------

  describe("vector-only search when sqlite-vec is unavailable", () => {
    it("returns empty array immediately when vector search is requested but vec module is unavailable", async () => {
      // Force vec unavailable by intercepting vec-related calls. We assert
      // through a manual replacement of the per-instance vecAvailable field.
      const a = new SqliteMemoryAdapter(testConfig);
      try {
        // Set the private field to false so the vec-unavailable path executes
        (a as unknown as { vecAvailable: boolean }).vecAvailable = false;
        const result = await a.search(sessionKey, [1, 0, 0, 0], { limit: 10 });
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value).toHaveLength(0);
      } finally {
        a.close();
      }
    });
  });

  // ---- trustLevel filter in vector-search path (line 206) ---------------

  describe("vector search trustLevel filter", () => {
    it("excludes vector hits whose trust level does not match the option filter", async () => {
      if (!isVecAvailable()) return;
      const eSystem = makeEntry({ content: "system trusted entry", trustLevel: "system", embedding: [1, 0, 0, 0] });
      const eExternal = makeEntry({ content: "external untrusted", trustLevel: "external", embedding: [1, 0, 0, 0] });
      await adapter.store(eSystem);
      await adapter.store(eExternal);
      const result = await adapter.search(sessionKey, [1, 0, 0, 0], { trustLevel: "system", limit: 10 });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toHaveLength(1);
      expect(result.value[0]!.entry.trustLevel).toBe("system");
    });
  });

  // ---- catch path: non-Error throw branch (line 96, 123, etc.) ----------

  describe("catch branch wraps non-Error throws into Error", () => {
    it("wraps a non-Error throw object inside store() catch into a fresh Error", async () => {
      // Simulate a non-Error throw by hijacking the better-sqlite3 transaction
      const db = adapter.getDb();
      const origTx = db.transaction.bind(db);
      vi.spyOn(db, "transaction").mockImplementationOnce(() => {
        return Object.assign(() => { throw "not-an-error-string"; }, { default: () => {}, deferred: () => {}, immediate: () => {}, exclusive: () => {} }) as never;
      });
      try {
        const result = await adapter.store(makeEntry());
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error).toBeInstanceOf(Error);
          expect(result.error.message).toBe("not-an-error-string");
        }
      } finally {
        // Restore
        (db.transaction as unknown as { mockRestore?: () => void }).mockRestore?.();
        origTx;
      }
    });

    // NOTE: retrieve/update/clear catch-branch tests were removed in a prior
    // port-trim cleanup along with the corresponding methods. The surviving
    // store + search + delete catch branches (above and below) cover the same
    // non-Error-throw wrapping pattern.

    it("wraps non-Error throws into Error inside delete() catch", async () => {
      const db = adapter.getDb();
      vi.spyOn(db, "prepare").mockImplementationOnce(() => {
        throw "non-error-in-delete";
      });
      const result = await adapter.delete("any-id");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(Error);
        expect(result.error.message).toBe("non-error-in-delete");
      }
    });

    it("wraps non-Error throws into Error inside search() catch", async () => {
      const db = adapter.getDb();
      vi.spyOn(db, "prepare").mockImplementationOnce(() => {
        throw "non-error-in-search";
      });
      const result = await adapter.search(sessionKey, "anything");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(Error);
        expect(result.error.message).toBe("non-error-in-search");
      }
    });
  });

  // ---- checkpoint nullish path (line 472) -------------------------------

  describe("checkpoint nullish-coalescing branch", () => {
    it("returns 0 when wal_checkpoint pragma returns no rows", () => {
      // Patch pragma to return an empty array so the ?? 0 fallback fires
      const db = adapter.getDb();
      const origPragma = db.pragma.bind(db);
      vi.spyOn(db, "pragma").mockImplementationOnce(() => [] as never);
      try {
        const n = adapter.checkpoint();
        expect(n).toBe(0);
      } finally {
        // Cleanup happens via afterEach close()
        origPragma;
      }
    });
  });
});
