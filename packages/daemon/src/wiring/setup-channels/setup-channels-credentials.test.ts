// SPDX-License-Identifier: Apache-2.0
/**
 * Compile-time regression pin + behavioral tests for the credentials leaf of
 * the setup-channels module. Hosts `registerCronEventListeners` (cron-driven
 * API-key + model resolution + event dispatch).
 *
 * The witness pins the closure-captured deps key set. The behavioral tests
 * exercise the `__MEMORY_CONSOLIDATION__` sentinel intercept:
 * the opt-in cost gate (a disabled/default agent does NO LLM work)
 * and the enabled path (the sentinel runs runMemoryConsolidation with the
 * injected store + clock). The broader integration matrix (memory review,
 * agent_turn, systemEvent, suspend notification) is exercised by
 * setup-channels-registry.test.ts which invokes setupChannels end-to-end.
 *
 * @module
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Hoisted mocks. registerCronEventListeners imports concrete symbols from
// @comis/agent / @comis/skills / @comis/channels at module load; mock them so
// the daemon test never does real LLM work nor pulls heavy transitive deps.
// runMemoryConsolidation is the spy the behavioral tests assert against.
// ---------------------------------------------------------------------------

const mockRunMemoryConsolidation = vi.hoisted(() => vi.fn(async () => ({ ok: true as const, value: undefined })));
const mockRunMemoryReview = vi.hoisted(() => vi.fn(async () => ({ ok: true as const, value: undefined })));
// The reasoning job + its injected-seam factory. runMemoryReasoning
// is the spy the __MEMORY_REASONING__ dispatch tests assert against;
// createReasoningSeam returns a sentinel fn the dispatch must pass as deps.reason.
const mockReasonSeam = vi.hoisted(() => vi.fn(async () => ({ deductive: [], inductive: [] })));
const mockCreateReasoningSeam = vi.hoisted(() => vi.fn(() => mockReasonSeam));
const mockRunMemoryReasoning = vi.hoisted(() => vi.fn(async () => ({ ok: true as const, value: undefined })));
const mockResolveOperationModel = vi.hoisted(() => vi.fn(() => ({
  provider: "anthropic",
  modelId: "anthropic:claude-haiku",
  model: "anthropic:claude-haiku",
  timeoutMs: 60_000,
  source: "default",
})));

// Faithful capability-axis stub for resolveModelProfile (CR-01): explicit
// override wins; else anthropic/openai → frontier, google → mid, else → small.
const mockResolveModelProfile = vi.hoisted(() => vi.fn((model: { provider: string }, override?: string) => {
  let capabilityClass = override;
  if (capabilityClass === undefined) {
    const p = model.provider;
    capabilityClass = p === "anthropic" || p === "openai" ? "frontier" : p === "google" ? "mid" : "small";
  }
  return { capabilityClass };
}));

vi.mock("@comis/agent", () => ({
  sanitizeAssistantResponse: vi.fn((s: string) => s),
  resolveOperationModel: mockResolveOperationModel,
  resolveProviderFamily: vi.fn(() => "anthropic"),
  resolveModelProfile: mockResolveModelProfile,
  runMemoryReview: mockRunMemoryReview,
  runMemoryConsolidation: mockRunMemoryConsolidation,
  runMemoryReasoning: mockRunMemoryReasoning,
  createReasoningSeam: mockCreateReasoningSeam,
  classifyError: vi.fn(() => ({ userMessage: "error" })),
}));

vi.mock("@comis/skills", () => ({
  applyToolPolicy: vi.fn((tools: unknown[]) => ({ tools, filtered: [] })),
}));

vi.mock("@comis/channels", () => ({
  filterResponse: vi.fn((text: string) => ({ shouldDeliver: true, cleanedText: text })),
}));

// @comis/core: keep the real module (formatSessionKey / runWithContext /
// createDeliveryOrigin / systemNowMs are pure helpers and the deps types are
// erased) so the sentinel's control flow runs unmodified.

import {
  registerCronEventListeners,
  type CronEventListenerDeps,
} from "./setup-channels-credentials.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Capture the `scheduler:job_result` handler registered on a fake event bus. */
function makeEventBus() {
  const handlers = new Map<string, (payload: any) => unknown>();
  return {
    on: vi.fn((event: string, fn: (payload: any) => unknown) => { handlers.set(event, fn); }),
    emit: vi.fn(),
    fire: (event: string, payload: any) => handlers.get(event)?.(payload),
  };
}

