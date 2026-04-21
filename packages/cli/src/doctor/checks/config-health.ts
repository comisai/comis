// SPDX-License-Identifier: Apache-2.0
/**
 * Config health check for comis doctor.
 *
 * Verifies that config files exist, are parseable YAML, and validate
 * against the AppConfigSchema. Reports repairable findings for missing
 * or corrupt config files.
 *
 * @module
 */

import { readFileSync } from "node:fs";
import os from "node:os";
import { parse as parseYaml } from "yaml";
import { AppConfigSchema, loadEnvFile } from "@comis/core";
import type { DoctorCheck, DoctorFinding } from "../types.js";

const ENV_REF_RE = /\$\{([A-Z_][A-Z0-9_]*)\}/g;

/** Deep-walk an object and resolve `${VAR}` references using process.env. */
function resolveEnvRefs(obj: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === "string" && value.includes("${")) {
      // eslint-disable-next-line no-restricted-syntax -- CLI bootstrap before SecretManager
      obj[key] = value.replace(ENV_REF_RE, (match, varName: string) => process.env[varName] ?? match);
    } else if (value && typeof value === "object" && !Array.isArray(value)) {
      resolveEnvRefs(value as Record<string, unknown>);
    } else if (Array.isArray(value)) {
      for (const item of value) {
        if (item && typeof item === "object") resolveEnvRefs(item as Record<string, unknown>);
      }
    }
  }
}

const CATEGORY = "config";

/**
 * Doctor check: config file health.
 *
 * Checks if config files exist, can be parsed as YAML, and validate
 * against the AppConfigSchema.
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

    let configContent: string | undefined;
    let foundPath: string | undefined;

    for (const configPath of context.configPaths) {
      try {
        configContent = readFileSync(configPath, "utf-8");
        foundPath = configPath;
        break;
      } catch {
        // Try next path
      }
    }

    if (!configContent || !foundPath) {
      findings.push({
        category: CATEGORY,
        check: "Config file exists",
        status: "fail",
        message: "No config file found at any configured path",
        suggestion: "Run comis init to create config",
        repairable: true,
      });
      return findings;
    }

    // Attempt to parse YAML
    let parsed: unknown;
    try {
      parsed = parseYaml(configContent);
    } catch {
      findings.push({
        category: CATEGORY,
        check: "Config file parseable",
        status: "fail",
        message: `Config file is corrupt: ${foundPath}`,
        suggestion: "Config is corrupt -- repair will restore from backup or defaults",
        repairable: true,
      });
      return findings;
    }

    // Handle empty or non-object config
    if (parsed === null || parsed === undefined) {
      parsed = {};
    }

    if (typeof parsed !== "object" || Array.isArray(parsed)) {
      findings.push({
        category: CATEGORY,
        check: "Config file parseable",
        status: "fail",
        message: "Config file does not contain a valid object",
        suggestion: "Config is corrupt -- repair will restore from backup or defaults",
        repairable: true,
      });
      return findings;
    }

    // Resolve ${VAR} references before validation (mirrors daemon startup)
    loadEnvFile(os.homedir() + "/.comis/.env");
    resolveEnvRefs(parsed as Record<string, unknown>);

    // Validate against schema
    const result = AppConfigSchema.safeParse(parsed);
    if (!result.success) {
      const issues = result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
      findings.push({
        category: CATEGORY,
        check: "Config schema validation",
        status: "warn",
        message: `Config validation issues: ${issues}`,
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
