// SPDX-License-Identifier: Apache-2.0
/**
 * Boot-window honesty wiring proof — drives the
 * REAL `setupSingleAgent` boot path and asserts the served-window comparator +
 * boot-window-info collection run beside the per-agent pi ModelRegistry, the
 * ONLY seam with the registry-enriched "configured" window the executor itself
 * resolves (pi-executor.ts find + `?? 8_192`).
 *
 * Mirrors the 8 `setup-agents-*-wiring.test.ts` siblings' harness, with one
 * deliberate difference: `@comis/agent` is mocked via `importOriginal` spread so
 * `compareServedWindowForProvider` / `collectAgentBootWindowInfo` /
 * `resetServedWindowWarnForTest` are the REAL implementations — the wiring proof
 * must exercise the real once-per-boot-per-provider WARN latch and the real
 * executor-mirrored window resolution, not a stub (a recurring failure class
 * is "built-but-not-wired"; a stubbed comparator could pass while
 * the daemon never feeds it real registry data).
 *
 * Guards against the built-but-not-wired regression: without this wiring
 * SingleAgentDeps has no `servedWindowComparisons` / `agentBootWindowInfo`
 * collector fields and the runtime never invokes the comparator, so the
 * threaded maps stay empty and no comparator WARN fires.
 *
 * @module
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// --- Heavy collaborator mocks (hoisted) ------------------------------------

const mockExecutor = vi.hoisted(() => ({ execute: vi.fn(), getModel: vi.fn(() => "m") }));
const mockCreatePiExecutor = vi.hoisted(() => vi.fn(() => mockExecutor));
const mockSessionAdapter = vi.hoisted(() => ({ load: vi.fn(), save: vi.fn(), destroy: vi.fn() }));
/** Switchable per-test registry find — the registry-enriched "configured" source. */
const mockRegistryFind = vi.hoisted(() => vi.fn());

vi.mock("@comis/agent", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    // REAL via the spread: compareServedWindowForProvider,
    // collectAgentBootWindowInfo, resetServedWindowWarnForTest (and every
    // other pure helper the runtime leaf consumes).
    ...actual,
    createCircuitBreaker: vi.fn(() => ({ isOpen: () => false, recordSuccess: vi.fn(), recordFailure: vi.fn() })),
    createBudgetGuard: vi.fn(() => ({ check: vi.fn() })),
    createCostTracker: vi.fn(() => ({ track: vi.fn() })),
    createStepCounter: vi.fn(() => ({ increment: vi.fn() })),
    createPiExecutor: mockCreatePiExecutor,
    createComisSessionManager: vi.fn(() => mockSessionAdapter),
    cleanupStaleLocks: vi.fn(async () => 0),
    createAuthStorageAdapter: vi.fn(() => ({ getApiKey: vi.fn() })),
    createModelRegistryAdapter: vi.fn(async () => ({ registry: { find: mockRegistryFind }, modelRuntime: {} })),
    registerCustomProviders: vi.fn(() => ({ registered: 0, providerAliases: new Map() })),
    createAuthProfileManager: vi.fn(() => ({})),
    createAuthRotationAdapter: vi.fn(() => ({})),
    resolveCompactionModel: vi.fn(() => ""),
    LEAN_TOOL_DESCRIPTIONS: {},
    resolveDescription: vi.fn(() => "desc"),
  };
});

vi.mock("@comis/skills", () => ({
  agentToolsToToolDefinitions: vi.fn(() => []),
  createSkillRegistry: vi.fn(() => ({
    init: vi.fn(),
    startWatching: vi.fn(() => ({ close: vi.fn() })),
    getSnapshot: vi.fn(() => ({ prompt: "" })),
  })),
  createRuntimeEligibilityContext: vi.fn(() => ({})),
}));

vi.mock("@comis/core", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    safePath: vi.fn((...parts: string[]) => parts.filter((p) => p.length > 0).join("/")),
    ensureWorkspace: vi.fn(async () => {}),
    resolveWorkspaceDir: vi.fn(() => "/tmp/test-workspace"),
  };
});

vi.mock("node:fs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs")>()),
  mkdirSync: vi.fn(),
}));

vi.mock("../tool-capability-adapter.js", () => ({
  createToolCapabilityAdapter: vi.fn(() => ({ getCapabilities: vi.fn() })),
}));

vi.mock("./setup-agents-oauth.js", () => ({
  wireAuthProvider: vi.fn(() => ({ oauth: { resolveProviderApiKey: vi.fn() } })),
}));
vi.mock("./setup-acp-wiring.js", () => ({
  createAcpWiring: vi.fn(() => ({ holder: { current: undefined } })),
}));

import { setupSingleAgent } from "./setup-agents-runtime.js";
import { resetServedWindowWarnForTest } from "@comis/agent";
import { PerAgentConfigSchema, type AppContainer, type PerAgentConfig } from "@comis/core";
import type { SingleAgentDeps } from "./setup-agents-types.js";

// --- Harness ---------------------------------------------------------------

const COMPARATOR_WARN_MSG = "Ollama served context window below configured";
const FAIL_OPEN_WARN_MSG = "Boot window honesty checks skipped for agent";

