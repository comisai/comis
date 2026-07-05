// SPDX-License-Identifier: Apache-2.0
/**
 * The `msteams_conversation_refs` table DDL — the persisted map from a
 * conversation id to its routing tuple `{serviceUrl, tenantId, threadId?}`.
 * A reply rides the inbound activity's own routing; a PROACTIVE send (cron,
 * heartbeat, an unsolicited notice) has no inbound activity, so it recovers the
 * routing from HERE, on disk in the shared `memory.db`. The row is upserted on
 * every inbound activity so the freshest tuple is always stored.
 *
 * Forward-only, re-run-safe: create-if-not-exists only, no destructive or reverse
 * DDL. `initSchema` CALLS this so the table exists on every boot — a table defined
 * here but not wired into initSchema is MISSING at runtime.
 *
 * THE KEY: `key` is `sha256(conversation_id)` (the store hashes the id), so the PK
 * is a fixed-width digest regardless of the platform id's length or shape. The
 * `idx_msteams_conv_updated` index on `updated_at_ms` serves the TTL prune (delete
 * everything older than the window) and the cap eviction (keep the N most-recently
 * updated) the store runs on every capture, so the table cannot grow unbounded.
 *
 * SECURITY — routing columns ONLY (`conversation_id`, `service_url`, `tenant_id`,
 * `thread_id`, `updated_at_ms`): the stored `service_url`/`tenant_id` are routing,
 * not credentials, and there is deliberately NO credential column and NO
 * message-content column. The strictObject row schema REJECTS an extra column if
 * the DDL ever drifts. A persisted `service_url` stays untrusted until the send
 * path re-validates it against the host allowlist.
 *
 * `better-sqlite3` durability is WAL + path-based chmod (never fd-based file sync),
 * so this DDL is permission-model-safe by construction — no fd-fs guard is needed.
 *
 * @module
 */

import type Database from "better-sqlite3";

/**
 * Create the `msteams_conversation_refs` table + the `updated_at_ms` index that
 * serves the TTL prune + cap eviction idempotently.
 *
 * Safe to call multiple times (all DDL uses IF NOT EXISTS). Called from
 * `initSchema` so the table exists on every daemon boot.
 *
 * @param db - An open better-sqlite3 Database instance
 */
export function ensureMsTeamsConversationTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS msteams_conversation_refs (
      key             TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      service_url     TEXT NOT NULL,
      tenant_id       TEXT NOT NULL,
      thread_id       TEXT,
      updated_at_ms   INTEGER NOT NULL
    )
  `);
  // Serves both the TTL prune (updated_at_ms < now - TTL) and the cap eviction
  // (ORDER BY updated_at_ms DESC LIMIT CAP) the store runs on every capture.
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_msteams_conv_updated ON msteams_conversation_refs(updated_at_ms)`,
  );
}
