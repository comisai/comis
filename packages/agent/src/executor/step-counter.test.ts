// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { createStepCounter, type StepCounter } from "./step-counter.js";

describe("createStepCounter", () => {
  it("starts at count 0", () => {
    const sc = createStepCounter(10);
    expect(sc.getCount()).toBe(0);
  });

  it("increment() increases count by 1 and returns current count", () => {
    const sc = createStepCounter(10);
    expect(sc.increment()).toBe(1);
    expect(sc.increment()).toBe(2);
    expect(sc.increment()).toBe(3);
    expect(sc.getCount()).toBe(3);
  });

  it("shouldHalt() returns false when count < maxSteps", () => {
    const sc = createStepCounter(3);
    sc.increment(); // 1
    sc.increment(); // 2
    expect(sc.shouldHalt()).toBe(false);
  });

  it("shouldHalt() returns true when count >= maxSteps", () => {
    const sc = createStepCounter(3);
    sc.increment(); // 1
    sc.increment(); // 2
    sc.increment(); // 3
    expect(sc.shouldHalt()).toBe(true);
  });

  it("shouldHalt() returns true when count exceeds maxSteps", () => {
    const sc = createStepCounter(2);
    sc.increment(); // 1
    sc.increment(); // 2
    sc.increment(); // 3 (past max)
    expect(sc.shouldHalt()).toBe(true);
  });

  it("reset() returns count to 0", () => {
    const sc = createStepCounter(10);
    sc.increment();
    sc.increment();
    sc.increment();
    expect(sc.getCount()).toBe(3);

    sc.reset();
    expect(sc.getCount()).toBe(0);
    expect(sc.shouldHalt()).toBe(false);
  });

  it("defaults maxSteps to 50 when not provided", () => {
    const sc = createStepCounter();
    for (let i = 0; i < 49; i++) {
      sc.increment();
    }
    expect(sc.shouldHalt()).toBe(false);

    sc.increment(); // 50
    expect(sc.shouldHalt()).toBe(true);
  });
});
