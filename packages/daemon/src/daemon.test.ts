// SPDX-License-Identifier: Apache-2.0
import { PerAgentConfigSchema, type AppContainer, type GatewayConfig } from "@comis/core";
import type { GatewayServerHandle } from "@comis/gateway";
import type { ComisLogger } from "@comis/infra";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { WatchdogHandle } from "./health/watchdog.js";
import type { LatencyRecorder } from "./observability/latency-recorder.js";
import type { LogLevelManager } from "./observability/log-infra.js";
import type { TokenTracker } from "./observability/token-tracker.js";
import type { ShutdownHandle } from "./process/graceful-shutdown.js";
import type { ProcessMonitor } from "./process/process-monitor.js";
import { main, type DaemonOverrides, hardenDataDirPermissions, runPreflightDoctor, applyInspectDefaultsForLogging } from "./daemon.js";
import type { MediaResult } from "./wiring/setup-media.js";
import * as fs from "node:fs";
import * as os from "node:os";
import * as nodePath from "node:path";
import { inspect } from "node:util";
import { createMockLogger } from "../../../test/support/mock-logger.js";
import { createMockEventBus } from "../../../test/support/mock-event-bus.js";

// ---------------------------------------------------------------------------
// Helpers
function createMockContainer(gatewayOverrides?: Partial<GatewayConfig>): AppContainer {
  return {
    config: {
      daemon: { logLevels: {} },
      gateway: {
        enabled: false,
        host: "0.0.0.0",
        port: 4766,
        tokens: [],
        rateLimit: { windowMs: 60000, maxRequests: 100 },
        web: { enabled: false },
        maxBatchSize: 50,
        wsHeartbeatMs: 30000,
        ...gatewayOverrides,
      },
      memory: {
        dbPath: ":memory:",
        walMode: false,
        embeddingModel: "text-embedding-3-small",
        embeddingDimensions: 1536,
        compaction: { enabled: false, threshold: 1000, targetSize: 500 },
        retention: { maxAgeDays: 0, maxEntries: 0 },
      },
      embedding: {
        enabled: false,
        provider: "auto" as const,
        local: { modelUri: "", modelsDir: "models", gpu: "auto" as const },
        openai: { model: "text-embedding-3-small", dimensions: 1536 },
        cache: { maxEntries: 10_000 },
        batch: { batchSize: 100, indexOnStartup: true },
        autoReindex: true,
      },
      dataDir: "",
      agents: {
        default: PerAgentConfigSchema.parse({
          name: "test-agent",
          model: "claude-sonnet-4-5-20250929",
          provider: "anthropic",
          maxSteps: 25,
          budgets: { perExecution: 100_000, perHour: 500_000, perDay: 2_000_000 },
          circuitBreaker: { failureThreshold: 5, resetTimeoutMs: 60_000, halfOpenTimeoutMs: 30_000 },
          modelRoutes: {},
          rag: {
            enabled: false,
            maxResults: 5,
            maxContextChars: 4000,
            minScore: 0.1,
            includeTrustLevels: ["system", "learned"],
          },
        }),
      },
      routing: {
        defaultAgentId: "default",
        bindings: [],
      },
      monitoring: {
        disk: { enabled: false, paths: ["/"], thresholdPercent: 90 },
        resources: { enabled: false, cpuThresholdPercent: 85, memoryThresholdPercent: 90 },
        systemd: { enabled: false, services: [] },
        securityUpdates: { enabled: false, securityOnly: true },
        git: { enabled: false, repositories: [], checkRemote: true },
      },
      scheduler: {
        cron: { enabled: false, storeDir: "", maxConcurrentRuns: 3, defaultTimezone: "", maxJobs: 100 },
        heartbeat: { enabled: false, intervalMs: 300_000, showOk: false, showAlerts: true },
        quietHours: {
          enabled: false,
          start: "22:00",
          end: "07:00",
          timezone: "",
          criticalBypass: true,
        },
        execution: {
          lockDir: "./data/scheduler/locks",
          staleMs: 600_000,
          updateMs: 30_000,
          logDir: "./data/scheduler/logs",
          maxLogBytes: 2_000_000,
          keepLines: 2_000,
        },
        tasks: {
          enabled: false,
          confidenceThreshold: 0.8,
          storeDir: "./data/scheduler/tasks",
        },
      },
      integrations: {
        mcp: { servers: [] },
        media: {
          transcription: { provider: "openai", maxFileSizeMb: 25, timeoutMs: 60000, autoTranscribe: true, preflight: true, fallbackProviders: [] },
          tts: { provider: "openai", voice: "alloy", format: "opus", autoMode: "never", tagPattern: "\\[\\[tts\\]\\]", outputFormats: {} },
          imageAnalysis: { maxFileSizeMb: 20 },
          vision: { enabled: false, defaultProvider: undefined, defaultScopeAction: "allow", scopeRules: [] },
          linkUnderstanding: { enabled: false, maxUrls: 3, maxContentChars: 5000, timeoutMs: 10_000 },
          infrastructure: {
            maxRemoteFetchBytes: 25 * 1024 * 1024,
            concurrencyLimit: 3,
            tempFileTtlMs: 1_800_000,
            tempCleanupIntervalMs: 300_000,
          },
          documentExtraction: {
            enabled: false,
            allowedMimes: [],
            maxBytes: 10_485_760,
            maxChars: 200_000,
            maxTotalChars: 500_000,
            maxPages: 50,
            timeoutMs: 30_000,
            pdfImageFallbackThreshold: 100,
          },
          persistence: {
            enabled: false,
            maxStorageMb: 1024,
            maxFileBytes: 52_428_800,
          },
          imageGeneration: {
            provider: "fal",
            safetyChecker: true,
            maxPerHour: 10,
            defaultSize: "1024x1024",
            timeoutMs: 60_000,
          },
        },
      },
      security: {
        agentToAgent: {
          enabled: true,
          maxPingPongTurns: 3,
          allowAgents: [],
          subAgentRetentionMs: 3_600_000,
          waitTimeoutMs: 60_000,
        },
      },
      approvals: {
        enabled: false,
        defaultMode: "auto" as const,
        rules: [],
        defaultTimeoutMs: 300_000,
      },
      lifecycleReactions: { enabled: false, emojiTier: "unicode", timing: { debounceMs: 700, holdDoneMs: 3000, holdErrorMs: 5000, stallSoftMs: 15000, stallHardMs: 30000 }, perChannel: {} },
      observability: { persistence: { enabled: false, retentionDays: 30, snapshotIntervalMs: 300_000 } },
      deliveryQueue: { enabled: false, maxQueueDepth: 10_000, defaultMaxAttempts: 5, defaultExpireMs: 3_600_000, drainOnStartup: true, drainBudgetMs: 60_000, pruneIntervalMs: 300_000 },
      providers: { entries: {} },
      tenantId: "default",
      logLevel: "info",
      agentDir: "/tmp/test-agent-dir",
      // Phase 7 plan 08: setupSingleAgent now reads container.config.oauth.storage
      // for OAuth credential store wiring. Default to "file" (the YAML default).
      oauth: { storage: "file" as const },
    } as unknown as AppContainer["config"],
    eventBus: createMockEventBus(),
    secretManager: {
      get: vi.fn().mockReturnValue(undefined),
      keys: vi.fn().mockReturnValue([]),
    } as unknown as AppContainer["secretManager"],
    shutdown: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
  };
}