function makeLogger(): any {
  const logger: any = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(() => logger),
  };
  return logger;
}

/** Count recorded warn calls by their message string. */
function warnsWithMsg(logger: any, msg: string): unknown[][] {
  return (logger.warn as ReturnType<typeof vi.fn>).mock.calls.filter(
    (call: unknown[]) => call[1] === msg,
  );
}

function makeContainer(agentIds: string[]): AppContainer {
  const agents: Record<string, PerAgentConfig> = {};
  for (const id of agentIds) {
    // Explicit (non-"default") provider/model so resolveAgentModel passes them
    // through unchanged — the comparator must key on "qwen-local".
    agents[id] = PerAgentConfigSchema.parse({ name: id, model: "qwen3.6:35b", provider: "qwen-local" });
  }
  return {
    config: {
      agents,
      models: { defaultModel: "", defaultProvider: "" },
      dataDir: "/tmp/test-data",
      tenantId: "test-tenant",
      security: { storage: "file" },
      // The provider entry the comparator's probed-model expression reads
      // (resolveProbedModelId → models[0].id) — no defaultModel, no capability pin.
      providers: { entries: { "qwen-local": { models: [{ id: "qwen3.6:35b" }] } } },
      tooling: {},
      diagnostics: {},
      messages: {},
      integrations: { media: { persistence: { enabled: false } } },
      envelope: {},
      senderTrustDisplay: {},
      documentation: {},
      observability: {},
    } as any,
    eventBus: { on: vi.fn(), emit: vi.fn() } as any,
    secretManager: { get: vi.fn(() => undefined), has: vi.fn(() => false) } as any,
    hookRunner: {} as any,
  } as unknown as AppContainer;
}

interface ServedWindowHarness {
  deps: SingleAgentDeps;
  logger: any;
  servedWindowComparisons: Map<string, unknown>;
  agentBootWindowInfo: Map<string, unknown>;
}

function makeDeps(container: AppContainer): ServedWindowHarness {
  const logger = makeLogger();
  const servedWindowComparisons = new Map<string, unknown>();
  const agentBootWindowInfo = new Map<string, unknown>();
  const deps = {
    container,
    memoryAdapter: { getDb: vi.fn() } as any,
    sessionStore: {} as any,
    agentLogger: logger,
    resolvedAgentDir: "/tmp/agent-dir",
    mcpToolsInherited: false,
    rerankerModelPresent: false,
    oauthCredentialStore: { get: vi.fn(), set: vi.fn(), has: vi.fn(), list: vi.fn(), delete: vi.fn() } as any,
    mcpClientManager: {} as any,
    fileLock: { acquire: vi.fn(), release: vi.fn(), withLock: vi.fn(), isLocked: vi.fn(), cleanupStaleLocks: vi.fn(async () => 0) } as any,
    clock: { now: () => 0, monotonicNow: () => 0 } as any,
    env: { get: vi.fn() } as any,
    timers: { setTimeout: vi.fn(), setInterval: vi.fn() } as any,
    pendingModeSwitches: new Map(),
    trajectoryRegistry: { closeAll: vi.fn() } as any,
    // Probe result: Ollama serves 8_192 for this provider.
    servedWindowByProvider: new Map<string, number>([["qwen-local", 8_192]]),
    // The daemon-owned collector maps under test.
    servedWindowComparisons,
    agentBootWindowInfo,
  } as unknown as SingleAgentDeps;
  return { deps, logger, servedWindowComparisons, agentBootWindowInfo };
}

// --- Tests -------------------------------------------------------------------

