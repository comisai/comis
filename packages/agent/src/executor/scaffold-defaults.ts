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
   * hasDistinctCheapCritic (operationModels.verification resolves to a model
   * distinct from and cheaper than the primary via explicit_config).
   * Explicit config.verification.enabled always wins (boolean).
   */
  verificationEnabled: boolean;
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
  // -------------------------------------------------------------------------
  const explicitVerification = config.verification?.enabled; // boolean | undefined
  let verificationEnabled: boolean;
  if (explicitVerification !== undefined) {
    // Explicit config always wins — both true (force-on) and false (force-off / security gate)
    verificationEnabled = explicitVerification;
  } else if (isSmallNano && criticContext) {
    // Cost-gate: auto-enable only when a cheap keyless critic is resolvable.
    // Two conditions must hold:
    //  1. Provider is keyless (ollama/lm-studio) — no API key threading needed (WR-02)
    //  2. A distinct cheaper model is explicitly configured for the verification tier
    verificationEnabled =
      KEYLESS_CRITIC_PROVIDERS.has(criticContext.provider.toLowerCase()) &&
      hasDistinctCheapCritic(
        criticContext.provider,
        criticContext.agentModel,
        criticContext.operationModels,
      );
  } else {
    // frontier/mid → always off (SD5); or no criticContext → no cost-gate check → off
    verificationEnabled = false;
  }

  return { goalAnchorEnabled, baseFloor, verificationEnabled };
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

/**
 * Returns true when the verification operation model resolves to a model
 * distinct from (and therefore cheaper than) the agent's primary model.
 *
 * Uses the real 5-level priority chain from resolveOperationModel — no mocking.
 * The predicate is conservative:
 *   - `source === "explicit_config"` is the only level that can yield a cheap
 *     distinct model for verification (OPERATION_TIER_MAP["verification"]="primary"
 *     makes Level 4 family_default unreachable, and Level 5 always returns the
 *     agent primary → same model → not distinct).
 *   - `modelId !== agentModel` guards against `verification.model: "primary"` (which
 *     resolveOperationModel normalizes to agentModel with source="explicit_config").
 *
 * T-158-01 (Elevation of Privilege): this is called only after the
 * KEYLESS_CRITIC_PROVIDERS check — cloud-keyed providers never reach this helper.
 */
function hasDistinctCheapCritic(
  agentProvider: string,
  agentModel: string,
  operationModels: OperationModels,
): boolean {
  const resolution = resolveOperationModel({
    operationType: "verification",
    agentProvider,
    agentModel,
    operationModels,
    providerFamily: resolveProviderFamily(agentProvider),
  });
  return resolution.source === "explicit_config" && resolution.modelId !== agentModel;
}
