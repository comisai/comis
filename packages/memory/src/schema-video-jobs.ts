// SPDX-License-Identifier: Apache-2.0
/**
 * The `video_jobs` table DDL — the durable async job store the Phase-189
 * background poller resumes against across a daemon restart (JOB-01/JOB-03).
 * A job row survives the agent turn AND a daemon restart because it lives on
 * disk in the shared `memory.db`, not in memory.
 *
 * Forward-only, re-run-safe: create-if-not-exists only, no destructive or
 * reverse DDL (design §9). Extracted from `schema.ts` (which is at the
 * 800-line cap) — `initSchema` CALLS this so the table exists on every boot.
 *
 * SECURITY (T-189-02): columns are the opaque provider jobId + routing + state +
 * cost + path + a `deliver_attempts` redelivery counter ONLY — no credential
 * column. Columns MUST match `VideoJobDbRowSchema` (video-job-row-schema.ts)
 * exactly — the strictObject rejects any drift.
 *
 * CR-01 (Phase-189 code review): `deliver_attempts` bounds the poller's
 * redelivery loop. A row whose channel delivery keeps failing is re-driven by
 * the sweeper every `pollIntervalMs`; without a persisted counter that re-poll +
 * re-download (up to 200 MB) repeats forever. The poller increments this column
 * per delivery attempt and dead-letters the row to `failed` once it exceeds
 * `maxDeliveryAttempts`. Persisted (not in-memory) so the bound survives the
 * sweeper rebuilding the in-flight set from `listPending()` each tick.
 *
 * `better-sqlite3` durability is WAL + path-based chmod (never fd-based file
 * sync), so this DDL is permission-model-safe by construction — no fd-fs guard
 * is needed (Pitfall 2 / [[node-permission-model-disables-fsync]]).
 *
 * @module
 */

import type Database from "better-sqlite3";

/**
 * Create the `video_jobs` table + its indexes idempotently.
 *
 * Safe to call multiple times (all DDL uses IF NOT EXISTS). Called from
 * `initSchema` so the table exists on every daemon boot.
 *
 * @param db - An open better-sqlite3 Database instance
 */
export function ensureVideoJobTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS video_jobs (
      job_id             TEXT PRIMARY KEY,
      provider           TEXT NOT NULL,
      model              TEXT,
      agent_id           TEXT NOT NULL,
      channel_type       TEXT,
      channel_id         TEXT,
      trace_id           TEXT,
      session_key        TEXT,
      state              TEXT NOT NULL,
      estimated_cost_usd REAL,
      actual_cost_usd    REAL,
      media_path         TEXT,
      progress           REAL,
      last_error         TEXT,
      deliver_attempts   INTEGER NOT NULL DEFAULT 0,
      submitted_at_ms    INTEGER NOT NULL,
      updated_at_ms      INTEGER NOT NULL
    )
  `);
  // OBS-04 (Phase 192): forward-only, re-run-safe migration for the
  // `session_key` column. `CREATE TABLE IF NOT EXISTS` is a no-op on a table that
  // a PRIOR v2.24 build (without this column) already created, so a fresh db gets
  // the column from the CREATE above while an upgraded db needs this ALTER. Guard
  // it with a `PRAGMA table_info` column-exists check so the ALTER runs at most
  // once and re-running ensureVideoJobTable never throws (a duplicate ADD COLUMN
  // would). The off-turn background poller resolves the per-session trajectory
  // recorder by this key to stitch a background-completed render to its turn.
  // PRAGMA table_info shape is the sanctioned inline-object cast (the
  // schema.ts:50 / schema-pinned.ts:22 column-exists precedent) — the
  // untyped-sqlite gate exempts `as { ... }[]` (a one-off PRAGMA projection, not
  // a domain row that needs the RowMapper); `as Array<{...}>` would trip it.
  const cols = new Set(
    (db.prepare(`PRAGMA table_info(video_jobs)`).all() as { name: string }[]).map((r) => r.name),
  );
  if (!cols.has("session_key")) {
    db.exec(`ALTER TABLE video_jobs ADD COLUMN session_key TEXT`);
  }
  // Partial index for the poller's listPending() boot-resume scan (JOB-03).
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_video_jobs_pending ON video_jobs (state) WHERE state = 'pending'`,
  );
  // Index for the agent-scoped get (JOB-04 / TARGET-01).
  db.exec(`CREATE INDEX IF NOT EXISTS idx_video_jobs_agent ON video_jobs (agent_id)`);
}
