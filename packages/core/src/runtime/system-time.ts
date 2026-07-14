// SPDX-License-Identifier: Apache-2.0
/**
 * System time helpers for in-package consumers that cannot accept an
 * injected ClockPort (notably `console-logger.ts`, which is a top-level
 * Pino-free logger primitive consumed by CLI bootstrap paths before any
 * dependency-injection container exists).
 *
 * Sanctioned runtime root (`packages/core/src/runtime/`) per
 * BOOTSTRAP_PATH_PATTERNS at test/support/globals-classifier.ts:92 —
 * Date.now() / new Date() calls inside this file are exempt from the
 * globals architecture rule by classifier, not by allowlist entry.
 *
 * @module
 */

/** Returns the current Unix-epoch millisecond timestamp. */
export function systemNowMs(): number {
  return Date.now();
}

/** Returns the current wall-clock as a `Date` instance. */
export function systemNowDate(): Date {
  return new Date();
}

/**
 * Build a `Date` instance from a known timestamp value (epoch ms, ISO string,
 * etc.). This is NOT a clock read — it converts an already-known value into a
 * Date for formatting/display. The classifier flags `new Date(arg)` regardless
 * of whether an argument is supplied; this sanctioned-root helper is the
 * approved indirection for in-package consumers that need Date instances for
 * formatting (e.g., `formatTimestamp(epochMs)`, `new Date(stored).toISOString()`).
 */
export function systemDateFrom(value: number | string): Date {
  return new Date(value);
}

/**
 * Sleep for the specified milliseconds. Promise-based wrapper around
 * `setTimeout` for use at sanctioned-root indirection points
 * (e.g., OAuth device-code polling loops, retry backoff).
 */
export function systemSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Opaque handle for `systemSetTimeout` — pass to `systemClearTimeout` to cancel. */
export type SystemTimeoutHandle = ReturnType<typeof setTimeout>;

/** Opaque handle for `systemSetInterval` — pass to `systemClearInterval` to cancel. */
export type SystemIntervalHandle = ReturnType<typeof setInterval>;

/**
 * Schedule a one-shot timeout. Returns a handle that can be passed to
 * `systemClearTimeout` to cancel. Use this from in-package consumers that
 * cannot accept an injected TimerPort.
 *
 * The returned handle has Node's native `.unref()` — callers that need to
 * unref the timer (so it doesn't keep the event loop alive) should chain
 * `.unref()` on the returned handle.
 */
export function systemSetTimeout(cb: () => void, ms: number): SystemTimeoutHandle {
  return setTimeout(cb, ms);
}

/** Cancel a pending `systemSetTimeout` handle. Idempotent. */
export function systemClearTimeout(handle: SystemTimeoutHandle): void {
  clearTimeout(handle);
}

/**
 * Schedule a one-shot timeout in the shape `withTimeout` from `@comis/shared`
 * expects: `(cb, ms) => cancel`. Use this at every Pattern-B (sanctioned-root)
 * `withTimeout` call site so the consumer doesn't have to inline a 4-line
 * `scheduleTimeout` lambda around `systemSetTimeout`/`systemClearTimeout`.
 *
 * Equivalent to:
 *   `(cb, ms) => { const h = systemSetTimeout(cb, ms); return () => systemClearTimeout(h); }`
 *
 * `@comis/shared` cannot import `TimerPort` (leaf-invariant), so its
 * `withTimeout` takes the bare structural callback type. This helper is
 * the canonical Pattern-B adapter from the sanctioned-root timeout
 * helpers to that callback shape.
 */
export function systemScheduleTimeout(cb: () => void, ms: number): () => void {
  const handle = setTimeout(cb, ms);
  return () => clearTimeout(handle);
}

/**
 * Schedule a recurring interval. Returns a handle that can be passed to
 * `systemClearInterval` to cancel. The returned handle has Node's native
 * `.unref()` — callers that need to unref the interval (so it doesn't keep
 * the event loop alive on SIGTERM) MUST chain `.unref()` on the returned
 * handle. Daemon shutdown safety depends on this.
 */
export function systemSetInterval(cb: () => void, ms: number): SystemIntervalHandle {
  return setInterval(cb, ms);
}

/** Cancel a recurring `systemSetInterval` handle. Idempotent. */
export function systemClearInterval(handle: SystemIntervalHandle): void {
  clearInterval(handle);
}

/**
 * Read an environment variable. Sanctioned-root indirection equivalent of
 * `process.env[key]` — for in-package consumers that cannot accept an injected
 * EnvPort. Returns `undefined` if the variable is not set.
 *
 * Use this for non-secret env reads at trust-boundary call sites:
 *   - NODE_ENV (set by the launcher, gates dev-mode response validation)
 *   - INVOCATION_ID / NOTIFY_SOCKET (systemd execution detection)
 *   - PM2_HOME (set by pm2, gates pm2-process detection)
 *
 * Secret reads (API keys, OAuth tokens, etc.) MUST go through SecretManager.
 * This helper is intentionally narrow.
 */
// eslint-disable-next-line no-restricted-syntax, security/detect-object-injection -- sanctioned-root env helper at the trust boundary; consumers read non-secret env vars (NODE_ENV, INVOCATION_ID, NOTIFY_SOCKET, PM2_HOME). Secrets must use SecretManager.
export function systemGetEnv(key: string): string | undefined { return process.env[key]; }

/**
 * Return a shallow copy of `process.env`. Sanctioned-root indirection for
 * the rare cases that need the full env (e.g., subprocess spawn env that
 * inherits but strips a specific set of keys). Returns a NEW object so the
 * caller can mutate without affecting the live env.
 *
 * Use sparingly — most callers should read specific keys via `systemGetEnv`.
 */
export function systemEnvSnapshot(): NodeJS.ProcessEnv { return { ...process.env }; }
