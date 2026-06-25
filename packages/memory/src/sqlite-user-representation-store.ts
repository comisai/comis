// SPDX-License-Identifier: Apache-2.0
// @allow-throw: revise()'s trust-first revision runs the SELECT-incumbent → soft-close-loser → INSERT-new unit inside a better-sqlite3 `db.transaction(() => {...})()` callback, where a throw is the ONLY way to trigger the atomic ROLLBACK — returning a Result.err from the callback would COMMIT a torn supersession (an orphan close, or a double current-truth). The incumbent-row parse guard (`throw new Error(parsed.error.message)`) and any in-transaction fault are caught by the method's outer try/catch and converted to `err` (the tests prove "never throws"); consumed by the offline profile builder (the @allow-throw boundary), which treats the err as a non-fatal skipped write — exactly the sqlite-triple-store.ts upsertTriple boundary.
/**
 * SqliteUserRepresentationStore: the SOLE adapter for the segregated
 * `UserRepresentationStore` port (@comis/core).
 * It owns ALL the per-user-representation SQL over the additive
 * `user_representation` table — the only place SQL is written for this capability.
 *
 * ## Method status
 *
 * - `upsert(entry, scope)` writes one PREFIX-TYPED, HIGH-TRUST representation
 *   entry under the caller's (tenant, agent, user) scope. Layer 3 of the 3-layer
 *   anti-poisoning defense: it REJECTS a below-floor `trust` at the write boundary
 *   (returns `err` — never stores it at a reduced weight), BEFORE the INSERT, as
 *   defense-in-depth with the DB `CHECK(trust IN ('system','learned'))` (layer 1)
 *   and the port-type floor (layer 2). `content` is untrusted profile
 *   text — it runs through `validateMemoryWrite` (redaction firewall) and is bound
 *   as a `?` parameter, never concatenated. The row id is a `randomUUID()`
 *   (imported from `node:crypto`, mirror the triple store); `created_at` is the
 *   injected clock `scope.now`, NEVER `Date.now()`. The INSERT now also stamps
 *   `t_valid_start = now` (bi-temporal current-truth) so an upsert-written row is
 *   asOf-resolvable on the valid-time axis.
 * - `read(scope, cap)` is the LLM-free profile read: the CURRENT-TRUTH entries
 *   (`t_valid_end IS NULL`) for the caller's (tenant, agent, user) scope ONLY,
 *   capped. This is the deterministic read the prompt-assembly injection block
 *   consumes with NO model call. v2.26 WS5 Pitfall 1: the `AND t_valid_end IS NULL`
 *   filter is REQUIRED so a superseded belief never leaks into the recall prompt —
 *   superseded history is reachable ONLY via the explicit `asOf(t)` read.
 *   Returns an empty array when the user has no profile (the default-OFF no-op).
 * - `revise(entry, scope)` (v2.26 WS5 REVISE-01) does TRUST-FIRST bi-temporal
 *   supersession in ONE `db.transaction` — MIRRORING (not importing) the triple
 *   store's `upsertTriple`: it SELECTs the current-truth incumbent for
 *   (tenant, agent, user, entry_type) WHERE `t_valid_end IS NULL`; a same-belief
 *   candidate (normalized-equal or bigram-Dice ≥ threshold content) bumps the
 *   incumbent's `confidence` IN PLACE (no new row); a higher/equal-trust
 *   contradiction SOFT-CLOSES the incumbent (sets `t_valid_end` + `expired_at`,
 *   NEVER deletes) and inserts `entry` as current-truth; a LOWER-trust
 *   contradiction is recorded-not-believed (anti-poison — the incumbent stays).
 *   The same high-trust floor + `validateMemoryWrite` boundary as `upsert` run
 *   FIRST (REVISE-03 — external/below-floor/dirty rejected BEFORE the txn). After
 *   a supersession, per-record history is BOUNDED: closed rows beyond `historyCap`
 *   for the slot are trimmed oldest-`expired_at`-first (the ONE allowed DELETE).
 * - `asOf(t, scope, mode)` (v2.26 WS5 REVISE-02) is the bi-temporal as-of read,
 *   mirroring the triple store: `"valid"` (default) queries the VALID-time window
 *   (`t_valid_start <= t AND (t_valid_end IS NULL OR t_valid_end > t)` — "what was
 *   BELIEVED at t"); `"txn"` queries the record-time window (`created_at <= t AND
 *   (expired_at IS NULL OR expired_at > t)` — "what the system had RECORDED as of
 *   t"; `created_at` is the record-time anchor for user_representation). Both
 *   scoped. Superseded history is reachable ONLY here.
 *
 * It shares the `better-sqlite3` handle of the `SqliteMemoryAdapter` (passed in
 * via `getDb()`), so it runs against the same schema with `PRAGMA foreign_keys =
 * ON` already set — that pragma is what makes the `source_memory_id ->
 * memories(id)` `ON DELETE CASCADE` fire.
 *
 * ## Provenance / retirement caveat
 *
 * The `ON DELETE CASCADE` ONLY retires rows that carry a non-NULL
 * `source_memory_id` — i.e. the single-source write path. The PRIMARY producer,
 * the offline profile builder (`runUserRepresentationBuild`), DELIBERATELY omits
 * `sourceMemoryId` (a profile fact is distilled from the FUSED high-trust source
 * set, not one message — single-id provenance would be misleading), so its rows
 * have `source_memory_id = NULL` and the CASCADE NEVER fires for them. Those rows
 * are retired by revision (soft-close) + bounded-history trim instead.
 *
 * ## Isolation is the load-bearing security boundary (the §5.2 isolation
 *    pattern, EXTENDED with `user_id`)
 *
 * Comis runs many agents and many users in one DB. EVERY statement — the INSERT,
 * the scoped SELECT, the supersession incumbent SELECT, the soft-close UPDATE, the
 * confidence bump, the bounded-history trim DELETE, and the asOf read — filters on
 * `(tenant_id, agent_id, user_id)` (parameterized), so a representation entry
 * written under one (tenant, agent, user) is NEVER returned/closed/trimmed for
 * another scope by content coincidence. An UNRESOLVED scope (empty tenant/agent/
 * user) RAISES into an err (fail-closed — never widens to a shared pool).
 *
 * ## Untrusted input
 *
 * `content` derives from conversation content. It is DATA, never SQL — every value
 * reaching SQL is a bound `?` parameter, never concatenated. Every read parses
 * through `createRowMapper` (no `as Foo[]` casts; `untyped-sqlite.test.ts`). The
 * adapter logs counts/metadata only — NEVER the `content` body (AGENTS.md §2.7).
 *
 * @module
 */

