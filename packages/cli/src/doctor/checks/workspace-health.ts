/**
 * Workspace health check for comis doctor.
 *
 * Verifies that workspace directories exist and are writable:
 * data directory, skills directory, and log directory.
 * Reports repairable findings for missing directories.
 *
 * Uses string concatenation for paths (not path.join) per security rules.
 *
 * @module
 */

import { existsSync, accessSync, constants } from "node:fs";
import type { DoctorCheck, DoctorFinding } from "../types.js";

const CATEGORY = "workspace";

/**
 * Doctor check: workspace directory health.
 *
 * Checks that the data directory exists and is writable, and that
 * skills and log directories are present when configured.
 */
export const workspaceHealthCheck: DoctorCheck = {
  id: "workspace-health",
  name: "Workspace",
  run: async (context) => {
    const findings: DoctorFinding[] = [];

    const dataDir = context.dataDir;

    // Check dataDir exists
    if (!existsSync(dataDir)) {
      findings.push({
        category: CATEGORY,
        check: "Data directory",
        status: "fail",
        message: `Data directory missing: ${dataDir}`,
        suggestion: "Repair will create data directory",
        repairable: true,
      });
    } else {
      // Check dataDir is writable
      try {
        accessSync(dataDir, constants.W_OK);
      } catch {
        findings.push({
          category: CATEGORY,
          check: "Data directory writable",
          status: "fail",
          message: `Data directory is not writable: ${dataDir}`,
          suggestion: "Check directory permissions",
          repairable: true,
        });
      }
    }

    // Check for skills directory if configured
    if (context.config?.agents) {
      for (const agent of Object.values(context.config.agents)) {
        if (agent.skills?.discoveryPaths) {
          for (const skillsPath of agent.skills.discoveryPaths) {
            if (!existsSync(skillsPath)) {
              findings.push({
                category: CATEGORY,
                check: "Skills directory",
                status: "warn",
                message: `Skills directory missing: ${skillsPath}`,
                suggestion: "Repair will create skills directory",
                repairable: true,
              });
            }
          }
        }
      }
    }

    // Check for log directory
    const logDir = dataDir + "/logs";
    if (!existsSync(logDir)) {
      findings.push({
        category: CATEGORY,
        check: "Log directory",
        status: "warn",
        message: `Log directory missing: ${logDir}`,
        suggestion: "Repair will create log directory",
        repairable: true,
      });
    }

    // If no failures were found, report healthy
    if (findings.length === 0) {
      findings.push({
        category: CATEGORY,
        check: "Workspace directories",
        status: "pass",
        message: "Workspace directories are healthy",
        repairable: false,
      });
    }

    return findings;
  },
};
