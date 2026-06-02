// SPDX-License-Identifier: Apache-2.0
/**
 * v2.9 capability default-activation framework (Phase 115 — ACT-01).
 *
 * The minimal, reversible, config-overridable mechanism that resolves each v2.9
 * capability's effective default-OFF→ON state. Every capability ships
 * DEFAULT-OFF (the byte-identity-when-absent discipline). A capability's default
 * flips to ON ONLY when BOTH gates pass:
 *
 *   (a) MEASURED-LIFT gate — a RECORDED decision in {@link ACTIVATED_CAPABILITIES}
 *       that references a committed PROVE2 manifest AND a measured positive delta
 *       (the "nothing flips on faith" rule); AND
 *   (b) FROZEN safety invariants — the capability must not target a
 *       {@link FROZEN_TRUST_PATHS} path; no activation may move `trustAlpha` or
 *       the trust filter (`includeTrustLevels`), ever.
 *
 * Phase 114 (PROVE2) measured **+0.0pt** for every recall-config-togglable v2.9
 * capability (intent-reweight + forget were byte-identical to the baseline) and
 * deferred the enrichment-state capabilities (KG / USER / SOCIAL / REASON /
 * LEARN-RANK — they need derived state the verbatim-ingest bench does not build).
 * **So the activation set is EMPTY** and every capability resolves OFF — the
 * honest measure-first outcome (gate report:
 * `benchmarks/results/2026-06-02-phase114-prove2/GATE-REPORT.md`).
 *
 * REVERSIBILITY + OVERRIDE: this framework only resolves the *effective default*.
 * The per-agent config knobs (each `*.enabled` / `rag.*` toggle) remain the
 * operator override — an operator can always turn a capability ON or OFF in
 * config regardless of the resolved default. Adding a measured winner here flips
 * its default; removing the entry reverts it. No back-compat shim, no migration.
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

/** Stable identifier for each default-OFF v2.9 capability. Closed union. */
export type CapabilityId =
  | "user" // USER per-user representation (Phase 107)
  | "social" // SOCIAL directional relationship model (Phase 108)
  | "dialectic" // memory_ask grounded-Q&A tool (Phase 109)
  | "reason" // offline deductive/inductive reasoning (Phase 101)
  | "feed" // recall-utility feedback loop (Phase 93/FEED)
  | "learnRank" // learning-to-rank recall-side apply gate (Phase 111, LEARN-03)
  | "learnIq" // LLM-free intent-reweight query understanding (Phase 102, IQ)
  | "kg" // graph-spread recall lane (Phase 100, KG-04)
  | "forget"; // FadeMem per-type decay recall gate (Phase 112, FORGET-01)

/** One v2.9 capability: where its default-OFF knob lives + how it activates. */
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
   * one. SOCIAL (Phase 108, SOCIAL-03) carries a recorded
   * `privacyReviewSignedOffBy` sign-off — even a measured winner would not flip
   * SOCIAL on without it. Absent for every other capability.
   */
  readonly operatorGatePath?: string;
}

/**
 * The 9 default-OFF v2.9 capabilities. Each names the real config path of its
 * master toggle; the activation framework resolves each one's effective default.
 *
 * SOCIAL additionally carries `operatorGatePath` — the SOCIAL-03 recorded
 * privacy-review sign-off, an operator gate orthogonal to (and additional to)
 * the measured-lift gate (ACT-03).
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
  { id: "learnRank", label: "Learning-to-rank recall apply", configPath: "rag.onlineTuning.enabled" },
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
 * capability's default flips ON. It must reference a committed PROVE2 manifest
 * and a measured positive delta — the structural "nothing flips on faith" gate.
 */
export interface ActivationDecision {
  /** Which capability this decision activates. */
  readonly capability: CapabilityId;
  /**
   * Committed PROVE2 manifest the decision references (a path under
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
 * The measured-winner activation set. **EMPTY** — Phase 114 (PROVE2) measured no
 * capability meeting the measured-lift-with-no-regression bar (intent-reweight +
 * forget were byte-identical → +0.0pt; KG/USER/SOCIAL/REASON/LEARN-RANK deferred,
 * needing derived state the verbatim-ingest bench does not build). Every
 * capability therefore keeps its as-shipped default-OFF (ACT-02 = byte-identity
 * preserved). When a future costed run produces a measured winner, add its
 * recorded {@link ActivationDecision} here (and only here).
 */
export const ACTIVATED_CAPABILITIES: readonly ActivationDecision[] = Object.freeze([]);

/** The resolved effective default for one capability. */
export interface ResolvedCapabilityDefault {
  /** The capability id. */
  readonly id: CapabilityId;
  /** Effective default after both gates: ON iff a valid decision exists. */
  readonly effectiveDefaultOn: boolean;
  /** The recorded decision that flipped it ON, when present. */
  readonly decision?: ActivationDecision;
}

/**
 * Resolve a single capability's effective default-OFF→ON state.
 *
 * Returns ON iff a recorded {@link ActivationDecision} exists for the capability
 * AND that decision is valid under the frozen-trust invariant AND the measured
 * delta is positive. Otherwise OFF (the as-shipped default). Throws for an
 * unknown id (a typo must fail loud, never silently resolve OFF).
 */
export function resolveCapabilityDefault(id: CapabilityId): ResolvedCapabilityDefault {
  const cap = V2_9_CAPABILITIES.find((c) => c.id === id);
  if (cap === undefined) {
    throw new Error(`Unknown capability id: ${String(id)}`);
  }
  const decision = ACTIVATED_CAPABILITIES.find((d) => d.capability === id);
  // Both gates: a recorded decision (with a positive measured delta) AND the
  // frozen-trust invariant (the capability must not target a frozen path).
  const targetsFrozenTrust = FROZEN_TRUST_PATHS.includes(cap.configPath);
  const effectiveDefaultOn =
    decision !== undefined && decision.measuredDeltaPts > 0 && !targetsFrozenTrust;
  return effectiveDefaultOn
    ? { id, effectiveDefaultOn: true, decision }
    : { id, effectiveDefaultOn: false };
}

/** Resolve every registered capability's effective default (one entry each). */
export function resolveAllCapabilityDefaults(): readonly ResolvedCapabilityDefault[] {
  return V2_9_CAPABILITIES.map((c) => resolveCapabilityDefault(c.id));
}
