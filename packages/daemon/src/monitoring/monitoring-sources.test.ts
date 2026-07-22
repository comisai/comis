// SPDX-License-Identifier: Apache-2.0
import { ok } from "@comis/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeClock } from "../../../../test/support/fake-clock.js";

const mocks = vi.hoisted(() => ({
  execFile: vi.fn(),
  access: vi.fn(),
  readFile: vi.fn(),
  statfs: vi.fn(),
  cpus: vi.fn(),
  freemem: vi.fn(),
  totalmem: vi.fn(),
}));

vi.mock("node:child_process", () => ({ execFile: vi.fn() }));
vi.mock("node:util", () => ({ promisify: vi.fn(() => mocks.execFile) }));
vi.mock("node:fs/promises", () => ({
  access: mocks.access,
  constants: { F_OK: 0 },
  readFile: mocks.readFile,
  statfs: mocks.statfs,
}));
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return {
    ...actual,
    default: {
      ...actual.default,
      cpus: mocks.cpus,
      freemem: mocks.freemem,
      totalmem: mocks.totalmem,
    },
    cpus: mocks.cpus,
    freemem: mocks.freemem,
    totalmem: mocks.totalmem,
  };
});

import {
  createDiskSpaceSource,
  createGitWatcherSource,
  createSecurityUpdateSource,
  createSystemdServiceSource,
  createSystemResourcesSource,
} from "./index.js";

const NOW_MS = 1_800_000_000_000;
const clock = createFakeClock(NOW_MS);
const signal = new AbortController().signal;
const originalPlatform = process.platform;

beforeEach(() => {
  Object.defineProperty(process, "platform", { value: "freebsd", configurable: true });
  vi.clearAllMocks();
  mocks.access.mockResolvedValue(undefined);
  mocks.statfs.mockResolvedValue({ blocks: 1_000, bsize: 1_024, bavail: 500 });
  mocks.cpus.mockReturnValue([{ times: { user: 100, nice: 0, sys: 50, idle: 850, irq: 0 } }]);
  mocks.freemem.mockReturnValue(4 * 1024 * 1024 * 1024);
  mocks.totalmem.mockReturnValue(8 * 1024 * 1024 * 1024);
  mocks.readFile.mockResolvedValue("MemTotal: 8388608 kB\nMemAvailable: 4194304 kB\n");
  mocks.execFile.mockResolvedValue({ stdout: "", stderr: "" });
});

afterEach(() => {
  Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
  vi.restoreAllMocks();
});

