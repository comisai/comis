// SPDX-License-Identifier: Apache-2.0
/**
 * Capability default-activation framework (reconciled
 * for the V1 OPT-OUT posture).
 *
 * The minimal, reversible, config-overridable mechanism that resolves each
 * capability's effective default-OFF→ON state. A capability's default resolves
 * ON when EITHER activation path holds, AND the frozen-trust invariant is
 * respected:
 *
 *   (a) V1 OPT-OUT posture — the capability is in {@link V1_OPT_OUT_CAPABILITIES}.
 *       This is the product decision: ship the memory stack
 *       opt-OUT, so the eight non-privacy capabilities default ON. This path
 *       SUPERSEDES the original measured-lift-to-activate premise for those
 *       capabilities (the schema defaults themselves flipped ON — see
 *       `schema-agent-prompt.ts` for the $0 recall toggles and
 *       `schema-agent-runtime.ts` for the cost-bearing subtrees). The
 *       cost-bearing ones (USER / REASON / DIALECTIC, plus LEARN-RANK's offline
 *       bandit) are additionally gated by the master cost-feature kill switch
 *       (`memory.costFeatures.enabled`) at their daemon registration sites — the
 *       kill switch beats this default-ON.
 *   (b) MEASURED-LIFT gate — a RECORDED decision in {@link ACTIVATED_CAPABILITIES}
 *       that references a committed measured-lift manifest AND a measured positive delta
 *       (the "nothing flips on faith" rule). This path remains for any capability
 *       NOT in the opt-out set (today: SOCIAL).
 *
 * In BOTH paths the FROZEN safety invariant holds: a capability whose
 * `configPath` is a {@link FROZEN_TRUST_PATHS} path can NEVER resolve ON — no
 * activation may move `trustAlpha` or the trust filter (`includeTrustLevels`),
 * ever. Trust stays frozen throughout.
 *
 * SOCIAL stays OFF: it is NOT in the opt-out set (it carries a privacy/consent
 * gate, `privacyReviewSignedOffBy`) and has no recorded measured-lift decision,
 * so it resolves OFF — the operator opts in explicitly via config + sign-off.
 *
 * REVERSIBILITY + OVERRIDE: this framework only resolves the *effective default*.
 * The per-agent config knobs (each `*.enabled` / `rag.*` toggle) remain the
 * operator override — an operator can always turn a capability ON or OFF in
 * config regardless of the resolved default. No back-compat shim, no migration.
 *
 * NOT a public export of `@comis/core/config` beyond the named symbols below —
 * it carries no port, no runtime side effect, and reads no config at module load
 * (it is a declarative policy table + a pure resolver).
 *
 * @allow-throw: resolveCapabilityDefault throws on an unknown CapabilityId — a
 *   closed-union programmer-error guard (an unknown id only arises from an `as`
 *   cast), the conventional assertion boundary, not a recoverable Result seam.
 *
 * @module
 */

/** Stable identifier for each default-OFF capability. Closed union. */
export type CapabilityId =
  | "user" // USER per-user representation
  | "social" // SOCIAL directional relationship model
  | "dialectic" // memory_ask grounded-Q&A tool
  | "reason" // offline deductive/inductive reasoning
  | "feed" // recall-utility feedback loop
  | "learnIq" // LLM-free intent-reweight query understanding
  | "kg" // graph-spread recall lane
  | "forget"; // FadeMem per-type decay recall gate

/** One capability: where its default-OFF knob lives + how it activates. */
export interface CapabilityDescriptor {
  /** Stable id (closed union member). */
  readonly id: CapabilityId;
  /** Human-facing label (for operator-facing surfaces / logs). */
  readonly label: string;
  /**
   * Dotted per-agent config path of the capability's master ON/OFF knob,
   * relative to a parsed `PerAgentConfig` (e.g. "rag.forget.enabled",
   * "socialModeling.enabled"). The as-shipped value at this path is OFF
   * (an absent optional subtree ⇒ undefined ⇒ OFF, or an explicit `false`).
   */
  readonly configPath: string;
  /**
   * EXTRA operator gate beyond the measured-lift gate, when the capability has
   * one. SOCIAL carries a recorded
   * `privacyReviewSignedOffBy` sign-off — even a measured winner would not flip
   * SOCIAL on without it. Absent for every other capability.
   */
  readonly operatorGatePath?: string;
}

