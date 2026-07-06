// SPDX-License-Identifier: Apache-2.0
/**
 * Record a config-posture SNAPSHOT at boot.
 *
 * Captures the three log-file-only security-posture FINDINGS as a single
 * point-in-time `obs_diagnostics` row at startup, so the fleet lens
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
 * is the correct point-in-time model. Because the snapshot
 * is recorded once per boot regardless of WARN frequency, the recurrence gate
 * does not gate this snapshot away.
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
import type { ProvenanceStore } from "@comis/skills";
import type { StrandedFinding } from "../wiring/setup-storage-mismatch-warn.js";

/**
 * Count configured agents whose NATIVE provider family disagrees with
 * their model id's family (the provider/model chimera). Conservative — gateway/custom
 * providers + an unknown model family never flag (see `isProviderModelChimera`).
 * Lives here (not inline in daemon.ts) to keep daemon.ts under its 3000-line cap.
 * Count only — the caller persists the COUNT, never agent ids/model names.
 */
export function countChimericModels(
  agents: Readonly<Record<string, { provider?: string; model?: string }>>,
): number {
  return Object.values(agents).filter(
    (a) => typeof a.provider === "string" && typeof a.model === "string" && isProviderModelChimera(a.provider, a.model),
  ).length;
}

/**
 * Is the gateway bound to a LOOPBACK address?
 *
 * A loopback-bound gateway has no off-host network exposure, so running it WITHOUT
 * TLS is benign — it matches the `gateway-exposure` security check, which flags only
 * a `0.0.0.0`-without-TLS bind as critical, never a loopback one. Used to suppress the
 * `tlsOff` config-posture finding on a loopback bind so it does not become the fleet
 * `likelyRootCause` headline on a dev / loopback box (where it is noise). A non-loopback
 * bind (`0.0.0.0` or a routable IP) WITHOUT TLS still flags — correct for production.
 *
 * `gateway.host` defaults to `127.0.0.1`, so a default daemon is loopback (benign by
 * default); only an operator-set non-loopback host opts into the TLS-off finding. An
 * absent/unknown host is treated as NON-loopback (conservative — never suppress on doubt).
 */
export function isLoopbackHost(host: string | undefined): boolean {
  if (typeof host !== "string") return false;
  const h = host.trim().toLowerCase();
  return h === "127.0.0.1" || h === "::1" || h === "localhost" || h.startsWith("127.");
}

/**
 * Count configured agents burning tokens on remote-unknown-priced models
 * — those whose configured `provider`+`model` resolves to the `"unknown"` pricing
 * state (a NATIVE single-family provider with NO catalog rate — the
 * fail-open where `resolveModelPricing` silently returns $0, masking a phantom cost
 * as free). A `"free"` local/gateway provider (honest $0) and a `"priced"` agent are
 * NOT counted — so a local-first deployment is never false-flagged. Consumes the
 * shipped 3-state {@link resolvePricingState} directly, NEVER a catalog-presence
 * boolean. Lives here (not inline in daemon.ts) to keep daemon.ts under its 3000-line
 * cap. Count only — the caller persists the COUNT, never agent ids/model names.
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

/** The minimal agent-config shape the imported-drift producer reads: each agent's
 *  registry allowlist under `skills.import.registries`. */
type AgentRegistriesConfig = Readonly<
  Record<string, { skills?: { import?: { registries?: readonly string[] } } }>
>;

/**
 * Normalize a registry to a port-preserving, exact origin — the SAME rule the
 * import-time resolver applies (`new URL().origin` lowercases the host + scheme,
 * keeps a non-default port, drops a default one), so a stored origin and a config
 * allowlist entry compare consistently regardless of a trailing slash or casing.
 * A value that is not a URL (e.g. a bare registry token) has no origin — it folds
 * to its trimmed self so it still compares by exact value, never throwing.
 */
function normalizeRegistryOrigin(value: string): string {
  try {
    return new URL(value).origin;
  } catch {
    return value.trim();
  }
}

/**
 * Count the imported-skill posture over a provenance store: `total` is the number
 * of provenance records; `drift` is how many carry a recorded `registry` that is
 * NO LONGER in its APPLICABLE allowlist (allowlist drift after the fact — the only
 * way a live import can point at a non-allowlisted registry, since the import-time
 * gate hard-refuses).
 *
 * The applicable allowlist is resolved PER-RECORD, mirroring the per-agent
 * import-time gate: a `shared`-scope record checks the DEFAULT agent's
 * `skills.import.registries`; a `local` record checks `record.agentId`'s. A
 * union-of-all-agents shortcut would under-count drift. Both the record's registry
 * and every allowlist entry are normalized ({@link normalizeRegistryOrigin}) before
 * the membership check. A record with no `registry` (archive/github/upload) never
 * counts as drift. COUNT only — the caller persists the counts, never registry
 * origins or agent ids.
 *
 * Lives here (not inline in daemon.ts) beside the sibling boot-count helpers to
 * keep daemon.ts under its 3000-line cap.
 */
