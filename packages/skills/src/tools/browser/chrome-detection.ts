// SPDX-License-Identifier: Apache-2.0
/**
 * Chrome executable detection and process management.
 *
 * Finds installed Chrome/Chromium binaries on Linux and macOS, then
 * launches Chrome with the --remote-debugging-port flag for CDP access.
 *
 * Ported from Comis browser/chrome.executables.ts + chrome.ts,
 * stripped of Windows support, extension relay, and profile decoration.
 *
 * @module
 */

import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import type { BrowserConfig } from "./config.js";
import { DEFAULT_CDP_PORT, DEFAULT_BROWSER_PROFILE } from "./constants.js";

// ── Types ────────────────────────────────────────────────────────────

export type BrowserExecutable = {
  kind: "chrome" | "chromium" | "brave" | "edge" | "canary" | "custom";
  path: string;
};

export type RunningChrome = {
  pid: number;
  exe: BrowserExecutable;
  userDataDir: string;
  cdpPort: number;
  startedAt: number;
  proc: ChildProcessWithoutNullStreams;
};

// ── Chrome Detection ─────────────────────────────────────────────────

function exists(filePath: string): boolean {
  try {
    return fs.existsSync(filePath);
  } catch {
    return false;
  }
}

function findFirstExecutable(
  candidates: BrowserExecutable[],
): BrowserExecutable | null {
  for (const candidate of candidates) {
    if (exists(candidate.path)) {
      return candidate;
    }
  }
  return null;
}

