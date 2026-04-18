/**
 * systemd Service HeartbeatSourcePort implementation.
 * Monitors systemd service health by checking for failed services
 * using systemctl. Gracefully degrades when systemd is not available
 * (e.g., macOS, container environments).
 */

import type { SystemdMonitorConfig } from "@comis/core";
import type { HeartbeatSourcePort, HeartbeatCheckResult } from "@comis/scheduler";
import { HEARTBEAT_OK_TOKEN } from "@comis/scheduler";
import { execFile as execFileCb } from "node:child_process";
import { access, constants } from "node:fs/promises";
import { promisify } from "node:util";
import { envWithoutSystemdNotify } from "./exec-helpers.js";

const execFile = promisify(execFileCb);

const SOURCE_ID = "monitor:systemd-services";
const SOURCE_NAME = "systemd Service Monitor";
const EXEC_TIMEOUT_MS = 5_000;

/**
 * Check whether systemd is available on this system.
 */
async function isSystemdAvailable(): Promise<boolean> {
  try {
    // Check for /run/systemd/system directory (reliable indicator)
    await access("/run/systemd/system", constants.F_OK);
    return true;
  } catch {
    // Fallback: check if systemctl is on PATH
    try {
      await execFile("which", ["systemctl"], { timeout: EXEC_TIMEOUT_MS, env: envWithoutSystemdNotify() });
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * Get failed systemd services.
 */
async function getFailedServices(): Promise<string[]> {
  try {
    const { stdout } = await execFile("systemctl", ["--failed", "--no-legend", "--plain"], {
      timeout: EXEC_TIMEOUT_MS,
      env: envWithoutSystemdNotify(),
    });
    // Each line: "unit-name.service loaded failed failed description..."
    // Extract the service name (first field)
    return stdout
      .trim()
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => line.trim().split(/\s+/)[0] ?? line.trim());
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to query systemctl: ${msg}`, { cause: err });
  }
}

/**
 * Create a systemd service heartbeat source.
 * If systemd is not available, returns OK with a note.
 * If services array is non-empty, filters to only those services.
 */
export function createSystemdServiceSource(config: SystemdMonitorConfig): HeartbeatSourcePort {
  return {
    id: SOURCE_ID,
    name: SOURCE_NAME,

    async check(): Promise<HeartbeatCheckResult> {
      const now = Date.now();

      const available = await isSystemdAvailable();
      if (!available) {
        return {
          sourceId: SOURCE_ID,
          text: `${HEARTBEAT_OK_TOKEN} systemd not available on this system`,
          timestamp: now,
          metadata: { systemdAvailable: false },
        };
      }

      try {
        let failedServices = await getFailedServices();

        // Filter to configured services if specified
        if (config.services.length > 0) {
          const watchSet = new Set(config.services);
          failedServices = failedServices.filter((svc) => watchSet.has(svc));
        }

        if (failedServices.length > 0) {
          return {
            sourceId: SOURCE_ID,
            text: `CRITICAL: Failed systemd services: ${failedServices.join(", ")}`,
            timestamp: now,
            metadata: { failedServices },
          };
        }

        const scopeNote =
          config.services.length > 0
            ? `(watching: ${config.services.join(", ")})`
            : "(all services)";
        return {
          sourceId: SOURCE_ID,
          text: `${HEARTBEAT_OK_TOKEN} All systemd services healthy ${scopeNote}`,
          timestamp: now,
          metadata: { failedCount: 0, scope: config.services },
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          sourceId: SOURCE_ID,
          text: `systemd check error: ${msg}`,
          timestamp: now,
          metadata: { error: msg },
        };
      }
    },
  };
}
