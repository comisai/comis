// SPDX-License-Identifier: Apache-2.0
/**
 * Behavioral tests for the wired memory-cron sentinel handlers, exercising
 * `handleWireMemoryCronSentinel` DIRECTLY (the neighbor-test invariant — the file
 * carries its own coverage). The end-to-end delegation from `handleMemoryCronSentinel`
 * is covered in setup-channels-memory-crons.test.ts.
 *
 * The __USEFULNESS_JUDGE__ + __MEMORY_TRIPLE_EXTRACTION__
 * branches were DELETED (dormant crons) — the handler now serves only the KEYLESS
 * __MEMORY_LIFECYCLE__ sweep + the __REFLECT__ engine. createLlmReflectionAdapter /
 * runReflection are mocked — no real LLM, no key.
 *
 * @module
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockReasonSeam = vi.hoisted(() => vi.fn(async () => ({ deductive: [], inductive: [] })));
const mockCreateReasoningSeam = vi.hoisted(() => vi.fn(() => mockReasonSeam));
const mockResolveOperationModel = vi.hoisted(() => vi.fn(() => ({ provider: "anthropic", modelId: "anthropic:claude-haiku", model: "anthropic:claude-haiku", timeoutMs: 60_000, source: "default" })));
// The reflection job + adapter the __REFLECT__ handler injects/calls.
const mockRunReflection = vi.hoisted(() => vi.fn(async () => ({ ok: true as const, value: { admissionOutcome: "admitted" as const, selected: 2, admitted: 1, maxTopicCardinality: 2, distinctTopicKeys: 1, skipped: 1, emptyReflections: 0, untrustedDrops: 0, nameLengthRejections: 0 } })));
const mockCreateLlmReflectionAdapter = vi.hoisted(() => vi.fn(() => ({ reflect: vi.fn() })));

vi.mock("@comis/agent", async (importOriginal) => ({
  // Use the REAL module as the base so PURE helpers (classifyReflectOutcome — the wire's aggregate
  // verdict classifier) come from source, NOT a drift-prone re-stub
  // (the green-mock-vs-real-contract anti-pattern). Only the LLM/key-touching exports are overridden.
  ...(await importOriginal<typeof import("@comis/agent")>()),
  resolveOperationModel: mockResolveOperationModel,
  resolveProviderFamily: vi.fn(() => "anthropic"),
  createReasoningSeam: mockCreateReasoningSeam,
  runReflection: mockRunReflection,
  createLlmReflectionAdapter: mockCreateLlmReflectionAdapter,
  // The per-kind reflect prompts the __REFLECT__ handler injects as the
  // adapter `systemPrompt` (one engine, varied per-kind prompt). Distinct sentinels so a
  // test can assert which prompt fed which kind's adapter.
  REFLECT_PROMPT: "MOCK_SKILL_REFLECT_PROMPT",
  PROFILE_REFLECT_PROMPT: "MOCK_PROFILE_REFLECT_PROMPT",
  TOPIC_REFLECT_PROMPT: "MOCK_TOPIC_REFLECT_PROMPT",
  PROCEDURE_REFLECT_PROMPT: "MOCK_PROCEDURE_REFLECT_PROMPT",
  // The other named imports the module pulls (consolidation/reasoning/userrep/tuning)
  // are not on this leaf's code path, but the wholesale mock must satisfy the import list of
  // any transitively-imported module — keep them present as no-op spies. (The social-modeling
  // exports — runRelationshipBuild / createRelationshipSeam — were DELETED.)
  runMemoryConsolidation: vi.fn(),
  runMemoryReasoning: vi.fn(),
  runUserRepresentationBuild: vi.fn(),
  createUserRepresentationSeam: vi.fn(),
  resolveModelProfile: vi.fn(() => ({ capabilityClass: "frontier" })),
}));

import { handleWireMemoryCronSentinel } from "./setup-channels-memory-crons-wire.js";
import type { MemoryCronContext } from "./setup-channels-memory-crons-types.js";

function makeCtx(overrides: {
  agents?: Record<string, any>;
  apiKey?: string | undefined;
  inspectRows?: Array<{ id: string; content: string }>;
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
    memoryApi: memoryApi as any,
    ...(overrides.reflection !== undefined ? { reflection: overrides.reflection } : {}),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockResolveOperationModel.mockReturnValue({ provider: "anthropic", modelId: "anthropic:claude-haiku", model: "anthropic:claude-haiku", timeoutMs: 60_000, source: "default" } as any);
  mockCreateReasoningSeam.mockReturnValue(mockReasonSeam);
  mockRunReflection.mockResolvedValue({ ok: true as const, value: { admissionOutcome: "admitted" as const, selected: 2, admitted: 1, maxTopicCardinality: 2, distinctTopicKeys: 1, skipped: 1, emptyReflections: 0, untrustedDrops: 0, nameLengthRejections: 0 } });
  mockCreateLlmReflectionAdapter.mockReturnValue({ reflect: vi.fn() });
});

/** A reflection cron bundle for the enabled-path tests (the daemon assembles this in credentials.ts).
 *  The store Pick carries `supersede` (a profile/topic correction routes through it);
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

  // ----- The two DORMANT crons are GONE (deleted) -----
  // The __USEFULNESS_JUDGE__ (a recordUsage-feeding seam) and __MEMORY_TRIPLE_EXTRACTION__
  // (a no-op scaffold whose `extract` returned []) dispatch branches are DELETED. The handler
  // no longer recognizes either sentinel → it returns false (the caller falls through to the
  // normal delivery path, the benign no-op for any persisted stale job row). The
  // recordUsage reward write lives in setup-learning.ts (a separate seam) and is
  // UNAFFECTED; the TripleStorePort graphSpread recall lane survives (the JOB went, not the port).
  it("__USEFULNESS_JUDGE__ is deleted → returns false (falls through; no judge seam, no write)", async () => {
    const ctx = makeCtx({ agents: { "agent-1": { provider: "anthropic", memoryUsefulnessJudge: { enabled: true } } }, apiKey: "k" });
    const onComplete = vi.fn();
    const handled = await handleWireMemoryCronSentinel("__USEFULNESS_JUDGE__", { agentId: "agent-1", onComplete }, ctx);
    expect(handled, "the deleted __USEFULNESS_JUDGE__ sentinel is no longer recognized").toBe(false);
  });

  it("__MEMORY_TRIPLE_EXTRACTION__ is deleted → returns false (falls through; no job run)", async () => {
    const ctx = makeCtx({ agents: { "agent-1": { provider: "anthropic", memoryTripleExtraction: { enabled: true } } }, apiKey: "k" });
    const onComplete = vi.fn();
    const handled = await handleWireMemoryCronSentinel("__MEMORY_TRIPLE_EXTRACTION__", { agentId: "agent-1", onComplete }, ctx);
    expect(handled, "the deleted __MEMORY_TRIPLE_EXTRACTION__ sentinel is no longer recognized").toBe(false);
  });

  // -------------------------------------------------------------------------
  // The __REFLECT__ sentinel —
  // the reflect-engine replacement for the dead procedural-synthesis handler. DEFAULT
  // OFF — with learningSkills.enabled:false the handler is a clean ok no-op (NO reflect,
  // NO admit, ZERO behavior change). When enabled it injects the @comis/memory mental-
  // model store + the trusted-origin LCD source + the per-run reflect adapter and runs
  // runReflection, then RE-EMITS the reflect:* counts DAEMON-SIDE.
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

  it("__REFLECT__ enabled → runs ALL 4 reflect passes (skill, profile, topic, procedure) injecting the per-kind prompt/source, re-emits the SUMMED counts", async () => {
    const bundle = makeReflectionBundle();
    const ctx = makeCtx({
      // The collapsed learning block — reflect.minConfidence (0.6) + reflect.maxDocsPerRun (25).
      agents: { "agent-1": { name: "Agent 1", provider: "anthropic", learning: { enabled: true, reflect: { minConfidence: 0.6, maxDocsPerRun: 25 } } } },
      apiKey: "test-key",
      reflection: bundle,
    });
    const onComplete = vi.fn();
    const handled = await handleWireMemoryCronSentinel("__REFLECT__", { agentId: "agent-1", onComplete }, ctx);
    expect(handled).toBe(true);
    // ONE engine, LOOPED over the 4 passes — skill + profile + topic + the procedure pass (a 4th
    // kind:"skill" entry keyed on the descriptor). NOT four engines.
    expect(mockRunReflection).toHaveBeenCalledTimes(4);
    // The threaded `kind` covers skill twice (user-intent + procedure), plus profile + topic.
    const kinds = mockRunReflection.mock.calls.map((c) => (c[0] as { kind: string }).kind).sort();
    expect(kinds).toEqual(["profile", "skill", "skill", "topic"]);
    // The profile run carries a group-by-user groupKey (⇒ topicKey === userId).
    const profileArg = mockRunReflection.mock.calls.find((c) => (c[0] as { kind: string }).kind === "profile")![0] as Record<string, unknown>;
    // The USER-INTENT skill run: kind:"skill", NO groupKey, NO populateProcedureMetadata (byte-identical).
    const skillArg = mockRunReflection.mock.calls.find(
      (c) => (c[0] as { kind: string; populateProcedureMetadata?: boolean }).kind === "skill" && !(c[0] as { populateProcedureMetadata?: boolean }).populateProcedureMetadata,
    )![0] as Record<string, unknown>;
    // The PROCEDURE run: kind:"skill", a DEFINED descriptor groupKey, populateProcedureMetadata:true.
    const procArg = mockRunReflection.mock.calls.find(
      (c) => (c[0] as { populateProcedureMetadata?: boolean }).populateProcedureMetadata === true,
    )?.[0] as Record<string, unknown> | undefined;
    expect(procArg).toBeDefined();
    expect(procArg!.kind).toBe("skill");
    expect(typeof procArg!.groupKey).toBe("function");
    // The procedure groupKey reads the descriptor key; an absent descriptor ⇒ "" (ungroupable, skipped).
    expect((procArg!.groupKey as (t: { procedureDescriptor?: { key: string } }) => string)({ procedureDescriptor: { key: "web_search>jq" } })).toBe("web_search>jq");
    expect((procArg!.groupKey as (t: { procedureDescriptor?: { key: string } }) => string)({})).toBe("");
    expect(typeof profileArg.groupKey).toBe("function");
    expect((profileArg.groupKey as (t: { sender: string }) => string)({ sender: "u1" })).toBe("u1");
    expect(skillArg.groupKey).toBeUndefined();
    expect(skillArg.populateProcedureMetadata).toBeUndefined();
    // The injected closed-graph adapters (the daemon is the SOLE composition root); the SAME store
    // (with supersede) + outcome gate feed every pass.
    expect(skillArg.mentalModelStore).toBe(bundle!.learnedSkillStore);
    expect(skillArg.outcomeSignal).toBe(bundle!.outcomeSignal);
    expect(skillArg.reflectionAdapter).toBeDefined();
    // The per-pass adapter is built 4× (one per pass), each with the per-kind systemPrompt + source.
    expect(mockCreateLlmReflectionAdapter).toHaveBeenCalledTimes(4);
    const adapterPrompts = mockCreateLlmReflectionAdapter.mock.calls.map((c) => (c[0] as { systemPrompt: string; source: string }));
    expect(adapterPrompts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ systemPrompt: "MOCK_SKILL_REFLECT_PROMPT", source: "learned_skill_reflection" }),
        expect.objectContaining({ systemPrompt: "MOCK_PROFILE_REFLECT_PROMPT", source: "learned_profile_reflection" }),
        expect.objectContaining({ systemPrompt: "MOCK_TOPIC_REFLECT_PROMPT", source: "learned_topic_reflection" }),
        // The procedure pass wraps its transcript under a DISTINCT source label + prompt.
        expect.objectContaining({ systemPrompt: "MOCK_PROCEDURE_REFLECT_PROMPT", source: "learned_procedure_reflection" }),
      ]),
    );
    // No validation adapter / approval gate on the reflect path (the synthesis-only belt is gone).
    expect(skillArg.validationAdapter).toBeUndefined();
    expect(skillArg.approvalGate).toBeUndefined();
    // The config the daemon passed: the per-run DoS ceiling + the floor come from
    // the collapsed learning.reflect block (maxDocsPerRun is config-driven, 25 here).
    expect((skillArg.config as { maxDocsPerRun: number }).maxDocsPerRun).toBe(25);
    expect((skillArg.config as { minConfidence: number }).minConfidence).toBe(0.6);
    // The PER-KIND source build — called once per pass. The procedure pass reads the SAME
    // (descriptor-carrying) skill sources (kind:"skill"), so buildSourceTrajectories("skill") fires twice.
    expect(bundle!.buildSourceTrajectories).toHaveBeenCalledTimes(4);
    const builtKinds = (bundle!.buildSourceTrajectories as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]).sort();
    expect(builtKinds).toEqual(["profile", "skill", "skill", "topic"]);
    expect(Array.isArray(skillArg.sourceTrajectories)).toBe(true);
    // The daemon RE-EMITS the SUMMED counts DAEMON-SIDE after the loop (reflect:* names).
    // With the default all-admit mock returning {selected:2, admitted:1} per pass → sum admitted = 4.
    const emitCalls = (ctx.container.eventBus.emit as ReturnType<typeof vi.fn>).mock.calls;
    const emitted = emitCalls.map((c) => c[0]);
    expect(emitted).toContain("reflect:admitted");
    expect(emitted).toContain("reflect:funnel");
    // ONE summed emit (not per-pass) — the reflect:admitted.count is the SUMMED admitted (4 = 4 passes × 1).
    expect(emitted.filter((e) => e === "reflect:admitted")).toHaveLength(1);
    const synthEmit = emitCalls.find((c) => c[0] === "reflect:admitted");
    expect((synthEmit?.[1] as { count: number }).count).toBe(4);
    // The funnel carries the SUMMED reflect mapping: synthesized = sum selected (8 = 4×2),
    // admitted = 4, maxClusterCardinality = max across passes (2), the admissionOutcome verdict.
    const funnelEmit = emitCalls.find((c) => c[0] === "reflect:funnel");
    const funnel = funnelEmit?.[1] as { maxClusterCardinality: number; admitted: number; admissionOutcome: string; synthesized: number };
    expect(funnel.maxClusterCardinality).toBe(2);
    expect(funnel.admitted).toBe(4);
    expect(funnel.synthesized).toBe(8); // = sum selected (trusted-origin successes entering reflection)
    expect(funnel.admissionOutcome).toBe("admitted");
    // The vestigial learning:skill_validated is GONE (no validation event on the reflect path).
    expect(emitted).not.toContain("learning:skill_validated");
    expect(onComplete).toHaveBeenCalledWith({ status: "ok", error: undefined });
  });

  it("__REFLECT__ surfaces the uncorroborated funnel verdict (why 0 admitted) when ALL kinds admit nothing", async () => {
    // Every kind admits nothing for the uncorroborated reason → the SUMMED verdict is uncorroborated.
    mockRunReflection.mockResolvedValue({ ok: true as const, value: { admissionOutcome: "uncorroborated" as const, selected: 1, admitted: 0, maxTopicCardinality: 1, distinctTopicKeys: 1, skipped: 0, emptyReflections: 0, untrustedDrops: 0, nameLengthRejections: 0 } });
    const ctx = makeCtx({
      agents: { "agent-1": { name: "Agent 1", provider: "anthropic", learning: { enabled: true, reflect: { minConfidence: 0.6 } } } },
      apiKey: "test-key",
      reflection: makeReflectionBundle(),
    });
    const onComplete = vi.fn();
    await handleWireMemoryCronSentinel("__REFLECT__", { agentId: "agent-1", onComplete }, ctx);
    const emitCalls = (ctx.container.eventBus.emit as ReturnType<typeof vi.fn>).mock.calls;
    const funnel = emitCalls.find((c) => c[0] === "reflect:funnel")?.[1] as { admitted: number; maxClusterCardinality: number; admissionOutcome: string };
    expect(funnel.admitted).toBe(0); // 3 kinds × 0
    expect(funnel.maxClusterCardinality).toBe(1);
    expect(funnel.admissionOutcome).toBe("uncorroborated");
    const synth = emitCalls.find((c) => c[0] === "reflect:admitted")?.[1] as { count: number };
    expect(synth.count).toBe(0);
    expect(onComplete).toHaveBeenCalledWith({ status: "ok", error: undefined });
  });

  it("__REFLECT__ aggregate verdict is the MEANINGFUL per-kind reason, not the LAST kind's no_successes (mixed kinds)", async () => {
    // The SKILL kind selected 2 successes but they under-merged on the
    // deterministic topicKey (maxCardinality 1 → uncorroborated); the PROFILE + TOPIC kinds had no
    // successes. The old last-non-admitted-kind-wins fold made the SUMMED verdict `no_successes` —
    // self-contradictory next to `selected:2`, and it misdirects the operator to "nothing to learn
    // from" instead of "there WAS signal that under-merged → investigate the topicKey". The aggregate
    // MUST be `uncorroborated` (re-classified from the SUMMED counts, the funnel's documented intent).
    mockRunReflection
      .mockResolvedValueOnce({ ok: true as const, value: { admissionOutcome: "uncorroborated" as const, selected: 2, admitted: 0, maxTopicCardinality: 1, distinctTopicKeys: 2, skipped: 0, emptyReflections: 0, untrustedDrops: 0, nameLengthRejections: 0 } })
      .mockResolvedValueOnce({ ok: true as const, value: { admissionOutcome: "no_successes" as const, selected: 0, admitted: 0, maxTopicCardinality: 0, distinctTopicKeys: 0, skipped: 0, emptyReflections: 0, untrustedDrops: 0, nameLengthRejections: 0 } })
      .mockResolvedValueOnce({ ok: true as const, value: { admissionOutcome: "no_successes" as const, selected: 0, admitted: 0, maxTopicCardinality: 0, distinctTopicKeys: 0, skipped: 0, emptyReflections: 0, untrustedDrops: 0, nameLengthRejections: 0 } })
      // The 4th (procedure) pass — also no successes, so the SUMMED verdict stays the meaningful
      // skill-kind `uncorroborated` (selected:2, card:1), never the last pass's no_successes.
      .mockResolvedValueOnce({ ok: true as const, value: { admissionOutcome: "no_successes" as const, selected: 0, admitted: 0, maxTopicCardinality: 0, distinctTopicKeys: 0, skipped: 0, emptyReflections: 0, untrustedDrops: 0, nameLengthRejections: 0 } });
    const ctx = makeCtx({
      agents: { "agent-1": { name: "Agent 1", provider: "anthropic", learning: { enabled: true, reflect: { minConfidence: 0.6 } } } },
      apiKey: "test-key",
      reflection: makeReflectionBundle(),
    });
    await handleWireMemoryCronSentinel("__REFLECT__", { agentId: "agent-1", onComplete: vi.fn() }, ctx);
    const emitCalls = (ctx.container.eventBus.emit as ReturnType<typeof vi.fn>).mock.calls;
    const funnel = emitCalls.find((c) => c[0] === "reflect:funnel")?.[1] as { admissionOutcome: string; synthesized: number; admitted: number; distinctTopicKeys: number };
    expect(funnel.synthesized).toBe(2); // sum selected — there WAS trusted-origin signal this run
    expect(funnel.admitted).toBe(0);
    // The under-merge discriminator summed across kinds (skill 2 + no_successes 0 + no_successes 0).
    // synthesized:2 + distinctTopicKeys:2 + maxCard:1 = 2 successes that landed on 2 separate topics.
    expect(funnel.distinctTopicKeys).toBe(2);
    // The aggregate verdict matches its own counts (selected:2, card:1) — NOT the last kind's no_successes.
    expect(funnel.admissionOutcome).toBe("uncorroborated");
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
