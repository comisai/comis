// SPDX-License-Identifier: Apache-2.0
/**
 * Model management RPC handler module.
 * Handles model catalog query methods:
 *   models.list           -- List available models (optionally filtered by provider)
 *   models.test           -- Check provider configuration and catalog status
 *   models.list_providers -- Live native pi-ai catalog provider list (Layer 1F)
 * All handlers are read-only -- no approval gate required.
 * @module
 */

import type { ModelCatalog } from "@comis/agent";
import type { ProviderEntry } from "@comis/core";
import { getProviders } from "@mariozechner/pi-ai";
import type { RpcHandler } from "./types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Dependencies required by model management RPC handlers. */
export interface ModelHandlerDeps {
  /** Model catalog populated from pi-ai static registry + scan results. */
  modelCatalog: ModelCatalog;
  /** Agent configs for determining which providers are actively configured. */
  agents: Record<string, { provider: string; model: string }>;
  /** Custom provider entries from config.yaml for fallback when catalog is empty. */
  providerEntries?: Record<string, ProviderEntry>;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a record of model management RPC handlers bound to the given deps.
 * models.list -- query the model catalog with optional provider filter.
 * models.test -- check provider configuration and catalog availability.
 */
export function createModelHandlers(deps: ModelHandlerDeps): Record<string, RpcHandler> {
  return {
    // -----------------------------------------------------------------------
    // List available models
    // -----------------------------------------------------------------------

    "models.list": async (params) => {
      const provider = params.provider as string | undefined;

      // Filtered: return full model details for a single provider
      if (provider) {
        const entries = deps.modelCatalog.getByProvider(provider);
        return {
          models: entries.map((e) => ({
            provider: e.provider,
            modelId: e.modelId,
            displayName: e.displayName,
            contextWindow: e.contextWindow,
            maxTokens: e.maxTokens,
            input: e.input,
            reasoning: e.reasoning,
            validated: e.validated,
          })),
          total: entries.length,
        };
      }

      // Unfiltered: return full catalog grouped by provider (used by GUI)
      const providerNames = deps.modelCatalog.getProviders();
      return {
        providers: providerNames.map((name) => {
          const models = deps.modelCatalog.getByProvider(name);
          return {
            name,
            modelCount: models.length,
            models: models.map((m) => ({
              modelId: m.modelId,
              displayName: m.displayName,
              contextWindow: m.contextWindow,
              maxTokens: m.maxTokens,
              input: m.input,
              reasoning: m.reasoning,
              validated: m.validated,
            })),
          };
        }),
        totalModels: deps.modelCatalog.getAll().length,
      };
    },

    // -----------------------------------------------------------------------
    // List native pi-ai catalog providers (Layer 1F -- 260430-vwt)
    //
    // Live self-discovery for the agent: returns the de-duplicated, sorted
    // list of provider names from the pi-ai native catalog. Pairs with the
    // tool-descriptions auto-promote guidance so the agent can verify
    // which provider_id values trigger promotion in providers.create.
    // -----------------------------------------------------------------------

    "models.list_providers": async (params) => {
      const trustLevel = params._trustLevel as string | undefined;
      if (trustLevel !== "admin") {
        throw new Error("Admin access required");
      }
      const providers = [...new Set<string>(getProviders())].sort();
      return { providers, count: providers.length };
    },

    // -----------------------------------------------------------------------
    // Test provider configuration and availability
    // -----------------------------------------------------------------------

    "models.test": async (params) => {
      const provider = params.provider as string | undefined;
      if (!provider) {
        throw new Error("Missing required parameter: provider");
      }

      // Find all agents that use this provider
      const matchingAgents = Object.entries(deps.agents).filter(
        ([, a]) => a.provider === provider,
      );

      if (matchingAgents.length === 0) {
        const modelsInCatalog = deps.modelCatalog.getByProvider(provider);
        const providerEntry = deps.providerEntries?.[provider];
        const customModelCount = providerEntry?.enabled ? providerEntry.models.length : 0;
        return {
          provider,
          status: "not_configured",
          message: "No agents use this provider",
          modelsInCatalog: modelsInCatalog.length,
          ...(customModelCount > 0 ? { customModels: customModelCount } : {}),
          hint:
            "To switch to this provider, use agents_manage with action 'update' " +
            "to set the agent's provider and model. " +
            "Example: agents_manage({ action: 'update', agent_id: '<id>', " +
            `config: { provider: '${provider}', model: '<modelId>' } })`,
        };
      }

      // Check catalog availability for this provider
      const modelsInCatalog = deps.modelCatalog.getByProvider(provider);

      if (modelsInCatalog.length > 0) {
        return {
          provider,
          status: "available",
          modelsAvailable: modelsInCatalog.length,
          validatedModels: modelsInCatalog.filter((m) => m.validated).length,
          agentsUsing: matchingAgents.map(([id, a]) => ({ agentId: id, model: a.model })),
        };
      }

      // Catalog empty — check custom provider entries (custom providers
      // register with the pi ModelRegistry for routing but are not in the
      // static ModelCatalog used by this management tool).
      const providerEntry = deps.providerEntries?.[provider];
      if (providerEntry && providerEntry.enabled && providerEntry.models.length > 0) {
        return {
          provider,
          status: "available",
          source: "custom_provider",
          modelsAvailable: providerEntry.models.length,
          models: providerEntry.models.map((m) => m.id),
          agentsUsing: matchingAgents.map(([id, a]) => ({ agentId: id, model: a.model })),
        };
      }

      return {
        provider,
        status: "no_models",
        modelsAvailable: 0,
        validatedModels: 0,
        agentsUsing: matchingAgents.map(([id, a]) => ({ agentId: id, model: a.model })),
      };
    },
  };
}
