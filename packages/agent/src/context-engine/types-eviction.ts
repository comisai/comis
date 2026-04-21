// SPDX-License-Identifier: Apache-2.0
/**
 * Dead content evictor types for observation-based eviction stats.
 *
 * @module
 */

// ---------------------------------------------------------------------------
// Dead Content Evictor
// ---------------------------------------------------------------------------

/**
 * Stats from a single dead content evictor run.
 * Reported via onEvicted callback for metrics aggregation.
 */
export interface EvictionStats {
  /** Total number of tool results evicted (replaced with placeholders). */
  evictedCount: number;
  /** Total characters removed by eviction. */
  evictedChars: number;
  /** Per-category eviction counts (file_read, exec, web, image, error). */
  categories: Record<string, number>;
}