import type Database from "better-sqlite3";
import type {
  UserRepresentationStore,
  UserRepresentationScope,
  UserRepresentationInput,
  UserRepresentationEntry,
  ReviseOutcome,
} from "@comis/core";
import { randomUUID } from "node:crypto";
import { systemNowMs, validateMemoryWrite } from "@comis/core";
import { ok, err, type Result } from "@comis/shared";
import { createRowMapper } from "./row-mapper.js";
import { UserRepresentationRowSchema } from "./row-schemas.js";

/** Minimal pino-compatible logger (mirrors sqlite-triple-store.ts). */
interface MemoryLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  debug(obj: Record<string, unknown>, msg: string): void;
}

/** Constructor deps for {@link createSqliteUserRepresentationStore}. */
export interface MemoryUserRepresentationStoreDeps {
  /** The shared better-sqlite3 handle (typically `SqliteMemoryAdapter.getDb()`). */
  db: Database.Database;
  /** Optional structured logger. */
  logger?: MemoryLogger;
  /**
   * v2.26 WS5 REVISE-02 (Pitfall 2): the bounded per-record asOf history cap. After
   * a supersession soft-closes an incumbent, closed rows for the
   * (tenant, agent, user, entry_type) slot BEYOND this many are trimmed
   * oldest-`expired_at`-first — the ONE sanctioned DELETE (ancient superseded
   * history only, never current truth). The daemon passes the
   * `agents.<id>.memoryUserRepresentation.historyCap` config value (default 10).
   */
  historyCap?: number;
}

// Row mapper — the sanctioned read path (no `as Foo[]`). Parses the scoped-read
// projection AND the supersession incumbent SELECT * into the typed snake_case row
// before the camelCase map.
const reprRowMapper = createRowMapper(UserRepresentationRowSchema);

/**
 * Default cap for {@link createSqliteUserRepresentationStore}'s `read` — a sane
 * bound so a profile read can never return an unbounded row set. Callers pass an
 * explicit `cap` to override (mirror the triple store's DEFAULT_CURRENT_TRUTH_CAP).
 */
