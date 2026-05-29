// SPDX-License-Identifier: Apache-2.0
/**
 * SqliteMemoryConsolidationStore: the SOLE adapter for the segregated
 * `MemoryConsolidationStore` port (@comis/core, Phase 84). It owns ALL
 * consolidation SQL — the scoped, STATE-predicate candidate selection
 * (`consolidated_at IS NULL`, NOT a time cursor — CONS-04), the embedding
 * hydration (a `LEFT JOIN vec_memories` when sqlite-vec is available — RESEARCH
 * Pitfall 7), the observation listing for the deterministic dedup pre-check
 * (CONS-01/04 support), and the ATOMIC `applyConsolidation` transaction
 * (CONS-03).
 *
 * It shares the `better-sqlite3` handle of the `SqliteMemoryAdapter` (passed in
 * via `getDb()`), so it runs against the same schema — the `memories` table now
 * carries the 5 observation columns (`proof_count`, `source_ids`,
 * `consolidated_at`, `confidence`, `history`) and the
 * `idx_memories_unconsol` / `idx_memories_observations` partial indexes added by
 * `ensureMemoryColumns` + `initSchema` (Plan 01).
 *
 * ## The two central de-risks live here (the SQL boundary)
 *
 * 1. **Atomic apply (CONS-03).** `applyConsolidation` is ONE
 *    `db.transaction(fn)()`: it creates the observation row AND marks every
 *    source `consolidated_at` in a single unit. better-sqlite3's transaction
 *    callable auto-ROLLBACKs on any throw, so a mid-failure leaves NEITHER an
 *    orphan observation NOR partially-marked sources.
 * 2. **State-predicate selection (CONS-04).** Candidates are selected by
 *    `consolidated_at IS NULL` — a STATE predicate, not a `created_at > cursor`
 *    watermark. Because the mark happens INSIDE the apply transaction, a
 *    processed source leaves the candidate set atomically; a re-run does not
 *    re-select it, so the cycle is naturally idempotent (no double-create — the
 *    singleton/watermark bug the superseded design sketch suffered).
 *
 * ## Non-destructive (CONS-05)
 *
 * `applyConsolidation` NEVER removes a source memory and NEVER touches a
 * supersession column — it only sets `consolidated_at`. The raw rows stay
 * live and recall-able; conflicts are resolved at read time (Phase 81).
 *
 * ## Single-writer assumption (mirror sqlite-memory-entity-store.ts:137-144)
 *
 * better-sqlite3 transactions are DEFERRED (no up-front write lock), so
 * atomicity within one `applyConsolidation` call does NOT by itself serialize
 * two *concurrent* writers. What guarantees no interleave is that the daemon
 * memory write path is SINGLE-THREADED and better-sqlite3 is synchronous — the
 * consolidation cron and a live agent write cannot run mid-transaction. The
 * apply leans on that assumption (a concurrent design would need additional
 * locking around the create+mark unit).
 *
 * ## Isolation is the load-bearing security boundary (T-84-05)
 *
 * Comis runs many agents/tenants in one DB. The candidate SELECT, the
 * observation SELECT, AND the source-mark UPDATE all filter on
 * `(tenant_id, agent_id)` (the UPDATE on `tenant_id` — a cross-tenant id is a
 * fail-closed no-op) — parameterized — so a cross-scope memory is never
 * returned as a candidate nor marked.
 *
 * ## Untrusted input (T-84-09)
 *
 * Memory content + ids derive from conversation text. Every value reaches SQL
 * as a bound `?` parameter — never concatenated — and every read parses through
 * `MemoryRowSchema` (the `createRowMapper` factory; no `as Foo[]` casts —
 * `untyped-sqlite.test.ts`).
 *
 * @module
 */

import type Database from "better-sqlite3";
import type {
  MemoryConsolidationStore,
  ConsolidationCandidate,
  ConsolidationPlan,
  MemoryEntry,
} from "@comis/core";
import { systemNowMs } from "@comis/core";
import { ok, err, type Result } from "@comis/shared";
import { createRowMapper, rowToEntry, insertMemoryRow } from "./row-mapper.js";
import { MemoryRowSchema } from "./row-schemas.js";
import { isVecAvailable } from "./schema.js";

/** Minimal pino-compatible logger (mirrors sqlite-memory-entity-store.ts). */
interface MemoryLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  debug(obj: Record<string, unknown>, msg: string): void;
}

