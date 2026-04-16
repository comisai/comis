/**
 * State protection security check.
 *
 * Verifies that the data directory exists with appropriate permissions,
 * and that database files within it are not world-writable.
 *
 * @module
 */

import { existsSync, statSync, readdirSync } from "node:fs";
import type { SecurityCheck, SecurityFinding } from "../types.js";

/** Database file extensions to check for permissions. */
const DB_FILE_PATTERNS = [".db", ".sqlite", ".sqlite3"];

/**
 * State protection check.
 *
 * Verifies data directory existence and permissions, and checks
 * for world-writable database files.
 */
export const stateProtectionCheck: SecurityCheck = {
  id: "state-protection",
  name: "State Protection",
  run: async (context) => {
    const findings: SecurityFinding[] = [];

    if (!context.dataDir) {
      return findings;
    }

    // Check data directory existence
    if (!existsSync(context.dataDir)) {
      findings.push({
        category: "state-protection",
        severity: "warning",
        message: `Data directory does not exist: ${context.dataDir}`,
        remediation: `Create data directory with restrictive permissions: mkdir -m 700 ${context.dataDir}`,
        code: "SEC-STATE-001",
        path: context.dataDir,
      });
      return findings;
    }

    // Check data directory permissions
    try {
      const stat = statSync(context.dataDir);
      const mode = stat.mode & 0o777;

      if (mode & 0o002) {
        findings.push({
          category: "state-protection",
          severity: "critical",
          message: `Data directory is world-writable: ${context.dataDir} (mode ${mode.toString(8)})`,
          remediation: `chmod 700 ${context.dataDir}`,
          code: "SEC-STATE-002",
          path: context.dataDir,
        });
      }
    } catch (error) {
      findings.push({
        category: "state-protection",
        severity: "warning",
        message: `Could not check data directory permissions: ${(error as Error).message}`,
        remediation: "Verify data directory is accessible",
        code: "SEC-STATE-ERR",
        path: context.dataDir,
      });
      return findings;
    }

    // Check database files for world-writable permissions
    try {
      const entries = readdirSync(context.dataDir);
      for (const entry of entries) {
        const isDbFile = DB_FILE_PATTERNS.some((ext) => entry.endsWith(ext));
        if (!isDbFile) continue;

        const filePath = context.dataDir + "/" + entry;
        try {
          const stat = statSync(filePath);
          const mode = stat.mode & 0o777;

          if (mode & 0o002) {
            findings.push({
              category: "state-protection",
              severity: "critical",
              message: `Database file is world-writable: ${filePath} (mode ${mode.toString(8)})`,
              remediation: `chmod 600 ${filePath}`,
              code: "SEC-STATE-003",
              path: filePath,
            });
          }
        } catch {
          // Skip files we can't stat
        }
      }
    } catch {
      // If we can't read the directory, we already checked permissions above
    }

    return findings;
  },
};
