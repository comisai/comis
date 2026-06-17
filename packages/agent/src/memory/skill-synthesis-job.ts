// SPDX-License-Identifier: Apache-2.0
/**
 * The procedural skill-synthesis job (v2.26 Verified Learning WS2,
 * SKILL-03/04/05/08).
 *
 * Runs as an offline cron (wired daemon-side, Plan 07 — NOT the hot path). One
 * pass: abstain-gate → select `success` trajectories → cluster (anti-domination)
 * → synthesize `CandidateSkill[]` from the (already-wrapped) trajectory →
 * validate via the injected `SkillValidationPort` → ADMIT to the learned-skill
 * store at `trust=learned`/`state=candidate`/low `proof_count`. Stages:
 *
 *  1. **Abstain** (FIRST, cheapest): a small/nano model without a capable
 *     override → `resolveMemoryOpsStrategy` returns `"abstain"` → SKIP. BENIGN
 *     (Defer ≠ Retry): increments NO failure metric and trips NO breaker. It logs
 *     `errorKind:"precondition"` (an unmet capability precondition — the
 *     consolidation-abstain precedent) with a synthesis-abstained `hint`, NOT a
 *     failure (SKILL-05).
 *  2. **Select** (fail-closed, SKILL-03): for each injected source trajectory,
 *     call `OutcomeSignalPort.resolve`; keep ONLY `outcome === "success" &&
 *     confidence >= minConfidence`. `failure`/`unknown`/low-confidence are
 *     skipped — a non-success trajectory never feeds synthesis.
 *  3. **Cluster** (anti-domination, SKILL-04): single-link by cosine threshold;
 *     cluster cardinality = the count of DISTINCT `(sessionId, sender)` pairs, so
 *     N near-identical "successes" from ONE sender count as 1 — an attacker
 *     cannot mint a high-proof procedure by repeating one trajectory N times. The
 *     WRITTEN `proof_count` is additionally capped LOW at admission (Task 3), the
 *     belt that holds regardless of sender precision.
 *  4. **Bound** (SKILL-05): the synthesis loop is triple-capped — `maxIterations`
 *     / `maxContextTokens` / `wallClockMs` — and TERMINATES at whichever bound it
 *     hits first (`boundedBy`).
 *  5. **Validate + admit** (SKILL-08, Task 3): the admission predicate routes a
 *     clean read-only candidate to auto-admit and a mutating one to the approval
 *     gate.
 *
 * Closed graph: this job consumes `@comis/core` PORT TYPES only
 * (`SkillSynthesisPort`, `SkillValidationPort`, `LearnedSkillStorePort`,
 * `OutcomeSignalPort`, `LearningScope`, `CandidateSkill`, …) + the injected
 * source/clock/eventBus. It imports NO `@comis/memory` / `@comis/skills` value
 * (the agent↛memory / agent↛skills build cut, `architecture-graph.test.ts`); the
 * daemon injects the real store + validation adapters (Plan 07). It emits NO
 * `learning:skill_*` bus event — the daemon emits the counts after the job
 * returns (mirroring 198's `outcome_observed`), so the bridge entry lands with
 * the daemon emit (Plan 07), never an unbridged emit here.
 *
 * @module
 */

import { ok, fromPromise, type Result } from "@comis/shared";
import type {
  LearningScope,
  CandidateSkill,
  SkillSynthesisPort,
  SkillValidationPort,
  SkillValidationResult,
  LearnedSkillStorePort,
  OutcomeSignalPort,
} from "@comis/core";
import { resolveMemoryOpsStrategy } from "./memory-capability-router.js";
import { cosine } from "./memory-consolidation-clustering.js";
import type { CapabilityClass } from "../executor/model-profile.js";

// ---------------------------------------------------------------------------
// Defaults (the triple-cap — design §13-risk-4 / §17)
// ---------------------------------------------------------------------------

