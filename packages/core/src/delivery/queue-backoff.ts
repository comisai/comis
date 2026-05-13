// SPDX-License-Identifier: Apache-2.0
/**
 * Phase 30 — Queue backoff schedule + helpers.
 *
 * Relocated from packages/channels/src/shared/deliver-to-channel.ts:94-186 in
 * plan 06 (the standalone file was deleted; QUEUE_BACKOFF_SCHEDULE_MS,
 * computeQueueBackoff, resolveChunkLimit are still consumed by daemon and
 * channels code, so they live in core/src/delivery/ alongside the
 * DeliveryService factory).
 *
 * @module
 */

// ---------------------------------------------------------------------------
// Chunk-limit default
// ---------------------------------------------------------------------------

/**
 * Universal chunk limit default.
 *
 * All platforms default to this unless overridden by ChannelCapability or
 * config. This is a UX limit, not an API limit -- shorter chunks are more
 * readable on mobile.
 */
const DEFAULT_CHUNK_LIMIT = 4000;

// ---------------------------------------------------------------------------
// Queue backoff schedule
// ---------------------------------------------------------------------------

/**
 * Backoff schedule for queue nack retry delays (milliseconds).
 *
 * Index = attemptCount (0-based from queue entry).
 * Values: 5s, 25s, 2m, 10m, 10m (cap).
 *
 * Exported for use by drain cycle.
 */
export const QUEUE_BACKOFF_SCHEDULE_MS: readonly number[] = Object.freeze([
  5_000,
  25_000,
  120_000,
  600_000,
  600_000,
]);

/**
 * Compute the backoff delay for a queue retry based on attempt count.
 *
 * Uses QUEUE_BACKOFF_SCHEDULE_MS, clamping at the last value for
 * attempt counts beyond the schedule length.
 *
 * Exported for use by drain cycle.
 *
 * @param attemptCount - The current attempt count (0-based)
 * @returns Delay in milliseconds before next retry
 */
export function computeQueueBackoff(attemptCount: number): number {
  const idx = Math.min(attemptCount, QUEUE_BACKOFF_SCHEDULE_MS.length - 1);
  return QUEUE_BACKOFF_SCHEDULE_MS[idx];
}

// ---------------------------------------------------------------------------
// Chunk limit resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the effective chunk limit for a delivery.
 *
 * Resolution order (first defined wins):
 *   1. maxCharsOverride -- caller-provided explicit override
 *   2. DEFAULT_CHUNK_LIMIT (4000) -- universal fallback
 *
 * Exported for callers that need the resolved limit (execution pipeline)
 * and for testing.
 */
export function resolveChunkLimit(maxCharsOverride?: number): number {
  if (typeof maxCharsOverride === "number" && maxCharsOverride > 0) {
    return maxCharsOverride;
  }
  return DEFAULT_CHUNK_LIMIT;
}
