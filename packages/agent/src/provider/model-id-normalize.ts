// SPDX-License-Identifier: Apache-2.0
/**
 * Model ID normalization: resolves user-friendly shortcuts to full SDK model IDs.
 *
 * Resolves shorthand aliases (e.g., "sonnet", "opus", "flash") against the pi-ai
 * SDK's runtime model registry. This provides zero-config convenience -- users
 * don't need to remember dated model IDs like "claude-sonnet-4-20250514".
 *
 * **Complementary to ModelAliasResolver:** That system is config-driven (YAML
 * aliases, user customization). This system is built-in and SDK-backed. Config
 * aliases are resolved first in daemon wiring; SDK normalization runs at each
 * `modelRegistry.find()` call site.
 *
 * **Prefix ambiguity fix:** Among models matching a family prefix, the shortest
 * model ID is preferred. This prevents "gpt-4o-mini" from matching for prefix
 * "gpt-4o" when the user asked for "gpt4". Among same-length IDs, the one that
 * sorts last alphabetically is preferred (latest version).
 *
 * @module
 */

import { getModels, type KnownProvider } from "@mariozechner/pi-ai";

export interface ModelIdNormalizationResult {
  provider: string;
  modelId: string;
  normalized: boolean;
}

/**
 * Static alias map: user-friendly shortcut -> model ID prefix.
 *
 * The prefix is matched against `model.id.startsWith(prefix)` in the SDK
 * registry. Keep prefixes broad enough to capture new versions within a family,
 * but specific enough to avoid cross-family matches.
 *
 * **Maintenance:** Update when SDK adds new model families or renames existing
 * ones. The prefix must match the SDK's model ID naming convention.
 */
const FAMILY_ALIASES: Record<string, Record<string, string>> = {
  anthropic: {
    opus: "claude-opus-4",
    sonnet: "claude-sonnet-4",
    haiku: "claude-haiku-4",
  },
  openai: {
    gpt4: "gpt-4o",
    "gpt4-mini": "gpt-4o-mini",
    o3: "o3",
    "o3-mini": "o3-mini",
    "o4-mini": "o4-mini",
  },
  google: {
    "gemini-pro": "gemini-3-pro",
    "gemini-flash": "gemini-3-flash",
  },
  xai: {
    grok: "grok-4",
  },
};

/**
 * Resolve a user-friendly model shortcut to a full SDK model ID.
 *
 * @param provider - Provider name (e.g., "anthropic", "openai")
 * @param modelId - User-supplied model ID or shortcut (e.g., "sonnet", "gpt4")
 * @returns Resolution result with `normalized: true` if the shortcut was resolved,
 *          or `normalized: false` with the original modelId if passthrough
 */
export function normalizeModelId(
  provider: string,
  modelId: string,
): ModelIdNormalizationResult {
  const lower = modelId.toLowerCase().trim();
  const providerAliases = FAMILY_ALIASES[provider];

  if (!providerAliases) {
    return { provider, modelId, normalized: false };
  }

  const prefix = providerAliases[lower];
  if (!prefix) {
    return { provider, modelId, normalized: false };
  }

  // Resolve against SDK registry (sync -- reads from static generated registry).
  // Cast to KnownProvider -- unknown providers already returned passthrough above
  // (no FAMILY_ALIASES entry), so this cast is safe for all reachable code paths.
  const models = getModels(provider as KnownProvider);
  const matches = models
    .filter((m) => m.id.toLowerCase().startsWith(prefix))
    .sort((a, b) => b.id.localeCompare(a.id));

  if (matches.length > 0) {
    // Prefer the shortest match to avoid prefix ambiguity:
    // e.g., "gpt-4o" (length 6) over "gpt-4o-mini" (length 11) for prefix "gpt-4o"
    // Among same-length IDs, desc sort already picked the latest version.
    const shortest = matches.reduce(
      (best, m) => (m.id.length < best.id.length ? m : best),
      matches[0],
    );
    return { provider, modelId: shortest.id, normalized: true };
  }

  // No matches in registry for this prefix -- pass through unchanged
  return { provider, modelId, normalized: false };
}
