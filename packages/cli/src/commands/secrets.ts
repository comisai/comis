// SPDX-License-Identifier: Apache-2.0
/**
 * Secret management commands: init, set, get, list, delete, import, audit.
 *
 * Provides `comis secrets [init|set|get|list|delete|import|audit]` subcommands
 * for managing encrypted secrets without a running daemon.
 *
 * All secret storage uses AES-256-GCM encryption via the SecretStorePort
 * adapter backed by SQLite (secrets.db in the data directory).
 *
 * The `audit` subcommand scans config YAML and .env files for plaintext
 * secrets and reports findings with severity levels, supporting CI gating
 * via --check and machine-readable output via --json.
 *
 * @module
 */

import type { Command } from "commander";
import * as p from "@clack/prompts";
import * as fs from "node:fs";
import * as os from "node:os";
import { randomBytes } from "node:crypto";
import {
  parseMasterKey,
  createSecretsCrypto,
  loadEnvFile,
  safePath,
  auditSecrets,
} from "@comis/core";
import type { SecretStorePort, AuditFinding } from "@comis/core";
import { createSqliteSecretStore } from "@comis/memory";
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
 * Open the secret store using the master key from env or ~/.comis/.env.
 *
 * Resolution order:
 * 1. SECRETS_MASTER_KEY from process.env (ESLint disable: CLI entry point)
 * 2. SECRETS_MASTER_KEY from ~/.comis/.env loaded into a separate record
 *
 * @param dataDir - Data directory (default: ~/.comis)
 * @returns SecretStorePort instance (caller must close in finally block)
 * @throws Error if master key not found or canary validation fails
 */
