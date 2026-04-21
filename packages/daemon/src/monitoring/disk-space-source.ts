// SPDX-License-Identifier: Apache-2.0
/**
 * Disk Space HeartbeatSourcePort implementation.
 * Monitors filesystem usage on configured paths using Node.js native
 * fs.statfs(). Alerts when any path exceeds the configured threshold.
 * Disk space monitoring.
 */

import type { DiskMonitorConfig } from "@comis/core";
import type { HeartbeatSourcePort, HeartbeatCheckResult } from "@comis/scheduler";
import { HEARTBEAT_OK_TOKEN } from "@comis/scheduler";
import { statfs } from "node:fs/promises";

const SOURCE_ID = "monitor:disk-space";
const SOURCE_NAME = "Disk Space Monitor";

interface DiskPathResult {
  path: string;
  usedPercent: number;
  totalGb: number;
  error?: string;
}

async function checkPath(fsPath: string): Promise<DiskPathResult> {
  try {
    const stats = await statfs(fsPath);
    const totalBytes = stats.blocks * stats.bsize;
    const freeBytes = stats.bavail * stats.bsize;
    const usedBytes = totalBytes - freeBytes;
    const usedPercent = totalBytes > 0 ? (usedBytes / totalBytes) * 100 : 0;
    const totalGb = totalBytes / (1024 * 1024 * 1024);
    return { path: fsPath, usedPercent, totalGb };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { path: fsPath, usedPercent: 0, totalGb: 0, error: msg };
  }
}

/**
 * Create a disk space heartbeat source.
 * Checks each configured path with fs.statfs() and alerts
 * when usage exceeds thresholdPercent.
 */
export function createDiskSpaceSource(config: DiskMonitorConfig): HeartbeatSourcePort {
  return {
    id: SOURCE_ID,
    name: SOURCE_NAME,

    async check(): Promise<HeartbeatCheckResult> {
      const now = Date.now();
      const results: DiskPathResult[] = [];

      for (const fsPath of config.paths) {
        results.push(await checkPath(fsPath));
      }

      const errors = results.filter((r) => r.error);
      const overThreshold = results.filter(
        (r) => !r.error && r.usedPercent > config.thresholdPercent,
      );

      if (errors.length > 0) {
        const errorTexts = errors.map((e) => `${e.path}: error - ${e.error}`);
        return {
          sourceId: SOURCE_ID,
          text: `Disk check errors: ${errorTexts.join("; ")}`,
          timestamp: now,
          metadata: { errors },
        };
      }

      if (overThreshold.length > 0) {
        const alertTexts = overThreshold.map(
          (r) => `${r.path}: ${r.usedPercent.toFixed(1)}% used (${r.totalGb.toFixed(1)} GB total)`,
        );
        return {
          sourceId: SOURCE_ID,
          text: `CRITICAL: Disk usage exceeds ${config.thresholdPercent}% threshold - ${alertTexts.join("; ")}`,
          timestamp: now,
          metadata: { overThreshold },
        };
      }

      const summaries = results.map(
        (r) => `${r.path}: ${r.usedPercent.toFixed(1)}% (${r.totalGb.toFixed(1)} GB)`,
      );
      return {
        sourceId: SOURCE_ID,
        text: `${HEARTBEAT_OK_TOKEN} Disk usage OK - ${summaries.join("; ")}`,
        timestamp: now,
        metadata: { results },
      };
    },
  };
}
