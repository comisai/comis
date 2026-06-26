// SPDX-License-Identifier: Apache-2.0
/**
 * Orchestration suite for {@link runReflection} (v2.31 Reflection engine,
 * Phase 223 Plan 04, REFLECT-01/03/04/05/06 + INV-2/INV-5).
 *
 * Everything is MOCKED — the reflect LLM adapter, the outcome-signal port, and
 * the mental-model store are stubs we control; the injected source history is
 * plain data; the clock is fixed. The headline assertions are the SECURITY ones,
 * RED-tested BOTH directions:
 *   - Trusted-origin SELECT (INV-5/D-04): a trusted-origin success seeds a doc; an
 *     UNTRUSTED-origin success seeds NOTHING (`store.admit` never called for it).
 *   - Corroboration (INV-2/D-05): ≥2 distinct (sessionId,sender) per topicKey →
 *     a candidate doc; a single (session,sender) repeated N times → NO doc.
 *   - Empty-content guard (REFLECT-05): a failed/empty reflection → `store.admit`
 *     is NOT called (the prior doc survives), reason-coded `empty_reflection`.
 *   - Validate + idempotency (REFLECT-06): a poison body is rejected before admit;
 *     a clean body admits at state-forced candidate/learned/proof=1; re-running on
 *     the SAME outcomes admits no duplicate (same deterministic id).
 *   - Delta-ops (REFLECT-04): an existing doc with a structuredBody refreshes via
 *     delta-ops, untargeted sections byte-identical; a new doc synthesizes fresh.
 */
import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
import { ok } from "@comis/shared";
import { applyDeltaOps, renderStructuredBody } from "@comis/core";
import type { ResolvedOutcome, StructuredBody } from "@comis/core";
import type { ReflectionResult } from "./reflection-prompt.js";
import {
  runReflection,
  classifyReflectOutcome,
  type RunReflectionDeps,
  type RunReflectionConfig,
  type ReflectionSourceTrajectory,
} from "./reflection-job.js";

const NOW = 1_700_000_000_000;
const SCOPE = { tenantId: "t1", agentId: "a1", now: NOW };

// ── outcome fixtures ──
function success(confidence = 0.9): ResolvedOutcome {
  return { outcome: "success", confidence, sources: ["tool"], recalledIds: [], usedSkillIds: [] };
}
function failure(): ResolvedOutcome {
  return { outcome: "failure", confidence: 0.9, sources: ["tool"], recalledIds: [], usedSkillIds: [] };
}
function unknown(): ResolvedOutcome {
  return { outcome: "unknown", confidence: 0, sources: [], recalledIds: [], usedSkillIds: [] };
}

/**
 * A source trajectory. `signature` drives the topicKey group-by; identical
 * signatures (after normalization) collide into one topic. `trustedOrigin`
 * defaults to true (the daemon derives it — Research A2).
 */
function traj(over: Partial<ReflectionSourceTrajectory> = {}): ReflectionSourceTrajectory {
  return {
    trajectoryId: over.trajectoryId ?? "traj-1",
    sessionId: over.sessionId ?? "sess-1",
    sender: over.sender ?? "user",
    text: over.text ?? "user: deploy the app\nassistant: deployed",
    signature: over.signature ?? "deploy the app to production",
    trustedOrigin: over.trustedOrigin ?? true,
  };
}

/** A well-formed fresh-doc reflection (a new doc → section list). */
function freshReflection(): ReflectionResult {
  return {
    sections: [
      { id: "when-to-use", heading: "When to use", body: "Use when deploying the app." },
      { id: "steps", heading: "Steps", body: "1. build\n2. ship" },
    ],
  };
}

interface Mocks {
  reflect: Mock;
  resolve: Mock;
  get: Mock;
  admit: Mock;
  logger: { info: Mock; debug: Mock; warn: Mock; error: Mock };
}

