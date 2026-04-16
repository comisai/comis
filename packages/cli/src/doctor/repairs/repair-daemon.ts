/**
 * Daemon repair module for comis doctor.
 *
 * Repairs daemon-related findings: removes stale PID files
 * when the daemon process is no longer running.
 *
 * @module
 */

import type { Result } from "@comis/shared";
import { ok, err } from "@comis/shared";
import { unlinkSync } from "node:fs";
import type { DoctorFinding } from "../types.js";

/**
 * Repair daemon-related findings.
 *
 * For stale PID file findings (repairable=true): removes the stale
 * PID file so the daemon can be cleanly restarted.
 *
 * @param findings - Doctor findings from daemon-health check
 * @param pidFile - Path to the daemon PID file
 * @returns Result with list of actions taken, or Error on failure
 */
export async function repairDaemon(
  findings: DoctorFinding[],
  pidFile: string,
): Promise<Result<string[], Error>> {
  const actions: string[] = [];

  const repairableFindings = findings.filter(
    (f) => f.category === "daemon" && f.repairable,
  );

  if (repairableFindings.length === 0) {
    return ok(actions);
  }

  try {
    for (const _finding of repairableFindings) { // eslint-disable-line @typescript-eslint/no-unused-vars
      unlinkSync(pidFile);
      actions.push(`Removed stale PID file: ${pidFile}`);
    }

    return ok(actions);
  } catch (error) {
    return err(error instanceof Error ? error : new Error(String(error)));
  }
}
