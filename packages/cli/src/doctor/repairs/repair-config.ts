/**
 * Config repair module for comis doctor.
 *
 * Repairs config-related findings: creates missing config files or
 * restores corrupt configs from backup/defaults.
 *
 * Uses string concatenation for paths (not path.join) per security rules.
 *
 * @module
 */

import type { Result } from "@comis/shared";
import { ok, err } from "@comis/shared";
import { writeFileSync, existsSync, mkdirSync, copyFileSync } from "node:fs";
import type { DoctorFinding } from "../types.js";

/** Default minimal config YAML content. */
const DEFAULT_CONFIG = `# Comis configuration
tenantId: default
logLevel: info
`;

/**
 * Create a simple timestamped backup of a file.
 *
 * Copies the source to `{path}.backup.{timestamp}`.
 * Returns the backup path on success.
 */
function createBackup(filePath: string): string | null {
  try {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "").replace("T", "T").slice(0, 15) + "Z";
    const backupPath = `${filePath}.backup.${timestamp}`;
    copyFileSync(filePath, backupPath);
    return backupPath;
  } catch {
    return null;
  }
}

/**
 * Repair config-related findings.
 *
 * For config-health findings with repairable=true:
 * - If config missing: creates a minimal default config YAML.
 * - If config corrupt: backs up the corrupt file, then writes defaults.
 *
 * @param findings - Doctor findings from config-health check
 * @param configPaths - Config file paths to use
 * @returns Result with list of actions taken, or Error on failure
 */
export async function repairConfig(
  findings: DoctorFinding[],
  configPaths: string[],
): Promise<Result<string[], Error>> {
  const actions: string[] = [];

  const repairableFindings = findings.filter(
    (f) => f.category === "config" && f.repairable,
  );

  if (repairableFindings.length === 0) {
    return ok(actions);
  }

  try {
    // Determine target config path
    // eslint-disable-next-line no-restricted-syntax -- CLI repair reads env directly for home directory
    const homedir = process.env["HOME"] || process.env["USERPROFILE"] || "/root";
    const targetPath = configPaths.length > 0
      ? configPaths[0]
      : homedir + "/.comis/config.yaml";

    for (const finding of repairableFindings) {
      if (finding.message.includes("corrupt")) {
        // Config is corrupt -- backup first, then write defaults
        if (existsSync(targetPath)) {
          const backupPath = createBackup(targetPath);
          if (backupPath) {
            actions.push(`Backed up corrupt config to: ${backupPath}`);
          }
        }

        writeFileSync(targetPath, DEFAULT_CONFIG, { mode: 0o600 });
        actions.push(`Wrote default config to: ${targetPath}`);
      } else if (finding.message.includes("not found") || finding.message.includes("No config")) {
        // Config missing -- create directory and write defaults
        const lastSlash = targetPath.lastIndexOf("/");
        if (lastSlash > 0) {
          const dir = targetPath.slice(0, lastSlash);
          mkdirSync(dir, { recursive: true, mode: 0o700 });
        }

        writeFileSync(targetPath, DEFAULT_CONFIG, { mode: 0o600 });
        actions.push(`Created default config at: ${targetPath}`);
      }
    }

    return ok(actions);
  } catch (error) {
    return err(error instanceof Error ? error : new Error(String(error)));
  }
}
