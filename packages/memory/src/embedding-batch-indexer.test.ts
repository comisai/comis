// SPDX-License-Identifier: Apache-2.0
import type { EmbeddingPort } from "@comis/core";
import type { Result } from "@comis/shared";
import { ok, err } from "@comis/shared";
import Database from "better-sqlite3";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { createBatchIndexer } from "./embedding-batch-indexer.js";
import { initSchema } from "./schema.js";

const DIMS = 4;

/** Create a mock EmbeddingPort that returns deterministic vectors. */
function createMockPort(opts?: { failAfterBatches?: number }): EmbeddingPort & {
  embedBatchFn: ReturnType<typeof vi.fn>;
  batchCallCount: number;
} {
  let batchCallCount = 0;
  const failAfter = opts?.failAfterBatches ?? Infinity;

  const embedBatchFn = vi.fn<(texts: string[]) => Promise<Result<number[][], Error>>>(
    async (texts: string[]) => {
      batchCallCount++;
      if (batchCallCount > failAfter) {
        return err(new Error("provider unavailable"));
      }
      const vecs: number[][] = texts.map((t) => {
        const vec = new Array(DIMS).fill(0);
        for (let i = 0; i < t.length && i < DIMS; i++) {
          vec[i] = t.charCodeAt(i) / 256;
        }
        return vec;
      });
      return ok(vecs);
    },
  );

  const port: EmbeddingPort & {
    embedBatchFn: ReturnType<typeof vi.fn>;
    batchCallCount: number;
  } = {
    provider: "test",
    dimensions: DIMS,
    modelId: "test-embed-model",
    embed: vi.fn().mockResolvedValue(ok(new Array(DIMS).fill(0))),
    embedBatch: embedBatchFn,
    embedBatchFn,
    get batchCallCount() {
      return batchCallCount;
    },
  };

  return port;
}

/** Insert a minimal memory row. */
function insertMemory(
  db: Database.Database,
  id: string,
  content: string,
  hasEmbedding = 0,
): void {
  db.prepare(
    `INSERT INTO memories (id, tenant_id, user_id, content, trust_level, memory_type, source_who, tags, created_at, has_embedding)
     VALUES (?, 'default', 'u1', ?, 'learned', 'semantic', 'agent', '[]', ?, ?)`,
  ).run(id, content, Date.now(), hasEmbedding);
}

