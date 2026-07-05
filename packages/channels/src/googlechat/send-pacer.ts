// SPDX-License-Identifier: Apache-2.0
/**
 * Per-space outbound write pacer for the Google Chat send path.
 *
 * Google Chat caps message creation at one write per second per space, so a
 * chunked reply that fans several messages into a single space must space its
 * writes or trip a 429. This pacer enforces that ceiling proactively:
 * `acquire(space)` resolves only once at least `minIntervalMs` has elapsed since
 * the previous write to the SAME space. Different spaces are independent — a
 * write to one never blocks a write to another.
 *
 * Concurrent acquires for one space are serialized through a per-space promise
 * chain, so a burst cannot check-then-act its way past the interval by all
 * reading the same "next allowed" instant and firing together.
 *
 * The wait is abort-aware and rides an injected timer whose handle is unref'd,
 * so a pending pace-wait resolves promptly on abort and never blocks process
 * shutdown. The clock and timer are injected seams — no ambient time is read —
 * so the pacing is deterministic under test.
 *
 * @module
 */

import type { systemSetTimeout, systemClearTimeout } from "@comis/core";

/** Default minimum interval between writes to a single space. */
const DEFAULT_MIN_INTERVAL_MS = 1000;

/** Injected seams the pacer needs: a clock, a one-shot timer, and its canceller. */
export interface SendPacerDeps {
  /** Injected clock in epoch ms. */
  now: () => number;
  /** Injected one-shot timer for the pace-wait. */
  setTimeout: typeof systemSetTimeout;
  /** Injected timer canceller, used to drop a pending wait on abort. */
  clearTimeout?: typeof systemClearTimeout;
  /** Minimum ms between writes to one space. Defaults to 1000. */
  minIntervalMs?: number;
}

/** A per-space outbound write pacer. */
export interface SendPacer {
  /**
   * Resolve once a write to `space` may proceed under the per-space interval.
   * A supplied `signal` cancels a pending wait promptly (resolving, not
   * rejecting — the write is simply abandoned upstream).
   */
  acquire(space: string, signal?: AbortSignal): Promise<void>;
}

/**
 * Create a per-space write pacer enforcing at most one write per
 * `minIntervalMs` per space.
 */
export function createSendPacer(deps: SendPacerDeps): SendPacer {
  const minInterval = deps.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;
  // Per-space serialized tail: each acquire chains behind the prior same-space
  // acquire so the interval is enforced sequentially, never racily.
  const tails = new Map<string, Promise<void>>();
  // Per-space earliest-next-write instant, in epoch ms.
  const nextAllowed = new Map<string, number>();

  // Resolve after `ms`, or promptly if `signal` aborts. The timer handle is
  // unref'd so a pending wait never holds the event loop open at shutdown.
  function sleep(ms: number, signal?: AbortSignal): Promise<void> {
    if (ms <= 0) return Promise.resolve();
    if (signal?.aborted === true) return Promise.resolve();
    return new Promise<void>((resolve) => {
      // onAbort closes over `handle`; it only runs on the abort event, by which
      // point `handle` is assigned — so the forward reference is safe.
      const onAbort = (): void => {
        deps.clearTimeout?.(handle);
        resolve();
      };
      const handle = deps.setTimeout(() => {
        // Normal completion: drop the abort listener so it does not accumulate
        // on the signal across successive writes sharing one signal.
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      handle.unref?.();
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  async function waitTurn(space: string, signal?: AbortSignal): Promise<void> {
    const wait = Math.max(0, (nextAllowed.get(space) ?? 0) - deps.now());
    await sleep(wait, signal);
    nextAllowed.set(space, deps.now() + minInterval);
  }

  return {
    acquire(space: string, signal?: AbortSignal): Promise<void> {
      const prior = tails.get(space) ?? Promise.resolve();
      const mine = prior.then(() => waitTurn(space, signal));
      // The tail must never reject the chain — a failed or aborted wait still
      // releases the next same-space acquire.
      tails.set(
        space,
        mine.then(
          () => undefined,
          () => undefined,
        ),
      );
      return mine;
    },
  };
}
