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
  MemoryPinnedStore,
  MemorySearchOptions,
  MemorySearchResult,
  MemoryEntry,
  SessionKey,
  MemoryConfig,
  EmbeddingPort,
} from "@comis/core";
import { ok, err, fromPromise, type Result } from "@comis/shared";
import type Database from "better-sqlite3";
import { hybridSearch, searchByText, searchByVector } from "./hybrid-search.js";
import { initSchema } from "./schema.js";
import { rowToEntry, insertMemoryRow, storeEmbedding, parseTags, createRowMapper } from "./row-mapper.js";
import { MemoryRowSchema, IdProjectionRowSchema } from "./row-schemas.js";
import { truncateForEmbedding } from "./embedding-batch-indexer.js";
import { openSqliteDatabase } from "./sqlite-adapter-base.js";
import { systemNowMs } from "@comis/core";

// Row mappers
const memoryRowMapper = createRowMapper(MemoryRowSchema);
// DIST-05 (WR-02) id-projection mapper — the sanctioned typed-read path for the
// session-scoped id capture (no `as Foo[]` cast — untyped-sqlite gate).
const idProjectionRowMapper = createRowMapper(IdProjectionRowSchema);

/** Minimal pino-compatible logger interface for memory subsystem logging. */
interface MemoryLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  debug(obj: Record<string, unknown>, msg: string): void;
}

// ── SqliteMemoryAdapter ──────────────────────────────────────────────

export class SqliteMemoryAdapter implements MemoryPort, MemoryPinnedStore {
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
      // memoryType is a first-class optional MemoryEntry field. The
      // `?? "semantic"` fallback is belt-and-braces: an omitting write still satisfies
      // the column's NOT NULL DEFAULT 'semantic' CHECK.
      const memoryType = entry.memoryType ?? "semantic";

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
        // Forward the NL temporal range into the post-fusion WHERE
        // (occurred_at BETWEEN ? AND ?, ANDed onto the scope — never widens).
        ...(options?.occurredAtRange ? { occurredAtRange: options.occurredAtRange } : {}),
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

  // ── searchLanes (the un-fused FTS/vector split) ──────────

  /**
   * Resolve the query embedding exactly as {@link search} does for a string
   * query: embed via the injected port, then collapse a zero-length vector to
   * `undefined` (the documented short/emoji → FTS-only fallback). Returns
   * `undefined` when there is no embedding port. Shared by `searchLanes`.
   */
  private async resolveQueryEmbedding(query: string, queryLen: number): Promise<number[] | undefined> {
    if (!this.embeddingPort) return undefined;
    const embedResult = await this.embeddingPort.embed(truncateForEmbedding(query));
    if (!embedResult.ok) {
      this.logger?.warn(
        {
          err: embedResult.error,
          hint: "Continuing search with FTS5-only; vector search unavailable",
          errorKind: "dependency" as const,
          queryLen,
        },
        "Memory embedding failed",
      );
      return undefined;
    }
    // Zero-length embedding (short/emoji input) -> FTS-only fallback.
    if (embedResult.value.length === 0) {
      this.logger?.debug({ queryLen, op: "search-lanes" }, "Zero-length embedding vector, falling back to FTS-only");
      return undefined;
    }
    return embedResult.value;
  }

  /**
   * Hydrate an id list (in rank order) into MemorySearchResult[], scoped to the
   * tenant, skipping missing/expired rows and applying the agent/trust filters
   * (mirrors the {@link search} hydrate loop). NO minScore — the lanes are
   * pre-filter candidate pools (the minScore re-application moves to the recall
   * layer, applied after fusion). Each surviving row keeps a rank-preserving
   * intra-lane score (1, 1-ε, …) — fuse() rebases multi-lane onto rank anyway,
   * so order is what matters; the single-lane (FTS-only) path then preserves a
   * monotone-decreasing score.
   */
  private hydrateLane(
    ids: string[],
    tenantId: string,
    now: number,
    options?: MemorySearchOptions,
  ): MemorySearchResult[] {
    const out: MemorySearchResult[] = [];
    let rank = 0;
    for (const id of ids) {
      const parsed = memoryRowMapper.parseOptionalRow(
        this.db.prepare("SELECT * FROM memories WHERE id = ? AND tenant_id = ?").get(id, tenantId),
      );
      const row = parsed.ok ? parsed.value : undefined;
      if (!row) continue;
      if (row.expires_at !== null && row.expires_at <= now) continue;
      if (options?.agentId && row.agent_id !== options.agentId) continue;
      if (options?.trustLevel && row.trust_level !== options.trustLevel) continue;
      // The NL temporal range ANDs onto the ALREADY-(tenant, agent)-scoped
      // per-id read above — it can only NARROW (never widens scope). A NULL
      // occurred_at (no event time) fails the range and drops out, matching the
      // `occurred_at BETWEEN ? AND ?` semantics on the fused search() path. (The
      // searchLanes path resolves ids via searchByText/searchByVector, NOT
      // hybridSearch, so the filter is applied here at hydration, not in SQL.)
      if (options?.occurredAtRange) {
        const { start, end } = options.occurredAtRange;
        if (row.occurred_at === null || row.occurred_at < start || row.occurred_at > end) continue;
      }
      rank += 1;
      // Rank-preserving intra-lane score in (0,1], strictly decreasing with rank.
      out.push({ entry: rowToEntry(row), score: 1 / rank });
    }
    return out;
  }

