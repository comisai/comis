/**
 * SqliteMemoryAdapter: Full MemoryPort implementation backed by SQLite.
 *
 * Implements all 6 MemoryPort methods (store/retrieve/search/update/delete/clear)
 * with provenance tracking, trust-level partitioning, and hybrid search.
 *
 * Implements multi-tier memory (memoryType), provenance tracking, trust-level
 * partitioning, hybrid search, and WAL mode for concurrent access.
 */

import type {
  MemoryPort,
  MemorySearchOptions,
  MemorySearchResult,
  MemoryUpdateFields,
  MemoryEntry,
  SessionKey,
  MemoryConfig,
  EmbeddingPort,
} from "@comis/core";
import { ok, err, type Result } from "@comis/shared";
import type Database from "better-sqlite3";
import type { MemoryRow } from "./types.js";
import { hybridSearch, searchByVector } from "./hybrid-search.js";
import { initSchema } from "./schema.js";
import { rowToEntry, insertMemoryRow, storeEmbedding, parseTags } from "./row-mapper.js";
import { truncateForEmbedding } from "./embedding-batch-indexer.js";
import { openSqliteDatabase } from "./sqlite-adapter-base.js";

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
    const startMs = Date.now();
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

      const durationMs = Date.now() - startMs;
      // Finding 14: hasEmbedding=false implies embedding will be queued for background generation
      this.logger?.debug({ durationMs, op: "store", hasEmbedding: !!entry.embedding, embeddingQueued: !entry.embedding, memoryType }, "Memory store complete");
      return ok(entry);
    } catch (e: unknown) {
      return err(e instanceof Error ? e : new Error(String(e)));
    }
  }

  // ── storeWithType (for compaction service) ───────────────────────

  /**
   * Store a memory entry with an explicit memoryType.
   * Used by the compaction service to store summarized entries
   * as 'semantic' and working memories.
   */
  async storeWithType(
    entry: MemoryEntry,
    memoryType: "working" | "episodic" | "semantic" | "procedural",
  ): Promise<Result<MemoryEntry, Error>> {
    try {
      const vecAvailable = this.vecAvailable;
      const tx = this.db.transaction(() => {
        insertMemoryRow(this.db, entry, memoryType);
        if (entry.embedding) {
          storeEmbedding(this.db, entry.id, entry.embedding, vecAvailable);
        }
      });
      tx();

      return ok(entry);
    } catch (e: unknown) {
      return err(e instanceof Error ? e : new Error(String(e)));
    }
  }

  // ── retrieve ─────────────────────────────────────────────────────

  async retrieve(id: string, tenantId?: string): Promise<Result<MemoryEntry | undefined, Error>> {
    const startMs = Date.now();
    try {
      const tid = tenantId ?? "default";
      // Filter expired entries at query time
      const row = this.db
        .prepare("SELECT * FROM memories WHERE id = ? AND tenant_id = ? AND (expires_at IS NULL OR expires_at > ?)")
        .get(id, tid, Date.now()) as MemoryRow | undefined;

      if (!row) {
        const durationMs = Date.now() - startMs;
        this.logger?.debug({ durationMs, op: "retrieve", resultCount: 0 }, "Memory retrieve complete");
        return ok(undefined);
      }

      // Load embedding if available (per-instance vec state)
      let embedding: number[] | undefined;
      if (row.has_embedding && this.vecAvailable) {
        const vecRow = this.db
          .prepare("SELECT embedding FROM vec_memories WHERE memory_id = ?")
          .get(id) as { embedding: Buffer } | undefined;

        if (vecRow) {
          const float32 = new Float32Array(
            vecRow.embedding.buffer,
            vecRow.embedding.byteOffset,
            vecRow.embedding.byteLength / Float32Array.BYTES_PER_ELEMENT,
          );
          embedding = Array.from(float32);
        }
      }

      const durationMs = Date.now() - startMs;
      this.logger?.debug({ durationMs, op: "retrieve", resultCount: 1 }, "Memory retrieve complete");
      return ok(rowToEntry(row, embedding));
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
    const startMs = Date.now();
    const queryLen = typeof query === "string" ? query.length : 0;
    try {
      const limit = options?.limit ?? 10;
      const tenantId = sessionKey.tenantId;

      if (Array.isArray(query)) {
        // Vector-only search (per-instance vec state)
        if (!this.vecAvailable) {
          const durationMs = Date.now() - startMs;
          this.logger?.debug({ durationMs, op: "search", resultCount: 0, queryLen, searchMode: "vector-only" }, "Memory search complete");
          return ok([]);
        }

        const vecResults = searchByVector(this.db, query, limit);

        const now = Date.now();
        const results: MemorySearchResult[] = [];
        for (const vr of vecResults) {
          const row = this.db
            .prepare("SELECT * FROM memories WHERE id = ? AND tenant_id = ?")
            .get(vr.id, tenantId) as MemoryRow | undefined;

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
        const durationMs = Date.now() - startMs;
        this.logger?.debug({ durationMs, op: "search", resultCount: sliced.length, queryLen, searchMode: "vector-only" }, "Memory search complete");
        return ok(sliced);
      }

      // String query: hybrid search
      let queryEmbedding: number[] | undefined;
      let embedDurationMs: number | undefined;

      if (this.embeddingPort) {
        const embedStartMs = Date.now();
        const embedResult = await this.embeddingPort.embed(truncateForEmbedding(query));
        embedDurationMs = Date.now() - embedStartMs;
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
      const now = Date.now();
      const results: MemorySearchResult[] = [];
      for (const hr of hybridResults) {
        const row = this.db
          .prepare("SELECT * FROM memories WHERE id = ? AND tenant_id = ?")
          .get(hr.id, tenantId) as MemoryRow | undefined;

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

      const durationMs = Date.now() - startMs;
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
      const durationMs = Date.now() - startMs;
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

  // ── update ───────────────────────────────────────────────────────

  async update(
    id: string,
    fields: MemoryUpdateFields,
    tenantId?: string,
  ): Promise<Result<MemoryEntry, Error>> {
    const startMs = Date.now();
    try {
      const tid = tenantId ?? "default";

      // Verify entry exists
      const existing = this.db
        .prepare("SELECT * FROM memories WHERE id = ? AND tenant_id = ?")
        .get(id, tid) as MemoryRow | undefined;

      if (!existing) {
        return err(new Error(`Memory entry not found: ${id}`));
      }

      // Build dynamic SET clause
      const setClauses: string[] = [];
      const setParams: unknown[] = [];

      if (fields.content !== undefined) {
        setClauses.push("content = ?");
        setParams.push(fields.content);
      }
      if (fields.tags !== undefined) {
        setClauses.push("tags = ?");
        setParams.push(JSON.stringify(fields.tags));
      }
      if (fields.trustLevel !== undefined) {
        setClauses.push("trust_level = ?");
        setParams.push(fields.trustLevel);
      }
      if (fields.expiresAt !== undefined) {
        setClauses.push("expires_at = ?");
        setParams.push(fields.expiresAt);
      }

      // Always update updated_at
      setClauses.push("updated_at = ?");
      setParams.push(Date.now());

      const tx = this.db.transaction(() => {
        if (setClauses.length > 0) {
          const sql = `UPDATE memories SET ${setClauses.join(", ")} WHERE id = ? AND tenant_id = ?`;
          setParams.push(id, tid);
          this.db.prepare(sql).run(...setParams);
        }

        // Handle embedding update (per-instance vec state)
        if (fields.embedding !== undefined && this.vecAvailable) {
          const float32 = new Float32Array(fields.embedding);

          if (existing.has_embedding) {
            // Delete old embedding and insert new
            this.db.prepare("DELETE FROM vec_memories WHERE memory_id = ?").run(id);
          }

          this.db
            .prepare("INSERT INTO vec_memories(memory_id, embedding) VALUES (?, ?)")
            .run(id, float32);
          this.db.prepare("UPDATE memories SET has_embedding = 1 WHERE id = ?").run(id);
        }
      });
      tx();

      // Return updated entry
      const updated = this.db
        .prepare("SELECT * FROM memories WHERE id = ? AND tenant_id = ?")
        .get(id, tid) as MemoryRow;

      const durationMs = Date.now() - startMs;
      this.logger?.debug({ durationMs, op: "update" }, "Memory update complete");
      return ok(rowToEntry(updated));
    } catch (e: unknown) {
      return err(e instanceof Error ? e : new Error(String(e)));
    }
  }

  // ── delete ───────────────────────────────────────────────────────

  async delete(id: string, tenantId?: string): Promise<Result<boolean, Error>> {
    const startMs = Date.now();
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

      const durationMs = Date.now() - startMs;
      this.logger?.debug({ durationMs, op: "delete" }, "Memory delete complete");
      return ok(result.changes > 0);
    } catch (e: unknown) {
      return err(e instanceof Error ? e : new Error(String(e)));
    }
  }

  // ── clear ────────────────────────────────────────────────────────

  async clear(sessionKey: SessionKey): Promise<Result<number, Error>> {
    const startMs = Date.now();
    try {
      const tid = sessionKey.tenantId;

      // Get IDs to delete from vec_memories first (per-instance)
      if (this.vecAvailable) {
        const ids = this.db
          .prepare("SELECT id FROM memories WHERE tenant_id = ?")
          .all(tid) as Array<{ id: string }>;

        for (const { id } of ids) {
          this.db.prepare("DELETE FROM vec_memories WHERE memory_id = ?").run(id);
        }
      }

      // Delete all memories for tenant (FTS5 trigger handles cleanup)
      const result = this.db.prepare("DELETE FROM memories WHERE tenant_id = ?").run(tid);

      const durationMs = Date.now() - startMs;
      this.logger?.debug({ durationMs, op: "clear" }, "Memory clear complete");
      return ok(result.changes);
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
