// SPDX-License-Identifier: Apache-2.0
/**
 * Agent config — Autonomy honest-degrade path (PROFILE-03).
 *
 * Split out of `schema-agent-autonomy.ts` (which keeps the PROFILE-01
 * named-profile resolver) to hold the SEPARATE PROFILE-03 concern: when a host
 * precondition for the jail fails, downshift the resolved posture to `assistant`
 * and SURFACE a structured signal — never a silent unjailed fallback.
 *
 * 210/211 SEAM (RESEARCH Pitfall 5 / A4): the downshift is driven by a
 * preflight-RESULT INPUT (a boolean the caller passes in), NEVER a live
 * bubblewrap / `unshare` probe. The probe that PRODUCES that boolean is Phase
 * 211 (JAIL-03). Keeping the trigger an input keeps `degradeAutonomy` PURE
 * (AGENTS §2.2) and independently testable — this leaf imports nothing from the
 * daemon's sandbox-provider layer.
 *
 * Re-exported from `schema-agent-autonomy.ts` so consumers keep importing
 * `degradeAutonomy`/`AutonomyDownshift`/`AutonomyPreflightResult` from there
 * (and via the `@comis/core` barrel).
 *
 * @module
 */
import {
  AutonomyConfigSchema,
  resolveAutonomy,
  type AutonomyProfileName,
  type ResolvedAutonomy,
} from "./schema-agent-autonomy.js";

/** The host preconditions a jail-bearing posture depends on (210: the namespace preflight; 211 adds the probe that fills it). */
export interface AutonomyPreflightResult {
  /**
   * Whether the unprivileged-user-namespace (`unshare --user`/`--net`)
   * preflight passed. `false` means the jail cannot be built, so an
   * autonomy-bearing posture would run UNJAILED — which we refuse, downshifting
   * to `assistant` instead. In Phase 210 this is supplied by the caller (the
   * default at boot is `true`); the actual probe lands in Phase 211.
   */
  readonly namespacePreflightOk: boolean;
}

/**
 * The structured signal a downshift surfaces (PROFILE-03). Carried out of
 * {@link degradeAutonomy} so the daemon can emit a WARN + a `doctor` finding —
 * the operator is TOLD, never silently dropped to a safer posture. The
 * `errorKind` is the closed-union `"precondition"` (an unmet host guard), and
 * `hint` names the remediation.
 */
export interface AutonomyDownshift {
  /** The profile that was selected before the precondition failed. */
  readonly downshiftedFrom: AutonomyProfileName;
  /** Always `assistant` in M1 — the zero-surface safe floor. */
  readonly downshiftedTo: "assistant";
  /** Machine-readable reason (the failed precondition). */
  readonly reason: "namespace_preflight_failed";
  /** Operator-facing remediation (canonical logging field `hint`). */
  readonly hint: string;
  /** Closed-union errorKind — `"precondition"` = an unmet guard (AGENTS §2.7). */
  readonly errorKind: "precondition";
}

/** The actionable remediation surfaced on a namespace-preflight downshift. */
const NAMESPACE_PREFLIGHT_DOWNSHIFT_HINT =
  "Autonomy needs an unprivileged user namespace to build the jail, and the namespace preflight failed — downshifted to the 'assistant' profile (no orchestration surfaces). Enable unprivileged user namespaces (e.g. sysctl kernel.unprivileged_userns_clone=1 / kernel.apparmor_restrict_unprivileged_userns=0) and restart, or set autonomy.profile: assistant to silence this. See docs/agents/autonomy.";

/**
 * Honest legible degrade (PROFILE-03). Given a fully-resolved posture and the
 * host preflight RESULT, downshift to `assistant` (enabled false, zero caps) and
 * SURFACE a structured {@link AutonomyDownshift} when the namespace preflight
 * failed — never a silent enabled-but-unjailed fallback.
 *
 * PURE — a function of `(resolved, preflight)` only (no env/clock/fs, AGENTS
 * §2.2). The preflight boolean is an INPUT; the probe that produces it is Phase
 * 211 (JAIL-03 / RESEARCH Pitfall 5). The downshift is a no-op (no signal) when
 * the preflight passed OR the posture is already `assistant` (nothing to take
 * away — idempotent).
 *
 * @param resolved the posture from {@link resolveAutonomy}.
 * @param preflight the host preconditions (210: caller-supplied; 211: probed).
 * @returns the (possibly-downshifted) posture + an optional surfaced signal.
 */
export function degradeAutonomy(
  resolved: ResolvedAutonomy,
  preflight: AutonomyPreflightResult,
): { resolved: ResolvedAutonomy; downshift?: AutonomyDownshift } {
  // Preflight passed, or there is nothing to downshift FROM (already the
  // zero-surface floor): return the posture untouched, no signal.
  if (preflight.namespacePreflightOk || resolved.profile === "assistant") {
    return { resolved };
  }
  // Failed precondition on an autonomy-bearing posture → fall to the assistant
  // floor and SAY SO. Resolve the canonical `assistant` shape so the downshifted
  // posture is byte-identical to a selected `assistant` (enabled false, 0 caps).
  // Parse through the schema first so the `AutonomyConfig` is fully-defaulted
  // (the resolver's param is the OUTPUT type — `message` is required), matching
  // the Plan-02 m1Notice/`tsc`-vs-vitest typing precedent.
  const downshifted = resolveAutonomy(AutonomyConfigSchema.parse({ profile: "assistant" }));
  const downshift: AutonomyDownshift = {
    downshiftedFrom: resolved.profile,
    downshiftedTo: "assistant",
    reason: "namespace_preflight_failed",
    hint: NAMESPACE_PREFLIGHT_DOWNSHIFT_HINT,
    errorKind: "precondition",
  };
  return { resolved: downshifted, downshift };
}
