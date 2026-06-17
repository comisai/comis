// SPDX-License-Identifier: Apache-2.0
/**
 * Behavioral tests for the extracted LLM-backed memory-cron sentinel handlers
 * (`__MEMORY_CONSOLIDATION__` + `__MEMORY_REASONING__`).
 *
 * These mirror the assertions in setup-channels-credentials.test.ts (which drives
 * the handlers through registerCronEventListeners end-to-end); here they exercise
 * the extracted `handleMemoryCronSentinel` directly so the helper carries its own
 * neighbor test (the coverage-gate file-neighbor invariant) and per-package floor.
 *
 * The reasoning sentinel's distinguishing assertion: it injects BOTH the
 * consolidation store AND the triple store (the deductive write path, the
 * field-plumbing chain) + the built reason() seam. runMemoryReasoning /
 * createReasoningSeam are mocked — no real LLM, no key.
 *
 * @module
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockRunMemoryConsolidation = vi.hoisted(() => vi.fn(async () => ({ ok: true as const, value: undefined })));
const mockReasonSeam = vi.hoisted(() => vi.fn(async () => ({ deductive: [], inductive: [] })));
const mockCreateReasoningSeam = vi.hoisted(() => vi.fn(() => mockReasonSeam));
const mockRunMemoryReasoning = vi.hoisted(() => vi.fn(async () => ({ ok: true as const, value: undefined })));
const mockRunUserRepresentationBuild = vi.hoisted(() => vi.fn(async () => ({ ok: true as const, value: { built: 0, written: 0, blocked: 0 } })));
const mockUserReprSeam = vi.hoisted(() => vi.fn(async () => []));
const mockCreateUserRepresentationSeam = vi.hoisted(() => vi.fn(() => mockUserReprSeam));
const mockRunRelationshipBuild = vi.hoisted(() => vi.fn(async () => ({ ok: true as const, value: { built: 0, written: 0, blocked: 0 } })));
const mockRelationshipSeam = vi.hoisted(() => vi.fn(async () => []));
const mockCreateRelationshipSeam = vi.hoisted(() => vi.fn(() => mockRelationshipSeam));
// WIRE-02: the __USEFULNESS_JUDGE__ seam. `judge({ candidateIds, answer })` returns a
// partition; the handler writes that through usefulnessStore.recordUsage. Default verdict
// is empty (overridden per-test) so the no-op floor is also exercisable.
const mockJudgeSeam = vi.hoisted(() => vi.fn(async () => ({ usedIds: [] as string[], ignoredIds: [] as string[] })));
const mockCreateUsefulnessJudgeSeam = vi.hoisted(() => vi.fn(() => mockJudgeSeam));
const mockRunMemoryTripleExtraction = vi.hoisted(() => vi.fn(async () => ({ ok: true as const, value: { extracted: 0, written: 0, blocked: 0, downgraded: 0, skippedOverCap: 0 } })));
// RANK-02/03: the per-intent bandit job. Mocked so the cron's per-intent iteration +
// learner/gate threading is asserted via the captured deps (not the math).
const mockRunOnlineTuning = vi.hoisted(() => vi.fn(async () => ({ ok: true as const, value: { updated: false, clampHits: 0, signalCount: 0 } })));
const mockResolveOperationModel = vi.hoisted(() => vi.fn(() => ({
  provider: "anthropic",
  modelId: "anthropic:claude-haiku",
  model: "anthropic:claude-haiku",
  timeoutMs: 60_000,
  source: "default",
})));

// A faithful stub of resolveModelProfile's CAPABILITY axis (the only axis
// resolveMemoryOpsCapability reads): explicit override wins; else provider-family
// heuristic (anthropic/openai → frontier, google → mid, else → small). The real
// fn lives in @comis/agent which this file mocks wholesale, so the helper under
// test (resolveMemoryOpsCapability) gets this stub.
const mockResolveModelProfile = vi.hoisted(() => vi.fn((model: { provider: string }, override?: string) => {
  let capabilityClass = override;
  if (capabilityClass === undefined) {
    const p = model.provider;
    capabilityClass = p === "anthropic" || p === "openai" ? "frontier" : p === "google" ? "mid" : "small";
  }
  return { capabilityClass };
}));

vi.mock("@comis/agent", () => ({
  resolveOperationModel: mockResolveOperationModel,
  resolveProviderFamily: vi.fn(() => "anthropic"),
  resolveModelProfile: mockResolveModelProfile,
  runMemoryConsolidation: mockRunMemoryConsolidation,
  runMemoryReasoning: mockRunMemoryReasoning,
  createReasoningSeam: mockCreateReasoningSeam,
  runUserRepresentationBuild: mockRunUserRepresentationBuild,
  createUserRepresentationSeam: mockCreateUserRepresentationSeam,
  runRelationshipBuild: mockRunRelationshipBuild,
  createRelationshipSeam: mockCreateRelationshipSeam,
  createUsefulnessJudgeSeam: mockCreateUsefulnessJudgeSeam,
  runMemoryTripleExtraction: mockRunMemoryTripleExtraction,
  runOnlineTuning: mockRunOnlineTuning,
}));

import { handleMemoryCronSentinel, type MemoryCronContext } from "./setup-channels-memory-crons.js";

function makeCtx(overrides: {
  agents?: Record<string, any>;
  apiKey?: string | undefined;
  /** Rows the injected memoryApi.inspect returns (the __SOCIAL_MODELING__ source set). */
  inspectRows?: Array<{ id: string; userId: string; content: string; trustLevel: string; source?: { sessionKey?: string | null } }>;
  /** The injected DORMANT lifecycle store (the __MEMORY_LIFECYCLE__ sentinel). When absent
   *  a default spy returning the all-0 dormant report is used so the on-path can assert it. */
  memoryLifecycleStore?: { runLifecycleSweep: ReturnType<typeof vi.fn> };
  /** The usefulness store the __USEFULNESS_JUDGE__ sentinel WRITES through (recordUsage).
   *  When absent a default spy returning ok is used so the write can be asserted (WIRE-02). */
  usefulnessStore?: { recordUsage: ReturnType<typeof vi.fn>; readUsefulness: ReturnType<typeof vi.fn> };
} = {}): MemoryCronContext {
  const logger = {
    info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(),
    child: vi.fn(() => logger),
  };
  const container = {
    config: { tenantId: "tenant-a", agents: overrides.agents ?? {}, providers: { entries: {} } },
    eventBus: { emit: vi.fn(), on: vi.fn() },
    secretManager: { get: vi.fn(() => (overrides.apiKey === undefined ? undefined : overrides.apiKey)) },
  };
  // inspect is called once per trust level (system, learned); return the fixture rows for the
  // FIRST trust level only so a row is not double-counted across levels (mirror how the real
  // memories carry one trustLevel per row).
  let inspectCall = 0;
  const memoryApi = {
    inspect: vi.fn(() => {
      inspectCall++;
      return inspectCall === 1 ? (overrides.inspectRows ?? []) : [];
    }),
  };
  return {
    container: container as any,
    logger: logger as any,
    clock: { now: () => 1_000, nowDate: () => new Date(1_000) } as any,
    agents: overrides.agents ?? {},
    tenantId: "tenant-a",
    consolidationStore: { listConsolidationCandidates: vi.fn() } as any,
    tripleStore: { upsertTriple: vi.fn(), currentTruth: vi.fn() } as any,
    relationshipStore: { upsert: vi.fn(), read: vi.fn() } as any,
    // The tuned-alpha write store the __ONLINE_TUNING__ bandit upserts through (port TYPE only).
    tunedAlphaStore: { upsert: vi.fn(async () => ({ ok: true as const, value: undefined })), read: vi.fn(async () => ({ ok: true as const, value: undefined })) } as any,
    memoryApi: memoryApi as any,
    memoryLifecycleStore: (overrides.memoryLifecycleStore ?? {
      // The DORMANT default: scanned some rows, mutated NONE (the scaffold).
      runLifecycleSweep: vi.fn(async () => ({ ok: true as const, value: { scanned: 3, promoted: 0, demoted: 0, evicted: 0 } })),
    }) as any,
    usefulnessStore: (overrides.usefulnessStore ?? {
      // The WRITE surface the usefulness judge drives (WIRE-02) + the READ surface __ONLINE_TUNING__ uses.
      recordUsage: vi.fn(async () => ({ ok: true as const, value: undefined })),
      readUsefulness: vi.fn(async () => ({ ok: true as const, value: new Map() })),
    }) as any,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // Restore default model-resolution behavior cleared by clearAllMocks.
  mockResolveOperationModel.mockReturnValue({
    provider: "anthropic",
    modelId: "anthropic:claude-haiku",
    model: "anthropic:claude-haiku",
    timeoutMs: 60_000,
    source: "default",
  } as any);
  mockResolveModelProfile.mockImplementation((model: { provider: string }, override?: string) => {
    let capabilityClass = override;
    if (capabilityClass === undefined) {
      const p = model.provider;
      capabilityClass = p === "anthropic" || p === "openai" ? "frontier" : p === "google" ? "mid" : "small";
    }
    return { capabilityClass } as any;
  });
  mockRunMemoryConsolidation.mockResolvedValue({ ok: true as const, value: undefined });
  mockRunMemoryReasoning.mockResolvedValue({ ok: true as const, value: undefined });
  mockCreateReasoningSeam.mockReturnValue(mockReasonSeam);
  mockRunUserRepresentationBuild.mockResolvedValue({ ok: true as const, value: { built: 0, written: 0, blocked: 0 } });
  mockCreateUserRepresentationSeam.mockReturnValue(mockUserReprSeam);
  mockRunRelationshipBuild.mockResolvedValue({ ok: true as const, value: { built: 0, written: 0, blocked: 0 } });
  mockCreateRelationshipSeam.mockReturnValue(mockRelationshipSeam);
  mockCreateUsefulnessJudgeSeam.mockReturnValue(mockJudgeSeam);
  mockJudgeSeam.mockResolvedValue({ usedIds: [], ignoredIds: [] });
  mockRunMemoryTripleExtraction.mockResolvedValue({ ok: true as const, value: { extracted: 0, written: 0, blocked: 0, downgraded: 0, skippedOverCap: 0 } });
  mockRunOnlineTuning.mockResolvedValue({ ok: true as const, value: { updated: false, clampHits: 0, signalCount: 0 } });
});

