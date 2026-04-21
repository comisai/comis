// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { createRateLimiter } from "./rate-limiter.js";

describe("createRateLimiter", () => {
  it("first call to tryAcquire returns true", () => {
    const limiter = createRateLimiter({ maxPerHour: 5, nowMs: () => 0 });
    expect(limiter.tryAcquire("agent-1")).toBe(true);
  });

  it("allows up to maxPerHour calls, blocks maxPerHour+1", () => {
    let clock = 0;
    const limiter = createRateLimiter({ maxPerHour: 3, nowMs: () => clock });

    expect(limiter.tryAcquire("agent-1")).toBe(true);  // 1
    expect(limiter.tryAcquire("agent-1")).toBe(true);  // 2
    expect(limiter.tryAcquire("agent-1")).toBe(true);  // 3
    expect(limiter.tryAcquire("agent-1")).toBe(false); // 4 = blocked
  });

  it("resets counter after window expires (1 hour)", () => {
    let clock = 0;
    const limiter = createRateLimiter({ maxPerHour: 2, nowMs: () => clock });

    expect(limiter.tryAcquire("agent-1")).toBe(true);
    expect(limiter.tryAcquire("agent-1")).toBe(true);
    expect(limiter.tryAcquire("agent-1")).toBe(false);

    // Advance past 1 hour
    clock = 3_600_001;
    expect(limiter.tryAcquire("agent-1")).toBe(true);
  });

  it("tracks independent counters per agentId", () => {
    let clock = 0;
    const limiter = createRateLimiter({ maxPerHour: 1, nowMs: () => clock });

    expect(limiter.tryAcquire("agent-1")).toBe(true);
    expect(limiter.tryAcquire("agent-1")).toBe(false);
    // Different agent should have its own counter
    expect(limiter.tryAcquire("agent-2")).toBe(true);
  });

  it("reset(agentId) clears that agent's counter", () => {
    let clock = 0;
    const limiter = createRateLimiter({ maxPerHour: 1, nowMs: () => clock });

    expect(limiter.tryAcquire("agent-1")).toBe(true);
    expect(limiter.tryAcquire("agent-1")).toBe(false);

    limiter.reset("agent-1");
    expect(limiter.tryAcquire("agent-1")).toBe(true);
  });
});