/** Find Chrome on macOS. */
function findChromeMac(): BrowserExecutable | null {
  const home = os.homedir();
  const candidates: BrowserExecutable[] = [
    {
      kind: "chrome",
      path: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    },
    {
      kind: "chrome",
      path: `${home}/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`,
    },
    {
      kind: "brave",
      path: "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    },
    {
      kind: "brave",
      path: `${home}/Applications/Brave Browser.app/Contents/MacOS/Brave Browser`,
    },
    {
      kind: "edge",
      path: "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    },
    {
      kind: "edge",
      path: `${home}/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge`,
    },
    {
      kind: "chromium",
      path: "/Applications/Chromium.app/Contents/MacOS/Chromium",
    },
    {
      kind: "chromium",
      path: `${home}/Applications/Chromium.app/Contents/MacOS/Chromium`,
    },
    {
      kind: "canary",
      path: "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
    },
    {
      kind: "canary",
      path: `${home}/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary`,
    },
  ];
  return findFirstExecutable(candidates);
}

/** Find Chrome on Linux. */
function findChromeLinux(): BrowserExecutable | null {
  const candidates: BrowserExecutable[] = [
    { kind: "chrome", path: "/usr/bin/google-chrome" },
    { kind: "chrome", path: "/usr/bin/google-chrome-stable" },
    { kind: "chrome", path: "/usr/bin/chrome" },
    { kind: "brave", path: "/usr/bin/brave-browser" },
    { kind: "brave", path: "/usr/bin/brave-browser-stable" },
    { kind: "brave", path: "/usr/bin/brave" },
    { kind: "brave", path: "/snap/bin/brave" },
    { kind: "edge", path: "/usr/bin/microsoft-edge" },
    { kind: "edge", path: "/usr/bin/microsoft-edge-stable" },
    { kind: "chromium", path: "/usr/bin/chromium" },
    { kind: "chromium", path: "/usr/bin/chromium-browser" },
    { kind: "chromium", path: "/snap/bin/chromium" },
  ];
  return findFirstExecutable(candidates);
}

/**
 * Find an installed Chrome/Chromium executable.
 *
 * Checks custom path first (from config), then standard OS locations.
 * Returns null if no browser is found.
 */
export function findChrome(
  chromePath?: string,
): BrowserExecutable | null {
  if (chromePath) {
    if (!exists(chromePath)) {
      return null;
    }
    return { kind: "custom", path: chromePath };
  }

  const platform = process.platform;
  if (platform === "darwin") return findChromeMac();
  if (platform === "linux") return findChromeLinux();
  return null;
}

// ── Chrome Launcher ──────────────────────────────────────────────────

/**
 * Resolve user data directory for the browser profile.
 */
function resolveUserDataDir(profileName: string): string {
  const configDir =
    // eslint-disable-next-line no-restricted-syntax -- XDG standard directory detection, not secret access
    process.env["XDG_CONFIG_HOME"] || `${os.homedir()}/.config`;
  return `${configDir}/comis/browser/${profileName}/user-data`;
}

/**
 * Check if Chrome is reachable at the given CDP URL.
 */
async function isChromeReachable(
  cdpUrl: string,
  timeoutMs = 500,
): Promise<boolean> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${cdpUrl}/json/version`, {
      signal: ctrl.signal,
    });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(t);
  }
}

/**
 * Launch Chrome with CDP remote debugging enabled.
 *
 * @returns A RunningChrome handle for process management.
 * @throws If no browser executable is found or Chrome fails to start.
 */
export async function launchChrome(
  config: BrowserConfig,
  spawnEnv?: Record<string, string>,  // filtered env for Chrome subprocess
): Promise<RunningChrome> {
  const exe = findChrome(config.chromePath);
  if (!exe) {
    throw new Error(
      "No supported browser found (Chrome/Brave/Edge/Chromium on macOS or Linux).",
    );
  }

  const cdpPort = config.cdpPort ?? DEFAULT_CDP_PORT;
  const profileName = config.defaultProfile ?? DEFAULT_BROWSER_PROFILE;
  const userDataDir = resolveUserDataDir(profileName);

  fs.mkdirSync(userDataDir, { recursive: true });

  const args: string[] = [
    `--remote-debugging-port=${cdpPort}`,
    `--user-data-dir=${userDataDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-sync",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-features=Translate,MediaRouter",
    "--disable-session-crashed-bubble",
    "--hide-crash-restore-bubble",
    "--password-store=basic",
  ];

  if (config.headless !== false) {
    args.push("--headless=new");
    args.push("--disable-gpu");
  }
  if (config.noSandbox) {
    args.push("--no-sandbox");
    args.push("--disable-setuid-sandbox");
  }
  if (process.platform === "linux") {
    args.push("--disable-dev-shm-usage");
  }
  if (config.viewport) {
    args.push(
      `--window-size=${config.viewport.width},${config.viewport.height}`,
    );
  }

  // Always open a blank tab to ensure a target exists.
  args.push("about:blank");

  const startedAt = Date.now();

  // Use filtered env instead of raw process.env
  const chromeEnv = spawnEnv
    ? { ...spawnEnv, HOME: os.homedir() }
    // eslint-disable-next-line no-restricted-syntax -- PATH for subprocess spawn, not secret access (fallback when no spawnEnv provided)
    : { PATH: process.env["PATH"] ?? "", HOME: os.homedir() };

  const proc = spawn(exe.path, args, {
    stdio: "pipe",
    env: chromeEnv,
  });

  // Wait for CDP to become reachable.
  const cdpUrl = `http://127.0.0.1:${cdpPort}`;
  const readyDeadline = Date.now() + 15_000;
  while (Date.now() < readyDeadline) {
    if (await isChromeReachable(cdpUrl, 500)) {
      break;
    }
    await new Promise((r) => setTimeout(r, 200));
  }

  if (!(await isChromeReachable(cdpUrl, 500))) {
    try {
      proc.kill("SIGKILL");
    } catch {
      // ignore
    }
    throw new Error(
      `Failed to start Chrome CDP on port ${cdpPort} for profile "${profileName}".`,
    );
  }

  return {
    pid: proc.pid ?? -1,
    exe,
    userDataDir,
    cdpPort,
    startedAt,
    proc,
  };
}

/**
 * Stop a running Chrome process.
 *
 * Sends SIGTERM first, then SIGKILL after timeout.
 */
export async function stopChrome(
  running: RunningChrome,
  timeoutMs = 2500,
): Promise<void> {
  const proc = running.proc;
  if (proc.killed || proc.exitCode !== null) return;

  try {
    proc.kill("SIGTERM");
  } catch {
    // ignore
  }

  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (proc.exitCode !== null || proc.killed) return;
    await new Promise((r) => setTimeout(r, 100));
  }

  try {
    proc.kill("SIGKILL");
  } catch {
    // ignore
  }
}
