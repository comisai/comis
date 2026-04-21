// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMockLogger } from "../../../../test/support/mock-logger.js";

// ---------------------------------------------------------------------------
// Hoisted mocks (Health)
// ---------------------------------------------------------------------------

const mockLoadOrCreateDeviceIdentity = vi.hoisted(() => vi.fn());

vi.mock("../device/device-identity.js", () => ({
  loadOrCreateDeviceIdentity: mockLoadOrCreateDeviceIdentity,
}));

// ---------------------------------------------------------------------------
// Hoisted mocks (Monitoring)
// ---------------------------------------------------------------------------

const mockCreateDiskSpaceSource = vi.hoisted(() => vi.fn(() => ({ id: "disk" })));
const mockCreateSystemResourcesSource = vi.hoisted(() => vi.fn(() => ({ id: "resources" })));
const mockCreateSystemdServiceSource = vi.hoisted(() => vi.fn(() => ({ id: "systemd" })));
const mockCreateSecurityUpdateSource = vi.hoisted(() => vi.fn(() => ({ id: "security" })));
const mockCreateGitWatcherSource = vi.hoisted(() => vi.fn(() => ({ id: "git" })));

const mockCreateHeartbeatRunner = vi.hoisted(() => vi.fn(() => ({
  start: vi.fn(),
  stop: vi.fn(),
})));

const mockCreateDuplicateDetector = vi.hoisted(() => vi.fn(() => ({
  isDuplicate: vi.fn(() => false),
  clear: vi.fn(),
})));

const mockDeliverHeartbeatNotification = vi.hoisted(() => vi.fn(() => Promise.resolve({ status: "delivered", messageId: "test-msg-1" })));

vi.mock("../monitoring/index.js", () => ({
  createDiskSpaceSource: mockCreateDiskSpaceSource,
  createSystemResourcesSource: mockCreateSystemResourcesSource,
  createSystemdServiceSource: mockCreateSystemdServiceSource,
  createSecurityUpdateSource: mockCreateSecurityUpdateSource,
  createGitWatcherSource: mockCreateGitWatcherSource,
}));

vi.mock("@comis/scheduler", () => ({
  createHeartbeatRunner: mockCreateHeartbeatRunner,
  createDuplicateDetector: mockCreateDuplicateDetector,
  deliverHeartbeatNotification: mockDeliverHeartbeatNotification,
}));

// ---------------------------------------------------------------------------
// Helpers
function createMinimalContainer(overrides: Record<string, any> = {}) {
  return {
    config: {
      dataDir: "/test/data",
      ...overrides,
    },
    eventBus: { on: vi.fn(), emit: vi.fn() },
  } as any;
}

function createMonitoringConfig(overrides: Record<string, any> = {}) {
  return {
    disk: { enabled: false, ...overrides.disk },
    resources: { enabled: false, ...overrides.resources },
    systemd: { enabled: false, ...overrides.systemd },
    securityUpdates: { enabled: false, ...overrides.securityUpdates },
    git: { enabled: false, ...overrides.git },
  };
}

function createSchedulerConfig(overrides: Record<string, any> = {}) {
  return {
    heartbeat: {
      intervalMs: 60_000,
      showOk: false,
      showAlerts: true,
      ...overrides.heartbeat,
    },
    quietHours: {
      enabled: false,
      criticalBypass: true,
      ...overrides.quietHours,
    },
  };
}

function createMonitoringContainer(opts: { monitoring?: Record<string, any>; scheduler?: Record<string, any> } = {}) {
  return {
    config: {
      monitoring: createMonitoringConfig(opts.monitoring),
      scheduler: createSchedulerConfig(opts.scheduler),
    },
    eventBus: { on: vi.fn(), emit: vi.fn() },
  } as any;
}

// ===========================================================================
// Health tests
// ===========================================================================

