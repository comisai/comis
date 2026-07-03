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

const mockRunMemoryConsolidation = vi.hoisted(() => vi.fn(async () => ({ ok: true as const, value: { generalized: 0, clustersConsidered: 0, durationMs: 0 } })));
const mockReasonSeam = vi.hoisted(() => vi.fn(async () => ({ deductive: [], inductive: [] })));
const mockCreateReasoningSeam = vi.hoisted(() => vi.fn(() => mockReasonSeam));
const mockRunMemoryReasoning = vi.hoisted(() => vi.fn(async () => ({ ok: true as const, value: undefined })));
const mockRunUserRepresentationBuild = vi.hoisted(() => vi.fn(async () => ({ ok: true as const, value: { built: 0, written: 0, blocked: 0, superseded: 0, corroborated: 0, inserted: 0, durationMs: 0 } })));
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
    consolidationStore: { listObservations: vi.fn() } as any,
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
  mockRunMemoryConsolidation.mockResolvedValue({ ok: true as const, value: { generalized: 0, clustersConsidered: 0, durationMs: 0 } });
  mockRunMemoryReasoning.mockResolvedValue({ ok: true as const, value: undefined });
  mockCreateReasoningSeam.mockReturnValue(mockReasonSeam);
  mockRunUserRepresentationBuild.mockResolvedValue({ ok: true as const, value: { built: 0, written: 0, blocked: 0, superseded: 0, corroborated: 0, inserted: 0, durationMs: 0 } });
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

  // The standalone __MEMORY_CONSOLIDATION__ /
  // __MEMORY_REASONING__ / __USER_REPRESENTATION__ intercepts were REMOVED (their work folds
  // into __REFLECT__), and __SOCIAL_MODELING__ was DELETED with the rest of the
  // social-modeling subsystem (its scheduler registration is gone too). A stray sentinel must
  // NO LONGER be handled here — it falls through (the WIRE leaf does not handle it either, so
  // `handled` is false) and the consolidation/reasoning/user-rep/relationship jobs are NEVER invoked.
  it.each(["__MEMORY_CONSOLIDATION__", "__MEMORY_REASONING__", "__USER_REPRESENTATION__", "__SOCIAL_MODELING__"])(
    "no longer handles the removed %s sentinel — falls through, runs no job",
    async (sentinel) => {
      const ctx = makeCtx({
        agents: { "agent-1": { name: "Agent 1", provider: "anthropic", memoryConsolidation: { enabled: true }, memoryReasoning: { enabled: true }, memoryUserRepresentation: { enabled: true }, socialModeling: { enabled: true, privacyReviewSignedOffBy: "ops@example.com" } } },
        apiKey: "test-key",
        inspectRows: [{ id: "m1", userId: "u1", content: "fact", trustLevel: "learned", source: { sessionKey: "tenant-a:u1:chan-1" } }],
      });
      const onComplete = vi.fn();
      const handled = await handleMemoryCronSentinel(sentinel, { agentId: "agent-1", onComplete }, ctx);
      expect(handled).toBe(false); // not handled here, and not by the WIRE leaf → falls through
      expect(mockRunMemoryConsolidation).not.toHaveBeenCalled();
      expect(mockRunMemoryReasoning).not.toHaveBeenCalled();
      expect(mockRunUserRepresentationBuild).not.toHaveBeenCalled();
      expect(mockRunRelationshipBuild, "the deleted __SOCIAL_MODELING__ builder must never run").not.toHaveBeenCalled();
    },
  );
});

// (The __ONLINE_TUNING__ sentinel tests were removed — the UCB recall bandit
// + its cron were deleted; recall scoring is the fixed config.rag.scoring alphas.)

