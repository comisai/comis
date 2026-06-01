// SPDX-License-Identifier: Apache-2.0
// @allow-throw: upsertTriple's trust-first invalidation runs the SELECT-incumbent → soft-close-loser → INSERT-new unit inside a better-sqlite3 `db.transaction(() => {...})()` callback, where a throw is the ONLY way to trigger the atomic ROLLBACK — returning a Result.err from the callback would COMMIT a torn supersession (an orphan close, or a double current-truth). The incumbent-row parse guard (`throw new Error(parsed.error.message)`) and any in-transaction fault are caught by the method's outer try/catch and converted to `err` (the tests prove "never throws"); consumed by the offline triple-extraction writer (the @allow-throw boundary), which treats the err as a non-fatal skipped write.
/**
 * SqliteTripleStore: the SOLE adapter for the segregated `TripleStorePort`
 * (@comis/core, Phase 100, Track F — KG-01/KG-02/KG-03). It owns ALL the
 * knowledge-graph triple SQL over the additive `memory_triples` table.
 *
 * ## Method status
 *
 * - `upsertTriple` does TRUST-FIRST single-current-truth invalidation (Plan
 *   100-02 / KG-02) in ONE `db.transaction`: it SELECTs the current-truth
 *   incumbent on (tenant, agent, subject, predicate) WHERE `t_valid_end IS NULL`,
 *   then resolves a contradiction (same s+p, DIFFERENT object) on the HARD trust
 *   ladder (`system` > `learned` > `external`) — the higher-trust row stays
 *   current REGARDLESS of recency; equal trust tiebreaks by recency (newer
 *   `t_occurred`|`t_ingested` wins); the LOSER is SOFT-CLOSED (`t_valid_end` +
 *   `expired_at` set), NEVER deleted. Same object is idempotent corroboration (no
 *   new history row). Non-overlapping occurred intervals coexist (Graphiti's
 *   interval-overlap guard).
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

// Row mapper — the sanctioned read path (no `as Foo[]`). Used for both the
// asOf window read AND the single current-truth incumbent (SELECT *) in the
// invalidation transaction (`parseOptionalRow`).
const tripleRowMapper = createRowMapper(MemoryTripleRowSchema);

/**
 * The decided branch of a `upsertTriple` invalidation, logged as metadata (never
 * the S/P/O body). `inserted` = no incumbent; `corroborated` = same object
 * (idempotent); `superseded` = a higher-trust (or equal-trust-newer) contradiction
 * soft-closed the incumbent; `recorded-not-believed` = a lower-trust (or
 * equal-trust-older) claim was kept but did NOT win; `coexist` = non-overlapping
 * occurred windows (both current-truth).
 */
type TripleUpsertOutcome =
  | "inserted"
  | "corroborated"
  | "superseded"
  | "recorded-not-believed"
  | "coexist";

/**
 * The Comis trust ladder as a HARD ordinal for the invalidation comparison
 * (KG-02). Trust is a HARD BRANCH here — the higher-trust row stays current
 * REGARDLESS of recency — NOT a soft score multiplier (that is `score.ts`'s job
 * on the read path). An `external`-trust claim can therefore NEVER supersede a
 * `system`/`learned` current-truth (the anti-poisoning control; SUITE-04 probes
 * exactly this). `system` (2) > `learned` (1) > `external` (0).
 */
const TRUST_RANK: Record<"system" | "learned" | "external", number> = {
  system: 2,
  learned: 1,
  external: 0,
};

/**
 * Two occurred windows OVERLAP iff each starts on/before the other ends
 * (half-open-friendly inclusive test). Only meaningful when BOTH rows carry a
 * full `[t_occurred .. t_occurred_end]` range — Graphiti's interval-overlap
 * guard: a contradiction is only real when the windows overlap; disjoint windows
 * are two facts true at DIFFERENT times (both stay current, neither closes).
 */
