/**
 * Daemon control commands: start, stop, status, logs.
 *
 * Provides `comis daemon [start|stop|status|logs]` subcommands
 * for controlling the Comis daemon process via systemd or direct spawn.
 *
 * @module
 */

import type { Command } from "commander";
import { execFile, spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync, openSync } from "node:fs";
import * as os from "node:os";
import { promisify } from "node:util";
import { safePath } from "@comis/core";
import { withClient } from "../client/rpc-client.js";
import { success, error, info, warn } from "../output/format.js";
import { renderKeyValue } from "../output/table.js";

const exec = promisify(execFile);

const COMIS_DIR = safePath(os.homedir(), ".comis");
const PID_FILE = safePath(COMIS_DIR, "daemon.pid");
const LOG_FILE = safePath(COMIS_DIR, "daemon.log");

/** Max time to wait for daemon gateway to become ready (ms). */
const READY_TIMEOUT_MS = 15_000;
/** Interval between readiness polls (ms). */
const READY_POLL_MS = 500;

/**
 * Poll the daemon health endpoint until it responds or the timeout expires.
 *
 * @returns true if the daemon became ready, false on timeout
 */
async function waitForReady(host: string, port: number): Promise<boolean> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  const url = `http://${host}:${port}/health`;

  while (Date.now() < deadline) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 2000);
      const res = await fetch(url, { signal: controller.signal });
      clearTimeout(timer);
      if (res.ok) return true;
    } catch {
      // Not ready yet -- keep polling
    }
    await new Promise((r) => setTimeout(r, READY_POLL_MS));
  }
  return false;
}

/**
 * Read gateway config from the user's config file (minimal line parser).
 * Returns gateway enabled state, host, and port.
 */
function readGatewayConfig(): { enabled: boolean; host: string; port: number } {
  const configPath = safePath(os.homedir() + "/.comis", "config.yaml");
  const defaults = { enabled: true, host: "localhost", port: 4766 };

  if (!existsSync(configPath)) return defaults;

  try {
    const content = readFileSync(configPath, "utf-8");
    const lines = content.split("\n");
    let inGateway = false;
    let enabled = true; // schema default
    let host = "0.0.0.0";
    let port = 4766;

    for (const line of lines) {
      const trimmed = line.trimStart();
      if (!line.startsWith(" ") && !line.startsWith("\t") && trimmed.length > 0 && !trimmed.startsWith("#")) {
        inGateway = trimmed.startsWith("gateway:");
      }
      if (inGateway) {
        const enabledMatch = trimmed.match(/^enabled:\s*(true|false)/);
        if (enabledMatch) enabled = enabledMatch[1] === "true";
        const hostMatch = trimmed.match(/^host:\s*(.+)/);
        if (hostMatch) host = hostMatch[1]!.trim();
        const portMatch = trimmed.match(/^port:\s*(\d+)/);
        if (portMatch) port = Number(portMatch[1]);
      }
    }
    return { enabled, host: host === "0.0.0.0" ? "localhost" : host, port };
  } catch {
    return defaults;
  }
}

// ---------- PID file helpers ----------

