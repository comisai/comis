// SPDX-License-Identifier: Apache-2.0
// @allow-throw: setup-agents tooling guards; consumed at daemon.ts bootstrap catch boundary.
/**
 * Per-agent tooling and model resolution helpers.
 *
 * Contains `resolveAgentModel`, the sub-agent tool-name resolver, and the
 * deterministic canary fallback derivation. Pure helpers — no closure state,
 * no daemon-runtime deps; safe to import from setup-agents-runtime and
 * setup-agents-registry.
 *
 * @module
 */

import { createHmac } from "node:crypto";
import { getModels, getProviders, type KnownProvider } from "@earendil-works/pi-ai";
import { resolveOperationDefaults } from "@comis/agent";
import { TOOL_PROFILES } from "@comis/skills";

/**
 * Resolve "default" model/provider placeholders to concrete values from the
 * pi-ai catalog. Called once per agent at daemon startup so executors always
 * receive concrete values.
 *
 * Resolution sources, in priority order:
 *   1. Per-agent explicit value (agentConfig.model / .provider not "default")
 *   2. YAML models.defaultModel / models.defaultProvider (operator override)
 *   3. Catalog heuristic for provider: most-populated native pi-ai provider
 *      (e.g. openrouter at 249 models > anthropic at 23). Single source of
 *      truth — no env var, no hardcoded FALLBACK_PROVIDER. If users want
 *      a specific default, they set models.defaultProvider in YAML.
 *   4. Catalog heuristic for model: resolveOperationDefaults(provider).mid
 *      (mid-tier cost), falling back to getModels(provider)[0].id.
 *
 * Throws when the pi-ai catalog is empty (zero providers / zero models for
 * the resolved provider) — the caller is asking for a default and we can't
 * synthesize one. Operators can recover by setting models.defaultProvider /
 * models.defaultModel explicitly.
 */
export function resolveAgentModel(
  agentConfig: { model: string; provider: string },
  modelsConfig: { defaultModel: string; defaultProvider: string },
): { model: string; provider: string } {
  const providerIsDefault = agentConfig.provider.toLowerCase() === "default";
  const modelIsDefault = agentConfig.model.toLowerCase() === "default";

  // Step 1: resolve provider
  let provider: string;
  if (!providerIsDefault) {
    provider = agentConfig.provider;
  } else if (modelsConfig.defaultProvider) {
    provider = modelsConfig.defaultProvider;
  } else {
    // Catalog heuristic: most-populated native provider wins.
    const allProviders = getProviders();
    if (allProviders.length === 0) {
      throw new Error(
        "Pi-ai catalog returned zero providers. " +
        "Install or upgrade @earendil-works/pi-ai, or set models.defaultProvider explicitly.",
      );
    }
    provider = allProviders
      .map((p) => ({ p, n: getModels(p as KnownProvider).length }))
      .sort((a, b) => b.n - a.n)[0]!.p;
  }

  // Step 2: resolve model
  let model: string;
  if (!modelIsDefault) {
    model = agentConfig.model;
  } else if (modelsConfig.defaultModel) {
    model = modelsConfig.defaultModel;
  } else {
    // Catalog read: prefer mid-tier from resolveOperationDefaults
    // (catalog-derived, cost-aware), fall back to first model id when
    // resolveOperationDefaults returns {} (custom YAML providers).
    const tier = resolveOperationDefaults(provider);
    const firstId = getModels(provider as KnownProvider)[0]?.id;
    const candidate = tier.mid ?? firstId;
    if (!candidate) {
      throw new Error(
        `No models found for provider "${provider}" in pi-ai catalog. ` +
        "Set models.defaultModel explicitly or upgrade @earendil-works/pi-ai.",
      );
    }
    model = candidate;
  }

  return { model, provider };
}

/**
 * Resolve an agent's MAIN provider id in lockstep with the completion path
 * (RES-01 / I4) — the handler-side accessor for provider-following image
 * generation (Phase 183). Delegates to the EXACT completion-path
 * `resolveAgentModel`, so the id it returns is the same one the completion
 * runner resolves for the agent.
 *
 * Fallback is the operator-configurable `defaultAgentId` — NOT the literal
 * string `"default"`. A deployment's default agent may be renamed (CLAUDE.md
 * documents real `mldag` / `head_trader` agents); a literal-`"default"` lookup
 * misses on those, yielding `undefined` and a `resolveAgentModel(undefined,…)`
 * throw. This mirrors the boot selector (`daemon.ts`) and every other
 * default-agent fallback in the daemon.
 *
 * When NEITHER `agentId` NOR `defaultAgentId` is present in the map (a
 * misconfigured deployment), this returns an honest sentinel
 * `{ providerId: "unknown" }` rather than throwing — `"unknown"` has no
 * `IMAGE_CAPABILITY` entry, so downstream resolution surfaces the honest
 * RES-03 unavailable path (with the knob-naming hint) instead of crashing the
 * RPC handler.
 */
export function resolveAgentMainProvider(
  agents: Record<string, { model: string; provider: string }>,
  modelsConfig: { defaultModel: string; defaultProvider: string },
  agentId: string,
  defaultAgentId: string,
): { providerId: string } {
  const cfg = agents[agentId] ?? agents[defaultAgentId];
  if (!cfg) return { providerId: "unknown" };
  const { provider } = resolveAgentModel(cfg, modelsConfig);
  return { providerId: provider };
}

/**
 * Resolve the EFFECTIVE rag.rerank.enabled for an agent.
 * Explicit operator value wins both directions; unset → auto-on iff the model
 * is locally present. `explicit` MUST be read from the RAW (pre-zod-default)
 * config — see setup-agents-runtime.ts — because RagConfigSchema.rerank.enabled
 * carries a `.default()` (default-ON), so a parsed value can
 * never be `undefined` and would erase the genuine unset signal. Threading the
 * raw tri-state keeps the zero-download posture: an unset config with
 * the model ABSENT stays effective-off, so a bare default-ON config does NOT
 * trigger a 606MB fetch.
 */
export function resolveEffectiveRerank(explicit: boolean | undefined, present: boolean): boolean {
  if (explicit !== undefined) return explicit;
  return present;
}

/**
 * Resolve the union of tool names from TOOL_PROFILES for the configured
 * sub-agent tool groups. Also includes builtin tools that sub-agents always get
 * (web_search, web_fetch, read, edit, write, grep, find, ls).
 */
export function resolveSubAgentToolNames(groups: string[]): string[] {
  const builtins = [
    "web_search", "web_fetch", "read", "edit", "write",
    "grep", "find", "ls",
  ];
  const fromProfiles = groups.flatMap(g => TOOL_PROFILES[g] ?? []);
  return [...new Set([...builtins, ...fromProfiles])];
}

/**
 * Derive a deterministic canary fallback secret for an agent.
 * Used when CANARY_SECRET is not configured in environment.
 */
export function deriveCanaryFallback(baseSecret: string, agentId: string): string {
  return createHmac("sha256", baseSecret)
    .update(`canary-fallback:${agentId}`)
    .digest("hex");
}
