// SPDX-License-Identifier: Apache-2.0
/**
 * Capability-gated reliability defaults resolver.
 *
 * For small/nano models, resolves capability defaults
 * for GoalAnchor, rag.baseFloor, and verification critic.
 * frontier/mid: returns all OFF (behavior-neutral — identical to running
 * without this resolver).
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
 * Conservative base-score floor for small/nano models.
 *
 * Proven by the poison-recall fixture: blocks recall entries with base≤0.12
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
 * Keyless providers where the verification critic can auto-enable (cost-gate).
 *
 * Mirrors KEYLESS_CRITIC_PROVIDERS in verification-gate.ts — kept separate to
 * avoid a circular import between scaffold-defaults and verification-gate;
 * parity between the two sets is asserted by a cross-file test.
 *
 * A cloud-keyed provider (anthropic, openai) can never trigger the
 * auto-critic default — the KEYLESS_CRITIC_PROVIDERS check is the primary barrier,
 * and the capability gate independently forces frontier→false.
 */
const KEYLESS_CRITIC_PROVIDERS = new Set<string>(["ollama", "lm-studio"]);

/** Per-file bootstrap.maxChars default for small/nano.
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
 *  to force 20_000 on a small model, use capabilityClassOverride:"frontier". */
const BOOTSTRAP_MAX_CHARS_SENTINEL = 20_000 as const;

/** Active-tool ceiling for the `small` capability class.
 *  Keeps CORE_TOOLS (~15) + recently-used head-room + warm tools active;
 *  defers cold long-tail behind discover_tools (no capability removal).
 *  24 = 15 CORE_TOOLS + 9 discretionary slots.
 *  At 24 tools × ~300 chars avg ≈ 7K chars (vs 12K at 40) — ~750–1250 tokens saved. */
const SMALL_DEFAULT_ACTIVE_TOOL_CEILING = 24 as const;

/** Total bootstrap budget for small/nano. Caps the SUM of all bootstrap file chars.
 *  Per-file cap (3_500) still applies as an upper bound per file; this cap is the aggregate.
 *  Rationale: only AGENTS.md (6780) exceeds 3500 so per-file trimming only trims that one
 *  file — total bootstrap stays ~12.9K. A total cap of 5_000 forces proportional reduction. */
const SMALL_NANO_DEFAULT_BOOTSTRAP_TOTAL_CHARS = 5_000 as const;

/** Per-tool-result char cap for the `small` class.
 *  The schema default (50_000 chars ≈ 12.5K tokens) lets ONE tool result eat ~40% of a
 *  32K-token window — two exhaust it. Observed live: sessions hit context_exhausted at
 *  assembled ~33-35K because web_search/read results were 20-35K chars each. 12_000 chars
 *  (~3K tokens) lets a small model hold ~7 results in its working space; the offload
 *  guard keeps the full content on disk so nothing is permanently lost. */
const SMALL_DEFAULT_MAX_TOOL_RESULT_CHARS = 12_000 as const;

/** Tighter per-tool-result char cap for `nano` (16K window) — ~2K tokens. */
const NANO_DEFAULT_MAX_TOOL_RESULT_CHARS = 8_000 as const;

/** The schema .default() for maxToolResultChars (50_000). Doubles as the "unset" sentinel,
 *  exactly like BOOTSTRAP_MAX_CHARS_SENTINEL: a small model that explicitly sets 50_000 still
 *  receives the capability cap (force the full value via capabilityClassOverride:"frontier"). */
