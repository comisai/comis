// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { createImageGenRateLimiter } from "./rate-limiter.js";

describe("createImageGenRateLimiter", () => {
  it("allows up to maxPerHour calls", () => {
    const limiter = createImageGenRateLimiter({ maxPerHour: 3 });
    expect(limiter.tryAcquire("agent-1")).toBe(true);
    expect(limiter.tryAcquire("agent-1")).toBe(true);
    expect(limiter.tryAcquire("agent-1")).toBe(true);
    expect(limiter.tryAcquire("agent-1")).toBe(false);
  });

  it("tracks agents independently", () => {
    const limiter = createImageGenRateLimiter({ maxPerHour: 1 });
    expect(limiter.tryAcquire("agent-1")).toBe(true);
    expect(limiter.tryAcquire("agent-1")).toBe(false);
    expect(limiter.tryAcquire("agent-2")).toBe(true);
  });

  it("resets after window expires", () => {
    let now = 1000;
    const limiter = createImageGenRateLimiter({
      maxPerHour: 1,
      nowMs: () => now,
    });

    expect(limiter.tryAcquire("agent-1")).toBe(true);
    expect(limiter.tryAcquire("agent-1")).toBe(false);

    // Advance past 1 hour
    now += 3_600_001;
    expect(limiter.tryAcquire("agent-1")).toBe(true);
  });

  it("reset() clears counter for agent", () => {
    const limiter = createImageGenRateLimiter({ maxPerHour: 1 });
    expect(limiter.tryAcquire("agent-1")).toBe(true);
    expect(limiter.tryAcquire("agent-1")).toBe(false);

    limiter.reset("agent-1");
    expect(limiter.tryAcquire("agent-1")).toBe(true);
  });
});
