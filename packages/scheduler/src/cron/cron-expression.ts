// SPDX-License-Identifier: Apache-2.0
import { Cron } from "croner";
import { systemDateFrom } from "@comis/core";
import type { CronPersistedSchedule } from "./cron-types.js";

/** Compute the next nominal occurrence strictly after `exclusiveLowerBoundMs`. */
export function computeNextRunAtMs(
  schedule: CronPersistedSchedule,
  exclusiveLowerBoundMs: number,
): number | undefined {
  if (!Number.isSafeInteger(exclusiveLowerBoundMs) || exclusiveLowerBoundMs < 0) return undefined;
  switch (schedule.kind) {
    case "cron":
      return computeCron(schedule.expr, schedule.tz, exclusiveLowerBoundMs);
    case "every":
      return computeEvery(schedule.everyMs, schedule.anchorMs, exclusiveLowerBoundMs);
    case "at":
      return schedule.atMs > exclusiveLowerBoundMs ? schedule.atMs : undefined;
    default: {
      const _exhaustive: never = schedule;
      return _exhaustive;
    }
  }
}

function computeCron(expr: string, timezone: string, lowerBoundMs: number): number | undefined {
  try {
    const cron = new Cron(expr, { timezone, catch: false });
    const nextDate = cron.nextRun(systemDateFrom(lowerBoundMs));
    if (nextDate === null) return undefined;
    const nextMs = nextDate.getTime();
    return Number.isSafeInteger(nextMs) && nextMs > lowerBoundMs ? nextMs : undefined;
  } catch {
    return undefined;
  }
}

function computeEvery(everyMs: number, anchorMs: number, lowerBoundMs: number): number | undefined {
  if (!Number.isSafeInteger(everyMs) || everyMs <= 0 || !Number.isSafeInteger(anchorMs) || anchorMs < 0) {
    return undefined;
  }
  if (lowerBoundMs < anchorMs) return anchorMs;
  const elapsed = lowerBoundMs - anchorMs;
  const steps = Math.floor(elapsed / everyMs) + 1;
  const delta = steps * everyMs;
  const next = anchorMs + delta;
  return Number.isSafeInteger(delta) && Number.isSafeInteger(next) && next > lowerBoundMs
    ? next
    : undefined;
}