describe("createBatchIndexer", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    initSchema(db, DIMS);
  });

  it("indexUnembedded embeds all unembedded memories", async () => {
    const port = createMockPort();
    const indexer = createBatchIndexer(db, port);

    insertMemory(db, "m1", "hello world");
    insertMemory(db, "m2", "goodbye world");
    insertMemory(db, "m3", "test content");

    const result = await indexer.indexUnembedded();
    expect(result.indexed).toBe(3);
    expect(result.failed).toBe(0);

    // All should now be marked as embedded
    const count = indexer.unembeddedCount();
    expect(count).toBe(0);
  });

  it("indexUnembedded with multiple batches processes all", async () => {
    const port = createMockPort();
    const indexer = createBatchIndexer(db, port, { batchSize: 2 });

    // Insert 5 memories, batchSize=2 -> 3 batches (2, 2, 1)
    for (let i = 0; i < 5; i++) {
      insertMemory(db, `m${i}`, `content ${i}`);
    }

    const result = await indexer.indexUnembedded();
    expect(result.indexed).toBe(5);
    expect(result.failed).toBe(0);

    // Should have been called 3 times (batches of 2, 2, 1)
    expect(port.embedBatchFn).toHaveBeenCalledTimes(3);
    expect(indexer.unembeddedCount()).toBe(0);
  });

  it("indexUnembedded stops on embedBatch failure", async () => {
    // Fail after the first batch
    const port = createMockPort({ failAfterBatches: 1 });
    const indexer = createBatchIndexer(db, port, { batchSize: 2 });

    // Insert 4 memories -> would need 2 batches
    for (let i = 0; i < 4; i++) {
      insertMemory(db, `m${i}`, `content ${i}`);
    }

    const result = await indexer.indexUnembedded();
    // First batch of 2 succeeded, second batch of 2 failed
    expect(result.indexed).toBe(2);
    expect(result.failed).toBe(2);

    // 2 still unembedded
    expect(indexer.unembeddedCount()).toBe(2);
  });

  it("reindexAll clears and re-embeds everything", async () => {
    const port = createMockPort();
    const indexer = createBatchIndexer(db, port);

    // Insert memories already marked as embedded
    insertMemory(db, "m1", "hello", 1);
    insertMemory(db, "m2", "world", 1);

    // Verify they start as embedded
    expect(indexer.unembeddedCount()).toBe(0);

    const result = await indexer.reindexAll();
    expect(result.indexed).toBe(2);
    expect(result.failed).toBe(0);

    // embedBatch should have been called to re-embed
    expect(port.embedBatchFn).toHaveBeenCalled();
    expect(indexer.unembeddedCount()).toBe(0);
  });

  it("unembeddedCount returns correct count", () => {
    const port = createMockPort();
    const indexer = createBatchIndexer(db, port);

    expect(indexer.unembeddedCount()).toBe(0);

    insertMemory(db, "m1", "hello");
    expect(indexer.unembeddedCount()).toBe(1);

    insertMemory(db, "m2", "world");
    expect(indexer.unembeddedCount()).toBe(2);

    // One already embedded
    insertMemory(db, "m3", "embedded", 1);
    expect(indexer.unembeddedCount()).toBe(2);
  });

  it("indexUnembedded with no unembedded entries returns zeros", async () => {
    const port = createMockPort();
    const indexer = createBatchIndexer(db, port);

    // No memories at all
    const result = await indexer.indexUnembedded();
    expect(result.indexed).toBe(0);
    expect(result.failed).toBe(0);

    // embedBatch should never be called
    expect(port.embedBatchFn).not.toHaveBeenCalled();
  });

  it("indexUnembedded skips already-embedded memories", async () => {
    const port = createMockPort();
    const indexer = createBatchIndexer(db, port);

    // Mix of embedded and unembedded
    insertMemory(db, "m1", "already done", 1);
    insertMemory(db, "m2", "needs embedding");

    const result = await indexer.indexUnembedded();
    expect(result.indexed).toBe(1);
    expect(result.failed).toBe(0);

    // Only 1 text sent to embedBatch
    expect(port.embedBatchFn).toHaveBeenCalledTimes(1);
    expect(port.embedBatchFn).toHaveBeenCalledWith(["needs embedding"]);
  });

  it("indexUnembedded handles per-item null failures gracefully", async () => {
    // Create a port that returns null for the second item
    const perItemFailPort: EmbeddingPort = {
      provider: "test",
      dimensions: DIMS,
      modelId: "test-embed-model",
      embed: vi.fn().mockResolvedValue(ok(new Array(DIMS).fill(0))),
      embedBatch: vi.fn(async (texts: string[]) => {
        const vecs = texts.map((t, i) => {
          if (i === 1) return null; // Second item fails
          const vec = new Array(DIMS).fill(0);
          for (let j = 0; j < t.length && j < DIMS; j++) {
            vec[j] = t.charCodeAt(j) / 256;
          }
          return vec;
        });
        return ok(vecs as number[][]);
      }),
    };

    const indexer = createBatchIndexer(db, perItemFailPort);

    insertMemory(db, "m1", "hello world");
    insertMemory(db, "m2", "this one fails");
    insertMemory(db, "m3", "test content");

    const result = await indexer.indexUnembedded();
    expect(result.indexed).toBe(2);
    expect(result.failed).toBe(1);

    // Successful ones should have has_embedding = 1
    const m1 = db.prepare("SELECT has_embedding FROM memories WHERE id = ?").get("m1") as { has_embedding: number };
    const m3 = db.prepare("SELECT has_embedding FROM memories WHERE id = ?").get("m3") as { has_embedding: number };
    expect(m1.has_embedding).toBe(1);
    expect(m3.has_embedding).toBe(1);

    // Failed one should have has_embedding = -1 (permanently failed, not retried)
    const m2 = db.prepare("SELECT has_embedding FROM memories WHERE id = ?").get("m2") as { has_embedding: number };
    expect(m2.has_embedding).toBe(-1);

    // No unembedded (0) left -- all are either 1 or -1
    expect(indexer.unembeddedCount()).toBe(0);
  });

  it("indexUnembedded truncates oversized text before embedding", async () => {
    // Track texts passed to embedBatch
    let capturedTexts: string[] = [];
    const capturingPort: EmbeddingPort = {
      provider: "test",
      dimensions: DIMS,
      modelId: "test-embed-model",
      embed: vi.fn().mockResolvedValue(ok(new Array(DIMS).fill(0))),
      embedBatch: vi.fn(async (texts: string[]) => {
        capturedTexts = texts;
        const vecs: number[][] = texts.map(() => new Array(DIMS).fill(0));
        return ok(vecs);
      }),
    };

    const indexer = createBatchIndexer(db, capturingPort);

    // Insert a memory with content exceeding 6144 chars (1536 tokens * 4 chars/token)
    const oversizedContent = "x".repeat(50_000);
    insertMemory(db, "m1", oversizedContent);

    await indexer.indexUnembedded();

    // The text passed to embedBatch should be truncated to 6144 chars
    expect(capturedTexts.length).toBe(1);
    expect(capturedTexts[0].length).toBe(6_144);
  });
});
