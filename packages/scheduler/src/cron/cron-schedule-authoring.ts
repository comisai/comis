// SPDX-License-Identifier: Apache-2.0
import { Cron } from "croner";
import { systemDateFrom } from "@comis/core";
import { err, ok, type Result } from "@comis/shared";
import {
  CronAuthoringScheduleSchema,
  type CronAuthoringSchedule,
  type CronPersistedSchedule,
} from "./cron-types.js";

export type CronScheduleAuthoringErrorCode =
  | "invalid_input"
  | "invalid_timezone"
  | "invalid_expression"
  | "conflicting_timezone"
  | "nonexistent_wall_time"
  | "ambiguous_wall_time"
  | "past_schedule"
  | "unsafe_epoch";

export class CronScheduleAuthoringError extends Error {
  readonly errorKind = "validation" as const;

  constructor(readonly code: CronScheduleAuthoringErrorCode, message: string) {
    super(message);
  }
}

/** Resolve public schedule intent to the only schema persisted by CronStore. */
export function resolveCronAuthoringSchedule(
  input: CronAuthoringSchedule,
  authoredAtMs: number,
  configuredDefaultTimezone: string,
): Result<CronPersistedSchedule, CronScheduleAuthoringError> {
  const parsed = CronAuthoringScheduleSchema.safeParse(input);
  if (!parsed.success || !isSafeEpoch(authoredAtMs)) {
    return err(new CronScheduleAuthoringError("invalid_input", "Invalid cron schedule input"));
  }

  const defaultTimezone = configuredDefaultTimezone.trim() || "UTC";
  if (!isIanaTimezone(defaultTimezone)) {
    return err(new CronScheduleAuthoringError("invalid_timezone", "Invalid default scheduler timezone"));
  }

  const schedule = parsed.data;
  switch (schedule.kind) {
    case "cron": {
      const tz = schedule.tz ?? defaultTimezone;
      if (!isIanaTimezone(tz)) {
        return err(new CronScheduleAuthoringError("invalid_timezone", "Invalid cron timezone"));
      }
      try {
        new Cron(schedule.expr, { timezone: tz, catch: false });
      } catch {
        return err(new CronScheduleAuthoringError("invalid_expression", "Invalid cron expression"));
      }
      return ok({ kind: "cron", expr: schedule.expr, tz });
    }
    case "every":
      return ok({
        kind: "every",
        everyMs: schedule.everyMs,
        anchorMs: schedule.anchorMs ?? authoredAtMs,
      });
    case "in": {
      const deltaMs = schedule.seconds * 1_000;
      const atMs = authoredAtMs + deltaMs;
      if (!Number.isSafeInteger(deltaMs) || !isSafeEpoch(atMs) || atMs <= authoredAtMs) {
        return err(new CronScheduleAuthoringError("unsafe_epoch", "Relative schedule exceeds the safe epoch range"));
      }
      return ok({ kind: "at", atMs });
    }
    case "at": {
      const explicitOffset = HAS_EXPLICIT_OFFSET.test(schedule.at);
      if (explicitOffset && schedule.tz !== undefined) {
        return err(new CronScheduleAuthoringError(
          "conflicting_timezone",
          "An offset-bearing timestamp cannot also specify a timezone",
        ));
      }
      if (explicitOffset && schedule.fold !== undefined) {
        return err(new CronScheduleAuthoringError(
          "conflicting_timezone",
          "Fold selection is legal only for a naive wall-clock timestamp",
        ));
      }

      let atMs: number;
      if (explicitOffset) {
        atMs = Date.parse(schedule.at);
        if (!isSafeEpoch(atMs)) {
          return err(new CronScheduleAuthoringError("invalid_input", "Invalid offset-bearing timestamp"));
        }
      } else {
        const tz = schedule.tz ?? defaultTimezone;
        if (!isIanaTimezone(tz)) {
          return err(new CronScheduleAuthoringError("invalid_timezone", "Invalid wall-clock timezone"));
        }
        const resolved = resolveWallClock(schedule.at, tz);
        if (!resolved.ok) return resolved;
        if (resolved.value.length > 1 && schedule.fold === undefined) {
          return err(new CronScheduleAuthoringError(
            "ambiguous_wall_time",
            "Ambiguous wall-clock timestamp requires earlier or later fold selection",
          ));
        }
        atMs = schedule.fold === "later"
          ? resolved.value.at(-1)!
          : resolved.value[0]!;
      }

      if (atMs <= authoredAtMs) {
        return err(new CronScheduleAuthoringError("past_schedule", "One-shot schedule must be in the future"));
      }
      return ok({ kind: "at", atMs });
    }
    default: {
      const _exhaustive: never = schedule;
      return err(new CronScheduleAuthoringError("invalid_input", `Unsupported schedule: ${String(_exhaustive)}`));
    }
  }
}

