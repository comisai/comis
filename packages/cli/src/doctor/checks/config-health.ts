// SPDX-License-Identifier: Apache-2.0
/**
 * Config health check for comis doctor.
 *
 * Verifies that config files exist, are parseable YAML, and validate
 * against the AppConfigSchema — consuming the SAME store-aware resolution
 * (`config-resolve.ts`) the rest of doctor uses, so this check and the
 * gateway/channel checks can never disagree about whether the config
 * loaded. Reports repairable findings for missing or corrupt config files,
 * and names any `${VAR}` references that the process environment, active
 * data-dir `.env`, and configured store all missed (the usual root cause of
 * placeholder-shaped validation noise).
 *
 * @module
 */

import { resolveDoctorConfig } from "../config-resolve.js";
import type { DoctorCheck, DoctorFinding } from "../types.js";

const CATEGORY = "config";

/**
 * Doctor check: config file health.
 *
 * Checks if config files exist, can be parsed as YAML, and validate
 * against the AppConfigSchema after daemon-equivalent `${VAR}` substitution.
 */
export const configHealthCheck: DoctorCheck = {
  id: "config-health",
  name: "Configuration",
  run: async (context) => {
    const findings: DoctorFinding[] = [];

    // Check if any config path exists
    if (context.configPaths.length === 0) {
      findings.push({
        category: CATEGORY,
        check: "Config file exists",
        status: "fail",
        message: "No config file paths provided",
        suggestion: "Run comis init to create config",
        repairable: true,
      });
      return findings;
    }

    const resolution =
      context.configResolution ?? resolveDoctorConfig(context.configPaths);

    if (resolution.loadError !== undefined) {
      const { kind, message } = resolution.loadError;
      findings.push({
        category: CATEGORY,
        check: kind === "missing" ? "Config file exists" : "Config file parseable",
        status: "fail",
        message,
        suggestion:
          kind === "missing"
            ? "Run comis init to create config"
            : "Config is corrupt -- repair will restore from backup or defaults",
        repairable: true,
      });
      return findings;
    }

    // References nothing resolved are reported first: they are almost always
    // the cause of the validation issues that follow, and the message names
    // the exact knob (var name + config path + the three places checked).
    if (resolution.unresolvedRefs !== undefined && resolution.unresolvedRefs.length > 0) {
      const refs = resolution.unresolvedRefs
        .map((ref) => `\${${ref.varName}} at ${ref.path}`)
        .join(", ");
      findings.push({
        category: CATEGORY,
        check: "Secret references",
        status: "warn",
        message: `Unresolved secret reference(s): ${refs} — not in the process environment, active data-dir .env, or configured secret store`,
        suggestion: "Set the variable in the environment or store it via comis secrets set",
        repairable: false,
      });
    }

    if (resolution.validationIssues !== undefined) {
      findings.push({
        category: CATEGORY,
        check: "Config schema validation",
        status: "warn",
        message: `Config validation issues: ${resolution.validationIssues.join("; ")}`,
        repairable: false,
      });
      return findings;
    }

    findings.push({
      category: CATEGORY,
      check: "Config files",
      status: "pass",
      message: "Config files are valid",
      repairable: false,
    });

    return findings;
  },
};
