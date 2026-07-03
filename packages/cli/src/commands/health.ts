// SPDX-License-Identifier: Apache-2.0
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
import { existsSync, readFileSync } from "node:fs";
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
import {
  renderFindings,
  type NormalizedFinding,
} from "../util/render-findings.js";

/** All doctor checks in execution order (same as doctor command). */
const ALL_CHECKS = [
  configHealthCheck,
  daemonHealthCheck,
  gatewayHealthCheck,
  channelHealthCheck,
  workspaceHealthCheck,
];

/**
 * Resolve default config paths from COMIS_CONFIG_PATHS env var or standard locations.
 */
function resolveDefaultConfigPaths(): string[] {
  // eslint-disable-next-line no-restricted-syntax -- CLI bootstrap before SecretManager
  const envPaths = process.env["COMIS_CONFIG_PATHS"];
  if (envPaths) {
    return envPaths.split(":").filter((p) => p.length > 0);
  }
  const candidates = [
    os.homedir() + "/.comis/config.yaml",
    os.homedir() + "/.comis/config.local.yaml",
    "/etc/comis/config.yaml",
    "/etc/comis/config.local.yaml",
  ];
  return candidates.filter((p) => existsSync(p));
}

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

  // gw.host is a *bind* address; remap wildcards to loopback so the
  // connectivity probe targets a real address.
  let gatewayUrl: string | undefined;
  if (config?.gateway) {
    const gw = config.gateway;
    const bindHost = gw.host || "127.0.0.1";
    const host = bindHost === "0.0.0.0" ? "127.0.0.1" : bindHost === "::" ? "::1" : bindHost;
    const port = gw.port || 4766;
    const protocol = gw.tls ? "https" : "http";
    gatewayUrl = `${protocol}://${host}:${port}`;
  }

  return { config, configPaths, dataDir, daemonPidFile, gatewayUrl };
}

/**
 * Build a human-readable footer for the health summary line.
 *
 * Output contract:
 *   - "All checks passed" when no fail/warn findings exist
 *   - "{total} issue(s) found ({n} error(s), {n} warning(s))" otherwise
 */
function buildHealthFooter(failCount: number, warnCount: number): string {
  const total = failCount + warnCount;
  if (total === 0) {
    return chalk.green("All checks passed");
  }
  const parts: string[] = [];
  if (failCount > 0) parts.push(`${failCount} error${failCount !== 1 ? "s" : ""}`);
  if (warnCount > 0) parts.push(`${warnCount} warning${warnCount !== 1 ? "s" : ""}`);
  return `${total} issue${total !== 1 ? "s" : ""} found (${parts.join(", ")})`;
}

/**
 * Map filtered doctor findings to the unified NormalizedFinding shape consumed
 * by renderFindings. Preserves first-seen category ordering by category-stable
 * iteration of the input array (callers are responsible for upstream filtering).
 */
function mapHealthFindings(findings: readonly DoctorFinding[]): NormalizedFinding[] {
  return findings.map((f) => ({
    status: f.status,
    category: f.category,
    title: f.check,
    message: f.message,
    hint: f.suggestion,
  }));
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
        const configPaths = options.config ?? resolveDefaultConfigPaths();
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
          const findings = mapHealthFindings(filtered);
          // `comis health` emits ONLY the footer line — either "All checks
          // passed" (green) or "N issues found (X errors, Y warnings)" —
          // with NO leading "N checks, X fail, Y warn" preamble. Suppress
          // the preamble by passing total=0 and empty counts; the renderer's
          // `summaryParts()` then yields no entries and `emitSummary()` only
          // emits the footer. This also means the pre-vs-post-filter
          // `total`/`counts` mismatch is moot once no preamble renders.
          const summary = {
            total: 0,
            counts: {},
            footer: buildHealthFooter(result.failCount, result.warnCount),
          };
          renderFindings(
            { kind: "findings", findings, summary },
            { renderMode: "compact", groupBy: "category" },
          );
        }

        // Exit with code 1 if any fail-status findings exist (for CI usage)
        if (result.failCount > 0) {
          process.exit(1);
        }
      },
    );
}
