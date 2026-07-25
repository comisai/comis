// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi, beforeEach } from "vitest";
import { createFakeClock } from "../../../../test/support/fake-clock.js";
import { createFakeTimers } from "../../../../test/support/fake-timers.js";
import { createMockLogger } from "../../../../test/support/mock-logger.js";

const sourceFactories = vi.hoisted(() => ({
  disk: vi.fn(() => ({ id: "monitor_disk_space" })),
  resources: vi.fn(() => ({ id: "monitor_system_resources" })),
  systemd: vi.fn(() => ({ id: "monitor_systemd_services" })),
  security: vi.fn(() => ({ id: "monitor_security_updates" })),
  git: vi.fn(() => ({ id: "monitor_git_repositories" })),
}));
const heartbeatRunner = vi.hoisted(() => ({
  runOnce: vi.fn(), registerSource: vi.fn(), unregisterSource: vi.fn(), isBusy: vi.fn(), shutdown: vi.fn(),
}));
const createHeartbeatRunner = vi.hoisted(() => vi.fn(() => heartbeatRunner));
const createDuplicateDetector = vi.hoisted(() => vi.fn(() => ({
  check: vi.fn(() => false), recordPossiblyVisible: vi.fn(), clear: vi.fn(),
})));

vi.mock("../monitoring/index.js", () => ({
  createDiskSpaceSource: sourceFactories.disk,
  createSystemResourcesSource: sourceFactories.resources,
  createSystemdServiceSource: sourceFactories.systemd,
  createSecurityUpdateSource: sourceFactories.security,
  createGitWatcherSource: sourceFactories.git,
}));
vi.mock("@comis/scheduler", () => ({ createHeartbeatRunner, createDuplicateDetector }));

function container(enabled = false) {
  return {
    config: {
      monitoring: {
        disk: { enabled, paths: ["/"], thresholdPercent: 90 },
        resources: { enabled, cpuThresholdPercent: 90, memoryThresholdPercent: 90 },
        systemd: { enabled, services: [] },
        securityUpdates: { enabled, securityOnly: true },
        git: { enabled, repositories: [], checkRemote: false },
      },
      scheduler: {
        heartbeat: { staleMs: 120_000 },
      },
    },
    eventBus: { emit: vi.fn() },
  } as never;
}

describe("health and monitoring setup", () => {
  beforeEach(() => vi.clearAllMocks());

  it("starts and returns the process health monitor", async () => {
    const processMonitor = { start: vi.fn(), stop: vi.fn() };
    const createProcessMonitor = vi.fn(() => processMonitor);
    const { setupHealth } = await import("./setup-health.js");

    expect(setupHealth({
      container: container(),
      logger: createMockLogger() as never,
      daemonLogger: createMockLogger() as never,
      _createProcessMonitor: createProcessMonitor as never,
    })).toEqual({ processMonitor });
    expect(processMonitor.start).toHaveBeenCalledOnce();
  });

  it("keeps monitoring absent and timer-free when every source is disabled", async () => {
    const { setupMonitoring } = await import("./setup-health.js");
    const result = setupMonitoring({
      container: container(false),
      schedulerLogger: createMockLogger() as never,
      clock: createFakeClock(1_000),
      timers: createFakeTimers(1_000),
    });

    expect(result.heartbeatRunner).toBeUndefined();
    expect(createHeartbeatRunner).not.toHaveBeenCalled();
    expect(result.duplicateDetector).toBeDefined();
  });

  it("constructs closed monitoring sources without starting a timer", async () => {
    const { setupMonitoring } = await import("./setup-health.js");
    const clock = createFakeClock(1_000);
    const timers = createFakeTimers(1_000);
    const schedulerLogger = createMockLogger();
    const configured = container(true);

    const result = setupMonitoring({
      container: configured,
      schedulerLogger: schedulerLogger as never,
      clock,
      timers,
    });

    expect(result.heartbeatRunner).toBe(heartbeatRunner);
    expect(sourceFactories.disk).toHaveBeenCalledWith(configured.config.monitoring.disk, clock);
    expect(sourceFactories.resources).toHaveBeenCalledWith(configured.config.monitoring.resources, clock);
    expect(sourceFactories.systemd).toHaveBeenCalledWith(configured.config.monitoring.systemd, clock);
    expect(sourceFactories.security).toHaveBeenCalledWith(configured.config.monitoring.securityUpdates, clock);
    expect(sourceFactories.git).toHaveBeenCalledWith(configured.config.monitoring.git, clock);
    expect(createHeartbeatRunner).toHaveBeenCalledWith({
      sources: expect.any(Array),
      clock,
      timers,
      eventBus: configured.eventBus,
      logger: schedulerLogger,
      staleMs: 120_000,
    });
    expect(timers.unrefRecord()).toEqual([]);
  });
});
