// SPDX-License-Identifier: Apache-2.0
// @allow-throw: validated schema-upgrade rows must abort and roll back the surrounding better-sqlite3 transaction when the retained table is malformed.
/**
 * The `outward_send_ledger` table DDL — the outward-send uncertainty ledger the
 * resume engine parks on boot.
 * A send-intent is persisted HERE, on disk in the shared `memory.db`, BEFORE the
 * irreversible chat-platform call, so a daemon crash mid-send leaves a durable
 * uncertainty trace that startup can park and escalate without another
 * platform call.
 *
 * Forward-only and re-run-safe: a current table is create-if-not-exists. When
 * the table exists without operation-identity columns, a transaction validates
 * every retained row, copies it into the current constrained shape, and swaps
 * the table atomically. Committed rows keep their platform receipts; rows whose
 * outcome cannot be proven are parked as unresolved. `initSchema` CALLS this so
 * the table exists in the current shape on every boot.
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
 * `content_digest` is the ONLY content trace. New rows carry the caller's full
 * SHA-256; a retained short digest is itself SHA-256-hashed during the structural
 * upgrade so the current shape remains content-free and collision-resistant.
 * There is deliberately NO `body` / `text` / `message` column and NO secret /
 * token / bearer / api_key column. Operation-identity checks use the immutable
 * fingerprint, never the message text. A recipient list is routing only
 * (`channel_id`), never a stored secret.
 *
 * `better-sqlite3` durability is WAL + path-based chmod (never fd-based file
 * sync), so this DDL is permission-model-safe by construction — no fd-fs guard
 * is needed (mirrors video_jobs / durable_run_checkpoints / [[node-permission-model-disables-fsync]]).
 *
 * @module
 */

import type Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { z } from "zod";
import { createRowMapper } from "./sqlite-row-mapper.js";
import { requireTableInfoRows } from "./schema-introspection.js";

const RetainedOutwardLedgerRowSchema = z.strictObject({
  id: z.string().min(1),
  root_run_id: z.string().min(1),
  step_index: z.number().int().nonnegative(),
  agent_id: z.string().min(1),
  channel_type: z.string().min(1),
  channel_id: z.string().min(1),
  state: z.enum([
    "send_attempt_started",
    "unknown_after_send",
    "committed",
    "failed",
    "unresolved",
  ]),
  platform_message_id: z.string().nullable(),
  content_digest: z.string().regex(/^(?:[0-9a-f]{16}|[0-9a-f]{64})$/),
  reconcile_outcome: z.enum(["sent", "not_sent", "unresolved"]).nullable(),
  attempt_count: z.number().int().nonnegative(),
  last_error: z.string().nullable(),
  created_at_ms: z.number().int().nonnegative(),
  updated_at_ms: z.number().int().nonnegative(),
});

type RetainedOutwardLedgerRow = z.infer<typeof RetainedOutwardLedgerRowSchema>;

const retainedOutwardLedgerMapper = createRowMapper(RetainedOutwardLedgerRowSchema);

function retainedDigest(row: RetainedOutwardLedgerRow): string {
  if (row.content_digest.length === 64) return row.content_digest;
  return createHash("sha256")
    .update(`retained-content-digest:${row.content_digest}`, "utf8")
    .digest("hex");
}

function retainedFingerprint(row: RetainedOutwardLedgerRow): string {
  return createHash("sha256")
    .update(JSON.stringify({
      kind: "retained_unclassified",
      id: row.id,
      rootRunId: row.root_run_id,
      stepIndex: row.step_index,
      agentId: row.agent_id,
      channelType: row.channel_type,
      channelId: row.channel_id,
      contentDigest: row.content_digest,
    }), "utf8")
    .digest("hex");
}

