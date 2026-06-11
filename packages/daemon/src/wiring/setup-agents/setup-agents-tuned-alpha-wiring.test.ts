// SPDX-License-Identifier: Apache-2.0
/**
 * Forward-presence test — drives the REAL `setupSingleAgent`
 * boot path and asserts that `tunedAlphaStore` from `SingleAgentDeps` is actually
 * forwarded into the `createPiExecutor(...)` deps object literal.
 *
 * The field-plumbing lesson this file guards (the earlier user-representation BLOCKER, the
 * relationship-store reproduction, now for the tuned-alpha sibling): a store can be
 * threaded through the TYPES (setup-agents-types.ts, pi-executor-types.ts) and
 * POPULATED in setup-agents-registry.ts, yet the `createPiExecutor` construction site
 * in setup-agents-runtime.ts (the long sibling-stores line that already carries
 * `usefulnessStore`/`userRepresentationStore`/`relationshipStore`) can still OMIT it —
 * so in the live daemon `deps.tunedAlphaStore` is always `undefined` and the
 * gated read in prompt-assembly's `buildScoringAlphas` overlay never sees the store
 * (the learned alphas silently never apply — Pitfall 5). The keyless bench passes
 * (it constructs the adapter directly) but a live daemon never reads the tuned vector.
 *
 * Mirrors setup-agents-relationship-wiring.test.ts / setup-agents-userrep-wiring.test.ts
 * 1:1 — the established analog for asserting a deps field reaches the mocked
 * createPiExecutor. RED on pre-fix code (the :466 line omits tunedAlphaStore), GREEN
 * once the forward is added on the sibling-stores line.
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
  createModelRegistryAdapter: vi.fn(() => ({ find: vi.fn() })),
  registerCustomProviders: vi.fn(() => ({ registered: 0, providerAliases: new Map() })),
  createAuthProfileManager: vi.fn(() => ({})),
  createAuthRotationAdapter: vi.fn(() => ({})),
  resolveCompactionModel: vi.fn(() => ""),
  resolveOperationDefaults: vi.fn(() => ({ mid: "concrete-model" })),
  // KNOB-01 + FLOOR-01 (176-05): the boot-honesty block runs unconditionally in
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
    rawAgentRerankEnabled: new Map<string, boolean | undefined>(),
    hookRunner: {} as any,
  } as unknown as AppContainer;
}

// The load-bearing sentinel — the exact object the executor construction must forward.
const SENTINEL_TUNED_ALPHA = { read: vi.fn(), upsert: vi.fn() } as any;

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
    tunedAlphaStore: SENTINEL_TUNED_ALPHA,
    oauthCredentialStore: { get: vi.fn(), set: vi.fn(), has: vi.fn(), list: vi.fn(), delete: vi.fn() } as any,
    mcpClientManager: {} as any,
    fileLock: { acquire: vi.fn(), release: vi.fn(), withLock: vi.fn(), isLocked: vi.fn(), cleanupStaleLocks: vi.fn(async () => 0) } as any,
    clock: { now: () => 0, monotonicNnow: () => 0 } as any,
    env: { get: vi.fn() } as any,
    timers: { setTimeout: vi.fn(), setInterval: vi.fn() } as any,
    trajectoryRegistry: { closeAll: vi.fn() } as any,
  } as unknown as SingleAgentDeps;
}

// --- Test ------------------------------------------------------------------

describe("setupSingleAgent forwards tunedAlphaStore into createPiExecutor (field-plumbing)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("passes the SingleAgentDeps.tunedAlphaStore through to the executor deps", async () => {
    // RED on pre-fix code: the createPiExecutor object literal omits tunedAlphaStore,
    // so the executor (and thus prompt-assembly's buildScoringAlphas gated read) never
    // sees the store → the learned alphas silently never apply in the live daemon. GREEN
    // once the forward is added on the sibling-stores line.
    const agentId = "default";
    const container = makeContainer(agentId);
    const deps = makeDeps(container);
    await setupSingleAgent(agentId, container.config.agents[agentId] as PerAgentConfig, deps);

    // createPiExecutor(effectiveConfig, deps) — the store is forwarded in the 2nd (deps) arg.
    expect(mockCreatePiExecutor).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ tunedAlphaStore: SENTINEL_TUNED_ALPHA }),
    );
  });
});