/** Max synthesis iterations (clusters fed to the LLM) per run. */
const DEFAULT_MAX_ITERATIONS = 10;
/** Max accumulated trajectory context tokens (approx) fed to synthesis per run. */
const DEFAULT_MAX_CONTEXT_TOKENS = 100_000;
/** Max wall-clock (ms) the synthesis loop may run before terminating. */
const DEFAULT_WALL_CLOCK_MS = 300_000;
/**
 * The LOW proof-count cap a synthesized candidate is admitted at, REGARDLESS of
 * cluster size — the SKILL-04 anti-domination belt (the real guard, independent
 * of `(session_id, sender)` precision).
 */
const LOW_PROOF_COUNT = 1;

/** Rough chars-per-token estimate for the context-token bound (no tokenizer in-loop).
 *  IN-03: this UNDER-counts CJK/multi-byte content, but the EFFECTIVE cap is
 *  `maxIterations` (the hard per-run cluster ceiling); the token bound is only a
 *  secondary, deliberately-conservative DoS ceiling, so the under-count merely
 *  caps sooner — never looser. No behavior change needed. */
const CHARS_PER_TOKEN = 4;

/** Cosine threshold above which two success trajectories are clustered. */
const DEFAULT_SIMILARITY_THRESHOLD = 0.82;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * One finished source trajectory the job selects + clusters over. The daemon
 * (Plan 07) builds these from the LCD-merged `buildReviewSessionSource` (NOT raw
 * `sessionStore.listDetailed` — empty in DAG mode, the LIVEMEM bug) and injects
 * them. `text` is the flattened transcript the synthesis adapter wraps; `sender`
 * is the message author the anti-domination cardinality counts on.
 */
export interface SynthesisSourceTrajectory {
  /** The trajectory identity (the stable traceId the outcome signal keys on). */
  trajectoryId: string;
  /** The conversation/session the trajectory belongs to (anti-domination key part). */
  sessionId: string;
  /** The author of the trajectory (anti-domination key part; coarse is acceptable). */
  sender: string;
  /** The flattened trajectory text the synthesis adapter wraps + distils. UNTRUSTED. */
  text: string;
  /** Optional embedding for cosine clustering (absent ⇒ the trajectory is a singleton). */
  embedding?: number[];
}

/** The `learningSkills`-derived config slice the job reads (a structural subset). */
export interface SkillSynthesisJobConfig {
  enabled: boolean;
  autoAdmitReadOnly: boolean;
  minConfidence: number;
  requireForMutating: boolean;
}

/** A minimal structural logger (no Pino import — the closed-graph discipline). */
export interface SkillSynthesisJobLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  debug(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
}

/** The approval-gate surface the mutating-admission path uses (structural subset). */
export interface SkillApprovalGate {
  requestApproval(req: {
    toolName: string;
    action: string;
    params: Record<string, unknown>;
    agentId: string;
    sessionKey: string;
    trustLevel: string;
  }): Promise<{ approved: boolean }>;
}

/** Dependencies injected into {@link runSkillSynthesis}. */
export interface SkillSynthesisJobDeps {
  agentId: string;
  tenantId: string;
  /** The (tenant, agent) isolation boundary every read/write rebinds to. */
  scope: LearningScope;
  config: SkillSynthesisJobConfig;
  /** The agent's model capability class (drives the abstain gate). */
  capabilityClass?: CapabilityClass;
  /** Operator override — a stronger cheap model is configured for the pipeline. */
  hasCapableModelOverride?: boolean;
  /** The LCD-merged source history the daemon injects (NOT sessionStore.listDetailed). */
  sourceTrajectories: SynthesisSourceTrajectory[];
  /** The capability-routed synthesis adapter (wraps the untrusted trajectory). */
  synthesisAdapter: Pick<SkillSynthesisPort, "synthesize">;
  /** The outcome-signal port (the fail-closed success gate). */
  outcomeSignal: Pick<OutcomeSignalPort, "resolve">;
  /** The sandbox/static validation adapter (injected from @comis/skills, Plan 07). */
  validationAdapter: Pick<SkillValidationPort, "validate">;
  /** The learned-skill store (injected from @comis/memory, Plan 07). */
  learnedSkillStore: Pick<LearnedSkillStorePort, "admit">;
  /** The mutating-admission approval gate. */
  approvalGate: SkillApprovalGate;
  /** Wall-clock reads — durations + the wall-clock cap. NEVER a wall-clock global. */
  clock: { now: () => number };
  /** Counts/ids-only event bus (the daemon emits the learning:skill_* events, Plan 07). */
  eventBus: { emit(event: string, payload: unknown): void };
  logger: SkillSynthesisJobLogger;
  /** Triple-cap overrides (defaults: 10 / 100k / 300s). */
  maxIterations?: number;
  maxContextTokens?: number;
  wallClockMs?: number;
  similarityThreshold?: number;
  /** Optional cosine threshold override (defaults to 0.82). */
  /** Failure-metric sink — invoked ONLY on a genuine synthesis FAULT, never abstain (Defer ≠ Retry). */
  onSynthesisFailure?: (info: { errorKind: string; trajectoryCount: number }) => void;
  /** Breaker-trip sink — invoked ONLY on a genuine fault, never abstain (Defer ≠ Retry). */
  onBreakerTrip?: (info: { errorKind: string }) => void;
}

