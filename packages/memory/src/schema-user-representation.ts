// SPDX-License-Identifier: Apache-2.0
import type Database from "better-sqlite3";

/**
 * v2.26 WS5 REVISE-02: additively give `user_representation` the four bi-temporal
 * columns the trust-first soft-close revision needs — mirroring `memory_triples`'s
 * shape (`schema.ts:316-342`) via the per-column `PRAGMA table_info` guard
 * (`ensurePinnedColumn` `schema-pinned.ts:18` precedent). SQLite has no
 * `ADD COLUMN IF NOT EXISTS`, so each add is presence-guarded. Forward-only,
 * O(1) nullable adds, safe on every boot including a live `~/.comis` DB created
 * before the columns existed:
 * - `t_valid_start` (valid-time start): backfilled to `created_at` for pre-existing
 *   rows (deterministic — current rows become valid-since-creation), so the asOf
 *   valid-time read has a lower bound on every row.
 * - `t_valid_end` (valid-time end): NULL = currently believed (the default recall
 *   filter, mirror `t_valid_end IS NULL`); a non-NULL value = soft-closed/superseded.
 * - `expired_at` (txn/record-time end): the record-time axis end-stamp.
 * - `confidence` (REAL): the corroboration bump target — a same-belief candidate
 *   strictly raises this in place, NEVER inserting a new current-truth row.
 *
 * The `idx_user_repr_current` partial index (on `t_valid_end IS NULL`) mirrors
 * `idx_triples_current` (`schema.ts:336`) — it serves the current-truth incumbent
 * SELECT + the default-recall read. CREATE INDEX IF NOT EXISTS is re-run-safe
 * AFTER the column-add. Registered in `initSchema` right after
 * `ensureUserRepresentationTable` (the `ensurePinnedColumn`-after-`ensureMemoryColumns`
 * ordering). Lives in this sibling file (mirror `schema-pinned.ts`) to keep
 * `schema.ts` under the 800-line cap.
 *
 * @param db - An open better-sqlite3 Database whose `user_representation` table
 *   already exists. Call AFTER `ensureUserRepresentationTable` in `initSchema`.
 */
export function ensureUserRepresentationBitemporalColumns(db: Database.Database): void {
  // Object-literal cast (matches the `as { name: string }[]` style at
  // ensureMemoryColumns:53 / ensurePinnedColumn:22); the untyped-sqlite rule targets
  // `as Foo[]` (a \w+ named type) — object-literal casts pass.
  const cols = new Set(
    (db.prepare(`PRAGMA table_info(user_representation)`).all() as { name: string }[]).map(
      (r) => r.name,
    ),
  );
  if (!cols.has("t_valid_start")) {
    db.exec(`ALTER TABLE user_representation ADD COLUMN t_valid_start INTEGER`);
    // Deterministic one-time backfill: current rows become valid-since-creation
    // (the existing created_at is the record/valid anchor — mirror the design's
    // explicit guidance). Guarded by IS NULL so a re-run touches nothing.
    db.exec(`UPDATE user_representation SET t_valid_start = created_at WHERE t_valid_start IS NULL`);
  }
  if (!cols.has("t_valid_end")) db.exec(`ALTER TABLE user_representation ADD COLUMN t_valid_end INTEGER`);
  if (!cols.has("expired_at")) db.exec(`ALTER TABLE user_representation ADD COLUMN expired_at INTEGER`);
  // The corroboration confidence-bump target (A2) — REQUIRED so revise()'s
  // bumpConfidence has a column to strictly-raise in place.
  if (!cols.has("confidence")) db.exec(`ALTER TABLE user_representation ADD COLUMN confidence REAL`);
  // Current-truth partial index (mirror idx_triples_current schema.ts:336). MUST be
  // AFTER the ALTER (the column must exist for the WHERE expression).
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_user_repr_current
      ON user_representation(tenant_id, agent_id, user_id, entry_type) WHERE t_valid_end IS NULL;
  `);
}