describe("setupSingleAgent boot-window honesty wiring", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // The comparator's once-per-boot-per-provider latch is module-level — reset
    // so test order cannot leak a latched WARN across cases.
    resetServedWindowWarnForTest();
    // Registry-enriched "configured": find resolves contextWindow 131_072.
    mockRegistryFind.mockImplementation((provider: string, id: string) => ({
      id,
      provider,
      contextWindow: 131_072,
    }));
  });

  it("invokes the comparator beside the per-agent registry and collects the comparison into the threaded map, warning exactly once", async () => {
    const agentId = "default";
    const container = makeContainer([agentId]);
    const { deps, logger, servedWindowComparisons } = makeDeps(container);

    await setupSingleAgent(agentId, container.config.agents[agentId] as PerAgentConfig, deps);

    // ONE comparison collected for the provider, fed by the probe map (served
    // 8_192) against the registry-mirrored configured window (131_072).
    expect(servedWindowComparisons.get("qwen-local")).toMatchObject({
      served: 8_192,
      configured: 131_072,
      belowConfigured: true,
    });
    // Exactly ONE under-served comparator WARN (the exact WARN shape lives in
    // the comparator's own fixtures; the wiring proof pins invocation + latch).
    expect(warnsWithMsg(logger, COMPARATOR_WARN_MSG)).toHaveLength(1);
  });

  it("latches the WARN per provider across agents — two agents on one provider still warn once and collect one entry", async () => {
    const container = makeContainer(["default", "second"]);
    const { deps, logger, servedWindowComparisons } = makeDeps(container);

    await setupSingleAgent("default", container.config.agents["default"] as PerAgentConfig, deps);
    await setupSingleAgent("second", container.config.agents["second"] as PerAgentConfig, deps);

    expect(warnsWithMsg(logger, COMPARATOR_WARN_MSG)).toHaveLength(1);
    expect(servedWindowComparisons.size).toBe(1);
    // The latched second call still RETURNED a comparison (one comparison,
    // two surfaces) — the map entry survives the re-set.
    expect(servedWindowComparisons.get("qwen-local")).toMatchObject({ belowConfigured: true });
  });

  it("collects per-agent boot window info (served-bound effective window, registry-mirrored configured, small/nano profile) into the threaded map", async () => {
    const agentId = "default";
    const container = makeContainer([agentId]);
    const { deps, agentBootWindowInfo } = makeDeps(container);

    await setupSingleAgent(agentId, container.config.agents[agentId] as PerAgentConfig, deps);

    const info = agentBootWindowInfo.get(agentId) as
      | {
          effectiveWindow: number;
          windowSource: string;
          configuredWindow: number;
          modelProfile: { capabilityClass: string };
        }
      | undefined;
    expect(info).toBeDefined();
    expect(info).toMatchObject({
      effectiveWindow: 8_192,
      windowSource: "served",
      configuredWindow: 131_072,
    });
    // Unknown local provider family → small (fail-safe); the floor equation
    // consumes the profile resolved on the RECONCILED window.
    expect(["small", "nano"]).toContain(info?.modelProfile.capabilityClass);
  });

  it("binds servedContextWindow as the {providerKey, window} pair so the executor can gate the clamp on the per-execution provider", async () => {
    // The bare number lost the provider identity —
    // pi-executor then applied the primary's served window to override models
    // on OTHER providers. The pairing is one field by design: a value without
    // its provider key cannot be bound.
    const agentId = "default";
    const container = makeContainer([agentId]);
    const { deps } = makeDeps(container);

    await setupSingleAgent(agentId, container.config.agents[agentId] as PerAgentConfig, deps);

    expect(mockCreatePiExecutor).toHaveBeenCalledTimes(1);
    const executorDeps = (mockCreatePiExecutor.mock.calls[0] as unknown[])?.[1] as
      | { servedContextWindow?: { providerKey: string; window: number } }
      | undefined;
    expect(executorDeps?.servedContextWindow).toEqual({
      providerKey: "qwen-local",
      window: 8_192,
    });
  });

  it("the boot-window info carries the EXACT convertTools closure the executor receives (corpus-identity pin)", async () => {
    // The boot toolSchemaTokens term must
    // measure the SAME converted ToolDefinition corpus the turn-time S
    // estimate measures. The pin is REFERENCE identity — one closure, two
    // consumers — so the two corpora cannot fork (a second closure built from
    // the same parts could silently drift).
    const agentId = "default";
    const container = makeContainer([agentId]);
    const { deps, agentBootWindowInfo } = makeDeps(container);

    await setupSingleAgent(agentId, container.config.agents[agentId] as PerAgentConfig, deps);

    const info = agentBootWindowInfo.get(agentId) as { convertTools?: unknown } | undefined;
    const executorDeps = (mockCreatePiExecutor.mock.calls[0] as unknown[])?.[1] as
      | { convertTools?: unknown }
      | undefined;
    expect(typeof info?.convertTools).toBe("function");
    expect(typeof executorDeps?.convertTools).toBe("function");
    expect(info?.convertTools).toBe(executorDeps?.convertTools);
  });

  it("an unprobed provider binds servedContextWindow undefined (no pair fabricated)", async () => {
    const agentId = "default";
    const container = makeContainer([agentId]);
    const { deps } = makeDeps(container);
    (deps as unknown as { servedWindowByProvider: Map<string, number> }).servedWindowByProvider =
      new Map();

    await setupSingleAgent(agentId, container.config.agents[agentId] as PerAgentConfig, deps);

    const executorDeps = (mockCreatePiExecutor.mock.calls[0] as unknown[])?.[1] as
      | { servedContextWindow?: unknown }
      | undefined;
    expect(executorDeps?.servedContextWindow).toBeUndefined();
  });

  it("fails open — a throwing registry find does NOT reject agent setup; setup completes with an errorKind 'internal' WARN and no collected boot info", async () => {
    const agentId = "default";
    const container = makeContainer([agentId]);
    const { deps, logger, agentBootWindowInfo } = makeDeps(container);
    mockRegistryFind.mockImplementation(() => {
      throw new Error("registry exploded");
    });

    // The agent must still boot: no rejection.
    await expect(
      setupSingleAgent(agentId, container.config.agents[agentId] as PerAgentConfig, deps),
    ).resolves.toBeDefined();

    const failOpenWarns = warnsWithMsg(logger, FAIL_OPEN_WARN_MSG);
    expect(failOpenWarns).toHaveLength(1);
    expect(failOpenWarns[0]?.[0]).toMatchObject({ errorKind: "internal", agentId });
    // The honesty block was skipped wholesale — nothing half-collected.
    expect(agentBootWindowInfo.size).toBe(0);
  });
});
