// SPDX-License-Identifier: Apache-2.0
/**
 * SqliteOutcomeStore: the SOLE adapter for the segregated `OutcomeSignalPort`
 * (@comis/core). It owns ALL the `outcome_events`
 * SQL — the idempotent `observe()` write (one raw observation per signal source),
 * the scoped `resolve()` read+fusion (precedence-first then confidence,
 * fail-closed `unknown`), and the age-based `prune()`.
 *
 * ## Idempotency
 *
 * `observe()` derives the row `id` as a deterministic sha256 hash of the UNIQUE
 * tuple `(tenant_id, agent_id, trajectory_id, source, observed_at)` in CODE
 * before insert, AND inserts `ON CONFLICT(…) DO NOTHING` on that same tuple. A
 * replayed observation is a no-op at BOTH layers: the hash-id makes a replay
 * upsert the same primary key even if the row was deleted, and the `UNIQUE`
 * backstop catches it regardless.
 *
 * ## Isolation is the load-bearing security boundary
 *
 * Comis runs many agents in one DB. EVERY statement (both `observe` and
 * `resolve`) filters on `(tenant_id, agent_id)` — parameterized — and the table
 * keys/indexes lead on those columns, so a row under one (tenant, agent) is NEVER
 * visible to a read under another even when `trajectory_id` is byte-identical. An
 * UNRESOLVED `(tenant, agent)` scope (empty id) on `resolve()` fails-closed with
 * `err(...)` — it NEVER widens to a shared/global pool (the hindsight
 * `get_current_schema()` leak vector).
 *
 * ## Untrusted input
 *
 * Every id reaches SQL as a bound `?` parameter — never concatenated — and every
 * read parses through `createRowMapper` (no `as Foo[]` casts; `untyped-sqlite.test.ts`).
 * The persisted JSON columns (`recalled_ids`/`used_skill_ids`) are parsed with a
 * graceful-degrade `safeParse` (corrupt JSON → empty list, never a throw). Logs
 * carry counts/ids + metadata only — never bodies or query text (§2.7).
 *
 * @module
 */

import type Database from "better-sqlite3";
import { createHash } from "node:crypto";
import type {
  OutcomeSignalPort,
  OutcomeObservation,
  ResolvedOutcome,
  OutcomePruneResult,
  LearningScope,
} from "@comis/core";
import { systemNowMs } from "@comis/core";
import { ok, err, type Result } from "@comis/shared";
import { z } from "zod";
import { createRowMapper } from "./row-mapper.js";
import { OutcomeEventRowSchema } from "./outcome-event-row-schema.js";

/** Minimal pino-compatible logger (mirrors sqlite-memory-usefulness-store.ts). */
interface MemoryLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  debug(obj: Record<string, unknown>, msg: string): void;
}

/** Constructor deps for {@link createSqliteOutcomeStore}. */
export interface OutcomeStoreDeps {
  /** The shared better-sqlite3 handle (typically `SqliteMemoryAdapter.getDb()`). */
  db: Database.Database;
  /** Optional structured logger. */
  logger?: MemoryLogger;
}

// Row mapper — the sanctioned read path (no `as Foo[]`).
const outcomeRowMapper = createRowMapper(OutcomeEventRowSchema);

// Row mapper for listTrajectoryIds — the projected columns (sanctioned typed read;
// no `as Foo[]` cast, per untyped-sqlite.test.ts). `d` is the per-turn
// procedure_descriptor read back (the content-free JSON tool-NAME array; NULL when no
// procedure ran — SQLite NULL ≠ undefined → `.nullable()`).
const trajectoryIdRowMapper = createRowMapper(z.object({ t: z.string(), s: z.string(), d: z.string().nullable() }));

// Lenient JSON-string[] parser for the recalled_ids/used_skill_ids columns:
// corrupt/non-array JSON degrades to [] (never a throw that breaks resolve()).
const StringArraySchema = z.array(z.string());

/** Parse a nullable JSON-encoded string[] column; [] on NULL or corrupt data. */
function parseIdList(raw: string | null): string[] {
  if (raw === null) return [];
  try {
    const parsed = StringArraySchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : [];
  } catch {
    return [];
  }
}

