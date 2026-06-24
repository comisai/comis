// SPDX-License-Identifier: Apache-2.0
/**
 * I3 — record a config-posture SNAPSHOT at boot.
 *
 * Captures the three log-file-only security-posture FINDINGS as a single
 * point-in-time `obs_diagnostics` row at startup, so the fleet lens (Phase 161)
 * can query a daemon's posture without grepping `daemon.log`:
 *   - `tlsOff`               — the gateway is running without TLS (recomputed
 *                              from `gateway.{tls, allowInsecureHttp}` at the
 *                              boot site — the gateway WARN is NOT intercepted).
 *   - `allowInsecureHttp`    — the operator explicitly opted into plaintext HTTP.
 *   - `stranded`             — stranded-secret COUNTS per credential family
 *                              ({stranded: <closed label>, entryCount: <count>})
 *                              from the refactored `checkStorageModeConsistency`
 *                              probe — COUNTS only, NEVER a secret value.
 *   - `canaryFallbackActive`  — daemon-global boolean: `true` when `CANARY_SECRET`
 *                              is absent, so EVERY agent falls back to a
 *                              deterministic per-agent canary derivation
 *                              (setup-agents-runtime.ts) instead of the
 *                              operator-set secret. An HONEST presence proxy, not
 *                              a per-agent tally: `CANARY_SECRET` is folded into
 *                              the boot `mergedEnv` store-wins (buildMergedEnv),
 *                              so the env read at the boot site already honors an
 *                              encrypted/file secret-store entry — the same
 *                              source the per-agent path resolves. Deep per-agent
 *                              plumbing is avoided per KISS.
 *
 * This is a boot-time SNAPSHOT — a direct `insertDiagnostic`, NOT an event. An
 * event would imply recurrence/streaming and go stale; a once-per-boot record
 * is the correct point-in-time model (RESEARCH Pitfall 4). Because the snapshot
 * is recorded once per boot regardless of WARN frequency, the recurrence gate
 * does not gate I3 away.
 *
 * `details` carries ONLY booleans + counts + closed stranded labels — no secret
 * values, no cert paths, no canary secrets, no free text. The stranded findings
 * are the SAME count-only objects the probe already WARNs with (bounded-payload
 * discipline, §2.7).
 *
 * @module
 */
import type { ClockPort } from "@comis/core";
import { isProviderModelChimera, resolvePricingState } from "@comis/core";
import type { ObservabilityStore } from "@comis/memory";
import type { StrandedFinding } from "../wiring/setup-storage-mismatch-warn.js";

/**
 * RESOLVE-01: count configured agents whose NATIVE provider family disagrees with
 * their model id's family (the `ffe11736` chimera). Conservative — gateway/custom
 * providers + an unknown model family never flag (see `isProviderModelChimera`).
 * Lives here (not inline in daemon.ts) to keep daemon.ts under its 3000-line cap.
 * Count only — the caller persists the COUNT, never agent ids/model names (I3).
 */
export function countChimericModels(
  agents: Readonly<Record<string, { provider?: string; model?: string }>>,
): number {
  return Object.values(agents).filter(
    (a) => typeof a.provider === "string" && typeof a.model === "string" && isProviderModelChimera(a.provider, a.model),
  ).length;
}

/**
 * SPEND-05: count configured agents burning tokens on remote-unknown-priced models
 * — those whose configured `provider`+`model` resolves to the `"unknown"` pricing
 * state (a NATIVE single-family provider with NO catalog rate — the `ffe11736`
 * fail-open where `resolveModelPricing` silently returns $0, masking a phantom cost
 * as free). A `"free"` local/gateway provider (honest $0) and a `"priced"` agent are
 * NOT counted — so a local-first deployment is never false-flagged. Consumes the
 * shipped 3-state {@link resolvePricingState} directly, NEVER a catalog-presence
 * boolean. Lives here (not inline in daemon.ts) to keep daemon.ts under its 3000-line
 * cap. Count only — the caller persists the COUNT, never agent ids/model names (I3).
 */
export function countPricingGaps(
  agents: Readonly<Record<string, { provider?: string; model?: string }>>,
): number {
  return Object.values(agents).filter(
    (a) =>
      typeof a.provider === "string" &&
      typeof a.model === "string" &&
      resolvePricingState(a.provider, a.model) === "unknown",
  ).length;
}

