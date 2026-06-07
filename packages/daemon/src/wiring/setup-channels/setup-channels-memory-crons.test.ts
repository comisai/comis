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
    memoryApi: memoryApi as any,
    memoryLifecycleStore: (overrides.memoryLifecycleStore ?? {
      // The DORMANT default: scanned some rows, mutated NONE (the scaffold).
      runLifecycleSweep: vi.fn(async () => ({ ok: true as const, value: { scanned: 3, promoted: 0, demoted: 0, evicted: 0 } })),
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
});
