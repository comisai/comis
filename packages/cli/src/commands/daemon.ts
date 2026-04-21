// SPDX-License-Identifier: Apache-2.0
/**
 * Daemon control commands: start, stop, status, logs.
 *
 * Provides `comis daemon [start|stop|status|logs]` subcommands for controlling
 * the Comis daemon. Dispatches to whichever supervisor actually owns the
 * daemon — systemd (system or user scope), pm2, or direct-spawn — detected
 * at runtime so the CLI works no matter how the installer wired things up.
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

// ---------- Service manager detection ----------

type ServiceManager = "systemd" | "systemd-user" | "pm2" | "direct";

/** Check if system-scope systemd owns the comis unit. */
async function hasSystemSystemd(): Promise<boolean> {
  if (!existsSync("/run/systemd/system")) return false;
  try {
    const { stdout } = await exec(
      "systemctl",
      ["list-unit-files", "comis.service", "--no-pager", "--no-legend"],
      { timeout: 5_000 },
    );
    return stdout.includes("comis.service");
  } catch {
    return false;
  }
}

/** Check if user-scope systemd owns the comis unit. */
async function hasUserSystemd(): Promise<boolean> {
  if (!existsSync("/run/systemd/system")) return false;
  try {
    const { stdout } = await exec(
      "systemctl",
      ["--user", "list-unit-files", "comis.service", "--no-pager", "--no-legend"],
      { timeout: 5_000 },
    );
    return stdout.includes("comis.service");
  } catch {
    return false;
  }
}

/** Check if pm2 has a process registered as "comis". */
async function hasPm2Service(): Promise<boolean> {
  try {
    const { stdout } = await exec("pm2", ["jlist"], { timeout: 5_000 });
    const parsed = JSON.parse(stdout) as Array<{ name?: string }>;
    return parsed.some((p) => p.name === "comis");
  } catch {
    return false;
  }
}

/**
 * Detect which supervisor owns this install.
 *
 * Priority: system systemd → user systemd → pm2 → direct-spawn fallback.
 * Cached for the lifetime of a single CLI invocation.
 */
let cachedManager: ServiceManager | null = null;
async function detectServiceManager(): Promise<ServiceManager> {
  if (cachedManager !== null) return cachedManager;
  if (await hasSystemSystemd()) return (cachedManager = "systemd");
  if (await hasUserSystemd()) return (cachedManager = "systemd-user");
  if (await hasPm2Service()) return (cachedManager = "pm2");
  return (cachedManager = "direct");
}

