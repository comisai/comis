// SPDX-License-Identifier: Apache-2.0
/**
 * createSqliteDurableRunStore — SQLite persistence for the Phase-216 durable run
 * checkpoint (DUR-01/DUR-02/DUR-03/HB-01), implementing the `@comis/core`
 * {@link DurableRunPort}.
 *
 * Factory-function pattern (modeled wholesale on `createVideoJobStore`): prepares
 * fixed SQL statements once in the closure, returns a frozen `DurableRunPort`.
 * Reads go through `createRowMapper(DurableRunDbRowSchema)` so a corrupt row
 * degrades to a `Result.err`, never a throw (T-216-08); the JSON array columns
 * (`spawn_tree`/`caps`/`lease_ids`) are parsed inside a guard so a hand-edited /
 * truncated JSON column ALSO degrades to `err` rather than crashing the boot scan.
 *
 * The row is the durable spine the resume engine rebuilds the in-memory
 * `BoundedAutonomy`/`LeaseManager` FROM across a daemon restart: a row survives
 * the agent turn AND a restart because it lives on disk in the shared `memory.db`
 * (never an own .db). The `caps` column persists the ATTENUATED set (the result
 * of `attenuateCaps`) so a resume rehydrates it verbatim (DUR-03); the Plan-01
 * `parseDurableRunRecord` Zod union is the gate before any re-mint (T-216-06).
 *
 * NEW-1 (CRITICAL): the dedicated `outward_step` column is the SOLE monotonic
 * outward-send counter and is owned ENTIRELY by `allocateOutwardStep`.
 * `upsertCheckpoint` NEVER writes it, so a checkpoint between two outward sends
 * cannot reset it and re-introduce HIGH-1. `DurableRunRecord.stepIndex` maps onto
 * `outward_step` in `rowToRecord`; the column seeds at the -1 'never-sent'
 * sentinel, so a never-allocated run surfaces stepIndex -1 — which the domain
 * schema permits (`.min(-1)`, NEW-5), so it is NOT falsely orphaned. (LOW-1:
 * there is no coarse per-step index column — only `outward_step`.)
 *
 * SECURITY (T-216-05): the persisted columns carry NO secret — the lease
 * credential is held by the boot-bound adapter and is re-minted FRESH on resume;
 * only the attenuated caps + leaseId correlation are written here.
 *
 * @module
 */

import type Database from "better-sqlite3";
import type { Result } from "@comis/shared";
import { ok, err } from "@comis/shared";
import { systemNowMs, type DurableRunPort, type DurableRunRecord } from "@comis/core";
import { createRowMapper } from "./row-mapper.js";
import { DurableRunDbRowSchema, type DurableRunDbRow } from "./durable-run-row-schema.js";

/** Options for the durable-run store (an injectable clock for deterministic tests). */
export interface DurableRunStoreOptions {
  /** Wall-clock source for created_at_ms / updated_at_ms; defaults to systemNowMs. */
  readonly nowMs?: () => number;
}

// ---------------------------------------------------------------------------
// Row mapper (snake_case -> camelCase) + JSON-column parse guard
// ---------------------------------------------------------------------------

const durableRunMapper = createRowMapper(DurableRunDbRowSchema);

/**
 * Map a validated DB row to the domain `DurableRunRecord`. Returns a `Result`
 * because the JSON array columns may be corrupt: a non-parseable
 * `spawn_tree`/`caps`/`lease_ids` degrades to `err` (T-216-08), never a throw.
 *
 * NEW-1/NEW-5/LOW-1: `record.stepIndex` maps from the `outward_step` column (the
 * sole counter; -1 seed surfaces as stepIndex -1 for a never-sent run).
 */