function makeDeps(
  trajectories: ReflectionSourceTrajectory[],
  over: Partial<RunReflectionDeps> = {},
  mocksOut?: Partial<Mocks>,
): RunReflectionDeps {
  const reflect = (over.reflectionAdapter?.reflect as Mock) ?? vi.fn(async () => ok(freshReflection()));
  const resolve = (over.outcomeSignal?.resolve as Mock) ?? vi.fn(async () => ok(success()));
  const get = (over.mentalModelStore?.get as Mock) ?? vi.fn(async () => ok(undefined));
  const admit = (over.mentalModelStore?.admit as Mock) ?? vi.fn(async () => ok({ id: "id-1", admitted: true }));
  const logger = { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() };

  if (mocksOut) {
    mocksOut.reflect = reflect;
    mocksOut.resolve = resolve;
    mocksOut.get = get;
    mocksOut.admit = admit;
    mocksOut.logger = logger;
  }

  const config: RunReflectionConfig = {
    enabled: true,
    minConfidence: 0.7,
    maxDocsPerRun: 10,
    ...(over.config ?? {}),
  };

  return {
    agentId: "a1",
    tenantId: "t1",
    scope: SCOPE,
    config,
    sourceTrajectories: trajectories,
    reflectionAdapter: { reflect },
    outcomeSignal: { resolve },
    mentalModelStore: { get, admit },
    clock: over.clock ?? { now: () => NOW },
    eventBus: over.eventBus ?? { emit: vi.fn() },
    logger,
  } as RunReflectionDeps;
}

// ---------------------------------------------------------------------------
// classifyReflectOutcome (the diagnosability verdict)
// ---------------------------------------------------------------------------

describe("classifyReflectOutcome (why a reflection run admitted nothing)", () => {
  const base = { selected: 2, maxTopicCardinality: 2, admitted: 0, emptyReflections: 0 };
  it("admitted wins (success short-circuits)", () => {
    expect(classifyReflectOutcome({ ...base, admitted: 1 })).toBe("admitted");
  });
  it("no_successes when SELECT kept nothing", () => {
    expect(classifyReflectOutcome({ ...base, selected: 0 })).toBe("no_successes");
  });
  it("uncorroborated when no topic reached cardinality 2", () => {
    expect(classifyReflectOutcome({ ...base, maxTopicCardinality: 1 })).toBe("uncorroborated");
  });
  it("empty_reflection when a corroborated topic reflected empty", () => {
    expect(classifyReflectOutcome({ ...base, emptyReflections: 1 })).toBe("empty_reflection");
  });
  it("rejected_validation when corroborated + non-empty but nothing admitted", () => {
    expect(classifyReflectOutcome(base)).toBe("rejected_validation");
  });
});

// ---------------------------------------------------------------------------
// SELECT (REFLECT-01)
// ---------------------------------------------------------------------------

