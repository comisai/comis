/**
 * Integration tests for the full embedding pipeline.
 *
 * Exercises the end-to-end flow: config -> provider creation -> cache wrapping ->
 * fingerprint check -> batch indexing -> queue wiring -> memory adapter with vector
 * search. Uses mock EmbeddingPort (no actual node-llama-cpp or OpenAI calls).
 */

import type { EmbeddingPort } from "@comis/core";
import { ok, err, type Result } from "@comis/shared";
import Database from "better-sqlite3";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { initSchema, isVecAvailable } from "./schema.js";
import { SqliteMemoryAdapter } from "./sqlite-memory-adapter.js";
import { createCachedEmbeddingPort } from "./embedding-cache-lru.js";
import { createFingerprintManager } from "./embedding-fingerprint.js";
import { createBatchIndexer } from "./embedding-batch-indexer.js";
import { createEmbeddingQueue } from "./embedding-queue.js";

const DIMS = 4;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Create a mock EmbeddingPort with deterministic fake vectors.
 * Vectors are based on character codes for uniqueness per input text.
 */
function createMockEmbeddingPort(
  dimensions: number = DIMS,
  modelId: string = "test-model",
): EmbeddingPort & { embedFn: ReturnType<typeof vi.fn>; embedBatchFn: ReturnType<typeof vi.fn> } {
  const embedFn = vi.fn<(text: string) => Promise<Result<number[], Error>>>(
    async (text: string) => {
      const vec = new Array(dimensions).fill(0.1);
      for (let i = 0; i < text.length && i < dimensions; i++) {
        vec[i] = text.charCodeAt(i) / 256;
      }
      return ok(vec);
    },
  );

  const embedBatchFn = vi.fn<(texts: string[]) => Promise<Result<number[][], Error>>>(
    async (texts: string[]) => {
      const vecs: number[][] = texts.map((t) => {
        const vec = new Array(dimensions).fill(0.1);
        for (let i = 0; i < t.length && i < dimensions; i++) {
          vec[i] = t.charCodeAt(i) / 256;
        }
        return vec;
      });
      return ok(vecs);
    },
  );

  return {
    provider: "test",
    dimensions,
    modelId,
    embed: embedFn,
    embedBatch: embedBatchFn,
    embedFn,
    embedBatchFn,
  };
}

/** Insert a minimal memory row directly into the DB. */
function insertMemory(
  db: Database.Database,
  id: string,
  content: string,
  hasEmbedding: number = 0,
): void {
  db.prepare(
    `INSERT INTO memories (id, tenant_id, agent_id, user_id, content, trust_level, memory_type, source_who, tags, created_at, has_embedding)
     VALUES (?, 'default', 'default', 'u1', ?, 'learned', 'semantic', 'agent', '[]', ?, ?)`,
  ).run(id, content, Date.now(), hasEmbedding);
}

// ---------------------------------------------------------------------------
// Integration Tests
// ---------------------------------------------------------------------------

