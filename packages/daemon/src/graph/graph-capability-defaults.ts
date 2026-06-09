// SPDX-License-Identifier: Apache-2.0
/**
 * F3: capability-gated graph concurrency defaults.
 *
 * Background: the 2026-06-08 live re-verification observed 8 concurrent
 * qwen3.6:35b inferences saturate a single Ollama GPU — 4/8 sub-agents died
 * on 180-second prompt timeouts and 0/11 graph nodes completed. The DAG
 * decomposition was correct; the failure was concurrency × timeout × hardware
 * ceiling. Reducing the small/nano default concurrency to 2 prevents saturation.
 *
 * Tier mapping:
 * - small / nano → maxConcurrency = 2  (local inference hardware ceiling)
 * - frontier / mid → maxConcurrency = 4  (byte-identical to pre-F3)
 *
 * Operators can always raise the ceiling via the existing
 * `security.agentToAgent.graphMaxConcurrency` config key — the ?? chain in
 * daemon.ts ensures the explicit config wins over the capability-derived default.
 *
 * The `capabilityOverride` parameter mirrors the operator escape hatch in
 * `resolveMemoryOpsCapability`: force a capability class different from what the
 * provider heuristic would derive (e.g., force frontier class on a local model).
 *
 * @module
 */

import { resolveModelProfile, type CapabilityClass } from "@comis/agent";

/** The capability-gated graph concurrency defaults for a given model. */
export interface GraphConcurrencyDefaults {
  /** Default max concurrent sub-agent graph nodes for this capability tier. */
  maxConcurrency: number;
}

/** F3: small/nano local inference hardware saturation threshold (measured 2026-06-08). */
const SMALL_NANO_GRAPH_MAX_CONCURRENCY = 2 as const;

/** F3: frontier/mid concurrency — byte-identical to the pre-F3 hardcoded `4`. */
const DEFAULT_GRAPH_MAX_CONCURRENCY = 4 as const;

/**
 * Resolve capability-gated graph concurrency defaults for a model.
 *
 * Returns `maxConcurrency=2` for small/nano models (local inference hardware ceiling)
 * and `maxConcurrency=4` for frontier/mid (unchanged from pre-F3).
 *
 * @param model - The agent's primary model (`{ provider, modelId }`).
 * @param capabilityOverride - Optional operator override for the capability class
 *   (`container.config.providers.entries[provider].capabilities.capabilityClass`).
 *   Mirrors the pattern in `resolveMemoryOpsCapability`. When set, overrides the
 *   provider-heuristic-derived class in both directions.
 */
export function resolveGraphConcurrencyDefaults(
  model: { provider: string; modelId: string },
  capabilityOverride?: CapabilityClass,
): GraphConcurrencyDefaults {
  const profile = resolveModelProfile(
    { id: model.modelId, provider: model.provider },
    capabilityOverride,
  );
  const isSmallNano = profile.capabilityClass === "small" || profile.capabilityClass === "nano";
  return {
    maxConcurrency: isSmallNano ? SMALL_NANO_GRAPH_MAX_CONCURRENCY : DEFAULT_GRAPH_MAX_CONCURRENCY,
  };
}
