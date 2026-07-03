// SPDX-License-Identifier: Apache-2.0
/**
 * Pino-free ComisLogger decorator: collapse repeated identical log lines.
 *
 * `withDedup` wraps a {@link ComisLogger} so repeated messages keyed by the
 * same dedup key fire the underlying logger ONCE. The key is
 * `fingerprint(`${level}:${k}`)`, where `k` is the caller-supplied `dedupKey`
 * object field if present, else the message string (the shared
 * `fingerprint` digest is the key). The first occurrence passes through unchanged;
 * repeats are suppressed and their count tracked (a collapsed signal, never a
 * silently dropped one).
 *
 * Mirrors `console-logger.ts` — the existing Pino-free `ComisLogger` precedent
 * in `@comis/core` (object literal with a level getter/setter + the 7 level
 * methods + `child`). It lives in `@comis/core`, NOT `@comis/infra`, because
 * its only consumers (`tool-result-size-bouncer`, `oauth-token-manager`) are in
 * `@comis/agent`, which is forbidden from importing `@comis/infra`
 * (`architecture-graph.test.ts` locks `agent ↛ infra`). This is the same
 * decision the project already made for `fingerprint`.
 *
 * TTL: `opts.ttlMs` defaults to `undefined` = process-lifetime dedup. A
 * security-relevant repeated WARN is therefore collapsed-with-count within the
 * process but its FIRST occurrence always fires — a security signal is
 * collapsed, never fully suppressed. When a TTL IS supplied,
 * a key whose first emission is older than `ttlMs` is treated as a fresh entry
 * and re-emitted.
 *
 * @module
 */
import type { ComisLogger, LogMethod } from "./log-fields.js";
import { fingerprint } from "./fingerprint.js";
import { systemNowMs } from "../runtime/system-time.js";

/** Tuning for {@link withDedup}. */
export interface WithDedupOptions {
  /**
   * Re-emit window in milliseconds. `undefined` (default) = process-lifetime
   * dedup. When set, a repeat is
   * re-emitted once `ttlMs` has elapsed since the key's first emission.
   */
  ttlMs?: number;
  /**
   * Reserved hard-cap on the number of tracked keys (future eviction hook).
   * Accepted but currently a no-op — do not
   * rely on it for eviction until a test pins the behavior.
   */
  max?: number;
}

export function withDedup(logger: ComisLogger, opts: WithDedupOptions = {}): ComisLogger {
  const seen = new Map<string, { count: number; firstMs: number }>();

  const deriveKey = (level: string, args: readonly unknown[]): string => {
    const obj = args.find((a) => a !== null && typeof a === "object") as
      | Record<string, unknown>
      | undefined;
    const msg = args.find((a) => typeof a === "string") as string | undefined;
    const k =
      obj !== undefined && typeof obj["dedupKey"] === "string"
        ? (obj["dedupKey"] as string)
        : (msg ?? "");
    return fingerprint(`${level}:${k}`);
  };

  const wrap = (level: keyof ComisLogger): LogMethod => {
    return (...args: unknown[]): void => {
      const key = deriveKey(String(level), args);
      const now = systemNowMs();
      const prior = seen.get(key);
      const expired =
        prior !== undefined && opts.ttlMs !== undefined && now - prior.firstMs >= opts.ttlMs;
      if (prior !== undefined && !expired) {
        prior.count++;
        return; // suppress the repeat (collapsed; count tracked)
      }
      seen.set(key, { count: 1, firstMs: now });
      (logger[level] as LogMethod)(...args); // first occurrence → pass through unchanged
    };
  };

  const wrapped: ComisLogger = {
    get level(): string {
      return logger.level;
    },
    set level(l: string) {
      logger.level = l;
    },
    trace: wrap("trace"),
    debug: wrap("debug"),
    info: wrap("info"),
    warn: wrap("warn"),
    error: wrap("error"),
    fatal: wrap("fatal"),
    audit: wrap("audit"),
    child(bindings: Record<string, unknown>): ComisLogger {
      return withDedup(logger.child(bindings), opts);
    },
  };
  return wrapped;
}
