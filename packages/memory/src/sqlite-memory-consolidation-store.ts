// SPDX-License-Identifier: Apache-2.0
// @allow-throw: foldIntoExisting's `throw new Error(...)` guards (fold target not found / mapper parse failure / grown-row vanished) run INSIDE the better-sqlite3 `db.transaction(fn)()` callback, where a throw is the ONLY way to trigger the atomic ROLLBACK — returning a Result.err from the callback would COMMIT the partial grow. Every throw is caught by the method's own outer try/catch and converted to `err` (the tests prove "never throws"); consumed by the daemon consolidation cron (@allow-throw boundary), which treats the err as a non-fatal skipped fold.
/**
 * SqliteMemoryConsolidationStore: the SOLE adapter for the segregated
 * `MemoryConsolidationStore` port (@comis/core). It owns ALL
 * consolidation SQL — the scoped, STATE-predicate candidate selection
 * (`consolidated_at IS NULL`, NOT a time cursor), the embedding
 * hydration (a `LEFT JOIN vec_memories` when sqlite-vec is available — RESEARCH
 * Pitfall 7), the observation listing for the deterministic dedup pre-check,
 * and the ATOMIC `applyConsolidation` transaction.
 *
 * It shares the `better-sqlite3` handle of the `SqliteMemoryAdapter` (passed in
 * via `getDb()`), so it runs against the same schema — the `memories` table now
 * carries the 5 observation columns (`proof_count`, `source_ids`,
 * `consolidated_at`, `confidence`, `history`) and the
 * `idx_memories_unconsol` / `idx_memories_observations` partial indexes added by
 * `ensureMemoryColumns` + `initSchema`.
 *
 * ## The two central de-risks live here (the SQL boundary)
 *
 * 1. **Atomic apply.** `applyConsolidation` is ONE
 *    `db.transaction(fn)()`: it creates the observation row AND marks every
 *    source `consolidated_at` in a single unit. better-sqlite3's transaction
 *    callable auto-ROLLBACKs on any throw, so a mid-failure leaves NEITHER an
 *    orphan observation NOR partially-marked sources.
 * 2. **State-predicate selection.** Candidates are selected by
 *    `consolidated_at IS NULL` — a STATE predicate, not a `created_at > cursor`
 *    watermark. Because the mark happens INSIDE the apply transaction, a
 *    processed source leaves the candidate set atomically; a re-run does not
 *    re-select it, so the cycle is naturally idempotent (no double-create — the
 *    singleton/watermark bug the superseded design sketch suffered).
 *
 * ## Non-destructive
 *
 * `applyConsolidation` NEVER removes a source memory and NEVER touches a
 * supersession column — it only sets `consolidated_at`. The raw rows stay
 * live and recall-able; conflicts are resolved at read time.
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
 * ## Isolation is the load-bearing security boundary
 *
 * Comis runs many agents/tenants in one DB. The candidate SELECT, the
 * observation SELECT, AND the source-mark UPDATE all filter on
 * `(tenant_id, agent_id)` (the UPDATE on `tenant_id` — a cross-tenant id is a
 * fail-closed no-op) — parameterized — so a cross-scope memory is never
 * returned as a candidate nor marked.
 *
 * ## Untrusted input
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
  ConsolidationFoldPlan,
  MemoryEntry,
} from "@comis/core";
import { systemNowMs } from "@comis/core";
import { ok, err, type Result } from "@comis/shared";
import { createRowMapper, rowToEntry, insertMemoryRow } from "./row-mapper.js";
import { searchByVector } from "./hybrid-search.js";
import { MemoryRowSchema, IdProjectionRowSchema } from "./row-schemas.js";
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

// DIST-05 id-projection mapper (sanctioned typed-read path; no `as Foo[]` cast).
const idProjectionMapper = createRowMapper(IdProjectionRowSchema);

/**
 * Decode a sqlite-vec embedding column (a Node Buffer of packed float32s) into
 * a `number[]`. Returns `undefined` when the column is null/absent (a LEFT JOIN
 * miss, or sqlite-vec unavailable) — embeddings are optional on a candidate
 * (the clusterer then degrades to entity/FTS overlap, non-fatal).
 *
 * Decode is TOTAL and non-throwing. A corrupt/misaligned/truncated blob
 * degrades that ONE candidate to "no embedding" — it MUST NOT throw, because the
 * caller's outer try/catch would turn a single bad row into an `err` and the
 * consolidation job treats a candidate-read `err` as FATAL (aborts the whole
 * run). Two concrete hazards this guards:
 *   - byteOffset alignment: `new Float32Array(buf.buffer, buf.byteOffset, len)`
 *     throws `RangeError` when `byteOffset` is not a multiple of 4 (a POOLED
 *     Buffer's backing ArrayBuffer window). We copy the bytes into a fresh,
 *     0-aligned ArrayBuffer first, so the view offset is always 0.
 *   - truncation: a blob whose byteLength is not a multiple of 4 is not a clean
 *     float32 vector; viewing `floor(len/4)` floats would silently DROP the
 *     trailing bytes and feed a wrong vector into cosine. We reject it.
 */
