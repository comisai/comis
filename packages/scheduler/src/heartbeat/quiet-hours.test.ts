import { describe, it, expect } from "vitest";
import type { QuietHoursConfig } from "./quiet-hours.js";
import { parseTimeToMinutes, getCurrentMinutesInTimezone, isInQuietHours } from "./quiet-hours.js";

describe("parseTimeToMinutes", () => {
  it("parses 22:00 -> 1320", () => {
    expect(parseTimeToMinutes("22:00")).toBe(1320);
  });

  it("parses 07:00 -> 420", () => {
    expect(parseTimeToMinutes("07:00")).toBe(420);
  });

  it("parses 00:00 -> 0", () => {
    expect(parseTimeToMinutes("00:00")).toBe(0);
  });

  it("parses 23:59 -> 1439", () => {
    expect(parseTimeToMinutes("23:59")).toBe(1439);
  });

  it("parses 12:30 -> 750", () => {
    expect(parseTimeToMinutes("12:30")).toBe(750);
  });

  it("throws on invalid format (no colon)", () => {
    expect(() => parseTimeToMinutes("2200")).toThrow("Invalid time format");
  });

  it("throws on invalid format (single digit)", () => {
    expect(() => parseTimeToMinutes("2:00")).toThrow("Invalid time format");
  });

  it("throws on invalid format (extra chars)", () => {
    expect(() => parseTimeToMinutes("22:00:00")).toThrow("Invalid time format");
  });

  it("throws on invalid hour value (25:00)", () => {
    expect(() => parseTimeToMinutes("25:00")).toThrow("Invalid time value");
  });

  it("throws on invalid minute value (22:61)", () => {
    expect(() => parseTimeToMinutes("22:61")).toThrow("Invalid time value");
  });
});

describe("getCurrentMinutesInTimezone", () => {
  it("returns correct minutes for a fixed timestamp in UTC", () => {
    // 2024-01-15 14:30:00 UTC = 870 minutes
    const ts = Date.UTC(2024, 0, 15, 14, 30, 0);
    const minutes = getCurrentMinutesInTimezone(ts, "UTC");
    expect(minutes).toBe(14 * 60 + 30); // 870
  });

  it("applies timezone offset correctly", () => {
    // 2024-01-15 14:30:00 UTC -> in America/New_York (EST = UTC-5) -> 09:30 = 570
    const ts = Date.UTC(2024, 0, 15, 14, 30, 0);
    const minutes = getCurrentMinutesInTimezone(ts, "America/New_York");
    expect(minutes).toBe(9 * 60 + 30); // 570
  });

  it("handles midnight correctly", () => {
    // 2024-01-15 00:00:00 UTC
    const ts = Date.UTC(2024, 0, 15, 0, 0, 0);
    const minutes = getCurrentMinutesInTimezone(ts, "UTC");
    expect(minutes).toBe(0);
  });
});

describe("isInQuietHours", () => {
  // Use fixed timestamps to avoid timezone ambiguity
  // Helper: create a timestamp for a specific UTC hour/minute
  function utcTimestamp(hour: number, minute: number): number {
    return Date.UTC(2024, 0, 15, hour, minute, 0);
  }

  const overnightConfig: QuietHoursConfig = {
    enabled: true,
    start: "22:00",
    end: "07:00",
    timezone: "UTC",
  };

  const sameDayConfig: QuietHoursConfig = {
    enabled: true,
    start: "13:00",
    end: "17:00",
    timezone: "UTC",
  };

  it("returns false when disabled", () => {
    const config: QuietHoursConfig = { ...overnightConfig, enabled: false };
    expect(isInQuietHours(config, utcTimestamp(23, 0))).toBe(false);
  });

  // Overnight window 22:00-07:00
  it("overnight: 23:00 is in quiet hours", () => {
    expect(isInQuietHours(overnightConfig, utcTimestamp(23, 0))).toBe(true);
  });

  it("overnight: 06:00 is in quiet hours", () => {
    expect(isInQuietHours(overnightConfig, utcTimestamp(6, 0))).toBe(true);
  });

  it("overnight: 08:00 is NOT in quiet hours", () => {
    expect(isInQuietHours(overnightConfig, utcTimestamp(8, 0))).toBe(false);
  });

  it("overnight: 21:00 is NOT in quiet hours", () => {
    expect(isInQuietHours(overnightConfig, utcTimestamp(21, 0))).toBe(false);
  });

  it("overnight: start time (22:00) is inclusive", () => {
    expect(isInQuietHours(overnightConfig, utcTimestamp(22, 0))).toBe(true);
  });

  it("overnight: end time (07:00) is exclusive", () => {
    expect(isInQuietHours(overnightConfig, utcTimestamp(7, 0))).toBe(false);
  });

  it("overnight: 00:00 (midnight) is in quiet hours", () => {
    expect(isInQuietHours(overnightConfig, utcTimestamp(0, 0))).toBe(true);
  });

  // Same-day window 13:00-17:00
  it("same-day: 14:00 is in quiet hours", () => {
    expect(isInQuietHours(sameDayConfig, utcTimestamp(14, 0))).toBe(true);
  });

  it("same-day: 12:00 is NOT in quiet hours", () => {
    expect(isInQuietHours(sameDayConfig, utcTimestamp(12, 0))).toBe(false);
  });

  it("same-day: 18:00 is NOT in quiet hours", () => {
    expect(isInQuietHours(sameDayConfig, utcTimestamp(18, 0))).toBe(false);
  });

  it("same-day: start time (13:00) is inclusive", () => {
    expect(isInQuietHours(sameDayConfig, utcTimestamp(13, 0))).toBe(true);
  });

  it("same-day: end time (17:00) is exclusive", () => {
    expect(isInQuietHours(sameDayConfig, utcTimestamp(17, 0))).toBe(false);
  });
});
