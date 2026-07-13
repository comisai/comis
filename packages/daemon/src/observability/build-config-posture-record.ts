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
import { isProviderModelChimera, resolvePricingState, modelResolvesInCatalog } from "@comis/core";
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
 * `true` when ANY configured agent set `skills.terminal.unsafeDisableSandbox: true` — the operator
 * opt-out of the terminal-driver bwrap jail (a driven CLI runs unsandboxed). A RELAXED security
 * default that should be surfaced at boot, not silent — the peer of `browser.noSandbox`. A boolean,
 * never agent ids or config bodies. Lives here (not inline in daemon.ts) to keep daemon.ts under its
 * 3000-line cap.
 */
export function anyAgentTerminalUnsafeDisableSandbox(
  agents: Readonly<Record<string, { skills?: { terminal?: { unsafeDisableSandbox?: boolean } } }>>,
): boolean {
  return Object.values(agents).some((a) => a.skills?.terminal?.unsafeDisableSandbox === true);
}

// isLoopbackHost moved to @comis/core (security/loopback-host) so the gateway's
// boot log shares the SAME TLS-off-is-benign-on-loopback judgment as this
// posture record and the gateway-exposure security check. Re-exported so the
// existing daemon-side consumers (daemon.ts, tests) keep one import site.
export { isLoopbackHost } from "@comis/core";

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

/**
 * Count configured agents whose (provider, model) does NOT resolve in the model
 * catalog — the fail-closed-to-nano class (`modelRegistry.find()` → undefined →
 * FAIL_CLOSED_PROFILE nano/8192, so every non-trivial turn context-exhausts).
 * Neither the chimeric NOR the pricing detector catches it: a non-native provider
 * like `openai-codex` resolves `"free"` (not `"unknown"`) for an unknown model, and
 * the model family still parses, so both return clean (the live fleet-marathon
 * `gpt-5.6` incident). Operator-declared custom models (`providers.entries.<p>.models`)
 * are legitimately absent from the static catalog and are EXEMPTED (no false-flag).
 * Lives here (not inline in daemon.ts) to keep daemon.ts under its 3000-line cap.
 * Count only — the caller persists the COUNT, never agent ids/model names.
 */
export function countUnresolvedModels(
  agents: Readonly<Record<string, { provider?: string; model?: string }>>,
  providersEntries: Readonly<Record<string, { models?: ReadonlyArray<{ id: string }> }>> | undefined,
): number {
  let count = 0;
  for (const a of Object.values(agents)) {
    if (typeof a.provider !== "string" || typeof a.model !== "string") continue;
    // Exempt operator-declared custom models (legitimately not in the static catalog).
    const isCustom = providersEntries?.[a.provider]?.models?.some((m) => m.id === a.model) ?? false;
    if (isCustom) continue;
    if (!modelResolvesInCatalog(a.provider, a.model)) count++;
  }
  return count;
}

/**
 * Media provider → the SecretManager env key its credential comes from. A
 * provider absent from this map needs NO credential and can never be a gap:
 * `auto` (follows the agent's main provider, resolved on that path), `local`
 * (keyless whisper STT), `edge`/`piper` (keyless TTS). `openai-codex` is
 * handled separately (OAuth, not an env key — see countMediaCredentialGaps).
 */
const MEDIA_PROVIDER_ENV_KEY: Readonly<Record<string, string>> = {
  openai: "OPENAI_API_KEY",
  google: "GOOGLE_API_KEY",
  fal: "FAL_KEY",
  openrouter: "OPENROUTER_API_KEY",
  groq: "GROQ_API_KEY",
  deepgram: "DEEPGRAM_API_KEY",
  elevenlabs: "ELEVENLABS_API_KEY",
  xai: "XAI_API_KEY",
};

/**
 * Count configured media pipelines (imageGeneration / transcription / tts /
 * videoGeneration) whose PINNED provider's credential is ABSENT — the pipeline
 * will fail at first use (the incident-day image-gen unavailability). The
 * chimeric/pricing detectors only watch the main COMPLETION pipeline, so a
 * media credential gap was invisible to `comis fleet`; this makes it a boot
 * COUNT (never provider names — the no-free-text contract).
 *
 * `hasSecret` is `container.secretManager.has`. `imageCodexAvailable` is the
 * store-aware image-codex availability the image bundle already resolved
 * (`openai-codex` uses an OAuth profile, not an env key, and only appears in
 * the image pipeline) — reused so a cold in-memory cache does not false-flag a
 * logged-in Codex profile (the trap the image fix closed).
 */