export function countImportedNonAllowlisted(
  store: ProvenanceStore,
  agents: AgentRegistriesConfig,
  defaultAgentId: string,
): { total: number; drift: number } {
  let total = 0;
  let drift = 0;
  for (const record of Object.values(store)) {
    total++;
    const registry = record.registry;
    if (typeof registry !== "string" || registry.length === 0) continue; // archive/github/upload — never drift.
    const capsAgentId = record.scope === "shared" ? defaultAgentId : record.agentId;
    const allowlist = agents[capsAgentId]?.skills?.import?.registries ?? [];
    const normalizedAllowed = new Set(allowlist.map(normalizeRegistryOrigin));
    if (!normalizedAllowed.has(normalizeRegistryOrigin(registry))) drift++;
  }
  return { total, drift };
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
   * Providers whose Ollama-served window < configured at
   * this boot — a COUNT, never provider names (the no-free-text contract).
   * Derived in daemon.ts from the SAME comparison results the served-window boot
   * WARN used (one comparison, two surfaces — no drift).
   */
  servedBelowConfiguredCount: number;
  /**
   * Number of configured agents whose
   * NATIVE provider family disagrees with their model id's family (the provider/model
   * chimera — e.g. `provider: anthropic` + a qwen model → phantom profile). A
   * COUNT, never agent ids or model names (the no-free-text contract). Computed in
   * daemon.ts via `isProviderModelChimera` over the configured agents at boot.
   * Optional (defaults to 0 in the record) so existing callers/tests need no change.
   */
  chimericModelCount?: number;
  /**
   * Number of configured agents burning tokens
   * on remote-unknown-priced models (`resolvePricingState == "unknown"` — a NATIVE
   * provider with no catalog rate, the fail-open where spend is silently
   * under-counted as $0). A COUNT, never agent ids or model names (the no-free-text
   * contract). Computed in daemon.ts via `countPricingGaps` over the configured
   * agents at boot. Optional (defaults to 0 in the record).
   */
  pricingGapCount?: number;
  /**
   * Total number of imported skills (provenance records) at
   * boot. A COUNT, never a skill name or registry origin. Computed in daemon.ts
   * via `countImportedNonAllowlisted` over `readProvenanceStore`. Optional
   * (defaults to 0 in the record) so existing callers/tests need no change.
   */
  importedSkillCount?: number;
  /**
   * Number of imported skills whose recorded `registry`
   * is NO LONGER in its applicable allowlist (`skills.import.registries`, resolved
   * per-record: shared→default agent, local→record.agentId) — allowlist drift
   * after the fact. Non-zero flips severity to warning. A COUNT, never a registry
   * origin or agent id (the no-free-text contract). Computed in daemon.ts via
   * `countImportedNonAllowlisted`. Optional (defaults to 0).
   */
  importedNonAllowlistedRegistryCount?: number;
  /**
   * `true` when the operator set
   * `security.agentToAgent.sandboxNoDowngrade: false` — a RELAXED security default
   * (a spawned child may run with a weaker sandbox posture than its parent). A
   * relaxed security default should be surfaced at boot, not
   * silent. A boolean, never config bodies. Optional (defaults to `false`).
   */
  sandboxNoDowngradeDisabled?: boolean;
}

/**
 * Write a one-shot `config_posture` row to `obs_diagnostics` at boot.
 *
 * No-ops when `obsStore` is `undefined` (observability persistence disabled) —
 * the `?.` is mandatory so a disabled-persistence boot cannot crash shutdown.
 * Severity is `"warning"` when ANY posture issue is present
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
  const importedSkillCount = inputs.importedSkillCount ?? 0;
  const importedNonAllowlistedRegistryCount = inputs.importedNonAllowlistedRegistryCount ?? 0;
  const sandboxNoDowngradeDisabled = inputs.sandboxNoDowngradeDisabled ?? false;
  const hasIssue =
    inputs.tlsOff ||
    inputs.strandedFindings.length > 0 ||
    inputs.canaryFallbackActive ||
    inputs.servedBelowConfiguredCount > 0 ||
    chimericModelCount > 0 ||
    pricingGapCount > 0 ||
    importedNonAllowlistedRegistryCount > 0 ||
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
      // Agents booted with a NATIVE provider + a foreign model family
      // (the provider/model chimera). A COUNT, never agent ids/model names (no free text).
      chimericModelCount,
      // Agents burning tokens on remote-unknown-priced models
      // (resolvePricingState == "unknown"). A COUNT, never agent ids/model names.
      pricingGapCount,
      // Total imported skills (provenance records) + how many carry a recorded
      // registry no longer in its applicable allowlist (allowlist drift). COUNTS
      // only, never a registry origin or agent id (the no-free-text contract).
      importedSkillCount,
      importedNonAllowlistedRegistryCount,
      // The no-downgrade sandbox invariant is DISABLED (relaxed
      // default surfaced at boot, not silent). A boolean, never config bodies.
      sandboxNoDowngradeDisabled,
    }),
  });
}
