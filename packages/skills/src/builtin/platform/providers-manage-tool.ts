// SPDX-License-Identifier: Apache-2.0
/**
 * Provider management tool: multi-action tool for LLM provider configuration.
 *
 * Supports 7 actions: list, get, create, update, delete, enable, disable.
 * Destructive actions (create, delete) require approval via the ApprovalGate.
 * All actions enforce admin trust level via createTrustGuard.
 * Delegates to providers.* RPC handlers via rpcCall.
 *
 * @module
 */

import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import type { ApprovalGate } from "@comis/core";
import { readStringParam } from "./tool-helpers.js";
import { createAdminManageTool } from "./admin-manage-factory.js";
import type { RpcCall } from "./cron-tool.js";

// ---------------------------------------------------------------------------
// Parameter schema
// ---------------------------------------------------------------------------

export const ProvidersManageToolParams = Type.Object({
  action: Type.Union(
    [
      Type.Literal("list"),
      Type.Literal("get"),
      Type.Literal("create"),
      Type.Literal("update"),
      Type.Literal("delete"),
      Type.Literal("enable"),
      Type.Literal("disable"),
    ],
    {
      description:
        "Provider management action. Valid values: " +
        "list (view all providers), get (read config), " +
        "create (register new provider), update (modify config), " +
        "delete (remove provider), enable/disable (toggle availability)",
    },
  ),
  provider_id: Type.Optional(Type.String({
    description:
      "The provider identifier (required for all actions except list) " +
      "-- any user-chosen name (e.g., 'nvidia', 'deepseek', 'ollama-local', " +
      "'groq', 'my-vllm', 'company-internal')",
  })),
  config: Type.Optional(
    Type.Union([
      Type.Object(
        {
          type: Type.Optional(Type.String({
            description:
              "Provider SDK type -- determines the API protocol. Common values: " +
              "openai (any OpenAI-compatible endpoint), anthropic, google, ollama, " +
              "groq, mistral, together, deepseek, cerebras, xai, openrouter. " +
              "Use 'openai' for custom/self-hosted endpoints that speak the OpenAI " +
              "API format (NVIDIA NIM, vLLM, LM Studio, llama.cpp, Fireworks, " +
              "Perplexity, etc.)",
          })),
          name: Type.Optional(Type.String({ description: "Human-readable display name" })),
          baseUrl: Type.Optional(Type.String({
            description: "API base URL (e.g., https://integrate.api.nvidia.com/v1)",
          })),
          apiKeyName: Type.Optional(Type.String({
            description:
              "SecretManager key name for the API key (NOT the key itself). " +
              "Store the key first via gateway env_set. Required for cloud " +
              "providers; may be omitted for type='ollama' once keyless " +
              "registration lands (until then, all entries with models[] " +
              "need a resolvable apiKeyName).",
          })),
          enabled: Type.Optional(Type.Boolean({
            description: "Whether provider is active (default: true)",
          })),
          timeoutMs: Type.Optional(Type.Integer({
            description: "Request timeout in ms (default: 120000)",
          })),
          maxRetries: Type.Optional(Type.Integer({
            description: "Max retries for transient errors (default: 2)",
          })),
          headers: Type.Optional(Type.Record(Type.String(), Type.String(), {
            description: "Custom headers for API requests",
          })),
          models: Type.Optional(Type.Array(
            Type.Object({
              id: Type.String({
                description: "Model ID at provider (e.g., moonshotai/kimi-k2.5)",
              }),
              name: Type.Optional(Type.String({ description: "Display name" })),
              reasoning: Type.Optional(Type.Boolean({
                description: "Supports extended thinking",
              })),
              contextWindow: Type.Optional(Type.Integer({
                description: "Max context tokens",
              })),
              maxTokens: Type.Optional(Type.Integer({
                description: "Max output tokens",
              })),
              input: Type.Optional(Type.Array(
                Type.Union([Type.Literal("text"), Type.Literal("image")]),
              )),
            }),
            { description: "User-defined model entries for this provider" },
          )),
        },
        { description: "Provider configuration for create/update" },
      ),
      Type.String({
        description: "Provider config as JSON string (fallback). Prefer object form.",
      }),
    ]),
  ),
});

