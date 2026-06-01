// SPDX-License-Identifier: Apache-2.0
/**
 * SqliteTripleStore: the SOLE adapter for the segregated `TripleStorePort`
 * (@comis/core, Phase 100, Track F — KG-01/KG-03). It owns ALL the
 * knowledge-graph triple SQL over the additive `memory_triples` table.
 *
 * ## This is the Plan 100-01 SKELETON
 *
 * - `upsertTriple` is INSERT-ONLY — it always writes a current-truth row
 *   (`t_valid_end`/`expired_at` NULL). The trust-first single-current-truth
 *   invalidation transaction (compare trust on the ladder, soft-close the loser,
 *   never DELETE) is Plan 100-02.
 * - `asOf(t)` is the working valid-time query (`t_valid_start <= t AND
 *   (t_valid_end IS NULL OR t_valid_end > t)`), scoped.
 * - `spreadLane` returns `[]` — the bounded recursive-CTE neighbourhood spread is
 *   Plan 100-04.
 *
 * It shares the `better-sqlite3` handle of the `SqliteMemoryAdapter` (passed in
 * via `getDb()`), so it runs against the same schema with `PRAGMA foreign_keys =
 * ON` already set — that pragma is what makes the `source_memory_id ->
 * memories(id)` `ON DELETE CASCADE` fire (deleting a source memory drops its
 * derived triples; no orphan-sweep job).
 *
 * ## Isolation is the load-bearing security boundary (T-100-01-01, the §5.2 / ENT-03 pattern)
 *
 * Comis runs many agents in one DB. BOTH the write (the INSERT) and the read
 * (`asOf`, and the Plan-04 `spreadLane` CTE) filter on `(tenant_id, agent_id)` —
 * parameterized — so a triple written under one (tenant, agent) is NEVER returned
 * for another scope by subject/object-string coincidence.
 *
 * ## Untrusted input
 *
 * `subject`/`predicate`/`object` derive from conversation content. They are DATA,
 * never SQL — every value reaching SQL is a bound `?` parameter, never
 * concatenated. Every read parses through `createRowMapper` (no `as Foo[]` casts;
 * `untyped-sqlite.test.ts`). The adapter logs counts/metadata only — NEVER the
 * subject/predicate/object body (AGENTS.md §2.7).
 *
 * @module
 */

import type Database from "better-sqlite3";
import type { TripleStorePort, TripleScope, TripleInput } from "@comis/core";
import { systemNowMs } from "@comis/core";
import { ok, err, type Result } from "@comis/shared";
import { createRowMapper } from "./row-mapper.js";
import { MemoryTripleRowSchema } from "./row-schemas.js";

/** Minimal pino-compatible logger (mirrors sqlite-memory-causal-store.ts). */
interface MemoryLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  debug(obj: Record<string, unknown>, msg: string): void;
}

/** Constructor deps for {@link createSqliteTripleStore}. */
export interface MemoryTripleStoreDeps {
  /** The shared better-sqlite3 handle (typically `SqliteMemoryAdapter.getDb()`). */
  db: Database.Database;
  /** Optional structured logger. */
  logger?: MemoryLogger;
}

// Row mapper — the sanctioned read path (no `as Foo[]`).
const tripleRowMapper = createRowMapper(MemoryTripleRowSchema);

/** Map a parsed snake_case `memory_triples` row to the camelCase `TripleInput`. */
function rowToTripleInput(row: {
  subject: string;
  predicate: string;
  object: string;
  trust: "system" | "learned" | "external";
  t_valid_start: number;
  t_occurred: number | null;
  t_occurred_end: number | null;
  source_memory_id: string | null;
  confidence: number | null;
}): TripleInput {
  return {
    subject: row.subject,
    predicate: row.predicate,
    object: row.object,
    trust: row.trust,
    tValidStart: row.t_valid_start,
    ...(row.t_occurred !== null ? { tOccurred: row.t_occurred } : {}),
    ...(row.t_occurred_end !== null ? { tOccurredEnd: row.t_occurred_end } : {}),
    ...(row.source_memory_id !== null ? { sourceMemoryId: row.source_memory_id } : {}),
    ...(row.confidence !== null ? { confidence: row.confidence } : {}),
  };
}

/**
 * Create the SQLite-backed {@link TripleStorePort} adapter over a shared db
 * handle. The handle's lifecycle (open/close, pragmas) is owned by the caller
 * (the memory adapter) — this factory neither opens nor closes it.
 */
