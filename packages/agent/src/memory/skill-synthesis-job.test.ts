// SPDX-License-Identifier: Apache-2.0
/**
 * Orchestration suite for {@link runSkillSynthesis} (v2.26 Verified Learning
 * WS2, SKILL-03/04/05/08).
 *
 * Everything is MOCKED — the synthesis adapter, the outcome-signal port, the
 * validation port, the store, and the approval gate are all stubs we control;
 * the injected source history is plain data; the clock is fixed. The headline
 * assertions are the SECURITY ones:
 *   - Abstain (SKILL-05 / Defer ≠ Retry): a small/nano model without a capable
 *     override SKIPS benignly — no synthesize call, no failure metric, no breaker.
 *   - Fail-closed selection (SKILL-03): only `success` ≥ minConfidence is fed to
 *     synthesis; `failure`/`unknown` trajectories are skipped.
 *   - Anti-domination (SKILL-04): N near-identical successes from ONE
 *     (session_id, sender) cluster to cardinality 1, not N.
 *   - Triple-cap (SKILL-05): the synthesis loop terminates at the iteration cap.
 *
 * The admission half (validate → admit / ApprovalGate) is exercised in the
 * Task-3 additions below.
 */
import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
import { ok, err } from "@comis/shared";
import type {
  ResolvedOutcome,
  CandidateSkill,
  SkillValidationResult,
  SynthesisInput,
} from "@comis/core";
import {
  runSkillSynthesis,
  classifyAdmissionOutcome,
  type SkillSynthesisJobDeps,
  type SkillSynthesisJobConfig,
  type SynthesisSourceTrajectory,
} from "./skill-synthesis-job.js";

// ── RC-4: admissionOutcome classifier (the diagnosability verdict; live 2026-06-25) ──
describe("classifyAdmissionOutcome (RC-4 — why a synthesis run admitted nothing)", () => {
  const base = { selected: 2, hadEmbeddings: true, maxClusterCardinality: 2, synthesized: 1, admitted: 0, approvalRequested: 0 };
  it("admitted wins (success short-circuits)", () => {
    expect(classifyAdmissionOutcome({ ...base, admitted: 1 })).toBe("admitted");
  });
  it("no_successful_sources when SELECT kept nothing", () => {
    expect(classifyAdmissionOutcome({ ...base, selected: 0 })).toBe("no_successful_sources");
  });
  it("no_embeddings (SYNTH-EMBED-DEAD signature) — sources but none carry an embedding → all singletons", () => {
    expect(classifyAdmissionOutcome({ ...base, hadEmbeddings: false, maxClusterCardinality: 1 })).toBe("no_embeddings");
  });
  it("uncorroborated when embeddings exist but no cluster reached cardinality 2", () => {
    expect(classifyAdmissionOutcome({ ...base, maxClusterCardinality: 1 })).toBe("uncorroborated");
  });
  it("no_procedure_synthesized when a corroborated cluster yielded no candidate", () => {
    expect(classifyAdmissionOutcome({ ...base, synthesized: 0 })).toBe("no_procedure_synthesized");
  });
  it("mutating_deferred when a candidate routed to the approval gate", () => {
    expect(classifyAdmissionOutcome({ ...base, approvalRequested: 1 })).toBe("mutating_deferred");
  });
  it("validation_failed when synthesized but the admission predicate failed (e.g. unvalidated script)", () => {
    expect(classifyAdmissionOutcome(base)).toBe("validation_failed");
  });
});

const NOW = 1_700_000_000_000;
const SCOPE = { tenantId: "t1", agentId: "a1", now: NOW };

/** A success outcome the mocked resolver returns. */
function success(confidence = 0.9): ResolvedOutcome {
  return { outcome: "success", confidence, sources: ["tool"], recalledIds: [], usedSkillIds: [] };
}
function failure(): ResolvedOutcome {
  return { outcome: "failure", confidence: 0.9, sources: ["tool"], recalledIds: [], usedSkillIds: [] };
}
function unknown(): ResolvedOutcome {
  return { outcome: "unknown", confidence: 0, sources: [], recalledIds: [], usedSkillIds: [] };
}

/** A clean read-only candidate the synthesis adapter returns by default. */
function readOnlyCandidate(name = "do-x"): CandidateSkill {
  return {
    name,
    description: "Use when the user asks to do X.",
    body: "1. read.\n2. report.",
    scripts: [],
    requiredTools: ["read"],
  };
}

