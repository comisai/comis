// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { createFakeClock } from "./fake-clock.js";

describe("createFakeClock (PORTS-08)", () => {
  it("now() returns initialMs initially", () => {
    const c = createFakeClock(1_000);
    expect(c.now()).toBe(1_000);
  });

  it("advance(ms) moves now() forward deterministically", () => {
    const c = createFakeClock(1_000);
    c.advance(500);
    expect(c.now()).toBe(1_500);
    c.advance(250);
    expect(c.now()).toBe(1_750);
  });

  it("nowDate() reflects the current synthetic time", () => {
    const c = createFakeClock(0);
    expect(c.nowDate().getTime()).toBe(0);
    c.advance(123);
    expect(c.nowDate().getTime()).toBe(123);
  });

  it("multiple fake clocks are independent (per-test isolation)", () => {
    const a = createFakeClock(0);
    const b = createFakeClock(0);
    a.advance(100);
    expect(a.now()).toBe(100);
    expect(b.now()).toBe(0);
  });
});