/**
 * Per-candidate validation verdict SUMMARY surfaced for the daemon's
 * `learning:skill_validated` emit (WR-01). BOOLEANS + the closed `coverage` enum
 * ONLY — never a field name, finding body, or script (the SEC-01 firewall; the
 * daemon emit carries exactly these three scalars). One entry per VALIDATED
 * candidate (i.e. the validation adapter returned a verdict, pass or fail).
 */
export interface SkillValidationSummary {
  staticOk: boolean;
  dynamicOk: boolean;
  coverage: "full" | "static-only";
}

/** What `runSkillSynthesis` returns — counts/ids/closed-scalars only; the daemon emits the events. */
export interface SkillSynthesisJobResult {
  /** True when the run abstained (weak model, benign skip). */
  abstained: boolean;
  /** How many candidate skills were synthesized this run. */
  synthesized: number;
  /** How many candidates were admitted to the store (read-only auto + approved mutating). */
  admitted: number;
  /** How many distinct candidates were validated. */
  validated: number;
  /** How many were routed to the approval gate (mutating). */
  approvalRequested: number;
  /**
   * Per-validated-candidate verdict summaries (WR-01). The daemon emits one
   * `learning:skill_validated` per entry AFTER the job returns (booleans +
   * coverage only), so the `learned_skill_failing` validation-failure obs path is
   * reachable. Empty on an abstained / nothing-selected run.
   */
  validations: SkillValidationSummary[];
  /** The largest distinct-(sessionId, sender) cardinality across the clusters (anti-domination telemetry). */
  maxClusterCardinality: number;
  /** Which bound terminated the synthesis loop, if any (`undefined` when unbounded this run). */
  boundedBy?: "iterations" | "contextTokens" | "wallClock";
}

// ---------------------------------------------------------------------------
// Clustering (anti-domination)
// ---------------------------------------------------------------------------

/** A cluster of selected success trajectories + its distinct-(session, sender) cardinality. */
interface SynthesisCluster {
  members: SynthesisSourceTrajectory[];
  /** Distinct (sessionId, sender) pairs — the anti-domination cardinality (NOT member count). */
  cardinality: number;
}

/** Distinct (sessionId, sender) cardinality of a member set (the anti-domination metric). */
function distinctSenderCardinality(members: SynthesisSourceTrajectory[]): number {
  const seen = new Set<string>();
  for (const m of members) {
    // session_id + sender — repeating one (session, sender) N times counts once.
    seen.add(`${m.sessionId} ${m.sender}`);
  }
  return seen.size;
}

/**
 * Greedy single-link clustering of selected successes by cosine similarity
 * (deterministic, array order). A trajectory with no embedding (or no neighbour)
 * becomes a singleton. Each cluster carries its distinct-(sessionId, sender)
 * cardinality — the SKILL-04 anti-domination count.
 */
