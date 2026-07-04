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

// runMemoryConsolidation returns counts-only stats (generalized/clustersConsidered/durationMs).
// (The learning:memory_generalized telemetry event was removed; the
// consolidation cron no longer emits a learning event — the stats stay for the INFO completion line.)
const mockRunMemoryConsolidation = vi.hoisted(() => vi.fn(async () => ({ ok: true as const, value: { generalized: 0, clustersConsidered: 0, durationMs: 0 } })));
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

// Faithful capability-axis stub for resolveModelProfile: explicit
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

/** A stub consolidation store — the trimmed live surface (the dead
 *  consolidation-cron writer methods were cut). Its methods are not reached on the
 *  short-circuit path. */
function makeConsolidationStore() {
  return {
    listObservations: vi.fn(async () => ({ ok: true as const, value: [] })),
    unlinkDeletedSources: vi.fn(async () => ({ ok: true as const, value: 0 })),
    purgeConsolidatedDerivedFrom: vi.fn(async () => ({ ok: true as const, value: 0 })),
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
    mockRunMemoryConsolidation.mockResolvedValue({ ok: true as const, value: { generalized: 0, clustersConsidered: 0, durationMs: 0 } });
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
  // The __MEMORY_CONSOLIDATION__ / __MEMORY_REASONING__ /
  // __USER_REPRESENTATION__ sentinel intercepts were REMOVED end-to-end — their work
  // folds into the ONE __REFLECT__ cron. Fired through registerCronEventListeners
  // (with the per-agent features ENABLED), the consolidation/reasoning jobs are NEVER
  // invoked — the sentinel is no longer routed (the registrations are gone too, so it can
  // no longer fire in production; this proves a stray one is inert).
  // -------------------------------------------------------------------------

  it.each(["__MEMORY_CONSOLIDATION__", "__MEMORY_REASONING__", "__USER_REPRESENTATION__"])(
    "the removed %s sentinel runs no job end-to-end (folded into __REFLECT__)",
    async (sentinel) => {
      const deps = makeDeps({
        agents: { "agent-1": { name: "Agent 1", provider: "anthropic", memoryConsolidation: { enabled: true }, memoryReasoning: { enabled: true }, memoryUserRepresentation: { enabled: true } } },
        apiKey: "test-key",
      });
      registerCronEventListeners(deps);

      const onComplete = vi.fn();
      await deps.__eventBus.fire("scheduler:job_result", { result: sentinel, agentId: "agent-1", onComplete });

      // The folded jobs are never invoked (the intercept branches are gone).
      expect(mockRunMemoryConsolidation).not.toHaveBeenCalled();
      expect(mockRunMemoryReasoning).not.toHaveBeenCalled();
    },
  );

  // -------------------------------------------------------------------------
  // The __MEMORY_REVIEW__ branch threads capabilityClass +
  // hasCapableModelOverride into runMemoryReview's deps so the abstain path is
  // reachable in production for a small/nano cron model. Without these fields the
  // deps default to "frontier" → "capable", so a weak model would still run
  // the extraction LLM call.
  // -------------------------------------------------------------------------
  it("__MEMORY_REVIEW__ threads capabilityClass='small' + no override for a small cron model (abstain reachable)", async () => {
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

  it("__MEMORY_REVIEW__ threads hasCapableModelOverride=true when the cron provider pins a capable class", async () => {
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

  // -------------------------------------------------------------------------
  // Control-token safety. An untrusted, model-authored deliver string equal to a
  // memory-cron sentinel must NOT be interpreted as a control token. Sentinel
  // interpretation is scoped to INTERNAL, deliveryTarget-less emits; a user-facing
  // delivery (a normal cron result OR a wake-gate deliver-on-skip) ALWAYS carries a
  // deliveryTarget, so a deliver of "__MEMORY_REVIEW__" is shipped VERBATIM and the
  // review LLM turn never fires.
  // -------------------------------------------------------------------------

  it("delivers a deliver equal to __MEMORY_REVIEW__ VERBATIM when it carries a deliveryTarget (never runs review)", async () => {
    const deliverToChannel = vi.fn(async () => ({
      ok: true as const,
      value: { ok: true, totalChunks: 1, deliveredChunks: 1, failedChunks: 0, chunks: [], totalChars: 16 },
    }));
    const deps = makeDeps({
      agents: { "agent-1": { name: "Agent 1", provider: "anthropic", memoryReview: { enabled: true } } },
      apiKey: "test-key",
    });
    (deps as any).adaptersByType = new Map([["telegram", { channelType: "telegram" }]]);
    (deps as any).deliveryService = { deliverToChannel };
    registerCronEventListeners(deps);

    await deps.__eventBus.fire("scheduler:job_result", {
      result: "__MEMORY_REVIEW__",
      agentId: "agent-1",
      jobName: "backup-monitor",
      payloadKind: "system_event",
      deliveryTarget: { channelType: "telegram", channelId: "chat-1" },
    });

    // The control token is shipped verbatim — the review LLM turn never fires.
    expect(mockRunMemoryReview).not.toHaveBeenCalled();
    expect(deliverToChannel).toHaveBeenCalledWith(
      { channelType: "telegram" },
      "chat-1",
      "__MEMORY_REVIEW__",
      undefined,
    );
  });

  it("still runs memory review for a target-LESS __MEMORY_REVIEW__ sentinel (internal cron path unchanged)", async () => {
    const deps = makeDeps({
      agents: { "agent-1": { name: "Agent 1", provider: "anthropic", memoryReview: { enabled: true } } },
      apiKey: "test-key",
    });
    registerCronEventListeners(deps);

    await deps.__eventBus.fire("scheduler:job_result", {
      result: "__MEMORY_REVIEW__",
      agentId: "agent-1",
      // no deliveryTarget — the internal, target-less memory-review cron shape
    });

    expect(mockRunMemoryReview).toHaveBeenCalledOnce();
  });

  // -------------------------------------------------------------------------
  // The cron agent_turn producer THREADS the resolver's
  // timeoutSource into cronOverrides.promptTimeout.source. A producer that
  // passed `promptTimeout: { promptTimeoutMs }` UNCONDITIONALLY would
  // collapse "the 150s cron default applied" into what decode treats as an
  // explicit operator override.
  // -------------------------------------------------------------------------
  it("cron agent_turn threads resolution.timeoutSource into cronOverrides.promptTimeout.source (provenance not collapsed)", async () => {
    // The resolver labeled this timeout "operation_default" (the 150s cron
    // default applied — the operator set NO operationModels.cron.timeout).
    mockResolveOperationModel.mockReturnValue({
      provider: "anthropic",
      modelId: "claude-haiku",
      model: "anthropic:claude-haiku",
      timeoutMs: 150_000,
      source: "family_default",
      timeoutSource: "operation_default",
    } as any);

    const capturedOverrides: any[] = [];
    const executor = {
      execute: vi.fn(async (...args: any[]) => {
        capturedOverrides.push(args[7]);
        return {
          response: "cron done",
          sessionKey: {},
          tokensUsed: { input: 0, output: 0, total: 10 },
          cost: { total: 0.001 },
          stepsExecuted: 1,
          llmCalls: 1,
          finishReason: "stop",
        };
      }),
    };

    const deps = makeDeps({
      agents: { "agent-1": { name: "Agent 1", provider: "anthropic", model: "claude-sonnet-4-5", operationModels: {} } },
    });
    (deps as any).executors = new Map([["agent-1", executor]]);
    (deps as any).adaptersByType = new Map([["telegram", { channelType: "telegram" }]]);
    (deps as any).sessionManager = { expire: vi.fn(), loadOrCreate: vi.fn(() => []), save: vi.fn() };
    (deps as any).deliveryService = {
      deliverToChannel: vi.fn(async () => ({
        ok: true as const,
        value: { ok: true, totalChunks: 1, deliveredChunks: 1, failedChunks: 0, chunks: [], totalChars: 9 },
      })),
    };
    registerCronEventListeners(deps);

    const onComplete = vi.fn();
    await deps.__eventBus.fire("scheduler:job_result", {
      result: "ping the user",
      payloadKind: "agent_turn",
      agentId: "agent-1",
      jobId: "job-1",
      jobName: "morning-ping",
      deliveryTarget: { channelType: "telegram", channelId: "chat-1", userId: "user_a", tenantId: "tenant-a" },
      onComplete,
    });

    expect(executor.execute).toHaveBeenCalledOnce();
    // The full promptTimeout shape pins BOTH the value and the carried
    // provenance — the bare { promptTimeoutMs } shape is the collapse bug.
    expect(capturedOverrides[0].promptTimeout).toEqual({
      promptTimeoutMs: 150_000,
      source: "operation_default",
    });
    expect(onComplete).toHaveBeenCalledWith({ status: "ok" });
  });
});
