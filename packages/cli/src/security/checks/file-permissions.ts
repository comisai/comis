/**
 * File permissions security check.
 *
 * Verifies that config files and data directories have restrictive
 * permissions. World-readable config files are critical because they
 * may contain credentials; group-readable is a warning.
 *
 * @module
 */

import { statSync } from "node:fs";
import type { SecurityCheck, SecurityFinding } from "../types.js";

/**
 * File permissions check.
 *
 * Checks config file permissions (world-readable = critical, group-readable = warning)
 * and data directory permissions (mode > 0o700 = warning).
 * ENOENT errors are silently ignored (missing file is not a permissions issue).
 */
export const filePermissionsCheck: SecurityCheck = {
  id: "file-permissions",
  name: "File Permissions",
  run: async (context) => {
    const findings: SecurityFinding[] = [];

    // Check each config file path
    for (const configPath of context.configPaths) {
      try {
        const stat = statSync(configPath);
        const mode = stat.mode & 0o777;

        if (mode & 0o004) {
          findings.push({
            category: "file-permissions",
            severity: "critical",
            message: `Config file is world-readable: ${configPath} (mode ${mode.toString(8)})`,
            remediation: `chmod 600 ${configPath}`,
            code: "SEC-PERM-001",
            path: configPath,
          });
        } else if (mode & 0o040) {
          findings.push({
            category: "file-permissions",
            severity: "warning",
            message: `Config file is group-readable: ${configPath} (mode ${mode.toString(8)})`,
            remediation: `chmod 600 ${configPath}`,
            code: "SEC-PERM-002",
            path: configPath,
          });
        }
      } catch (error) {
        // ENOENT (file not found) is not a permissions issue -- ignore
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "ENOENT") {
          findings.push({
            category: "file-permissions",
            severity: "warning",
            message: `Could not check permissions for ${configPath}: ${(error as Error).message}`,
            remediation: "Verify file exists and is accessible",
            code: "SEC-PERM-ERR",
            path: configPath,
          });
        }
      }
    }

    // Check data directory permissions
    if (context.dataDir) {
      try {
        const stat = statSync(context.dataDir);
        const mode = stat.mode & 0o777;

        if (mode > 0o700) {
          findings.push({
            category: "file-permissions",
            severity: "warning",
            message: `Data directory has overly permissive mode: ${context.dataDir} (mode ${mode.toString(8)})`,
            remediation: `chmod 700 ${context.dataDir}`,
            code: "SEC-PERM-003",
            path: context.dataDir,
          });
        }
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "ENOENT") {
          findings.push({
            category: "file-permissions",
            severity: "warning",
            message: `Could not check data directory permissions: ${(error as Error).message}`,
            remediation: "Verify data directory exists and is accessible",
            code: "SEC-PERM-ERR",
            path: context.dataDir,
          });
        }
      }
    }

    return findings;
  },
};
