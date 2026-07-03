// SPDX-License-Identifier: Apache-2.0
/**
 * Shared announcement idempotency-key construction + a bounded delivery-dedup
 * primitive, used by every sub-agent completion-delivery path.
 *
 * `buildAnnounceKey` is the single source of truth for the
 * `${callerSessionKey}::${runId}` key. The success path (`deliverAnnouncement`)
 * and the failure path (`deliverFailureNotification`) both build it; two
 * hand-rolled literals would silently diverge on any delimiter/operand change
 * and break the cross-path dedup with no test catching the drift. One helper
 * converts that into a one-edit guarantee.
 *
 * `createDeliveryDedup` owns the delivered-key set OUTSIDE the
 * batcher so the no-batcher success branches can mark too (consistent dedup
 * whether or not a batcher is wired), and it is BOUNDED (FIFO eviction) like
 * every sibling structure in this subsystem (`runs` MAX_RUNS, the DLQ
 * `maxEntries`) — a long-running daemon spawning thousands of sub-agents must
 * not leak one Set entry per delivery for the whole process lifetime.
 *
 * @module
 */

/**
 * Build the shared idempotency key `${callerSessionKey}::${runId}`.
 *
 * `::` delimits the formatted session key's own single colons
 * (`callerSessionKey` is the formatted form, e.g. `default:user1:chan1`).
 * Returns `undefined` for a top-level spawn (no `callerSessionKey`) or an
 * empty-string key — those deliveries are never deduped.
 */
export function buildAnnounceKey(
  callerSessionKey: string | undefined,
  runId: string,
): string | undefined {
  return callerSessionKey ? `${callerSessionKey}::${runId}` : undefined;
}

/**
 * Bounded delivered-key set for completion-delivery idempotency.
 *
 * The dedup window only needs to outlive the debounce + DLQ-retry horizon
 * (minutes), not the daemon — an entry whose `runId` is long-terminal can never
 * be legitimately re-delivered through the live path. The default cap is set
 * well past any realistic concurrent in-flight + DLQ-retry window so eviction
 * never drops a key that is still inside its delivery window (eviction is
 * oldest-delivered FIFO; the oldest entry is, by construction, the furthest
 * past its in-flight window).
 */
export interface DeliveryDedup {
  /** Has this key already been delivered? */
  has(key: string): boolean;
  /** Record this key as delivered. Call ONLY after a confirmed successful send. */
  mark(key: string): void;
  /** Current number of retained keys (for tests / observability). */
  readonly size: number;
}

/**
 * Default delivered-key cap. 10_000 » any realistic concurrent in-flight +
 * DLQ-retry window (the DLQ itself caps at `maxEntries=100` and bounds
 * re-delivery by `attemptCount`/`maxAgeMs`), so a key is only ever evicted long
 * after its run is terminal and can no longer be legitimately re-delivered.
 */
export const MAX_DELIVERED_KEYS = 10_000;

/**
 * Create a bounded delivery-dedup. `Set` preserves insertion order, so the
 * first-inserted (oldest-delivered) key is evicted first on overflow.
 */
export function createDeliveryDedup(cap: number = MAX_DELIVERED_KEYS): DeliveryDedup {
  const keys = new Set<string>();
  return {
    has: (key: string) => keys.has(key),
    mark(key: string): void {
      // Re-marking an existing key must not grow the set (Set.add is a no-op for
      // a present member, and we only evict when adding a NEW key at capacity).
      if (keys.has(key)) return;
      if (keys.size >= cap) {
        const oldest = keys.values().next().value;
        if (oldest !== undefined) keys.delete(oldest);
      }
      keys.add(key);
    },
    get size() {
      return keys.size;
    },
  };
}
