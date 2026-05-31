// SPDX-License-Identifier: Apache-2.0
/**
 * Compile-time regression pin + behavioral tests for the credentials leaf of
 * the setup-channels module. Hosts `registerCronEventListeners` (cron-driven
 * API-key + model resolution + event dispatch).
 *
 * The witness pins the closure-captured deps key set. The behavioral tests
 * exercise the `__MEMORY_CONSOLIDATION__` sentinel intercept (Phase 84,
 * CONS-07): the opt-in cost gate (a disabled/default agent does NO LLM work)
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
const mockResolveOperationModel = vi.hoisted(() => vi.fn(() => ({
  provider: "anthropic",
  modelId: "anthropic:claude-haiku",
  model: "anthropic:claude-haiku",
  timeoutMs: 60_000,
  source: "default",
})));

vi.mock("@comis/agent", () => ({
  sanitizeAssistantResponse: vi.fn((s: string) => s),
  resolveOperationModel: mockResolveOperationModel,
  resolveProviderFamily: vi.fn(() => "anthropic"),
  runMemoryReview: mockRunMemoryReview,
  runMemoryConsolidation: mockRunMemoryConsolidation,
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

function makeDeps(overrides: {
  agents?: Record<string, any>;
  apiKey?: string | undefined;
  eventBus?: ReturnType<typeof makeEventBus>;
  consolidationStore?: ReturnType<typeof makeConsolidationStore>;
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
    mockResolveOperationModel.mockReturnValue({
      provider: "anthropic", modelId: "anthropic:claude-haiku", model: "anthropic:claude-haiku",
      timeoutMs: 60_000, source: "default",
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
      // for relative-date resolution (EXTR-02) + timestamp reads (CONS-07).
      clock: true,
      adaptersByType: true,
      deliveryService: true,
      assembleToolsForAgent: true,
      transcriber: true,
      workspaceDirs: true,
      memoryAdapter: true,
      entityStore: true,
      // Phase 84 (CONS-07): the consolidation store injected into the
      // __MEMORY_CONSOLIDATION__ sentinel → runMemoryConsolidation.
      consolidationStore: true,
      tenantId: true,
      piSessionAdapters: true,
      cronExecutionTrackers: true,
      activeRunRegistry: true,
    };
    expect(Object.keys(witness).length).toBe(19);
  });

  // -------------------------------------------------------------------------
  // RED A — the opt-in cost gate (CONS-07 / T-84-19)
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

    // No LLM work without a key; the WARN carries the env-var NAME, never the value (T-84-20).
    expect(mockRunMemoryConsolidation).not.toHaveBeenCalled();
    expect(onComplete).toHaveBeenCalledWith({ status: "error", error: "No API key for anthropic" });
  });

  it("warns + errors when the consolidation sentinel fires without an agentId (T-84-22)", async () => {
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
});
