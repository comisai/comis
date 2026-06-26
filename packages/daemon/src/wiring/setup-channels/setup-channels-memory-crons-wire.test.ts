// SPDX-License-Identifier: Apache-2.0
/**
 * Behavioral tests for the WS7-wired memory-cron sentinel handlers
 * (`__USEFULNESS_JUDGE__` WIRE-02 + `__MEMORY_TRIPLE_EXTRACTION__` WIRE-01),
 * exercising `handleWireMemoryCronSentinel` DIRECTLY (the neighbor-test invariant
 * — the file carries its own coverage). The end-to-end delegation from
 * `handleMemoryCronSentinel` is covered in setup-channels-memory-crons.test.ts.
 *
 * createUsefulnessJudgeSeam / runMemoryTripleExtraction / createReasoningSeam are
 * mocked — no real LLM, no key.
 *
 * @module
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockJudgeSeam = vi.hoisted(() => vi.fn(async () => ({ usedIds: [] as string[], ignoredIds: [] as string[] })));
const mockCreateUsefulnessJudgeSeam = vi.hoisted(() => vi.fn(() => mockJudgeSeam));
const mockReasonSeam = vi.hoisted(() => vi.fn(async () => ({ deductive: [], inductive: [] })));
const mockCreateReasoningSeam = vi.hoisted(() => vi.fn(() => mockReasonSeam));
const mockRunMemoryTripleExtraction = vi.hoisted(() => vi.fn(async () => ({ ok: true as const, value: { extracted: 0, written: 0, blocked: 0, downgraded: 0, skippedOverCap: 0 } })));
const mockResolveOperationModel = vi.hoisted(() => vi.fn(() => ({ provider: "anthropic", modelId: "anthropic:claude-haiku", model: "anthropic:claude-haiku", timeoutMs: 60_000, source: "default" })));
// REFLECT-01: the reflection job + adapter the __REFLECT__ handler injects/calls.
const mockRunReflection = vi.hoisted(() => vi.fn(async () => ({ ok: true as const, value: { admissionOutcome: "admitted" as const, selected: 2, admitted: 1, maxTopicCardinality: 2, skipped: 1 } })));
const mockCreateLlmReflectionAdapter = vi.hoisted(() => vi.fn(() => ({ reflect: vi.fn() })));

vi.mock("@comis/agent", () => ({
  resolveOperationModel: mockResolveOperationModel,
  resolveProviderFamily: vi.fn(() => "anthropic"),
  createUsefulnessJudgeSeam: mockCreateUsefulnessJudgeSeam,
  createReasoningSeam: mockCreateReasoningSeam,
  runMemoryTripleExtraction: mockRunMemoryTripleExtraction,
  runReflection: mockRunReflection,
  createLlmReflectionAdapter: mockCreateLlmReflectionAdapter,
  // Phase 225 FOLD: the per-kind reflect prompts the __REFLECT__ handler injects as the
  // adapter `systemPrompt` (one engine, varied per-kind prompt). Distinct sentinels so a
  // test can assert which prompt fed which kind's adapter.
  REFLECT_PROMPT: "MOCK_SKILL_REFLECT_PROMPT",
  PROFILE_REFLECT_PROMPT: "MOCK_PROFILE_REFLECT_PROMPT",
  TOPIC_REFLECT_PROMPT: "MOCK_TOPIC_REFLECT_PROMPT",
  // The other named imports the module pulls (consolidation/reasoning/userrep/social/tuning)
  // are not on this leaf's code path, but the wholesale mock must satisfy the import list of
  // any transitively-imported module — keep them present as no-op spies.
  runMemoryConsolidation: vi.fn(),
  runMemoryReasoning: vi.fn(),
  runUserRepresentationBuild: vi.fn(),
  createUserRepresentationSeam: vi.fn(),
  runRelationshipBuild: vi.fn(),
  createRelationshipSeam: vi.fn(),
  resolveModelProfile: vi.fn(() => ({ capabilityClass: "frontier" })),
}));

import { handleWireMemoryCronSentinel } from "./setup-channels-memory-crons-wire.js";
import type { MemoryCronContext } from "./setup-channels-memory-crons-types.js";

function makeCtx(overrides: {
  agents?: Record<string, any>;
  apiKey?: string | undefined;
  inspectRows?: Array<{ id: string; content: string }>;
  recordUsage?: ReturnType<typeof vi.fn>;
  reflection?: MemoryCronContext["reflection"];
} = {}): MemoryCronContext {
  const logger = { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn(() => logger) };
  const container = {
    config: { tenantId: "tenant-a", agents: overrides.agents ?? {}, providers: { entries: {} } },
    eventBus: { emit: vi.fn(), on: vi.fn() },
    secretManager: { get: vi.fn(() => (overrides.apiKey === undefined ? undefined : overrides.apiKey)) },
  };
  const memoryApi = { inspect: vi.fn(() => overrides.inspectRows ?? []) };
  return {
    container: container as any,
    logger: logger as any,
    clock: { now: () => 1_000, nowDate: () => new Date(1_000) } as any,
    agents: overrides.agents ?? {},
    tenantId: "tenant-a",
    tripleStore: { upsertTriple: vi.fn(), currentTruth: vi.fn() } as any,
    usefulnessStore: {
      recordUsage: overrides.recordUsage ?? vi.fn(async () => ({ ok: true as const, value: undefined })),
      readUsefulness: vi.fn(async () => ({ ok: true as const, value: new Map() })),
    } as any,
    memoryApi: memoryApi as any,
    ...(overrides.reflection !== undefined ? { reflection: overrides.reflection } : {}),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockResolveOperationModel.mockReturnValue({ provider: "anthropic", modelId: "anthropic:claude-haiku", model: "anthropic:claude-haiku", timeoutMs: 60_000, source: "default" } as any);
  mockCreateUsefulnessJudgeSeam.mockReturnValue(mockJudgeSeam);
  mockJudgeSeam.mockResolvedValue({ usedIds: [], ignoredIds: [] });
  mockCreateReasoningSeam.mockReturnValue(mockReasonSeam);
  mockRunMemoryTripleExtraction.mockResolvedValue({ ok: true as const, value: { extracted: 0, written: 0, blocked: 0, downgraded: 0, skippedOverCap: 0 } });
  mockRunReflection.mockResolvedValue({ ok: true as const, value: { admissionOutcome: "admitted" as const, selected: 2, admitted: 1, maxTopicCardinality: 2, skipped: 1 } });
  mockCreateLlmReflectionAdapter.mockReturnValue({ reflect: vi.fn() });
});

/** A reflection cron bundle for the enabled-path tests (the daemon assembles this in credentials.ts).
 *  Phase 225 FOLD: the store Pick carries `supersede` (a profile/topic correction routes through it);
 *  `buildSourceTrajectories` takes a leading `kind` arg + each source carries BOTH anti-poison axes. */
