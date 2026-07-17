// SPDX-License-Identifier: Apache-2.0
/**
 * The `outcome_events` ledger DDL — the durable record of a finished
 * trajectory's net task-outcome. Every row is
 * one raw observation from one signal source (tool / pipeline / correction /
 * judge / reaction / explicit); `resolve()` fuses all rows for a trajectory into
 * one verdict (precedence-first then confidence).
 *
 * Forward-only, re-run-safe: `CREATE TABLE IF NOT EXISTS` + `CREATE INDEX IF NOT
 * EXISTS` only — no destructive or reverse DDL, no branch on an old shape
 * (additive). Extracted from `schema.ts` (which is at the 800-line cap), like
 * `schema-video-jobs.ts` — `initSchema` CALLS this so the table exists on every
 * boot.
 *
 * IDEMPOTENCY: the `id` is a deterministic sha256 hash of the UNIQUE tuple
 * `(tenant_id, agent_id, trajectory_id, source, observed_at)` computed in the
 * store before insert, AND the table carries a `UNIQUE (…)` backstop on that
 * tuple — a replayed observation is a no-op at BOTH layers (the store inserts
 * `ON CONFLICT … DO NOTHING`).
 *
 * SECURITY: `(tenant_id, agent_id)` are bare `NOT NULL`
 * columns and lead every key/index — the store filters EVERY statement on them,
 * so a row under one (tenant, agent) is never visible to a read under another in
 * the multi-agent DB. No trust column exists: `confidence` /
 * `sender_trust` are descriptive, never authorization. No message bodies are
 * stored — ids + closed enums + confidence only (content-free). `procedure_descriptor`
 * holds ONLY a JSON array of content-free tool NAMES (the pre-flight footprint) —
 * never args/bodies/secrets — and is NOT part of any key/index (the sha256 id tuple
 * is untouched).
 *
 * `better-sqlite3` durability is WAL + path-based chmod (never fd-based file
 * sync), so this DDL is permission-model-safe by construction — no fd-fs guard is
 * needed ([[node-permission-model-disables-fsync]]).
 *
 * @module
 */

import type Database from "better-sqlite3";
import { requireTableInfoRows } from "./schema-introspection.js";

/**
 * Create the `outcome_events` table + its scope index idempotently.
 *
 * Safe to call multiple times (all DDL uses IF NOT EXISTS). Called from
 * `initSchema` so the table exists on every daemon boot. The `CHECK` constraints
 * pin the `outcome` / `source` closed enums; the `UNIQUE (…)` is the idempotency
 * backstop; the index serves the scoped `resolve()` read.
 *
 * @param db - An open better-sqlite3 Database instance
 */
export function ensureOutcomeEventsTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS outcome_events (
      id              TEXT PRIMARY KEY,
      tenant_id       TEXT NOT NULL,
      agent_id        TEXT NOT NULL,
      session_id      TEXT NOT NULL,
      trajectory_id   TEXT NOT NULL,
      outcome         TEXT NOT NULL CHECK (outcome IN ('success','failure','corrected','unknown')),
      source          TEXT NOT NULL CHECK (source IN ('tool','pipeline','correction','judge','reaction','explicit')),
      confidence      REAL NOT NULL DEFAULT 0.5,
      sender_trust    TEXT,
      recalled_ids    TEXT,
      used_skill_ids  TEXT,
      procedure_descriptor TEXT,
      observed_at     INTEGER NOT NULL,
      UNIQUE (tenant_id, agent_id, trajectory_id, source, observed_at)
    );
    CREATE INDEX IF NOT EXISTS outcome_events_scope ON outcome_events(tenant_id, agent_id, trajectory_id);
  `);
  // Forward-only, re-run-safe migration for the `procedure_descriptor` column.
  // `CREATE TABLE IF NOT EXISTS` is a no-op on a table a PRIOR build (without this
  // column) already created, so a fresh db gets the column from the CREATE above
  // while an already-created `~/.comis/memory.db` needs this ALTER. Guard it with a
  // `PRAGMA table_info` column-exists check so the ALTER runs at most once and
  // re-running ensureOutcomeEventsTable never throws (a duplicate ADD COLUMN would).
  // The additive column is nullable — every prior row reads back NULL (no descriptor).
  // The sha256 id tuple `(tenant_id, agent_id, trajectory_id, source, observed_at)` is
  // UNTOUCHED — the descriptor is a content-free attribution column, in no key/index.
  const cols = new Set(
    requireTableInfoRows(
      db.prepare(`PRAGMA table_info(outcome_events)`).all(),
      "outcome_events",
    ).map((row) => row.name),
  );
  if (!cols.has("procedure_descriptor")) {
    db.exec(`ALTER TABLE outcome_events ADD COLUMN procedure_descriptor TEXT`);
  }
}
