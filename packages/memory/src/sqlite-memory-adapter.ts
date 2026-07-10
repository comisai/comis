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
import { z } from "zod";
import { hybridSearch, searchByText, searchByVector } from "./hybrid-search.js";
import { initSchema } from "./schema.js";
import { isVecDimensionMismatch, type VecTableRebuild } from "./vec-dimension.js";
import { rowToEntry, insertMemoryRow, storeEmbedding, parseTags, createRowMapper } from "./row-mapper.js";
import { MemoryRowSchema, IdProjectionRowSchema } from "./row-schemas.js";
import { truncateForEmbedding } from "./embedding-batch-indexer.js";
import { openSqliteDatabase } from "./sqlite-adapter-base.js";
import { systemNowMs, normalizeForSearch, validateMemoryWrite } from "@comis/core";

/**
 * The decided branch of a {@link SqliteMemoryAdapter.supersede} call,
 * returned to the caller and logged as metadata (never the content body). A closed
 * string-literal union (no `kind: string`): `"superseded"` = the incumbent's content
 * was updated to the new value and its prior state appended to `memories.history`;
 * `"not-found"` = no incumbent matched the scoped (id, tenant, agent[, user]) key, so
 * NO row was written (the no-op — e.g. a cross-scope correction the V4 WHERE rejects).
 */
export type MemorySupersedeOutcome = "superseded" | "not-found";

/**
 * The scope a {@link SqliteMemoryAdapter.supersede} runs under. `tenantId` +
 * `agentId` are the load-bearing 2-way isolation boundary (mirrors store/delete +
 * the user-rep `revise()` scope); `userId` narrows further when the caller knows it
 * (a correction targeting one user's fact must not touch another's same-content row).
 */
export interface MemorySupersedeScope {
  tenantId: string;
  agentId: string;
  /** Optional 3rd isolation axis; ANDed into every statement when present. */
  userId?: string;
}

// Row mappers
const memoryRowMapper = createRowMapper(MemoryRowSchema);
// Id-projection mapper — the sanctioned typed-read path for the
// session-scoped id capture (no `as Foo[]` cast — untyped-sqlite gate).
const idProjectionRowMapper = createRowMapper(IdProjectionRowSchema);

// The canonical `memories.history` JSON shape — an ordered array of
// prior contents (MemoryEntrySchema.history + the growObservation precedent). Built
// once at module scope; parses the nullable TEXT column on read-back inside
// supersede(). A strictObject mirrors the row-mapper's HistorySchema (the read path),
// so a malformed/legacy column degrades to "absent" (→ a fresh array) instead of
// throwing — never blocking a correction on a corrupt history payload.
const SupersedeHistorySchema = z.array(
  z.strictObject({ previousContent: z.string(), changedAt: z.number().int().positive() }),
);

/**
 * Parse the incumbent's `memories.history` column (JSON TEXT or NULL) into the
 * typed prior-state array, or `undefined` when the column is NULL / corrupt /
 * oversized (mirrors row-mapper.ts parseHistory — degrade to "field absent", never
 * throw). supersede() then starts a fresh array, so a damaged column self-heals on
 * the next correction rather than aborting it.
 */
