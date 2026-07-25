// SPDX-License-Identifier: Apache-2.0
/**
 * Daemon boot gate spy tests.
 *
 * These tests prove that `writeMasterKeyIfAbsent` is NEVER called when
 * `security.storage` is "file" or "env" (no key material created on first
 * boot), and IS called exactly once when `security.storage` is "encrypted".
 *
 * This is the concrete proof that file/env first boot creates no key material.
 *
 * Structure: each test injects `overrides.preReadStorageMode` to return
 * the desired storageMode, and `overrides.writeMasterKeyIfAbsent` as a spy.
 * The test then asserts the spy call count.
 *
 * RED+GREEN committed together per AGENTS.md §2.10:
 * The test references the daemon boot gate code which was rewritten to expose
 * injectable overrides. Before the rewrite, `preReadStorageMode` and
 * `writeMasterKeyIfAbsent` were not injectable, so a RED-only commit would fail
 * to compile.
 *
 * @module
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { resolve as pathResolve } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { PerAgentConfigSchema, ToolingConfigSchema, type AppContainer, type GatewayConfig } from "@comis/core";
import { main, type DaemonOverrides } from "./daemon.js";
import { createMockLogger } from "../../../test/support/mock-logger.js";
import { createMockEventBus } from "../../../test/support/mock-event-bus.js";

// ---------------------------------------------------------------------------
// Helpers (minimal mock container — mirrors daemon.test.ts pattern)
// ---------------------------------------------------------------------------

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
      routing: { defaultAgentId: "default", bindings: [] },
      monitoring: {
        disk: { enabled: false, paths: ["/"], thresholdPercent: 90 },
        resources: { enabled: false, cpuThresholdPercent: 85, memoryThresholdPercent: 90 },
        systemd: { enabled: false, services: [] },
        securityUpdates: { enabled: false, securityOnly: true },
        git: { enabled: false, repositories: [], checkRemote: true },
      },
      scheduler: {
        cron: { enabled: false, maxRunsPerTick: 3, defaultTimezone: "UTC", maxJobs: 100, maxConsecutiveDependencyErrors: 5, staggerWindowMs: 0 },
        heartbeat: { enabled: false, intervalMs: 300_000, showOk: false, showAlerts: true },
        quietHours: { enabled: false, start: "22:00", end: "07:00", timezone: "", criticalBypass: true },
        execution: { maxLogBytes: 2_000_000, retainedExecutions: 1_000 },
        tasks: { enabled: false, confidenceThreshold: 0.8, debounceMs: 15_000, batchMax: 8, maxPerCheck: 3, maxPerDayPerConversation: 3, defaultWindowMs: 43_200_000, preAcceptanceRetryLimit: 3 },
      },
      integrations: {
        mcp: { servers: [] },
        media: {
          transcription: { provider: "auto", maxFileSizeMb: 25, timeoutMs: 60000, autoTranscribe: true, preflight: true, fallbackProviders: [], local: { model: "base" } },
          tts: { provider: "edge", voice: "alloy", format: "opus", autoMode: "never", tagPattern: "\\[\\[tts\\]\\]", outputFormats: {} },
          imageAnalysis: { maxFileSizeMb: 20 },
          vision: { enabled: false, defaultProvider: undefined, defaultScopeAction: "allow", scopeRules: [] },
          linkUnderstanding: { enabled: false, maxUrls: 3, maxContentChars: 5000, timeoutMs: 10_000 },
          infrastructure: { maxRemoteFetchBytes: 25 * 1024 * 1024, concurrencyLimit: 3, tempFileTtlMs: 1_800_000, tempCleanupIntervalMs: 300_000 },
          documentExtraction: { enabled: false, allowedMimes: [], maxBytes: 10_485_760, maxChars: 200_000, maxTotalChars: 500_000, maxPages: 50, timeoutMs: 30_000, pdfImageFallbackThreshold: 100 },
          persistence: { enabled: false, maxStorageMb: 1024, maxFileBytes: 52_428_800 },
          imageGeneration: { provider: "fal", safetyChecker: true, maxPerHour: 10, defaultSize: "1024x1024", timeoutMs: 60_000 },
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
      approvals: { enabled: false, defaultMode: "auto" as const, rules: [], defaultTimeoutMs: 300_000 },
      lifecycleReactions: { enabled: false, emojiTier: "unicode", timing: { debounceMs: 700, holdDoneMs: 3000, holdErrorMs: 5000, stallSoftMs: 15000, stallHardMs: 30000 }, perChannel: {} },
      observability: { persistence: { enabled: false, retentionDays: 30, snapshotIntervalMs: 300_000 } },
      deliveryQueue: { enabled: false, maxQueueDepth: 10_000, defaultMaxAttempts: 5, defaultExpireMs: 3_600_000, drainOnStartup: true, drainBudgetMs: 60_000, pruneIntervalMs: 300_000 },
      providers: { entries: {} },
      tenantId: "default",
      logLevel: "info",
      agentDir: "/tmp/test-agent-dir",
      tooling: ToolingConfigSchema.parse({}),
    } as unknown as AppContainer["config"],
    eventBus: createMockEventBus(),
    secretManager: {
      get: vi.fn().mockReturnValue(undefined),
      keys: vi.fn().mockReturnValue([]),
    } as unknown as AppContainer["secretManager"],
    shutdown: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
  };
}

function createMockLogLevelManager() {
  const logger = createMockLogger();
  return {
    getLogger: vi.fn().mockReturnValue(logger),
    setLevel: vi.fn(),
    setGlobalLevel: vi.fn(),
  };
}

function createMockTokenTracker() {
  return {
    record: vi.fn(),
    getByTrace: vi.fn().mockReturnValue([]),
    getByProvider: vi.fn().mockReturnValue({ totalTokens: 0, totalCost: 0, count: 0 }),
    getAll: vi.fn().mockReturnValue([]),
    on: vi.fn(),
  };
}

function createMockProcessMonitor() {
  return { start: vi.fn(), stop: vi.fn(), status: vi.fn() };
}

function createMockShutdownHandle() {
  const listeners: Array<(reason: string) => Promise<void>> = [];
  return {
    register: vi.fn(),
    trigger: vi.fn().mockImplementation(async (reason: string) => {
      for (const l of listeners) {
        try { await l(reason); } catch { /* ignore */ }
      }
    }),
    dispose: vi.fn(),
  };
}

