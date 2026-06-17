// SPDX-License-Identifier: Apache-2.0
/**
 * SqliteOutcomeStore: the SOLE adapter for the segregated `OutcomeSignalPort`
 * (@comis/core, v2.26 Verified Learning WS1). It owns ALL the `outcome_events`
 * SQL — the idempotent `observe()` write (one raw observation per signal source),
 * the scoped `resolve()` read+fusion (precedence-first then confidence,
 * fail-closed `unknown`), and the age-based `prune()`.
 *
 * ## Idempotency (OUTCOME-01 / T-198-09)
 *
 * `observe()` derives the row `id` as a deterministic sha256 hash of the UNIQUE
 * tuple `(tenant_id, agent_id, trajectory_id, source, observed_at)` in CODE
 * before insert, AND inserts `ON CONFLICT(…) DO NOTHING` on that same tuple. A
 * replayed observation is a no-op at BOTH layers: the hash-id makes a replay
 * upsert the same primary key even if the row was deleted, and the `UNIQUE`
 * backstop catches it regardless.
 *
 * ## Isolation is the load-bearing security boundary (SEC-01 / T-198-05)
 *
 * Comis runs many agents in one DB. EVERY statement (both `observe` and
 * `resolve`) filters on `(tenant_id, agent_id)` — parameterized — and the table
 * keys/indexes lead on those columns, so a row under one (tenant, agent) is NEVER
 * visible to a read under another even when `trajectory_id` is byte-identical. An
 * UNRESOLVED `(tenant, agent)` scope (empty id) on `resolve()` fails-closed with
 * `err(...)` — it NEVER widens to a shared/global pool (the hindsight
 * `get_current_schema()` leak vector, design §9).
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
 * Source-tier precedence for `resolve()` fusion (OUTCOME-05): LOWER rank = HIGHER
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
 * Outcome-severity ordering for the same-tier EQUAL-confidence tie-break (WR-01):
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
  // Idempotent insert keyed on the (tenant_id, agent_id, trajectory_id, source,
  // observed_at) UNIQUE tuple: a replay is a no-op (DO NOTHING). All 12 columns
  // are bound `?` params — never string-built SQL.
  const insertStmt = db.prepare(
    "INSERT INTO outcome_events (id, tenant_id, agent_id, session_id, trajectory_id, outcome, source, confidence, sender_trust, recalled_ids, used_skill_ids, observed_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) " +
      "ON CONFLICT(tenant_id, agent_id, trajectory_id, source, observed_at) DO NOTHING",
  );

  // Scoped read for resolve(): the `tenant_id = ? AND agent_id = ?` filter is the
  // load-bearing isolation boundary (SEC-01); every value is a bound `?` param.
  // `ORDER BY observed_at ASC, id ASC` makes the multi-row scan STABLE across runs
  // (WR-01): without it an unindexed scan can return same-tier rows in any order, so
  // an equal-confidence tie-break that keyed on `rows[0]` flipped run-to-run.
  const readStmt = db.prepare(
    "SELECT id, session_id, trajectory_id, outcome, source, confidence, sender_trust, recalled_ids, used_skill_ids, observed_at " +
      "FROM outcome_events WHERE tenant_id = ? AND agent_id = ? AND trajectory_id = ? " +
      "ORDER BY observed_at ASC, id ASC",
  );

  // Age-based prune: DELETE every row older than the cutoff, wrapped in a
  // transaction (mirror observability-reset.ts:54-67). Implemented in Task 3.
  const pruneStmt = db.prepare("DELETE FROM outcome_events WHERE observed_at < ?");
  const pruneTx = db.transaction((cutoff: number) => pruneStmt.run(cutoff).changes);

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
      // shared/global pool (SEC-01 / T-198-05, the get_current_schema() leak
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
        // fuses to `unknown` and derives NO learning (OUTCOME-05); the coverage
        // metric (Plan 04) must NOT count this as resolved.
        if (rows.length === 0) {
          logger?.debug(
            { step: "outcome-resolve", resolved: false, durationMs: systemNowMs() - startMs },
            "Outcome resolve — no signal (fail-closed unknown)",
          );
          return ok({ outcome: "unknown", confidence: 0, sources: [], recalledIds: [], usedSkillIds: [] });
        }

        // Precedence-first, then confidence, then outcome-severity (OUTCOME-05 /
        // WR-01): pick the highest-precedence tier present, then the MAX-confidence
        // row WITHIN that tier, and on a same-tier EQUAL-confidence TIE prefer the
        // more-severe outcome (`failure` > `corrected` > `unknown` > `success`) so a
        // failure is never masked by an equal-confidence sibling success. A
        // high-confidence reaction still never overrides a deterministic tool result.
        let winner = rows[0]!;
        for (const row of rows) {
          const rt = tierRank(row.source);
          const wt = tierRank(winner.source);
          const better =
            rt < wt ||
            (rt === wt && row.confidence > winner.confidence) ||
            (rt === wt &&
              row.confidence === winner.confidence &&
              outcomeSeverity(row.outcome) > outcomeSeverity(winner.outcome));
          if (better) winner = row;
        }

        // sources = the distinct set of source strings present (deduped). Cast to
        // the closed-union element type — the DDL CHECK guarantees in-set values.
        const sources = [...new Set(rows.map((r) => r.source))] as ResolvedOutcome["sources"];

        // Attribution: union+dedup recalledIds across ALL rows (any source may
        // carry them); usedSkillIds is the EMPTY sink in P0 (populated Phase 201).
        const recalledSet = new Set<string>();
        for (const row of rows) for (const id of parseIdList(row.recalled_ids)) recalledSet.add(id);

        const resolved: ResolvedOutcome = {
          outcome: winner.outcome as ResolvedOutcome["outcome"],
          confidence: winner.confidence,
          sources,
          recalledIds: [...recalledSet],
          usedSkillIds: [],
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

    // prune() — implemented in Task 3 (age-based housekeeping). Wired here so the
    // port type is total; the proven cutoff math + transaction land in Task 3.
    prune(retentionDays: number): OutcomePruneResult {
      const cutoff = systemNowMs() - retentionDays * 86400000;
      return { changes: pruneTx(cutoff) };
    },
  };
}