const VALID_ACTIONS = ["list", "get", "create", "update", "delete", "enable", "disable"] as const;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Coerce config from JSON string to object if LLM double-encoded it. */
function coerceConfig(p: Record<string, unknown>): Record<string, unknown> | undefined {
  const raw = p.config;
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch { /* not valid JSON, fall through */ }
  }
  return raw as Record<string, unknown> | undefined;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a provider management tool with 7 actions.
 *
 * Actions:
 * - **list** -- List all configured providers
 * - **get** -- Get provider configuration and status
 * - **create** -- Register a new provider (requires approval)
 * - **update** -- Modify provider configuration
 * - **delete** -- Remove a provider (requires approval)
 * - **enable** -- Enable a disabled provider
 * - **disable** -- Disable a provider
 *
 * @param rpcCall - RPC call function for delegating to the daemon backend
 * @param approvalGate - Optional approval gate for create/delete actions
 * @param callbacks - Optional mutation lifecycle callbacks (onMutationStart/onMutationEnd)
 * @returns AgentTool implementing the provider management interface
 */
export function createProvidersManageTool(
  rpcCall: RpcCall,
  approvalGate?: ApprovalGate,
  callbacks?: {
    onMutationStart?: () => void;
    onMutationEnd?: () => void;
  },
): AgentTool<typeof ProvidersManageToolParams> {
  return createAdminManageTool(
    {
      name: "providers_manage",
      label: "Provider Management",
      description:
        "Manage LLM providers: list, get, create, update, delete, enable, disable. " +
        "Create/delete require approval. API keys must be stored separately via gateway env_set.",
      parameters: ProvidersManageToolParams,
      validActions: VALID_ACTIONS,
      rpcPrefix: "providers",
      gatedActions: ["create", "delete"],
      actionOverrides: {
        async list(_p, rpcCall, ctx) {
          return rpcCall("providers.list", { _trustLevel: ctx.trustLevel });
        },
        async get(p, rpcCall, ctx) {
          const providerId = readStringParam(p, "provider_id");
          return rpcCall("providers.get", { providerId, _trustLevel: ctx.trustLevel });
        },
        async create(p, rpcCall, ctx) {
          const providerId = readStringParam(p, "provider_id");
          const config = coerceConfig(p);
          callbacks?.onMutationStart?.();
          try {
            return await rpcCall("providers.create", { providerId, config, _trustLevel: ctx.trustLevel });
          } finally {
            callbacks?.onMutationEnd?.();
          }
        },
        async update(p, rpcCall, ctx) {
          const providerId = readStringParam(p, "provider_id");
          const config = coerceConfig(p);
          callbacks?.onMutationStart?.();
          try {
            return await rpcCall("providers.update", { providerId, config, _trustLevel: ctx.trustLevel });
          } finally {
            callbacks?.onMutationEnd?.();
          }
        },
        async delete(p, rpcCall, ctx) {
          const providerId = readStringParam(p, "provider_id");
          callbacks?.onMutationStart?.();
          try {
            return await rpcCall("providers.delete", { providerId, _trustLevel: ctx.trustLevel });
          } finally {
            callbacks?.onMutationEnd?.();
          }
        },
        async enable(p, rpcCall, ctx) {
          const providerId = readStringParam(p, "provider_id");
          callbacks?.onMutationStart?.();
          try {
            return await rpcCall("providers.enable", { providerId, _trustLevel: ctx.trustLevel });
          } finally {
            callbacks?.onMutationEnd?.();
          }
        },
        async disable(p, rpcCall, ctx) {
          const providerId = readStringParam(p, "provider_id");
          callbacks?.onMutationStart?.();
          try {
            return await rpcCall("providers.disable", { providerId, _trustLevel: ctx.trustLevel });
          } finally {
            callbacks?.onMutationEnd?.();
          }
        },
      },
    },
    rpcCall,
    approvalGate,
    callbacks,
  );
}
