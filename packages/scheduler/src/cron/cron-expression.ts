// SPDX-License-Identifier: Apache-2.0
import { Cron } from "croner";
import type { CronSchedule } from "./cron-types.js";
import { systemDateFrom } from "@comis/core";

/**
 * Compute the next run time in milliseconds for a given schedule.
 *
 * Handles three schedule kinds:
 * - "cron": standard cron expression via croner library
 * - "every": interval-based with optional anchor
 * - "at": one-shot at a specific ISO 8601 datetime
 *
 * Returns undefined if no future run is possible (past one-shot, invalid expression, etc).
 */
export function computeNextRunAtMs(schedule: CronSchedule, nowMs: number): number | undefined {
  switch (schedule.kind) {
    case "cron":
      return computeCron(schedule.expr, schedule.tz, nowMs);
    case "every":
      return computeEvery(schedule.everyMs, schedule.anchorMs, nowMs);
    case "at":
      return computeAt(schedule.at, nowMs, schedule.tz);
  }
}

function computeCron(expr: string, tz: string | undefined, nowMs: number): number | undefined {
  try {
    const timezone = tz ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
    const cron = new Cron(expr, { timezone, catch: false });
    // 1ms lookback prevents skipping current-second boundary
    const nextDate = cron.nextRun(systemDateFrom(nowMs - 1));
    if (!nextDate) return undefined;
    const nextMs = nextDate.getTime();
    if (!Number.isFinite(nextMs) || nextMs < nowMs) return undefined;
    return nextMs;
  } catch {
    // Invalid cron expression
    return undefined;
  }
}

function computeEvery(
  everyMs: number,
  anchorMs: number | undefined,
  nowMs: number,
): number | undefined {
  const interval = Math.max(1, Math.floor(everyMs));
  const anchor = anchorMs ?? nowMs;

  if (nowMs < anchor) {
    return anchor;
  }

  const elapsed = nowMs - anchor;
  const steps = Math.max(1, Math.floor((elapsed + interval - 1) / interval));
  const next = anchor + steps * interval;
  return next;
}

function computeAt(at: string, nowMs: number, tz?: string): number | undefined {
  // When a tz is given AND `at` is a naive wall-clock (no explicit offset),
  // interpret it in that zone. Otherwise fall back to system-local parsing
  // (the prior behavior). An `at` that already carries an offset (Z / ±HH:MM)
  // is unambiguous, so the tz is ignored for it.
  const dateMs =
    tz && !HAS_EXPLICIT_OFFSET.test(at)
      ? zonedWallClockToUtcMs(at, tz)
      : systemDateFrom(at).getTime();
  if (!Number.isFinite(dateMs)) return undefined;
  return dateMs > nowMs ? dateMs : undefined;
}

/** ISO-8601 trailing offset: "Z", "+02:00", "-0700", etc. */
const HAS_EXPLICIT_OFFSET = /([zZ]|[+-]\d{2}:?\d{2})$/;

/**
 * Offset (ms) of `timeZone` at the instant `utcMs`: the wall-clock the zone
 * shows for that instant, reinterpreted as UTC, minus the instant. DST-aware.
 */
function tzOffsetMs(utcMs: number, timeZone: string): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const p: Record<string, number> = {};
  for (const part of dtf.formatToParts(new Date(utcMs))) {
    if (part.type !== "literal") p[part.type] = Number(part.value);
  }
  const asUtc = Date.UTC(p.year!, p.month! - 1, p.day!, p.hour!, p.minute!, p.second!);
  return asUtc - utcMs;
}

/**
 * Convert a NAIVE ISO-8601 wall-clock datetime (no offset) interpreted in
 * `timeZone` to a UTC epoch (ms). DST-aware via a one-step offset refinement
 * (handles the offset that applies at the target instant, not just "now").
 * Returns NaN for an unparseable datetime or an invalid IANA zone.
 */
function zonedWallClockToUtcMs(naiveIso: string, timeZone: string): number {
  const asIfUtc = Date.parse(naiveIso.endsWith("Z") ? naiveIso : `${naiveIso}Z`);
  if (!Number.isFinite(asIfUtc)) return NaN;
  try {
    const utc1 = asIfUtc - tzOffsetMs(asIfUtc, timeZone);
    // Refine once so the offset is taken at the resolved instant (DST-correct).
    return asIfUtc - tzOffsetMs(utc1, timeZone);
  } catch {
    // Invalid IANA timeZone → Intl throws a RangeError.
    return NaN;
  }
}
