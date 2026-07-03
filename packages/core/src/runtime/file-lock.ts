// SPDX-License-Identifier: Apache-2.0
/**
 * File-based execution locking via proper-lockfile.
 *
 * Provides at-most-once execution guarantee for scheduled jobs
 * across processes. Uses file system locks with stale detection
 * and periodic mtime updates for liveness proof.
 *
 * The `createFileLock(): FileLockPort` factory is the canonical adapter target
 * for non-scheduler consumers (CLI, agent OAuth call sites, agent
 * session-write-lock).
 *
 * The `withExecutionLock` + `isLocked` named-export helpers below are a
 * direct-call surface with no in-repo consumer from @comis/core
 * (the scheduler-side caller `cron-store.ts` imports them from its
 * own `../execution/execution-lock.js`).
 */

import type { Result } from "@comis/shared";
import { ok, err } from "@comis/shared";
import type { FileLockPort, LockOptions, LockError } from "../ports/file-lock.js";
import { safePath } from "../security/safe-path.js";
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
  /**
   * Optional lock-acquisition retry budget. Forwarded to proper-lockfile's
   * own retry option (uses a built-in incremental backoff). When undefined
   * (default), retries: 0 — fail fast on contention. Lets the OAuth manager
   * wait for a sibling refresh to complete (concurrent-refresh acceptance)
   * without callers having to roll their own retry loop.
   */
  retries?:
    | number
    | {
        retries: number;
        minTimeout?: number;
        maxTimeout?: number;
        factor?: number;
      };
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
      retries: opts.retries ?? 0,
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

/** Detect proper-lockfile's "lock not held" error for idempotent release. */
function isAlreadyReleasedError(e: unknown): boolean {
  // proper-lockfile throws an Error with code "ENOTACQUIRED" or message
  // "Lock is not acquired/owned by you" when releasing a path that is no
  // longer locked.
  if (e instanceof Error) {
    const code = (e as Error & { code?: string }).code;
    if (code === "ENOTACQUIRED") return true;
    return /not acquired|not owned/i.test(e.message);
  }
  return false;
}

/**
 * Production FileLockPort factory backed by proper-lockfile.
 *
 * Injected through agent's session-write-lock + OAuth call sites so agent has
 * no direct proper-lockfile dependency.
 *
 * The factory is zero-arg; per-call `LockOptions` live on every method call.
 * The error shape preserves today's ELOCKED detection
 * (`{ kind: "locked" | "error", message }`).
 *
 * `acquire` returns a release-callback (`Result<() => Promise<void>, LockError>`)
 * matching proper-lockfile's native `lock(path, opts) => Promise<release>` shape.
 */
export function createFileLock(): FileLockPort {
  return {
    async acquire(
      lockPath: string,
      opts: LockOptions = {},
    ): Promise<Result<() => Promise<void>, LockError>> {
      // Same prep as withExecutionLock: ensure dir + sentinel exist.
      const dir = path.dirname(lockPath);
      await fs.mkdir(dir, { recursive: true });
      try {
        await fs.access(lockPath);
      } catch {
        await fs.writeFile(lockPath, "");
      }

      try {
        const release = await lockfile.lock(lockPath, {
          stale: opts.staleMs ?? 30_000,
          // proper-lockfile's `update` option drives mtime liveness pings
          // while the lock is held. Default 30_000 mirrors withExecutionLock's
          // DEFAULT_OPTIONS.updateMs. Agent OAuth call sites pass 5_000 to
          // keep stale-detection responsive.
          update: opts.updateMs ?? 30_000,
          // retries: forward proper-lockfile-native shape directly when the
          // caller provided the object form; bare-number form maps to
          // { retries: N, minTimeout: retryMinTimeout ?? 500 }.
          retries:
            typeof opts.retries === "object" && opts.retries !== null
              ? opts.retries
              : {
                  retries: (opts.retries as number | undefined) ?? 3,
                  minTimeout: opts.retryMinTimeout ?? 500,
                },
        });
        return ok(release);
      } catch (e) {
        if (isElockedError(e)) {
          return err({ kind: "locked", message: String(e) });
        }
        return err({ kind: "error", message: String(e) });
      }
    },

    async release(lockPath: string): Promise<Result<void, LockError>> {
      try {
        await lockfile.unlock(lockPath);
        return ok(undefined);
      } catch (e) {
        // Idempotent: double-release returns ok per port contract.
        // Match the swallow pattern at session-write-lock.ts:127-131.
        if (isAlreadyReleasedError(e)) {
          return ok(undefined);
        }
        return err({ kind: "error", message: String(e) });
      }
    },

    async withLock<T>(
      lockPath: string,
      fn: () => Promise<T>,
      opts: LockOptions = {},
    ): Promise<Result<T, LockError>> {
      const acq = await this.acquire(lockPath, opts);
      if (!acq.ok) return acq;
      const release = acq.value;
      try {
        const value = await fn();
        return ok(value);
      } catch (fnErr) {
        // Propagate errors thrown by fn — preserve today's withExecutionLock
        // semantics (if fn throws, finally still releases; the throw
        // propagates). FileLockPort returns Result, so wrap as
        // err({ kind: "error", … }).
        return err({ kind: "error", message: String(fnErr) });
      } finally {
        try {
          await release();
        } catch {
          // Lock may have been compromised; ignore release error per
          // the withExecutionLock pattern above.
        }
      }
    },

    async isLocked(lockPath: string): Promise<boolean> {
      try {
        return await lockfile.check(lockPath);
      } catch {
        return false;
      }
    },

    async cleanupStaleLocks(
      lockDir: string,
      maxAgeMs: number = 3_600_000,
    ): Promise<number> {
      // Mirror agent/src/session/session-write-lock.ts cleanup logic:
      //   1. readdir lockDir (ENOENT → 0)
      //   2. for each `*.lock` regular file
      //   3. skip if mtime is younger than maxAgeMs
      //   4. skip if currently held (lockfile.check)
      //   5. unlink the sentinel file. proper-lockfile's `.lock.lock`
      //      directory (the active-lock indicator) is owned by
      //      proper-lockfile itself and is removed atomically by the
      //      successful lockfile.unlock above; this routine never deletes
      //      directories — it only reclaims orphaned `.lock` sentinel files
      //      whose `.lock.lock` partner was already released (or whose
      //      holder process crashed cleanly without leaving stale state).
      let entries: string[];
      try {
        entries = await fs.readdir(lockDir);
      } catch {
        return 0;
      }
      const now = Date.now();
      let removed = 0;
      for (const entry of entries) {
        if (!entry.endsWith(".lock")) continue;
        // safePath ensures the cleanup walk cannot escape lockDir even when
        // the directory contains an attacker-injected entry.
        const fullPath = safePath(lockDir, entry);
        try {
          const stat = await fs.stat(fullPath);
          if (!stat.isFile()) continue;
          if (now - stat.mtimeMs < maxAgeMs) continue;
          const isActive = await lockfile.check(fullPath).catch(() => false);
          if (isActive) continue;
          await fs.unlink(fullPath);
          removed++;
        } catch {
          // File may have been removed concurrently — ignore.
        }
      }
      return removed;
    },
  };
}
