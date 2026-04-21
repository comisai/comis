// SPDX-License-Identifier: Apache-2.0
/**
 * Auto-provisioning for external tool binaries (ripgrep, fd).
 *
 * Checks system PATH first, then a local tools directory (~/.comis/bin/).
 * Downloads from GitHub releases if not found. Supports macOS/Linux
 * (x86_64 + aarch64). Respects COMIS_OFFLINE env var.
 *
 * @module
 */

import { existsSync, mkdirSync, createWriteStream, chmodSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { arch, platform, homedir } from "node:os";
import { spawnSync, execFile } from "node:child_process";
import { promisify } from "node:util";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TOOLS_DIR = join(homedir(), ".comis", "bin");
const NETWORK_TIMEOUT_MS = 10_000;
const DOWNLOAD_TIMEOUT_MS = 120_000;

// ---------------------------------------------------------------------------
// Tool registry
// ---------------------------------------------------------------------------

interface ToolConfig {
  name: string;
  repo: string;
  binaryName: string;
  tagPrefix: string;
  getAssetName: (version: string, plat: string, architecture: string) => string | null;
}

const TOOLS: Record<string, ToolConfig> = {
  rg: {
    name: "ripgrep",
    repo: "BurntSushi/ripgrep",
    binaryName: "rg",
    tagPrefix: "",
    getAssetName: (version, plat, architecture) => {
      if (plat === "darwin") {
        const archStr = architecture === "arm64" ? "aarch64" : "x86_64";
        return `ripgrep-${version}-${archStr}-apple-darwin.tar.gz`;
      }
      if (plat === "linux") {
        if (architecture === "arm64") return `ripgrep-${version}-aarch64-unknown-linux-gnu.tar.gz`;
        return `ripgrep-${version}-x86_64-unknown-linux-musl.tar.gz`;
      }
      return null;
    },
  },
  fd: {
    name: "fd",
    repo: "sharkdp/fd",
    binaryName: "fd",
    tagPrefix: "v",
    getAssetName: (version, plat, architecture) => {
      if (plat === "darwin") {
        const archStr = architecture === "arm64" ? "aarch64" : "x86_64";
        return `fd-v${version}-${archStr}-apple-darwin.tar.gz`;
      }
      if (plat === "linux") {
        const archStr = architecture === "arm64" ? "aarch64" : "x86_64";
        return `fd-v${version}-${archStr}-unknown-linux-gnu.tar.gz`;
      }
      return null;
    },
  },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Check if a command exists on the system PATH.
 *
 * @param cmd - Binary name to check
 * @returns true if the command is callable
 */
function commandExists(cmd: string): boolean {
  const result = spawnSync(cmd, ["--version"], { stdio: "pipe" });
  return result.error === undefined || result.error === null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Get the path to a tool binary, checking local tools dir first then PATH.
 *
 * @param tool - Tool key ("rg" or "fd")
 * @returns Absolute path to local binary, bare binary name if on PATH, or null
 */
export function getToolPath(tool: "rg" | "fd"): string | null {
  const config = TOOLS[tool];
  if (!config) return null;

  // Check local tools directory first
  const localPath = join(TOOLS_DIR, config.binaryName);
  if (existsSync(localPath)) return localPath;

  // Check system PATH
  if (commandExists(config.binaryName)) return config.binaryName;

  return null;
}

/**
 * Ensure a tool binary is available, downloading if necessary.
 *
 * Resolution order: local ~/.comis/bin/ -> system PATH -> download.
 * Returns undefined (never throws) on download failure or offline mode.
 *
 * @param tool - Tool key ("rg" or "fd")
 * @param logger - Optional logger for debug messages
 * @returns Path to binary, or undefined if unavailable
 */
export async function ensureTool(
  tool: "rg" | "fd",
  logger?: { debug?(msg: string, ...args: unknown[]): void },
): Promise<string | undefined> {
  const existing = getToolPath(tool);
  if (existing) return existing;

  const config = TOOLS[tool];
  if (!config) return undefined;

  // Respect offline mode
  // eslint-disable-next-line no-restricted-syntax -- ops toggle read before SecretManager is initialized
  if (process.env.COMIS_OFFLINE === "1" || process.env.COMIS_OFFLINE === "true") {
    logger?.debug?.(`${config.name} not found, offline mode enabled`);
    return undefined;
  }

  logger?.debug?.(`${config.name} not found, downloading...`);

  try {
    const path = await downloadTool(tool);
    logger?.debug?.(`${config.name} installed to ${path}`);
    return path;
  } catch (e) {
    logger?.debug?.(`Failed to download ${config.name}: ${e instanceof Error ? e.message : e}`);
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Download implementation
// ---------------------------------------------------------------------------

/**
 * Download a tool binary from GitHub releases.
 *
 * Fetches latest version from GitHub API, downloads the platform-specific
 * tar.gz asset, extracts the binary, and installs to ~/.comis/bin/.
 *
 * @param tool - Tool key ("rg" or "fd")
 * @returns Path to installed binary
 * @throws Error on download or extraction failure
 */
async function downloadTool(tool: "rg" | "fd"): Promise<string> {
  const config = TOOLS[tool];
  if (!config) throw new Error(`Unknown tool: ${tool}`);

  // 1. Resolve platform + architecture
  const plat = platform();
  const architecture = arch();
  const assetName = config.getAssetName("VERSION_PLACEHOLDER", plat, architecture);
  if (!assetName) {
    throw new Error(`Unsupported platform: ${plat}/${architecture}`);
  }

  // 2. Fetch latest version from GitHub API
  const apiUrl = `https://api.github.com/repos/${config.repo}/releases/latest`;
  const apiResponse = await fetch(apiUrl, {
    signal: AbortSignal.timeout(NETWORK_TIMEOUT_MS),
    headers: { Accept: "application/vnd.github.v3+json" },
  });
  if (!apiResponse.ok) {
    throw new Error(`GitHub API returned ${apiResponse.status}: ${await apiResponse.text()}`);
  }

  const release = (await apiResponse.json()) as { tag_name: string };
  const tagName = release.tag_name;
  const version = tagName.startsWith(config.tagPrefix)
    ? tagName.slice(config.tagPrefix.length)
    : tagName;

  // 3. Build real asset name with version
  const realAssetName = config.getAssetName(version, plat, architecture)!;
  const downloadUrl = `https://github.com/${config.repo}/releases/download/${tagName}/${realAssetName}`;

  // 4. Ensure tools directory exists
  mkdirSync(TOOLS_DIR, { recursive: true });

  // 5. Download tar.gz
  const tempTarPath = join(TOOLS_DIR, `.${config.binaryName}-download.tar.gz`);
  const tempExtractDir = join(TOOLS_DIR, `.${config.binaryName}-extract`);

  try {
    const downloadResponse = await fetch(downloadUrl, {
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    });
    if (!downloadResponse.ok) {
      throw new Error(`Download failed with ${downloadResponse.status}: ${downloadUrl}`);
    }

    // Stream to file
    const body = downloadResponse.body;
    if (!body) throw new Error("Empty response body");
    await pipeline(
      Readable.fromWeb(body as import("node:stream/web").ReadableStream),
      createWriteStream(tempTarPath),
    );

    // 6. Extract
    mkdirSync(tempExtractDir, { recursive: true });
    await execFileAsync("tar", ["-xzf", tempTarPath, "-C", tempExtractDir]);

    // 7. Find the binary in extracted directory (may be in a subdirectory)
    const assetBaseName = realAssetName.replace(/\.tar\.gz$/, "");
    const possiblePaths = [
      join(tempExtractDir, assetBaseName, config.binaryName),
      join(tempExtractDir, config.binaryName),
    ];

    let sourceBinary: string | undefined;
    for (const p of possiblePaths) {
      if (existsSync(p)) {
        sourceBinary = p;
        break;
      }
    }
    if (!sourceBinary) {
      throw new Error(`Binary ${config.binaryName} not found in extracted archive`);
    }

    // 8. Atomic install: write to .tmp, chmod +x, rename to final
    const finalPath = join(TOOLS_DIR, config.binaryName);
    const tmpPath = finalPath + ".tmp";
    renameSync(sourceBinary, tmpPath);
    chmodSync(tmpPath, 0o755);
    renameSync(tmpPath, finalPath);

    return finalPath;
  } finally {
    // Cleanup temp files
    try { rmSync(tempTarPath, { force: true }); } catch { /* best effort */ }
    try { rmSync(tempExtractDir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}
