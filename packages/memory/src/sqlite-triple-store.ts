// SPDX-License-Identifier: Apache-2.0
// @allow-throw: upsertTriple's trust-first invalidation runs the SELECT-incumbent → soft-close-loser → INSERT-new unit inside a better-sqlite3 `db.transaction(() => {...})()` callback, where a throw is the ONLY way to trigger the atomic ROLLBACK — returning a Result.err from the callback would COMMIT a torn supersession (an orphan close, or a double current-truth). The incumbent-row parse guard (`throw new Error(parsed.error.message)`) and any in-transaction fault are caught by the method's outer try/catch and converted to `err` (the tests prove "never throws"); consumed by the offline triple-extraction writer (the @allow-throw boundary), which treats the err as a non-fatal skipped write.
/**
 * SqliteTripleStore: the SOLE adapter for the segregated `TripleStorePort`
 * (@comis/core). It owns ALL the
 * knowledge-graph triple SQL over the additive `memory_triples` table.
 *
 * ## Method status
 *
 * - `upsertTriple` does TRUST-FIRST single-current-truth invalidation
 *   in ONE `db.transaction`: it SELECTs the current-truth
 *   incumbent on (tenant, agent, subject, predicate) WHERE `t_valid_end IS NULL`,
 *   then resolves a contradiction (same s+p, DIFFERENT object) on the HARD trust
 *   ladder (`system` > `learned` > `external`) — the higher-trust row stays
 *   current REGARDLESS of recency; equal trust tiebreaks by recency (newer
 *   `t_occurred`|`t_ingested` wins); the LOSER is SOFT-CLOSED (`t_valid_end` +
 *   `expired_at` set), NEVER deleted. Same object is idempotent corroboration (no
 *   new history row). Non-overlapping occurred intervals coexist (the
 *   interval-overlap guard).
 * - `asOf(t, scope, mode)` is the bi-temporal as-of read:
 *   `"valid"` (default) queries the VALID-time window (`t_valid_start <= t AND
 *   (t_valid_end IS NULL OR t_valid_end > t)` — "what was BELIEVED true at t");
 *   `"txn"` queries the TXN/record-time window (`t_ingested <= t AND (expired_at
 *   IS NULL OR expired_at > t)` — "what the system had RECORDED as of t"). The
 *   two modes index DIFFERENT column pairs, so a back-dated or future-valid fact
 *   appears in one but not the other at a chosen `t`. Both scoped.
 * - `currentTruth(scope, cap)` is the DEFAULT-RECALL read:
 *   only `t_valid_end IS NULL` rows — superseded losers and recorded-but-not-
 *   believed rows are DEFAULT-FILTERED out (the stale-fact leak fix). As-of
 *   history is reachable only via an explicit `asOf(t)`. Scoped, capped.
 * - `spreadLane(seedSubjects, scope, maxDepth, fanOut, cap)` is the read-side
 *   graph-spread lane: a bounded `WITH RECURSIVE walk`
 *   over current-truth `subject → object` edges from the seed subjects. The
 *   recursive arm is scoped on `(tenant_id, agent_id)` AND filtered on
 *   `t_valid_end IS NULL` (scope + current-truth ON THE RECURSIVE STEP, not just
 *   the base case), depth-capped (`walk.depth < maxDepth`) and per-node fan-out-
 *   capped (top-F current-truth out-edges by trust then recency). Reached nodes
 *   hydrate back to their source `memories` rows (scoped) as
 *   `MemorySearchResult[]` scored `1/(1+depth)` with IDF seed-damping — LLM-free,
 *   O(bounded), so it fuses directly into the agent's weighted RRF.
 *
 * It shares the `better-sqlite3` handle of the `SqliteMemoryAdapter` (passed in
 * via `getDb()`), so it runs against the same schema with `PRAGMA foreign_keys =
 * ON` already set — that pragma is what makes the `source_memory_id ->
 * memories(id)` `ON DELETE CASCADE` fire (deleting a source memory drops its
 * derived triples; no orphan-sweep job).
 *
 * ## Isolation is the load-bearing security boundary
 *
 * Comis runs many agents in one DB. BOTH the write (the INSERT) and the read
 * (`asOf`, and the `spreadLane` CTE) filter on `(tenant_id, agent_id)` —
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
import type { TripleStorePort, TripleScope, TripleInput, MemorySearchResult } from "@comis/core";
import { systemNowMs } from "@comis/core";
import { ok, err, type Result } from "@comis/shared";
import { createRowMapper, rowToEntry } from "./row-mapper.js";
import { MemoryTripleRowSchema, MemoryRowSchema, SpreadNodeRowSchema } from "./row-schemas.js";

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
// Graph-spread read mappers: the recursive-CTE node projection
// (node + depth) and the full `memories` row hydrate (→ rowToEntry). Both
// parse via createRowMapper (no `as Foo[]`).
const spreadNodeRowMapper = createRowMapper(SpreadNodeRowSchema);
const memoryRowMapper = createRowMapper(MemoryRowSchema);

/**
 * Default per-node fan-out cap for the graph-spread walk — bounds each node's
 * expansion to its top-F current-truth out-edges (by trust then recency) so a
 * dense hub cannot blow the recursive frontier. The caller passes
 * an explicit `fanOut` (the lane config default is 8).
 */
