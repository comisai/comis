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
import { existsSync } from "node:fs";
import Database from "better-sqlite3";
import { success, error, info } from "../output/format.js";
import { withSpinner } from "../output/spinner.js";
import { runDoctorChecks } from "../doctor/check-runner.js";
import { renderDoctorTable, renderDoctorJson } from "../doctor/output.js";
import { repairConfig } from "../doctor/repairs/repair-config.js";
import { repairDaemon } from "../doctor/repairs/repair-daemon.js";
import { repairWorkspace } from "../doctor/repairs/repair-workspace.js";
import { repairConfigAudit } from "../doctor/repairs/repair-config-audit.js";
import { repairFtsDrift, repairContextItems } from "../doctor/repairs/repair-lcd.js";
import {
  buildDiagnosticContext,
  DIAGNOSTIC_CHECKS,
  resolveDefaultDiagnosticConfigPaths,
} from "../doctor/diagnostic-suite.js";
import type { DoctorContext } from "../doctor/types.js";

/**
 * Register the `doctor` command on the program.
 *
 * Provides:
 * - `comis doctor` -- run 10 health check categories (config, daemon, gateway,
 *   version-skew, channel, Teams, workspace, OAuth, secrets-audit, LCD store)
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
      "Diagnose 10 subsystems: configuration, daemon, gateway, version-skew, channel, Teams, workspace, OAuth, secrets-audit, and LCD health",
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
      const configPaths = options.config ?? resolveDefaultDiagnosticConfigPaths();
      const context: DoctorContext = {
        ...buildDiagnosticContext(configPaths),
        refreshTest: options.refreshTest,
      };

      const result = await withSpinner("Running diagnostics...", () =>
        runDoctorChecks(DIAGNOSTIC_CHECKS, context),
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
          error("FAILED: Config repair could not complete; verify config-path permissions");
        }

        const daemonResult = await repairDaemon(findings, context.daemonPidFile);
        if (daemonResult.ok) {
          for (const action of daemonResult.value) {
            success(`REPAIRED: ${action}`);
          }
        } else {
          error("FAILED: Daemon repair could not complete; verify PID-file permissions");
        }

        const workspaceResult = await repairWorkspace(findings, context.dataDir);
        if (workspaceResult.ok) {
          for (const action of workspaceResult.value) {
            success(`REPAIRED: ${action}`);
          }
        } else {
          error("FAILED: Workspace repair could not complete; verify data-directory permissions");
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
          // An unavailable repair RPC is non-fatal to the remaining repairs.
          info("SKIPPED: Config-audit scrub could not complete through the daemon RPC");
        }

        // LCD store repairs: run when there are repairable lcd findings.
        // Opens memory.db in READ-WRITE mode with busy_timeout=5000 to surface
        // SQLITE_BUSY cleanly if the daemon is still running (operator must stop it first).
        const hasLcdRepairable = findings.some(
          (f) => f.category === "lcd" && f.repairable,
        );
        if (hasLcdRepairable) {
          const dbPath = context.memoryDbPath ?? context.dataDir + "/memory.db";
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
                error("FAILED: LCD FTS repair could not complete; stop the daemon and retry");
              }

              const contextItemsResult = await repairContextItems(lcdDb);
              if (contextItemsResult.ok) {
                for (const action of contextItemsResult.value) {
                  success(`REPAIRED: ${action}`);
                }
              } else {
                error(
                  "FAILED: LCD context-items repair could not complete; stop the daemon and retry",
                );
              }
            } catch {
              error(
                "FAILED: LCD repair could not open memory.db — ensure the daemon is stopped " +
                  "and the database path is readable before running --repair",
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
          ...buildDiagnosticContext(configPaths),
          refreshTest: options.refreshTest,
        };
        const rerunResult = await withSpinner("Verifying repairs...", () =>
          runDoctorChecks(DIAGNOSTIC_CHECKS, rerunContext),
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
