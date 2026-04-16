import type { EmbeddingPort } from "@comis/core";
import type { Result } from "@comis/shared";
import { ok, err } from "@comis/shared";
import { describe, it, expect, vi } from "vitest";
import { createCachedEmbeddingPort } from "./embedding-cache-lru.js";

const DIMS = 4;

/** Create a mock EmbeddingPort with vi.fn() methods for call tracking. */
function createMockPort(): EmbeddingPort & {
  embedFn: ReturnType<typeof vi.fn>;
  embedBatchFn: ReturnType<typeof vi.fn>;
} {
  const embedFn = vi.fn<(text: string) => Promise<Result<number[], Error>>>(
    async (text: string) => {
      const vec = new Array(DIMS).fill(0);
      for (let i = 0; i < text.length && i < DIMS; i++) {
        vec[i] = text.charCodeAt(i) / 256;
      }
      return ok(vec);
    },
  );

  const embedBatchFn = vi.fn<(texts: string[]) => Promise<Result<number[][], Error>>>(
    async (texts: string[]) => {
      const vecs: number[][] = [];
      for (const t of texts) {
        const vec = new Array(DIMS).fill(0);
        for (let i = 0; i < t.length && i < DIMS; i++) {
          vec[i] = t.charCodeAt(i) / 256;
        }
        vecs.push(vec);
      }
      return ok(vecs);
    },
  );

  return {
    provider: "test",
    dimensions: DIMS,
    modelId: "test-model",
    embed: embedFn,
    embedBatch: embedBatchFn,
    embedFn,
    embedBatchFn,
  };
}

