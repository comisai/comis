// SPDX-License-Identifier: Apache-2.0
/**
 * Cached embedding port decorator.
 *
 * Wraps any EmbeddingPort with an LRU cache keyed by SHA-256 content
 * hashes. Previously-seen text returns immediately without calling
 * the inner provider. embedBatch splits texts into cache hits and
 * misses, only calling the inner provider for misses.
 */

import type { EmbeddingPort } from "@comis/core";
import { ok, type Result } from "@comis/shared";
import { createHash } from "node:crypto";
import { LRUCache } from "lru-cache";

export interface EmbeddingCacheOptions {
  /** Maximum number of cached embeddings. Default: 10_000 */
  maxEntries: number;
  /** TTL in milliseconds. Default: undefined (no TTL, LRU only).
   *  Recommended: 86_400_000 (24 hours) for long-running daemons. */
  ttlMs?: number;
}

/** Snapshot of embedding cache statistics. */
export interface EmbeddingCacheStats {
  entries: number;
  maxEntries: number;
  hitRate: number;
  hits: number;
  misses: number;
  provider: string;
}

/**
 * Create a cached EmbeddingPort decorator that wraps the given inner
 * provider with an LRU content-hash cache.
 *
 * @param inner - The underlying EmbeddingPort to delegate cache misses to
 * @param options - Cache configuration (maxEntries)
 * @returns An EmbeddingPort with transparent caching
 */
export function createCachedEmbeddingPort(
  inner: EmbeddingPort,
  options: EmbeddingCacheOptions,
): EmbeddingPort & { getCacheStats(): EmbeddingCacheStats } {
  const cache = new LRUCache<string, number[]>({
    max: options.maxEntries,
    ...(options.ttlMs ? { ttl: options.ttlMs } : {}),
  });
  let hits = 0;
  let misses = 0;

  function hashText(text: string): string {
    return createHash("sha256").update(text).digest("hex");
  }

  return {
    provider: inner.provider,
    dimensions: inner.dimensions,
    modelId: inner.modelId,

    async dispose(): Promise<void> {
      await inner.dispose?.();
    },

    async embed(text: string): Promise<Result<number[], Error>> {
      const key = hashText(text);
      const cached = cache.get(key);
      if (cached) {
        hits++;
        return ok(cached);
      }

      misses++;
      const result = await inner.embed(text);
      if (result.ok) cache.set(key, result.value);
      return result;
    },

    async embedBatch(texts: string[]): Promise<Result<number[][], Error>> {
      // Split into hits and misses
      const results: (number[] | null)[] = [];
      const missIndices: number[] = [];
      const missTexts: string[] = [];
      const missHashes: string[] = [];

      for (let i = 0; i < texts.length; i++) {
        const key = hashText(texts[i]);
        const cached = cache.get(key);
        if (cached) {
          hits++;
          results.push(cached);
        } else {
          misses++;
          results.push(null);
          missIndices.push(i);
          missTexts.push(texts[i]);
          missHashes.push(key);
        }
      }

      // If all cached, return immediately
      if (missTexts.length === 0) {
        return ok(results as number[][]);
      }

      // Embed misses in a single batch
      const batchResult = await inner.embedBatch(missTexts);
      if (!batchResult.ok) return batchResult;

      // Merge: fill in misses and cache them
      for (let j = 0; j < missIndices.length; j++) {
        const idx = missIndices[j];
        results[idx] = batchResult.value[j];
        cache.set(missHashes[j], batchResult.value[j]);
      }

      return ok(results as number[][]);
    },

    getCacheStats(): EmbeddingCacheStats {
      const total = hits + misses;
      return {
        entries: cache.size,
        maxEntries: cache.max,
        hitRate: total > 0 ? hits / total : 0,
        hits,
        misses,
        provider: inner.provider,
      };
    },
  };
}
