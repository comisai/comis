// SPDX-License-Identifier: Apache-2.0
/**
 * Provider capabilities resolution: 3-layer cascade pattern.
 *
 * Resolution order:
 *   1. DEFAULTS -- complete ProviderCapabilities with safe fallback values
 *   2. PROVIDER_OVERRIDES[normalizeProviderId(provider)] -- built-in overrides
 *      for known providers (8 entries covering Anthropic, OpenAI, Google, Mistral)
 *   3. userOverrides -- user-supplied config from YAML `providers.entries.*.capabilities`
 *
 * Providers NOT in PROVIDER_OVERRIDES (cerebras, groq, xai, etc.) get clean
 * DEFAULTS via spread fallthrough -- no explicit entry needed.
 *
 * @module
 */

import { getProviders } from "@earendil-works/pi-ai/compat";
import type { ProviderCapabilities } from "@comis/core";

/**
 * Default provider capabilities. Matches ProviderCapabilitiesSchema defaults.
 * All fields present -- serves as the base layer in the 3-layer cascade.
 */
export const DEFAULTS: ProviderCapabilities = {
  providerFamily: "default",
  dropThinkingBlockModelHints: [],
  transcriptToolCallIdMode: "default",
  transcriptToolCallIdModelHints: [],
};

/**
 * Built-in overrides for providers that differ from DEFAULTS.
 *
 * 8 entries covering:
 * - Anthropic family (2): anthropic, amazon-bedrock
 * - OpenAI family (3): openai, azure-openai-responses, openai-codex
 * - Google family (2): google, google-vertex
 * - Mistral (1): strict9 tool call ID mode with 7 model hints
 *
 * Providers NOT in this map fall through to DEFAULTS via spread.
 */
const PROVIDER_OVERRIDES: Record<string, Partial<ProviderCapabilities>> = {
  // Anthropic family
  "anthropic": { providerFamily: "anthropic", dropThinkingBlockModelHints: ["claude"] },
  "amazon-bedrock": { providerFamily: "anthropic", dropThinkingBlockModelHints: ["claude"] },

  // OpenAI family
  "openai": { providerFamily: "openai" },
  "azure-openai-responses": { providerFamily: "openai" },
  "openai-codex": { providerFamily: "openai" },

  // Google family
  "google": { providerFamily: "google" },
  "google-vertex": { providerFamily: "google" },

  // Mistral -- strict9 tool call ID normalization
  "mistral": {
    transcriptToolCallIdMode: "strict9",
    transcriptToolCallIdModelHints: [
      "mistral", "mixtral", "codestral", "pixtral",
      "devstral", "ministral", "mistralai",
    ],
  },
};

/**
 * Provider ID alias table. Maps user-friendly shorthand names to canonical
 * provider IDs used in PROVIDER_OVERRIDES.
 */
const ALIASES: Record<string, string> = {
  "aws-bedrock": "amazon-bedrock",
  "bedrock": "amazon-bedrock",
  "azure-responses": "azure-openai-responses",
  "codex": "openai-codex",
  "gcp": "google",
  "gcp-vertex": "google-vertex",
  "gemini": "google",
  "grok": "xai",
};

/**
 * Normalize a provider ID string: trim whitespace, lowercase, then resolve
 * aliases. Canonical IDs (e.g., "groq", "openai") pass through unchanged
 * via the `?? lower` fallthrough.
 */
export function normalizeProviderId(provider: string): string {
  const lower = provider.trim().toLowerCase();
  return ALIASES[lower] ?? lower;
}

/**
 * Resolve provider capabilities using the 3-layer cascade:
 *   DEFAULTS -> PROVIDER_OVERRIDES[normalized] -> userOverrides
 *
 * @param provider - Provider ID (canonical or alias, case-insensitive)
 * @param userOverrides - Optional user-supplied capability overrides from config
 * @returns Complete ProviderCapabilities with all fields populated
 */
export function resolveProviderCapabilities(
  provider: string,
  userOverrides?: Partial<ProviderCapabilities>,
): ProviderCapabilities {
  const normalized = normalizeProviderId(provider);
  return {
    ...DEFAULTS,
    ...PROVIDER_OVERRIDES[normalized],
    ...userOverrides,
  };
}