describe("runReflection — SELECT (REFLECT-01, fail-closed)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("keeps ONLY success >= minConfidence — failure/unknown/low-confidence are dropped", async () => {
    const mocks: Partial<Mocks> = {};
    const resolve = vi.fn(async (id: string) => {
      if (id === "ok-a") return ok(success(0.9));
      if (id === "ok-b") return ok(success(0.9));
      if (id === "fail") return ok(failure());
      if (id === "unk") return ok(unknown());
      if (id === "low") return ok(success(0.3)); // below minConfidence
      return ok(unknown());
    });
    // ok-a and ok-b share a topic + distinct (session,sender) → one corroborated doc.
    const deps = makeDeps(
      [
        traj({ trajectoryId: "ok-a", sessionId: "s1", sender: "u1" }),
        traj({ trajectoryId: "ok-b", sessionId: "s2", sender: "u2" }),
        traj({ trajectoryId: "fail", sessionId: "s3", sender: "u3" }),
        traj({ trajectoryId: "unk", sessionId: "s4", sender: "u4" }),
        traj({ trajectoryId: "low", sessionId: "s5", sender: "u5" }),
      ],
      { outcomeSignal: { resolve } },
      mocks,
    );

    const res = await runReflection(deps);

    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.value.selected).toBe(2); // only the 2 successes >= minConfidence
    expect(res.value.admitted).toBe(1);
  });

  it("returns no_successes when nothing resolves to success", async () => {
    const mocks: Partial<Mocks> = {};
    const resolve = vi.fn(async () => ok(failure()));
    const deps = makeDeps([traj({ trajectoryId: "a" }), traj({ trajectoryId: "b" })], { outcomeSignal: { resolve } }, mocks);
    const res = await runReflection(deps);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.value.admitted).toBe(0);
    expect(res.value.admissionOutcome).toBe("no_successes");
    expect(mocks.reflect).not.toHaveBeenCalled();
  });

  it("fail-closed: an unresolved outcome (err) is skipped, never treated as a success", async () => {
    const mocks: Partial<Mocks> = {};
    const { err } = await import("@comis/shared");
    const resolve = vi.fn(async () => err(new Error("scope unresolved")));
    const deps = makeDeps(
      [traj({ trajectoryId: "a", sessionId: "s1", sender: "u1" }), traj({ trajectoryId: "b", sessionId: "s2", sender: "u2" })],
      { outcomeSignal: { resolve } },
      mocks,
    );
    const res = await runReflection(deps);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.value.selected).toBe(0);
    expect(res.value.admitted).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Trusted-origin (INV-5 / D-04) — RED BOTH directions
// ---------------------------------------------------------------------------

describe("runReflection — trusted-origin SELECT (INV-5/D-04, BOTH directions)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("a TRUSTED-origin success proceeds to a doc", async () => {
    const mocks: Partial<Mocks> = {};
    const deps = makeDeps(
      [
        traj({ trajectoryId: "a", sessionId: "s1", sender: "u1", trustedOrigin: true }),
        traj({ trajectoryId: "b", sessionId: "s2", sender: "u2", trustedOrigin: true }),
      ],
      {},
      mocks,
    );
    const res = await runReflection(deps);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.value.admitted).toBe(1);
    expect(mocks.admit).toHaveBeenCalledTimes(1);
  });

  it("an UNTRUSTED-origin success seeds NOTHING — store.admit never called for it", async () => {
    const mocks: Partial<Mocks> = {};
    // Two successes on the SAME topic + DISTINCT (session,sender) — they WOULD
    // corroborate, BUT both are untrusted-origin → filtered out at SELECT.
    const deps = makeDeps(
      [
        traj({ trajectoryId: "a", sessionId: "s1", sender: "u1", trustedOrigin: false }),
        traj({ trajectoryId: "b", sessionId: "s2", sender: "u2", trustedOrigin: false }),
      ],
      {},
      mocks,
    );

    const res = await runReflection(deps);

    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.value.selected).toBe(0); // untrusted-origin successes are NOT selected
    expect(res.value.admitted).toBe(0);
    expect(mocks.admit).not.toHaveBeenCalled();
    expect(mocks.reflect).not.toHaveBeenCalled();
  });

  it("a SINGLE untrusted-origin success among trusted ones does not corroborate the topic alone", async () => {
    const mocks: Partial<Mocks> = {};
    // One trusted + one untrusted on the same topic → only the trusted survives →
    // cardinality 1 → NO doc (the untrusted one cannot be the 2nd corroborator).
    const deps = makeDeps(
      [
        traj({ trajectoryId: "a", sessionId: "s1", sender: "u1", trustedOrigin: true }),
        traj({ trajectoryId: "b", sessionId: "s2", sender: "u2", trustedOrigin: false }),
      ],
      {},
      mocks,
    );
    const res = await runReflection(deps);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.value.selected).toBe(1);
    expect(res.value.admitted).toBe(0);
    expect(mocks.admit).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Group-by + corroboration (INV-2 / D-05) — RED BOTH directions
// ---------------------------------------------------------------------------

describe("runReflection — group-by topicKey + corroboration gate (INV-2/D-05, BOTH directions)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("≥2 distinct (sessionId,sender) on the SAME topicKey → one candidate doc admitted", async () => {
    const mocks: Partial<Mocks> = {};
    // Same topic, DIFFERENTLY WORDED (the topicKey normalizer must collide them) +
    // distinct (session,sender).
    const deps = makeDeps(
      [
        traj({ trajectoryId: "a", sessionId: "s1", sender: "u1", signature: "deploy the app to production" }),
        traj({ trajectoryId: "b", sessionId: "s2", sender: "u2", signature: "app deploy to production please" }),
      ],
      {},
      mocks,
    );

    const res = await runReflection(deps);

    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.value.maxTopicCardinality).toBe(2);
    expect(res.value.admitted).toBe(1);
    expect(mocks.reflect).toHaveBeenCalledTimes(1);
    expect(mocks.admit).toHaveBeenCalledTimes(1);
  });

  it("a SINGLE (sessionId,sender) repeated N times on one topicKey → NO doc (cardinality 1)", async () => {
    const mocks: Partial<Mocks> = {};
    // 5 successes, SAME topic, SAME (session,sender) — an attacker repeating one
    // success N times must NOT corroborate.
    const trajectories = Array.from({ length: 5 }, (_, i) =>
      traj({ trajectoryId: `dom-${i}`, sessionId: "sess-A", sender: "u1", signature: "deploy the app" }),
    );
    const deps = makeDeps(trajectories, {}, mocks);

    const res = await runReflection(deps);

    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.value.selected).toBe(5);
    expect(res.value.maxTopicCardinality).toBe(1); // distinct (session,sender) = 1
    expect(res.value.admitted).toBe(0);
    expect(mocks.admit).not.toHaveBeenCalled();
    expect(res.value.admissionOutcome).toBe("uncorroborated");
  });

  it("counts distinct (session,sender) — same session, different senders = cardinality 2", async () => {
    const mocks: Partial<Mocks> = {};
    const deps = makeDeps(
      [
        traj({ trajectoryId: "x", sessionId: "sess-A", sender: "u1", signature: "rotate the api key" }),
        traj({ trajectoryId: "y", sessionId: "sess-A", sender: "u2", signature: "rotate api key" }),
      ],
      {},
      mocks,
    );
    const res = await runReflection(deps);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.value.maxTopicCardinality).toBe(2);
    expect(res.value.admitted).toBe(1);
  });

  it("an empty topicKey (ungroupable signature) is skipped — never corroborates", async () => {
    const mocks: Partial<Mocks> = {};
    // A stopword-only signature normalizes to "" → ungroupable, even with 2 distinct senders.
    const deps = makeDeps(
      [
        traj({ trajectoryId: "a", sessionId: "s1", sender: "u1", signature: "the a an to of" }),
        traj({ trajectoryId: "b", sessionId: "s2", sender: "u2", signature: "for and or please" }),
      ],
      {},
      mocks,
    );
    const res = await runReflection(deps);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.value.admitted).toBe(0);
    expect(mocks.admit).not.toHaveBeenCalled();
  });

  it("bounds the reflect calls by maxDocsPerRun", async () => {
    const mocks: Partial<Mocks> = {};
    // 5 distinct corroborated topics, each with 2 distinct senders; maxDocsPerRun:2.
    const trajectories: ReflectionSourceTrajectory[] = [];
    for (let t = 0; t < 5; t++) {
      trajectories.push(traj({ trajectoryId: `t${t}-a`, sessionId: `s${t}a`, sender: "u1", signature: `topic alpha ${t}` }));
      trajectories.push(traj({ trajectoryId: `t${t}-b`, sessionId: `s${t}b`, sender: "u2", signature: `topic alpha ${t}` }));
    }
    const deps = makeDeps(trajectories, { config: { maxDocsPerRun: 2 } as RunReflectionConfig }, mocks);

    const res = await runReflection(deps);

    expect(res.ok).toBe(true);
    expect((mocks.reflect as Mock).mock.calls.length).toBeLessThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// Delta-ops vs fresh (REFLECT-04)
// ---------------------------------------------------------------------------

describe("runReflection — delta-ops refresh vs fresh synth (REFLECT-04)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("an EXISTING doc with a structuredBody refreshes via delta-ops — untargeted sections byte-identical", async () => {
    const mocks: Partial<Mocks> = {};
    const prior: StructuredBody = {
      sections: [
        { id: "when-to-use", heading: "When to use", body: "Use when deploying." },
        { id: "steps", heading: "Steps", body: "1. build\n2. ship" },
        { id: "pitfalls", heading: "Pitfalls", body: "Watch the env." },
      ],
    };
    const get = vi.fn(async () =>
      ok({
        id: "existing-id",
        name: "deploy-doc",
        description: "d",
        body: renderStructuredBody(prior),
        kind: "skill" as const,
        topicKey: "tk",
        trustLevel: "learned" as const,
        state: "candidate" as const,
        proofCount: 1,
        confidence: 0.7,
        mutating: false,
        sourceTrajIds: [],
        structuredBody: prior,
        createdAt: NOW,
      }),
    );
    // The reflect replaces ONLY the "steps" section.
    const reflect = vi.fn(async () => ok({
      ops: [{ op: "replace" as const, id: "steps", section: { id: "steps", heading: "Steps", body: "1. build\n2. test\n3. ship" } }],
    }));
    const deps = makeDeps(
      [
        traj({ trajectoryId: "a", sessionId: "s1", sender: "u1", signature: "deploy the app" }),
        traj({ trajectoryId: "b", sessionId: "s2", sender: "u2", signature: "deploy app" }),
      ],
      { mentalModelStore: { get, admit: vi.fn(async () => ok({ id: "existing-id", admitted: true })) }, reflectionAdapter: { reflect } },
      mocks,
    );

    const res = await runReflection(deps);

    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.value.admitted).toBe(1);
    // The adapter is given the PRIOR sections so it can delta against them.
    expect((reflect as Mock).mock.calls[0][0].currentSections).toEqual(prior.sections);
    // The admitted structuredBody == applyDeltaOps(prior, ops): untargeted sections byte-identical.
    const admitArg = (mocks.admit as Mock).mock.calls[0][0];
    const expected = applyDeltaOps(prior, [
      { op: "replace", id: "steps", section: { id: "steps", heading: "Steps", body: "1. build\n2. test\n3. ship" } },
    ]);
    expect(admitArg.structuredBody).toEqual(expected);
    // Reference identity on the untouched sections (the drift-killer).
    expect(admitArg.structuredBody.sections[0]).toBe(prior.sections[0]);
    expect(admitArg.structuredBody.sections[2]).toBe(prior.sections[2]);
    // The body column is the rendered AST.
    expect(admitArg.body).toBe(renderStructuredBody(expected));
  });

  it("a NEW doc (store.get returns nothing) synthesizes a fresh section list", async () => {
    const mocks: Partial<Mocks> = {};
    const get = vi.fn(async () => ok(undefined));
    const reflect = vi.fn(async () => ok(freshReflection()));
    const deps = makeDeps(
      [
        traj({ trajectoryId: "a", sessionId: "s1", sender: "u1", signature: "deploy the app" }),
        traj({ trajectoryId: "b", sessionId: "s2", sender: "u2", signature: "deploy app" }),
      ],
      { mentalModelStore: { get, admit: vi.fn(async () => ok({ id: "new-id", admitted: true })) }, reflectionAdapter: { reflect } },
      mocks,
    );

    const res = await runReflection(deps);

    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.value.admitted).toBe(1);
    // A new doc is given an EMPTY current-sections list.
    expect((reflect as Mock).mock.calls[0][0].currentSections).toEqual([]);
    const admitArg = (mocks.admit as Mock).mock.calls[0][0];
    expect(admitArg.structuredBody.sections).toHaveLength(2);
    expect(admitArg.body).toBe(renderStructuredBody({ sections: freshReflection().sections! }));
  });
});

