// SPDX-License-Identifier: Apache-2.0
/**
 * Contract tests for @comis/infra runtime adapters (PORTS-07).
 *
 * Each adapter asserts it satisfies the port contract from @comis/core.
 * Tolerances per design §5.3: clock 50ms; timer 30ms safety margin.
 *
 * PORTS-04 cancel-safety + idempotency contract tests live in the
 * createSystemTimers describe block.
 *
 * Placement note: this test sits at `packages/infra/src/__tests__/` (not the
 * plan-authored `packages/infra/__tests__/`). The infra vitest config only
 * includes `src/**\/*.test.ts` and the globals-classifier exemption regex at
 * test/support/globals-classifier.ts:95 matches `packages/[pkg]/src/__tests__/`
 * — a sibling `__tests__/` outside `src/` would be silently uncovered and
 * unexempt. Phase 39 Plan 02 Rule-3 fix.
 *
 * @module
 */
import { describe, it, expect } from "vitest";
import {
  createSystemClock,
  createSystemEnv,
  createSystemTimers,
} from "../index.js";

describe("createSystemClock contract (PORTS-06, PORTS-07)", () => {
  it("now() returns a value within 50ms of Date.now()", () => {
    const c = createSystemClock();
    const before = Date.now();
    const got = c.now();
    const after = Date.now();
    expect(got).toBeGreaterThanOrEqual(before);
    expect(got).toBeLessThanOrEqual(after + 50);
  });

  it("nowDate() returns a Date whose getTime() is within 50ms of new Date()", () => {
    const c = createSystemClock();
    const before = Date.now();
    const got = c.nowDate();
    const after = Date.now();
    expect(got).toBeInstanceOf(Date);
    expect(got.getTime()).toBeGreaterThanOrEqual(before);
    expect(got.getTime()).toBeLessThanOrEqual(after + 50);
  });

  it("now() and nowDate() agree within 5ms", () => {
    const c = createSystemClock();
    const n = c.now();
    const d = c.nowDate();
    expect(Math.abs(d.getTime() - n)).toBeLessThan(5);
  });
});

describe("createSystemEnv contract (PORTS-06, PORTS-07)", () => {
  it("get(key) returns the supplied source[key]", () => {
    const e = createSystemEnv({ FOO: "bar", BAZ: undefined });
    expect(e.get("FOO")).toBe("bar");
    expect(e.get("BAZ")).toBeUndefined();
    expect(e.get("MISSING")).toBeUndefined();
  });

  it("snapshot([…]) returns a frozen readonly record with requested keys", () => {
    const e = createSystemEnv({ A: "1", B: undefined });
    const snap = e.snapshot(["A", "B", "C"]);
    expect(Object.isFrozen(snap)).toBe(true);
    expect(snap["A"]).toBe("1");
    expect(snap["B"]).toBeUndefined();
    expect(snap["C"]).toBeUndefined();
  });

  it("default source is process.env when no source argument passed", () => {
    // We don't assert specific keys — just that the adapter doesn't throw
    // and that get() returns a string-or-undefined for any key.
    const e = createSystemEnv();
    const v = e.get("PATH"); // PATH is almost certainly defined on POSIX hosts
    expect(typeof v === "string" || v === undefined).toBe(true);
  });
});

describe("createSystemTimers contract (PORTS-04, PORTS-06, PORTS-07)", () => {
  it("setTimeout fires the callback after the requested delay", async () => {
    const t = createSystemTimers();
    let fired = false;
    t.setTimeout(() => {
      fired = true;
    }, 5);
    await new Promise((r) => setTimeout(r, 30)); // 30ms safety margin
    expect(fired).toBe(true);
  });

  it("handle.cancel() prevents the callback from firing", async () => {
    const t = createSystemTimers();
    let fired = false;
    const h = t.setTimeout(() => {
      fired = true;
    }, 10);
    h.cancel();
    expect(h.cancelled).toBe(true);
    await new Promise((r) => setTimeout(r, 30));
    expect(fired).toBe(false);
  });

  it("setInterval fires the callback repeatedly until cancel()", async () => {
    const t = createSystemTimers();
    let count = 0;
    const h = t.setInterval(() => {
      count++;
    }, 5);
    await new Promise((r) => setTimeout(r, 30));
    h.cancel();
    const seen = count;
    await new Promise((r) => setTimeout(r, 20));
    expect(seen).toBeGreaterThanOrEqual(2);
    expect(count).toBe(seen); // no more fires after cancel
  });

  it("PORTS-04: unref() after cancel() is a no-op", () => {
    const t = createSystemTimers();
    const h = t.setInterval(() => {}, 60_000);
    h.cancel();
    expect(() => h.unref()).not.toThrow();
    expect(h.cancelled).toBe(true);
  });

  it("PORTS-04: unref() twice is a no-op (idempotent)", () => {
    const t = createSystemTimers();
    const h = t.setInterval(() => {}, 60_000);
    h.unref();
    expect(() => h.unref()).not.toThrow();
    h.cancel(); // cleanup
  });

  it("PORTS-04: cancel() twice is a no-op (idempotent)", () => {
    const t = createSystemTimers();
    const h = t.setInterval(() => {}, 60_000);
    h.cancel();
    expect(() => h.cancel()).not.toThrow();
    expect(h.cancelled).toBe(true);
  });
});