describe("handleMemoryCronSentinel", () => {
  it("returns false for a non-memory-cron sentinel (falls through to the delivery path)", async () => {
    const ctx = makeCtx();
    const onComplete = vi.fn();
    const handled = await handleMemoryCronSentinel("__SOMETHING_ELSE__", { result: "__SOMETHING_ELSE__", agentId: "a", onComplete }, ctx);
    expect(handled).toBe(false);
    expect(onComplete).not.toHaveBeenCalled();
  });

  it("short-circuits reasoning ok and runs nothing when the agent has it disabled (opt-in gate)", async () => {
    const ctx = makeCtx({ agents: { "agent-1": { name: "Agent 1" } } });
    const onComplete = vi.fn();
    const handled = await handleMemoryCronSentinel("__MEMORY_REASONING__", { agentId: "agent-1", onComplete }, ctx);
    expect(handled).toBe(true);
    expect(mockRunMemoryReasoning).not.toHaveBeenCalled();
    expect(mockCreateReasoningSeam).not.toHaveBeenCalled();
    expect(onComplete).toHaveBeenCalledWith({ status: "ok" });
  });

  it("runs runMemoryReasoning with BOTH stores + the built seam when reasoning is enabled", async () => {
    const ctx = makeCtx({
      agents: { "agent-1": { name: "Agent 1", provider: "anthropic", memoryReasoning: { enabled: true } } },
      apiKey: "test-key",
    });
    const onComplete = vi.fn();
    const handled = await handleMemoryCronSentinel("__MEMORY_REASONING__", { agentId: "agent-1", onComplete }, ctx);
    expect(handled).toBe(true);
    expect(mockRunMemoryReasoning).toHaveBeenCalledOnce();
    const arg = mockRunMemoryReasoning.mock.calls[0][0] as Record<string, unknown>;
    expect(arg.consolidationStore).toBe(ctx.consolidationStore);
    expect(arg.tripleStore).toBe(ctx.tripleStore);
    expect(arg.reason).toBe(mockReasonSeam);
    expect(mockCreateReasoningSeam).toHaveBeenCalledOnce();
    expect(onComplete).toHaveBeenCalledWith({ status: "ok", error: undefined });
  });

  it("skips reasoning with an error when an enabled agent has no API key (no key value used)", async () => {
    const ctx = makeCtx({
      agents: { "agent-1": { name: "Agent 1", provider: "anthropic", memoryReasoning: { enabled: true } } },
      apiKey: undefined,
    });
    const onComplete = vi.fn();
    await handleMemoryCronSentinel("__MEMORY_REASONING__", { agentId: "agent-1", onComplete }, ctx);
    expect(mockCreateReasoningSeam).not.toHaveBeenCalled();
    expect(mockRunMemoryReasoning).not.toHaveBeenCalled();
    expect(onComplete).toHaveBeenCalledWith({ status: "error", error: "No API key for anthropic" });
  });

  it("still handles the consolidation sentinel (the extraction preserved both branches)", async () => {
    const ctx = makeCtx({
      agents: { "agent-1": { name: "Agent 1", provider: "anthropic", memoryConsolidation: { enabled: true } } },
      apiKey: "test-key",
    });
    const onComplete = vi.fn();
    const handled = await handleMemoryCronSentinel("__MEMORY_CONSOLIDATION__", { agentId: "agent-1", onComplete }, ctx);
    expect(handled).toBe(true);
    expect(mockRunMemoryConsolidation).toHaveBeenCalledOnce();
    const arg = mockRunMemoryConsolidation.mock.calls[0][0] as Record<string, unknown>;
    expect(arg.consolidationStore).toBe(ctx.consolidationStore);
    expect(onComplete).toHaveBeenCalledWith({ status: "ok", error: undefined });
  });

  // -------------------------------------------------------------------------
  // CR-01: R6 capabilityClass / hasCapableModelOverride are THREADED into the
  // consolidation deps so the abstain path is reachable in production. Before
  // the fix neither field was passed and every consumer hit its default
  // ("frontier"/false) → "capable", so a small/nano model still ran the merge
  // LLM call. These pin the deps the daemon actually constructs.
  // -------------------------------------------------------------------------
  it("CR-01: a SMALL cron/memory model threads capabilityClass='small' + no override into the consolidation deps (abstain reachable)", async () => {
    // The cron model resolves to a local/ollama provider → small.
    mockResolveOperationModel.mockReturnValue({
      provider: "ollama",
      modelId: "ollama:qwen3.6:35b",
      model: "ollama:qwen3.6:35b",
      timeoutMs: 60_000,
      source: "default",
    } as any);
    const ctx = makeCtx({
      agents: { "agent-1": { name: "Agent 1", provider: "ollama", memoryConsolidation: { enabled: true } } },
      apiKey: "test-key",
    });
    const onComplete = vi.fn();
    await handleMemoryCronSentinel("__MEMORY_CONSOLIDATION__", { agentId: "agent-1", onComplete }, ctx);
    expect(mockRunMemoryConsolidation).toHaveBeenCalledOnce();
    const arg = mockRunMemoryConsolidation.mock.calls[0][0] as Record<string, unknown>;
    expect(arg.capabilityClass).toBe("small");
    expect(arg.hasCapableModelOverride).toBe(false);
  });

  it("CR-01: a FRONTIER cron/memory model threads capabilityClass='frontier' (behavior-neutral)", async () => {
    const ctx = makeCtx({
      agents: { "agent-1": { name: "Agent 1", provider: "anthropic", memoryConsolidation: { enabled: true } } },
      apiKey: "test-key",
    });
    const onComplete = vi.fn();
    await handleMemoryCronSentinel("__MEMORY_CONSOLIDATION__", { agentId: "agent-1", onComplete }, ctx);
    const arg = mockRunMemoryConsolidation.mock.calls[0][0] as Record<string, unknown>;
    expect(arg.capabilityClass).toBe("frontier");
    expect(arg.hasCapableModelOverride).toBe(false);
  });

  it("CR-01: an operator capabilityClass override on the cron provider threads hasCapableModelOverride=true", async () => {
    mockResolveOperationModel.mockReturnValue({
      provider: "ollama",
      modelId: "ollama:qwen3.6:35b",
      model: "ollama:qwen3.6:35b",
      timeoutMs: 60_000,
      source: "default",
    } as any);
    const ctx = makeCtx({
      agents: { "agent-1": { name: "Agent 1", provider: "ollama", memoryConsolidation: { enabled: true } } },
      apiKey: "test-key",
    });
    // Pin a capable class on the cron provider's capabilities (the operator
    // "stronger cheap model for the memory pipeline" override).
    (ctx.container as any).config.providers.entries.ollama = { capabilities: { capabilityClass: "mid" } };
    const onComplete = vi.fn();
    await handleMemoryCronSentinel("__MEMORY_CONSOLIDATION__", { agentId: "agent-1", onComplete }, ctx);
    const arg = mockRunMemoryConsolidation.mock.calls[0][0] as Record<string, unknown>;
    expect(arg.capabilityClass).toBe("mid");
    expect(arg.hasCapableModelOverride).toBe(true);
  });

  it("warns + errors when a memory-cron sentinel fires without an agentId", async () => {
    const ctx = makeCtx();
    const onComplete = vi.fn();
    await handleMemoryCronSentinel("__MEMORY_REASONING__", { agentId: undefined, onComplete }, ctx);
    expect(mockRunMemoryReasoning).not.toHaveBeenCalled();
    expect(onComplete).toHaveBeenCalledWith({ status: "error", error: "No agentId for memory reasoning" });
  });

  // -------------------------------------------------------------------------
  // KEYLESS-CRON (live-found 2026-06-13, qwen3.6:35b run): the main completion
  // path resolves keyless local providers (ollama / lm-studio) via
  // KEYLESS_PROVIDER_TYPES, but the cost-cron gate blindly required an API key
  // and SILENTLY SKIPPED — disabling the entire LTM-learning layer
  // (consolidation/reasoning/user-representation/review) on local-model
  // deployments, with a MISLEADING "Set OLLAMA_API_KEY" hint (Ollama is keyless).
  // The fix mirrors credential-resolver.ts: keyless providers proceed with the
  // KEYLESS_API_KEY_SENTINEL instead of being skipped.
  // -------------------------------------------------------------------------
  it("KEYLESS: an ollama agent with NO API key STILL runs consolidation (keyless sentinel, not skipped)", async () => {
    mockResolveOperationModel.mockReturnValue({
      provider: "ollama",
      modelId: "ollama:qwen3.6:35b",
      model: "ollama:qwen3.6:35b",
      timeoutMs: 60_000,
      source: "default",
    } as any);
    const ctx = makeCtx({
      agents: { "agent-1": { name: "Agent 1", provider: "ollama", memoryConsolidation: { enabled: true } } },
      apiKey: undefined, // NO key in the secret store — keyless local provider
    });
    const onComplete = vi.fn();
    await handleMemoryCronSentinel("__MEMORY_CONSOLIDATION__", { agentId: "agent-1", onComplete }, ctx);
    expect(mockRunMemoryConsolidation).toHaveBeenCalledOnce();
    const arg = mockRunMemoryConsolidation.mock.calls[0][0] as Record<string, unknown>;
    expect(arg.apiKey).toBe("ollama-no-auth");
    expect(onComplete).toHaveBeenCalledWith({ status: "ok", error: undefined });
  });

  it("KEYLESS: an ollama agent with NO API key STILL runs the user-representation build", async () => {
    mockResolveOperationModel.mockReturnValue({
      provider: "ollama", modelId: "ollama:qwen3.6:35b", model: "ollama:qwen3.6:35b", timeoutMs: 60_000, source: "default",
    } as any);
    const ctx = makeCtx({
      agents: { "agent-1": { name: "Agent 1", provider: "ollama", memoryUserRepresentation: { enabled: true } } },
      apiKey: undefined,
      inspectRows: [{ id: "m1", userId: "u1", content: "fact", trustLevel: "learned", source: { sessionKey: "s1" } }],
    });
    // The user-rep handler requires the write surface (injected from setup-memory).
    (ctx as any).userRepresentationStore = { upsert: vi.fn(), read: vi.fn() };
    const onComplete = vi.fn();
    await handleMemoryCronSentinel("__USER_REPRESENTATION__", { agentId: "agent-1", onComplete }, ctx);
    expect(mockRunUserRepresentationBuild).toHaveBeenCalled();
  });

  it("KEYLESS-guard: a NON-keyless (anthropic) agent with NO API key STILL skips (real misconfig fails loud)", async () => {
    // The keyless allowance must NOT mask a genuine missing-key misconfiguration.
    const ctx = makeCtx({
      agents: { "agent-1": { name: "Agent 1", provider: "anthropic", memoryConsolidation: { enabled: true } } },
      apiKey: undefined,
    });
    const onComplete = vi.fn();
    await handleMemoryCronSentinel("__MEMORY_CONSOLIDATION__", { agentId: "agent-1", onComplete }, ctx);
    expect(mockRunMemoryConsolidation).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// __ONLINE_TUNING__ sentinel (RANK-02/03, Phase 200 Plan 06): the KEYLESS bandit.
// The cron gate composes `memoryOnlineTuning.enabled` (schedule) AND
// `learningTuning.enabled` (the bandit/per-intent/outcome-reward behavior). When the
// behavior is on it iterates the INTENT buckets (global '' + the 4 deterministic intents),
// running runOnlineTuning per bucket with the config-selected learner + exploration. When
// learningTuning is OFF it falls back to a SINGLE legacy nudge run (byte-identical).
// ---------------------------------------------------------------------------
describe("handleMemoryCronSentinel __ONLINE_TUNING__", () => {
  it("short-circuits ok and runs NOTHING when memoryOnlineTuning is disabled (the cron gate)", async () => {
    const ctx = makeCtx({ agents: { "agent-1": { name: "Agent 1" } } });
    const onComplete = vi.fn();
    const handled = await handleMemoryCronSentinel("__ONLINE_TUNING__", { agentId: "agent-1", onComplete }, ctx);
    expect(handled).toBe(true);
    expect(mockRunOnlineTuning).not.toHaveBeenCalled();
    expect(onComplete).toHaveBeenCalledWith({ status: "ok" });
  });

  it("RANK-02: with memoryOnlineTuning + learningTuning ON, iterates ALL intent buckets (global '' + the 4 intents) — one bandit run per bucket", async () => {
    const ctx = makeCtx({
      agents: {
        "agent-1": {
          name: "Agent 1",
          memoryOnlineTuning: { enabled: true },
          learningTuning: { enabled: true, learner: "bandit", perIntent: true, exploration: 0.1 },
        },
      },
    });
    const onComplete = vi.fn();
    await handleMemoryCronSentinel("__ONLINE_TUNING__", { agentId: "agent-1", onComplete }, ctx);
    // 5 buckets: the global '' + factual + temporal + preference + enumeration.
    expect(mockRunOnlineTuning).toHaveBeenCalledTimes(5);
    const intents = mockRunOnlineTuning.mock.calls.map((c) => (c[0] as any).config.intent);
    expect(new Set(intents)).toEqual(new Set(["", "factual", "temporal", "preference", "enumeration"]));
    expect(onComplete).toHaveBeenCalledWith({ status: "ok", error: undefined });
  });

  it("RANK-03: threads learner:'bandit' + exploration from learningTuning into each bandit run", async () => {
    const ctx = makeCtx({
      agents: {
        "agent-1": {
          name: "Agent 1",
          memoryOnlineTuning: { enabled: true },
          learningTuning: { enabled: true, learner: "bandit", perIntent: true, exploration: 0.25 },
        },
      },
    });
    await handleMemoryCronSentinel("__ONLINE_TUNING__", { agentId: "agent-1", onComplete: vi.fn() }, ctx);
    for (const call of mockRunOnlineTuning.mock.calls) {
      const cfg = (call[0] as any).config;
      expect(cfg.learner).toBe("bandit");
      expect(cfg.exploration).toBe(0.25);
      expect(cfg.enabled).toBe(true);
    }
  });

  it("byte-identity: with learningTuning OFF (default), runs the LEGACY single-bucket nudge (one run, no per-intent, no bandit)", async () => {
    const ctx = makeCtx({
      agents: { "agent-1": { name: "Agent 1", memoryOnlineTuning: { enabled: true } } }, // no learningTuning
    });
    await handleMemoryCronSentinel("__ONLINE_TUNING__", { agentId: "agent-1", onComplete: vi.fn() }, ctx);
    // The legacy path: ONE run, no intent (global ''), no bandit learner.
    expect(mockRunOnlineTuning).toHaveBeenCalledTimes(1);
    const cfg = (mockRunOnlineTuning.mock.calls[0][0] as any).config;
    expect(cfg.intent).toBeUndefined();
    expect(cfg.learner).not.toBe("bandit");
  });

  it("reads the per-intent FEED scoped to (tenant, agent, intent) — the readUsefulness seam carries intent", async () => {
    const readUsefulness = vi.fn(async () => ({ ok: true as const, value: new Map() }));
    const ctx = makeCtx({
      agents: {
        "agent-1": {
          name: "Agent 1",
          memoryOnlineTuning: { enabled: true },
          learningTuning: { enabled: true, learner: "bandit", perIntent: true, exploration: 0.1 },
        },
      },
      usefulnessStore: { recordUsage: vi.fn(async () => ({ ok: true as const, value: undefined })), readUsefulness },
    });
    await handleMemoryCronSentinel("__ONLINE_TUNING__", { agentId: "agent-1", onComplete: vi.fn() }, ctx);
    // Each bucket's readUsefulness seam is invoked by the job (mocked here), so assert the
    // seam exists per call and the per-intent scope is threaded by exercising one seam.
    const temporalCall = mockRunOnlineTuning.mock.calls.find((c) => (c[0] as any).config.intent === "temporal");
    expect(temporalCall).toBeDefined();
    await (temporalCall![0] as any).readUsefulness();
    expect(readUsefulness).toHaveBeenCalledWith(expect.any(Array), expect.objectContaining({ tenantId: "tenant-a", agentId: "agent-1", intent: "temporal" }));
  });
});

// ---------------------------------------------------------------------------
// __SOCIAL_MODELING__ sentinel (the offline
// directional relationship builder). The gate is STRICTER than the per-user
// representation cron: it requires BOTH enabled AND a recorded privacy-review
// sign-off. The write-side resolves channelId per source from the
// session key and SKIPS NULL-session-key sources.
// ---------------------------------------------------------------------------

describe("handleMemoryCronSentinel __SOCIAL_MODELING__", () => {
  // A formatted session key {tenant}:{user}:{channelId} — parseFormattedSessionKey
  // recovers channelId from this on the write side.
  const sk = (channelId: string, userId = "user_a") => `tenant-a:${userId}:${channelId}`;

  it("short-circuits ok and runs NOTHING when socialModeling is disabled (the opt-in gate)", async () => {
    const ctx = makeCtx({ agents: { "agent-1": { name: "Agent 1" } } });
    const onComplete = vi.fn();
    const handled = await handleMemoryCronSentinel("__SOCIAL_MODELING__", { agentId: "agent-1", onComplete }, ctx);
    expect(handled).toBe(true);
    expect(mockRunRelationshipBuild).not.toHaveBeenCalled();
    expect(mockCreateRelationshipSeam).not.toHaveBeenCalled();
    expect(onComplete).toHaveBeenCalledWith({ status: "ok" });
  });

  it("short-circuits ok and runs NOTHING when enabled but NO privacy-review sign-off (the sign-off gate)", async () => {
    // The knob alone does NOT activate — a recorded sign-off is required.
    const ctx = makeCtx({
      agents: { "agent-1": { name: "Agent 1", provider: "anthropic", socialModeling: { enabled: true } } },
      apiKey: "test-key",
      inspectRows: [{ id: "s1", userId: "user_a", content: "A trusts B", trustLevel: "learned", source: { sessionKey: sk("chan-1") } }],
    });
    const onComplete = vi.fn();
    const handled = await handleMemoryCronSentinel("__SOCIAL_MODELING__", { agentId: "agent-1", onComplete }, ctx);
    expect(handled).toBe(true);
    expect(mockRunRelationshipBuild).not.toHaveBeenCalled();
    expect(mockCreateRelationshipSeam).not.toHaveBeenCalled();
    expect(onComplete).toHaveBeenCalledWith({ status: "ok" });
  });

  it("groups sources by resolved channelId and invokes runRelationshipBuild PER channel when enabled + signed-off + keyed", async () => {
    const ctx = makeCtx({
      agents: { "agent-1": { name: "Agent 1", provider: "anthropic", socialModeling: { enabled: true, privacyReviewSignedOffBy: "ops@example.com" } } },
      apiKey: "test-key",
      inspectRows: [
        { id: "s1", userId: "user_a", content: "A about B", trustLevel: "learned", source: { sessionKey: sk("chan-1", "user_a") } },
        { id: "s2", userId: "user_b", content: "B about A", trustLevel: "learned", source: { sessionKey: sk("chan-1", "user_b") } },
        { id: "s3", userId: "user_c", content: "C about D", trustLevel: "learned", source: { sessionKey: sk("chan-2", "user_c") } },
      ],
    });
    const onComplete = vi.fn();
    const handled = await handleMemoryCronSentinel("__SOCIAL_MODELING__", { agentId: "agent-1", onComplete }, ctx);
    expect(handled).toBe(true);
    // Two distinct channels (chan-1, chan-2) => two per-channel build invocations.
    expect(mockRunRelationshipBuild).toHaveBeenCalledTimes(2);
    const channelIds = mockRunRelationshipBuild.mock.calls.map((c) => (c[0] as any).channelId).sort();
    expect(channelIds).toEqual(["chan-1", "chan-2"]);
    // The build is scoped to the agent + tenant + channel and receives the relationshipStore port.
    const firstArg = mockRunRelationshipBuild.mock.calls[0][0] as any;
    expect(firstArg.agentId).toBe("agent-1");
    expect(firstArg.tenantId).toBe("tenant-a");
    expect(firstArg.relationshipStore).toBe(ctx.relationshipStore);
    expect(mockCreateRelationshipSeam).toHaveBeenCalledOnce();
    expect(onComplete).toHaveBeenCalledWith({ status: "ok", error: undefined });
  });

  it("SKIPS a NULL-session-key source (0 build invocations for a NULL-only set — never bucketed under undefined)", async () => {
    // A source whose channelId cannot be resolved is SKIPPED + counted,
    // NEVER bucketed under an empty/undefined channel.
    const ctx = makeCtx({
      agents: { "agent-1": { name: "Agent 1", provider: "anthropic", socialModeling: { enabled: true, privacyReviewSignedOffBy: "ops@example.com" } } },
      apiKey: "test-key",
      inspectRows: [
        { id: "s1", userId: "user_a", content: "system fact, no session key", trustLevel: "learned", source: { sessionKey: null } },
      ],
    });
    const onComplete = vi.fn();
    const handled = await handleMemoryCronSentinel("__SOCIAL_MODELING__", { agentId: "agent-1", onComplete }, ctx);
    expect(handled).toBe(true);
    // A NULL-session-key-only source set yields 0 build invocations (no undefined-channel bucket).
    expect(mockRunRelationshipBuild).not.toHaveBeenCalled();
    expect(onComplete).toHaveBeenCalledWith({ status: "ok", error: undefined });
  });

  it("skips with an error when enabled + signed-off but NO API key (no key value used)", async () => {
    const ctx = makeCtx({
      agents: { "agent-1": { name: "Agent 1", provider: "anthropic", socialModeling: { enabled: true, privacyReviewSignedOffBy: "ops@example.com" } } },
      apiKey: undefined,
      inspectRows: [{ id: "s1", userId: "user_a", content: "A about B", trustLevel: "learned", source: { sessionKey: sk("chan-1") } }],
    });
    const onComplete = vi.fn();
    await handleMemoryCronSentinel("__SOCIAL_MODELING__", { agentId: "agent-1", onComplete }, ctx);
    expect(mockCreateRelationshipSeam).not.toHaveBeenCalled();
    expect(mockRunRelationshipBuild).not.toHaveBeenCalled();
    expect(onComplete).toHaveBeenCalledWith({ status: "error", error: "No API key for anthropic" });
  });
});

// ---------------------------------------------------------------------------
// __MEMORY_LIFECYCLE__ sentinel (the DORMANT
// lifecycle sweep). UNLIKE the consolidation/reasoning/user-rep/social sentinels
// it is KEYLESS (no resolveOperationModel, no secretManager, no build() seam —
// like the __ONLINE_TUNING__ bandit). It re-checks memoryLifecycle.enabled
// (defence-in-depth) and short-circuits ok when off; when on it invokes
// runLifecycleSweep — which is DORMANT (evicts/demotes/promotes 0 rows).
// ---------------------------------------------------------------------------
describe("handleMemoryCronSentinel __MEMORY_LIFECYCLE__", () => {
  it("short-circuits ok and runs NOTHING when memoryLifecycle is disabled (the opt-in gate)", async () => {
    const sweep = vi.fn(async () => ({ ok: true as const, value: { scanned: 0, promoted: 0, demoted: 0, evicted: 0 } }));
    const ctx = makeCtx({ agents: { "agent-1": { name: "Agent 1" } }, memoryLifecycleStore: { runLifecycleSweep: sweep } });
    const onComplete = vi.fn();
    const handled = await handleMemoryCronSentinel("__MEMORY_LIFECYCLE__", { agentId: "agent-1", onComplete }, ctx);
    expect(handled).toBe(true);
    // Defence-in-depth re-check: a now-disabled agent's stale persisted job runs NOTHING.
    expect(sweep).not.toHaveBeenCalled();
    expect(onComplete).toHaveBeenCalledWith({ status: "ok" });
  });

  it("invokes the DORMANT runLifecycleSweep scoped to (tenant, agent) with the injected clock when enabled — and the report mutates 0 rows", async () => {
    const sweep = vi.fn(async () => ({ ok: true as const, value: { scanned: 5, promoted: 0, demoted: 0, evicted: 0 } }));
    const ctx = makeCtx({
      agents: { "agent-1": { name: "Agent 1", memoryLifecycle: { enabled: true } } },
      memoryLifecycleStore: { runLifecycleSweep: sweep },
    });
    const onComplete = vi.fn();
    const handled = await handleMemoryCronSentinel("__MEMORY_LIFECYCLE__", { agentId: "agent-1", onComplete }, ctx);
    expect(handled).toBe(true);
    expect(sweep).toHaveBeenCalledOnce();
    // Scoped per (tenant, agent); the age axis uses the INJECTED clock.now (1_000), never Date.now.
    const scope = sweep.mock.calls[0][0] as { tenantId: string; agentId: string; now: number };
    expect(scope.tenantId).toBe("tenant-a");
    expect(scope.agentId).toBe("agent-1");
    expect(scope.now).toBe(1_000);
    // The Pitfall-3 on-path DORMANT proof: even when enabled the sweep mutates 0 rows.
    const report = await sweep.mock.results[0].value;
    expect(report.value).toEqual({ scanned: 5, promoted: 0, demoted: 0, evicted: 0 });
    expect(onComplete).toHaveBeenCalledWith({ status: "ok", error: undefined });
  });

  it("is KEYLESS — the lifecycle branch resolves NO model and reads NO secret", async () => {
    const sweep = vi.fn(async () => ({ ok: true as const, value: { scanned: 1, promoted: 0, demoted: 0, evicted: 0 } }));
    const ctx = makeCtx({
      agents: { "agent-1": { name: "Agent 1", provider: "anthropic", memoryLifecycle: { enabled: true } } },
      memoryLifecycleStore: { runLifecycleSweep: sweep },
    });
    const onComplete = vi.fn();
    await handleMemoryCronSentinel("__MEMORY_LIFECYCLE__", { agentId: "agent-1", onComplete }, ctx);
    expect(sweep).toHaveBeenCalledOnce();
    // The deletion vs the LLM sentinels — NO model resolution, NO secret read.
    expect(mockResolveOperationModel).not.toHaveBeenCalled();
    expect((ctx.container as any).secretManager.get).not.toHaveBeenCalled();
  });

  it("reports a non-fatal error (onComplete error) when the sweep fails — no throw", async () => {
    const sweep = vi.fn(async () => ({ ok: false as const, error: new Error("sweep boom") }));
    const ctx = makeCtx({
      agents: { "agent-1": { name: "Agent 1", memoryLifecycle: { enabled: true } } },
      memoryLifecycleStore: { runLifecycleSweep: sweep },
    });
    const onComplete = vi.fn();
    const handled = await handleMemoryCronSentinel("__MEMORY_LIFECYCLE__", { agentId: "agent-1", onComplete }, ctx);
    expect(handled).toBe(true);
    expect(onComplete).toHaveBeenCalledWith({ status: "error", error: "sweep boom" });
  });

  it("warns + errors when the lifecycle sentinel fires without an agentId", async () => {
    const sweep = vi.fn();
    const ctx = makeCtx({ memoryLifecycleStore: { runLifecycleSweep: sweep } });
    const onComplete = vi.fn();
    await handleMemoryCronSentinel("__MEMORY_LIFECYCLE__", { agentId: undefined, onComplete }, ctx);
    expect(sweep).not.toHaveBeenCalled();
    expect(onComplete).toHaveBeenCalledWith({ status: "error", error: "No agentId for memory lifecycle" });
  });

  // -------------------------------------------------------------------------
  // WIRE-02 (the WS7 first-RED): the __USEFULNESS_JUDGE__ cron was registered at
  // setup-schedulers.ts:489 but had NO dispatch handler — it fired nightly as a
  // NO-OP. These pin that the handler now constructs the seam and WRITES through
  // usefulnessStore.recordUsage (the dormant seam is live), with the same opt-in /
  // no-agentId / non-fatal posture as the sibling sentinels.
  // -------------------------------------------------------------------------
  it("the __USEFULNESS_JUDGE__ handler writes through recordUsage (no longer a nightly no-op)", async () => {
    // This is the first-RED: on pre-patch HEAD there is no __USEFULNESS_JUDGE__ block, so
    // the sentinel falls through unhandled (returns false) and recordUsage is NEVER called.
    mockJudgeSeam.mockResolvedValue({ usedIds: ["m1"], ignoredIds: ["m2"] });
    const recordUsage = vi.fn(async () => ({ ok: true as const, value: undefined }));
    const ctx = makeCtx({
      agents: { "agent-1": { name: "Agent 1", provider: "anthropic", memoryUsefulnessJudge: { enabled: true } } },
      apiKey: "test-key",
      inspectRows: [{ id: "m1", userId: "u", content: "x", trustLevel: "learned" }, { id: "m2", userId: "u", content: "y", trustLevel: "learned" }],
      usefulnessStore: { recordUsage, readUsefulness: vi.fn(async () => ({ ok: true as const, value: new Map() })) },
    });
    const onComplete = vi.fn();
    const handled = await handleMemoryCronSentinel("__USEFULNESS_JUDGE__", { agentId: "agent-1", onComplete }, ctx);
    expect(handled).toBe(true);
    expect(mockCreateUsefulnessJudgeSeam).toHaveBeenCalledOnce();
    expect(recordUsage).toHaveBeenCalledOnce();
    // The verdict partition is written through to the store, scoped to (tenant, agent).
    const [usedIds, ignoredIds, scope] = recordUsage.mock.calls[0] as [string[], string[], Record<string, unknown>];
    expect(usedIds).toEqual(["m1"]);
    expect(ignoredIds).toEqual(["m2"]);
    expect(scope).toMatchObject({ tenantId: "tenant-a", agentId: "agent-1" });
    expect(onComplete).toHaveBeenCalledWith({ status: "ok", error: undefined });
  });

  it("short-circuits the usefulness judge ok and never writes when the agent has it disabled (defence-in-depth re-check)", async () => {
    const recordUsage = vi.fn(async () => ({ ok: true as const, value: undefined }));
    const ctx = makeCtx({
      agents: { "agent-1": { name: "Agent 1" } },
      usefulnessStore: { recordUsage, readUsefulness: vi.fn(async () => ({ ok: true as const, value: new Map() })) },
    });
    const onComplete = vi.fn();
    const handled = await handleMemoryCronSentinel("__USEFULNESS_JUDGE__", { agentId: "agent-1", onComplete }, ctx);
    expect(handled).toBe(true);
    expect(mockCreateUsefulnessJudgeSeam).not.toHaveBeenCalled();
    expect(recordUsage).not.toHaveBeenCalled();
    expect(onComplete).toHaveBeenCalledWith({ status: "ok" });
  });

  it("warns + errors when the usefulness-judge sentinel fires without an agentId (no write)", async () => {
    const recordUsage = vi.fn(async () => ({ ok: true as const, value: undefined }));
    const ctx = makeCtx({ usefulnessStore: { recordUsage, readUsefulness: vi.fn(async () => ({ ok: true as const, value: new Map() })) } });
    const onComplete = vi.fn();
    const handled = await handleMemoryCronSentinel("__USEFULNESS_JUDGE__", { agentId: undefined, onComplete }, ctx);
    expect(handled).toBe(true);
    expect(recordUsage).not.toHaveBeenCalled();
    expect(onComplete).toHaveBeenCalledWith({ status: "error", error: "No agentId for usefulness judge" });
  });

  it("reports a non-fatal error (onComplete error) when recordUsage fails — never throws out of the dispatcher", async () => {
    mockJudgeSeam.mockResolvedValue({ usedIds: ["m1"], ignoredIds: [] });
    const recordUsage = vi.fn(async () => ({ ok: false as const, error: new Error("record boom") }));
    const ctx = makeCtx({
      agents: { "agent-1": { name: "Agent 1", provider: "anthropic", memoryUsefulnessJudge: { enabled: true } } },
      apiKey: "test-key",
      inspectRows: [{ id: "m1", userId: "u", content: "x", trustLevel: "learned" }],
      usefulnessStore: { recordUsage, readUsefulness: vi.fn(async () => ({ ok: true as const, value: new Map() })) },
    });
    const onComplete = vi.fn();
    const handled = await handleMemoryCronSentinel("__USEFULNESS_JUDGE__", { agentId: "agent-1", onComplete }, ctx);
    expect(handled).toBe(true);
    expect(recordUsage).toHaveBeenCalledOnce();
    expect(onComplete).toHaveBeenCalledWith({ status: "error", error: "record boom" });
  });

  it("skips the usefulness judge with an error when an enabled agent has no API key (no key value used)", async () => {
    const recordUsage = vi.fn(async () => ({ ok: true as const, value: undefined }));
    const ctx = makeCtx({
      agents: { "agent-1": { name: "Agent 1", provider: "anthropic", memoryUsefulnessJudge: { enabled: true } } },
      apiKey: undefined,
      usefulnessStore: { recordUsage, readUsefulness: vi.fn(async () => ({ ok: true as const, value: new Map() })) },
    });
    const onComplete = vi.fn();
    await handleMemoryCronSentinel("__USEFULNESS_JUDGE__", { agentId: "agent-1", onComplete }, ctx);
    expect(mockCreateUsefulnessJudgeSeam).not.toHaveBeenCalled();
    expect(recordUsage).not.toHaveBeenCalled();
    expect(onComplete).toHaveBeenCalledWith({ status: "error", error: "No API key for anthropic" });
  });
});
