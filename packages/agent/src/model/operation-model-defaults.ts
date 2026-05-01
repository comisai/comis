// SPDX-License-Identifier: Apache-2.0
/**
 * Operation model defaults: catalog-derived per-provider model tiering.
 *
 * Replaces the previous hardcoded `OPERATION_MODEL_DEFAULTS` table (which
 * pinned `mid`/`fast` model IDs per provider family) with a pure function
 * that reads the live pi-ai catalog at call time. Two design properties:
 *
 * 1. Pi-ai SDK upgrades automatically light up new providers/models — no
 *    per-release source edits to bump `OPERATION_MODEL_DEFAULTS` literals.
 * 2. Closes the latent bug where switching primary to a non-Anthropic
 *    provider left cron/heartbeat/compaction routed to Claude Sonnet
 *    (because the old map was Anthropic/OpenAI/Google only).
 *
 * Tier picking: filter to text-capable models with non-zero cost, sort
 * ascending by total cost (input + output), pick 10th-percentile = `fast`,
 * 50th-percentile = `mid`. All-free-models providers (e.g. local Ollama,
 * Z.AI most models) fall back to "first text-capable id" for both slots.
 *
 * @module
 */

import { getModels, getProviders, type KnownProvider } from "@mariozechner/pi-ai";
import type { ModelOperationType } from "@comis/core";

// ---------------------------------------------------------------------------
// Tier resolution
// ---------------------------------------------------------------------------

/** Cached set of native pi-ai providers for O(1) membership check. */
const _nativeProviderSet = new Set<string>(getProviders());

/** Sum of input + output cost (per-million-tokens). Treats undefined as 0. */
function totalCost(m: { cost?: { input?: number; output?: number } }): number {
  return (m.cost?.input ?? 0) + (m.cost?.output ?? 0);
}

/**
 * Resolve cost-tier model defaults for a given native pi-ai provider.
 *
 * Returns `{ fast, mid }` model IDs (without provider prefix) selected from
 * the catalog by ascending total cost. Both undefined fields when the
 * provider is unknown to pi-ai (e.g. custom YAML providers like Ollama).
 *
 * Algorithm:
 *   1. Fetch `getModels(provider)` -> all models for that provider.
 *   2. Filter to models supporting text input (`m.input.includes("text")`).
 *   3. Filter to non-zero cost (eliminates free/local-only models from
 *      ranking — they won't be reachable in production).
 *   4. Sort ascending by total cost.
 *   5. `fast` = 10th percentile, `mid` = 50th percentile.
 *   6. If post-filter set is empty (all-free provider), use the first
 *      text-capable model id for both slots.
 *
 * Pure function — no async, no side effects. Re-callable per request.
 *
 * @param provider - Provider name to resolve (e.g. "anthropic", "openrouter")
 * @returns `{ fast?: string, mid?: string }` — empty object for unknown providers
 */
export function resolveOperationDefaults(provider: string): { fast?: string; mid?: string } {
  if (!_nativeProviderSet.has(provider)) return {};

  const all = getModels(provider as KnownProvider);
  const textCapable = all.filter((m) => m.input?.includes("text"));

  // Non-free models, sorted ascending by total cost.
  const priced = textCapable
    .filter((m) => totalCost(m) > 0)
    .sort((a, b) => totalCost(a) - totalCost(b));

  if (priced.length === 0) {
    // All-free-models provider (e.g. Z.AI's predominantly-free catalog,
    // Github Copilot, Kimi Coding). Use first text-capable id for both
    // slots — no division by zero, graceful degradation.
    const fallback = textCapable[0]?.id;
    return { fast: fallback, mid: fallback };
  }

  // Math.min clamp guards single-element arrays (10% of 1 -> 0).
  const fastIdx = Math.min(priced.length - 1, Math.floor(priced.length * 0.1));
  const midIdx = Math.min(priced.length - 1, Math.floor(priced.length * 0.5));
  return {
    fast: priced[fastIdx].id,
    mid: priced[midIdx].id,
  };
}

// ---------------------------------------------------------------------------
// Operation -> tier mapping (provider-agnostic semantics)
// ---------------------------------------------------------------------------

/**
 * Maps each operation type to its cost tier.
 *
 * - "primary": always uses the agent's primary model (interactive, subagent)
 * - "mid": moderate complexity, tool-using operations (cron)
 * - "fast": simple classification/summarization (heartbeat, taskExtraction, condensation, compaction)
 */
export const OPERATION_TIER_MAP: Record<ModelOperationType, "primary" | "mid" | "fast"> = {
  interactive: "primary",
  cron: "mid",
  heartbeat: "fast",
  subagent: "primary",
  compaction: "fast",
  taskExtraction: "fast",
  condensation: "fast",
};

/**
 * Default timeout per operation type in milliseconds.
 *
 * These are used when no explicit per-operation timeout is configured.
 * The agent's promptTimeout.promptTimeoutMs is the ultimate fallback
 * (handled by the resolver, not stored here).
 */
export const OPERATION_TIMEOUT_DEFAULTS: Partial<Record<ModelOperationType, number>> = {
  heartbeat: 60_000,
  cron: 150_000,
  subagent: 120_000,
  compaction: 60_000,
  taskExtraction: 30_000,
  condensation: 30_000,
};

/**
 * Default cache retention hint per operation type.
 *
 * Most non-interactive operations use "short" (5-min TTL) or "none"
 * because their prompts change frequently and caching wastes storage.
 */
export const OPERATION_CACHE_DEFAULTS: Partial<Record<ModelOperationType, "none" | "short">> = {
  heartbeat: "none",
  compaction: "none",
  taskExtraction: "none",
  condensation: "short",
  cron: "short", // 5m TTL: covers within-execution multi-step reuse, avoids 1h write premium across hourly runs.
};
