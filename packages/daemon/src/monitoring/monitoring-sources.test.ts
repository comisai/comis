// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for monitoring HeartbeatSourcePort implementations.
 * Each source factory is tested with mocked system calls to verify
 * correct ok/alert/critical classification.
 * For sources that use promisify(execFile), we mock node:child_process
 * with a properly-shaped execFile AND mock node:util to provide a
 * promisify that returns our async mock directly.
 */

import { HEARTBEAT_OK_TOKEN } from "@comis/scheduler";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Helper: create exec mock + util mock pair
// ---------------------------------------------------------------------------

/**
 * Creates a pair of vi.doMock calls for node:child_process and node:util
 * that work correctly with `promisify(execFile)` in the source code.
 */
function mockExec(
  handler: (cmd: string, args: string[], opts: unknown) => { stdout: string; stderr: string },
) {
  const asyncHandler = async (cmd: string, args: string[], opts: unknown) =>
    handler(cmd, args, opts);

  vi.doMock("node:child_process", () => ({
    execFile: vi.fn(),
  }));
  vi.doMock("node:util", () => ({
    promisify: vi.fn().mockReturnValue(asyncHandler),
  }));
}

/**
 * Creates an exec mock that always throws an error.
 */
function mockExecError(errorMsg: string) {
  const asyncHandler = async () => {
    throw new Error(errorMsg);
  };
  vi.doMock("node:child_process", () => ({
    execFile: vi.fn(),
  }));
  vi.doMock("node:util", () => ({
    promisify: vi.fn().mockReturnValue(asyncHandler),
  }));
}

// ---------------------------------------------------------------------------
// Helper: mock process.platform
// ---------------------------------------------------------------------------

const originalPlatform = process.platform;

function mockPlatform(platform: string) {
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
}

// ---------------------------------------------------------------------------
// Disk Space Source (uses fs.statfs)
// ---------------------------------------------------------------------------

describe("createDiskSpaceSource", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it("returns HEARTBEAT_OK_TOKEN when disk usage is under threshold", async () => {
    vi.doMock("node:fs/promises", () => ({
      statfs: vi.fn().mockResolvedValue({
        blocks: 1_000_000,
        bsize: 4096,
        bavail: 500_000,
      }),
    }));

    const { createDiskSpaceSource } = await import("./disk-space-source.js");
    const source = createDiskSpaceSource({
      enabled: true,
      paths: ["/"],
      thresholdPercent: 90,
    });

    expect(source.id).toBe("monitor:disk-space");
    expect(source.name).toBe("Disk Space Monitor");

    const result = await source.check();
    expect(result.sourceId).toBe("monitor:disk-space");
    expect(result.text).toContain(HEARTBEAT_OK_TOKEN);
    expect(result.timestamp).toBeGreaterThan(0);
  });

  it("returns CRITICAL when disk usage exceeds threshold", async () => {
    vi.doMock("node:fs/promises", () => ({
      statfs: vi.fn().mockResolvedValue({
        blocks: 1_000_000,
        bsize: 4096,
        bavail: 50_000,
      }),
    }));

    const { createDiskSpaceSource } = await import("./disk-space-source.js");
    const source = createDiskSpaceSource({
      enabled: true,
      paths: ["/"],
      thresholdPercent: 90,
    });

    const result = await source.check();
    expect(result.text).toContain("CRITICAL");
    expect(result.text).toContain("95.0%");
  });

  it("handles statfs errors gracefully", async () => {
    vi.doMock("node:fs/promises", () => ({
      statfs: vi.fn().mockRejectedValue(new Error("Permission denied")),
    }));

    const { createDiskSpaceSource } = await import("./disk-space-source.js");
    const source = createDiskSpaceSource({
      enabled: true,
      paths: ["/secret"],
      thresholdPercent: 90,
    });

    const result = await source.check();
    expect(result.text).toContain("error");
    expect(result.text).toContain("Permission denied");
  });
});

// ---------------------------------------------------------------------------
// System Resources Source (uses os module + OS-aware memory detection)
// ---------------------------------------------------------------------------