  async searchLanes(
    sessionKey: SessionKey,
    query: string | number[],
    options?: MemorySearchOptions,
  ): Promise<Result<{ fts: MemorySearchResult[]; vector: MemorySearchResult[] }, Error>> {
    const startMs = systemNowMs();
    const queryLen = typeof query === "string" ? query.length : 0;
    try {
      const limit = options?.limit ?? 10;
      // Match hybridSearch's per-lane over-fetch (hybrid-search.ts:284) so the
      // candidate pools entering fuse() are byte-identical to today's fused pools.
      const overfetchLimit = limit * 2;
      const tenantId = sessionKey.tenantId;
      const now = systemNowMs();

      // Resolve the FTS query text + the vector embedding. A vector (number[])
      // query has no FTS text; a string query resolves an embedding exactly as
      // search() does (incl. the zero-length → FTS-only fallback).
      let ftsIds: Array<{ id: string }> = [];
      let queryEmbedding: number[] | undefined;
      if (typeof query === "string") {
        ftsIds = searchByText(this.db, query, overfetchLimit);
        queryEmbedding = await this.resolveQueryEmbedding(query, queryLen);
      } else {
        // Vector-only query: no FTS lane; the array IS the embedding.
        queryEmbedding = query;
      }

      // Vector lane: only when vec is available AND we have a non-empty embedding.
      let vecIds: Array<{ id: string }> = [];
      if (this.vecAvailable && queryEmbedding !== undefined && queryEmbedding.length > 0) {
        vecIds = searchByVector(this.db, queryEmbedding, overfetchLimit);
      }

      // Hydrate each lane independently (rank order preserved). NO RRF fusion,
      // NO minScore — fusion + minScore move to the agent's recall layer.
      const fts = this.hydrateLane(ftsIds.map((r) => r.id), tenantId, now, options);
      const vector = this.hydrateLane(vecIds.map((r) => r.id), tenantId, now, options);

      const durationMs = systemNowMs() - startMs;
      this.logger?.debug(
        {
          step: "search-lanes",
          durationMs,
          op: "search-lanes",
          ftsCandidates: fts.length,
          vectorCandidates: vector.length,
          queryLen,
          searchMode: queryEmbedding && queryEmbedding.length > 0 ? "hybrid" : "fts-only",
        },
        "Memory searchLanes complete",
      );
      return ok({ fts, vector });
    } catch (e: unknown) {
      const durationMs = systemNowMs() - startMs;
      this.logger?.warn(
        {
          err: e instanceof Error ? e : new Error(String(e)),
          op: "search-lanes",
          durationMs,
          queryLen,
          hint: "Memory searchLanes query failed; check database integrity",
          errorKind: "internal" as const,
        },
        "Memory searchLanes failed",
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

  // ── listMemoryIdsBySessionKey (DIST-05, WR-02) ─────────────────────

  /**
   * Phase 172 (DIST-05, WR-02): Read the memory ids for a (sessionKey, tenant,
   * agent) scope WITHOUT deleting. Used by the session-reset handler to capture
   * THIS session's ids BEFORE `deleteBySessionKey`, so `--purge-derived` can be
   * session-scoped (source_ids ∩ thisSessionIds) instead of the coarse
   * "any dangling source id" sweep.
   *
   * R4 isolation: filters on `source_session_key` AND `tenant_id` AND `agent_id`
   * — the SAME scope as `deleteBySessionKey`. Typed read via the row mapper (no
   * `as Foo[]` cast — untyped-sqlite gate). Returns the ids (possibly empty).
   */
  async listMemoryIdsBySessionKey(
    sessionKey: string,
    scope: { tenantId: string; agentId: string },
  ): Promise<Result<string[], Error>> {
    try {
      const parsed = idProjectionRowMapper.parseRows(
        this.db
          .prepare(
            "SELECT id FROM memories WHERE source_session_key = ? AND tenant_id = ? AND agent_id = ?",
          )
          .all(sessionKey, scope.tenantId, scope.agentId),
      );
      if (!parsed.ok) return err(new Error(parsed.error.message));
      return ok(parsed.value.map((r) => r.id));
    } catch (e: unknown) {
      return err(e instanceof Error ? e : new Error(String(e)));
    }
  }

  // ── deleteBySessionKey (DIST-05) ───────────────────────────────────

  /**
   * Phase 172 (DIST-05): Delete ALL memory rows for a (sessionKey, tenant, agent)
   * scope. ONE query covers BOTH paired-conversation memories AND lcd-distilled
   * episodic memories — both store `source_session_key` on the `memories` row.
   *
   * R4 isolation: the WHERE filters on `source_session_key` AND `tenant_id` AND
   * `agent_id`, so a cross-tenant or cross-agent row is never deleted (the same
   * fail-closed scoping the consolidation paths use). The `ON DELETE CASCADE` on
   * `lcd_memory_provenance.memory_id` drops the provenance rows automatically;
   * the `memories_ad AFTER DELETE` FTS trigger cleans `memory_fts`. We delete the
   * matching `vec_memories` rows first (the vec0 virtual table has no FK cascade —
   * per-id delete, same as `delete`).
   *
   * Returns the count of `memories` rows deleted (0 when none match), or an error.
   */
  async deleteBySessionKey(
    sessionKey: string,
    scope: { tenantId: string; agentId: string },
  ): Promise<Result<number, Error>> {
    const startMs = systemNowMs();
    try {
      const tx = this.db.transaction(() => {
        // vec_memories has no cascade — delete the matching vec rows by id first.
        // Subquery is fully tenant+agent+session scoped (R4) so it can only ever
        // reference this scope's memory ids.
        if (this.vecAvailable) {
          this.db
            .prepare(
              "DELETE FROM vec_memories WHERE memory_id IN " +
                "(SELECT id FROM memories WHERE source_session_key = ? AND tenant_id = ? AND agent_id = ?)",
            )
            .run(sessionKey, scope.tenantId, scope.agentId);
        }
        // Delete the memory rows (FTS trigger + provenance CASCADE handle the rest).
        const info = this.db
          .prepare(
            "DELETE FROM memories WHERE source_session_key = ? AND tenant_id = ? AND agent_id = ?",
          )
          .run(sessionKey, scope.tenantId, scope.agentId);
        return info.changes;
      });
      const changes = tx();

      const durationMs = systemNowMs() - startMs;
      this.logger?.debug(
        { durationMs, op: "deleteBySessionKey", deleted: changes },
        "Memory delete-by-session-key complete",
      );
      return ok(changes);
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

  // ── pin ──────────────────────────────────────────────────────────

  async pin(id: string, tenantId?: string, agentId?: string): Promise<Result<boolean, Error>> {
    return fromPromise((async () => {
      const sql =
        tenantId !== undefined && agentId !== undefined
          ? "UPDATE memories SET pinned = 1 WHERE id = ? AND tenant_id = ? AND agent_id = ?"
          : tenantId !== undefined
          ? "UPDATE memories SET pinned = 1 WHERE id = ? AND tenant_id = ?"
          : "UPDATE memories SET pinned = 1 WHERE id = ?";
      const info =
        tenantId !== undefined && agentId !== undefined
          ? this.db.prepare(sql).run(id, tenantId, agentId)
          : tenantId !== undefined
          ? this.db.prepare(sql).run(id, tenantId)
          : this.db.prepare(sql).run(id);
      return info.changes > 0;
    })());
  }

  // ── unpin ────────────────────────────────────────────────────────

  async unpin(id: string, tenantId?: string, agentId?: string): Promise<Result<boolean, Error>> {
    return fromPromise((async () => {
      const sql =
        tenantId !== undefined && agentId !== undefined
          ? "UPDATE memories SET pinned = 0 WHERE id = ? AND tenant_id = ? AND agent_id = ?"
          : tenantId !== undefined
          ? "UPDATE memories SET pinned = 0 WHERE id = ? AND tenant_id = ?"
          : "UPDATE memories SET pinned = 0 WHERE id = ?";
      const info =
        tenantId !== undefined && agentId !== undefined
          ? this.db.prepare(sql).run(id, tenantId, agentId)
          : tenantId !== undefined
          ? this.db.prepare(sql).run(id, tenantId)
          : this.db.prepare(sql).run(id);
      return info.changes > 0;
    })());
  }

  // ── listPinned ───────────────────────────────────────────────────

  async listPinned(
    scope: { tenantId: string; agentId: string },
    limit: number,
  ): Promise<Result<MemorySearchResult[], Error>> {
    return fromPromise((async () => {
      // CR-02 fix: exclude expired entries (mirrors the other read paths in
      // hydrateLane and search — `expires_at IS NULL OR expires_at > nowMs`).
      const nowMs = systemNowMs();
      const parsed = memoryRowMapper.parseRows(
        this.db
          .prepare(
            "SELECT * FROM memories " +
              "WHERE tenant_id = ? AND agent_id = ? AND pinned = 1 " +
              "AND (expires_at IS NULL OR expires_at > ?) " +
              "ORDER BY created_at DESC LIMIT ?",
          )
          .all(scope.tenantId, scope.agentId, nowMs, limit),
      );
      if (!parsed.ok) return [];
      return parsed.value.map((row) => ({
        entry: rowToEntry(row),
        score: 1.0,
      }));
    })());
  }

  // ── close ────────────────────────────────────────────────────────

  /** Close the database connection. */
  close(): void {
    this.db.close();
  }
}
