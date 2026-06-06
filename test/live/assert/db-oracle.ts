// SPDX-License-Identifier: Apache-2.0
/**
 * Persistence oracle — afterEach post-condition for every live test.
 *
 * Opens the SQLite store READONLY (never writes). Runs:
 *   1. PRAGMA integrity_check
 *   2. PRAGMA foreign_key_check
 *   3. Zod row validation on the `memories` table via parseRows (RowMapper has no singular parse method)
 *   4. Row-delta diff (snapshot before/after via opts.expectedDeltas + opts.beforeCounts)
 *
 * T-134-12 (Tampering): Database opened with { readonly: true } — any write
 * attempt throws immediately.
 *
 * @module
 */

import Database from "better-sqlite3";
import { createRowMapper, MemoryRowSchema } from "@comis/memory";

/**
 * Expected row count delta for a single table.
 */
export interface RowDelta {
  table: string;
  expectedRowDelta: number;
}

/**
 * Options for the persistence oracle.
 */
export interface DbOracleOptions {
  /** Expected row count deltas (snapshot-diff check). */
  expectedDeltas?: RowDelta[];
  /** Row counts captured BEFORE the test ran (keyed by table name). */
  beforeCounts?: Record<string, number>;
}

/**
 * Run the persistence oracle against a SQLite database file.
 *
 * The database is opened readonly — the oracle NEVER writes to the store.
 * Throws on the first failing check with a descriptive message.
 *
 * @param dbPath - Absolute path to the SQLite database file.
 * @param opts   - Per-test oracle options.
 */
