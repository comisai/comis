// SPDX-License-Identifier: Apache-2.0
/**
 * ModelProfile — immutable value type resolved once per execution.
 *
 * Two independent axes:
 *   - Capacity axis: contextWindow, maxOutputTokens (budget inputs)
 *   - Capability axis: capabilityClass → scaffoldLevel + securityLevel
 *     (scaffold intensity + lockdown; INDEPENDENT of contextWindow)
 *
 * securityLevel scales INVERSELY with capabilityClass (weaker model ⇒ stricter lockdown).
 * Unknown/unresolved models fail closed to the most-locked profile (FAIL_CLOSED_PROFILE).
 *
 * @module
 */

// ---------------------------------------------------------------------------
// Type exports
// ---------------------------------------------------------------------------

export type CapabilityClass = "frontier" | "mid" | "small" | "nano";
export type ScaffoldLevel = "light" | "standard" | "max";
export type SecurityLevel = "standard" | "hardened" | "locked";
export type ReasoningStyle = "none" | "native";

export interface ModelProfile {
  // Capacity axis — budget input; independent of capability
  readonly contextWindow: number;
  readonly maxOutputTokens: number;
  // Capability axis — scaffold + security intensity
  readonly capabilityClass: CapabilityClass;
  readonly scaffoldLevel: ScaffoldLevel; // derived from capabilityClass
  readonly securityLevel: SecurityLevel; // derived from capabilityClass (INVERTED: weaker ⇒ stricter)
  // Feature flags — from resolvedModel.input + config capabilities.*
  readonly supportsVision: boolean;
  readonly supportsTools: boolean;
  readonly supportsPromptCache: boolean;
  readonly supportsServerToolSearch: boolean;
  readonly supportsStructuredOutput: boolean;
  readonly reasoningStyle: ReasoningStyle;
}

// ---------------------------------------------------------------------------
// Derivation tables (named constants — no inline magic)
// ---------------------------------------------------------------------------

const SCAFFOLD_FOR: Readonly<Record<CapabilityClass, ScaffoldLevel>> = {
  frontier: "light",
  mid: "standard",
  small: "max",
  nano: "max",
} as const;

const SECURITY_FOR: Readonly<Record<CapabilityClass, SecurityLevel>> = {
  frontier: "standard",
  mid: "hardened",
  small: "locked",
  nano: "locked",
} as const;

// ---------------------------------------------------------------------------
// Fail-closed constant (unknown/unresolved model → most-locked profile)
// ---------------------------------------------------------------------------

/** Unknown model → most-scaffolded, most-locked (K2: fail-closed) */
export const FAIL_CLOSED_PROFILE: Readonly<ModelProfile> = {
  contextWindow: 8_192,
  maxOutputTokens: 4_096,
  capabilityClass: "nano",
  scaffoldLevel: "max",
  securityLevel: "locked",
  supportsVision: false,
  supportsTools: true,
  supportsPromptCache: false,
  supportsServerToolSearch: false,
  supportsStructuredOutput: false,
  reasoningStyle: "none",
} as const;

// ---------------------------------------------------------------------------
// Pure resolver function
// ---------------------------------------------------------------------------

/**
 * Resolve an immutable ModelProfile from the resolved model entry and
 * any user-supplied per-provider capability overrides.
 *
 * Pure — no I/O, no side effects, deterministic for equal inputs.
 * Unknown models (resolvedModel = undefined) fail closed → most-locked profile.
 *
 * capabilityClass derivation (config override > provider heuristic > fail-safe):
 *  1. capabilityClassOverride (explicit) → use directly
 *  2. provider = "anthropic" or starts with "anthropic" → "frontier"
 *  3. provider = "openai" → "frontier"
 *  4. provider = "google" → "mid"
 *  5. all others (ollama, custom, etc.) → "small"  (fail-safe direction)
 *
 * This ensures a 256K ollama model resolves capabilityClass="small", never "frontier".
 * The contextWindow is NEVER used to derive capabilityClass (K2 invariant).
 */
export function resolveModelProfile(
  resolvedModel:
    | {
        id: string;
        provider: string;
        contextWindow?: number;
        maxTokens?: number;
        reasoning?: boolean;
        input?: string[];
      }
    | undefined,
  _userModel?: Pick<
    { contextWindow?: number; maxTokens?: number; input?: string[]; reasoning?: boolean },
    "contextWindow" | "maxTokens" | "input" | "reasoning"
  >,
  capabilityClassOverride?: CapabilityClass,
): ModelProfile {
  // Fail-closed: unknown/undefined model → most-locked profile
  if (!resolvedModel) {
    return FAIL_CLOSED_PROFILE;
  }

  // -----------------------------------------------------------------------
  // Capacity axis (budget inputs — INDEPENDENT of capability)
  // -----------------------------------------------------------------------
  const contextWindow = resolvedModel.contextWindow ?? 8_192;
  const maxOutputTokens = Math.min(resolvedModel.maxTokens ?? 4_096, 32_768);

  // -----------------------------------------------------------------------
  // Capability axis: capabilityClass derivation
  // NEVER reads contextWindow — K2 invariant
  // -----------------------------------------------------------------------
  let capabilityClass: CapabilityClass;

  if (capabilityClassOverride !== undefined) {
    // Explicit config override wins unconditionally
    capabilityClass = capabilityClassOverride;
  } else {
    // Provider-based heuristic (fail-safe direction)
    const provider = resolvedModel.provider.toLowerCase();
    if (provider === "anthropic" || provider.startsWith("anthropic")) {
      capabilityClass = "frontier";
    } else if (provider === "openai") {
      capabilityClass = "frontier";
    } else if (provider === "google") {
      capabilityClass = "mid";
    } else {
      // All other providers (ollama, custom, etc.) → "small"
      // Fail-safe: unknown/local models default to high scaffold + locked security
      capabilityClass = "small";
    }
  }

  // Derived from capabilityClass (lookup tables — no magic)
  const scaffoldLevel = SCAFFOLD_FOR[capabilityClass];
  const securityLevel = SECURITY_FOR[capabilityClass];

  // -----------------------------------------------------------------------
  // Feature flags — derived from resolvedModel fields, not from model ID strings
  // -----------------------------------------------------------------------
  const supportsVision = resolvedModel.input?.includes("image") === true;
  const reasoningStyle: ReasoningStyle = resolvedModel.reasoning === true ? "native" : "none";

  return {
    contextWindow,
    maxOutputTokens,
    capabilityClass,
    scaffoldLevel,
    securityLevel,
    supportsVision,
    supportsTools: true,
    supportsPromptCache: false,
    supportsServerToolSearch: false,
    supportsStructuredOutput: false,
    reasoningStyle,
  };
}