/** Write daemon PID to file. */
function writePidFile(pid: number): void {
  mkdirSync(COMIS_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(PID_FILE, String(pid));
}

/** Read daemon PID from file. Returns null if missing or invalid. */
function readPidFile(): number | null {
  try {
    const raw = readFileSync(PID_FILE, "utf-8").trim();
    const pid = Number(raw);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

/** Remove PID file. */
function removePidFile(): void {
  try {
    unlinkSync(PID_FILE);
  } catch {
    // Already gone
  }
}

/** Check if a process with the given PID is alive. */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Check if systemd is available and the comis service is installed. */
async function hasSystemd(): Promise<boolean> {
  if (!existsSync("/run/systemd/system")) return false;
  try {
    await exec("systemctl", ["list-unit-files", "comis.service", "--no-pager"], {
      timeout: 5_000,
    });
    return true;
  } catch {
    return false;
  }
}

// ---------- Subcommand handlers ----------

/**
 * Start the daemon in direct mode (no systemd).
 *
 * Spawns a detached node process, writes PID file, and polls for readiness.
 */
async function startDirectMode(): Promise<void> {
  const existingPid = readPidFile();
  if (existingPid && isProcessAlive(existingPid)) {
    warn(`Daemon is already running (PID: ${existingPid})`);
    return;
  }

  info("Starting daemon in direct mode...");
  const daemonPath = new URL("../../../daemon/dist/daemon.js", import.meta.url).pathname;
  if (!existsSync(daemonPath)) {
    error("Daemon binary not found. Run `pnpm build` first.");
    process.exit(1);
  }
  mkdirSync(COMIS_DIR, { recursive: true, mode: 0o700 });
  const logFd = openSync(LOG_FILE, "a", 0o600);
  const child = spawn("node", [daemonPath], {
    detached: true,
    stdio: ["ignore", logFd, logFd],
  });
  child.unref();

  if (!child.pid) {
    error("Failed to start daemon: no PID returned");
    process.exit(1);
  }

  writePidFile(child.pid);

  const gwConfig = readGatewayConfig();
  if (!gwConfig.enabled) {
    warn(
      `Daemon spawned (PID: ${child.pid}) but gateway is disabled in config. ` +
      "The CLI requires the gateway to communicate with the daemon. " +
      "Set gateway.enabled: true in ~/.comis/config.yaml",
    );
    return;
  }

  info("Waiting for daemon to be ready...");
  const ready = await waitForReady(gwConfig.host, gwConfig.port);
  if (ready) {
    success(`Daemon started and ready (PID: ${child.pid})`);
  } else if (isProcessAlive(child.pid)) {
    warn(
      `Daemon started (PID: ${child.pid}) but gateway is not responding on ${gwConfig.host}:${gwConfig.port}. ` +
      "Check daemon logs: comis daemon logs",
    );
  } else {
    removePidFile();
    error("Daemon process exited unexpectedly. Check logs: comis daemon logs");
    process.exit(1);
  }
}

/** Handle the `daemon start` subcommand. */
async function handleDaemonStart(): Promise<void> {
  try {
    if (await hasSystemd()) {
      info("Starting daemon via systemd...");
      await exec("systemctl", ["start", "comis"], { timeout: 10_000 });
      success("Daemon started");
    } else {
      await startDirectMode();
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    error(`Failed to start daemon: ${msg}`);
    process.exit(1);
  }
}

/** Handle the `daemon stop` subcommand. */
async function handleDaemonStop(): Promise<void> {
  try {
    if (await hasSystemd()) {
      info("Stopping daemon via systemd...");
      await exec("systemctl", ["stop", "comis"], { timeout: 15_000 });
      success("Daemon stopped");
      return;
    }

    // Direct mode: use PID file
    const pid = readPidFile();
    if (!pid) {
      warn("Daemon is not running (no PID file found)");
      return;
    }

    if (!isProcessAlive(pid)) {
      warn("Daemon is not running (stale PID file)");
      removePidFile();
      return;
    }

    info(`Stopping daemon (PID: ${pid})...`);
    process.kill(pid, "SIGTERM");

    // Wait for process to exit (up to 10 seconds)
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      if (!isProcessAlive(pid)) {
        removePidFile();
        success("Daemon stopped");
        return;
      }
      await new Promise((r) => setTimeout(r, 200));
    }

    // Force kill if still running
    warn("Daemon did not stop gracefully, sending SIGKILL...");
    process.kill(pid, "SIGKILL");
    removePidFile();
    success("Daemon killed");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    error(`Failed to stop daemon: ${msg}`);
    process.exit(1);
  }
}

/**
 * Try to get daemon status via RPC.
 *
 * @returns true if RPC succeeded and status was displayed
 */
async function tryRpcStatus(): Promise<boolean> {
  try {
    const result = await withClient(async (client) => {
      return (await client.call("config.get", {})) as Record<string, unknown>;
    });
    success("Daemon is running");
    const pairs: [string, string][] = [];
    const pid = readPidFile();
    if (pid) pairs.push(["PID", String(pid)]);
    if (result["tenantId"]) pairs.push(["Tenant", String(result["tenantId"])]);
    if (result["gateway"]) {
      const gw = result["gateway"] as Record<string, unknown>;
      pairs.push(["Gateway", `${gw["host"]}:${gw["port"]}`]);
    }
    if (pairs.length > 0) {
      renderKeyValue(pairs);
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Try to get daemon status via systemd.
 *
 * @returns true if systemd check succeeded and status was displayed
 */
async function trySystemdStatus(): Promise<boolean> {
  try {
    if (!(await hasSystemd())) return false;

    const { stdout } = await exec("systemctl", ["is-active", "comis"], { timeout: 5_000 });
    const status = stdout.trim();
    if (status === "active") {
      success("Daemon is running (systemd)");
      try {
        const { stdout: showOut } = await exec(
          "systemctl",
          ["show", "comis", "--property=ActiveEnterTimestamp,MainPID", "--no-pager"],
          { timeout: 5_000 },
        );
        const props = Object.fromEntries(
          showOut
            .trim()
            .split("\n")
            .map((line) => {
              const [k, ...v] = line.split("=");
              return [k, v.join("=")] as [string, string];
            }),
        );
        const pairs: [string, string][] = [];
        if (props["MainPID"]) pairs.push(["PID", props["MainPID"]]);
        if (props["ActiveEnterTimestamp"])
          pairs.push(["Since", props["ActiveEnterTimestamp"]]);
        if (pairs.length > 0) renderKeyValue(pairs);
      } catch {
        // Extra info failed -- status already shown
      }
    } else {
      warn(`Daemon status: ${status}`);
    }
    return true;
  } catch {
    return false;
  }
}

/** Handle the `daemon status` subcommand. */
async function handleDaemonStatus(): Promise<void> {
  // Try RPC first for detailed info
  if (await tryRpcStatus()) return;

  // Try systemd
  if (await trySystemdStatus()) return;

  // Fall back to PID file check
  const pid = readPidFile();
  if (pid && isProcessAlive(pid)) {
    success(`Daemon is running (PID: ${pid})`);
    renderKeyValue([["PID", String(pid)]]);
  } else {
    if (pid) removePidFile(); // Clean up stale PID file
    warn("Daemon is not running");
  }
}

/** Handle the `daemon logs` subcommand. */
async function handleDaemonLogs(options: { follow?: boolean; lines: string }): Promise<void> {
  try {
    if (await hasSystemd()) {
      const args = ["--unit=comis", "--no-pager", `-n${options.lines}`];
      if (options.follow) {
        args.push("--follow");
        // Stream output with spawn
        const child = spawn("journalctl", args, { stdio: "inherit" });
        child.on("error", (err) => {
          error(`Failed to read logs: ${err.message}`);
          process.exit(1);
        });
      } else {
        const { stdout } = await exec("journalctl", args, { timeout: 10_000 });
        if (stdout.trim()) {
          console.log(stdout);
        } else {
          info("No logs found");
        }
      }
    } else {
      // Attempt to tail log file from default location
      // eslint-disable-next-line no-restricted-syntax -- CLI bootstrap before SecretManager
      const logPath = process.env["COMIS_LOG_PATH"] ?? LOG_FILE;
      if (!existsSync(logPath)) {
        warn(`Log file not found: ${logPath}`);
        info("Set COMIS_LOG_PATH to specify a custom log file location.");
        return;
      }
      const args = ["-n", options.lines, logPath];
      if (options.follow) {
        args.unshift("-f");
        const child = spawn("tail", args, { stdio: "inherit" });
        child.on("error", (err) => {
          error(`Failed to read logs: ${err.message}`);
          process.exit(1);
        });
      } else {
        const { stdout } = await exec("tail", args, { timeout: 5_000 });
        if (stdout.trim()) {
          console.log(stdout);
        } else {
          info("No logs found");
        }
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    error(`Failed to read logs: ${msg}`);
    process.exit(1);
  }
}

// ---------- Command registration ----------

/**
 * Register the `daemon` subcommand group on the program.
 *
 * @param program - The root Commander program
 */
export function registerDaemonCommand(program: Command): void {
  const daemon = program.command("daemon").description("Control the Comis daemon");

  daemon
    .command("start")
    .description("Start the Comis daemon")
    .action(handleDaemonStart);

  daemon
    .command("stop")
    .description("Stop the Comis daemon")
    .action(handleDaemonStop);

  daemon
    .command("status")
    .description("Show daemon status")
    .action(handleDaemonStatus);

  daemon
    .command("logs")
    .description("Show daemon logs")
    .option("-f, --follow", "Follow log output")
    .option("-n, --lines <n>", "Number of lines to show", "50")
    .action(handleDaemonLogs);
}