describe("setupHealth", () => {
  let mockCreateProcessMonitor: ReturnType<typeof vi.fn>;
  let mockStartWatchdog: ReturnType<typeof vi.fn>;
  let mockProcessMonitor: { start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> };
  let mockWatchdogHandle: { kick: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.clearAllMocks();

    mockProcessMonitor = { start: vi.fn(), stop: vi.fn() };
    mockWatchdogHandle = { kick: vi.fn() };
    mockCreateProcessMonitor = vi.fn(() => mockProcessMonitor);
    mockStartWatchdog = vi.fn(() => mockWatchdogHandle);

    // Default: identity loads successfully
    mockLoadOrCreateDeviceIdentity.mockReturnValue({
      ok: true,
      value: { deviceId: "dev-abc123", publicKey: "pk-test" },
    });
  });

  async function getSetupHealth() {
    const mod = await import("./setup-health.js");
    return mod.setupHealth;
  }

  // -------------------------------------------------------------------------
  // 1. Creates and starts process monitor
  // -------------------------------------------------------------------------

  it("calls _createProcessMonitor with eventBus and calls .start()", async () => {
    const container = createMinimalContainer();
    const setupHealth = await getSetupHealth();

    setupHealth({
      container,
      logger: createMockLogger() as any,
      daemonLogger: createMockLogger() as any,
      _createProcessMonitor: mockCreateProcessMonitor,
      _startWatchdog: mockStartWatchdog,
    });

    expect(mockCreateProcessMonitor).toHaveBeenCalledWith({ eventBus: container.eventBus });
    expect(mockProcessMonitor.start).toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // 2. Starts watchdog with logger and processMonitor
  // -------------------------------------------------------------------------

  it("calls _startWatchdog with logger and processMonitor", async () => {
    const daemonLogger = createMockLogger();
    const setupHealth = await getSetupHealth();

    setupHealth({
      container: createMinimalContainer(),
      logger: createMockLogger() as any,
      daemonLogger: daemonLogger as any,
      _createProcessMonitor: mockCreateProcessMonitor,
      _startWatchdog: mockStartWatchdog,
    });

    expect(mockStartWatchdog).toHaveBeenCalledWith({
      logger: daemonLogger,
      processMonitor: mockProcessMonitor,
    });
  });

  // -------------------------------------------------------------------------
  // 3. Returns all result fields
  // -------------------------------------------------------------------------

  it("returns processMonitor, watchdogHandle, and deviceIdentity", async () => {
    const setupHealth = await getSetupHealth();

    const result = setupHealth({
      container: createMinimalContainer(),
      logger: createMockLogger() as any,
      daemonLogger: createMockLogger() as any,
      _createProcessMonitor: mockCreateProcessMonitor,
      _startWatchdog: mockStartWatchdog,
    });

    expect(result.processMonitor).toBe(mockProcessMonitor);
    expect(result.watchdogHandle).toBe(mockWatchdogHandle);
    expect(result.deviceIdentity).toEqual({ deviceId: "dev-abc123", publicKey: "pk-test" });
  });

  // -------------------------------------------------------------------------
  // 4. Loads device identity on success
  // -------------------------------------------------------------------------

  it("loads device identity and logs info on success", async () => {
    const daemonLogger = createMockLogger();
    const setupHealth = await getSetupHealth();

    const result = setupHealth({
      container: createMinimalContainer(),
      logger: createMockLogger() as any,
      daemonLogger: daemonLogger as any,
      _createProcessMonitor: mockCreateProcessMonitor,
      _startWatchdog: mockStartWatchdog,
    });

    expect(result.deviceIdentity).toBeDefined();
    expect(daemonLogger.info).toHaveBeenCalledWith(
      { deviceId: "dev-abc123" },
      "Device identity loaded",
    );
  });

  // -------------------------------------------------------------------------
  // 5. Sets deviceIdentity to undefined on failure, logs warn
  // -------------------------------------------------------------------------

  it("sets deviceIdentity to undefined and logs warn on identity load failure", async () => {
    mockLoadOrCreateDeviceIdentity.mockReturnValue({
      ok: false,
      error: { message: "Permission denied" },
    });

    const daemonLogger = createMockLogger();
    const setupHealth = await getSetupHealth();

    const result = setupHealth({
      container: createMinimalContainer(),
      logger: createMockLogger() as any,
      daemonLogger: daemonLogger as any,
      _createProcessMonitor: mockCreateProcessMonitor,
      _startWatchdog: mockStartWatchdog,
    });

    expect(result.deviceIdentity).toBeUndefined();
    expect(daemonLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        err: "Permission denied",
        hint: "Check file permissions in data directory",
        errorKind: "internal",
      }),
      "Device identity not available (non-fatal)",
    );
  });

  // -------------------------------------------------------------------------
  // 6. Falls back to "." when dataDir is undefined
  // -------------------------------------------------------------------------

  it("uses '.' as stateDir when dataDir is falsy", async () => {
    const container = createMinimalContainer({ dataDir: "" });
    const setupHealth = await getSetupHealth();

    setupHealth({
      container,
      logger: createMockLogger() as any,
      daemonLogger: createMockLogger() as any,
      _createProcessMonitor: mockCreateProcessMonitor,
      _startWatchdog: mockStartWatchdog,
    });

    // loadOrCreateDeviceIdentity should be called with "."
    expect(mockLoadOrCreateDeviceIdentity).toHaveBeenCalledWith(".");
  });
});