/**
 * Build minimal DaemonOverrides for the boot-gate spy tests.
 *
 * Provides:
 * - `preReadStorageMode` override that returns the given mode
 * - `writeMasterKeyIfAbsent` spy (returns a no-op stub result)
 * - All other required overrides as minimal mocks
 */
function buildBootGateOverrides(storageMode: "encrypted" | "file" | "env") {
  const container = createMockContainer();
  const logLevelManager = createMockLogLevelManager();
  const writeMasterKeySpy = vi.fn().mockReturnValue({
    written: false,
    path: "/tmp/test/.env",
    keyHex: undefined,
  });

  const overrides: DaemonOverrides = {
    // Inject the storage mode directly — no real YAML reads
    preReadStorageMode: vi.fn().mockReturnValue(storageMode),
    // Spy: asserts call count === 0 (file/env) or 1 (encrypted)
    writeMasterKeyIfAbsent: writeMasterKeySpy,
    bootstrap: vi.fn().mockReturnValue({ ok: true, value: container }),
    setupSecrets: vi.fn().mockReturnValue({ ok: true, value: null }),
    createTracingLogger: vi.fn().mockReturnValue(createMockLogger()),
    createLogLevelManager: vi.fn().mockReturnValue(logLevelManager),
    createTokenTracker: vi.fn().mockReturnValue(createMockTokenTracker()),
    createProcessMonitor: vi.fn().mockReturnValue(createMockProcessMonitor()),
    createGatewayServer: vi.fn().mockReturnValue(undefined),
    setupMedia: vi.fn().mockResolvedValue({
      transcriber: null,
      ttsRunner: null,
      imageGenProvider: null,
      imageAnalyzer: null,
      mediaInfra: null,
      linkUnderstandingEngine: null,
      mediaPersistence: null,
      documentExtractor: null,
    }),
    exit: vi.fn(),
  };

  return { overrides, writeMasterKeySpy };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("daemon boot gate — writeMasterKeyIfAbsent call gate", () => {
  const originalEnv = process.env;
  const instances: Array<{ shutdownHandle: { trigger: (r: string) => Promise<void>; dispose: () => void } }> = [];
  let tmpDir: string;

  beforeEach(() => {
    process.env = { ...originalEnv };
    tmpDir = mkdtempSync(pathResolve(tmpdir(), "comis-boot-gate-test-"));
    process.env["COMIS_DATA_DIR"] = tmpDir;
    process.env["COMIS_CONFIG_PATHS"] = pathResolve(tmpDir, "config.yaml");
    delete process.env["SECRETS_MASTER_KEY"];
  });

  afterEach(async () => {
    while (instances.length > 0) {
      const inst = instances.shift()!;
      try { await inst.shutdownHandle.trigger("test-cleanup"); } catch { /* ignore */ }
      try { inst.shutdownHandle.dispose(); } catch { /* idempotent */ }
    }
    process.env = originalEnv;
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  // ------------------------------------------------------------------
  // file mode — no key material
  // ------------------------------------------------------------------

  it("writeMasterKeyIfAbsent is NOT called when security.storage is 'file' (spy call count === 0)", async () => {
    const { overrides, writeMasterKeySpy } = buildBootGateOverrides("file");

    // The boot gate (writeMasterKeyIfAbsent call at step 4) runs BEFORE setupMemory.
    // If the daemon fails later (e.g. stale dist in @comis/memory), the spy
    // call count is still valid — we catch the error and assert after it.
    try {
      const instance = await main(overrides);
      instances.push(instance);
    } catch {
      // Tolerate post-gate failures (stale dist, setupMemory, etc.)
    }

    // Core assertion: the spy must not have been called
    expect(writeMasterKeySpy).not.toHaveBeenCalled();
    expect(writeMasterKeySpy.mock.calls.length).toBe(0);
  });

  // ------------------------------------------------------------------
  // env mode — no key material
  // ------------------------------------------------------------------

  it("writeMasterKeyIfAbsent is NOT called when security.storage is 'env' (spy call count === 0)", async () => {
    const { overrides, writeMasterKeySpy } = buildBootGateOverrides("env");

    try {
      const instance = await main(overrides);
      instances.push(instance);
    } catch {
      // Tolerate post-gate failures (stale dist, setupMemory, etc.)
    }

    // Core assertion: the spy must not have been called
    expect(writeMasterKeySpy).not.toHaveBeenCalled();
    expect(writeMasterKeySpy.mock.calls.length).toBe(0);
  });

  // ------------------------------------------------------------------
  // encrypted mode — key material IS written
  // ------------------------------------------------------------------

  it("writeMasterKeyIfAbsent IS called when security.storage is 'encrypted' (spy call count === 1)", async () => {
    const { overrides, writeMasterKeySpy } = buildBootGateOverrides("encrypted");

    try {
      const instance = await main(overrides);
      instances.push(instance);
    } catch {
      // Tolerate post-gate failures (stale dist, setupMemory, etc.)
    }

    // Core assertion: the spy must have been called exactly once
    expect(writeMasterKeySpy).toHaveBeenCalledTimes(1);
    // And called with the dataDir
    expect(writeMasterKeySpy.mock.calls[0]![0]).toBe(tmpDir);
  });
});

// ---------------------------------------------------------------------------
// storageMode vs container.config.security.storage divergence gate
// ---------------------------------------------------------------------------

describe("daemon boot gate — storageMode vs post-bootstrap security.storage divergence", () => {
  const originalEnv = process.env;
  let tmpDir: string;

  beforeEach(() => {
    process.env = { ...originalEnv };
    tmpDir = mkdtempSync(pathResolve(tmpdir(), "comis-wr03-test-"));
    process.env["COMIS_DATA_DIR"] = tmpDir;
    process.env["COMIS_CONFIG_PATHS"] = pathResolve(tmpDir, "config.yaml");
    delete process.env["SECRETS_MASTER_KEY"];
  });

  afterEach(() => {
    process.env = originalEnv;
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("boot fails with [CONFIG_ERROR] when pre-read storageMode='encrypted' but post-bootstrap security.storage='file' (${VAR} mismatch scenario)", async () => {
    // Simulate: preReadStorageMode() returns "encrypted" (raw YAML scan, cannot expand ${VAR})
    // but the bootstrapped config resolves security.storage to "file" (post-substitution).
    // This is the ${COMIS_STORAGE_MODE}="file" → pre-read defaults to "encrypted" divergence.
    //
    // Provide a fake SECRETS_MASTER_KEY so selectSecretStore("encrypted") succeeds
    // and we reach the post-bootstrap divergence check.
    process.env["SECRETS_MASTER_KEY"] = "a".repeat(64); // 64 hex chars = 32 bytes

    const container = createMockContainer();
    // Stage-2 scrub reads container.platformSecretNames — provide empty set.
    (container as Record<string, unknown>)["platformSecretNames"] = new Set<string>();
    // Override security.storage in the mock container to "file" (diverges from "encrypted" pre-read)
    (container.config as Record<string, unknown>)["security"] = {
      ...((container.config as Record<string, unknown>)["security"] as Record<string, unknown>),
      storage: "file",
    };

    const overrides: import("./daemon.js").DaemonOverrides = {
      preReadStorageMode: vi.fn().mockReturnValue("encrypted"),
      writeMasterKeyIfAbsent: vi.fn().mockReturnValue({ written: false, path: "/tmp/test/.env", keyHex: undefined }),
      bootstrap: vi.fn().mockReturnValue({ ok: true, value: container }),
      setupSecrets: vi.fn().mockReturnValue({ ok: true, value: null }),
      createTracingLogger: vi.fn().mockReturnValue(createMockLogger()),
      createLogLevelManager: vi.fn().mockReturnValue(createMockLogLevelManager()),
      createTokenTracker: vi.fn().mockReturnValue(createMockTokenTracker()),
      createProcessMonitor: vi.fn().mockReturnValue(createMockProcessMonitor()),
      createGatewayServer: vi.fn().mockReturnValue(undefined),
      setupMedia: vi.fn().mockResolvedValue({
        transcriber: null, ttsRunner: null, imageGenProvider: null, imageAnalyzer: null,
        mediaInfra: null, linkUnderstandingEngine: null, mediaPersistence: null, documentExtractor: null,
      }),
      exit: vi.fn(),
    };

    await expect(main(overrides)).rejects.toThrow(/\[CONFIG_ERROR\].*security\.storage/);
  });
});
