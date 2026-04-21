// SPDX-License-Identifier: Apache-2.0
/**
 * SQLite L2 embedding cache adapter.
 *
 * Wraps any EmbeddingPort with a persistent SQLite-backed cache keyed by
 * composite (provider, model, config_hash, text_hash). Stores embeddings
 * as BLOB (Float32Array serialized via Buffer). Cache misses delegate to
 * the inner provider and UPSERT the result. UPSERT uses ON CONFLICT DO
 * UPDATE (not INSERT OR REPLACE) to preserve rowid stability.
 *
 * Prepared SQL statements are created once at factory init.
 *
 * @module
 */

import type { EmbeddingPort } from "@comis/core";
import { ok, type Result } from "@comis/shared";
import type Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { computeEmbeddingIdentityHash } from "./embedding-hash.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface SqliteEmbeddingCacheOptions {
  /** Shared memory database (must have embedding_cache table from initSchema). */
  db: Database.Database;
  /** Maximum number of cached embeddings. Default: 50_000 */
  maxEntries: number;
  /** Optional TTL in milliseconds. */
  ttlMs?: number;
  /** Prune check interval in milliseconds. Default: 300_000 (5 min). */
  pruneIntervalMs?: number;
}

// ---------------------------------------------------------------------------
// BLOB conversion helpers (module-level, not exported)
// ---------------------------------------------------------------------------

/** Serialize a number[] embedding to a BLOB-ready Buffer via Float32Array. */
function vectorToBlob(embedding: number[]): Buffer {
  const f32 = new Float32Array(embedding);
  // 3-arg defensive form -- avoids SharedArrayBuffer edge cases
  return Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength);
}

/** Deserialize a BLOB Buffer back to number[] via Float32Array. */
function blobToVector(buffer: Buffer): number[] {
  const f32 = new Float32Array(
    buffer.buffer,
    buffer.byteOffset,
    buffer.byteLength / Float32Array.BYTES_PER_ELEMENT,
  );
  return Array.from(f32);
}

/** SHA-256 hex hash of text content (cache key component). */
function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

// ---------------------------------------------------------------------------
// Batch SELECT constants
// ---------------------------------------------------------------------------

/** Fixed params in batch SELECT: provider, model, config_hash. */
const FIXED_PARAMS = 3;
/** Max text hashes per batch SELECT to stay within SQLite's 999-variable limit. */
const MAX_HASHES_PER_QUERY = 999 - FIXED_PARAMS; // 996

// ---------------------------------------------------------------------------
// Cache row types
// ---------------------------------------------------------------------------

interface CacheRow {
  embedding: Buffer;
}

