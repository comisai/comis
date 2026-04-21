// SPDX-License-Identifier: Apache-2.0
import type { EmbeddingPort } from "@comis/core";
import type { Result } from "@comis/shared";
import { ok, err } from "@comis/shared";
import Database from "better-sqlite3";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { createEmbeddingQueue } from "./embedding-queue.js";
import { initSchema, isVecAvailable } from "./schema.js";

const DIMS = 4;

/**
 * Create a mock EmbeddingPort that returns deterministic embeddings.
 * Tracks call order via the `calls` array for FIFO verification.
 */
function createMockEmbeddingPort(opts?: {
  /** Delay in ms before resolving */
  delay?: number;
  /** If true, returns an error result instead of success */
  fail?: boolean;
}): EmbeddingPort & { calls: string[] } {
  const calls: string[] = [];
  const delay = opts?.delay ?? 0;
  const fail = opts?.fail ?? false;

  return {
    provider: "test",
    dimensions: DIMS,
    modelId: "test-embed-model",
    calls,
    async embed(text: string): Promise<Result<number[], Error>> {
      calls.push(text);
      if (delay > 0) {
        await new Promise((r) => setTimeout(r, delay));
      }
      if (fail) {
        return err(new Error("mock embedding failure"));
      }
      // Deterministic vector based on text chars
      const vec = new Array(DIMS).fill(0);
      for (let i = 0; i < text.length && i < DIMS; i++) {
        vec[i] = text.charCodeAt(i) / 256;
      }
      return ok(vec);
    },
    async embedBatch(texts: string[]): Promise<Result<number[][], Error>> {
      const results: number[][] = [];
      for (const t of texts) {
        const r = await this.embed(t);
        if (r.ok) results.push(r.value);
      }
      return ok(results);
    },
  };
}

/** Insert a minimal memory row into the database. */
function insertMemory(db: Database.Database, id: string, content: string): void {
  db.prepare(
    `INSERT INTO memories (id, tenant_id, user_id, content, trust_level, memory_type, source_who, tags, created_at)
     VALUES (?, 'default', 'u1', ?, 'learned', 'semantic', 'agent', '[]', ?)`,
  ).run(id, content, Date.now());
}