export function createSqliteTripleStore(deps: MemoryTripleStoreDeps): TripleStorePort {
  const { db, logger } = deps;

  // --- Prepared statements (parameterized; reused across calls) ---
  // INSERT-ONLY current-truth write (Plan 100-01 skeleton). t_valid_end +
  // expired_at are NULL (currently believed / live record); t_ingested =
  // scope.now (injected clock, NEVER Date.now()). Bound params only.
  const insertTriple = db.prepare(
    "INSERT INTO memory_triples " +
      "(id, tenant_id, agent_id, subject, predicate, object, trust, " +
      "t_valid_start, t_valid_end, t_ingested, expired_at, t_occurred, t_occurred_end, " +
      "source_memory_id, confidence) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL, ?, ?, ?, ?)",
  );
  // Valid-time as-of read (KG-03), scoped. The `tenant_id = ? AND agent_id = ?`
  // is the load-bearing ISOLATION boundary (T-100-01-01). Bound params only.
  const asOfSelect = db.prepare(
    "SELECT * FROM memory_triples " +
      "WHERE tenant_id = ? AND agent_id = ? " +
      "AND t_valid_start <= ? AND (t_valid_end IS NULL OR t_valid_end > ?)",
  );

  return {
    async upsertTriple(triple: TripleInput, scope: TripleScope): Promise<Result<void, Error>> {
      const startMs = systemNowMs();
      const { tenantId, agentId, now } = scope;
      try {
        // Plan 100-02: trust-first single-current-truth invalidation transaction
        // goes here (SELECT current incumbent on (tenant, agent, subject,
        // predicate) WHERE t_valid_end IS NULL; compare trust; soft-close the
        // loser; never DELETE). For now: INSERT-ONLY current-truth row.
        const id = crypto.randomUUID();
        insertTriple.run(
          id,
          tenantId,
          agentId,
          triple.subject,
          triple.predicate,
          triple.object,
          triple.trust,
          triple.tValidStart,
          now, // t_ingested (injected clock)
          triple.tOccurred ?? null,
          triple.tOccurredEnd ?? null,
          triple.sourceMemoryId ?? null,
          triple.confidence ?? null,
        );

        // Counts/metadata only — NEVER the subject/predicate/object body (§2.7).
        logger?.debug(
          { step: "triple-upsert", written: 1, durationMs: systemNowMs() - startMs },
          "Triple upsert complete",
        );
        return ok(undefined);
      } catch (e: unknown) {
        const durationMs = systemNowMs() - startMs;
        const error = e instanceof Error ? e : new Error(String(e));
        logger?.warn(
          {
            step: "triple-upsert",
            durationMs,
            err: error,
            errorKind: "internal" as const,
            hint: "triple write failed — assertion not persisted",
          },
          "Triple upsert failed",
        );
        return err(error);
      }
    },

    async asOf(
      t: number,
      scope: Omit<TripleScope, "now">,
    ): Promise<Result<TripleInput[], Error>> {
      const startMs = systemNowMs();
      const { tenantId, agentId } = scope;
      try {
        // Scoped valid-time window. The (tenant, agent) filter is load-bearing.
        const rows = asOfSelect.all(tenantId, agentId, t, t);
        const parsed = tripleRowMapper.parseRows(rows);
        if (!parsed.ok) return err(new Error(parsed.error.message));

        const results = parsed.value.map(rowToTripleInput);

        const durationMs = systemNowMs() - startMs;
        logger?.debug(
          { step: "triple-asof", count: results.length, durationMs },
          "Triple asOf complete",
        );
        return ok(results);
      } catch (e: unknown) {
        const durationMs = systemNowMs() - startMs;
        const error = e instanceof Error ? e : new Error(String(e));
        logger?.warn(
          {
            step: "triple-asof",
            durationMs,
            err: error,
            errorKind: "internal" as const,
            hint: "triple asOf query failed",
          },
          "Triple asOf failed",
        );
        return err(error);
      }
    },

    async spreadLane(
      seedSubjects: string[],
      _scope: Omit<TripleScope, "now">,
      _maxDepth: number,
      _fanOut: number,
      _cap: number,
    ): Promise<Result<import("@comis/core").MemorySearchResult[], Error>> {
      // Plan 100-04: bounded recursive-CTE neighbourhood spread goes here (the
      // scoped `WITH RECURSIVE walk(...)` over current-truth subject->object
      // edges, depth/fan-out capped, hydrated into MemorySearchResult[]). For now
      // it stubs to ok([]) — the empty-lane no-op leaves RRF ranking unchanged.
      logger?.debug(
        { step: "triple-spread", seedCount: seedSubjects.length, count: 0, durationMs: 0 },
        "Triple spreadLane stub (Plan 100-04)",
      );
      return ok([]);
    },
  };
}