function createMockLogLevelManager(): LogLevelManager {
  return {
    getLogger: vi.fn().mockReturnValue(createMockLogger()),
    setLevel: vi.fn(),
    setGlobalLevel: vi.fn(),
  };
}

function createMockTokenTracker(): TokenTracker {
  return {
    record: vi.fn(),
    getByTrace: vi.fn().mockReturnValue([]),
    getByProvider: vi.fn().mockReturnValue({ totalTokens: 0, totalCost: 0, count: 0 }),
    getByModel: vi.fn().mockReturnValue({ totalTokens: 0, totalCost: 0, count: 0 }),
    getAll: vi.fn().mockReturnValue([]),
    prune: vi.fn().mockReturnValue(0),
  };
}

function createMockLatencyRecorder(): LatencyRecorder {
  return {
    startTimer: vi.fn().mockReturnValue(() => 0),
    record: vi.fn(),
    getStats: vi.fn().mockReturnValue({ count: 0, mean: 0, min: 0, max: 0, p50: 0, p99: 0 }),
    reset: vi.fn(),
    prune: vi.fn().mockReturnValue(0),
  };
}

function createMockProcessMonitor(): ProcessMonitor {
  return {
    start: vi.fn(),
    stop: vi.fn(),
    collect: vi.fn(),
  };
}

