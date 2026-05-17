// SPDX-License-Identifier: Apache-2.0
/**
 * FakeClock: a per-test ClockPort implementation with explicit advance(ms).
 *
 * Strictly more useful than vi.useFakeTimers() because the fake is per-test
 * instead of process-global — tests can construct multiple independent clocks
 * without ceremony.
 *
 * @module
 */
import type { ClockPort } from "@comis/core";

export interface FakeClock extends ClockPort {
  advance(ms: number): void;
}

export function createFakeClock(initialMs: number): FakeClock {
  let now = initialMs;
  return {
    now: () => now,
    nowDate: () => new Date(now),
    advance: (ms) => {
      now += ms;
    },
  };
}
