// SPDX-License-Identifier: Apache-2.0
/**
 * The `outward_send_ledger` table DDL — the three-state exactly-once outward-send
 * ledger the resume engine reconciles on boot.
 * A send-intent is persisted HERE, on disk in the shared `memory.db`, BEFORE the
 * irreversible chat-platform call, so a daemon CRASH mid-send leaves a durable,
 * reconcilable trace rather than a lost message OR a blind replay (a second
 * 10,000-user DM blast on restart).
 *
 * Forward-only, re-run-safe: create-if-not-exists only, no destructive or reverse
 * DDL. Extracted from `schema.ts` (which is at the 800-line cap) —
 * `initSchema` CALLS this so the table exists on every boot (a table
 * defined here but not wired into initSchema is MISSING at runtime).
 *
 * THE IDEMPOTENCY KEY: the UNIQUE index
 * `idx_osl_idempotency` on `(root_run_id, step_index)` is what makes the send
 * exactly-once. The `step_index` half is allocated by the durable_runs
 * `allocateOutwardStep` monotonic counter, so a REPLAYED step collides
 * on this index — a second `begin` is an err the wrap site treats as
 * "already in flight, do NOT double-send". This store has NO blind
 * `in_flight → pending` bulk reset (the `delivery-queue-adapter.ts:141-145`
 * bulk-reset anti-pattern): recovery is PER-ROW via the
 * `listUnreconciled` scan → the engine asks the platform `reconcileSend?`,
 * never a blanket UPDATE.
 *
 * SECURITY — CONTENT-FREE (mirrors video_jobs / durable_runs):
 * `content_digest` is a sha256 set by the caller and is the ONLY
 * content trace. There is deliberately NO `body` / `text` / `message` column and
 * NO secret / token / bearer / api_key column — the reconcile matches on the
 * digest + a time window, NEVER the message text. A recipient list
 * is routing only (`channel_id`), never a stored secret.
 *
 * `better-sqlite3` durability is WAL + path-based chmod (never fd-based file
 * sync), so this DDL is permission-model-safe by construction — no fd-fs guard
 * is needed (mirrors video_jobs / durable_runs / [[node-permission-model-disables-fsync]]).
 *
 * @module
 */

import type Database from "better-sqlite3";

/**
 * Create the `outward_send_ledger` table + its UNIQUE idempotency index and the
 * partial recovery-scan index idempotently.
 *
 * Safe to call multiple times (all DDL uses IF NOT EXISTS). Called from
 * `initSchema` so the table exists on every daemon boot.
 *
 * @param db - An open better-sqlite3 Database instance
 */
export function ensureOutwardLedgerTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS outward_send_ledger (
      id                  TEXT PRIMARY KEY,
      root_run_id         TEXT NOT NULL,
      step_index          INTEGER NOT NULL,
      agent_id            TEXT NOT NULL,
      channel_type        TEXT NOT NULL,
      channel_id          TEXT NOT NULL,
      state               TEXT NOT NULL CHECK(state IN ('send_attempt_started','unknown_after_send','committed','failed','unresolved')),
      platform_message_id TEXT,
      content_digest      TEXT NOT NULL,
      reconcile_outcome   TEXT,
      attempt_count       INTEGER NOT NULL DEFAULT 0,
      last_error          TEXT,
      created_at_ms       INTEGER NOT NULL,
      updated_at_ms       INTEGER NOT NULL
    )
  `);
  // The idempotency key. A replayed (root_run_id, step_index)
  // collides here, so a second begin() is the "already in flight" err — there is
  // NO second outward send.
  db.exec(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_osl_idempotency ON outward_send_ledger(root_run_id, step_index)`,
  );
  // The partial recovery-scan index — serves listUnreconciled(), which
  // returns ONLY the still-in-flight rows the boot reconcile loop must resolve.
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_osl_unknown ON outward_send_ledger(state) WHERE state IN ('unknown_after_send','send_attempt_started')`,
  );
}
