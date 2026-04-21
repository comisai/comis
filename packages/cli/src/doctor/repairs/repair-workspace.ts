// SPDX-License-Identifier: Apache-2.0
/**
 * Workspace repair module for comis doctor.
 *
 * Repairs workspace-related findings: creates missing data, skills,
 * and log directories with secure permissions (0o700).
 *
 * Uses string concatenation for paths (not path.join) per security rules.
 *
 * @module
 */

import type { Result } from "@comis/shared";
import { ok, err } from "@comis/shared";
import { mkdirSync } from "node:fs";
import type { DoctorFinding } from "../types.js";

/**
 * Repair workspace-related findings.
 *
 * For missing directory findings (repairable=true): creates the
 * missing directories with 0o700 permissions.
 *
 * @param findings - Doctor findings from workspace-health check
 * @param dataDir - Base data directory path
 * @returns Result with list of actions taken, or Error on failure
 */
export async function repairWorkspace(
  findings: DoctorFinding[],
  dataDir: string,
): Promise<Result<string[], Error>> {
  const actions: string[] = [];

  const repairableFindings = findings.filter(
    (f) => f.category === "workspace" && f.repairable,
  );

  if (repairableFindings.length === 0) {
    return ok(actions);
  }

  try {
    for (const finding of repairableFindings) {
      if (finding.check === "Data directory" || finding.check === "Data directory writable") {
        mkdirSync(dataDir, { recursive: true, mode: 0o700 });
        actions.push(`Created data directory: ${dataDir}`);
      } else if (finding.check === "Log directory") {
        const logDir = dataDir + "/logs";
        mkdirSync(logDir, { recursive: true, mode: 0o700 });
        actions.push(`Created log directory: ${logDir}`);
      } else if (finding.check === "Skills directory") {
        // Extract the path from the finding message
        const match = finding.message.match(/missing: (.+)$/);
        if (match) {
          const skillsDir = match[1];
          mkdirSync(skillsDir, { recursive: true, mode: 0o700 });
          actions.push(`Created skills directory: ${skillsDir}`);
        }
      }
    }

    return ok(actions);
  } catch (error) {
    return err(error instanceof Error ? error : new Error(String(error)));
  }
}