describe("createEmbeddingQueue", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    initSchema(db, DIMS);
  });

  it("enqueue does not block (returns immediately before embedding completes)", async () => {
    const port = createMockEmbeddingPort({ delay: 50 });
    const queue = createEmbeddingQueue(db, port);

    insertMemory(db, "m1", "hello world");
    queue.enqueue("m1", "hello world");

    // The call should have returned immediately -- check that the embedding
    // is NOT yet stored (still processing in background)
    const row = db.prepare("SELECT has_embedding FROM memories WHERE id = 'm1'").get() as {
      has_embedding: number;
    };
    expect(row.has_embedding).toBe(0);

    // Now wait for completion
    await queue.onIdle();
    const after = db.prepare("SELECT has_embedding FROM memories WHERE id = 'm1'").get() as {
      has_embedding: number;
    };
    expect(after.has_embedding).toBe(1);
  });

  it("after onIdle(), entry has embedding in vec_memories", async () => {
    if (!isVecAvailable()) return;

    const port = createMockEmbeddingPort();
    const queue = createEmbeddingQueue(db, port);

    insertMemory(db, "m1", "test content");
    queue.enqueue("m1", "test content");
    await queue.onIdle();

    const vecRow = db.prepare("SELECT memory_id FROM vec_memories WHERE memory_id = 'm1'").get() as
      | { memory_id: string }
      | undefined;

    expect(vecRow).toBeDefined();
    expect(vecRow!.memory_id).toBe("m1");
  });

  it("after onIdle(), memories.has_embedding = 1", async () => {
    const port = createMockEmbeddingPort();
    const queue = createEmbeddingQueue(db, port);

    insertMemory(db, "m1", "test content");
    queue.enqueue("m1", "test content");
    await queue.onIdle();

    const row = db.prepare("SELECT has_embedding FROM memories WHERE id = 'm1'").get() as {
      has_embedding: number;
    };
    expect(row.has_embedding).toBe(1);
  });

  it("multiple enqueues process FIFO (call order matches enqueue order)", async () => {
    const port = createMockEmbeddingPort();
    const queue = createEmbeddingQueue(db, port);

    insertMemory(db, "m1", "first");
    insertMemory(db, "m2", "second");
    insertMemory(db, "m3", "third");

    queue.enqueue("m1", "first");
    queue.enqueue("m2", "second");
    queue.enqueue("m3", "third");

    await queue.onIdle();

    expect(port.calls).toEqual(["first", "second", "third"]);
  });

  it("concurrency=1: second embed does not start until first finishes", async () => {
    const timeline: Array<{ text: string; event: "start" | "end" }> = [];

    const port: EmbeddingPort & { calls: string[] } = {
      provider: "test",
      dimensions: DIMS,
      modelId: "test-embed-model",
      calls: [],
      async embed(text: string): Promise<Result<number[], Error>> {
        this.calls.push(text);
        timeline.push({ text, event: "start" });
        await new Promise((r) => setTimeout(r, 30));
        timeline.push({ text, event: "end" });
        return ok(new Array(DIMS).fill(0.5));
      },
      async embedBatch(texts: string[]): Promise<Result<number[][], Error>> {
        return ok(texts.map(() => new Array(DIMS).fill(0.5)));
      },
    };

    const queue = createEmbeddingQueue(db, port);

    insertMemory(db, "m1", "alpha");
    insertMemory(db, "m2", "beta");

    queue.enqueue("m1", "alpha");
    queue.enqueue("m2", "beta");

    await queue.onIdle();

    // With concurrency=1, "alpha" must end before "beta" starts
    const alphaEnd = timeline.findIndex((e) => e.text === "alpha" && e.event === "end");
    const betaStart = timeline.findIndex((e) => e.text === "beta" && e.event === "start");

    expect(alphaEnd).toBeLessThan(betaStart);
  });

  it("failed embedding does not crash queue (entry stays without embedding)", async () => {
    const port = createMockEmbeddingPort({ fail: true });
    const queue = createEmbeddingQueue(db, port);

    insertMemory(db, "m1", "will fail");
    queue.enqueue("m1", "will fail");

    // Should not throw
    await queue.onIdle();

    // Entry should still exist but without embedding
    const row = db.prepare("SELECT has_embedding FROM memories WHERE id = 'm1'").get() as {
      has_embedding: number;
    };
    expect(row.has_embedding).toBe(0);

    // Memory itself is intact
    const mem = db.prepare("SELECT content FROM memories WHERE id = 'm1'").get() as {
      content: string;
    };
    expect(mem.content).toBe("will fail");
  });

  it("failed embedding logs warning via structured logger", async () => {
    const mockLogger = { warn: vi.fn() };

    const port = createMockEmbeddingPort({ fail: true });
    const queue = createEmbeddingQueue(db, port, mockLogger);

    insertMemory(db, "m1", "will fail");
    queue.enqueue("m1", "will fail");
    await queue.onIdle();

    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        entryId: "m1",
        err: expect.stringContaining("mock embedding failure"),
        hint: expect.stringContaining("FTS5"),
        errorKind: "dependency",
      }),
      "Embedding generation failed",
    );
  });

  it("pending() returns correct count before and after processing", async () => {
    const port = createMockEmbeddingPort({ delay: 30 });
    const queue = createEmbeddingQueue(db, port);

    // Before any enqueue
    expect(queue.pending()).toBe(0);

    insertMemory(db, "m1", "a");
    insertMemory(db, "m2", "b");
    insertMemory(db, "m3", "c");

    queue.enqueue("m1", "a");
    queue.enqueue("m2", "b");
    queue.enqueue("m3", "c");

    // At least some should be pending (1 running + others queued)
    expect(queue.pending()).toBeGreaterThan(0);

    await queue.onIdle();

    expect(queue.pending()).toBe(0);
  });

  it("pause() stops processing, resume() continues", async () => {
    const port = createMockEmbeddingPort({ delay: 10 });
    const queue = createEmbeddingQueue(db, port);

    insertMemory(db, "m1", "a");
    insertMemory(db, "m2", "b");

    queue.pause();
    queue.enqueue("m1", "a");
    queue.enqueue("m2", "b");

    // Give a tick for anything that might process
    await new Promise((r) => setTimeout(r, 50));

    // Nothing should have been processed while paused
    expect(port.calls).toHaveLength(0);

    queue.resume();
    await queue.onIdle();

    expect(port.calls).toHaveLength(2);
  });

  it("clear() removes pending items", async () => {
    const port = createMockEmbeddingPort({ delay: 50 });
    const queue = createEmbeddingQueue(db, port);

    insertMemory(db, "m1", "a");
    insertMemory(db, "m2", "b");
    insertMemory(db, "m3", "c");

    queue.enqueue("m1", "a");
    queue.enqueue("m2", "b");
    queue.enqueue("m3", "c");

    // Clear pending (in-progress item may still complete)
    queue.clear();

    await queue.onIdle();

    // Only the first item (already in-progress when clear was called) should have been processed
    // or possibly none if clear was very fast. At most 1 should complete.
    expect(port.calls.length).toBeLessThanOrEqual(1);
  });

  it("onIdle() resolves immediately when queue is empty", async () => {
    const port = createMockEmbeddingPort();
    const queue = createEmbeddingQueue(db, port);

    const start = Date.now();
    await queue.onIdle();
    const elapsed = Date.now() - start;

    // Should resolve nearly instantly (under 50ms)
    expect(elapsed).toBeLessThan(50);
  });

  it("embedding is stored as Float32Array in vec_memories", async () => {
    if (!isVecAvailable()) return;

    const port = createMockEmbeddingPort();
    const queue = createEmbeddingQueue(db, port);

    insertMemory(db, "m1", "AB");
    queue.enqueue("m1", "AB");
    await queue.onIdle();

    // Query the raw embedding from vec_memories
    const vecRow = db.prepare("SELECT embedding FROM vec_memories WHERE memory_id = 'm1'").get() as
      | { embedding: Buffer }
      | undefined;

    expect(vecRow).toBeDefined();

    // Convert Buffer back to Float32Array and verify values
    const float32 = new Float32Array(
      vecRow!.embedding.buffer,
      vecRow!.embedding.byteOffset,
      vecRow!.embedding.byteLength / Float32Array.BYTES_PER_ELEMENT,
    );

    expect(float32.length).toBe(DIMS);
    // "A" = 65, "B" = 66; charCode / 256
    expect(float32[0]).toBeCloseTo(65 / 256, 5);
    expect(float32[1]).toBeCloseTo(66 / 256, 5);
  });
});
