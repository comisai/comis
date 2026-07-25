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
import { parseDocument } from "yaml";
import {
  loadConfigFile,
  parseConfigPaths,
  systemGetEnv,
  validateConfig,
  deepMerge,
  loadEnvFile,
  ConfigReadContract,
  ConfigPatchContract,
  ConfigHistoryContract,
  ConfigDiffContract,
  ConfigRollbackContract,
} from "@comis/core";
import { callTyped, withClient } from "../client/rpc-client.js";
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
  pruneOldBackups,
  type InspectPayload,
} from "../sync-tooling/index.js";
import {
  registerConfigAuditCommand,
  buildCliSyncToolingAuditBase,
  appendCliSyncToolingAudit,
} from "./config/audit.js";
import {
  runToolingFill,
  type PromptIO,
} from "../tooling-fill/index.js";
import {
  formatDate,
  readHintKeysForInspect,
  resolveEnvRefs,
  truncate,
} from "./config-parsers.js";
import { confirm } from "../util/confirm.js";

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
 * the no-flag invocation is safe by construction — operator-supplied
 * `--config` is operator-trusted; the default is not operator-derived
 * and therefore not subject to traversal concerns.
 */
const SYNC_TOOLING_DEFAULT_CONFIG = os.homedir() + "/.comis/config.yaml";

/**
 * Register the `config` subcommand group on the program.
 *
 * @param program - The root Commander program
 */