/** Systemctl arg prefix for the current scope. */
function systemctlArgs(manager: "systemd" | "systemd-user", ...rest: string[]): string[] {
  return manager === "systemd-user" ? ["--user", ...rest] : rest;
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
    const manager = await detectServiceManager();
    switch (manager) {
      case "systemd":
      case "systemd-user": {
        const scope = manager === "systemd-user" ? "systemd (user scope)" : "systemd";
        info(`Starting daemon via ${scope}...`);
        await exec("systemctl", systemctlArgs(manager, "start", "comis"), { timeout: 10_000 });
        success("Daemon started");
        return;
      }
      case "pm2": {
        info("Starting daemon via pm2...");
        await exec("pm2", ["start", "comis"], { timeout: 10_000 });
        success("Daemon started");
        return;
      }
      case "direct": {
        await startDirectMode();
        return;
      }
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
    const manager = await detectServiceManager();
    switch (manager) {
      case "systemd":
      case "systemd-user": {
        const scope = manager === "systemd-user" ? "systemd (user scope)" : "systemd";
        info(`Stopping daemon via ${scope}...`);
        await exec("systemctl", systemctlArgs(manager, "stop", "comis"), { timeout: 15_000 });
        success("Daemon stopped");
        return;
      }
      case "pm2": {
        info("Stopping daemon via pm2...");
        await exec("pm2", ["stop", "comis"], { timeout: 15_000 });
        success("Daemon stopped");
        return;
      }
      case "direct": {
        await stopDirectMode();
        return;
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    error(`Failed to stop daemon: ${msg}`);
    process.exit(1);
  }
}

/** Stop the daemon that was started via direct-spawn. */
async function stopDirectMode(): Promise<void> {
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

  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) {
      removePidFile();
      success("Daemon stopped");
      return;
    }
    await new Promise((r) => setTimeout(r, 200));
  }

  warn("Daemon did not stop gracefully, sending SIGKILL...");
  process.kill(pid, "SIGKILL");
  removePidFile();
  success("Daemon killed");
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

/** Try to describe daemon status via systemd. */
async function trySystemdStatus(scope: "systemd" | "systemd-user"): Promise<boolean> {
  try {
    const { stdout } = await exec(
      "systemctl",
      systemctlArgs(scope, "is-active", "comis"),
      { timeout: 5_000 },
    );
    const status = stdout.trim();
    const label = scope === "systemd-user" ? "systemd (user)" : "systemd";
    if (status === "active") {
      success(`Daemon is running (${label})`);
      try {
        const { stdout: showOut } = await exec(
          "systemctl",
          systemctlArgs(scope, "show", "comis", "--property=ActiveEnterTimestamp,MainPID", "--no-pager"),
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
      warn(`Daemon status (${label}): ${status}`);
    }
    return true;
  } catch {
    return false;
  }
}

/** Try to describe daemon status via pm2. */
async function tryPm2Status(): Promise<boolean> {
  try {
    const { stdout } = await exec("pm2", ["jlist"], { timeout: 5_000 });
    const parsed = JSON.parse(stdout) as Array<{
      name?: string;
      pid?: number;
      pm2_env?: { status?: string; pm_uptime?: number; restart_time?: number };
    }>;
    const entry = parsed.find((p) => p.name === "comis");
    if (!entry) return false;

    const status = entry.pm2_env?.status ?? "unknown";
    if (status === "online") {
      success("Daemon is running (pm2)");
    } else {
      warn(`Daemon status (pm2): ${status}`);
    }
    const pairs: [string, string][] = [];
    if (entry.pid) pairs.push(["PID", String(entry.pid)]);
    if (entry.pm2_env?.pm_uptime) pairs.push(["Since", new Date(entry.pm2_env.pm_uptime).toISOString()]);
    if (typeof entry.pm2_env?.restart_time === "number") {
      pairs.push(["Restarts", String(entry.pm2_env.restart_time)]);
    }
    if (pairs.length > 0) renderKeyValue(pairs);
    return true;
  } catch {
    return false;
  }
}

/** Handle the `daemon status` subcommand. */
async function handleDaemonStatus(): Promise<void> {
  // Try RPC first for detailed info — works regardless of supervisor
  if (await tryRpcStatus()) return;

  const manager = await detectServiceManager();
  switch (manager) {
    case "systemd":
    case "systemd-user":
      if (await trySystemdStatus(manager)) return;
      break;
    case "pm2":
      if (await tryPm2Status()) return;
      break;
    case "direct":
      break;
  }

  // Fall back to PID file check
  const pid = readPidFile();
  if (pid && isProcessAlive(pid)) {
    success(`Daemon is running (direct, PID: ${pid})`);
    renderKeyValue([["PID", String(pid)]]);
  } else {
    if (pid) removePidFile();
    warn("Daemon is not running");
  }
}

/** Handle the `daemon logs` subcommand. */
async function handleDaemonLogs(options: { follow?: boolean; lines: string }): Promise<void> {
  try {
    const manager = await detectServiceManager();
    switch (manager) {
      case "systemd":
      case "systemd-user":
        await streamSystemdLogs(manager, options);
        return;
      case "pm2":
        streamPm2Logs(options);
        return;
      case "direct":
        await streamDirectLogs(options);
        return;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    error(`Failed to read logs: ${msg}`);
    process.exit(1);
  }
}

async function streamSystemdLogs(
  scope: "systemd" | "systemd-user",
  options: { follow?: boolean; lines: string },
): Promise<void> {
  const args = ["--unit=comis", "--no-pager", `-n${options.lines}`];
  if (scope === "systemd-user") args.push("--user");
  if (options.follow) {
    args.push("--follow");
    const child = spawn("journalctl", args, { stdio: "inherit" });
    child.on("error", (err) => {
      error(`Failed to read logs: ${err.message}`);
      process.exit(1);
    });
    return;
  }
  const { stdout } = await exec("journalctl", args, { timeout: 10_000 });
  if (stdout.trim()) {
    console.log(stdout);
  } else {
    info("No logs found");
  }
}

function streamPm2Logs(options: { follow?: boolean; lines: string }): void {
  const args = ["logs", "comis", "--lines", options.lines];
  if (!options.follow) args.push("--nostream");
  const child = spawn("pm2", args, { stdio: "inherit" });
  child.on("error", (err) => {
    error(`Failed to read logs: ${err.message}`);
    process.exit(1);
  });
}

async function streamDirectLogs(options: { follow?: boolean; lines: string }): Promise<void> {
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
    return;
  }
  const { stdout } = await exec("tail", args, { timeout: 5_000 });
  if (stdout.trim()) {
    console.log(stdout);
  } else {
    info("No logs found");
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
