// SPDX-License-Identifier: Apache-2.0
/**
 * Config validation security check.
 *
 * Validates that the config file parses correctly against the
 * AppConfigSchema. Parse failures indicate malformed config that
 * could lead to insecure default behavior.
 *
 * @module
 */

import { AppConfigSchema } from "@comis/core";
import type { SecurityCheck, SecurityFinding } from "../types.js";

/**
 * Config validation check.
 *
 * If config is undefined but rawConfigContent exists, attempts safeParse.
 * If config already exists (parsed), emits an info finding confirming validity.
 */
export const configValidationCheck: SecurityCheck = {
  id: "config-validation",
  name: "Config Validation",
  run: async (context) => {
    const findings: SecurityFinding[] = [];

    if (context.config === undefined && context.rawConfigContent !== undefined) {
      // Config not yet parsed -- attempt validation
      let rawObj: unknown;
      try {
        // Try JSON first, then YAML-like plain object
        rawObj = JSON.parse(context.rawConfigContent);
      } catch {
        // Not JSON -- for YAML content, the caller should have already parsed it.
        // If we have raw content but no config, it likely failed upstream.
        findings.push({
          category: "config-validation",
          severity: "critical",
          message: "Config file could not be parsed",
          remediation: "Check config file syntax (YAML or JSON format required)",
          code: "SEC-CFG-001",
        });
        return findings;
      }

      const result = AppConfigSchema.safeParse(rawObj);
      if (!result.success) {
        const issues = result.error.issues
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; ");
        findings.push({
          category: "config-validation",
          severity: "critical",
          message: `Config validation failed: ${issues}`,
          remediation: "Fix the reported config schema violations",
          code: "SEC-CFG-001",
        });
      } else {
        findings.push({
          category: "config-validation",
          severity: "info",
          message: "Config validates successfully",
          remediation: "None needed",
          code: "SEC-CFG-PASS",
        });
      }
    } else if (context.config !== undefined) {
      // Config was already successfully parsed
      findings.push({
        category: "config-validation",
        severity: "info",
        message: "Config validates successfully",
        remediation: "None needed",
        code: "SEC-CFG-PASS",
      });
    }

    return findings;
  },
};