export function registerConfigCommand(program: Command): void {
  const config = program.command("config").description("Configuration management");

  // `comis config audit show|scrub` subcommand group.
  registerConfigAuditCommand(config);

  // --- config validate -------------------------------------------------------

  config
    .command("validate")
    .description("Validate configuration files")
    .option("-c, --config <paths...>", "Config file paths to validate")
    .action(async (options: { config?: string[] }) => {
      const configuredPaths = parseConfigPaths(systemGetEnv("COMIS_CONFIG_PATHS"));
      const configPaths =
        options.config ?? (configuredPaths.length > 0 ? configuredPaths : DEFAULT_CONFIG_PATHS);

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
            return await callTyped(client, ConfigReadContract, section ? { section } : {});
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
          // ConfigPatchContract.request.value accepts the wire-observable
          // primitive | record | array-of-record union (loose record).
          // The `value` here is JSON-parsed from the CLI arg (or raw string
          // fallback) — already in the allowed shape. callTyped's contract
          // input type widens to z.input, which for the union is
          // `string | number | boolean | Record<string, unknown> | Array<Record<string, unknown>>`
          // — cast through unknown to satisfy TS narrowing.
          return await callTyped(client, ConfigPatchContract, {
            section,
            key,
            value: value as string,
          });
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
            return await callTyped(client, ConfigHistoryContract, { limit });
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
            formatDate(entry.timestamp),
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
            return await callTyped(client, ConfigDiffContract, sha ? { sha } : {});
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
        if (
          !(await confirm({
            message: `Rollback config to ${sha.slice(0, 7)}? This will restart the daemon.`,
          }))
        ) {
          info("Cancelled");
          return;
        }
      }

      try {
        await withClient(async (client) => {
          return await callTyped(client, ConfigRollbackContract, { sha });
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
  // Operator UX for materializing the `tooling:` block from discovered MCPs
  // and skills. Three modes:
  //   1. inspect (default)   — print diff, exit 0, never touch the file
  //   2. --write             — backup + append-only mutation + atomic write
  //   3. --write --overwrite — backup + regenerate the entire managed block
  //
  // Wiring boundary: this callback is the orchestrator. All discovery,
  // AST mutation, fs I/O, and daemon probing live in
  // `packages/cli/src/sync-tooling/`.
  config
    .command("sync-tooling")
    .description("Discover MCPs/skills and sync the tooling: config block")
    .option("--write", "Apply changes to config.yaml (default: inspect-only)")
    .option("--overwrite", "Regenerate the entire tooling block (requires --write)")
    .option("--format <format>", "Inspect-mode output format (human|json)", "human")
    // --config is operator-supplied and operator-trusted. The default is
    // hardcoded so the no-flag invocation is safe by construction.
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

        // --overwrite requires --write — usage error before any I/O.
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

        // Daemon-active guard fires for write paths only. Inspect mode is
        // read-only so the daemon's restart-required `tooling.*`
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
        //       key order across mutations).
        const loaded = loadConfigFile(configPath);
        if (!loaded.ok) {
          // FILE_NOT_FOUND is recoverable — init-when-absent path. Anything
          // else (parse error, permission denied) → exit 3.
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

        // Compute the read-only mutation plan against the current AST.
        const plan = computeMutationPlan(doc, artifacts);

        // "Nothing to sync" cases (write-path only — inspect mode always renders):
        //  (a) Fresh config — operator has installed no MCPs/skills AND no tooling
        //      block exists yet. Writing an empty skeleton would be churn.
        //  (b) Plan is a no-op against an existing tooling block (no adds, no
        //      removes, no skeleton needed).
        // When discovery is empty BUT a tooling block exists with stale hints,
        // the plan will report removes — that path must NOT short-circuit.
        const isFreshAndEmpty =
          mcps.length === 0 && skills.length === 0 && plan.needsSkeleton;
        const planIsNoop =
          plan.mcpAdds.length === 0 &&
          plan.mcpRemoves.length === 0 &&
          plan.skillAdds.length === 0 &&
          plan.skillRemoves.length === 0 &&
          !plan.needsSkeleton;
        const nothingToDo = isFreshAndEmpty || planIsNoop;
        if (nothingToDo && isWrite && !isOverwrite) {
          info(
            isFreshAndEmpty
              ? "(nothing to sync — no MCPs or skills discovered)"
              : "(nothing to sync — config is already in sync)",
          );
          process.exit(0);
          return;
        }

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

        // --write path: backup-fail-fast → atomic write → summary lines.
        const backup = writeBackup(configPath, homeDir);
        if (!backup.ok) {
          error(
            `Backup failed (${backup.error.code}): ${backup.error.path} — ${backup.error.cause}`,
          );
          process.exit(2);
          return;
        }

        const counts = applyToDocument(doc, artifacts, { overwrite: isOverwrite });

        // Two-phase audit around the single atomicWriteFile call site
        // (only write site in this file). Best-effort.
        // Honor diagnostics.configAudit.enabled — when explicitly false,
        // skip both buildCliSyncToolingAuditBase (build) and
        // appendCliSyncToolingAudit (append). Default-true semantics via
        // the `!== false` check: omitted or true continues to emit the
        // audit line; only an explicit false silences it.
        // configJs was loaded above at line 464 (Record<string, unknown> shape)
        // and is `{}` in the init-when-absent recovery path, which evaluates
        // to true via the optional-chain returning undefined !== false.
        const configJsAudit = configJs as {
          diagnostics?: { configAudit?: { enabled?: boolean } };
        };
        const cliAuditEnabled =
          configJsAudit?.diagnostics?.configAudit?.enabled !== false;
        const auditBase = cliAuditEnabled
          ? buildCliSyncToolingAuditBase(configPath)
          : undefined;
        const written = atomicWriteFile(configPath, doc.toString());
        if (auditBase !== undefined) {
          appendCliSyncToolingAudit(auditBase, written);
        }

        if (!written.ok) {
          error(`Atomic write failed (${written.error.code}): ${written.error.cause}`);
          process.exit(2);
          return;
        }

        // Terse one-line summary so operators see the backup path.
        const totalAdded = counts.mcpAdded + counts.skillAdded;
        const totalRemoved = counts.mcpRemoved + counts.skillRemoved;
        success(
          `tooling: +${totalAdded} hints, -${totalRemoved} hints (backup: ${backup.value.backupPath})`,
        );

        // Extra warning for overwrite (destructive of operator intent).
        if (isOverwrite) {
          warn(
            `⚠ overwrote ${configPath} — entire tooling: block regenerated. Backup: ${backup.value.backupPath}`,
          );
        }

        // Housekeeping: keep the 5 most recent sync-tooling backups under
        // ~/.comis/, drop older. Best-effort — backup pruning is never
        // load-bearing, and the freshly-written backup counts toward the
        // keep set.
        const pruneRes = pruneOldBackups(homeDir, "sync-tooling", 5);
        if (pruneRes.deleted > 0) {
          info(`(pruned ${pruneRes.deleted} older sync-tooling backup(s))`);
        }

        process.exit(0);
      },
    );

  // --- config tooling-fill --------------------------------------------------
  // Operator UX for materializing the description + replacesPackages fields
  // on tooling capability hints via the live Comis daemon. The orchestrator
  // owns the full state machine; this callback is the composition root — it
  // builds the OrchestratorOpts bag, instantiates the confirm-helper-backed
  // PromptIO, and routes the result's exitCode into process.exit.
  //
  // Wiring boundary: ALL discovery, AST mutation, fs I/O, daemon probing,
  // supervisor calls, and LLM round-trips live in
  // `packages/cli/src/tooling-fill/`.
  config
    .command("tooling-fill [hint-name]")
    .description(
      "Fill description + replacesPackages on a tooling capability hint via the live agent",
    )
    .option("--all", "Fill every stub-valued hint")
    .option("--force", "Overwrite operator-filled hints")
    .option(
      "--dry-run",
      "Print agent suggestion + diff; never stop daemon, never write file",
    )
    .option("--yes", "Skip values-confirmation prompt")
    .option("--restart", "Authorize daemon-stop+start window")
    .option("--allow-restart", "Alias for --restart")
    .option("--no-restart", "Write file but skip daemon stop+start")
    .option(
      "--restart-cmd <cmd>",
      "Override supervisor with full stop+start command",
    )
    .option(
      "--force-no-validate",
      "Skip package-name shape validation (escape hatch — loud warning)",
    )
    .option(
      "-c, --config <path>",
      "Config file path",
      SYNC_TOOLING_DEFAULT_CONFIG,
    )
    .option(
      "--agent <id>",
      "Agent ID for the LLM call (default: daemon's first agent)",
    )
    .option(
      "--kind <kind>",
      "Disambiguate hint kind: mcp or skills (when both maps contain the same key)",
    )
    .action(
      async (
        hintName: string | undefined,
        options: {
          all?: boolean;
          force?: boolean;
          dryRun?: boolean;
          yes?: boolean;
          restart?: boolean;
          allowRestart?: boolean;
          restartCmd?: string;
          forceNoValidate?: boolean;
          config?: string;
          agent?: string;
          kind?: string;
        },
      ) => {
        // PromptIO thin facade: each confirm is a one-shot p.confirm via
        // the central helper. No shared rl — p.confirm allocates its own
        // interactive session per call. The PromptIO interface shape is
        // preserved so runToolingFill({prompts}) is unchanged.
        const prompts: PromptIO = {
          confirmValues: async (diff: string): Promise<boolean> => {
            process.stdout.write(diff + "\n");
            return await confirm({ message: "Apply these values?" });
          },
          confirmRestart: async (s): Promise<boolean> => {
            return await confirm({
              message: `Stop and restart daemon (${s.kind})?`,
            });
          },
        };

        // --restart vs --no-restart vs unset — Commander convention:
        //   --restart       → options.restart === true
        //   --no-restart    → options.restart === false
        //   neither         → options.restart === undefined
        // --allow-restart is an alias: if either is set, treat as true.
        // Explicit --no-restart + --allow-restart is a contradiction;
        // refuse rather than silently letting the alias win.
        if (options.allowRestart === true && options.restart === false) {
          error("--allow-restart and --no-restart are mutually exclusive");
          process.exit(1);
          return;
        }
        const restartFlag: boolean | undefined =
          options.allowRestart === true
            ? true
            : options.restart === undefined
              ? undefined
              : options.restart;

        const result = await runToolingFill({
          hintName,
          all: options.all === true,
          force: options.force === true,
          forceNoValidate: options.forceNoValidate === true,
          dryRun: options.dryRun === true,
          yes: options.yes === true,
          restart: restartFlag,
          restartCmd: options.restartCmd,
          configPath: options.config ?? SYNC_TOOLING_DEFAULT_CONFIG,
          homeDir: os.homedir(),
          kindHint:
            options.kind === "mcp" || options.kind === "skills"
              ? options.kind
              : undefined,
          agentId: options.agent,
          isTty: process.stdout.isTTY === true,
          prompts,
          clock: () => new Date(),
        });

        if (result.exitCode === 0) {
          success(result.summary);
        } else {
          error(result.summary);
        }
        process.exit(result.exitCode);
      },
    );
}
