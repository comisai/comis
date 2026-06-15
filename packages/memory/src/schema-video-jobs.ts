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
 * cost + path ONLY — no credential column. Columns MUST match
 * `VideoJobDbRowSchema` (video-job-row-schema.ts) exactly — the strictObject
 * rejects any drift.
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
      state              TEXT NOT NULL,
      estimated_cost_usd REAL,
      actual_cost_usd    REAL,
      media_path         TEXT,
      progress           REAL,
      last_error         TEXT,
      submitted_at_ms    INTEGER NOT NULL,
      updated_at_ms      INTEGER NOT NULL
    )
  `);
  // Partial index for the poller's listPending() boot-resume scan (JOB-03).
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_video_jobs_pending ON video_jobs (state) WHERE state = 'pending'`,
  );
  // Index for the agent-scoped get (JOB-04 / TARGET-01).
  db.exec(`CREATE INDEX IF NOT EXISTS idx_video_jobs_agent ON video_jobs (agent_id)`);
}