// ---------------------------------------------------------------------------
// (The __SOCIAL_MODELING__ sentinel describe block — the offline directional relationship
//  builder dispatch — was DELETED with the rest of the social-modeling
//  subsystem. The 'no longer handled' assertion above now covers __SOCIAL_MODELING__.)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// __MEMORY_LIFECYCLE__ sentinel (the DORMANT
// lifecycle sweep). UNLIKE the consolidation/reasoning/user-rep/social sentinels
// it is KEYLESS (no resolveOperationModel, no secretManager, no build() seam).
// It re-checks memoryLifecycle.enabled
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
    // The on-path DORMANT proof: even when enabled the sweep mutates 0 rows.
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
  // The daemon emits learning:memory_demoted /
  // learning:memory_evicted (COUNTS ONLY) from the real sweep report, and threads the
  // learningForgetting eviction policy into runLifecycleSweep's per-call scope so the
  // store activates eviction. The store itself emits nothing (counts-only convention).
  // -------------------------------------------------------------------------
  it("emits learning:memory_demoted + learning:memory_evicted (counts only) from the sweep report", async () => {
    const sweep = vi.fn(async () => ({ ok: true as const, value: { scanned: 9, promoted: 0, demoted: 2, evicted: 3 } }));
    const ctx = makeCtx({
      agents: {
        "agent-1": {
          name: "Agent 1",
          memoryLifecycle: { enabled: true },
          // The collapsed learning block gates eviction (the deleted strengthThreshold/
          // failurePenalty decay knobs are gone; learning.enabled drives evictionEnabled).
          learning: { enabled: true },
        },
      },
      memoryLifecycleStore: { runLifecycleSweep: sweep },
    });
    const emit = (ctx.container as any).eventBus.emit as ReturnType<typeof vi.fn>;
    await handleMemoryCronSentinel("__MEMORY_LIFECYCLE__", { agentId: "agent-1", onComplete: vi.fn() }, ctx);
    expect(emit).toHaveBeenCalledWith("learning:memory_demoted", expect.objectContaining({ agentId: "agent-1", count: 2 }));
    expect(emit).toHaveBeenCalledWith("learning:memory_evicted", expect.objectContaining({ agentId: "agent-1", count: 3 }));
    // Counts only — the payloads carry no memory ids/bodies.
    const evictPayload = emit.mock.calls.find((c) => c[0] === "learning:memory_evicted")![1] as Record<string, unknown>;
    expect(Object.keys(evictPayload).sort()).toEqual(["agentId", "count", "timestamp"]);
  });

  it("threads the collapsed learning.forget policy (evictionEnabled + failureEvictionFloor) into the sweep scope", async () => {
    // The FadeMem strength-decay disjunct + its strengthThreshold/
    // failurePenalty knobs are deleted; the former learningForgetting block collapsed into
    // learning.forget. The override threads the master gate (learning.enabled → evictionEnabled)
    // + the corroborated-failure floor (learning.forget.failureEvictionFloor — the reachable path).
    const sweep = vi.fn(async () => ({ ok: true as const, value: { scanned: 5, promoted: 0, demoted: 0, evicted: 1 } }));
    const ctx = makeCtx({
      agents: {
        "agent-1": {
          name: "Agent 1",
          memoryLifecycle: { enabled: true },
          learning: { enabled: true, forget: { failureEvictionFloor: 4 } },
        },
      },
      memoryLifecycleStore: { runLifecycleSweep: sweep },
    });
    await handleMemoryCronSentinel("__MEMORY_LIFECYCLE__", { agentId: "agent-1", onComplete: vi.fn() }, ctx);
    const scope = sweep.mock.calls[0][0] as { tenantId: string; agentId: string; now: number; policy?: any };
    expect(scope.policy).toBeDefined();
    expect(scope.policy.evictionEnabled).toBe(true);
    expect(scope.policy.failureEvictionFloor).toBe(4);
    // The deleted decay knobs are NOT threaded into the override.
    expect(scope.policy.strengthThreshold).toBeUndefined();
    expect(scope.policy.failurePenalty).toBeUndefined();
  });

  it("byte-identity: with learningForgetting OFF (default), the sweep runs with eviction OFF and emits counts of 0 (no behavior change)", async () => {
    const sweep = vi.fn(async () => ({ ok: true as const, value: { scanned: 5, promoted: 0, demoted: 0, evicted: 0 } }));
    const ctx = makeCtx({
      agents: { "agent-1": { name: "Agent 1", memoryLifecycle: { enabled: true } } }, // no learningForgetting
      memoryLifecycleStore: { runLifecycleSweep: sweep },
    });
    const emit = (ctx.container as any).eventBus.emit as ReturnType<typeof vi.fn>;
    await handleMemoryCronSentinel("__MEMORY_LIFECYCLE__", { agentId: "agent-1", onComplete: vi.fn() }, ctx);
    // The sweep scope carries no eviction-enabled policy (DORMANT — byte-identical).
    const scope = sweep.mock.calls[0][0] as { policy?: { evictionEnabled?: boolean } };
    expect(scope.policy?.evictionEnabled ?? false).toBe(false);
    // The emits carry count 0 (DORMANT report) — the eviction did nothing.
    expect(emit).toHaveBeenCalledWith("learning:memory_evicted", expect.objectContaining({ count: 0 }));
  });

  // -------------------------------------------------------------------------
  // The __USEFULNESS_JUDGE__ + __MEMORY_TRIPLE_EXTRACTION__
  // dormant crons are GONE. handleMemoryCronSentinel delegates to the wire file at its
  // fall-through, and neither sentinel is recognized anymore → the whole chain returns false
  // (the caller delivers the system_event normally — the benign no-op for a persisted
  // stale job row). The recordUsage reward write (setup-learning.ts) is a SEPARATE
  // seam and is untouched; the TripleStorePort graphSpread recall lane survives (the JOB went).
  // -------------------------------------------------------------------------
  it("the deleted __USEFULNESS_JUDGE__ sentinel is unhandled → returns false (falls through)", async () => {
    const ctx = makeCtx({ agents: { "agent-1": { name: "Agent 1", provider: "anthropic" } }, apiKey: "test-key" });
    const onComplete = vi.fn();
    const handled = await handleMemoryCronSentinel("__USEFULNESS_JUDGE__", { agentId: "agent-1", onComplete }, ctx);
    expect(handled, "the deleted usefulness-judge sentinel must no longer be handled").toBe(false);
  });

  it("the deleted __MEMORY_TRIPLE_EXTRACTION__ sentinel is unhandled → returns false (falls through)", async () => {
    const ctx = makeCtx({ agents: { "agent-1": { name: "Agent 1", provider: "anthropic" } }, apiKey: "test-key" });
    const onComplete = vi.fn();
    const handled = await handleMemoryCronSentinel("__MEMORY_TRIPLE_EXTRACTION__", { agentId: "agent-1", onComplete }, ctx);
    expect(handled, "the deleted triple-extraction sentinel must no longer be handled").toBe(false);
  });
});