function retainedState(row: RetainedOutwardLedgerRow): {
  state: "committed" | "failed" | "unresolved";
  platformMessageId: string | null;
  reconcileOutcome: "unresolved" | null;
  lastError: string | null;
} {
  if (
    row.state === "committed"
    && typeof row.platform_message_id === "string"
    && row.platform_message_id.length > 0
  ) {
    return {
      state: "committed",
      platformMessageId: row.platform_message_id,
      reconcileOutcome: null,
      lastError: null,
    };
  }
  if (row.state === "failed" && typeof row.last_error === "string" && row.last_error.length > 0) {
    return {
      state: "failed",
      platformMessageId: null,
      reconcileOutcome: null,
      lastError: row.last_error,
    };
  }
  return {
    state: "unresolved",
    platformMessageId: null,
    reconcileOutcome: "unresolved",
    lastError: null,
  };
}

function upgradeRetainedOutwardLedger(db: Database.Database): void {
  const columns = new Set(
    requireTableInfoRows(
      db.prepare(`PRAGMA table_info(outward_send_ledger)`).all(),
      "outward_send_ledger",
    ).map((row) => row.name),
  );
  if (columns.has("operation_kind") && columns.has("operation_fingerprint")) return;

  const parsed = retainedOutwardLedgerMapper.parseRows(db.prepare(`
    SELECT
      id, root_run_id, step_index, agent_id, channel_type, channel_id,
      state, platform_message_id, content_digest, reconcile_outcome,
      attempt_count, last_error, created_at_ms, updated_at_ms
    FROM outward_send_ledger
    ORDER BY created_at_ms ASC, root_run_id ASC, step_index ASC
  `).all());
  if (!parsed.ok) {
    throw new Error(`Retained outward ledger validation failed: ${parsed.error.message}`);
  }

  const replace = db.transaction((rows: RetainedOutwardLedgerRow[]) => {
    db.exec(`
      DROP TABLE IF EXISTS outward_send_ledger_next;
      CREATE TABLE outward_send_ledger_next (
        id                    TEXT PRIMARY KEY,
        root_run_id           TEXT NOT NULL,
        step_index            INTEGER NOT NULL,
        agent_id              TEXT NOT NULL,
        channel_type          TEXT NOT NULL,
        channel_id            TEXT NOT NULL,
        operation_kind        TEXT NOT NULL CHECK(operation_kind IN ('message_send','message_reply','message_react','cross_session_announcement','retained_unclassified')),
        operation_fingerprint TEXT NOT NULL,
        state                 TEXT NOT NULL CHECK(state IN ('send_attempt_started','unknown_after_send','committed','failed','unresolved')),
        platform_message_id   TEXT,
        content_digest        TEXT NOT NULL,
        reconcile_outcome     TEXT CHECK(reconcile_outcome IS NULL OR reconcile_outcome = 'unresolved'),
        attempt_count         INTEGER NOT NULL DEFAULT 0,
        last_error            TEXT,
        created_at_ms         INTEGER NOT NULL,
        updated_at_ms         INTEGER NOT NULL
      );
    `);
    const insert = db.prepare(`
      INSERT INTO outward_send_ledger_next (
        id, root_run_id, step_index, agent_id, channel_type, channel_id,
        operation_kind, operation_fingerprint, state, platform_message_id,
        content_digest, reconcile_outcome, attempt_count, last_error,
        created_at_ms, updated_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, 'retained_unclassified', ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const row of rows) {
      const normalized = retainedState(row);
      insert.run(
        row.id,
        row.root_run_id,
        row.step_index,
        row.agent_id,
        row.channel_type,
        row.channel_id,
        retainedFingerprint(row),
        normalized.state,
        normalized.platformMessageId,
        retainedDigest(row),
        normalized.reconcileOutcome,
        row.attempt_count,
        normalized.lastError,
        row.created_at_ms,
        row.updated_at_ms,
      );
    }
    db.exec(`
      DROP TABLE outward_send_ledger;
      ALTER TABLE outward_send_ledger_next RENAME TO outward_send_ledger;
    `);
  });
  replace.immediate(parsed.value);
}

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
      operation_kind      TEXT NOT NULL CHECK(operation_kind IN ('message_send','message_reply','message_react','cross_session_announcement','retained_unclassified')),
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
  upgradeRetainedOutwardLedger(db);
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
