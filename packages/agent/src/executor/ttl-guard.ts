// SPDX-License-Identifier: Apache-2.0
/**
 * TTL guard for Anthropic prompt cache expiry detection.
 *
 * Compares wall-clock elapsed time since the last assistant response against
 * TTL boundaries (5 min for "short", 60 min for "long"). When the cache has
 * likely expired, fires onTtlExpiry to reset adaptive retention to cold-start.
 *
 * Wall-clock TTL expiry check
 * Anthropic-only guard (non-Anthropic providers pass through unchanged)
 *
 * @module
 */

import type { StreamFn } from "@mariozechner/pi-agent-core";
import type { CacheRetention } from "@mariozechner/pi-ai";
import type { ComisLogger } from "@comis/infra";

import type { StreamFnWrapper } from "./stream-wrappers/types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Anthropic-family providers that support cache_control breakpoints. */
const ANTHROPIC_FAMILY = new Set(["anthropic", "anthropic-vertex", "amazon-bedrock"]);

/** TTL boundaries in milliseconds, keyed by CacheRetention value.
 *  "short" = 5 minutes, "long" = 60 minutes. */
const TTL_BOUNDARIES: Partial<Record<CacheRetention, number>> = {
  short: 5 * 60 * 1000,   // 300,000 ms
  long: 60 * 60 * 1000,   // 3,600,000 ms
};

// ---------------------------------------------------------------------------
// Module-level state
// ---------------------------------------------------------------------------

/** Per-session last assistant response timestamp and retention at that time. */
const sessionLastResponseTs = new Map<string, { ts: number; retention: CacheRetention }>();

// ---------------------------------------------------------------------------
// Config interface
// ---------------------------------------------------------------------------

export interface TtlGuardConfig {
  /** Session key for timestamp lookup. */
  sessionKey: string;
  /** Getter for the current cache retention (from AdaptiveCacheRetention). */
  getRetention: () => CacheRetention | undefined;
  /** Called when elapsed time exceeds the TTL boundary. */
  onTtlExpiry: () => void;
  /** Logger for debug output. */
  logger: ComisLogger;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a stream wrapper that checks wall-clock TTL expiry for Anthropic sessions.
 *
 * Non-Anthropic providers pass through unchanged.
 * If no prior timestamp exists for the session (cold-start), passes through.
 * When elapsed > TTL boundary, fires onTtlExpiry before calling next.
 * Always calls next(model, context, options) regardless of TTL outcome.
 */
export function createTtlGuard(config: TtlGuardConfig): StreamFnWrapper {
  return function ttlGuard(next: StreamFn): StreamFn {
    return (model, context, options) => {
      // Non-Anthropic providers skip TTL check entirely
      if (!ANTHROPIC_FAMILY.has(model.provider)) {
        return next(model, context, options);
      }

      // Cold-start: no prior timestamp for this session
      const lastEntry = sessionLastResponseTs.get(config.sessionKey);
      if (!lastEntry) {
        return next(model, context, options);
      }

      // Look up TTL boundary for the stored retention
      const ttlMs = TTL_BOUNDARIES[lastEntry.retention];
      if (ttlMs === undefined) {
        // Unknown retention (e.g., "none") -- no TTL to check
        return next(model, context, options);
      }

      // Check wall-clock elapsed time (strict greater-than, not >=)
      const elapsed = Date.now() - lastEntry.ts;
      if (elapsed > ttlMs) {
        config.logger.debug(
          { sessionKey: config.sessionKey, elapsedMs: elapsed, ttlMs, retention: lastEntry.retention },
          "TTL guard: cache likely expired, firing onTtlExpiry",
        );
        config.onTtlExpiry();
      }

      return next(model, context, options);
    };
  };
}

// ---------------------------------------------------------------------------
// Timestamp recording
// ---------------------------------------------------------------------------

/**
 * Record the timestamp and retention for the last assistant response in a session.
 * Called after each successful LLM response to update the TTL baseline.
 */
export function recordLastResponseTs(sessionKey: string, retention: CacheRetention): void {
  sessionLastResponseTs.set(sessionKey, { ts: Date.now(), retention });
}

/**
 * Clear the last response timestamp for a session.
 * Called during session cleanup (co-located with clearSessionCacheWarm, etc.).
 */
export function clearSessionLastResponseTs(sessionKey: string): void {
  sessionLastResponseTs.delete(sessionKey);
}

/**
 * Get elapsed milliseconds since the last assistant response for a session.
 * Returns undefined if no response has been recorded (cold-start).
 * Used by the idle-based thinking clear to determine if cache is cold.
 */
export function getElapsedSinceLastResponse(sessionKey: string): number | undefined {
  const entry = sessionLastResponseTs.get(sessionKey);
  if (!entry) return undefined;
  return Date.now() - entry.ts;
}

/**
 * Get the raw timestamp of the last recorded response for a session.
 * Returns undefined if no response has been recorded (cold-start).
 * Used by the cadence tracker to detect turn boundaries.
 */
export function getLastResponseTs(sessionKey: string): number | undefined {
  return sessionLastResponseTs.get(sessionKey)?.ts;
}

// ---------------------------------------------------------------------------
// Test-only export
// ---------------------------------------------------------------------------

/** Expose the internal Map for test assertions. Underscore prefix per project convention. */
export function _getSessionLastResponseTsForTest(): Map<string, { ts: number; retention: CacheRetention }> {
  return sessionLastResponseTs;
}