/** A clean validation verdict (read-only, static-only coverage). */
function cleanValidation(over: Partial<SkillValidationResult> = {}): SkillValidationResult {
  return {
    staticOk: true,
    dynamicOk: false,
    reproducedEffect: false,
    findings: [],
    sandboxProvider: "none",
    coverage: "static-only",
    ...over,
  };
}

/**
 * A clean DYNAMIC verdict — the sandbox ran the procedure AND reproduced its
 * effect. A MUTATING candidate is only admissible with this (the predicate
 * requires `reproducedEffect` when not read-only); approval is then the
 * additional gate on top.
 */
function reproducedValidation(over: Partial<SkillValidationResult> = {}): SkillValidationResult {
  return {
    staticOk: true,
    dynamicOk: true,
    reproducedEffect: true,
    findings: [],
    sandboxProvider: "bwrap",
    coverage: "full",
    ...over,
  };
}

function traj(over: Partial<SynthesisSourceTrajectory> = {}): SynthesisSourceTrajectory {
  return {
    trajectoryId: over.trajectoryId ?? "traj-1",
    sessionId: over.sessionId ?? "sess-1",
    sender: over.sender ?? "user",
    text: over.text ?? "user: do x\nassistant: did x",
    embedding: over.embedding,
  };
}

interface Mocks {
  synthesize: Mock;
  resolve: Mock;
  validate: Mock;
  admit: Mock;
  requestApproval: Mock;
  failureMetric: Mock;
  breakerTrip: Mock;
  logger: { info: Mock; debug: Mock; warn: Mock; error: Mock };
}

function makeDeps(
  trajectories: SynthesisSourceTrajectory[],
  over: Partial<SkillSynthesisJobDeps> = {},
  mocksOut?: Partial<Mocks>,
): SkillSynthesisJobDeps {
  const synthesize = (over.synthesisAdapter?.synthesize as Mock) ?? vi.fn(async () => ok([readOnlyCandidate()]));
  const resolve = (over.outcomeSignal?.resolve as Mock) ?? vi.fn(async () => ok(success()));
  const validate = (over.validationAdapter?.validate as Mock) ?? vi.fn(async () => ok(cleanValidation()));
  const admit = (over.learnedSkillStore?.admit as Mock) ?? vi.fn(async () => ok({ id: "id-1", admitted: true }));
  const requestApproval =
    (over.approvalGate?.requestApproval as Mock) ??
    vi.fn(async () => ({ requestId: "r", approved: false, approvedBy: "system:timeout", resolvedAt: NOW }));
  const failureMetric = (mocksOut?.failureMetric as Mock) ?? vi.fn();
  const breakerTrip = (mocksOut?.breakerTrip as Mock) ?? vi.fn();
  const logger = { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() };

  if (mocksOut) {
    mocksOut.synthesize = synthesize;
    mocksOut.resolve = resolve;
    mocksOut.validate = validate;
    mocksOut.admit = admit;
    mocksOut.requestApproval = requestApproval;
    mocksOut.failureMetric = failureMetric;
    mocksOut.breakerTrip = breakerTrip;
    mocksOut.logger = logger;
  }

  // Merge config carefully (a partial `over.config` must NOT drop the defaults).
  const config: SkillSynthesisJobConfig = {
    enabled: true,
    autoAdmitReadOnly: true,
    minConfidence: 0.7,
    requireForMutating: true,
    ...(over.config ?? {}),
  };

  return {
    agentId: "a1",
    tenantId: "t1",
    scope: SCOPE,
    config,
    capabilityClass: over.capabilityClass ?? "frontier",
    hasCapableModelOverride: over.hasCapableModelOverride ?? false,
    sourceTrajectories: trajectories,
    synthesisAdapter: { synthesize },
    outcomeSignal: { resolve },
    validationAdapter: { validate },
    learnedSkillStore: { admit },
    approvalGate: { requestApproval },
    clock: over.clock ?? { now: () => NOW },
    eventBus: over.eventBus ?? { emit: vi.fn() },
    logger,
    onSynthesisFailure: failureMetric,
    onBreakerTrip: breakerTrip,
    maxIterations: over.maxIterations,
    maxContextTokens: over.maxContextTokens,
    wallClockMs: over.wallClockMs,
    similarityThreshold: over.similarityThreshold,
  } as SkillSynthesisJobDeps;
}

