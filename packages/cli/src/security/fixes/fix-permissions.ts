/**
 * Permission remediation actions.
 *
 * Creates fix actions for file/directory permission findings:
 * - config files chmod to 600
 * - data directories chmod to 700
 * - world-writable state files chmod to 600
 *
 * @module
 */

import { chmodSync } from "node:fs";
import { ok, err } from "@comis/shared";
import type { SecurityFinding } from "../types.js";
import type { RemediationAction } from "../fix-types.js";

/** Finding codes that can be remediated by permission changes. */
const CONFIG_PERM_CODES = new Set(["SEC-PERM-001", "SEC-PERM-002"]);
const DIR_PERM_CODES = new Set(["SEC-PERM-003"]);
const STATE_PERM_CODES = new Set(["SEC-STATE-002", "SEC-STATE-003"]);

/**
 * Create remediation actions for permission-related security findings.
 *
 * Skips findings without a path property (nothing to chmod).
 *
 * @param findings - Security findings from the audit
 * @returns Array of remediation actions for permission fixes
 */
export function createPermissionFixes(findings: SecurityFinding[]): RemediationAction[] {
  const actions: RemediationAction[] = [];

  for (const finding of findings) {
    if (!finding.path) continue;

    const filePath = finding.path;

    if (CONFIG_PERM_CODES.has(finding.code)) {
      actions.push({
        code: finding.code,
        description: "Restrict config file permissions to owner-only",
        preview: () => `chmod 600 ${filePath}`,
        apply: async () => {
          try {
            chmodSync(filePath, 0o600);
            return ok(`Set ${filePath} to mode 600`);
          } catch (error) {
            return err(error instanceof Error ? error : new Error(String(error)));
          }
        },
      });
    } else if (DIR_PERM_CODES.has(finding.code)) {
      actions.push({
        code: finding.code,
        description: "Restrict data directory permissions to owner-only",
        preview: () => `chmod 700 ${filePath}`,
        apply: async () => {
          try {
            chmodSync(filePath, 0o700);
            return ok(`Set ${filePath} to mode 700`);
          } catch (error) {
            return err(error instanceof Error ? error : new Error(String(error)));
          }
        },
      });
    } else if (STATE_PERM_CODES.has(finding.code)) {
      actions.push({
        code: finding.code,
        description: "Restrict state file permissions to owner-only",
        preview: () => `chmod 600 ${filePath}`,
        apply: async () => {
          try {
            chmodSync(filePath, 0o600);
            return ok(`Set ${filePath} to mode 600`);
          } catch (error) {
            return err(error instanceof Error ? error : new Error(String(error)));
          }
        },
      });
    }
  }

  return actions;
}
