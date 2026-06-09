// SPDX-License-Identifier: Apache-2.0
/**
 * Capability-gated reliability defaults resolver (Phase 158).
 *
 * SD1/SD2/SD3: for small/nano models, resolves capability defaults
 * for GoalAnchor, rag.baseFloor, and verification critic.
 * frontier/mid: returns all OFF (behavior-neutral, byte-identical to v2.14).
 *
 * Precedence (load-bearing): explicit per-agent config > capability default > off.
 * Implementation: `resolved = explicit ?? capabilityDefault(class)`.
 *
 * Fail-closed: unknown/unset config → off (never silently enables a feature).
 *
 * @module
 */

import type { ModelProfile } from "./model-profile.js";
import type { PerAgentConfig, OperationModels } from "@comis/core";
import { resolveOperationModel, resolveProviderFamily } from "../model/operation-model-resolver.js";

// ---------------------------------------------------------------------------
// Named constants
// ---------------------------------------------------------------------------

/**
 * Conservative base-score floor for small/nano models (SD2).
 *
 * Proven by Phase-153 poison fixture: blocks recall entries with base≤0.12
 * (CASE A in memory-recall-floor.test.ts: base=0.12 < 0.15 → dropped by
 * passesBaseFloor gate). Keeps entries with base≥0.15 (legit recall).
 *
 * Rationale: 0.15 is the smallest floor that drops the confirmed poison
 * (base=0.12) without nuking good recall (CASE B: base=0.40 survives).
 * Accepted tradeoff: conservative — an operator who wants no floor on a
 * small model can set capabilityClassOverride:"frontier" to disable it.
 */
const SMALL_NANO_DEFAULT_BASE_FLOOR = 0.15 as const;

/**
 * Keyless providers where the verification critic can auto-enable (SD3 cost-gate).
 *
 * Mirrors KEYLESS_CRITIC_PROVIDERS in verification-gate.ts — kept separate to
 * avoid a circular import between scaffold-defaults and verification-gate.
 * // Parity with verification-gate.ts KEYLESS_CRITIC_PROVIDERS is asserted in Plan 02 (cross-file).
 *
 * WR-02: a cloud-keyed provider (anthropic, openai) can never trigger the
 * auto-critic default — the KEYLESS_CRITIC_PROVIDERS check is the primary barrier.
 * SD3 Test 11 proves frontier→false regardless.
 */
const KEYLESS_CRITIC_PROVIDERS = new Set<string>(["ollama", "lm-studio"]);

/** SD6: per-file bootstrap.maxChars default for small/nano.
 *  At 3_500, AGENTS.md (6,780 chars) truncates to head(2,450)+tail(700);
 *  all other workspace files (≤2,844 chars) are included whole.
 *  Rationale: tames the observed 495% bootstrap-budget warning without truncating
 *  identity files (SOUL/IDENTITY/USER/ROLE/TOOLS/HEARTBEAT/BOOT all under 3,500). */
const SMALL_NANO_DEFAULT_BOOTSTRAP_MAX_CHARS = 3_500 as const;

/** The schema .default() value for bootstrap.maxChars (BootstrapConfigSchema.default(20_000)).
 *  Serves as the "unset" sentinel: an operator who has NOT set bootstrap.maxChars in config
 *  receives exactly 20_000 from the parsed PerAgentConfig.
 *  Detection: configuredMaxChars === BOOTSTRAP_MAX_CHARS_SENTINEL → apply capability default.
 *  NOTE: an operator who explicitly sets bootstrap.maxChars:20000 also triggers the sentinel;
 *  document in D2 that to force 20_000 on a small model, use capabilityClassOverride:"frontier". */
const BOOTSTRAP_MAX_CHARS_SENTINEL = 20_000 as const;

/** SD7/F1: active-tool ceiling for the `small` capability class.
 *  Keeps CORE_TOOLS (~15) + recently-used head-room + warm tools active;
 *  defers cold long-tail behind discover_tools (no capability removal).
 *  Retuned F1 from 40→24: 15 CORE_TOOLS + 9 discretionary slots.
 *  At 24 tools × ~300 chars avg ≈ 7K chars (vs 12K at 40) — ~750–1250 tokens saved. */