describe("Embedding pipeline integration", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    initSchema(db, DIMS);
  });

  it("full pipeline: store -> batch index -> search returns results", async () => {
    const mockPort = createMockEmbeddingPort(DIMS, "test-embed-v1");

    // Create adapter with embedding port
    const adapter = new SqliteMemoryAdapter(
      { dbPath: ":memory:", walMode: false, embeddingDimensions: DIMS } as any,
      mockPort,
    );

    // Use the adapter's internal DB (which has the schema already initialized)
    const adapterDb = adapter.getDb();

    // Store 3 memories via adapter
    const now = Date.now();
    for (let i = 1; i <= 3; i++) {
      await adapter.store({
        id: `mem-${i}`,
        tenantId: "default",
        agentId: "default",
        userId: "u1",
        content: `Test memory content number ${i}`,
        trustLevel: "learned",
        source: { who: "agent" },
        tags: ["test"],
        createdAt: now + i,
      });
    }

    // Create batch indexer and embed all unembedded memories
    const batchIndexer = createBatchIndexer(adapterDb, mockPort, { batchSize: 10 });
    const indexResult = await batchIndexer.indexUnembedded();

    expect(indexResult.indexed).toBe(3);
    expect(indexResult.failed).toBe(0);

    // Search via adapter (uses embeddingPort.embed for query vector)
    const sessionKey = { tenantId: "default", userId: "u1", channelId: "test" };
    const searchResult = await adapter.search(sessionKey, "Test memory content", { limit: 10 });

    expect(searchResult.ok).toBe(true);
    if (searchResult.ok) {
      // Should return results (FTS5 at minimum, possibly hybrid if vec is available)
      expect(searchResult.value.length).toBeGreaterThan(0);
    }
  });

  it("cache prevents redundant embedding calls", async () => {
    const mockPort = createMockEmbeddingPort(DIMS, "cached-model");

    // Wrap with cache
    const cached = createCachedEmbeddingPort(mockPort, { maxEntries: 100 });

    // Call embed with same text twice
    const result1 = await cached.embed("same text for caching");
    const result2 = await cached.embed("same text for caching");

    expect(result1.ok).toBe(true);
    expect(result2.ok).toBe(true);

    // Inner embed should only be called once (second was cache hit)
    expect(mockPort.embedFn).toHaveBeenCalledTimes(1);

    // Both results should be identical
    if (result1.ok && result2.ok) {
      expect(result1.value).toEqual(result2.value);
    }
  });

  it("fingerprint detects model change and triggers reindex", async () => {
    const fingerprintMgr = createFingerprintManager(db);
    fingerprintMgr.ensureTable();

    // Create mock port A (4 dims, model-a)
    const portA = createMockEmbeddingPort(4, "model-a");

    // Save fingerprint for port A
    fingerprintMgr.save(fingerprintMgr.computeFingerprint(portA));

    // Verify no change detected for same port
    expect(fingerprintMgr.hasChanged(portA)).toBe(false);

    // Create mock port B (different model and dimensions)
    const portB = createMockEmbeddingPort(4, "model-b");

    // Should detect change since model changed
    expect(fingerprintMgr.hasChanged(portB)).toBe(true);

    // Insert some memories to reindex
    insertMemory(db, "m1", "hello world", 1);
    insertMemory(db, "m2", "test data", 1);
    insertMemory(db, "m3", "embedding test", 1);

    // Create batch indexer with port B and reindex all
    const batchIndexer = createBatchIndexer(db, portB, { batchSize: 10 });
    const result = await batchIndexer.reindexAll();

    // All 3 should be re-embedded with port B
    expect(result.indexed).toBe(3);
    expect(result.failed).toBe(0);
    expect(portB.embedBatchFn).toHaveBeenCalled();

    // Update fingerprint to port B
    fingerprintMgr.save(fingerprintMgr.computeFingerprint(portB));

    // No change detected for port B now
    expect(fingerprintMgr.hasChanged(portB)).toBe(false);
  });

  it("embedding queue processes new entries asynchronously", async () => {
    const mockPort = createMockEmbeddingPort(DIMS, "queue-model");

    // Insert entries first so the queue can update their has_embedding flag
    insertMemory(db, "q1", "queue entry one");
    insertMemory(db, "q2", "queue entry two");
    insertMemory(db, "q3", "queue entry three");

    // Create embedding queue
    const queue = createEmbeddingQueue(db, mockPort);

    // Enqueue 3 entries
    queue.enqueue("q1", "queue entry one");
    queue.enqueue("q2", "queue entry two");
    queue.enqueue("q3", "queue entry three");

    // Wait for queue to process all entries
    await queue.onIdle();

    // Verify has_embedding = 1 for all 3 entries
    const rows = db
      .prepare("SELECT id, has_embedding FROM memories WHERE id IN ('q1', 'q2', 'q3')")
      .all() as { id: string; has_embedding: number }[];

    for (const row of rows) {
      expect(row.has_embedding).toBe(1);
    }

    // Verify vec_memories has rows (if vec is available)
    if (isVecAvailable()) {
      const vecCount = db
        .prepare("SELECT COUNT(*) as cnt FROM vec_memories")
        .get() as { cnt: number };
      expect(vecCount.cnt).toBe(3);
    }
  });

  it("graceful degradation: no embedding port uses FTS5 only", async () => {
    // Create SqliteMemoryAdapter WITHOUT embedding port
    const adapter = new SqliteMemoryAdapter(
      { dbPath: ":memory:", walMode: false, embeddingDimensions: DIMS } as any,
    );
    const adapterDb = adapter.getDb();

    // Store memories
    const now = Date.now();
    for (let i = 1; i <= 3; i++) {
      await adapter.store({
        id: `fts-${i}`,
        tenantId: "default",
        agentId: "default",
        userId: "u1",
        content: `Searchable memory about topic ${i}`,
        trustLevel: "learned",
        source: { who: "agent" },
        tags: [],
        createdAt: now + i,
      });
    }

    // Search by text -- should return results via FTS5
    const sessionKey = { tenantId: "default", userId: "u1", channelId: "test" };
    const searchResult = await adapter.search(sessionKey, "Searchable memory topic", { limit: 10 });

    expect(searchResult.ok).toBe(true);
    if (searchResult.ok) {
      expect(searchResult.value.length).toBeGreaterThan(0);
    }

    // Verify no embeddings were generated
    const embeddedCount = adapterDb
      .prepare("SELECT COUNT(*) as cnt FROM memories WHERE has_embedding = 1")
      .get() as { cnt: number };
    expect(embeddedCount.cnt).toBe(0);
  });

  it("batch indexer handles embedBatch failure gracefully", async () => {
    // Create mock port that always fails embedBatch
    const failPort: EmbeddingPort = {
      provider: "test",
      dimensions: DIMS,
      modelId: "fail-model",
      embed: vi.fn().mockResolvedValue(err(new Error("embed failed"))),
      embedBatch: vi.fn().mockResolvedValue(err(new Error("batch failed"))),
    };

    // Insert memories to index
    insertMemory(db, "f1", "should fail embedding");
    insertMemory(db, "f2", "also should fail");
    insertMemory(db, "f3", "failing too");

    const indexer = createBatchIndexer(db, failPort, { batchSize: 10 });
    const result = await indexer.indexUnembedded();

    // All should fail
    expect(result.indexed).toBe(0);
    expect(result.failed).toBe(3);

    // Memories still have has_embedding = 0
    const unembedded = indexer.unembeddedCount();
    expect(unembedded).toBe(3);

    // embedBatch was called once (then stopped due to failure-stop behavior)
    expect(failPort.embedBatch).toHaveBeenCalledTimes(1);
  });
});
