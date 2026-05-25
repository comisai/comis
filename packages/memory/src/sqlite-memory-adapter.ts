// SPDX-License-Identifier: Apache-2.0
/**
 * SqliteMemoryAdapter: MemoryPort implementation backed by SQLite.
 *
 * Implements the 3 MemoryPort methods (store/search/delete) with provenance
 * tracking, trust-level partitioning, and hybrid search.
 *
 * Implements multi-tier memory (memoryType), provenance tracking, trust-level
 * partitioning, hybrid search, and WAL mode for concurrent access.
 */

import type {
  MemoryPort,
  MemorySearchOptions,
  MemorySearchResult,
  MemoryEntry,
  SessionKey,
  MemoryConfig,
  EmbeddingPort,
} from "@comis/core";
import { ok, err, type Result } from "@comis/shared";
import type Database from "better-sqlite3";
import { hybridSearch, searchByVector } from "./hybrid-search.js";
import { initSchema } from "./schema.js";
import { rowToEntry, insertMemoryRow, storeEmbedding, parseTags, createRowMapper } from "./row-mapper.js";
import { MemoryRowSchema } from "./row-schemas.js";
import { truncateForEmbedding } from "./embedding-batch-indexer.js";
import { openSqliteDatabase } from "./sqlite-adapter-base.js";
import { systemNowMs } from "@comis/core";

// Row mappers
const memoryRowMapper = createRowMapper(MemoryRowSchema);

/** Minimal pino-compatible logger interface for memory subsystem logging. */
interface MemoryLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  debug(obj: Record<string, unknown>, msg: string): void;
}

// ── SqliteMemoryAdapter ──────────────────────────────────────────────

export class SqliteMemoryAdapter implements MemoryPort {
  private readonly db: Database.Database;
  private readonly config: MemoryConfig;
  private readonly embeddingPort?: EmbeddingPort;
  private readonly logger?: MemoryLogger;
  /** Per-instance sqlite-vec availability flag. */
  private readonly vecAvailable: boolean;

  constructor(config: MemoryConfig, embeddingPort?: EmbeddingPort, logger?: MemoryLogger) {
    this.config = config;
    this.embeddingPort = embeddingPort;
    this.logger = logger;

    // Open database with standardized lifecycle (WAL mode, chmod)
    let vecAvailable = false;
    this.db = openSqliteDatabase({
      dbPath: config.dbPath,
      walMode: config.walMode,
      initSchema: (db) => {
        // Initialize schema and capture per-instance vec state
        const schemaResult = initSchema(db, config.embeddingDimensions);
        vecAvailable = schemaResult.vecAvailable;
      },
    });
    this.vecAvailable = vecAvailable;

    this.logger?.debug({ dbPath: config.dbPath }, "Memory database opened");
  }

  /** Get the underlying database (for testing/advanced use). */
  getDb(): Database.Database {
    return this.db;
  }

  // ── store ────────────────────────────────────────────────────────

  async store(entry: MemoryEntry): Promise<Result<MemoryEntry, Error>> {
    const startMs = systemNowMs();
    try {
      const memoryType = (entry as MemoryEntry & { memoryType?: string }).memoryType ?? "semantic";

      const vecAvailable = this.vecAvailable;
      const tx = this.db.transaction(() => {
        insertMemoryRow(this.db, entry, memoryType);
        if (entry.embedding) {
          storeEmbedding(this.db, entry.id, entry.embedding, vecAvailable);
        }
      });
      tx();

      const durationMs = systemNowMs() - startMs;
      // hasEmbedding=false implies embedding will be queued for background generation
      this.logger?.info({ step: "memory-store", durationMs, op: "store", hasEmbedding: !!entry.embedding, embeddingQueued: !entry.embedding, memoryType }, "Memory store complete");
      return ok(entry);
    } catch (e: unknown) {
      return err(e instanceof Error ? e : new Error(String(e)));
    }
  }

  // ── search ───────────────────────────────────────────────────────

