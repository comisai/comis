/**
 * Uninstall command — thin wrapper that re-invokes install.sh --uninstall.
 *
 * The installer is the source of truth for every file, service, and user the
 * install path can create, so the uninstall path lives there too. This command
 * downloads a fresh copy of install.sh from comis.ai and runs it with the
 * requested uninstall flags, forwarding the user's TTY for interactive
 * confirmation and sudo prompts.
 *
 * @module
 */

import type { Command } from "commander";
import { spawn, execFile } from "node:child_process";
import { existsSync, mkdtempSync, unlinkSync, rmdirSync } from "node:fs";
import * as os from "node:os";
import { dirname } from "node:path";
import { promisify } from "node:util";
import { safePath } from "@comis/core";
import { error, info, warn } from "../output/format.js";

const exec = promisify(execFile);

const INSTALLER_URL = "https://comis.ai/install.sh";

interface UninstallOptions {
  purge?: boolean;
  removeUser?: boolean;
  yes?: boolean;
  dryRun?: boolean;
  /** Path to a local install.sh (skips download — useful for dev). */
  installer?: string;
}

/**
 * Download the installer to a temp file and return its path.
 *
 * The caller is responsible for cleaning up.
 */
async function downloadInstaller(): Promise<string> {
  const tmpDir = mkdtempSync(safePath(os.tmpdir(), "comis-uninstall-"));
  const target = safePath(tmpDir, "install.sh");

  const hasCurl = await which("curl");
  if (hasCurl) {
    try {
      await exec("curl", [
        "-fsSL",
        "--proto", "=https",
        "--tlsv1.2",
        "--retry", "3",
        "--retry-delay", "1",
        "-o", target,
        INSTALLER_URL,
      ], { timeout: 30_000 });
      return target;
    } catch (err) {
      // fall through to wget
      warn(`curl download failed: ${(err as Error).message}`);
    }
  }

  const hasWget = await which("wget");
  if (hasWget) {
    await exec("wget", [
      "-q",
      "--https-only",
      "--secure-protocol=TLSv1_2",
      "-O", target,
      INSTALLER_URL,
    ], { timeout: 30_000 });
    return target;
  }

  throw new Error("Neither curl nor wget is available — cannot download installer.");
}

async function which(cmd: string): Promise<boolean> {
  try {
    await exec(cmd, ["--version"], { timeout: 2_000 });
    return true;
  } catch {
    return false;
  }
}

function cleanupTempInstaller(installerPath: string): void {
  try {
    unlinkSync(installerPath);
    rmdirSync(dirname(installerPath));
  } catch {
    // Best-effort
  }
}

/** Run install.sh with the uninstall flags, forwarding stdio for interactivity. */
function runInstaller(installerPath: string, args: string[]): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn("bash", [installerPath, ...args], { stdio: "inherit" });
    child.on("exit", (code) => resolve(code ?? 1));
    child.on("error", (err) => {
      error(`Failed to run installer: ${err.message}`);
      resolve(1);
    });
  });
}

async function handleUninstall(options: UninstallOptions): Promise<void> {
  const args = ["--uninstall"];
  if (options.purge) args.push("--purge");
  if (options.removeUser) args.push("--remove-user");
  if (options.yes) args.push("--yes");
  if (options.dryRun) args.push("--dry-run");

  let installerPath = options.installer ?? "";
  let isTemp = false;

  if (installerPath && !existsSync(installerPath)) {
    error(`Installer not found: ${installerPath}`);
    process.exit(1);
  }

  if (!installerPath) {
    info("Downloading installer...");
    try {
      installerPath = await downloadInstaller();
      isTemp = true;
    } catch (err) {
      error(`Could not download installer: ${(err as Error).message}`);
      info("You can download it manually and pass --installer <path>:");
      info(`  curl -fsSL ${INSTALLER_URL} -o /tmp/install.sh`);
      info("  comis uninstall --installer /tmp/install.sh [flags]");
      process.exit(1);
    }
  }

  // A minimal in-memory installer so the network-unavailable user can still
  // at least invoke uninstall with a vendored copy if they have one.
  if (!existsSync(installerPath)) {
    error(`Installer path missing after download: ${installerPath}`);
    process.exit(1);
  }

  const code = await runInstaller(installerPath, args);

  if (isTemp) cleanupTempInstaller(installerPath);

  if (code !== 0) process.exit(code);
}

export function registerUninstallCommand(program: Command): void {
  program
    .command("uninstall")
    .description("Remove Comis from this machine (keeps data unless --purge)")
    .option("--purge", "Also delete ~/.comis and /etc/comis (data + config)")
    .option("--remove-user", "Linux+root only: also delete the comis system user (implies --purge)")
    .option("--yes", "Skip confirmation prompt")
    .option("--dry-run", "Print actions without performing them")
    .option("--installer <path>", "Use a local install.sh instead of downloading")
    .action(handleUninstall);
}
