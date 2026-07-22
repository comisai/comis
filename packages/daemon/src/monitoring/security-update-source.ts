// SPDX-License-Identifier: Apache-2.0
/** Content-free operating-system security-update monitoring adapter. */
import type { ClockPort, SecurityUpdateMonitorConfig } from "@comis/core";
import type { HeartbeatSourcePort } from "@comis/scheduler";
import { err, ok } from "@comis/shared";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { envWithoutSystemdNotify } from "./exec-helpers.js";

const execFile = promisify(execFileCb);
const SOURCE_ID = "monitor_security_updates";
const EXEC_TIMEOUT_MS = 30_000;
type PackageManager = "apt" | "dnf" | "yum";

async function detectPackageManager(signal: AbortSignal): Promise<PackageManager | null> {
  for (const executable of ["apt-get", "dnf", "yum"] as const) {
    if (signal.aborted) return null;
    try {
      await execFile("which", [executable], { timeout: 5_000, env: envWithoutSystemdNotify(), signal });
      return executable === "apt-get" ? "apt" : executable;
    } catch {
      // Try the next supported manager.
    }
  }
  return null;
}

async function checkApt(
  securityOnly: boolean,
  signal: AbortSignal,
): Promise<{ count: number; securityCount: number }> {
  const { stdout } = await execFile("apt-get", ["-s", "upgrade"], {
    timeout: EXEC_TIMEOUT_MS,
    env: envWithoutSystemdNotify(),
    signal,
  });
  const upgradeMatch = stdout.match(/^(\d+)\s+upgraded/m);
  const totalCount = upgradeMatch ? Number.parseInt(upgradeMatch[1]!, 10) : 0;
  const securityCount = stdout.split("\n")
    .filter((line) => line.startsWith("Inst ") && /security/i.test(line)).length;
  return { count: securityOnly ? securityCount : totalCount, securityCount };
}

async function checkDnf(
  manager: "dnf" | "yum",
  securityOnly: boolean,
  signal: AbortSignal,
): Promise<{ count: number; securityCount: number }> {
  try {
    const { stdout } = await execFile(
      manager,
      securityOnly ? ["check-update", "--security"] : ["check-update"],
      { timeout: EXEC_TIMEOUT_MS, env: envWithoutSystemdNotify(), signal },
    );
    const count = stdout.trim().split("\n").filter((line) => line.trim().length > 0).length;
    return { count, securityCount: count };
  } catch (error: unknown) {
    if (error && typeof error === "object" && "code" in error && error.code === 100) {
      const stdout = "stdout" in error ? String(error.stdout) : "";
      const count = stdout.trim().split("\n").filter((line) => line.trim().length > 0).length;
      return { count, securityCount: count };
    }
    throw error;
  }
}

export function createSecurityUpdateSource(
  config: SecurityUpdateMonitorConfig,
  clock: ClockPort,
): HeartbeatSourcePort {
  return {
    id: SOURCE_ID,
    async check(signal) {
      if (signal.aborted) return err({ code: "cancelled", errorKind: "timeout" });
      const manager = await detectPackageManager(signal);
      if (signal.aborted) return err({ code: "cancelled", errorKind: "timeout" });
      if (manager === null) {
        return ok({
          level: "ok",
          observedAtMs: clock.now(),
          code: "package_manager_unavailable",
          counters: [],
        });
      }
      let result: { count: number; securityCount: number };
      try {
        result = manager === "apt"
          ? await checkApt(config.securityOnly, signal)
          : await checkDnf(manager, config.securityOnly, signal);
      } catch {
        return err({
          code: signal.aborted ? "cancelled" : "package_query_failed",
          errorKind: signal.aborted ? "timeout" : "dependency",
        });
      }
      return ok({
        level: result.count > 0 ? "critical" : "ok",
        observedAtMs: clock.now(),
        code: result.count > 0 ? "security_updates_pending" : "security_updates_current",
        counters: [
          { name: "updates_pending", value: result.count },
          { name: "security_updates_pending", value: result.securityCount },
        ],
      });
    },
  };
}