const DEFAULT_READ_CAP = 256;

/**
 * Default bounded per-record asOf history (REVISE-02 Pitfall 2). Mirrors the
 * Plan-01 `historyCap` config default; the daemon passes the configured value.
 */
const DEFAULT_HISTORY_CAP = 10;

/**
 * The seed confidence a NEW current-truth row is inserted with, and the base a
 * corroboration bump strictly raises. A same-belief candidate sets
 * `confidence = min(1, (incumbent.confidence ?? SEED) + STEP)` — a documented
 * monotonic increase, capped at 1.0. The WS5 first-RED corroboration half asserts
 * this bump is OBSERVABLE (strictly greater than the seed).
 */
const SEED_CONFIDENCE = 0.5;
const CONFIDENCE_BUMP_STEP = 0.1;

/**
 * The Comis trust ladder as a HARD ordinal for the revision comparison — MIRRORED
 * from sqlite-triple-store.ts:129 (NOT imported). For user_representation the
 * ladder collapses to `{ system: 2, learned: 1 }` — `external` is STRUCTURALLY
 * ABSENT (REVISE-03: the DB CHECK + the adapter floor reject keep it out). Trust is
 * a HARD BRANCH: a higher-trust incumbent stays current REGARDLESS of recency; a
 * lower-trust contradiction can NEVER supersede it (the anti-poisoning control).
 */
const TRUST_RANK: Record<"system" | "learned", number> = {
  system: 2,
  learned: 1,
};

/**
 * The decided branch of a `revise` transaction, logged as metadata (never the
 * content body) AND returned to the caller (the single source of truth for the
 * offline builder's revision telemetry — REVISE-01/OBS-01). `inserted` = no
 * incumbent (or a topic-distinct coexist); `corroborated` = same belief (confidence
 * bumped in place, no new row); `superseded` = a higher/equal-trust contradiction
 * soft-closed the incumbent; `recorded-not-believed` = a lower-trust contradiction
 * was rejected (the incumbent stays current). The canonical type is owned by the
 * @comis/core port (`ReviseOutcome`) so the agent counts EXACTLY this — mirrored
 * here only as the in-adapter alias.
 */
type ReviseOutcomeLocal = ReviseOutcome;

/**
 * Normalize a belief content for the same-slot comparison: trim + collapse inner
 * whitespace + lowercase. LOCAL pure helper — deliberately NOT the @comis/agent
 * clustering `contentSimilarity` (the agent↛memory package boundary stays clean;
 * the richer same-slot classification across the whole profile is the JOB's job).
 */
function normalizeBelief(s: string): string {
  return s.trim().replace(/\s+/g, " ").toLowerCase();
}

/** Character bigram set of a normalized string (for the Dice near-paraphrase test). */
function bigrams(s: string): Set<string> {
  const grams = new Set<string>();
  for (let i = 0; i < s.length - 1; i++) grams.add(s.slice(i, i + 2));
  return grams;
}

/**
 * Sørensen–Dice coefficient over character bigrams, symmetric, [0,1], no-NaN
 * guarded. A LOCAL pure helper (mirrors the discipline of the agent-side
 * `contentSimilarity` without importing it).
 */
function bigramDice(a: string, b: string): number {
  if (a === b) return 1;
  const aGrams = bigrams(a);
  const bGrams = bigrams(b);
  const total = aGrams.size + bGrams.size;
  if (total === 0) return a === b ? 1 : 0;
  let overlap = 0;
  for (const g of aGrams) if (bGrams.has(g)) overlap++;
  return (2 * overlap) / total;
}

