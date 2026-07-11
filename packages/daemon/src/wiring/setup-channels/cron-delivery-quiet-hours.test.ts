// SPDX-License-Identifier: Apache-2.0
// Quiet-hours suppresses a non-critical cron's user-facing DELIVERY (the job
// still ran). The gate helper delegates to isInQuietHours; these pin the decision +
// throw-safety contract the cron delivery listener relies on.
import { describe, it, expect, vi } from "vitest";
import { cronDeliverySuppressedByQuietHours, cronDeliverySuppressedByQuietHoursLogged } from "./cron-delivery-quiet-hours.js";

// UTC timestamps at known wall-clock hours (Date.parse is allowed in tests; the
// globals gate only blocks Date.now()/new Date() with no args).
const at = (iso: string): number => Date.parse(iso);
const cfg = (over: Partial<{ enabled: boolean; start: string; end: string; timezone: string; criticalBypass: boolean }> = {}) => ({
  enabled: true,
  start: "22:00",
  end: "07:00",
  timezone: "UTC",
  criticalBypass: false,
  ...over,
});

describe("cronDeliverySuppressedByQuietHours (cron-output quiet-hours gate)", () => {
  it("SUPPRESSES inside an overnight quiet window (03:00 within 22:00-07:00)", () => {
    expect(cronDeliverySuppressedByQuietHours(cfg(), at("2026-07-11T03:00:00Z"))).toBe(true);
  });

  it("DELIVERS outside the window (12:00 is not within 22:00-07:00)", () => {
    expect(cronDeliverySuppressedByQuietHours(cfg(), at("2026-07-11T12:00:00Z"))).toBe(false);
  });

  it("DELIVERS when quiet hours are disabled (even at 03:00)", () => {
    expect(cronDeliverySuppressedByQuietHours(cfg({ enabled: false }), at("2026-07-11T03:00:00Z"))).toBe(false);
  });

  it("SUPPRESSES inside a same-day window (14:00 within 13:00-17:00)", () => {
    expect(cronDeliverySuppressedByQuietHours(cfg({ start: "13:00", end: "17:00" }), at("2026-07-11T14:00:00Z"))).toBe(true);
  });
});

// The listener-facing wrapper: it must emit an INFO record on suppression and,
// critically, FAIL TOWARD DELIVER (return false + WARN) if the quiet-hours
// config is malformed — a config typo must never silently mute a cron forever.
describe("cronDeliverySuppressedByQuietHoursLogged (throw-safe listener gate)", () => {
  const mkLogger = () => ({ info: vi.fn(), warn: vi.fn() });

  it("returns true and logs INFO (not WARN) when suppressed in-window", () => {
    const logger = mkLogger();
    const out = cronDeliverySuppressedByQuietHoursLogged(cfg(), at("2026-07-11T03:00:00Z"), logger as never, "job-a", "agentTurn");
    expect(out).toBe(true);
    expect(logger.info).toHaveBeenCalledTimes(1);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("returns false and logs nothing when out-of-window", () => {
    const logger = mkLogger();
    const out = cronDeliverySuppressedByQuietHoursLogged(cfg(), at("2026-07-11T12:00:00Z"), logger as never, "job-a", "system_event");
    expect(out).toBe(false);
    expect(logger.info).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("FAILS TOWARD DELIVER (false + WARN) on a malformed quiet-hours window", () => {
    const logger = mkLogger();
    // A non-HH:MM start makes isInQuietHours throw; the gate must swallow it,
    // WARN, and return false so the cron output is NOT silently dropped.
    const out = cronDeliverySuppressedByQuietHoursLogged(
      cfg({ start: "not-a-time" }),
      at("2026-07-11T03:00:00Z"),
      logger as never,
      "job-a",
      "agentTurn",
    );
    expect(out).toBe(false);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.info).not.toHaveBeenCalled();
  });
});
