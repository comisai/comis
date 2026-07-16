// SPDX-License-Identifier: Apache-2.0
// @allow-throw: SQLite adapter boundary rejects invalid options before filesystem mutation.
/**
 * Shared SQLite database lifecycle utility.
 *
 * Handles the common boilerplate for stores that open their own database:
 * directory creation, database open, WAL/pragma setup, file permissions,
 * and schema initialization.
 *
 * Stores that receive a pre-opened `db` parameter (createSessionStore,
 * DeliveryQueueAdapter, etc.) do not need this utility -- they have minimal
 * boilerplate already.
 *
 * @module
 */
import Database from "better-sqlite3";
import { mkdirSync, chmodSync, existsSync } from "node:fs";
import { dirname } from "node:path";

const WAL_BUSY_RETRY_MS = 10;
const walRetrySignal = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));

function isSqliteBusy(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const code = (error as { readonly code?: unknown }).code;
  return code === "SQLITE_BUSY" || code === "SQLITE_LOCKED";
}

/** WAL negotiation ignores SQLite's busy handler on a concurrent first open. */
function enableWalMode(db: Database.Database, busyTimeoutMs: number | undefined): void {
  let remainingMs = busyTimeoutMs ?? 0;
  for (;;) {
    try {
      db.pragma("journal_mode = WAL");
      return;
    } catch (error) {
      if (!isSqliteBusy(error) || remainingMs <= 0) throw error;
      const waitMs = Math.min(WAL_BUSY_RETRY_MS, remainingMs);
      Atomics.wait(walRetrySignal, 0, 0, waitMs);
      remainingMs -= waitMs;
    }
  }
}

export interface SqliteAdapterOptions {
  /** Path to the SQLite database file, or ":memory:" for in-memory */
  dbPath: string;
  /** Enable WAL mode (default: true) */
  walMode?: boolean;
  /** Lock wait configured before any journal-mode mutation. */
  busyTimeoutMs?: number;
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
  const { dbPath, walMode = true, busyTimeoutMs, initSchema } = opts;
  if (busyTimeoutMs !== undefined
    && (!Number.isSafeInteger(busyTimeoutMs) || busyTimeoutMs <= 0
      || busyTimeoutMs > 2_147_483_647)) {
    throw new Error("SQLite busy timeout must be a positive 32-bit integer");
  }

  // Create parent directory if needed
  if (dbPath !== ":memory:") {
    const parentDir = dirname(dbPath);
    mkdirSync(parentDir, { recursive: true, mode: 0o700 });
  }

  const db = new Database(dbPath);
  try {
    // Standard pragmas
    if (busyTimeoutMs !== undefined) db.pragma(`busy_timeout = ${busyTimeoutMs}`);
    if (walMode) enableWalMode(db, busyTimeoutMs);
    db.pragma("synchronous = NORMAL");
    db.pragma("foreign_keys = ON");

    // Secure file permissions
    if (dbPath !== ":memory:") {
      chmodDbFiles(dbPath, 0o600);
    }

    // Schema initialization
    if (initSchema) initSchema(db);

    return db;
  } catch (error) {
    try {
      db.close();
    } catch {
      // Preserve the initialization failure that made the handle unusable.
    }
    throw error;
  }
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
