// SPDX-License-Identifier: Apache-2.0
/**
 * Quiet-hours suppression for a cron job's USER-FACING delivery.
 *
 * The cron still RUNS (execution/maintenance is never skipped) — only its
 * output does not ping the channel off-hours, honoring the documented contract
 * ("cron jobs and heartbeat alerts are suppressed" during quiet hours;
 * `docs/operations/scheduler.mdx`). It mirrors the wake-gate precedent (a
 * routine ✓ ping never lands overnight): suppress the DELIVERY, not the run.
 * Crons carry no per-job criticality, so there is no `criticalBypass` branch
 * here — the documented contract is unconditional.
 */
import type { ComisLogger } from "@comis/infra";
import type { QuietHoursConfig } from "@comis/scheduler";
import { isInQuietHours } from "@comis/scheduler";

/**
 * Whether a non-critical cron's user-facing delivery should be suppressed
 * because quiet hours are active. `isInQuietHours` already returns false when
 * quiet hours are disabled.
 */
export function cronDeliverySuppressedByQuietHours(quietHours: QuietHoursConfig, nowMs: number): boolean {
  return isInQuietHours(quietHours, nowMs);
}

/**
 * Throw-safe gate for the two cron delivery listeners. Returns true when the
 * caller must WITHHOLD the delivery (and it has already emitted the INFO record
 * naming the suppression). A malformed `quietHours.start/end` fails toward
 * DELIVER (returns false) with a WARN — off-hours silence must never swallow a
 * misconfiguration into permanent muteness.
 */
export function cronDeliverySuppressedByQuietHoursLogged(
  quietHours: QuietHoursConfig,
  nowMs: number,
  logger: ComisLogger,
  jobName: string,
  kind: "agentTurn" | "system_event",
): boolean {
  let suppress = false;
  try {
    suppress = cronDeliverySuppressedByQuietHours(quietHours, nowMs);
  } catch (qhErr) {
    logger.warn(
      { err: qhErr, jobName, errorKind: "config" as const, hint: "scheduler.quietHours.start/end must be HH:MM — delivering anyway (fail-open)" },
      "Cron quiet-hours check failed",
    );
  }
  if (suppress) {
    logger.info(
      { jobName, quietHours: true, step: "quiet-hours" },
      kind === "agentTurn"
        ? "Cron agentTurn delivery suppressed (quiet hours) — job ran, output withheld off-hours"
        : "Cron system_event delivery suppressed (quiet hours) — output withheld off-hours",
    );
  }
  return suppress;
}