export function countMediaCredentialGaps(
  media:
    | {
        imageGeneration?: { provider?: string };
        transcription?: { provider?: string };
        tts?: { provider?: string };
        videoGeneration?: { provider?: string };
      }
    | undefined,
  hasSecret: (key: string) => boolean,
  imageCodexAvailable: boolean,
): number {
  if (!media) return 0;
  const providers = [
    media.imageGeneration?.provider,
    media.transcription?.provider,
    media.tts?.provider,
    media.videoGeneration?.provider,
  ];
  let gaps = 0;
  for (const p of providers) {
    if (typeof p !== "string") continue;
    if (p === "openai-codex") {
      if (!imageCodexAvailable) gaps++;
      continue;
    }
    const key = MEDIA_PROVIDER_ENV_KEY[p];
    if (key === undefined) continue; // keyless / follow-main → never a gap
    if (!hasSecret(key)) gaps++;
  }
  return gaps;
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
   * Number of configured agents whose (provider, model) does NOT resolve in the
   * model catalog and is not an operator-declared custom model — the
   * fail-closed-to-nano class (see {@link countUnresolvedModels}). A COUNT, never
   * agent ids or model names. Computed in daemon.ts via `countUnresolvedModels`
   * over the configured agents at boot. Optional (defaults to 0 in the record).
   */
  unresolvedModelCount?: number;
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
  /**
   * `true` when the operator set `browser.noSandbox: true` — a RELAXED security
   * default (Chromium runs WITHOUT its own sandbox while the browser tool
   * processes untrusted web content). Distinct from
   * `sandboxNoDowngradeDisabled` (the agent-to-agent spawn sandbox). A relaxed
   * security default should be surfaced at boot, not silent. A boolean, never
   * config bodies. Optional (defaults to `false`).
   */
  browserNoSandbox?: boolean;
  /**
   * `true` when ANY configured agent set `skills.terminal.unsafeDisableSandbox: true` — the
   * operator opt-out of the terminal-driver bwrap jail (a driven coding CLI runs unsandboxed). A
   * RELAXED security default (the child has no filesystem/network/uid confinement), distinct from
   * `browserNoSandbox` (the Chromium sandbox) and `sandboxNoDowngradeDisabled` (the agent-to-agent
   * spawn sandbox). Should be surfaced at boot, not silent. A boolean, never agent ids or config
   * bodies. Computed via {@link anyAgentTerminalUnsafeDisableSandbox} at boot. Optional (defaults
   * to `false`).
   */
  terminalUnsafeDisableSandbox?: boolean;
  /**
   * Number of configured media pipelines (image / transcription / tts / video)
   * whose PINNED provider's credential is absent — the pipeline will fail at
   * first use. A COUNT, never provider names. Computed via
   * {@link countMediaCredentialGaps} at boot. Optional (defaults to 0).
   */
  mediaCredentialGapCount?: number;
}

/**
 * Write a one-shot `config_posture` row to `obs_diagnostics` at boot.
 *
 * No-ops when `obsStore` is `undefined` (observability persistence disabled) —
 * the `?.` is mandatory so a disabled-persistence boot cannot crash shutdown.
 * Severity is `"warning"` when ANY posture issue is present — `tlsOff`, a
 * stranded finding, `canaryFallbackActive`, `servedBelowConfiguredCount > 0`,
 * `chimericModelCount > 0`, `unresolvedModelCount > 0`, `pricingGapCount > 0`,
 * `importedNonAllowlistedRegistryCount > 0`, `sandboxNoDowngradeDisabled`,
 * `browserNoSandbox`, `terminalUnsafeDisableSandbox`, or
 * `mediaCredentialGapCount > 0` — else `"info"`. The timestamp comes from the
 * injected `ClockPort` — never `Date.now()` (globals gate).
 */
export function buildConfigPostureRecord(
  obsStore: ObservabilityStore | undefined,
  inputs: ConfigPostureInputs,
  clock: ClockPort,
): void {
  const chimericModelCount = inputs.chimericModelCount ?? 0;
  const unresolvedModelCount = inputs.unresolvedModelCount ?? 0;
  const pricingGapCount = inputs.pricingGapCount ?? 0;
  const importedSkillCount = inputs.importedSkillCount ?? 0;
  const importedNonAllowlistedRegistryCount = inputs.importedNonAllowlistedRegistryCount ?? 0;
  const sandboxNoDowngradeDisabled = inputs.sandboxNoDowngradeDisabled ?? false;
  const browserNoSandbox = inputs.browserNoSandbox ?? false;
  const terminalUnsafeDisableSandbox = inputs.terminalUnsafeDisableSandbox ?? false;
  const mediaCredentialGapCount = inputs.mediaCredentialGapCount ?? 0;
  const hasIssue =
    inputs.tlsOff ||
    inputs.strandedFindings.length > 0 ||
    inputs.canaryFallbackActive ||
    inputs.servedBelowConfiguredCount > 0 ||
    chimericModelCount > 0 ||
    unresolvedModelCount > 0 ||
    pricingGapCount > 0 ||
    importedNonAllowlistedRegistryCount > 0 ||
    sandboxNoDowngradeDisabled ||
    browserNoSandbox ||
    terminalUnsafeDisableSandbox ||
    mediaCredentialGapCount > 0;

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
      // Agents whose (provider, model) does NOT resolve in the catalog (and is not a
      // custom model) → fail-closed-to-nano. A COUNT, never agent ids/model names.
      unresolvedModelCount,
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
      // Chromium runs WITHOUT its sandbox (browser.noSandbox: true) — a relaxed
      // security default surfaced at boot, not silent. A boolean, never bodies.
      browserNoSandbox,
      // A driven coding CLI runs WITHOUT the bwrap jail
      // (skills.terminal.unsafeDisableSandbox: true) — a relaxed security default surfaced at
      // boot, not silent. A boolean, never agent ids or bodies.
      terminalUnsafeDisableSandbox,
      // Configured media pipelines whose pinned provider's credential is
      // absent (image/transcription/tts/video). A COUNT, never provider names.
      mediaCredentialGapCount,
    }),
  });
}