/** The boot-time config-posture inputs (counts/booleans/closed labels only). */
export interface ConfigPostureInputs {
  /** The gateway is running without TLS (and not explicitly allowing insecure HTTP). */
  tlsOff: boolean;
  /** The operator opted into plaintext HTTP (`gateway.allowInsecureHttp`). */
  allowInsecureHttp: boolean;
  /** Stranded-secret COUNTS per family — never a secret value. */
  strandedFindings: StrandedFinding[];
  /**
   * Daemon-global boolean: `true` when `CANARY_SECRET` is absent (every agent
   * uses the deterministic per-agent canary fallback), `false` when it is set.
   * An honest presence proxy keyed on `CANARY_SECRET` in env-or-secret-store
   * (the boot `mergedEnv` is store-wins) — NOT a per-agent count.
   */
  canaryFallbackActive: boolean;
  /**
   * KNOB-03 (Phase 176): providers whose Ollama-served window < configured at
   * this boot — a COUNT, never provider names (the no-free-text contract).
   * Derived in daemon.ts from the SAME comparison results the KNOB-01 boot
   * WARN used (one comparison, two surfaces — no drift).
   */
  servedBelowConfiguredCount: number;
  /**
   * RESOLVE-01 (observability-excellence): number of configured agents whose
   * NATIVE provider family disagrees with their model id's family (the `ffe11736`
   * chimera — e.g. `provider: anthropic` + a qwen model → phantom profile). A
   * COUNT, never agent ids or model names (the no-free-text contract). Computed in
   * daemon.ts via `isProviderModelChimera` over the configured agents at boot.
   * Optional (defaults to 0 in the record) so existing callers/tests need no change.
   */
  chimericModelCount?: number;
  /**
   * SPEND-05 (observability-excellence): number of configured agents burning tokens
   * on remote-unknown-priced models (`resolvePricingState == "unknown"` — a NATIVE
   * provider with no catalog rate, the `ffe11736` fail-open where spend is silently
   * under-counted as $0). A COUNT, never agent ids or model names (the no-free-text
   * contract). Computed in daemon.ts via `countPricingGaps` over the configured
   * agents at boot. Optional (defaults to 0 in the record).
   */
  pricingGapCount?: number;
  /**
   * RELAX-SURFACE (30uc-20260624, Track-M): `true` when the operator set
   * `security.agentToAgent.sandboxNoDowngrade: false` — a RELAXED security default
   * (a spawned child may run with a weaker sandbox posture than its parent). The
   * Track-M relaxation-surfacing rule wants a relaxed default surfaced at boot, not
   * silent. A boolean, never config bodies. Optional (defaults to `false`).
   */
  sandboxNoDowngradeDisabled?: boolean;
}

/**
 * Write a one-shot `config_posture` row to `obs_diagnostics` at boot.
 *
 * No-ops when `obsStore` is `undefined` (observability persistence disabled) —
 * the `?.` is mandatory so a disabled-persistence boot cannot crash shutdown
 * (Pitfall 5). Severity is `"warning"` when ANY posture issue is present
 * (`tlsOff` OR a stranded finding OR `canaryFallbackActive` OR
 * `servedBelowConfiguredCount > 0`), else `"info"`. The timestamp comes from
 * the injected `ClockPort` — never `Date.now()` (globals gate).
 */
export function buildConfigPostureRecord(
  obsStore: ObservabilityStore | undefined,
  inputs: ConfigPostureInputs,
  clock: ClockPort,
): void {
  const chimericModelCount = inputs.chimericModelCount ?? 0;
  const pricingGapCount = inputs.pricingGapCount ?? 0;
  const sandboxNoDowngradeDisabled = inputs.sandboxNoDowngradeDisabled ?? false;
  const hasIssue =
    inputs.tlsOff ||
    inputs.strandedFindings.length > 0 ||
    inputs.canaryFallbackActive ||
    inputs.servedBelowConfiguredCount > 0 ||
    chimericModelCount > 0 ||
    pricingGapCount > 0 ||
    sandboxNoDowngradeDisabled;

  obsStore?.insertDiagnostic({
    timestamp: clock.now(),
    category: "config_posture",
    severity: hasIssue ? "warning" : "info",
    message: "config_posture",
    details: JSON.stringify({
      tlsOff: inputs.tlsOff,
      allowInsecureHttp: inputs.allowInsecureHttp,
      stranded: inputs.strandedFindings,
      canaryFallbackActive: inputs.canaryFallbackActive,
      servedBelowConfiguredCount: inputs.servedBelowConfiguredCount,
      // RESOLVE-01: agents booted with a NATIVE provider + a foreign model family
      // (the ffe11736 chimera). A COUNT, never agent ids/model names (no free text).
      chimericModelCount,
      // SPEND-05: agents burning tokens on remote-unknown-priced models
      // (resolvePricingState == "unknown"). A COUNT, never agent ids/model names.
      pricingGapCount,
      // RELAX-SURFACE: the no-downgrade sandbox invariant is DISABLED (relaxed
      // default surfaced at boot, not silent). A boolean, never config bodies.
      sandboxNoDowngradeDisabled,
    }),
  });
}
