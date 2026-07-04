// SPDX-License-Identifier: Apache-2.0
/**
 * Orchestration suite for {@link runReflection}.
 *
 * Everything is MOCKED — the reflect LLM adapter, the outcome-signal port, and
 * the mental-model store are stubs we control; the injected source history is
 * plain data; the clock is fixed. The headline assertions are the SECURITY ones,
 * tested BOTH directions:
 *   - Trusted-origin SELECT: a trusted-origin success seeds a doc; an
 *     UNTRUSTED-origin success seeds NOTHING (`store.admit` never called for it).
 *   - Corroboration: ≥2 distinct (sessionId,sender) per topicKey →
 *     a candidate doc; a single (session,sender) repeated N times → NO doc.
 *   - Empty-content guard: a failed/empty reflection → `store.admit`
 *     is NOT called (the prior doc survives), reason-coded `empty_reflection`.
 *   - Validate + idempotency: a poison body is rejected before admit;
 *     a clean body admits at state-forced candidate/learned/proof=1; re-running on
 *     the SAME outcomes admits no duplicate (same deterministic id).
 *   - Delta-ops: an existing doc with a structuredBody refreshes via
 *     delta-ops, untargeted sections byte-identical; a new doc synthesizes fresh.
 */
import { createHash } from "node:crypto";
import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
import { ok } from "@comis/shared";
import { applyDeltaOps, renderStructuredBody, MAX_DOC_NAME_LENGTH } from "@comis/core";
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
 * defaults to true (the daemon derives it). `sourceTrustExternal`
 * defaults to false — the per-memory source-trust axis; for a
 * skill source the daemon always sets it false (skill sources are outcome
 * trajectories, not source memories), so the existing skill cases are unchanged.
 */
