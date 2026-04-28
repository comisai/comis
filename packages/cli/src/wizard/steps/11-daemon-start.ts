// SPDX-License-Identifier: Apache-2.0
/**
 * Daemon auto-start step -- step 11 of the init wizard.
 *
 * Offers to start the Comis daemon after config write, spawns it
 * as a detached process if accepted, polls the health endpoint for
 * readiness, and runs subsystem health checks with per-failure fix
 * guidance.
 *
 * This is the biggest UX win of the redesign: users get immediate
 * feedback on whether their setup works, plus actionable guidance
 * when it does not.
 *
 * @module
 */

import { execFile, spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  writeFileSync,
  openSync,
  closeSync,
  accessSync,
  constants as fsConstants,
} from "node:fs";
import * as os from "node:os";
import { promisify } from "node:util";
import { safePath } from "@comis/core";

const exec = promisify(execFile);
import type {
  WizardState,
  WizardStep,
  WizardPrompter,
  Spinner,
} from "../index.js";
import {
  updateState,
  sectionSeparator,
  success as themeSuccess,
  error as themeError,
} from "../index.js";

// ---------- Constants ----------

/** Max time to wait for daemon gateway to become ready (ms). */
const READY_TIMEOUT_MS = 15_000;
/** Interval between readiness polls (ms). */
const READY_POLL_MS = 500;

// ---------- Types ----------

/** Result of a single health check. */
type CheckResult = {
  name: string;
  passed: boolean;
  detail: string;
  fix?: string;
};

// ---------- Helpers ----------

/**
 * Resolve the gateway host and port from wizard state.
 *
 * Falls back to 127.0.0.1:4766 when gateway config is absent.
 */
function resolveGateway(state: WizardState): { host: string; port: number } {
  if (!state.gateway) {
    return { host: "127.0.0.1", port: 4766 };
  }

  let host: string;
  switch (state.gateway.bindMode) {
    case "loopback":
      host = "127.0.0.1";
      break;
    case "lan":
      // When bound to 0.0.0.0, health check should use localhost
      host = "127.0.0.1";
      break;
    case "custom":
      host = state.gateway.customIp ?? "127.0.0.1";
      break;
    default:
      host = "127.0.0.1";
  }

  return { host, port: state.gateway.port };
}

/**
 * Poll the daemon health endpoint until it responds or timeout expires.
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
 * Poll the gateway through a stop/start cycle.
 *
 * Used after signalling the in-container daemon for a Docker-managed
 * restart: first waits for the gateway to go down (proving the signal
 * landed and the container is exiting), then for a fresh gateway to
 * come back (proving Docker's restart policy respawned the container).
 * Returns false if either phase times out.
 */
async function waitForRestart(host: string, port: number): Promise<boolean> {
  const url = `http://${host}:${port}/health`;
  const probe = async (): Promise<boolean> => {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 1500);
      const res = await fetch(url, { signal: controller.signal });
      clearTimeout(timer);
      return res.ok;
    } catch {
      return false;
    }
  };

  // Phase 1: wait for the gateway to disappear (signal landed).
  const downDeadline = Date.now() + 5_000;
  while (Date.now() < downDeadline) {
    if (!(await probe())) break;
    await new Promise((r) => setTimeout(r, READY_POLL_MS));
  }

  // Phase 2: wait for the gateway to come back (container restarted).
  const upDeadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < upDeadline) {
    if (await probe()) return true;
    await new Promise((r) => setTimeout(r, READY_POLL_MS));
  }
  return false;
}

/**
 * Run subsystem health checks and display results.
 *
 * Checks: gateway, API provider, configured channels, memory/data dir.
 * All checks are best-effort -- failures are warnings, not blockers.
 */
