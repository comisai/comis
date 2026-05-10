// SPDX-License-Identifier: Apache-2.0
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
import * as fs from "node:fs";
import * as os from "node:os";
import chalk from "chalk";
import { isMap, isPair, isScalar, parseDocument } from "yaml";
import { loadConfigFile, validateConfig, deepMerge, loadEnvFile } from "@comis/core";
import { withClient } from "../client/rpc-client.js";
import { success, error, info, warn, json } from "../output/format.js";
import { withSpinner } from "../output/spinner.js";
import { renderTable, renderKeyValue } from "../output/table.js";
import {
  applyToDocument,
  atomicWriteFile,
  computeMutationPlan,
  discoverSkills,
  isDaemonRunning,
  readMcpServers,
  renderInspectHuman,
  renderInspectJson,
  writeBackup,
  type InspectPayload,
} from "../sync-tooling/index.js";

/** Default config paths to check (matching daemon defaults). */
const DEFAULT_CONFIG_PATHS = [
  os.homedir() + "/.comis/config.yaml",
  os.homedir() + "/.comis/config.local.yaml",
  "/etc/comis/config.yaml",
  "/etc/comis/config.local.yaml",
];

/**
 * Default config path for `sync-tooling` — single path, not the merged
 * 4-path list used by `validate`. Hardcoded to `~/.comis/config.yaml` so
 * the no-flag invocation is safe by construction (T-25-11 reconciliation
 * — operator-supplied `--config` is operator-trusted; the default is
 * not operator-derived and therefore not subject to traversal concerns).
 */
const SYNC_TOOLING_DEFAULT_CONFIG = os.homedir() + "/.comis/config.yaml";

/** Pattern matching `${VAR_NAME}` env var references. */
const ENV_REF_RE = /\$\{([A-Z_][A-Z0-9_]*)\}/g;

/**
 * Deep-walk an object and resolve `${VAR}` references using process.env.
 * Mutates in place for efficiency since the input is a transient merge result.
 */
