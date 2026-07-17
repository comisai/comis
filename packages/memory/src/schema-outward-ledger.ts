// SPDX-License-Identifier: Apache-2.0
/**
 * The `outward_send_ledger` table DDL — the outward-send uncertainty ledger the
 * resume engine parks on boot.
 * A send-intent is persisted HERE, on disk in the shared `memory.db`, BEFORE the
 * irreversible chat-platform call, so a daemon crash mid-send leaves a durable
 * uncertainty trace that startup can park and escalate without another
 * platform call.
 *
 * Forward-only, re-run-safe: create-if-not-exists only, no destructive or reverse
 * DDL. Extracted from `schema.ts` (which is at the 800-line cap) —
 * `initSchema` CALLS this so the table exists on every boot (a table
 * defined here but not wired into initSchema is MISSING at runtime).
 *
 * THE IDEMPOTENCY KEY: the UNIQUE index
 * `idx_osl_idempotency` on `(root_run_id, step_index)` is what makes the send
 * stable across repeated calls using one logical operation identity. The
 * `step_index` half is allocated by the outward ledger's `allocateStep`
 * monotonic counter, so a repeated step collides
 * on this index — a second `begin` is an err the wrap site treats as
 * "already in flight, do NOT double-send". This store has NO blind
 * `in_flight → pending` bulk reset (the `delivery-queue-adapter.ts:141-145`
 * bulk-reset anti-pattern): recovery is PER-ROW via the
 * `listUnreconciled` scan → the engine atomically parks each uncertain row,
 * never a blanket UPDATE or a second platform call.
 *
 * SECURITY — CONTENT-FREE (mirrors video_jobs / durable_run_checkpoints):
 * `content_digest` is a sha256 set by the caller and is the ONLY
 * content trace. There is deliberately NO `body` / `text` / `message` column and
 * NO secret / token / bearer / api_key column. Operation-identity checks use the
 * immutable fingerprint, never the message text. A recipient list
 * is routing only (`channel_id`), never a stored secret.
 *
 * `better-sqlite3` durability is WAL + path-based chmod (never fd-based file
 * sync), so this DDL is permission-model-safe by construction — no fd-fs guard
 * is needed (mirrors video_jobs / durable_run_checkpoints / [[node-permission-model-disables-fsync]]).
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
      operation_kind      TEXT NOT NULL CHECK(operation_kind IN ('message_send','message_reply','message_react','cross_session_announcement')),
      operation_fingerprint TEXT NOT NULL,
      state               TEXT NOT NULL CHECK(state IN ('send_attempt_started','unknown_after_send','committed','failed','unresolved')),
      platform_message_id TEXT,
      content_digest      TEXT NOT NULL,
      reconcile_outcome   TEXT CHECK(reconcile_outcome IS NULL OR reconcile_outcome = 'unresolved'),
      attempt_count       INTEGER NOT NULL DEFAULT 0,
      last_error          TEXT,
      created_at_ms       INTEGER NOT NULL,
      updated_at_ms       INTEGER NOT NULL
    )
  `);
  // The idempotency key. A repeated (root_run_id, step_index)
  // collides here, so a second begin() is the "already in flight" err — there is
  // NO second outward send.
  db.exec(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_osl_idempotency ON outward_send_ledger(root_run_id, step_index)`,
  );
  // The partial recovery-scan index serves listUnreconciled(), which returns
  // only the still-in-flight rows the boot recovery loop must park.
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_osl_unknown ON outward_send_ledger(state) WHERE state IN ('unknown_after_send','send_attempt_started')`,
  );
  db.exec(`
    CREATE TABLE IF NOT EXISTS outward_send_sequences (
      root_run_id         TEXT PRIMARY KEY,
      last_step_index     INTEGER NOT NULL,
      updated_at_ms       INTEGER NOT NULL
    )
  `);
  // A caller's logical operation keeps one stable sequence across transport
  // retries and process restarts. operation_id stores only the SHA-256 digest
  // of the canonical identity; caller-controlled text never enters this table.
  db.exec(`
    CREATE TABLE IF NOT EXISTS outward_send_operations (
      root_run_id         TEXT NOT NULL,
      operation_id       TEXT NOT NULL CHECK(length(operation_id) = 64 AND operation_id NOT GLOB '*[^0-9a-f]*'),
      step_index         INTEGER NOT NULL,
      created_at_ms      INTEGER NOT NULL,
      updated_at_ms      INTEGER NOT NULL,
      PRIMARY KEY (root_run_id, operation_id),
      UNIQUE (root_run_id, step_index)
    )
  `);
}
