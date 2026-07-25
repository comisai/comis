// SPDX-License-Identifier: Apache-2.0
/**
 * Observability-table migrations split out of `schema.ts` (which sits at the
 * 800-line cap) — the `schema-tuned-alpha.ts` / `schema-outcome-events.ts`
 * co-location precedent. `initSchema` CALLS these so they run on every boot,
 * AFTER the base `obs_token_usage` CREATE.
 *
 * Two migrations:
 *  - `ensureObsTokenColumns` — the forward-only `obs_token_usage` cost-correctness
 *    column upgrade + the dead `cache_retention` DROP.
 *  - `ensureObsAuditTable` — the dedicated `obs_audit_events` table + indexes.
 *
 * @module
 */

import type Database from "better-sqlite3";
import { requireTableInfoRows } from "./schema-introspection.js";

/**
 * Forward-only upgrade of `obs_token_usage` for the cost-correctness work.
 * Two parts, both idempotent:
 *
 * 1. DROP the dead `cache_retention` column (no event field ever populated it;
 *    the `retention_changed` cache-break reason is a DIFFERENT
 *    table). SQLite has no `DROP COLUMN`, so when the column is still present we run
 *    the standard transactional table-REBUILD (the `memory_usefulness` precedent in
 *    schema.ts): CREATE a `_new` table without it, `INSERT … SELECT` every other
 *    column VERBATIM (existing rows survive intact), DROP, RENAME, recreate the 4
 *    indexes. `obs_token_usage` has NO foreign key, so — unlike the
 *    `memory_usefulness` rebuild — no `foreign_keys` pragma bracketing is needed.
 *    Guarded by a presence check, so it is a no-op on an already-migrated DB.
 *
 * 2. ADD the 6 new columns via the `ensureMemoryColumns` guarded-ALTER idiom
 *    (`warmup_turn`/`cache_eligible` as INTEGER 0/1 flags, `cost_correction`/
 *    `pending_cache_investment_usd` as REAL, `pricing_state` as TEXT, and the
 *    `tool_tag` as TEXT — the JSON distinct-tool array). All nullable
 *    → O(1), no rewrite, no backfill (existing rows get NULL).
 *
 * Net post-condition (fresh OR existing DB): the 6 columns present, `cache_retention`
 * absent. Called AFTER the `obs_token_usage` CREATE in `initSchema`.
 *
 * @param db - An open better-sqlite3 Database whose `obs_token_usage` table exists.
 */
