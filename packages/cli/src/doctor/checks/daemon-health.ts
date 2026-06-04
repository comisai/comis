// SPDX-License-Identifier: Apache-2.0
/**
 * Daemon health check for comis doctor.
 *
 * Verifies that the daemon process is running. Two files can record a live
 * daemon's PID:
 *   - `daemon.pid`   — written by the CLI launcher (`comis daemon start`).
 *   - `.daemon.lock` — written by the daemon itself on every boot
 *     (`acquireDataDirLock` in @comis/daemon). This is the ONLY signal present
 *     for a systemd / pm2 / direct-`node` daemon — the production path the
 *     installer sets up, which never goes through the CLI launcher.
 *
 * The check prefers `daemon.pid` (preserving its repairable stale-file
 * semantics) and falls back to the daemon's authoritative `.daemon.lock`, so a
 * service-managed daemon is correctly reported as running instead of "not
 * found".
 *
 * @module
 */

import { readFileSync } from "node:fs";
import type { DoctorCheck, DoctorFinding } from "../types.js";

const CATEGORY = "daemon";

/**
 * Filename of the daemon's data-dir singleton lock. Mirrors `LOCK_FILE` in
 * `@comis/daemon` (`src/wiring/data-dir-lock.ts`); kept as a local constant to
 * avoid a cli → daemon package import edge (the build is cycle-sensitive).
 */
const DAEMON_LOCK_FILE = ".daemon.lock";

/** Standard "no running daemon detected" finding (shared by both file paths). */
function pidFileNotFoundFinding(): DoctorFinding {
  return {
    category: CATEGORY,
    check: "PID file",
    status: "warn",
    message: "Daemon PID file not found",
    suggestion: "Start the daemon: comis daemon start",
    repairable: false,
  };
}

/**
 * Returns true if the given PID is alive.
 * - process.kill(pid, 0) succeeds → alive.
 * - throws EPERM → alive (process exists, we lack permission to signal it).
 * - throws otherwise (ESRCH) → dead.
 */
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Read and trim a PID file; undefined when the file is absent/unreadable. */
function readPidFile(path: string): string | undefined {
  try {
    return readFileSync(path, "utf-8").trim();
  } catch {
    return undefined;
  }
}

/**
 * Fallback detection via the daemon's authoritative `.daemon.lock`.
 *
 * Returns a "pass" finding when the lock holds a live PID; otherwise the
 * standard "PID file not found" warn. A stale lock is NOT reported as
 * doctor-repairable because the daemon self-heals it on its next boot
 * (`acquireDataDirLock` unlinks a dead-PID lock and retries).
 */
function detectViaDaemonLock(dataDir: string): DoctorFinding {
  const lockContent = readPidFile(dataDir + "/" + DAEMON_LOCK_FILE);
  if (lockContent === undefined) {
    return pidFileNotFoundFinding();
  }
  const pid = Number(lockContent);
  if (Number.isInteger(pid) && pid > 0 && isPidAlive(pid)) {
    return {
      category: CATEGORY,
      check: "Process alive",
      status: "pass",
      message: `Daemon is running (PID: ${pid})`,
      repairable: false,
    };
  }
  return pidFileNotFoundFinding();
}

/**
 * Doctor check: daemon process health.
 *
 * Reads the PID file (or the daemon's lock), verifies the process is alive,
 * and reports stale `daemon.pid` files as repairable.
 */
export const daemonHealthCheck: DoctorCheck = {
  id: "daemon-health",
  name: "Daemon",
  run: async (context) => {
    const findings: DoctorFinding[] = [];

    // CLI-launcher pid file first — preserves its repairable stale-file
    // semantics for `comis daemon start`-managed daemons.
    const pidContent = readPidFile(context.daemonPidFile);

    if (pidContent === undefined) {
      // No daemon.pid: a systemd / pm2 / direct-`node` daemon writes only
      // <dataDir>/.daemon.lock. Consult it before declaring the daemon down.
      findings.push(detectViaDaemonLock(context.dataDir));
      return findings;
    }

    const pid = Number(pidContent);
    if (!Number.isInteger(pid) || pid <= 0) {
      findings.push({
        category: CATEGORY,
        check: "PID file",
        status: "warn",
        message: "Daemon PID file contains invalid value",
        suggestion: "Start the daemon: comis daemon start",
        repairable: false,
      });
      return findings;
    }

    // Check if process is alive
    if (!isPidAlive(pid)) {
      // Process is not alive -- stale PID file
      findings.push({
        category: CATEGORY,
        check: "Process alive",
        status: "fail",
        message: `Stale PID file (PID: ${pid} is not running)`,
        suggestion: "Stale PID file -- repair will remove it",
        repairable: true,
      });
      return findings;
    }

    findings.push({
      category: CATEGORY,
      check: "Process alive",
      status: "pass",
      message: `Daemon is running (PID: ${pid})`,
      repairable: false,
    });

    return findings;
  },
};
