// SPDX-License-Identifier: Apache-2.0
/**
 * Operation model defaults: catalog-derived per-provider model tiering.
 *
 * A pure function reads the live pi-ai catalog at call time rather than
 * consulting a hardcoded table of `mid`/`fast` model IDs per provider
 * family. Two design properties:
 *
 * 1. Pi-ai SDK upgrades automatically light up new providers/models — no
 *    per-release source edits to bump literal model IDs.
 * 2. Every provider is covered uniformly: a hardcoded family map covering
 *    only a few providers would leave cron/heartbeat/compaction routed to
 *    Claude Sonnet when the primary provider is anything else.
 *
 * Tier picking: filter to text-capable models with non-zero cost, sort
 * ascending by total cost (input + output), take the provider's distinct
 * price ladder, pick top-of-cohort (lex-greatest within the price rung) at
 * the 10th-percentile rung = `fast`, 50th-percentile rung = `mid`.
 * All-free-models providers (e.g. local Ollama, Z.AI most models)
 * fall back to "first text-capable id" for both slots.
 *
 * @module
 */

import { type KnownProvider } from "@earendil-works/pi-ai";
import { getModels, getProviders } from "@earendil-works/pi-ai/compat";
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
 * Pick the "top of cohort" model from a cost-ascending list.
 *
 * Takes the percentile over the provider's DISTINCT price ladder (unique
 * total-cost values, ascending), then returns the lex-greatest ID within
 * the selected price rung. Lex-greatest is a deterministic proxy for
 * "newest/highest version" across the providers we ship — for dated IDs
 * (YYYY-MM-DD, YYMM) and semver-ish IDs (claude-sonnet-4-6 >
 * claude-sonnet-4-5) the lex order matches recency.
 *
 * Why the price ladder and not catalog rows? Providers ship an uneven
 * number of listings per price point — aliased + dated ids of the same
 * model, and more variants of the flagship tier than the mid tier (five
 * Opus 4.x ids vs three Sonnet ids). A row-indexed percentile drifts to
 * whichever tier has the most listings: the Anthropic 50th-percentile row
 * landed in the $30 Opus cohort, routing "mid" operations (cron, skill
 * synthesis) to flagship pricing. The ladder is the stable tier signal —
 * its median rung is the provider's actual mid-price tier regardless of
 * how many ids each tier ships.
 *
 * Why not just take `cohort[0]`? JavaScript's stable sort preserves
 * original-array order within a cost-tied block, so a bare index pick
 * returns whatever the catalog happened to enumerate first — an arbitrary
 * member of the rung, picked by accident, not by quality signal.
 *
 * Degenerate case: a ladder with a single rung (or a 2-rung ladder at the
 * 50th percentile, floor((2-1)*0.5) = 0) resolves fast and mid to the same
 * rung — graceful and cost-safe.
 *
 * Module-internal — not exported.
 */
function pickFromCohort(
  sortedAsc: ReadonlyArray<{ id: string; cost?: { input?: number; output?: number } }>,
  percentile: number,
): string | undefined {
  if (sortedAsc.length === 0) return undefined;
  const ladder = [...new Set(sortedAsc.map(totalCost))];
  const rungCost = ladder[Math.min(ladder.length - 1, Math.floor((ladder.length - 1) * percentile))]!;
  const cohort = sortedAsc.filter((m) => totalCost(m) === rungCost);
  return [...cohort].sort((a, b) => b.id.localeCompare(a.id))[0]?.id;
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
 *   5. `fast` and `mid` are top-of-cohort at the 10th and 50th percentile
 *      of the DISTINCT price ladder respectively (lex-greatest ID within
 *      the price rung the percentile lands in). Cost ties broken by
 *      lex-greatest ID — avoids picking a model purely because of catalog
 *      iteration order (e.g. several Anthropic Sonnets all at $18/MTok).
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
  const textCapableAll = all.filter((m) => m.input?.includes("text"));
  // Operation-tier models must be PINNED, reproducible ids — EXCLUDE floating aliases
  // (`*-latest`). An alias drifts as the provider re-points it and 404s outright once the
  // provider retires it: the live 2026-06-18 fast-tier pick `claude-3-5-haiku-latest`
  // returned an Anthropic `not_found_error`, which the cost-gated seams swallowed as an
  // empty verdict (the outcome judge never fired). A dated id (`…-20241022`) is stable.
  // Keep the aliased set as a fallback so a catalog that ONLY exposes aliases still resolves.
  const pinned = textCapableAll.filter((m) => !m.id.endsWith("-latest"));
  const textCapable = pinned.length > 0 ? pinned : textCapableAll;

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

  return {
    fast: pickFromCohort(priced, 0.1),
    mid: pickFromCohort(priced, 0.5),
  };
}

// ---------------------------------------------------------------------------
// Operation -> tier mapping (provider-agnostic semantics)
// ---------------------------------------------------------------------------

/**
 * Maps each operation type to its cost tier.
 *
 * - "primary": always uses the agent's primary model (interactive, subagent, verification, planning)
 * - "mid": moderate complexity, tool-using operations (cron)
 * - "fast": simple classification/summarization (heartbeat, taskExtraction, condensation, compaction)
 *
 * verification + planning map to "primary" so that on a local-only Ollama deploy
 * (where resolveOperationDefaults returns {}) the resolver falls through to Level 5
 * (agent primary) — self-check by design, with no new dependency. A configured cheap
 * model via operationModels.verification.model overrides this at Level 2.
 */
export const OPERATION_TIER_MAP: Record<ModelOperationType, "primary" | "mid" | "fast"> = {
  interactive: "primary",
  cron: "mid",
  heartbeat: "fast",
  subagent: "primary",
  compaction: "fast",
  taskExtraction: "fast",
  condensation: "fast",
  verification: "primary",  // local-only self-check; configured: cheap model via Level 2
  planning: "primary",       // same resolution path as verification
  outcomeJudge: "fast",      // optional cost-gated outcome judge — a fast classification op
  skillSynthesis: "mid",     // offline procedural synthesis — a mid-tier synthesis op (NOT a fast classify)
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
  verification: 120_000,  // same ceiling as the critic LLM_TIMEOUT_MS
  outcomeJudge: 30_000,   // mirrors condensation — a fast classification op
  skillSynthesis: 150_000, // mirrors cron — an offline batch op
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
  verification: "none",  // critic responses consume the reviewed response and must not be cached
  planning: "none",       // planner responses are request-specific; caching wastes storage
  outcomeJudge: "none",   // judge responses are request-specific (like verification)
  skillSynthesis: "short", // offline reuse within a run, like cron
};