function clusterSuccesses(
  selected: SynthesisSourceTrajectory[],
  similarityThreshold: number,
): SynthesisCluster[] {
  const visited = new Array<boolean>(selected.length).fill(false);
  const clusters: SynthesisCluster[] = [];

  for (let i = 0; i < selected.length; i++) {
    if (visited[i]) continue;
    visited[i] = true;
    const seed = selected[i];
    const members: SynthesisSourceTrajectory[] = [seed];
    const seedEmb = seed.embedding;

    for (let j = i + 1; j < selected.length; j++) {
      if (visited[j]) continue;
      const cand = selected[j];
      const neighbour =
        seedEmb !== undefined &&
        cand.embedding !== undefined &&
        cosine(seedEmb, cand.embedding) >= similarityThreshold;
      if (neighbour) {
        visited[j] = true;
        members.push(cand);
      }
    }

    clusters.push({ members, cardinality: distinctSenderCardinality(members) });
  }

  return clusters;
}

/** Flatten a cluster's member text into one block for synthesis (the adapter wraps it). */
function clusterText(cluster: SynthesisCluster): string {
  return cluster.members.map((m) => m.text).join("\n\n---\n\n");
}

// ---------------------------------------------------------------------------
// Admission (SKILL-08) — Task 3
// ---------------------------------------------------------------------------

/**
 * Tool-name prefixes/heuristics that make a procedure NON-DETERMINISTIC
 * (resolved-decision #2): a candidate whose required tools reach the network /
 * an LLM / exec-with-network is non-deterministic and may NEVER auto-admit, even
 * when mutating-approved by predicate — it is approval-only.
 */
const NONDETERMINISTIC_TOOL_HINTS = ["web", "fetch", "http", "search", "llm", "browser", "network"];

/** True when any required tool reaches the network / an LLM (⇒ non-deterministic). */
function isNonDeterministic(requiredTools: ReadonlyArray<string>): boolean {
  return requiredTools.some((t) => {
    const lower = t.toLowerCase();
    return NONDETERMINISTIC_TOOL_HINTS.some((h) => lower.includes(h));
  });
}

/**
 * The admission predicate (design §WS2 step 6 / §14-D2):
 *   admissible = staticOk && (dynamicOk || noEmbeddedScripts) && (reproducedEffect || readOnly)
 */
