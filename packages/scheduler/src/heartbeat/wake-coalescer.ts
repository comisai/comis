// SPDX-License-Identifier: Apache-2.0
/**
 * Wake Coalescer: Centralized wake dispatch with debouncing and priority deduplication.
 *
 * Prevents duplicate heartbeat executions from rapid-fire wake requests by:
 * - Debouncing within a configurable window (default 250ms)
 * - Applying priority-based deduplication (higher overrides lower)
 * - Automatically retrying when heartbeat is in-flight
 * - Tracking pending wakes per key for independent coalescing
 *
 * Implements debouncing, priority deduplication, and in-flight retry.
 *
 * @module
 */

import type {
  WakeReasonKind,
  PendingWake,
  WakeCoalescerDeps,
  WakeCoalescer,
} from "./wake-types.js";
import { WAKE_PRIORITY } from "./wake-types.js";

/**
 * Create a wake coalescer that debounces rapid heartbeat wake requests.
 *
 * @param deps - Dependencies including runOnce, logger, and optional timing config
 * @returns WakeCoalescer with requestHeartbeatNow and shutdown methods
 */
export function createWakeCoalescer(deps: WakeCoalescerDeps): WakeCoalescer {
  const { runOnce, logger } = deps;
  const coalesceWindowMs = deps.coalesceWindowMs ?? 250;
  const busyRetryMs = deps.busyRetryMs ?? 1000;
  const getNow = deps.nowMs ?? Date.now;

  /** Pending wakes keyed by dispatch key. */
  const pending = new Map<string, PendingWake>();

  /** Keys currently executing runOnce. */
  const inFlight = new Set<string>();

  /**
   * Fire the debounced wake: set in-flight, run once, clear in-flight.
   */
  async function dispatch(key: string, reason: WakeReasonKind): Promise<void> {
    inFlight.add(key);
    logger.debug({ reason, key }, "Wake dispatching");

    try {
      await runOnce();
    } finally {
      inFlight.delete(key);
      logger.debug({ key }, "Wake dispatch complete");
    }
  }

  function requestHeartbeatNow(reason: WakeReasonKind, key = "global"): void {
    const priority = WAKE_PRIORITY[reason];

    logger.debug({ reason, key, priority }, "Wake request received");

    // ---- In-flight handling ----
    if (inFlight.has(key)) {
      const existing = pending.get(key);

      if (existing?.retryTimer !== undefined) {
        // Retry already pending -- only upgrade priority if higher
        if (priority > existing.priority) {
          existing.reason = reason;
          existing.priority = priority;
          logger.debug(
            { oldReason: existing.reason, newReason: reason, key },
            "Wake retry priority upgraded",
          );
        }
        logger.debug(
          { reason, key },
          "Wake deferred (in-flight), retry already pending",
        );
        return;
      }

      // Schedule a single retry after busyRetryMs
      const retryTimer = setTimeout(() => {
        // Remove the retry entry and re-request
        const entry = pending.get(key);
        if (entry) {
          pending.delete(key);
        }
        requestHeartbeatNow(reason, key);
      }, busyRetryMs);
      retryTimer.unref();

      // Store as pending with retry timer
      pending.set(key, {
        reason,
        priority,
        debounceTimer: undefined as unknown as ReturnType<typeof setTimeout>,
        retryTimer,
        requestedAt: getNow(),
      });

      logger.debug(
        { reason, key, busyRetryMs },
        "Wake deferred (in-flight), retry scheduled",
      );
      return;
    }

    // ---- Priority-based coalescing ----
    const existingPending = pending.get(key);

    if (existingPending) {
      if (priority > existingPending.priority) {
        // Higher priority: replace reason and reset debounce timer
        clearTimeout(existingPending.debounceTimer);
        const oldReason = existingPending.reason;

        existingPending.reason = reason;
        existingPending.priority = priority;

        const debounceTimer = setTimeout(() => {
          const entry = pending.get(key);
          if (!entry) return;
          pending.delete(key);
          void dispatch(key, entry.reason);
        }, coalesceWindowMs);
        debounceTimer.unref();
        existingPending.debounceTimer = debounceTimer;

        logger.debug(
          { oldReason, newReason: reason, key },
          "Wake priority upgraded",
        );
      } else {
        // Lower or equal priority: coalesce (ignore, keep existing timer)
        logger.debug(
          { reason, key, existingReason: existingPending.reason },
          "Wake coalesced (lower/equal priority ignored)",
        );
      }
      return;
    }

    // ---- New pending entry with debounce timer ----
    const debounceTimer = setTimeout(() => {
      const entry = pending.get(key);
      if (!entry) return;
      pending.delete(key);
      void dispatch(key, entry.reason);
    }, coalesceWindowMs);
    debounceTimer.unref();

    pending.set(key, {
      reason,
      priority,
      debounceTimer,
      requestedAt: getNow(),
    });
  }

  function shutdown(): void {
    for (const [, entry] of pending) {
      clearTimeout(entry.debounceTimer);
      if (entry.retryTimer !== undefined) {
        clearTimeout(entry.retryTimer);
      }
    }
    pending.clear();
    inFlight.clear();
  }

  return { requestHeartbeatNow, shutdown };
}
