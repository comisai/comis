// SPDX-License-Identifier: Apache-2.0
/**
 * The default `TimerPort` for the background video poller's outer sweeper.
 *
 * Extracted from `setup-video-poller.ts` (file-size discipline — the poller file
 * sits at the 800-line cap; this pure, dependency-light helper is the natural
 * piece to hoist, NOT an allowlist bump). It wraps the sanctioned
 * `systemSetInterval`/`systemClearInterval` (the daemon composition root is a
 * sanctioned globals-gate root). Only `setInterval` is exercised by the poller;
 * the `setTimeout` member is provided for `TimerPort` interface completeness.
 *
 * @module
 */
import {
  systemSetInterval,
  systemClearInterval,
  type TimerPort,
  type TimerHandle,
} from "@comis/core";

/** Build the default `TimerPort` used when the poller is given no injected timer. */
export function defaultVideoPollerTimerPort(): TimerPort {
  const wrap = (h: ReturnType<typeof setInterval>): TimerHandle => {
    let cancelled = false;
    return {
      get cancelled() {
        return cancelled;
      },
      cancel() {
        if (cancelled) return;
        cancelled = true;
        systemClearInterval(h);
      },
      unref() {
        h.unref();
      },
    };
  };
  return {
    setInterval: (cb, ms) => wrap(systemSetInterval(cb, ms)),
    setTimeout: (cb, ms) => wrap(systemSetInterval(cb, ms)), // unused by the poller
  };
}
