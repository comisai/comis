// SPDX-License-Identifier: Apache-2.0
/**
 * DuplicateDetector: TTL-based deduplication for heartbeat notification text.
 *
 * Suppresses identical notification text for the same agent+channel compound
 * key within a configurable TTL window (default 24 hours). Used by the delivery
 * bridge to prevent notification spam when heartbeat checks repeatedly produce
 * the same result text.
 *
 */

/** DuplicateDetector public interface. */
export interface DuplicateDetector {
  /**
   * Returns true if key+text combination was seen within TTL.
   * Marks as seen if new or expired.
   */
  isDuplicate(key: string, text: string): boolean;

  /** Clear all tracked entries. */
  clear(): void;
}

/**
 * Create a DuplicateDetector with TTL-based expiration and injectable clock.
 *
 * @param opts.ttlMs - Time-to-live in milliseconds (default: 24 hours)
 * @param opts.maxEntries - Maximum entries before FIFO eviction (default: 500)
 * @param opts.nowMs - Injectable clock for deterministic testing (default: Date.now)
 */
export function createDuplicateDetector(opts?: {
  ttlMs?: number;
  maxEntries?: number;
  nowMs?: () => number;
}): DuplicateDetector {
  const ttlMs = opts?.ttlMs ?? 24 * 60 * 60 * 1000;
  const getNow = opts?.nowMs ?? Date.now;
  const maxEntries = opts?.maxEntries ?? 500;

  /** Map from compound key ("key:text") to firstSeenMs timestamp. */
  const seen = new Map<string, number>();

  function compoundKey(key: string, text: string): string {
    return `${key}\0${text}`;
  }

  /** Evict oldest entry when at capacity (FIFO via Map insertion order). */
  function evictIfNeeded(): void {
    if (seen.size >= maxEntries) {
      const oldestKey = seen.keys().next().value as string;
      seen.delete(oldestKey);
    }
  }

  return {
    isDuplicate(key: string, text: string): boolean {
      const compound = compoundKey(key, text);
      const now = getNow();
      const firstSeen = seen.get(compound);

      if (firstSeen !== undefined) {
        if (now - firstSeen < ttlMs) {
          // Still within TTL -- this is a duplicate
          return true;
        }
        // Expired -- delete and fall through to re-record
        seen.delete(compound);
      }

      // New entry or expired -- record and return false
      evictIfNeeded();
      seen.set(compound, now);
      return false;
    },

    clear(): void {
      seen.clear();
    },
  };
}