function createMockShutdownHandle(): ShutdownHandle {
  return {
    isShuttingDown: false,
    trigger: vi.fn<(signal: string) => Promise<void>>().mockResolvedValue(undefined),
    dispose: vi.fn(),
  };
}

function createMockWatchdogHandle(): WatchdogHandle {
  return {
    stop: vi.fn(),
  };
}

function createMockGatewayHandle(): GatewayServerHandle {
  return {
    app: { route: vi.fn(), use: vi.fn() } as unknown as GatewayServerHandle["app"],
    start: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    stop: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
  };
}

function createMockMediaResult(): MediaResult {
  return {
    linkRunner: { run: vi.fn().mockResolvedValue([]) } as unknown as MediaResult["linkRunner"],
    ffmpegCapabilities: { ffmpegAvailable: false, ffprobeAvailable: false },
    mediaTempManager: {
      init: vi.fn().mockResolvedValue({ ok: true }),
      startCleanupInterval: vi.fn(),
      stopCleanupInterval: vi.fn(),
      getManagedDir: vi.fn().mockReturnValue("/tmp/test-media"),
    } as unknown as MediaResult["mediaTempManager"],
    mediaSemaphore: { acquire: vi.fn().mockResolvedValue(vi.fn()), concurrencyLimit: 3 } as unknown as MediaResult["mediaSemaphore"],
    ssrfFetcher: { fetch: vi.fn() } as unknown as MediaResult["ssrfFetcher"],
  };
}

/**
 * Build a full set of overrides that mock all dependencies.
 * Tracks call order for sequence verification.
 */