/**
 * The 9 default-OFF capabilities. Each names the real config path of its
 * master toggle; the activation framework resolves each one's effective default.
 *
 * SOCIAL additionally carries `operatorGatePath` — the recorded
 * privacy-review sign-off, an operator gate orthogonal to (and additional to)
 * the measured-lift gate.
 */
export const V2_9_CAPABILITIES: readonly CapabilityDescriptor[] = Object.freeze([
  { id: "user", label: "Per-user representation", configPath: "memoryUserRepresentation.enabled" },
  {
    id: "social",
    label: "Directional relationship model",
    configPath: "socialModeling.enabled",
    operatorGatePath: "socialModeling.privacyReviewSignedOffBy",
  },
  { id: "dialectic", label: "memory_ask grounded Q&A", configPath: "dialectic.enabled" },
  { id: "reason", label: "Offline reasoning", configPath: "memoryReasoning.enabled" },
  { id: "feed", label: "Recall-utility feedback loop", configPath: "rag.feedback.enabled" },
  {
    id: "learnIq",
    label: "Intent-reweight query understanding",
    configPath: "rag.queryUnderstanding.intentReweight",
  },
  { id: "kg", label: "Graph-spread recall lane", configPath: "rag.lanes.graphSpread.enabled" },
  { id: "forget", label: "FadeMem decay recall gate", configPath: "rag.forget.enabled" },
]);

/**
 * Config paths that are FROZEN — the trust hard-boundary. No activation may move
 * `trustAlpha` (the trust-level ranking weight + tie-break) or `includeTrustLevels`
 * (the trust filter that excludes external-trust memories). A capability whose
 * `configPath` is one of these is rejected from the registry by its tests; an
 * activation decision targeting one is rejected by the resolver invariant.
 * Binding constraint: trust stays frozen throughout activation.
 */
export const FROZEN_TRUST_PATHS: readonly string[] = Object.freeze([
  "rag.scoring.trustAlpha",
  "rag.includeTrustLevels",
]);

/**
 * A recorded measured-lift activation decision. An entry here is the ONLY way a
 * capability's default flips ON. It must reference a committed measured-lift manifest
 * and a measured positive delta — the structural "nothing flips on faith" gate.
 */
export interface ActivationDecision {
  /** Which capability this decision activates. */
  readonly capability: CapabilityId;
  /**
   * Committed measured-lift manifest the decision references (a path under
   * `benchmarks/results/.../` — e.g. a GATE-REPORT.md / run-provenance.json /
   * capability-lift-report.json). Audit-traceable.
   */
  readonly manifest: string;
  /** Measured cross-judged QA-lift in points (must be > 0 — a measured win). */
  readonly measuredDeltaPts: number;
  /** Free-text rationale (the gap-report finding that justified the flip). */
  readonly rationale: string;
}

/**
 * The measured-winner activation set. **EMPTY** — the measured-lift evaluation found no
 * capability meeting the measured-lift-with-no-regression bar. This path now only
 * governs capabilities NOT in {@link V1_OPT_OUT_CAPABILITIES} (today: SOCIAL); the
 * eight opt-out capabilities flip ON via the v1 opt-out posture instead. When a
 * future costed run produces a measured winner for SOCIAL (post privacy sign-off),
 * add its recorded {@link ActivationDecision} here (and only here).
 */
export const ACTIVATED_CAPABILITIES: readonly ActivationDecision[] = Object.freeze([]);

