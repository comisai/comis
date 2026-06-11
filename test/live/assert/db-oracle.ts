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
import * as sqliteVec from "sqlite-vec";
import { createRowMapper, MemoryRowSchema } from "@comis/memory";

/**
 * Open a READONLY connection with the sqlite-vec extension loaded, mirroring
 * how the product reads the store (packages/memory schema.ts initSchema).
 *
 * 260611 live-fire fix: MEM Stage-B daemons create vec_memories as a REAL vec0
 * virtual table; a plain readonly connection threw
 * "SqliteError: no such module: vec0" from snapshotRowCounts and silently
 * skipped runDbOracle check 3d. Loading the extension is connection-level (not
 * a DB write) so the readonly guarantee (T-134-12) is unchanged. Load failure
 * is tolerated — vec-dependent reads then fall back to the existing
 * "no such module: vec0" skip paths instead of failing the oracle.
 */
function openReadonlyWithVec(dbPath: string): Database.Database {
  const db = new Database(dbPath, { readonly: true });
  try {
    sqliteVec.load(db);
  } catch {
    // Optional native extension unavailable on this host — vec-dependent
    // checks degrade to their existing skip paths.
  }
  return db;
}

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
  // Open READONLY — oracle never writes (T-134-12). sqlite-vec is loaded so
  // vec0 virtual tables are first-class ground truth (check 3d executes).
  const db = openReadonlyWithVec(dbPath);
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
      //
      // vec_memories is a `vec0` virtual table (sqlite-vec). The oracle opens its
      // OWN readonly connection, which does NOT load the optional sqlite-vec
      // extension — so SELECT-ing from the vec0 vtable can throw "no such module:
      // vec0" even though the table is structurally present in sqlite_master.
      // That is a missing-optional-extension condition in the reader, NOT a
      // desync defect, so it must not false-fail the oracle. We attempt the
      // cross-check and skip ONLY on the vec0-module-load error; any other error
      // (and any genuine count mismatch) still fails.
      if (tables.includes("vec_memories")) {
        let vecQueryable = true;
        let vecCount = 0;
        try {
          vecCount = (
            db.prepare("SELECT COUNT(*) AS c FROM vec_memories").get() as { c: number }
          ).c;
        } catch (e) {
          if (e instanceof Error && /no such module: vec0/i.test(e.message)) {
            // Reader lacks sqlite-vec — skip the vec sync cross-check (not a defect).
            vecQueryable = false;
          } else {
            throw e;
          }
        }
        if (vecQueryable) {
          const embCount = (
            db.prepare("SELECT COUNT(*) AS c FROM memories WHERE has_embedding=1").get() as { c: number }
          ).c;
          if (embCount !== vecCount) {
            throw new Error(
              `[db-oracle check 3d] vec_memories desynced: memories(has_embedding=1)=${embCount}, vec=${vecCount}`,
            );
          }
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
  const db = openReadonlyWithVec(dbPath);
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
      try {
        counts[t] = (
          db.prepare(`SELECT count(*) as c FROM ${t}`).get() as { c: number }
        ).c;
      } catch (e) {
        // Mirror runDbOracle check 3d: when the optional sqlite-vec extension
        // could not be loaded on this host, a vec0 vtable count is a
        // missing-reader-capability condition, not a data defect — omit the
        // table from the snapshot (callers' delta math treats absent as 0).
        // Any other error is a real failure and propagates.
        if (!(e instanceof Error && /no such module: vec0/i.test(e.message))) {
          throw e;
        }
      }
    }
    return counts;
  } finally {
    db.close();
  }
}
