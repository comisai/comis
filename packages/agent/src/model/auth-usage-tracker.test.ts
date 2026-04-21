// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createAuthUsageTracker, type AuthUsageTracker } from "./auth-usage-tracker.js";

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let tracker: AuthUsageTracker;

beforeEach(() => {
  tracker = createAuthUsageTracker();
});

// ---------------------------------------------------------------------------
// record() + getStats()
// ---------------------------------------------------------------------------

describe("createAuthUsageTracker", () => {
  describe("record + getStats", () => {
    it("single record returns correct stats", () => {
      tracker.record("KEY_A", { tokensIn: 100, tokensOut: 50, cost: 0.01, success: true });

      const stats = tracker.getStats("KEY_A");
      expect(stats).toBeDefined();
      expect(stats!.keyName).toBe("KEY_A");
      expect(stats!.totalTokens).toBe(150);
      expect(stats!.tokens).toEqual({ input: 100, output: 50 });
      expect(stats!.totalCost).toBe(0.01);
      expect(stats!.successCount).toBe(1);
      expect(stats!.errorCount).toBe(0);
      expect(stats!.callCount).toBe(1);
    });

    it("multiple records accumulate totals", () => {
      tracker.record("KEY_A", { tokensIn: 100, tokensOut: 50, cost: 0.01, success: true });
      tracker.record("KEY_A", { tokensIn: 200, tokensOut: 100, cost: 0.02, success: true });
      tracker.record("KEY_A", { tokensIn: 50, tokensOut: 25, cost: 0.005, success: true });

      const stats = tracker.getStats("KEY_A");
      expect(stats!.totalTokens).toBe(525);
      expect(stats!.tokens).toEqual({ input: 350, output: 175 });
      expect(stats!.totalCost).toBeCloseTo(0.035, 6);
      expect(stats!.successCount).toBe(3);
      expect(stats!.callCount).toBe(3);
    });

    it("records with success=false increment errorCount", () => {
      tracker.record("KEY_A", { tokensIn: 0, tokensOut: 0, cost: 0, success: false });

      const stats = tracker.getStats("KEY_A");
      expect(stats!.errorCount).toBe(1);
      expect(stats!.successCount).toBe(0);
      expect(stats!.callCount).toBe(1);
    });

    it("computes errorRate correctly (2 errors / 5 calls = 0.4)", () => {
      tracker.record("KEY_A", { tokensIn: 10, tokensOut: 5, cost: 0.001, success: true });
      tracker.record("KEY_A", { tokensIn: 10, tokensOut: 5, cost: 0.001, success: true });
      tracker.record("KEY_A", { tokensIn: 10, tokensOut: 5, cost: 0.001, success: true });
      tracker.record("KEY_A", { tokensIn: 0, tokensOut: 0, cost: 0, success: false });
      tracker.record("KEY_A", { tokensIn: 0, tokensOut: 0, cost: 0, success: false });

      const stats = tracker.getStats("KEY_A");
      expect(stats!.errorRate).toBeCloseTo(0.4, 6);
      expect(stats!.errorCount).toBe(2);
      expect(stats!.callCount).toBe(5);
    });

    it("returns 0 errorRate when all calls succeed", () => {
      tracker.record("KEY_A", { tokensIn: 10, tokensOut: 5, cost: 0.001, success: true });
      tracker.record("KEY_A", { tokensIn: 10, tokensOut: 5, cost: 0.001, success: true });

      const stats = tracker.getStats("KEY_A");
      expect(stats!.errorRate).toBe(0);
    });

    it("returns undefined for unknown keyName", () => {
      expect(tracker.getStats("UNKNOWN")).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // getAllStats()
  // ---------------------------------------------------------------------------

  describe("getAllStats", () => {
    it("returns all profiles sorted by totalCost descending", () => {
      tracker.record("KEY_CHEAP", { tokensIn: 10, tokensOut: 5, cost: 0.001, success: true });
      tracker.record("KEY_MID", { tokensIn: 100, tokensOut: 50, cost: 0.05, success: true });
      tracker.record("KEY_EXPENSIVE", { tokensIn: 500, tokensOut: 250, cost: 0.5, success: true });

      const all = tracker.getAllStats();
      expect(all).toHaveLength(3);
      expect(all[0].keyName).toBe("KEY_EXPENSIVE");
      expect(all[1].keyName).toBe("KEY_MID");
      expect(all[2].keyName).toBe("KEY_CHEAP");
    });

    it("returns empty array when no records", () => {
      expect(tracker.getAllStats()).toEqual([]);
    });
  });

  // ---------------------------------------------------------------------------
  // reset()
  // ---------------------------------------------------------------------------

  describe("reset", () => {
    it("clears all stats", () => {
      tracker.record("KEY_A", { tokensIn: 100, tokensOut: 50, cost: 0.01, success: true });
      tracker.record("KEY_B", { tokensIn: 200, tokensOut: 100, cost: 0.02, success: true });

      tracker.reset();

      expect(tracker.getStats("KEY_A")).toBeUndefined();
      expect(tracker.getStats("KEY_B")).toBeUndefined();
      expect(tracker.getAllStats()).toEqual([]);
    });
  });

  // ---------------------------------------------------------------------------
  // prune()
  // ---------------------------------------------------------------------------

  describe("prune", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("removes stale entries and returns count", () => {
      vi.setSystemTime(new Date("2025-01-01T00:00:00Z"));
      tracker.record("OLD_KEY", { tokensIn: 10, tokensOut: 5, cost: 0.001, success: true });

      // Advance time by 2 hours
      vi.setSystemTime(new Date("2025-01-01T02:00:00Z"));
      tracker.record("NEW_KEY", { tokensIn: 20, tokensOut: 10, cost: 0.002, success: true });

      // Prune entries older than 1 hour
      const removed = tracker.prune(60 * 60 * 1000);
      expect(removed).toBe(1);
      expect(tracker.getStats("OLD_KEY")).toBeUndefined();
      expect(tracker.getStats("NEW_KEY")).toBeDefined();
    });

    it("keeps recent entries", () => {
      vi.setSystemTime(new Date("2025-01-01T00:00:00Z"));
      tracker.record("KEY_A", { tokensIn: 10, tokensOut: 5, cost: 0.001, success: true });
      tracker.record("KEY_B", { tokensIn: 20, tokensOut: 10, cost: 0.002, success: true });

      // Only 5 minutes later -- prune with 1 hour max age
      vi.setSystemTime(new Date("2025-01-01T00:05:00Z"));
      const removed = tracker.prune(60 * 60 * 1000);

      expect(removed).toBe(0);
      expect(tracker.getAllStats()).toHaveLength(2);
    });
  });

  // ---------------------------------------------------------------------------
  // lastUsedAt
  // ---------------------------------------------------------------------------

  describe("lastUsedAt", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("updates lastUsedAt on each record call", () => {
      vi.setSystemTime(new Date("2025-01-01T00:00:00Z"));
      tracker.record("KEY_A", { tokensIn: 10, tokensOut: 5, cost: 0.001, success: true });
      const firstTime = tracker.getStats("KEY_A")!.lastUsedAt;

      vi.setSystemTime(new Date("2025-01-01T01:00:00Z"));
      tracker.record("KEY_A", { tokensIn: 20, tokensOut: 10, cost: 0.002, success: true });
      const secondTime = tracker.getStats("KEY_A")!.lastUsedAt;

      expect(secondTime).toBeGreaterThan(firstTime);
      expect(secondTime).toBe(new Date("2025-01-01T01:00:00Z").getTime());
    });
  });
});