const SMALL_DEFAULT_ACTIVE_TOOL_CEILING = 24 as const;

/** SD9/F2: total bootstrap budget for small/nano. Caps the SUM of all bootstrap file chars.
 *  Per-file cap (3_500) still applies as an upper bound per file; this cap is the aggregate.
 *  Rationale: only AGENTS.md (6780) exceeds 3500 so per-file trimming only trims that one
 *  file — total bootstrap stays ~12.9K. A total cap of 5_000 forces proportional reduction. */
const SMALL_NANO_DEFAULT_BOOTSTRAP_TOTAL_CHARS = 5_000 as const;

// ---------------------------------------------------------------------------
// Exported types
// ---------------------------------------------------------------------------

/**
 * Resolved capability-gated defaults for a single agent execution.
 *
 * All three gates follow: explicit config > capability default > off.
 */
export interface ScaffoldDefaults {
  /**
   * SD1: effective GoalAnchor enabled flag.
   *
   * small/nano unset → true (capability default ON).
   * frontier/mid unset → false (byte-identical to v2.14).
   * Explicit config.goalAnchor.enabled always wins (boolean).
   */
  goalAnchorEnabled: boolean;
  /**
   * SD2: effective rag.baseFloor (0 = no floor).
   *
   * small/nano with baseFloor=0 (schema default/"unset") → SMALL_NANO_DEFAULT_BASE_FLOOR (0.15).
   * frontier/mid with baseFloor=0 → 0 (byte-identical to v2.14).
   * Explicit config.rag.baseFloor > 0 always wins.
   *
   * Note: 0 is both the schema default and an explicit "disable floor" sentinel.
   * An operator who wants no floor on a small model must use capabilityClassOverride:"frontier".
   */
  baseFloor: number;
  /**
   * SD3: effective verification critic enabled flag (cost-gated).
   *
   * Auto-ON only when: small/nano + keyless provider (ollama/lm-studio) +
   * a distinct cheaper model is configured (operationModels.verification resolves
   * to a model distinct from the primary via explicit_config).
   * Explicit config.verification.enabled always wins (boolean).
   */
  verificationEnabled: boolean;
  /**
   * SD3 / WR-01: the model the verification critic MUST run on when it runs —
   * the resolved DISTINCT CHEAP verification operation model the cost-gate gated
   * on (or the operator's configured verification model in the explicit force-on
   * path), NEVER silently the agent's primary. The cost-gate's whole rationale
   * ("never silently doubles local-CPU inference latency") is false if the critic
   * auto-enables on a cheap model's existence but then runs the primary.
   *
   * `undefined` when verification is off, OR when no critic-context was supplied,
   * OR when the resolved verification provider is not keyless. The synthetic
   * critic deps run keyless (apiKey:""), so a keyed resolved provider is not
   * exposed here — the caller falls back to the agent's (already-keyless) primary.
   */
  criticModel?: { provider: string; modelId: string };
  /**
   * SD6: effective bootstrap.maxChars per-file budget.
   *
   * small/nano with default 20_000 → SMALL_NANO_DEFAULT_BOOTSTRAP_MAX_CHARS (3_500).
   * frontier/mid: always 20_000.
   * Explicit config.bootstrap.maxChars !== BOOTSTRAP_MAX_CHARS_SENTINEL always wins.
   *
   * Note: 20_000 is BOTH the schema default AND the "unset" sentinel (bootstrap uses
   * .default() not .optional()). An operator who explicitly sets maxChars:20000 on a
   * small model still receives the capability default — document this in D2.
   */
  bootstrapMaxChars: number;
  /**
   * SD7/F1: effective active-tool ceiling (max tool schemas in the prompt request).
   *
   * small: SMALL_DEFAULT_ACTIVE_TOOL_CEILING (24). nano/frontier/mid: undefined.
   * nano already has its own aggressive deferral path (CORE_TOOLS-only, ~15 active);
   * a ceiling on top would be a no-op.
   * Ceiling is enforced in applyToolDeferral via DeferralContext.activeToolCeiling.
   */
  activeToolCeiling: number | undefined;
  /**
   * SD9/F2: effective total bootstrap budget (sum of all file chars after per-file truncation).
   *
   * small/nano: SMALL_NANO_DEFAULT_BOOTSTRAP_TOTAL_CHARS (5_000).
   * frontier/mid: undefined (no total cap — byte-identical to v2.14).
   * Applied in buildBootstrapContextFiles as an additional constraint after per-file truncation.
   */
  bootstrapTotalMaxChars: number | undefined;
}