async function runHealthCheck(
  state: WizardState,
  prompter: WizardPrompter,
  gatewayHost: string,
  gatewayPort: number,
): Promise<void> {
  const checks: CheckResult[] = [];

  // 1. Gateway check
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(`http://${gatewayHost}:${gatewayPort}/health`, {
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (res.ok) {
      checks.push({
        name: "Gateway",
        passed: true,
        detail: `responding on ${gatewayHost}:${gatewayPort}`,
      });
    } else {
      checks.push({
        name: "Gateway",
        passed: false,
        detail: `returned status ${res.status}`,
        fix: "Check gateway config in ~/.comis/config.yaml",
      });
    }
  } catch {
    checks.push({
      name: "Gateway",
      passed: false,
      detail: "not responding",
      fix: "Check gateway config in ~/.comis/config.yaml",
    });
  }

  // 2. API provider check (trust daemon health -- it validates provider on startup)
  if (state.provider?.id) {
    // If gateway responded OK, assume API provider is reachable
    const gatewayPassed = checks[0]?.passed ?? false;
    if (gatewayPassed) {
      checks.push({
        name: "API provider",
        passed: true,
        detail: state.provider.id,
      });
    } else {
      checks.push({
        name: "API provider",
        passed: false,
        detail: `${state.provider.id} (cannot verify -- gateway not responding)`,
        fix: `Verify API key with 'comis configure --section provider'`,
      });
    }
  }

  // 3. Channel checks (cannot verify connections from outside daemon, report as configured)
  if (state.channels && state.channels.length > 0) {
    for (const channel of state.channels) {
      checks.push({
        name: channel.type,
        passed: true,
        detail: "configured",
      });
    }
  }

  // 4. Memory/data dir check
  const dataDir = state.dataDir ?? safePath(os.homedir(), ".comis", "data");
  try {
    if (existsSync(dataDir)) {
      accessSync(dataDir, fsConstants.W_OK);
      checks.push({
        name: "Memory database",
        passed: true,
        detail: dataDir,
      });
    } else {
      // Directory will be created by the daemon on first run
      checks.push({
        name: "Memory database",
        passed: true,
        detail: `${dataDir} (will be created)`,
      });
    }
  } catch {
    checks.push({
      name: "Memory database",
      passed: false,
      detail: `${dataDir} is not writable`,
      fix: "Check data directory permissions",
    });
  }

  // Display results
  prompter.log.info("Health check results:");
  const failures: CheckResult[] = [];

  for (const check of checks) {
    if (check.passed) {
      prompter.log.info(themeSuccess(`${check.name}: ${check.detail}`));
    } else {
      prompter.log.info(themeError(`${check.name}: ${check.detail}`));
      failures.push(check);
    }
  }

  // Show failure guidance
  if (failures.length > 0) {
    prompter.log.warn(
      `${failures.length} of ${checks.length} checks failed. Run 'comis doctor' for details.`,
    );
    for (const failure of failures) {
      if (failure.fix) {
        prompter.log.warn(`  Fix: ${failure.fix}`);
      }
    }
  }
}

// ---------- Service manager detection ----------

type ServiceManager = "systemd" | "systemd-user" | "direct";

/**
 * Detect whether we are running inside a Docker container.
 *
 * Inside a container the daemon is owned by PID 1 (dumb-init in the
 * official image), so the wizard's direct-spawn flow is wrong: signalling
 * the in-container daemon process exits PID 1 and Docker's restart policy
 * picks up the new config. Bringing up a second daemon is what produces
 * the EADDRINUSE + "comis status: offline" symptom.
 */
function isDocker(): boolean {
  return existsSync("/.dockerenv");
}

/**
 * Find the comis daemon PID inside the container.
 *
 * Scans /proc for processes whose parent is PID 1 and whose cmdline
 * contains "daemon.js". Used to signal the container's daemon for a
 * Docker-native restart instead of spawning a sibling.
 */
async function findContainerDaemonPid(): Promise<number | undefined> {
  try {
    const { readdirSync, readFileSync } = await import("node:fs");
    for (const entry of readdirSync("/proc")) {
      if (!/^\d+$/.test(entry)) continue;
      const pid = Number(entry);
      if (pid === 1 || pid === process.pid) continue;
      let cmdline: string;
      let ppid: string;
      try {
        cmdline = readFileSync(`/proc/${entry}/cmdline`, "utf-8");
        const status = readFileSync(`/proc/${entry}/status`, "utf-8");
        ppid = (/^PPid:\s*(\d+)/m.exec(status)?.[1]) ?? "";
      } catch {
        continue;
      }
      if (ppid !== "1") continue;
      if (!cmdline.includes("daemon.js")) continue;
      return pid;
    }
  } catch { /* /proc not accessible */ }
  return undefined;
}

async function detectServiceManager(): Promise<ServiceManager> {
  if (!existsSync("/run/systemd/system")) return "direct";
  try {
    const { stdout } = await exec(
      "systemctl",
      ["list-unit-files", "comis.service", "--no-pager", "--no-legend"],
      { timeout: 5_000 },
    );
    if (stdout.includes("comis.service")) return "systemd";
  } catch { /* not available */ }
  try {
    const { stdout } = await exec(
      "systemctl",
      ["--user", "list-unit-files", "comis.service", "--no-pager", "--no-legend"],
      { timeout: 5_000 },
    );
    if (stdout.includes("comis.service")) return "systemd-user";
  } catch { /* not available */ }
  return "direct";
}

async function restartViaSystemd(manager: "systemd" | "systemd-user"): Promise<boolean> {
  try {
    const args = manager === "systemd-user"
      ? ["--user", "restart", "comis"]
      : ["restart", "comis"];
    if (manager === "systemd" && process.getuid?.() !== 0) {
      await exec("sudo", ["systemctl", ...args], { timeout: 15_000 });
    } else {
      await exec("systemctl", args, { timeout: 15_000 });
    }
    return true;
  } catch {
    // sudo failed (comis user has no sudo) — fall back to SIGUSR2.
    // The daemon traps SIGUSR2 and exits with code 42; systemd respawns
    // it via RestartForceExitStatus=42, picking up the new config.
    return restartViaSigusr2(manager);
  }
}

async function restartViaSigusr2(manager: "systemd" | "systemd-user"): Promise<boolean> {
  try {
    const pidArgs = manager === "systemd-user"
      ? ["--user", "show", "comis", "--property=MainPID", "--value"]
      : ["show", "comis", "--property=MainPID", "--value"];
    const { stdout } = await exec("systemctl", pidArgs, { timeout: 5_000 });
    const pid = Number(stdout.trim());
    if (isNaN(pid) || pid <= 0) return false;
    process.kill(pid, "SIGUSR2");
    // Wait for systemd to respawn the process
    await new Promise((r) => setTimeout(r, 3000));
    return true;
  } catch {
    return false;
  }
}

async function startViaSystemd(manager: "systemd" | "systemd-user"): Promise<boolean> {
  try {
    const args = manager === "systemd-user"
      ? ["--user", "start", "comis"]
      : ["start", "comis"];
    if (manager === "systemd" && process.getuid?.() !== 0) {
      await exec("sudo", ["systemctl", ...args], { timeout: 15_000 });
    } else {
      await exec("systemctl", args, { timeout: 15_000 });
    }
    return true;
  } catch {
    return false;
  }
}

// ---------- Step Implementation ----------

export const daemonStartStep: WizardStep = {
  id: "daemon-start",
  label: "Start Daemon",

  async execute(state: WizardState, prompter: WizardPrompter): Promise<WizardState> {
    prompter.note(sectionSeparator("Start Daemon"));

    // 0. Check if daemon is already running
    const { host, port } = resolveGateway(state);
    let daemonRunning = false;

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 2000);
      const res = await fetch(`http://${host}:${port}/health`, {
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (res.ok) daemonRunning = true;
    } catch {
      // Not running
    }

    const serviceManager = await detectServiceManager();

    // 1. Offer auto-start (or restart if already running)
    let choice: string;

    if (daemonRunning) {
      prompter.log.info(themeSuccess(`Daemon is running on ${host}:${port}`));

      choice = await prompter.select<string>({
        message: "Daemon is already running. What would you like to do?",
        options: [
          { value: "restart", label: "Restart (recommended)", hint: "Apply new configuration" },
          { value: "no", label: "Leave running", hint: "Config changes apply on next restart" },
        ],
      });
    } else {
      choice = await prompter.select<string>({
        message: "Start the Comis daemon now?",
        options: [
          { value: "yes", label: "Yes (recommended)" },
          { value: "no", label: "No -- I'll start it manually later" },
        ],
      });
    }

    // 2. If user declines, show manual command and move on
    if (choice === "no") {
      if (daemonRunning && serviceManager !== "direct") {
        prompter.log.info("Restart to apply changes: sudo systemctl restart comis");
      } else {
        prompter.log.info("Start later with: comis daemon start");
      }
      return updateState(state, {});
    }

    // 3. Use systemd when it owns the daemon
    if (serviceManager !== "direct") {
      const spinner: Spinner = prompter.spinner();
      const action = choice === "restart" ? "Restarting" : "Starting";
      spinner.start(`${action} daemon via systemd...`);

      const ok = choice === "restart"
        ? await restartViaSystemd(serviceManager)
        : await startViaSystemd(serviceManager);

      if (!ok) {
        spinner.stop(`Could not ${choice === "restart" ? "restart" : "start"} via systemd`);
        if (process.getuid?.() !== 0) {
          prompter.log.warn("Run as root: sudo systemctl restart comis");
        }
        return updateState(state, {});
      }

      const ready = await waitForReady(host, port);
      if (ready) {
        spinner.stop(`Daemon ${choice === "restart" ? "restarted" : "started"} and ready`);
      } else {
        spinner.stop(`Daemon ${choice === "restart" ? "restarted" : "started"} but gateway not yet responding`);
        prompter.log.warn("Check logs: comis daemon logs");
      }

      if (!state.skipHealth) {
        await runHealthCheck(state, prompter, host, port);
      }

      return updateState(state, {});
    }

    // 4. Direct-spawn fallback (no systemd)

    // Docker branch: the daemon is the container's PID 1 process tree.
    // Spawning a sibling produces EADDRINUSE; killing PID 1 directly via
    // pid-file (which the container daemon doesn't write) is a no-op.
    // Signal the actual daemon process so dumb-init exits and Docker's
    // restart policy brings the container back with the new config.
    if (isDocker()) {
      const dockerSpinner: Spinner = prompter.spinner();

      if (choice === "restart" || daemonRunning) {
        dockerSpinner.start("Signalling container daemon to restart...");
        const targetPid = await findContainerDaemonPid();
        if (targetPid) {
          try { process.kill(targetPid, "SIGTERM"); } catch { /* already gone */ }
          // Wait for the gateway to disappear, then for it to come back
          // (Docker restart policy respawns the container).
          const restarted = await waitForRestart(host, port);
          if (restarted) {
            dockerSpinner.stop("Daemon restarted via container restart policy");
          } else {
            dockerSpinner.stop(
              "Daemon stopped, but the container did not auto-restart",
            );
            prompter.log.warn(
              "Run `docker restart <container>` (or `docker start <container>` if it exited) to apply the new config.",
            );
            return updateState(state, {});
          }
        } else {
          dockerSpinner.stop("Could not find the container daemon process");
          prompter.log.warn(
            "Run `docker restart <container>` to apply the new configuration.",
          );
          return updateState(state, {});
        }
      } else {
        // Daemon wasn't running and we're inside a container — Docker
        // launches the daemon itself; nothing for the wizard to do here.
        dockerSpinner.start("Waiting for container daemon...");
        const ready = await waitForReady(host, port);
        dockerSpinner.stop(
          ready ? "Daemon ready" : "Daemon not yet responding",
        );
        if (!ready) {
          prompter.log.warn(
            "Start the container with `docker start <container>` if it isn't already running.",
          );
          return updateState(state, {});
        }
      }

      if (!state.skipHealth) {
        await runHealthCheck(state, prompter, host, port);
      }
      return updateState(state, {});
    }

    // Stop existing daemon before restart
    if (choice === "restart") {
      const stopSpinner: Spinner = prompter.spinner();
      stopSpinner.start("Stopping daemon...");

      try {
        const pidFile = safePath(os.homedir(), ".comis", "daemon.pid");
        if (existsSync(pidFile)) {
          const { readFileSync } = await import("node:fs");
          const pid = Number(readFileSync(pidFile, "utf-8").trim());
          if (!isNaN(pid)) {
            try { process.kill(pid, "SIGTERM"); } catch { /* already stopped */ }
            await new Promise((r) => setTimeout(r, 1500));
          }
        }
        stopSpinner.stop("Daemon stopped");
      } catch {
        stopSpinner.stop("Could not stop daemon (may already be stopped)");
      }
    }

    const spinner: Spinner = prompter.spinner();
    spinner.start("Starting daemon...");

    try {
      const daemonPath = new URL("../../../../daemon/dist/daemon.js", import.meta.url).pathname;

      if (!existsSync(daemonPath)) {
        spinner.stop("Daemon binary not found");
        prompter.log.warn("Run 'pnpm build' first, then 'comis daemon start'");
        return updateState(state, {});
      }

      const comisDir = safePath(os.homedir(), ".comis");
      const pidFile = safePath(comisDir, "daemon.pid");
      const logFile = safePath(comisDir, "daemon.log");

      mkdirSync(comisDir, { recursive: true, mode: 0o700 });

      const logFd = openSync(logFile, "a", 0o600);

      let childPid: number | undefined;
      try {
        const child = spawn("node", [daemonPath], {
          detached: true,
          stdio: ["ignore", logFd, logFd],
        });
        child.unref();
        childPid = child.pid ?? undefined;
      } finally {
        closeSync(logFd);
      }

      if (!childPid) {
        spinner.stop("Failed to start daemon: no PID returned");
        return updateState(state, {});
      }

      writeFileSync(pidFile, String(childPid));
      spinner.update(`Daemon started (PID ${childPid})`);

      const ready = await waitForReady(host, port);
      if (ready) {
        spinner.stop(`Daemon started and ready (PID ${childPid})`);
      } else {
        spinner.stop("Daemon started but gateway not yet responding");
        prompter.log.warn("Check logs: comis daemon logs");
      }

      if (!state.skipHealth) {
        await runHealthCheck(state, prompter, host, port);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      spinner.stop(`Failed to start daemon: ${msg}`);
      prompter.log.warn("You can start the daemon later with: comis daemon start");
    }

    return updateState(state, {});
  },
};