describe("runSkillSynthesis — abstain gate (SKILL-05, Defer ≠ Retry)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("abstains on a small model without a capable override — benign skip, no failure metric/breaker", async () => {
    const mocks: Partial<Mocks> = {};
    const deps = makeDeps([traj()], { capabilityClass: "small", hasCapableModelOverride: false }, mocks);

    const res = await runSkillSynthesis(deps);

    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.value.abstained).toBe(true);
    expect(res.value.synthesized).toBe(0);
    // The synthesis LLM is never invoked.
    expect(mocks.synthesize).not.toHaveBeenCalled();
    // Defer ≠ Retry: abstain inflates NO failure metric and trips NO breaker.
    expect(mocks.failureMetric).not.toHaveBeenCalled();
    expect(mocks.breakerTrip).not.toHaveBeenCalled();
  });

  it("abstains on nano without an override", async () => {
    const mocks: Partial<Mocks> = {};
    const deps = makeDeps([traj()], { capabilityClass: "nano" }, mocks);
    const res = await runSkillSynthesis(deps);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.value.abstained).toBe(true);
    expect(mocks.synthesize).not.toHaveBeenCalled();
  });

  it("does NOT abstain on a small model WITH a capable override", async () => {
    const mocks: Partial<Mocks> = {};
    const deps = makeDeps([traj()], { capabilityClass: "small", hasCapableModelOverride: true }, mocks);
    const res = await runSkillSynthesis(deps);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.value.abstained).toBe(false);
    expect(mocks.synthesize).toHaveBeenCalled();
  });
});

describe("runSkillSynthesis — fail-closed selection (SKILL-03)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("synthesizes ONLY success trajectories at/above minConfidence", async () => {
    const mocks: Partial<Mocks> = {};
    const resolve = vi.fn(async (id: string) => {
      if (id === "ok-traj") return ok(success(0.9));
      if (id === "fail-traj") return ok(failure());
      if (id === "unknown-traj") return ok(unknown());
      if (id === "low-conf") return ok(success(0.3)); // below minConfidence 0.7
      return ok(unknown());
    });
    const deps = makeDeps(
      [
        traj({ trajectoryId: "ok-traj", sessionId: "s1", sender: "user" }),
        traj({ trajectoryId: "fail-traj", sessionId: "s2", sender: "user" }),
        traj({ trajectoryId: "unknown-traj", sessionId: "s3", sender: "user" }),
        traj({ trajectoryId: "low-conf", sessionId: "s4", sender: "user" }),
      ],
      { outcomeSignal: { resolve } },
      mocks,
    );

    const res = await runSkillSynthesis(deps);

    expect(res.ok).toBe(true);
    // Exactly ONE cluster (the single success) reaches synthesize — the
    // failure, unknown, and low-confidence trajectories are all skipped.
    expect(mocks.synthesize).toHaveBeenCalledTimes(1);
    const passed = (mocks.synthesize as Mock).mock.calls[0][0] as SynthesisInput;
    expect(passed.clusterTrajIds).toEqual(["ok-traj"]);
  });

  it("synthesizes nothing when no trajectory resolves to success", async () => {
    const mocks: Partial<Mocks> = {};
    const resolve = vi.fn(async () => ok(failure()));
    const deps = makeDeps([traj({ trajectoryId: "a" }), traj({ trajectoryId: "b" })], { outcomeSignal: { resolve } }, mocks);
    const res = await runSkillSynthesis(deps);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.value.synthesized).toBe(0);
    expect(mocks.synthesize).not.toHaveBeenCalled();
  });
});

describe("runSkillSynthesis — anti-domination clustering (SKILL-04)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("collapses N near-identical successes from ONE (session_id, sender) to cardinality 1", async () => {
    const mocks: Partial<Mocks> = {};
    // 5 near-identical successes from the SAME session + sender. An attacker
    // repeating one "success" N times must NOT mint cardinality N.
    const emb = [1, 0, 0];
    const trajectories = Array.from({ length: 5 }, (_, i) =>
      traj({ trajectoryId: `dom-${i}`, sessionId: "sess-A", sender: "user", embedding: emb }),
    );
    const deps = makeDeps(trajectories, {}, mocks);

    const res = await runSkillSynthesis(deps);

    expect(res.ok).toBe(true);
    // One cluster, and its distinct-(session,sender) cardinality is 1.
    expect(mocks.synthesize).toHaveBeenCalledTimes(1);
    if (!res.ok) throw new Error("expected ok");
    expect(res.value.maxClusterCardinality).toBe(1);
  });

  it("counts distinct (session_id, sender) pairs — same session, different senders = cardinality 2", async () => {
    const mocks: Partial<Mocks> = {};
    const emb = [1, 0, 0];
    const deps = makeDeps(
      [
        traj({ trajectoryId: "x", sessionId: "sess-A", sender: "user", embedding: emb }),
        traj({ trajectoryId: "y", sessionId: "sess-A", sender: "model", embedding: emb }),
      ],
      {},
      mocks,
    );
    const res = await runSkillSynthesis(deps);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.value.maxClusterCardinality).toBe(2);
  });
});

