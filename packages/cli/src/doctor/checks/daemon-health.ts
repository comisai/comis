/**
 * Daemon health check for comis doctor.
 *
 * Verifies that the daemon process is running by reading the PID file
 * and checking if the process is alive. Reports repairable findings
 * for stale PID files.
 *
 * @module
 */

import { readFileSync } from "node:fs";
import type { DoctorCheck, DoctorFinding } from "../types.js";

const CATEGORY = "daemon";

/**
 * Doctor check: daemon process health.
 *
 * Reads the PID file, verifies the process is alive, and reports
 * stale PID files as repairable.
 */
export const daemonHealthCheck: DoctorCheck = {
  id: "daemon-health",
  name: "Daemon",
  run: async (context) => {
    const findings: DoctorFinding[] = [];

    // Read PID from file
    let pidContent: string;
    try {
      pidContent = readFileSync(context.daemonPidFile, "utf-8").trim();
    } catch {
      findings.push({
        category: CATEGORY,
        check: "PID file",
        status: "warn",
        message: "Daemon PID file not found",
        suggestion: "Start the daemon: comis daemon start",
        repairable: false,
      });
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
    try {
      process.kill(pid, 0);
    } catch {
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
