// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for the per-agent video-generation rate limiter (hourly count cap).
 * Mirrors the image-gen rate limiter: a fixed 1h window with an injectable clock.
 *
 * @module
 */
import { describe, it, expect } from "vitest";
import { createVideoGenRateLimiter } from "./rate-limiter.js";

describe("createVideoGenRateLimiter", () => {
  it("allows up to maxPerHour calls then blocks", () => {
    const limiter = createVideoGenRateLimiter({ maxPerHour: 2 });
    expect(limiter.tryAcquire("agent-1")).toBe(true);
    expect(limiter.tryAcquire("agent-1")).toBe(true);
    expect(limiter.tryAcquire("agent-1")).toBe(false);
  });

  it("tracks agents independently", () => {
    const limiter = createVideoGenRateLimiter({ maxPerHour: 1 });
    expect(limiter.tryAcquire("agent-1")).toBe(true);
    expect(limiter.tryAcquire("agent-1")).toBe(false);
    expect(limiter.tryAcquire("agent-2")).toBe(true);
  });

  it("resets after the 1h window expires (injected clock)", () => {
    let now = 1_000;
    const limiter = createVideoGenRateLimiter({ maxPerHour: 1, nowMs: () => now });

    expect(limiter.tryAcquire("agent-1")).toBe(true);
    expect(limiter.tryAcquire("agent-1")).toBe(false);

    now += 3_600_001; // just past 1h
    expect(limiter.tryAcquire("agent-1")).toBe(true);
  });

  it("reset() re-allows an agent immediately", () => {
    const limiter = createVideoGenRateLimiter({ maxPerHour: 1 });
    expect(limiter.tryAcquire("agent-1")).toBe(true);
    expect(limiter.tryAcquire("agent-1")).toBe(false);

    limiter.reset("agent-1");
    expect(limiter.tryAcquire("agent-1")).toBe(true);
  });
});
