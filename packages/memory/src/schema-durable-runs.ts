// SPDX-License-Identifier: Apache-2.0
/**
 * The `durable_runs` table DDL — the durable checkpoint spine the resume engine
 * scans on boot. A long-running agent run
 * writes its `{spawnTree, caps, leaseIds, budgetConsumed, cronOrigin, stepIndex,
 * status, lastHeartbeatAt}` here so a daemon RESTART can find it
 * (`listResumable`), keep it alive (`touchHeartbeat`), and refuse to re-mint a
 * revoked one (`invalidateForRevoke`). The row survives the agent turn AND a
 * restart because it lives on disk in the shared `memory.db`, not in memory —
 * the in-memory `BoundedAutonomy`/`LeaseManager` are rebuilt FROM it on resume.
 *
 * Forward-only, re-run-safe: create-if-not-exists only, no destructive or
 * reverse DDL. Extracted from `schema.ts` (which is at the 800-line
 * cap) — `initSchema` CALLS this so the table exists on every boot (a table
 * defined here but not wired into initSchema is MISSING at runtime).
 *
 * SECURITY (mirrors video_jobs): there is NO secret / bearer
 * / token / api_key column. The lease credential is NEVER persisted — only the
 * ATTENUATED `caps` (the result of `attenuateCaps`, never a superset) and the
 * `lease_ids` correlation are stored, and the credential is re-minted FRESH on
 * resume (`data-directory.mdx` invariant). A hand-edited `caps` column is gated by the
 * `parseDurableRunRecord` Zod union before any resume re-mint,
 * so a tampered `caps:["admin"]` orphans the run rather than escalating.
 *
 * The dedicated outward counter: `outward_step` is the SOLE monotonic
 * outward-send counter column, owned ENTIRELY by `allocateOutwardStep`. It seeds
 * at the `-1` 'no outward send yet' sentinel (the value the domain schema permits
 * via `.min(-1)`) so the first `allocateOutwardStep` yields 0.
 * `upsertCheckpoint` MUST NEVER write this column, or a checkpoint between two
 * outward sends would reset the counter and re-introduce the duplicate-send bug.
 * (There is NO coarse per-step index column — the runner is a spawn-orchestrator with
 * no per-step loop, so a coarse marker would be dead state.)
 *
 * Resumable-orchestrate columns: `script_ref` (the pinned script path relative to
 * the run workspace) and `checkpoint_ref` (the last checkpoint's ResultRef id) are
 * additive, nullable, and CONTENT-FREE — pointers, never the script bytes /
 * checkpoint body / a bearer (INV-5; the no-secret invariant above holds). They make
 * orchestrate the first RE-RUNNABLE durable kind. `upsertCheckpoint` writes them with
 * `COALESCE(excluded.x, x)` so a partial upsert preserves the other's prior value.
 *
 * `better-sqlite3` durability is WAL + path-based chmod (never fd-based file
 * sync), so this DDL is permission-model-safe by construction — no fd-fs guard
 * is needed (mirrors video_jobs / [[node-permission-model-disables-fsync]]).
 *
 * @module
 */

import type Database from "better-sqlite3";

/**
 * Create the `durable_runs` table + its boot-resume index idempotently.
 *
 * Safe to call multiple times (all DDL uses IF NOT EXISTS). Called from
 * `initSchema` so the table exists on every daemon boot.
 *
 * @param db - An open better-sqlite3 Database instance
 */
export function ensureDurableRunTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS durable_runs (
      root_run_id        TEXT PRIMARY KEY,
      spawn_tree         TEXT NOT NULL,
      caps               TEXT NOT NULL,
      lease_ids          TEXT NOT NULL,
      budget_consumed    REAL NOT NULL DEFAULT 0,
      cron_origin        TEXT,
      outward_step       INTEGER NOT NULL DEFAULT -1,
      status             TEXT NOT NULL CHECK(status IN ('running','orphaned','completed','revoked')),
      orphan_reason      TEXT,
      last_heartbeat_at  INTEGER NOT NULL,
      created_at_ms      INTEGER NOT NULL,
      updated_at_ms      INTEGER NOT NULL,
      script_ref         TEXT,
      checkpoint_ref     TEXT
    )
  `);
  // Partial index for the boot-resume scan + the heartbeat watchdog's
  // stale-running sweep: both filter status='running' and order by the heartbeat.
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_durable_runs_resumable ON durable_runs (status, last_heartbeat_at) WHERE status = 'running'`,
  );
  // Forward-only, re-run-safe migration for the additive {script_ref, checkpoint_ref}
  // columns. `CREATE TABLE IF NOT EXISTS` is a no-op on a durable_runs table a PRIOR
  // build (without these columns) already created, so a fresh db gets them from the
  // CREATE above while an already-created `~/.comis/memory.db` needs this guarded ALTER.
  // The `PRAGMA table_info` column-exists check makes each ALTER run at most once, so
  // re-running ensureDurableRunTable never throws (a duplicate ADD COLUMN would). Both
  // columns are nullable — every prior row reads back NULL (no scriptRef/checkpointRef).
  // They make orchestrate the first RE-RUNNABLE durable kind: `script_ref` is the pinned
  // script path relative to the run workspace, `checkpoint_ref` is the last checkpoint's
  // ResultRef id — CONTENT-FREE pointers, NOT the script bytes / checkpoint body / any
  // bearer (the no-secret invariant above holds; INV-5). `outward_step` is UNTOUCHED —
  // the new columns are in no key/index and `upsertCheckpoint` never writes the counter.
  // The `as { name: string }[]` PRAGMA cast is the sanctioned inline exception to the
  // untyped-sqlite gate (the schema-outcome-events.ts / schema-video-jobs.ts precedent).
  const cols = new Set(
    (db.prepare(`PRAGMA table_info(durable_runs)`).all() as { name: string }[]).map((r) => r.name),
  );
  if (!cols.has("script_ref")) db.exec(`ALTER TABLE durable_runs ADD COLUMN script_ref TEXT`);
  if (!cols.has("checkpoint_ref")) db.exec(`ALTER TABLE durable_runs ADD COLUMN checkpoint_ref TEXT`);
}