function buildOverrides(gatewayOverrides?: Partial<GatewayConfig>) {
  const callOrder: string[] = [];
  const container = createMockContainer(gatewayOverrides);
  const logger = createMockLogger();
  const logLevelManager = createMockLogLevelManager();
  const tokenTracker = createMockTokenTracker();
  const latencyRecorder = createMockLatencyRecorder();
  const processMonitor = createMockProcessMonitor();
  const shutdownHandle = createMockShutdownHandle();
  const watchdogHandle = createMockWatchdogHandle();
  const gatewayHandle = createMockGatewayHandle();

  const overrides: DaemonOverrides = {
    setupMedia: vi.fn().mockResolvedValue(createMockMediaResult()),
    bootstrap: vi.fn().mockImplementation(() => {
      callOrder.push("bootstrap");
      return { ok: true, value: container };
    }),
    createTracingLogger: vi.fn().mockImplementation(() => {
      callOrder.push("createTracingLogger");
      return logger;
    }),
    createLogLevelManager: vi.fn().mockImplementation(() => {
      callOrder.push("createLogLevelManager");
      return logLevelManager;
    }),
    createTokenTracker: vi.fn().mockImplementation(() => {
      callOrder.push("createTokenTracker");
      return tokenTracker;
    }),
    createLatencyRecorder: vi.fn().mockImplementation(() => {
      callOrder.push("createLatencyRecorder");
      return latencyRecorder;
    }),
    createProcessMonitor: vi.fn().mockImplementation(() => {
      callOrder.push("createProcessMonitor");
      return processMonitor;
    }),
    registerGracefulShutdown: vi.fn().mockImplementation(() => {
      callOrder.push("registerGracefulShutdown");
      return shutdownHandle;
    }),
    startWatchdog: vi.fn().mockImplementation(() => {
      callOrder.push("startWatchdog");
      return watchdogHandle;
    }),
    createGatewayServer: vi.fn().mockImplementation(() => {
      callOrder.push("createGatewayServer");
      return gatewayHandle;
    }),
    exit: vi.fn(),
  };

  return {
    overrides,
    callOrder,
    mocks: {
      container,
      logger,
      logLevelManager,
      tokenTracker,
      latencyRecorder,
      processMonitor,
      shutdownHandle,
      watchdogHandle,
      gatewayHandle,
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("daemon main()", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("completes full startup sequence in correct order (gateway disabled)", async () => {
    const { overrides, callOrder } = buildOverrides();

    await main(overrides);

    expect(callOrder).toEqual([
      "bootstrap",
      "createTracingLogger",
      "createLogLevelManager",
      "createTokenTracker",
      "createLatencyRecorder",
      "createProcessMonitor",
      "startWatchdog",
      "registerGracefulShutdown",
    ]);
  });

  it("completes full startup sequence with gateway enabled", async () => {
    const { overrides, callOrder } = buildOverrides({
      enabled: true,
      tokens: [{ id: "test", secret: "s3cret", scopes: ["rpc"] }],
    });

    await main(overrides);

    expect(callOrder).toEqual([
      "bootstrap",
      "createTracingLogger",
      "createLogLevelManager",
      "createTokenTracker",
      "createLatencyRecorder",
      "createProcessMonitor",
      "startWatchdog",
      "createGatewayServer",
      "registerGracefulShutdown",
    ]);
  });

  it("returns DaemonInstance with all services", async () => {
    const { overrides, mocks } = buildOverrides();

    const instance = await main(overrides);

    // container is spread-cloned during SecretRef resolution, so identity differs
    expect(instance.container.config).toStrictEqual(mocks.container.config);
    expect(instance.logger).toBe(mocks.logger);
    expect(instance.logLevelManager).toBe(mocks.logLevelManager);
    expect(instance.tokenTracker).toBe(mocks.tokenTracker);
    expect(instance.latencyRecorder).toBe(mocks.latencyRecorder);
    expect(instance.processMonitor).toBe(mocks.processMonitor);
    expect(instance.shutdownHandle).toBe(mocks.shutdownHandle);
    expect(instance.watchdogHandle).toBe(mocks.watchdogHandle);
  });

  it("returns gatewayHandle when gateway is enabled", async () => {
    const { overrides, mocks } = buildOverrides({
      enabled: true,
      tokens: [{ id: "test", secret: "s3cret", scopes: ["rpc"] }],
    });

    const instance = await main(overrides);

    expect(instance.gatewayHandle).toBe(mocks.gatewayHandle);
    expect(mocks.gatewayHandle.start).toHaveBeenCalledTimes(1);
  });

  it("does not create gateway when disabled", async () => {
    const { overrides } = buildOverrides();

    const instance = await main(overrides);

    expect(instance.gatewayHandle).toBeUndefined();
    expect(overrides.createGatewayServer).not.toHaveBeenCalled();
  });

  it("passes onShutdown callback when gateway is enabled", async () => {
    const { overrides } = buildOverrides({
      enabled: true,
      tokens: [{ id: "test", secret: "s3cret", scopes: ["rpc"] }],
    });

    await main(overrides);

    expect(overrides.registerGracefulShutdown).toHaveBeenCalledWith(
      expect.objectContaining({
        onShutdown: expect.any(Function),
      }),
    );
  });

  it("always passes onShutdown for db cleanup even when gateway is disabled", async () => {
    const { overrides } = buildOverrides();

    await main(overrides);

    expect(overrides.registerGracefulShutdown).toHaveBeenCalledWith(
      expect.objectContaining({
        onShutdown: expect.any(Function),
      }),
    );
  });

  it("starts process monitor after creation", async () => {
    const { overrides, mocks } = buildOverrides();

    await main(overrides);

    expect(mocks.processMonitor.start).toHaveBeenCalledTimes(1);
  });

  it("logs startup complete message with structured banner", async () => {
    const { overrides, mocks } = buildOverrides();

    await main(overrides);

    // Startup banner goes through daemonLogger (module-bound logger from logLevelManager)
    const daemonLogger = (mocks.logLevelManager.getLogger as ReturnType<typeof vi.fn>).mock.results[0]?.value;
    expect(daemonLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        version: expect.any(String),
        agents: expect.any(Array),
        channels: expect.any(Array),
      }),
      "Comis daemon started",
    );
  });

  it("uses COMIS_CONFIG_PATHS when set (filtered to existing files)", async () => {
    process.env["COMIS_CONFIG_PATHS"] = "/custom/a.yaml:/custom/b.yaml";
    const { overrides } = buildOverrides();

    await main(overrides);

    // Non-existent paths are filtered out by existsSync before bootstrap.
    // bootstrap now receives mergedEnv (process.env when no secret store).
    expect(overrides.bootstrap).toHaveBeenCalledWith(
      expect.objectContaining({ configPaths: [] }),
    );
  });

  it("uses default config paths when COMIS_CONFIG_PATHS is not set", async () => {
    delete process.env["COMIS_CONFIG_PATHS"];
    const { overrides } = buildOverrides();

    await main(overrides);

    // Default paths are ~/.comis/config.yaml and ~/.comis/config.local.yaml,
    // filtered to only files that exist on disk
    const call = (overrides.bootstrap as ReturnType<typeof vi.fn>).mock.calls[0]![0] as {
      configPaths: string[];
    };
    for (const p of call.configPaths) {
      expect(p).toMatch(/\.comis\/config(\.local)?\.yaml$/);
    }
  });

  it("throws on bootstrap failure", async () => {
    const { overrides } = buildOverrides();
    (overrides.bootstrap as ReturnType<typeof vi.fn>).mockReturnValue({
      ok: false,
      error: { message: "Config file not found" },
    });

    await expect(main(overrides)).rejects.toThrow("Bootstrap failed: Config file not found");
  });

  it("passes container to graceful shutdown", async () => {
    const { overrides, mocks } = buildOverrides();

    await main(overrides);

    expect(overrides.registerGracefulShutdown).toHaveBeenCalledWith(
      expect.objectContaining({
        container: mocks.container,
        processMonitor: mocks.processMonitor,
      }),
    );
  });

  it("passes process monitor to watchdog for health gating", async () => {
    const { overrides, mocks } = buildOverrides();

    await main(overrides);

    expect(overrides.startWatchdog).toHaveBeenCalledWith(
      expect.objectContaining({
        processMonitor: mocks.processMonitor,
      }),
    );
  });

  it("passes exit override to graceful shutdown", async () => {
    const { overrides } = buildOverrides();
    const mockExit = vi.fn();
    overrides.exit = mockExit;

    await main(overrides);

    expect(overrides.registerGracefulShutdown).toHaveBeenCalledWith(
      expect.objectContaining({
        exit: mockExit,
      }),
    );
  });

  // -------------------------------------------------------------------------
  // Layer 3C (260501-07g): boot-time PROVIDER_OVERRIDES staleness validator
  // -------------------------------------------------------------------------
  // The daemon calls validateProviderOverrides during the "3.6" startup step.
  // Against the LIVE pi-ai catalog, two override keys are currently orphans
  // (anthropic-vertex, azure-openai). The validator emits one structured WARN
  // per orphan key with errorKind:"config" and module:"agent.capabilities".

  it("emits structured WARNs for orphaned PROVIDER_OVERRIDES keys at boot", async () => {
    const { overrides, mocks } = buildOverrides();

    await main(overrides);

    // The mock LogLevelManager returns the same mock logger for every
    // getLogger() call -- assert at least one warn carrying the validator's
    // signature was emitted during boot.
    const sharedMockLogger = (mocks.logLevelManager.getLogger as ReturnType<typeof vi.fn>)
      .mock.results[0]?.value;
    expect(sharedMockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: expect.any(String),
        hint: expect.stringContaining("PROVIDER_OVERRIDES"),
        errorKind: "config",
        module: "agent.capabilities",
      }),
      "Capability override has no matching pi-ai provider",
    );
  });
});

