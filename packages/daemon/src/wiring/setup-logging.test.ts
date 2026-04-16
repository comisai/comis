import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMockLogger } from "../../../../test/support/mock-logger.js";

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

const mockCreateFileTransport = vi.hoisted(() => vi.fn(() => ({ target: "file-transport" })));
const mockIsPm2Managed = vi.hoisted(() => vi.fn(() => false));

vi.mock("../observability/log-infra.js", () => ({
  createFileTransport: mockCreateFileTransport,
  isPm2Managed: mockIsPm2Managed,
}));

const mockReadFileSync = vi.hoisted(() => vi.fn(() => JSON.stringify({ version: "1.2.3" })));
vi.mock("node:fs", () => ({
  readFileSync: mockReadFileSync,
}));

// ---------------------------------------------------------------------------
// Helpers
function createMinimalContainer(overrides: Record<string, any> = {}) {
  return {
    config: {
      daemon: { logging: undefined },
      logLevel: undefined,
      ...overrides,
    },
    eventBus: { on: vi.fn(), emit: vi.fn() },
  } as any;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("setupLogging", () => {
  let mockLogLevelManager: any;
  let mockCreateTracingLogger: ReturnType<typeof vi.fn>;
  let mockCreateLogLevelManager: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();

    mockLogLevelManager = {
      getLogger: vi.fn(() => createMockLogger()),
    };

    mockCreateTracingLogger = vi.fn(() => createMockLogger());
    mockCreateLogLevelManager = vi.fn(() => mockLogLevelManager);
  });

  async function getSetupLogging() {
    const mod = await import("./setup-logging.js");
    return mod.setupLogging;
  }

  // -------------------------------------------------------------------------
  // 1. Returns all 7 module-bound loggers and logLevelManager
  // -------------------------------------------------------------------------

  it("returns all 7 module-bound loggers and logLevelManager", async () => {
    const setupLogging = await getSetupLogging();
    const result = setupLogging({
      container: createMinimalContainer(),
      instanceId: "test-inst",
      _createTracingLogger: mockCreateTracingLogger,
      _createLogLevelManager: mockCreateLogLevelManager,
    });

    expect(result.logger).toBeDefined();
    expect(result.logLevelManager).toBe(mockLogLevelManager);
    expect(result.daemonLogger).toBeDefined();
    expect(result.gatewayLogger).toBeDefined();
    expect(result.channelsLogger).toBeDefined();
    expect(result.agentLogger).toBeDefined();
    expect(result.schedulerLogger).toBeDefined();
    expect(result.skillsLogger).toBeDefined();
    expect(result.memoryLogger).toBeDefined();

    // Verify getLogger was called for all 7 modules
    const calls = mockLogLevelManager.getLogger.mock.calls.map((c: any[]) => c[0]);
    expect(calls).toContain("daemon");
    expect(calls).toContain("gateway");
    expect(calls).toContain("channels");
    expect(calls).toContain("agent");
    expect(calls).toContain("scheduler");
    expect(calls).toContain("skills");
    expect(calls).toContain("memory");
  });

  // -------------------------------------------------------------------------
  // 2. Creates file transport when logging config is set
  // -------------------------------------------------------------------------

  it("creates file transport when daemon.logging is set", async () => {
    const loggingConfig = { directory: "/var/log/comis", maxFiles: 5 };
    const container = createMinimalContainer({
      daemon: { logging: loggingConfig },
      logLevel: "debug",
    });

    const setupLogging = await getSetupLogging();
    setupLogging({
      container,
      instanceId: "test-inst",
      _createTracingLogger: mockCreateTracingLogger,
      _createLogLevelManager: mockCreateLogLevelManager,
    });

    expect(mockCreateFileTransport).toHaveBeenCalledWith(loggingConfig, "debug");
  });

  // -------------------------------------------------------------------------
  // 3. Skips file transport when logging config is undefined
  // -------------------------------------------------------------------------

  it("skips file transport when daemon.logging is undefined", async () => {
    const container = createMinimalContainer({ daemon: { logging: undefined } });

    const setupLogging = await getSetupLogging();
    setupLogging({
      container,
      instanceId: "test-inst",
      _createTracingLogger: mockCreateTracingLogger,
      _createLogLevelManager: mockCreateLogLevelManager,
    });

    expect(mockCreateFileTransport).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // 4. Passes configLogLevel or defaults to "info"
  // -------------------------------------------------------------------------

  it("passes configLogLevel to _createTracingLogger", async () => {
    const container = createMinimalContainer({ logLevel: "warn" });

    const setupLogging = await getSetupLogging();
    setupLogging({
      container,
      instanceId: "test-inst",
      _createTracingLogger: mockCreateTracingLogger,
      _createLogLevelManager: mockCreateLogLevelManager,
    });

    expect(mockCreateTracingLogger).toHaveBeenCalledWith(
      expect.objectContaining({ level: "warn" }),
    );
  });

  it("defaults to 'info' when logLevel is undefined", async () => {
    const container = createMinimalContainer({ logLevel: undefined });

    const setupLogging = await getSetupLogging();
    setupLogging({
      container,
      instanceId: "test-inst",
      _createTracingLogger: mockCreateTracingLogger,
      _createLogLevelManager: mockCreateLogLevelManager,
    });

    expect(mockCreateTracingLogger).toHaveBeenCalledWith(
      expect.objectContaining({ level: "info" }),
    );
  });

  // -------------------------------------------------------------------------
  // 5. Binds instanceId to root logger via .child()
  // -------------------------------------------------------------------------

  it("binds instanceId to root logger via .child()", async () => {
    const rawLogger = createMockLogger();
    mockCreateTracingLogger.mockReturnValue(rawLogger);

    const setupLogging = await getSetupLogging();
    setupLogging({
      container: createMinimalContainer(),
      instanceId: "abcd1234",
      _createTracingLogger: mockCreateTracingLogger,
      _createLogLevelManager: mockCreateLogLevelManager,
    });

    expect(rawLogger.child).toHaveBeenCalledWith({ instanceId: "abcd1234" });
  });

  // -------------------------------------------------------------------------
  // 6. Reads daemon version from package.json
  // -------------------------------------------------------------------------

  it("reads daemon version from package.json", async () => {
    mockReadFileSync.mockReturnValue(JSON.stringify({ version: "2.5.0" }));

    const setupLogging = await getSetupLogging();
    const result = setupLogging({
      container: createMinimalContainer(),
      instanceId: "test-inst",
      _createTracingLogger: mockCreateTracingLogger,
      _createLogLevelManager: mockCreateLogLevelManager,
    });

    expect(result.daemonVersion).toBe("2.5.0");
  });

  // -------------------------------------------------------------------------
  // 7. Falls back to "unknown" and logs warn when readFileSync throws
  // -------------------------------------------------------------------------

  it("falls back to 'unknown' when readFileSync throws", async () => {
    mockReadFileSync.mockImplementation(() => { throw new Error("ENOENT"); });

    const setupLogging = await getSetupLogging();
    const result = setupLogging({
      container: createMinimalContainer(),
      instanceId: "test-inst",
      _createTracingLogger: mockCreateTracingLogger,
      _createLogLevelManager: mockCreateLogLevelManager,
    });

    expect(result.daemonVersion).toBe("unknown");
    // The logger.warn is called on the child logger (returned by .child())
    // Since our mock child returns the same logger, check the logger
    const boundLogger = result.logger;
    expect(boundLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        hint: "Check that packages/daemon/package.json exists and is readable",
        errorKind: "config",
      }),
      "Failed to read daemon version from package.json",
    );
  });
});