describe("createSystemResourcesSource", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
  });

  it("returns HEARTBEAT_OK_TOKEN when resources are under threshold (fallback path)", async () => {
    mockPlatform("freebsd"); // triggers os.freemem fallback

    vi.doMock("node:os", async (importOriginal) => ({
      ...(await importOriginal<typeof import("node:os")>()),
      cpus: vi
        .fn()
        .mockReturnValue([{ times: { user: 100, nice: 0, sys: 50, idle: 850, irq: 0 } }]),
      freemem: vi.fn().mockReturnValue(4 * 1024 * 1024 * 1024),
      totalmem: vi.fn().mockReturnValue(8 * 1024 * 1024 * 1024),
    }));

    const { createSystemResourcesSource } = await import("./system-resources-source.js");
    const source = createSystemResourcesSource({
      enabled: true,
      cpuThresholdPercent: 85,
      memoryThresholdPercent: 90,
    });

    expect(source.id).toBe("monitor:system-resources");
    expect(source.name).toBe("System Resources Monitor");

    const result = await source.check();
    expect(result.sourceId).toBe("monitor:system-resources");
    expect(result.text).toContain(HEARTBEAT_OK_TOKEN);
    expect((result.metadata as Record<string, unknown>).memorySource).toBe("os.freemem");
  });

  it("returns CRITICAL when CPU exceeds threshold", async () => {
    mockPlatform("freebsd");

    vi.doMock("node:os", async (importOriginal) => ({
      ...(await importOriginal<typeof import("node:os")>()),
      cpus: vi.fn().mockReturnValue([{ times: { user: 900, nice: 0, sys: 50, idle: 50, irq: 0 } }]),
      freemem: vi.fn().mockReturnValue(4 * 1024 * 1024 * 1024),
      totalmem: vi.fn().mockReturnValue(8 * 1024 * 1024 * 1024),
    }));

    const { createSystemResourcesSource } = await import("./system-resources-source.js");
    const source = createSystemResourcesSource({
      enabled: true,
      cpuThresholdPercent: 85,
      memoryThresholdPercent: 90,
    });

    const result = await source.check();
    expect(result.text).toContain("CRITICAL");
    expect(result.text).toContain("CPU");
  });

  it("returns CRITICAL when memory exceeds threshold (fallback path)", async () => {
    mockPlatform("freebsd");

    vi.doMock("node:os", async (importOriginal) => ({
      ...(await importOriginal<typeof import("node:os")>()),
      cpus: vi
        .fn()
        .mockReturnValue([{ times: { user: 100, nice: 0, sys: 50, idle: 850, irq: 0 } }]),
      freemem: vi.fn().mockReturnValue(0.5 * 1024 * 1024 * 1024),
      totalmem: vi.fn().mockReturnValue(8 * 1024 * 1024 * 1024),
    }));

    const { createSystemResourcesSource } = await import("./system-resources-source.js");
    const source = createSystemResourcesSource({
      enabled: true,
      cpuThresholdPercent: 85,
      memoryThresholdPercent: 90,
    });

    const result = await source.check();
    expect(result.text).toContain("CRITICAL");
    expect(result.text).toContain("Memory");
  });

  // -------------------------------------------------------------------------
  // macOS: vm_stat path
  // -------------------------------------------------------------------------

  it("macOS: uses vm_stat for accurate memory reporting", async () => {
    mockPlatform("darwin");

    // 16 KB page size (Apple Silicon), total 16 GB
    // free=200000 + inactive=300000 + purgeable=50000 + speculative=10000 = 560000 pages
    // available = 560000 * 16384 = 9,175,040,000 bytes (~8.5 GB)
    // total = 16 GB = 17,179,869,184 bytes
    // used% = ((17179869184 - 9175040000) / 17179869184) * 100 ≈ 46.6%
    const vmStatOutput = [
      "Mach Virtual Memory Statistics: (page size of 16384 bytes)",
      "Pages free:                              200000.",
      "Pages active:                            400000.",
      "Pages inactive:                          300000.",
      "Pages speculative:                        10000.",
      "Pages throttled:                              0.",
      "Pages wired down:                        150000.",
      "Pages purgeable:                          50000.",
      'Pages stored in compressor:               80000.',
      'Pages occupied by compressor:             20000.',
      "",
    ].join("\n");

    mockExec((cmd) => {
      if (cmd === "vm_stat") {
        return { stdout: vmStatOutput, stderr: "" };
      }
      throw new Error(`unexpected command: ${cmd}`);
    });

    vi.doMock("node:os", async (importOriginal) => ({
      ...(await importOriginal<typeof import("node:os")>()),
      cpus: vi
        .fn()
        .mockReturnValue([{ times: { user: 100, nice: 0, sys: 50, idle: 850, irq: 0 } }]),
      totalmem: vi.fn().mockReturnValue(16 * 1024 * 1024 * 1024),
    }));

    const { createSystemResourcesSource } = await import("./system-resources-source.js");
    const source = createSystemResourcesSource({
      enabled: true,
      cpuThresholdPercent: 85,
      memoryThresholdPercent: 90,
    });

    const result = await source.check();
    expect(result.text).toContain(HEARTBEAT_OK_TOKEN);
    const meta = result.metadata as Record<string, unknown>;
    expect(meta.memorySource).toBe("vm_stat");
    // ~46.6% used — well under 90% threshold
    expect(meta.memoryPercent).toBeLessThan(50);
  });

  it("macOS: vm_stat failure falls back to os.freemem", async () => {
    mockPlatform("darwin");

    mockExecError("vm_stat: command not found");

    vi.doMock("node:os", async (importOriginal) => ({
      ...(await importOriginal<typeof import("node:os")>()),
      cpus: vi
        .fn()
        .mockReturnValue([{ times: { user: 100, nice: 0, sys: 50, idle: 850, irq: 0 } }]),
      freemem: vi.fn().mockReturnValue(4 * 1024 * 1024 * 1024),
      totalmem: vi.fn().mockReturnValue(16 * 1024 * 1024 * 1024),
    }));

    const { createSystemResourcesSource } = await import("./system-resources-source.js");
    const source = createSystemResourcesSource({
      enabled: true,
      cpuThresholdPercent: 85,
      memoryThresholdPercent: 90,
    });

    const result = await source.check();
    expect(result.text).toContain(HEARTBEAT_OK_TOKEN);
    expect((result.metadata as Record<string, unknown>).memorySource).toBe("os.freemem");
  });

  // -------------------------------------------------------------------------
  // Linux: /proc/meminfo path
  // -------------------------------------------------------------------------

  it("Linux: uses /proc/meminfo MemAvailable for accurate reporting", async () => {
    mockPlatform("linux");

    // MemTotal: 16 GB, MemAvailable: 10 GB → 37.5% used
    const procMeminfo = [
      "MemTotal:       16777216 kB",
      "MemFree:          512000 kB",
      "MemAvailable:   10485760 kB",
      "Buffers:          256000 kB",
      "Cached:          5120000 kB",
      "SwapCached:            0 kB",
    ].join("\n");

    vi.doMock("node:fs/promises", () => ({
      readFile: vi.fn().mockResolvedValue(procMeminfo),
    }));

    vi.doMock("node:os", async (importOriginal) => ({
      ...(await importOriginal<typeof import("node:os")>()),
      cpus: vi
        .fn()
        .mockReturnValue([{ times: { user: 100, nice: 0, sys: 50, idle: 850, irq: 0 } }]),
      totalmem: vi.fn().mockReturnValue(16 * 1024 * 1024 * 1024),
    }));
    // Mock child_process/util to no-ops (not used on Linux path)
    vi.doMock("node:child_process", () => ({ execFile: vi.fn() }));
    vi.doMock("node:util", () => ({ promisify: vi.fn().mockReturnValue(async () => ({})) }));

    const { createSystemResourcesSource } = await import("./system-resources-source.js");
    const source = createSystemResourcesSource({
      enabled: true,
      cpuThresholdPercent: 85,
      memoryThresholdPercent: 90,
    });

    const result = await source.check();
    expect(result.text).toContain(HEARTBEAT_OK_TOKEN);
    const meta = result.metadata as Record<string, unknown>;
    expect(meta.memorySource).toBe("/proc/meminfo");
    // 37.5% used — well under 90% threshold
    expect(meta.memoryPercent).toBeLessThan(40);
  });

  it("Linux: falls back to MemFree+Buffers+Cached when MemAvailable absent", async () => {
    mockPlatform("linux");

    // Old kernel without MemAvailable
    // MemTotal: 8 GB, MemFree: 1 GB, Buffers: 0.5 GB, Cached: 2.5 GB → available ~4 GB → 50% used
    const procMeminfo = [
      "MemTotal:        8388608 kB",
      "MemFree:         1048576 kB",
      "Buffers:          524288 kB",
      "Cached:          2621440 kB",
    ].join("\n");

    vi.doMock("node:fs/promises", () => ({
      readFile: vi.fn().mockResolvedValue(procMeminfo),
    }));

    vi.doMock("node:os", async (importOriginal) => ({
      ...(await importOriginal<typeof import("node:os")>()),
      cpus: vi
        .fn()
        .mockReturnValue([{ times: { user: 100, nice: 0, sys: 50, idle: 850, irq: 0 } }]),
      totalmem: vi.fn().mockReturnValue(8 * 1024 * 1024 * 1024),
    }));
    vi.doMock("node:child_process", () => ({ execFile: vi.fn() }));
    vi.doMock("node:util", () => ({ promisify: vi.fn().mockReturnValue(async () => ({})) }));

    const { createSystemResourcesSource } = await import("./system-resources-source.js");
    const source = createSystemResourcesSource({
      enabled: true,
      cpuThresholdPercent: 85,
      memoryThresholdPercent: 90,
    });

    const result = await source.check();
    expect(result.text).toContain(HEARTBEAT_OK_TOKEN);
    const meta = result.metadata as Record<string, unknown>;
    expect(meta.memorySource).toBe("/proc/meminfo");
    expect(meta.memoryPercent).toBeLessThan(55);
  });

  it("Linux: /proc/meminfo failure falls back to os.freemem", async () => {
    mockPlatform("linux");

    vi.doMock("node:fs/promises", () => ({
      readFile: vi.fn().mockRejectedValue(new Error("ENOENT")),
    }));

    vi.doMock("node:os", async (importOriginal) => ({
      ...(await importOriginal<typeof import("node:os")>()),
      cpus: vi
        .fn()
        .mockReturnValue([{ times: { user: 100, nice: 0, sys: 50, idle: 850, irq: 0 } }]),
      freemem: vi.fn().mockReturnValue(4 * 1024 * 1024 * 1024),
      totalmem: vi.fn().mockReturnValue(8 * 1024 * 1024 * 1024),
    }));
    vi.doMock("node:child_process", () => ({ execFile: vi.fn() }));
    vi.doMock("node:util", () => ({ promisify: vi.fn().mockReturnValue(async () => { throw new Error("unused"); }) }));

    const { createSystemResourcesSource } = await import("./system-resources-source.js");
    const source = createSystemResourcesSource({
      enabled: true,
      cpuThresholdPercent: 85,
      memoryThresholdPercent: 90,
    });

    const result = await source.check();
    expect(result.text).toContain(HEARTBEAT_OK_TOKEN);
    expect((result.metadata as Record<string, unknown>).memorySource).toBe("os.freemem");
  });
});

