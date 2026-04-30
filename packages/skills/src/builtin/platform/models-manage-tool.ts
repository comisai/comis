// SPDX-License-Identifier: Apache-2.0
/**
 * Model management tool: multi-action tool for listing models and testing providers.
 *
 * Supports 2 actions: list (query model catalog) and test (check provider status).
 * Read-only tool -- no approval gate needed.
 * All actions enforce admin trust level via createTrustGuard.
 * Delegates to models.* RPC handlers via rpcCall.
 *
 * @module
 */

import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "typebox";
import { readStringParam } from "./tool-helpers.js";
import { createAdminManageTool } from "./admin-manage-factory.js";
import type { RpcCall } from "./cron-tool.js";

// ---------------------------------------------------------------------------
// Parameter schema
// ---------------------------------------------------------------------------

const ModelsManageToolParams = Type.Object({
  action: Type.Union(
    [
      Type.Literal("list"),
      Type.Literal("test"),
      Type.Literal("list_providers"),
    ],
    { description: "Model management action. Valid values: list (query model catalog), test (check provider availability), list_providers (live native pi-ai catalog provider list for self-discovery)" },
  ),
  provider: Type.Optional(
    Type.String({
      description:
        "Provider name to filter results (optional for list, required for test, ignored for list_providers). " +
        "Examples: anthropic, openai, google, groq.",
    }),
  ),
});

const VALID_ACTIONS = ["list", "test", "list_providers"] as const;

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a model management tool with 2 actions.
 *
 * Actions:
 * - **list** -- List available models from the catalog, optionally filtered by provider.
 *   Returns model metadata: provider, modelId, contextWindow, maxTokens, validation status.
 * - **test** -- Check provider configuration and catalog availability. Reports how many
 *   models are available and validated, and which agents use the provider.
 *
 * No approval gate -- both actions are read-only.
 *
 * @param rpcCall - RPC call function for delegating to the daemon backend
 * @returns AgentTool implementing the model management interface
 */
export function createModelsManageTool(rpcCall: RpcCall): AgentTool<typeof ModelsManageToolParams> {
  return createAdminManageTool(
    {
      name: "models_manage",
      label: "Model Management",
      description:
        "List available models, test provider availability.",
      parameters: ModelsManageToolParams,
      validActions: VALID_ACTIONS,
      rpcPrefix: "models",
      actionOverrides: {
        async list(p, rpcCall, ctx) {
          const provider = readStringParam(p, "provider", false);
          const result = await rpcCall("models.list", { provider, _trustLevel: ctx.trustLevel }) as Record<string, unknown>;

          // Unfiltered: summarize to provider directory for the LLM
          // (full catalog is 100K+ chars; agent only needs names + counts)
          if (!provider && Array.isArray(result.providers)) {
            return {
              providers: (result.providers as Array<{ name: string; modelCount: number }>)
                .map((p) => ({ name: p.name, modelCount: p.modelCount })),
              totalModels: result.totalModels,
              hint: "Use provider filter for full model details: models_manage list provider=<name>",
            };
          }

          return result;
        },
        async test(p, rpcCall, ctx) {
          const provider = readStringParam(p, "provider");
          return rpcCall("models.test", { provider, _trustLevel: ctx.trustLevel });
        },
        // Layer 1F (260430-vwt): live native-catalog provider list for
        // agent self-discovery. Pairs with the tool-guide pointer so the
        // agent can confirm which names auto-promote in providers.create.
        async list_providers(_p, rpcCall, ctx) {
          return rpcCall("models.list_providers", { _trustLevel: ctx.trustLevel });
        },
      },
    },
    rpcCall,
  );
}