// ===========================================================================
// Monitoring tests
// ===========================================================================

describe("setupMonitoring", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  async function getSetupMonitoring() {
    const mod = await import("./setup-health.js");
    return mod.setupMonitoring;
  }

  // -------------------------------------------------------------------------
  // 1. No heartbeat when all sources disabled
  // -------------------------------------------------------------------------

  it("returns undefined heartbeatRunner when all sources disabled", async () => {
    const setupMonitoring = await getSetupMonitoring();

    const result = setupMonitoring({
      container: createMonitoringContainer(),
      schedulerLogger: createMockLogger() as any,
      logger: createMockLogger() as any,
    });

    expect(result.heartbeatRunner).toBeUndefined();
    expect(mockCreateHeartbeatRunner).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // 2. Creates heartbeat runner when disk monitoring enabled
  // -------------------------------------------------------------------------

  it("creates heartbeat runner when disk monitoring enabled and calls .start()", async () => {
    const container = createMonitoringContainer({
      monitoring: { disk: { enabled: true, thresholdPct: 90 } },
    });
    const setupMonitoring = await getSetupMonitoring();

    const result = setupMonitoring({
      container,
      schedulerLogger: createMockLogger() as any,
      logger: createMockLogger() as any,
    });

    expect(result.heartbeatRunner).toBeDefined();
    expect(mockCreateHeartbeatRunner).toHaveBeenCalledOnce();
    expect(result.heartbeatRunner!.start).toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // 3. Adds multiple sources when multiple configs enabled
  // -------------------------------------------------------------------------

  it("adds multiple sources when multiple monitoring configs enabled", async () => {
    const container = createMonitoringContainer({
      monitoring: {
        disk: { enabled: true },
        resources: { enabled: true },
        git: { enabled: true },
      },
    });
    const setupMonitoring = await getSetupMonitoring();

    setupMonitoring({
      container,
      schedulerLogger: createMockLogger() as any,
      logger: createMockLogger() as any,
    });

    expect(mockCreateDiskSpaceSource).toHaveBeenCalled();
    expect(mockCreateSystemResourcesSource).toHaveBeenCalled();
    expect(mockCreateGitWatcherSource).toHaveBeenCalled();
    expect(mockCreateSystemdServiceSource).not.toHaveBeenCalled();
    expect(mockCreateSecurityUpdateSource).not.toHaveBeenCalled();

    // Verify 3 sources passed to heartbeat runner
    const sources = mockCreateHeartbeatRunner.mock.calls[0][0].sources;
    expect(sources).toHaveLength(3);
  });

  // -------------------------------------------------------------------------
  // 4. All 5 source types can be enabled
  // -------------------------------------------------------------------------

  it("creates all 5 source types when all enabled", async () => {
    const container = createMonitoringContainer({
      monitoring: {
        disk: { enabled: true },
        resources: { enabled: true },
        systemd: { enabled: true },
        securityUpdates: { enabled: true },
        git: { enabled: true },
      },
    });
    const setupMonitoring = await getSetupMonitoring();

    setupMonitoring({
      container,
      schedulerLogger: createMockLogger() as any,
      logger: createMockLogger() as any,
    });

    const sources = mockCreateHeartbeatRunner.mock.calls[0][0].sources;
    expect(sources).toHaveLength(5);
  });

  // -------------------------------------------------------------------------
  // 5. Notification callback logs critical/alert/info correctly
  // -------------------------------------------------------------------------

  it("onNotification logs critical as error", async () => {
    const container = createMonitoringContainer({
      monitoring: { disk: { enabled: true } },
    });
    const logger = createMockLogger();
    const setupMonitoring = await getSetupMonitoring();

    setupMonitoring({
      container,
      schedulerLogger: createMockLogger() as any,
      logger: logger as any,
    });

    const onNotification = mockCreateHeartbeatRunner.mock.calls[0][0].onNotification;

    onNotification({ sourceId: "disk", level: "critical", text: "Disk full" });
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceId: "disk",
        level: "critical",
        hint: "Investigate the monitoring source for critical conditions",
        errorKind: "resource",
      }),
      "Monitoring: Disk full",
    );
  });

  it("onNotification logs alert as warn", async () => {
    const container = createMonitoringContainer({
      monitoring: { disk: { enabled: true } },
    });
    const logger = createMockLogger();
    const setupMonitoring = await getSetupMonitoring();

    setupMonitoring({
      container,
      schedulerLogger: createMockLogger() as any,
      logger: logger as any,
    });

    const onNotification = mockCreateHeartbeatRunner.mock.calls[0][0].onNotification;

    onNotification({ sourceId: "resources", level: "alert", text: "High CPU" });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceId: "resources",
        level: "alert",
        hint: "Review the monitoring source alert details",
        errorKind: "resource",
      }),
      "Monitoring: High CPU",
    );
  });

  it("onNotification logs info level notifications as info", async () => {
    const container = createMonitoringContainer({
      monitoring: { disk: { enabled: true } },
    });
    const logger = createMockLogger();
    const setupMonitoring = await getSetupMonitoring();

    setupMonitoring({
      container,
      schedulerLogger: createMockLogger() as any,
      logger: logger as any,
    });

    const onNotification = mockCreateHeartbeatRunner.mock.calls[0][0].onNotification;

    onNotification({ sourceId: "git", level: "info", text: "Repo clean" });
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ sourceId: "git", level: "info" }),
      "Monitoring: Repo clean",
    );
  });

  // -------------------------------------------------------------------------
  // 6. Passes quietHoursConfig and criticalBypass
  // -------------------------------------------------------------------------

  it("passes quietHoursConfig and criticalBypass from scheduler config", async () => {
    const container = createMonitoringContainer({
      monitoring: { disk: { enabled: true } },
      scheduler: {
        quietHours: { enabled: true, criticalBypass: false, start: "22:00", end: "08:00" },
      },
    });
    const setupMonitoring = await getSetupMonitoring();

    setupMonitoring({
      container,
      schedulerLogger: createMockLogger() as any,
      logger: createMockLogger() as any,
    });

    const runnerArgs = mockCreateHeartbeatRunner.mock.calls[0][0];
    expect(runnerArgs.quietHoursConfig).toEqual(
      expect.objectContaining({ enabled: true, start: "22:00", end: "08:00" }),
    );
    expect(runnerArgs.criticalBypass).toBe(false);
  });

  // -------------------------------------------------------------------------
  // 7. Passes heartbeat config
  // -------------------------------------------------------------------------

  it("passes heartbeat config (intervalMs, showOk, showAlerts)", async () => {
    const container = createMonitoringContainer({
      monitoring: { disk: { enabled: true } },
      scheduler: {
        heartbeat: { intervalMs: 30_000, showOk: true, showAlerts: false },
      },
    });
    const setupMonitoring = await getSetupMonitoring();

    setupMonitoring({
      container,
      schedulerLogger: createMockLogger() as any,
      logger: createMockLogger() as any,
    });

    const runnerArgs = mockCreateHeartbeatRunner.mock.calls[0][0];
    expect(runnerArgs.config).toEqual({
      intervalMs: 30_000,
      showOk: true,
      showAlerts: false,
    });
  });

  // -------------------------------------------------------------------------
  // 8. Logs source count on start
  // -------------------------------------------------------------------------

  it("logs source count when heartbeat runner started", async () => {
    const container = createMonitoringContainer({
      monitoring: {
        disk: { enabled: true },
        resources: { enabled: true },
      },
    });
    const schedulerLogger = createMockLogger();
    const setupMonitoring = await getSetupMonitoring();

    setupMonitoring({
      container,
      schedulerLogger: schedulerLogger as any,
      logger: createMockLogger() as any,
    });

    expect(schedulerLogger.info).toHaveBeenCalledWith(
      { sourceCount: 2 },
      "Monitoring heartbeat runner started",
    );
  });
});
