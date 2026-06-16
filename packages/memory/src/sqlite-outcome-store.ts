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

    // resolve() — implemented in Task 2 (precedence-first fusion + fail-closed
    // unknown + attribution). Placeholder keeps the OutcomeSignalPort type total.
    async resolve(
      _trajectoryId: string,
      _scope: LearningScope,
    ): Promise<Result<ResolvedOutcome, Error>> {
      return ok({ outcome: "unknown", confidence: 0, sources: [], recalledIds: [], usedSkillIds: [] });
    },

    // prune() — implemented in Task 3 (age-based housekeeping). Wired here so the
    // port type is total; the proven cutoff math + transaction land in Task 3.
    prune(retentionDays: number): OutcomePruneResult {
      const cutoff = systemNowMs() - retentionDays * 86400000;
      return { changes: pruneTx(cutoff) };
    },
  };
}