export async function runDbOracle(
  dbPath: string,
  opts?: DbOracleOptions,
): Promise<void> {
  // Open READONLY — oracle never writes (T-134-12).
  const db = new Database(dbPath, { readonly: true });
  try {
    // ── Check 1: PRAGMA integrity_check ──────────────────────────────────────
    const ic = db.pragma("integrity_check") as Array<{ integrity_check: string }>;
    if (ic[0]?.integrity_check !== "ok") {
      throw new Error(
        `[db-oracle check 1] PRAGMA integrity_check failed: ${JSON.stringify(ic)}`,
      );
    }

    // ── Check 2: PRAGMA foreign_key_check ────────────────────────────────────
    const fk = db.pragma("foreign_key_check") as unknown[];
    if (fk.length > 0) {
      throw new Error(
        `[db-oracle check 2] PRAGMA foreign_key_check failed: ${fk.length} violation(s): ${JSON.stringify(fk.slice(0, 3))}`,
      );
    }

    // ── Check 3: Zod row validation on memories table ────────────────────────
    // Uses parseRows (RowMapper exposes parseRows + parseOptionalRow; no singular parse method exists).
    const tables = (
      db
        .prepare("SELECT name FROM sqlite_master WHERE type='table'")
        .all() as { name: string }[]
    ).map((r) => r.name);

    if (tables.includes("memories")) {
      const memoryMapper = createRowMapper(MemoryRowSchema);
      const rows = db.prepare("SELECT * FROM memories").all();
      const result = memoryMapper.parseRows(rows);
      if (!result.ok) {
        throw new Error(
          `[db-oracle check 3] Row validation failed in 'memories': ${JSON.stringify(result.error)}`,
        );
      }
    }

    // ── Check 3b: lcd_summaries_fts sync (FTS external-content table) ────────
    // The lcd_summaries_fts virtual table is an external-content FTS5 table
    // backed by lcd_summaries. Its row count must equal lcd_summaries.
    // A desynced FTS table means the content-rowid mapping is broken and
    // ctx_search / ctx_inspect queries will return stale or missing results.
    // Only runs when both lcd_summaries AND lcd_summaries_fts tables exist.
    if (tables.includes("lcd_summaries") && tables.includes("lcd_summaries_fts")) {
      const lcdSumCount = (db.prepare("SELECT COUNT(*) AS c FROM lcd_summaries").get() as { c: number }).c;
      const lcdFtsCount = (db.prepare("SELECT COUNT(*) AS c FROM lcd_summaries_fts").get() as { c: number }).c;
      if (lcdSumCount !== lcdFtsCount) {
        throw new Error(
          `[db-oracle check 3b] lcd_summaries_fts desynced: lcd_summaries has ${lcdSumCount} rows, fts has ${lcdFtsCount}`,
        );
      }
    }

    // ── Check 3c: memory_fts ↔ memories (ALL rows) sync ─────────────────────
    // The memory_fts virtual table is an external-content FTS5 table backed by
    // the FULL memories table. Its after-insert/update/delete triggers fire on
    // every INSERT/DELETE/UPDATE OF content ON memories with NO has_embedding
    // filter (see packages/memory/src/schema.ts lines 553-565). The correct
    // invariant is COUNT(*) FROM memory_fts == COUNT(*) FROM memories (total),
    // NOT the has_embedding=1 subset. A desynced FTS means text-search queries
    // return stale/missing results. Per FND-11 (§5.2 point 4): memory_fts/vec
    // desync is a production risk.
    // Only runs when both "memories" and "memory_fts" tables exist in the DB.
    if (tables.includes("memories") && tables.includes("memory_fts")) {
      const totalMemCount = (
        db.prepare("SELECT COUNT(*) AS c FROM memories").get() as { c: number }
      ).c;
      const ftsCount = (
        db.prepare("SELECT COUNT(*) AS c FROM memory_fts").get() as { c: number }
      ).c;
      if (totalMemCount !== ftsCount) {
        throw new Error(
          `[db-oracle check 3c] memory_fts desynced: memories=${totalMemCount}, fts=${ftsCount}`,
        );
      }

      // ── Check 3d: vec_memories ↔ memories(has_embedding=1) sync ────────────
      // vec_memories tracks only embedded rows (has_embedding=1). Its row count
      // must equal COUNT(*) FROM memories WHERE has_embedding=1.
      // Only runs when vec_memories table also exists.
      if (tables.includes("vec_memories")) {
        const embCount = (
          db.prepare("SELECT COUNT(*) AS c FROM memories WHERE has_embedding=1").get() as { c: number }
        ).c;
        const vecCount = (
          db.prepare("SELECT COUNT(*) AS c FROM vec_memories").get() as { c: number }
        ).c;
        if (embCount !== vecCount) {
          throw new Error(
            `[db-oracle check 3d] vec_memories desynced: memories(has_embedding=1)=${embCount}, vec=${vecCount}`,
          );
        }
      }
    }

    // ── Check 4: Row-delta diff ───────────────────────────────────────────────
    if (opts?.expectedDeltas && opts.beforeCounts) {
      for (const delta of opts.expectedDeltas) {
        if (!tables.includes(delta.table)) continue;
        const afterCount = (
          db
            .prepare(`SELECT count(*) as c FROM ${delta.table}`)
            .get() as { c: number }
        ).c;
        const beforeCount = opts.beforeCounts[delta.table] ?? 0;
        const actual = afterCount - beforeCount;
        if (actual !== delta.expectedRowDelta) {
          throw new Error(
            `[db-oracle check 4] Row delta mismatch on '${delta.table}': expected ${delta.expectedRowDelta}, got ${actual}`,
          );
        }
      }
    }
  } finally {
    db.close();
  }
}

/**
 * Snapshot row counts for the given tables before a test runs.
 *
 * Call this before the unit-under-test to capture the baseline, then pass
 * the result as `opts.beforeCounts` to `runDbOracle`.
 *
 * Opens the database READONLY — never writes.
 *
 * @param dbPath - Absolute path to the SQLite database file.
 * @param tables - Table names to snapshot.
 */
export function snapshotRowCounts(
  dbPath: string,
  tables: string[],
): Record<string, number> {
  const db = new Database(dbPath, { readonly: true });
  try {
    // Mirror the sqlite_master allowlist guard used in runDbOracle check 4
    // to prevent caller-supplied table names from being interpolated directly
    // into SQL without validation (WR-03 — injection hardening + consistency).
    const existingTables = new Set<string>(
      (
        db
          .prepare("SELECT name FROM sqlite_master WHERE type='table'")
          .all() as { name: string }[]
      ).map((r) => r.name),
    );
    const counts: Record<string, number> = {};
    for (const t of tables) {
      if (!existingTables.has(t)) continue; // skip tables not in the DB
      counts[t] = (
        db.prepare(`SELECT count(*) as c FROM ${t}`).get() as { c: number }
      ).c;
    }
    return counts;
  } finally {
    db.close();
  }
}
