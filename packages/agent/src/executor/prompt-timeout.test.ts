// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { TimeoutError } from "@comis/shared";
import { withPromptTimeout, withResettablePromptTimeout, PromptTimeoutError } from "./prompt-timeout.js";
import type { TimerPort, TimerHandle } from "@comis/core";

// Test TimerPort that delegates to globals.
function wrapTimerHandle(t: NodeJS.Timeout): TimerHandle {
  let cancelled = false;
  let unrefCalled = false;
  return {
    get cancelled() { return cancelled; },
    cancel() { if (cancelled) return; cancelled = true; clearTimeout(t); },
    unref() { if (cancelled || unrefCalled) return; unrefCalled = true; t.unref(); },
  };
}
const testTimers: TimerPort = {
  setTimeout: (cb, ms) => wrapTimerHandle(setTimeout(cb, ms)),
  setInterval: (cb, ms) => wrapTimerHandle(setInterval(cb, ms)),
};

describe("PromptTimeoutError", () => {
  it("extends TimeoutError", () => {
    const err = new PromptTimeoutError(5000);
    expect(err).toBeInstanceOf(TimeoutError);
    expect(err).toBeInstanceOf(Error);
  });

  it("has correct name and message", () => {
    const err = new PromptTimeoutError(180_000);
    expect(err.name).toBe("PromptTimeoutError");
    expect(err.message).toBe("Prompt execution timed out after 180000ms");
    expect(err.timeoutMs).toBe(180_000);
  });
});

describe("withPromptTimeout", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves with original value when promise completes before timeout", async () => {
    const promise = new Promise<string>((resolve) => {
      setTimeout(() => resolve("result"), 10);
    });

    const resultPromise = withPromptTimeout(promise, 1000, vi.fn(), testTimers);

    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result).toBe("result");
  });

  it("rejects with PromptTimeoutError when promise exceeds timeout", async () => {
    const promise = new Promise<string>((resolve) => {
      setTimeout(() => resolve("too late"), 10_000);
    });

    const resultPromise = withPromptTimeout(promise, 50, vi.fn(), testTimers);

    // Attach catch BEFORE advancing timers to prevent unhandled rejection
    const caught = resultPromise.catch((e: unknown) => e);

    await vi.advanceTimersByTimeAsync(50);

    const err = await caught;
    expect(err).toBeInstanceOf(PromptTimeoutError);
    expect((err as PromptTimeoutError).timeoutMs).toBe(50);
  });

  it("calls abort when timeout fires", async () => {
    const abort = vi.fn();
    const promise = new Promise<string>((resolve) => {
      setTimeout(() => resolve("too late"), 10_000);
    });

    const resultPromise = withPromptTimeout(promise, 50, abort, testTimers);
    const caught = resultPromise.catch((e: unknown) => e);

    await vi.advanceTimersByTimeAsync(50);

    const err = await caught;
    expect(err).toBeInstanceOf(PromptTimeoutError);
    expect(abort).toHaveBeenCalledTimes(1);
  });

  it("clears timer when promise resolves before timeout", async () => {
    const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");

    const promise = new Promise<string>((resolve) => {
      setTimeout(() => resolve("fast"), 10);
    });

    const resultPromise = withPromptTimeout(promise, 1000, vi.fn(), testTimers);

    await vi.advanceTimersByTimeAsync(10);
    await resultPromise;

    expect(clearTimeoutSpy).toHaveBeenCalled();
    clearTimeoutSpy.mockRestore();
  });

  it("suppresses unhandled rejection from losing promise", async () => {
    // The original promise will reject AFTER the timeout wins.
    // Without the .catch(() => {}) suppression, Node would warn about
    // an unhandled promise rejection.
    const promise = new Promise<string>((_resolve, reject) => {
      setTimeout(() => reject(new Error("late rejection")), 200);
    });

    const resultPromise = withPromptTimeout(promise, 50, vi.fn(), testTimers);
    const caught = resultPromise.catch((e: unknown) => e);

    await vi.advanceTimersByTimeAsync(50);
    const err = await caught;
    expect(err).toBeInstanceOf(PromptTimeoutError);

    // Advance timers to let the late rejection fire -- should not throw
    await vi.advanceTimersByTimeAsync(200);
  });

  it("handles sync throw from abort gracefully", async () => {
    const abort = () => {
      throw new Error("abort exploded");
    };

    const promise = new Promise<string>((resolve) => {
      setTimeout(() => resolve("too late"), 10_000);
    });

    const resultPromise = withPromptTimeout(promise, 50, abort, testTimers);
    const caught = resultPromise.catch((e: unknown) => e);

    await vi.advanceTimersByTimeAsync(50);

    // Should still reject with PromptTimeoutError, not the abort error
    const err = await caught;
    expect(err).toBeInstanceOf(PromptTimeoutError);
    expect((err as Error).message).not.toContain("abort exploded");
  });

  it("handles async rejection from abort gracefully", async () => {
    const abort = () => Promise.reject(new Error("abort async fail"));

    const promise = new Promise<string>((resolve) => {
      setTimeout(() => resolve("too late"), 10_000);
    });

    const resultPromise = withPromptTimeout(promise, 50, abort, testTimers);
    const caught = resultPromise.catch((e: unknown) => e);

    await vi.advanceTimersByTimeAsync(50);

    // Should still reject with PromptTimeoutError, not the abort error
    const err = await caught;
    expect(err).toBeInstanceOf(PromptTimeoutError);
    expect((err as Error).message).not.toContain("abort async fail");
  });
});

