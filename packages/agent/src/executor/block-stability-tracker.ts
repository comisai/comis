// SPDX-License-Identifier: Apache-2.0
/**
 * Block stability tracker: per-zone content stability tracking across
 * consecutive API calls for a session.
 *
 * Provides the core detection mechanism -- knowing WHEN a
 * breakpoint zone's content has been stable long enough to warrant 1h TTL
 * promotion. This is the data layer; the TTL assignment pipeline wires it.
 *
 * State shape: Map<sessionKey, Map<zoneName, { hash, consecutiveCount }>>
 * Same module-level Map pattern as sessionCacheWarm in executor-session-state.ts.
 *
 * @module
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Tracks per-zone content stability across consecutive API calls.
 *
 * Call recordZoneHash() after each placeCacheBreakpoints invocation,
 * then isStable() to check whether the zone qualifies for TTL promotion.
 */
export interface BlockStabilityTracker {
  /** Record a content hash for a zone in a session. Call after placeCacheBreakpoints. */
  recordZoneHash(sessionKey: string, zone: string, contentHash: number): void;
  /** Check if a zone has been stable for >= threshold consecutive calls. */
  isStable(sessionKey: string, zone: string, threshold: number): boolean;
}

// ---------------------------------------------------------------------------
// Module-level state
// ---------------------------------------------------------------------------

// Map<sessionKey, Map<zoneName, { hash: number; consecutiveCount: number }>>
const sessionBlockStability = new Map<string, Map<string, { hash: number; consecutiveCount: number }>>();

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a BlockStabilityTracker instance.
 *
 * Uses module-level Map for per-session state (same pattern as
 * sessionCacheWarm in executor-session-state.ts).
 *
 * @returns BlockStabilityTracker with recordZoneHash and isStable methods
 */
export function createBlockStabilityTracker(): BlockStabilityTracker {
  return {
    recordZoneHash(sessionKey: string, zone: string, contentHash: number): void {
      let zones = sessionBlockStability.get(sessionKey);
      if (!zones) {
        zones = new Map();
        sessionBlockStability.set(sessionKey, zones);
      }

      const entry = zones.get(zone);
      if (!entry || entry.hash !== contentHash) {
        // New zone or hash changed: reset/init with count 1
        zones.set(zone, { hash: contentHash, consecutiveCount: 1 });
      } else {
        // Same hash: increment consecutive count
        entry.consecutiveCount++;
      }
    },

    isStable(sessionKey: string, zone: string, threshold: number): boolean {
      const zones = sessionBlockStability.get(sessionKey);
      if (!zones) return false;
      const entry = zones.get(zone);
      return entry !== undefined && entry.consecutiveCount >= threshold;
    },
  };
}

// ---------------------------------------------------------------------------
// Session cleanup
// ---------------------------------------------------------------------------

/**
 * Clear all block stability tracking state for a given session.
 * Called from session-snapshot-cleanup.ts on session expiry.
 *
 * @param sessionKey - The formatted session key to clean up
 */
export function clearSessionBlockStability(sessionKey: string): void {
  sessionBlockStability.delete(sessionKey);
}