// ---------------------------------------------------------------------------
// Empty-content guard (REFLECT-05)
// ---------------------------------------------------------------------------

describe("runReflection — empty-content guard (REFLECT-05)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("an LLM reflection returning {} → store.admit NOT called (the prior doc survives), recorded empty_reflection", async () => {
    const mocks: Partial<Mocks> = {};
    const reflect = vi.fn(async () => ok({})); // empty result
    const deps = makeDeps(
      [
        traj({ trajectoryId: "a", sessionId: "s1", sender: "u1", signature: "deploy the app" }),
        traj({ trajectoryId: "b", sessionId: "s2", sender: "u2", signature: "deploy app" }),
      ],
      { reflectionAdapter: { reflect } },
      mocks,
    );

    const res = await runReflection(deps);

    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(mocks.reflect).toHaveBeenCalledTimes(1);
    expect(mocks.admit).not.toHaveBeenCalled();
    expect(res.value.admitted).toBe(0);
    expect(res.value.admissionOutcome).toBe("empty_reflection");
  });

  it("a FAILED reflection (err) → store.admit NOT called, recorded empty_reflection (non-fatal)", async () => {
    const mocks: Partial<Mocks> = {};
    const { err } = await import("@comis/shared");
    const reflect = vi.fn(async () => err(new Error("LLM down")));
    const deps = makeDeps(
      [
        traj({ trajectoryId: "a", sessionId: "s1", sender: "u1", signature: "deploy the app" }),
        traj({ trajectoryId: "b", sessionId: "s2", sender: "u2", signature: "deploy app" }),
      ],
      { reflectionAdapter: { reflect } },
      mocks,
    );

    const res = await runReflection(deps);

    expect(res.ok).toBe(true); // the RUN survives a per-topic LLM fault
    if (!res.ok) throw new Error("expected ok");
    expect(mocks.admit).not.toHaveBeenCalled();
    expect(res.value.admitted).toBe(0);
  });

  it("a fresh reflection with an EMPTY section list → store.admit NOT called (no empty doc admitted)", async () => {
    const mocks: Partial<Mocks> = {};
    const reflect = vi.fn(async () => ok({ sections: [] }));
    const deps = makeDeps(
      [
        traj({ trajectoryId: "a", sessionId: "s1", sender: "u1", signature: "deploy the app" }),
        traj({ trajectoryId: "b", sessionId: "s2", sender: "u2", signature: "deploy app" }),
      ],
      { reflectionAdapter: { reflect } },
      mocks,
    );
    const res = await runReflection(deps);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(mocks.admit).not.toHaveBeenCalled();
  });

  it("an existing doc whose delta-ops are EMPTY (no change) → store.admit NOT called (the prior doc survives)", async () => {
    const mocks: Partial<Mocks> = {};
    const prior: StructuredBody = { sections: [{ id: "s", heading: "S", body: "b" }] };
    const get = vi.fn(async () =>
      ok({
        id: "existing-id",
        name: "deploy-doc",
        description: "d",
        body: renderStructuredBody(prior),
        kind: "skill" as const,
        topicKey: "tk",
        trustLevel: "learned" as const,
        state: "candidate" as const,
        proofCount: 1,
        confidence: 0.7,
        mutating: false,
        sourceTrajIds: [],
        structuredBody: prior,
        createdAt: NOW,
      }),
    );
    const reflect = vi.fn(async () => ok({ ops: [] })); // no change
    const deps = makeDeps(
      [
        traj({ trajectoryId: "a", sessionId: "s1", sender: "u1", signature: "deploy the app" }),
        traj({ trajectoryId: "b", sessionId: "s2", sender: "u2", signature: "deploy app" }),
      ],
      { mentalModelStore: { get, admit: vi.fn() }, reflectionAdapter: { reflect } },
      mocks,
    );
    const res = await runReflection(deps);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(mocks.admit).not.toHaveBeenCalled();
    expect(res.value.admissionOutcome).toBe("empty_reflection");
  });
});