describe("withResettablePromptTimeout", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves normally when promise completes before timeout", async () => {
    const promise = new Promise<string>((resolve) => {
      setTimeout(() => resolve("result"), 10);
    });

    const { promise: racedPromise } = withResettablePromptTimeout(promise, 1000, vi.fn(), testTimers);

    await vi.advanceTimersByTimeAsync(10);

    const result = await racedPromise;
    expect(result).toBe("result");
  });

  it("rejects with PromptTimeoutError when timeout fires", async () => {
    const abort = vi.fn();
    const promise = new Promise<string>((resolve) => {
      setTimeout(() => resolve("too late"), 10_000);
    });

    const { promise: racedPromise } = withResettablePromptTimeout(promise, 50, abort, testTimers);
    const caught = racedPromise.catch((e: unknown) => e);

    await vi.advanceTimersByTimeAsync(50);

    const err = await caught;
    expect(err).toBeInstanceOf(PromptTimeoutError);
    expect(abort).toHaveBeenCalledTimes(1);
  });

  it("resetTimer extends the deadline", async () => {
    const abort = vi.fn();
    const promise = new Promise<string>((resolve) => {
      setTimeout(() => resolve("made it"), 150);
    });

    // Timeout is 100ms -- without reset, promise at 150ms would timeout
    const { promise: racedPromise, resetTimer } = withResettablePromptTimeout(promise, 100, abort, testTimers);

    // At 80ms, reset the timer. New deadline: 80+100=180ms
    await vi.advanceTimersByTimeAsync(80);
    resetTimer();

    // Advance to 150ms -- promise resolves (before 180ms deadline)
    await vi.advanceTimersByTimeAsync(70);

    const result = await racedPromise;
    expect(result).toBe("made it");
    expect(abort).not.toHaveBeenCalled();
  });

  it("resetTimer after timeout has no effect", async () => {
    const abort = vi.fn();
    const promise = new Promise<string>((resolve) => {
      setTimeout(() => resolve("too late"), 10_000);
    });

    const { promise: racedPromise, resetTimer } = withResettablePromptTimeout(promise, 50, abort, testTimers);
    const caught = racedPromise.catch((e: unknown) => e);

    // Timeout fires at 50ms
    await vi.advanceTimersByTimeAsync(50);

    const err = await caught;
    expect(err).toBeInstanceOf(PromptTimeoutError);

    // Calling resetTimer after settlement is safe (no-op)
    resetTimer();
    expect(abort).toHaveBeenCalledTimes(1);
  });

  it("multiple resets work correctly", async () => {
    const abort = vi.fn();
    const promise = new Promise<string>((resolve) => {
      setTimeout(() => resolve("after two resets"), 200);
    });

    // Timeout 100ms -- needs two resets to survive 200ms promise
    const { promise: racedPromise, resetTimer } = withResettablePromptTimeout(promise, 100, abort, testTimers);

    // Reset at 80ms -> new deadline 180ms
    await vi.advanceTimersByTimeAsync(80);
    resetTimer();

    // Reset again at 150ms -> new deadline 250ms
    await vi.advanceTimersByTimeAsync(70);
    resetTimer();

    // Promise resolves at 200ms (within 250ms deadline)
    await vi.advanceTimersByTimeAsync(50);

    const result = await racedPromise;
    expect(result).toBe("after two resets");
    expect(abort).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// LAT-02 decision fixture matrix (Phase 177 Plan 01).
//
// The four ROADMAP cells -- (a) silent-prefill-then-stream, (b) true hang,
// (c) streaming runaway, (d) tool-completion reset -- under BOTH budget
// readings (default 180_000 and the documented-local 300_000) and BOTH
// scaling branches (uniform stall vs first-activity allowance). resetTimer()
// calls stand in for stream-delta resets (the delta->reset wiring is plan
// 177-03). The matrix is permanent regression evidence: the Task-3 DECISION
// (gate scope + first-activity scaling) is read FROM these cells, not taste
// (design/local-model-last-mile.md S11 step 3; 177-RESEARCH Critical
// Finding 4 / Pattern 3).
//
// LAT-02 DECISION (177-01): stall semantics ALL-PROVIDERS, first-activity
// scaling NONE, fixture-(a) read as documented-local-config (300000).
// Canonical (a)-(d) regression cells for the chosen semantics:
//   (a) LAT-02-2  -- 200s prefill survives under the documented local budget
//                    with pure stall semantics (LAT-02-1 documents WHY the
//                    reading matters: (a) at DEFAULT cannot pass pure stall);
//   (b) LAT-02-4  -- true hang dies at the stall budget (180s), makespan
//                    carried;
//   (c) LAT-02-6 + LAT-02-7 -- runaway dies at exactly the makespan (R-1);
//                    reset-after-fire is a no-op;
//   (d) LAT-02-8 + the resetTimer suite above -- tool-completion resets
//                    unchanged;
//   back-compat/leak: LAT-02-9, LAT-02-10.
// UNCHOSEN-branch cells STAY as documented evidence (do not delete):
//   LAT-02-3a/3b prove first-activity scaling executable; LAT-02-5 pins its
//   cost -- true-hang detection degrades from 180s to the makespan (30 min
//   at defaults), which is what ruled the scaling branch out given
//   LAT-02-2's documented-config pass. Gate scope is all-providers because
//   the timer is client-side (request bytes untouched -- I3 pins request
//   construction) and the LAT-02-6 ceiling ADDS a bound cloud turns lack
//   today; graph nodes keep their own 600s x layer governor which fires
//   first (research Pitfall 8). Consumed by 177-03 (wiring) and 177-06
//   (docs) via the 177-01-SUMMARY DECISION block.
// ---------------------------------------------------------------------------
describe("withResettablePromptTimeout -- LAT-02 decision fixture matrix", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // -- Fixture (a): silent prefill then stream ------------------------------

  it("LAT-02-1: [stall-only @ default 180000] a 200s silent prefill dies at the 180s stall budget (limit 'stall')", async () => {
    // Documents the arithmetic that forces the decision: fixture (a) at
    // DEFAULT config CANNOT pass under a pure stall budget (200s silence >
    // 180s budget) -- exactly as it exceeds today's whole-turn race.
    const abort = vi.fn();
    const hung = new Promise<never>(() => {});
    const { promise: raced } = withResettablePromptTimeout(hung, 180_000, abort, testTimers);
    const caught = raced.catch((e: unknown) => e);

    await vi.advanceTimersByTimeAsync(180_000);

    const err = (await caught) as PromptTimeoutError;
    expect(err).toBeInstanceOf(PromptTimeoutError);
    expect(err.limit).toBe("stall");
    expect(err.stallBudgetMs).toBe(180_000);
    expect(err.timeoutMs).toBe(180_000);
    expect(abort).toHaveBeenCalledTimes(1);
  });

  it("LAT-02-2: [stall-only @ documented-local 300000] 200s silence then stream resets -> completes, abort never called", async () => {
    // Evidence cell (passes pre-patch too -- keep as regression): under the
    // ALREADY-documented local config (config-yaml.mdx local guidance, 300s)
    // pure stall semantics survive the 200s prefill AND the post-first-token
    // stream, with no new semantics.
    const abort = vi.fn();
    const promise = new Promise<string>((resolve) => {
      setTimeout(() => resolve("completed after slow prefill"), 280_000);
    });
    const { promise: raced, resetTimer } = withResettablePromptTimeout(
      promise,
      300_000,
      abort,
      testTimers,
    );

    // 200s of silent prefill -- under the 300s budget, no kill.
    await vi.advanceTimersByTimeAsync(200_000);
    resetTimer(); // first stream delta at 200s
    await vi.advanceTimersByTimeAsync(1_000);
    resetTimer(); // 201s
    await vi.advanceTimersByTimeAsync(1_000);
    resetTimer(); // 202s -> stall deadline now 502s
    await vi.advanceTimersByTimeAsync(78_000); // -> 280s: promise resolves

    const result = await raced;
    expect(result).toBe("completed after slow prefill");
    expect(abort).not.toHaveBeenCalled();
  });

  it("LAT-02-3a: [first-activity scaling @ default 180000] 200s silence survives under initialBudgetMs; a 180s gap AFTER first activity kills with limit 'stall'", async () => {
    const abort = vi.fn();
    const hung = new Promise<never>(() => {});
    const { promise: raced, resetTimer } = withResettablePromptTimeout(
      hung,
      180_000,
      abort,
      testTimers,
      // The derived no-new-key allowance: promptTimeoutMs x 10 (never a
      // Hermes constant -- design S7).
      { initialBudgetMs: 1_800_000 },
    );
    const caught = raced.catch((e: unknown) => e);

    // 200s of silence -- under the 1_800_000 first-arm budget, no kill yet.
    await vi.advanceTimersByTimeAsync(200_000);
    expect(abort).not.toHaveBeenCalled();

    resetTimer(); // first activity at 200s -> budget drops to the steady 180_000
    await vi.advanceTimersByTimeAsync(10_000); // -> 210s
    resetTimer(); // last activity at 210s -> stall deadline 390s
    await vi.advanceTimersByTimeAsync(180_000); // -> 390s: the post-activity gap exceeded

    const err = (await caught) as PromptTimeoutError;
    expect(err).toBeInstanceOf(PromptTimeoutError);
    expect(err.limit).toBe("stall");
    expect(err.stallBudgetMs).toBe(180_000);
    // The restarted (steady-state) arm fired, not the initial allowance.
    expect(err.timeoutMs).toBe(180_000);
    expect(abort).toHaveBeenCalledTimes(1);
  });

  it("LAT-02-3b: [first-activity scaling @ default 180000] 200s silence then 1/s resets -> completes at 280s", async () => {
    const abort = vi.fn();
    const promise = new Promise<string>((resolve) => {
      setTimeout(() => resolve("scaled prefill completed"), 280_000);
    });
    const { promise: raced, resetTimer } = withResettablePromptTimeout(
      promise,
      180_000,
      abort,
      testTimers,
      { initialBudgetMs: 1_800_000 },
    );
    const caught = raced.catch((e: unknown) => e);

    await vi.advanceTimersByTimeAsync(200_000); // silent prefill
    for (let t = 200_000; t < 280_000; t += 1_000) {
      resetTimer(); // stream deltas every simulated second
      await vi.advanceTimersByTimeAsync(1_000);
    }

    const result = await caught;
    expect(result).toBe("scaled prefill completed");
    expect(abort).not.toHaveBeenCalled();
  });

  // -- Fixture (b): true hang ------------------------------------------------

  it("LAT-02-4: [true hang @ default] with makespanMs present, a dead call dies at the 180s stall budget (stall fires FIRST)", async () => {
    const abort = vi.fn();
    const hung = new Promise<never>(() => {});
    const { promise: raced } = withResettablePromptTimeout(hung, 180_000, abort, testTimers, {
      makespanMs: 1_800_000,
    });
    const caught = raced.catch((e: unknown) => e);

    await vi.advanceTimersByTimeAsync(180_000);

    const err = (await caught) as PromptTimeoutError;
    expect(err).toBeInstanceOf(PromptTimeoutError);
    expect(err.limit).toBe("stall");
    expect(err.stallBudgetMs).toBe(180_000);
    expect(err.makespanMs).toBe(1_800_000); // ceiling carried for hint rendering (177-04)
    expect(err.timeoutMs).toBe(180_000);
    expect(abort).toHaveBeenCalledTimes(1);
  });

  it("LAT-02-5: [scaling-branch cost cell] initialBudgetMs delays true-hang detection from 180s to the makespan (1_800_000)", async () => {
    // THE cost the Task-3 decision weighs (research Critical Finding 4): with
    // first-activity scaling, a genuinely dead local Ollama takes 30 minutes
    // to detect instead of 3.
    const abort = vi.fn();
    const hung = new Promise<never>(() => {});
    const { promise: raced } = withResettablePromptTimeout(hung, 180_000, abort, testTimers, {
      initialBudgetMs: 1_800_000,
      makespanMs: 1_800_000,
    });
    const caught = raced.catch((e: unknown) => e);

    // At the old default deadline (180s) and far beyond it: still alive.
    await vi.advanceTimersByTimeAsync(180_000);
    expect(abort).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_619_999); // -> 1_799_999ms total
    expect(abort).not.toHaveBeenCalled();

    // The kill only arrives at exactly 1_800_000.
    await vi.advanceTimersByTimeAsync(1);
    expect(abort).toHaveBeenCalledTimes(1);
    const err = (await caught) as PromptTimeoutError;
    expect(err).toBeInstanceOf(PromptTimeoutError);
    // Both arms expire on the same tick; the stall (initial-budget) arm is
    // scheduled first and wins deterministically under fake timers.
    expect(err.limit).toBe("stall");
    expect(err.timeoutMs).toBe(1_800_000);
  });

  // -- Fixture (c): streaming runaway (the R-1 cell) -------------------------

  it("LAT-02-6: [streaming runaway] 1/s resets forever -> survives the stall budget, dies at EXACTLY the makespan with limit 'makespan' (R-1)", async () => {
    // RED pre-patch: the current primitive NEVER kills this -- a pure
    // stall-reset deadline is unbounded while the stream keeps producing
    // (gemma4 16x/810s runaway receipt, scripts/bench-small-model/README.md).
    const abort = vi.fn();
    const hung = new Promise<never>(() => {}); // generation streams forever, never resolves
    const { promise: raced, resetTimer } = withResettablePromptTimeout(
      hung,
      180_000,
      abort,
      testTimers,
      { makespanMs: 1_800_000 },
    );
    let rejection: unknown;
    const caught = raced.catch((e: unknown) => {
      rejection = e;
      return e;
    });

    // Drive a delta-shaped reset every simulated second up to 1ms before the
    // ceiling, asserting survival past the stall budget AND past 1_000_000.
    for (let t = 1_000; t <= 1_799_000; t += 1_000) {
      await vi.advanceTimersByTimeAsync(1_000);
      if (t === 181_000 || t === 1_000_000) {
        expect(abort).not.toHaveBeenCalled(); // a pure stall-reset never kills it
      }
      resetTimer();
    }
    expect(rejection).toBeUndefined();

    // The non-resetting makespan timer fires at exactly 1_800_000.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(abort).toHaveBeenCalledTimes(1);
    const err = (await caught) as PromptTimeoutError;
    expect(err).toBeInstanceOf(PromptTimeoutError);
    expect(err.limit).toBe("makespan");
    expect(err.stallBudgetMs).toBe(180_000);
    expect(err.makespanMs).toBe(1_800_000);
    expect(err.timeoutMs).toBe(1_800_000);
  });

  it("LAT-02-7: [Pitfall 1 latch] resetTimer spam after the makespan fired is a no-op (no second abort, no timer restart)", async () => {
    const abort = vi.fn();
    const hung = new Promise<never>(() => {});
    const { promise: raced, resetTimer } = withResettablePromptTimeout(hung, 100, abort, testTimers, {
      makespanMs: 250,
    });
    const caught = raced.catch((e: unknown) => e);

    // Keep the stall budget alive across the ceiling: resets at 50/100/150/200.
    for (let i = 0; i < 4; i++) {
      await vi.advanceTimersByTimeAsync(50);
      resetTimer();
    }
    await vi.advanceTimersByTimeAsync(50); // -> 250: makespan fires
    expect(abort).toHaveBeenCalledTimes(1);

    // Reset spam after the fire: the shared settled latch makes it a no-op.
    resetTimer();
    resetTimer();
    resetTimer();
    expect(vi.getTimerCount()).toBe(0); // no timer restarted
    await vi.advanceTimersByTimeAsync(10_000);
    expect(abort).toHaveBeenCalledTimes(1); // no second abort, no late fire

    const err = (await caught) as PromptTimeoutError;
    expect(err).toBeInstanceOf(PromptTimeoutError);
    expect(err.limit).toBe("makespan");
  });

  // -- Fixture (d): tool-completion reset unchanged --------------------------

  it("LAT-02-8: [tool-completion reset] with makespanMs present, a reset at 170s extends the stall deadline exactly as without opts", async () => {
    // Guard pin: the makespan opt must NOT change reset semantics (the
    // :204-268 suite above stays green untouched as fixture (d)'s baseline).
    const abort = vi.fn();
    const promise = new Promise<string>((resolve) => {
      setTimeout(() => resolve("done after resets"), 340_000);
    });
    const { promise: raced, resetTimer } = withResettablePromptTimeout(
      promise,
      180_000,
      abort,
      testTimers,
      { makespanMs: 1_800_000 },
    );

    await vi.advanceTimersByTimeAsync(170_000);
    resetTimer(); // tool completion at 170s -> stall deadline 350s
    await vi.advanceTimersByTimeAsync(170_000); // -> 340s: resolves before the 350s deadline

    const result = await raced;
    expect(result).toBe("done after resets");
    expect(abort).not.toHaveBeenCalled();
  });

  // -- Frontier / back-compat pins -------------------------------------------

  it("LAT-02-9: [back-compat] no opts -> message byte-identical to pre-patch; limit 'stall' is the only new observable", async () => {
    const abort = vi.fn();
    const hung = new Promise<never>(() => {});
    const { promise: raced } = withResettablePromptTimeout(hung, 50, abort, testTimers);
    const caught = raced.catch((e: unknown) => e);

    await vi.advanceTimersByTimeAsync(50);

    const err = (await caught) as PromptTimeoutError;
    expect(err).toBeInstanceOf(PromptTimeoutError);
    // The :32 message pin shape holds -- bridge/log greps depend on it.
    expect(err.message).toBe("Prompt execution timed out after 50ms");
    expect(err.timeoutMs).toBe(50);
    expect(err.limit).toBe("stall");
    expect(err.stallBudgetMs).toBe(50);
    expect(err.makespanMs).toBeUndefined();
    expect(abort).toHaveBeenCalledTimes(1);
  });

  it("LAT-02-10: fast completion with makespanMs -> resolves, both timers cancelled in the single .finally, no late fire", async () => {
    const abort = vi.fn();
    const promise = new Promise<string>((resolve) => {
      setTimeout(() => resolve("fast"), 30_000);
    });
    const { promise: raced } = withResettablePromptTimeout(promise, 180_000, abort, testTimers, {
      makespanMs: 1_800_000,
    });

    await vi.advanceTimersByTimeAsync(30_000);
    const result = await raced;
    expect(result).toBe("fast");
    expect(vi.getTimerCount()).toBe(0); // no timer leak: stall AND makespan cancelled

    // Advancing far past the would-be makespan produces no late abort/rejection.
    await vi.advanceTimersByTimeAsync(2_000_000);
    expect(abort).not.toHaveBeenCalled();
  });
});
