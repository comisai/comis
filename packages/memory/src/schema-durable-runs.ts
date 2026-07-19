// SPDX-License-Identifier: Apache-2.0
// @allow-throw: durable-run schema preflight rejects formatted-session authority before boot; initSchema is consumed at the daemon boundary.
/**
 * The `durable_run_checkpoints` table DDL — the durable checkpoint spine the resume engine
 * scans on boot. A long-running agent run
 * writes its `{spawnTree, caps, leaseIds, budgetConsumed, cronOrigin,
 * status, lastHeartbeatAt}` here so a daemon RESTART can find it
 * (`listResumable`), keep it alive (`touchHeartbeat`), and refuse to re-mint a
 * revoked one (`invalidateForRevoke`). The row survives the agent turn AND a
 * restart because it lives on disk in the shared `memory.db`, not in memory —
 * the in-memory `BoundedAutonomy`/`LeaseManager` are rebuilt FROM it on resume.
 *
 * Re-run-safe: create-if-not-exists only, with no destructive DDL. Extracted
 * from `schema.ts` (which is at the 800-line cap) — `initSchema` calls this so
 * the table exists on every boot.
 *
 * SECURITY (mirrors video_jobs): there is NO secret / bearer
 * / token / api_key column. The lease credential is NEVER persisted — only the
 * ATTENUATED `caps` (the result of `attenuateCaps`, never a superset) and the
 * `lease_ids` correlation are stored, and the credential is re-minted FRESH on
 * resume (`data-directory.mdx` invariant). The protected SQLite file is the
 * local trust boundary. Domain parsing rejects malformed, out-of-vocabulary, or
 * internally inconsistent authority rows and the resume scan quarantines them;
 * it is a corruption guard, not authentication against a process that can write
 * the service user's database.
 *
 * Outward-send sequencing is owned by the separate outward ledger sequence
 * table. Checkpoint writes never read or mutate that counter.
 *
 * `script_ref` is the pinned orchestrate script path relative to its workspace;
 * `checkpoint_ref` points to a protected checkpoint artifact. Both columns are
 * nullable and CONTENT-FREE — pointers, never script bytes, graph tasks, node
 * outputs, checkpoint bodies, or bearers. `upsertCheckpoint` writes them with
 * `COALESCE(excluded.x, x)` so a partial upsert preserves the other's prior value.
 *
 * `better-sqlite3` durability is WAL + path-based chmod (never fd-based file
 * sync), so this DDL is permission-model-safe by construction — no fd-fs guard
 * is needed (mirrors video_jobs / [[node-permission-model-disables-fsync]]).
 *
 * @module
 */

import type Database from "better-sqlite3";
import { requireTableInfoRows } from "./schema-introspection.js";

const REQUIRED_DURABLE_AUTHORITY_COLUMNS = [
  "tenant_id",
  "agent_id",
  "conversation_ref",
  "canonical_scope",
  "principal_id",
] as const;

/**
 * Create the `durable_run_checkpoints` table + its boot-resume index idempotently.
 *
 * Safe to call multiple times (all DDL uses IF NOT EXISTS). Called from
 * `initSchema` so the table exists on every daemon boot.
 *
 * @param db - An open better-sqlite3 Database instance
 */
export function ensureDurableRunTable(db: Database.Database): void {
  const exists = db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'durable_run_checkpoints'",
  ).get() !== undefined;
  if (exists) {
    const columns = new Set(
      requireTableInfoRows(
        db.prepare("PRAGMA table_info(durable_run_checkpoints)").all(),
        "durable_run_checkpoints",
      ).map((row) => row.name),
    );
    const missing = REQUIRED_DURABLE_AUTHORITY_COLUMNS.filter((column) => !columns.has(column));
    if (missing.length > 0) {
      throw new Error(
        `durable_run_checkpoints database schema is incompatible: missing ${missing.join(", ")}. Back up the database, then recreate it with the current Comis schema.`,
      );
    }
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS durable_run_checkpoints (
      checkpoint_id      TEXT PRIMARY KEY NOT NULL,
      root_run_id        TEXT NOT NULL,
      tenant_id          TEXT NOT NULL,
      agent_id           TEXT NOT NULL,
      conversation_ref   TEXT NOT NULL,
      canonical_scope    TEXT NOT NULL,
      principal_id       TEXT NOT NULL,
      delivery_origin    TEXT,
      spawn_tree         TEXT NOT NULL,
      caps               TEXT NOT NULL,
      lease_ids          TEXT NOT NULL,
      budget_consumed    REAL NOT NULL DEFAULT 0,
      cron_origin        TEXT,
      trust_level        TEXT NOT NULL CHECK(trust_level IN ('admin','user','guest')),
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
    `CREATE INDEX IF NOT EXISTS idx_durable_run_checkpoints_resumable ON durable_run_checkpoints (status, last_heartbeat_at) WHERE status = 'running'`,
  );
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_durable_run_checkpoints_root ON durable_run_checkpoints (root_run_id)`,
  );
  db.exec(`
    CREATE TABLE IF NOT EXISTS durable_run_roots (
      root_run_id   TEXT PRIMARY KEY NOT NULL,
      revoked_at_ms INTEGER
    )
  `);
}