  async search(
    sessionKey: SessionKey,
    query: string | number[],
    options?: MemorySearchOptions,
  ): Promise<Result<MemorySearchResult[], Error>> {
    const startMs = systemNowMs();
    const queryLen = typeof query === "string" ? query.length : 0;
    try {
      const limit = options?.limit ?? 10;
      const tenantId = sessionKey.tenantId;

      if (Array.isArray(query)) {
        // Vector-only search (per-instance vec state)
        if (!this.vecAvailable) {
          const durationMs = systemNowMs() - startMs;
          this.logger?.debug({ durationMs, op: "search", resultCount: 0, queryLen, searchMode: "vector-only" }, "Memory search complete");
          return ok([]);
        }

        const vecResults = searchByVector(this.db, query, limit);

        const now = systemNowMs();
        const results: MemorySearchResult[] = [];
        for (const vr of vecResults) {
          const parsed = memoryRowMapper.parseOptionalRow(
            this.db
              .prepare("SELECT * FROM memories WHERE id = ? AND tenant_id = ?")
              .get(vr.id, tenantId),
          );
          const row = parsed.ok ? parsed.value : undefined;

          if (!row) continue;

          // Filter expired entries at query time
          if (row.expires_at !== null && row.expires_at <= now) continue;

          // Apply filters
          if (options?.agentId && row.agent_id !== options.agentId) continue;
          if (options?.trustLevel && row.trust_level !== options.trustLevel) continue;

          // Convert cosine distance to similarity score (0-1)
          const score = 1 - vr.distance;
          if (options?.minScore !== undefined && score < options.minScore) continue;

          results.push({
            entry: rowToEntry(row),
            score,
          });
        }

        const sliced = results.slice(0, limit);
        const durationMs = systemNowMs() - startMs;
        this.logger?.debug({ durationMs, op: "search", resultCount: sliced.length, queryLen, searchMode: "vector-only" }, "Memory search complete");
        return ok(sliced);
      }

      // String query: hybrid search
      let queryEmbedding: number[] | undefined;
      let embedDurationMs: number | undefined;

      if (this.embeddingPort) {
        const embedStartMs = systemNowMs();
        const embedResult = await this.embeddingPort.embed(truncateForEmbedding(query));
        embedDurationMs = systemNowMs() - embedStartMs;
        if (embedResult.ok) {
          queryEmbedding = embedResult.value;
          // Zero-length embedding (short/emoji input) -> FTS-only fallback
          if (queryEmbedding.length === 0) {
            this.logger?.debug(
              { queryLen, op: "search" },
              "Zero-length embedding vector, falling back to FTS-only",
            );
            queryEmbedding = undefined;
          }
        } else {
          this.logger?.warn(
            {
              err: embedResult.error,
              hint: "Continuing search with FTS5-only; vector search unavailable",
              errorKind: "dependency" as const,
              queryLen,
            },
            "Memory embedding failed",
          );
        }
      }

      const hybridResults = hybridSearch(this.db, query, queryEmbedding, {
        limit,
        trustLevel: options?.trustLevel,
        tenantId,
        agentId: options?.agentId,
      }, this.vecAvailable);

      // Build full MemorySearchResult with entries
      const now = systemNowMs();
      const results: MemorySearchResult[] = [];
      for (const hr of hybridResults) {
        const parsed = memoryRowMapper.parseOptionalRow(
          this.db
            .prepare("SELECT * FROM memories WHERE id = ? AND tenant_id = ?")
            .get(hr.id, tenantId),
        );
        const row = parsed.ok ? parsed.value : undefined;

        if (!row) continue;

        // Filter expired entries at query time
        if (row.expires_at !== null && row.expires_at <= now) continue;

        // Apply minScore filter
        if (options?.minScore !== undefined && hr.score < options.minScore) continue;

        // Apply tag filter
        if (options?.tags && options.tags.length > 0) {
          const entryTags = parseTags(row.tags);
          const hasAllTags = options.tags.every((t) => entryTags.includes(t));
          if (!hasAllTags) continue;
        }

        results.push({
          entry: rowToEntry(row),
          score: hr.score,
        });
      }

      const durationMs = systemNowMs() - startMs;
      this.logger?.debug(
        {
          durationMs,
          op: "search",
          resultCount: results.length,
          queryLen,
          searchMode: queryEmbedding ? "hybrid" : "fts-only",
          embeddingDurationMs: embedDurationMs ?? 0,
        },
        "Memory search complete",
      );
      return ok(results);
    } catch (e: unknown) {
      const durationMs = systemNowMs() - startMs;
      this.logger?.warn(
        {
          err: e instanceof Error ? e : new Error(String(e)),
          op: "search",
          durationMs,
          queryLen,
          hint: "Memory search query failed; check database integrity",
          errorKind: "internal" as const,
        },
        "Memory search failed",
      );
      return err(e instanceof Error ? e : new Error(String(e)));
    }
  }

  // ── delete ───────────────────────────────────────────────────────

  async delete(id: string, tenantId?: string): Promise<Result<boolean, Error>> {
    const startMs = systemNowMs();
    try {
      const tid = tenantId ?? "default";

      // Delete from vec_memories first (no cascade on virtual tables, per-instance)
      if (this.vecAvailable) {
        this.db.prepare("DELETE FROM vec_memories WHERE memory_id = ?").run(id);
      }

      // Delete from memories (FTS5 trigger handles memory_fts cleanup)
      const result = this.db
        .prepare("DELETE FROM memories WHERE id = ? AND tenant_id = ?")
        .run(id, tid);

      const durationMs = systemNowMs() - startMs;
      this.logger?.debug({ durationMs, op: "delete" }, "Memory delete complete");
      return ok(result.changes > 0);
    } catch (e: unknown) {
      return err(e instanceof Error ? e : new Error(String(e)));
    }
  }

  // ── WAL checkpoint ─────────────────────────────────────────────────

  /**
   * Run a passive WAL checkpoint. Does not block readers or writers.
   * Returns the number of WAL pages moved to the database.
   *
   * Call periodically (e.g., every 5 minutes via daemon health loop)
   * to prevent WAL bloat when long-running readers block auto-checkpoint.
   */
  checkpoint(): number {
    const result = this.db.pragma("wal_checkpoint(PASSIVE)") as Array<{
      busy: number;
      log: number;
      checkpointed: number;
    }>;
    return result[0]?.checkpointed ?? 0;
  }

  // ── close ────────────────────────────────────────────────────────

  /** Close the database connection. */
  close(): void {
    this.db.close();
  }
}
