// SPDX-License-Identifier: Apache-2.0
/**
 * Per-session filesystem write lock.
 *
 * Provides `withSessionLock(fileLock, lockDir, sessionKey, fn)` that serializes
 * concurrent access to the same session transcript via an injected
 * `FileLockPort`. Different sessions use different lock files (per-session,
 * not global) so they do not block each other.
 *
 * Daemon composition supplies `createFileLock()` from `@comis/core` (the
 * single proper-lockfile adapter in the workspace). The same port instance
 * is reused by oauth-credential-store-file and oauth-token-manager so all
 * three agent lock surfaces converge on one adapter.
 *
 * @module
 */

import { createHash } from "node:crypto";
import { safePath } from "@comis/core";
import type { ComisLogger, FileLockPort } from "@comis/core";
import type { Result } from "@comis/shared";
import { err } from "@comis/shared";

/** Default max age for stale sentinel cleanup (1 hour). */
const DEFAULT_CLEANUP_MAX_AGE_MS = 3_600_000;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Options for per-session write locking. */
export interface LockedSessionStoreOptions {
  /** Lock considered stale after this many ms (default: 30_000 = 30s). */
  staleMs?: number;
  /** Number of lock acquisition retries (default: 3). */
  retries?: number;
  /** Retry delay base in ms (default: 500). */
  retryMinTimeout?: number;
  /**
   * Optional logger. When provided, structured-cause logging fires
   * before the FileLockPort's discriminated error union is collapsed to
   * the coarse "locked" | "error" string. Without it, observability is
   * limited to the collapsed return value — callers cannot distinguish
   * "ELOCKED after N retries" from "EACCES on the lock directory".
   *
   * The public Result API is unchanged either way; the logger is purely
   * an observability hook for operator triage.
   */
  logger?: ComisLogger;
  /** Optional sessionKey to include in the log line (correlatable to traceId). */
  sessionKey?: string;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_STALE_MS = 30_000;
const DEFAULT_RETRIES = 3;
const DEFAULT_RETRY_MIN_TIMEOUT = 500;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Derive a deterministic lock sentinel file path from a session key.
 * Uses first 12 hex chars of SHA-256 hash to avoid filesystem issues
 * with long or special-character session keys.
 */
function deriveLockPath(lockDir: string, sessionKey: string): string {
  const hash = createHash("sha256").update(sessionKey).digest("hex").slice(0, 12);
  return safePath(lockDir, `${hash}.lock`);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Acquire a per-session filesystem lock, execute `fn`, and release.
 *
 * Returns `ok(result)` on success, `err("locked")` when the lock is
 * already held and retries are exhausted, or `err("error")` for
 * unexpected failures.
 *
 * The lock file is derived from `sha256(sessionKey).slice(0,12)` so
 * different sessions use separate locks (no cross-session blocking).
 *
 * `fileLock` is injected by the caller — daemon composition passes the
 * `createFileLock()` instance built once at startup. The port handles
 * sentinel-file creation, stale-lock recovery, retry backoff, and the
 * ELOCKED → "locked" mapping.
 */
export async function withSessionLock<T>(
  fileLock: FileLockPort,
  lockDir: string,
  sessionKey: string,
  fn: () => T | Promise<T>,
  options?: LockedSessionStoreOptions,
): Promise<Result<T, "locked" | "error">> {
  const staleMs = options?.staleMs ?? DEFAULT_STALE_MS;
  const retries = options?.retries ?? DEFAULT_RETRIES;
  const retryMinTimeout = options?.retryMinTimeout ?? DEFAULT_RETRY_MIN_TIMEOUT;

  const sentinelPath = deriveLockPath(lockDir, sessionKey);

  // `fileLock.withLock` ensures the lockDir + sentinel file exist (the
  // createFileLock adapter creates them on demand via mkdir+writeFile).
  // It also catches thrown errors from `fn` and surfaces them as
  // `err({ kind: "error" })` — we collapse the port's discriminated error
  // union to the coarse "locked" | "error" string that withSessionLock's
  // public API exposes.
  const lockResult = await fileLock.withLock(
    sentinelPath,
    async () => await fn(),
    {
      staleMs,
      retries: { retries, minTimeout: retryMinTimeout },
    },
  );

  if (lockResult.ok) {
    return lockResult;
  }
  if (lockResult.error.kind === "locked") {
    return err("locked" as const);
  }
  // The FileLockPort returns a discriminated error union with structured
  // fields (kind, cause). We collapse it to a string for the public API,
  // but the underlying cause (ELOCKED chain vs EACCES on the lock
  // directory vs disk-full) is useful for operator triage. If a logger is
  // provided, emit a structured warn line BEFORE the collapse so the
  // cause survives in the log stream.
  if (options?.logger) {
    options.logger.warn(
      {
        submodule: "session-write-lock",
        hint: "lock_error_collapsed",
        errorKind: "internal" as const,
        sentinelPath,
        sessionKey: options.sessionKey,
        err: lockResult.error,
      },
      "withSessionLock collapsing FileLockPort error to err('error')",
    );
  }
  return err("error" as const);
}

/**
 * Remove stale sentinel `.lock` files from the lock directory.
 *
 * Sentinel files are created by `withSessionLock` but never deleted.
 * This function delegates to `fileLock.cleanupStaleLocks`, which scans the
 * directory for `*.lock` regular files older than `maxAgeMs` and removes any
 * that are not currently held.
 *
 * Safe to call while the daemon is running — locked sentinels are skipped
 * by the underlying port.
 *
 * @param fileLock - Injected FileLockPort (created once at daemon composition root).
 * @param lockDir - Directory containing sentinel `.lock` files.
 * @param maxAgeMs - Only remove sentinels older than this (default: 1 hour).
 * @returns Number of sentinel files removed.
 */
export async function cleanupStaleLocks(
  fileLock: FileLockPort,
  lockDir: string,
  maxAgeMs: number = DEFAULT_CLEANUP_MAX_AGE_MS,
): Promise<number> {
  return fileLock.cleanupStaleLocks(lockDir, maxAgeMs);
}
