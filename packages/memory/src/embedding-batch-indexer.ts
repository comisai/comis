// SPDX-License-Identifier: Apache-2.0
/**
 * Batch embedding indexer.
 *
 * Processes unembedded memories (has_embedding=0) in configurable
 * batches via embedBatch(). Useful for bootstrapping a fresh vector
 * index from an existing corpus or re-indexing after a provider change.
 *
 * reindexAll() clears vec_memories, resets all has_embedding flags,
 * then runs indexUnembedded() to re-embed everything.
 */

import type { EmbeddingPort } from "@comis/core";
import type Database from "better-sqlite3";
import { isVecAvailable } from "./schema.js";

export interface BatchIndexerOptions {
  /** Number of memories to embed per batch. Default: 100 */
  batchSize: number;
  /** Optional logger for per-item failure diagnostics */
  logger?: { warn: (obj: Record<string, unknown>, msg: string) => void };
}

export interface BatchIndexerResult {
  indexed: number;
  failed: number;
  /** Last batch-level error message (if any batch failed entirely). */
  lastError?: string;
}

export interface BatchIndexer {
  /** Embed all memories with has_embedding = 0. */
  indexUnembedded(): Promise<BatchIndexerResult>;

  /** Clear all embeddings and re-embed everything. */
  reindexAll(): Promise<BatchIndexerResult>;

  /** Count of memories with has_embedding = 0. */
  unembeddedCount(): number;
}

/**
 * Truncate text to a safe character limit for embedding context windows.
 * Uses a conservative chars-to-tokens ratio (~4 chars/token for English).
 * Default maxTokens=1536 leaves ~25% headroom below 2048 context.
 */
export function truncateForEmbedding(text: string, maxTokens = 1536): string {
  const maxChars = maxTokens * 4; // Conservative: ~4 chars per token
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars);
}

/**
 * Create a BatchIndexer that processes unembedded memories using the
 * given EmbeddingPort.
 *
 * @param db - An open better-sqlite3 Database with initialized schema
 * @param embeddingPort - The embedding provider to generate vectors
 * @param options - Optional batch configuration
 * @returns A BatchIndexer instance
 */
export function createBatchIndexer(
  db: Database.Database,
  embeddingPort: EmbeddingPort,
  options?: Partial<BatchIndexerOptions>,
): BatchIndexer {
  const batchSize = options?.batchSize ?? 100;
  const logger = options?.logger;

  const indexer: BatchIndexer = {
    async indexUnembedded(): Promise<BatchIndexerResult> {
      let indexed = 0;
      let failed = 0;
      let lastBatchError: string | undefined;

      while (true) {
        const rows = db
          .prepare("SELECT id, content FROM memories WHERE has_embedding = 0 LIMIT ?")
          .all(batchSize) as { id: string; content: string }[];

        if (rows.length === 0) break;

        const texts = rows.map((r) => truncateForEmbedding(r.content));
        const result = await embeddingPort.embedBatch(texts);

        if (result.ok) {
          const insertVec = db.prepare(
            "INSERT OR REPLACE INTO vec_memories(memory_id, embedding) VALUES (?, ?)",
          );
          const updateFlag = db.prepare(
            "UPDATE memories SET has_embedding = 1 WHERE id = ?",
          );
          const markFailed = db.prepare(
            "UPDATE memories SET has_embedding = -1 WHERE id = ?",
          );

          const tx = db.transaction(() => {
            for (let i = 0; i < rows.length; i++) {
              const vec = result.value[i];
              if (vec == null) {
                // Per-item failure -- mark permanently failed, skip this row
                failed++;
                markFailed.run(rows[i].id);
                logger?.warn(
                  { memoryId: rows[i].id, contentLength: rows[i].content.length, errorKind: "dependency" },
                  "Embedding failed for individual memory, skipping",
                );
                continue;
              }
              if (isVecAvailable()) {
                insertVec.run(rows[i].id, new Float32Array(vec));
              }
              updateFlag.run(rows[i].id);
              indexed++;
            }
          });
          tx();
        } else {
          // Entire batch failed (provider down, etc.)
          lastBatchError = result.error.message;
          logger?.warn(
            {
              err: result.error.message,
              batchSize: rows.length,
              errorKind: "dependency",
              hint: "Check embedding provider connectivity and API key validity",
            },
            "Embedding batch failed entirely",
          );
          failed += rows.length;
          break;
        }
      }

      return { indexed, failed, lastError: lastBatchError };
    },

    async reindexAll(): Promise<BatchIndexerResult> {
      // Clear existing embeddings
      if (isVecAvailable()) {
        db.exec("DELETE FROM vec_memories");
      }
      db.exec("UPDATE memories SET has_embedding = 0");

      // Then index everything
      return indexer.indexUnembedded();
    },

    unembeddedCount(): number {
      const row = db
        .prepare("SELECT COUNT(*) as cnt FROM memories WHERE has_embedding = 0")
        .get() as { cnt: number };
      return row.cnt;
    },
  };

  return indexer;
}
