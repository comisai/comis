// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { createCallRateLimiter } from "./call-rate-limiter.js";
import type { CallRateLimiter } from "./call-rate-limiter.js";
import { createFakeClock } from "../../../../test/support/fake-clock.js";
import {
  createFakeTimers,
  type FakeTimers,
} from "../../../../test/support/fake-timers.js";
import type { FakeClock } from "../../../../test/support/fake-clock.js";

// ---------------------------------------------------------------------------
// Per-root + per-socket calls/sec bounded by a sliding window, with a
// connection-churn cap and the maxEntries + TTL-evict leak guards from the
// injection-rate-limiter pattern. Clock + timers are INJECTED — no Date.now.
// ---------------------------------------------------------------------------

interface Harness {
  clock: FakeClock;
  timers: FakeTimers;
  limiter: CallRateLimiter;
}

function makeLimiter(
  overrides: Partial<Parameters<typeof createCallRateLimiter>[0]> = {},
): Harness {
  const clock = createFakeClock(1_000_000);
  const timers = createFakeTimers(1_000_000);
  const limiter = createCallRateLimiter({
    clock,
    timers,
    callWindowMs: 1_000,
    maxCallsPerWindow: 3,
    churnWindowMs: 60_000,
    maxChurnPerWindow: 2,
    maxEntries: 10_000,
    ...overrides,
  });
  return { clock, timers, limiter };
}

describe("createCallRateLimiter", () => {
  it("exposes tryCall, tryChurn, size, and destroy on the returned limiter", () => {
    const { limiter } = makeLimiter();
    expect(typeof limiter.tryCall).toBe("function");
    expect(typeof limiter.tryChurn).toBe("function");
    expect(typeof limiter.size).toBe("function");
    expect(typeof limiter.destroy).toBe("function");
    limiter.destroy();
  });

  it("allows calls up to the window cap then denies the over-cap call with reason rate", () => {
    const { clock, limiter } = makeLimiter({
      callWindowMs: 1_000,
      maxCallsPerWindow: 3,
    });
    expect(limiter.tryCall("root-A")).toEqual({ ok: true });
    expect(limiter.tryCall("root-A")).toEqual({ ok: true });
    expect(limiter.tryCall("root-A")).toEqual({ ok: true });
    expect(limiter.tryCall("root-A")).toEqual({ ok: false, reason: "rate" });

    // Slide the window past the oldest timestamps — a fresh call is allowed.
    clock.advance(1_001);
    expect(limiter.tryCall("root-A")).toEqual({ ok: true });
    limiter.destroy();
  });

  it("keeps per-key call budgets independent across distinct root and socket keys", () => {
    const { limiter } = makeLimiter({ maxCallsPerWindow: 3 });
    // Exhaust root-A's budget.
    limiter.tryCall("root:root-A");
    limiter.tryCall("root:root-A");
    limiter.tryCall("root:root-A");
    expect(limiter.tryCall("root:root-A")).toEqual({ ok: false, reason: "rate" });

    // A distinct socket key is unaffected by root-A being at its cap.
    expect(limiter.tryCall("socket:socket-1")).toEqual({ ok: true });
    limiter.destroy();
  });

  it("bounds the bucket map at maxEntries by evicting the oldest distinct key", () => {
    const { clock, limiter } = makeLimiter({ maxEntries: 2 });
    limiter.tryCall("key-1");
    clock.advance(1); // make key-1 strictly oldest by most-recent timestamp
    limiter.tryCall("key-2");
    clock.advance(1);
    expect(limiter.size()).toBe(2);

    // A 3rd distinct key forces an eviction — the map never exceeds maxEntries.
    limiter.tryCall("key-3");
    expect(limiter.size()).toBe(2);
    limiter.destroy();
  });

  it("bounds connection churn per root per window and denies over the churn cap with reason churn", () => {
    const { clock, limiter } = makeLimiter({
      churnWindowMs: 60_000,
      maxChurnPerWindow: 2,
    });
    expect(limiter.tryChurn("root-A")).toEqual({ ok: true });
    expect(limiter.tryChurn("root-A")).toEqual({ ok: true });
    expect(limiter.tryChurn("root-A")).toEqual({ ok: false, reason: "churn" });

    // Churn keys are independent of call keys and per-root.
    expect(limiter.tryChurn("root-B")).toEqual({ ok: true });

    // Slide the churn window — churn is allowed again.
    clock.advance(60_001);
    expect(limiter.tryChurn("root-A")).toEqual({ ok: true });
    limiter.destroy();
  });

  it("evicts an idle key via the unref'd TTL timer so the bucket map drops it", () => {
    const { clock, timers, limiter } = makeLimiter({
      callWindowMs: 1_000,
      maxCallsPerWindow: 3,
    });
    limiter.tryCall("root-A");
    expect(limiter.size()).toBe(1);

    // The TTL timer is unref'd (does not block process exit).
    const record = timers.unrefRecord();
    expect(record.some((e) => e.unrefCalled && !e.cancelled)).toBe(true);

    // After the TTL elapses with no further calls, the timer fires and the
    // bucket is removed. Advance both clock and timers past the TTL.
    clock.advance(5_000);
    timers.advance(5_000);
    expect(limiter.size()).toBe(0);
    limiter.destroy();
  });

  it("cancels all scheduled timers on destroy for a clean daemon shutdown", () => {
    const { timers, limiter } = makeLimiter();
    limiter.tryCall("root-A");
    limiter.tryCall("root-B");
    limiter.destroy();

    // Every timer the limiter scheduled is cancelled after destroy().
    const record = timers.unrefRecord();
    expect(record.length).toBeGreaterThan(0);
    expect(record.every((e) => e.cancelled)).toBe(true);
  });
});