/**
 * Source-tier precedence for `resolve()` fusion: LOWER rank = HIGHER
 * precedence. The deterministic `tool`/`pipeline` signals outrank everything —
 * a high-confidence reaction NEVER beats a tool result. `judge` sits below the
 * deterministic tier; `correction`/`explicit` are grouped with the `reaction`
 * band (a `correction` is a soft-failure signal, NOT a deterministic verdict, so
 * it never outranks a tool). An unknown/foreign source falls to the bottom.
 *
 * A `Map` (not a plain object) avoids the dynamic object-index lint while the
 * lookup key is a DB-CHECK-constrained closed enum.
 */
const SOURCE_TIER_RANK = new Map<string, number>([
  ["tool", 0],
  ["pipeline", 0],
  ["judge", 1],
  ["reaction", 2],
  ["correction", 2],
  ["explicit", 2],
]);
function tierRank(source: string): number {
  return SOURCE_TIER_RANK.get(source) ?? 3;
}

/**
 * Outcome-severity ordering for the same-tier EQUAL-confidence tie-break:
 * HIGHER value wins a tie. A `failure` (then a `corrected` soft-failure) beats a
 * `success`/`unknown` of equal confidence within the SAME tier — the conservative
 * verdict, so a real tool/node failure is NEVER silently masked by an
 * equal-confidence sibling success (the multi-tool / multi-node DAG case). This
 * ONLY breaks ties: precedence (tier) and then strict confidence still decide
 * first, so a higher-confidence success still wins over a lower-confidence failure.
 *
 * A `Map` (not a plain object) avoids the dynamic object-index lint while the key
 * is a DB-CHECK-constrained closed enum.
 */
const OUTCOME_SEVERITY = new Map<string, number>([
  ["failure", 3],
  ["corrected", 2],
  ["unknown", 1],
  ["success", 0],
]);
function outcomeSeverity(outcome: string): number {
  return OUTCOME_SEVERITY.get(outcome) ?? 0;
}

/**
 * Cap on the per-turn trajectories `listTrajectoryIds` returns (most-recent-first)
 * — a bounded source for the synthesis cron, mirroring the review source's
 * DEFAULT_MAX_CONVERSATIONS=200 ceiling (anti-DoS on the append-only ledger).
 */
const MAX_LISTED_TRAJECTORIES = 500;

/**
 * Compute the deterministic row id from the UNIQUE tuple. A stable sha256 hex of
 * the space-joined `(tenant_id, agent_id, trajectory_id, source, observed_at)` —
 * NEVER `Date.now()`/`Math.random()`. The `createHash` precedent is
 * `embedding-hash.ts`. A replay of the same tuple yields the same id (idempotency
 * backstop beyond the UNIQUE constraint).
 */
function outcomeRowId(o: OutcomeObservation): string {
  return createHash("sha256")
    .update(
      [o.tenantId, o.agentId, o.trajectoryId, o.source, String(o.observedAt)].join(" "),
    )
    .digest("hex");
}

/**
 * Create the SQLite-backed {@link OutcomeSignalPort} adapter over a shared db
 * handle. The handle's lifecycle (open/close, pragmas) is owned by the caller
 * (the memory adapter) — this factory neither opens nor closes it. Built
 * UNCONDITIONALLY (no model/IO cost, like every dormant store); the per-agent
 * enable flag gates the daemon-side `observe`/`resolve` call, not construction.
 */