describe("createCachedEmbeddingPort", () => {
  it("first embed call hits inner, second returns from cache", async () => {
    const mock = createMockPort();
    const cached = createCachedEmbeddingPort(mock, { maxEntries: 100 });

    const r1 = await cached.embed("hello");
    expect(r1.ok).toBe(true);
    expect(mock.embedFn).toHaveBeenCalledTimes(1);

    const r2 = await cached.embed("hello");
    expect(r2.ok).toBe(true);
    // Inner should NOT be called again
    expect(mock.embedFn).toHaveBeenCalledTimes(1);

    // Both results should be identical
    if (r1.ok && r2.ok) {
      expect(r1.value).toEqual(r2.value);
    }
  });

  it("embedBatch with mix of cached and uncached only sends misses to inner", async () => {
    const mock = createMockPort();
    const cached = createCachedEmbeddingPort(mock, { maxEntries: 100 });

    // Pre-cache "alpha" via single embed
    await cached.embed("alpha");
    expect(mock.embedFn).toHaveBeenCalledTimes(1);

    // Now embedBatch with alpha (cached) + beta (uncached) + gamma (uncached)
    const result = await cached.embedBatch(["alpha", "beta", "gamma"]);
    expect(result.ok).toBe(true);

    // Inner embedBatch should only receive the uncached texts
    expect(mock.embedBatchFn).toHaveBeenCalledTimes(1);
    expect(mock.embedBatchFn).toHaveBeenCalledWith(["beta", "gamma"]);

    // Result should have 3 vectors
    if (result.ok) {
      expect(result.value).toHaveLength(3);
    }
  });

  it("embedBatch with all cached returns immediately without calling inner", async () => {
    const mock = createMockPort();
    const cached = createCachedEmbeddingPort(mock, { maxEntries: 100 });

    // Pre-cache all texts via single embeds
    await cached.embed("one");
    await cached.embed("two");
    mock.embedFn.mockClear();
    mock.embedBatchFn.mockClear();

    const result = await cached.embedBatch(["one", "two"]);
    expect(result.ok).toBe(true);

    // Neither embed nor embedBatch should be called
    expect(mock.embedFn).not.toHaveBeenCalled();
    expect(mock.embedBatchFn).not.toHaveBeenCalled();

    if (result.ok) {
      expect(result.value).toHaveLength(2);
    }
  });

  it("cache respects maxEntries (oldest evicted)", async () => {
    const mock = createMockPort();
    const cached = createCachedEmbeddingPort(mock, { maxEntries: 2 });

    // Fill cache to max
    await cached.embed("first");
    await cached.embed("second");
    expect(mock.embedFn).toHaveBeenCalledTimes(2);

    // Add a third entry, which should evict "first"
    await cached.embed("third");
    expect(mock.embedFn).toHaveBeenCalledTimes(3);

    // "second" and "third" should be cached
    mock.embedFn.mockClear();
    await cached.embed("second");
    await cached.embed("third");
    expect(mock.embedFn).not.toHaveBeenCalled();

    // "first" should have been evicted -- must call inner again
    await cached.embed("first");
    expect(mock.embedFn).toHaveBeenCalledTimes(1);
  });

  it("embed error is not cached", async () => {
    const mock = createMockPort();
    // Make first call fail
    mock.embedFn.mockResolvedValueOnce(err(new Error("provider down")));

    const cached = createCachedEmbeddingPort(mock, { maxEntries: 100 });

    const r1 = await cached.embed("failing");
    expect(r1.ok).toBe(false);
    expect(mock.embedFn).toHaveBeenCalledTimes(1);

    // Now make inner succeed
    mock.embedFn.mockResolvedValueOnce(ok([1, 2, 3, 4]));

    const r2 = await cached.embed("failing");
    expect(r2.ok).toBe(true);
    // Inner should be called again since error was not cached
    expect(mock.embedFn).toHaveBeenCalledTimes(2);
  });

  it("preserves dimensions and modelId from inner port", () => {
    const mock = createMockPort();
    const cached = createCachedEmbeddingPort(mock, { maxEntries: 100 });

    expect(cached.dimensions).toBe(DIMS);
    expect(cached.modelId).toBe("test-model");
  });

  it("embedBatch propagates inner error", async () => {
    const mock = createMockPort();
    mock.embedBatchFn.mockResolvedValueOnce(err(new Error("batch failure")));

    const cached = createCachedEmbeddingPort(mock, { maxEntries: 100 });

    const result = await cached.embedBatch(["a", "b"]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toBe("batch failure");
    }
  });

  it("dispose() forwards to inner port", async () => {
    const mock = createMockPort();
    const disposeFn = vi.fn(async () => {});
    (mock as any).dispose = disposeFn;
    const cached = createCachedEmbeddingPort(mock, { maxEntries: 100 });
    await cached.dispose!();
    expect(disposeFn).toHaveBeenCalledTimes(1);
  });

  it("dispose() handles inner without dispose method", async () => {
    const mock = createMockPort();
    const cached = createCachedEmbeddingPort(mock, { maxEntries: 100 });
    // Should not throw when inner has no dispose
    await expect(cached.dispose!()).resolves.toBeUndefined();
  });

  it("embedBatch does not rehash texts on cache store", async () => {
    const mock = createMockPort();
    const cached = createCachedEmbeddingPort(mock, { maxEntries: 100 });
    // First call: all misses, inner called
    const result = await cached.embedBatch(["x", "y", "z"]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toHaveLength(3);
    // Second call: all cached, inner NOT called
    mock.embedBatchFn.mockClear();
    const result2 = await cached.embedBatch(["x", "y", "z"]);
    expect(result2.ok).toBe(true);
    expect(mock.embedBatchFn).not.toHaveBeenCalled();
  });

  describe("getCacheStats", () => {
    it("returns zeroed stats on fresh cache", () => {
      const mock = createMockPort();
      const cached = createCachedEmbeddingPort(mock, { maxEntries: 100 });
      const stats = cached.getCacheStats();
      expect(stats).toEqual({
        entries: 0,
        maxEntries: 100,
        hitRate: 0,
        hits: 0,
        misses: 0,
        provider: "test",
      });
    });

    it("tracks miss on first embed and hit on second", async () => {
      const mock = createMockPort();
      const cached = createCachedEmbeddingPort(mock, { maxEntries: 100 });

      await cached.embed("hello");
      let stats = cached.getCacheStats();
      expect(stats.misses).toBe(1);
      expect(stats.hits).toBe(0);
      expect(stats.entries).toBe(1);

      await cached.embed("hello");
      stats = cached.getCacheStats();
      expect(stats.hits).toBe(1);
      expect(stats.misses).toBe(1);
      expect(stats.hitRate).toBe(0.5);
      expect(stats.entries).toBe(1);
    });

    it("tracks hits and misses in embedBatch", async () => {
      const mock = createMockPort();
      const cached = createCachedEmbeddingPort(mock, { maxEntries: 100 });

      // Pre-cache "alpha"
      await cached.embed("alpha");
      // stats: 1 miss, 0 hits

      // embedBatch with alpha (hit) + beta (miss) + gamma (miss)
      await cached.embedBatch(["alpha", "beta", "gamma"]);
      const stats = cached.getCacheStats();
      // embed: 1 miss
      // embedBatch: 1 hit + 2 misses
      expect(stats.hits).toBe(1);
      expect(stats.misses).toBe(3);
      expect(stats.entries).toBe(3);
      expect(stats.hitRate).toBe(1 / 4);
    });
  });

  describe("TTL support", () => {
    it("expires entries after ttlMs", async () => {
      const mock = createMockPort();
      const cached = createCachedEmbeddingPort(mock, {
        maxEntries: 100,
        ttlMs: 100,
      });

      // First call -- inner called
      await cached.embed("hello");
      expect(mock.embedFn).toHaveBeenCalledTimes(1);

      // Immediate second call -- cache hit, inner NOT called
      await cached.embed("hello");
      expect(mock.embedFn).toHaveBeenCalledTimes(1);

      // Wait for TTL to expire
      await new Promise((r) => setTimeout(r, 150));

      // After TTL -- inner called again
      await cached.embed("hello");
      expect(mock.embedFn).toHaveBeenCalledTimes(2);
    });

    it("entries persist without TTL (LRU only)", async () => {
      const mock = createMockPort();
      const cached = createCachedEmbeddingPort(mock, { maxEntries: 100 });

      // First call -- inner called
      await cached.embed("hello");
      expect(mock.embedFn).toHaveBeenCalledTimes(1);

      // Wait longer than the TTL test above
      await new Promise((r) => setTimeout(r, 200));

      // Still cached -- inner NOT called (no TTL, pure LRU)
      await cached.embed("hello");
      expect(mock.embedFn).toHaveBeenCalledTimes(1);
    });
  });
});
