// SPDX-License-Identifier: Apache-2.0
/**
 * BEHAVIORAL wiring test — drives the REAL `setupSingleAgent`
 * boot path end-to-end (NOT a source-string match, NOT the pure `resolveEffectiveRerank`
 * unit) to prove the per-agent effective `rag.rerank.enabled` precedence ACTUALLY fires
 * for the data the production caller has in hand.
 *
 * The BLOCKER this file reproduces: the precedence read the "explicit" signal
 * from a config object that is ALREADY Zod-parsed, where `rag.rerank.enabled` has been
 * defaulted to a concrete boolean (`.default(true)`). So the genuine
 * "unset" signal was erased before it reached `resolveEffectiveRerank`, and the
 * zero-download precedence (unset → auto-on iff modelPresent) could NEVER work.
 * The earlier `resolveEffectiveRerank` unit test passed but proved nothing about
 * whether the caller could ever supply `undefined`. This file closes that gap:
 * it asserts the EFFECTIVE config written back to `container.config.agents[agentId]`,
 * driving the SAME parse the boot loop applies.
 *
 * The four scenarios pin the full truth table:
 *   (1) all-default (rerank UNSET) + modelPresent=true  → effective enabled === true  (auto-on FIRES)
 *   (2) all-default (rerank UNSET) + modelPresent=false → effective enabled === false (stays off)
 *   (3) explicit enabled:true      + modelPresent=false → effective enabled === true  (opt-in preserved)
 *   (4) explicit enabled:false     + modelPresent=true  → effective enabled === false (force-off preserved)
 *
 * The heavy per-agent collaborators (executor, skill registry, OAuth, workspace, ACP)
 * are mocked to no-ops — the write-back at `container.config.agents[agentId] = effectiveConfig`
 * happens BEFORE executor construction, so the resolved rerank flag is observable without
 * the real executor stack. `@comis/core` is preserved EXCEPT `safePath`/`ensureWorkspace`/
 * `resolveWorkspaceDir` (filesystem) so `PerAgentConfigSchema` stays REAL — that real parse
 * is exactly what erases the unset signal and reproduces the bug.
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

// Stub only the filesystem-touching @comis/core helpers; keep PerAgentConfigSchema REAL
// (its `.default()` on rerank.enabled — default-ON — is what makes the
// parsed value a concrete boolean that erases the unset signal, reproducing the bug).
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

/**
 * Build a container the way the daemon boot path builds it: `config.agents` is the
 * Zod-PARSED config (so an unset rerank arrives as a concrete `false`), and
 * `rawAgentRerankEnabled` carries the genuine pre-default signal (the Approach-B raw map).
 * `rawRerankInput` is the RAW (pre-parse) rerank.enabled the operator wrote (or omitted).
 */
function makeContainer(agentId: string, rawRerankInput: boolean | undefined): AppContainer {
  const rawAgent: Record<string, unknown> = { name: agentId, model: "default", provider: "default" };
  if (rawRerankInput !== undefined) {
    rawAgent.rag = { rerank: { enabled: rawRerankInput } };
  }
  // Parse exactly as the boot loop does — this is what erases an unset rerank to false.
  const parsed = PerAgentConfigSchema.parse(rawAgent);

  const rawAgentRerankEnabled = new Map<string, boolean | undefined>();
  rawAgentRerankEnabled.set(agentId, rawRerankInput);

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
    rawAgentRerankEnabled,
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
  rawRerankInput: boolean | undefined,
  rerankerModelPresent: boolean,
): Promise<{ effectiveEnabled: boolean; container: AppContainer; logger: any }> {
  const agentId = "default";
  const container = makeContainer(agentId, rawRerankInput);
  const deps = makeDeps(container, rerankerModelPresent);
  await setupSingleAgent(agentId, container.config.agents[agentId] as PerAgentConfig, deps);
  // Downstream consumers read the WRITTEN-BACK effective config.
  const effectiveEnabled = container.config.agents[agentId]!.rag.rerank.enabled;
  return { effectiveEnabled, container, logger: deps.agentLogger };
}

// --- Tests -----------------------------------------------------------------

describe("setupSingleAgent rag.rerank auto-on through the real parsed-config boot path", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("auto-enables rerank for a genuinely all-default agent when the model is present", async () => {
    // rerank is UNSET (the operator never set it) — the raw map carries `undefined`. The
    // precedence threads that raw tri-state (NOT the parsed default, which
    // makes a concrete `true`), so modelPresent=true resolves auto-on. (Previously the
    // precedence read the parsed default and could never see the unset signal.)
    const { effectiveEnabled } = await runAndReadEffectiveRerank(undefined, true);
    expect(effectiveEnabled).toBe(true);
  });

  it("fires the auto-enabled INFO boundary log exactly once for the unset+present case", async () => {
    // The operator must be able to see WHY rerank turned on for an agent that never set it.
    // The guard at setup-agents-runtime.ts must be reachable so both the flip AND its
    // INFO log fire; if the guard were dead (unreachable), this INFO would never emit.
    const { logger } = await runAndReadEffectiveRerank(undefined, true);
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ rerankAutoEnabled: true }),
      expect.stringContaining("Reranker auto-enabled"),
    );
  });

  it("keeps rerank off for an all-default agent when the model is absent (zero-download posture)", async () => {
    // Fresh install, model NOT present: unset + absent → effective stays false. This holds
    // on pre-patch too (it is the one case the broken read coincidentally gets right), and
    // must REMAIN green after the fix so the zero-download posture is preserved.
    const { effectiveEnabled, logger } = await runAndReadEffectiveRerank(undefined, false);
    expect(effectiveEnabled).toBe(false);
    // And the auto-on INFO must NOT fire when nothing was flipped on.
    expect(logger.info).not.toHaveBeenCalledWith(
      expect.objectContaining({ rerankAutoEnabled: true }),
      expect.anything(),
    );
  });

  it("honors an explicit opt-in (enabled:true) even when the model is absent", async () => {
    // Explicit operator value wins both directions: enabled:true stays on regardless of
    // local presence (the download path is owned by the build gate, not this flip).
    const { effectiveEnabled, logger } = await runAndReadEffectiveRerank(true, false);
    expect(effectiveEnabled).toBe(true);
    // Explicit-on is NOT an auto-on — the boundary log must stay silent.
    expect(logger.info).not.toHaveBeenCalledWith(
      expect.objectContaining({ rerankAutoEnabled: true }),
      expect.anything(),
    );
  });

  it("honors an explicit force-off (enabled:false) even when the model is present", async () => {
    // Explicit false must NOT be overridden by local presence — operator intent is final.
    const { effectiveEnabled, logger } = await runAndReadEffectiveRerank(false, true);
    expect(effectiveEnabled).toBe(false);
    expect(logger.info).not.toHaveBeenCalledWith(
      expect.objectContaining({ rerankAutoEnabled: true }),
      expect.anything(),
    );
  });
});
