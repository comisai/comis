// SPDX-License-Identifier: Apache-2.0
/**
 * INTEGRATION: scheduler cron — computeNextRunAtMs + quiet-hours integration.
 *
 * Exercises the production cron-expression evaluator and quiet-hours
 * integration in-process for `@comis/scheduler`.
 *
 * @module
 */

import { describe, it, expect } from "vitest";
import {
  computeNextRunAtMs,
  isInQuietHours,
  parseTimeToMinutes,
  getCurrentMinutesInTimezone,
} from "@comis/scheduler";

describe("INTEGRATION: scheduler cron — pure scheduling primitives", () => {
  it("computeNextRunAtMs (cron) returns ms timestamp for valid 'every minute' expression", () => {
    // Use 30 seconds past the minute so the next firing is strictly later.
    // (At exact minute boundary, the 1ms lookback in computeCron returns
    // the current ms — which matches the cron semantics but trips a
    // toBeGreaterThan assertion.)
    const nowMs = new Date("2026-01-01T00:00:30Z").getTime();
    const next = computeNextRunAtMs(
      { kind: "cron", expr: "* * * * *", tz: "UTC" },
      nowMs,
    );
    expect(typeof next).toBe("number");
    expect(next).toBeGreaterThan(nowMs);
  });

  it("computeNextRunAtMs (every) returns next-fire ms after anchor", () => {
    const anchorMs = new Date("2026-01-01T00:00:00Z").getTime();
    const nowMs = anchorMs + 30_000;
    const next = computeNextRunAtMs(
      { kind: "every", everyMs: 60_000, anchorMs },
      nowMs,
    );
    expect(typeof next).toBe("number");
    expect(next).toBeGreaterThanOrEqual(nowMs);
  });

  it("computeNextRunAtMs (cron) handles common '0 12 * * *' (noon daily)", () => {
    const nowMs = new Date("2026-01-01T10:00:00Z").getTime();
    const next = computeNextRunAtMs(
      { kind: "cron", expr: "0 12 * * *", tz: "UTC" },
      nowMs,
    );
    expect(typeof next).toBe("number");
    const expected = new Date("2026-01-01T12:00:00Z").getTime();
    expect(next).toBe(expected);
  });

  it("parseTimeToMinutes converts HH:MM to minutes-of-day", () => {
    expect(parseTimeToMinutes("00:00")).toBe(0);
    expect(parseTimeToMinutes("12:00")).toBe(12 * 60);
    expect(parseTimeToMinutes("23:59")).toBe(23 * 60 + 59);
  });

  it("getCurrentMinutesInTimezone returns 0-1439 range value for UTC at noon", () => {
    const noonUtcMs = new Date("2026-01-01T12:00:00Z").getTime();
    const minutes = getCurrentMinutesInTimezone(noonUtcMs, "UTC");
    expect(minutes).toBe(12 * 60);
  });

  it("isInQuietHours returns false outside the configured overnight window (noon UTC)", () => {
    const noonUtcMs = new Date("2026-01-01T12:00:00Z").getTime();
    const result = isInQuietHours(
      {
        enabled: true,
        start: "22:00",
        end: "06:00",
        timezone: "UTC",
      },
      noonUtcMs,
    );
    expect(result).toBe(false);
  });

  it("isInQuietHours returns true inside an overnight window (02:00 UTC)", () => {
    const twoAmUtcMs = new Date("2026-01-01T02:00:00Z").getTime();
    const result = isInQuietHours(
      {
        enabled: true,
        start: "22:00",
        end: "06:00",
        timezone: "UTC",
      },
      twoAmUtcMs,
    );
    expect(result).toBe(true);
  });

  it("isInQuietHours returns false when feature disabled", () => {
    const twoAmUtcMs = new Date("2026-01-01T02:00:00Z").getTime();
    const result = isInQuietHours(
      {
        enabled: false,
        start: "22:00",
        end: "06:00",
        timezone: "UTC",
      },
      twoAmUtcMs,
    );
    expect(result).toBe(false);
  });
});
