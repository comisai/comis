// SPDX-License-Identifier: Apache-2.0
/**
 * FileLockPort: hexagonal architecture boundary for file-based mutual exclusion.
 *
 * The port is broad enough for THREE current consumers:
 *   - scheduler execution locks (cron-shaped, fixed timing — withExecutionLock today)
 *   - agent session write locks (30s stale, 3 retries, 500ms min timeout — LockedSessionStoreOptions today)
 *   - agent OAuth credential/token locks (cross-process stale-lock recovery per RES-ARCH-2)
 *
 * Implementation: scheduler ships the canonical `createFileLock(): FileLockPort` factory
 * backed by `proper-lockfile` (the only proper-lockfile adapter in the workspace post-Phase-28).
 *
 * Phase 28 declares the port; Phase 32 commit 13 (ORCH-EXT-15) injects it through agent's
 * session-write-lock + OAuth lock call sites and removes agent's direct proper-lockfile dep.
 * Until then, the contract tests in this phase run against agent's direct-proper-lockfile
 * impl — they stay green by construction when Phase 32 retargets imports.
 *
 * Error shape `{ kind: "locked" | "error" }` preserves today's proper-lockfile ELOCKED
 * detection (see agent/src/session/session-write-lock.ts:62 + scheduler/src/execution/execution-lock.ts:115-120).
 *
 * @module
 */
import type { Result } from "@comis/shared";

/**
 * Per-call lock acquisition options. Different consumers pass different values
 * (scheduler exec-lock fixed cron timing; agent session-write-lock 30s/3-retry/500ms;
 * OAuth aggressive refresh retry). Per D-08, the factory is zero-arg and these
 * options live on every method call.
 */
export interface LockOptions {
  /** Lock considered stale after this many ms without update (default 30_000). */
  readonly staleMs?: number;
  /**
   * Lock-acquisition retry budget (default 3). Accepts either a bare number
   * (mapped to proper-lockfile { retries: N }) or the full proper-lockfile retry
   * config object so callers like agent oauth-token-manager — which today passes
   * { retries: 5, minTimeout: 50, maxTimeout: 1_000, factor: 2 } — can carry their
   * existing tuning forward without semantic regression.
   */
  readonly retries?:
    | number
    | { retries: number; minTimeout?: number; maxTimeout?: number; factor?: number };
  /** First-retry minimum delay in ms (default 500). */
  readonly retryMinTimeout?: number;
  /**
   * Mtime update interval in ms for liveness proof (default 30_000).
   * Forwarded to proper-lockfile's `update` option. Zero or undefined disables
   * the liveness ping; consumers like agent OAuth refresh use 5_000 to keep
   * stale-detection in scheduler exec-lock's neighborhood without flapping.
   * (Field added so agent's existing { staleMs: 30_000, updateMs: 5_000 } shape
   * survives the Phase 28 retarget from withExecutionLock to createFileLock().withLock.)
   */
  readonly updateMs?: number;
}

/**
 * File-lock contract. Implementations: `createFileLock()` factory in @comis/scheduler.
 *
 * `acquire` returns a release callback (matching proper-lockfile's native
 * `lock(path, opts) => Promise<release>` shape — see Claude's Discretion choice in
 * 28-CONTEXT.md). Callers either invoke the callback or use `withLock` for the
 * try/finally pattern.
 */
export interface FileLockPort {
  /**
   * Acquire the lock at lockPath. Returns ok(release) on success; err({ kind: "locked", … })
   * if the lock is held and retries are exhausted; err({ kind: "error", … }) for
   * unexpected failures. Caller MUST invoke the release callback to free the lock.
   */
  acquire(
    lockPath: string,
    opts?: LockOptions,
  ): Promise<Result<() => Promise<void>, LockError>>;

  /**
   * Release the lock at lockPath. Idempotent: double-release returns ok(undefined)
   * (does not throw) — matches the existing finally{} swallow at session-write-lock.ts:127-131.
   */
  release(lockPath: string): Promise<Result<void, LockError>>;

  /**
   * Acquire-execute-release pattern. Releases on both success AND throw.
   * Returns ok(value) on success; err on contention or runtime error.
   */
  withLock<T>(
    lockPath: string,
    fn: () => Promise<T>,
    opts?: LockOptions,
  ): Promise<Result<T, LockError>>;

  /** Check whether the lock at lockPath is currently held. */
  isLocked(lockPath: string): Promise<boolean>;

  /**
   * Reclaim stale locks under lockDir. Removes proper-lockfile sentinels (`*.lock`
   * directories) older than maxAgeMs that are not currently held. Default
   * maxAgeMs = 3_600_000 (1 hour) — matches session-write-lock.ts:24
   * DEFAULT_CLEANUP_MAX_AGE_MS. Returns the count of reclaimed locks.
   *
   * REQUIRED on the port per RES-ARCH-2 (the design's §5.2 enumeration omitted
   * cleanupStaleLocks but the §5.3 test list calls for it; the gap is closed here).
   */
  cleanupStaleLocks(lockDir: string, maxAgeMs?: number): Promise<number>;
}

/**
 * Lock error shape. `kind: "locked"` corresponds to proper-lockfile's ELOCKED
 * (lock held + retries exhausted); `kind: "error"` is everything else
 * (filesystem error, permission denied, etc.).
 */
export type LockError = { readonly kind: "locked" | "error"; readonly message: string };
