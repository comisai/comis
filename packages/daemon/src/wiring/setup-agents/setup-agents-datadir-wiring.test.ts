// SPDX-License-Identifier: Apache-2.0
/**
 * Wiring guard — setupSingleAgent must thread the resolved data dir into BOTH
 * `createComisSessionManager(...)` and the `createPiExecutor(...)` deps.
 *
 * Without the forward, neither call receives `dataDir`, so the agent-side
 * session-index writers (comis-session-manager.ts + pi-event-bridge.ts, both
 * `deps.dataDir ?? ~/.comis`) fall back to the REAL ~/.comis — tripping the
 * "must not write under the real ~/.comis" guard, and on a production install
 * with COMIS_DATA_DIR=/custom the session index would silently land in ~/.comis
 * instead of /custom. Mirrors the
 * setup-agents-lcd-wiring.test.ts composition-root guard pattern: types stay
 * structurally compatible when the field is omitted (it is optional), so only
 * a literal-forward assertion catches the omission.
 *
 * @module
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// --- Heavy collaborator mocks (hoisted) ------------------------------------

const mockExecutor = vi.hoisted(() => ({ execute: vi.fn(), getModel: vi.fn(() => "m") }));
const mockCreatePiExecutor = vi.hoisted(() => vi.fn(() => mockExecutor));
const mockSessionAdapter = vi.hoisted(() => ({ load: vi.fn(), save: vi.fn(), destroy: vi.fn() }));
const mockCreateComisSessionManager = vi.hoisted(() => vi.fn(() => mockSessionAdapter));

vi.mock("@comis/agent", () => ({
  createCircuitBreaker: vi.fn(() => ({ isOpen: () => false, recordSuccess: vi.fn(), recordFailure: vi.fn() })),
  createBudgetGuard: vi.fn(() => ({ check: vi.fn() })),
  createCostTracker: vi.fn(() => ({ track: vi.fn() })),
  createStepCounter: vi.fn(() => ({ increment: vi.fn() })),
  createPiExecutor: mockCreatePiExecutor,
  createComisSessionManager: mockCreateComisSessionManager,
  cleanupStaleLocks: vi.fn(async () => 0),
  createAuthStorageAdapter: vi.fn(() => ({ getApiKey: vi.fn() })),
  createModelRegistryAdapter: vi.fn(async () => ({ registry: { find: vi.fn() }, modelRuntime: {} })),
  registerCustomProviders: vi.fn(() => ({ registered: 0, providerAliases: new Map() })),
  createAuthProfileManager: vi.fn(() => ({})),
  createAuthRotationAdapter: vi.fn(() => ({})),
  resolveCompactionModel: vi.fn(() => ""),
  resolveOperationDefaults: vi.fn(() => ({ mid: "concrete-model" })),
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

function makeContainer(agentId: string): AppContainer {
  const parsed = PerAgentConfigSchema.parse({ name: agentId, model: "default", provider: "default" });
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

function makeDeps(container: AppContainer): SingleAgentDeps {
  const logger = makeLogger();
  return {
    container,
    memoryAdapter: { getDb: vi.fn() } as any,
    sessionStore: {} as any,
    agentLogger: logger,
    resolvedAgentDir: "/tmp/agent-dir",
    mcpToolsInherited: false,
    rerankerModelPresent: false,
    lcdStore: { append: vi.fn(), getMessages: vi.fn(() => []) } as any,
    oauthCredentialStore: { get: vi.fn(), set: vi.fn(), has: vi.fn(), list: vi.fn(), delete: vi.fn() } as any,
    mcpClientManager: {} as any,
    fileLock: { acquire: vi.fn(), release: vi.fn(), withLock: vi.fn(), isLocked: vi.fn(), cleanupStaleLocks: vi.fn(async () => 0) } as any,
    clock: { now: () => 0, monotonicNnow: () => 0 } as any,
    env: { get: vi.fn() } as any,
    timers: { setTimeout: vi.fn(), setInterval: vi.fn() } as any,
    trajectoryRegistry: { closeAll: vi.fn() } as any,
  } as unknown as SingleAgentDeps;
}

// --- Tests ------------------------------------------------------------------

describe("setupSingleAgent threads the resolved dataDir to session-index writers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("passes dataDir to createComisSessionManager (session_ended index entries)", async () => {
    const agentId = "default";
    const container = makeContainer(agentId);
    const deps = makeDeps(container);
    await setupSingleAgent(agentId, container.config.agents[agentId] as PerAgentConfig, deps);

    expect(mockCreateComisSessionManager).toHaveBeenCalledWith(
      expect.objectContaining({ dataDir: "/tmp/test-data" }),
    );
  });

  it("passes dataDir into the createPiExecutor deps (bridge session_started/turn entries)", async () => {
    const agentId = "default";
    const container = makeContainer(agentId);
    const deps = makeDeps(container);
    await setupSingleAgent(agentId, container.config.agents[agentId] as PerAgentConfig, deps);

    expect(mockCreatePiExecutor).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ dataDir: "/tmp/test-data" }),
    );
  });
});