const HAS_EXPLICIT_OFFSET = /([zZ]|[+-]\d{2}:?\d{2})$/;
const NAIVE_ISO = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/;

type WallClockFields = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  millisecond: number;
};

function resolveWallClock(
  value: string,
  timezone: string,
): Result<readonly number[], CronScheduleAuthoringError> {
  const fields = parseWallClock(value);
  if (fields === undefined) {
    return err(new CronScheduleAuthoringError("invalid_input", "Invalid naive wall-clock timestamp"));
  }
  const nominalMs = Date.UTC(
    fields.year,
    fields.month - 1,
    fields.day,
    fields.hour,
    fields.minute,
    fields.second,
    fields.millisecond,
  );
  if (!isSafeEpoch(nominalMs)) {
    return err(new CronScheduleAuthoringError("unsafe_epoch", "Wall-clock timestamp exceeds the safe epoch range"));
  }

  const offsets = new Set<number>();
  const twoDaysMs = 2 * 24 * 60 * 60 * 1_000;
  const sampleStepMs = 6 * 60 * 60 * 1_000;
  for (let sample = nominalMs - twoDaysMs; sample <= nominalMs + twoDaysMs; sample += sampleStepMs) {
    offsets.add(timezoneOffsetMs(sample, timezone));
  }

  const candidates = [...offsets]
    .map((offset) => nominalMs - offset)
    .filter((candidate) => isSafeEpoch(candidate) && fieldsEqual(formatWallClock(candidate, timezone), fields))
    .filter((candidate, index, all) => all.indexOf(candidate) === index)
    .sort((left, right) => left - right);
  if (candidates.length === 0) {
    return err(new CronScheduleAuthoringError(
      "nonexistent_wall_time",
      "Wall-clock timestamp does not exist in the requested timezone",
    ));
  }
  return ok(candidates);
}

function parseWallClock(value: string): WallClockFields | undefined {
  const match = NAIVE_ISO.exec(value);
  if (match === null) return undefined;
  const fields: WallClockFields = {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: Number(match[4]),
    minute: Number(match[5]),
    second: Number(match[6] ?? "0"),
    millisecond: Number((match[7] ?? "0").padEnd(3, "0")),
  };
  const roundTrip = systemDateFrom(Date.UTC(
    fields.year,
    fields.month - 1,
    fields.day,
    fields.hour,
    fields.minute,
    fields.second,
    fields.millisecond,
  ));
  if (
    roundTrip.getUTCFullYear() !== fields.year
    || roundTrip.getUTCMonth() + 1 !== fields.month
    || roundTrip.getUTCDate() !== fields.day
    || roundTrip.getUTCHours() !== fields.hour
    || roundTrip.getUTCMinutes() !== fields.minute
    || roundTrip.getUTCSeconds() !== fields.second
    || roundTrip.getUTCMilliseconds() !== fields.millisecond
  ) return undefined;
  return fields;
}

function formatWallClock(epochMs: number, timezone: string): WallClockFields {
  const values: Record<string, number> = {};
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(epochMs);
  for (const part of parts) {
    if (part.type !== "literal") values[part.type] = Number(part.value);
  }
  return {
    year: values.year!, month: values.month!, day: values.day!,
    hour: values.hour!, minute: values.minute!, second: values.second!,
    millisecond: epochMs % 1_000,
  };
}

function timezoneOffsetMs(epochMs: number, timezone: string): number {
  const local = formatWallClock(epochMs, timezone);
  return Date.UTC(
    local.year, local.month - 1, local.day,
    local.hour, local.minute, local.second, local.millisecond,
  ) - epochMs;
}

function fieldsEqual(left: WallClockFields, right: WallClockFields): boolean {
  return left.year === right.year && left.month === right.month && left.day === right.day
    && left.hour === right.hour && left.minute === right.minute && left.second === right.second
    && left.millisecond === right.millisecond;
}

function isIanaTimezone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format(0);
    return true;
  } catch {
    return false;
  }
}

function isSafeEpoch(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}