function occurredOverlaps(
  aStart: number,
  aEnd: number,
  bStart: number,
  bEnd: number,
): boolean {
  return aStart <= bEnd && bStart <= aEnd;
}

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
  // Loser-path INSERT (KG-02): the new row is written ALREADY-CLOSED
  // (`t_valid_end` + `expired_at` set) — "recorded but NOT believed" — when a
  // lower-trust or older-on-tiebreak claim must not supersede the incumbent. The
  // conflict is RETAINED (never dropped) and surfaceable. Bound params only.
  const insertTripleClosed = db.prepare(
    "INSERT INTO memory_triples " +
      "(id, tenant_id, agent_id, subject, predicate, object, trust, " +
      "t_valid_start, t_valid_end, t_ingested, expired_at, t_occurred, t_occurred_end, " +
      "source_memory_id, confidence) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  // SELECT the current-truth incumbent for (tenant, agent, subject, predicate),
  // scoped. `t_valid_end IS NULL` = currently believed. SELECT * → parsed via
  // the full-row mapper (no `as Row`). The (tenant, agent) filter is the
  // load-bearing ISOLATION boundary (T-100-02-02): a contradiction in one scope
  // can NEVER read/close a row in another. Bound params only.
  const selectIncumbent = db.prepare(
    "SELECT * FROM memory_triples " +
      "WHERE tenant_id = ? AND agent_id = ? AND subject = ? AND predicate = ? " +
      "AND t_valid_end IS NULL",
  );
  // Soft-close the LOSER (KG-02 / T-100-02-03): set `t_valid_end` + `expired_at`
  // — NEVER a DELETE. Keyed by id AND re-scoped on (tenant, agent) so a stray id
  // can never close a cross-scope row. Bound params only.
  const softCloseIncumbent = db.prepare(
    "UPDATE memory_triples SET t_valid_end = ?, expired_at = ? " +
      "WHERE id = ? AND tenant_id = ? AND agent_id = ?",
  );
  // Idempotent corroboration bump (same s+p+o): refresh the incumbent's optional
  // confidence in place — NO new history row. Scoped + keyed by id. Bound params.
  const bumpConfidence = db.prepare(
    "UPDATE memory_triples SET confidence = ? " +
      "WHERE id = ? AND tenant_id = ? AND agent_id = ?",
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
        // INSERT a fresh current-truth row (t_valid_end + expired_at NULL).
        const insertCurrent = (): void => {
          insertTriple.run(
            crypto.randomUUID(),
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
        };
        // INSERT the new row ALREADY-CLOSED (recorded-but-NOT-believed): the
        // loser of a contradiction. t_valid_end = expired_at = now.
        const insertRecordedNotBelieved = (): void => {
          insertTripleClosed.run(
            crypto.randomUUID(),
            tenantId,
            agentId,
            triple.subject,
            triple.predicate,
            triple.object,
            triple.trust,
            triple.tValidStart,
            now, // t_valid_end (closed immediately — not believed)
            now, // t_ingested
            now, // expired_at
            triple.tOccurred ?? null,
            triple.tOccurredEnd ?? null,
            triple.sourceMemoryId ?? null,
            triple.confidence ?? null,
          );
        };

        // Trust-first single-current-truth invalidation (KG-02) — ONE
        // synchronous transaction. better-sqlite3 BEGINs, runs fn, COMMITs — and
        // auto-ROLLBACKs on ANY throw, so the SELECT-incumbent → soft-close-loser
        // → INSERT-new unit is atomic: no orphan close, no double current-truth.
        // Single-threaded daemon write path = no interleave (the @allow-throw
        // boundary). The decided branch is returned for the metadata log.
        const tx = db.transaction((): TripleUpsertOutcome => {
          // 1. SELECT the current-truth incumbent (scoped). SELECT * → full-row
          //    mapper; a parse fault THROWS to ROLLBACK (caught below → err).
          const raw = selectIncumbent.get(tenantId, agentId, triple.subject, triple.predicate);
          const parsed = tripleRowMapper.parseOptionalRow(raw);
          if (!parsed.ok) throw new Error(parsed.error.message);
          const incumbent = parsed.value;

          // 2a. No incumbent → the new row is the sole current-truth.
          if (incumbent === undefined) {
            insertCurrent();
            return "inserted";
          }

          // 2b. Same object = corroboration → idempotent (optional confidence
          //     bump on the incumbent in place; NO new history row).
          if (incumbent.object === triple.object) {
            if (triple.confidence !== undefined) {
              bumpConfidence.run(triple.confidence, incumbent.id, tenantId, agentId);
            }
            return "corroborated";
          }

          // 2c. Different object = a candidate contradiction.
          // Interval-overlap guard (Graphiti): when BOTH rows carry a FULL
          // occurred range, it is a contradiction ONLY if the windows overlap.
          // Disjoint windows = two facts true at different times → the new row
          // ALSO becomes current-truth (neither closes).
          const newHasRange = triple.tOccurred != null && triple.tOccurredEnd != null;
          const incHasRange = incumbent.t_occurred !== null && incumbent.t_occurred_end !== null;
          if (
            newHasRange &&
            incHasRange &&
            !occurredOverlaps(
              triple.tOccurred as number,
              triple.tOccurredEnd as number,
              incumbent.t_occurred as number,
              incumbent.t_occurred_end as number,
            )
          ) {
            insertCurrent();
            return "coexist";
          }

          // Trust-first HARD ladder comparison (NOT a soft weight). Higher trust
          // stays current REGARDLESS of recency.
          const newRank = TRUST_RANK[triple.trust];
          const incRank = TRUST_RANK[incumbent.trust];

          if (newRank > incRank) {
            // New wins: soft-close the incumbent (loser) — never DELETE — and
            // insert the new row as current-truth.
            softCloseIncumbent.run(now, now, incumbent.id, tenantId, agentId);
            insertCurrent();
            return "superseded";
          }

          if (newRank < incRank) {
            // A newer LOW-trust claim NEVER supersedes a higher-trust fact
            // (SUITE-04). Record it (closed) so the conflict is retained +
            // surfaceable; the incumbent stays current.
            insertRecordedNotBelieved();
            return "recorded-not-believed";
          }

          // Equal trust → recency tiebreak on t_occurred (fallback t_ingested).
          const newWhen = triple.tOccurred ?? now;
          const incWhen = incumbent.t_occurred ?? incumbent.t_ingested;
          if (newWhen > incWhen) {
            softCloseIncumbent.run(now, now, incumbent.id, tenantId, agentId);
            insertCurrent();
            return "superseded";
          }
          // New is NOT newer (older or a tie) → it loses; record it closed.
          insertRecordedNotBelieved();
          return "recorded-not-believed";
        });
        const outcome = tx(); // throws → automatic ROLLBACK; nothing committed

        // Counts/metadata + the decided OUTCOME only — NEVER the S/P/O body
        // (§2.7). `closed: 1` flags that an incumbent edge was soft-closed.
        logger?.debug(
          {
            step: "triple-upsert",
            outcome,
            closed: outcome === "superseded" ? 1 : 0,
            durationMs: systemNowMs() - startMs,
          },
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
            hint: "triple write failed — assertion not persisted (transaction rolled back)",
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
