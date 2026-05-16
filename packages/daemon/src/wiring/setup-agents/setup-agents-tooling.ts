// SPDX-License-Identifier: Apache-2.0
// @allow-throw: setup-agents tooling guards; consumed at daemon.ts bootstrap catch boundary (Phase 41 TS-HYG-07).
/**
 * Per-agent tooling and model resolution helpers.
 *
 * Phase 43 wave 8 split (FILE-SPLIT-08): extracted from setup-agents.ts
 * containing `resolveAgentModel`, the sub-agent tool-name resolver, and the
 * deterministic canary fallback derivation. Pure helpers — no closure state,
 * no daemon-runtime deps; safe to import from setup-agents-runtime and
 * setup-agents-registry.
 *
 * @module
 */

import { createHmac } from "node:crypto";
import { getModels, getProviders, type KnownProvider } from "@mariozechner/pi-ai";
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
        "Install or upgrade @mariozechner/pi-ai, or set models.defaultProvider explicitly.",
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
        "Set models.defaultModel explicitly or upgrade @mariozechner/pi-ai.",
      );
    }
    model = candidate;
  }

  return { model, provider };
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