/** A stub consolidation store — its methods must NEVER be reached on the
 *  short-circuit path (RED A); on the enabled path runMemoryConsolidation is
 *  mocked so these are not called by the daemon test directly either. */
function makeConsolidationStore() {
  return {
    listConsolidationCandidates: vi.fn(async () => ({ ok: true as const, value: [] })),
    listObservations: vi.fn(async () => ({ ok: true as const, value: [] })),
    applyConsolidation: vi.fn(async () => ({ ok: true as const, value: undefined })),
  };
}

/** A stub triple store — its methods must NEVER be reached on the short-circuit
 *  path; on the enabled path runMemoryReasoning is mocked so these are not called
 *  by the daemon test directly either. */
function makeTripleStore() {
  return {
    upsertTriple: vi.fn(async () => ({ ok: true as const, value: undefined })),
    currentTruth: vi.fn(async () => ({ ok: true as const, value: [] })),
  };
}

function makeDeps(overrides: {
  agents?: Record<string, any>;
  apiKey?: string | undefined;
  eventBus?: ReturnType<typeof makeEventBus>;
  consolidationStore?: ReturnType<typeof makeConsolidationStore>;
  tripleStore?: ReturnType<typeof makeTripleStore>;
} = {}): CronEventListenerDeps & { __eventBus: ReturnType<typeof makeEventBus> } {
  const eventBus = overrides.eventBus ?? makeEventBus();
  const logger = {
    info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(),
    child: vi.fn(() => logger),
  };
  const container = {
    config: {
      tenantId: "tenant-a",
      agents: overrides.agents ?? {},
      providers: { entries: {} },
    },
    eventBus,
    secretManager: { get: vi.fn(() => (overrides.apiKey === undefined ? undefined : overrides.apiKey)) },
  };
  return {
    container: container as any,
    executors: new Map(),
    defaultAgentId: "default",
    sessionManager: {} as any,
    sessionStore: {} as any,
    logger: logger as any,
    clock: { now: () => 1_000, nowDate: () => new Date(1_000) } as any,
    adaptersByType: new Map(),
    deliveryService: {} as any,
    tenantId: "tenant-a",
    consolidationStore: (overrides.consolidationStore ?? makeConsolidationStore()) as any,
    tripleStore: (overrides.tripleStore ?? makeTripleStore()) as any,
    __eventBus: eventBus,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("setup-channels-credentials", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRunMemoryConsolidation.mockResolvedValue({ ok: true as const, value: undefined });
    mockRunMemoryReasoning.mockResolvedValue({ ok: true as const, value: undefined });
    mockCreateReasoningSeam.mockReturnValue(mockReasonSeam);
    mockResolveOperationModel.mockReturnValue({
      provider: "anthropic", modelId: "anthropic:claude-haiku", model: "anthropic:claude-haiku",
      timeoutMs: 60_000, source: "default",
    });
    mockResolveModelProfile.mockImplementation((model: { provider: string }, override?: string) => {
      let capabilityClass = override;
      if (capabilityClass === undefined) {
        const p = model.provider;
        capabilityClass = p === "anthropic" || p === "openai" ? "frontier" : p === "google" ? "mid" : "small";
      }
      return { capabilityClass } as any;
    });
  });

  it("registerCronEventListeners: exported as a callable function", () => {
    expect(typeof registerCronEventListeners).toBe("function");
    expect(registerCronEventListeners.length).toBeGreaterThanOrEqual(1);
  });

  it("CronEventListenerDeps witness pins the closure-captured key set", () => {
    // The witness's `Record<keyof T, true>` compile-checks exhaustiveness;
    // if a closure capture is added/renamed without updating the deps
    // surface, the literal stops type-checking.
    const witness: Record<keyof CronEventListenerDeps, true> = {
      container: true,
      executors: true,
      defaultAgentId: true,
      sessionManager: true,
      sessionStore: true,
      logger: true,
      // Composition-root clock threaded to runMemoryReview/runMemoryConsolidation
      // for relative-date resolution + timestamp reads.
      clock: true,
      adaptersByType: true,
      deliveryService: true,
      assembleToolsForAgent: true,
      transcriber: true,
      workspaceDirs: true,
      memoryAdapter: true,
      entityStore: true,
      // The consolidation store injected into the
      // __MEMORY_CONSOLIDATION__ sentinel → runMemoryConsolidation.
      consolidationStore: true,
      // The triple store injected into the
      // __MEMORY_REASONING__ sentinel → runMemoryReasoning (the deductive
      // current-truth write path). Threaded daemon → registry → credentials.
      tripleStore: true,
      tenantId: true,
      piSessionAdapters: true,
      cronExecutionTrackers: true,
      activeRunRegistry: true,
    };
    expect(Object.keys(witness).length).toBe(20);
  });

  // -------------------------------------------------------------------------
  // RED A — the opt-in cost gate
  // A disabled (or default-config) agent must do NO consolidation work and the
  // sentinel must short-circuit ok so the scheduler records a clean run.
  // -------------------------------------------------------------------------

  it("short-circuits ok and does NOT run consolidation when the agent has it disabled (opt-in gate)", async () => {
    const consolidationStore = makeConsolidationStore();
    const deps = makeDeps({
      // memoryConsolidation undefined => default OFF.
      agents: { "agent-1": { name: "Agent 1" } },
      consolidationStore,
    });
    registerCronEventListeners(deps);

    const onComplete = vi.fn();
    await deps.__eventBus.fire("scheduler:job_result", {
      result: "__MEMORY_CONSOLIDATION__",
      agentId: "agent-1",
      onComplete,
    });

    // The opt-in cost gate: no LLM work, no store reads, clean ok.
    expect(mockRunMemoryConsolidation).not.toHaveBeenCalled();
    expect(consolidationStore.listConsolidationCandidates).not.toHaveBeenCalled();
    expect(onComplete).toHaveBeenCalledWith({ status: "ok" });
  });

  it("short-circuits ok for an explicitly disabled (enabled:false) agent", async () => {
    const deps = makeDeps({
      agents: { "agent-1": { name: "Agent 1", memoryConsolidation: { enabled: false } } },
    });
    registerCronEventListeners(deps);

    const onComplete = vi.fn();
    await deps.__eventBus.fire("scheduler:job_result", {
      result: "__MEMORY_CONSOLIDATION__",
      agentId: "agent-1",
      onComplete,
    });

    expect(mockRunMemoryConsolidation).not.toHaveBeenCalled();
    expect(onComplete).toHaveBeenCalledWith({ status: "ok" });
  });

  // -------------------------------------------------------------------------
  // RED B — the enabled path
  // An operator-enabled agent runs runMemoryConsolidation with the injected
  // store + clock + the resolved cheap model/key; onComplete reflects the result.
  // -------------------------------------------------------------------------

  it("runs runMemoryConsolidation with the injected store + clock when the agent has it enabled", async () => {
    const consolidationStore = makeConsolidationStore();
    const deps = makeDeps({
      agents: { "agent-1": { name: "Agent 1", provider: "anthropic", memoryConsolidation: { enabled: true, maxCandidatesPerRun: 50 } } },
      apiKey: "test-key",
      consolidationStore,
    });
    registerCronEventListeners(deps);

    const onComplete = vi.fn();
    await deps.__eventBus.fire("scheduler:job_result", {
      result: "__MEMORY_CONSOLIDATION__",
      agentId: "agent-1",
      onComplete,
    });

    expect(mockRunMemoryConsolidation).toHaveBeenCalledOnce();
    const arg = mockRunMemoryConsolidation.mock.calls[0][0] as Record<string, unknown>;
    expect(arg.agentId).toBe("agent-1");
    expect(arg.tenantId).toBe("tenant-a");
    // The injected store (from setup-memory) + clock (composition root) reach the job.
    expect(arg.consolidationStore).toBe(consolidationStore);
    expect(arg.clock).toBe(deps.clock);
    expect(arg.apiKey).toBe("test-key");
    expect(arg.config).toEqual({ enabled: true, maxCandidatesPerRun: 50 });
    expect(onComplete).toHaveBeenCalledWith({ status: "ok", error: undefined });
  });

  // -------------------------------------------------------------------------
  // CR-01: the __MEMORY_REVIEW__ branch threads R6 capabilityClass +
  // hasCapableModelOverride into runMemoryReview's deps so the abstain path is
  // reachable in production for a small/nano cron model. Before the fix neither
  // field was passed → default "frontier" → "capable", so a weak model still ran
  // the extraction LLM call (the R6-dead bug).
  // -------------------------------------------------------------------------
  it("CR-01: __MEMORY_REVIEW__ threads capabilityClass='small' + no override for a small cron model (abstain reachable)", async () => {
    mockResolveOperationModel.mockReturnValue({
      provider: "ollama", modelId: "ollama:qwen3.6:35b", model: "ollama:qwen3.6:35b",
      timeoutMs: 60_000, source: "default",
    } as any);
    const deps = makeDeps({
      agents: { "agent-1": { name: "Agent 1", provider: "ollama", memoryReview: { enabled: true } } },
      apiKey: "test-key",
    });
    registerCronEventListeners(deps);

    const onComplete = vi.fn();
    await deps.__eventBus.fire("scheduler:job_result", {
      result: "__MEMORY_REVIEW__",
      agentId: "agent-1",
      onComplete,
    });

    expect(mockRunMemoryReview).toHaveBeenCalledOnce();
    const arg = mockRunMemoryReview.mock.calls[0][0] as Record<string, unknown>;
    expect(arg.capabilityClass).toBe("small");
    expect(arg.hasCapableModelOverride).toBe(false);
  });

  it("CR-01: __MEMORY_REVIEW__ threads hasCapableModelOverride=true when the cron provider pins a capable class", async () => {
    mockResolveOperationModel.mockReturnValue({
      provider: "ollama", modelId: "ollama:qwen3.6:35b", model: "ollama:qwen3.6:35b",
      timeoutMs: 60_000, source: "default",
    } as any);
    const deps = makeDeps({
      agents: { "agent-1": { name: "Agent 1", provider: "ollama", memoryReview: { enabled: true } } },
      apiKey: "test-key",
    });
    (deps.container as any).config.providers.entries.ollama = { capabilities: { capabilityClass: "frontier" } };
    registerCronEventListeners(deps);

    const onComplete = vi.fn();
    await deps.__eventBus.fire("scheduler:job_result", {
      result: "__MEMORY_REVIEW__",
      agentId: "agent-1",
      onComplete,
    });

    const arg = mockRunMemoryReview.mock.calls[0][0] as Record<string, unknown>;
    expect(arg.capabilityClass).toBe("frontier");
    expect(arg.hasCapableModelOverride).toBe(true);
  });

  it("reports an error onComplete when runMemoryConsolidation returns err", async () => {
    mockRunMemoryConsolidation.mockResolvedValueOnce({ ok: false as const, error: new Error("boom") });
    const deps = makeDeps({
      agents: { "agent-1": { name: "Agent 1", provider: "anthropic", memoryConsolidation: { enabled: true } } },
      apiKey: "test-key",
    });
    registerCronEventListeners(deps);

    const onComplete = vi.fn();
    await deps.__eventBus.fire("scheduler:job_result", {
      result: "__MEMORY_CONSOLIDATION__",
      agentId: "agent-1",
      onComplete,
    });

    expect(mockRunMemoryConsolidation).toHaveBeenCalledOnce();
    expect(onComplete).toHaveBeenCalledWith({ status: "error", error: "boom" });
  });

  it("skips with an error when an enabled agent has no API key (no key value logged)", async () => {
    const deps = makeDeps({
      agents: { "agent-1": { name: "Agent 1", provider: "anthropic", memoryConsolidation: { enabled: true } } },
      apiKey: undefined, // secretManager.get returns undefined
    });
    registerCronEventListeners(deps);

    const onComplete = vi.fn();
    await deps.__eventBus.fire("scheduler:job_result", {
      result: "__MEMORY_CONSOLIDATION__",
      agentId: "agent-1",
      onComplete,
    });

    // No LLM work without a key; the WARN carries the env-var NAME, never the value.
    expect(mockRunMemoryConsolidation).not.toHaveBeenCalled();
    expect(onComplete).toHaveBeenCalledWith({ status: "error", error: "No API key for anthropic" });
  });

  it("warns + errors when the consolidation sentinel fires without an agentId", async () => {
    const deps = makeDeps();
    registerCronEventListeners(deps);

    const onComplete = vi.fn();
    await deps.__eventBus.fire("scheduler:job_result", {
      result: "__MEMORY_CONSOLIDATION__",
      agentId: undefined,
      onComplete,
    });

    expect(mockRunMemoryConsolidation).not.toHaveBeenCalled();
    expect(onComplete).toHaveBeenCalledWith({ status: "error", error: "No agentId for memory consolidation" });
  });

  // -------------------------------------------------------------------------
  // __MEMORY_REASONING__ sentinel.
  // Mirrors the consolidation block: the opt-in cost gate (a disabled/default
  // agent does NO LLM work) + the enabled path (runMemoryReasoning runs with
  // BOTH the consolidation store AND the triple store injected + the built
  // reason() seam). The triple-store thread is the deductive write path — a
  // missing thread would make the deductive path a silent no-op.
  // -------------------------------------------------------------------------

  it("short-circuits ok and does NOT run reasoning when the agent has it disabled (opt-in gate)", async () => {
    const consolidationStore = makeConsolidationStore();
    const tripleStore = makeTripleStore();
    const deps = makeDeps({
      // memoryReasoning undefined => default OFF.
      agents: { "agent-1": { name: "Agent 1" } },
      consolidationStore,
      tripleStore,
    });
    registerCronEventListeners(deps);

    const onComplete = vi.fn();
    await deps.__eventBus.fire("scheduler:job_result", {
      result: "__MEMORY_REASONING__",
      agentId: "agent-1",
      onComplete,
    });

    // The opt-in cost gate: no LLM work, no store reads, clean ok.
    expect(mockRunMemoryReasoning).not.toHaveBeenCalled();
    expect(mockCreateReasoningSeam).not.toHaveBeenCalled();
    expect(consolidationStore.listConsolidationCandidates).not.toHaveBeenCalled();
    expect(onComplete).toHaveBeenCalledWith({ status: "ok" });
  });

  it("short-circuits ok for an explicitly disabled (enabled:false) reasoning agent", async () => {
    const deps = makeDeps({
      agents: { "agent-1": { name: "Agent 1", memoryReasoning: { enabled: false } } },
    });
    registerCronEventListeners(deps);

    const onComplete = vi.fn();
    await deps.__eventBus.fire("scheduler:job_result", {
      result: "__MEMORY_REASONING__",
      agentId: "agent-1",
      onComplete,
    });

    expect(mockRunMemoryReasoning).not.toHaveBeenCalled();
    expect(onComplete).toHaveBeenCalledWith({ status: "ok" });
  });

  it("runs runMemoryReasoning with BOTH stores + the built reason seam when the agent has it enabled", async () => {
    const consolidationStore = makeConsolidationStore();
    const tripleStore = makeTripleStore();
    const deps = makeDeps({
      agents: { "agent-1": { name: "Agent 1", provider: "anthropic", memoryReasoning: { enabled: true, maxObservationsPerRun: 25 } } },
      apiKey: "test-key",
      consolidationStore,
      tripleStore,
    });
    registerCronEventListeners(deps);

    const onComplete = vi.fn();
    await deps.__eventBus.fire("scheduler:job_result", {
      result: "__MEMORY_REASONING__",
      agentId: "agent-1",
      onComplete,
    });

    expect(mockRunMemoryReasoning).toHaveBeenCalledOnce();
    const arg = mockRunMemoryReasoning.mock.calls[0][0] as Record<string, unknown>;
    expect(arg.agentId).toBe("agent-1");
    expect(arg.tenantId).toBe("tenant-a");
    // BOTH stores injected (the field-plumbing chain is complete) — the deductive
    // write path (tripleStore) AND the inductive write path (consolidationStore).
    expect(arg.consolidationStore).toBe(consolidationStore);
    expect(arg.tripleStore).toBe(tripleStore);
    expect(arg.clock).toBe(deps.clock);
    // The injected reason seam was built from the resolved cheap model + key, and
    // is the exact fn passed as deps.reason.
    expect(mockCreateReasoningSeam).toHaveBeenCalledOnce();
    const seamArg = mockCreateReasoningSeam.mock.calls[0][0] as Record<string, unknown>;
    expect(seamArg.apiKey).toBe("test-key");
    expect(seamArg.provider).toBe("anthropic");
    expect(arg.reason).toBe(mockReasonSeam);
    expect(arg.config).toEqual({ enabled: true, maxObservationsPerRun: 25 });
    expect(onComplete).toHaveBeenCalledWith({ status: "ok", error: undefined });
  });

  it("reports an error onComplete when runMemoryReasoning returns err", async () => {
    mockRunMemoryReasoning.mockResolvedValueOnce({ ok: false as const, error: new Error("boom") });
    const deps = makeDeps({
      agents: { "agent-1": { name: "Agent 1", provider: "anthropic", memoryReasoning: { enabled: true } } },
      apiKey: "test-key",
    });
    registerCronEventListeners(deps);

    const onComplete = vi.fn();
    await deps.__eventBus.fire("scheduler:job_result", {
      result: "__MEMORY_REASONING__",
      agentId: "agent-1",
      onComplete,
    });

    expect(mockRunMemoryReasoning).toHaveBeenCalledOnce();
    expect(onComplete).toHaveBeenCalledWith({ status: "error", error: "boom" });
  });

  it("skips reasoning with an error when an enabled agent has no API key (no key value logged)", async () => {
    const deps = makeDeps({
      agents: { "agent-1": { name: "Agent 1", provider: "anthropic", memoryReasoning: { enabled: true } } },
      apiKey: undefined, // secretManager.get returns undefined
    });
    registerCronEventListeners(deps);

    const onComplete = vi.fn();
    await deps.__eventBus.fire("scheduler:job_result", {
      result: "__MEMORY_REASONING__",
      agentId: "agent-1",
      onComplete,
    });

    // No LLM work without a key; the seam is never built, the job never runs.
    expect(mockCreateReasoningSeam).not.toHaveBeenCalled();
    expect(mockRunMemoryReasoning).not.toHaveBeenCalled();
    expect(onComplete).toHaveBeenCalledWith({ status: "error", error: "No API key for anthropic" });
  });

  it("warns + errors when the reasoning sentinel fires without an agentId", async () => {
    const deps = makeDeps();
    registerCronEventListeners(deps);

    const onComplete = vi.fn();
    await deps.__eventBus.fire("scheduler:job_result", {
      result: "__MEMORY_REASONING__",
      agentId: undefined,
      onComplete,
    });

    expect(mockRunMemoryReasoning).not.toHaveBeenCalled();
    expect(onComplete).toHaveBeenCalledWith({ status: "error", error: "No agentId for memory reasoning" });
  });
});
