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

import { spawn } from "node:child_process";
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
import { safePath } from "@comis/core";
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
      prompter.log.info("Start later with: comis daemon start");
      return updateState(state, {});
    }

    // 2b. Stop existing daemon before restart
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
            // Brief wait for graceful shutdown
            await new Promise((r) => setTimeout(r, 1500));
          }
        }
        stopSpinner.stop("Daemon stopped");
      } catch {
        stopSpinner.stop("Could not stop daemon (may already be stopped)");
      }
    }

    // 3. Spawn daemon
    const spinner: Spinner = prompter.spinner();
    spinner.start("Starting daemon...");

    try {
      // Resolve daemon binary path (relative to this file's location in dist/)
      const daemonPath = new URL("../../../../daemon/dist/daemon.js", import.meta.url).pathname;

      if (!existsSync(daemonPath)) {
        spinner.stop("Daemon binary not found");
        prompter.log.warn("Run 'pnpm build' first, then 'comis daemon start'");
        return updateState(state, {});
      }

      // Determine paths using safePath (matching daemon.ts pattern)
      const comisDir = safePath(os.homedir(), ".comis");
      const pidFile = safePath(comisDir, "daemon.pid");
      const logFile = safePath(comisDir, "daemon.log");

      // Ensure directory exists with restricted permissions
      mkdirSync(comisDir, { recursive: true, mode: 0o700 });

      // Open log file for daemon stdout/stderr
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
        // Close the file descriptor in the parent process after spawn
        closeSync(logFd);
      }

      if (!childPid) {
        spinner.stop("Failed to start daemon: no PID returned");
        return updateState(state, {});
      }

      // Write PID file
      writeFileSync(pidFile, String(childPid));
      spinner.update(`Daemon started (PID ${childPid})`);

      // 4. Wait for readiness
      const ready = await waitForReady(host, port);
      if (ready) {
        spinner.stop(`Daemon started and ready (PID ${childPid})`);
      } else {
        spinner.stop("Daemon started but gateway not yet responding");
        prompter.log.warn("Check logs: comis daemon logs");
      }

      // 5. Run health check (skip if --skip-health was passed)
      if (!state.skipHealth) {
        await runHealthCheck(state, prompter, host, port);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      spinner.stop(`Failed to start daemon: ${msg}`);
      prompter.log.warn("You can start the daemon later with: comis daemon start");
    }

    // 7. Return state
    return updateState(state, {});
  },
};