const MAX_TOOL_RESULT_CHARS_SENTINEL = 50_000 as const;

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
   * Effective GoalAnchor enabled flag.
   *
   * small/nano unset → true (capability default ON).
   * frontier/mid unset → false (byte-identical to running without this resolver).
   * Explicit config.goalAnchor.enabled always wins (boolean).
   */
  goalAnchorEnabled: boolean;
  /**
   * Effective rag.baseFloor (0 = no floor).
   *
   * small/nano with baseFloor=0 (schema default/"unset") → SMALL_NANO_DEFAULT_BASE_FLOOR (0.15).
   * frontier/mid with baseFloor=0 → 0 (byte-identical to running without this resolver).
   * Explicit config.rag.baseFloor > 0 always wins.
   *
   * Note: 0 is both the schema default and an explicit "disable floor" sentinel.
   * An operator who wants no floor on a small model must use capabilityClassOverride:"frontier".
   */
  baseFloor: number;
  /**
   * Effective verification critic enabled flag (cost-gated).
   *
   * Auto-ON only when: small/nano + keyless provider (ollama/lm-studio) +
   * a distinct cheaper model is configured (operationModels.verification resolves
   * to a model distinct from the primary via explicit_config).
   * Explicit config.verification.enabled always wins (boolean).
   */
  verificationEnabled: boolean;
  /**
   * The model the verification critic MUST run on when it runs —
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
   * Effective bootstrap.maxChars per-file budget.
   *
   * small/nano with default 20_000 → SMALL_NANO_DEFAULT_BOOTSTRAP_MAX_CHARS (3_500).
   * frontier/mid: always 20_000.
   * Explicit config.bootstrap.maxChars !== BOOTSTRAP_MAX_CHARS_SENTINEL always wins.
   *
   * Note: 20_000 is BOTH the schema default AND the "unset" sentinel (bootstrap uses
   * .default() not .optional()). An operator who explicitly sets maxChars:20000 on a
   * small model still receives the capability default — force 20_000 via
   * capabilityClassOverride:"frontier".
   */
  bootstrapMaxChars: number;
  /**
   * Effective active-tool ceiling (max tool schemas in the prompt request).
   *
   * small: SMALL_DEFAULT_ACTIVE_TOOL_CEILING (24). nano/frontier/mid: undefined.
   * nano already has its own aggressive deferral path (CORE_TOOLS-only, ~15 active);
   * a ceiling on top would be a no-op.
   * Ceiling is enforced in applyToolDeferral via DeferralContext.activeToolCeiling.
   */
  activeToolCeiling: number | undefined;
  /**
   * Effective total bootstrap budget (sum of all file chars after per-file truncation).
   *
   * small/nano: SMALL_NANO_DEFAULT_BOOTSTRAP_TOTAL_CHARS (5_000).
   * frontier/mid: undefined (no total cap — byte-identical to running without this resolver).
   * Applied in buildBootstrapContextFiles as an additional constraint after per-file truncation.
   */
  bootstrapTotalMaxChars: number | undefined;
  /**
   * Effective per-tool-result char cap (truncation threshold).
   *
   * small → SMALL_DEFAULT_MAX_TOOL_RESULT_CHARS (12_000).
   * nano  → NANO_DEFAULT_MAX_TOOL_RESULT_CHARS (8_000).
   * frontier/mid → undefined (consumer uses config.maxToolResultChars = 50_000, byte-identical).
   * Explicit operator config.maxToolResultChars (!= 50_000 sentinel) → undefined (operator value
   * wins via the consumer's `scaffold.maxToolResultChars ?? config.maxToolResultChars` fallback).
   *
   * Consumed at the tool-result-size-bouncer wiring (executor-stream-setup) so a single oversized
   * tool result cannot blow a small model's window.
   */
  maxToolResultChars: number | undefined;
  /**
   * The unified-arbiter-active signal.
   *
   * `true` when the relevance-first arbiter ranks LTM T3/T4 candidates
   * against history — small/nano on a non-caching model (the
   * relevance-first vs recency-first choice gates on supportsPromptCache, NOT tier;
   * a local model that doesn't cache reorders for free, a caching model pays a
   * cache-break so it stays recency-first below the fence).
   *
   * frontier/mid (recency-first): `false` — the arbiter does NOT run, recall/assembly
   * stay byte-identical to running without this resolver.
   *
   * Explicit config.contextEngine.relevance.firstByDefault always wins (both ways).
   *
   * LOAD-BEARING: when `true`, the recall baseFloor gate
   * (memory-recall.ts) enforces the resolved {@link ScaffoldDefaults.baseFloor}
   * (0.15 for small/nano) instead of silently skipping an unconfigured (0) floor —
   * an arbiter that ranks LTM against history needs the floor actually enforced.
   */
  relevanceFirst: boolean;
}