// ---------------------------------------------------------------------------
// systemd Service Source (uses child_process + fs/promises)
// ---------------------------------------------------------------------------

describe("createSystemdServiceSource", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it("returns OK when systemd is unavailable", async () => {
    vi.doMock("node:fs/promises", () => ({
      access: vi.fn().mockRejectedValue(new Error("ENOENT")),
      constants: { F_OK: 0 },
    }));
    mockExecError("not found");

    const { createSystemdServiceSource } = await import("./systemd-service-source.js");
    const source = createSystemdServiceSource({
      enabled: true,
      services: [],
    });

    expect(source.id).toBe("monitor:systemd-services");
    expect(source.name).toBe("systemd Service Monitor");

    const result = await source.check();
    expect(result.text).toContain(HEARTBEAT_OK_TOKEN);
    expect(result.text).toContain("systemd not available");
  });

  it("returns CRITICAL when failed services detected", async () => {
    vi.doMock("node:fs/promises", () => ({
      access: vi.fn().mockResolvedValue(undefined),
      constants: { F_OK: 0 },
    }));
    mockExec((cmd, args) => {
      if (cmd === "systemctl" && args.includes("--failed")) {
        return { stdout: "nginx.service loaded failed failed nginx\n", stderr: "" };
      }
      return { stdout: "", stderr: "" };
    });

    const { createSystemdServiceSource } = await import("./systemd-service-source.js");
    const source = createSystemdServiceSource({
      enabled: true,
      services: [],
    });

    const result = await source.check();
    expect(result.text).toContain("CRITICAL");
    expect(result.text).toContain("nginx.service");
  });

  it("filters to configured services only", async () => {
    vi.doMock("node:fs/promises", () => ({
      access: vi.fn().mockResolvedValue(undefined),
      constants: { F_OK: 0 },
    }));
    mockExec((cmd, args) => {
      if (cmd === "systemctl" && args.includes("--failed")) {
        return {
          stdout:
            "nginx.service loaded failed failed nginx\napache.service loaded failed failed apache\n",
          stderr: "",
        };
      }
      return { stdout: "", stderr: "" };
    });

    const { createSystemdServiceSource } = await import("./systemd-service-source.js");
    const source = createSystemdServiceSource({
      enabled: true,
      services: ["nginx.service"],
    });

    const result = await source.check();
    expect(result.text).toContain("CRITICAL");
    expect(result.text).toContain("nginx.service");
    expect(result.text).not.toContain("apache.service");
  });
});

