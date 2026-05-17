// SPDX-License-Identifier: Apache-2.0
/**
 * Branch-coverage tests for system-resources-source.
 *
 * The platform-specific memory branches (vm_stat parse / /proc/meminfo
 * parse) are exercised via mocked execFile + readFile. The CPU usage
 * branch is exercised via mocked os.cpus().
 */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";

// Mock node:child_process before importing the source under test.
// vm_stat output simulates a healthy system with ~50% memory available.
const VM_STAT_OUTPUT = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                           100000.
Pages active:                          50000.
Pages inactive:                       100000.
Pages speculative:                     50000.
Pages purgeable:                      100000.
`;
const PROC_MEMINFO = `MemTotal:       16777216 kB
MemFree:         2000000 kB
MemAvailable:    8000000 kB
Buffers:         500000 kB
Cached:         2000000 kB
`;
vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    execFile: vi.fn((_cmd: string, _args: string[], _opts: unknown, cb: (e: Error | null, r: { stdout: string; stderr: string }) => void) => {
      cb(null, { stdout: VM_STAT_OUTPUT, stderr: "" });
    }),
  };
});

vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  return { ...actual, readFile: vi.fn(async () => PROC_MEMINFO) };
});

vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return {
    ...actual,
    cpus: vi.fn(() => [
      { times: { user: 100, nice: 0, sys: 50, idle: 850, irq: 0 } },
      { times: { user: 100, nice: 0, sys: 50, idle: 850, irq: 0 } },
    ]),
    freemem: vi.fn(() => 8 * 1024 * 1024 * 1024), // 8 GB free
    totalmem: vi.fn(() => 16 * 1024 * 1024 * 1024), // 16 GB total
  };
});

import { createSystemResourcesSource } from "./system-resources-source.js";

afterEach(() => {
  vi.clearAllMocks();
});

describe("createSystemResourcesSource", () => {
  it("returns source id and name metadata identifying it as the system-resources monitor", () => {
    const source = createSystemResourcesSource({
      cpuThresholdPercent: 80,
      memoryThresholdPercent: 80,
    } as never);
    expect(source.id).toBe("monitor:system-resources");
    expect(source.name).toBe("System Resources Monitor");
  });

  it("returns OK token text when both CPU and memory usage are under their respective thresholds", async () => {
    // Mocks default CPU = (200+100) / (200+100+1700) = 15%
    // Mocks default mem = (16-8)/16 = 50%
    const source = createSystemResourcesSource({
      cpuThresholdPercent: 80,
      memoryThresholdPercent: 80,
    } as never);
    const result = await source.check();
    expect(result.text).toContain("OK");
    expect(result.metadata).toMatchObject({
      cpuPercent: expect.any(Number),
      memoryPercent: expect.any(Number),
      totalMemoryGb: expect.any(Number),
    });
  });

  it("returns CRITICAL text when CPU usage exceeds the configured threshold percentage", async () => {
    const source = createSystemResourcesSource({
      cpuThresholdPercent: 1, // Very low — always exceeds
      memoryThresholdPercent: 99,
    } as never);
    const result = await source.check();
    expect(result.text).toContain("CRITICAL");
    expect(result.text).toContain("CPU");
  });

  it("returns CRITICAL text when memory usage exceeds the configured threshold percentage", async () => {
    const source = createSystemResourcesSource({
      cpuThresholdPercent: 99,
      memoryThresholdPercent: 1, // Very low — always exceeds
    } as never);
    const result = await source.check();
    expect(result.text).toContain("CRITICAL");
    expect(result.text).toContain("Memory");
  });

  it("returns CRITICAL text aggregating both CPU and memory when both exceed thresholds", async () => {
    const source = createSystemResourcesSource({
      cpuThresholdPercent: 1,
      memoryThresholdPercent: 1,
    } as never);
    const result = await source.check();
    expect(result.text).toContain("CPU");
    expect(result.text).toContain("Memory");
  });
});
