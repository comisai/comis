// SPDX-License-Identifier: Apache-2.0
// @allow-throw: monitoring source /proc/meminfo parse guard; consumed via monitoring-source aggregator try/catch chain.
/**
 * System Resources HeartbeatSourcePort implementation.
 * Monitors CPU and memory usage with OS-aware memory detection:
 * - macOS: parses `vm_stat` to include purgeable/inactive/speculative pages
 *   (os.freemem() only reports truly free pages, causing false high-usage alerts)
 * - Linux: reads /proc/meminfo MemAvailable (accounts for reclaimable buffers/cache)
 * - Fallback: os.freemem() for unsupported platforms
 */

import type { ClockPort, ResourceMonitorConfig } from "@comis/core";
import type { HeartbeatSourcePort } from "@comis/scheduler";
import { err, ok } from "@comis/shared";
import { cpus, freemem, totalmem } from "node:os";
import { execFile as execFileCb } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

const execFile = promisify(execFileCb);

const SOURCE_ID = "monitor_system_resources";
const EXEC_TIMEOUT_MS = 5_000;

/** Memory info with source provenance for observability. */
interface MemoryInfo {
  usedPercent: number;
  totalGb: number;
  freeGb: number;
  source: "vm_stat" | "/proc/meminfo" | "os.freemem";
}

/**
 * Calculate CPU usage percentage from os.cpus() snapshot.
 * Uses the idle ratio across all cores. Note: this is a point-in-time
 * snapshot, not an average over an interval.
 */
function getCpuUsagePercent(): number {
  const cpuInfo = cpus();
  if (cpuInfo.length === 0) return 0;

  let totalIdle = 0;
  let totalTick = 0;

  for (const cpu of cpuInfo) {
    const { user, nice, sys, idle, irq } = cpu.times;
    totalIdle += idle;
    totalTick += user + nice + sys + idle + irq;
  }

  return totalTick > 0 ? ((totalTick - totalIdle) / totalTick) * 100 : 0;
}

/**
 * Parse a "Pages xxx:" line value from vm_stat output.
 * Returns the page count or 0 if not found.
 */
function parseVmStatField(output: string, field: string): number {
  const re = new RegExp(`^${field}:\\s+(\\d+)`, "m");
  const match = output.match(re);
  return match ? parseInt(match[1], 10) : 0;
}

/**
 * macOS: parse vm_stat to get accurate available memory.
 * os.freemem() on macOS only reports "Pages free" which excludes
 * inactive, purgeable, and speculative pages that the OS can instantly
 * reclaim. This causes false ~90%+ usage readings on healthy systems.
 * Available = (free + purgeable + speculative + inactive) * pageSize
 */
async function getMemoryUsageMacOS(): Promise<MemoryInfo> {
  const { stdout } = await execFile("vm_stat", [], { timeout: EXEC_TIMEOUT_MS });

  // Parse page size from header: "Mach Virtual Memory Statistics: (page size of N bytes)"
  const pageSizeMatch = stdout.match(/page size of (\d+) bytes/);
  const pageSize = pageSizeMatch ? parseInt(pageSizeMatch[1], 10) : 16384;

  const free = parseVmStatField(stdout, "Pages free");
  const inactive = parseVmStatField(stdout, "Pages inactive");
  const purgeable = parseVmStatField(stdout, "Pages purgeable");
  const speculative = parseVmStatField(stdout, "Pages speculative");

  const availableBytes = (free + inactive + purgeable + speculative) * pageSize;
  const total = totalmem();
  const usedPercent = total > 0 ? ((total - availableBytes) / total) * 100 : 0;

  return {
    usedPercent: Math.max(0, Math.min(100, usedPercent)),
    totalGb: total / (1024 * 1024 * 1024),
    freeGb: availableBytes / (1024 * 1024 * 1024),
    source: "vm_stat",
  };
}

/**
 * Parse a kB field from /proc/meminfo (e.g. "MemAvailable:    8192000 kB").
 * Returns bytes or undefined if not found.
 */