describe("runSkillSynthesis — triple-cap (SKILL-05)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("terminates the synthesis loop at the iteration cap", async () => {
    const mocks: Partial<Mocks> = {};
    // 50 distinct-session successes with NO embedding → 50 singleton clusters
    // (no cosine neighbour); the iteration cap (10) bounds how many reach
    // synthesize, and the loop terminates with boundedBy === "iterations".
    const trajectories = Array.from({ length: 50 }, (_, i) =>
      traj({ trajectoryId: `t-${i}`, sessionId: `s-${i}`, sender: "user" }),
    );
    const deps = makeDeps(trajectories, { maxIterations: 10 }, mocks);

    const res = await runSkillSynthesis(deps);

    expect(res.ok).toBe(true);
    // Bounded: never more than the iteration cap.
    expect((mocks.synthesize as Mock).mock.calls.length).toBeLessThanOrEqual(10);
    if (!res.ok) throw new Error("expected ok");
    expect(res.value.boundedBy).toBe("iterations");
  });
});

// ---------------------------------------------------------------------------
// Task 3 — validate + admission gate (SKILL-08)
// ---------------------------------------------------------------------------

/** A mutating candidate (a write tool ⇒ not read-only). */
function mutatingCandidate(name = "write-x"): CandidateSkill {
  return {
    name,
    description: "Use when the user asks to write X.",
    body: "1. write the file.",
    scripts: [],
    requiredTools: ["write"],
  };
}

/** A non-deterministic mutating candidate (a network tool). */
function networkMutatingCandidate(name = "post-x"): CandidateSkill {
  return {
    name,
    description: "Use when the user asks to post X to a webhook.",
    body: "1. POST to the webhook.",
    scripts: [],
    requiredTools: ["web_fetch", "write"],
  };
}