/**
 * The V1 OPT-OUT capability set. These eight capabilities ship
 * default-ON because the product decision is an opt-OUT memory posture — their
 * schema defaults flipped false→true in `schema-agent-prompt.ts` (the $0 recall
 * toggles: KG / LEARN-IQ / FORGET / FEED / LEARN-RANK apply-gate) and
 * `schema-agent-runtime.ts` (the cost-bearing subtrees: USER / REASON / DIALECTIC,
 * plus LEARN-RANK's offline bandit). This set supersedes the original
 * measured-lift-to-activate premise FOR THESE CAPABILITIES — the resolver returns
 * ON for any member (subject only to the frozen-trust invariant).
 *
 * SOCIAL is DELIBERATELY ABSENT: it carries a privacy/consent gate
 * (`privacyReviewSignedOffBy`) and stays OFF, opt-IN only. Adding a member here
 * flips its default ON; removing one reverts it. No back-compat shim, no migration.
 */
export const V1_OPT_OUT_CAPABILITIES: ReadonlySet<CapabilityId> = Object.freeze(
  new Set<CapabilityId>(["user", "dialectic", "reason", "feed", "learnIq", "kg", "forget"]),
);

/** How a capability's effective default resolved ON (audit-traceable). */
export type ActivationVia = "v1-opt-out" | "measured-lift";

/** The resolved effective default for one capability. */
export interface ResolvedCapabilityDefault {
  /** The capability id. */
  readonly id: CapabilityId;
  /** Effective default after the activation paths + frozen-trust invariant. */
  readonly effectiveDefaultOn: boolean;
  /** Which path flipped it ON, when ON. Absent when OFF. */
  readonly via?: ActivationVia;
  /** The recorded measured-lift decision that flipped it ON, when via "measured-lift". */
  readonly decision?: ActivationDecision;
}

/**
 * Resolve a single capability's effective default-OFF→ON state.
 *
 * Returns ON when EITHER the v1 opt-out posture applies (the capability is in
 * {@link V1_OPT_OUT_CAPABILITIES}) OR a recorded {@link ActivationDecision} with a
 * positive measured delta exists — AND, in both cases, the capability does not
 * target a {@link FROZEN_TRUST_PATHS} path (the frozen-trust invariant always
 * wins, so a hypothetical trust-targeting member could never resolve ON).
 * Otherwise OFF (the as-shipped default — today: SOCIAL). Throws for an unknown id
 * (a typo must fail loud, never silently resolve OFF).
 */
export function resolveCapabilityDefault(id: CapabilityId): ResolvedCapabilityDefault {
  const cap = V2_9_CAPABILITIES.find((c) => c.id === id);
  if (cap === undefined) {
    throw new Error(`Unknown capability id: ${String(id)}`);
  }
  // The frozen-trust invariant gates BOTH paths: a capability targeting a frozen
  // trust path can never resolve ON, regardless of opt-out membership or decision.
  const targetsFrozenTrust = FROZEN_TRUST_PATHS.includes(cap.configPath);
  if (targetsFrozenTrust) {
    return { id, effectiveDefaultOn: false };
  }
  // Path (a): the v1 opt-out posture — supersedes measured-lift
  // for its members. The schema defaults themselves flipped ON for these.
  if (V1_OPT_OUT_CAPABILITIES.has(id)) {
    return { id, effectiveDefaultOn: true, via: "v1-opt-out" };
  }
  // Path (b): a recorded measured-lift decision (with a positive measured delta).
  const decision = ACTIVATED_CAPABILITIES.find((d) => d.capability === id);
  if (decision !== undefined && decision.measuredDeltaPts > 0) {
    return { id, effectiveDefaultOn: true, via: "measured-lift", decision };
  }
  return { id, effectiveDefaultOn: false };
}

/** Resolve every registered capability's effective default (one entry each). */
export function resolveAllCapabilityDefaults(): readonly ResolvedCapabilityDefault[] {
  return V2_9_CAPABILITIES.map((c) => resolveCapabilityDefault(c.id));
}