/**
 * The contradiction-vs-corroboration-vs-coexist decision — THE one genuine design
 * call of this plan (RESEARCH Pitfall 4). For a SAME-`entry_type` candidate vs the
 * incumbent, the normalized character bigram-Dice partitions into THREE bands:
 *
 *   Dice ≥ SAME_BELIEF_DICE (0.9)  → CORROBORATE  (near-restatement: same belief,
 *                                    bump confidence in place; no new row)
 *   SAME_SLOT_DICE (0.5) ≤ Dice    → CONTRADICT   (same topic / belief slot, a
 *      < SAME_BELIEF_DICE             DIFFERENT value: "prefers coffee" vs "prefers
 *                                     tea" — trust-first supersede the incumbent)
 *   Dice < SAME_SLOT_DICE (0.5)    → COEXIST       (topic-distinct same-type fact:
 *                                     "enjoys hiking" vs "drinks espresso" — INSERT
 *                                     as an additional current-truth, never collapse)
 *
 * The high corroborate floor (0.9) means only a near-restatement bumps confidence;
 * the slot floor (0.5) means distinct preferences are NEVER collapsed (the
 * profile-shrink failure mode, Pitfall 4) — they coexist. Deterministic, pure,
 * symmetric — no LLM, no abstain gate needed. The classification is `revise`'s only
 * judgement; the richer cross-profile same-slot classification is the JOB's job.
 */
const SAME_BELIEF_DICE = 0.9;
const SAME_SLOT_DICE = 0.5;
type SlotRelation = "corroborate" | "contradict" | "coexist";
function classifyAgainstIncumbent(incumbent: string, candidate: string): SlotRelation {
  const ni = normalizeBelief(incumbent);
  const nc = normalizeBelief(candidate);
  if (ni === nc) return "corroborate";
  const d = bigramDice(ni, nc);
  if (d >= SAME_BELIEF_DICE) return "corroborate";
  if (d >= SAME_SLOT_DICE) return "contradict";
  return "coexist";
}

/** Map a parsed snake_case `user_representation` row to the camelCase entry. */
function rowToEntry(row: {
  id: string;
  entry_type: "identity" | "preference" | "relationship" | "instruction";
  content: string;
  trust: "system" | "learned";
  source_memory_id?: string | null;
  created_at: number;
  updated_at?: number | null;
  t_valid_start?: number | null;
  t_valid_end?: number | null;
}): UserRepresentationEntry {
  return {
    id: row.id,
    entryType: row.entry_type,
    content: row.content,
    trust: row.trust,
    createdAt: row.created_at,
    ...(row.source_memory_id != null ? { sourceMemoryId: row.source_memory_id } : {}),
    ...(row.updated_at != null ? { updatedAt: row.updated_at } : {}),
    ...(row.t_valid_start != null ? { validFrom: row.t_valid_start } : {}),
    ...(row.t_valid_end != null ? { validTo: row.t_valid_end } : {}),
  };
}

/**
 * Create the SQLite-backed {@link UserRepresentationStore} adapter over a shared
 * db handle. The handle's lifecycle (open/close, pragmas) is owned by the caller
 * (the memory adapter) — this factory neither opens nor closes it.
 */
