// SPDX-License-Identifier: Apache-2.0
/** Content-free systemd service monitoring adapter. */
import type { ClockPort, SystemdMonitorConfig } from "@comis/core";
import type { HeartbeatSourcePort } from "@comis/scheduler";
import { err, ok } from "@comis/shared";
import { execFile as execFileCb } from "node:child_process";
import { access, constants } from "node:fs/promises";
import { promisify } from "node:util";
import { envWithoutSystemdNotify } from "./exec-helpers.js";

const execFile = promisify(execFileCb);
const SOURCE_ID = "monitor_systemd_services";
const EXEC_TIMEOUT_MS = 5_000;

async function isSystemdAvailable(signal: AbortSignal): Promise<boolean> {
  try {
    await access("/run/systemd/system", constants.F_OK);
    return true;
  } catch {
    if (signal.aborted) return false;
    try {
      await execFile("which", ["systemctl"], {
        timeout: EXEC_TIMEOUT_MS,
        env: envWithoutSystemdNotify(),
        signal,
      });
      return true;
    } catch {
      return false;
    }
  }
}

export function createSystemdServiceSource(
  config: SystemdMonitorConfig,
  clock: ClockPort,
): HeartbeatSourcePort {
  return {
    id: SOURCE_ID,
    async check(signal) {
      if (signal.aborted) return err({ code: "cancelled", errorKind: "timeout" });
      const available = await isSystemdAvailable(signal);
      if (signal.aborted) return err({ code: "cancelled", errorKind: "timeout" });
      if (!available) {
        return ok({
          level: "ok",
          observedAtMs: clock.now(),
          code: "systemd_unavailable",
          counters: [],
        });
      }
      let stdout: string;
      try {
        const result = await execFile("systemctl", ["--failed", "--no-legend", "--plain"], {
          timeout: EXEC_TIMEOUT_MS,
          env: envWithoutSystemdNotify(),
          signal,
        });
        stdout = result.stdout;
      } catch {
        return err({
          code: signal.aborted ? "cancelled" : "systemd_query_failed",
          errorKind: signal.aborted ? "timeout" : "dependency",
        });
      }
      const failed = stdout.trim().split("\n").filter((line) => line.trim().length > 0)
        .map((line) => line.trim().split(/\s+/)[0] ?? "")
        .filter((service) => config.services.length === 0 || config.services.includes(service));
      return ok({
        level: failed.length > 0 ? "critical" : "ok",
        observedAtMs: clock.now(),
        code: failed.length > 0 ? "systemd_services_failed" : "systemd_healthy",
        counters: [{ name: "failed_services", value: failed.length }],
      });
    },
  };
}
