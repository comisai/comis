// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createInjectionRateLimiter } from "./injection-rate-limiter.js";
import type { InjectionRateLimiter } from "./injection-rate-limiter.js";

describe("createInjectionRateLimiter", () => {
  let limiter: InjectionRateLimiter;

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    limiter?.destroy();
    vi.useRealTimers();
  });

  it("returns InjectionRateLimiter with record, getCount, destroy methods", () => {
    limiter = createInjectionRateLimiter();
    expect(typeof limiter.record).toBe("function");
    expect(typeof limiter.getCount).toBe("function");
    expect(typeof limiter.destroy).toBe("function");
  });

  describe("record - basic counting", () => {
    it("first detection returns count 1, level none", () => {
      limiter = createInjectionRateLimiter();
      const result = limiter.record("tenant1", "user1");
      expect(result).toEqual({ count: 1, level: "none", thresholdCrossed: false });
    });

    it("second detection returns count 2, level none", () => {
      limiter = createInjectionRateLimiter();
      limiter.record("tenant1", "user1");
      const result = limiter.record("tenant1", "user1");
      expect(result).toEqual({ count: 2, level: "none", thresholdCrossed: false });
    });

    it("third detection (default warnThreshold) returns level warn with thresholdCrossed true", () => {
      limiter = createInjectionRateLimiter();
      limiter.record("tenant1", "user1");
      limiter.record("tenant1", "user1");
      const result = limiter.record("tenant1", "user1");
      expect(result).toEqual({ count: 3, level: "warn", thresholdCrossed: true });
    });

    it("fourth detection returns level warn but thresholdCrossed false (already crossed)", () => {
      limiter = createInjectionRateLimiter();
      limiter.record("tenant1", "user1");
      limiter.record("tenant1", "user1");
      limiter.record("tenant1", "user1");
      const result = limiter.record("tenant1", "user1");
      expect(result).toEqual({ count: 4, level: "warn", thresholdCrossed: false });
    });

    it("fifth detection (default auditThreshold) returns level audit with thresholdCrossed true", () => {
      limiter = createInjectionRateLimiter();
      for (let i = 0; i < 4; i++) limiter.record("tenant1", "user1");
      const result = limiter.record("tenant1", "user1");
      expect(result).toEqual({ count: 5, level: "audit", thresholdCrossed: true });
    });

    it("sixth detection returns level audit but thresholdCrossed false", () => {
      limiter = createInjectionRateLimiter();
      for (let i = 0; i < 5; i++) limiter.record("tenant1", "user1");
      const result = limiter.record("tenant1", "user1");
      expect(result).toEqual({ count: 6, level: "audit", thresholdCrossed: false });
    });
  });

  describe("record - user-scoped counting", () => {
    it("different users have independent counters", () => {
      limiter = createInjectionRateLimiter();
      limiter.record("tenant1", "user1");
      limiter.record("tenant1", "user1");
      const r1 = limiter.record("tenant1", "user1");
      const r2 = limiter.record("tenant1", "user2");

      expect(r1.level).toBe("warn");
      expect(r1.count).toBe(3);
      expect(r2.level).toBe("none");
      expect(r2.count).toBe(1);
    });

    it("different tenants with same userId have independent counters", () => {
      limiter = createInjectionRateLimiter();
      limiter.record("tenant1", "user1");
      limiter.record("tenant1", "user1");
      const r1 = limiter.record("tenant1", "user1");
      const r2 = limiter.record("tenant2", "user1");

      expect(r1.level).toBe("warn");
      expect(r1.count).toBe(3);
      expect(r2.level).toBe("none");
      expect(r2.count).toBe(1);
    });
  });

  describe("record - sliding window", () => {
    it("timestamps older than windowMs are pruned", () => {
      const windowMs = 5000;
      limiter = createInjectionRateLimiter({ windowMs });

      limiter.record("t", "u");
      limiter.record("t", "u");
      expect(limiter.getCount("t", "u")).toBe(2);

      // Advance past windowMs so first two timestamps are pruned
      vi.advanceTimersByTime(windowMs + 1);

      const result = limiter.record("t", "u");
      expect(result.count).toBe(1);
    });

    it("window boundary: timestamps at exactly windowMs are kept", () => {
      const windowMs = 5000;
      limiter = createInjectionRateLimiter({ windowMs });

      limiter.record("t", "u");

      // Advance by exactly windowMs (boundary - should be kept by <=)
      vi.advanceTimersByTime(windowMs);

      const result = limiter.record("t", "u");
      expect(result.count).toBe(2);
    });
  });

  describe("record - custom thresholds", () => {
    it("custom warnThreshold and auditThreshold", () => {
      limiter = createInjectionRateLimiter({ warnThreshold: 2, auditThreshold: 4 });

      limiter.record("t", "u");
      const r2 = limiter.record("t", "u");
      expect(r2).toEqual({ count: 2, level: "warn", thresholdCrossed: true });

      const r3 = limiter.record("t", "u");
      expect(r3).toEqual({ count: 3, level: "warn", thresholdCrossed: false });

      const r4 = limiter.record("t", "u");
      expect(r4).toEqual({ count: 4, level: "audit", thresholdCrossed: true });

      const r5 = limiter.record("t", "u");
      expect(r5).toEqual({ count: 5, level: "audit", thresholdCrossed: false });
    });
  });

  describe("getCount", () => {
    it("returns 0 for unknown user", () => {
      limiter = createInjectionRateLimiter();
      expect(limiter.getCount("unknown", "user")).toBe(0);
    });

    it("returns current count for tracked user", () => {
      limiter = createInjectionRateLimiter();
      limiter.record("t", "u");
      limiter.record("t", "u");
      limiter.record("t", "u");
      expect(limiter.getCount("t", "u")).toBe(3);
    });
  });

  describe("TTL eviction", () => {
    it("entry is evicted after entryTtlMs of inactivity", () => {
      const entryTtlMs = 3000;
      limiter = createInjectionRateLimiter({ entryTtlMs });

      limiter.record("t", "u");
      expect(limiter.getCount("t", "u")).toBe(1);

      // Advance past TTL to trigger eviction timer
      vi.advanceTimersByTime(entryTtlMs + 1);

      expect(limiter.getCount("t", "u")).toBe(0);
    });

    it("TTL timer is reset on each record call", () => {
      const entryTtlMs = 3000;
      limiter = createInjectionRateLimiter({ entryTtlMs });

      limiter.record("t", "u");

      // Advance by entryTtlMs - 100 (not expired yet)
      vi.advanceTimersByTime(entryTtlMs - 100);
      expect(limiter.getCount("t", "u")).toBe(1);

      // Record again, resetting the TTL timer
      limiter.record("t", "u");

      // Advance by entryTtlMs - 100 again (total: 2*entryTtlMs - 200 from start, but only entryTtlMs - 100 since last record)
      vi.advanceTimersByTime(entryTtlMs - 100);
      expect(limiter.getCount("t", "u")).toBeGreaterThan(0);

      // Now advance past the TTL from last record
      vi.advanceTimersByTime(entryTtlMs + 1);
      expect(limiter.getCount("t", "u")).toBe(0);
    });
  });

  describe("maxEntries cap", () => {
    it("evicts oldest entry when maxEntries exceeded", () => {
      limiter = createInjectionRateLimiter({ maxEntries: 2 });

      limiter.record("tenant", "user1");
      vi.advanceTimersByTime(1); // Ensure distinct timestamps
      limiter.record("tenant", "user2");
      vi.advanceTimersByTime(1);
      limiter.record("tenant", "user3");

      // user1 should be evicted (oldest most-recent timestamp)
      expect(limiter.getCount("tenant", "user1")).toBe(0);
      expect(limiter.getCount("tenant", "user2")).toBe(1);
      expect(limiter.getCount("tenant", "user3")).toBe(1);
    });
  });

  describe("destroy", () => {
    it("clears all entries and timers", () => {
      limiter = createInjectionRateLimiter();
      limiter.record("t", "u1");
      limiter.record("t", "u2");
      limiter.record("t", "u3");

      limiter.destroy();

      expect(limiter.getCount("t", "u1")).toBe(0);
      expect(limiter.getCount("t", "u2")).toBe(0);
      expect(limiter.getCount("t", "u3")).toBe(0);
    });

    it("no timers fire after destroy", () => {
      const entryTtlMs = 3000;
      limiter = createInjectionRateLimiter({ entryTtlMs });

      limiter.record("t", "u");
      limiter.destroy();

      // Advancing past TTL should not cause errors (timers were cleared)
      expect(() => vi.advanceTimersByTime(entryTtlMs + 1)).not.toThrow();
    });
  });
});
