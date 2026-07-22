// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { computeNextRunAtMs } from "./cron-expression.js";

const HOUR_MS = 60 * 60 * 1_000;
const LOWER_BOUND_MS = Date.UTC(2027, 0, 1, 0, 0, 0);

describe("cron recurrence computation", () => {
  it("computes cron occurrences strictly after the supplied lower bound", () => {
    expect(computeNextRunAtMs(
      { kind: "cron", expr: "0 * * * *", tz: "UTC" },
      LOWER_BOUND_MS,
    )).toBe(LOWER_BOUND_MS + HOUR_MS);
  });

  it("returns undefined for invalid cron expressions and timezones", () => {
    expect(computeNextRunAtMs(
      { kind: "cron", expr: "not-a-cron", tz: "UTC" },
      LOWER_BOUND_MS,
    )).toBeUndefined();
    expect(computeNextRunAtMs(
      { kind: "cron", expr: "0 * * * *", tz: "Not/A_Zone" },
      LOWER_BOUND_MS,
    )).toBeUndefined();
  });

  it("returns interval anchors before advancing by complete periods", () => {
    const schedule = { kind: "every" as const, everyMs: 500, anchorMs: 1_000 };

    expect(computeNextRunAtMs(schedule, 999)).toBe(1_000);
    expect(computeNextRunAtMs(schedule, 1_000)).toBe(1_500);
    expect(computeNextRunAtMs(schedule, 1_749)).toBe(2_000);
  });

  it("rejects invalid recurrence bounds and interval arithmetic overflow", () => {
    const valid = { kind: "every" as const, everyMs: 500, anchorMs: 1_000 };
    expect(computeNextRunAtMs(valid, -1)).toBeUndefined();
    expect(computeNextRunAtMs(valid, 1.5)).toBeUndefined();
    expect(computeNextRunAtMs({ ...valid, everyMs: 0 }, 1_000)).toBeUndefined();
    expect(computeNextRunAtMs({ ...valid, everyMs: 1.5 }, 1_000)).toBeUndefined();
    expect(computeNextRunAtMs({ ...valid, anchorMs: -1 }, 1_000)).toBeUndefined();
    expect(computeNextRunAtMs({ ...valid, anchorMs: 1.5 }, 1_000)).toBeUndefined();
    expect(computeNextRunAtMs(
      { kind: "every", everyMs: Number.MAX_SAFE_INTEGER, anchorMs: 0 },
      Number.MAX_SAFE_INTEGER,
    )).toBeUndefined();
  });

  it("returns one-shot instants only while they remain in the future", () => {
    const schedule = { kind: "at" as const, atMs: 2_000 };
    expect(computeNextRunAtMs(schedule, 1_999)).toBe(2_000);
    expect(computeNextRunAtMs(schedule, 2_000)).toBeUndefined();
    expect(computeNextRunAtMs(schedule, 2_001)).toBeUndefined();
  });
});