describe("runSkillSynthesis — admission predicate (SKILL-08, the first-RED)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("AUTO-ADMITS a clean read-only candidate at low proof_count (autoAdmitReadOnly:true)", async () => {
    const mocks: Partial<Mocks> = {};
    const synthesize = vi.fn(async () => ok([readOnlyCandidate("read-only-skill")]));
    const validate = vi.fn(async () => ok(cleanValidation())); // staticOk, no scripts, read-only
    const deps = makeDeps(
      [traj()],
      { synthesisAdapter: { synthesize }, validationAdapter: { validate }, config: { autoAdmitReadOnly: true } as never },
      mocks,
    );

    const res = await runSkillSynthesis(deps);

    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.value.admitted).toBe(1);
    expect(mocks.admit).toHaveBeenCalledTimes(1);
    const admitArg = (mocks.admit as Mock).mock.calls[0][0];
    // The SKILL-04 anti-domination cap: proofCount is LOW (1), not the cluster size.
    expect(admitArg.proofCount).toBe(1);
    // trust=learned / state=candidate are FORCED by the store (verified in 201-02);
    // the caller supplies neither (AdmitMentalModelInput omits trustLevel + id).
    expect(admitArg).not.toHaveProperty("trustLevel");
    // The approval gate is NOT consulted for a read-only candidate.
    expect(mocks.requestApproval).not.toHaveBeenCalled();
  });

  it("does NOT admit a read-only candidate when autoAdmitReadOnly is false", async () => {
    const mocks: Partial<Mocks> = {};
    const deps = makeDeps([traj()], { config: { autoAdmitReadOnly: false } as never }, mocks);
    const res = await runSkillSynthesis(deps);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.value.admitted).toBe(0);
    expect(mocks.admit).not.toHaveBeenCalled();
  });

  it("routes a MUTATING candidate to the ApprovalGate — NOT admitted when the gate denies", async () => {
    const mocks: Partial<Mocks> = {};
    const synthesize = vi.fn(async () => ok([mutatingCandidate()]));
    // A mutating candidate is only ADMISSIBLE with a reproduced dynamic verdict
    // (the predicate requires reproducedEffect when not read-only); approval is
    // the additional gate on top.
    const validate = vi.fn(async () => ok(reproducedValidation()));
    const requestApproval = vi.fn(async () => ({ approved: false }));
    const deps = makeDeps(
      [traj()],
      { synthesisAdapter: { synthesize }, validationAdapter: { validate }, approvalGate: { requestApproval } },
      mocks,
    );

    const res = await runSkillSynthesis(deps);

    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(mocks.requestApproval).toHaveBeenCalledTimes(1);
    expect(res.value.admitted).toBe(0); // denied → not admitted
    expect(mocks.admit).not.toHaveBeenCalled();
  });

  it("admits a MUTATING candidate ONLY after the ApprovalGate approves", async () => {
    const mocks: Partial<Mocks> = {};
    const synthesize = vi.fn(async () => ok([mutatingCandidate()]));
    const validate = vi.fn(async () => ok(reproducedValidation()));
    const requestApproval = vi.fn(async () => ({ approved: true }));
    const deps = makeDeps(
      [traj()],
      { synthesisAdapter: { synthesize }, validationAdapter: { validate }, approvalGate: { requestApproval } },
      mocks,
    );

    const res = await runSkillSynthesis(deps);

    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(mocks.requestApproval).toHaveBeenCalledTimes(1);
    expect(res.value.admitted).toBe(1);
    expect(mocks.admit).toHaveBeenCalledTimes(1);
  });

  it("NEVER auto-admits a NON-DETERMINISTIC mutating candidate — approval-only even when admissible", async () => {
    const mocks: Partial<Mocks> = {};
    const synthesize = vi.fn(async () => ok([networkMutatingCandidate()]));
    // Even with a reproduced dynamic verdict (admissible), a non-deterministic
    // mutating candidate must route through approval, never auto-admit.
    const validate = vi.fn(async () => ok(reproducedValidation()));
    const requestApproval = vi.fn(async () => ({ approved: false }));
    const deps = makeDeps(
      [traj()],
      { synthesisAdapter: { synthesize }, validationAdapter: { validate }, approvalGate: { requestApproval } },
      mocks,
    );

    const res = await runSkillSynthesis(deps);

    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(mocks.requestApproval).toHaveBeenCalledTimes(1);
    const approvalParams = (mocks.requestApproval as Mock).mock.calls[0][0];
    expect(approvalParams.params.nonDeterministic).toBe(true);
    expect(res.value.admitted).toBe(0);
    expect(mocks.admit).not.toHaveBeenCalled();
  });

  it("does NOT admit a candidate that fails the static scan (staticOk:false)", async () => {
    const mocks: Partial<Mocks> = {};
    const validate = vi.fn(async () => ok(cleanValidation({ staticOk: false })));
    const deps = makeDeps([traj()], { validationAdapter: { validate } }, mocks);
    const res = await runSkillSynthesis(deps);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.value.admitted).toBe(0);
    expect(mocks.admit).not.toHaveBeenCalled();
  });

  it("does NOT admit a read-only candidate WITH embedded scripts that the sandbox could not run (dynamicOk:false, coverage static-only)", async () => {
    const mocks: Partial<Mocks> = {};
    // A candidate with embedded scripts but no clean dynamic run: noEmbeddedScripts
    // is false AND dynamicOk is false → (dynamicOk || noEmbeddedScripts) is false
    // → NOT admissible (fail-closed).
    const withScripts: CandidateSkill = {
      ...readOnlyCandidate("scripted"),
      scripts: [{ path: "run.sh", lang: "bash", content: "echo hi" }],
    };
    const synthesize = vi.fn(async () => ok([withScripts]));
    const validate = vi.fn(async () => ok(cleanValidation({ staticOk: true, dynamicOk: false })));
    const deps = makeDeps([traj()], { synthesisAdapter: { synthesize }, validationAdapter: { validate } }, mocks);

    const res = await runSkillSynthesis(deps);

    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.value.admitted).toBe(0);
    expect(mocks.admit).not.toHaveBeenCalled();
  });
});

