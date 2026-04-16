/**
 * Config management commands.
 *
 * Provides `comis config validate|show|set|history|diff|rollback`
 * subcommands for local validation and remote config management via
 * the daemon JSON-RPC interface.
 *
 * @module
 */

import type { Command } from "commander";
import chalk from "chalk";
import { loadConfigFile, validateConfig, deepMerge } from "@comis/core";
import { withClient } from "../client/rpc-client.js";
import { success, error, info, warn, json } from "../output/format.js";
import { withSpinner } from "../output/spinner.js";
import { renderTable, renderKeyValue } from "../output/table.js";

/** Default config paths to check (matching daemon defaults). */
const DEFAULT_CONFIG_PATHS = ["/etc/comis/config.yaml", "/etc/comis/config.local.yaml"];

/**
 * Register the `config` subcommand group on the program.
 *
 * @param program - The root Commander program
 */
export function registerConfigCommand(program: Command): void {
  const config = program.command("config").description("Configuration management");

  // --- config validate -------------------------------------------------------

  config
    .command("validate")
    .description("Validate configuration files")
    .option("-c, --config <paths...>", "Config file paths to validate")
    .action(async (options: { config?: string[] }) => {
      const configPaths =
        options.config ??
        // eslint-disable-next-line no-restricted-syntax -- CLI bootstrap before SecretManager
        (process.env["COMIS_CONFIG_PATHS"]
          // eslint-disable-next-line no-restricted-syntax -- CLI bootstrap before SecretManager
          ? process.env["COMIS_CONFIG_PATHS"].split(":")
          : DEFAULT_CONFIG_PATHS);

      info(`Validating configuration from: ${configPaths.join(", ")}`);

      // Load and merge config files
      let merged: Record<string, unknown> = {};
      let anyFound = false;

      for (const filePath of configPaths) {
        const result = loadConfigFile(filePath);
        if (!result.ok) {
          if (result.error.code === "FILE_NOT_FOUND") {
            warn(`Config file not found (skipped): ${filePath}`);
            continue;
          }
          error(`Failed to load ${filePath}: ${result.error.message}`);
          process.exit(1);
        }
        anyFound = true;
        merged = deepMerge(merged, result.value);
        info(`Loaded: ${filePath}`);
      }

      if (!anyFound) {
        info("No config files found. Validating with defaults only.");
      }

      // Validate merged config
      const validation = validateConfig(merged);

      if (validation.ok) {
        success("Configuration is valid");
        return;
      }

      // Report Zod errors with path info
      error("Configuration validation failed:");

      const details = validation.error.details;
      if (Array.isArray(details)) {
        for (const issue of details) {
          const zodIssue = issue as { path?: (string | number)[]; message?: string; code?: string };
          const path = zodIssue.path?.join(".") || "(root)";
          const message = zodIssue.message ?? "Unknown error";
          error(`  ${path}: ${message}`);
        }
      } else {
        error(`  ${validation.error.message}`);
      }

      process.exit(1);
    });

  // --- config show [section] -------------------------------------------------

  config
    .command("show [section]")
    .description("Display current configuration")
    .option("--format <format>", "Output format (detail|json)", "detail")
    .action(async (section: string | undefined, options: { format: string }) => {
      try {
        const result = await withSpinner("Reading config...", () =>
          withClient(async (client) => {
            return await client.call("config.read", { section });
          }),
        );

        if (options.format === "json") {
          json(result);
          return;
        }

        if (section) {
          // Section detail: render key-value pairs for the section object
          const sectionData = result as Record<string, unknown>;
          const pairs: [string, string][] = Object.entries(sectionData).map(
            ([key, value]) => [chalk.bold(key), typeof value === "object" ? JSON.stringify(value) : String(value)],
          );
          renderKeyValue(pairs);
        } else {
          // Full config: render section list with key counts
          const fullResult = result as { config: Record<string, unknown>; sections: string[] };
          const rows = fullResult.sections.map((name) => {
            const sectionObj = fullResult.config[name];
            const keyCount =
              sectionObj && typeof sectionObj === "object"
                ? Object.keys(sectionObj).length
                : 0;
            return [name, String(keyCount)];
          });
          renderTable(["Section", "Keys"], rows);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        error(`Failed to read config: ${msg}`);
        process.exit(1);
      }
    });

  // --- config set <path> <value> ---------------------------------------------

  config
    .command("set <path> <value>")
    .description("Modify a config value via the daemon")
    .action(async (dotPath: string, rawValue: string) => {
      // Parse dot-path into section + key
      const segments = dotPath.split(".");
      if (segments.length < 2) {
        error("Path must include at least section.key (e.g., agent.budget.maxTokens)");
        process.exit(1);
      }

      const section = segments[0]!;
      const key = segments.slice(1).join(".");

      // Parse value: try JSON first (for numbers, booleans, objects), fall back to string
      let value: unknown;
      try {
        value = JSON.parse(rawValue);
      } catch {
        value = rawValue;
      }

      try {
        await withClient(async (client) => {
          return await client.call("config.patch", { section, key, value });
        });

        success(`Set ${dotPath} = ${JSON.stringify(value)}`);
        warn("Daemon is restarting to apply changes...");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        error(`Failed to set config: ${msg}`);
        process.exit(1);
      }
    });

  // --- config history [--limit N] --------------------------------------------

  config
    .command("history")
    .description("Display config change history")
    .option("--limit <n>", "Maximum entries to display", "10")
    .option("--format <format>", "Output format (table|json)", "table")
    .action(async (options: { limit: string; format: string }) => {
      try {
        const limit = parseInt(options.limit, 10);
        const result = await withSpinner("Fetching config history...", () =>
          withClient(async (client) => {
            return (await client.call("config.history", { limit })) as {
              entries: Array<{ sha: string; date: string; message: string; author?: string }>;
              error?: string;
            };
          }),
        );

        // Handle graceful degradation when git is unavailable
        if (result.entries.length === 0 && result.error) {
          warn(result.error);
          return;
        }

        if (result.entries.length === 0) {
          info("No config history found");
          return;
        }

        if (options.format === "json") {
          json(result.entries);
          return;
        }

        renderTable(
          ["SHA", "Date", "Message"],
          result.entries.map((entry) => [
            entry.sha.slice(0, 7),
            formatDate(entry.date),
            truncate(entry.message, 60),
          ]),
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        error(`Failed to fetch config history: ${msg}`);
        process.exit(1);
      }
    });

  // --- config diff [sha] -----------------------------------------------------

  config
    .command("diff [sha]")
    .description("Display config diff against HEAD or a specific commit")
    .action(async (sha: string | undefined) => {
      try {
        const result = await withSpinner("Computing diff...", () =>
          withClient(async (client) => {
            return (await client.call("config.diff", { sha })) as {
              diff: string;
              error?: string;
            };
          }),
        );

        if (result.error) {
          warn(result.error);
          return;
        }

        if (result.diff === "") {
          info("No config changes");
          return;
        }

        // Colorize diff output line by line
        for (const line of result.diff.split("\n")) {
          if (line.startsWith("+++") || line.startsWith("---")) {
            console.log(chalk.bold(line));
          } else if (line.startsWith("+")) {
            console.log(chalk.green(line));
          } else if (line.startsWith("-")) {
            console.log(chalk.red(line));
          } else if (line.startsWith("@@")) {
            console.log(chalk.cyan(line));
          } else {
            console.log(line);
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        error(`Failed to compute diff: ${msg}`);
        process.exit(1);
      }
    });

  // --- config rollback <sha> -------------------------------------------------

  config
    .command("rollback <sha>")
    .description("Restore config from a previous commit")
    .option("-y, --yes", "Skip confirmation prompt")
    .action(async (sha: string, options: { yes?: boolean }) => {
      // Confirmation prompt unless --yes
      if (!options.yes) {
        const readline = await import("node:readline");
        const rl = readline.createInterface({
          input: process.stdin,
          output: process.stdout,
        });

        const answer = await new Promise<string>((resolve) => {
          rl.question(
            chalk.yellow(`Rollback config to ${sha.slice(0, 7)}? This will restart the daemon. (y/N) `),
            (ans) => {
              rl.close();
              resolve(ans.trim().toLowerCase());
            },
          );
        });

        if (answer !== "y" && answer !== "yes") {
          info("Cancelled");
          return;
        }
      }

      try {
        await withClient(async (client) => {
          return await client.call("config.rollback", { sha });
        });

        success(`Config rolled back to ${sha.slice(0, 7)}`);
        warn("Daemon is restarting...");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        error(`Failed to rollback config: ${msg}`);
        process.exit(1);
      }
    });
}

/**
 * Truncate a string to a maximum length with ellipsis.
 */
function truncate(str: string, maxLength: number): string {
  const oneLine = str.replace(/\n/g, " ");
  if (oneLine.length <= maxLength) return oneLine;
  return oneLine.slice(0, maxLength - 3) + "...";
}

/**
 * Format an ISO date string for display.
 */
function formatDate(dateStr: string): string {
  try {
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return dateStr;
    return d.toLocaleString();
  } catch {
    return dateStr;
  }
}