// ---------------------------------------------------------------------------
// Main resolver
// ---------------------------------------------------------------------------

/**
 * Resolve capability-gated defaults for a single agent execution.
 *
 * Pure — no I/O, no side effects, deterministic for equal inputs.
 *
 * @param modelProfile - Immutable profile resolved once per execution (Phase 151).
 * @param config - Per-agent config (post top-level parse; sub-blocks may be undefined).
 * @param criticContext - Optional cost-gate inputs for SD3 (provider, agentModel, operationModels).
 *   Pass undefined when the critic wiring is not available at the call site.
 */
export function resolveScaffoldDefaults(
  modelProfile: ModelProfile,
  config: PerAgentConfig,
  criticContext?: {
    provider: string;
    agentModel: string;
    operationModels: OperationModels;
  },
): ScaffoldDefaults {
  // Determine the capability tier — scaffoldLevel==="max" iff capabilityClass ∈ {small, nano}
  const isSmallNano = modelProfile.scaffoldLevel === "max";

  // -------------------------------------------------------------------------
  // SD1: GoalAnchor — explicit ?? capability default
  //
  // config.goalAnchor?.enabled is `boolean | undefined` (the block is .optional()
  // at agent level — an unconfigured agent yields config.goalAnchor === undefined).
  // Do NOT re-parse through GoalAnchorConfigSchema — that collapses undefined→false
  // (Pitfall 1: the schema .default(false) fires and kills the ?? gate).
  // The ?? expression fires only when the left side is `undefined` — explicit `false`
  // is preserved (the load-bearing force-off operator path).
  // -------------------------------------------------------------------------
  const goalAnchorEnabled = config.goalAnchor?.enabled ?? isSmallNano;

  // -------------------------------------------------------------------------
  // SD2: rag.baseFloor — explicit (non-zero) wins; 0 is the "unset" sentinel
  //
  // config.rag is always a fully-defaulted RagConfig (schema .default({})),
  // so config.rag.baseFloor is always `number`. The schema default is 0.
  // `> 0` treats both the schema default (0) and an explicit `rag.baseFloor: 0`
  // as "unset" — documented in D1.
  // Defensive: tests may pass a cast PerAgentConfig without a fully-parsed rag block.
  // In production the top-level parse always provides config.rag (schema .default({})).
  // -------------------------------------------------------------------------
  const configuredBaseFloor = config.rag?.baseFloor ?? 0;
  const baseFloor =
    configuredBaseFloor > 0
      ? configuredBaseFloor
      : isSmallNano
        ? SMALL_NANO_DEFAULT_BASE_FLOOR
        : 0;

  // -------------------------------------------------------------------------
  // SD3: verification — explicit wins; otherwise cost-gated capability default
  //
  // config.verification?.enabled is `boolean | undefined` (block is .optional()).
  // Do NOT re-parse through VerificationConfigSchema.
  //
  // WR-01: resolve the verification operation model ONCE. It drives BOTH the
  // cost-gate distinctness decision AND the model the critic actually runs on
  // (criticModel below) — so the critic can never auto-enable on a cheap model's
  // existence yet silently run the primary (the bug WR-01 fixed).
  // Uses the real 5-level priority chain from resolveOperationModel — no mocking.
  // -------------------------------------------------------------------------
  const verificationResolution = criticContext
    ? resolveOperationModel({
        operationType: "verification",
        agentProvider: criticContext.provider,
        agentModel: criticContext.agentModel,
        operationModels: criticContext.operationModels,
        providerFamily: resolveProviderFamily(criticContext.provider),
      })
    : undefined;

  const explicitVerification = config.verification?.enabled; // boolean | undefined
  let verificationEnabled: boolean;
  if (explicitVerification !== undefined) {
    // Explicit config always wins — both true (force-on) and false (force-off / security gate)
    verificationEnabled = explicitVerification;
  } else if (isSmallNano && criticContext && verificationResolution) {
    // Cost-gate: auto-enable only when a cheap keyless critic is resolvable.
    // Two conditions must hold:
    //  1. Provider is keyless (ollama/lm-studio) — no API key threading needed
    //  2. A distinct cheaper model is explicitly configured for the verification tier.
    //     `source === "explicit_config"` is the only level that can yield a cheap
    //     distinct model (OPERATION_TIER_MAP["verification"]="primary" makes Level 4
    //     family_default unreachable, Level 5 returns the agent primary → not distinct);
    //     `modelId !== agentModel` guards `verification.model: "primary"`.
    verificationEnabled =
      KEYLESS_CRITIC_PROVIDERS.has(criticContext.provider.toLowerCase()) &&
      verificationResolution.source === "explicit_config" &&
      verificationResolution.modelId !== criticContext.agentModel;
  } else {
    // frontier/mid → always off (SD5); or no criticContext → no cost-gate check → off
    verificationEnabled = false;
  }

  // WR-01: when the critic runs, it MUST run on the resolved verification model
  // (the distinct cheap model the cost-gate gated on, or the operator's configured
  // verification model in the explicit force-on path) — NEVER silently the agent
  // primary. The synthetic critic deps run keyless (apiKey:""), so expose the
  // resolved model only when its provider is keyless; otherwise leave it undefined
  // and let the caller fall back to the agent's (already-keyless) primary rather
  // than calling a keyed provider with an empty key.
  const criticModel =
    verificationEnabled &&
    verificationResolution &&
    KEYLESS_CRITIC_PROVIDERS.has(verificationResolution.provider.toLowerCase())
      ? { provider: verificationResolution.provider, modelId: verificationResolution.modelId }
      : undefined;

  // -------------------------------------------------------------------------
  // SD6: bootstrap.maxChars capability default.
  // bootstrap uses .default() not .optional() — config.bootstrap.maxChars is always a number.
  // The "unset" detection is === BOOTSTRAP_MAX_CHARS_SENTINEL (not ?? undefined).
  // See RESEARCH.md Pitfall 1 and the SD2 === 0 sentinel analog in this file.
  // -------------------------------------------------------------------------
  const configuredMaxChars = config.bootstrap?.maxChars ?? BOOTSTRAP_MAX_CHARS_SENTINEL;
  const bootstrapMaxChars =
    configuredMaxChars !== BOOTSTRAP_MAX_CHARS_SENTINEL
      ? configuredMaxChars                              // explicit non-default value wins
      : isSmallNano
        ? SMALL_NANO_DEFAULT_BOOTSTRAP_MAX_CHARS        // small/nano capability default
        : BOOTSTRAP_MAX_CHARS_SENTINEL;                 // frontier/mid: 20_000 (unchanged)

  // -------------------------------------------------------------------------
  // SD7/F1: active-tool ceiling — ONLY for small class.
  // nano is excluded: it already has aggressive CORE_TOOLS-only deferral at applyToolDeferral:413.
  // Adding a ceiling of 24 on top of nano's ~15-active output would be a no-op, and confusing.
  // frontier/mid: no ceiling (behavior-neutral).
  // -------------------------------------------------------------------------
  const activeToolCeiling: number | undefined =
    modelProfile.capabilityClass === "small"
      ? SMALL_DEFAULT_ACTIVE_TOOL_CEILING
      : undefined;

  // -------------------------------------------------------------------------
  // SD9/F2: total bootstrap budget — small/nano only.
  // Applied in buildBootstrapContextFiles as a second pass after per-file truncation.
  // frontier/mid: undefined (no total cap — byte-identical to v2.14).
  // -------------------------------------------------------------------------
  const bootstrapTotalMaxChars: number | undefined = isSmallNano
    ? SMALL_NANO_DEFAULT_BOOTSTRAP_TOTAL_CHARS
    : undefined;

  return { goalAnchorEnabled, baseFloor, verificationEnabled, criticModel, bootstrapMaxChars, activeToolCeiling, bootstrapTotalMaxChars };
}