function resolveEnvRefs(obj: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === "string" && value.includes("${")) {
      obj[key] = value.replace(ENV_REF_RE, (match, varName: string) => {
        // eslint-disable-next-line no-restricted-syntax -- CLI bootstrap before SecretManager
        return process.env[varName] ?? match;
      });
    } else if (value && typeof value === "object" && !Array.isArray(value)) {
      resolveEnvRefs(value as Record<string, unknown>);
    } else if (Array.isArray(value)) {
      for (const item of value) {
        if (item && typeof item === "object") {
          resolveEnvRefs(item as Record<string, unknown>);
        }
      }
    }
  }
}

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

      // Load .env so ${VAR} references resolve before validation
      loadEnvFile(os.homedir() + "/.comis/.env");
      resolveEnvRefs(merged);

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

  // --- config sync-tooling --------------------------------------------------
  // Phase 25 — operator UX for materializing the `tooling:` block from
  // discovered MCPs and skills. Three modes:
  //   1. inspect (default)   — print diff, exit 0, never touch the file
  //   2. --write             — backup + append-only mutation + atomic write
  //   3. --write --overwrite — backup + regenerate the entire managed block
  //
  // Wiring boundary: this callback is the orchestrator. All discovery,
  // AST mutation, fs I/O, and daemon probing live in
  // `packages/cli/src/sync-tooling/*` (Wave 1 + Wave 2). See
  // `.planning/phases/25-sync-tooling-cli/25-SPEC.md` for full requirements
  // and `25-CONTEXT.md` D-01..D-25 for locked decisions referenced inline.
  config
    .command("sync-tooling")
    .description("Discover MCPs/skills and sync the tooling: config block")
    .option("--write", "Apply changes to config.yaml (default: inspect-only)")
    .option("--overwrite", "Regenerate the entire tooling block (requires --write)")
    .option("--format <format>", "Inspect-mode output format (human|json)", "human")
    // T-25-11: --config is operator-supplied and operator-trusted. The default
    // is hardcoded so the no-flag invocation is safe by construction.
    .option("-c, --config <path>", "Config file path", SYNC_TOOLING_DEFAULT_CONFIG)
    .action(
      async (options: {
        write?: boolean;
        overwrite?: boolean;
        format?: string;
        config?: string;
      }) => {
        const configPath = options.config ?? SYNC_TOOLING_DEFAULT_CONFIG;
        const homeDir = os.homedir();
        const isWrite = options.write === true;
        const isOverwrite = options.overwrite === true;
        const fmt = options.format ?? "human";

        // D-03: --overwrite requires --write — usage error before any I/O.
        if (isOverwrite && !isWrite) {
          error("--overwrite requires --write");
          process.exit(1);
          return;
        }
        if (fmt !== "human" && fmt !== "json") {
          error(`--format must be 'human' or 'json' (got: ${fmt})`);
          process.exit(1);
          return;
        }

        // D-13/D-14: daemon-active guard fires for write paths only. Inspect
        // mode is read-only so the daemon's restart-required `tooling.*`
        // configuration is unaffected.
        if (isWrite) {
          const running = await isDaemonRunning();
          if (running) {
            error(
              "daemon is running — stop it before running sync-tooling --write (tooling.* is restart-required)",
            );
            process.exit(1);
            return;
          }
        }

        // Two views of the source file:
        //   (1) loadConfigFile → JS shape for discover.ts (validates structure,
        //       returns ok({}) on missing/empty file).
        //   (2) parseDocument  → AST for generate.ts (preserves comments and
        //       key order across mutations, REQ-7).
        const loaded = loadConfigFile(configPath);
        if (!loaded.ok) {
          // FILE_NOT_FOUND is recoverable — init-when-absent path. Anything
          // else (parse error, permission denied) → exit 3 per D-25.
          if (loaded.error.code !== "FILE_NOT_FOUND") {
            error(`Failed to load ${configPath}: ${loaded.error.message}`);
            process.exit(3);
            return;
          }
        }
        const configJs = loaded.ok ? loaded.value : {};

        let rawYaml: string;
        try {
          rawYaml = fs.readFileSync(configPath, "utf-8");
        } catch {
          // Init-when-absent: file does not exist on disk → start with empty
          // content; parseDocument tolerates an empty string.
          rawYaml = "";
        }

        let doc;
        try {
          doc = parseDocument(rawYaml);
          if (doc.errors.length > 0) {
            error(
              `Invalid YAML in ${configPath}: ${doc.errors.map((er) => er.message).join("; ")}`,
            );
            process.exit(3);
            return;
          }
        } catch (e) {
          error(`Failed to parse ${configPath}: ${String(e)}`);
          process.exit(3);
          return;
        }

        // Discovery — both helpers are pure (no Result wrapper; they silent-skip
        // malformed entries, see discover.ts JSDoc).
        const mcps = readMcpServers(configJs);
        const skills = discoverSkills(configJs, { homeDir });
        const artifacts = { mcps, skills };

        // RESEARCH Open Question 2: empty discovery → "nothing to sync".
        // Even in --write mode this is a no-op: no backup, no mutation,
        // exit 0. Operator-friendly for CI scripts.
        const nothingToDo = mcps.length === 0 && skills.length === 0;
        if (nothingToDo && !isOverwrite) {
          info("(nothing to sync — no MCPs or skills discovered)");
          process.exit(0);
          return;
        }

        // Compute the read-only mutation plan against the current AST.
        const plan = computeMutationPlan(doc, artifacts);

        // Build a "would-write" preview by cloning + applying without writing.
        // Re-parse from rawYaml so we don't mutate the doc we may write later.
        const previewDoc = parseDocument(rawYaml);
        if (previewDoc.errors.length === 0) {
          applyToDocument(previewDoc, artifacts, { overwrite: isOverwrite });
        }
        const wouldWrite = previewDoc.toString();

        const inspectPayload: InspectPayload = {
          discovered: artifacts,
          existing: {
            tooling: doc.hasIn(["tooling"]) ? "present" : "absent",
            mcpHintNames: readHintKeysForInspect(doc, [
              "tooling",
              "mcp",
              "capabilityHints",
            ]),
            skillHintNames: readHintKeysForInspect(doc, [
              "tooling",
              "skills",
              "capabilityHints",
            ]),
          },
          diff: {
            add: { mcps: plan.mcpAdds, skills: plan.skillAdds },
            remove: { mcps: plan.mcpRemoves, skills: plan.skillRemoves },
          },
          wouldWrite,
        };

        // Inspect mode (no --write): render and exit 0 — config.yaml untouched.
        if (!isWrite) {
          if (fmt === "json") {
            json(JSON.parse(renderInspectJson(inspectPayload)) as Record<string, unknown>);
          } else {
            // Use process.stdout.write so chalk-coded output renders without
            // the format.ts indentation prefix (which is for one-liners).
            process.stdout.write(renderInspectHuman(inspectPayload) + "\n");
          }
          process.exit(0);
          return;
        }

        // --write path: D-12 backup-fail-fast → D-11 atomic write → D-23/D-24
        // summary lines.
        const backup = writeBackup(configPath, homeDir);
        if (!backup.ok) {
          error(
            `Backup failed (${backup.error.code}): ${backup.error.path} — ${backup.error.cause}`,
          );
          process.exit(2);
          return;
        }

        const counts = applyToDocument(doc, artifacts, { overwrite: isOverwrite });
        const written = atomicWriteFile(configPath, doc.toString());
        if (!written.ok) {
          error(`Atomic write failed (${written.error.code}): ${written.error.cause}`);
          process.exit(2);
          return;
        }

        // D-23: terse one-line summary so operators see the backup path.
        const totalAdded = counts.mcpAdded + counts.skillAdded;
        const totalRemoved = counts.mcpRemoved + counts.skillRemoved;
        success(
          `tooling: +${totalAdded} hints, -${totalRemoved} hints (backup: ${backup.value.backupPath})`,
        );

        // D-24: extra warning for overwrite (destructive of operator intent).
        if (isOverwrite) {
          warn(
            `⚠ overwrote ${configPath} — entire tooling: block regenerated. Backup: ${backup.value.backupPath}`,
          );
        }

        process.exit(0);
      },
    );
}

/**
 * Read the keys of an existing `tooling.*.capabilityHints` map from a
 * yaml@2.8.4 Document. Returns an empty array if the path is absent or
 * the value at the path is not a YAMLMap. Local helper (avoids exposing
 * a mutation-AST utility from the sync-tooling barrel).
 */
function readHintKeysForInspect(
  doc: ReturnType<typeof parseDocument>,
  hintMapPath: string[],
): string[] {
  if (!doc.hasIn(hintMapPath)) return [];
  const node = doc.getIn(hintMapPath, true);
  if (!isMap(node)) return [];
  const keys: string[] = [];
  for (const p of node.items) {
    if (!isPair(p)) continue;
    const k = isScalar(p.key) ? p.key.value : p.key;
    if (typeof k === "string") keys.push(k);
  }
  return keys;
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
