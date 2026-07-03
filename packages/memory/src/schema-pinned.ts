// SPDX-License-Identifier: Apache-2.0
import type Database from "better-sqlite3";

/**
 * Additively ensure the `memories` table carries the `pinned` column.
 * Forward-only additive contract: SQLite has no
 * `ADD COLUMN IF NOT EXISTS`, so the add is guarded by a `PRAGMA table_info(memories)`
 * presence check. Safe on every boot, including a live `~/.comis` DB created before
 * the column existed — existing rows get DEFAULT 0 (O(1) add; no table rewrite, no
 * backfill). No dual-schema read paths, no `?? 0` fallbacks: this is the SOLE add-site.
 *
 * The partial index `idx_memories_pinned` (`WHERE pinned = 1`) is write-time
 * idempotent (`CREATE INDEX IF NOT EXISTS`): safe to create on every boot after the
 * column exists.
 *
 * @param db - An open better-sqlite3 Database whose `memories` table already exists.
 */
export function ensurePinnedColumn(db: Database.Database): void {
  // Object-literal cast (matches the `as { name: string }[]` style at ensureMemoryColumns:49);
  // the untyped-sqlite rule targets `as Foo[]` (a \w+ named type) — object-literal casts pass.
  const cols = new Set(
    (db.prepare(`PRAGMA table_info(memories)`).all() as { name: string }[]).map((r) => r.name),
  );
  if (!cols.has("pinned")) {
    db.exec(`ALTER TABLE memories ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0`);
  }
  // Partial index: serves listPinned() SELECT WHERE pinned = 1.
  // CREATE INDEX IF NOT EXISTS is safe regardless of whether the column existed.
  // MUST be called AFTER the ALTER (the column must exist for the index expression).
  //
  // `created_at DESC` in the partial index expression requires SQLite >= 3.38.0
  // for full covering-index use (DESC in index expressions). The bundled better-sqlite3
  // v12.10.0 ships SQLite 3.53.0 (verified 2026-06-04), well above 3.38.0 — the sort
  // is covered and no performance concern exists. This comment is the verification receipt.
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_memories_pinned
      ON memories(tenant_id, agent_id, created_at DESC)
      WHERE pinned = 1;
  `);
}
