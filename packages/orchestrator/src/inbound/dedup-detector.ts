// SPDX-License-Identifier: Apache-2.0
/**
 * Bounded-LRU duplicate inbound message detector.
 *
 * Keyed by source tuple string. A bounded insertion-ordered Map
 * is used for FIFO insertion-order eviction. The check is entirely synchronous
 * — no await, no setInterval.
 *
 * Eviction strategy (per `.reserve()` call — no background timer):
 *   1. Sweep the front of the Map deleting entries whose firstSeenAt is
 *      older than `ts - windowMs` (FIFO = oldest entries are at the front).
 *   2. After the age sweep, if the Map still exceeds maxEntries, delete the
 *      current oldest entry (first Map key).
 *
 * Memory bound: O(min(maxEntries, window-rate)).
 * Overhead: sub-microsecond at the target ~30 msg/s load.
 *
 * @module
 */

import { systemNowMs } from "@comis/core";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Reservation returned for a newly admitted physical source. */
export interface DedupReservation {
  /** Retain the source identity after the ingress attempt finishes successfully. */
  commit(): void;
  /** Release an uncommitted identity so a platform retry can be admitted. */
  rollback(): void;
}

/** Result of reserving one physical source identity. */
export interface DedupReservationResult {
  /** True when the messageId was already seen within the window. */
  isDuplicate: boolean;
  /** Timestamp (epoch ms) when the messageId was first seen.
   *  Undefined when isDuplicate is false. */
  firstSeenAt?: number;
  /** Milliseconds between firstSeenAt and the current check.
   *  Undefined when isDuplicate is false. */
  deltaMs?: number;
  /** Present only for a newly admitted source. */
  reservation?: DedupReservation;
}

/**
 * Synchronous duplicate detector interface.
 * The `.reserve()` method is the single API surface.
 */
export interface DedupDetector {
  /** Reserve a source identity if it is not already pending or committed. */
  reserve(sourceKey: string): DedupReservationResult;
}

/** Construction options for createDedupDetector. */
export interface DedupDetectorOptions {
  /** Maximum number of messageIds to track simultaneously.
   *  When exceeded, the oldest (FIFO) entry is evicted.
   *  Default: 1024. */
  maxEntries?: number;
  /** Window duration in milliseconds. Entries older than this
   *  are considered expired and evicted on the next check.
   *  Default: 10_000 (10 seconds). */
  windowMs?: number;
  /** Clock function — injectable for deterministic tests.
   *  Default: systemNowMs from @comis/core. */
  now?: () => number;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a bounded-LRU duplicate detector.
 *
 * The detector is channel-agnostic — callers supply channelType/chatId
 * separately when emitting the dedup:duplicate_inbound event.
 *
 * @example
 * ```ts
 * const detector = createDedupDetector();
 * const r = detector.reserve(sourceKey);
 * if (r.isDuplicate) {
 *   // emit dedup:duplicate_inbound, log WARN
 * }
 * ```
 */
export function createDedupDetector(opts: DedupDetectorOptions = {}): DedupDetector {
  const maxEntries = opts.maxEntries ?? 1024;
  const windowMs   = opts.windowMs   ?? 10_000;
  const now        = opts.now        ?? systemNowMs;

  interface Entry {
    firstSeenAt: number;
    token: number;
    committed: boolean;
  }
  const seen = new Map<string, Entry>();
  let nextToken = 1;

  return {
    reserve(sourceKey: string): DedupReservationResult {
      const ts = now();

      // Step 1: evict expired entries from the front (FIFO oldest-first).
      // Map iteration visits in insertion order → oldest keys are first.
      for (const [key, entry] of seen) {
        if (entry.firstSeenAt < ts - windowMs) {
          seen.delete(key);
        } else {
          // Since the Map is ordered by insertion, once we find a non-expired
          // entry we know all subsequent entries are also non-expired.
          break;
        }
      }

      // Step 2: check for an existing entry BEFORE inserting (synchronous
      // read-then-write — no await between them; safe in Node's event loop).
      const existing = seen.get(sourceKey);
      if (existing !== undefined) {
        const firstSeenAt = existing.firstSeenAt;
        // Intentionally do NOT refresh the timestamp — keep firstSeenAt
        // stable so deltaMs grows monotonically within the window.
        return { isDuplicate: true, firstSeenAt, deltaMs: ts - firstSeenAt };
      }

      // Step 3: insert and enforce the size cap.
      const entry: Entry = {
        firstSeenAt: ts,
        token: nextToken++,
        committed: false,
      };
      seen.set(sourceKey, entry);
      if (seen.size > maxEntries) {
        // Delete the oldest entry (first key in insertion order).
        const oldest = seen.keys().next().value;
        if (oldest !== undefined) {
          seen.delete(oldest);
        }
      }

      let settled = false;
      const reservation: DedupReservation = {
        commit(): void {
          if (settled) return;
          settled = true;
          const current = seen.get(sourceKey);
          if (current?.token === entry.token) current.committed = true;
        },
        rollback(): void {
          if (settled) return;
          settled = true;
          const current = seen.get(sourceKey);
          if (current?.token === entry.token && !current.committed) {
            seen.delete(sourceKey);
          }
        },
      };

      return { isDuplicate: false, reservation };
    },
  };
}