describe("runSkillSynthesis — WR-01 surfaces per-candidate validation verdicts", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns a validations[] entry (booleans + coverage) for an ADMITTED read-only candidate", async () => {
    const mocks: Partial<Mocks> = {};
    const validate = vi.fn(async () => ok(cleanValidation({ staticOk: true })));
    const deps = makeDeps([traj()], { validationAdapter: { validate } }, mocks);

    const res = await runSkillSynthesis(deps);

    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.value.validations).toEqual([
      { staticOk: true, dynamicOk: false, coverage: "static-only" },
    ]);
  });

  it("returns a validations[] entry for a FAILED (staticOk:false) candidate — the failure path is reachable", async () => {
    const mocks: Partial<Mocks> = {};
    // A candidate that fails the static scan is still VALIDATED (the adapter
    // returned a verdict) — it must surface a validations[] entry so the daemon
    // emits learning:skill_validated{staticOk:false} (the learned_skill_failing
    // obs path).
    const validate = vi.fn(async () => ok(cleanValidation({ staticOk: false })));
    const deps = makeDeps([traj()], { validationAdapter: { validate } }, mocks);

    const res = await runSkillSynthesis(deps);

    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.value.admitted).toBe(0); // not admitted (failed static)
    expect(res.value.validations).toEqual([
      { staticOk: false, dynamicOk: false, coverage: "static-only" },
    ]);
  });

  it("returns an empty validations[] on a nothing-selected run (no candidate validated)", async () => {
    const mocks: Partial<Mocks> = {};
    const resolve = vi.fn(async () => ok(failure())); // nothing selected
    const deps = makeDeps([traj()], { outcomeSignal: { resolve } }, mocks);

    const res = await runSkillSynthesis(deps);

    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.value.validations).toEqual([]);
  });
});

describe("runSkillSynthesis — IN-01 admission confidence is verdict-derived (not a hardcoded 1)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("seeds a static-only read-only admit at 0.7 (NOT 1)", async () => {
    const mocks: Partial<Mocks> = {};
    const validate = vi.fn(async () => ok(cleanValidation())); // static-only, read-only
    const deps = makeDeps([traj()], { validationAdapter: { validate } }, mocks);

    const res = await runSkillSynthesis(deps);

    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(mocks.admit).toHaveBeenCalledTimes(1);
    const admitArg = (mocks.admit as Mock).mock.calls[0][0];
    expect(admitArg.confidence).toBe(0.7); // verdict-derived seed, not the old literal 1
    expect(admitArg.proofCount).toBe(1); // the LOW cap is unchanged
  });

  it("seeds a dynamically-reproduced mutating admit at 1.0 (full reproduction)", async () => {
    const mocks: Partial<Mocks> = {};
    const synthesize = vi.fn(async () => ok([mutatingCandidate()]));
    const validate = vi.fn(async () => ok(reproducedValidation())); // dynamicOk + reproduced + full
    const requestApproval = vi.fn(async () => ({ approved: true }));
    const deps = makeDeps(
      [traj()],
      { synthesisAdapter: { synthesize }, validationAdapter: { validate }, approvalGate: { requestApproval } },
      mocks,
    );

    const res = await runSkillSynthesis(deps);

    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(mocks.admit).toHaveBeenCalledTimes(1);
    const admitArg = (mocks.admit as Mock).mock.calls[0][0];
    expect(admitArg.confidence).toBe(1.0); // reproduced effect → full confidence
  });
});

describe("runSkillSynthesis — proof_count cap holds at admission (SKILL-04 adversarial)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("admits at the LOW cap even from a cluster of 50 near-identical successes", async () => {
    const mocks: Partial<Mocks> = {};
    const emb = [1, 0, 0];
    // 50 near-identical successes from ONE sender — they cluster into ONE cluster
    // of 50 members, cardinality 1. The synthesized candidate must admit at the
    // LOW proof_count cap, NOT 50 (the real anti-domination belt).
    const trajectories = Array.from({ length: 50 }, (_, i) =>
      traj({ trajectoryId: `dom-${i}`, sessionId: "sess-A", sender: "user", embedding: emb }),
    );
    const synthesize = vi.fn(async () => ok([readOnlyCandidate("dominated-skill")]));
    const deps = makeDeps(trajectories, { synthesisAdapter: { synthesize } }, mocks);

    const res = await runSkillSynthesis(deps);

    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.value.maxClusterCardinality).toBe(1);
    expect(mocks.admit).toHaveBeenCalledTimes(1);
    const admitArg = (mocks.admit as Mock).mock.calls[0][0];
    expect(admitArg.proofCount).toBe(1); // LOW cap, NOT 50
  });

  it("does NOT emit any learning:skill_* event from the job (the daemon emits, Plan 07)", async () => {
    const emit = vi.fn();
    const deps = makeDeps([traj()], { eventBus: { emit } });
    await runSkillSynthesis(deps);
    const learningSkillEmits = emit.mock.calls.filter((c) => String(c[0]).startsWith("learning:skill_"));
    expect(learningSkillEmits).toHaveLength(0);
  });
});
