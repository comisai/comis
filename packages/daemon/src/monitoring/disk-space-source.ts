// SPDX-License-Identifier: Apache-2.0
/** Content-free disk-capacity monitoring adapter. */
import type { ClockPort, DiskMonitorConfig } from "@comis/core";
import type { HeartbeatSourcePort } from "@comis/scheduler";
import { err, ok } from "@comis/shared";
import { statfs } from "node:fs/promises";

const SOURCE_ID = "monitor_disk_space";

type DiskPathResult =
  | { ok: true; usedPercent: number }
  | { ok: false };

async function checkPath(fsPath: string): Promise<DiskPathResult> {
  try {
    const stats = await statfs(fsPath);
    const totalBytes = stats.blocks * stats.bsize;
    const freeBytes = stats.bavail * stats.bsize;
    return {
      ok: true,
      usedPercent: totalBytes > 0 ? ((totalBytes - freeBytes) / totalBytes) * 100 : 0,
    };
  } catch {
    return { ok: false };
  }
}

export function createDiskSpaceSource(
  config: DiskMonitorConfig,
  clock: ClockPort,
): HeartbeatSourcePort {
  return {
    id: SOURCE_ID,
    async check(signal) {
      if (signal.aborted) return err({ code: "cancelled", errorKind: "timeout" });
      const results: DiskPathResult[] = [];
      for (const fsPath of config.paths) {
        if (signal.aborted) return err({ code: "cancelled", errorKind: "timeout" });
        results.push(await checkPath(fsPath));
      }
      if (signal.aborted) return err({ code: "cancelled", errorKind: "timeout" });
      if (results.some((result) => !result.ok)) {
        return err({ code: "stat_failed", errorKind: "resource" });
      }
      const successful = results.filter((result): result is Extract<DiskPathResult, { ok: true }> => result.ok);
      const overThreshold = successful.filter((result) => result.usedPercent > config.thresholdPercent);
      const maximumUsedPercent = successful.reduce(
        (maximum, result) => Math.max(maximum, Math.round(result.usedPercent)),
        0,
      );
      return ok({
        level: overThreshold.length > 0 ? "critical" : "ok",
        observedAtMs: clock.now(),
        code: overThreshold.length > 0 ? "disk_threshold_exceeded" : "disk_healthy",
        counters: [
          { name: "paths_checked", value: successful.length },
          { name: "over_threshold", value: overThreshold.length },
          { name: "maximum_used_percent", value: maximumUsedPercent },
        ],
      });
    },
  };
}
