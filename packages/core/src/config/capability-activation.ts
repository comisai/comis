// SPDX-License-Identifier: Apache-2.0
/**
 * Capability default-activation framework (V1 OPT-OUT posture).
 *
 * The minimal, reversible, config-overridable mechanism that resolves each
 * capability's effective default-OFF→ON state. A capability's default resolves
 * ON when EITHER activation path holds, AND the frozen-trust invariant is
 * respected:
 *
 *   (a) V1 OPT-OUT posture — the capability is in {@link V1_OPT_OUT_CAPABILITIES}.
 *       This is the product decision: ship the memory stack
 *       opt-OUT, so the non-privacy capabilities default ON. This path
 *       SUPERSEDES the measured-lift-to-activate premise for those
 *       capabilities (the schema defaults themselves are ON — see
 *       `schema-agent-prompt.ts` for the $0 recall toggles and
 *       `schema-agent-runtime.ts` for the cost-bearing subtrees). The
 *       cost-bearing ones (DIALECTIC) are additionally gated by the master
 *       cost-feature kill switch at their daemon registration sites — the
 *       kill switch beats this default-ON.
 *   (b) MEASURED-LIFT gate — a RECORDED decision in {@link ACTIVATED_CAPABILITIES}
 *       that references a committed measured-lift manifest AND a measured positive delta
 *       (the "nothing flips on faith" rule). This path is empty (every registered
 *       capability is in the opt-out set); it remains as an ahead-of-need mechanism.
 *
 * In BOTH paths the FROZEN safety invariant holds: a capability whose
 * `configPath` is a {@link FROZEN_TRUST_PATHS} path can NEVER resolve ON — no
 * activation may move `trustAlpha` or the trust filter (`includeTrustLevels`),
 * ever. Trust stays frozen throughout.
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

/** Stable identifier for each capability. Closed union. */
export type CapabilityId =
  | "dialectic" // memory_ask grounded-Q&A tool
  | "feed" // recall-utility feedback loop
  | "learnIq" // LLM-free intent-reweight query understanding
  | "kg" // graph-spread recall lane
  | "forget"; // FadeMem per-type decay recall gate

/** One capability: where its master knob lives + how it activates. */
export interface CapabilityDescriptor {
  /** Stable id (closed union member). */
  readonly id: CapabilityId;
  /** Human-facing label (for operator-facing surfaces / logs). */
  readonly label: string;
  /**
   * Dotted per-agent config path of the capability's master ON/OFF knob,
   * relative to a parsed `PerAgentConfig` (e.g. "rag.forget.enabled",
   * "dialectic.enabled"). All five resolve ON via the V1 opt-out posture.
   */
  readonly configPath: string;
}

/**
 * The five capabilities. Each names the real config path of its master toggle;
 * the activation framework resolves each one's effective default. All five are in
 * the V1 opt-out set, so each resolves ON (subject to the frozen-trust invariant).
 * No member is OFF; the measured-lift path stays as an empty, ahead-of-need
 * mechanism.
 */
export const V2_9_CAPABILITIES: readonly CapabilityDescriptor[] = Object.freeze([
  { id: "dialectic", label: "memory_ask grounded Q&A", configPath: "dialectic.enabled" },
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
  /** Free-text rationale explaining why the measured lift justified the flip. */
  readonly rationale: string;
}

/**
 * The measured-winner activation set. **EMPTY** — every registered capability is
 * in {@link V1_OPT_OUT_CAPABILITIES}, so none needs a measured-lift decision. The
 * opt-out capabilities flip ON via the v1 opt-out posture. This path remains as an ahead-of-need
 * mechanism: a future non-opt-out capability with a recorded {@link ActivationDecision}
 * (and a measured positive delta) would be added here (and only here).
 */
export const ACTIVATED_CAPABILITIES: readonly ActivationDecision[] = Object.freeze([]);

/**
 * The V1 OPT-OUT capability set. These five capabilities ship
 * default-ON because the product decision is an opt-OUT memory posture — their
 * schema defaults are true in `schema-agent-prompt.ts` (the $0 recall
 * toggles: KG / LEARN-IQ / FORGET / FEED) and `schema-agent-runtime.ts` (the
 * cost-bearing subtree: DIALECTIC). This set supersedes the
 * measured-lift-to-activate premise FOR THESE CAPABILITIES — the resolver returns
 * ON for any member (subject only to the frozen-trust invariant). It is the
 * FULL registered set (every capability resolves ON).
 *
 * Adding a member here flips its default ON; removing one reverts it.
 * No back-compat shim, no migration.
 */
export const V1_OPT_OUT_CAPABILITIES: ReadonlySet<CapabilityId> = Object.freeze(
  new Set<CapabilityId>(["dialectic", "feed", "learnIq", "kg", "forget"]),
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
 * Otherwise OFF (the as-shipped default; no registered member currently resolves
 * OFF). Throws for an unknown id (a typo must fail loud, never silently resolve OFF).
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
  // for its members. The schema defaults themselves are ON for these.
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