/** Constructor deps for {@link createSqliteMemoryConsolidationStore}. */
export interface MemoryConsolidationStoreDeps {
  /** The shared better-sqlite3 handle (typically `SqliteMemoryAdapter.getDb()`). */
  db: Database.Database;
  /** Optional structured logger. */
  logger?: MemoryLogger;
}

// Row mapper — the sanctioned read path (no `as Foo[]`). The candidate SELECT
// peels the joined `embedding` column off each raw row BEFORE this strict parse,
// so the extra column never trips MemoryRowSchema's `strictObject`.
const memoryRowMapper = createRowMapper(MemoryRowSchema);

/**
 * Decode a sqlite-vec embedding column (a Node Buffer of packed float32s) into
 * a `number[]`. Returns `undefined` when the column is null/absent (a LEFT JOIN
 * miss, or sqlite-vec unavailable) — embeddings are optional on a candidate
 * (the clusterer then degrades to entity/FTS overlap, non-fatal).
 */
function decodeEmbedding(raw: unknown): number[] | undefined {
  if (!Buffer.isBuffer(raw)) return undefined;
  // sqlite-vec packs the vector as little-endian float32s. Slice on the Buffer's
  // own byteOffset/byteLength so a pooled Buffer's backing ArrayBuffer is read
  // at the correct window.
  const f32 = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
  return Array.from(f32);
}

/**
 * Create the SQLite-backed {@link MemoryConsolidationStore} adapter over a
 * shared db handle. The handle's lifecycle (open/close, pragmas) is owned by the
 * caller (the memory adapter) — this factory neither opens nor closes it.
 */
