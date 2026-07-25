// SPDX-License-Identifier: Apache-2.0
/**
 * Compaction-model resolver: runtime-resolves the `compactionModel`
 * configuration field from the pi-ai catalog when the schema default
 * is the empty string.
 *
 * Why this exists:
 *   A hardcoded provider-specific default (e.g. an Anthropic Haiku literal)
 *   would keep routing compaction to that provider even when an operator's
 *   primary provider is OpenRouter, Google, etc. — defeating the
 *   cost-tiering intent and causing cross-provider auth confusion (no
 *   Anthropic API key configured).
 *
 *   The schema default is "" and the value is resolved at runtime: pick the
 *   fast-tier model from `resolveOperationDefaults(primaryProvider)`, with
 *   `getModels(primaryProvider)[0]` as the catalog-fallback.
 *
 *   Note: explicit `compactionModel` values from YAML configs win unchanged
 *   (length > 0 short-circuits the resolver).
 *
 * @module
 */

import type { BuiltinProvider } from "@earendil-works/pi-ai/compat";
import { getModels } from "@earendil-works/pi-ai/compat";
import { resolveOperationDefaults } from "./operation-model-defaults.js";

/**
 * Resolve the effective compaction model id, in "provider:modelId" format.
 *
 * Resolution rules:
 *   1. If `configValue` is non-empty, return it unchanged (operator explicit).
 *   2. Otherwise, derive the fast-tier model from `resolveOperationDefaults`
 *      for the agent's primary provider; fall back to first catalog model
 *      id if cost-tiering returned nothing (custom YAML provider).
 *   3. If neither tiering nor catalog produces a candidate (unknown provider
 *      with empty catalog), return "" so the consumer can fall through to
 *      session model — graceful degradation.
 *
 * Pure function — no side effects, no async. Safe to call per-execute.
 *
 * @param configValue - Raw `contextEngine.compactionModel` from agent config
 * @param primaryProvider - Agent's primary provider (e.g. "anthropic", "openrouter")
 * @returns Resolved model in "provider:modelId" format, or "" for graceful fallback
 */
export function resolveCompactionModel(
  configValue: string,
  primaryProvider: string,
): string {
  if (configValue.length > 0) return configValue;

  const tier = resolveOperationDefaults(primaryProvider);
  const firstId = getModels(primaryProvider as BuiltinProvider)[0]?.id;
  const modelId = tier.fast ?? firstId;

  return modelId ? `${primaryProvider}:${modelId}` : "";
}
