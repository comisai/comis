// SPDX-License-Identifier: Apache-2.0
import { Cron } from "croner";
import type { CronSchedule } from "./cron-types.js";

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
      return computeAt(schedule.at, nowMs);
  }
}

function computeCron(expr: string, tz: string | undefined, nowMs: number): number | undefined {
  try {
    const timezone = tz ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
    const cron = new Cron(expr, { timezone, catch: false });
    // 1ms lookback prevents skipping current-second boundary
    const nextDate = cron.nextRun(new Date(nowMs - 1));
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

function computeAt(at: string, nowMs: number): number | undefined {
  const dateMs = new Date(at).getTime();
  if (!Number.isFinite(dateMs)) return undefined;
  return dateMs > nowMs ? dateMs : undefined;
}