export function createSqliteUserRepresentationStore(
  deps: MemoryUserRepresentationStoreDeps,
): UserRepresentationStore {
  const { db, logger } = deps;
  const historyCap = deps.historyCap ?? DEFAULT_HISTORY_CAP;

  // --- Prepared statements (parameterized; reused across calls) ---
  // INSERT one representation entry. Every value a bound `?` (NEVER concatenated).
  // created_at = scope.now (injected clock, NEVER Date.now()); updated_at NULL on
  // first write; t_valid_start = now (bi-temporal current-truth — t_valid_end +
  // expired_at default NULL = currently believed); confidence = the seed (so a
  // later corroboration has a base to strictly raise). The DB
  // CHECK(trust IN ('system','learned')) is the DB-layer floor.
  const insertEntry = db.prepare(
    "INSERT INTO user_representation " +
      "(id, tenant_id, agent_id, user_id, entry_type, content, trust, source_memory_id, created_at, t_valid_start, confidence) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  // The scoped CURRENT-TRUTH read. The `tenant_id = ? AND agent_id = ? AND
  // user_id = ?` filter is the load-bearing 3-way ISOLATION boundary; the
  // `AND t_valid_end IS NULL` is the REQUIRED Pitfall-1 current-truth filter (a
  // superseded belief never leaks to the prompt). Newest-first, capped (cap a
  // bound `?`). Bound params only. Projects the bi-temporal cols for the entry map.
  const readScoped = db.prepare(
    "SELECT id, entry_type, content, trust, source_memory_id, created_at, updated_at, t_valid_start, t_valid_end " +
      "FROM user_representation " +
      "WHERE tenant_id = ? AND agent_id = ? AND user_id = ? AND t_valid_end IS NULL " +
      "ORDER BY entry_type, created_at DESC LIMIT ?",
  );
  // SELECT the current-truth incumbent for (tenant, agent, user, entry_type),
  // scoped. `t_valid_end IS NULL` = currently believed. The explicit projection
  // (NOT `SELECT *` — UserRepresentationRowSchema is a strictObject that does not
  // carry tenant_id/agent_id/user_id; the WHERE pins them) includes `confidence`
  // for the corroboration bump base. Parsed via the row mapper (no `as Row`). The
  // 3-way scope filter is the load-bearing ISOLATION boundary: a contradiction in
  // one scope can NEVER read/close a row in another. ORDER BY t_valid_start DESC
  // LIMIT 1 picks the most-recent current-truth when topic-distinct same-type facts
  // coexist (the slot the candidate shares).
  const selectCurrentEntry = db.prepare(
    "SELECT id, entry_type, content, trust, source_memory_id, created_at, updated_at, t_valid_start, t_valid_end, expired_at, confidence " +
      "FROM user_representation " +
      "WHERE tenant_id = ? AND agent_id = ? AND user_id = ? AND entry_type = ? " +
      "AND t_valid_end IS NULL " +
      "ORDER BY t_valid_start DESC LIMIT 1",
  );
  // Soft-close the LOSER: set `t_valid_end` + `expired_at` — NEVER a DELETE. Keyed
  // by id AND re-scoped on (tenant, agent, user) so a stray id can never close a
  // cross-scope row. Bound params only.
  const softCloseEntry = db.prepare(
    "UPDATE user_representation SET t_valid_end = ?, expired_at = ? " +
      "WHERE id = ? AND tenant_id = ? AND agent_id = ? AND user_id = ?",
  );
  // Corroboration bump (same belief slot): strictly raise the incumbent's
  // confidence in place — NO new history row. Scoped + keyed by id. Bound params.
  const bumpConfidence = db.prepare(
    "UPDATE user_representation SET confidence = ? " +
      "WHERE id = ? AND tenant_id = ? AND agent_id = ? AND user_id = ?",
  );
  // Valid-time as-of read, scoped — "what was BELIEVED at t". (tenant, agent, user)
  // is the load-bearing ISOLATION boundary; `t` a bound `?`. Projects the cols the
  // entry map needs.
  const asOfSelect = db.prepare(
    "SELECT id, entry_type, content, trust, source_memory_id, created_at, updated_at, t_valid_start, t_valid_end " +
      "FROM user_representation " +
      "WHERE tenant_id = ? AND agent_id = ? AND user_id = ? " +
      "AND t_valid_start <= ? AND (t_valid_end IS NULL OR t_valid_end > ?)",
  );
  // Txn/record-time as-of read, scoped — "what the system had RECORDED as of t":
  // `created_at <= t AND (expired_at IS NULL OR expired_at > t)`. `created_at` is
  // the record-time anchor for user_representation (the design lists only 3 NEW
  // columns because created_at doubles as t_ingested). Querying a DIFFERENT column
  // pair than asOfSelect is the whole point of the txn variant. Scoped; bound params.
  const asOfTxnSelect = db.prepare(
    "SELECT id, entry_type, content, trust, source_memory_id, created_at, updated_at, t_valid_start, t_valid_end " +
      "FROM user_representation " +
      "WHERE tenant_id = ? AND agent_id = ? AND user_id = ? " +
      "AND created_at <= ? AND (expired_at IS NULL OR expired_at > ?)",
  );
  // Bounded-history trim (Pitfall 2) — the ONE allowed DELETE: drop the oldest
  // CLOSED (superseded) rows for the slot beyond historyCap, oldest `expired_at`
  // first. NEVER touches current truth (`t_valid_end IS NOT NULL` confines it to
  // ancient superseded history). Scoped on (tenant, agent, user, entry_type); the
  // keep-count is a bound `?` (the LIMIT offset = how many to RETAIN). Bound params.
  const trimOldClosed = db.prepare(
    "DELETE FROM user_representation WHERE id IN (" +
      "SELECT id FROM user_representation " +
      "WHERE tenant_id = ? AND agent_id = ? AND user_id = ? AND entry_type = ? AND t_valid_end IS NOT NULL " +
      "ORDER BY expired_at DESC LIMIT -1 OFFSET ?" +
      ")",
  );

  /**
   * Fail-closed scope guard (mirror sqlite-mental-model-store.ts
   * rejectUnresolvedScope). An empty tenant/agent/user RAISES into an err — the
   * store refuses to widen to a shared pool. Covers the write paths.
   */
  function rejectUnresolvedScope(
    tenantId: string,
    agentId: string,
    userId: string,
  ): Result<never, Error> | undefined {
    if (tenantId === "" || agentId === "" || userId === "") {
      logger?.warn(
        {
          step: "user-repr-revise",
          errorKind: "config" as const,
          hint: "user-representation store requires a resolved (tenant, agent, user) scope — refusing to widen to a shared pool",
        },
        "User-representation op rejected (unresolved scope)",
      );
      return err(
        new Error("user-representation store requires a resolved (tenant, agent, user) scope"),
      );
    }
    return undefined;
  }

  /**
   * The shared write-boundary firewall — the high-trust floor reject (layer 3) +
   * the `validateMemoryWrite` redaction firewall. Runs on BOTH `upsert` and
   * `revise` (REVISE-03 — external/below-floor/dirty rejected BEFORE the write).
   * Returns an `err` to short-circuit, or `undefined` to proceed.
   */
  function rejectUnwritableEntry(
    entry: UserRepresentationInput,
    step: "user-repr-upsert" | "user-repr-revise",
    startMs: number,
  ): Result<never, Error> | undefined {
    // LAYER 3 (write-boundary): reject a below-floor trust BEFORE the write — return
    // err, NEVER store at a reduced weight (defense-in-depth with the DB CHECK; the
    // port type makes this unreachable for honest callers, a cast-past value is
    // rejected here).
    if (entry.trust !== "system" && entry.trust !== "learned") {
      logger?.warn(
        {
          step,
          errorKind: "validation" as const,
          hint: "trust below the high-trust floor — entry rejected, not stored",
          durationMs: systemNowMs() - startMs,
        },
        "User-representation write rejected (trust below high-trust floor)",
      );
      return err(new Error("user-representation: trust below high-trust floor"));
    }
    // The redaction firewall on the untrusted profile text. The profile is
    // HIGH-TRUST-ONLY — there is no `external` tier to down-store a `warn` into — so
    // ANYTHING not `clean` is REJECTED, never persisted.
    const verdict = validateMemoryWrite(entry.content);
    if (verdict.severity !== "clean") {
      logger?.warn(
        {
          step,
          errorKind: "validation" as const,
          severity: verdict.severity,
          criticalPatterns: verdict.criticalPatterns,
          hint: "content failed validateMemoryWrite (redaction firewall) — entry not persisted",
          durationMs: systemNowMs() - startMs,
        },
        "User-representation write rejected (redaction firewall)",
      );
      return err(new Error("user-representation: content failed redaction validation"));
    }
    return undefined;
  }

  return {
    async upsert(
      entry: UserRepresentationInput,
      scope: UserRepresentationScope,
    ): Promise<Result<void, Error>> {
      const startMs = systemNowMs();
      const { tenantId, agentId, userId, now } = scope;
      try {
        const unwritable = rejectUnwritableEntry(entry, "user-repr-upsert", startMs);
        if (unwritable) return unwritable;

        insertEntry.run(
          randomUUID(),
          tenantId,
          agentId,
          userId,
          entry.entryType,
          entry.content,
          entry.trust,
          entry.sourceMemoryId ?? null,
          now, // created_at (injected clock)
          now, // t_valid_start (bi-temporal current-truth)
          SEED_CONFIDENCE, // confidence seed (corroboration bumps from here)
        );

        // Counts/metadata ONLY — NEVER the content body (§2.7). entryType is a
        // bounded enum tag, not the profile text.
        logger?.debug(
          {
            step: "user-repr-upsert",
            entryType: entry.entryType,
            durationMs: systemNowMs() - startMs,
          },
          "User-representation upsert complete",
        );
        return ok(undefined);
      } catch (e: unknown) {
        const durationMs = systemNowMs() - startMs;
        const error = e instanceof Error ? e : new Error(String(e));
        logger?.warn(
          {
            step: "user-repr-upsert",
            durationMs,
            err: error,
            errorKind: "internal" as const,
            hint: "user-representation write failed — entry not persisted",
          },
          "User-representation upsert failed",
        );
        return err(error);
      }
    },

    async revise(
      entry: UserRepresentationInput,
      scope: UserRepresentationScope,
    ): Promise<Result<ReviseOutcome, Error>> {
      const startMs = systemNowMs();
      const { tenantId, agentId, userId, now } = scope;

      // Fail-closed: an unresolved scope RAISES before any DB touch.
      const badScope = rejectUnresolvedScope(tenantId, agentId, userId);
      if (badScope) return badScope;
      // REVISE-03: the SAME high-trust floor + redaction firewall as upsert, BEFORE
      // the txn — external/below-floor/dirty content never reaches the supersession.
      const unwritable = rejectUnwritableEntry(entry, "user-repr-revise", startMs);
      if (unwritable) return unwritable;

      try {
        // INSERT a fresh current-truth row (t_valid_start = now; t_valid_end +
        // expired_at NULL; confidence seed). Captured here so both the no-incumbent
        // and the superseded branch reuse it.
        const insertCurrent = (): void => {
          insertEntry.run(
            randomUUID(),
            tenantId,
            agentId,
            userId,
            entry.entryType,
            entry.content,
            entry.trust,
            entry.sourceMemoryId ?? null,
            now, // created_at
            now, // t_valid_start
            SEED_CONFIDENCE,
          );
        };

        // Trust-first single-current-truth revision — ONE synchronous transaction
        // (mirror upsertTriple). better-sqlite3 auto-ROLLBACKs on ANY throw, so the
        // SELECT-incumbent → (corroborate | soft-close-loser + INSERT) unit is
        // atomic. The decided branch is returned for the metadata log.
        const tx = db.transaction((): ReviseOutcomeLocal => {
          // 1. SELECT the current-truth incumbent for the slot (scoped). SELECT * →
          //    full-row mapper; a parse fault THROWS to ROLLBACK (caught below → err).
          const raw = selectCurrentEntry.get(tenantId, agentId, userId, entry.entryType);
          const parsed = reprRowMapper.parseOptionalRow(raw);
          if (!parsed.ok) throw new Error(parsed.error.message);
          const incumbent = parsed.value;

          // 2a. No incumbent → the candidate is the sole current-truth.
          if (incumbent === undefined) {
            insertCurrent();
            return "inserted";
          }

          const relation = classifyAgainstIncumbent(incumbent.content, entry.content);

          // 2b. Near-restatement = corroboration → strictly bump the incumbent's
          //     confidence in place; NO new current-truth row (the WS5 first-RED
          //     corroboration half).
          if (relation === "corroborate") {
            const base = incumbent.confidence ?? SEED_CONFIDENCE;
            const bumped = Math.min(1, base + CONFIDENCE_BUMP_STEP);
            bumpConfidence.run(bumped, incumbent.id, tenantId, agentId, userId);
            return "corroborated";
          }

          // 2c. Topic-distinct same-type fact = COEXIST → INSERT as an additional
          //     current-truth; the incumbent is UNTOUCHED (Pitfall 4 — distinct
          //     preferences are never collapsed).
          if (relation === "coexist") {
            insertCurrent();
            return "inserted";
          }

          // 2d. Same belief slot, DIFFERENT value = a contradiction. Trust-first
          //     HARD ladder (NOT a soft weight). A higher OR equal-trust candidate
          //     supersedes (the equal-trust case = the newer belief wins, since the
          //     candidate's now > the incumbent's t_valid_start by construction).
          const newRank = TRUST_RANK[entry.trust];
          const incRank = TRUST_RANK[incumbent.trust];
          if (newRank >= incRank) {
            // New wins: soft-close the incumbent (loser) — never DELETE — and insert
            // the candidate as current-truth.
            softCloseEntry.run(now, now, incumbent.id, tenantId, agentId, userId);
            insertCurrent();
            return "superseded";
          }
          // A lower-trust contradiction NEVER supersedes a higher-trust incumbent
          // (ANTI-POISON). Recorded-not-believed: the incumbent stays current; the
          // candidate is dropped (the profile has no external down-store tier).
          return "recorded-not-believed";
        });
        const outcome = tx(); // throws → automatic ROLLBACK; nothing committed

        // Bounded per-record history (Pitfall 2): after a supersession/insert, trim
        // CLOSED rows for the slot beyond historyCap (oldest expired_at first). The
        // ONE allowed DELETE — ancient superseded history only, never current truth.
        let trimmed = 0;
        if (outcome === "superseded" || outcome === "inserted") {
          const info = trimOldClosed.run(tenantId, agentId, userId, entry.entryType, historyCap);
          trimmed = info.changes;
        }

        // Counts/metadata + the decided OUTCOME only — NEVER the content body
        // (§2.7). `closed` flags a soft-closed incumbent; `trimmed` the bounded-trim.
        logger?.debug(
          {
            step: "user-repr-revise",
            outcome,
            closed: outcome === "superseded" ? 1 : 0,
            trimmed,
            durationMs: systemNowMs() - startMs,
          },
          "User-representation revise complete",
        );
        // Return the AUTHORITATIVE decided branch so the offline builder counts what
        // was actually persisted (REVISE-01/OBS-01) — the single source of truth for
        // the `learning:user_model_revised` superseded/corroborated/inserted counts.
        return ok(outcome);
      } catch (e: unknown) {
        const durationMs = systemNowMs() - startMs;
        const error = e instanceof Error ? e : new Error(String(e));
        logger?.warn(
          {
            step: "user-repr-revise",
            durationMs,
            err: error,
            errorKind: "internal" as const,
            hint: "user-representation revise failed — assertion not persisted (transaction rolled back)",
          },
          "User-representation revise failed",
        );
        return err(error);
      }
    },

    async read(
      scope: Omit<UserRepresentationScope, "now">,
      cap: number = DEFAULT_READ_CAP,
    ): Promise<Result<UserRepresentationEntry[], Error>> {
      const startMs = systemNowMs();
      const { tenantId, agentId, userId } = scope;
      try {
        // The 3-way scoped CURRENT-TRUTH read — the (tenant, agent, user) filter is
        // the load-bearing isolation boundary; `AND t_valid_end IS NULL` (Pitfall 1)
        // keeps superseded beliefs out of the recall prompt; the cap is a bound `?`.
        const rows = readScoped.all(tenantId, agentId, userId, cap);
        const parsed = reprRowMapper.parseRows(rows);
        if (!parsed.ok) return err(new Error(parsed.error.message));

        const entries = parsed.value.map(rowToEntry);

        logger?.debug(
          { step: "user-repr-read", count: entries.length, cap, durationMs: systemNowMs() - startMs },
          "User-representation read complete",
        );
        return ok(entries);
      } catch (e: unknown) {
        const durationMs = systemNowMs() - startMs;
        const error = e instanceof Error ? e : new Error(String(e));
        logger?.warn(
          {
            step: "user-repr-read",
            durationMs,
            err: error,
            errorKind: "internal" as const,
            hint: "user-representation read failed — profile unavailable",
          },
          "User-representation read failed",
        );
        return err(error);
      }
    },

    async asOf(
      t: number,
      scope: Omit<UserRepresentationScope, "now">,
      mode: "valid" | "txn" = "valid",
    ): Promise<Result<UserRepresentationEntry[], Error>> {
      const startMs = systemNowMs();
      const { tenantId, agentId, userId } = scope;
      try {
        // Branch the temporal axis on `mode` — the two prepared statements query
        // DIFFERENT column pairs (valid-time t_valid_start/t_valid_end vs record-time
        // created_at/expired_at). Both (tenant, agent, user) scoped (the load-bearing
        // isolation filter); `t` is a bound `?` param.
        const stmt = mode === "txn" ? asOfTxnSelect : asOfSelect;
        const rows = stmt.all(tenantId, agentId, userId, t, t);
        const parsed = reprRowMapper.parseRows(rows);
        if (!parsed.ok) return err(new Error(parsed.error.message));

        const entries = parsed.value.map(rowToEntry);

        logger?.debug(
          { step: "user-repr-asof", mode, count: entries.length, durationMs: systemNowMs() - startMs },
          "User-representation asOf complete",
        );
        return ok(entries);
      } catch (e: unknown) {
        const durationMs = systemNowMs() - startMs;
        const error = e instanceof Error ? e : new Error(String(e));
        logger?.warn(
          {
            step: "user-repr-asof",
            mode,
            durationMs,
            err: error,
            errorKind: "internal" as const,
            hint: "user-representation asOf query failed",
          },
          "User-representation asOf failed",
        );
        return err(error);
      }
    },
  };
}
