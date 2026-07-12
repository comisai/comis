// SPDX-License-Identifier: Apache-2.0
/**
 * Security audit and fix CLI commands.
 *
 * Provides `comis security audit` for running security checks
 * with configurable output format and severity filtering, and
 * `comis security fix` for auto-remediating findings with
 * dry-run preview by default and `--yes` for immediate application.
 *
 * @module
 */

import type { Command } from "commander";
import { readFileSync } from "node:fs";
import * as os from "node:os";
import { loadConfigFile, validateConfig } from "@comis/core";
import type { AppConfig } from "@comis/core";
import chalk from "chalk";
import { info, json } from "../output/format.js";
import { withSpinner } from "../output/spinner.js";
import { runSecurityAudit } from "../security/check-runner.js";
import { renderAuditTable, renderAuditJson } from "../security/output.js";
import { configValidationCheck } from "../security/checks/config-validation.js";
import { filePermissionsCheck } from "../security/checks/file-permissions.js";
import { secretsExposureCheck } from "../security/checks/secrets-exposure.js";
import { gatewayExposureCheck } from "../security/checks/gateway-exposure.js";
import { channelSecurityCheck } from "../security/checks/channel-security.js";
import { stateProtectionCheck } from "../security/checks/state-protection.js";
import { modelHygieneCheck } from "../security/checks/model-hygiene.js";
import { skillsCodeCheck } from "../security/checks/skills-code.js";
import { hooksHardeningCheck } from "../security/checks/hooks-hardening.js";
import { ssrfSurfaceCheck } from "../security/checks/ssrf-surface.js";
import { auditLoggingCheck } from "../security/checks/audit-logging.js";
import { actionConfirmationCheck } from "../security/checks/action-confirmation.js";
import { webhookSecurityCheck } from "../security/checks/webhook-security.js";
import { browserExposureCheck } from "../security/checks/browser-exposure.js";
import type { AuditContext, Severity, AuditResult } from "../security/types.js";
import { runSecurityFix } from "../security/fix-runner.js";
import { runAuditLog, type AuditLogOptions } from "./security-audit-log.js";

/** All security checks in execution order (14 total). */
const ALL_CHECKS = [
  configValidationCheck,
  filePermissionsCheck,
  secretsExposureCheck,
  gatewayExposureCheck,
  modelHygieneCheck,
  skillsCodeCheck,
  hooksHardeningCheck,
  channelSecurityCheck,
  stateProtectionCheck,
  ssrfSurfaceCheck,
  auditLoggingCheck,
  actionConfirmationCheck,
  webhookSecurityCheck,
  browserExposureCheck,
];

/** Numeric severity levels for filtering. */
const SEVERITY_LEVELS: Record<Severity, number> = {
  critical: 0,
  warning: 1,
  info: 2,
};

/**
 * Build an AuditContext from CLI options.
 *
 * Loads config if paths provided, reads raw content,
 * resolves data directory and skills paths.
 */
function buildAuditContext(configPaths: string[]): AuditContext {
  let config: AppConfig | undefined;
  let rawConfigContent: string | undefined;
  let configError: string | undefined;

  if (configPaths.length > 0) {
    // Read raw content of first config file for secrets scanning
    try {
      rawConfigContent = readFileSync(configPaths[0], "utf-8");
    } catch (err) {
      // File not readable -- leave raw content undefined
      configError = `could not read config file: ${err instanceof Error ? err.message : String(err)}`;
    }

    // Attempt to load and validate config. Capture WHY it failed so the
    // config-validation check can report the real reason instead of guessing,
    // and so a failed load never silently drops every config-scoped check.
    const loadResult = loadConfigFile(configPaths[0]);
    if (loadResult.ok) {
      const validateResult = validateConfig(loadResult.value);
      if (validateResult.ok) {
        config = validateResult.value;
      } else {
        configError = validateResult.error.message;
      }
    } else if (configError === undefined) {
      configError = loadResult.error.message;
    }
  }

  // Resolve dataDir from config or default
  const dataDir = config?.dataDir || os.homedir() + "/.comis";

  // Resolve skillsPaths from config agents or default
  const skillsPaths: string[] = [];
  if (config?.agents) {
    for (const agent of Object.values(config.agents)) {
      if (agent.skills?.discoveryPaths) {
        skillsPaths.push(...agent.skills.discoveryPaths);
      }
    }
  }

  return {
    config,
    rawConfigContent,
    configPaths,
    dataDir,
    skillsPaths,
    configError,
  };
}

/**
 * Register the `security` command group on the program.
 *
 * Provides:
 * - `comis security audit` -- run security checks
 * - `comis security fix` -- auto-remediate findings (dry-run by default)
 * - `comis security audit-log` -- query the durable security-decision audit log
 *
 * @param program - The root Commander program
 */