const DEFAULT_SPREAD_FANOUT = 8;

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
 * The Comis trust ladder as a HARD ordinal for the invalidation comparison.
 * Trust is a HARD BRANCH here — the higher-trust row stays current
 * REGARDLESS of recency — NOT a soft score multiplier (that is `score.ts`'s job
 * on the read path). An `external`-trust claim can therefore NEVER supersede a
 * `system`/`learned` current-truth (the anti-poisoning control; the security
 * suite probes exactly this). `system` (2) > `learned` (1) > `external` (0).
 */
const TRUST_RANK: Record<"system" | "learned" | "external", number> = {
  system: 2,
  learned: 1,
  external: 0,
};

/**
 * Default cap for {@link createSqliteTripleStore}'s `currentTruth` read — a sane
 * bound so a default-recall current-truth scan can never return an unbounded row
 * set. Callers pass an explicit `cap` to override.
 */
const DEFAULT_CURRENT_TRUTH_CAP = 256;

/**
 * Two occurred windows OVERLAP iff each starts on/before the other ends
 * (half-open-friendly inclusive test). Only meaningful when BOTH rows carry a
 * full `[t_occurred .. t_occurred_end]` range — the interval-overlap
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
  // INSERT-ONLY current-truth write. t_valid_end +
  // expired_at are NULL (currently believed / live record); t_ingested =
  // scope.now (injected clock, NEVER Date.now()). Bound params only.
  const insertTriple = db.prepare(
    "INSERT INTO memory_triples " +
      "(id, tenant_id, agent_id, subject, predicate, object, trust, " +
      "t_valid_start, t_valid_end, t_ingested, expired_at, t_occurred, t_occurred_end, " +
      "source_memory_id, confidence) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL, ?, ?, ?, ?)",
  );
  // Loser-path INSERT: the new row is written ALREADY-CLOSED
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
  // load-bearing ISOLATION boundary: a contradiction in one scope
  // can NEVER read/close a row in another. Bound params only.
  const selectIncumbent = db.prepare(
    "SELECT * FROM memory_triples " +
      "WHERE tenant_id = ? AND agent_id = ? AND subject = ? AND predicate = ? " +
      "AND t_valid_end IS NULL",
  );
  // Soft-close the LOSER: set `t_valid_end` + `expired_at`
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
  // Valid-time as-of read, scoped. The `tenant_id = ? AND agent_id = ?`
  // is the load-bearing ISOLATION boundary. Bound params only.
  // "What was BELIEVED true at t" — indexes the VALID-time window.
  const asOfSelect = db.prepare(
    "SELECT * FROM memory_triples " +
      "WHERE tenant_id = ? AND agent_id = ? " +
      "AND t_valid_start <= ? AND (t_valid_end IS NULL OR t_valid_end > ?)",
  );
  // Txn/record-time as-of read, scoped. SAME shape over the OTHER
  // bi-temporal axis — "what the system had RECORDED as of t": the record window
  // `t_ingested <= t AND (expired_at IS NULL OR expired_at > t)`. Querying a
  // DIFFERENT column pair than asOfSelect is the whole point of the txn variant
  // (a back-dated / future-valid fact diverges between the two at a chosen t).
  // (tenant, agent) scoped; bound params only.
  const asOfTxnSelect = db.prepare(
    "SELECT * FROM memory_triples " +
      "WHERE tenant_id = ? AND agent_id = ? " +
      "AND t_ingested <= ? AND (expired_at IS NULL OR expired_at > ?)",
  );
  // Default-recall current-truth read (the stale-fact leak fix).
  // ONLY `t_valid_end IS NULL` rows are believed NOW: superseded losers (soft-
  // closed) and recorded-but-not-believed rows (inserted already-closed by the
  // invalidation write path) are DEFAULT-FILTERED out. Newest-valid first, capped.
  // (tenant, agent) scoped; bound params only (the cap is a bound `?`).
  const currentTruthSelect = db.prepare(
    "SELECT * FROM memory_triples " +
      "WHERE tenant_id = ? AND agent_id = ? AND t_valid_end IS NULL " +
      "ORDER BY t_valid_start DESC LIMIT ?",
  );
  // Graph-spread hydrate: resolve a reached node (a triple `object`) →
  // its source memory row. Pick the highest-trust, most-recent current-truth
  // triple whose `object` is the node AND that carries a source_memory_id, then
  // join `memories` re-asserting the FULL (tenant, agent) scope (self-sufficient
  // hydrate — no fail-open if the CTE is ever refactored). Bound params only.
  // The ALWAYS-ON `evicted_at IS NULL` recall exclusion (`m.` alias —
  // `memories` is joined as `m`). This is the RECALL-side hydration (graph-spread →
  // MemorySearchResult[] → createMemoryRecall → the prompt), so a soft-evicted reached-node
  // source memory MUST be omitted here. The bi-temporal asOf reads (asOfSelect /
  // asOfTxnSelect over memory_triples) are UNRELATED (triples, not memories) and stay as-is;
  // the inspect/asOf raw memory reads stay UNFILTERED (eviction soft + asOf-resolvable).
  const hydrateSpreadNode = db.prepare(
    "SELECT m.* FROM memories m " +
      "JOIN memory_triples t ON t.source_memory_id = m.id " +
      "WHERE t.tenant_id = ? AND t.agent_id = ? AND t.object = ? AND t.t_valid_end IS NULL " +
      "AND m.tenant_id = ? AND m.agent_id = ? AND m.evicted_at IS NULL " +
      "ORDER BY t.trust DESC, t.t_ingested DESC LIMIT 1",
  );
  // IDF seed-damp helper (HippoRAG): a seed's current-truth out-edge
  // count — the spread weight is divided by this so a hub seed (many edges)
  // damps its neighbours vs a sparse seed. Scoped + current-truth; bound params.
  const seedOutEdgeCount = db.prepare(
    "SELECT COUNT(*) AS c FROM memory_triples " +
      "WHERE tenant_id = ? AND agent_id = ? AND subject = ? AND t_valid_end IS NULL",
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

        // Trust-first single-current-truth invalidation — ONE
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
          // Interval-overlap guard: when BOTH rows carry a FULL
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
            // A newer LOW-trust claim NEVER supersedes a higher-trust fact.
            // Record it (closed) so the conflict is retained +
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
      mode: "valid" | "txn" = "valid",
    ): Promise<Result<TripleInput[], Error>> {
      const startMs = systemNowMs();
      const { tenantId, agentId } = scope;
      try {
        // Branch the temporal axis on `mode` — the two prepared statements query
        // DIFFERENT column pairs (valid-time t_valid_start/t_valid_end vs
        // record-time t_ingested/expired_at). Both (tenant, agent) scoped (the
        // load-bearing isolation filter); `t` is a bound `?` param.
        const stmt = mode === "txn" ? asOfTxnSelect : asOfSelect;
        const rows = stmt.all(tenantId, agentId, t, t);
        const parsed = tripleRowMapper.parseRows(rows);
        if (!parsed.ok) return err(new Error(parsed.error.message));

        const results = parsed.value.map(rowToTripleInput);

        const durationMs = systemNowMs() - startMs;
        logger?.debug(
          { step: "triple-asof", mode, count: results.length, durationMs },
          "Triple asOf complete",
        );
        return ok(results);
      } catch (e: unknown) {
        const durationMs = systemNowMs() - startMs;
        const error = e instanceof Error ? e : new Error(String(e));
        logger?.warn(
          {
            step: "triple-asof",
            mode,
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

    async currentTruth(
      scope: Omit<TripleScope, "now">,
      cap: number = DEFAULT_CURRENT_TRUTH_CAP,
    ): Promise<Result<TripleInput[], Error>> {
      const startMs = systemNowMs();
      const { tenantId, agentId } = scope;
      try {
        // The DEFAULT-RECALL read: only `t_valid_end IS NULL` rows (believed
        // NOW) — superseded losers + recorded-but-not-believed rows are
        // default-filtered out (the stale-fact leak fix). Scoped + capped;
        // both the (tenant, agent) filter and the cap are bound `?` params.
        const rows = currentTruthSelect.all(tenantId, agentId, cap);
        const parsed = tripleRowMapper.parseRows(rows);
        if (!parsed.ok) return err(new Error(parsed.error.message));

        const results = parsed.value.map(rowToTripleInput);

        const durationMs = systemNowMs() - startMs;
        logger?.debug(
          { step: "triple-current-truth", count: results.length, cap, durationMs },
          "Triple currentTruth complete",
        );
        return ok(results);
      } catch (e: unknown) {
        const durationMs = systemNowMs() - startMs;
        const error = e instanceof Error ? e : new Error(String(e));
        logger?.warn(
          {
            step: "triple-current-truth",
            durationMs,
            err: error,
            errorKind: "internal" as const,
            hint: "triple currentTruth query failed — normal recall current-truth read unavailable",
          },
          "Triple currentTruth failed",
        );
        return err(error);
      }
    },

    async spreadLane(
      seedSubjects: string[],
      scope: Omit<TripleScope, "now">,
      maxDepth: number,
      fanOut: number = DEFAULT_SPREAD_FANOUT,
      cap: number,
    ): Promise<Result<MemorySearchResult[], Error>> {
      const startMs = systemNowMs();
      const { tenantId, agentId } = scope;
      try {
        // No seeds -> empty lane (no query). RRF unchanged.
        if (seedSubjects.length === 0) {
          logger?.debug(
            { step: "triple-spread", seedCount: 0, reachedCount: 0, durationMs: 0 },
            "Triple spreadLane skipped (no seeds)",
          );
          return ok([]);
        }

        // The bounded recursive-CTE neighbourhood walk (RESEARCH §Graph-spread
        // lane — VERIFIED in better-sqlite3 12.9.0). Seeds bound as ONE JSON
        // array `?` to json_each (NEVER concatenated). The
        // RECURSIVE arm's WHERE carries the (tenant, agent) scope + the
        // current-truth filter (t_valid_end IS NULL) + the depth cap — the scope
        // is on the RECURSIVE JOIN, not just the base case (the
        // easy one to forget). The FAN-OUT cap is a correlated
        // subquery in the recursive arm bounding each node to its top-F
        // current-truth out-edges (trust DESC, then recency) so a dense hub
        // cannot blow the frontier. Final `WHERE depth > 0 LIMIT ?` bounds the
        // returned node count. All five `?` are bound params (no string SQL).
        const walkSql =
          "WITH RECURSIVE walk(node, depth) AS (" +
          "  SELECT value AS node, 0 AS depth FROM json_each(?)" +
          "  UNION" +
          "  SELECT t.object, walk.depth + 1" +
          "    FROM memory_triples t" +
          "    JOIN walk ON t.subject = walk.node" +
          "   WHERE t.tenant_id = ? AND t.agent_id = ?" +
          "     AND t.t_valid_end IS NULL" +
          "     AND walk.depth < ?" +
          "     AND t.id IN (" +
          "       SELECT t2.id FROM memory_triples t2" +
          "        WHERE t2.subject = walk.node" +
          "          AND t2.tenant_id = ? AND t2.agent_id = ?" +
          "          AND t2.t_valid_end IS NULL" +
          "        ORDER BY t2.trust DESC, t2.t_ingested DESC" +
          "        LIMIT ?" +
          "     )" +
          ") SELECT DISTINCT node, depth FROM walk WHERE depth > 0 ORDER BY depth ASC LIMIT ?";
        const nodeRows = db
          .prepare(walkSql)
          .all(JSON.stringify(seedSubjects), tenantId, agentId, maxDepth, tenantId, agentId, fanOut, cap);

        const parsedNodes = spreadNodeRowMapper.parseRows(nodeRows);
        if (!parsedNodes.ok) return err(new Error(parsedNodes.error.message));

        // Keep the SHALLOWEST depth per node (a node reachable at depth 1 and 2
        // surfaces once, at depth 1 — its strongest 1/(1+depth) score).
        const depthByNode = new Map<string, number>();
        for (const { node, depth } of parsedNodes.value) {
          const prior = depthByNode.get(node);
          if (prior === undefined || depth < prior) depthByNode.set(node, depth);
        }

        // IDF seed-damp factor (HippoRAG): the average seed's current-truth
        // out-edge count, used to divide the spread weight so a dense-seed walk
        // damps its neighbours. Scoped + current-truth; >=1 to avoid /0.
        let seedEdgeTotal = 0;
        for (const seed of seedSubjects) {
          const raw = seedOutEdgeCount.get(tenantId, agentId, seed) as { c: number } | undefined;
          seedEdgeTotal += raw?.c ?? 0;
        }
        const idfDamp = Math.max(1, seedEdgeTotal / seedSubjects.length);

        // Hydrate each reached node → its source memory (scoped), score
        // 1/(1+depth) IDF-damped. A node whose triples carry no source_memory_id
        // (or whose memory is gone) is skipped (defensive hydrate miss).
        const scored: Array<{ result: MemorySearchResult; score: number }> = [];
        for (const [node, depth] of depthByNode) {
          const memParsed = memoryRowMapper.parseOptionalRow(
            hydrateSpreadNode.get(tenantId, agentId, node, tenantId, agentId),
          );
          if (!memParsed.ok) return err(new Error(memParsed.error.message));
          const row = memParsed.value;
          if (!row) continue; // no in-scope source memory for this node -> skip
          const score = 1 / (1 + depth) / idfDamp;
          scored.push({ result: { entry: rowToEntry(row), score }, score });
        }

        // Sort score-desc; deterministic id tie-break (stable order for equal
        // depth). Then bound by cap (the node walk already LIMIT-capped, but the
        // hydrate could fan a node to one memory — keep the cap defensive).
        scored.sort((a, b) => {
          if (a.score !== b.score) return b.score - a.score;
          return a.result.entry.id.localeCompare(b.result.entry.id);
        });
        const results = scored.slice(0, cap).map((s) => s.result);

        const durationMs = systemNowMs() - startMs;
        logger?.debug(
          { step: "triple-spread", seedCount: seedSubjects.length, reachedCount: results.length, durationMs },
          "Triple spreadLane complete",
        );
        return ok(results);
      } catch (e: unknown) {
        const durationMs = systemNowMs() - startMs;
        const error = e instanceof Error ? e : new Error(String(e));
        logger?.warn(
          {
            step: "triple-spread",
            durationMs,
            err: error,
            errorKind: "internal" as const,
            hint: "triple spreadLane CTE failed — graph-spread lane unavailable",
          },
          "Triple spreadLane failed",
        );
        return err(error);
      }
    },
  };
}
