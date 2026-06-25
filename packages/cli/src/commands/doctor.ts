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
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import Database from "better-sqlite3";
import { success, error, info } from "../output/format.js";
import { withSpinner } from "../output/spinner.js";
import { runDoctorChecks } from "../doctor/check-runner.js";
import { renderDoctorTable, renderDoctorJson } from "../doctor/output.js";
import { configHealthCheck } from "../doctor/checks/config-health.js";
import { daemonHealthCheck } from "../doctor/checks/daemon-health.js";
import { gatewayHealthCheck } from "../doctor/checks/gateway-health.js";
import { channelHealthCheck } from "../doctor/checks/channel-health.js";
import { workspaceHealthCheck } from "../doctor/checks/workspace-health.js";
import { oauthHealthCheck } from "../doctor/checks/oauth-health.js";
import { lcdHealthCheck } from "../doctor/checks/lcd-health.js";
import { secretsAuditHealthCheck } from "../doctor/checks/secrets-audit-health.js";
import { versionSkewHealthCheck } from "../doctor/checks/version-skew-health.js";
import { repairConfig } from "../doctor/repairs/repair-config.js";
import { repairDaemon } from "../doctor/repairs/repair-daemon.js";
import { repairWorkspace } from "../doctor/repairs/repair-workspace.js";
import { repairConfigAudit } from "../doctor/repairs/repair-config-audit.js";
import { repairFtsDrift, repairContextItems } from "../doctor/repairs/repair-lcd.js";
import { resolveDoctorConfig } from "../doctor/config-resolve.js";
import type { DoctorContext } from "../doctor/types.js";

/**
 * This CLI's own version, read from `packages/cli/package.json` (mirrors how
 * `cli.ts` sets `program.version`). Threaded onto the DoctorContext so the
 * version-skew check compares it against the daemon's reported version without
 * re-reading the package at check time. `undefined` if the read fails (the
 * check then degrades to its own package.json fallback / a skip).
 */
function readCliVersion(): string | undefined {
  try {
    const req = createRequire(import.meta.url);
    const pkg = req("../../package.json") as { version?: string };
    return pkg.version;
  } catch {
    return undefined;
  }
}

/** All doctor checks in execution order (9 categories). */
const ALL_CHECKS = [
  configHealthCheck,
  daemonHealthCheck,
  gatewayHealthCheck,
  // Runs after gateway (needs the daemon reachable) — flags a CLI<->daemon
  // version skew that would otherwise make config checks report phantom
  // schema failures (stale global `comis` incident).
  versionSkewHealthCheck,
  channelHealthCheck,
  workspaceHealthCheck,
  oauthHealthCheck,
  secretsAuditHealthCheck,
  lcdHealthCheck,
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
 * Resolves the config ONCE via the shared store-aware path (env ->
 * ~/.comis/.env -> encrypted secret store, mirroring daemon boot) so every
 * check sees the same config the daemon would. The full resolution outcome
 * rides on the context: when the config is unavailable, checks must name
 * the real reason instead of claiming nothing is configured.
 */
function buildDoctorContext(configPaths: string[]): DoctorContext {
  const configResolution = resolveDoctorConfig(configPaths);
  const config = configResolution.config;

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
    configResolution,
    configPaths,
    dataDir,
    daemonPidFile,
    gatewayUrl,
    cliVersion: readCliVersion(),
  };
}

/**
 * Register the `doctor` command on the program.
 *
 * Provides:
 * - `comis doctor` -- run 8 health check categories (config, daemon, gateway,
 *   channel, workspace, OAuth, secrets-audit, LCD store)
 * - `comis doctor --repair` -- auto-fix repairable issues
 * - `comis doctor --refresh-test` -- opt-in refresh probe per profile.
 *   WARNING: rotates the refresh token at OpenAI.
 *
 * @param program - The root Commander program
 */
export function registerDoctorCommand(program: Command): void {
  program
    .command("doctor")
    .description(
      "Diagnose configuration, daemon, gateway, channel, workspace, and OAuth health",
    )
    .option("--repair", "Auto-fix repairable issues")
    .option("-c, --config <paths...>", "Config file paths to check")
    .option("--format <format>", 'Output format: "table" or "json"', "table")
    .option(
      "--refresh-test",
      "Run a real OAuth refresh against the provider per profile. " +
        "WARNING: rotates the refresh token at OpenAI; the stored token will " +
        "be stale after this check. Default: OFF (opt-in).",
    )
    .action(async (options: {
      repair?: boolean;
      config?: string[];
      format: string;
      refreshTest?: boolean;
    }) => {
      const configPaths = options.config ?? resolveDefaultConfigPaths();
      const context: DoctorContext = {
        ...buildDoctorContext(configPaths),
        refreshTest: options.refreshTest,
      };

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

        // Config-audit-log scrubber.
        // Opt-in only via --repair; safe to run even when no
        // findings flag the audit log because the scrubber is
        // idempotent (same output on a clean file).
        const auditScrubResult = await repairConfigAudit();
        if (auditScrubResult.ok) {
          for (const action of auditScrubResult.value) {
            success(`REPAIRED: ${action}`);
          }
        } else {
          // Daemon-down is the common non-error case; surface as info.
          info(`SKIPPED: Config-audit scrub: ${auditScrubResult.error.message}`);
        }

        // LCD store repairs: run when there are repairable lcd findings.
        // Opens memory.db in READ-WRITE mode with busy_timeout=5000 to surface
        // SQLITE_BUSY cleanly if the daemon is still running (operator must stop it first).
        const hasLcdRepairable = findings.some(
          (f) => f.category === "lcd" && f.repairable,
        );
        if (hasLcdRepairable) {
          const dbPath = context.dataDir + "/memory.db";
          if (existsSync(dbPath)) {
            let lcdDb: Database.Database | undefined;
            try {
              lcdDb = new Database(dbPath, { timeout: 5000 });
              lcdDb.pragma("busy_timeout = 5000");

              const ftsDriftResult = await repairFtsDrift(lcdDb);
              if (ftsDriftResult.ok) {
                for (const action of ftsDriftResult.value) {
                  success(`REPAIRED: ${action}`);
                }
              } else {
                error(`FAILED: LCD FTS repair: ${ftsDriftResult.error.message}`);
              }

              const contextItemsResult = await repairContextItems(lcdDb);
              if (contextItemsResult.ok) {
                for (const action of contextItemsResult.value) {
                  success(`REPAIRED: ${action}`);
                }
              } else {
                error(`FAILED: LCD context-items repair: ${contextItemsResult.error.message}`);
              }
            } catch (lcdErr) {
              const msg = lcdErr instanceof Error ? lcdErr.message : String(lcdErr);
              error(
                `FAILED: LCD repair could not open memory.db: ${msg}` +
                  " — ensure the daemon is stopped before running --repair",
              );
            } finally {
              lcdDb?.close();
            }
          } else {
            info("SKIPPED: LCD repair — memory.db not found");
          }
        }

        // Re-run diagnostics after repairs
        info("Re-running diagnostics...");
        const rerunContext: DoctorContext = {
          ...buildDoctorContext(configPaths),
          refreshTest: options.refreshTest,
        };
        const rerunResult = await withSpinner("Verifying repairs...", () =>
          runDoctorChecks(ALL_CHECKS, rerunContext),
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
