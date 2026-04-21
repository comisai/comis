// SPDX-License-Identifier: Apache-2.0
/**
 * SQLite WAL checkpoint and auxiliary file cleanup utility.
 *
 * Ensures WAL/SHM files are properly checkpointed and deleted during test
 * teardown, preventing stale files from leaking between test runs.
 *
 * @module
 */

import { unlinkSync } from "node:fs";

/**
 * Force WAL checkpoint and delete auxiliary SQLite files.
 * Call during test teardown to prevent stale WAL/SHM files from leaking between runs.
 *
 * @param dbPath - Absolute path to the SQLite database file
 * @param db - Optional open database handle (with pragma/close methods)
 */
export function cleanupDatabase(
  dbPath: string,
  db?: { pragma: (sql: string) => unknown; close: () => void },
): void {
  if (db) {
    try {
      db.pragma("wal_checkpoint(TRUNCATE)");
    } catch {
      // Database may already be closed
    }
    try {
      db.close();
    } catch {
      // Already closed
    }
  }

  // Delete auxiliary WAL/SHM files
  for (const suffix of ["-wal", "-shm"]) {
    try {
      unlinkSync(dbPath + suffix);
    } catch {
      // File may not exist
    }
  }
}
