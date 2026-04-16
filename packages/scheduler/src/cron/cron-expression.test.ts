import { describe, it, expect } from "vitest";
import type { CronSchedule } from "./cron-types.js";
import { computeNextRunAtMs } from "./cron-expression.js";

describe("computeNextRunAtMs", () => {
  describe('kind "cron"', () => {
    it('returns next 5-min boundary for "*/5 * * * *"', () => {
      // 2026-01-15 12:02:00 UTC
      const nowMs = new Date("2026-01-15T12:02:00Z").getTime();
      const schedule: CronSchedule = { kind: "cron", expr: "*/5 * * * *", tz: "UTC" };
      const next = computeNextRunAtMs(schedule, nowMs);
      expect(next).toBeDefined();
      // Next 5-min boundary after 12:02 is 12:05
      expect(next).toBe(new Date("2026-01-15T12:05:00Z").getTime());
    });

    it("respects timezone parameter", () => {
      // 2026-06-15 04:30:00 UTC = 2026-06-15 00:30:00 EDT
      // "0 1 * * *" means 01:00 in the given timezone
      const nowMs = new Date("2026-06-15T04:30:00Z").getTime();
      const schedule: CronSchedule = { kind: "cron", expr: "0 1 * * *", tz: "America/New_York" };
      const next = computeNextRunAtMs(schedule, nowMs);
      expect(next).toBeDefined();
      // Next 01:00 EDT is same day: 2026-06-15 01:00 EDT = 2026-06-15 05:00 UTC
      expect(next).toBe(new Date("2026-06-15T05:00:00Z").getTime());
    });

    it("returns undefined for invalid cron expression", () => {
      const nowMs = Date.now();
      const schedule: CronSchedule = { kind: "cron", expr: "invalid cron" };
      // Should handle gracefully, returning undefined or throwing
      const result = computeNextRunAtMs(schedule, nowMs);
      expect(result).toBeUndefined();
    });
  });

  describe('kind "every"', () => {
    it("returns correct next interval when anchor is in the past", () => {
      // anchor at t=0, everyMs=60000 (1 minute), nowMs=150000 (2.5 minutes in)
      const anchor = 0;
      const nowMs = 150_000;
      const schedule: CronSchedule = { kind: "every", everyMs: 60_000, anchorMs: anchor };
      const next = computeNextRunAtMs(schedule, nowMs);
      // Steps: ceil(150000/60000) = 3, so next = 0 + 3*60000 = 180000
      expect(next).toBe(180_000);
    });

    it("returns anchor when anchor is in the future", () => {
      const anchor = 500_000;
      const nowMs = 100_000;
      const schedule: CronSchedule = { kind: "every", everyMs: 60_000, anchorMs: anchor };
      const next = computeNextRunAtMs(schedule, nowMs);
      expect(next).toBe(anchor);
    });

    it("returns correct next interval without explicit anchor", () => {
      const nowMs = 100_000;
      const schedule: CronSchedule = { kind: "every", everyMs: 60_000 };
      const next = computeNextRunAtMs(schedule, nowMs);
      // No anchor, so anchor defaults to nowMs, first fire is nowMs + everyMs
      // Actually anchor = nowMs, nowMs == anchor, so elapsed=0, steps = max(1, ceil(0/60000)) = 1
      // next = nowMs + 1*60000 = 160000
      expect(next).toBeDefined();
      // The exact behavior: anchor = nowMs, so nowMs < anchor is false, nowMs == anchor
      // elapsed = 0, steps = max(1, floor((0 + 59999) / 60000)) = max(1, 0) = 1
      // next = nowMs + 60000 = 160000
      expect(next).toBe(160_000);
    });

    it("returns next interval exactly on boundary", () => {
      // anchor=0, everyMs=60000, nowMs=120000 (exactly on a boundary)
      const schedule: CronSchedule = { kind: "every", everyMs: 60_000, anchorMs: 0 };
      const next = computeNextRunAtMs(schedule, 120_000);
      // elapsed=120000, steps = max(1, floor((120000 + 59999) / 60000)) = max(1, floor(179999/60000)) = max(1, 2) = 2
      // next = 0 + 2*60000 = 120000
      // But 120000 == nowMs, which is fine (>= nowMs)
      expect(next).toBe(120_000);
    });
  });

  describe('kind "at"', () => {
    it("returns timestamp in ms for future ISO datetime", () => {
      const futureDate = "2030-01-01T00:00:00Z";
      const nowMs = Date.now();
      const schedule: CronSchedule = { kind: "at", at: futureDate };
      const next = computeNextRunAtMs(schedule, nowMs);
      expect(next).toBe(new Date(futureDate).getTime());
    });

    it("returns undefined for past ISO datetime", () => {
      const pastDate = "2020-01-01T00:00:00Z";
      const nowMs = Date.now();
      const schedule: CronSchedule = { kind: "at", at: pastDate };
      const next = computeNextRunAtMs(schedule, nowMs);
      expect(next).toBeUndefined();
    });
  });
});
