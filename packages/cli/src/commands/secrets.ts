// SPDX-License-Identifier: Apache-2.0
// @allow-throw: CLI command entry point; throws caught by Commander.js error handler boundary (CLI user-facing flows exception).
/**
 * Secret management commands: init, set, get, list, delete, import, audit.
 *
 * Provides `comis secrets [init|set|get|list|delete|import|audit]` subcommands
 * for managing encrypted secrets.
 *
 * Store-backed subcommands (set, get, list, delete, import) route through
 * daemon RPC -- the CLI never opens the encrypted SQLite store directly.
 * Each store-backed subcommand gates on a 200ms `requireDaemonOrExit()` probe
 * and exits with code 4 (DaemonRequired) on failure (see util/daemon-required.ts).
 *
 * `secrets init` is daemon-free -- it calls the `writeMasterKeyIfAbsent`
 * core helper to generate/persist `SECRETS_MASTER_KEY` in `~/.comis/.env`.
 *
 * The `audit` subcommand is daemon-free -- it scans config YAML and .env
 * files for plaintext secrets and reports findings with severity levels,
 * supporting CI gating via --check and machine-readable output via --json.
 *
 * @module
 */

import type { Command } from "commander";
import * as p from "@clack/prompts";
import * as fs from "node:fs";
import * as os from "node:os";
import {
  loadEnvFile,
  safePath,
  auditSecrets,
  writeMasterKeyIfAbsent,
  generateMasterKey,
  SecretsSetContract,
  SecretsGetContract,
  SecretsListContract,
  SecretsDeleteContract,
} from "@comis/core";
import type { AuditFinding } from "@comis/core";
import { withClient, callTyped } from "../client/rpc-client.js";
import { requireDaemonOrExit, DAEMON_PROBE_TIMEOUT_MS } from "../util/daemon-required.js";
import { isDaemonRunning } from "../sync-tooling/daemon-guard.js";
import { offlineSecretSet, offlineSecretsList, offlineSecretGet } from "../util/offline-secrets-store.js";
import { success, error, info, warn, json } from "../output/format.js";
import { renderTable } from "../output/table.js";
import { formatRelativeTime } from "./sessions.js";

/**
 * Provider prefix mapping for auto-detection from secret name.
 */
const PROVIDER_PREFIXES: ReadonlyArray<[string, string]> = [
  ["OPENAI_", "openai"],
  ["ANTHROPIC_", "anthropic"],
  ["TELEGRAM_", "telegram"],
  ["DISCORD_", "discord"],
  ["SLACK_", "slack"],
  ["STRIPE_", "stripe"],
  ["SENDGRID_", "sendgrid"],
  ["TWILIO_", "twilio"],
  ["AWS_", "aws"],
  ["GOOGLE_", "google"],
  ["GROQ_", "groq"],
  ["DEEPGRAM_", "deepgram"],
  ["ELEVENLABS_", "elevenlabs"],
  ["BRAVE_", "brave"],
];

/**
 * Prefixes and exact names to skip during .env import.
 * These are operational/system variables, not secrets.
 */
const SKIP_PREFIXES = ["COMIS_", "NODE_"];
const SKIP_EXACT = new Set([
  "SECRETS_MASTER_KEY",
  "PATH",
  "HOME",
  "SHELL",
  "USER",
  "TERM",
  "LANG",
  "TZ",
  "EDITOR",
  "VISUAL",
]);

/**
 * Auto-detect provider from a secret name using prefix matching.
 *
 * @param name - Secret name (e.g., "OPENAI_API_KEY")
 * @returns Provider string or undefined if no match
 */
function detectProvider(name: string): string | undefined {
  for (const [prefix, provider] of PROVIDER_PREFIXES) {
    if (name.startsWith(prefix)) {
      return provider;
    }
  }
  return undefined;
}

/**
 * Determine whether a key should be imported from .env.
 *
 * @param key - Environment variable name
 * @returns true if the key should be imported as a secret
 */
function shouldImport(key: string): boolean {
  if (SKIP_EXACT.has(key)) return false;
  for (const prefix of SKIP_PREFIXES) {
    if (key.startsWith(prefix)) return false;
  }
  return true;
}

/**
 * Resolve a secret value from one of three mutually exclusive input modes:
 * 1. --value flag: return directly
 * 2. --stdin flag: read from stdin
 * 3. Default: interactive hidden prompt via @clack/prompts
 *
 * @param options - Command options with value, stdin flags
 * @returns The resolved secret value
 * @throws Error if no TTY and no explicit input mode
 */
