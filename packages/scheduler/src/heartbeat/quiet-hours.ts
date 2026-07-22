// SPDX-License-Identifier: Apache-2.0
// @allow-throw: @allow-throw boundary: quiet-hours time-format validation guards; consumed via setup-heartbeat daemon-wiring (daemon.ts bootstrap).
/**
 * Quiet hours notification suppression.
 *
 * Determines whether the current time falls within a configured quiet
 * window. Supports overnight windows (e.g., 22:00-07:00) and same-day
 * windows (e.g., 13:00-17:00). Start time is inclusive, end time exclusive.
 */

import { systemDateFrom } from "@comis/core";
import { err, ok, tryCatch, type Result } from "@comis/shared";

const QUIET_END_SEARCH_MINUTES = 27 * 60;

/** Configuration for quiet hours notification suppression. */
export interface QuietHoursConfig {
  /** Whether quiet hours are enabled. */
  enabled: boolean;
  /** Start time in HH:MM format (inclusive). */
  start: string;
  /** End time in HH:MM format (exclusive). */
  end: string;
  /** IANA timezone string (empty = system local). */
  timezone: string;
}

/**
 * Parse a "HH:MM" time string to minutes since midnight.
 *
 * @throws Error on invalid format
 */
export function parseTimeToMinutes(time: string): number {
  const match = /^(\d{2}):(\d{2})$/.exec(time);
  if (!match) {
    throw new Error(`Invalid time format: "${time}" (expected HH:MM)`);
  }
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) {
    throw new Error(`Invalid time value: "${time}" (hours 0-23, minutes 0-59)`);
  }
  return hours * 60 + minutes;
}

/**
 * Get current minutes since midnight in the given timezone.
 *
 * Uses Intl.DateTimeFormat with hourCycle: "h23" for 24-hour format.
 * If timezone is empty string, system local timezone is used.
 */
export function getCurrentMinutesInTimezone(nowMs: number, timezone: string): number {
  const date = systemDateFrom(nowMs);
  const options: Intl.DateTimeFormatOptions = {
    hour: "numeric",
    minute: "numeric",
    hourCycle: "h23",
  };
  if (timezone !== "") {
    options.timeZone = timezone;
  }
  const formatter = new Intl.DateTimeFormat("en-US", options);
  const parts = formatter.formatToParts(date);

  let hours = 0;
  let minutes = 0;
  for (const part of parts) {
    if (part.type === "hour") hours = Number(part.value);
    if (part.type === "minute") minutes = Number(part.value);
  }

  return hours * 60 + minutes;
}

/**
 * Check whether the current time falls within quiet hours.
 *
 * Returns false if quiet hours are disabled.
 * Handles overnight windows (start > end, e.g. 22:00-07:00):
 *   current >= start OR current < end
 * Handles same-day windows (start < end, e.g. 13:00-17:00):
 *   current >= start AND current < end
 */
export function isInQuietHours(config: QuietHoursConfig, nowMs: number): boolean {
  if (!config.enabled) return false;

  const startMin = parseTimeToMinutes(config.start);
  const endMin = parseTimeToMinutes(config.end);
  const currentMin = getCurrentMinutesInTimezone(nowMs, config.timezone);

  if (startMin > endMin) {
    // Overnight window (e.g., 22:00-07:00)
    return currentMin >= startMin || currentMin < endMin;
  }
  // Same-day window (e.g., 13:00-17:00)
  return currentMin >= startMin && currentMin < endMin;
}

export type QuietHoursResolutionError = {
  readonly code: "invalid_config";
  readonly errorKind: "config";
};

/** Resolve the next exact minute boundary where the current quiet window ends. */
export function resolveQuietHoursEndMs(
  config: QuietHoursConfig,
  nowMs: number,
): Result<number | null, QuietHoursResolutionError> {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
    return err({ code: "invalid_config", errorKind: "config" });
  }
  const active = tryCatch(() => isInQuietHours(config, nowMs));
  if (!active.ok) return err({ code: "invalid_config", errorKind: "config" });
  if (!active.value) return ok(null);

  let candidateMs = nowMs - (nowMs % 60_000) + 60_000;
  for (let minute = 0; minute < QUIET_END_SEARCH_MINUTES; minute += 1) {
    const candidate = tryCatch(() => isInQuietHours(config, candidateMs));
    if (!candidate.ok) return err({ code: "invalid_config", errorKind: "config" });
    if (!candidate.value) return ok(candidateMs);
    candidateMs += 60_000;
  }
  return err({ code: "invalid_config", errorKind: "config" });
}
