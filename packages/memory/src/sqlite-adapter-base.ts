// SPDX-License-Identifier: Apache-2.0
/**
 * Shared SQLite database lifecycle utility.
 *
 * Handles the common boilerplate for stores that open their own database:
 * directory creation, database open, WAL/pragma setup, file permissions,
 * and schema initialization.
 *
 * Stores that receive a pre-opened `db` parameter (ContextStore, SessionStore,
 * DeliveryQueueAdapter, etc.) do not need this utility -- they have minimal
 * boilerplate already.
 *
 * @module
 */
import Database from "better-sqlite3";
import { mkdirSync, chmodSync, existsSync } from "node:fs";
import { dirname } from "node:path";

export interface SqliteAdapterOptions {
  /** Path to the SQLite database file, or ":memory:" for in-memory */
  dbPath: string;
  /** Enable WAL mode (default: true) */
  walMode?: boolean;
  /** Schema initialization function -- called after pragmas, before returning db */
  initSchema?: (db: Database.Database) => void;
}

/**
 * Open a SQLite database with standardized lifecycle:
 * 1. Create parent directory (mode 0o700)
 * 2. Open database
 * 3. Set pragmas: journal_mode=WAL, synchronous=NORMAL, foreign_keys=ON
 * 4. chmod DB file and companions to 0o600
 * 5. Run schema initialization if provided
 *
 * @returns The opened Database instance, ready for use
 */
export function openSqliteDatabase(opts: SqliteAdapterOptions): Database.Database {
  const { dbPath, walMode = true, initSchema } = opts;

  // Create parent directory if needed
  if (dbPath !== ":memory:") {
    const parentDir = dirname(dbPath);
    mkdirSync(parentDir, { recursive: true, mode: 0o700 });
  }

  const db = new Database(dbPath);

  // Standard pragmas
  if (walMode) db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("foreign_keys = ON");

  // Secure file permissions
  if (dbPath !== ":memory:") {
    chmodDbFiles(dbPath, 0o600);
  }

  // Schema initialization
  if (initSchema) initSchema(db);

  return db;
}

/**
 * Set permissions on the database file and its WAL/SHM companions.
 * Exported for stores that need a second chmod pass after post-open writes
 * (e.g., canary validation in the secret store).
 */
export function chmodDbFiles(dbPath: string, mode: number): void {
  try {
    chmodSync(dbPath, mode);
  } catch {
    // Best-effort: chmod may fail on some filesystems; not fatal
  }
  for (const suffix of ["-wal", "-shm"]) {
    try {
      const companion = dbPath + suffix;
      if (existsSync(companion)) chmodSync(companion, mode);
    } catch {
      // WAL/SHM files may not exist yet -- that is expected
    }
  }
}
