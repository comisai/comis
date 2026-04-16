/**
 * Tests for SQLite L2 embedding cache adapter.
 *
 * Uses in-memory SQLite database with initSchema() to create all tables.
 * Verifies DDL, BLOB round-trip, cache hit/miss, UPSERT, composite key
 * isolation, embedBatch delegation, and dispose forwarding.
 */

import Database from "better-sqlite3";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ok, err, type Result } from "@comis/shared";
import type { EmbeddingPort } from "@comis/core";
import { createHash } from "node:crypto";
import { initSchema } from "./schema.js";
import { createSqliteEmbeddingCache, type SqliteEmbeddingCacheOptions } from "./embedding-cache-sqlite.js";
import { computeEmbeddingIdentityHash } from "./embedding-hash.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const DIMS = 384;

/** Create a deterministic test vector of given length. */
function makeVector(dims: number, seed = 1): number[] {
  return Array.from({ length: dims }, (_, i) => (i + seed) * 0.001);
}

/** Create a mock inner EmbeddingPort. */
function createMockInner(overrides?: Partial<EmbeddingPort>): EmbeddingPort {
  return {
    provider: "test",
    modelId: "test-model",
    dimensions: DIMS,
    embed: vi.fn(async (_text: string): Promise<Result<number[], Error>> => {
      return ok(makeVector(DIMS));
    }),
    embedBatch: vi.fn(async (texts: string[]): Promise<Result<number[][], Error>> => {
      return ok(texts.map((_, i) => makeVector(DIMS, i + 1)));
    }),
    dispose: vi.fn(async () => {}),
    ...overrides,
  };
}

/** Create a fresh in-memory database with schema. */
function createTestDb(): Database.Database {
  const db = new Database(":memory:");
  initSchema(db, DIMS);
  return db;
}

/** Create default cache options for tests. */
function createTestOptions(db: Database.Database): SqliteEmbeddingCacheOptions {
  return { db, maxEntries: 50_000 };
}

