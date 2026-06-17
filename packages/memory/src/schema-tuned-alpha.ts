// SPDX-License-Identifier: Apache-2.0
/**
 * The per-intent `tuned_alpha` migration — the v2.26 Verified Learning (WS3,
 * RANK-05) transactional PK-widening REBUILD that widens the legacy 2-col PK
 * `(tenant_id, agent_id)` to the per-intent 3-col `(tenant_id, agent_id, intent)`
 * and adds the RESERVED posterior-slot columns `outcome_reward_sum` / `outcome_n`.
 * Plus the `memory_usefulness.failure_count` per-column add (FORGET-02) — the
 * outcome-attributed task-failure signal, DISTINCT from `ignored_count`
 * (recalled-but-not-cited).
 *
 * ## The `outcome_reward_sum` / `outcome_n` columns are RESERVED/INERT in v1 (WR-04)
 *
 * They are written 0 on every upsert and read by NOBODY. The bandit derives its
 * posterior LIVE from the `memory_usefulness` feed (used/ignored − the WR-03 failure
 * term) in the offline job's `aggregateFeed`, NOT from these columns. They are a
 * forward-compatible slot for a future durable cross-run posterior, kept here so the
 * PK-widening REBUILD lands them once rather than via a later table churn — NOT the
 * current reward path. Do NOT build a reader against them expecting a live posterior.
 *
 * Extracted from `schema.ts` (which is at the 800-line cap) — the
 * `schema-outcome-events.ts` co-location precedent. `initSchema` CALLS the two
 * ensure fns so the migrations run on every boot.
 *
 * ## Why a REBUILD, not `ADD COLUMN intent`
 *
 * SQLite has NO `ALTER ADD PRIMARY KEY`. A bare `ADD COLUMN intent` leaves the PK
 * 2-col, so the adapter's 3-col `ON CONFLICT(tenant_id, agent_id, intent)` would
 * abort the SECOND intent bucket's upsert with `UNIQUE constraint failed`. So a
 * pre-intent DB runs the standard SQLite transactional table REBUILD (mirrors
 * `ensureUsefulnessTable` VERBATIM): create a `_new` table with the genuine 3-col
 * PK, copy EVERY row into the `''` global bucket (`COALESCE(intent,'')` — no
 * loss/corruption), drop, rename. Re-run-safe (3-col PK present → skip).
 *
 * ## Belt #3 survives the rebuild (RANK-04)
 *
 * The `_new` table DDL carries ONLY the 4 tunable boost alphas + `intent` +
 * `outcome_reward_sum` + `outcome_n` + `updated_at` — and NO trust-weight column.
 * The bandit can never move the trust weight; it stays config-sourced at the
 * apply site. The fifth (trust-weight) column name is deliberately never written
 * in this DDL (the grep-0 belt, asserted in schema-tuned-alpha.test.ts).
 *
 * `better-sqlite3` durability is WAL + path-based chmod (never fd-based file
 * sync), so this DDL is permission-model-safe by construction — no fd-fs guard is
 * needed ([[node-permission-model-disables-fsync]]).
 *
 * @module
 */

import type Database from "better-sqlite3";

/**
 * Idempotently ensure the `tuned_alpha` table is per-intent (3-col PK) with the
 * RESERVED posterior-slot columns (`outcome_reward_sum`/`outcome_n` — INERT in v1,
 * see the module JSDoc). A FRESH DB gets the 3-col PK directly from
 * `CREATE TABLE`; a pre-intent (legacy 2-col-PK) DB is REBUILT to widen the PK
 * (ADD COLUMN cannot). Re-run-safe: when the 3-col PK is already present the
 * rebuild is skipped, so a second call is a no-op.
 *
 * @param db - An open better-sqlite3 Database instance. NO FK to `memories`
 *   (per-scope CONFIG state) — the foreign_keys toggle is harmless but kept to
 *   mirror the `ensureUsefulnessTable` precedent.
 */