function parseHistoryColumn(raw: string | null): MemoryEntry["history"] | undefined {
  if (raw === null) return undefined;
  try {
    const parsed = SupersedeHistorySchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

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
  /** The vec0 twins rebuilt at open because the embedder dimension changed. */
  private readonly vecRebuilt?: readonly VecTableRebuild[];

  constructor(config: MemoryConfig, embeddingPort?: EmbeddingPort, logger?: MemoryLogger) {
    this.config = config;
    this.embeddingPort = embeddingPort;
    this.logger = logger;

    // Open database with standardized lifecycle (WAL mode, chmod)
    let vecAvailable = false;
    let vecRebuilt: VecTableRebuild[] | undefined;
    this.db = openSqliteDatabase({
      dbPath: config.dbPath,
      walMode: config.walMode,
      initSchema: (db) => {
        // Initialize schema and capture per-instance vec state (recall keys nest under .recall)
        const schemaResult = initSchema(db, config.recall.embeddingDimensions);
        vecAvailable = schemaResult.vecAvailable;
        vecRebuilt = schemaResult.vecRebuilt;
      },
    });
    this.vecAvailable = vecAvailable;
    this.vecRebuilt = vecRebuilt;

    // INFO, not DEBUG: a dimension rebuild wipes every stored vector until the
    // reindex lands — an operator diagnosing empty recall must see it at the
    // default log level.
    for (const rebuild of vecRebuilt ?? []) {
      this.logger?.info(
        {
          step: "vec-dimension-rebuild",
          table: rebuild.table,
          fromDimensions: rebuild.fromDimensions,
          toDimensions: rebuild.toDimensions,
          hint: "embedding dimensions changed; stale vectors dropped and rows re-queued for embedding",
        },
        "Vector table rebuilt for new embedding dimension",
      );
    }

    this.logger?.debug({ dbPath: config.dbPath }, "Memory database opened");
  }

  /** Get the underlying database (for testing/advanced use). */
  getDb(): Database.Database {
    return this.db;
  }

  /** The vec0 twins rebuilt when this adapter opened (embedder dimension
   *  changed since the previous boot), for the boot model_health snapshot. */
  getVecRebuilt(): readonly VecTableRebuild[] | undefined {
    return this.vecRebuilt;
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
          // The ALWAYS-ON `evicted_at IS NULL` recall exclusion —
          // a soft-evicted row (evicted_at set by the lifecycle sweep) is omitted from
          // THIS live vector-only recall path too, not only hybridSearch. The
          // inspect/asOf raw reads stay UNFILTERED (eviction is soft + asOf-resolvable).
          const parsed = memoryRowMapper.parseOptionalRow(
            this.db
              .prepare("SELECT * FROM memories WHERE id = ? AND tenant_id = ? AND evicted_at IS NULL")
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
        // hybridSearch already applies `evicted_at IS NULL` in its
        // post-fusion WHERE, so an evicted id never reaches here — but the per-id hydrate
        // is itself a recall read, so it carries the same always-on exclusion explicitly
        // (defense in depth; the two halves of the soft-eviction guarantee stay coupled).
        const parsed = memoryRowMapper.parseOptionalRow(
          this.db
            .prepare("SELECT * FROM memories WHERE id = ? AND tenant_id = ? AND evicted_at IS NULL")
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
      // The ALWAYS-ON `evicted_at IS NULL` recall exclusion —
      // hydrateLane backs searchLanes, the PRIMARY live recall path (createMemoryRecall
      // prefers searchLanes, memory-recall.ts:183), so a soft-evicted row MUST be omitted
      // here exactly as hybridSearch's post-fusion WHERE does it (hybrid-search.ts:440).
      // The inspect/asOf raw reads stay UNFILTERED (eviction is soft + asOf-resolvable).
      const parsed = memoryRowMapper.parseOptionalRow(
        this.db
          .prepare("SELECT * FROM memories WHERE id = ? AND tenant_id = ? AND evicted_at IS NULL")
          .get(id, tenantId),
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
  ): Promise<
    Result<
      {
        fts: MemorySearchResult[];
        vector: MemorySearchResult[];
        vectorLaneDegraded?: { errorKind: string };
      },
      Error
    >
  > {
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

      // Vector lane: only when vec is available AND we have a non-empty
      // embedding. ISOLATED — a vector-lane failure degrades THAT lane to
      // empty instead of failing the whole call, so text recall survives a
      // broken vector backend (observed live: a vec dimension mismatch erred
      // every searchLanes call for hours while FTS was perfectly healthy).
      let vecIds: Array<{ id: string }> = [];
      let vectorLaneDegraded: { errorKind: string } | undefined;
      if (this.vecAvailable && queryEmbedding !== undefined && queryEmbedding.length > 0) {
        try {
          vecIds = searchByVector(this.db, queryEmbedding, overfetchLimit);
        } catch (e: unknown) {
          // Branch the hint by failure class: a vec dimension mismatch is an
          // embedder/table drift (config), not database corruption — the
          // generic check-database-integrity pointer sent a live investigation
          // the wrong way while recall was fully dead.
          const dimensionMismatch = isVecDimensionMismatch(e);
          const errorKind = dimensionMismatch ? ("config" as const) : ("internal" as const);
          vectorLaneDegraded = { errorKind };
          this.logger?.warn(
            {
              err: e instanceof Error ? e : new Error(String(e)),
              op: "search-lanes",
              durationMs: systemNowMs() - startMs,
              queryLen,
              hint: dimensionMismatch
                ? "query embedding dimensions do not match the vec_memories table — the embedder changed while the daemon was running; restart the daemon (the vec tables rebuild to the configured dimensions at boot); FTS recall still serves"
                : "vector lane query failed; FTS recall still serves — check database integrity",
              errorKind,
            },
            "Memory searchLanes vector lane degraded",
          );
        }
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
      return ok({
        fts,
        vector,
        ...(vectorLaneDegraded !== undefined ? { vectorLaneDegraded } : {}),
      });
    } catch (e: unknown) {
      const durationMs = systemNowMs() - startMs;
      // Both lanes are unusable (FTS query or hydration failed) — a genuine
      // whole-call failure. The caller emits memory:recall_degraded so the
      // failure is visible beyond this log line.
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

  // ── supersede (non-destructive contradiction → revise) ─

  /**
   * Resolve a user CORRECTION of an existing fact by
   * SUPERSESSION, NOT deletion. UPDATEs the scoped incumbent's `content` to
   * `newContent` and APPENDs the prior state (`{ previousContent, changedAt }`) to
   * the `memories.history` JSON array. The row is UPDATEd, never DELETEd — deletion
   * stays reserved for the corroborated-poison security path. The existing
   * row IS the latest, so recall (search/searchLanes) naturally returns the new
   * content; there is NO `mentioned_at` column and NO recall-side asOf filter (the
   * superseded content simply stops being the row's `content`, preserved in history).
   *
   * Mirrors the `sqlite-user-representation-store.ts` `revise()` discipline — the
   * SELECT-incumbent → history-append → UPDATE unit runs inside ONE
   * `db.transaction(() => {...})()`, so a parse fault (or any in-txn throw) atomic-
   * ROLLBACKs (the @allow-throw boundary; the outer try/catch converts it to `err`,
   * exactly like `revise()`). Every statement is scoped
   * `WHERE id = ? AND tenant_id = ? AND agent_id = ?` (+ `user_id` when supplied),
   * bound params only (V4 isolation). The incumbent is parsed via the row mapper (no
   * `as Row`). The NEW content passes the same `validateMemoryWrite` redaction
   * firewall a write goes through BEFORE the txn — a CRITICAL correction is
   * rejected, never persisted. The `memories_au AFTER UPDATE OF content` trigger
   * re-syncs `memory_fts`; the normalized `memory_fts_tri` trigram twin is
   * re-inserted on the content change (the `growObservation` precedent), and the
   * stale `vec_memories` embedding is invalidated (deleted + `has_embedding = 0`) so
   * the background indexer re-embeds C2 — never leaving a C1 vector pointing at the
   * row (mirrors store()'s no-precomputed-embedding path).
   *
   * @param id - The incumbent memory id to correct.
   * @param newContent - The corrected content (C2). Untrusted → redaction-scanned.
   * @param scope - The (tenant, agent[, user]) isolation scope.
   * @param now - The supersede clock (epoch ms; injected, never `Date.now()`).
   * @returns `"superseded"` on a successful revise, `"not-found"` when no scoped
   *          incumbent matched (no row written), or an `err` (firewall-rejected,
   *          parse fault, or DB error — the transaction rolled back).
   */
  async supersede(
    id: string,
    newContent: string,
    scope: MemorySupersedeScope,
    now: number,
  ): Promise<Result<MemorySupersedeOutcome, Error>> {
    const startMs = systemNowMs();
    const { tenantId, agentId, userId } = scope;

    // The redaction firewall on the untrusted correction, BEFORE the txn — a
    // CRITICAL classification (dangerous command / secret egress) is REJECTED and
    // never persisted (mirrors revise()'s rejectUnwritableEntry → err). A `warn`
    // is permitted (the existing trust_level on the row is unchanged — a correction
    // re-states the same user fact at the same trust tier; only `critical` blocks).
    const verdict = validateMemoryWrite(newContent);
    if (verdict.severity === "critical") {
      this.logger?.warn(
        {
          step: "memory-supersede",
          errorKind: "validation" as const,
          severity: verdict.severity,
          criticalPatterns: verdict.criticalPatterns,
          hint: "correction content failed validateMemoryWrite (redaction firewall) — supersession not applied",
          durationMs: systemNowMs() - startMs,
        },
        "Memory supersede rejected (redaction firewall)",
      );
      return err(new Error("memory supersede: content failed redaction validation"));
    }

    try {
      // Scoped statements — the (tenant, agent[, user]) filter is the V4 isolation
      // boundary; every value a bound `?` (NEVER concatenated). The 3-way userId
      // axis is ANDed only when the caller supplies it.
      const scopeSql = userId !== undefined
        ? "tenant_id = ? AND agent_id = ? AND user_id = ?"
        : "tenant_id = ? AND agent_id = ?";
      const scopeArgs: string[] = userId !== undefined ? [tenantId, agentId, userId] : [tenantId, agentId];

      const selectIncumbent = this.db.prepare(
        `SELECT * FROM memories WHERE id = ? AND ${scopeSql}`,
      );
      const updateContent = this.db.prepare(
        `UPDATE memories SET content = ?, history = ?, updated_at = ? WHERE id = ? AND ${scopeSql}`,
      );

      const vecAvailable = this.vecAvailable;

      // The revise unit — ONE synchronous transaction (mirror revise()/store()).
      // better-sqlite3 auto-ROLLBACKs on ANY throw, so SELECT-incumbent →
      // history-append → UPDATE is atomic; a parse fault THROWS → ROLLBACK (caught
      // below → err). The decided branch is returned for the metadata log.
      const tx = this.db.transaction((): MemorySupersedeOutcome => {
        // 1. SELECT the scoped incumbent; parse via the row mapper (no `as Row`).
        //    A parse fault THROWS to ROLLBACK.
        const parsed = memoryRowMapper.parseOptionalRow(selectIncumbent.get(id, ...scopeArgs));
        if (!parsed.ok) throw new Error(parsed.error.message);
        const incumbent = parsed.value;

        // 2. No incumbent under THIS scope → no-op (the cross-scope correction the
        //    V4 WHERE rejects, or an unknown id). NO row written.
        if (incumbent === undefined) return "not-found";

        // 2'. Did the correction actually rewrite content? A no-change correction
        //     (newContent === incumbent.content — e.g. a user "re-confirms" a fact)
        //     is still recorded in history below (the correction is the durable
        //     signal), but the re-index lanes MUST short-circuit on it: the
        //     memories_au / memories_tri_au triggers are themselves guarded
        //     `WHEN old.content IS NOT new.content` (schema-trigram.ts), so on a
        //     no-change UPDATE they do NOT fire — and the manual re-index work below
        //     would then either no-op-throw (the trigram INSERT collides on the
        //     existing twin's PK rowid → caught) or, worse, DESTRUCTIVELY drop the
        //     still-valid cached vec embedding and force a pointless re-embed. Mirror
        //     the consolidation-store precedent (sqlite-memory-consolidation-
        //     store.ts:428), which guards its identical twin re-insert on the same
        //     `contentChanged` flag.
        const contentChanged = newContent !== incumbent.content;

        // 3. Append the prior state to history (oldest-first), then update content.
        //    The shape { previousContent, changedAt } is the canonical history entry
        //    (MemoryEntrySchema.history + the growObservation precedent) — the row
        //    mapper's HistorySchema parses exactly this on read-back. History is
        //    appended REGARDLESS of contentChanged: a re-confirmation is a recorded
        //    correction even when the value is identical.
        const prior: MemoryEntry["history"] = [
          ...(parseHistoryColumn(incumbent.history) ?? []),
          { previousContent: incumbent.content, changedAt: now },
        ];
        // The memories_au AFTER UPDATE OF content trigger re-syncs memory_fts
        // automatically (delete old.content + insert new.content) — but ONLY when
        // its `WHEN old.content IS NOT new.content` guard holds, so a no-change
        // UPDATE here leaves memory_fts untouched (no churn).
        updateContent.run(newContent, JSON.stringify(prior), now, id, ...scopeArgs);

        // 3'. Re-index the changed content. SKIP entirely on a no-change correction:
        //     the WHEN-guarded triggers did not fire, so the existing twin / vec rows
        //     are already correct and must be left alone (matches the trigger path
        //     and the growObservation precedent).
        if (contentChanged) {
          // 3'a. Re-insert the NORMALIZED memory_fts_tri trigram twin for the new
          //      content: the memories_tri_au trigger (WHEN old.content IS NOT
          //      new.content) just DELETED the stale twin row, so without this the
          //      corrected row would be de-indexed in the trigram lane. Same guarded
          //      shape as the store-path twin write; never re-throw (would ROLLBACK
          //      the authoritative content update — the fail-safe direction is
          //      de-indexed, never stale-indexed).
          try {
            this.db
              .prepare(
                "INSERT INTO memory_fts_tri(rowid, content) VALUES ((SELECT rowid FROM memories WHERE id = ?), ?)",
              )
              .run(id, normalizeForSearch(newContent));
          } catch {
            // Trigram twin absent on this host, or an exceptional twin insert failure
            // → leave the row de-indexed in the trigram lane (fail-safe). The content
            // update is authoritative and stands; recall degrades to word + vector.
          }

          // 3'b. Invalidate the now-stale vec embedding: the vec0 twin still holds the
          //      C1 vector (vec_memories has no content trigger), which would surface
          //      the row for C1-similar queries as if it were current. Mirror store()'s
          //      no-precomputed-embedding path — drop the stale vec row + clear
          //      has_embedding, so the background indexer re-embeds C2. (store() only
          //      writes a vec row when the caller pre-supplies entry.embedding; a
          //      content correction supplies none, so the faithful mirror is
          //      invalidate-for-reindex, not a synchronous embed.)
          if (vecAvailable) {
            this.db.prepare("DELETE FROM vec_memories WHERE memory_id = ?").run(id);
            this.db.prepare("UPDATE memories SET has_embedding = 0 WHERE id = ?").run(id);
          }
        }
        return "superseded";
      });
      const outcome = tx(); // throws → automatic ROLLBACK; nothing committed

      // Counts/metadata + the decided OUTCOME only — NEVER the content body (§2.7).
      this.logger?.debug(
        { step: "memory-supersede", op: "supersede", outcome, durationMs: systemNowMs() - startMs },
        "Memory supersede complete",
      );
      return ok(outcome);
    } catch (e: unknown) {
      const durationMs = systemNowMs() - startMs;
      const error = e instanceof Error ? e : new Error(String(e));
      this.logger?.warn(
        {
          step: "memory-supersede",
          op: "supersede",
          durationMs,
          err: error,
          errorKind: "internal" as const,
          hint: "memory supersede failed — correction not applied (transaction rolled back)",
        },
        "Memory supersede failed",
      );
      return err(error);
    }
  }

  // ── listMemoryIdsBySessionKey ─────────────────────

  /**
   * Read the memory ids for a (sessionKey, tenant,
   * agent) scope WITHOUT deleting. Used by the session-reset handler to capture
   * THIS session's ids BEFORE `deleteBySessionKey`, so `--purge-derived` can be
   * session-scoped (source_ids ∩ thisSessionIds) instead of the coarse
   * "any dangling source id" sweep.
   *
   * Tenant/agent isolation: filters on `source_session_key` AND `tenant_id` AND `agent_id`
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

  // ── deleteBySessionKey ───────────────────────────────────

  /**
   * Delete ALL memory rows for a (sessionKey, tenant, agent)
   * scope. ONE query covers BOTH paired-conversation memories AND lcd-distilled
   * episodic memories — both store `source_session_key` on the `memories` row.
   *
   * Tenant/agent isolation: the WHERE filters on `source_session_key` AND `tenant_id` AND
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
        // Subquery is fully tenant+agent+session scoped so it can only ever
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
      // Exclude expired entries (mirrors the other read paths in
      // hydrateLane and search — `expires_at IS NULL OR expires_at > nowMs`).
      // The `AND evicted_at IS NULL` is defensive coupling — a
      // pinned row is store-side eviction-EXEMPT (the lifecycle sweep never evicts
      // pinned/system/high-proof rows), so a `pinned = 1` row can never carry
      // evicted_at; the guard makes the always-on-exclusion invariant explicit on this
      // recall read too, so the pinned-first lane and the fused lanes stay coupled.
      const nowMs = systemNowMs();
      const parsed = memoryRowMapper.parseRows(
        this.db
          .prepare(
            "SELECT * FROM memories " +
              "WHERE tenant_id = ? AND agent_id = ? AND pinned = 1 " +
              "AND (expires_at IS NULL OR expires_at > ?) " +
              "AND evicted_at IS NULL " +
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