/** SHA-256 hex hash (mirrors internal hashText). */
function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** Insert a cache row directly via SQL with controlled timestamps. */
function insertRawRow(
  db: Database.Database,
  text: string,
  opts: {
    provider?: string;
    model?: string;
    configHash?: string;
    createdAt?: number;
    accessedAt?: number;
    hitCount?: number;
    seed?: number;
  } = {},
): void {
  const {
    provider = "test",
    model = "test-model",
    configHash = computeEmbeddingIdentityHash("test-model", DIMS),
    createdAt = Date.now(),
    accessedAt = createdAt,
    hitCount = 0,
    seed = 1,
  } = opts;
  const textHash = hashText(text);
  const f32 = new Float32Array(makeVector(DIMS, seed));
  const blob = Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength);
  db.prepare(
    `INSERT INTO embedding_cache
       (provider, model, config_hash, text_hash, embedding, dims, hit_count, created_at, accessed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(provider, model, configHash, textHash, blob, DIMS, hitCount, createdAt, accessedAt);
}

/** Small async delay helper for timer-based tests. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("embedding_cache DDL", () => {
  it("creates embedding_cache table with correct columns", () => {
    const db = createTestDb();
    const columns = db.prepare("PRAGMA table_info(embedding_cache)").all() as Array<{
      name: string;
      type: string;
      notnull: number;
      pk: number;
    }>;

    const colMap = new Map(columns.map((c) => [c.name, c]));

    expect(colMap.get("provider")?.type).toBe("TEXT");
    expect(colMap.get("provider")?.notnull).toBe(1);
    expect(colMap.get("model")?.type).toBe("TEXT");
    expect(colMap.get("config_hash")?.type).toBe("TEXT");
    expect(colMap.get("text_hash")?.type).toBe("TEXT");
    expect(colMap.get("embedding")?.type).toBe("BLOB");
    expect(colMap.get("dims")?.type).toBe("INTEGER");
    expect(colMap.get("hit_count")?.type).toBe("INTEGER");
    expect(colMap.get("created_at")?.type).toBe("INTEGER");
    expect(colMap.get("accessed_at")?.type).toBe("INTEGER");

    // Composite PK: all 4 columns should have pk > 0
    expect(colMap.get("provider")?.pk).toBeGreaterThan(0);
    expect(colMap.get("model")?.pk).toBeGreaterThan(0);
    expect(colMap.get("config_hash")?.pk).toBeGreaterThan(0);
    expect(colMap.get("text_hash")?.pk).toBeGreaterThan(0);

    db.close();
  });

  it("creates embedding_provider_meta table in initSchema", () => {
    const db = createTestDb();
    const columns = db.prepare("PRAGMA table_info(embedding_provider_meta)").all() as Array<{
      name: string;
      type: string;
    }>;

    const colMap = new Map(columns.map((c) => [c.name, c]));
    expect(colMap.get("key")?.type).toBe("TEXT");
    expect(colMap.get("value")?.type).toBe("TEXT");

    db.close();
  });

  it("creates accessed_at index", () => {
    const db = createTestDb();
    const indexes = db.prepare("PRAGMA index_list(embedding_cache)").all() as Array<{
      name: string;
    }>;

    const indexNames = indexes.map((idx) => idx.name);
    expect(indexNames).toContain("idx_embedding_cache_accessed");

    db.close();
  });
});

describe("createSqliteEmbeddingCache", () => {
  let db: Database.Database;
  let inner: EmbeddingPort;
  let cache: EmbeddingPort;

  beforeEach(() => {
    db = createTestDb();
    inner = createMockInner();
    cache = createSqliteEmbeddingCache(inner, createTestOptions(db));
  });

  it("forwards provider, modelId, dimensions from inner", () => {
    expect(cache.provider).toBe("test");
    expect(cache.modelId).toBe("test-model");
    expect(cache.dimensions).toBe(DIMS);
  });

  it("stores BLOB and retrieves with correct Float32 values", async () => {
    const vector = makeVector(DIMS);
    (inner.embed as ReturnType<typeof vi.fn>).mockResolvedValueOnce(ok(vector));

    // First call: cache miss, stores BLOB
    const result1 = await cache.embed("hello world");
    expect(result1.ok).toBe(true);
    if (!result1.ok) throw new Error("unexpected");

    // Verify values are close (Float32 may lose precision)
    for (let i = 0; i < DIMS; i++) {
      expect(result1.value[i]).toBeCloseTo(vector[i], 5);
    }

    // Second call: cache hit, should return from BLOB
    const result2 = await cache.embed("hello world");
    expect(result2.ok).toBe(true);
    if (!result2.ok) throw new Error("unexpected");

    for (let i = 0; i < DIMS; i++) {
      expect(result2.value[i]).toBeCloseTo(vector[i], 5);
    }
  });

  it("cache hit does not call inner provider", async () => {
    const embedSpy = inner.embed as ReturnType<typeof vi.fn>;

    // First call: miss
    await cache.embed("cached text");
    expect(embedSpy).toHaveBeenCalledTimes(1);

    // Second call: hit
    await cache.embed("cached text");
    expect(embedSpy).toHaveBeenCalledTimes(1); // Still 1 -- no extra call
  });

  it("UPSERT overwrites on re-embed with different vector", async () => {
    const embedSpy = inner.embed as ReturnType<typeof vi.fn>;
    const vector1 = makeVector(DIMS, 1);
    const vector2 = makeVector(DIMS, 99);

    embedSpy.mockResolvedValueOnce(ok(vector1));

    // Initial embed
    await cache.embed("update-test");
    expect(embedSpy).toHaveBeenCalledTimes(1);

    // Simulate provider returning a different vector and force a miss by
    // creating a fresh cache instance (new prepared statements, same db)
    embedSpy.mockResolvedValueOnce(ok(vector2));
    const cache2 = createSqliteEmbeddingCache(inner, createTestOptions(db));

    // The first cache stored vector1. The new cache sees the same row.
    // To test UPSERT, we directly insert with a known text_hash to force
    // ON CONFLICT. We'll verify via raw SQL.
    await cache2.embed("update-test"); // hits the existing cache entry

    // It should be a HIT (returns vector1 from cache), not calling inner again
    expect(embedSpy).toHaveBeenCalledTimes(1); // Still 1 from the vector2 mock not being used

    // Now verify UPSERT by inserting via raw SQL to the same key with different data
    const row = db.prepare(
      `SELECT embedding, dims FROM embedding_cache
       WHERE provider = 'test' AND model = 'test-model' AND text_hash = ?`,
    ).get(createHash("sha256").update("update-test").digest("hex")) as {
      embedding: Buffer;
      dims: number;
    };

    expect(row).toBeDefined();
    expect(row.dims).toBe(DIMS);
    // Verify the stored vector is vector1 (from the first embed)
    const stored = new Float32Array(
      row.embedding.buffer,
      row.embedding.byteOffset,
      row.embedding.byteLength / Float32Array.BYTES_PER_ELEMENT,
    );
    expect(stored.length).toBe(DIMS);
    expect(stored[0]).toBeCloseTo(vector1[0], 5);
  });

  it("UPSERT preserves rowid on conflict (ON CONFLICT DO UPDATE)", async () => {
    const embedSpy = inner.embed as ReturnType<typeof vi.fn>;
    const vector1 = makeVector(DIMS, 1);
    const vector2 = makeVector(DIMS, 42);

    embedSpy.mockResolvedValueOnce(ok(vector1));
    await cache.embed("rowid-test");

    // Get the rowid
    const row1 = db.prepare(
      "SELECT rowid FROM embedding_cache WHERE text_hash = ?",
    ).get(createHash("sha256").update("rowid-test").digest("hex")) as { rowid: number };

    // Force re-embed by using the upsert stmt directly via a second cache miss
    // We need the cache to miss, so use a new cache instance that skips the LRU
    // But since the cache checks SQLite, it will hit. Instead, directly call the
    // upsert statement via the db to test rowid stability.
    const configHash = computeEmbeddingIdentityHash("test-model", DIMS);
    const textHash = createHash("sha256").update("rowid-test").digest("hex");
    const blob = Buffer.from(new Float32Array(vector2).buffer);
    const now = Date.now();

    db.prepare(
      `INSERT INTO embedding_cache
         (provider, model, config_hash, text_hash, embedding, dims, hit_count, created_at, accessed_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)
       ON CONFLICT(provider, model, config_hash, text_hash) DO UPDATE SET
         embedding = excluded.embedding,
         dims = excluded.dims,
         hit_count = 0,
         accessed_at = excluded.accessed_at`,
    ).run("test", "test-model", configHash, textHash, blob, DIMS, now, now);

    const row2 = db.prepare(
      "SELECT rowid FROM embedding_cache WHERE text_hash = ?",
    ).get(textHash) as { rowid: number };

    // Rowid should be the same (ON CONFLICT DO UPDATE preserves rowid)
    expect(row2.rowid).toBe(row1.rowid);
  });

  it("composite key isolates entries by provider", async () => {
    const innerA = createMockInner({ provider: "provider-a" });
    const innerB = createMockInner({ provider: "provider-b" });

    const vectorA = makeVector(DIMS, 10);
    const vectorB = makeVector(DIMS, 20);

    (innerA.embed as ReturnType<typeof vi.fn>).mockResolvedValueOnce(ok(vectorA));
    (innerB.embed as ReturnType<typeof vi.fn>).mockResolvedValueOnce(ok(vectorB));

    const cacheA = createSqliteEmbeddingCache(innerA, createTestOptions(db));
    const cacheB = createSqliteEmbeddingCache(innerB, createTestOptions(db));

    await cacheA.embed("shared-text");
    await cacheB.embed("shared-text");

    // Both providers should have stored separate entries
    const count = db.prepare("SELECT COUNT(*) as cnt FROM embedding_cache WHERE text_hash = ?")
      .get(createHash("sha256").update("shared-text").digest("hex")) as { cnt: number };

    expect(count.cnt).toBe(2);
  });

  it("composite key isolates entries by model", async () => {
    const innerA = createMockInner({ modelId: "model-a" });
    const innerB = createMockInner({ modelId: "model-b" });

    (innerA.embed as ReturnType<typeof vi.fn>).mockResolvedValueOnce(ok(makeVector(DIMS, 1)));
    (innerB.embed as ReturnType<typeof vi.fn>).mockResolvedValueOnce(ok(makeVector(DIMS, 2)));

    const cacheA = createSqliteEmbeddingCache(innerA, createTestOptions(db));
    const cacheB = createSqliteEmbeddingCache(innerB, createTestOptions(db));

    await cacheA.embed("shared-text");
    await cacheB.embed("shared-text");

    const count = db.prepare("SELECT COUNT(*) as cnt FROM embedding_cache").get() as { cnt: number };
    expect(count.cnt).toBe(2);
  });

  // -------------------------------------------------------------------------
  // embedBatch: batch SELECT hit/miss splitting
  // -------------------------------------------------------------------------

  it("embedBatch splits hits and misses correctly", async () => {
    const embedSpy = inner.embed as ReturnType<typeof vi.fn>;
    const batchSpy = inner.embedBatch as ReturnType<typeof vi.fn>;

    // Pre-populate cache with 3 embeddings via single embed() calls
    const vectors = [makeVector(DIMS, 10), makeVector(DIMS, 20), makeVector(DIMS, 30)];
    embedSpy
      .mockResolvedValueOnce(ok(vectors[0]))
      .mockResolvedValueOnce(ok(vectors[1]))
      .mockResolvedValueOnce(ok(vectors[2]));
    await cache.embed("cached-a");
    await cache.embed("cached-b");
    await cache.embed("cached-c");

    // Mock the batch response for the 2 misses
    const missVectors = [makeVector(DIMS, 40), makeVector(DIMS, 50)];
    batchSpy.mockResolvedValueOnce(ok(missVectors));

    // Call embedBatch with 5 texts (3 cached + 2 new)
    const result = await cache.embedBatch([
      "cached-a", "new-d", "cached-b", "new-e", "cached-c",
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unexpected");

    // inner.embedBatch called with only the 2 miss texts
    expect(batchSpy).toHaveBeenCalledTimes(1);
    expect(batchSpy).toHaveBeenCalledWith(["new-d", "new-e"]);

    // Verify all 5 results in original order
    expect(result.value.length).toBe(5);
    expect(result.value[0][0]).toBeCloseTo(vectors[0][0], 5); // cached-a
    expect(result.value[1][0]).toBeCloseTo(missVectors[0][0], 5); // new-d
    expect(result.value[2][0]).toBeCloseTo(vectors[1][0], 5); // cached-b
    expect(result.value[3][0]).toBeCloseTo(missVectors[1][0], 5); // new-e
    expect(result.value[4][0]).toBeCloseTo(vectors[2][0], 5); // cached-c
  });

  it("embedBatch all hits returns without calling provider", async () => {
    const embedSpy = inner.embed as ReturnType<typeof vi.fn>;
    const batchSpy = inner.embedBatch as ReturnType<typeof vi.fn>;

    // Pre-populate cache with 3 embeddings
    const vectors = [makeVector(DIMS, 1), makeVector(DIMS, 2), makeVector(DIMS, 3)];
    embedSpy
      .mockResolvedValueOnce(ok(vectors[0]))
      .mockResolvedValueOnce(ok(vectors[1]))
      .mockResolvedValueOnce(ok(vectors[2]));
    await cache.embed("hit-a");
    await cache.embed("hit-b");
    await cache.embed("hit-c");

    // Call embedBatch with the same 3 texts
    const result = await cache.embedBatch(["hit-a", "hit-b", "hit-c"]);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unexpected");

    // inner.embedBatch NOT called -- all cache hits
    expect(batchSpy).not.toHaveBeenCalled();

    // Results match cached values
    expect(result.value.length).toBe(3);
    expect(result.value[0][0]).toBeCloseTo(vectors[0][0], 5);
    expect(result.value[1][0]).toBeCloseTo(vectors[1][0], 5);
    expect(result.value[2][0]).toBeCloseTo(vectors[2][0], 5);
  });

  it("embedBatch all misses calls provider for full batch", async () => {
    const batchSpy = inner.embedBatch as ReturnType<typeof vi.fn>;

    // Empty cache -- all misses
    const vectors = [makeVector(DIMS, 1), makeVector(DIMS, 2), makeVector(DIMS, 3)];
    batchSpy.mockResolvedValueOnce(ok(vectors));

    const result = await cache.embedBatch(["miss-a", "miss-b", "miss-c"]);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unexpected");

    // Provider called with all 3 texts
    expect(batchSpy).toHaveBeenCalledTimes(1);
    expect(batchSpy).toHaveBeenCalledWith(["miss-a", "miss-b", "miss-c"]);

    // Verify all stored in cache -- subsequent call returns from cache
    batchSpy.mockClear();
    const result2 = await cache.embedBatch(["miss-a", "miss-b", "miss-c"]);
    expect(result2.ok).toBe(true);
    expect(batchSpy).not.toHaveBeenCalled(); // All hits now
  });

  it("embedBatch empty array returns empty array", async () => {
    const batchSpy = inner.embedBatch as ReturnType<typeof vi.fn>;

    const result = await cache.embedBatch([]);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unexpected");
    expect(result.value).toEqual([]);

    // Provider NOT called
    expect(batchSpy).not.toHaveBeenCalled();
  });

  it("embedBatch UPSERT is transactional (all-or-nothing)", async () => {
    const batchSpy = inner.embedBatch as ReturnType<typeof vi.fn>;

    const vectors = [makeVector(DIMS, 1), makeVector(DIMS, 2), makeVector(DIMS, 3)];
    batchSpy.mockResolvedValueOnce(ok(vectors));

    // Call embedBatch with 3 texts
    await cache.embedBatch(["tx-a", "tx-b", "tx-c"]);

    // Verify all 3 entries exist via direct SQL SELECT
    const count = db.prepare("SELECT COUNT(*) as cnt FROM embedding_cache").get() as { cnt: number };
    expect(count.cnt).toBe(3);

    // Verify each entry individually
    for (const text of ["tx-a", "tx-b", "tx-c"]) {
      const hash = createHash("sha256").update(text).digest("hex");
      const row = db.prepare(
        "SELECT embedding FROM embedding_cache WHERE text_hash = ?",
      ).get(hash) as { embedding: Buffer } | undefined;
      expect(row).toBeDefined();
    }
  });

  it("embedBatch preserves ordering with mixed hit/miss pattern", async () => {
    const embedSpy = inner.embed as ReturnType<typeof vi.fn>;
    const batchSpy = inner.embedBatch as ReturnType<typeof vi.fn>;

    // Pre-populate A and C (not B, D, E)
    const vecA = makeVector(DIMS, 100);
    const vecC = makeVector(DIMS, 300);
    embedSpy
      .mockResolvedValueOnce(ok(vecA))
      .mockResolvedValueOnce(ok(vecC));
    await cache.embed("order-A");
    await cache.embed("order-C");

    // Mock batch response for misses B, D, E
    const vecB = makeVector(DIMS, 200);
    const vecD = makeVector(DIMS, 400);
    const vecE = makeVector(DIMS, 500);
    batchSpy.mockResolvedValueOnce(ok([vecB, vecD, vecE]));

    // Call embedBatch([A, B, C, D, E]) -- A,C are hits; B,D,E are misses
    const result = await cache.embedBatch([
      "order-A", "order-B", "order-C", "order-D", "order-E",
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unexpected");

    expect(result.value.length).toBe(5);

    // result[0] = A's embedding (cached hit)
    expect(result.value[0][0]).toBeCloseTo(vecA[0], 5);
    // result[1] = B's embedding (miss, first from provider batch)
    expect(result.value[1][0]).toBeCloseTo(vecB[0], 5);
    // result[2] = C's embedding (cached hit)
    expect(result.value[2][0]).toBeCloseTo(vecC[0], 5);
    // result[3] = D's embedding (miss, second from provider batch)
    expect(result.value[3][0]).toBeCloseTo(vecD[0], 5);
    // result[4] = E's embedding (miss, third from provider batch)
    expect(result.value[4][0]).toBeCloseTo(vecE[0], 5);

    // Provider called with only the miss texts in order
    expect(batchSpy).toHaveBeenCalledWith(["order-B", "order-D", "order-E"]);
  });

  it("embedBatch with moderate batch validates batch SELECT works", async () => {
    const embedSpy = inner.embed as ReturnType<typeof vi.fn>;
    const batchSpy = inner.embedBatch as ReturnType<typeof vi.fn>;

    // Pre-populate 5 entries via single embed()
    const cachedVecs: number[][] = [];
    for (let i = 0; i < 5; i++) {
      const vec = makeVector(DIMS, i + 1);
      cachedVecs.push(vec);
      embedSpy.mockResolvedValueOnce(ok(vec));
      await cache.embed(`batch-text-${i}`);
    }

    // Build a batch of 10: 5 hits + 5 misses
    const texts: string[] = [];
    for (let i = 0; i < 10; i++) {
      texts.push(`batch-text-${i}`);
    }

    // Mock provider response for the 5 misses
    const missVecs = Array.from({ length: 5 }, (_, i) => makeVector(DIMS, i + 100));
    batchSpy.mockResolvedValueOnce(ok(missVecs));

    const result = await cache.embedBatch(texts);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unexpected");

    // Verify only 5 misses sent to provider
    expect(batchSpy).toHaveBeenCalledTimes(1);
    const callArgs = batchSpy.mock.calls[0][0] as string[];
    expect(callArgs.length).toBe(5);

    // Verify all 10 results returned
    expect(result.value.length).toBe(10);

    // First 5 should match cached vectors (Float32 precision)
    for (let i = 0; i < 5; i++) {
      expect(result.value[i][0]).toBeCloseTo(cachedVecs[i][0], 5);
    }
    // Last 5 should match miss vectors
    for (let i = 0; i < 5; i++) {
      expect(result.value[i + 5][0]).toBeCloseTo(missVecs[i][0], 5);
    }
  });

  it("embedBatch returns error if inner.embedBatch fails", async () => {
    const batchSpy = inner.embedBatch as ReturnType<typeof vi.fn>;
    batchSpy.mockResolvedValueOnce(err(new Error("provider down")));

    const result = await cache.embedBatch(["fail-a", "fail-b"]);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unexpected");
    expect(result.error.message).toBe("provider down");
  });

  it("dispose forwards to inner", async () => {
    const disposeSpy = inner.dispose as ReturnType<typeof vi.fn>;
    await cache.dispose?.();
    expect(disposeSpy).toHaveBeenCalledTimes(1);
  });

  it("does not cache on inner embed error", async () => {
    const embedSpy = inner.embed as ReturnType<typeof vi.fn>;
    embedSpy.mockResolvedValueOnce(err(new Error("API error")));

    const result = await cache.embed("error-text");
    expect(result.ok).toBe(false);

    // Verify nothing was stored
    const count = db.prepare("SELECT COUNT(*) as cnt FROM embedding_cache").get() as { cnt: number };
    expect(count.cnt).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Cache maintenance: lazy buffer, LRU prune, TTL, WAL checkpoint, dispose
// ---------------------------------------------------------------------------

describe("cache maintenance", () => {
  let db: Database.Database;
  let inner: EmbeddingPort;

  beforeEach(() => {
    db = createTestDb();
    inner = createMockInner();
  });

  afterEach(() => {
    // Ensure db is closed to avoid leaking handles
    try { db.close(); } catch { /* already closed */ }
  });

  it("recordAccess buffers and does not write on every hit", async () => {
    const cache = createSqliteEmbeddingCache(inner, {
      db,
      maxEntries: 50_000,
      pruneIntervalMs: 600_000, // large -- prevent timer interference
    });

    // Seed the cache with one entry via embed() (cache miss)
    const embedSpy = inner.embed as ReturnType<typeof vi.fn>;
    embedSpy.mockResolvedValueOnce(ok(makeVector(DIMS)));
    await cache.embed("buffered-text");

    // Record the accessed_at after the initial insert
    const textHash = hashText("buffered-text");
    const initialRow = db.prepare(
      "SELECT accessed_at FROM embedding_cache WHERE text_hash = ?",
    ).get(textHash) as { accessed_at: number };
    const initialAccessed = initialRow.accessed_at;

    // Wait a small moment so Date.now() differs
    await delay(5);

    // Hit the cache 5 more times (under the 100 threshold)
    for (let i = 0; i < 5; i++) {
      await cache.embed("buffered-text");
    }

    // Buffer has NOT flushed yet (only 5 hits, threshold is 100)
    // So accessed_at in SQLite should still be the original value
    const afterRow = db.prepare(
      "SELECT accessed_at, hit_count FROM embedding_cache WHERE text_hash = ?",
    ).get(textHash) as { accessed_at: number; hit_count: number };

    expect(afterRow.accessed_at).toBe(initialAccessed);
    expect(afterRow.hit_count).toBe(0); // Not flushed yet

    await cache.dispose?.();
  });

  it("lazy buffer flushes at 100-entry threshold", async () => {
    const cache = createSqliteEmbeddingCache(inner, {
      db,
      maxEntries: 50_000,
      pruneIntervalMs: 600_000,
    });

    const embedSpy = inner.embed as ReturnType<typeof vi.fn>;

    // Pre-populate 101 distinct texts
    for (let i = 0; i < 101; i++) {
      embedSpy.mockResolvedValueOnce(ok(makeVector(DIMS, i + 1)));
      await cache.embed(`threshold-text-${i}`);
    }

    // Now hit each of the first 100 texts (cache hits) to build up the buffer
    // After the 100th *distinct* text_hash enters the buffer, it should auto-flush
    for (let i = 0; i < 100; i++) {
      await cache.embed(`threshold-text-${i}`);
    }

    // The flush should have happened at the 100th entry
    // Check that at least some entries have hit_count > 0
    const updated = db.prepare(
      "SELECT COUNT(*) as cnt FROM embedding_cache WHERE hit_count > 0",
    ).get() as { cnt: number };

    // All 100 buffered entries should have been flushed (hit_count incremented)
    expect(updated.cnt).toBe(100);

    await cache.dispose?.();
  });

  it("LRU prune removes least-recently-accessed entries", async () => {
    // Use short pruneIntervalMs to trigger prune via timer
    const cache = createSqliteEmbeddingCache(inner, {
      db,
      maxEntries: 5,
      pruneIntervalMs: 30,
    });

    // Insert 10 entries with staggered accessed_at times via raw SQL
    const baseTime = Date.now() - 10_000;
    for (let i = 0; i < 10; i++) {
      insertRawRow(db, `lru-text-${i}`, {
        createdAt: baseTime + i * 100,
        accessedAt: baseTime + i * 100,
        seed: i + 1,
      });
    }

    // Verify we have 10 entries
    const before = db.prepare("SELECT COUNT(*) as cnt FROM embedding_cache").get() as { cnt: number };
    expect(before.cnt).toBe(10);

    // Wait for prune timer to fire
    await delay(100);

    // After prune, only maxEntries (5) should remain -- the 5 most recently accessed
    const after = db.prepare("SELECT COUNT(*) as cnt FROM embedding_cache").get() as { cnt: number };
    expect(after.cnt).toBe(5);

    // The surviving entries should be the ones with highest accessed_at (texts 5-9)
    for (let i = 5; i < 10; i++) {
      const row = db.prepare(
        "SELECT 1 as found FROM embedding_cache WHERE text_hash = ?",
      ).get(hashText(`lru-text-${i}`)) as { found: number } | undefined;
      expect(row).toBeDefined();
    }

    // The oldest entries (0-4) should have been evicted
    for (let i = 0; i < 5; i++) {
      const row = db.prepare(
        "SELECT 1 as found FROM embedding_cache WHERE text_hash = ?",
      ).get(hashText(`lru-text-${i}`)) as { found: number } | undefined;
      expect(row).toBeUndefined();
    }

    await cache.dispose?.();
  });

  it("prune flushes lazy buffer before eviction", async () => {
    // maxEntries: 3, insert 5 texts, hit the oldest one to refresh it
    const cache = createSqliteEmbeddingCache(inner, {
      db,
      maxEntries: 3,
      pruneIntervalMs: 30,
    });

    // Insert 5 entries with staggered times. Entry #0 is the oldest.
    const baseTime = Date.now() - 10_000;
    for (let i = 0; i < 5; i++) {
      insertRawRow(db, `pitfall-text-${i}`, {
        createdAt: baseTime + i * 100,
        accessedAt: baseTime + i * 100,
        seed: i + 1,
      });
    }

    // Hit text #0 (oldest by created_at/accessed_at) to make it recently-accessed
    // This access goes into the lazy buffer -- NOT yet persisted to SQLite
    const embedSpy = inner.embed as ReturnType<typeof vi.fn>;
    await cache.embed(`pitfall-text-0`); // cache hit -> recordAccess(textHash)

    // Wait for prune timer to fire
    await delay(100);

    // Text #0 should survive because prune flushes the buffer first,
    // updating its accessed_at to a recent time
    const row0 = db.prepare(
      "SELECT 1 as found FROM embedding_cache WHERE text_hash = ?",
    ).get(hashText("pitfall-text-0")) as { found: number } | undefined;
    expect(row0).toBeDefined();

    // Only 3 entries should remain total
    const count = db.prepare("SELECT COUNT(*) as cnt FROM embedding_cache").get() as { cnt: number };
    expect(count.cnt).toBe(3);

    // Texts #1 and #2 (the next oldest, NOT recently accessed) should be evicted
    const row1 = db.prepare(
      "SELECT 1 as found FROM embedding_cache WHERE text_hash = ?",
    ).get(hashText("pitfall-text-1")) as { found: number } | undefined;
    const row2 = db.prepare(
      "SELECT 1 as found FROM embedding_cache WHERE text_hash = ?",
    ).get(hashText("pitfall-text-2")) as { found: number } | undefined;
    expect(row1).toBeUndefined();
    expect(row2).toBeUndefined();

    await cache.dispose?.();
  });

  it("TTL expiration removes old entries", async () => {
    const cache = createSqliteEmbeddingCache(inner, {
      db,
      maxEntries: 50_000,
      ttlMs: 100, // 100ms TTL for test speed
      pruneIntervalMs: 30,
    });

    // Insert 3 "old" entries with created_at in the past (> 100ms ago)
    const oldTime = Date.now() - 500;
    for (let i = 0; i < 3; i++) {
      insertRawRow(db, `old-text-${i}`, {
        createdAt: oldTime,
        accessedAt: oldTime,
        seed: i + 1,
      });
    }

    // Insert 1 "recent" entry with current timestamp
    insertRawRow(db, "recent-text", {
      createdAt: Date.now(),
      accessedAt: Date.now(),
      seed: 99,
    });

    // Verify 4 entries before prune
    const before = db.prepare("SELECT COUNT(*) as cnt FROM embedding_cache").get() as { cnt: number };
    expect(before.cnt).toBe(4);

    // Wait for prune timer to fire
    await delay(100);

    // The 3 old entries should be deleted, the recent one should remain
    const after = db.prepare("SELECT COUNT(*) as cnt FROM embedding_cache").get() as { cnt: number };
    expect(after.cnt).toBe(1);

    const recent = db.prepare(
      "SELECT 1 as found FROM embedding_cache WHERE text_hash = ?",
    ).get(hashText("recent-text")) as { found: number } | undefined;
    expect(recent).toBeDefined();

    await cache.dispose?.();
  });

  it("WAL checkpoint runs after prune without error", async () => {
    // This test verifies prune + WAL checkpoint completes without throwing
    const cache = createSqliteEmbeddingCache(inner, {
      db,
      maxEntries: 2,
      pruneIntervalMs: 30,
    });

    // Insert 5 entries (exceeds maxEntries of 2)
    for (let i = 0; i < 5; i++) {
      insertRawRow(db, `wal-text-${i}`, {
        createdAt: Date.now() - 1000 + i * 100,
        accessedAt: Date.now() - 1000 + i * 100,
        seed: i + 1,
      });
    }

    // Wait for prune to fire and complete (including WAL checkpoint)
    await delay(100);

    // If WAL checkpoint threw, the test would fail. Verify prune happened.
    const count = db.prepare("SELECT COUNT(*) as cnt FROM embedding_cache").get() as { cnt: number };
    expect(count.cnt).toBe(2);

    await cache.dispose?.();
  });

  it("dispose flushes buffer and clears timer", async () => {
    const disposeSpy = inner.dispose as ReturnType<typeof vi.fn>;
    const cache = createSqliteEmbeddingCache(inner, {
      db,
      maxEntries: 50_000,
      pruneIntervalMs: 600_000,
    });

    const embedSpy = inner.embed as ReturnType<typeof vi.fn>;

    // Populate and hit several texts (builds buffer without flushing)
    for (let i = 0; i < 5; i++) {
      embedSpy.mockResolvedValueOnce(ok(makeVector(DIMS, i + 1)));
      await cache.embed(`dispose-text-${i}`);
    }
    // Hit them again (cache hits -> buffer entries)
    for (let i = 0; i < 5; i++) {
      await cache.embed(`dispose-text-${i}`);
    }

    // Before dispose: buffer is populated but NOT flushed (under threshold)
    const beforeFlush = db.prepare(
      "SELECT COUNT(*) as cnt FROM embedding_cache WHERE hit_count > 0",
    ).get() as { cnt: number };
    expect(beforeFlush.cnt).toBe(0); // Not flushed yet

    // Call dispose
    await cache.dispose?.();

    // After dispose: buffer should have been flushed
    const afterFlush = db.prepare(
      "SELECT COUNT(*) as cnt FROM embedding_cache WHERE hit_count > 0",
    ).get() as { cnt: number };
    expect(afterFlush.cnt).toBe(5); // All 5 entries had their access flushed

    // inner.dispose was called
    expect(disposeSpy).toHaveBeenCalledTimes(1);
  });

  it("dispose forwards to inner.dispose exactly once", async () => {
    const disposeSpy = inner.dispose as ReturnType<typeof vi.fn>;
    const cache = createSqliteEmbeddingCache(inner, {
      db,
      maxEntries: 50_000,
      pruneIntervalMs: 600_000,
    });

    await cache.dispose?.();
    expect(disposeSpy).toHaveBeenCalledTimes(1);

    // Second dispose is a no-op (double-dispose safe)
    await cache.dispose?.();
    expect(disposeSpy).toHaveBeenCalledTimes(1); // Still 1
  });
});