// ---------------------------------------------------------------------------
// Security Update Source (uses child_process)
// ---------------------------------------------------------------------------

describe("createSecurityUpdateSource", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it("returns OK when no package manager found", async () => {
    mockExecError("not found");

    const { createSecurityUpdateSource } = await import("./security-update-source.js");
    const source = createSecurityUpdateSource({
      enabled: true,
      securityOnly: true,
    });

    expect(source.id).toBe("monitor:security-updates");
    expect(source.name).toBe("Security Update Monitor");

    const result = await source.check();
    expect(result.text).toContain(HEARTBEAT_OK_TOKEN);
    expect(result.text).toContain("No supported package manager");
  });

  it("returns CRITICAL when apt-get finds security updates", async () => {
    mockExec((cmd, args) => {
      if (cmd === "which" && args[0] === "apt-get") {
        return { stdout: "/usr/bin/apt-get\n", stderr: "" };
      }
      if (cmd === "apt-get" && args.includes("-s")) {
        return {
          stdout:
            "3 upgraded, 0 newly installed, 0 to remove.\nInst libssl3 (3.0.2 Ubuntu:22.04/jammy-security)\nInst curl (7.81.0 Ubuntu:22.04/jammy-security)\nInst vim (2:8.2 Ubuntu:22.04/jammy-updates)\n",
          stderr: "",
        };
      }
      throw new Error("not found");
    });

    const { createSecurityUpdateSource } = await import("./security-update-source.js");
    const source = createSecurityUpdateSource({
      enabled: true,
      securityOnly: true,
    });

    const result = await source.check();
    expect(result.text).toContain("CRITICAL");
    expect(result.text).toContain("pending");
  });

  it("returns OK when apt-get finds no updates", async () => {
    mockExec((cmd, args) => {
      if (cmd === "which" && args[0] === "apt-get") {
        return { stdout: "/usr/bin/apt-get\n", stderr: "" };
      }
      if (cmd === "apt-get" && args.includes("-s")) {
        return { stdout: "0 upgraded, 0 newly installed, 0 to remove.\n", stderr: "" };
      }
      throw new Error("not found");
    });

    const { createSecurityUpdateSource } = await import("./security-update-source.js");
    const source = createSecurityUpdateSource({
      enabled: true,
      securityOnly: true,
    });

    const result = await source.check();
    expect(result.text).toContain(HEARTBEAT_OK_TOKEN);
  });
});