function rowToRecord(row: DurableRunDbRow): Result<DurableRunRecord, Error> {
  let spawnTree: DurableRunRecord["spawnTree"];
  let caps: DurableRunRecord["caps"];
  let leaseIds: DurableRunRecord["leaseIds"];
  try {
    // The JSON columns are TEXT on disk; parse them as-is. `spawn_tree` is EITHER
    // a flat string[] OR a DAG {nodeId,status,runId?}[] — JSON.parse preserves the
    // shape; the Plan-01 spawnTree union validates both (do not coerce one into
    // the other). Casts are to the domain field types; the Zod `parseDurableRunRecord`
    // at the resume boundary (Plan 04/07) is the membership gate (T-216-06).
    spawnTree = JSON.parse(row.spawn_tree) as DurableRunRecord["spawnTree"];
    caps = JSON.parse(row.caps) as DurableRunRecord["caps"];
    leaseIds = JSON.parse(row.lease_ids) as DurableRunRecord["leaseIds"];
  } catch (e) {
    return err(
      new Error(
        `durable_runs row ${row.root_run_id} has a corrupt JSON column: ${
          e instanceof Error ? e.message : String(e)
        }`,
      ),
    );
  }
  return ok({
    rootRunId: row.root_run_id,
    spawnTree,
    caps,
    leaseIds,
    budgetConsumed: row.budget_consumed,
    cronOrigin: row.cron_origin,
    // NEW-1/NEW-5: the idempotency-key field maps from the dedicated counter column.
    stepIndex: row.outward_step,
    status: row.status as DurableRunRecord["status"],
    lastHeartbeatAt: row.last_heartbeat_at,
  });
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a SQLite-backed `DurableRunPort`.
 *
 * Assumes `initSchema()` (which calls `ensureDurableRunTable`) has already been
 * called — the `durable_runs` table exists. Prepares fixed SQL once.
 *
 * @param db - An open better-sqlite3 Database instance
 * @param opts - Optional injectable clock (deterministic tests)
 * @returns DurableRunPort implementation (frozen)
 */
export function createSqliteDurableRunStore(
  db: Database.Database,
  opts: DurableRunStoreOptions = {},
): DurableRunPort {
  const nowMs = opts.nowMs ?? systemNowMs;

  // --- Prepared statements ---

  // DUR-01 idempotent upsert. NEW-1 (CRITICAL): the column list and the
  // DO UPDATE SET clause DELIBERATELY OMIT `outward_step` — the counter is owned
  // solely by allocateOutwardStep. On a fresh INSERT, outward_step takes the DDL
  // default (-1, the NEW-5 sentinel); on CONFLICT, the SET clause leaves it
  // untouched so a concurrent allocate's value survives. (LOW-1: there is no
  // coarse per-step index column to write — the DDL has only outward_step.)
  const upsertStmt = db.prepare(`
    INSERT INTO durable_runs (
      root_run_id, spawn_tree, caps, lease_ids, budget_consumed, cron_origin,
      status, last_heartbeat_at, created_at_ms, updated_at_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(root_run_id) DO UPDATE SET
      spawn_tree = excluded.spawn_tree,
      caps = excluded.caps,
      lease_ids = excluded.lease_ids,
      budget_consumed = excluded.budget_consumed,
      cron_origin = excluded.cron_origin,
      status = excluded.status,
      last_heartbeat_at = excluded.last_heartbeat_at,
      updated_at_ms = excluded.updated_at_ms
  `);

  const getStmt = db.prepare(`SELECT * FROM durable_runs WHERE root_run_id = ?`);

  // DUR-02 boot-resume scan — only status='running' (the partial index serves it).
  const listResumableStmt = db.prepare(`
    SELECT * FROM durable_runs WHERE status = 'running' ORDER BY last_heartbeat_at ASC
  `);

  const markOrphanedStmt = db.prepare(`
    UPDATE durable_runs SET status = 'orphaned', orphan_reason = ?, updated_at_ms = ?
    WHERE root_run_id = ?
  `);

  const markCompletedStmt = db.prepare(`
    UPDATE durable_runs SET status = 'completed', updated_at_ms = ? WHERE root_run_id = ?
  `);

  const touchHeartbeatStmt = db.prepare(`
    UPDATE durable_runs SET last_heartbeat_at = ?, updated_at_ms = ? WHERE root_run_id = ?
  `);

  // DUR-03 — a revoke flips the record to the terminal 'revoked' state so
  // listResumable filters it out and resume can never re-mint pre-revoke caps.
  const invalidateForRevokeStmt = db.prepare(`
    UPDATE durable_runs SET status = 'revoked', orphan_reason = 'revoked', updated_at_ms = ?
    WHERE root_run_id = ?
  `);

  // HIGH-1 / ONCE-02 — the ATOMIC monotonic outward-send counter. A single
  // synchronous UPDATE ... RETURNING (better-sqlite3 supports RETURNING) so two
  // sequential calls can never observe the same index. outward_step seeds at -1,
  // so the first allocate yields 0. This is the SOLE writer of outward_step (NEW-1).
  const allocateStmt = db.prepare(`
    UPDATE durable_runs SET outward_step = outward_step + 1, updated_at_ms = ?
    WHERE root_run_id = ? RETURNING outward_step
  `);
  // allocateOutwardStep never errors on a missing row: insert a minimal running
  // placeholder (outward_step takes the DDL default -1) then run the UPDATE, so a
  // first send on a not-yet-checkpointed run still gets index 0.
  const insertPlaceholderStmt = db.prepare(`
    INSERT OR IGNORE INTO durable_runs (
      root_run_id, spawn_tree, caps, lease_ids, budget_consumed, cron_origin,
      status, last_heartbeat_at, created_at_ms, updated_at_ms
    ) VALUES (?, '[]', '[]', '[]', 0, NULL, 'running', ?, ?, ?)
  `);
  const allocCounterSchema = DurableRunDbRowSchema.pick({ outward_step: true });
  const allocCounterMapper = createRowMapper(allocCounterSchema);

  // --- Store implementation ---

  const store: DurableRunPort = {
    upsertCheckpoint(record: DurableRunRecord): Promise<Result<void, Error>> {
      try {
        const t = nowMs();
        upsertStmt.run(
          record.rootRunId,
          JSON.stringify(record.spawnTree),
          JSON.stringify(record.caps),
          JSON.stringify(record.leaseIds),
          record.budgetConsumed,
          record.cronOrigin ?? null,
          record.status,
          record.lastHeartbeatAt,
          t, // created_at_ms (ignored on CONFLICT — PK row keeps its original)
          t, // updated_at_ms
        );
        return Promise.resolve(ok(undefined));
      } catch (e) {
        return Promise.resolve(err(e instanceof Error ? e : new Error(String(e))));
      }
    },

    listResumable(): Promise<Result<DurableRunRecord[], Error>> {
      try {
        const parsed = durableRunMapper.parseRows(listResumableStmt.all());
        if (!parsed.ok) {
          return Promise.resolve(err(new Error(`Row validation failed: ${parsed.error.message}`)));
        }
        const out: DurableRunRecord[] = [];
        for (const row of parsed.value) {
          const rec = rowToRecord(row);
          if (!rec.ok) return Promise.resolve(err(rec.error)); // early-return on first corrupt row
          out.push(rec.value);
        }
        return Promise.resolve(ok(out));
      } catch (e) {
        return Promise.resolve(err(e instanceof Error ? e : new Error(String(e))));
      }
    },

    getByRootRun(rootRunId: string): Promise<Result<DurableRunRecord | undefined, Error>> {
      try {
        const parsed = durableRunMapper.parseOptionalRow(getStmt.get(rootRunId));
        if (!parsed.ok) {
          return Promise.resolve(err(new Error(`Row validation failed: ${parsed.error.message}`)));
        }
        if (parsed.value === undefined) return Promise.resolve(ok(undefined));
        const rec = rowToRecord(parsed.value);
        if (!rec.ok) return Promise.resolve(err(rec.error));
        return Promise.resolve(ok(rec.value));
      } catch (e) {
        return Promise.resolve(err(e instanceof Error ? e : new Error(String(e))));
      }
    },

    markOrphaned(rootRunId: string, reason: string): Promise<Result<void, Error>> {
      try {
        markOrphanedStmt.run(reason, nowMs(), rootRunId);
        return Promise.resolve(ok(undefined));
      } catch (e) {
        return Promise.resolve(err(e instanceof Error ? e : new Error(String(e))));
      }
    },

    markCompleted(rootRunId: string): Promise<Result<void, Error>> {
      try {
        markCompletedStmt.run(nowMs(), rootRunId);
        return Promise.resolve(ok(undefined));
      } catch (e) {
        return Promise.resolve(err(e instanceof Error ? e : new Error(String(e))));
      }
    },

    touchHeartbeat(rootRunId: string, atMs: number): Promise<Result<void, Error>> {
      try {
        touchHeartbeatStmt.run(atMs, nowMs(), rootRunId);
        return Promise.resolve(ok(undefined));
      } catch (e) {
        return Promise.resolve(err(e instanceof Error ? e : new Error(String(e))));
      }
    },

    invalidateForRevoke(rootRunId: string): Promise<Result<void, Error>> {
      try {
        invalidateForRevokeStmt.run(nowMs(), rootRunId);
        return Promise.resolve(ok(undefined));
      } catch (e) {
        return Promise.resolve(err(e instanceof Error ? e : new Error(String(e))));
      }
    },

    allocateOutwardStep(rootRunId: string): Promise<Result<number, Error>> {
      try {
        const t = nowMs();
        // Ensure a row exists (no-op when present — INSERT OR IGNORE on the PK),
        // then atomically bump + read the counter in the SAME synchronous turn
        // (better-sqlite3 is sync + single-connection, so the RETURNING value is
        // this UPDATE's own). The counter seeds at -1 → first call returns 0.
        insertPlaceholderStmt.run(rootRunId, t, t, t);
        const raw = allocateStmt.get(t, rootRunId);
        const parsed = allocCounterMapper.parseOptionalRow(raw);
        if (!parsed.ok) {
          return Promise.resolve(err(new Error(`Row validation failed: ${parsed.error.message}`)));
        }
        if (parsed.value === undefined) {
          // Unreachable in practice — the INSERT OR IGNORE above guarantees a row.
          return Promise.resolve(
            err(new Error(`allocateOutwardStep: no durable_runs row for ${rootRunId}`)),
          );
        }
        return Promise.resolve(ok(parsed.value.outward_step));
      } catch (e) {
        return Promise.resolve(err(e instanceof Error ? e : new Error(String(e))));
      }
    },
  };

  return Object.freeze(store);
}