interface BatchCacheRow {
  text_hash: string;
  embedding: Buffer;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a persistent L2 embedding cache adapter wrapping an inner EmbeddingPort.
 *
 * Cache entries are keyed by composite (provider, model, config_hash, text_hash)
 * and stored as Float32Array BLOBs. Prepared statements are initialized once.
 *
 * @param inner - The underlying EmbeddingPort to delegate cache misses to
 * @param options - SQLite database and cache configuration
 * @returns An EmbeddingPort with transparent persistent caching
 */
export function createSqliteEmbeddingCache(
  inner: EmbeddingPort,
  options: SqliteEmbeddingCacheOptions,
): EmbeddingPort {
  const { db } = options;

  // Read inner identity at construction time
  const provider = inner.provider;
  const modelId = inner.modelId;
  const dimensions = inner.dimensions;
  const configHash = computeEmbeddingIdentityHash(modelId, dimensions);

  // --- Prepare SQL statements ONCE ---
  const selectOneStmt = db.prepare<[string, string, string, string], CacheRow>(
    `SELECT embedding FROM embedding_cache
     WHERE provider = ? AND model = ? AND config_hash = ? AND text_hash = ?`,
  );

  // UPSERT: ON CONFLICT DO UPDATE preserves rowid.
  // Re-embed resets hit_count = 0.
  const upsertStmt = db.prepare(
    `INSERT INTO embedding_cache
       (provider, model, config_hash, text_hash, embedding, dims, hit_count, created_at, accessed_at)
     VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)
     ON CONFLICT(provider, model, config_hash, text_hash) DO UPDATE SET
       embedding = excluded.embedding,
       dims = excluded.dims,
       hit_count = 0,
       accessed_at = excluded.accessed_at`,
  );

  // Lazy access buffer UPDATE
  const updateAccessStmt = db.prepare(
    `UPDATE embedding_cache SET accessed_at = ?, hit_count = hit_count + 1
     WHERE provider = ? AND model = ? AND config_hash = ? AND text_hash = ?`,
  );

  // LRU prune DELETE: keeps the top maxEntries by accessed_at
  const pruneStmt = db.prepare(
    `DELETE FROM embedding_cache WHERE rowid IN (
       SELECT rowid FROM embedding_cache ORDER BY accessed_at ASC
       LIMIT max(0, (SELECT COUNT(*) FROM embedding_cache) - ?)
     )`,
  );

  // TTL prune DELETE: removes entries older than a cutoff timestamp
  const ttlPruneStmt = db.prepare(
    "DELETE FROM embedding_cache WHERE created_at < ?",
  );

  // --- Batch SELECT helper (closure over db, provider, model, configHash) ---
  // Chunks hashes into groups of MAX_HASHES_PER_QUERY (996) to respect
  // SQLite's SQLITE_MAX_VARIABLE_NUMBER (999) limit. better-sqlite3 caches
  // compiled SQL internally for repeated identical batch sizes.
  function batchSelect(textHashes: string[]): Map<string, Buffer> {
    const hits = new Map<string, Buffer>();
    for (let i = 0; i < textHashes.length; i += MAX_HASHES_PER_QUERY) {
      const chunk = textHashes.slice(i, i + MAX_HASHES_PER_QUERY);
      const placeholders = chunk.map(() => "?").join(", ");
      const stmt = db.prepare(
        `SELECT text_hash, embedding FROM embedding_cache
         WHERE provider = ? AND model = ? AND config_hash = ?
         AND text_hash IN (${placeholders})`,
      );
      const rows = stmt.all(provider, modelId, configHash, ...chunk) as BatchCacheRow[];
      for (const row of rows) {
        hits.set(row.text_hash, row.embedding);
      }
    }
    return hits;
  }

  // ---------------------------------------------------------------------------
  // Lazy accessed_at buffer
  // ---------------------------------------------------------------------------

  /** Pending access timestamps keyed by text_hash. Flushed at threshold or on prune/dispose. */
  const accessBuffer = new Map<string, number>();
  const FLUSH_THRESHOLD = 100;

  /** Record a cache hit for lazy access-time tracking. */
  function recordAccess(textHash: string): void {
    accessBuffer.set(textHash, Date.now());
    if (accessBuffer.size >= FLUSH_THRESHOLD) {
      flushAccessBuffer();
    }
  }

  /** Flush pending access timestamps to SQLite in a single transaction. */
  function flushAccessBuffer(): void {
    if (accessBuffer.size === 0) return;
    const tx = db.transaction(() => {
      for (const [textHash, ts] of accessBuffer) {
        updateAccessStmt.run(ts, provider, modelId, configHash, textHash);
      }
    });
    tx();
    accessBuffer.clear();
  }

  // ---------------------------------------------------------------------------
  // LRU prune + TTL eviction + WAL checkpoint
  // ---------------------------------------------------------------------------

  /** Evict stale entries: flush buffer -> LRU prune -> optional TTL -> WAL checkpoint. */
  function prune(): void {
    // CRITICAL: flush lazy buffer BEFORE prune -- otherwise recently-accessed
    // entries have stale accessed_at in SQLite and may be incorrectly evicted.
    flushAccessBuffer();

    // LRU eviction: keep only the maxEntries most recently accessed
    const changes = pruneStmt.run(options.maxEntries);

    // Optional TTL eviction
    let ttlChanges = 0;
    if (options.ttlMs != null) {
      const ttlResult = ttlPruneStmt.run(Date.now() - options.ttlMs);
      ttlChanges = ttlResult.changes;
    }

    // WAL checkpoint after prune to reclaim space from BLOB deletes
    if (changes.changes > 0 || ttlChanges > 0) {
      db.pragma("wal_checkpoint(PASSIVE)");
    }
  }

  // ---------------------------------------------------------------------------
  // Prune timer
  // ---------------------------------------------------------------------------

  const pruneIntervalMs = options.pruneIntervalMs ?? 300_000;
  const pruneTimer = setInterval(() => {
    prune();
  }, pruneIntervalMs);
  // Prevent timer from keeping Node.js process alive
  pruneTimer.unref();

  // ---------------------------------------------------------------------------
  // Dispose guard
  // ---------------------------------------------------------------------------

  let disposed = false;

  return {
    provider,
    dimensions,
    modelId,

    async embed(text: string): Promise<Result<number[], Error>> {
      const textHash = hashText(text);

      // Cache lookup
      const row = selectOneStmt.get(provider, modelId, configHash, textHash);
      if (row) {
        // Cache hit -- return deserialized BLOB; record access lazily
        recordAccess(textHash);
        return ok(blobToVector(row.embedding));
      }

      // Cache miss -- delegate to inner provider
      const result = await inner.embed(text);
      if (result.ok) {
        const now = Date.now();
        upsertStmt.run(
          provider,
          modelId,
          configHash,
          textHash,
          vectorToBlob(result.value),
          dimensions,
          now,
          now,
        );
      }
      return result;
    },

    async embedBatch(texts: string[]): Promise<Result<number[][], Error>> {
      // (a) Early return for empty batch
      if (texts.length === 0) return ok([]);

      // (b) Compute text hashes once (avoid redundant SHA-256)
      const textHashes = texts.map((t) => hashText(t));

      // (c) Batch SELECT for L2 cache hits
      const hits = batchSelect(textHashes);

      // (d) Build results array and collect misses
      const results: (number[] | null)[] = new Array(texts.length).fill(null);
      const missIndices: number[] = [];
      const missTexts: string[] = [];
      const missHashes: string[] = [];

      for (let i = 0; i < texts.length; i++) {
        const hit = hits.get(textHashes[i]);
        if (hit) {
          results[i] = blobToVector(hit);
          recordAccess(textHashes[i]);
        } else {
          missIndices.push(i);
          missTexts.push(texts[i]);
          missHashes.push(textHashes[i]);
        }
      }

      // (e) All hits -- no provider call needed
      if (missIndices.length === 0) return ok(results as number[][]);

      // (f) Call inner provider for misses only
      const batchResult = await inner.embedBatch(missTexts);

      // (g) On error: return error
      if (!batchResult.ok) return batchResult;

      // (h) UPSERT miss results in a single transaction
      const now = Date.now();
      const upsertMisses = db.transaction(() => {
        for (let j = 0; j < missIndices.length; j++) {
          const idx = missIndices[j];
          results[idx] = batchResult.value[j];
          upsertStmt.run(
            provider,
            modelId,
            configHash,
            missHashes[j],
            vectorToBlob(batchResult.value[j]),
            dimensions,
            now,
            now,
          );
        }
      });
      upsertMisses();

      // WAL checkpoint after bulk inserts to prevent journal growth
      if (missIndices.length >= 50) {
        db.pragma("wal_checkpoint(PASSIVE)");
      }

      // (i) Return ordered results
      return ok(results as number[][]);
    },

    async dispose(): Promise<void> {
      if (disposed) return;
      disposed = true;
      // Flush pending access timestamps to SQLite before shutdown
      flushAccessBuffer();
      // Stop periodic prune timer
      clearInterval(pruneTimer);
      // Forward to inner provider (critical for GPU cleanup with local providers)
      await inner.dispose?.();
    },
  };
}
