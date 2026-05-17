// SPDX-License-Identifier: Apache-2.0
/**
 * Node-backed TimerPort adapter.
 *
 * Returns closure-cancellable TimerHandle objects:
 *   - handle.cancel()  → clearTimeout/clearInterval the underlying Node timer
 *   - handle.unref()   → t.unref() with cancel-safety + idempotency guard
 *   - handle.cancelled → readonly flag for callers and shutdown tests
 *
 * Idempotency contract:
 *   - unref() on a cancelled timer is a no-op (cancelled flag guards delegation)
 *   - unref() called twice is a no-op (unrefCalled flag guards delegation)
 *   - cancel() called twice is a no-op (cancelled flag guards delegation)
 *
 * Sanctioned runtime root — setTimeout/setInterval/clearTimeout/clearInterval
 * are exempt from the globals architecture rule by classifier.
 *
 * @module
 */
import type { TimerPort, TimerHandle } from "@comis/core";

export function createSystemTimers(): TimerPort {
  function wrap(t: NodeJS.Timeout): TimerHandle {
    let cancelled = false;
    let unrefCalled = false;
    return {
      get cancelled() {
        return cancelled;
      },
      cancel() {
        if (cancelled) return;
        cancelled = true;
        clearTimeout(t); // valid for clearInterval-backed handles too
      },
      unref() {
        if (cancelled || unrefCalled) return;
        unrefCalled = true;
        t.unref();
      },
    };
  }
  return {
    setTimeout: (cb, ms) => wrap(setTimeout(cb, ms)),
    setInterval: (cb, ms) => wrap(setInterval(cb, ms)),
  };
}
