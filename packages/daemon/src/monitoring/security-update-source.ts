// SPDX-License-Identifier: Apache-2.0
/**
 * Security Update HeartbeatSourcePort implementation.
 * Detects pending security updates by querying the system package
 * manager (apt-get, dnf, or yum). Gracefully degrades when no
 * supported package manager is found.
 */

import type { SecurityUpdateMonitorConfig } from "@comis/core";
import type { HeartbeatSourcePort, HeartbeatCheckResult } from "@comis/scheduler";
import { HEARTBEAT_OK_TOKEN } from "@comis/scheduler";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { envWithoutSystemdNotify } from "./exec-helpers.js";

const execFile = promisify(execFileCb);

const SOURCE_ID = "monitor:security-updates";
const SOURCE_NAME = "Security Update Monitor";
const EXEC_TIMEOUT_MS = 30_000; // package queries can be slow

type PackageManager = "apt" | "dnf" | "yum";

/**
 * Detect which package manager is available.
 */
async function detectPackageManager(): Promise<PackageManager | null> {
  for (const pm of ["apt-get", "dnf", "yum"] as const) {
    try {
      await execFile("which", [pm], { timeout: 5_000, env: envWithoutSystemdNotify() });
      return pm === "apt-get" ? "apt" : pm;
    } catch {
      // Not found, try next
    }
  }
  return null;
}

/**
 * Check for updates using apt-get simulate.
 */
async function checkApt(securityOnly: boolean): Promise<{ count: number; securityCount: number }> {
  const { stdout } = await execFile("apt-get", ["-s", "upgrade"], {
    timeout: EXEC_TIMEOUT_MS,
    env: envWithoutSystemdNotify(),
  });

  // Parse "X upgraded, Y newly installed" line
  const upgradeMatch = stdout.match(/^(\d+)\s+upgraded/m);
  const totalCount = upgradeMatch ? parseInt(upgradeMatch[1], 10) : 0;

  // Count security updates from Inst lines
  let securityCount = 0;
  const lines = stdout.split("\n");
  for (const line of lines) {
    if (line.startsWith("Inst ") && /security/i.test(line)) {
      securityCount++;
    }
  }

  return {
    count: securityOnly ? securityCount : totalCount,
    securityCount,
  };
}

/**
 * Check for updates using dnf/yum.
 */
async function checkDnf(
  pm: "dnf" | "yum",
  securityOnly: boolean,
): Promise<{ count: number; securityCount: number }> {
  try {
    const args = securityOnly ? ["check-update", "--security"] : ["check-update"];

    const { stdout } = await execFile(pm, args, {
      timeout: EXEC_TIMEOUT_MS,
      env: envWithoutSystemdNotify(),
    });

    // Count non-empty lines after the header
    const lines = stdout
      .trim()
      .split("\n")
      .filter((l) => l.trim().length > 0);
    // dnf check-update returns exit code 100 if updates available, 0 if none
    return { count: lines.length, securityCount: lines.length };
  } catch (err: unknown) {
    // Exit code 100 means updates are available (dnf convention)
    if (err && typeof err === "object" && "code" in err && (err as { code: number }).code === 100) {
      const stdout = "stdout" in err ? String((err as { stdout: string }).stdout) : "";
      const lines = stdout
        .trim()
        .split("\n")
        .filter((l) => l.trim().length > 0);
      return { count: lines.length, securityCount: lines.length };
    }
    throw err;
  }
}

/**
 * Create a security update heartbeat source.
 * Detects the system package manager and checks for pending updates.
 * Returns OK with a note if no supported package manager is found.
 */
export function createSecurityUpdateSource(
  config: SecurityUpdateMonitorConfig,
): HeartbeatSourcePort {
  return {
    id: SOURCE_ID,
    name: SOURCE_NAME,

    async check(): Promise<HeartbeatCheckResult> {
      const now = Date.now();

      try {
        const pm = await detectPackageManager();

        if (!pm) {
          return {
            sourceId: SOURCE_ID,
            text: `${HEARTBEAT_OK_TOKEN} No supported package manager detected`,
            timestamp: now,
            metadata: { packageManager: null },
          };
        }

        let result: { count: number; securityCount: number };

        if (pm === "apt") {
          result = await checkApt(config.securityOnly);
        } else {
          result = await checkDnf(pm, config.securityOnly);
        }

        if (result.count > 0) {
          const label = config.securityOnly ? "security updates" : "updates";
          return {
            sourceId: SOURCE_ID,
            text: `CRITICAL: ${result.count} pending ${label} (${result.securityCount} security)`,
            timestamp: now,
            metadata: { packageManager: pm, ...result },
          };
        }

        return {
          sourceId: SOURCE_ID,
          text: `${HEARTBEAT_OK_TOKEN} No pending ${config.securityOnly ? "security " : ""}updates (${pm})`,
          timestamp: now,
          metadata: { packageManager: pm, count: 0 },
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          sourceId: SOURCE_ID,
          text: `Security update check error: ${msg}`,
          timestamp: now,
          metadata: { error: msg },
        };
      }
    },
  };
}
