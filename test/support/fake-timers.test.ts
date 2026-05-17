// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { createFakeTimers } from "./fake-timers.js";

describe("createFakeTimers", () => {
  it("advance(ms) fires scheduled setTimeout callbacks whose deadline passed", () => {
    const t = createFakeTimers(0);
    let fired = false;
    t.setTimeout(() => {
      fired = true;
    }, 100);
    t.advance(50);
    expect(fired).toBe(false);
    t.advance(60);
    expect(fired).toBe(true);
  });

  it("cancel() prevents the setTimeout callback from firing", () => {
    const t = createFakeTimers(0);
    let fired = false;
    const h = t.setTimeout(() => {
      fired = true;
    }, 100);
    h.cancel();
    t.advance(200);
    expect(fired).toBe(false);
    expect(h.cancelled).toBe(true);
  });

  it("setInterval fires repeatedly under advance()", () => {
    const t = createFakeTimers(0);
    let count = 0;
    const h = t.setInterval(() => {
      count++;
    }, 50);
    t.advance(120); // should fire at 50 and 100
    expect(count).toBe(2);
    h.cancel();
    t.advance(100);
    expect(count).toBe(2); // no more fires after cancel
  });

  it("unrefRecord() reflects unref() calls", () => {
    const t = createFakeTimers(0);
    const h1 = t.setInterval(() => {}, 1_000);
    const h2 = t.setTimeout(() => {}, 5_000);
    h1.unref();
    const record = t.unrefRecord();
    // The record should contain entries for both h1 (unrefCalled=true) and h2 (unrefCalled=false)
    expect(record.length).toBeGreaterThanOrEqual(2);
    const interval = record.find((r) => r.kind === "interval" && r.delay === 1_000);
    const timeout = record.find((r) => r.kind === "timeout" && r.delay === 5_000);
    expect(interval?.unrefCalled).toBe(true);
    expect(timeout?.unrefCalled).toBe(false);
    h2.cancel();
  });

  it("contract on the fake: unref() after cancel() is a no-op", () => {
    const t = createFakeTimers(0);
    const h = t.setInterval(() => {}, 60_000);
    h.cancel();
    expect(() => h.unref()).not.toThrow();
  });
});
