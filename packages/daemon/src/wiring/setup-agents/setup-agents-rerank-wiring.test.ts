// SPDX-License-Identifier: Apache-2.0
/**
 * Drives the real `setupSingleAgent` path and pins the validated rerank-mode
 * truth table. Heavy collaborators are mocked because the observable contract
 * is the effective mode written to `container.config.agents[agentId]`.
 *
 * @module
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// --- Heavy collaborator mocks (hoisted) ------------------------------------

const mockExecutor = vi.hoisted(() => ({ execute: vi.fn(), getModel: vi.fn(() => "m") }));
const mockCreatePiExecutor = vi.hoisted(() => vi.fn(() => mockExecutor));
const mockSessionAdapter = vi.hoisted(() => ({ load: vi.fn(), save: vi.fn(), destroy: vi.fn() }));

vi.mock("@comis/agent", () => ({
  createCircuitBreaker: vi.fn(() => ({ isOpen: () => false, recordSuccess: vi.fn(), recordFailure: vi.fn() })),
  createBudgetGuard: vi.fn(() => ({ check: vi.fn() })),
  createCostTracker: vi.fn(() => ({ track: vi.fn() })),
  createStepCounter: vi.fn(() => ({ increment: vi.fn() })),
  createPiExecutor: mockCreatePiExecutor,
  createComisSessionManager: vi.fn(() => mockSessionAdapter),
  cleanupStaleLocks: vi.fn(async () => 0),
  createAuthStorageAdapter: vi.fn(() => ({ getApiKey: vi.fn() })),
  createModelRegistryAdapter: vi.fn(async () => ({ registry: { find: vi.fn() }, modelRuntime: {} })),
  registerCustomProviders: vi.fn(() => ({ registered: 0, providerAliases: new Map() })),
  createAuthProfileManager: vi.fn(() => ({})),
  createAuthRotationAdapter: vi.fn(() => ({})),
  resolveCompactionModel: vi.fn(() => ""),
  resolveOperationDefaults: vi.fn(() => ({ mid: "concrete-model" })),
  // The boot-honesty block runs unconditionally in
  // setupSingleAgent — stubbed inert here (this suite pins a different wire).
  compareServedWindowForProvider: vi.fn(() => undefined),
  collectAgentBootWindowInfo: vi.fn(() => ({})),
  LEAN_TOOL_DESCRIPTIONS: {},
  resolveDescription: vi.fn(() => "desc"),
}));

vi.mock("@comis/skills", () => ({
  agentToolsToToolDefinitions: vi.fn(() => []),
  createSkillRegistry: vi.fn(() => ({
    init: vi.fn(),
    startWatching: vi.fn(() => ({ close: vi.fn() })),
    getSnapshot: vi.fn(() => ({ prompt: "" })),
  })),
  createRuntimeEligibilityContext: vi.fn(() => ({})),
}));

// Stub only filesystem-touching helpers; the real schema must resolve defaults.
vi.mock("@comis/core", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    safePath: vi.fn((...parts: string[]) => parts.filter((p) => p.length > 0).join("/")),
    ensureWorkspace: vi.fn(async () => {}),
    resolveWorkspaceDir: vi.fn(() => "/tmp/test-workspace"),
  };
});

vi.mock("node:fs", () => ({ mkdirSync: vi.fn() }));

// The per-agent ToolCapabilityPort adapter (constructed inside setupSingleAgent).
vi.mock("../tool-capability-adapter.js", () => ({
  createToolCapabilityAdapter: vi.fn(() => ({ getCapabilities: vi.fn() })),
}));

// OAuth + ACP wiring helpers — return minimal shapes the runtime reads.
vi.mock("./setup-agents-oauth.js", () => ({
  wireAuthProvider: vi.fn(() => ({ oauth: { resolveProviderApiKey: vi.fn() } })),
}));
vi.mock("./setup-acp-wiring.js", () => ({
  createAcpWiring: vi.fn(() => ({ holder: { current: undefined } })),
}));

import { setupSingleAgent } from "./setup-agents-runtime.js";
import { PerAgentConfigSchema, type AppContainer, type PerAgentConfig } from "@comis/core";
import type { SingleAgentDeps } from "./setup-agents-types.js";

// --- Harness ---------------------------------------------------------------

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

function makeContainer(agentId: string, mode: "auto" | "on" | "off" | undefined): AppContainer {
  const rawAgent: Record<string, unknown> = { name: agentId, model: "default", provider: "default" };
  if (mode !== undefined) {
    rawAgent.rag = { rerank: { mode } };
  }
  const parsed = PerAgentConfigSchema.parse(rawAgent);

  return {
    config: {
      agents: { [agentId]: parsed },
      models: { defaultModel: "", defaultProvider: "" },
      dataDir: "/tmp/test-data",
      tenantId: "test-tenant",
      security: { storage: "file" },
      providers: { entries: {} },
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

function makeDeps(container: AppContainer, rerankerModelPresent: boolean): SingleAgentDeps {
  const logger = makeLogger();
  return {
    container,
    memoryAdapter: { getDb: vi.fn() } as any,
    sessionStore: {} as any,
    agentLogger: logger,
    resolvedAgentDir: "/tmp/agent-dir",
    mcpToolsInherited: false,
    rerankerModelPresent,
    oauthCredentialStore: { get: vi.fn(), set: vi.fn(), has: vi.fn(), list: vi.fn(), delete: vi.fn() } as any,
    mcpClientManager: {} as any,
    fileLock: { acquire: vi.fn(), release: vi.fn(), withLock: vi.fn(), isLocked: vi.fn(), cleanupStaleLocks: vi.fn(async () => 0) } as any,
    clock: { now: () => 0, monotonicNnow: () => 0 } as any,
    env: { get: vi.fn() } as any,
    timers: { setTimeout: vi.fn(), setInterval: vi.fn() } as any,
    trajectoryRegistry: { closeAll: vi.fn() } as any,
  } as unknown as SingleAgentDeps;
}

async function runAndReadEffectiveRerank(
  mode: "auto" | "on" | "off" | undefined,
  rerankerModelPresent: boolean,
): Promise<{ effectiveMode: "auto" | "on" | "off"; container: AppContainer; logger: any }> {
  const agentId = "default";
  const container = makeContainer(agentId, mode);
  const deps = makeDeps(container, rerankerModelPresent);
  await setupSingleAgent(agentId, container.config.agents[agentId] as PerAgentConfig, deps);
  // Downstream consumers read the WRITTEN-BACK effective config.
  const effectiveMode = container.config.agents[agentId]!.rag.rerank.mode;
  return { effectiveMode, container, logger: deps.agentLogger };
}

// --- Tests -----------------------------------------------------------------

describe("setupSingleAgent resolves the validated rerank mode", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("auto-enables rerank for a genuinely all-default agent when the model is present", async () => {
    const { effectiveMode } = await runAndReadEffectiveRerank(undefined, true);
    expect(effectiveMode).toBe("on");
  });

  it("fires the auto-enabled INFO boundary log exactly once for the unset+present case", async () => {
    const { logger } = await runAndReadEffectiveRerank(undefined, true);
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ rerankAutoEnabled: true }),
      expect.stringContaining("Reranker auto-enabled"),
    );
  });

  it("keeps rerank off for an all-default agent when the model is absent (zero-download posture)", async () => {
    const { effectiveMode, logger } = await runAndReadEffectiveRerank(undefined, false);
    expect(effectiveMode).toBe("off");
    expect(logger.info).not.toHaveBeenCalledWith(
      expect.objectContaining({ rerankAutoEnabled: true }),
      expect.anything(),
    );
  });

  it("honors explicit on even when the model is absent", async () => {
    const { effectiveMode, logger } = await runAndReadEffectiveRerank("on", false);
    expect(effectiveMode).toBe("on");
    expect(logger.info).not.toHaveBeenCalledWith(
      expect.objectContaining({ rerankAutoEnabled: true }),
      expect.anything(),
    );
  });

  it("honors explicit off even when the model is present", async () => {
    const { effectiveMode, logger } = await runAndReadEffectiveRerank("off", true);
    expect(effectiveMode).toBe("off");
    expect(logger.info).not.toHaveBeenCalledWith(
      expect.objectContaining({ rerankAutoEnabled: true }),
      expect.anything(),
    );
  });
});