function decodeEmbedding(raw: unknown): number[] | undefined {
  if (!Buffer.isBuffer(raw)) return undefined;
  // A clean float32 payload is a whole number of 4-byte lanes; anything else is
  // a corrupt/partial blob → degrade (never a silently-truncated vector).
  if (raw.byteLength % 4 !== 0) return undefined;
  try {
    // Copy into a fresh, 0-offset ArrayBuffer (owns its own buffer) so the
    // Float32Array view is always 4-byte aligned regardless of the source
    // Buffer's pooled byteOffset. sqlite-vec packs little-endian float32s.
    const copy = Uint8Array.prototype.slice.call(raw);
    return Array.from(new Float32Array(copy.buffer, 0, copy.byteLength / 4));
  } catch {
    // Defensive: never let one bad row abort the candidate read.
    return undefined;
  }
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
  //   - m.tenant_id = ? AND m.agent_id = ?  → scope isolation
  //   - m.consolidated_at IS NULL           → STATE predicate, NOT a cursor
  //   - m.proof_count IS NULL               → only raws, never existing observations
  //   - ORDER BY m.created_at ASC LIMIT ?   → oldest-first, bounded
  const selectCandidates = isVecAvailable()
    ? db.prepare(
        "SELECT m.*, v.embedding AS embedding FROM memories m " +
          "LEFT JOIN vec_memories v ON v.memory_id = m.id " +
          "WHERE m.tenant_id = ? AND m.agent_id = ? AND m.consolidated_at IS NULL " +
          "AND m.proof_count IS NULL AND m.pinned != 1 " +
          "ORDER BY m.created_at ASC LIMIT ?",
      )
    : db.prepare(
        "SELECT m.* FROM memories m " +
          "WHERE m.tenant_id = ? AND m.agent_id = ? AND m.consolidated_at IS NULL " +
          "AND m.proof_count IS NULL AND m.pinned != 1 " +
          "ORDER BY m.created_at ASC LIMIT ?",
      );

  // Observation listing for the dedup pre-check. proof_count IS NOT
  // NULL is the column-flag for "this row is an observation" (§4.1).
  const selectObservations = db.prepare(
    "SELECT * FROM memories WHERE tenant_id = ? AND agent_id = ? AND proof_count IS NOT NULL " +
      "ORDER BY created_at DESC LIMIT ?",
  );

  // Source-mark UPDATE — scoped on tenant_id (a cross-tenant id is a no-op,
  // fail-closed). NON-DESTRUCTIVE: sets consolidated_at only; the source row is
  // never removed.
  const markConsolidated = db.prepare(
    "UPDATE memories SET consolidated_at = ? WHERE id = ? AND tenant_id = ?",
  );

  // --- Fold statements — the dual of the create path ---

  // Read the EXISTING observation to grow, INSIDE the fold transaction. Scoped on
  // (tenant_id) + `proof_count IS NOT NULL` so the target MUST be an observation
  // in the caller's tenant — a cross-tenant id OR a raw (proof_count NULL) row
  // misses → fail-closed err, nothing mutated.
  const selectObservationById = db.prepare(
    "SELECT * FROM memories WHERE id = ? AND tenant_id = ? AND proof_count IS NOT NULL",
  );

  // Grow the observation in place (partial-column UPDATE — NOT a full-row replace
  // via the create-path insert helper). `content = COALESCE(?, content)` makes an
  // omitted content a true no-op on the column → the `memories_au AFTER UPDATE OF
  // content` FTS trigger does not re-index a proof-only fold (RESEARCH Pitfall 6,
  // schema.ts:284). `trust_level = ?` writes plan.trustLevel VERBATIM — the
  // adapter never recomputes/raises trust (the min ceiling is computed upstream;
  // the adapter has no path to RAISE). Scoped on (tenant_id) +
  // `proof_count IS NOT NULL` (defense-in-depth — the same predicate as the read).
  const growObservation = db.prepare(
    "UPDATE memories SET proof_count = ?, source_ids = ?, history = ?, confidence = ?, " +
      "occurred_at = ?, trust_level = ?, content = COALESCE(?, content), updated_at = ? " +
      "WHERE id = ? AND tenant_id = ? AND proof_count IS NOT NULL",
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
        // ONE transaction: create the observation AND mark every source
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

    async foldIntoExisting(
      plan: ConsolidationFoldPlan,
    ): Promise<Result<MemoryEntry, Error>> {
      const startMs = systemNowMs();
      try {
        // ONE transaction: grow the EXISTING observation AND mark every
        // new source consolidated_at in a single unit. better-sqlite3's
        // transaction callable auto-ROLLBACKs on ANY throw, so a failure in EITHER
        // the grow OR a source-mark reverts BOTH — no torn observation, no orphan
        // mark. `grown` is captured inside so the read-back reflects the committed
        // state. The mark + history use `plan.now` (the injected clock); systemNowMs
        // below is only the durationMs metric (globals rule).
        let grown: MemoryEntry | undefined;
        const tx = db.transaction(() => {
          // (a) Read the target INSIDE the tx — must be an observation in scope.
          //     A cross-tenant id OR a raw (proof_count NULL) row misses → throw →
          //     ROLLBACK → err (fail-closed). Parsed via the row mapper
          //     (the sanctioned typed-read path — untyped-sqlite gate).
          const targetRaw = selectObservationById.get(plan.targetObservationId, plan.tenantId);
          const parsedTarget = memoryRowMapper.parseOptionalRow(targetRaw);
          if (!parsedTarget.ok) throw new Error(parsedTarget.error.message);
          if (!parsedTarget.value) {
            throw new Error("fold target not found — not an observation in scope");
          }
          const target = rowToEntry(parsedTarget.value);

          // (b) IDEMPOTENCY backstop: proof_count := |UNION(existing, new)|
          //     — a SET-cardinality recompute via `new Set(...)`, NEVER a blind +=.
          //     Re-folding already-present sources leaves the count unchanged.
          const union = [...new Set([...(target.sourceIds ?? []), ...plan.newSourceIds])];
          const newProofCount = union.length;

          // (c) Non-destructive history: append the prior content ONLY
          //     when the fold actually CHANGES content (a proof-only fold appends
          //     nothing → no FTS churn, no history noise — Pitfall 6).
          const history = [...(target.history ?? [])];
          if (plan.content !== undefined && plan.content !== target.content) {
            history.push({ previousContent: target.content, changedAt: plan.now });
          }

          // (d) Grow the row: UNIONed proof_count + source_ids, appended history,
          //     refreshed confidence + occurred_at (half-life clock reset), trust
          //     written VERBATIM (never raised), content COALESCE-d
          //     (omit = unchanged). source_ids/history persist as JSON TEXT.
          growObservation.run(
            newProofCount,
            JSON.stringify(union),
            JSON.stringify(history),
            plan.confidence,
            plan.occurredAt,
            plan.trustLevel,
            plan.content ?? null, // null → COALESCE keeps existing content (no FTS re-index)
            plan.now, // updated_at (record time of the fold)
            plan.targetObservationId,
            plan.tenantId,
          );

          // (e) Mark every NEW source consolidated_at — scoped, fail-closed,
          //     non-destructive (sets consolidated_at only; never deletes).
          for (const id of plan.newSourceIds) {
            markConsolidated.run(plan.now, id, plan.tenantId);
          }

          // (f) Read the grown row back (same scoped statement) so the returned
          //     entry reflects the committed state.
          const grownRaw = selectObservationById.get(plan.targetObservationId, plan.tenantId);
          const parsedGrown = memoryRowMapper.parseOptionalRow(grownRaw);
          if (!parsedGrown.ok) throw new Error(parsedGrown.error.message);
          if (!parsedGrown.value) throw new Error("grown observation vanished post-fold");
          grown = rowToEntry(parsedGrown.value);
        });
        tx(); // throws → automatic ROLLBACK; nothing committed (no torn grow, no orphan mark)

        const durationMs = systemNowMs() - startMs;
        logger?.debug(
          {
            step: "consolidation-fold",
            durationMs,
            targetObservationId: plan.targetObservationId,
            newSourceCount: plan.newSourceIds.length,
            proofCount: grown?.proofCount,
          },
          "Consolidation fold applied (observation grown + new sources marked)",
        );
        // grown is always set on the COMMIT path (set in step (f) before tx() returns).
        return ok(grown!);
      } catch (e: unknown) {
        const durationMs = systemNowMs() - startMs;
        const error = e instanceof Error ? e : new Error(String(e));
        logger?.warn(
          {
            step: "consolidation-fold",
            durationMs,
            err: error,
            errorKind: "internal" as const,
            hint: "fold transaction failed — rolled back, no partial state",
          },
          "Consolidation fold failed",
        );
        return err(error);
      }
    },

    /**
     * READ (the surprisal-gate engine). The k nearest-neighbour
     * cosine DISTANCES for one embedding, returned sorted ascending (closer
     * first), or `ok([])` when sqlite-vec is unavailable (graceful degrade — the
     * caller's missing-embedding policy then applies). The `(agentId, tenantId)`
     * args are carried for parity + a future filtered variant (V4 access
     * control); the surprisal score is per-candidate, so the caller already holds
     * in-scope embeddings.
     *
     * Backed by the shipped sqlite-vec `searchByVector` (hybrid-search.ts:155) —
     * `SELECT memory_id, distance FROM vec_memories WHERE embedding MATCH ? AND
     * k = ?` with the embedding bound as a Float32Array `?` parameter (NEVER
     * concatenated). `searchByVector` returns rows sorted by
     * distance ASCENDING and degrades to `[]` on any row-validation error, so we
     * pass its distances straight through (the agent-side `surprisalSelect`
     * applies its own `(surprisal desc, id asc)` total order).
     *
     * ## Scope
     * The `vec_memories` virtual table is GLOBAL (no tenant/agent column on the
     * vec0 table), so this read is corpus-wide. That is by design: it returns
     * ONLY DISTANCES (floats), never ids or content — a non-identifying scalar
     * cannot leak another scope's memory body. The caller holds only
     * in-scope candidate embeddings and uses the distances for a per-candidate
     * novelty SCORE; no cross-scope content crosses the boundary. A future
     * filtered-vec variant (V4) can use the carried `(agentId, tenantId)` args
     * for hard access control.
     *
     * ## Result discipline
     * A pure read wrapped in try/catch → `err`; `isVecAvailable()` false → `ok([])`.
     * NEVER throws out — a corrupt vec table degrades the surprisal gate for that
     * candidate (the caller's run continues), it never crashes the reasoning job.
     */
    async knnDistances(
      embedding: number[],
      k: number,
      _agentId: string,
      _tenantId: string,
    ): Promise<Result<number[], Error>> {
      const startMs = systemNowMs();
      try {
        if (!isVecAvailable()) {
          logger?.debug(
            { step: "reason-knn", errorKind: "precondition" as const },
            "knnDistances: sqlite-vec unavailable — degrading to no neighbours",
          );
          return ok([]); // graceful degrade — no vec, no neighbours
        }
        // searchByVector returns {id, distance}[] sorted by distance ASCENDING
        // (hybrid-search.ts:153) and binds the embedding as a Float32Array `?`
        // (no string concat). We need only the distances for the surprisal score.
        const neighbours = searchByVector(db, embedding, k);
        logger?.debug(
          { step: "reason-knn", durationMs: systemNowMs() - startMs, count: neighbours.length },
          "knnDistances complete",
        );
        // Already sorted ascending — pass the distances through (counts-only log;
        // never the embedding values, §2.7).
        return ok(neighbours.map((n) => n.distance));
      } catch (e) {
        const error = e instanceof Error ? e : new Error(String(e));
        logger?.warn(
          {
            step: "reason-knn",
            durationMs: systemNowMs() - startMs,
            err: error,
            errorKind: "internal" as const,
            hint: "k-NN distance read failed — surprisal gate degrades to no neighbours",
          },
          "knnDistances failed",
        );
        return err(error);
      }
    },

    /**
     * Mark source memories `consolidated_at` WITHOUT creating an observation
     * (the deductive-only drain). Reuses the SAME scoped, fail-closed
     * `markConsolidated` UPDATE as the apply/fold paths (sets `consolidated_at`
     * only; never deletes), in ONE `db.transaction` so a partial mark
     * cannot commit. Scoped on `tenant_id` (a cross-tenant id is a no-op), the
     * value bound as a `?` parameter. Idempotent: re-marking an already-marked
     * source re-writes the same column (the candidate predicate
     * `consolidated_at IS NULL` already excludes it from re-selection). Returns
     * the number of rows actually changed.
     */
    async unlinkDeletedSources(
      _sessionKey: string,
      tenantId: string,
      agentId: string,
    ): Promise<Result<number, Error>> {
      // DIST-05: called AFTER the raw memories were deleted by
      // deleteBySessionKey, so the source rows are already gone. We re-scan each
      // in-scope observation's source_ids and treat any id no longer present in
      // `memories` (for this tenant+agent) as a deleted source. Orphan (every
      // source gone) → DELETE the observation; multi-source (some sources
      // survive) → KEEP with the reduced source_ids (unlink-only — never
      // over-delete).
      //
      // `_sessionKey` is part of the port signature for symmetry with the
      // --purge path + a future provenance-joined variant; the
      // delete-already-happened semantics mean the load-bearing predicate is
      // "source id absent from memories" — sessionKey-agnostic but
      // (tenant, agent)-SCOPED (WR-05: matches deleteBySessionKey's scope exactly,
      // fail-closed isolation), so the param is intentionally unused here.
      const startMs = systemNowMs();
      try {
        // The set of live memory ids for this tenant+agent — the membership oracle
        // for "still exists". Scoped on tenant_id AND agent_id (WR-05, fail-closed:
        // a cross-scope id is never in this set, so it can never be treated as
        // "surviving"). Typed read via the sanctioned mapper (untyped-sqlite).
        const liveIdsParsed = idProjectionMapper.parseRows(
          db.prepare("SELECT id FROM memories WHERE tenant_id = ? AND agent_id = ?").all(tenantId, agentId),
        );
        if (!liveIdsParsed.ok) return err(new Error(liveIdsParsed.error.message));
        const liveIds = new Set(liveIdsParsed.value.map((r) => r.id));

        // All observations (proof_count IS NOT NULL) in this tenant+agent carry the
        // source_ids array. Read the full rows through the existing memoryRowMapper
        // (SELECT *) so source_ids is parsed for us by rowToEntry (no new schema,
        // no manual JSON.parse). Scoped on tenant_id AND agent_id (WR-05) — mirrors
        // the agent-scoped selectObservations/selectCandidates in this file.
        const observationsParsed = memoryRowMapper.parseRows(
          db
            .prepare("SELECT * FROM memories WHERE proof_count IS NOT NULL AND tenant_id = ? AND agent_id = ?")
            .all(tenantId, agentId),
        );
        if (!observationsParsed.ok) return err(new Error(observationsParsed.error.message));
        const observations = observationsParsed.value.map((row) => rowToEntry(row));

        let orphansDeleted = 0;
        const deleteSingle = db.prepare("DELETE FROM memories WHERE id = ? AND tenant_id = ? AND agent_id = ?");
        const updateSourceIds = db.prepare(
          "UPDATE memories SET source_ids = ? WHERE id = ? AND tenant_id = ? AND agent_id = ?",
        );

        const tx = db.transaction(() => {
          for (const obs of observations) {
            const ids = obs.sourceIds ?? [];
            if (ids.length === 0) continue; // no sources to unlink
            const surviving = ids.filter((id) => liveIds.has(id));
            if (surviving.length === ids.length) continue; // no deleted sources — untouched
            if (surviving.length === 0) {
              // Orphan: every source gone → delete the observation.
              deleteSingle.run(obs.id, tenantId, agentId);
              orphansDeleted++;
            } else {
              // Multi-source: keep with reduced source_ids (unlink only).
              updateSourceIds.run(JSON.stringify(surviving), obs.id, tenantId, agentId);
            }
          }
          return orphansDeleted;
        });
        const deleted = tx();

        logger?.debug(
          { step: "consolidation-unlink", durationMs: systemNowMs() - startMs, orphansDeleted: deleted },
          "unlinkDeletedSources complete (orphans deleted, multi-source unlinked)",
        );
        return ok(deleted);
      } catch (e: unknown) {
        const error = e instanceof Error ? e : new Error(String(e));
        logger?.warn(
          {
            step: "consolidation-unlink",
            durationMs: systemNowMs() - startMs,
            err: error,
            errorKind: "internal" as const,
            hint: "unlinkDeletedSources transaction failed — rolled back; consolidated observations may still reference deleted sources",
          },
          "unlinkDeletedSources failed",
        );
        return err(error);
      }
    },

    async purgeConsolidatedDerivedFrom(
      sessionKey: string,
      tenantId: string,
      agentId: string,
      thisSessionIds: string[],
    ): Promise<Result<number, Error>> {
      // DIST-05 nuclear escalation: delete EVERY observation derived from THIS
      // session's deleted memory ids. Called via the opt-in --purge-derived flag
      // ONLY. Runs AFTER the raw memories were deleted, but the purge oracle is
      // the explicit `thisSessionIds` set (captured BEFORE the delete via
      // MemoryPort.listMemoryIdsBySessionKey), NOT "any source id now absent".
      //
      // WR-02 (session-scoped, not coarse): an observation is purged ONLY if its
      // source_ids INTERSECT thisSessionIds. A prior unrelated dangling source id
      // in an UNRELATED observation (from an earlier admin delete / TTL / another
      // session's purge) is left alone — the bug the "any absent id" oracle had.
      // It still nukes a multi-source observation when one of its sources WAS a
      // this-session id (nuclear regardless of surviving corroboration).
      //
      // WR-05: scoped on tenant_id AND agent_id (matches deleteBySessionKey).
      // `sessionKey` is retained for the audit log. An empty thisSessionIds set
      // purges nothing (fast-path).
      const startMs = systemNowMs();
      try {
        if (thisSessionIds.length === 0) {
          logger?.debug(
            { step: "consolidation-purge-derived", durationMs: systemNowMs() - startMs, observationsDeleted: 0, sessionKey },
            "purgeConsolidatedDerivedFrom: no this-session ids — nothing to purge",
          );
          return ok(0);
        }
        const sessionIdSet = new Set(thisSessionIds);

        const observationsParsed = memoryRowMapper.parseRows(
          db
            .prepare("SELECT * FROM memories WHERE proof_count IS NOT NULL AND tenant_id = ? AND agent_id = ?")
            .all(tenantId, agentId),
        );
        if (!observationsParsed.ok) return err(new Error(observationsParsed.error.message));
        const observations = observationsParsed.value.map((row) => rowToEntry(row));

        let deletedCount = 0;
        const deleteObs = db.prepare("DELETE FROM memories WHERE id = ? AND tenant_id = ? AND agent_id = ?");

        const tx = db.transaction(() => {
          for (const obs of observations) {
            const ids = obs.sourceIds ?? [];
            if (ids.length === 0) continue;
            // Purge ONLY when a source id was one of THIS session's deleted ids
            // (source_ids ∩ thisSessionIds ≠ ∅) — nuclear regardless of surviving
            // corroboration, but session-scoped (WR-02): unrelated observations
            // with a prior dangling id are untouched.
            const derivedFromThisSession = ids.some((id) => sessionIdSet.has(id));
            if (derivedFromThisSession) {
              deleteObs.run(obs.id, tenantId, agentId);
              deletedCount++;
            }
          }
          return deletedCount;
        });
        const deleted = tx();

        logger?.debug(
          {
            step: "consolidation-purge-derived",
            durationMs: systemNowMs() - startMs,
            observationsDeleted: deleted,
            sessionKey,
          },
          "purgeConsolidatedDerivedFrom complete (derived observations purged)",
        );
        return ok(deleted);
      } catch (e: unknown) {
        const error = e instanceof Error ? e : new Error(String(e));
        logger?.warn(
          {
            step: "consolidation-purge-derived",
            durationMs: systemNowMs() - startMs,
            err: error,
            errorKind: "internal" as const,
            hint: "purgeConsolidatedDerivedFrom transaction failed — rolled back; no observations purged",
          },
          "purgeConsolidatedDerivedFrom failed",
        );
        return err(error);
      }
    },

    async markReasoned(
      sourceIds: string[],
      tenantId: string,
      now: number,
    ): Promise<Result<number, Error>> {
      const startMs = systemNowMs();
      try {
        const tx = db.transaction(() => {
          let changed = 0;
          for (const id of sourceIds) {
            // Scoped on (tenant_id) — a cross-tenant id is a fail-closed no-op
            // (changes === 0). NON-DESTRUCTIVE: sets consolidated_at only.
            changed += markConsolidated.run(now, id, tenantId).changes;
          }
          return changed;
        });
        const changed = tx();

        logger?.debug(
          { step: "reason-mark", durationMs: systemNowMs() - startMs, markedCount: changed },
          "markReasoned complete (deductive-only sources marked consolidated)",
        );
        return ok(changed);
      } catch (e: unknown) {
        const error = e instanceof Error ? e : new Error(String(e));
        logger?.warn(
          {
            step: "reason-mark",
            durationMs: systemNowMs() - startMs,
            err: error,
            errorKind: "internal" as const,
            hint: "markReasoned transaction failed — rolled back, sources stay unconsolidated for retry next run",
          },
          "markReasoned failed",
        );
        return err(error);
      }
    },
  };
}
