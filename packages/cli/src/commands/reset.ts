/**
 * Reset utility command: sessions, config, workspace.
 *
 * Provides `comis reset <target>` for clearing sessions, config files,
 * or the entire workspace. Requires explicit confirmation for destructive
 * operations, with `--yes` for scripted/CI usage.
 *
 * @module
 */

import type { Command } from "commander";
import * as p from "@clack/prompts";
import * as fs from "node:fs";
import * as os from "node:os";
import { withClient } from "../client/rpc-client.js";
import { success, error, info, warn } from "../output/format.js";
import { withSpinner } from "../output/spinner.js";

/** Valid reset targets. */
const VALID_TARGETS = ["sessions", "config", "workspace"] as const;
type ResetTarget = (typeof VALID_TARGETS)[number];

/** Target-specific confirmation messages. */
const CONFIRM_MESSAGES: Record<ResetTarget, (dataDir: string) => string> = {
  sessions: () => "Delete ALL sessions? This cannot be undone.",
  config: () => "Delete config.yaml and .env? You will need to run 'comis init' again.",
  workspace: (dataDir) =>
    `Delete entire workspace (${dataDir}) including sessions, memory, logs? This cannot be undone.`,
};

/**
 * Resolve the Comis data directory from config or default.
 *
 * @param configPath - Optional path to config file
 * @returns Resolved data directory path
 */
function resolveDataDir(configPath?: string): string {
  if (configPath) {
    try {
      const content = fs.readFileSync(configPath, "utf-8");
      // Simple YAML extraction for dataDir field
      const match = content.match(/^dataDir:\s*(.+)$/m);
      if (match) {
        return match[1].trim().replace(/^["']|["']$/g, "");
      }
    } catch {
      // Fall through to default
    }
  }

  return os.homedir() + "/.comis";
}

/**
 * Resolve the Comis config directory.
 *
 * @returns Config directory path (default: /etc/comis)
 */
function resolveConfigDir(): string {
  return "/etc/comis";
}

/**
 * Delete a file, ignoring ENOENT (file not found) errors.
 *
 * @param filePath - Path to the file to delete
 */
function safeUnlink(filePath: string): void {
  try {
    fs.unlinkSync(filePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw err;
    }
  }
}

/**
 * Execute reset for sessions target.
 *
 * Tries RPC-based session deletion first (daemon running).
 * Falls back to direct SQLite database file removal if daemon is not running.
 */
async function resetSessions(dataDir: string): Promise<void> {
  try {
    await withSpinner("Clearing sessions via daemon...", () =>
      withClient(async (client) => {
        return await client.call("session.reset");
      }),
    );
    success("All sessions deleted");
  } catch {
    // Daemon not running -- try direct file deletion
    const dbPath = dataDir + "/memory.db";
    try {
      fs.accessSync(dbPath);
      warn("Daemon not running. Removing memory database directly.");
      warn("This also removes memory data (not just sessions).");
      fs.unlinkSync(dbPath);
      // Also clean up WAL and SHM files if present
      safeUnlink(dbPath + "-wal");
      safeUnlink(dbPath + "-shm");
      success("Memory database removed");
    } catch (fileErr) {
      if ((fileErr as NodeJS.ErrnoException).code === "ENOENT") {
        info("No memory database found -- nothing to reset");
      } else {
        throw fileErr;
      }
    }
  }
}

/**
 * Execute reset for config target.
 *
 * Removes config.yaml and .env files from the config directory.
 */
function resetConfig(): void {
  const configDir = resolveConfigDir();
  safeUnlink(configDir + "/config.yaml");
  safeUnlink(configDir + "/.env");
  success("Config files removed");
  info("Run 'comis init' to reconfigure");
}

/**
 * Execute reset for workspace target.
 *
 * Removes the entire data directory and config files.
 */
function resetWorkspace(dataDir: string): void {
  // Remove data directory
  try {
    fs.rmSync(dataDir, { recursive: true, force: true });
  } catch {
    // Best effort -- directory may not exist
  }

  // Also remove config files
  resetConfig();
  success(`Workspace at ${dataDir} removed`);
}

/**
 * Register the `reset` command on the program.
 *
 * Provides `comis reset <target>` for clearing sessions, config,
 * or the entire workspace with explicit confirmation.
 *
 * @param program - The root Commander program
 */
export function registerResetCommand(program: Command): void {
  program
    .command("reset <target>")
    .description("Reset sessions, config, or workspace")
    .option("--yes", "Skip confirmation prompt")
    .option("-c, --config <path>", "Config file path for resolving data directory")
    .action(async (target: string, options: { yes?: boolean; config?: string }) => {
      // Validate target
      if (!VALID_TARGETS.includes(target as ResetTarget)) {
        error(`Invalid target: "${target}"`);
        info(`Valid targets: ${VALID_TARGETS.join(", ")}`);
        process.exit(1);
      }

      const resetTarget = target as ResetTarget;
      const dataDir = resolveDataDir(options.config);

      // Confirmation prompt (unless --yes)
      if (!options.yes) {
        const message = CONFIRM_MESSAGES[resetTarget](dataDir);
        const confirmed = await p.confirm({ message });

        if (p.isCancel(confirmed) || !confirmed) {
          p.cancel("Reset cancelled.");
          return;
        }
      }

      try {
        switch (resetTarget) {
          case "sessions":
            await resetSessions(dataDir);
            break;
          case "config":
            resetConfig();
            break;
          case "workspace":
            resetWorkspace(dataDir);
            break;
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        error(`Reset failed: ${msg}`);
        process.exit(1);
      }
    });
}
