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

// Provider-family mapping is single-sourced to capabilities.ts which already
// handles all aliases (amazon-bedrock, google-vertex, azure-openai-responses, etc.)
// and is the canonical registry used by isAnthropicFamily/isGoogleFamily everywhere.
import { resolveProviderCapabilities } from "../provider/capabilities.js";

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

/**
 * Unknown model → most-scaffolded, most-locked (K2: fail-closed).
 *
 * Note: supportsTools is true because the executor still routes calls through
 * the tool policy gates; supportsTools is a capability declaration, not a
 * policy gate. If a future phase uses supportsTools as a policy gate, revisit
 * this default (IN-02).
 */
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
 * capabilityClass derivation (config override > provider family > fail-safe):
 *  1. capabilityClassOverride (explicit) → use directly
 *  2. providerFamily = "anthropic" (anthropic, amazon-bedrock, bedrock, ...) → "frontier"
 *  3. providerFamily = "openai" (openai, azure-openai-responses, openai-codex, ...) → "frontier"
 *  4. providerFamily = "google" (google, google-vertex, gcp-vertex, ...) → "mid"
 *  5. all others (ollama, custom, etc.) → "small"  (fail-safe direction)
 *
 * Provider-family resolution is single-sourced to capabilities.ts so all
 * canonical aliases (amazon-bedrock → anthropic, google-vertex → google,
 * azure-openai-responses → openai) are handled automatically (CR-01).
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
        // CR-02: widened to readonly string[] | undefined so ("text"|"image")[]
        // (the SDK's actual type) is assignable without a double-cast at the call site.
        input?: readonly string[] | string[];
        // SA7: optional SDK fields for prompt-cache enrichment.
        // compat is typed loosely (unknown) so that any of the SDK's three compat
        // union members (OpenAICompletionsCompat / OpenAIResponsesCompat /
        // AnthropicMessagesCompat) is structurally assignable without an index
        // signature requirement. cacheControlFormat is extracted via a safe
        // narrowing check inside the resolver body.
        compat?: unknown;
        // cost.cacheRead > 0 signals native prompt-cache support (Anthropic/Bedrock:
        // $0.30/MTok for cache reads). Field is absent on non-caching providers.
        cost?: { cacheRead?: number } | undefined;
      }
    | undefined,
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
    // CR-01: use canonical provider-family mapping (single-sourced to capabilities.ts)
    // so all provider aliases (amazon-bedrock, google-vertex, azure-openai-responses,
    // bedrock, gcp-vertex, etc.) map to their correct family — not the raw provider string.
    const family = resolveProviderCapabilities(resolvedModel.provider).providerFamily;
    if (family === "anthropic" || family === "openai") {
      capabilityClass = "frontier";
    } else if (family === "google") {
      capabilityClass = "mid";
    } else {
      // All other providers (ollama, cerebras, groq, custom, etc.) → "small"
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

  // SA7: Derive supportsPromptCache from SDK Model metadata when available,
  // with providerFamily="anthropic" as the fallback for call sites without
  // the full Model object. Fail-safe direction: prefer false-negative
  // (no cache_control injection) over false-positive (inject into a
  // non-caching provider). Three signals — any one is sufficient:
  //   1. providerFamily = "anthropic" (anthropic, amazon-bedrock, and aliases —
  //      CR-02 family fallback; preserves all existing behavior)
  //   2. Model.compat.cacheControlFormat = "anthropic" (openai-compat providers
  //      like Fireworks/OpenRouter that inject Anthropic-style cache_control)
  //   3. Model.cost.cacheRead > 0 (native caching signal from SDK catalog;
  //      Anthropic/Bedrock: $0.30/MTok for cache reads)
  //
  // Production wiring: pi-executor.ts:328 passes the SDK Model<Api> object
  // (carrying both .compat and .cost) to resolveModelProfile — widening the
  // param type is sufficient; no wiring change needed at the call site.
  // Safe narrowing helper: read cacheControlFormat from the compat field (typed
  // as unknown to accept all three SDK union members without an index signature).
  const compatCacheFormat =
    resolvedModel.compat != null &&
    typeof resolvedModel.compat === "object" &&
    "cacheControlFormat" in resolvedModel.compat
      ? (resolvedModel.compat as { cacheControlFormat?: unknown }).cacheControlFormat
      : undefined;

  const providerCapabilities = resolveProviderCapabilities(resolvedModel.provider);
  const supportsPromptCache =
    providerCapabilities.providerFamily === "anthropic" ||
    compatCacheFormat === "anthropic" ||
    (resolvedModel.cost?.cacheRead ?? 0) > 0;

  return {
    contextWindow,
    maxOutputTokens,
    capabilityClass,
    scaffoldLevel,
    securityLevel,
    supportsVision,
    supportsTools: true,
    supportsPromptCache,
    supportsServerToolSearch: false,
    supportsStructuredOutput: false,
    reasoningStyle,
  };
}