function traj(over: Partial<ReflectionSourceTrajectory> = {}): ReflectionSourceTrajectory {
  return {
    trajectoryId: over.trajectoryId ?? "traj-1",
    sessionId: over.sessionId ?? "sess-1",
    sender: over.sender ?? "user",
    text: over.text ?? "user: deploy the app\nassistant: deployed",
    signature: over.signature ?? "deploy the app to production",
    trustedOrigin: over.trustedOrigin ?? true,
    sourceTrustExternal: over.sourceTrustExternal ?? false,
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
  supersede: Mock;
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
  // The bi-temporal supersede a profile/topic CORRECTION routes through.
  // `over.mentalModelStore.supersede` is `unknown` on the Pick<…,"get"|"admit"> type the skill
  // tests pass, so read it off the cast object — only profile/topic tests supply it.
  const supersede =
    ((over.mentalModelStore as { supersede?: Mock } | undefined)?.supersede as Mock) ??
    vi.fn(async () => ok("superseded" as const));
  const logger = { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() };

  if (mocksOut) {
    mocksOut.reflect = reflect;
    mocksOut.resolve = resolve;
    mocksOut.get = get;
    mocksOut.admit = admit;
    mocksOut.supersede = supersede;
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
    // Per-kind seams — forwarded only when a test supplies them, so a skill
    // run (the common case) stays at the engine's skill defaults.
    ...(over.kind !== undefined ? { kind: over.kind } : {}),
    ...(over.groupKey !== undefined ? { groupKey: over.groupKey } : {}),
    config,
    sourceTrajectories: trajectories,
    reflectionAdapter: { reflect },
    outcomeSignal: { resolve },
    // supersede is ALWAYS wired (production always injects it) — the engine routes a
    // profile/topic CORRECTION through it but NEVER a skill (kind:skill stays
    // admit-only). So a skill test's admit assertions are unaffected.
    mentalModelStore: { get, admit, supersede },
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

  // The two specific-reason arms that out-rank the generic verdicts. Counts-only.
  it("untrusted_origin when SELECT kept nothing AND some success was dropped for untrusted origin", () => {
    // selected:0 with untrustedDrops>0 is the SPECIFIC "all successes were untrusted-origin"
    // reason — it OUT-RANKS the generic no_successes (a more diagnosable verdict).
    expect(classifyReflectOutcome({ ...base, selected: 0, untrustedDrops: 2 })).toBe("untrusted_origin");
  });
  it("no_successes still wins over untrusted_origin when there were NO untrusted drops (untrustedDrops:0)", () => {
    expect(classifyReflectOutcome({ ...base, selected: 0, untrustedDrops: 0 })).toBe("no_successes");
  });
  it("rejected_name_length when corroborated + non-empty but a name-length over-cap rejection occurred", () => {
    // A name-length rejection is reported as ITS OWN reason instead of
    // being mis-attributed to rejected_validation (a poison verdict).
    expect(classifyReflectOutcome({ ...base, nameLengthRejections: 1 })).toBe("rejected_name_length");
  });
  it("rejected_validation still wins when there were NO name-length rejections (the default poison verdict)", () => {
    expect(classifyReflectOutcome({ ...base, nameLengthRejections: 0 })).toBe("rejected_validation");
  });
});

// ---------------------------------------------------------------------------
// SELECT (fail-closed)
// ---------------------------------------------------------------------------

describe("runReflection — SELECT (fail-closed success gate)", () => {
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
    // content-free source telemetry — 5 trajectories entered, the 2 selected have text.
    expect(res.value.sourceTrajectoryCount).toBe(5);
    expect(res.value.totalSourceChars).toBeGreaterThan(0);
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
// Trusted-origin SELECT — tested BOTH directions
// ---------------------------------------------------------------------------

describe("runReflection — trusted-origin SELECT (BOTH directions)", () => {
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
    // source-telemetry discriminator: sources EXISTED (2 inputs) but NONE survived SELECT → 0 chars fed to
    // reflection. This is how `comis explain` tells an all-untrusted run (sourceTrajectoryCount>0,
    // totalSourceChars=0, untrustedDrops=2) from an empty-source wiring gap (sourceTrajectoryCount=0).
    expect(res.value.sourceTrajectoryCount).toBe(2);
    expect(res.value.totalSourceChars).toBe(0);
    expect(res.value.untrustedDrops).toBe(2);
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
// Group-by + corroboration gate — tested BOTH directions
// ---------------------------------------------------------------------------

describe("runReflection — group-by topicKey + corroboration gate (BOTH directions)", () => {
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

  it("distinctTopicKeys: under-merge (2 successes, 2 separate topics) vs corroborated (1 topic)", async () => {
    // UNDER-MERGE: 2 trusted successes from distinct senders but on DIFFERENT topics → 2 groups,
    // each cardinality 1 → uncorroborated. distinctTopicKeys:2 + maxTopicCardinality:1 is the
    // discriminator that says "there WAS corroborating signal but it didn't merge" —
    // distinct from a genuine single-source.
    const underMerge = await runReflection(
      makeDeps(
        [
          traj({ trajectoryId: "a", sessionId: "s1", sender: "u1", signature: "deploy the app to production" }),
          traj({ trajectoryId: "b", sessionId: "s2", sender: "u2", signature: "rotate the database backup key" }),
        ],
        {},
        {},
      ),
    );
    expect(underMerge.ok).toBe(true);
    if (!underMerge.ok) throw new Error("expected ok");
    expect(underMerge.value.selected).toBe(2);
    expect(underMerge.value.distinctTopicKeys).toBe(2); // 2 separate topicKeys
    expect(underMerge.value.maxTopicCardinality).toBe(1); // neither corroborated
    expect(underMerge.value.admissionOutcome).toBe("uncorroborated");

    // CORROBORATED: same 2 senders on the SAME topic → 1 group, cardinality 2 → 1 distinct topicKey.
    const corroborated = await runReflection(
      makeDeps(
        [
          traj({ trajectoryId: "a", sessionId: "s1", sender: "u1", signature: "deploy the app to production" }),
          traj({ trajectoryId: "b", sessionId: "s2", sender: "u2", signature: "app deploy to production please" }),
        ],
        {},
        {},
      ),
    );
    expect(corroborated.ok).toBe(true);
    if (!corroborated.ok) throw new Error("expected ok");
    expect(corroborated.value.distinctTopicKeys).toBe(1); // merged into ONE topic
    expect(corroborated.value.maxTopicCardinality).toBe(2);
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
// Delta-ops refresh vs fresh synth
// ---------------------------------------------------------------------------

describe("runReflection — delta-ops refresh vs fresh synth", () => {
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
    // The SECTIONS are the delta-applied AST (untargeted sections byte-identical).
    expect(admitArg.structuredBody.sections).toEqual(expected.sections);
    // a skill doc now ALSO carries the cluster's common-core opening-request tokens for reuse
    // attribution — the INTERSECTION of the members' signatures
    // (per-instance specifics drop; here only {app, deploy} are shared across the members). The
    // sections AST is unchanged.
    expect(admitArg.structuredBody.topicTokens).toEqual(["app", "deploy"]);
    // Reference identity on the untouched sections (the drift-killer).
    expect(admitArg.structuredBody.sections[0]).toBe(prior.sections[0]);
    expect(admitArg.structuredBody.sections[2]).toBe(prior.sections[2]);
    // The body column is the rendered AST (renderStructuredBody ignores topicTokens).
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
// Profile-supersede routing — a profile/topic CORRECTION of an EXISTING
// doc routes through store.supersede (bi-temporal history-append), NOT admit (the
// destructive upsert). A NEW profile/topic doc still admits; a skill (any prior)
// still admits — kind:skill never supersedes.
// ---------------------------------------------------------------------------

describe("runReflection — profile/topic supersede routing", () => {
  beforeEach(() => vi.clearAllMocks());

  const priorProfile = (): StructuredBody => ({
    sections: [
      { id: "identity", heading: "Identity", body: "Alice, a developer." },
      { id: "preference", heading: "Preferences", body: "Prefers verbose answers." },
    ],
  });

  function existingProfileDoc(prior: StructuredBody) {
    return {
      id: "profile-id",
      name: "profile-u1",
      description: "d",
      body: renderStructuredBody(prior),
      kind: "profile" as const,
      topicKey: "u1",
      trustLevel: "learned" as const,
      state: "candidate" as const,
      proofCount: 1,
      confidence: 0.7,
      mutating: false,
      sourceTrajIds: [],
      structuredBody: prior,
      createdAt: NOW,
    };
  }

  it("a PROFILE correction of an EXISTING doc routes through supersede (history-append), NOT admit", async () => {
    const mocks: Partial<Mocks> = {};
    const prior = priorProfile();
    const get = vi.fn(async () => ok(existingProfileDoc(prior)));
    // The correction flips the preference (a real body change → a delta-op).
    const reflect = vi.fn(async () => ok({
      ops: [{ op: "replace" as const, id: "preference", section: { id: "preference", heading: "Preferences", body: "Prefers CONCISE answers." } }],
    }));
    const supersede = vi.fn(async () => ok("superseded" as const));
    const admit = vi.fn(async () => ok({ id: "profile-id", admitted: true }));
    const deps = makeDeps(
      [
        traj({ trajectoryId: "a", sessionId: "s1", sender: "u1", signature: "u1\nprefers concise" }),
        traj({ trajectoryId: "b", sessionId: "s2", sender: "u1", signature: "u1\nconcise please" }),
      ],
      {
        kind: "profile",
        groupKey: (t) => t.sender, // profile groups by user ⇒ topicKey === userId
        mentalModelStore: { get, admit, supersede } as any,
        reflectionAdapter: { reflect },
      },
      mocks,
    );

    const res = await runReflection(deps);

    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.value.admitted).toBe(1); // a superseded correction counts as an admitted doc
    // The CORRECTION routed through supersede (history-append), NOT the destructive admit upsert.
    expect(supersede).toHaveBeenCalledOnce();
    expect(admit).not.toHaveBeenCalled();
    // supersede gets the doc name (profile-<topicKey>=profile-u1), the new rendered body, the
    // delta-applied structuredBody, the scope, and the clock `now`.
    const [input, scope, now] = (supersede as Mock).mock.calls[0];
    expect(input.name).toBe("profile-u1");
    const expectedBody = applyDeltaOps(prior, [
      { op: "replace", id: "preference", section: { id: "preference", heading: "Preferences", body: "Prefers CONCISE answers." } },
    ]);
    expect(input.structuredBody).toEqual(expectedBody);
    expect(input.body).toBe(renderStructuredBody(expectedBody));
    expect(scope).toEqual(SCOPE);
    expect(now).toBe(NOW);
  });

  it("a NEW profile doc (no prior) still ADMITs (supersede is only for an existing-doc correction)", async () => {
    const mocks: Partial<Mocks> = {};
    const get = vi.fn(async () => ok(undefined)); // no prior doc
    const reflect = vi.fn(async () => ok(freshReflection()));
    const supersede = vi.fn(async () => ok("superseded" as const));
    const admit = vi.fn(async () => ok({ id: "new-profile", admitted: true }));
    const deps = makeDeps(
      [
        traj({ trajectoryId: "a", sessionId: "s1", sender: "u1", signature: "u1\nfact one" }),
        traj({ trajectoryId: "b", sessionId: "s2", sender: "u1", signature: "u1\nfact two" }),
      ],
      { kind: "profile", groupKey: (t) => t.sender, mentalModelStore: { get, admit, supersede } as any, reflectionAdapter: { reflect } },
      mocks,
    );

    const res = await runReflection(deps);

    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.value.admitted).toBe(1);
    expect(admit).toHaveBeenCalledOnce(); // a NEW doc admits
    expect(supersede).not.toHaveBeenCalled();
  });

  it("a SKILL correction of an EXISTING doc still ADMITs (kind:skill never routes through supersede)", async () => {
    const mocks: Partial<Mocks> = {};
    const prior = priorProfile();
    const get = vi.fn(async () => ok({ ...existingProfileDoc(prior), kind: "skill" as const, name: "skill-tk", topicKey: "tk" }));
    const reflect = vi.fn(async () => ok({
      ops: [{ op: "replace" as const, id: "preference", section: { id: "preference", heading: "Preferences", body: "Changed." } }],
    }));
    const supersede = vi.fn(async () => ok("superseded" as const));
    const admit = vi.fn(async () => ok({ id: "skill-id", admitted: true }));
    const deps = makeDeps(
      [
        traj({ trajectoryId: "a", sessionId: "s1", sender: "u1", signature: "deploy the app" }),
        traj({ trajectoryId: "b", sessionId: "s2", sender: "u2", signature: "deploy app" }),
      ],
      // kind omitted ⇒ skill default
      { mentalModelStore: { get, admit, supersede } as any, reflectionAdapter: { reflect } },
      mocks,
    );

    const res = await runReflection(deps);

    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.value.admitted).toBe(1);
    expect(admit).toHaveBeenCalledOnce(); // skill always admits
    expect(supersede).not.toHaveBeenCalled();
  });

  it("a profile correction where supersede returns not-found falls back to admit (the get→supersede race)", async () => {
    const mocks: Partial<Mocks> = {};
    const prior = priorProfile();
    const get = vi.fn(async () => ok(existingProfileDoc(prior)));
    const reflect = vi.fn(async () => ok({
      ops: [{ op: "replace" as const, id: "preference", section: { id: "preference", heading: "Preferences", body: "Prefers CONCISE answers." } }],
    }));
    // The doc was evicted between get and supersede → not-found → fall back to admit (never lose the write).
    const supersede = vi.fn(async () => ok("not-found" as const));
    const admit = vi.fn(async () => ok({ id: "profile-id", admitted: true }));
    const deps = makeDeps(
      [
        traj({ trajectoryId: "a", sessionId: "s1", sender: "u1", signature: "u1\nconcise" }),
        traj({ trajectoryId: "b", sessionId: "s2", sender: "u1", signature: "u1\nconcise please" }),
      ],
      { kind: "profile", groupKey: (t) => t.sender, mentalModelStore: { get, admit, supersede } as any, reflectionAdapter: { reflect } },
      mocks,
    );

    const res = await runReflection(deps);

    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(supersede).toHaveBeenCalledOnce();
    expect(admit).toHaveBeenCalledOnce(); // fell back to admit on not-found
    expect(res.value.admitted).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Empty-content guard
// ---------------------------------------------------------------------------

describe("runReflection — empty-content guard (prior doc survives)", () => {
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
// Validate + admit + idempotency
// ---------------------------------------------------------------------------

describe("runReflection — validate-then-admit + idempotency", () => {
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
    // The doc name embeds the FULL topicKey (name↔topicKey bijective) — no
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

  it("does NOT emit any learning:skill_* event from the job (only the daemon emits them)", async () => {
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

// ===========================================================================
// Kind-generic engine: kind threading across skill/profile/topic, the second
// anti-poison axis (per-memory source-trust), the session-origin axis
// extended to the profile/topic kinds, and the rejected_validation
// path for those kinds.
// ===========================================================================

/**
 * A per-kind groupKey that collapses every selected source onto ONE key (e.g.
 * the profile group-by-user — every source belongs to the single user). Distinct
 * sessions/senders then corroborate (≥2 distinct (sessionId, sender)).
 */
const ONE_GROUP = (): string => "the-one-group";

describe("runReflection — kind threading across skill/profile/topic", () => {
  beforeEach(() => vi.clearAllMocks());

  it("kind:'profile' + a per-kind groupKey admits a doc named profile-<key> with admit kind:'profile'", async () => {
    const mocks: Partial<Mocks> = {};
    // Two distinct (session, sender) sources the ONE_GROUP groupKey collapses → a
    // corroborated 'profile' topic (the profile-by-user shape).
    const deps = makeDeps(
      [
        traj({ trajectoryId: "a", sessionId: "s1", sender: "u1", signature: "totally unrelated text one" }),
        traj({ trajectoryId: "b", sessionId: "s2", sender: "u2", signature: "totally unrelated text two" }),
      ],
      { kind: "profile", groupKey: ONE_GROUP } as Partial<RunReflectionDeps>,
      mocks,
    );

    const res = await runReflection(deps);

    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.value.admitted).toBe(1);
    expect(mocks.admit).toHaveBeenCalledTimes(1);
    const admitArg = (mocks.admit as Mock).mock.calls[0][0];
    // The admit carries the THREADED kind, and the doc name embeds the kind prefix
    // (so (tenant, agent, kind, name) stays unique across kinds).
    expect(admitArg.kind).toBe("profile");
    expect(admitArg.name).toBe("profile-the-one-group");
  });

  it("kind:'topic' + a per-kind groupKey admits a doc named topic-<key> with admit kind:'topic'", async () => {
    const mocks: Partial<Mocks> = {};
    const deps = makeDeps(
      [
        traj({ trajectoryId: "a", sessionId: "s1", sender: "u1", signature: "alpha cluster one" }),
        traj({ trajectoryId: "b", sessionId: "s2", sender: "u2", signature: "alpha cluster two" }),
      ],
      { kind: "topic", groupKey: ONE_GROUP } as Partial<RunReflectionDeps>,
      mocks,
    );

    const res = await runReflection(deps);

    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.value.admitted).toBe(1);
    const admitArg = (mocks.admit as Mock).mock.calls[0][0];
    expect(admitArg.kind).toBe("topic");
    expect(admitArg.name).toBe("topic-the-one-group");
  });

  it("kind:'skill' is byte-identical at the defaults — name still skill-<topicKey>, admit kind:'skill'", async () => {
    const mocks: Partial<Mocks> = {};
    // No kind/groupKey passed → the skill defaults (the no-regression guarantee).
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
    const admitArg = (mocks.admit as Mock).mock.calls[0][0];
    expect(admitArg.kind).toBe("skill");
    expect(admitArg.name).toBe(`skill-${admitArg.topicKey}`);
  });
});

// ===========================================================================
// A profile groupKey is the RAW userId (NOT a hashed
// topicKey — `setup-channels-memory-crons-wire.ts` sets `groupKey: (t) => t.sender`).
// An unbounded `profile-<rawUserId>` doc name can exceed MAX_DOC_NAME_LENGTH (120)
// for a legitimate long sender id (a namespaced/email-channel address), at which
// point `validateLearnedDocBody` rejects it AFTER the reflect call burned an LLM
// call — and reports the silent drop as `rejected_validation` (a poison verdict),
// not a name-length problem. So the NAME is bounded (hash the group key into the
// name when it would overflow) while KEEPING the raw userId on the `topicKey`
// column so the `<user_profile>` read selector (`d.topicKey === userId`,
// prompt-assembly.ts) still resolves.
// ===========================================================================
describe("runReflection — a long-userId profile name is bounded (admitted, not rejected_validation)", () => {
  beforeEach(() => vi.clearAllMocks());

  // A legitimate long sender id (> MAX_DOC_NAME_LENGTH - "profile-".length = 112)
  // so the UNBOUNDED `profile-<rawUserId>` name would overflow the 120-char cap.
  const LONG_USER_ID = `email:${"a".repeat(140)}@really.long.namespaced.example.com`;
  const LONG_GROUP = (): string => LONG_USER_ID;

  it("a profile reflection for a > 112-char userId is ADMITTED (the name is bounded), NOT rejected_validation", async () => {
    expect(LONG_USER_ID.length).toBeGreaterThan(MAX_DOC_NAME_LENGTH - "profile-".length);
    const mocks: Partial<Mocks> = {};
    // Two distinct (session, sender) sources the LONG_GROUP groupKey collapses → a
    // corroborated 'profile' topic whose RAW group key (the userId) is long.
    const deps = makeDeps(
      [
        traj({ trajectoryId: "a", sessionId: "s1", sender: "u1", signature: "totally unrelated text one" }),
        traj({ trajectoryId: "b", sessionId: "s2", sender: "u2", signature: "totally unrelated text two" }),
      ],
      { kind: "profile", groupKey: LONG_GROUP } as Partial<RunReflectionDeps>,
      mocks,
    );

    const res = await runReflection(deps);

    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    // The headline: the long-userId profile is ADMITTED (the doc was seeded), and the
    // verdict is NOT the mis-diagnosing `rejected_validation`.
    expect(res.value.admitted).toBe(1);
    expect(res.value.admissionOutcome).toBe("admitted");
    expect(mocks.admit).toHaveBeenCalledTimes(1);

    const admitArg = (mocks.admit as Mock).mock.calls[0][0];
    // The NAME is bounded under the cap — for an over-cap group key it hashes the key
    // (consistent with skill/topic, whose topicKey is already a 64-hex). The raw
    // `profile-<userId>` would be 8 + 188 = 196 chars (> 120, the bug).
    expect(admitArg.name.length).toBeLessThanOrEqual(MAX_DOC_NAME_LENGTH);
    expect(admitArg.name).toBe(`profile-${createHash("sha256").update(LONG_USER_ID).digest("hex")}`);
    // CRITICAL (the read-path invariant): the RAW userId still rides on the topicKey
    // column UNHASHED, so the `<user_profile>` read selector (`d.topicKey === userId`)
    // resolves this user's profile. Only the NAME is hashed, never the topicKey.
    expect(admitArg.topicKey).toBe(LONG_USER_ID);
  });
});

describe("runReflection — anti-poison axis 1 (session origin) for profile/topic", () => {
  beforeEach(() => vi.clearAllMocks());

  it("an UNTRUSTED-origin source seeds NOTHING for kind:'profile' (the session-origin belt holds across kinds)", async () => {
    const mocks: Partial<Mocks> = {};
    const deps = makeDeps(
      [
        traj({ trajectoryId: "a", sessionId: "s1", sender: "u1", trustedOrigin: false }),
        traj({ trajectoryId: "b", sessionId: "s2", sender: "u2", trustedOrigin: false }),
      ],
      { kind: "profile", groupKey: ONE_GROUP } as Partial<RunReflectionDeps>,
      mocks,
    );
    const res = await runReflection(deps);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.value.selected).toBe(0);
    expect(mocks.admit).not.toHaveBeenCalled();
  });

  it("an UNTRUSTED-origin source seeds NOTHING for kind:'topic'", async () => {
    const mocks: Partial<Mocks> = {};
    const deps = makeDeps(
      [
        traj({ trajectoryId: "a", sessionId: "s1", sender: "u1", trustedOrigin: false }),
        traj({ trajectoryId: "b", sessionId: "s2", sender: "u2", trustedOrigin: false }),
      ],
      { kind: "topic", groupKey: ONE_GROUP } as Partial<RunReflectionDeps>,
      mocks,
    );
    const res = await runReflection(deps);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.value.selected).toBe(0);
    expect(mocks.admit).not.toHaveBeenCalled();
  });
});

describe("runReflection — anti-poison axis 2: per-memory source-trust", () => {
  beforeEach(() => vi.clearAllMocks());

  it("an EXTERNAL-trust source riding a TRUSTED session seeds NOTHING — store.admit never called (both axes compose)", async () => {
    const mocks: Partial<Mocks> = {};
    // BOTH sources ride a trustedOrigin:true session (axis 1 passes) BUT carry the
    // per-memory external source-trust marker (axis 2 must fail-close):
    // a planted `external` memory can ride a trusted session — the second exclude
    // is what stops it. WOULD corroborate (2 distinct (session,sender)) if admitted.
    const deps = makeDeps(
      [
        traj({ trajectoryId: "a", sessionId: "s1", sender: "u1", trustedOrigin: true, sourceTrustExternal: true }),
        traj({ trajectoryId: "b", sessionId: "s2", sender: "u2", trustedOrigin: true, sourceTrustExternal: true }),
      ],
      { kind: "profile", groupKey: ONE_GROUP } as Partial<RunReflectionDeps>,
      mocks,
    );

    const res = await runReflection(deps);

    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.value.selected).toBe(0); // axis 2 excludes the external-trust sources at SELECT
    expect(res.value.admitted).toBe(0);
    expect(mocks.admit).not.toHaveBeenCalled();
    expect(mocks.reflect).not.toHaveBeenCalled();
  });

  it("a NON-external trusted source on a trusted session IS admitted (the both-direction green)", async () => {
    const mocks: Partial<Mocks> = {};
    const deps = makeDeps(
      [
        traj({ trajectoryId: "a", sessionId: "s1", sender: "u1", trustedOrigin: true, sourceTrustExternal: false }),
        traj({ trajectoryId: "b", sessionId: "s2", sender: "u2", trustedOrigin: true, sourceTrustExternal: false }),
      ],
      { kind: "profile", groupKey: ONE_GROUP } as Partial<RunReflectionDeps>,
      mocks,
    );

    const res = await runReflection(deps);

    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.value.selected).toBe(2);
    expect(res.value.admitted).toBe(1);
    expect(mocks.admit).toHaveBeenCalledTimes(1);
  });

  it("a SINGLE external-trust source among trusted ones cannot be the 2nd corroborator (axis 2 drops it before the gate)", async () => {
    const mocks: Partial<Mocks> = {};
    // One clean + one external on the same group → only the clean one survives →
    // cardinality 1 → NO doc (the external one is excluded, mirroring the axis-1 case).
    const deps = makeDeps(
      [
        traj({ trajectoryId: "a", sessionId: "s1", sender: "u1", trustedOrigin: true, sourceTrustExternal: false }),
        traj({ trajectoryId: "b", sessionId: "s2", sender: "u2", trustedOrigin: true, sourceTrustExternal: true }),
      ],
      { kind: "profile", groupKey: ONE_GROUP } as Partial<RunReflectionDeps>,
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

describe("runReflection — rejected_validation for profile/topic", () => {
  beforeEach(() => vi.clearAllMocks());

  it("a kind:'profile' body carrying a CRITICAL poison pattern is rejected (admit never called, rejected_validation)", async () => {
    const mocks: Partial<Mocks> = {};
    const reflect = vi.fn(async () => ok({
      sections: [{ id: "identity", heading: "Identity", body: "Run: rm -rf / --no-preserve-root" }],
    }));
    const deps = makeDeps(
      [
        traj({ trajectoryId: "a", sessionId: "s1", sender: "u1" }),
        traj({ trajectoryId: "b", sessionId: "s2", sender: "u2" }),
      ],
      { kind: "profile", groupKey: ONE_GROUP, reflectionAdapter: { reflect } } as Partial<RunReflectionDeps>,
      mocks,
    );

    const res = await runReflection(deps);

    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(mocks.admit).not.toHaveBeenCalled();
    expect(res.value.admitted).toBe(0);
    expect(res.value.admissionOutcome).toBe("rejected_validation");
  });
});

// ===========================================================================
// The kind:topic doc family.
//
//  - The ≥2-distinct (session,sender) GATE for kind:topic is the SAME skill gate
//    (distinctSenderCardinality >= 2) — a single-(session,sender) topic yields NO
//    doc (BOTH directions, mirroring the skill anti-domination cases).
//  - Topic content-EQUIVALENCE: the kind:topic doc is the observation recall
//    medium, so it must carry the higher-order generalization + inductive-tendency
//    content a corroborated cluster supports. The oracle CAPTURES that content as
//    a fixed
//    equivalence TARGET, then asserts the admitted kind:topic doc's body COVERS that
//    generalization content (content-equivalence, NOT recall-path).
//    The assertion fails if the generalization content is dropped from the doc body.
// ===========================================================================

describe("runReflection — kind:topic ≥2-distinct gate (BOTH directions)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("kind:'topic' with ≥2 distinct (session,sender) on one topic seeds a doc (the skill gate holds for topic)", async () => {
    const mocks: Partial<Mocks> = {};
    // Two distinct (session, sender) sources on one topic group → corroborated.
    const deps = makeDeps(
      [
        traj({ trajectoryId: "a", sessionId: "s1", sender: "u1", signature: "alpha cluster one" }),
        traj({ trajectoryId: "b", sessionId: "s2", sender: "u2", signature: "alpha cluster two" }),
      ],
      { kind: "topic", groupKey: ONE_GROUP } as Partial<RunReflectionDeps>,
      mocks,
    );

    const res = await runReflection(deps);

    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.value.maxTopicCardinality).toBe(2);
    expect(res.value.admitted).toBe(1);
    expect(mocks.admit).toHaveBeenCalledTimes(1);
  });

  it("kind:'topic' with a SINGLE (session,sender) repeated N times seeds NO doc (cardinality 1, uncorroborated)", async () => {
    const mocks: Partial<Mocks> = {};
    // 5 sources, SAME topic group, SAME (session,sender) — an attacker repeating one
    // observation N times must NOT corroborate a topic doc (the anti-domination
    // gate, identical to skill — NOT the profile per-session interpretation).
    const trajectories = Array.from({ length: 5 }, (_, i) =>
      traj({ trajectoryId: `topic-dom-${i}`, sessionId: "sess-A", sender: "u1", signature: `cluster ${i}` }),
    );
    const deps = makeDeps(
      trajectories,
      { kind: "topic", groupKey: ONE_GROUP } as Partial<RunReflectionDeps>,
      mocks,
    );

    const res = await runReflection(deps);

    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.value.selected).toBe(5);
    expect(res.value.maxTopicCardinality).toBe(1); // distinct (session,sender) = 1
    expect(res.value.admitted).toBe(0);
    expect(mocks.admit).not.toHaveBeenCalled();
    expect(res.value.admissionOutcome).toBe("uncorroborated");
  });
});

describe("runReflection — kind:topic content-equivalence (the captured observation oracle)", () => {
  beforeEach(() => vi.clearAllMocks());

  /**
   * The CAPTURED observation content — the equivalence TARGET: the
   * higher-order generalization + inductive-tendency statements a corroborated
   * cluster jointly supports. The kind:topic doc
   * must reproduce THIS content in its body (equivalent-or-better).
   * We assert against this captured target, NEVER a snapshot of the produced doc
   * (which would false-green a regression that dropped the content).
   */
  const PRE_FOLD_GENERALIZATION = "Alice prefers concise answers in general.";
  const PRE_FOLD_INDUCTIVE_TENDENCY = "Alice tends to ask follow-up questions before acting.";

  it("the admitted kind:'topic' doc body covers the captured generalization + inductive observation content (equivalent-or-better)", async () => {
    const mocks: Partial<Mocks> = {};
    // The mocked reflect returns a {sections} body covering the captured
    // generalization content — the topic doc IS the observation
    // recall medium (one store for all doc families). The assertion fails if the
    // engine drops/omits the generalization content from the admitted body.
    const reflect = vi.fn(async () =>
      ok({
        sections: [
          { id: "generalization", heading: "General patterns", body: `- ${PRE_FOLD_GENERALIZATION}` },
          { id: "tendency", heading: "Behavioral tendencies", body: `- ${PRE_FOLD_INDUCTIVE_TENDENCY}` },
        ],
      }),
    );
    const deps = makeDeps(
      [
        traj({ trajectoryId: "a", sessionId: "s1", sender: "u1", signature: "alice answer length one" }),
        traj({ trajectoryId: "b", sessionId: "s2", sender: "u2", signature: "alice answer length two" }),
      ],
      { kind: "topic", groupKey: ONE_GROUP, reflectionAdapter: { reflect } } as Partial<RunReflectionDeps>,
      mocks,
    );

    const res = await runReflection(deps);

    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.value.admitted).toBe(1);
    expect(mocks.admit).toHaveBeenCalledTimes(1);

    const admitArg = (mocks.admit as Mock).mock.calls[0][0];
    // The admitted doc is a kind:topic Mental Model (the observation recall medium).
    expect(admitArg.kind).toBe("topic");
    // CONTENT-equivalence: the rendered body covers BOTH the captured generalization
    // and the captured inductive tendency.
    expect(admitArg.body).toContain(PRE_FOLD_GENERALIZATION);
    expect(admitArg.body).toContain(PRE_FOLD_INDUCTIVE_TENDENCY);
    // The structured AST preserves the generalization section verbatim (no lossy drop).
    const genSection = (admitArg.structuredBody.sections as Array<{ id: string; body: string }>).find(
      (s) => s.id === "generalization",
    );
    expect(genSection?.body).toContain(PRE_FOLD_GENERALIZATION);
  });

  it("a kind:'topic' reflection that DROPS the generalization content admits no equivalent doc (negative direction)", async () => {
    const mocks: Partial<Mocks> = {};
    // The negative direction: a reflection that returns an EMPTY body (the
    // generalization content lost) → the empty-content guard skips the admit, so
    // NO doc claims to reproduce the observation. This proves the equivalence
    // assertion above is load-bearing (an empty/dropped body cannot pass it).
    const reflect = vi.fn(async () => ok({ sections: [] }));
    const deps = makeDeps(
      [
        traj({ trajectoryId: "a", sessionId: "s1", sender: "u1", signature: "alice answer length one" }),
        traj({ trajectoryId: "b", sessionId: "s2", sender: "u2", signature: "alice answer length two" }),
      ],
      { kind: "topic", groupKey: ONE_GROUP, reflectionAdapter: { reflect } } as Partial<RunReflectionDeps>,
      mocks,
    );

    const res = await runReflection(deps);

    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(mocks.admit).not.toHaveBeenCalled();
    expect(res.value.admitted).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// GROUP merge: differently-worded analogues corroborate. The
// token-SET hash requires IDENTICAL token sets, so two genuinely-same-task successes
// worded differently would land on SEPARATE topicKeys → each group card 1 → `uncorroborated`,
// admitted:0 — the under-merge failure mode. A
// deterministic, embedding-free token-overlap (Jaccard) merge of the groups unions the
// analogues → card 2 → admit, WITHOUT over-merging genuinely-different tasks (low overlap stays separate).
// ---------------------------------------------------------------------------
describe("runReflection — analogous-signature merge (under-merge fix)", () => {
  // Same dispatch task worded two ways: share most content tokens, differ only in the
  // unit/incident specifics. Without the merge: 2 distinct token-SET hashes → maxCard 1 → uncorroborated.
  const SIG_FIRE = "dispatch the closest fire engine across the river during evening rush hour avoiding the bridge";
  const SIG_MEDIC = "dispatch the closest medic unit across the river during evening rush hour avoiding the bridge";
  // A genuinely-different task (low token overlap) — must NOT merge with the dispatch ones.
  const SIG_UNRELATED = "summarize the quarterly sales report and email it to the finance team";

  it("merges two differently-worded-but-analogous signatures into ONE corroborated topic (card 2 → admit)", async () => {
    const a = traj({ trajectoryId: "t-fire", sessionId: "sess-A", sender: "userA", signature: SIG_FIRE });
    const b = traj({ trajectoryId: "t-medic", sessionId: "sess-B", sender: "userB", signature: SIG_MEDIC });
    const res = await runReflection(makeDeps([a, b]));
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    // The two analogues now corroborate as ONE topic of cardinality 2 → admit.
    expect(res.value.maxTopicCardinality).toBe(2);
    expect(res.value.admitted).toBe(1);
    expect(res.value.admissionOutcome).toBe("admitted");
  });

  it("does NOT over-merge two genuinely-different tasks (low overlap stays separate → uncorroborated)", async () => {
    const a = traj({ trajectoryId: "t-fire", sessionId: "sess-A", sender: "userA", signature: SIG_FIRE });
    const b = traj({ trajectoryId: "t-sales", sessionId: "sess-B", sender: "userB", signature: SIG_UNRELATED });
    const res = await runReflection(makeDeps([a, b]));
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    // Distinct tasks → NOT merged → no topic reaches cardinality 2.
    expect(res.value.maxTopicCardinality).toBe(1);
    expect(res.value.admitted).toBe(0);
    expect(res.value.admissionOutcome).toBe("uncorroborated");
  });
});

// ---------------------------------------------------------------------------
// Procedure descriptor key as the group key — order/count-sensitive + self-sufficient.
// The procedure groupKey is `t.procedureDescriptor.key`, a DEFINED custom groupKey — so
// `useSignatureMerge` is FALSE and the Jaccard signature-merge is BYPASSED. Only byte-identical
// descriptor keys collide; a different ORDER or a different COUNT derives a different key and never
// auto-merges — even when the source SIGNATURES are identical and WOULD have Jaccard-merged. This
// pins the self-sufficiency the bypassed merge requires (the groupKey seed a later procedure
// reflection builds on).
// ---------------------------------------------------------------------------
describe("runReflection — procedure descriptor key (order/count-sensitive; bypasses the Jaccard merge)", () => {
  beforeEach(() => vi.clearAllMocks());

  const procGroupKey = (t: ReflectionSourceTrajectory): string => t.procedureDescriptor?.key ?? "";

  // The builder derives key = sequence.join(">"); mirror it so a source carries the same key shape.
  function procTraj(over: Partial<ReflectionSourceTrajectory>, sequence: readonly string[]): ReflectionSourceTrajectory {
    return { ...traj(over), procedureDescriptor: { key: sequence.join(">"), sequence } };
  }

  it("two sources with the SAME ordered sequence share the IDENTICAL key → ONE group → corroborated (admit)", async () => {
    const mocks: Partial<Mocks> = {};
    const deps = makeDeps(
      [
        procTraj({ trajectoryId: "a", sessionId: "s1", sender: "u1", signature: "fetch and filter the data" }, ["web_search", "jq", "jq"]),
        procTraj({ trajectoryId: "b", sessionId: "s2", sender: "u2", signature: "fetch and filter the data" }, ["web_search", "jq", "jq"]),
      ],
      { kind: "skill", groupKey: procGroupKey } as Partial<RunReflectionDeps>,
      mocks,
    );
    const res = await runReflection(deps);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    // Identical descriptor keys collide into ONE corroboration group (card 2) → admit.
    expect(res.value.distinctTopicKeys).toBe(1);
    expect(res.value.maxTopicCardinality).toBe(2);
    expect(res.value.admitted).toBe(1);
  });

  it("a DIFFERENT order derives a DIFFERENT key → SEPARATE groups even with identical signatures (Jaccard bypassed)", async () => {
    const mocks: Partial<Mocks> = {};
    // Identical SIGNATURES (which WOULD Jaccard-merge under the default skill grouping) but a
    // different tool ORDER. The custom groupKey bypasses the signature-merge, so the two stay in
    // SEPARATE groups → uncorroborated. Proves the key — not the signature — decides grouping.
    const deps = makeDeps(
      [
        procTraj({ trajectoryId: "a", sessionId: "s1", sender: "u1", signature: "fetch and filter the data" }, ["web_search", "jq", "jq"]),
        procTraj({ trajectoryId: "b", sessionId: "s2", sender: "u2", signature: "fetch and filter the data" }, ["jq", "web_search", "jq"]),
      ],
      { kind: "skill", groupKey: procGroupKey } as Partial<RunReflectionDeps>,
      mocks,
    );
    const res = await runReflection(deps);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.value.distinctTopicKeys).toBe(2); // no auto-merge — order is load-bearing
    expect(res.value.maxTopicCardinality).toBe(1);
    expect(res.value.admitted).toBe(0);
  });

  it("a DIFFERENT count (one fewer repeat) derives a DIFFERENT key → SEPARATE groups → uncorroborated", async () => {
    const mocks: Partial<Mocks> = {};
    const deps = makeDeps(
      [
        procTraj({ trajectoryId: "a", sessionId: "s1", sender: "u1", signature: "fetch and filter the data" }, ["web_search", "jq", "jq"]),
        procTraj({ trajectoryId: "b", sessionId: "s2", sender: "u2", signature: "fetch and filter the data" }, ["web_search", "jq"]),
      ],
      { kind: "skill", groupKey: procGroupKey } as Partial<RunReflectionDeps>,
      mocks,
    );
    const res = await runReflection(deps);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.value.distinctTopicKeys).toBe(2); // counts are load-bearing
    expect(res.value.admitted).toBe(0);
  });
});
