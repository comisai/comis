/**
 * Config remediation actions (advisory only).
 *
 * Creates advisory actions for config-related findings. Invalid configs
 * require manual backup + rewrite from defaults. Missing gateway tokens
 * cannot be auto-generated.
 *
 * @module
 */

import { err } from "@comis/shared";
import type { SecurityFinding } from "../types.js";
import type { RemediationAction } from "../fix-types.js";

/**
 * Create advisory remediation actions for config-related findings.
 *
 * Handles:
 * - invalid config: suggests backup + rewrite from defaults
 * - missing gateway tokens: cannot auto-generate tokens
 *
 * All actions are advisory-only (apply returns error with guidance).
 *
 * @param findings - Security findings from the audit
 * @param _configPaths - Config file paths (reserved for future use)
 * @returns Array of advisory remediation actions
 */
export function createConfigFixes(
  findings: SecurityFinding[],
  _configPaths: string[],  
): RemediationAction[] {
  const actions: RemediationAction[] = [];

  for (const finding of findings) {
    if (finding.code === "SEC-CFG-001") {
      actions.push({
        code: finding.code,
        description: "Advisory: invalid config requires manual repair",
        preview: () => "Cannot auto-fix invalid config -- backup and rewrite from defaults recommended",
        apply: async () =>
          err(new Error("Manual action required: backup config file and rewrite from defaults")),
      });
    } else if (finding.code === "SEC-GW-003") {
      actions.push({
        code: finding.code,
        description: "Advisory: gateway tokens must be manually configured",
        preview: () => "Cannot auto-generate gateway tokens -- add tokens to config manually",
        apply: async () =>
          err(new Error("Manual action required: add gateway authentication tokens to config")),
      });
    }
  }

  return actions;
}