// ---------------------------------------------------------------------------
// hardenDataDirPermissions
// ---------------------------------------------------------------------------

describe("hardenDataDirPermissions", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = fs.mkdtempSync(nodePath.join(os.tmpdir(), "daemon-perm-test-"));
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it("corrects data directory permissions from 0o755 to 0o700", () => {
    fs.chmodSync(testDir, 0o755);
    const corrections = hardenDataDirPermissions(testDir);

    const dirCorrection = corrections.find((c) => c.file === testDir);
    expect(dirCorrection).toBeDefined();
    expect(dirCorrection!.oldMode).toBe(0o755);
    expect(dirCorrection!.newMode).toBe(0o700);

    const stat = fs.statSync(testDir);
    expect(stat.mode & 0o777).toBe(0o700);
  });

  it("corrects sensitive file permissions from 0o644 to 0o600", () => {
    fs.chmodSync(testDir, 0o700);
    const configPath = nodePath.join(testDir, "config.yaml");
    fs.writeFileSync(configPath, "key: value");
    fs.chmodSync(configPath, 0o644);

    const corrections = hardenDataDirPermissions(testDir);

    const fileCorrection = corrections.find((c) => c.file === configPath);
    expect(fileCorrection).toBeDefined();
    expect(fileCorrection!.oldMode).toBe(0o644);
    expect(fileCorrection!.newMode).toBe(0o600);

    const stat = fs.statSync(configPath);
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it("returns no corrections when permissions are already correct", () => {
    fs.chmodSync(testDir, 0o700);
    const envPath = nodePath.join(testDir, ".env");
    fs.writeFileSync(envPath, "SECRET=val");
    fs.chmodSync(envPath, 0o600);

    const corrections = hardenDataDirPermissions(testDir);
    expect(corrections).toEqual([]);
  });

  it("handles non-existent sensitive files gracefully", () => {
    fs.chmodSync(testDir, 0o700);
    // No files in testDir -- should not throw
    const corrections = hardenDataDirPermissions(testDir);
    expect(corrections).toEqual([]);
  });

  it("scans all known sensitive files", () => {
    fs.chmodSync(testDir, 0o700);
    const files = ["config.yaml", "config.local.yaml", ".env", "secrets.db"];
    for (const f of files) {
      const fp = nodePath.join(testDir, f);
      fs.writeFileSync(fp, "data");
      fs.chmodSync(fp, 0o644);
    }

    const corrections = hardenDataDirPermissions(testDir);
    // All 4 files should be corrected
    expect(corrections).toHaveLength(4);
    for (const c of corrections) {
      expect(c.oldMode).toBe(0o644);
      expect(c.newMode).toBe(0o600);
    }
  });
});

describe("runPreflightDoctor", () => {
  type FakeDbCtor = new (path: string) => { prepare(sql: string): { get(): unknown }; close(): void };

  const okLoader: () => Promise<FakeDbCtor> = async () => {
    class OkDb {
      constructor(_path: string) {}
      prepare(_sql: string) { return { get: () => ({ ok: 1 }) }; }
      close(): void {}
    }
    return OkDb as unknown as FakeDbCtor;
  };

  it("passes silently when better-sqlite3 loads and returns a row", async () => {
    const exitFn = vi.fn();
    const writes: string[] = [];
    await runPreflightDoctor(exitFn, {
      stderrWrite: (s) => writes.push(s),
      loadBetterSqlite3: okLoader,
    });
    expect(exitFn).not.toHaveBeenCalled();
    expect(writes).toEqual([]);
  });

  it("emits FATAL JSON and exits 78 when Database constructor throws (bindings missing)", async () => {
    const exitFn = vi.fn();
    const writes: string[] = [];
    const brokenLoader: () => Promise<FakeDbCtor> = async () => {
      class BrokenDb {
        constructor(_path: string) { throw new Error("Cannot find module 'bindings'"); }
        prepare(_sql: string) { return { get: () => null }; }
        close(): void {}
      }
      return BrokenDb as unknown as FakeDbCtor;
    };
    await runPreflightDoctor(exitFn, {
      stderrWrite: (s) => writes.push(s),
      loadBetterSqlite3: brokenLoader,
    });
    expect(exitFn).toHaveBeenCalledExactlyOnceWith(78);
    expect(writes).toHaveLength(1);
    const record = JSON.parse(writes[0]!.trim());
    expect(record.level).toBe(60);
    expect(record.module).toBe("preflight");
    expect(record.errorKind).toBe("dependency");
    expect(record.err).toContain("Cannot find module 'bindings'");
    expect(record.hint).toMatch(/npm rebuild better-sqlite3/);
    expect(record.msg).toContain("Preflight check failed");
  });

  it("fails when the sentinel query returns null", async () => {
    const exitFn = vi.fn();
    const writes: string[] = [];
    const nullRowLoader: () => Promise<FakeDbCtor> = async () => {
      class NullDb {
        constructor(_path: string) {}
        prepare(_sql: string) { return { get: () => null }; }
        close(): void {}
      }
      return NullDb as unknown as FakeDbCtor;
    };
    await runPreflightDoctor(exitFn, {
      stderrWrite: (s) => writes.push(s),
      loadBetterSqlite3: nullRowLoader,
    });
    expect(exitFn).toHaveBeenCalledExactlyOnceWith(78);
    expect(writes).toHaveLength(1);
    const record = JSON.parse(writes[0]!.trim());
    expect(record.err).toContain("no row from sentinel query");
  });

  it("closes the probe database even if the sentinel query throws", async () => {
    const exitFn = vi.fn();
    const writes: string[] = [];
    let closed = false;
    const throwingQueryLoader: () => Promise<FakeDbCtor> = async () => {
      class ThrowDb {
        constructor(_path: string) {}
        prepare(_sql: string) { return { get: () => { throw new Error("sqlite runtime error"); } }; }
        close(): void { closed = true; }
      }
      return ThrowDb as unknown as FakeDbCtor;
    };
    await runPreflightDoctor(exitFn, {
      stderrWrite: (s) => writes.push(s),
      loadBetterSqlite3: throwingQueryLoader,
    });
    expect(closed).toBe(true);
    expect(exitFn).toHaveBeenCalledExactlyOnceWith(78);
  });
});

// ---------------------------------------------------------------------------
// applyInspectDefaultsForLogging
// ---------------------------------------------------------------------------

describe("applyInspectDefaultsForLogging", () => {
  let savedDepth: number | null;
  let savedBreakLength: number;

  beforeEach(() => {
    savedDepth = inspect.defaultOptions.depth ?? null;
    savedBreakLength = inspect.defaultOptions.breakLength ?? 80;
    // Reset to Node defaults for each test so prior test state cannot leak.
    inspect.defaultOptions.depth = 2;
    inspect.defaultOptions.breakLength = 80;
  });

  afterEach(() => {
    inspect.defaultOptions.depth = savedDepth;
    inspect.defaultOptions.breakLength = savedBreakLength;
  });

  it("sets depth=null and breakLength=Infinity when ANTHROPIC_LOG=debug", () => {
    const result = applyInspectDefaultsForLogging({ ANTHROPIC_LOG: "debug" });
    expect(inspect.defaultOptions.depth).toBeNull();
    expect(inspect.defaultOptions.breakLength).toBe(Infinity);
    expect(result).toEqual({ depthChanged: true, breakLengthChanged: true });
  });

  it("sets depth=null and breakLength=Infinity when ANTHROPIC_LOG=info", () => {
    const result = applyInspectDefaultsForLogging({ ANTHROPIC_LOG: "info" });
    expect(inspect.defaultOptions.depth).toBeNull();
    expect(inspect.defaultOptions.breakLength).toBe(Infinity);
    expect(result).toEqual({ depthChanged: true, breakLengthChanged: true });
  });

  it("does not mutate inspect defaults when ANTHROPIC_LOG is unset", () => {
    const result = applyInspectDefaultsForLogging({});
    expect(inspect.defaultOptions.depth).toBe(2);
    expect(inspect.defaultOptions.breakLength).toBe(80);
    expect(result).toEqual({ depthChanged: false, breakLengthChanged: false });
  });

  it("does not mutate inspect defaults for non-debug/info ANTHROPIC_LOG values", () => {
    const r1 = applyInspectDefaultsForLogging({ ANTHROPIC_LOG: "warn" });
    expect(inspect.defaultOptions.depth).toBe(2);
    expect(inspect.defaultOptions.breakLength).toBe(80);
    expect(r1).toEqual({ depthChanged: false, breakLengthChanged: false });

    const r2 = applyInspectDefaultsForLogging({ ANTHROPIC_LOG: "" });
    expect(inspect.defaultOptions.depth).toBe(2);
    expect(inspect.defaultOptions.breakLength).toBe(80);
    expect(r2).toEqual({ depthChanged: false, breakLengthChanged: false });
  });
});
