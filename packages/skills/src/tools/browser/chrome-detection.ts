// SPDX-License-Identifier: Apache-2.0
// @allow-throw: browser/playwright SDK boundary wrapper; throws caught by AgentTool wrapper (browser-action-tool) — agent execution boundary catch.
/**
 * Chrome executable detection and process management.
 *
 * Finds installed Chrome/Chromium binaries on Linux and macOS, then
 * launches Chrome with the --remote-debugging-port flag for CDP access.
 *
 * Scope is deliberately limited to Linux and macOS: Windows, extension
 * relay, and profile decoration are out of scope.
 *
 * @module
 */

import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import type { BrowserConfig } from "./config.js";
import { DEFAULT_CDP_PORT, DEFAULT_BROWSER_PROFILE } from "./constants.js";
import { systemClearTimeout, systemGetEnv, systemNowMs, systemSetTimeout } from "@comis/core";

// ── Types ────────────────────────────────────────────────────────────

export type BrowserExecutable = {
  kind: "chrome" | "chromium" | "brave" | "edge" | "canary" | "custom" | "cloak";
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

// Compare two CloakBrowser version-dir names ("chromium-146.0.7680.177.4")
// numerically, descending — newest first. Falls back to lexicographic on
// non-numeric segments so we never throw on a malformed dir name.
function compareCloakVersionsDesc(a: string, b: string): number {
  const norm = (s: string) =>
    s.replace(/^chromium-/, "").split(".").map((p) => {
      const n = Number(p);
      return Number.isFinite(n) ? n : p;
    });
  const av = norm(a);
  const bv = norm(b);
  const len = Math.max(av.length, bv.length);
  for (let i = 0; i < len; i++) {
    const x = av[i] ?? 0;
    const y = bv[i] ?? 0;
    if (x === y) continue;
    if (typeof x === "number" && typeof y === "number") return y - x;
    return String(y).localeCompare(String(x));
  }
  return 0;
}

/**
 * Find the CloakBrowser binary if installed.
 *
 * CloakBrowser ships its own stealth Chromium binary that auto-downloads
 * to ~/.cloakbrowser/chromium-<version>/ when `npx cloakbrowser install`
 * runs. We prefer it over stock Chrome when present — the user (or the
 * installer's --with-cloakbrowser flag) put it there deliberately.
 *
 * Layout differs per platform:
 *   Linux:  ~/.cloakbrowser/chromium-<version>/chrome
 *   macOS:  ~/.cloakbrowser/chromium-<version>/Chromium.app/Contents/MacOS/Chromium
 *
 * Multiple versions may coexist (auto-update keeps the previous one as a
 * fallback) — pick the newest.
 */
function findCloakBrowser(): BrowserExecutable | null {
  const root = `${os.homedir()}/.cloakbrowser`;
  if (!exists(root)) return null;
  let entries: string[];
  try {
    entries = fs.readdirSync(root);
  } catch {
    return null;
  }
  const versions = entries
    .filter((name) => name.startsWith("chromium-"))
    .sort(compareCloakVersionsDesc);
  const isMac = process.platform === "darwin";
  for (const v of versions) {
    const binPath = isMac
      ? `${root}/${v}/Chromium.app/Contents/MacOS/Chromium`
      : `${root}/${v}/chrome`;
    if (exists(binPath)) {
      return { kind: "cloak", path: binPath };
    }
  }
  return null;
}

/**
 * Find an installed Chrome/Chromium executable.
 *
 * Resolution order:
 *   1. Explicit chromePath from config (operator override).
 *   2. CloakBrowser binary at ~/.cloakbrowser/ if present (stealth wins
 *      when the user installed it deliberately).
 *   3. Stock Chrome / Brave / Edge / Chromium per platform.
 *
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

  const cloak = findCloakBrowser();
  if (cloak) return cloak;

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
    systemGetEnv("XDG_CONFIG_HOME") || `${os.homedir()}/.config`;
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
  const t = systemSetTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${cdpUrl}/json/version`, {
      signal: ctrl.signal,
    });
    return res.ok;
  } catch {
    return false;
  } finally {
    systemClearTimeout(t);
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

  const startedAt = systemNowMs();

  // Use filtered env instead of raw process.env
  const chromeEnv = spawnEnv
    ? { ...spawnEnv, HOME: os.homedir() }
    : { PATH: systemGetEnv("PATH") ?? "", HOME: os.homedir() };

  const proc = spawn(exe.path, args, {
    stdio: "pipe",
    env: chromeEnv,
  });

  // Wait for CDP to become reachable.
  const cdpUrl = `http://127.0.0.1:${cdpPort}`;
  const readyDeadline = systemNowMs() + 15_000;
  while (systemNowMs() < readyDeadline) {
    if (await isChromeReachable(cdpUrl, 500)) {
      break;
    }
    await new Promise<void>((r) => systemSetTimeout(() => r(), 200));
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

  const start = systemNowMs();
  while (systemNowMs() - start < timeoutMs) {
    if (proc.exitCode !== null || proc.killed) return;
    await new Promise<void>((r) => systemSetTimeout(() => r(), 100));
  }

  try {
    proc.kill("SIGKILL");
  } catch {
    // ignore
  }
}
