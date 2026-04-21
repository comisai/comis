// SPDX-License-Identifier: Apache-2.0
/**
 * Heartbeat response cache: TTL-based cache for heartbeat query+response
 * pairs. Deduplicates identical heartbeat queries within a TTL window to
 * avoid redundant LLM calls when the same contextual input produces the
 * same result.
 *
 * Follows the same pattern as createDuplicateDetector in this package.
 *
 * @module
 */

import { createHash } from "node:crypto";
import { createTTLCache } from "@comis/shared";
import type { TTLCache } from "@comis/shared";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Heartbeat response cache interface. */
export interface HeartbeatResponseCache {
  /** Get cached response for a prompt hash. Returns undefined on miss. */
  get(promptHash: string): string | undefined;
  /** Store a response with TTL. */
  set(promptHash: string, response: string): void;
  /** Clear all cached entries. */
  clear(): void;
  /** Number of cached entries. */
  size(): number;
}

// ---------------------------------------------------------------------------
// Hash helper
// ---------------------------------------------------------------------------

/**
 * Compute a compact hash key from heartbeat prompt text and event digest.
 *
 * @param promptText - The heartbeat prompt text
 * @param eventDigest - A digest of system events / HEARTBEAT.md content
 * @returns 16-character hex hash
 */
export function hashHeartbeatPrompt(promptText: string, eventDigest: string): string {
  return createHash("sha256")
    .update(promptText + "\0" + eventDigest)
    .digest("hex")
    .slice(0, 16);
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a heartbeat response cache with TTL expiration and max entry limit.
 * Delegates to createTTLCache from @comis/shared.
 *
 * @param opts.ttlMs - Time-to-live in milliseconds (default: 30 minutes)
 * @param opts.maxEntries - Maximum cache entries (default: 50)
 * @param opts.nowMs - Injectable clock for deterministic testing (default: Date.now)
 */
export function createHeartbeatResponseCache(opts?: {
  ttlMs?: number;
  maxEntries?: number;
  nowMs?: () => number;
}): HeartbeatResponseCache {
  const cache: TTLCache<string> = createTTLCache<string>({
    ttlMs: opts?.ttlMs ?? 30 * 60 * 1000,
    maxEntries: opts?.maxEntries ?? 50,
    nowMs: opts?.nowMs,
  });

  return {
    get(promptHash: string): string | undefined {
      return cache.get(promptHash);
    },

    set(promptHash: string, response: string): void {
      cache.set(promptHash, response);
    },

    clear(): void {
      cache.clear();
    },

    size(): number {
      return cache.size();
    },
  };
}