function parseProcMemField(content: string, field: string): number | undefined {
  const re = new RegExp(`^${field}:\\s+(\\d+)\\s+kB`, "m");
  const match = content.match(re);
  return match ? parseInt(match[1], 10) * 1024 : undefined;
}

/**
 * Linux: read /proc/meminfo for accurate available memory.
 * Uses MemAvailable (kernel 3.14+) which accounts for reclaimable
 * buffers and cache. Falls back to MemFree + Buffers + Cached.
 */
async function getMemoryUsageLinux(): Promise<MemoryInfo> {
  const content = await readFile("/proc/meminfo", "utf-8");

  const memTotal = parseProcMemField(content, "MemTotal");
  const memAvailable = parseProcMemField(content, "MemAvailable");

  let available: number;
  let total: number;

  if (memTotal !== undefined && memAvailable !== undefined) {
    total = memTotal;
    available = memAvailable;
  } else if (memTotal !== undefined) {
    // Kernel < 3.14 fallback
    total = memTotal;
    const memFree = parseProcMemField(content, "MemFree") ?? 0;
    const buffers = parseProcMemField(content, "Buffers") ?? 0;
    const cached = parseProcMemField(content, "Cached") ?? 0;
    available = memFree + buffers + cached;
  } else {
    // Unexpected format — let caller fall back to os.freemem()
    throw new Error("Could not parse MemTotal from /proc/meminfo");
  }

  const usedPercent = total > 0 ? ((total - available) / total) * 100 : 0;

  return {
    usedPercent: Math.max(0, Math.min(100, usedPercent)),
    totalGb: total / (1024 * 1024 * 1024),
    freeGb: available / (1024 * 1024 * 1024),
    source: "/proc/meminfo",
  };
}

/**
 * Fallback: use os.freemem() for unsupported platforms.
 */
function getMemoryUsageFallback(): MemoryInfo {
  const total = totalmem();
  const free = freemem();
  const usedPercent = total > 0 ? ((total - free) / total) * 100 : 0;
  return {
    usedPercent,
    totalGb: total / (1024 * 1024 * 1024),
    freeGb: free / (1024 * 1024 * 1024),
    source: "os.freemem",
  };
}

/**
 * Get memory usage with OS-aware detection.
 * Tries platform-specific methods first, falls back to os.freemem().
 */
async function getMemoryUsagePercent(): Promise<MemoryInfo> {
  if (process.platform === "darwin") {
    try {
      return await getMemoryUsageMacOS();
    } catch {
      // vm_stat unavailable — fall through
    }
  }

  if (process.platform === "linux") {
    try {
      return await getMemoryUsageLinux();
    } catch {
      // /proc/meminfo unavailable — fall through
    }
  }

  return getMemoryUsageFallback();
}

/**
 * Create a system resources heartbeat source.
 * Checks CPU and memory usage against configured thresholds.
 */
export function createSystemResourcesSource(
  config: ResourceMonitorConfig,
  clock: ClockPort,
): HeartbeatSourcePort {
  return {
    id: SOURCE_ID,
    async check(signal) {
      if (signal.aborted) return err({ code: "cancelled", errorKind: "timeout" });
      let cpuPercent: number;
      let mem: MemoryInfo;
      try {
        cpuPercent = getCpuUsagePercent();
        mem = await getMemoryUsagePercent();
      } catch {
        return err({ code: "resource_probe_failed", errorKind: "resource" });
      }
      if (signal.aborted) return err({ code: "cancelled", errorKind: "timeout" });

      const cpuOver = cpuPercent > config.cpuThresholdPercent;
      const memOver = mem.usedPercent > config.memoryThresholdPercent;

      return ok({
        level: cpuOver || memOver ? "critical" : "ok",
        observedAtMs: clock.now(),
        code: cpuOver || memOver ? "resource_threshold_exceeded" : "resources_healthy",
        counters: [
          { name: "cpu_percent", value: Math.max(0, Math.round(cpuPercent)) },
          { name: "memory_percent", value: Math.max(0, Math.round(mem.usedPercent)) },
          { name: "cpu_over_threshold", value: cpuOver ? 1 : 0 },
          { name: "memory_over_threshold", value: memOver ? 1 : 0 },
        ],
      });
    },
  };
}