function openSecretStore(dataDir?: string): SecretStorePort {
  const dir = dataDir ?? os.homedir() + "/.comis";

  // 1. Try process.env first (CLI is a top-level entry point, like daemon.ts)
  // eslint-disable-next-line no-restricted-syntax -- CLI entry point: master key resolution matches daemon.ts pattern
  let raw = process.env["SECRETS_MASTER_KEY"];

  // 2. Fall back to ~/.comis/.env
  if (!raw) {
    const envRecord: Record<string, string | undefined> = {};
    const envPath = safePath(dir, ".env");
    loadEnvFile(envPath, envRecord);
    raw = envRecord["SECRETS_MASTER_KEY"];
  }

  if (!raw) {
    throw new Error(
      "SECRETS_MASTER_KEY not set. Run 'comis secrets init --write' first, or set SECRETS_MASTER_KEY in your environment.",
    );
  }

  const masterKey = parseMasterKey(raw);
  const crypto = createSecretsCrypto(masterKey);
  const dbPath = safePath(dir, "secrets.db");

  try {
    return createSqliteSecretStore(dbPath, crypto);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("DECRYPTION_FAILED") || msg.includes("Unsupported state") || msg.includes("auth tag")) {
      throw new Error(
        "Master key does not match the existing secrets database. Either use the original key or delete secrets.db to start fresh.",
        { cause: e },
      );
    }
    throw e;
  }
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
      const keyHex = randomBytes(32).toString("hex");

      if (options.write) {
        const dir = os.homedir() + "/.comis";
        const envPath = safePath(dir, ".env");

        // Check if key already exists
        try {
          const existing = fs.readFileSync(envPath, "utf-8");
          if (/^SECRETS_MASTER_KEY=/m.test(existing)) {
            error(
              "SECRETS_MASTER_KEY already exists in ~/.comis/.env. Remove it first or use a different file.",
            );
            return;
          }
        } catch {
          // File does not exist -- proceed to create
        }

        // Ensure directory exists with restricted permissions
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

        // Append master key
        fs.appendFileSync(envPath, `\nSECRETS_MASTER_KEY=${keyHex}\n`);
        fs.chmodSync(envPath, 0o600);

        success("Master key written to ~/.comis/.env (permissions: 0600)");
      } else {
        // Only print key to stdout when NOT writing to file
        console.log(keyHex);
      }
    });

  // secrets set <name>
  secrets
    .command("set <name>")
    .description("Encrypt and store a secret")
    .option("--value <value>", "Secret value (alternative to interactive prompt)")
    .option("--stdin", "Read value from stdin pipe")
    .option("--provider <provider>", "Provider tag (auto-detected if omitted)")
    .action(
      async (
        name: string,
        options: { value?: string; stdin?: boolean; provider?: string },
      ) => {
        let store: SecretStorePort | undefined;
        try {
          const value = await resolveSecretValue(options);
          const provider = options.provider ?? detectProvider(name);

          store = openSecretStore();
          const result = store.set(name, value, { provider });

          if (result.ok) {
            success(`Secret '${name}' stored successfully`);
          } else {
            error(result.error.message);
            process.exit(1);
          }
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          if (msg === "Cancelled") {
            info("Cancelled");
            return;
          }
          error(msg);
          process.exit(1);
        } finally {
          store?.close();
        }
      },
    );

  // secrets get <name>
  secrets
    .command("get <name>")
    .description("Decrypt and display a secret")
    .option("--yes", "Skip confirmation prompt")
    .action(async (name: string, options: { yes?: boolean }) => {
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

      let store: SecretStorePort | undefined;
      try {
        store = openSecretStore();
        const result = store.getDecrypted(name);

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
      } catch (e) {
        error(e instanceof Error ? e.message : String(e));
        process.exit(1);
      } finally {
        store?.close();
      }
    });

  // secrets list
  secrets
    .command("list")
    .description("List stored secrets (metadata only, no values)")
    .option("--format <format>", "Output format (table|json)", "table")
    .action(async (options: { format: string }) => {
      let store: SecretStorePort | undefined;
      try {
        store = openSecretStore();
        const result = store.list();

        if (!result.ok) {
          error(result.error.message);
          process.exit(1);
        }

        if (options.format === "json") {
          json(result.value);
          return;
        }

        if (result.value.length === 0) {
          info("No secrets stored");
          return;
        }

        renderTable(
          ["Name", "Provider", "Created", "Last Used", "Usage Count"],
          result.value.map((s) => [
            s.name,
            s.provider ?? "-",
            formatRelativeTime(s.createdAt),
            s.lastUsedAt ? formatRelativeTime(s.lastUsedAt) : "-",
            String(s.usageCount),
          ]),
        );
      } catch (e) {
        error(e instanceof Error ? e.message : String(e));
        process.exit(1);
      } finally {
        store?.close();
      }
    });

  // secrets delete <name>
  secrets
    .command("delete <name>")
    .description("Delete a secret from the store")
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

      let store: SecretStorePort | undefined;
      try {
        store = openSecretStore();
        const result = store.delete(name);

        if (!result.ok) {
          error(result.error.message);
          process.exit(1);
        }

        if (!result.value) {
          warn(`Secret '${name}' not found`);
        } else {
          success(`Secret '${name}' deleted`);
        }
      } catch (e) {
        error(e instanceof Error ? e.message : String(e));
        process.exit(1);
      } finally {
        store?.close();
      }
    });

  // secrets import
  secrets
    .command("import")
    .description("Import secrets from a .env file")
    .option("--file <path>", "Source .env file path (default: ~/.comis/.env)")
    .action(async (options: { file?: string }) => {
      const sourcePath =
        options.file ?? safePath(os.homedir() + "/.comis", ".env");

      let store: SecretStorePort | undefined;
      try {
        store = openSecretStore();

        // Load source file into a fresh record
        const envRecord: Record<string, string | undefined> = {};
        const loadResult = loadEnvFile(sourcePath, envRecord);

        if (loadResult === -1) {
          error(`File not found: ${sourcePath}`);
          process.exit(1);
        }

        let imported = 0;
        let skipped = 0;
        let failed = 0;

        for (const [key, value] of Object.entries(envRecord)) {
          if (value === undefined) continue;

          if (!shouldImport(key)) {
            skipped++;
            warn(`Skipped: ${key} (operational variable)`);
            continue;
          }

          const provider = detectProvider(key);
          const result = store.set(key, value, { provider });

          if (result.ok) {
            imported++;
            success(`Imported: ${key}`);
          } else {
            failed++;
            error(`Failed: ${key} -- ${result.error.message}`);
          }
        }

        info(
          `Import complete: ${imported} imported, ${skipped} skipped, ${failed} failed`,
        );
      } catch (e) {
        error(e instanceof Error ? e.message : String(e));
        process.exit(1);
      } finally {
        store?.close();
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