export function ensureTunedAlphaIntent(db: Database.Database): void {
  // FRESH DB: the genuine 3-col PK + intent + the 2 bandit-posterior columns. An
  // EXISTING (legacy 2-col-PK) DB: no-op here (the PK-shape rebuild below widens it).
  db.exec(`
    CREATE TABLE IF NOT EXISTS tuned_alpha (
      tenant_id          TEXT NOT NULL,
      agent_id           TEXT NOT NULL,
      recency_alpha      REAL NOT NULL,
      temporal_alpha     REAL NOT NULL,
      proof_alpha        REAL NOT NULL,
      usefulness_alpha   REAL NOT NULL,
      intent             TEXT NOT NULL DEFAULT '',
      outcome_reward_sum REAL NOT NULL DEFAULT 0,
      outcome_n          INTEGER NOT NULL DEFAULT 0,
      updated_at         INTEGER NOT NULL,
      PRIMARY KEY (tenant_id, agent_id, intent)
    );
  `);

  // Detect a pre-intent (legacy or partially-migrated) table by its PK shape
  // (`pk>0` marks a PK member). The object-literal cast is the sanctioned PRAGMA
  // idiom, NOT `as Foo[]` (untyped-sqlite.test.ts targets named-type casts).
  const tableInfo = db
    .prepare(`PRAGMA table_info(tuned_alpha)`)
    .all() as { name: string; pk: number }[];
  const pkHasIntent = tableInfo.some((c) => c.pk > 0 && c.name === "intent");
  if (!pkHasIntent) {
    // EXISTING (pre-intent) DB: REBUILD to genuinely widen the PK to 3-col. A
    // legacy table has NO `intent` column (copy the '' literal); a
    // partially-migrated one (column present, PK still 2-col) COALESCEs it. The
    // pre-intent table also lacks the bandit-posterior columns → backfill them to
    // 0 via the SELECT constants. Toggle foreign_keys OFF around the rename (the
    // pragma is a no-op INSIDE a txn, so it MUST bracket db.transaction).
    const hasIntentCol = tableInfo.some((c) => c.name === "intent");
    const intentSelectExpr = hasIntentCol ? "COALESCE(intent, '')" : "''";
    const fkWasOn = db.pragma("foreign_keys", { simple: true }) === 1;
    if (fkWasOn) db.pragma("foreign_keys = OFF");
    const rebuild = db.transaction(() => {
      db.exec(`
        CREATE TABLE tuned_alpha_new (
          tenant_id          TEXT NOT NULL,
          agent_id           TEXT NOT NULL,
          recency_alpha      REAL NOT NULL,
          temporal_alpha     REAL NOT NULL,
          proof_alpha        REAL NOT NULL,
          usefulness_alpha   REAL NOT NULL,
          intent             TEXT NOT NULL DEFAULT '',
          outcome_reward_sum REAL NOT NULL DEFAULT 0,
          outcome_n          INTEGER NOT NULL DEFAULT 0,
          updated_at         INTEGER NOT NULL,
          PRIMARY KEY (tenant_id, agent_id, intent)
        );
        INSERT INTO tuned_alpha_new
          (tenant_id, agent_id, recency_alpha, temporal_alpha, proof_alpha, usefulness_alpha, intent, outcome_reward_sum, outcome_n, updated_at)
          SELECT tenant_id, agent_id, recency_alpha, temporal_alpha, proof_alpha, usefulness_alpha, ${intentSelectExpr}, 0, 0, updated_at FROM tuned_alpha;
        DROP TABLE tuned_alpha;
        ALTER TABLE tuned_alpha_new RENAME TO tuned_alpha;
      `);
    });
    rebuild();
    // Restore the pragma. No foreign_key_check needed: tuned_alpha has no FK
    // (per-scope CONFIG state), and the INSERT…SELECT copies rows verbatim.
    if (fkWasOn) db.pragma("foreign_keys = ON");
  }
}

/**
 * Idempotently ensure `memory_usefulness` carries the `failure_count` column —
 * the outcome-attributed task-failure signal (FORGET-02). DISTINCT from
 * `ignored_count` (recalled-but-not-cited, a usage proxy): a correct-but-unused
 * memory accrues `ignored_count`, never `failure_count`. The per-column
 * `ensureMemoryColumns` idiom: a `PRAGMA table_info` presence guard, then an
 * `ADD COLUMN ... NOT NULL DEFAULT 0` (O(1), constant default — never NULL for a
 * count). Forward-only, re-run-safe.
 *
 * @param db - An open better-sqlite3 Database whose `memory_usefulness` table
 *   already exists (call AFTER `ensureUsefulnessTable` in `initSchema`).
 */
export function ensureUsefulnessFailureColumn(db: Database.Database): void {
  const cols = new Set(
    (db.prepare(`PRAGMA table_info(memory_usefulness)`).all() as { name: string }[]).map(
      (r) => r.name,
    ),
  );
  if (!cols.has("failure_count")) {
    db.exec(`ALTER TABLE memory_usefulness ADD COLUMN failure_count INTEGER NOT NULL DEFAULT 0`);
  }
}