// ---------------------------------------------------------------------------
// Git Watcher Source (uses child_process)
// ---------------------------------------------------------------------------

describe("createGitWatcherSource", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it("returns OK when no repositories configured", async () => {
    const { createGitWatcherSource } = await import("./git-watcher-source.js");
    const source = createGitWatcherSource({
      enabled: true,
      repositories: [],
      checkRemote: true,
    });

    expect(source.id).toBe("monitor:git-watcher");
    expect(source.name).toBe("Git Repository Monitor");

    const result = await source.check();
    expect(result.text).toContain(HEARTBEAT_OK_TOKEN);
    expect(result.text).toContain("No git repositories configured");
  });

  it("returns OK when repos are clean", async () => {
    mockExec((_cmd, args) => {
      if (args.includes("--porcelain")) {
        return { stdout: "", stderr: "" };
      }
      if (args.includes("rev-list")) {
        return { stdout: "0\n", stderr: "" };
      }
      return { stdout: "", stderr: "" };
    });

    const { createGitWatcherSource } = await import("./git-watcher-source.js");
    const source = createGitWatcherSource({
      enabled: true,
      repositories: ["/home/user/project"],
      checkRemote: true,
    });

    const result = await source.check();
    expect(result.text).toContain(HEARTBEAT_OK_TOKEN);
    expect(result.text).toContain("clean");
  });

  it("reports uncommitted changes", async () => {
    mockExec((_cmd, args) => {
      if (args.includes("--porcelain")) {
        return { stdout: " M src/main.ts\n?? new-file.ts\n", stderr: "" };
      }
      if (args.includes("rev-list")) {
        return { stdout: "0\n", stderr: "" };
      }
      return { stdout: "", stderr: "" };
    });

    const { createGitWatcherSource } = await import("./git-watcher-source.js");
    const source = createGitWatcherSource({
      enabled: true,
      repositories: ["/home/user/project"],
      checkRemote: true,
    });

    const result = await source.check();
    expect(result.text).toContain("attention");
    expect(result.text).toContain("uncommitted");
  });

  it("handles git errors gracefully", async () => {
    mockExecError("Not a git repository");

    const { createGitWatcherSource } = await import("./git-watcher-source.js");
    const source = createGitWatcherSource({
      enabled: true,
      repositories: ["/tmp/not-a-repo"],
      checkRemote: false,
    });

    const result = await source.check();
    expect(result.text).toContain("error");
    expect(result.text).toContain("Not a git repository");
  });
});