function isAdmissible(v: SkillValidationResult, candidate: CandidateSkill, readOnly: boolean): boolean {
  const noEmbeddedScripts = candidate.scripts.length === 0;
  return v.staticOk && (v.dynamicOk || noEmbeddedScripts) && (v.reproducedEffect || readOnly);
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

/**
 * Run one skill-synthesis pass for a single agent. Non-fatal posture: a single
 * trajectory's resolve/synthesis/validation fault is logged + skipped (the run
 * returns `ok` with the counts). The run returns `err` only on an unrecoverable
 * precondition.
 */
export async function runSkillSynthesis(
  deps: SkillSynthesisJobDeps,
): Promise<Result<SkillSynthesisJobResult, Error>> {
  const {
    agentId,
    scope,
    config,
    sourceTrajectories,
    synthesisAdapter,
    outcomeSignal,
    validationAdapter,
    learnedSkillStore,
    approvalGate,
    clock,
    logger,
  } = deps;

  const startMs = clock.now();
  const maxIterations = deps.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  const maxContextTokens = deps.maxContextTokens ?? DEFAULT_MAX_CONTEXT_TOKENS;
  const wallClockMs = deps.wallClockMs ?? DEFAULT_WALL_CLOCK_MS;
  const similarityThreshold = deps.similarityThreshold ?? DEFAULT_SIMILARITY_THRESHOLD;

  // 1. ABSTAIN GATE (first, cheapest). Defer ≠ Retry: a weak-model abstain is a
  //    BENIGN skip — no failure metric, no breaker trip.
  const capabilityClass = deps.capabilityClass ?? "frontier";
  const hasCapableModelOverride = deps.hasCapableModelOverride ?? false;
  if (resolveMemoryOpsStrategy(capabilityClass, hasCapableModelOverride) === "abstain") {
    logger.debug(
      {
        agentId,
        submodule: "skill-synthesis-job",
        step: "abstain" as const,
        // Closed-union errorKind (the consolidation-abstain precedent): an unmet
        // capability precondition. The `hint` carries the synthesis-abstained
        // semantics; this is BENIGN (no failure metric / no breaker), not a fault.
        errorKind: "precondition" as const,
        capabilityClass,
        hint: "skill synthesis abstained: capabilityClass requires a capableModel override (benign, Defer != Retry)",
      },
      "skill synthesis abstained",
    );
    // No failure metric, no breaker — the benign-skip contract.
    return ok({
      abstained: true,
      synthesized: 0,
      admitted: 0,
      validated: 0,
      approvalRequested: 0,
      validations: [],
      maxClusterCardinality: 0,
    });
  }

  // 2. SELECT (fail-closed): keep only `success` >= minConfidence.
  const selected: SynthesisSourceTrajectory[] = [];
  for (const t of sourceTrajectories) {
    const resolved = await fromPromise(outcomeSignal.resolve(t.trajectoryId, scope));
    if (!resolved.ok || !resolved.value.ok) {
      logger.debug(
        {
          agentId,
          step: "select" as const,
          trajectoryId: t.trajectoryId,
          // Closed-union: an unresolved outcome is an unmet precondition for
          // selection (fail-closed) — not a fault. Hint names the cause.
          errorKind: "precondition" as const,
          hint: "outcome unresolved (unknown/error) — skipped, fail-closed",
        },
        "skill synthesis: outcome unresolved, skipping trajectory",
      );
      continue; // fail-closed: an unresolved outcome is NOT a success
    }
    const outcome = resolved.value.value;
    if (outcome.outcome === "success" && outcome.confidence >= config.minConfidence) {
      selected.push(t);
    }
  }

  logger.debug(
    { agentId, step: "select" as const, candidates: sourceTrajectories.length, selected: selected.length },
    "skill synthesis selection complete",
  );

  if (selected.length === 0) {
    return ok({
      abstained: false,
      synthesized: 0,
      admitted: 0,
      validated: 0,
      approvalRequested: 0,
      validations: [],
      maxClusterCardinality: 0,
    });
  }

  // 3. CLUSTER (anti-domination): cardinality = distinct (sessionId, sender).
  const clusters = clusterSuccesses(selected, similarityThreshold);
  const maxClusterCardinality = clusters.reduce((mx, c) => Math.max(mx, c.cardinality), 0);
  logger.debug(
    { agentId, step: "cluster" as const, clusters: clusters.length, maxClusterCardinality },
    "skill synthesis clustering complete",
  );

  // 4. BOUND + SYNTHESIZE (+ 5. VALIDATE + ADMIT). Triple-cap the loop.
  let synthesized = 0;
  let validated = 0;
  let admitted = 0;
  let approvalRequested = 0;
  let contextTokens = 0;
  let boundedBy: SkillSynthesisJobResult["boundedBy"];
  // WR-01: collect per-validated-candidate verdict summaries so the daemon can
  // emit one `learning:skill_validated` per entry after this returns.
  const validations: SkillValidationSummary[] = [];

  for (let i = 0; i < clusters.length; i++) {
    // Triple-cap: terminate at whichever bound is hit first.
    if (i >= maxIterations) {
      boundedBy = "iterations";
      break;
    }
    if (clock.now() - startMs >= wallClockMs) {
      boundedBy = "wallClock";
      break;
    }
    const cluster = clusters[i];
    const text = clusterText(cluster);
    // A coarse DoS UPPER-BOUND on accumulated synthesis context — the load-bearing
    // bound is maxIterations; a CJK under-count only makes this secondary ceiling
    // MORE conservative (caps sooner), never less.
    // flat-by-design: coarse aggregate DoS ceiling, no per-script accuracy needed (TOK-01)
    const nextTokens = contextTokens + Math.ceil(text.length / CHARS_PER_TOKEN);
    if (nextTokens > maxContextTokens) {
      boundedBy = "contextTokens";
      break;
    }
    contextTokens = nextTokens;

    const clusterTrajIds = cluster.members.map((m) => m.trajectoryId);
    const synthResult = await fromPromise(
      synthesisAdapter.synthesize({ trajectoryText: text, scope, clusterTrajIds }),
    );
    if (!synthResult.ok || !synthResult.value.ok) {
      // A genuine synthesis FAULT (transport / adapter error) — this DOES count
      // as a failure (Defer ≠ Retry only excuses the abstain path, not a fault).
      // Closed-union errorKind `dependency` (a downstream LLM dependency call
      // faulted) — the consolidation/outcome-judge precedent.
      deps.onSynthesisFailure?.({ errorKind: "dependency", trajectoryCount: clusterTrajIds.length });
      logger.warn(
        {
          agentId,
          step: "synthesize" as const,
          errorKind: "dependency" as const,
          clusterTrajIds: clusterTrajIds.length,
          hint: "synthesis LLM call faulted for this cluster — skipped (no partial admit)",
        },
        "skill synthesis call failed for cluster, skipping",
      );
      continue;
    }
    const candidates = synthResult.value.value;
    synthesized += candidates.length;

    // 5. VALIDATE + ADMIT each candidate (SKILL-08).
    for (const candidate of candidates) {
      const r = await admitCandidate({
        candidate,
        clusterTrajIds,
        validationAdapter,
        learnedSkillStore,
        approvalGate,
        config,
        scope,
        agentId,
        sessionKey: cluster.members[0]?.sessionId ?? "",
        nowMs: clock.now(),
        logger,
      });
      if (r.validated) validated += 1;
      if (r.admitted) admitted += 1;
      if (r.approvalRequested) approvalRequested += 1;
      // WR-01: a validated candidate (the adapter returned a verdict, pass OR
      // fail) contributes a summary the daemon turns into a
      // `learning:skill_validated` event — booleans + coverage only.
      if (r.validationSummary) validations.push(r.validationSummary);
    }
  }

  logger.info(
    {
      agentId,
      submodule: "skill-synthesis-job",
      synthesized,
      validated,
      admitted,
      approvalRequested,
      maxClusterCardinality,
      ...(boundedBy ? { boundedBy } : {}),
      durationMs: clock.now() - startMs,
    },
    "skill synthesis run complete",
  );

  return ok({
    abstained: false,
    synthesized,
    admitted,
    validated,
    approvalRequested,
    validations,
    maxClusterCardinality,
    ...(boundedBy ? { boundedBy } : {}),
  });
}

// ---------------------------------------------------------------------------
// Per-candidate validation + admission (SKILL-08)
// ---------------------------------------------------------------------------

interface AdmitCandidateArgs {
  candidate: CandidateSkill;
  clusterTrajIds: string[];
  validationAdapter: Pick<SkillValidationPort, "validate">;
  learnedSkillStore: Pick<LearnedSkillStorePort, "admit">;
  approvalGate: SkillApprovalGate;
  config: SkillSynthesisJobConfig;
  scope: LearningScope;
  agentId: string;
  sessionKey: string;
  nowMs: number;
  logger: SkillSynthesisJobLogger;
}

interface AdmitCandidateOutcome {
  validated: boolean;
  admitted: boolean;
  approvalRequested: boolean;
  /** The verdict summary (WR-01) — present iff the candidate was validated. */
  validationSummary?: SkillValidationSummary;
}

/**
 * Validate one candidate, then apply the SKILL-08 admission policy:
 *  - read-only AND admissible AND `autoAdmitReadOnly` → AUTO-ADMIT at
 *    `trust=learned`/`state=candidate`/low `proof_count`;
 *  - mutating → ApprovalGate.requestApproval → admit ONLY on approval;
 *  - NON-DETERMINISTIC mutating → approval-only, NEVER auto-admit.
 *
 * WR-03 — the mutating arms are a LABELED FORWARD SEAM, currently DORMANT. With
 * the empty ReplayContext this passes (see below), `reproducedEffect` is
 * structurally false, so a mutating candidate fails the admission predicate and
 * returns BEFORE the ApprovalGate branch — no mutating procedure can admit in P2
 * (fail-closed-safe). The ApprovalGate path is wired and unit-tested (assuming a
 * reproduced verdict), so threading a real ReplayContext in the surface/execute
 * phase (202+) activates it. It is NOT dead-by-mistake; it is deferred-by-design.
 *
 * Returns counts + the per-candidate verdict summary (the daemon emits the
 * learning:skill_* events, Plan 07).
 */
async function admitCandidate(args: AdmitCandidateArgs): Promise<AdmitCandidateOutcome> {
  const {
    candidate,
    clusterTrajIds,
    validationAdapter,
    learnedSkillStore,
    approvalGate,
    config,
    scope,
    agentId,
    sessionKey,
    nowMs,
    logger,
  } = args;

  const out: AdmitCandidateOutcome = { validated: false, admitted: false, approvalRequested: false };

  // WR-03 (labeled forward seam — DEFERRED to the surface/execute phase 202+):
  // we pass an EMPTY ReplayContext (`{}`). The validator's `hasCheckableEffect`
  // is therefore false → `reproducedEffect` is structurally false → a MUTATING
  // candidate is NEVER admitted (the predicate requires `reproducedEffect ||
  // readOnly`, and a mutating candidate is not read-only). This is
  // fail-closed-safe and intentional for P2: genuine mutating admission needs a
  // real effect-capture-and-compare harness (capture the procedure's expected
  // observable effect from the source trajectory + assert the sandbox run
  // reproduces it), which is a 202+ concern. The mutating→ApprovalGate apparatus
  // below is kept as the forward seam (it is DORMANT, not broken — it activates
  // once a real ReplayContext is threaded here). See deferred-items.md.
  const validateResult = await fromPromise(
    validationAdapter.validate(candidate, {}, scope),
  );
  if (!validateResult.ok || !validateResult.value.ok) {
    logger.warn(
      {
        agentId,
        step: "validate" as const,
        // Closed-union: the validation adapter (a downstream dependency) faulted.
        errorKind: "dependency" as const,
        name: candidate.name,
        hint: "validation adapter faulted — candidate skipped (not admitted)",
      },
      "skill validation faulted, skipping candidate",
    );
    return out;
  }
  out.validated = true;
  const verdict = validateResult.value.value;
  // WR-01: surface the verdict booleans + coverage for the daemon emit (counts
  // only — never a finding/body). Carried for EVERY validated candidate (admit or
  // not), so the daemon's learning:skill_validated covers the failure path too.
  out.validationSummary = { staticOk: verdict.staticOk, dynamicOk: verdict.dynamicOk, coverage: verdict.coverage };
  // IN-01: derive the admission confidence from the validation verdict (NOT a
  // hardcoded 1). A dynamically-reproduced candidate is highest-confidence; a
  // clean full-coverage run is high; a static-only read-only admit seeds lower.
  const admissionConfidence = confidenceFromVerdict(verdict);

  const readOnly = isReadOnly(candidate);
  if (!isAdmissible(verdict, candidate, readOnly)) {
    logger.debug(
      {
        agentId,
        step: "admit" as const,
        name: candidate.name,
        staticOk: verdict.staticOk,
        dynamicOk: verdict.dynamicOk,
        coverage: verdict.coverage,
        hint: "candidate failed the admission predicate, not admitted",
      },
      "skill candidate not admissible",
    );
    return out;
  }

  // READ-ONLY auto-admit (config-gated).
  if (readOnly) {
    if (!config.autoAdmitReadOnly) {
      logger.debug({ agentId, step: "admit" as const, name: candidate.name }, "read-only auto-admit disabled by config");
      return out;
    }
    const admitR = await doAdmit(learnedSkillStore, candidate, clusterTrajIds, scope, nowMs, admissionConfidence);
    out.admitted = admitR;
    return out;
  }

  // MUTATING → approval gate. NON-DETERMINISTIC mutating is approval-only too
  // (the predicate already gates auto-admit on readOnly, so a mutating candidate
  // — deterministic or not — NEVER auto-admits; both route here).
  out.approvalRequested = true;
  const nonDet = isNonDeterministic(candidate.requiredTools);
  const resolution = await approvalGate.requestApproval({
    toolName: "learned_skill_admission",
    action: `admit_skill:${candidate.name}`,
    params: { name: candidate.name, mutating: true, nonDeterministic: nonDet },
    agentId,
    sessionKey,
    trustLevel: "learned",
  });
  if (resolution.approved) {
    const admitR = await doAdmit(learnedSkillStore, candidate, clusterTrajIds, scope, nowMs, admissionConfidence);
    out.admitted = admitR;
  } else {
    logger.debug(
      { agentId, step: "admit" as const, name: candidate.name, nonDeterministic: nonDet, hint: "mutating candidate not approved" },
      "skill candidate awaiting/denied approval — not admitted",
    );
  }
  return out;
}

/** A candidate is read-only when the validator computed `mutating: false` for it. */
function isReadOnly(candidate: CandidateSkill): boolean {
  // The `mutating` flag is computed by the validator (SKILL-06) and carried on
  // the candidate via the validation result; in P2 the candidate's own
  // requiredTools drive a conservative read-only check (a mutating tool ⇒ not
  // read-only) so a missing flag never opens auto-admit.
  return !candidateMutates(candidate);
}

/**
 * Conservative mutating check derived from `required_tools` (the SKILL-06
 * mechanism, PATTERNS.md): any tool that is not unambiguously read-only — or any
 * `mcp__`-prefixed tool (`isReadOnlyTool` returns true for ALL `mcp__` tools, so
 * the explicit prefix branch is the SEC-01 belt) — makes the candidate mutating.
 * A candidate with NO required tools is read-only.
 */
function candidateMutates(candidate: CandidateSkill): boolean {
  return candidate.requiredTools.some((t) => {
    const lower = t.toLowerCase();
    if (lower.startsWith("mcp__")) return true; // mcp__ tools are conservatively mutating
    return !READ_ONLY_TOOLS.has(lower);
  });
}

/** The small set of unambiguously read-only built-in tools. */
const READ_ONLY_TOOLS = new Set(["read", "list", "glob", "grep", "search", "get"]);

/**
 * Map a validation verdict to the admission confidence seed (IN-01). The
 * verdict is the only per-candidate trust signal available at admission in P2:
 *  - a dynamically REPRODUCED candidate (jail ran, scripts passed, effect
 *    reproduced) is the strongest evidence → 1.0;
 *  - a clean FULL-coverage run with no checkable effect → 0.9;
 *  - a static-only admit (read-only, script-free — the common case) seeds at
 *    0.7 (it passed the poison scan but obtained no dynamic proof).
 * The Phase 202 promote/demote/strength math refines this from real outcomes;
 * this replaces the hardcoded `1` so a static-only admit no longer enters at
 * full strength. The LOW proof_count cap is unchanged (anti-domination).
 */
function confidenceFromVerdict(verdict: SkillValidationResult): number {
  if (verdict.reproducedEffect && verdict.dynamicOk && verdict.coverage === "full") return 1.0;
  if (verdict.dynamicOk && verdict.coverage === "full") return 0.9;
  return 0.7;
}

/** Write the admitted candidate at trust=learned / state=candidate / low proof_count. */
async function doAdmit(
  store: Pick<LearnedSkillStorePort, "admit">,
  candidate: CandidateSkill,
  clusterTrajIds: string[],
  scope: LearningScope,
  nowMs: number,
  confidence: number,
): Promise<boolean> {
  const admitR = await fromPromise(
    store.admit(
      {
        name: candidate.name,
        description: candidate.description,
        body: candidate.body,
        mutating: candidateMutates(candidate),
        // The SKILL-04 anti-domination cap: LOW regardless of cluster size.
        proofCount: LOW_PROOF_COUNT,
        // IN-01: the validation-derived seed (not a hardcoded 1); strength
        // seeds from this at the store.
        confidence,
        sourceTrajIds: clusterTrajIds,
        createdAt: nowMs,
      },
      scope,
    ),
  );
  return admitR.ok && admitR.value.ok && admitR.value.value.admitted;
}
