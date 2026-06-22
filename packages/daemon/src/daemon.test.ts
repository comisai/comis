// SPDX-License-Identifier: Apache-2.0
import { PerAgentConfigSchema, ToolingConfigSchema, type AppContainer, type GatewayConfig } from "@comis/core";
import type { GatewayServerHandle } from "@comis/gateway";
import type { ComisLogger } from "@comis/infra";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { LogLevelManager } from "./observability/log-infra.js";
import type { TokenTracker } from "./observability/token-tracker.js";
import type { ShutdownHandle } from "./wiring/setup-shutdown.js";
import type { ProcessMonitor } from "./process/process-monitor.js";
import { main, type DaemonOverrides, type DaemonInstance, runPreflightDoctor, applyInspectDefaultsForLogging } from "./daemon.js";
// hardenDataDirPermissions was extracted to wiring/main-helpers.ts (Phase 188 —
// to recover daemon.ts line-cap headroom for the video-gen wiring), then moved
// again to its own wiring/harden-data-dir.ts (Phase 193 — to clear the
// main-helpers.ts over-cap inherited from the v2.24 squash; shrink-only split).
import { hardenDataDirPermissions } from "./wiring/harden-data-dir.js";
import type { MediaResult } from "./wiring/setup-media.js";
import * as fs from "node:fs";
import * as os from "node:os";
import * as nodePath from "node:path";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync } from "node:fs";
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
        retention: { maxAgeDays: 0 },
        // Master cost-feature kill switch (schema default true). Present here because the real
        // bootstrap always defaults it; the daemon's first-run notice + dialectic wiring read it.
        costFeatures: { enabled: true },
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
            // rag.rerank.enabled now defaults ON, but setupSingleAgent
            // resolves the EFFECTIVE rerank from the raw signal + model-presence — with no
            // reranker model present in this mock it resolves to false. Set it explicitly
            // false here so the mock config matches the post-setupAgents effective config
            // (this test asserts the DaemonInstance shape, not the rerank default).
            rerank: { enabled: false },
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
          transcription: { provider: "auto", maxFileSizeMb: 25, timeoutMs: 60000, autoTranscribe: true, preflight: true, fallbackProviders: [], local: { model: "base" } },
          tts: { provider: "edge", voice: "alloy", format: "opus", autoMode: "never", tagPattern: "\\[\\[tts\\]\\]", outputFormats: {} },
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
          // DELIVERY-02: the announcement batcher reads delivery.maxRetries for
          // its transient-retry cap (schema-defaulted in real config).
          delivery: { maxRetries: 3 },
        },
        storage: "file" as const,
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
      // setupSingleAgent reads container.config.tooling to construct the
      // per-agent ToolCapabilityPort adapter. Use the schema's full-default
      // tree so tests don't pin individual cluster IDs.
      tooling: ToolingConfigSchema.parse({}),
    } as unknown as AppContainer["config"],
    eventBus: createMockEventBus(),
    secretManager: {
      get: vi.fn().mockReturnValue(undefined),
      has: vi.fn().mockReturnValue(false),
      keys: vi.fn().mockReturnValue([]),
    } as unknown as AppContainer["secretManager"],
    // Stage-2 scrub reads container.platformSecretNames after bootstrap.
    // Provide an empty set so the scrub loop is a no-op in unit tests.
    platformSecretNames: new Set<string>(),
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
function buildOverrides(gatewayOverrides?: Partial<GatewayConfig>, storageMode: "encrypted" | "file" | "env" = "file") {
  const callOrder: string[] = [];
  const container = createMockContainer(gatewayOverrides);
  // container.config.security.storage must match the preReadStorageMode
  // for the boot invariant assertion to pass. Tests that override preReadStorageMode
  // must also pass the matching storageMode here.
  (container.config as Record<string, unknown>)["security"] = {
    ...((container.config as Record<string, unknown>)["security"] as Record<string, unknown>),
    storage: storageMode,
  };
  const logger = createMockLogger();
  const logLevelManager = createMockLogLevelManager();
  const tokenTracker = createMockTokenTracker();
  const processMonitor = createMockProcessMonitor();
  const shutdownHandle = createMockShutdownHandle();
  const gatewayHandle = createMockGatewayHandle();

  const overrides: DaemonOverrides = {
    // Default to "file" mode in tests — avoids requiring SECRETS_MASTER_KEY
    // in the environment. Tests that need a specific mode override this field.
    preReadStorageMode: vi.fn().mockReturnValue(storageMode),
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
    createProcessMonitor: vi.fn().mockImplementation(() => {
      callOrder.push("createProcessMonitor");
      return processMonitor;
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
      processMonitor,
      shutdownHandle,
      gatewayHandle,
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("daemon main()", () => {
  const originalEnv = process.env;
  // Each main() instantiates real OAuth + skill chokidar watchers via
  // setupSingleAgent — without per-test shutdown these accumulate as
  // active FSWatcher handles on the vitest worker process and prevent
  // the worker from terminating cleanly at file teardown (manifests as
  // `[vitest-pool]: Timeout terminating forks worker for test files
  // .../config-handlers.test.ts` because the leaky worker is later
  // reused for that file).
  const instances: DaemonInstance[] = [];

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(async () => {
    // Trigger full shutdown on every captured instance so OAuth file
    // watchers, skill watchers, and any other handles created during
    // setupSingleAgent are closed before the next test/file runs.
    while (instances.length > 0) {
      const inst = instances.shift()!;
      try {
        await inst.shutdownHandle.trigger("test-cleanup");
      } catch {
        // Best-effort: don't let a single bad teardown mask the test's
        // actual outcome.
      }
      try {
        inst.shutdownHandle.dispose();
      } catch {
        /* idempotent */
      }
    }
    process.env = originalEnv;
  });

  it("completes full startup sequence in correct order (gateway disabled)", async () => {
    const { overrides, callOrder } = buildOverrides();

    instances.push(await main(overrides));

    expect(callOrder).toEqual([
      "bootstrap",
      "createTracingLogger",
      "createLogLevelManager",
      "createTokenTracker",
      "createProcessMonitor",
    ]);
  });

  it("completes full startup sequence with gateway enabled", async () => {
    const { overrides, callOrder } = buildOverrides({
      enabled: true,
      tokens: [{ id: "test", secret: "s3cret", scopes: ["rpc"] }],
    });

    instances.push(await main(overrides));

    expect(callOrder).toEqual([
      "bootstrap",
      "createTracingLogger",
      "createLogLevelManager",
      "createTokenTracker",
      "createProcessMonitor",
      "createGatewayServer",
    ]);
  });

  it("returns DaemonInstance with all services", async () => {
    const { overrides, mocks } = buildOverrides();

    const instance = await main(overrides);
    instances.push(instance);

    // container is spread-cloned during SecretRef resolution, so identity differs
    expect(instance.container.config).toStrictEqual(mocks.container.config);
    expect(instance.logger).toBe(mocks.logger);
    expect(instance.logLevelManager).toBe(mocks.logLevelManager);
    expect(instance.tokenTracker).toBe(mocks.tokenTracker);
    expect(instance.processMonitor).toBe(mocks.processMonitor);
    // shutdownHandle is constructed inline by setupShutdown rather than
    // injected via a `_registerGracefulShutdown` factory seam. Assert the
    // shape (the integration tests cover behavior).
    expect(instance.shutdownHandle).toBeDefined();
    expect(typeof instance.shutdownHandle.trigger).toBe("function");
    expect(typeof instance.shutdownHandle.dispose).toBe("function");
  });

  it("returns gatewayHandle when gateway is enabled", async () => {
    const { overrides, mocks } = buildOverrides({
      enabled: true,
      tokens: [{ id: "test", secret: "s3cret", scopes: ["rpc"] }],
    });

    const instance = await main(overrides);
    instances.push(instance);

    expect(instance.gatewayHandle).toBe(mocks.gatewayHandle);
    expect(mocks.gatewayHandle.start).toHaveBeenCalledTimes(1);
  });

  it("does not create gateway when disabled", async () => {
    const { overrides } = buildOverrides();

    const instance = await main(overrides);
    instances.push(instance);

    expect(instance.gatewayHandle).toBeUndefined();
    expect(overrides.createGatewayServer).not.toHaveBeenCalled();
  });

  // The `_registerGracefulShutdown` factory seam is gone, so the
  // "passes onShutdown callback" assertions that previously inspected the
  // factory call are obsolete here. Coverage moves to:
  //   - packages/daemon/src/wiring/setup-shutdown.test.ts (per-component
  //     teardown invocation)
  //   - test/integration/daemon-shutdown*.test.ts (real-signal trigger end-
  //     to-end)

  it("starts process monitor after creation", async () => {
    const { overrides, mocks } = buildOverrides();

    instances.push(await main(overrides));

    expect(mocks.processMonitor.start).toHaveBeenCalledTimes(1);
  });

  it("logs startup complete message with structured banner", async () => {
    const { overrides, mocks } = buildOverrides();

    instances.push(await main(overrides));

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

    instances.push(await main(overrides));

    // Non-existent paths are filtered out by existsSync before bootstrap.
    // bootstrap now receives mergedEnv (process.env when no secret store).
    expect(overrides.bootstrap).toHaveBeenCalledWith(
      expect.objectContaining({ configPaths: [] }),
    );
  });

  it("uses default config paths when COMIS_CONFIG_PATHS is not set", async () => {
    delete process.env["COMIS_CONFIG_PATHS"];
    // This test deliberately exercises the default-path branch. The
    // VITEST guard (daemon.ts:~315) throws on that branch under
    // VITEST=true to stop accidental ~/.comis/ reads from real test code.
    // Here the test intent is the filtering behavior, not the guard, so
    // we drop VITEST for the duration of the call.
    const prevVitest = process.env["VITEST"];
    delete process.env["VITEST"];
    // P0: preReadStorageMode reads the default config files (if they exist) before
    // bootstrap. If the developer's real ~/.comis/config.yaml contains legacy keys,
    // the migration guard throws before bootstrap is called, breaking this test.
    // Override COMIS_DATA_DIR to a fresh tmpdir so the default paths point at
    // non-existent files, which preReadStorageMode silently skips (returns "encrypted").
    // Note: DEFAULT_CONFIG_PATHS is based on os.homedir(), not COMIS_DATA_DIR —
    // the path assert below is still valid because we are testing the shape of
    // DEFAULT_CONFIG_PATHS, not the actual file location.
    const { overrides } = buildOverrides();
    // P0: preReadStorageMode reads the default config files (if they exist) before
    // bootstrap. If the developer's real ~/.comis/config.yaml contains legacy keys,
    // the migration guard throws before bootstrap is called, breaking this test.
    // Use the override seam to return "file" so the boot gate passes
    // regardless of the actual ~/.comis/config.yaml content on this machine
    // (file mode does not require SECRETS_MASTER_KEY).
    overrides.preReadStorageMode = vi.fn().mockReturnValue("file");

    try {
      instances.push(await main(overrides));
    } finally {
      if (prevVitest !== undefined) process.env["VITEST"] = prevVitest;
    }

    // Default paths are ~/.comis/config.yaml and ~/.comis/config.local.yaml,
    // filtered to only files that exist on disk
    const call = (overrides.bootstrap as ReturnType<typeof vi.fn>).mock.calls[0]![0] as {
      configPaths: string[];
    };
    for (const p of call.configPaths) {
      expect(p).toMatch(/\.comis\/config(\.local)?\.yaml$/);
    }
  });

  it("throws under VITEST=true when COMIS_CONFIG_PATHS is unset", async () => {
    delete process.env["COMIS_CONFIG_PATHS"];
    process.env["VITEST"] = "true";
    const { overrides } = buildOverrides();

    // The guard hard-throws rather than silently reading
    // ~/.comis/config.yaml from a test process. The message MUST mention
    // VITEST and the sandbox-path remediation so the failure is
    // self-diagnosing for a test author.
    await expect(main(overrides)).rejects.toThrow(
      /VITEST=true and COMIS_CONFIG_PATHS unset/,
    );
  });

  it("throws on bootstrap failure", async () => {
    const { overrides } = buildOverrides();
    (overrides.bootstrap as ReturnType<typeof vi.fn>).mockReturnValue({
      ok: false,
      error: { message: "Config file not found" },
    });

    await expect(main(overrides)).rejects.toThrow("Bootstrap failed: Config file not found");
  });

  it("releases the singleton lock when a post-foundation boot stage throws", async () => {
    // Use an isolated temp dataDir so the lock file doesn't collide with other tests.
    const freshDataDir = fs.mkdtempSync(nodePath.join(os.tmpdir(), "daemon-cr01-lock-test-"));
    try {
      process.env["COMIS_DATA_DIR"] = freshDataDir;

      const { overrides } = buildOverrides();
      // Inject a failure inside bootAgents (stage 2) via setupMedia — this fires
      // after bootFoundation acquires the lock, simulating a post-foundation throw.
      (overrides.setupMedia as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error("simulated post-foundation boot failure"),
      );

      await expect(main(overrides)).rejects.toThrow("simulated post-foundation boot failure");

      // The singleton lock must have been released — if not, the lock file survives
      // and subsequent daemon starts would need stale-PID recovery.
      const lockPath = nodePath.join(freshDataDir, ".daemon.lock");
      expect(fs.existsSync(lockPath)).toBe(false);
    } finally {
      delete process.env["COMIS_DATA_DIR"];
      try { fs.rmSync(freshDataDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  // The two assertions previously here checked
  // `overrides.registerGracefulShutdown.toHaveBeenCalledWith(...)` to verify
  // that container/processMonitor/exit flowed through the factory seam. After
  // inlining, the seam is gone and the same wiring is exercised by:
  //   - setup-shutdown.test.ts ("returns shutdownHandle from setupShutdown",
  //     "executes ordered teardown in correct sequence")
  //   - test/integration/daemon-shutdown.test.ts (real SIGTERM end-to-end)

  // -------------------------------------------------------------------------
  // Boot-time PROVIDER_OVERRIDES staleness validator
  // -------------------------------------------------------------------------
  // The daemon calls validateProviderOverrides during the "3.6" startup step.
  // Against the LIVE pi-ai catalog, every PROVIDER_OVERRIDES key is currently
  // backed by a real provider, so the validator emits zero orphan WARNs at
  // boot. This regression guards against the override map drifting ahead of
  // pi-ai's catalog (which would re-introduce orphan WARNs per boot).

  it("emits no orphan PROVIDER_OVERRIDES WARNs at boot against the live pi-ai catalog", async () => {
    const { overrides, mocks } = buildOverrides();

    instances.push(await main(overrides));

    // The mock LogLevelManager returns the same mock logger for every
    // getLogger() call -- assert that no warn carrying the validator's
    // signature was emitted during boot.
    const sharedMockLogger = (mocks.logLevelManager.getLogger as ReturnType<typeof vi.fn>)
      .mock.results[0]?.value;
    expect(sharedMockLogger.warn).not.toHaveBeenCalledWith(
      expect.objectContaining({
        hint: expect.stringContaining("PROVIDER_OVERRIDES"),
        errorKind: "config",
        submodule: "capabilities",
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

  it("hardens secrets.json to 0o600 when present with loose permissions", () => {
    fs.chmodSync(testDir, 0o700);
    const secretsJsonPath = nodePath.join(testDir, "secrets.json");
    fs.writeFileSync(secretsJsonPath, '{"schemaVersion":1,"secrets":{}}');
    // Simulate a file written with a loose umask (e.g. operator ran mkdir manually)
    fs.chmodSync(secretsJsonPath, 0o644);

    const corrections = hardenDataDirPermissions(testDir);

    const secretsCorrection = corrections.find((c) => c.file === secretsJsonPath);
    expect(secretsCorrection).toBeDefined();
    expect(secretsCorrection!.oldMode).toBe(0o644);
    expect(secretsCorrection!.newMode).toBe(0o600);

    const stat = fs.statSync(secretsJsonPath);
    expect(stat.mode & 0o777).toBe(0o600);
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
    expect(record.submodule).toBe("preflight");
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

// ---------------------------------------------------------------------------
// opt-out and same-boot init
// ---------------------------------------------------------------------------

describe("opt-out and same-boot init", () => {
  const originalEnv = process.env;
  const instances: DaemonInstance[] = [];

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(async () => {
    while (instances.length > 0) {
      const inst = instances.shift()!;
      try {
        await inst.shutdownHandle.trigger("test-cleanup");
      } catch {
        // Best-effort
      }
      try {
        inst.shutdownHandle.dispose();
      } catch {
        /* idempotent */
      }
    }
    process.env = originalEnv;
  });

  it("calls writeMasterKeyIfAbsent on first boot with a fresh data directory (encrypted mode)", async () => {
    // Fresh tmpdir — no .env file present; use a subdirectory so writeMasterKeyIfAbsent
    // writes there rather than the shared sandbox COMIS_DATA_DIR.
    const { randomBytes } = await import("node:crypto");
    const keyHex = randomBytes(32).toString("hex");
    const freshDataDir = mkdtempSync(resolve(tmpdir(), "comis-first-boot-test-"));
    process.env["COMIS_DATA_DIR"] = freshDataDir;
    process.env["COMIS_CONFIG_PATHS"] = nodePath.join(freshDataDir, "config.yaml");
    process.env["SECRETS_MASTER_KEY"] = keyHex;
    const { overrides } = buildOverrides(undefined, "encrypted");
    const mockWriteMasterKeyIfAbsent = vi.fn().mockReturnValue({ written: true, keyHex });
    overrides.writeMasterKeyIfAbsent = mockWriteMasterKeyIfAbsent;

    const instance = await main(overrides);
    instances.push(instance);

    // writeMasterKeyIfAbsent must have been called with the dataDir on first boot.
    expect(mockWriteMasterKeyIfAbsent).toHaveBeenCalledWith(freshDataDir);

    delete process.env["SECRETS_MASTER_KEY"];
    rmSync(freshDataDir, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// selectSecretStore dispatch + store-wins + two-stage scrub
// ---------------------------------------------------------------------------
// These tests verify the selectSecretStore behaviors. Without selectSecretStore
// wired into bootFoundation, the file/env paths leave process.env unscrubbed
// and never call buildMergedEnv, so the scrub + shadow-WARN assertions fail.

describe("selectSecretStore dispatch + scrub + store-wins", () => {
  const originalEnv = process.env;
  const instances: DaemonInstance[] = [];

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(async () => {
    while (instances.length > 0) {
      const inst = instances.shift()!;
      try { await inst.shutdownHandle.trigger("test-cleanup"); } catch { /* ignore */ }
      try { inst.shutdownHandle.dispose(); } catch { /* idempotent */ }
    }
    process.env = originalEnv;
  });

  // -------------------------------------------------------------------------
  // stage-1: file mode must call scrubProcessEnv
  // -------------------------------------------------------------------------

  it("file mode: ANTHROPIC_API_KEY is removed from process.env after boot (stage-1 scrub)", async () => {
    const freshDataDir = mkdtempSync(resolve(tmpdir(), "comis-04-file-scrub-"));
    try {
      process.env["COMIS_DATA_DIR"] = freshDataDir;
      // Use a non-existent config path (avoids reading real ~/.comis/config.yaml)
      process.env["COMIS_CONFIG_PATHS"] = nodePath.join(freshDataDir, "config.yaml");
      process.env["ANTHROPIC_API_KEY"] = "sk-test-file-scrub-key";

      const { overrides } = buildOverrides();
      overrides.preReadStorageMode = vi.fn().mockReturnValue("file");
      overrides.setupSecrets = vi.fn().mockReturnValue({ ok: true, value: null });

      const instance = await main(overrides);
      instances.push(instance);

      // scrubProcessEnv must have run — ANTHROPIC_API_KEY must be gone
      expect(process.env["ANTHROPIC_API_KEY"]).toBeUndefined();
    } finally {
      rmSync(freshDataDir, { recursive: true, force: true });
    }
  });

  it("env mode: ANTHROPIC_API_KEY is removed from process.env after boot (stage-1 scrub)", async () => {
    const freshDataDir = mkdtempSync(resolve(tmpdir(), "comis-04-env-scrub-"));
    try {
      process.env["COMIS_DATA_DIR"] = freshDataDir;
      process.env["COMIS_CONFIG_PATHS"] = nodePath.join(freshDataDir, "config.yaml");
      process.env["ANTHROPIC_API_KEY"] = "sk-test-env-scrub-key";

      const { overrides } = buildOverrides(undefined, "env");
      overrides.setupSecrets = vi.fn().mockReturnValue({ ok: true, value: null });

      const instance = await main(overrides);
      instances.push(instance);

      // scrubProcessEnv must have run in env mode too — ANTHROPIC_API_KEY must be gone
      expect(process.env["ANTHROPIC_API_KEY"]).toBeUndefined();
    } finally {
      rmSync(freshDataDir, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // store-wins: WARN emitted when store value shadows process.env
  // -------------------------------------------------------------------------

  it("file mode: WARN logged with secretName when store value shadows process.env (store-wins)", async () => {
    const freshDataDir = mkdtempSync(resolve(tmpdir(), "comis-04-shadow-warn-"));
    try {
      // Pre-create secrets.json so the file store finds DISCORD_TOKEN on boot.
      const secretsJson = JSON.stringify({
        schemaVersion: 1,
        secrets: {
          DISCORD_TOKEN: {
            value: "store-discord-value",
            createdAt: Date.now(),
            updatedAt: Date.now(),
          },
        },
      });
      fs.writeFileSync(nodePath.resolve(freshDataDir, "secrets.json"), secretsJson, { mode: 0o600 });

      // Also set the same key in process.env so store-wins logic fires
      process.env["DISCORD_TOKEN"] = "env-discord-value";
      process.env["COMIS_DATA_DIR"] = freshDataDir;
      process.env["COMIS_CONFIG_PATHS"] = nodePath.join(freshDataDir, "config.yaml");

      const { overrides, mocks } = buildOverrides();
      overrides.preReadStorageMode = vi.fn().mockReturnValue("file");
      overrides.setupSecrets = vi.fn().mockReturnValue({ ok: true, value: null });

      const instance = await main(overrides);
      instances.push(instance);

      // buildMergedEnv must have emitted a WARN with secretName: "DISCORD_TOKEN"
      const logLevelManager = mocks.logLevelManager;
      const sharedLogger = (logLevelManager.getLogger as ReturnType<typeof vi.fn>).mock.results[0]?.value;
      expect(sharedLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ submodule: "secrets-overlay", secretName: "DISCORD_TOKEN" }),
        expect.stringContaining("store value is authoritative"),
      );
    } finally {
      rmSync(freshDataDir, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // Encrypted-mode regression: selectSecretStore dispatch must not break
  // the existing encrypted store set/get round-trip
  // -------------------------------------------------------------------------

  it("encrypted mode regression: daemon boots and env.set persists via selectSecretStore dispatch", async () => {
    const { randomBytes } = await import("node:crypto");
    const keyHex = randomBytes(32).toString("hex");
    const freshDataDir = mkdtempSync(resolve(tmpdir(), "comis-04-enc-regression-"));
    try {
      process.env["COMIS_DATA_DIR"] = freshDataDir;
      process.env["COMIS_CONFIG_PATHS"] = nodePath.join(freshDataDir, "config.yaml");
      process.env["SECRETS_MASTER_KEY"] = keyHex;

      const { overrides } = buildOverrides(undefined, "encrypted");
      // Do NOT override setupSecrets — let the real implementation run
      // so the encrypted path via selectSecretStore is exercised end-to-end.

      const instance = await main(overrides);
      instances.push(instance);

      // Encrypted mode must wire a real secretStore (not undefined).
      // Verify by calling env.set which requires secretStore to be present.
      const setResult = await instance.rpcCall(
        "env.set",
        { key: "STRIPE_SECRET_KEY", value: "sk-stripe-test", _trustLevel: "admin" },
      );
      // STRIPE_SECRET_KEY is a brand-new key (not in the mock secretManager),
      // so the additive restart rule applies: restarting:false (live-applied).
      expect(setResult).toMatchObject({ set: true, key: "STRIPE_SECRET_KEY", restarting: false });
    } finally {
      delete process.env["SECRETS_MASTER_KEY"];
      rmSync(freshDataDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Per-mode daemon harness
// ---------------------------------------------------------------------------
// Integration/regression assertions over already-assembled behavior.
// These tests verify that the assembled system satisfies the success
// criteria end-to-end. They are cross-cutting integration verification of
// already-tested units.

describe("per-mode daemon harness", () => {
  const originalEnv = process.env;
  const instances: DaemonInstance[] = [];

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(async () => {
    while (instances.length > 0) {
      const inst = instances.shift()!;
      try { await inst.shutdownHandle.trigger("test-cleanup"); } catch { /* ignore */ }
      try { inst.shutdownHandle.dispose(); } catch { /* idempotent */ }
    }
    process.env = originalEnv;
  });

  // -------------------------------------------------------------------------
  // file mode — env.set persists to secrets.json + read back
  // -------------------------------------------------------------------------

  it("file mode: env.set persists to secrets.json and reads back via secrets.get", async () => {
    const freshDataDir = mkdtempSync(resolve(tmpdir(), "comis-05-file-envset-"));
    try {
      process.env["COMIS_DATA_DIR"] = freshDataDir;
      process.env["COMIS_CONFIG_PATHS"] = nodePath.join(freshDataDir, "config.yaml");

      const { overrides } = buildOverrides();
      overrides.preReadStorageMode = vi.fn().mockReturnValue("file");

      const instance = await main(overrides);
      instances.push(instance);

      // env.set must persist to the file store and return storage:"file"
      const setResult = await instance.rpcCall(
        "env.set",
        { key: "MY_API_KEY", value: "test-api-value-12345", _trustLevel: "admin" },
      ) as { set: boolean; key: string; storage: string; restarting: boolean };
      expect(setResult.set).toBe(true);
      expect(setResult.key).toBe("MY_API_KEY");
      expect(setResult.storage).toBe("file");
      // MY_API_KEY is a brand-new key (not in the mock secretManager),
      // so the additive restart rule applies: restarting:false (live-applied).
      expect(setResult.restarting).toBe(false);

      // secrets.get must return the same value that was set
      const getResult = await instance.rpcCall(
        "secrets.get",
        { name: "MY_API_KEY", _trustLevel: "admin" },
      ) as { name: string; value: string | undefined; exists: boolean };
      expect(getResult.exists).toBe(true);
      expect(getResult.value).toBe("test-api-value-12345");

      // secrets.json must be created with 0600 permissions (residency + security)
      const secretsPath = nodePath.resolve(freshDataDir, "secrets.json");
      expect(fs.existsSync(secretsPath)).toBe(true);
      const stat = fs.statSync(secretsPath);
      expect(stat.mode & 0o777).toBe(0o600);

      // dataDir must have 0700 permissions
      const dirStat = fs.statSync(freshDataDir);
      expect(dirStat.mode & 0o777).toBe(0o700);
    } finally {
      rmSync(freshDataDir, { recursive: true, force: true });
    }
  });

  it("file mode: secrets.set persists and secrets.get reads back", async () => {
    const freshDataDir = mkdtempSync(resolve(tmpdir(), "comis-05-file-secsset-"));
    try {
      process.env["COMIS_DATA_DIR"] = freshDataDir;
      process.env["COMIS_CONFIG_PATHS"] = nodePath.join(freshDataDir, "config.yaml");

      const { overrides } = buildOverrides();
      overrides.preReadStorageMode = vi.fn().mockReturnValue("file");

      const instance = await main(overrides);
      instances.push(instance);

      // secrets.set must persist to the file store
      const setResult = await instance.rpcCall(
        "secrets.set",
        { name: "STRIPE_SECRET", value: "sk-stripe-test-99", _trustLevel: "admin" },
      ) as { name: string; stored: boolean };
      expect(setResult.stored).toBe(true);
      expect(setResult.name).toBe("STRIPE_SECRET");

      // secrets.get must return the persisted value
      const getResult = await instance.rpcCall(
        "secrets.get",
        { name: "STRIPE_SECRET", _trustLevel: "admin" },
      ) as { name: string; value: string | undefined; exists: boolean };
      expect(getResult.exists).toBe(true);
      expect(getResult.value).toBe("sk-stripe-test-99");
    } finally {
      rmSync(freshDataDir, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // env mode — both env.set and secrets.set rejected
  // -------------------------------------------------------------------------

  it("env mode: env.set returns error containing 'read-only'", async () => {
    const freshDataDir = mkdtempSync(resolve(tmpdir(), "comis-05-env-envset-"));
    try {
      process.env["COMIS_DATA_DIR"] = freshDataDir;
      process.env["COMIS_CONFIG_PATHS"] = nodePath.join(freshDataDir, "config.yaml");

      const { overrides } = buildOverrides(undefined, "env");

      const instance = await main(overrides);
      instances.push(instance);

      // env.set must throw with a message containing "read-only" in env mode
      await expect(
        instance.rpcCall(
          "env.set",
          { key: "SOME_SECRET", value: "some-value", _trustLevel: "admin" },
        ),
      ).rejects.toThrow(/read-only/);
    } finally {
      rmSync(freshDataDir, { recursive: true, force: true });
    }
  });

  it("env mode: secrets.set returns error containing 'read-only'", async () => {
    const freshDataDir = mkdtempSync(resolve(tmpdir(), "comis-05-env-secset-"));
    try {
      process.env["COMIS_DATA_DIR"] = freshDataDir;
      process.env["COMIS_CONFIG_PATHS"] = nodePath.join(freshDataDir, "config.yaml");

      const { overrides } = buildOverrides(undefined, "env");

      const instance = await main(overrides);
      instances.push(instance);

      // secrets.set must throw with a message containing "read-only" in env mode
      await expect(
        instance.rpcCall(
          "secrets.set",
          { name: "SOME_SECRET", value: "some-value", _trustLevel: "admin" },
        ),
      ).rejects.toThrow(/read-only/);
    } finally {
      rmSync(freshDataDir, { recursive: true, force: true });
    }
  });

  it("env mode: env_set error message mentions security.storage and not SECRETS_MASTER_KEY", async () => {
    const freshDataDir = mkdtempSync(resolve(tmpdir(), "comis-05-env-hint-"));
    try {
      process.env["COMIS_DATA_DIR"] = freshDataDir;
      process.env["COMIS_CONFIG_PATHS"] = nodePath.join(freshDataDir, "config.yaml");

      const { overrides } = buildOverrides(undefined, "env");

      const instance = await main(overrides);
      instances.push(instance);

      // The error must mention "security.storage" so the operator knows
      // how to switch to a writable store (actionable hint).
      // It must NOT mention SECRETS_MASTER_KEY (stale guidance removed).
      let thrownMessage = "";
      try {
        await instance.rpcCall(
          "env.set",
          { key: "SOME_KEY", value: "some-val", _trustLevel: "admin" },
        );
      } catch (e: unknown) {
        thrownMessage = e instanceof Error ? e.message : String(e);
      }
      expect(thrownMessage).toMatch(/read-only/);
      expect(thrownMessage).toMatch(/security\.storage/);
      expect(thrownMessage).not.toMatch(/SECRETS_MASTER_KEY/);
      expect(thrownMessage).not.toMatch(/~\/\.comis\/\.env/);
    } finally {
      rmSync(freshDataDir, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // file mode residency canary — secrets.list returns no value field
  // -------------------------------------------------------------------------

  it("file mode: secrets.list returns names+metadata only, no value field", async () => {
    const freshDataDir = mkdtempSync(resolve(tmpdir(), "comis-05-file-list-"));
    try {
      process.env["COMIS_DATA_DIR"] = freshDataDir;
      process.env["COMIS_CONFIG_PATHS"] = nodePath.join(freshDataDir, "config.yaml");

      const { overrides } = buildOverrides();
      overrides.preReadStorageMode = vi.fn().mockReturnValue("file");

      const instance = await main(overrides);
      instances.push(instance);

      // Store a secret via secrets.set
      await instance.rpcCall(
        "secrets.set",
        { name: "MY_KEY", value: "MY_VALUE", _trustLevel: "admin" },
      );

      // secrets.list must return entries with name but NO value field
      const listResult = await instance.rpcCall(
        "secrets.list",
        { _trustLevel: "admin" },
      ) as { secrets: Array<Record<string, unknown>> };
      expect(listResult.secrets.length).toBeGreaterThan(0);
      const entry = listResult.secrets.find((s) => s.name === "MY_KEY");
      expect(entry).toBeDefined();
      expect(entry).not.toHaveProperty("value");
      expect(entry).not.toHaveProperty("plaintext");
    } finally {
      rmSync(freshDataDir, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // stage-2 scrub — config-referenced custom secret absent post-boot
  // -------------------------------------------------------------------------

  it("stage-2 scrub: platformSecretNames secret absent from process.env after boot", async () => {
    const freshDataDir = mkdtempSync(resolve(tmpdir(), "comis-05-stage2-scrub-"));
    try {
      process.env["COMIS_DATA_DIR"] = freshDataDir;
      process.env["COMIS_CONFIG_PATHS"] = nodePath.join(freshDataDir, "config.yaml");
      // Set a custom secret that is NOT in the SENSITIVE_PREFIXES list
      // (so it survives stage-1 scrub but must be removed by stage-2 scrub).
      process.env["MY_CUSTOM_TOKEN"] = "super-secret-custom-value";

      const { overrides } = buildOverrides();
      overrides.preReadStorageMode = vi.fn().mockReturnValue("file");
      // Override bootstrap to return a container where platformSecretNames
      // includes MY_CUSTOM_TOKEN — simulating it being referenced in config.yaml.
      overrides.bootstrap = vi.fn().mockImplementation(() => {
        const container = createMockContainer();
        container.platformSecretNames = new Set<string>(["MY_CUSTOM_TOKEN"]);
        return { ok: true, value: container };
      });

      const instance = await main(overrides);
      instances.push(instance);

      // MY_CUSTOM_TOKEN must have been removed by stage-2 scrub
      expect(process.env["MY_CUSTOM_TOKEN"]).toBeUndefined();
    } finally {
      rmSync(freshDataDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Additive no-restart integration
// ---------------------------------------------------------------------------
// End-to-end integration tests for the additive-no-restart behavior.
// Verifies that the daemon satisfies the additive-no-restart success criteria:
//   1. env.set BRAND_NEW_KEY → restarting:false, NO SIGUSR2, value live in store
//   2. secrets.set OTHER_NEW_KEY → restarting:false, stored:true, NO SIGUSR2
//   3. Value readable via secrets.get after additive env.set (live-applied)
//   4. env.set EXISTING_KEY (rotation) → restarting:true, SIGUSR2 scheduled
//   5. secrets.delete EXISTING → restarting:true, deleted:true, SIGUSR2 scheduled
//   6. secrets.delete ABSENT → restarting:false, deleted:false, NO SIGUSR2

describe("additive no-restart integration", () => {
  const originalEnv = process.env;
  const instances: DaemonInstance[] = [];
  let killSpy: ReturnType<typeof vi.spyOn> | null = null;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(async () => {
    // Restore process.kill spy before shutdown (prevent SIGUSR2 calls from
    // interfering with shutdown). The spy is nulled after restoration.
    if (killSpy) {
      killSpy.mockRestore();
      killSpy = null;
    }
    while (instances.length > 0) {
      const inst = instances.shift()!;
      try { await inst.shutdownHandle.trigger("test-cleanup"); } catch { /* ignore */ }
      try { inst.shutdownHandle.dispose(); } catch { /* idempotent */ }
    }
    process.env = originalEnv;
  });

  // -------------------------------------------------------------------------
  // env.set NEW_KEY → restarting:false, SIGUSR2 NOT sent
  // -------------------------------------------------------------------------
  it("env.set on a brand-new key returns restarting:false (additive live-applied, no SIGUSR2)", async () => {
    const freshDataDir = mkdtempSync(resolve(tmpdir(), "comis-0304-env-new-"));
    try {
      process.env["COMIS_DATA_DIR"] = freshDataDir;
      process.env["COMIS_CONFIG_PATHS"] = nodePath.join(freshDataDir, "config.yaml");

      const { overrides } = buildOverrides();
      overrides.preReadStorageMode = vi.fn().mockReturnValue("file");

      const instance = await main(overrides);
      instances.push(instance);

      // Spy on process.kill to verify SIGUSR2 is NOT sent (additive path)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      killSpy = vi.spyOn(process, "kill" as any).mockImplementation((() => true) as never);

      const setResult = await instance.rpcCall(
        "env.set",
        { key: "BRAND_NEW_KEY_03_04", value: "hello-live", _trustLevel: "admin" },
      ) as { set: boolean; key: string; storage: string; restarting: boolean };

      // Let any async timers fire (rotation schedules SIGUSR2 after 200ms;
      // additive path should NOT have scheduled one)
      await new Promise((r) => setTimeout(r, 250));

      expect(setResult.set).toBe(true);
      expect(setResult.key).toBe("BRAND_NEW_KEY_03_04");
      expect(setResult.restarting).toBe(false);

      // SIGUSR2 must NOT have been sent (additive live-apply, no restart)
      const sigusr2Calls = (killSpy.mock.calls as unknown[][]).filter(
        (args) => args[0] === process.pid && args[1] === "SIGUSR2",
      );
      expect(sigusr2Calls.length).toBe(0);
    } finally {
      rmSync(freshDataDir, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // secrets.set OTHER_NEW_KEY → restarting:false, stored:true, no SIGUSR2
  // -------------------------------------------------------------------------
  it("secrets.set on a brand-new key returns restarting:false and stored:true (additive, no SIGUSR2)", async () => {
    const freshDataDir = mkdtempSync(resolve(tmpdir(), "comis-0304-sec-new-"));
    try {
      process.env["COMIS_DATA_DIR"] = freshDataDir;
      process.env["COMIS_CONFIG_PATHS"] = nodePath.join(freshDataDir, "config.yaml");

      const { overrides } = buildOverrides();
      overrides.preReadStorageMode = vi.fn().mockReturnValue("file");

      const instance = await main(overrides);
      instances.push(instance);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      killSpy = vi.spyOn(process, "kill" as any).mockImplementation((() => true) as never);

      const setResult = await instance.rpcCall(
        "secrets.set",
        { name: "OTHER_NEW_KEY_03_04", value: "secret-live", _trustLevel: "admin" },
      ) as { name: string; stored: boolean; restarting: boolean };

      await new Promise((r) => setTimeout(r, 250));

      expect(setResult.stored).toBe(true);
      expect(setResult.name).toBe("OTHER_NEW_KEY_03_04");
      expect(setResult.restarting).toBe(false);

      const sigusr2Calls = (killSpy.mock.calls as unknown[][]).filter(
        (args) => args[0] === process.pid && args[1] === "SIGUSR2",
      );
      expect(sigusr2Calls.length).toBe(0);
    } finally {
      rmSync(freshDataDir, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // daemon still responsive after additive env.set; value readable
  // -------------------------------------------------------------------------
  it("after additive env.set, daemon is responsive and value is readable via secrets.get", async () => {
    const freshDataDir = mkdtempSync(resolve(tmpdir(), "comis-0304-env-read-"));
    try {
      process.env["COMIS_DATA_DIR"] = freshDataDir;
      process.env["COMIS_CONFIG_PATHS"] = nodePath.join(freshDataDir, "config.yaml");

      const { overrides } = buildOverrides();
      overrides.preReadStorageMode = vi.fn().mockReturnValue("file");

      const instance = await main(overrides);
      instances.push(instance);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      killSpy = vi.spyOn(process, "kill" as any).mockImplementation((() => true) as never);

      // Step 1: additive write
      const setResult = await instance.rpcCall(
        "env.set",
        { key: "BRAND_NEW_KEY_03_04", value: "hello-live", _trustLevel: "admin" },
      ) as { set: boolean; restarting: boolean };
      expect(setResult.set).toBe(true);
      expect(setResult.restarting).toBe(false);

      // Step 2: daemon must still be responsive — call another RPC
      const getResult = await instance.rpcCall(
        "secrets.get",
        { name: "BRAND_NEW_KEY_03_04", _trustLevel: "admin" },
      ) as { name: string; value: string | undefined; exists: boolean };

      // The value was persisted to the file store by env.set (via secretStore.set)
      // and is now readable via secrets.get (which reads from the same file store).
      // This also proves the daemon did NOT restart (restart would reload from file;
      // the value being immediately readable via the same instance proves live-apply).
      expect(getResult.exists).toBe(true);
      expect(getResult.value).toBe("hello-live");
    } finally {
      rmSync(freshDataDir, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // env.set EXISTING_KEY → restarting:false, NO SIGUSR2
  // -------------------------------------------------------------------------
  it("env.set on an existing key returns restarting:false with no SIGUSR2 (live-rotation, no restart)", async () => {
    const freshDataDir = mkdtempSync(resolve(tmpdir(), "comis-0304-env-exist-"));
    try {
      process.env["COMIS_DATA_DIR"] = freshDataDir;
      process.env["COMIS_CONFIG_PATHS"] = nodePath.join(freshDataDir, "config.yaml");

      // Override bootstrap to return a container where secretManager.has("EXISTING_KEY") is true
      const { overrides } = buildOverrides();
      overrides.preReadStorageMode = vi.fn().mockReturnValue("file");
      overrides.bootstrap = vi.fn().mockImplementation(() => {
        const container = createMockContainer();
        // Simulate the key already existing in the secretManager
        (container.secretManager as { has: ReturnType<typeof vi.fn> }).has = vi.fn().mockImplementation(
          (k: string) => k === "EXISTING_KEY_03_04",
        );
        return { ok: true, value: container };
      });

      const instance = await main(overrides);
      instances.push(instance);

      // Intercept SIGUSR2 to detect any unexpected restart signal
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      killSpy = vi.spyOn(process, "kill" as any).mockImplementation((() => true) as never);

      const setResult = await instance.rpcCall(
        "env.set",
        { key: "EXISTING_KEY_03_04", value: "v2", _trustLevel: "admin" },
      ) as { set: boolean; key: string; restarting: boolean };

      // Wait past any potential timer (the SIGUSR2 timer was removed)
      await new Promise((r) => setTimeout(r, 250));

      expect(setResult.set).toBe(true);
      // Rotation now live-applies without restart
      expect(setResult.restarting).toBe(false);

      // SIGUSR2 must NOT have been called (no restart on rotation)
      const sigusr2Calls = (killSpy.mock.calls as unknown[][]).filter(
        (args) => args[0] === process.pid && args[1] === "SIGUSR2",
      );
      expect(sigusr2Calls.length).toBe(0);
    } finally {
      rmSync(freshDataDir, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // secrets.delete EXISTING → restarting:false, deleted:true, NO SIGUSR2
  // -------------------------------------------------------------------------
  it("secrets.delete on an existing key returns restarting:false and deleted:true (live-delete, no restart)", async () => {
    const freshDataDir = mkdtempSync(resolve(tmpdir(), "comis-0304-sec-del-"));
    try {
      process.env["COMIS_DATA_DIR"] = freshDataDir;
      process.env["COMIS_CONFIG_PATHS"] = nodePath.join(freshDataDir, "config.yaml");

      const { overrides } = buildOverrides();
      overrides.preReadStorageMode = vi.fn().mockReturnValue("file");

      const instance = await main(overrides);
      instances.push(instance);

      // First create the secret so it exists in the file store
      await instance.rpcCall(
        "secrets.set",
        { name: "DELETE_TARGET_03_04", value: "to-be-deleted", _trustLevel: "admin" },
      );

      // Now the key is in the store; secretManager.has() uses the mock.
      // Override the mock to indicate the key exists before delete.
      const container = (instance as unknown as { container: AppContainer }).container;
      (container.secretManager as { has: ReturnType<typeof vi.fn> }).has = vi.fn().mockImplementation(
        (k: string) => k === "DELETE_TARGET_03_04",
      );

      // Intercept SIGUSR2 to detect any unexpected restart signal
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      killSpy = vi.spyOn(process, "kill" as any).mockImplementation((() => true) as never);

      const delResult = await instance.rpcCall(
        "secrets.delete",
        { name: "DELETE_TARGET_03_04", _trustLevel: "admin" },
      ) as { name: string; deleted: boolean; restarting: boolean };

      await new Promise((r) => setTimeout(r, 250));

      expect(delResult.deleted).toBe(true);
      // Deletion now live-applies without restart
      expect(delResult.restarting).toBe(false);

      // SIGUSR2 must NOT have been called (no restart on delete)
      const sigusr2Calls = (killSpy.mock.calls as unknown[][]).filter(
        (args) => args[0] === process.pid && args[1] === "SIGUSR2",
      );
      expect(sigusr2Calls.length).toBe(0);
    } finally {
      rmSync(freshDataDir, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // secrets.delete ABSENT → restarting:false, deleted:false, NO SIGUSR2
  // -------------------------------------------------------------------------
  it("secrets.delete on a non-existent key returns restarting:false and deleted:false (no-op, no SIGUSR2)", async () => {
    const freshDataDir = mkdtempSync(resolve(tmpdir(), "comis-0304-sec-noexist-"));
    try {
      process.env["COMIS_DATA_DIR"] = freshDataDir;
      process.env["COMIS_CONFIG_PATHS"] = nodePath.join(freshDataDir, "config.yaml");

      const { overrides } = buildOverrides();
      overrides.preReadStorageMode = vi.fn().mockReturnValue("file");

      const instance = await main(overrides);
      instances.push(instance);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      killSpy = vi.spyOn(process, "kill" as any).mockImplementation((() => true) as never);

      const delResult = await instance.rpcCall(
        "secrets.delete",
        { name: "NEVER_EXISTED_03_04", _trustLevel: "admin" },
      ) as { name: string; deleted: boolean; restarting: boolean };

      await new Promise((r) => setTimeout(r, 250));

      expect(delResult.deleted).toBe(false);
      expect(delResult.restarting).toBe(false);

      const sigusr2Calls = (killSpy.mock.calls as unknown[][]).filter(
        (args) => args[0] === process.pid && args[1] === "SIGUSR2",
      );
      expect(sigusr2Calls.length).toBe(0);
    } finally {
      rmSync(freshDataDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Proxy env survives daemon Stage-1 scrub (signal-cli inheritance)
// ---------------------------------------------------------------------------
// The Stage-1 scrub (scrubProcessEnv) removes SENSITIVE_PREFIXES and
// SENSITIVE_EXACT_KEYS to prevent credential leakage through subprocess
// inheritance. HTTP_PROXY / HTTPS_PROXY / ALL_PROXY / NO_PROXY must NOT be
// removed — signal-cli (and any other child process) must inherit them so
// outbound traffic is routed through the operator-configured proxy.
//
// Behavioral assertion: set proxy env vars, boot daemon, verify they survive.
describe("daemon Stage-1 scrub preserves proxy env vars (XPORT-07)", () => {
  const originalEnv = process.env;
  const instances: DaemonInstance[] = [];

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(async () => {
    while (instances.length > 0) {
      const inst = instances.shift()!;
      try { await inst.shutdownHandle.trigger("test-cleanup"); } catch { /* best-effort */ }
      try { inst.shutdownHandle.dispose(); } catch { /* idempotent */ }
    }
    process.env = originalEnv;
  });

  it("HTTP_PROXY survives the Stage-1 scrub", async () => {
    const freshDataDir = mkdtempSync(nodePath.join(tmpdir(), "comis-proxy-xport07-"));
    try {
      process.env["COMIS_CONFIG_PATHS"] = nodePath.join(freshDataDir, "config.yaml");
      // Inject proxy env vars before daemon boot
      process.env["HTTP_PROXY"] = "http://proxy.test:3128";
      process.env["HTTPS_PROXY"] = "http://proxy.test:3128";
      process.env["ALL_PROXY"] = "socks5://proxy.test:1080";
      process.env["NO_PROXY"] = "localhost,127.0.0.1";

      const { overrides, mocks } = buildOverrides();
      // Add proxy config to mock container so installProxyAtBoot doesn't throw
      (mocks.container.config as Record<string, unknown>)["proxy"] = {
        enabled: false,
        proxyUrl: undefined,
      };
      const instance = await main(overrides);
      instances.push(instance);

      // After boot (scrubProcessEnv has run), proxy vars must still be present
      expect(process.env["HTTP_PROXY"]).toBe("http://proxy.test:3128");
      expect(process.env["HTTPS_PROXY"]).toBe("http://proxy.test:3128");
      expect(process.env["ALL_PROXY"]).toBe("socks5://proxy.test:1080");
      expect(process.env["NO_PROXY"]).toBe("localhost,127.0.0.1");
    } finally {
      rmSync(freshDataDir, { recursive: true, force: true });
    }
  });

  it("lowercase http_proxy / https_proxy also survive (Node convention)", async () => {
    const freshDataDir = mkdtempSync(nodePath.join(tmpdir(), "comis-proxy-xport07b-"));
    try {
      process.env["COMIS_CONFIG_PATHS"] = nodePath.join(freshDataDir, "config.yaml");
      process.env["http_proxy"] = "http://proxy.test:3128";
      process.env["https_proxy"] = "http://proxy.test:3128";
      process.env["no_proxy"] = "localhost";

      const { overrides, mocks } = buildOverrides();
      (mocks.container.config as Record<string, unknown>)["proxy"] = {
        enabled: false,
        proxyUrl: undefined,
      };
      const instance = await main(overrides);
      instances.push(instance);

      expect(process.env["http_proxy"]).toBe("http://proxy.test:3128");
      expect(process.env["https_proxy"]).toBe("http://proxy.test:3128");
      expect(process.env["no_proxy"]).toBe("localhost");
    } finally {
      rmSync(freshDataDir, { recursive: true, force: true });
    }
  });
});