// ---------------------------------------------------------------------------
// Main resolver
// ---------------------------------------------------------------------------

/**
 * Resolve capability-gated defaults for a single agent execution.
 *
 * Pure — no I/O, no side effects, deterministic for equal inputs.
 *
 * @param modelProfile - Immutable profile resolved once per execution.
 * @param config - Per-agent config (post top-level parse; sub-blocks may be undefined).
 * @param criticContext - Optional cost-gate inputs for the verification critic (provider, agentModel, operationModels).
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
  // GoalAnchor — explicit ?? capability default
  //
  // config.goalAnchor?.enabled is `boolean | undefined` (the block is .optional()
  // at agent level — an unconfigured agent yields config.goalAnchor === undefined).
  // Do NOT re-parse through GoalAnchorConfigSchema — that collapses undefined→false
  // (the schema-re-parse trap: the schema .default(false) fires and kills the ?? gate).
  // The ?? expression fires only when the left side is `undefined` — explicit `false`
  // is preserved (the load-bearing force-off operator path).
  // -------------------------------------------------------------------------
  const goalAnchorEnabled = config.goalAnchor?.enabled ?? isSmallNano;

  // -------------------------------------------------------------------------
  // rag.baseFloor — explicit (non-zero) wins; 0 is the "unset" sentinel
  //
  // config.rag is always a fully-defaulted RagConfig (schema .default({})),
  // so config.rag.baseFloor is always `number`. The schema default is 0.
  // `> 0` treats both the schema default (0) and an explicit `rag.baseFloor: 0`
  // as "unset".
  // Defensive: tests may pass a cast PerAgentConfig without a fully-parsed rag block.
  // In production the top-level parse always provides config.rag (schema .default({})).
  // -------------------------------------------------------------------------
  const configuredBaseFloor = config.rag?.baseFloor ?? 0;
  const baseFloor =
    configuredBaseFloor > 0
      ? configuredBaseFloor
      : isSmallNano
        ? SMALL_NANO_DEFAULT_BASE_FLOOR  // LOAD-BEARING under the arbiter (relevanceFirst): the
        : 0;                             // recall gate enforces THIS floor, not a silent 0.

  // -------------------------------------------------------------------------
  // relevanceFirst — the full policy gate
  // (the unified-arbiter-active signal AND the relevance-first vs recency-first policy).
  //
  // Copies the GoalAnchor capability-gate shape EXACTLY: explicit config wins (both ways),
  // else the capability default. The gate axis is supportsPromptCache,
  // NOT a provider-string predicate: small/nano on a non-caching model (typical Ollama)
  // reorders relevance-first for free; a caching model pays a cache-break so it stays
  // recency-first (false) below the fence — frontier (Anthropic, caches) → false; mid
  // (caching) → false. Frontier/mid recency-first is BYTE-IDENTICAL to running without
  // this resolver: the arbiter does not run for them. The small/nano default-ON flip
  // stays measurement-gated — this resolves the mechanism; the live flip is an operator step.
  //
  // The schema-re-parse trap: read the relevance.firstByDefault field DIRECTLY
  // via the optional chain below — the schema field is OPTIONAL with NO `.default()`,
  // so an omitted field stays `undefined` and the `??` falls through to the capability gate.
  // Do NOT re-parse the sub-block through its schema (a `.default()` would collapse
  // undefined→false and silently kill the capability gate). An explicit boolean (true OR
  // false) is preserved — the load-bearing operator override.
  // -------------------------------------------------------------------------
  const relevanceFirst =
    config.contextEngine?.relevance?.firstByDefault ??
    (isSmallNano && !modelProfile.supportsPromptCache);

  // -------------------------------------------------------------------------
  // verification — explicit wins; otherwise cost-gated capability default
  //
  // config.verification?.enabled is `boolean | undefined` (block is .optional()).
  // Do NOT re-parse through VerificationConfigSchema.
  //
  // Resolve the verification operation model ONCE. It drives BOTH the
  // cost-gate distinctness decision AND the model the critic actually runs on
  // (criticModel below) — so the critic can never auto-enable on a cheap model's
  // existence yet silently run the primary.
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
    // frontier/mid → always off; or no criticContext → no cost-gate check → off
    verificationEnabled = false;
  }

  // When the critic runs, it MUST run on the resolved verification model
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
  // bootstrap.maxChars capability default.
  // bootstrap uses .default() not .optional() — config.bootstrap.maxChars is always a number.
  // The "unset" detection is === BOOTSTRAP_MAX_CHARS_SENTINEL (not ?? undefined).
  // Same shape as the rag.baseFloor === 0 sentinel above.
  // -------------------------------------------------------------------------
  const configuredMaxChars = config.bootstrap?.maxChars ?? BOOTSTRAP_MAX_CHARS_SENTINEL;
  const bootstrapMaxChars =
    configuredMaxChars !== BOOTSTRAP_MAX_CHARS_SENTINEL
      ? configuredMaxChars                              // explicit non-default value wins
      : isSmallNano
        ? SMALL_NANO_DEFAULT_BOOTSTRAP_MAX_CHARS        // small/nano capability default
        : BOOTSTRAP_MAX_CHARS_SENTINEL;                 // frontier/mid: 20_000 (unchanged)

  // -------------------------------------------------------------------------
  // Active-tool ceiling — ONLY for small class.
  // nano is excluded: it already has aggressive CORE_TOOLS-only deferral at applyToolDeferral:413.
  // Adding a ceiling of 24 on top of nano's ~15-active output would be a no-op, and confusing.
  // frontier/mid: no ceiling (behavior-neutral).
  // -------------------------------------------------------------------------
  const activeToolCeiling: number | undefined =
    modelProfile.capabilityClass === "small"
      ? SMALL_DEFAULT_ACTIVE_TOOL_CEILING
      : undefined;

  // -------------------------------------------------------------------------
  // Total bootstrap budget — small/nano only.
  // Applied in buildBootstrapContextFiles as a second pass after per-file truncation.
  // frontier/mid: undefined (no total cap — behavior-neutral).
  // -------------------------------------------------------------------------
  const bootstrapTotalMaxChars: number | undefined = isSmallNano
    ? SMALL_NANO_DEFAULT_BOOTSTRAP_TOTAL_CHARS
    : undefined;

  // -------------------------------------------------------------------------
  // Per-tool-result char cap — small/nano only, when unset (=== 50_000 sentinel).
  // Returns a number ONLY when the scaffold wants to override; undefined means "use
  // config.maxToolResultChars as-is" (frontier/mid, or an explicit operator value).
  // -------------------------------------------------------------------------
  const configuredMaxToolResultChars = config.maxToolResultChars ?? MAX_TOOL_RESULT_CHARS_SENTINEL;
  const maxToolResultChars: number | undefined =
    configuredMaxToolResultChars !== MAX_TOOL_RESULT_CHARS_SENTINEL
      ? undefined                                       // explicit operator value → consumer uses config
      : modelProfile.capabilityClass === "nano"
        ? NANO_DEFAULT_MAX_TOOL_RESULT_CHARS
        : modelProfile.capabilityClass === "small"
          ? SMALL_DEFAULT_MAX_TOOL_RESULT_CHARS
          : undefined;                                  // frontier/mid → consumer uses config (50_000)

  return { goalAnchorEnabled, baseFloor, verificationEnabled, criticModel, bootstrapMaxChars, activeToolCeiling, bootstrapTotalMaxChars, maxToolResultChars, relevanceFirst };
}
