// SPDX-License-Identifier: Apache-2.0
// @allow-throw: acquireDataDirLock is a boot-time precondition guard — callers
// can't use Result<T> here because the daemon boot sequence requires hard failure
// on lock conflict or unexpected OS errors. releaseDataDirLock is best-effort
// and never throws (try/catch swallows).
/**
 * Data-directory singleton lock (D14).
 *
 * Prevents two daemon instances from sharing the same dataDir.
 * Uses an O_EXCL sentinel file (.daemon.lock) acquired BEFORE
 * bootstrapSecretsAndEnv. Includes stale-lock recovery (PID-liveness
 * check) to handle OOM-killed daemon without operator intervention.
 *
 * Single-retry semantic: after unlinking a stale lock, we retry once.
 * If two daemons race to detect the same stale lock simultaneously,
 * the O_EXCL at re-acquire serializes them — one wins the lock, the
 * other throws a conflict error. This is correct behavior.
 */
import * as fs from "node:fs";
import { safePath } from "@comis/core";
import { isFsyncDisabledByPermissionModel } from "@comis/shared";

const LOCK_FILE = ".daemon.lock";

/**
 * Returns true if the given PID is alive.
 * - process.kill(pid, 0) succeeds → alive.
 * - throws EPERM → alive (process exists, we lack permission to signal it).
 * - throws ESRCH → dead.
 */
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM = process exists but we can't signal it — treat as alive.
    // ESRCH = no such process — dead.
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Acquire the data-dir singleton lock.
 *
 * Creates `<dataDir>/.daemon.lock` containing `process.pid` using
 * O_EXCL to prevent two daemons from both claiming the directory.
 *
 * On EEXIST:
 *   - Reads the PID from the lock file.
 *   - If the PID is dead (ESRCH), unlinks the stale lock and retries once.
 *   - If the PID is alive (or EPERM), throws with an actionable error.
 *
 * @throws Error if another daemon instance is already running on this dataDir.
 */
export function acquireDataDirLock(dataDir: string): void {
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const lockPath = safePath(dataDir, LOCK_FILE);

  let fd: number | undefined;
  try {
    fd = fs.openSync(
      lockPath,
      fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY,
      0o600,
    );
    fs.writeSync(fd, String(process.pid));
    // Best-effort durability fsync — Node's Permission Model (--permission)
    // disables the fsync API; swallow that refusal so the daemon still boots,
    // while letting genuine I/O errors propagate.
    try {
      fs.fsyncSync(fd);
    } catch (fsyncErr) {
      if (!isFsyncDisabledByPermissionModel(fsyncErr)) throw fsyncErr;
    }
    fs.closeSync(fd);
    fd = undefined;

    // Fsync the parent directory to make the directory entry durable
    // (matches persistSecretsFile's discipline — power-failure safety).
    const dirFd = fs.openSync(dataDir, fs.constants.O_RDONLY);
    try {
      fs.fsyncSync(dirFd);
    } catch (fsyncErr) {
      if (!isFsyncDisabledByPermissionModel(fsyncErr)) throw fsyncErr;
    } finally {
      fs.closeSync(dirFd);
    }
  } catch (e) {
    // Close the fd if it was opened before the error
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* ignore */ }
    }

    if ((e as NodeJS.ErrnoException).code === "EEXIST") {
      // Lock file exists — check if the holding PID is still alive
      let otherPid: number | undefined;
      let otherPidStr = "unknown";
      try {
        otherPidStr = fs.readFileSync(lockPath, "utf-8").trim();
        otherPid = parseInt(otherPidStr, 10);
      } catch {
        // Cannot read the lock file — treat as active conflict
      }

      if (otherPid !== undefined && !isNaN(otherPid) && !isPidAlive(otherPid)) {
        // Stale lock — dead PID. Unlink and retry once.
        // If a concurrent daemon wins the subsequent O_EXCL, it holds the lock
        // and this call will throw a conflict error — correct behavior.
        try { fs.unlinkSync(lockPath); } catch { /* best-effort */ }
        acquireDataDirLock(dataDir); // single recursive retry
        return;
      }

      throw new Error(
        `[FATAL] Another daemon instance is already running on dataDir '${dataDir}' ` +
        `(lock held by PID ${otherPidStr}). ` +
        "Stop the existing daemon before starting a new one.",
        { cause: e },
      );
    }
    throw e;
  }
}

/**
 * Release the data-dir singleton lock.
 *
 * Unlinks `<dataDir>/.daemon.lock`. Best-effort: safe to call even if
 * the lock was never acquired or has already been removed.
 */
export function releaseDataDirLock(dataDir: string): void {
  try {
    fs.unlinkSync(safePath(dataDir, LOCK_FILE));
  } catch {
    // best-effort — already gone or never created
  }
}
