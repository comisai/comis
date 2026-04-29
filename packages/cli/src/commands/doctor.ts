// SPDX-License-Identifier: Apache-2.0
/**
 * Doctor diagnostic CLI command.
 *
 * Provides `comis doctor` for running health checks across config,
 * daemon, gateway, channel, and workspace subsystems. Supports
 * `--repair` mode for auto-fixing repairable issues.
 *
 * @module
 */

import type { Command } from "commander";
import * as os from "node:os";
import { existsSync, readFileSync } from "node:fs";
import { loadConfigFile, validateConfig } from "@comis/core";
import type { AppConfig } from "@comis/core";
import { success, error, info } from "../output/format.js";
import { withSpinner } from "../output/spinner.js";
import { runDoctorChecks } from "../doctor/check-runner.js";
import { renderDoctorTable, renderDoctorJson } from "../doctor/output.js";
import { configHealthCheck } from "../doctor/checks/config-health.js";
import { daemonHealthCheck } from "../doctor/checks/daemon-health.js";
import { gatewayHealthCheck } from "../doctor/checks/gateway-health.js";
import { channelHealthCheck } from "../doctor/checks/channel-health.js";
import { workspaceHealthCheck } from "../doctor/checks/workspace-health.js";
import { repairConfig } from "../doctor/repairs/repair-config.js";
import { repairDaemon } from "../doctor/repairs/repair-daemon.js";
import { repairWorkspace } from "../doctor/repairs/repair-workspace.js";
import type { DoctorContext } from "../doctor/types.js";

/** All doctor checks in execution order (5 categories). */
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
 * Build a DoctorContext from CLI options.
 *
 * Loads config if paths provided, resolves data directory,
 * daemon PID file path, and gateway URL.
 */
function buildDoctorContext(configPaths: string[]): DoctorContext {
  let config: AppConfig | undefined;

  if (configPaths.length > 0) {
    for (const configPath of configPaths) {
      try {
        readFileSync(configPath, "utf-8"); // verify readable
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

  // Resolve gateway URL from config. gw.host is a *bind* address; remap
  // wildcards to loopback so the connectivity probe targets a real address.
  let gatewayUrl: string | undefined;
  if (config?.gateway) {
    const gw = config.gateway;
    const bindHost = gw.host || "127.0.0.1";
    const host = bindHost === "0.0.0.0" ? "127.0.0.1" : bindHost === "::" ? "::1" : bindHost;
    const port = gw.port || 4766;
    const protocol = gw.tls ? "https" : "http";
    gatewayUrl = `${protocol}://${host}:${port}`;
  }

  return {
    config,
    configPaths,
    dataDir,
    daemonPidFile,
    gatewayUrl,
  };
}

/**
 * Register the `doctor` command on the program.
 *
 * Provides:
 * - `comis doctor` -- run 5 health check categories
 * - `comis doctor --repair` -- auto-fix repairable issues
 *
 * @param program - The root Commander program
 */
export function registerDoctorCommand(program: Command): void {
  program
    .command("doctor")
    .description("Diagnose configuration, daemon, gateway, channel, and workspace health")
    .option("--repair", "Auto-fix repairable issues")
    .option("-c, --config <paths...>", "Config file paths to check")
    .option("--format <format>", 'Output format: "table" or "json"', "table")
    .action(async (options: { repair?: boolean; config?: string[]; format: string }) => {
      const configPaths = options.config ?? resolveDefaultConfigPaths();
      const context = buildDoctorContext(configPaths);

      const result = await withSpinner("Running diagnostics...", () =>
        runDoctorChecks(ALL_CHECKS, context),
      );

      // Render results
      if (options.format === "json") {
        renderDoctorJson(result);
      } else {
        renderDoctorTable(result);
      }

      // Handle repair mode
      if (options.repair && result.repairableCount > 0) {
        info("Attempting repairs...");

        const findings = [...result.findings];

        // Run each repair module
        const configResult = await repairConfig(findings, context.configPaths);
        if (configResult.ok) {
          for (const action of configResult.value) {
            success(`REPAIRED: ${action}`);
          }
        } else {
          error(`FAILED: Config repair: ${configResult.error.message}`);
        }

        const daemonResult = await repairDaemon(findings, context.daemonPidFile);
        if (daemonResult.ok) {
          for (const action of daemonResult.value) {
            success(`REPAIRED: ${action}`);
          }
        } else {
          error(`FAILED: Daemon repair: ${daemonResult.error.message}`);
        }

        const workspaceResult = await repairWorkspace(findings, context.dataDir);
        if (workspaceResult.ok) {
          for (const action of workspaceResult.value) {
            success(`REPAIRED: ${action}`);
          }
        } else {
          error(`FAILED: Workspace repair: ${workspaceResult.error.message}`);
        }

        // Re-run diagnostics after repairs
        info("Re-running diagnostics...");
        const rerunResult = await withSpinner("Verifying repairs...", () =>
          runDoctorChecks(ALL_CHECKS, buildDoctorContext(configPaths)),
        );

        if (options.format === "json") {
          renderDoctorJson(rerunResult);
        } else {
          renderDoctorTable(rerunResult);
        }

        // Exit code based on post-repair results
        if (rerunResult.failCount > 0) {
          process.exit(1);
        }
      } else if (options.repair && result.repairableCount === 0) {
        info("No repairable issues found");
      } else if (result.failCount > 0) {
        // No repair mode, but failures found
        process.exit(1);
      }
    });
}