export function ensureObsTokenColumns(db: Database.Database): void {
  const cols = new Set(
    requireTableInfoRows(
      db.prepare(`PRAGMA table_info(obs_token_usage)`).all(),
      "obs_token_usage",
    ).map((row) => row.name),
  );

  // Part 1 — DROP the dead cache_retention column (rebuild; guarded so re-run-safe).
  if (cols.has("cache_retention")) {
    const rebuild = db.transaction(() => {
      db.exec(`
        CREATE TABLE obs_token_usage_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          timestamp INTEGER NOT NULL,
          trace_id TEXT NOT NULL,
          agent_id TEXT NOT NULL,
          channel_id TEXT DEFAULT '',
          session_key TEXT DEFAULT '',
          provider TEXT NOT NULL,
          model TEXT NOT NULL,
          prompt_tokens INTEGER NOT NULL,
          completion_tokens INTEGER NOT NULL,
          total_tokens INTEGER NOT NULL,
          cache_read_tokens INTEGER DEFAULT 0,
          cache_write_tokens INTEGER DEFAULT 0,
          cost_input REAL NOT NULL,
          cost_output REAL NOT NULL,
          cost_total REAL NOT NULL,
          cost_cache_read REAL NOT NULL DEFAULT 0,
          cost_cache_write REAL NOT NULL DEFAULT 0,
          cache_saved REAL NOT NULL DEFAULT 0,
          latency_ms INTEGER NOT NULL
        );
        INSERT INTO obs_token_usage_new (
          id, timestamp, trace_id, agent_id, channel_id, session_key,
          provider, model, prompt_tokens, completion_tokens, total_tokens,
          cache_read_tokens, cache_write_tokens, cost_input, cost_output, cost_total,
          cost_cache_read, cost_cache_write, cache_saved, latency_ms
        )
        SELECT
          id, timestamp, trace_id, agent_id, channel_id, session_key,
          provider, model, prompt_tokens, completion_tokens, total_tokens,
          cache_read_tokens, cache_write_tokens, cost_input, cost_output, cost_total,
          cost_cache_read, cost_cache_write, cache_saved, latency_ms
        FROM obs_token_usage;
        DROP TABLE obs_token_usage;
        ALTER TABLE obs_token_usage_new RENAME TO obs_token_usage;
        CREATE INDEX IF NOT EXISTS idx_obs_token_timestamp ON obs_token_usage(timestamp);
        CREATE INDEX IF NOT EXISTS idx_obs_token_agent ON obs_token_usage(agent_id, timestamp);
        CREATE INDEX IF NOT EXISTS idx_obs_token_provider ON obs_token_usage(provider, timestamp);
        CREATE INDEX IF NOT EXISTS idx_obs_token_session ON obs_token_usage(session_key, timestamp);
      `);
    });
    rebuild();
  }

  // Part 2 — ADD the 5 cost-correctness columns (guarded, nullable → O(1) ADD).
  // Re-probe after the rebuild (the rebuilt table has none of them yet).
  const cols2 = new Set(
    requireTableInfoRows(
      db.prepare(`PRAGMA table_info(obs_token_usage)`).all(),
      "obs_token_usage",
    ).map((row) => row.name),
  );
  if (!cols2.has("warmup_turn")) db.exec(`ALTER TABLE obs_token_usage ADD COLUMN warmup_turn INTEGER`);
  if (!cols2.has("cache_eligible")) db.exec(`ALTER TABLE obs_token_usage ADD COLUMN cache_eligible INTEGER`);
  if (!cols2.has("cost_correction")) db.exec(`ALTER TABLE obs_token_usage ADD COLUMN cost_correction REAL`);
  if (!cols2.has("pending_cache_investment_usd"))
    db.exec(`ALTER TABLE obs_token_usage ADD COLUMN pending_cache_investment_usd REAL`);
  if (!cols2.has("pricing_state")) db.exec(`ALTER TABLE obs_token_usage ADD COLUMN pricing_state TEXT`);
  // The per-turn tool tag — the IDENTICAL 6th additive,
  // forward-only, nullable ALTER (no migration framework, no dual-read shim).
  // Stores the JSON-stringified DISTINCT tool array (content-free names only);
  // NULL on existing rows (they survive verbatim) and on no-tool turns.
  if (!cols2.has("tool_tag")) db.exec(`ALTER TABLE obs_token_usage ADD COLUMN tool_tag TEXT`);
}

/**
 * Create the dedicated `obs_audit_events` security-audit table + its two indexes.
 * A DEDICATED table (not `obs_diagnostics`) — distinct retention +
 * actor/outcome/severity attribution columns + a regulatory grep surface. The
 * sink resolves `tenant_id` from the trace context else persists the `''`
 * system-scope sentinel (`tenant_id` is NOT NULL); `agent_id` stays NULL when
 * absent. `refs` is a scrubbed JSON blob. This module owns the DDL + the
 * `AuditEventRow` type; the insert/query methods + JSONL writer live elsewhere.
 * Idempotent (`CREATE … IF NOT EXISTS`).
 *
 * @param db - An open better-sqlite3 Database.
 */
export function ensureObsAuditTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS obs_audit_events (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      agent_id TEXT,
      ts INTEGER NOT NULL,
      kind TEXT NOT NULL,
      classification TEXT,
      action TEXT,
      actor TEXT,
      outcome TEXT,
      severity TEXT,
      trace_id TEXT,
      refs TEXT
    );
    CREATE INDEX IF NOT EXISTS obs_audit_scope ON obs_audit_events(tenant_id, agent_id, ts);
    CREATE INDEX IF NOT EXISTS obs_audit_kind  ON obs_audit_events(kind, ts);
  `);
}