function makeReflectionBundle(over: Partial<MemoryCronContext["reflection"]> = {}): NonNullable<MemoryCronContext["reflection"]> {
  return {
    learnedSkillStore: {
      get: vi.fn(async () => ({ ok: true as const, value: undefined })),
      admit: vi.fn(async () => ({ ok: true as const, value: { admitted: true } })),
      supersede: vi.fn(async () => ({ ok: true as const, value: "superseded" as const })),
    } as any,
    outcomeSignal: { resolve: vi.fn(async () => ({ ok: true as const, value: { outcome: "unknown", confidence: 0, sources: [], recalledIds: [], usedSkillIds: [] } })) } as any,
    buildSourceTrajectories: vi.fn(async (_kind: "skill" | "profile" | "topic") => [
      { trajectoryId: "t1", sessionId: "s1", sender: "u1", text: "did X then Y", signature: "do X", trustedOrigin: true, sourceTrustExternal: false },
    ]) as any,
    ...over,
  };
}

describe("handleWireMemoryCronSentinel", () => {
  it("returns false for an unrecognized sentinel (the caller falls through to delivery)", async () => {
    const handled = await handleWireMemoryCronSentinel("__SOMETHING_ELSE__", { agentId: "a", onComplete: vi.fn() }, makeCtx());
    expect(handled).toBe(false);
  });

  // ----- __USEFULNESS_JUDGE__ (WIRE-02) -----
  it("__USEFULNESS_JUDGE__ writes the judge verdict through recordUsage scoped to (tenant, agent)", async () => {
    mockJudgeSeam.mockResolvedValue({ usedIds: ["m1"], ignoredIds: ["m2"] });
    const recordUsage = vi.fn(async () => ({ ok: true as const, value: undefined }));
    const ctx = makeCtx({
      agents: { "agent-1": { provider: "anthropic", memoryUsefulnessJudge: { enabled: true } } },
      apiKey: "k",
      inspectRows: [{ id: "m1", content: "x" }, { id: "m2", content: "y" }],
      recordUsage,
    });
    const onComplete = vi.fn();
    const handled = await handleWireMemoryCronSentinel("__USEFULNESS_JUDGE__", { agentId: "agent-1", onComplete }, ctx);
    expect(handled).toBe(true);
    expect(mockCreateUsefulnessJudgeSeam).toHaveBeenCalledOnce();
    expect(recordUsage).toHaveBeenCalledOnce();
    const [used, ignored, scope] = recordUsage.mock.calls[0] as [string[], string[], Record<string, unknown>];
    expect(used).toEqual(["m1"]);
    expect(ignored).toEqual(["m2"]);
    expect(scope).toMatchObject({ tenantId: "tenant-a", agentId: "agent-1" });
    expect(onComplete).toHaveBeenCalledWith({ status: "ok", error: undefined });
  });

  it("__USEFULNESS_JUDGE__ short-circuits ok + no write when disabled (defence-in-depth)", async () => {
    const recordUsage = vi.fn();
    const ctx = makeCtx({ agents: { "agent-1": {} }, recordUsage });
    const onComplete = vi.fn();
    await handleWireMemoryCronSentinel("__USEFULNESS_JUDGE__", { agentId: "agent-1", onComplete }, ctx);
    expect(recordUsage).not.toHaveBeenCalled();
    expect(onComplete).toHaveBeenCalledWith({ status: "ok" });
  });

  it("__USEFULNESS_JUDGE__ errors (no write) when fired without an agentId", async () => {
    const recordUsage = vi.fn();
    const ctx = makeCtx({ recordUsage });
    const onComplete = vi.fn();
    await handleWireMemoryCronSentinel("__USEFULNESS_JUDGE__", { agentId: undefined, onComplete }, ctx);
    expect(recordUsage).not.toHaveBeenCalled();
    expect(onComplete).toHaveBeenCalledWith({ status: "error", error: "No agentId for usefulness judge" });
  });

  it("__USEFULNESS_JUDGE__ reports a non-fatal error when recordUsage fails (no throw)", async () => {
    mockJudgeSeam.mockResolvedValue({ usedIds: ["m1"], ignoredIds: [] });
    const recordUsage = vi.fn(async () => ({ ok: false as const, error: new Error("boom") }));
    const ctx = makeCtx({
      agents: { "agent-1": { provider: "anthropic", memoryUsefulnessJudge: { enabled: true } } },
      apiKey: "k",
      inspectRows: [{ id: "m1", content: "x" }],
      recordUsage,
    });
    const onComplete = vi.fn();
    const handled = await handleWireMemoryCronSentinel("__USEFULNESS_JUDGE__", { agentId: "agent-1", onComplete }, ctx);
    expect(handled).toBe(true);
    expect(onComplete).toHaveBeenCalledWith({ status: "error", error: "boom" });
  });

  it("__USEFULNESS_JUDGE__ errors when an enabled agent has no API key", async () => {
    const recordUsage = vi.fn();
    const ctx = makeCtx({ agents: { "agent-1": { provider: "anthropic", memoryUsefulnessJudge: { enabled: true } } }, apiKey: undefined, recordUsage });
    const onComplete = vi.fn();
    await handleWireMemoryCronSentinel("__USEFULNESS_JUDGE__", { agentId: "agent-1", onComplete }, ctx);
    expect(mockCreateUsefulnessJudgeSeam).not.toHaveBeenCalled();
    expect(recordUsage).not.toHaveBeenCalled();
    expect(onComplete).toHaveBeenCalledWith({ status: "error", error: "No API key for anthropic" });
  });

  // ----- __MEMORY_TRIPLE_EXTRACTION__ (WIRE-01) -----
  it("__MEMORY_TRIPLE_EXTRACTION__ short-circuits ok + does NOT run the job when disabled (default-OFF re-check)", async () => {
    const ctx = makeCtx({ agents: { "agent-1": {} } });
    const onComplete = vi.fn();
    const handled = await handleWireMemoryCronSentinel("__MEMORY_TRIPLE_EXTRACTION__", { agentId: "agent-1", onComplete }, ctx);
    expect(handled).toBe(true);
    expect(mockRunMemoryTripleExtraction).not.toHaveBeenCalled();
    expect(onComplete).toHaveBeenCalledWith({ status: "ok" });
  });

  it("__MEMORY_TRIPLE_EXTRACTION__ runs runMemoryTripleExtraction with the injected tripleStore when enabled", async () => {
    const ctx = makeCtx({
      agents: { "agent-1": { provider: "anthropic", memoryTripleExtraction: { enabled: true, maxCandidatesPerRun: 50 } } },
      apiKey: "k",
      inspectRows: [{ id: "m1", content: "alice knows bob" }],
    });
    const onComplete = vi.fn();
    const handled = await handleWireMemoryCronSentinel("__MEMORY_TRIPLE_EXTRACTION__", { agentId: "agent-1", onComplete }, ctx);
    expect(handled).toBe(true);
    expect(mockRunMemoryTripleExtraction).toHaveBeenCalledOnce();
    const arg = mockRunMemoryTripleExtraction.mock.calls[0][0] as Record<string, unknown>;
    expect(arg.tripleStore).toBe(ctx.tripleStore);
    expect(arg.config).toMatchObject({ enabled: true, maxCandidatesPerRun: 50 });
    expect(onComplete).toHaveBeenCalledWith({ status: "ok", error: undefined });
  });

  it("__MEMORY_TRIPLE_EXTRACTION__ errors (no run) when fired without an agentId", async () => {
    const ctx = makeCtx();
    const onComplete = vi.fn();
    await handleWireMemoryCronSentinel("__MEMORY_TRIPLE_EXTRACTION__", { agentId: undefined, onComplete }, ctx);
    expect(mockRunMemoryTripleExtraction).not.toHaveBeenCalled();
    expect(onComplete).toHaveBeenCalledWith({ status: "error", error: "No agentId for triple extraction" });
  });

  // -------------------------------------------------------------------------
  // REFLECT-01/02 (v2.31 Reflection, Phase 223 Plan 05): the __REFLECT__ sentinel —
  // the reflect-engine replacement for the dead procedural-synthesis handler. DEFAULT
  // OFF — with learningSkills.enabled:false the handler is a clean ok no-op (NO reflect,
  // NO admit, ZERO behavior change). When enabled it injects the @comis/memory mental-
  // model store + the trusted-origin LCD source + the per-run reflect adapter and runs
  // runReflection, then RE-EMITS the learning:skill_* counts DAEMON-SIDE (the NAMES are
  // kept — the reflect:* rename is Phase 226).
  // -------------------------------------------------------------------------
  it("__REFLECT__ disabled-default → clean ok no-op (NO reflect, NO admit, ZERO behavior change)", async () => {
    const ctx = makeCtx({ agents: { "agent-1": { name: "Agent 1" } }, reflection: makeReflectionBundle() });
    const onComplete = vi.fn();
    const handled = await handleWireMemoryCronSentinel("__REFLECT__", { agentId: "agent-1", onComplete }, ctx);
    expect(handled).toBe(true);
    expect(mockRunReflection).not.toHaveBeenCalled();
    expect(mockCreateLlmReflectionAdapter).not.toHaveBeenCalled();
    expect(onComplete).toHaveBeenCalledWith({ status: "ok" });
  });

  it("__REFLECT__ enabled → reflects ALL 3 kinds (one engine, looped) injecting the per-kind prompt/source, re-emits the SUMMED learning:skill_* counts", async () => {
    const bundle = makeReflectionBundle();
    const ctx = makeCtx({
      // Phase 226: the collapsed learning block — reflect.minConfidence (0.6) + reflect.maxDocsPerRun (25).
      agents: { "agent-1": { name: "Agent 1", provider: "anthropic", learning: { enabled: true, reflect: { minConfidence: 0.6, maxDocsPerRun: 25 } } } },
      apiKey: "test-key",
      reflection: bundle,
    });
    const onComplete = vi.fn();
    const handled = await handleWireMemoryCronSentinel("__REFLECT__", { agentId: "agent-1", onComplete }, ctx);
    expect(handled).toBe(true);
    // ONE engine, LOOPED over the 3 kinds (skill, profile, topic) — NOT three engines.
    expect(mockRunReflection).toHaveBeenCalledTimes(3);
    // Each kind is reflected: the threaded `kind` covers skill/profile/topic exactly once.
    const kinds = mockRunReflection.mock.calls.map((c) => (c[0] as { kind: string }).kind).sort();
    expect(kinds).toEqual(["profile", "skill", "topic"]);
    // The profile run carries a group-by-user groupKey (⇒ topicKey === userId); skill/topic do not.
    const profileArg = mockRunReflection.mock.calls.find((c) => (c[0] as { kind: string }).kind === "profile")![0] as Record<string, unknown>;
    const skillArg = mockRunReflection.mock.calls.find((c) => (c[0] as { kind: string }).kind === "skill")![0] as Record<string, unknown>;
    expect(typeof profileArg.groupKey).toBe("function");
    expect((profileArg.groupKey as (t: { sender: string }) => string)({ sender: "u1" })).toBe("u1");
    expect(skillArg.groupKey).toBeUndefined();
    // The injected closed-graph adapters (the daemon is the SOLE composition root); the SAME store
    // (with supersede) + outcome gate feed every kind.
    expect(skillArg.mentalModelStore).toBe(bundle!.learnedSkillStore);
    expect(skillArg.outcomeSignal).toBe(bundle!.outcomeSignal);
    expect(skillArg.reflectionAdapter).toBeDefined();
    // The per-kind adapter is built 3× (one per kind), each with the per-kind systemPrompt + source.
    expect(mockCreateLlmReflectionAdapter).toHaveBeenCalledTimes(3);
    const adapterPrompts = mockCreateLlmReflectionAdapter.mock.calls.map((c) => (c[0] as { systemPrompt: string; source: string }));
    expect(adapterPrompts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ systemPrompt: "MOCK_SKILL_REFLECT_PROMPT", source: "learned_skill_reflection" }),
        expect.objectContaining({ systemPrompt: "MOCK_PROFILE_REFLECT_PROMPT", source: "learned_profile_reflection" }),
        expect.objectContaining({ systemPrompt: "MOCK_TOPIC_REFLECT_PROMPT", source: "learned_topic_reflection" }),
      ]),
    );
    // No validation adapter / approval gate on the reflect path (the synthesis-only belt is gone).
    expect(skillArg.validationAdapter).toBeUndefined();
    expect(skillArg.approvalGate).toBeUndefined();
    // The config the daemon passed: Phase 226 wires the per-run DoS ceiling + the floor from
    // the collapsed learning.reflect block (maxDocsPerRun was a hardcoded 10, now config-driven 25).
    expect((skillArg.config as { maxDocsPerRun: number }).maxDocsPerRun).toBe(25);
    expect((skillArg.config as { minConfidence: number }).minConfidence).toBe(0.6);
    // The PER-KIND source build (skill outcomes / profile+topic memories) — called once per kind.
    expect(bundle!.buildSourceTrajectories).toHaveBeenCalledTimes(3);
    const builtKinds = (bundle!.buildSourceTrajectories as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]).sort();
    expect(builtKinds).toEqual(["profile", "skill", "topic"]);
    expect(Array.isArray(skillArg.sourceTrajectories)).toBe(true);
    // The daemon RE-EMITS the SUMMED counts DAEMON-SIDE after the loop (NAMES kept). With the
    // default all-admit mock returning {selected:2, admitted:1} per kind → sum admitted = 3.
    const emitCalls = (ctx.container.eventBus.emit as ReturnType<typeof vi.fn>).mock.calls;
    const emitted = emitCalls.map((c) => c[0]);
    expect(emitted).toContain("learning:skill_synthesized");
    expect(emitted).toContain("learning:skill_synthesis_funnel");
    // ONE summed emit (not per-kind) — the synthesized.count is the SUMMED admitted (3 = 3 kinds × 1).
    expect(emitted.filter((e) => e === "learning:skill_synthesized")).toHaveLength(1);
    const synthEmit = emitCalls.find((c) => c[0] === "learning:skill_synthesized");
    expect((synthEmit?.[1] as { count: number }).count).toBe(3);
    // The funnel carries the SUMMED reflect mapping: synthesized = sum selected (6 = 3×2),
    // admitted = 3, maxClusterCardinality = max across kinds (2), the D5 admissionOutcome verdict.
    const funnelEmit = emitCalls.find((c) => c[0] === "learning:skill_synthesis_funnel");
    const funnel = funnelEmit?.[1] as { maxClusterCardinality: number; admitted: number; admissionOutcome: string; synthesized: number };
    expect(funnel.maxClusterCardinality).toBe(2);
    expect(funnel.admitted).toBe(3);
    expect(funnel.synthesized).toBe(6); // = sum selected (trusted-origin successes entering reflection)
    expect(funnel.admissionOutcome).toBe("admitted");
    // No per-candidate learning:skill_validated on the reflect path (dropped — no validation adapter).
    expect(emitted).not.toContain("learning:skill_validated");
    expect(onComplete).toHaveBeenCalledWith({ status: "ok", error: undefined });
  });

  it("__REFLECT__ surfaces the uncorroborated funnel verdict (why 0 admitted) when ALL kinds admit nothing", async () => {
    // Every kind admits nothing for the uncorroborated reason → the SUMMED verdict is uncorroborated.
    mockRunReflection.mockResolvedValue({ ok: true as const, value: { admissionOutcome: "uncorroborated" as const, selected: 1, admitted: 0, maxTopicCardinality: 1, skipped: 0 } });
    const ctx = makeCtx({
      agents: { "agent-1": { name: "Agent 1", provider: "anthropic", learning: { enabled: true, reflect: { minConfidence: 0.6 } } } },
      apiKey: "test-key",
      reflection: makeReflectionBundle(),
    });
    const onComplete = vi.fn();
    await handleWireMemoryCronSentinel("__REFLECT__", { agentId: "agent-1", onComplete }, ctx);
    const emitCalls = (ctx.container.eventBus.emit as ReturnType<typeof vi.fn>).mock.calls;
    const funnel = emitCalls.find((c) => c[0] === "learning:skill_synthesis_funnel")?.[1] as { admitted: number; maxClusterCardinality: number; admissionOutcome: string };
    expect(funnel.admitted).toBe(0); // 3 kinds × 0
    expect(funnel.maxClusterCardinality).toBe(1);
    expect(funnel.admissionOutcome).toBe("uncorroborated");
    const synth = emitCalls.find((c) => c[0] === "learning:skill_synthesized")?.[1] as { count: number };
    expect(synth.count).toBe(0);
    expect(onComplete).toHaveBeenCalledWith({ status: "ok", error: undefined });
  });

  it("__REFLECT__ errors (no run) when the reflection bundle is not wired", async () => {
    const ctx = makeCtx({ agents: { "agent-1": { name: "Agent 1", learning: { enabled: true } } } }); // no reflection bundle
    const onComplete = vi.fn();
    const handled = await handleWireMemoryCronSentinel("__REFLECT__", { agentId: "agent-1", onComplete }, ctx);
    expect(handled).toBe(true);
    expect(mockRunReflection).not.toHaveBeenCalled();
    expect(onComplete).toHaveBeenCalledWith({ status: "error", error: "reflection surface not wired" });
  });

  it("__REFLECT__ errors (no run) when fired without an agentId", async () => {
    const ctx = makeCtx({ reflection: makeReflectionBundle() });
    const onComplete = vi.fn();
    await handleWireMemoryCronSentinel("__REFLECT__", { agentId: undefined, onComplete }, ctx);
    expect(mockRunReflection).not.toHaveBeenCalled();
    expect(onComplete).toHaveBeenCalledWith({ status: "error", error: "No agentId for reflection" });
  });
});
