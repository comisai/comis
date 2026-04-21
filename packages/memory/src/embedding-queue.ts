// SPDX-License-Identifier: Apache-2.0
/**
 * Background embedding queue for asynchronous vector generation.
 *
 * New memory entries are enqueued for embedding without blocking the store
 * call. The queue processes entries FIFO with concurrency=1 to respect
 * API rate limits. If embedding generation fails, the entry remains in
 * the database without an embedding (FTS5 still works).
 *
 * Uses p-queue for concurrency control with pause/resume/clear lifecycle.
 */

import type { EmbeddingPort } from "@comis/core";
import type Database from "better-sqlite3";
import PQueue from "p-queue";
import { suppressError } from "@comis/shared";
import { isVecAvailable } from "./schema.js";
import { truncateForEmbedding } from "./embedding-batch-indexer.js";

/**
 * EmbeddingQueue provides fire-and-forget embedding generation.
 *
 * Callers enqueue entries and the queue processes them in the background.
 * All lifecycle methods (pause/resume/clear/onIdle) are exposed for
 * graceful shutdown and testing.
 */
export interface EmbeddingQueue {
  /** Add an entry to the embedding queue. Does NOT block -- fire-and-forget. */
  enqueue(entryId: string, content: string): void;

  /** Number of items waiting + in-progress. */
  pending(): number;

  /** Resolves when the queue is empty and all tasks have completed. */
  onIdle(): Promise<void>;

  /** Pause queue processing (in-progress task will finish). */
  pause(): void;

  /** Resume queue processing after a pause. */
  resume(): void;

  /** Clear pending items from the queue (does not cancel in-progress). */
  clear(): void;
}

/** Minimal pino-compatible warn logger for structured error reporting. */
interface EmbeddingQueueLogger {
  warn(obj: Record<string, unknown>, msg: string): void;
}

/**
 * Create a background embedding queue bound to the given database and
 * embedding provider.
 *
 * @param db - An open better-sqlite3 Database with initialized schema
 * @param embeddingPort - The embedding provider to generate vectors
 * @param logger - Optional structured logger (replaces console.warn)
 * @returns An EmbeddingQueue instance
 */
export function createEmbeddingQueue(
  db: Database.Database,
  embeddingPort: EmbeddingPort,
  logger?: EmbeddingQueueLogger,
): EmbeddingQueue {
  const queue = new PQueue({ concurrency: 1 });

  return {
    enqueue(entryId: string, content: string): void {
      // Fire-and-forget: intentionally not awaiting the .add() return
      suppressError(
        queue.add(async () => {
          const result = await embeddingPort.embed(truncateForEmbedding(content));

          if (result.ok) {
            const float32 = new Float32Array(result.value);

            if (isVecAvailable()) {
              db.prepare(
                "INSERT OR REPLACE INTO vec_memories(memory_id, embedding) VALUES (?, ?)",
              ).run(entryId, float32);
            }

            db.prepare("UPDATE memories SET has_embedding = 1 WHERE id = ?").run(entryId);
          } else {
            // Entry stays without embedding -- FTS5 still works
            logger?.warn(
              {
                entryId,
                err: String(result.error),
                hint: "Embedding generation failed; entry remains searchable via FTS5 only",
                errorKind: "dependency" as const,
              },
              "Embedding generation failed",
            );
          }
        }),
        "Embedding queue task error already handled internally",
      );
    },

    pending(): number {
      return queue.size + queue.pending;
    },

    onIdle(): Promise<void> {
      return queue.onIdle();
    },

    pause(): void {
      queue.pause();
    },

    resume(): void {
      queue.start();
    },

    clear(): void {
      queue.clear();
    },
  };
}