describe("closed monitoring source adapters", () => {
  it("classifies disk health thresholds and stat failures without returning paths or prose", async () => {
    const source = createDiskSpaceSource({ paths: ["/data"], thresholdPercent: 80 } as never, clock);
    expect(source.id).toBe("monitor_disk_space");
    await expect(source.check(signal)).resolves.toEqual(ok({
      level: "ok",
      observedAtMs: NOW_MS,
      code: "disk_healthy",
      counters: [
        { name: "paths_checked", value: 1 },
        { name: "over_threshold", value: 0 },
        { name: "maximum_used_percent", value: 50 },
      ],
    }));

    mocks.statfs.mockResolvedValue({ blocks: 1_000, bsize: 1_024, bavail: 50 });
    await expect(source.check(signal)).resolves.toMatchObject({
      ok: true,
      value: { level: "critical", code: "disk_threshold_exceeded" },
    });
    mocks.statfs.mockRejectedValue(new Error("/secret credential-bearing path"));
    await expect(source.check(signal)).resolves.toEqual({
      ok: false,
      error: { code: "stat_failed", errorKind: "resource" },
    });
  });

  it("reports system CPU and memory only through bounded integer counters", async () => {
    const source = createSystemResourcesSource({
      cpuThresholdPercent: 80,
      memoryThresholdPercent: 80,
    } as never, clock);
    expect(source.id).toBe("monitor_system_resources");
    await expect(source.check(signal)).resolves.toEqual(ok({
      level: "ok",
      observedAtMs: NOW_MS,
      code: "resources_healthy",
      counters: [
        { name: "cpu_percent", value: 15 },
        { name: "memory_percent", value: 50 },
        { name: "cpu_over_threshold", value: 0 },
        { name: "memory_over_threshold", value: 0 },
      ],
    }));

    const critical = createSystemResourcesSource({
      cpuThresholdPercent: 1,
      memoryThresholdPercent: 1,
    } as never, clock);
    await expect(critical.check(signal)).resolves.toMatchObject({
      ok: true,
      value: { level: "critical", code: "resource_threshold_exceeded" },
    });
  });

  it("reports systemd availability failed counts and query errors as closed values", async () => {
    const source = createSystemdServiceSource({ services: [] } as never, clock);
    expect(source.id).toBe("monitor_systemd_services");
    await expect(source.check(signal)).resolves.toEqual(ok({
      level: "ok",
      observedAtMs: NOW_MS,
      code: "systemd_healthy",
      counters: [{ name: "failed_services", value: 0 }],
    }));

    mocks.execFile.mockResolvedValue({ stdout: "a.service loaded failed failed\n", stderr: "" });
    await expect(source.check(signal)).resolves.toEqual(ok({
      level: "critical",
      observedAtMs: NOW_MS,
      code: "systemd_services_failed",
      counters: [{ name: "failed_services", value: 1 }],
    }));
    mocks.execFile.mockRejectedValue(new Error("systemctl secret prose"));
    await expect(source.check(signal)).resolves.toEqual({
      ok: false,
      error: { code: "systemd_query_failed", errorKind: "dependency" },
    });
  });

  it("reports security update counts without package names or command output", async () => {
    mocks.execFile.mockImplementation(async (command: string, args: string[]) => {
      if (command === "which") return { stdout: args[0] === "apt-get" ? "/usr/bin/apt-get\n" : "", stderr: "" };
      return {
        stdout: "2 upgraded, 0 newly installed\nInst openssl [old] (new Ubuntu:security)\n",
        stderr: "",
      };
    });
    const source = createSecurityUpdateSource({ securityOnly: true } as never, clock);
    expect(source.id).toBe("monitor_security_updates");
    await expect(source.check(signal)).resolves.toEqual(ok({
      level: "critical",
      observedAtMs: NOW_MS,
      code: "security_updates_pending",
      counters: [
        { name: "updates_pending", value: 1 },
        { name: "security_updates_pending", value: 1 },
      ],
    }));

    mocks.execFile.mockRejectedValue(new Error("package manager secret prose"));
    await expect(source.check(signal)).resolves.toEqual({
      ok: true,
      value: {
        level: "ok",
        observedAtMs: NOW_MS,
        code: "package_manager_unavailable",
        counters: [],
      },
    });
  });

  it("reports git repository aggregate state without returning configured paths", async () => {
    mocks.execFile.mockImplementation(async (_command: string, args: string[]) => {
      if (args.includes("status")) return { stdout: " M file-a\n?? file-b\n", stderr: "" };
      return { stdout: "3\n", stderr: "" };
    });
    const source = createGitWatcherSource({
      repositories: ["/private/repo"],
      checkRemote: true,
    } as never, clock);
    expect(source.id).toBe("monitor_git_repositories");
    await expect(source.check(signal)).resolves.toEqual(ok({
      level: "alert",
      observedAtMs: NOW_MS,
      code: "git_attention_required",
      counters: [
        { name: "repositories_checked", value: 1 },
        { name: "repositories_failed", value: 0 },
        { name: "uncommitted_files", value: 2 },
        { name: "unpushed_commits", value: 3 },
      ],
    }));

    mocks.execFile.mockRejectedValue(new Error("/private/repo secret prose"));
    await expect(source.check(signal)).resolves.toEqual({
      ok: false,
      error: { code: "git_query_failed", errorKind: "dependency" },
    });
  });
});
