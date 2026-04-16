/**
 * Per-session filesystem write lock.
 *
 * Provides `withSessionLock(lockDir, sessionKey, fn)` that serializes
 * concurrent access to the same session transcript via proper-lockfile.
 * Different sessions use different lock files (per-session, not global)
 * so they do not block each other.
 *
 * Pattern follows `withExecutionLock` from @comis/scheduler but is
 * keyed by session key hash rather than a fixed sentinel path.
 *
 * @module
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as nodePath from "node:path";
import type { Result } from "@comis/shared";
import { ok, err } from "@comis/shared";
import lockfile from "proper-lockfile";

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
  return nodePath.join(lockDir, `${hash}.lock`);
}

/** Detect proper-lockfile ELOCKED error. */
function isElockedError(error: unknown): boolean {
  if (error instanceof Error && "code" in error) {
    return (error as Error & { code: string }).code === "ELOCKED";
  }
  return false;
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
 */
export async function withSessionLock<T>(
  lockDir: string,
  sessionKey: string,
  fn: () => T | Promise<T>,
  options?: LockedSessionStoreOptions,
): Promise<Result<T, "locked" | "error">> {
  const staleMs = options?.staleMs ?? DEFAULT_STALE_MS;
  const retries = options?.retries ?? DEFAULT_RETRIES;
  const retryMinTimeout = options?.retryMinTimeout ?? DEFAULT_RETRY_MIN_TIMEOUT;

  const sentinelPath = deriveLockPath(lockDir, sessionKey);

  // Ensure lock directory and sentinel file exist
  await fs.mkdir(lockDir, { recursive: true });
  try {
    await fs.access(sentinelPath);
  } catch {
    await fs.writeFile(sentinelPath, "");
  }

  let release: (() => Promise<void>) | undefined;

  try {
    release = await lockfile.lock(sentinelPath, {
      stale: staleMs,
      retries: {
        retries,
        minTimeout: retryMinTimeout,
      },
      onCompromised: () => {},
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
 * Remove stale sentinel `.lock` files from the lock directory.
 *
 * Sentinel files are created by `withSessionLock` but never deleted.
 * This function scans the lock directory and removes sentinel files
 * that are not currently locked and older than `maxAgeMs`.
 *
 * Safe to call while the daemon is running — locked sentinels are skipped.
 *
 * @param lockDir - Directory containing sentinel `.lock` files
 * @param maxAgeMs - Only remove sentinels older than this (default: 1 hour)
 * @returns Number of sentinel files removed
 */
export async function cleanupStaleLocks(
  lockDir: string,
  maxAgeMs: number = DEFAULT_CLEANUP_MAX_AGE_MS,
): Promise<number> {
  let entries: string[];
  try {
    entries = await fs.readdir(lockDir);
  } catch {
    return 0; // Directory doesn't exist yet — nothing to clean
  }

  const now = Date.now();
  let removed = 0;

  for (const entry of entries) {
    // Only process sentinel files (12-hex-char hash + .lock extension, regular files)
    if (!entry.endsWith(".lock")) continue;
    const fullPath = nodePath.join(lockDir, entry);

    try {
      const stat = await fs.stat(fullPath);
      if (!stat.isFile()) continue;
      if (now - stat.mtimeMs < maxAgeMs) continue;

      // Skip if currently locked (proper-lockfile creates a .lock.lock directory)
      const isActive = await lockfile.check(fullPath).catch(() => false);
      if (isActive) continue;

      await fs.unlink(fullPath);
      removed++;
    } catch {
      // File may have been removed concurrently — ignore
    }
  }

  return removed;
}