export function createSqliteMemoryConsolidationStore(
  deps: MemoryConsolidationStoreDeps,
): MemoryConsolidationStore {
  const { db, logger } = deps;

  // --- Prepared statements (parameterized; built once, reused across calls) ---

  // Candidate selection. Embeddings are hydrated via a LEFT JOIN onto the
  // vec_memories vec0 virtual table when sqlite-vec is available; when it is
  // not, the same query minus the JOIN + the `embedding` projection runs (the
  // candidate then has no embedding — the clusterer degrades gracefully). Both
  // variants share the load-bearing predicates:
  //   - m.tenant_id = ? AND m.agent_id = ?  → scope isolation (T-84-05)
  //   - m.consolidated_at IS NULL           → STATE predicate, NOT a cursor (CONS-04)
  //   - m.proof_count IS NULL               → only raws, never existing observations
  //   - ORDER BY m.created_at ASC LIMIT ?   → oldest-first, bounded (CONS-07)
  const selectCandidates = isVecAvailable()
    ? db.prepare(
        "SELECT m.*, v.embedding AS embedding FROM memories m " +
          "LEFT JOIN vec_memories v ON v.memory_id = m.id " +
          "WHERE m.tenant_id = ? AND m.agent_id = ? AND m.consolidated_at IS NULL " +
          "AND m.proof_count IS NULL " +
          "ORDER BY m.created_at ASC LIMIT ?",
      )
    : db.prepare(
        "SELECT m.* FROM memories m " +
          "WHERE m.tenant_id = ? AND m.agent_id = ? AND m.consolidated_at IS NULL " +
          "AND m.proof_count IS NULL " +
          "ORDER BY m.created_at ASC LIMIT ?",
      );

  // Observation listing for the dedup pre-check (CONS-04). proof_count IS NOT
  // NULL is the column-flag for "this row is an observation" (§4.1).
  const selectObservations = db.prepare(
    "SELECT * FROM memories WHERE tenant_id = ? AND agent_id = ? AND proof_count IS NOT NULL " +
      "ORDER BY created_at DESC LIMIT ?",
  );

  // Source-mark UPDATE — scoped on tenant_id (a cross-tenant id is a no-op,
  // fail-closed). NON-DESTRUCTIVE: sets consolidated_at only; the source row is
  // never removed (CONS-05).
  const markConsolidated = db.prepare(
    "UPDATE memories SET consolidated_at = ? WHERE id = ? AND tenant_id = ?",
  );

  return {
    async listConsolidationCandidates(
      agentId: string,
      tenantId: string,
      limit: number,
    ): Promise<Result<ConsolidationCandidate[], Error>> {
      const startMs = systemNowMs();
      try {
        // `Statement.all()` already returns `unknown[]` here — no `as Foo[]`
        // cast (untyped-sqlite). Each row is peeled + parsed below.
        const rawRows = selectCandidates.all(tenantId, agentId, limit);

        const candidates: ConsolidationCandidate[] = [];
        for (const raw of rawRows) {
          // Peel the joined embedding column off the row BEFORE the strict parse
          // (MemoryRowSchema is strictObject — an extra `embedding` column would
          // be rejected). The remaining columns are the memory row.
          const { embedding: rawEmbedding, ...memoryRow } = raw as Record<string, unknown>;
          const embedding = decodeEmbedding(rawEmbedding);

          const parsed = memoryRowMapper.parseOptionalRow(memoryRow);
          if (!parsed.ok) return err(new Error(parsed.error.message));
          if (!parsed.value) continue; // defensive — parseOptionalRow only nulls on undefined input

          const entry = rowToEntry(parsed.value, embedding);
          candidates.push(embedding ? { entry, embedding } : { entry });
        }

        const durationMs = systemNowMs() - startMs;
        logger?.debug(
          { step: "consolidation-candidates", durationMs, count: candidates.length },
          "Consolidation candidate selection complete",
        );
        return ok(candidates);
      } catch (e: unknown) {
        const durationMs = systemNowMs() - startMs;
        const error = e instanceof Error ? e : new Error(String(e));
        logger?.warn(
          {
            step: "consolidation-candidates",
            durationMs,
            err: error,
            errorKind: "internal" as const,
            hint: "consolidation candidate query failed — check DB integrity",
          },
          "Consolidation candidate selection failed",
        );
        return err(error);
      }
    },

    async listObservations(
      agentId: string,
      tenantId: string,
      limit: number,
    ): Promise<Result<MemoryEntry[], Error>> {
      const startMs = systemNowMs();
      try {
        const parsed = memoryRowMapper.parseRows(selectObservations.all(tenantId, agentId, limit));
        if (!parsed.ok) return err(new Error(parsed.error.message));

        // Observations have no embedding hydration (the dedup pre-check compares
        // content/source-id sets, not vectors).
        const observations = parsed.value.map((row) => rowToEntry(row));

        const durationMs = systemNowMs() - startMs;
        logger?.debug(
          { step: "consolidation-observations", durationMs, count: observations.length },
          "Observation listing complete",
        );
        return ok(observations);
      } catch (e: unknown) {
        const durationMs = systemNowMs() - startMs;
        const error = e instanceof Error ? e : new Error(String(e));
        logger?.warn(
          {
            step: "consolidation-observations",
            durationMs,
            err: error,
            errorKind: "internal" as const,
            hint: "observation listing query failed — check DB integrity",
          },
          "Observation listing failed",
        );
        return err(error);
      }
    },

    async applyConsolidation(
      plan: ConsolidationPlan,
    ): Promise<Result<MemoryEntry, Error>> {
      const startMs = systemNowMs();
      try {
        // ONE transaction (CONS-03): create the observation AND mark every source
        // consolidated_at. better-sqlite3's transaction callable BEGINs, runs fn,
        // COMMITs — and auto-ROLLBACKs on ANY throw, so a failure in EITHER the
        // insert OR a source-mark reverts BOTH. The mark uses `plan.now` (the
        // injected clock value) — never a wall-clock global for the WRITTEN
        // timestamp (systemNowMs below is only the durationMs metric, globals rule).
        const tx = db.transaction(() => {
          insertMemoryRow(db, plan.observation, "semantic"); // observation stays memory_type='semantic' (§4.1)
          for (const id of plan.markConsolidated) {
            markConsolidated.run(plan.now, id, plan.tenantId); // non-destructive, scoped, fail-closed
          }
        });
        tx(); // throws → automatic ROLLBACK; nothing committed (no orphan, no partial mark)

        const durationMs = systemNowMs() - startMs;
        logger?.debug(
          {
            step: "consolidation-apply",
            durationMs,
            markedCount: plan.markConsolidated.length,
            proofCount: plan.observation.proofCount,
          },
          "Consolidation applied (observation created + sources marked)",
        );
        return ok(plan.observation);
      } catch (e: unknown) {
        const durationMs = systemNowMs() - startMs;
        const error = e instanceof Error ? e : new Error(String(e));
        logger?.warn(
          {
            step: "consolidation-apply",
            durationMs,
            err: error,
            errorKind: "internal" as const,
            hint: "applyConsolidation transaction failed — rolled back, no partial state",
          },
          "Consolidation apply failed",
        );
        return err(error);
      }
    },
  };
}
