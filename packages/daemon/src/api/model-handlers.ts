// SPDX-License-Identifier: Apache-2.0
// @allow-throw: RPC handler module — all throws are caught and converted to JSON-RPC error responses by rpc-dispatch.ts:306-321.
/**
 * Model management RPC handler module.
 * Handles model catalog query methods:
 *   models.list           -- List available models (optionally filtered by provider)
 *   models.test           -- Check provider configuration and catalog status
 *   models.list_providers -- Live native pi-ai catalog provider list
 * All handlers are read-only -- no approval gate required.
 * @module
 */

import { AuthorizationError } from "./errors.js";
import { getProviders } from "@earendil-works/pi-ai";
import {
  ModelsListContract,
  ModelsListProvidersContract,
  ModelsTestContract,
  stripInternalFields,
  systemGetEnv,
} from "@comis/core";
import type { RpcHandler } from "./types.js";

// ---------------------------------------------------------------------------
// Dev-mode response parse helper
// ---------------------------------------------------------------------------

/**
 * Run `contract.response.parse(result)` only when NODE_ENV !== "production".
 * Daemon side is the trust boundary; in production the trust check is
 * the in-handler logic, not the contract parse.
 */
const IS_DEV = systemGetEnv("NODE_ENV") !== "production";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

// Re-aliased from the cluster slice in api/types.ts.
// Single source of truth: AgentsApiDeps (shared with agent-handlers,
// provider-handlers).
import type { AgentsApiDeps as ModelHandlerDeps } from "./types.js";
export type { ModelHandlerDeps };

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

    [ModelsListContract.method]: async (rawParams) => {
      const userParams = stripInternalFields(rawParams);
      const params = ModelsListContract.request.parse(userParams);

      const provider = params.provider as string | undefined;

      // Filtered: return full model details for a single provider
      if (provider) {
        const entries = deps.modelCatalog.getByProvider(provider);
        const result = {
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
        if (IS_DEV) ModelsListContract.response.parse(result);
        return result;
      }

      // Unfiltered: return full catalog grouped by provider (used by GUI)
      const providerNames = deps.modelCatalog.getProviders();
      const result = {
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
      if (IS_DEV) ModelsListContract.response.parse(result);
      return result;
    },

    // -----------------------------------------------------------------------
    // List native pi-ai catalog providers
    //
    // Live self-discovery for the agent: returns the de-duplicated, sorted
    // list of provider names from the pi-ai native catalog. Pairs with the
    // tool-descriptions auto-promote guidance so the agent can verify
    // which provider_id values trigger promotion in providers.create.
    // -----------------------------------------------------------------------

    [ModelsListProvidersContract.method]: async (rawParams) => {
      const trustLevel = rawParams._trustLevel as string | undefined;
      if (trustLevel !== "admin") {
        throw new AuthorizationError("Admin access required");
      }
      const userParams = stripInternalFields(rawParams);
      ModelsListProvidersContract.request.parse(userParams);

      const providers = [...new Set<string>(getProviders())].sort();
      const result = { providers, count: providers.length };
      if (IS_DEV) ModelsListProvidersContract.response.parse(result);
      return result;
    },

    // -----------------------------------------------------------------------
    // Test provider configuration and availability
    // -----------------------------------------------------------------------

    [ModelsTestContract.method]: async (rawParams) => {
      const provider = rawParams.provider as string | undefined;
      if (!provider) {
        throw new Error("Missing required parameter: provider");
      }

      const userParams = stripInternalFields(rawParams);
      ModelsTestContract.request.parse(userParams);

      // Find all agents that use this provider
      const matchingAgents = Object.entries(deps.agents).filter(
        ([, a]) => a.provider === provider,
      );

      if (matchingAgents.length === 0) {
        const modelsInCatalog = deps.modelCatalog.getByProvider(provider);
        const providerEntry = deps.providerEntries?.[provider];
        const customModelCount = providerEntry?.enabled ? providerEntry.models.length : 0;
        const result = {
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
        if (IS_DEV) ModelsTestContract.response.parse(result);
        return result;
      }

      // Check catalog availability for this provider
      const modelsInCatalog = deps.modelCatalog.getByProvider(provider);

      if (modelsInCatalog.length > 0) {
        const result = {
          provider,
          status: "available",
          modelsAvailable: modelsInCatalog.length,
          validatedModels: modelsInCatalog.filter((m) => m.validated).length,
          agentsUsing: matchingAgents.map(([id, a]) => ({ agentId: id, model: a.model })),
        };
        if (IS_DEV) ModelsTestContract.response.parse(result);
        return result;
      }

      // Catalog empty — check custom provider entries (custom providers
      // register with the pi ModelRegistry for routing but are not in the
      // static ModelCatalog used by this management tool).
      const providerEntry = deps.providerEntries?.[provider];
      if (providerEntry && providerEntry.enabled && providerEntry.models.length > 0) {
        const result = {
          provider,
          status: "available",
          source: "custom_provider",
          modelsAvailable: providerEntry.models.length,
          models: providerEntry.models.map((m) => m.id),
          agentsUsing: matchingAgents.map(([id, a]) => ({ agentId: id, model: a.model })),
        };
        if (IS_DEV) ModelsTestContract.response.parse(result);
        return result;
      }

      const result = {
        provider,
        status: "no_models",
        modelsAvailable: 0,
        validatedModels: 0,
        agentsUsing: matchingAgents.map(([id, a]) => ({ agentId: id, model: a.model })),
      };
      if (IS_DEV) ModelsTestContract.response.parse(result);
      return result;
    },
  };
}