async function resolveSecretValue(options: {
  value?: string;
  stdin?: boolean;
}): Promise<string> {
  // Mode 1: --value flag
  if (options.value !== undefined) {
    return options.value;
  }

  // Mode 2: --stdin flag
  if (options.stdin) {
    if (process.stdin.isTTY) {
      warn(
        "No pipe detected. Use: echo 'value' | comis secrets set NAME --stdin",
      );
    }
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
    }
    return Buffer.concat(chunks).toString("utf-8").trim();
  }

  // Mode 3: Interactive hidden prompt
  if (!process.stdin.isTTY) {
    throw new Error(
      "No TTY available for interactive input. Use --value or --stdin for non-interactive usage.",
    );
  }

  const value = await p.password({
    message: "Enter secret value:",
    validate: (v) => {
      if (!v || v.length === 0) return "Value cannot be empty";
      return undefined;
    },
  });

  if (p.isCancel(value)) {
    throw new Error("Cancelled");
  }

  return value;
}

/**
 * Register the `secrets` subcommand group on the program.
 *
 * Provides init, set, get, list, delete, and import subcommands for
 * managing encrypted secrets without a running daemon.
 *
 * @param program - The root Commander program
 */
export function registerSecretsCommand(program: Command): void {
  const secrets = program
    .command("secrets")
    .description("Encrypted secret management");

  // secrets init
  secrets
    .command("init")
    .description("Generate a new master encryption key")
    .option("--write", "Append key to ~/.comis/.env")
    .action(async (options: { write?: boolean }) => {
      if (options.write) {
        const dataDir = safePath(os.homedir(), ".comis");
        const result = writeMasterKeyIfAbsent(dataDir);
        if (result.written) {
          success(`Master key written to ${result.path} (permissions: 0600)`);
        } else {
          error(
            `SECRETS_MASTER_KEY already exists in ${result.path}. Remove it first or use a different file.`,
          );
          return;
        }
      } else {
        // Only print key to stdout when NOT writing to file
        console.log(generateMasterKey());
      }
    });

  // secrets set <name>
  secrets
    .command("set <name>")
    .description(
      "Encrypt and store a secret. Uses daemon RPC when running; falls back to direct store when daemon is offline.",
    )
    .option("--value <value>", "Secret value (alternative to interactive prompt)")
    .option("--stdin", "Read value from stdin pipe")
    .option("--provider <provider>", "Provider tag (auto-detected if omitted)")
    .action(
      async (
        name: string,
        options: { value?: string; stdin?: boolean; provider?: string },
      ) => {
        try {
          const value = await resolveSecretValue(options);
          const provider = options.provider ?? detectProvider(name);
          const daemonUp = await isDaemonRunning(DAEMON_PROBE_TIMEOUT_MS);

          if (daemonUp) {
            const result = await withClient(async (client) => {
              return await callTyped(client, SecretsSetContract, {
                name,
                value,
                ...(provider !== undefined ? { provider } : {}),
              });
            });

            if (result.restarting) {
              success(`Secret '${name}' stored — daemon restart scheduled (existing key rotated)`);
            } else {
              success(`Secret '${name}' stored and live-applied (no restart required)`);
            }
          } else {
            // Daemon-free fallback: write directly to the encrypted SQLite store
            const dataDir = safePath(os.homedir(), ".comis");
            const envFilePath = safePath(dataDir, ".env");
            const result = offlineSecretSet({
              name,
              value,
              ...(provider !== undefined ? { provider } : {}),
              dataDir,
              envFilePath,
            });
            if (!result.ok) {
              error(result.error.message);
              process.exit(1);
            }
            success(`Secret '${name}' stored (offline — daemon was not running)`);
          }
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          if (msg === "Cancelled") {
            info("Cancelled");
            return;
          }
          error(msg);
          process.exit(1);
        }
      },
    );

  // secrets get <name>
  secrets
    .command("get <name>")
    .description(
      "Decrypt and display a secret. Requires the comis daemon to be running, or pass --offline to read the local store directly (needs SECRETS_MASTER_KEY in ~/.comis/.env).",
    )
    .option("--yes", "Skip confirmation prompt")
    .option(
      "--offline",
      "Read the local encrypted store directly (no daemon RPC). Breaks the gateway-token chicken-and-egg.",
    )
    .action(async (name: string, options: { yes?: boolean; offline?: boolean }) => {
      // Confirmation guard
      if (!options.yes && process.stdout.isTTY) {
        const confirmed = await p.confirm({
          message:
            "This will display the secret value in plain text. Continue?",
        });

        if (p.isCancel(confirmed) || !confirmed) {
          info("Cancelled");
          return;
        }
      }

      // Explicit offline read. Without it,
      // `secrets get COMIS_GATEWAY_TOKEN` required the daemon RPC — which
      // required the very token being fetched. The daemon path stays the
      // default (RPC reads are audit-logged daemon-side); --offline is the
      // operator's deliberate, local, master-key-gated escape hatch.
      if (options.offline === true) {
        const dataDir = safePath(os.homedir(), ".comis");
        const result = offlineSecretGet({
          name,
          dataDir,
          envFilePath: safePath(dataDir, ".env"),
        });
        if (!result.ok) {
          error(result.error.message);
          process.exit(1);
        }
        if (result.value === undefined) {
          error(`Secret '${name}' not found`);
          process.exit(1);
        }
        // Raw output for pipe-ability
        console.log(result.value);
        return;
      }

      await requireDaemonOrExit();
      try {
        const result = await withClient(async (client) => {
          return await callTyped(client, SecretsGetContract, { name });
        });

        if (!result.exists || result.value === undefined) {
          error(`Secret '${name}' not found`);
          process.exit(1);
        }

        // Raw output for pipe-ability
        console.log(result.value);
      } catch (e) {
        error(e instanceof Error ? e.message : String(e));
        process.exit(1);
      }
    });

  // secrets list
  secrets
    .command("list")
    .description(
      "List stored secrets (metadata only, no values). Uses daemon RPC when running; falls back to direct store when daemon is offline.",
    )
    .option("--format <format>", "Output format (table|json)", "table")
    .action(async (options: { format: string }) => {
      try {
        const daemonUp = await isDaemonRunning(DAEMON_PROBE_TIMEOUT_MS);
        let rows: Array<{ name: string; provider?: string | null; createdAt: number }>;

        if (daemonUp) {
          const result = await withClient(async (client) => {
            return await callTyped(client, SecretsListContract, {});
          });
          rows = result.secrets;
        } else {
          const dataDir = safePath(os.homedir(), ".comis");
          const envFilePath = safePath(dataDir, ".env");
          const result = offlineSecretsList({ dataDir, envFilePath });
          if (!result.ok) {
            error(result.error.message);
            process.exit(1);
            return;
          }
          rows = result.value;
        }

        if (options.format === "json") {
          json(rows);
          return;
        }

        if (rows.length === 0) {
          info("No secrets stored");
          return;
        }

        renderTable(
          ["Name", "Provider", "Created"],
          rows.map((s) => [
            s.name,
            s.provider ?? "-",
            formatRelativeTime(s.createdAt),
          ]),
        );
      } catch (e) {
        error(e instanceof Error ? e.message : String(e));
        process.exit(1);
      }
    });

  // secrets delete <name>
  secrets
    .command("delete <name>")
    .description(
      "Delete a secret from the store. Requires the comis daemon to be running.",
    )
    .option("--yes", "Skip confirmation prompt")
    .action(async (name: string, options: { yes?: boolean }) => {
      if (!options.yes) {
        const confirmed = await p.confirm({
          message: `Delete secret '${name}'? This cannot be undone.`,
        });

        if (p.isCancel(confirmed) || !confirmed) {
          info("Cancelled");
          return;
        }
      }

      await requireDaemonOrExit();
      try {
        const result = await withClient(async (client) => {
          return await callTyped(client, SecretsDeleteContract, { name });
        });

        if (!result.deleted) {
          warn(`Secret '${name}' not found`);
        } else if (result.restarting) {
          success(`Secret '${name}' deleted — daemon restart scheduled`);
        } else {
          success(`Secret '${name}' deleted`);
        }
      } catch (e) {
        error(e instanceof Error ? e.message : String(e));
        process.exit(1);
      }
    });

  // secrets import
  secrets
    .command("import")
    .description(
      "Import secrets from a .env file. Uses daemon RPC when running; falls back to direct store when daemon is offline.",
    )
    .option("--file <path>", "Source .env file path (default: ~/.comis/.env)")
    .action(async (options: { file?: string }) => {
      const sourcePath =
        options.file ?? safePath(os.homedir() + "/.comis", ".env");

      try {
        // Load source file into a fresh record
        const envRecord: Record<string, string | undefined> = {};
        const loadResult = loadEnvFile(sourcePath, envRecord);

        if (loadResult === -1) {
          error(`File not found: ${sourcePath}`);
          process.exit(1);
          return;
        }

        const daemonUp = await isDaemonRunning(DAEMON_PROBE_TIMEOUT_MS);
        let imported = 0;
        let skipped = 0;
        let failed = 0;

        const dataDir = safePath(os.homedir(), ".comis");
        const envFilePath = safePath(dataDir, ".env");

        for (const [key, value] of Object.entries(envRecord)) {
          if (value === undefined) continue;

          if (!shouldImport(key)) {
            skipped++;
            warn(`Skipped: ${key} (operational variable)`);
            continue;
          }

          const provider = detectProvider(key);
          if (daemonUp) {
            try {
              await withClient(async (client) => {
                return await callTyped(client, SecretsSetContract, {
                  name: key,
                  value,
                  ...(provider !== undefined ? { provider } : {}),
                });
              });
              imported++;
              success(`Imported: ${key}`);
            } catch (e) {
              failed++;
              const msg = e instanceof Error ? e.message : String(e);
              error(`Failed: ${key} -- ${msg}`);
            }
          } else {
            const result = offlineSecretSet({
              name: key,
              value,
              ...(provider !== undefined ? { provider } : {}),
              dataDir,
              envFilePath,
            });
            if (!result.ok) {
              failed++;
              error(`Failed: ${key} -- ${result.error.message}`);
            } else {
              imported++;
              success(`Imported: ${key}`);
            }
          }
        }

        info(
          `Import complete: ${imported} imported, ${skipped} skipped, ${failed} failed`,
        );
      } catch (e) {
        error(e instanceof Error ? e.message : String(e));
        process.exit(1);
      }
    });

  // secrets audit
  secrets
    .command("audit")
    .description("Scan config and .env files for plaintext secrets")
    .option(
      "--config <paths...>",
      "Config file paths to scan (default: ~/.comis/config.yaml, ~/.comis/config.local.yaml)",
    )
    .option(
      "--env-file <path>",
      "Path to .env file (default: ~/.comis/.env)",
    )
    .option("--check", "Exit with code 1 if any findings exist (for CI)")
    .option("--json", "Output findings as JSON array")
    .action(
      async (options: {
        config?: string[];
        envFile?: string;
        check?: boolean;
        json?: boolean;
      }) => {
        // Resolve default paths
        const defaultConfigPaths = [
          safePath(os.homedir() + "/.comis", "config.yaml"),
          safePath(os.homedir() + "/.comis", "config.local.yaml"),
        ];
        const configPaths = options.config ?? defaultConfigPaths;
        const envFilePath =
          options.envFile ?? safePath(os.homedir() + "/.comis", ".env");

        // Filter to existing files only
        const existingConfigs = configPaths.filter((p) => fs.existsSync(p));
        const envPath = fs.existsSync(envFilePath) ? envFilePath : undefined;

        if (existingConfigs.length === 0 && !envPath) {
          info("No config files or .env found to audit");
          return;
        }

        // Run audit
        const findings = auditSecrets({
          configPaths: existingConfigs,
          envPath,
        });

        // JSON output mode
        if (options.json) {
          json(findings);
          if (options.check && findings.length > 0) {
            process.exit(1);
          }
          return;
        }

        // Table/human output mode
        if (findings.length === 0) {
          success("No plaintext secrets detected");
          if (existingConfigs.length > 0) {
            info(`Scanned config: ${existingConfigs.join(", ")}`);
          }
          if (envPath) {
            info(`Scanned env: ${envPath}`);
          }
          return;
        }

        // Group findings by file for display
        const byFile = new Map<string, AuditFinding[]>();
        for (const f of findings) {
          const list = byFile.get(f.file) ?? [];
          list.push(f);
          byFile.set(f.file, list);
        }

        for (const [file, fileFindings] of byFile) {
          info(`\n${file}:`);
          renderTable(
            ["Severity", "Code", "Path", "Message"],
            fileFindings.map((f) => [
              f.severity.toUpperCase(),
              f.code,
              f.jsonPath,
              f.message,
            ]),
          );
        }

        // Summary
        const errorCount = findings.filter(
          (f) => f.severity === "error",
        ).length;
        const warnCount = findings.filter(
          (f) => f.severity === "warn",
        ).length;
        const infoCount = findings.filter(
          (f) => f.severity === "info",
        ).length;

        info(
          `\nFindings: ${errorCount} error(s), ${warnCount} warning(s), ${infoCount} info`,
        );

        if (options.check && findings.length > 0) {
          error(
            `Audit check failed: ${findings.length} finding(s) detected`,
          );
          process.exit(1);
        }
      },
    );
}