export function createSqliteOutcomeStore(deps: OutcomeStoreDeps): OutcomeSignalPort {
  const { db, logger } = deps;

  // --- Prepared statements (parameterized; reused across calls) ---
  // Insert keyed on the (tenant_id, agent_id, trajectory_id, source, observed_at) UNIQUE
  // tuple. On conflict, MERGE the attribution columns rather than drop the row:
  // `recalled_ids` (memory:recall_used), `used_skill_ids` (memory:skill_used), and
  // `procedure_descriptor` (orchestrate:run_summary) are written as SEPARATE
  // source:"explicit" carriers at post-execution, so when their `observed_at` lands in the
  // SAME millisecond they collide on this tuple — a plain DO NOTHING then SILENTLY dropped
  // whichever lost the race, intermittently losing one credit on any turn that BOTH recalled
  // memory AND reused a skill (the ~1/3 reuse-credit miss). COALESCE keeps each column's
  // first non-null value, so the carriers MERGE onto one row instead of one dropping. A
  // genuine replay (identical tuple, same columns) COALESCEs to the same values — still a
  // no-op; a tool/pipeline collision (all id-columns null) is a no-op on these SETs and never
  // touches outcome/confidence, so fusion is byte-identical. All columns are bound `?`.
  // AGGREGATE EDGE (procedure_descriptor): a turn may hold multiple orchestrate runs but the
  // row keys on one trajectory_id — COALESCE keeps the FIRST run's descriptor (first-run wins);
  // a set-union across runs is a deliberate non-goal for this advisory, single-run-common case.
  const insertStmt = db.prepare(
    "INSERT INTO outcome_events (id, tenant_id, agent_id, session_id, trajectory_id, outcome, source, confidence, sender_trust, recalled_ids, used_skill_ids, procedure_descriptor, observed_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) " +
      "ON CONFLICT(tenant_id, agent_id, trajectory_id, source, observed_at) DO UPDATE SET " +
      "recalled_ids = COALESCE(excluded.recalled_ids, recalled_ids), " +
      "used_skill_ids = COALESCE(excluded.used_skill_ids, used_skill_ids), " +
      "procedure_descriptor = COALESCE(excluded.procedure_descriptor, procedure_descriptor)",
  );

  // Scoped read for resolve(): the `tenant_id = ? AND agent_id = ?` filter is the
  // load-bearing isolation boundary; every value is a bound `?` param.
  // `ORDER BY observed_at ASC, id ASC` makes the multi-row scan STABLE across runs:
  // without it an unindexed scan can return same-tier rows in any order, so
  // an equal-confidence tie-break that keyed on `rows[0]` flipped run-to-run.
  const readStmt = db.prepare(
    "SELECT id, session_id, trajectory_id, outcome, source, confidence, sender_trust, recalled_ids, used_skill_ids, procedure_descriptor, observed_at " +
      "FROM outcome_events WHERE tenant_id = ? AND agent_id = ? AND trajectory_id = ? " +
      "ORDER BY observed_at ASC, id ASC",
  );

  // Age-based prune: DELETE every row older than the cutoff, wrapped in a
  // transaction (mirror observability-reset.ts:54-67).
  const pruneStmt = db.prepare("DELETE FROM outcome_events WHERE observed_at < ?");
  const pruneTx = db.transaction((cutoff: number) => pruneStmt.run(cutoff).changes);

  // Per-turn enumeration for the synthesis source: the DISTINCT
  // (trajectory_id, session_id) pairs for the scope, most-recent-first, bounded
  // (anti-DoS, mirrors the review source's DEFAULT_MAX_CONVERSATIONS cap). GROUP BY
  // collapses one turn's multiple source rows to a single pair; MAX(observed_at)
  // is the recency key. These are the SAME per-turn `traceId`s `resolve()` keys on
  // — the synthesis source emits THESE so resolve() actually finds rows.
  // MAX(procedure_descriptor) surfaces the turn's content-free descriptor carrier
  // across its multiple source rows (the carrier is one `source:"explicit"` row; the
  // tool/pipeline siblings are NULL, which MAX ignores) — the read-back the reflection
  // source attaches onto its per-turn ReflectionSourceTrajectory. NULL when no procedure ran.
  const listStmt = db.prepare(
    "SELECT trajectory_id AS t, session_id AS s, MAX(observed_at) AS ts, MAX(procedure_descriptor) AS d FROM outcome_events " +
      "WHERE tenant_id = ? AND agent_id = ? GROUP BY trajectory_id, session_id ORDER BY ts DESC LIMIT ?",
  );

  return {
    async observe(obs: OutcomeObservation): Promise<Result<void, Error>> {
      const startMs = systemNowMs();
      try {
        const id = outcomeRowId(obs);
        insertStmt.run(
          id,
          obs.tenantId,
          obs.agentId,
          obs.sessionId,
          obs.trajectoryId,
          obs.outcome,
          obs.source,
          obs.confidence,
          obs.senderTrust ?? null,
          obs.recalledIds && obs.recalledIds.length > 0 ? JSON.stringify(obs.recalledIds) : null,
          obs.usedSkillIds && obs.usedSkillIds.length > 0 ? JSON.stringify(obs.usedSkillIds) : null,
          obs.procedureDescriptor && obs.procedureDescriptor.length > 0
            ? JSON.stringify(obs.procedureDescriptor)
            : null,
          obs.observedAt,
        );
        const durationMs = systemNowMs() - startMs;
        logger?.debug(
          {
            step: "outcome-observe",
            source: obs.source,
            outcome: obs.outcome,
            durationMs,
          },
          "Outcome observe complete",
        );
        return ok(undefined);
      } catch (e: unknown) {
        const durationMs = systemNowMs() - startMs;
        const error = e instanceof Error ? e : new Error(String(e));
        logger?.warn(
          {
            step: "outcome-observe",
            durationMs,
            err: error,
            errorKind: "internal" as const,
            hint: "outcome observe insert failed — check DB integrity / schema",
          },
          "Outcome observe failed",
        );
        return err(error);
      }
    },

    async resolve(
      trajectoryId: string,
      scope: LearningScope,
    ): Promise<Result<ResolvedOutcome, Error>> {
      const startMs = systemNowMs();
      const { tenantId, agentId } = scope;
      // Fail-closed on an unresolved (tenant, agent) scope — NEVER widen to a
      // shared/global pool (the get_current_schema() leak
      // vector). An empty id is a precondition violation, surfaced as err().
      if (tenantId === "" || agentId === "") {
        logger?.warn(
          {
            step: "outcome-resolve",
            errorKind: "config" as const,
            hint: "outcome resolve requires a resolved (tenant, agent) scope — refusing to widen to a shared pool",
          },
          "Outcome resolve rejected (unresolved scope)",
        );
        return err(new Error("outcome resolve requires a resolved (tenant, agent) scope"));
      }
      try {
        const parsed = outcomeRowMapper.parseRows(readStmt.all(tenantId, agentId, trajectoryId));
        if (!parsed.ok) return err(new Error(parsed.error.message));
        const rows = parsed.value;

        // Fail-closed unknown: a finished trajectory with no resolvable signal
        // fuses to `unknown` and derives NO learning; the coverage
        // metric must NOT count this as resolved.
        if (rows.length === 0) {
          logger?.debug(
            { step: "outcome-resolve", resolved: false, durationMs: systemNowMs() - startMs },
            "Outcome resolve — no signal (fail-closed unknown)",
          );
          return ok({ outcome: "unknown", confidence: 0, sources: [], recalledIds: [], usedSkillIds: [] });
        }

        // Precedence-first, then confidence, then RECENCY: pick the highest-precedence
        // tier present, then the MAX-confidence row WITHIN that tier, and on a same-tier
        // EQUAL-confidence TIE prefer the MOST RECENT observation (the turn's TERMINAL
        // state). So a transient tool failure the turn RECOVERED from (failure → later
        // success) resolves to `success`, not `failure` — resolving a self-corrected turn
        // to failure would wrongly exclude it from skill synthesis AND penalize the
        // memories/skills that produced the correct answer (Comis's own tool-policy guards
        // routinely manufacture transient failures). On an EXACT observed_at tie (genuinely
        // simultaneous signals — e.g. concurrent DAG-node siblings) severity STILL wins, so
        // a real concurrent failure is never masked. A high-confidence reaction still never
        // overrides a deterministic tool result.
        let winner = rows[0]!;
        for (const row of rows) {
          const rt = tierRank(row.source);
          const wt = tierRank(winner.source);
          const sameTierConf = rt === wt && row.confidence === winner.confidence;
          const better =
            rt < wt ||
            (rt === wt && row.confidence > winner.confidence) ||
            (sameTierConf && row.observed_at > winner.observed_at) ||
            (sameTierConf &&
              row.observed_at === winner.observed_at &&
              outcomeSeverity(row.outcome) > outcomeSeverity(winner.outcome));
          if (better) winner = row;
        }

        // sources = the distinct set of source strings present (deduped). Cast to
        // the closed-union element type — the DDL CHECK guarantees in-set values.
        const sources = [...new Set(rows.map((r) => r.source))] as ResolvedOutcome["sources"];

        // Attribution: union+dedup recalledIds AND usedSkillIds across ALL rows (any
        // source may carry either). The used_skill_ids column is written at observe()
        // (:199) when the daemon threads a memory:skill_used attribution into the call
        // (setup-learning.ts) — the loop is no longer write-only. The two loops
        // are byte-mirrors (same parseIdList graceful-degrade over the JSON TEXT column).
        const recalledSet = new Set<string>();
        for (const row of rows) for (const id of parseIdList(row.recalled_ids)) recalledSet.add(id);
        const usedSkillSet = new Set<string>();
        for (const row of rows) for (const id of parseIdList(row.used_skill_ids)) usedSkillSet.add(id);

        const resolved: ResolvedOutcome = {
          outcome: winner.outcome as ResolvedOutcome["outcome"],
          confidence: winner.confidence,
          sources,
          recalledIds: [...recalledSet],
          usedSkillIds: [...usedSkillSet],
        };
        logger?.debug(
          {
            step: "outcome-resolve",
            resolved: true,
            outcome: resolved.outcome,
            sourceCount: sources.length,
            durationMs: systemNowMs() - startMs,
          },
          "Outcome resolve complete",
        );
        return ok(resolved);
      } catch (e: unknown) {
        const error = e instanceof Error ? e : new Error(String(e));
        logger?.warn(
          {
            step: "outcome-resolve",
            durationMs: systemNowMs() - startMs,
            err: error,
            errorKind: "internal" as const,
            hint: "outcome resolve query failed — check DB integrity",
          },
          "Outcome resolve failed",
        );
        return err(error);
      }
    },

    // prune() — age-based housekeeping. Deletes every row older than the cutoff in
    // one transaction.
    prune(retentionDays: number): OutcomePruneResult {
      const cutoff = systemNowMs() - retentionDays * 86400000;
      return { changes: pruneTx(cutoff) };
    },

    // READ. The per-turn trajectory identities the ledger holds for this scope —
    // see the port doc. Fail-closed on an unresolved scope exactly like resolve()
    // (never a shared/global pool).
    async listTrajectoryIds(
      scope: LearningScope,
    ): Promise<Result<Array<{ trajectoryId: string; sessionId: string; procedureDescriptor?: ReadonlyArray<string> }>, Error>> {
      const { tenantId, agentId } = scope;
      if (tenantId === "" || agentId === "") {
        return err(new Error("outcome listTrajectoryIds requires a resolved (tenant, agent) scope"));
      }
      try {
        const parsed = trajectoryIdRowMapper.parseRows(listStmt.all(tenantId, agentId, MAX_LISTED_TRAJECTORIES));
        if (!parsed.ok) return err(new Error(parsed.error.message));
        return ok(
          parsed.value.map((r) => {
            // Read the content-free procedure descriptor back per turn. `parseIdList` reuses the
            // recalled/used-skill graceful-degrade posture ([] on NULL or corrupt JSON, never a
            // throw); an empty list maps to ABSENT so the field is OMITTED when no procedure ran.
            const descriptor = parseIdList(r.d);
            return {
              trajectoryId: r.t,
              sessionId: r.s,
              ...(descriptor.length > 0 ? { procedureDescriptor: descriptor } : {}),
            };
          }),
        );
      } catch (e: unknown) {
        const error = e instanceof Error ? e : new Error(String(e));
        logger?.warn(
          { step: "outcome-list", err: error, errorKind: "internal" as const, hint: "outcome listTrajectoryIds query failed — check DB integrity" },
          "Outcome listTrajectoryIds failed",
        );
        return err(error);
      }
    },
  };
}
