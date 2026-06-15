// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for the shared bounded-poll helper (DIVERGENCE 5).
 *
 * NO real timers: the deadline clock is injected via `createFakeClock` and the
 * `pollUntilDone` sleep is an injected lambda that ADVANCES the fake clock
 * synchronously (AGENTS.md §2.5 — never `vi.useFakeTimers`, never real
 * setTimeout). This proves the helper performs no wall-clock waiting and that
 * Phase 189's daemon poller can drive it deterministically.
 *
 * @module
 */
import { describe, it, expect } from "vitest";
import { createFakeClock } from "../../../../test/support/fake-clock.js";
import { createPollDeadline, pollUntilDone, type PollOutcome } from "./poll-deadline.js";

describe("createPollDeadline", () => {
  it("exceeded() is false at t0 and true once the clock advances >= timeoutMs", () => {
    const clock = createFakeClock(1_000);
    const deadline = createPollDeadline(1_000, clock.now);

    expect(deadline.exceeded()).toBe(false);
    clock.advance(999);
    expect(deadline.exceeded()).toBe(false);
    clock.advance(1); // now exactly at the deadline
    expect(deadline.exceeded()).toBe(true);
  });

  it("remainingMs() decreases as the clock advances and floors at 0", () => {
    const clock = createFakeClock(0);
    const deadline = createPollDeadline(1_000, clock.now);

    expect(deadline.remainingMs()).toBe(1_000);
    clock.advance(400);
    expect(deadline.remainingMs()).toBe(600);
    clock.advance(5_000); // well past the deadline
    expect(deadline.remainingMs()).toBe(0);
  });
});

describe("pollUntilDone", () => {
  it("resolves to the done status after pending→pending→done (<= 3 poll calls)", async () => {
    const clock = createFakeClock(0);
    // Injected sleep advances the fake clock so the deadline math stays honest
    // without any real waiting.
    const sleep = (ms: number): Promise<void> => {
      clock.advance(ms);
      return Promise.resolve();
    };
    const states: Array<{ state: "pending" | "done" }> = [
      { state: "pending" },
      { state: "pending" },
      { state: "done" },
    ];
    let calls = 0;
    const outcome: PollOutcome<{ state: string }> = await pollUntilDone({
      poll: () => {
        const s = states[calls] ?? { state: "done" };
        calls += 1;
        return Promise.resolve(s);
      },
      isDone: (s) => s.state === "done",
      isFailed: (s) => s.state === "failed",
      deadline: createPollDeadline(60_000, clock.now),
      pollIntervalMs: 10,
      sleep,
    });

    expect(calls).toBeLessThanOrEqual(3);
    expect(outcome.kind).toBe("done");
    if (outcome.kind === "done") {
      expect(outcome.status.state).toBe("done");
    }
  });

  it("resolves to a timeout once a pending poll exceeds the deadline (no real wait)", async () => {
    const clock = createFakeClock(0);
    const sleep = (ms: number): Promise<void> => {
      clock.advance(ms);
      return Promise.resolve();
    };
    let calls = 0;
    const outcome = await pollUntilDone({
      poll: () => {
        calls += 1;
        return Promise.resolve({ state: "pending" as const });
      },
      isDone: (s) => s.state === "done",
      isFailed: (s) => false,
      deadline: createPollDeadline(25, clock.now), // 3 sleeps of 10ms cross it
      pollIntervalMs: 10,
      sleep,
    });

    expect(outcome.kind).toBe("timeout");
    // The loop must terminate — not spin forever — once the deadline passes.
    expect(calls).toBeGreaterThan(0);
    expect(calls).toBeLessThan(10);
  });

  it("short-circuits immediately on a failed status (VPORT-02) — no further polls", async () => {
    const clock = createFakeClock(0);
    let calls = 0;
    const outcome = await pollUntilDone({
      poll: () => {
        calls += 1;
        return Promise.resolve({ state: "failed" as const });
      },
      isDone: (s) => s.state === "done",
      isFailed: (s) => s.state === "failed",
      deadline: createPollDeadline(60_000, clock.now),
      pollIntervalMs: 10,
      sleep: () => Promise.resolve(),
    });

    expect(outcome.kind).toBe("failed");
    expect(calls).toBe(1); // exactly one poll, then short-circuit
    if (outcome.kind === "failed") {
      expect(outcome.status.state).toBe("failed");
    }
  });

  it("returns timeout immediately when the signal is already aborted (never polls)", async () => {
    const clock = createFakeClock(0);
    const controller = new AbortController();
    controller.abort();
    let calls = 0;
    const outcome = await pollUntilDone({
      poll: () => {
        calls += 1;
        return Promise.resolve({ state: "pending" as const });
      },
      isDone: (s) => s.state === "done",
      isFailed: (s) => s.state === "failed",
      deadline: createPollDeadline(60_000, clock.now),
      pollIntervalMs: 10,
      sleep: () => Promise.resolve(),
      signal: controller.signal,
    });

    expect(outcome.kind).toBe("timeout");
    expect(calls).toBe(0);
  });

  it("clamps the inter-poll sleep to the remaining deadline budget", async () => {
    const clock = createFakeClock(0);
    const sleeps: number[] = [];
    const sleep = (ms: number): Promise<void> => {
      sleeps.push(ms);
      clock.advance(ms);
      return Promise.resolve();
    };
    await pollUntilDone({
      poll: () => Promise.resolve({ state: "pending" as const }),
      isDone: (s) => s.state === "done",
      isFailed: (s) => false,
      deadline: createPollDeadline(15, clock.now), // remaining < pollIntervalMs on the 2nd sleep
      pollIntervalMs: 10,
      sleep,
    });

    // First sleep uses the full 10ms interval; the next is clamped to the
    // remaining 5ms so the loop never sleeps past the deadline.
    expect(sleeps[0]).toBe(10);
    expect(sleeps.every((ms) => ms <= 10)).toBe(true);
    expect(Math.min(...sleeps)).toBeLessThan(10);
  });
});
