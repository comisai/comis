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
import type { ObservabilityStore } from "@comis/memory";
import type { StrandedFinding } from "../wiring/setup-storage-mismatch-warn.js";

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
  const hasIssue =
    inputs.tlsOff ||
    inputs.strandedFindings.length > 0 ||
    inputs.canaryFallbackActive ||
    inputs.servedBelowConfiguredCount > 0;

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
    }),
  });
}