// ---------------------------------------------------------------------------
// Validate + admit + idempotency (REFLECT-06)
// ---------------------------------------------------------------------------

describe("runReflection — validate-then-admit + idempotency (REFLECT-06)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("a clean body admits at proofCount LOW (1), kind:skill, topicKey set, structuredBody populated; trust/state store-forced (not supplied)", async () => {
    const mocks: Partial<Mocks> = {};
    const deps = makeDeps(
      [
        traj({ trajectoryId: "a", sessionId: "s1", sender: "u1", signature: "deploy the app" }),
        traj({ trajectoryId: "b", sessionId: "s2", sender: "u2", signature: "deploy app" }),
      ],
      {},
      mocks,
    );

    const res = await runReflection(deps);

    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(mocks.admit).toHaveBeenCalledTimes(1);
    const admitArg = (mocks.admit as Mock).mock.calls[0][0];
    expect(admitArg.proofCount).toBe(1); // LOW cap regardless of corroboration count
    expect(admitArg.kind).toBe("skill");
    expect(admitArg.mutating).toBe(false);
    expect(typeof admitArg.topicKey).toBe("string");
    expect(admitArg.topicKey.length).toBeGreaterThan(0);
    // WR-01: the doc name embeds the FULL topicKey (name↔topicKey bijective) — no
    // 16-char truncation, so two near-colliding topicKeys can never share a name.
    expect(admitArg.name).toBe(`skill-${admitArg.topicKey}`);
    expect(admitArg.structuredBody.sections).toHaveLength(2);
    expect(admitArg.sourceTrajIds).toEqual(["a", "b"]);
    expect(admitArg.createdAt).toBe(NOW);
    // trust=learned / state=candidate are FORCED by the store; the caller supplies neither.
    expect(admitArg).not.toHaveProperty("trustLevel");
    expect(admitArg).not.toHaveProperty("state");
  });

  it("a reflected body carrying a CRITICAL poison pattern → validateLearnedDocBody rejects → NOT admitted (rejected_validation)", async () => {
    const mocks: Partial<Mocks> = {};
    // A dangerous-command body trips validateMemoryWrite → critical → rejected.
    const reflect = vi.fn(async () => ok({
      sections: [{ id: "steps", heading: "Steps", body: "Run: rm -rf / --no-preserve-root" }],
    }));
    const deps = makeDeps(
      [
        traj({ trajectoryId: "a", sessionId: "s1", sender: "u1", signature: "wipe the disk" }),
        traj({ trajectoryId: "b", sessionId: "s2", sender: "u2", signature: "wipe disk" }),
      ],
      { reflectionAdapter: { reflect } },
      mocks,
    );

    const res = await runReflection(deps);

    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(mocks.admit).not.toHaveBeenCalled();
    expect(res.value.admitted).toBe(0);
    expect(res.value.admissionOutcome).toBe("rejected_validation");
  });

  it("re-running on the SAME outcomes admits no duplicate (idempotent — the store's deterministic id)", async () => {
    const mocks: Partial<Mocks> = {};
    // The store models idempotency: the first admit returns admitted:true; a second
    // admit of the same (deterministic) doc returns admitted:false (no new row).
    let calls = 0;
    const admit = vi.fn(async () => {
      calls += 1;
      return ok({ id: "deploy-doc-id", admitted: calls === 1 });
    });
    const sources = [
      traj({ trajectoryId: "a", sessionId: "s1", sender: "u1", signature: "deploy the app" }),
      traj({ trajectoryId: "b", sessionId: "s2", sender: "u2", signature: "deploy app" }),
    ];
    const deps1 = makeDeps(sources, { mentalModelStore: { get: vi.fn(async () => ok(undefined)), admit } }, mocks);

    const r1 = await runReflection(deps1);
    expect(r1.ok).toBe(true);
    if (!r1.ok) throw new Error("expected ok");
    expect(r1.value.admitted).toBe(1);

    const deps2 = makeDeps(sources, { mentalModelStore: { get: vi.fn(async () => ok(undefined)), admit } });
    const r2 = await runReflection(deps2);
    expect(r2.ok).toBe(true);
    if (!r2.ok) throw new Error("expected ok");
    // The 2nd run re-admits the SAME doc → admitted:false → counts 0 new.
    expect(r2.value.admitted).toBe(0);
  });

  it("does NOT emit any learning:skill_* event from the job (the daemon emits, Plan 05)", async () => {
    const emit = vi.fn();
    const deps = makeDeps(
      [
        traj({ trajectoryId: "a", sessionId: "s1", sender: "u1", signature: "deploy the app" }),
        traj({ trajectoryId: "b", sessionId: "s2", sender: "u2", signature: "deploy app" }),
      ],
      { eventBus: { emit } },
    );
    await runReflection(deps);
    const learningEmits = emit.mock.calls.filter((c) => String(c[0]).startsWith("learning:skill_"));
    expect(learningEmits).toHaveLength(0);
  });
});