/**
 * Check if a provider belongs to the Anthropic family.
 * True for: anthropic, amazon-bedrock (and their aliases).
 */
export function isAnthropicFamily(provider: string): boolean {
  return resolveProviderCapabilities(provider).providerFamily === "anthropic";
}

/**
 * Check if a provider belongs to the OpenAI family.
 * True for: openai, azure-openai-responses, openai-codex (and their aliases).
 */
export function isOpenAiFamily(provider: string): boolean {
  return resolveProviderCapabilities(provider).providerFamily === "openai";
}

/**
 * Check if a provider belongs to the Google family.
 * True for: google, google-vertex (and their aliases).
 */
export function isGoogleFamily(provider: string): boolean {
  return resolveProviderCapabilities(provider).providerFamily === "google";
}

/**
 * Check if a provider is Google AI Studio (api.google.dev, NOT Vertex AI).
 * True for: "google" only (and aliases: "gcp", "gemini").
 * Excludes: google-vertex.
 *
 * Only Google AI Studio supports the Caches API used by GeminiCacheManager.
 */
export function isGoogleAIStudio(provider: string): boolean {
  return normalizeProviderId(provider) === "google";
}

/**
 * Check if thinking blocks should be dropped from the context for a given
 * provider + model combination. Matches model ID substrings against
 * the provider's dropThinkingBlockModelHints.
 */
export function shouldDropThinkingBlocks(provider: string, modelId: string): boolean {
  const caps = resolveProviderCapabilities(provider);
  return caps.dropThinkingBlockModelHints.some(
    (h) => modelId.toLowerCase().includes(h),
  );
}

/**
 * Resolve the tool call ID mode for a given provider + model combination.
 *
 * If the provider has transcriptToolCallIdMode "strict9", returns "strict9"
 * only if the model ID matches one of the transcriptToolCallIdModelHints.
 * Otherwise returns "default".
 */
export function resolveToolCallIdMode(
  provider: string,
  modelId: string,
): "default" | "strict9" {
  const caps = resolveProviderCapabilities(provider);
  if (caps.transcriptToolCallIdMode === "strict9") {
    const matches = caps.transcriptToolCallIdModelHints.some(
      (h) => modelId.toLowerCase().includes(h),
    );
    return matches ? "strict9" : "default";
  }
  return caps.transcriptToolCallIdMode;
}

// ---------------------------------------------------------------------------
// Boot-time PROVIDER_OVERRIDES staleness validator
// ---------------------------------------------------------------------------

/**
 * Minimal Pino-compatible logger surface for `validateProviderOverrides`.
 * Object-first warn signature matches the project convention (object + msg).
 */
export interface ProviderOverridesValidatorLogger {
  warn(obj: object, msg: string): void;
}

/**
 * Validate that every key in `PROVIDER_OVERRIDES` exists in the live pi-ai
 * catalog. Orphaned keys (override entries for providers pi-ai no longer
 * ships) are emitted as structured WARNs so operators notice on the next
 * pi-ai bump. Does NOT throw -- the daemon continues to boot. Orphaned
 * overrides are dead-code, not active failures.
 *
 * @param logger - Pino-compatible logger (object-first warn signature)
 * @returns Inventory: orphan keys + total count of override keys checked
 */
export function validateProviderOverrides(
  logger: ProviderOverridesValidatorLogger,
): { orphans: string[]; checked: number } {
  const liveProviders = new Set<string>(getProviders());
  const overrideKeys = Object.keys(PROVIDER_OVERRIDES);
  const orphans: string[] = [];

  for (const key of overrideKeys) {
    if (!liveProviders.has(key)) {
      orphans.push(key);
      logger.warn(
        {
          provider: key,
          hint: "Provider override exists for unknown pi-ai provider; remove from PROVIDER_OVERRIDES on next bump",
          errorKind: "config" as const,
          submodule: "capabilities",
        },
        "Capability override has no matching pi-ai provider",
      );
    }
  }

  return { orphans, checked: overrideKeys.length };
}