export function registerSecurityCommand(program: Command): void {
  const security = program.command("security").description("Security audit and remediation tools");

  // security audit
  security
    .command("audit")
    .description("Run security audit checks")
    .option("-c, --config <paths...>", "Config file paths to audit")
    .option("--format <format>", 'Output format: "table" or "json"', "table")
    .option("--severity <level>", 'Minimum severity to show: "info", "warning", or "critical"', "info")
    .action(async (options: { config?: string[]; format: string; severity: string }) => {
      const configPaths = options.config ?? [];
      const context = buildAuditContext(configPaths);

      const result = await withSpinner("Running security audit (14 checks)...", () =>
        runSecurityAudit(ALL_CHECKS, context),
      );

      // Filter findings by severity threshold
      const severityThreshold = SEVERITY_LEVELS[options.severity as Severity] ?? SEVERITY_LEVELS.info;
      const filteredFindings = result.findings.filter(
        (f) => SEVERITY_LEVELS[f.severity] <= severityThreshold,
      );

      const filteredResult: AuditResult = {
        ...result,
        findings: filteredFindings,
        criticalCount: filteredFindings.filter((f) => f.severity === "critical").length,
        warningCount: filteredFindings.filter((f) => f.severity === "warning").length,
        infoCount: filteredFindings.filter((f) => f.severity === "info").length,
      };

      if (options.format === "json") {
        renderAuditJson(filteredResult);
      } else {
        renderAuditTable(filteredResult);
      }

      // Exit with code 1 if any critical findings (use original result, not filtered)
      if (result.criticalCount > 0) {
        process.exit(1);
      }
    });

  // security fix
  security
    .command("fix")
    .description("Auto-remediate security findings (dry-run by default)")
    .option("--yes", "Apply fixes without confirmation")
    .option("-c, --config <paths...>", "Config file paths")
    .option("--format <format>", 'Output format: "table" or "json"', "table")
    .action(
      async (options: { yes?: boolean; config?: string[]; format: string }) => {
        const configPaths = options.config ?? [];
        const context = buildAuditContext(configPaths);

        // Step 1: Run the full audit
        const auditResult = await withSpinner(
          "Running security audit (14 checks)...",
          () => runSecurityAudit(ALL_CHECKS, context),
        );

        // Count findings that have an available auto-fix (permissions, state files, secrets, config, gateway tokens)
        const remediableCount = auditResult.findings.filter((f) => {
          const c = f.code;
          return (
            c.startsWith("SEC-PERM-") ||
            c === "SEC-STATE-002" ||
            c === "SEC-STATE-003" ||
            c.startsWith("SEC-SECRET") ||
            c === "SEC-CFG-001" ||
            c === "SEC-GW-003"
          );
        }).length;

        info(
          `Found ${auditResult.findings.length} findings (${remediableCount} remediable)`,
        );

        // Step 2: Run fixes
        const applyMode = options.yes ?? false;
        const fixResult = await runSecurityFix(auditResult, configPaths, {
          apply: applyMode,
        });

        // Step 3: Output results
        if (options.format === "json") {
          // JSON output: serialize FixResult (actions as code/description objects)
          const jsonResult = {
            applied: fixResult.applied.map((a) => ({
              code: a.code,
              description: a.description,
            })),
            skipped: fixResult.skipped.map((a) => ({
              code: a.code,
              description: a.description,
              preview: a.preview(),
            })),
            failed: fixResult.failed.map((f) => ({
              code: f.action.code,
              description: f.action.description,
              error: f.error.message,
            })),
            backupPath: fixResult.backupPath,
          };
          json(jsonResult);
        } else if (!applyMode) {
          // Dry-run: show previews
          if (fixResult.skipped.length === 0) {
            info("No remediable findings found.");
          } else {
            for (const action of fixResult.skipped) {
              console.log(
                chalk.yellow("  DRY-RUN:") + ` [${action.code}] ${action.preview()}`,
              );
            }
            console.log();
            info("Run with --yes to apply fixes");
          }
        } else {
          // Apply mode: show results
          for (const action of fixResult.applied) {
            console.log(
              chalk.green("  FIXED:") + ` [${action.code}] ${action.description}`,
            );
          }
          for (const { action, error: fixError } of fixResult.failed) {
            console.log(
              chalk.red("  FAILED:") +
                ` [${action.code}] ${action.description} -- ${fixError.message}`,
            );
          }
          for (const action of fixResult.skipped) {
            console.log(
              chalk.yellow("  SKIPPED:") + ` [${action.code}] ${action.description}`,
            );
          }

          if (fixResult.backupPath) {
            console.log();
            info(`Config backed up to: ${fixResult.backupPath}`);
          }
        }

        // Exit code: 0 if dry-run or all actions succeeded, 1 if any failed
        if (applyMode && fixResult.failed.length > 0) {
          process.exit(1);
        }
      },
    );

  // security audit-log — the durable security-decision audit query.
  // DISTINCT from `security audit` (the local check-runner): this is a REMOTE
  // admin RPC (obs.audit.query) reading the persisted obs_audit_events. The
  // handler lives in the flat `security-audit-log.ts` (the explain.ts/fleet.ts
  // mold); ONLY callTyped is used there (the cli-uses-typed-rpc invariant).
  security
    .command("audit-log")
    .description("Query the durable security-decision audit log (secret access, injection detection, command blocks)")
    .option("--kind <kind>", "Filter by event family (e.g. secret_access, injection_detected)")
    .option("--classification <class>", "Filter by risk class: read | mutate | destructive")
    .option("--agent <id>", "Filter by agent id")
    .option("--tenant <tenant>", 'Filter by tenant scope ("" matches system-scoped events)')
    .option("--outcome <outcome>", "Filter by outcome: success | failure | denied")
    .option("--since <ms>", "Lower time bound (inclusive epoch ms)")
    .option("--until <ms>", "Upper time bound (inclusive epoch ms)")
    .option("--limit <n>", "Max rows (default 200, clamped to 1000)")
    .option("--format <format>", "Output format: table | json", "table")
    .action((options: AuditLogOptions) => runAuditLog(options));
}
