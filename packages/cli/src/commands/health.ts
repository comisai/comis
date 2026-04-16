/**
 * Health issues display CLI command.
 *
 * Provides `comis health` as a quick view of system problems (unlike
 * `doctor` which shows everything). By default shows only fail/warn findings,
 * grouped by category with suggested fixes. Exits with code 1 when failures
 * exist (CI-friendly).
 *
 * @module
 */

import type { Command } from "commander";
import * as os from "node:os";
import { readFileSync } from "node:fs";
import { loadConfigFile, validateConfig } from "@comis/core";
import type { AppConfig } from "@comis/core";
import chalk from "chalk";
import { json } from "../output/format.js";
import { withSpinner } from "../output/spinner.js";
import { runDoctorChecks } from "../doctor/check-runner.js";
import { configHealthCheck } from "../doctor/checks/config-health.js";
import { daemonHealthCheck } from "../doctor/checks/daemon-health.js";
import { gatewayHealthCheck } from "../doctor/checks/gateway-health.js";
import { channelHealthCheck } from "../doctor/checks/channel-health.js";
import { workspaceHealthCheck } from "../doctor/checks/workspace-health.js";
import type { DoctorContext, DoctorFinding } from "../doctor/types.js";

/** All doctor checks in execution order (same as doctor command). */
const ALL_CHECKS = [
  configHealthCheck,
  daemonHealthCheck,
  gatewayHealthCheck,
  channelHealthCheck,
  workspaceHealthCheck,
];

/**
 * Build a DoctorContext from CLI config paths.
 *
 * Loads config if paths provided, resolves data directory,
 * daemon PID file path, and gateway URL. Shared logic with
 * the doctor command.
 */
function buildHealthContext(configPaths: string[]): DoctorContext {
  let config: AppConfig | undefined;

  if (configPaths.length > 0) {
    for (const configPath of configPaths) {
      try {
        readFileSync(configPath, "utf-8");
        const loadResult = loadConfigFile(configPath);
        if (loadResult.ok) {
          const validateResult = validateConfig(loadResult.value);
          if (validateResult.ok) {
            config = validateResult.value;
            break;
          }
        }
      } catch {
        // Try next path
      }
    }
  }

  const dataDir = config?.dataDir || os.homedir() + "/.comis";
  const daemonPidFile = dataDir + "/daemon.pid";

  let gatewayUrl: string | undefined;
  if (config?.gateway) {
    const gw = config.gateway;
    const host = gw.host || "127.0.0.1";
    const port = gw.port || 3000;
    const protocol = gw.tls ? "https" : "http";
    gatewayUrl = `${protocol}://${host}:${port}`;
  }

  return { config, configPaths, dataDir, daemonPidFile, gatewayUrl };
}

/**
 * Group findings by category.
 *
 * Returns a Map of category name to findings array, preserving
 * insertion order (first-seen category order).
 */
function groupByCategory(findings: readonly DoctorFinding[]): Map<string, DoctorFinding[]> {
  const groups = new Map<string, DoctorFinding[]>();
  for (const finding of findings) {
    const existing = groups.get(finding.category);
    if (existing) {
      existing.push(finding);
    } else {
      groups.set(finding.category, [finding]);
    }
  }
  return groups;
}

/**
 * Render grouped health findings to stdout in table format.
 *
 * Each category is shown as a bold header, followed by findings with
 * colored status indicators. Suggestions are shown in gray below each issue.
 */
function renderHealthTable(
  grouped: Map<string, DoctorFinding[]>,
  failCount: number,
  warnCount: number,
): void {
  for (const [category, findings] of grouped) {
    console.log();
    console.log(chalk.bold(category));

    for (const finding of findings) {
      const icon = finding.status === "fail" ? chalk.red("x") : chalk.yellow("!");
      const msg = finding.status === "fail" ? chalk.red(finding.message) : chalk.yellow(finding.message);
      console.log(`  ${icon} ${msg}`);

      if (finding.suggestion) {
        console.log(`    ${chalk.gray(finding.suggestion)}`);
      }
    }
  }

  console.log();

  const total = failCount + warnCount;
  if (total === 0) {
    console.log(chalk.green("All checks passed"));
  } else {
    const parts: string[] = [];
    if (failCount > 0) parts.push(`${failCount} error${failCount !== 1 ? "s" : ""}`);
    if (warnCount > 0) parts.push(`${warnCount} warning${warnCount !== 1 ? "s" : ""}`);
    console.log(`${total} issue${total !== 1 ? "s" : ""} found (${parts.join(", ")})`);
  }
}

/**
 * Register the `health` command on the program.
 *
 * Provides `comis health` for quick system health issue display.
 * Shows only fail/warn findings by default, with `--all` to include passes.
 *
 * @param program - The root Commander program
 */
export function registerHealthCommand(program: Command): void {
  program
    .command("health")
    .description("Show system health issues")
    .option("-c, --config <paths...>", "Config file paths")
    .option("--format <format>", 'Output format: "table" or "json"', "table")
    .option("--all", "Show all findings including passing checks", false)
    .action(
      async (options: { config?: string[]; format: string; all: boolean }) => {
        const configPaths = options.config ?? [];
        const context = buildHealthContext(configPaths);

        const result = await withSpinner("Checking health...", () =>
          runDoctorChecks(ALL_CHECKS, context),
        );

        // Filter findings: by default only fail/warn
        const filtered = options.all
          ? result.findings
          : result.findings.filter((f) => f.status === "fail" || f.status === "warn");

        if (options.format === "json") {
          json(filtered);
        } else {
          const grouped = groupByCategory(filtered);
          renderHealthTable(grouped, result.failCount, result.warnCount);
        }

        // Exit with code 1 if any fail-status findings exist (for CI usage)
        if (result.failCount > 0) {
          process.exit(1);
        }
      },
    );
}
