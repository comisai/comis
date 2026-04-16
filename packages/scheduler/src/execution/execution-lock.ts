/**
 * File-based execution locking via proper-lockfile.
 *
 * Provides at-most-once execution guarantee for scheduled jobs
 * across processes. Uses file system locks with stale detection
 * and periodic mtime updates for liveness proof.
 */

import type { Result } from "@comis/shared";
import { ok, err } from "@comis/shared";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import lockfile from "proper-lockfile";

/** Options for file-based execution locking. */
export interface ExecutionLockOptions {
  /** Lock considered stale after this many ms without update (default 600_000 = 10 min). */
  staleMs: number;
  /** Mtime update interval in ms for liveness proof (default 30_000 = 30s). */
  updateMs: number;
  /** Callback when lock is compromised (e.g., external release). */
  onCompromised?: (err: Error) => void;
}

const DEFAULT_OPTIONS: ExecutionLockOptions = {
  staleMs: 600_000,
  updateMs: 30_000,
  onCompromised: () => {},
};

/**
 * Acquire a file lock, execute the function, and release the lock.
 *
 * Returns `ok(result)` on success, `err("locked")` when the lock is
 * already held by another process/call, or `err("error")` for
 * unexpected failures.
 *
 * The lock is always released in a finally block, even if `fn` throws.
 * The lockPath should be a sentinel file (e.g., `${lockDir}/job.lock`).
 */
export async function withExecutionLock<T>(
  lockPath: string,
  fn: () => Promise<T>,
  options?: Partial<ExecutionLockOptions>,
): Promise<Result<T, "locked" | "error">> {
  const opts: ExecutionLockOptions = { ...DEFAULT_OPTIONS, ...options };

  // Ensure lock directory and sentinel file exist
  const dir = path.dirname(lockPath);
  await fs.mkdir(dir, { recursive: true });
  try {
    await fs.access(lockPath);
  } catch {
    await fs.writeFile(lockPath, "");
  }

  let release: (() => Promise<void>) | undefined;

  try {
    release = await lockfile.lock(lockPath, {
      stale: opts.staleMs,
      update: opts.updateMs,
      retries: 0,
      onCompromised: opts.onCompromised ?? (() => {}),
    });
  } catch (lockErr: unknown) {
    if (isElockedError(lockErr)) {
      return err("locked");
    }
    return err("error");
  }

  try {
    const result = await fn();
    return ok(result);
  } finally {
    if (release) {
      try {
        await release();
      } catch {
        // Lock may have been compromised; ignore release error
      }
    }
  }
}

/**
 * Check whether a lock is currently held on the given path.
 */
export async function isLocked(lockPath: string): Promise<boolean> {
  try {
    return await lockfile.check(lockPath);
  } catch {
    return false;
  }
}

/** Detect proper-lockfile ELOCKED error. */
function isElockedError(error: unknown): boolean {
  if (error instanceof Error && "code" in error) {
    return (error as Error & { code: string }).code === "ELOCKED";
  }
  return false;
}
