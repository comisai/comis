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
  type SkillSynthesisJobDeps,
  type SynthesisSourceTrajectory,
} from "./skill-synthesis-job.js";

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

  return {
    agentId: "a1",
    tenantId: "t1",
    scope: SCOPE,
    config: {
      enabled: true,
      autoAdmitReadOnly: true,
      minConfidence: 0.7,
      requireForMutating: true,
      ...(over.config ?? {}),
    },
    capabilityClass: over.capabilityClass ?? "frontier",
    hasCapableModelOverride: over.hasCapableModelOverride ?? false,
    sourceTrajectories: trajectories,
    synthesisAdapter: { synthesize },
    outcomeSignal: { resolve },
    validationAdapter: { validate },
    learnedSkillStore: { admit },
    approvalGate: { requestApproval },
    clock: { now: () => NOW },
    eventBus: { emit: vi.fn() },
    logger,
    onSynthesisFailure: failureMetric,
    onBreakerTrip: breakerTrip,
    ...over,
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
