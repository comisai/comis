// SPDX-License-Identifier: Apache-2.0
// @allow-throw: RPC handler module — all throws are caught and converted to JSON-RPC error responses by rpc-dispatch.ts:306-321.
/**
 * Provider management RPC handler module.
 * Provides 7 handlers for runtime LLM provider management:
 *   providers.list    - List all providers with summary and apiKeyConfigured state
 *   providers.get     - Retrieve full provider config plus agentsUsing list
 *   providers.create  - Register a new provider entry with validation
 *   providers.update  - Patch an existing provider config with merge semantics
 *   providers.delete  - Remove a provider (blocked if agents reference it)
 *   providers.enable  - Set enabled:true on a disabled provider
 *   providers.disable - Set enabled:false (warns but does not block on references)
 *
 * Follows the same factory pattern as agent-handlers.ts. Each handler validates
 * input, operates on the runtime providerEntries map, and returns structured results.
 * API key values are NEVER exposed -- only apiKeyName references and apiKeyConfigured state.
 * @module
 */

import { AuthorizationError } from "./errors.js";
import {
  ProviderEntrySchema,
  ProvidersListContract,
  ProvidersGetContract,
  ProvidersCreateContract,
  ProvidersUpdateContract,
  ProvidersDeleteContract,
  ProvidersEnableContract,
  ProvidersDisableContract,
  stripInternalFields,
  systemGetEnv,
} from "@comis/core";
import type { ProviderEntry, PerAgentConfig } from "@comis/core";

// ---------------------------------------------------------------------------
// Dev-mode response parse helper
// ---------------------------------------------------------------------------

/**
 * Run `contract.response.parse(result)` only when NODE_ENV !== "production".
 * Daemon side is the trust boundary; in production the trust check is
 * the in-handler logic, not the contract parse.
 */
const IS_DEV = systemGetEnv("NODE_ENV") !== "production";
import type { BuiltinProvider } from "@earendil-works/pi-ai/compat";
import { getModels, getProviders } from "@earendil-works/pi-ai/compat";
import { checkBuiltInProviderRedundancy } from "./shared/builtin-provider-guard.js";
import { persistToConfig } from "./shared/persist-to-config.js";
import { probeProviderAuth } from "./shared/probe-provider-auth.js";
import type { RpcHandler } from "./types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

// Re-aliased from the cluster slice in api/types.ts. Single source of truth:
// AgentsApiDeps (shared with agent-handlers, model-handlers). The dispatcher
// constructs this handler with an explicit
// `providerEntries: deps.container.config.providers.entries` value, so the
// alias narrows that optional cluster-slice field to required (matching the
// handler body's direct `deps.providerEntries[id]` access).
import type { AgentsApiDeps } from "./types.js";
export type ProviderHandlerDeps = AgentsApiDeps & {
  providerEntries: Record<string, import("@comis/core").ProviderEntry>;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Sweep all agents for references to a given provider across three slots:
 * 1. Primary provider (agent.provider === providerId)
 * 2. Fallback models (agent.modelFailover.fallbackModels[].provider)
 * 3. Auth profiles (agent.modelFailover.authProfiles[].provider)
 *
 * Returns a structured breakdown of referencing agents by slot.
 */
function findAgentReferences(
  agents: Record<string, PerAgentConfig>,
  providerId: string,
): { primary: string[]; fallback: string[]; authProfile: string[] } {
  const primary: string[] = [];
  const fallback: string[] = [];
  const authProfile: string[] = [];

  for (const [agentId, agent] of Object.entries(agents)) {
    if (agent.provider === providerId) {
      primary.push(agentId);
    }
    if (agent.modelFailover?.fallbackModels?.some((f) => f.provider === providerId)) {
      fallback.push(agentId);
    }
    if (agent.modelFailover?.authProfiles?.some((a) => a.provider === providerId)) {
      authProfile.push(agentId);
    }
  }

  return { primary, fallback, authProfile };
}

/**
 * Check whether any agent references exist across the three slots.
 */
function hasAnyReferences(refs: { primary: string[]; fallback: string[]; authProfile: string[] }): boolean {
  return refs.primary.length > 0 || refs.fallback.length > 0 || refs.authProfile.length > 0;
}

/**
 * Format agent references into a human-readable message.
 */
function formatReferenceMessage(refs: { primary: string[]; fallback: string[]; authProfile: string[] }): string {
  const parts: string[] = [];
  if (refs.primary.length > 0) {
    parts.push(`primary provider: ${refs.primary.join(", ")}`);
  }
  if (refs.fallback.length > 0) {
    parts.push(`fallbackModels: ${refs.fallback.join(", ")}`);
  }
  if (refs.authProfile.length > 0) {
    parts.push(`authProfiles: ${refs.authProfile.join(", ")}`);
  }
  return parts.join("; ");
}

// ---------------------------------------------------------------------------
// Catalog-aware type promotion
// ---------------------------------------------------------------------------

/** Logger shape accepted by `normalizeProviderEntry`. Subset of Pino. */
interface NormalizeLogger {
  info: (obj: object, msg: string) => void;
}

/**
 * Auto-promote a Partial<ProviderEntry> when the `providerId` matches a
 * native pi-ai catalog entry AND the user has not expressed clear intent
 * to deviate from the native shape.
 *
 * The agent's tool guide currently shows `type:"openai"` as the example
 * for any OpenAI-compatible provider. Without promotion, registering
 * "openrouter" by name with that example shape lands a `type:"openai"`
 * entry that bypasses the OpenRouter native catalog (no costs, wrong
 * context window, single explicit model).
 *
 * Promotion fires when:
 *   1. providerId is in the live pi-ai native catalog, AND
 *   2. config.type is missing or set to "openai" (the passthrough sentinel), AND
 *   3. config.baseUrl is missing or matches the native catalog's baseUrl.
 *
 * Conservatism: a user pointing at a custom proxy whose URL differs from
 * the native one keeps their explicit `type:"openai"` shape -- the URL
 * mismatch is the opt-out signal.
 *
 * Logged at INFO with the original_type / promoted_type so operators can
 * see which entries were rewritten on the way in.
 */
function normalizeProviderEntry(
  providerId: string,
  config: Partial<ProviderEntry>,
  logger?: NormalizeLogger,
): Partial<ProviderEntry> {
  const native = new Set<string>(getProviders());
  if (!native.has(providerId)) return config;

  const catalog = getModels(providerId as BuiltinProvider);
  const nativeBaseUrl = catalog[0]?.baseUrl;

  const isPassthroughType = !config.type || config.type === "openai";
  const userBaseUrlMatchesNative =
    !config.baseUrl || config.baseUrl === nativeBaseUrl;

  if (isPassthroughType && userBaseUrlMatchesNative) {
    logger?.info(
      {
        providerId,
        original_type: config.type,
        promoted_type: providerId,
        hint: "Auto-promoted to native pi-ai catalog provider",
      },
      "providers.create: type promoted to native",
    );
    return { ...config, type: providerId };
  }

  return config;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a record of provider management RPC handlers bound to the given deps.
 */
export function createProviderHandlers(deps: ProviderHandlerDeps): Record<string, RpcHandler> {
  return {
    [ProvidersListContract.method]: async (rawParams) => {
      const trustLevel = rawParams._trustLevel as string | undefined;
      if (trustLevel !== "admin") {
        throw new AuthorizationError("Admin access required for provider listing");
      }
      const userParams = stripInternalFields(rawParams);
      ProvidersListContract.request.parse(userParams);

      const summaries = Object.entries(deps.providerEntries).map(([id, entry]) => ({
        id,
        type: entry.type,
        name: entry.name,
        enabled: entry.enabled,
        baseUrl: entry.baseUrl,
        apiKeyName: entry.apiKeyName,
        modelCount: entry.models.length,
        apiKeyConfigured: entry.apiKeyName
          ? (deps.secretManager?.has(entry.apiKeyName) ?? false)
          : null,
      }));

      const result = { providers: summaries };
      if (IS_DEV) ProvidersListContract.response.parse(result);
      return result;
    },

    [ProvidersGetContract.method]: async (rawParams) => {
      const trustLevel = rawParams._trustLevel as string | undefined;
      if (trustLevel !== "admin") {
        throw new AuthorizationError("Admin access required for provider retrieval");
      }

      const providerId = rawParams.providerId as string | undefined;
      if (!providerId) {
        throw new Error("Missing required parameter: providerId");
      }

      const entry = deps.providerEntries[providerId];
      if (entry === undefined) {
        throw new Error(`Provider not found: ${providerId}`);
      }

      const userParams = stripInternalFields(rawParams);
      ProvidersGetContract.request.parse(userParams);

      // Build agentsUsing list by scanning all three reference slots
      const refs = findAgentReferences(deps.agents, providerId);
      const agentsUsing = [
        ...new Set([...refs.primary, ...refs.fallback, ...refs.authProfile]),
      ];

      const result = {
        providerId,
        config: {
          type: entry.type,
          name: entry.name,
          baseUrl: entry.baseUrl,
          apiKeyName: entry.apiKeyName,
          enabled: entry.enabled,
          timeoutMs: entry.timeoutMs,
          maxRetries: entry.maxRetries,
          headers: entry.headers,
          capabilities: entry.capabilities,
          models: entry.models,
        },
        apiKeyConfigured: entry.apiKeyName
          ? (deps.secretManager?.has(entry.apiKeyName) ?? false)
          : null,
        agentsUsing,
      };
      if (IS_DEV) ProvidersGetContract.response.parse(result);
      return result;
    },

    [ProvidersCreateContract.method]: async (rawParams) => {
      const trustLevel = rawParams._trustLevel as string | undefined;
      if (trustLevel !== "admin") {
        throw new AuthorizationError("Admin access required for provider creation");
      }

      const providerId = rawParams.providerId as string | undefined;
      if (!providerId) {
        throw new Error("Missing required parameter: providerId");
      }

      const userParams = stripInternalFields(rawParams);
      const params = ProvidersCreateContract.request.parse(userParams);

      // Reserved name check -- "default" collides with PerAgentConfig.provider schema default
      if (providerId === "default") {
        throw new Error(
          'Provider ID "default" is reserved. The name "default" collides with the agent schema default -- ' +
          "every agent that never set its provider explicitly would match this entry. " +
          "Choose a descriptive name instead (e.g., 'my-ollama', 'nvidia-nim', 'groq-cloud').",
        );
      }

      if (deps.providerEntries[providerId] !== undefined) {
        throw new Error(`Provider already exists: ${providerId}`);
      }

      const config = (params.config as Partial<ProviderEntry>) ?? {};

      // Reject redundant catalog-shadowing entries before promotion / probe
      // / persist. A built-in provider with a catalog (or absent) baseUrl is
      // structurally redundant -- pi-ai's dynamic catalog already provides
      // its model list.
      const guardResult = checkBuiltInProviderRedundancy(providerId, config);
      if (!guardResult.ok) {
        throw new Error(guardResult.reason);
      }

      // Auto-promote type to native catalog name when the providerId
      // matches a pi-ai catalog entry AND the user has not opted out via a
      // custom baseUrl.
      const normalizedConfig = normalizeProviderEntry(
        providerId,
        config,
        deps.persistDeps?.logger,
      );
      const parsedConfig = ProviderEntrySchema.parse(normalizedConfig);

      // Probe provider API key before committing config
      if (parsedConfig.apiKeyName && deps.secretManager) {
        const apiKey = deps.secretManager.get(parsedConfig.apiKeyName);
        if (apiKey) {
          const probeResult = await probeProviderAuth(parsedConfig.baseUrl, apiKey, parsedConfig.models[0]?.id);
          if (!probeResult.ok) {
            throw new Error(
              `Provider "${providerId}" API key validation failed: ${probeResult.error}`,
            );
          }
        }
      }

      deps.providerEntries[providerId] = parsedConfig;

      // Best-effort persistence to config.yaml. Persist the normalized
      // config (post-Layer-1C promotion) so the YAML reflects the
      // promoted type -- otherwise the daemon would re-promote on every
      // restart, or worse, the persisted type:"openai" would override the
      // runtime promoted type on subsequent loads.
      if (deps.persistDeps) {
        const ctx = rawParams._context as { agentId?: string; userId?: string; traceId?: string } | undefined;
        const persistResult = await persistToConfig(deps.persistDeps, {
          patch: { providers: { entries: { [providerId]: normalizedConfig as unknown as Record<string, unknown> } } },
          actionType: "providers.create",
          entityId: providerId,
          actingUser: ctx?.userId ?? (rawParams._agentId as string | undefined),
          traceId: ctx?.traceId ?? (rawParams._traceId as string | undefined),
        });
        if (!persistResult.ok) {
          deps.persistDeps.logger.warn(
            { method: "providers.create", providerId, err: persistResult.error, hint: "Provider created in memory but config persistence failed", errorKind: "config" as const },
            "Provider config persistence failed",
          );
        }
      }

      const result = { providerId, config: parsedConfig, created: true as const };
      if (IS_DEV) ProvidersCreateContract.response.parse(result);
      return result;
    },

    [ProvidersUpdateContract.method]: async (rawParams) => {
      const trustLevel = rawParams._trustLevel as string | undefined;
      if (trustLevel !== "admin") {
        throw new AuthorizationError("Admin access required for provider modification");
      }

      const providerId = rawParams.providerId as string | undefined;
      if (!providerId) {
        throw new Error("Missing required parameter: providerId");
      }

      const existing = deps.providerEntries[providerId];
      if (existing === undefined) {
        throw new Error(`Provider not found: ${providerId}`);
      }

      const userParams = stripInternalFields(rawParams);
      const params = ProvidersUpdateContract.request.parse(userParams);

      const config = (params.config as Partial<ProviderEntry>) ?? {};
      // Capture user-provided fields BEFORE merge -- persistToConfig does deepMerge internally,
      // so we only persist the user's partial patch (not the fully merged config).
      const userPatch = params.config ? structuredClone(params.config as Record<string, unknown>) : {};

      // On update, only auto-promote when the user is actively changing
      // the `type` field. If `type` is absent from
      // the patch, the user is editing other fields and we must not
      // rewrite their existing type silently.
      let normalizedPatch = config;
      if (config.type !== undefined) {
        normalizedPatch = normalizeProviderEntry(
          providerId,
          config,
          deps.persistDeps?.logger,
        );
        // Mirror the promotion into both the in-memory merge and the persisted patch
        // so the YAML matches the runtime view.
        if (normalizedPatch.type !== config.type) {
          (userPatch as Record<string, unknown>).type = normalizedPatch.type;
        }
      }

      // Headers: shallow merge per-key (preserve existing keys, overlay new ones)
      if (normalizedPatch.headers && existing.headers) {
        normalizedPatch.headers = { ...existing.headers, ...normalizedPatch.headers };
      }
      // models[] and capabilities: replaced wholesale via spread (no merge needed)

      const merged = { ...existing, ...normalizedPatch };
      const parsedConfig = ProviderEntrySchema.parse(merged);
      deps.providerEntries[providerId] = parsedConfig;

      // Best-effort persistence to config.yaml -- persist userPatch NOT merged config
      if (deps.persistDeps) {
        const ctx = rawParams._context as { agentId?: string; userId?: string; traceId?: string } | undefined;
        const persistResult = await persistToConfig(deps.persistDeps, {
          patch: { providers: { entries: { [providerId]: userPatch } } },
          actionType: "providers.update",
          entityId: providerId,
          actingUser: ctx?.userId ?? (rawParams._agentId as string | undefined),
          traceId: ctx?.traceId ?? (rawParams._traceId as string | undefined),
        });
        if (!persistResult.ok) {
          deps.persistDeps.logger.warn(
            { method: "providers.update", providerId, err: persistResult.error, hint: "Provider updated in memory but config persistence failed", errorKind: "config" as const },
            "Provider config persistence failed",
          );
        }
      }

      const result = { providerId, config: parsedConfig, updated: true as const };
      if (IS_DEV) ProvidersUpdateContract.response.parse(result);
      return result;
    },

    [ProvidersDeleteContract.method]: async (rawParams) => {
      const trustLevel = rawParams._trustLevel as string | undefined;
      if (trustLevel !== "admin") {
        throw new AuthorizationError("Admin access required for provider deletion");
      }

      const providerId = rawParams.providerId as string | undefined;
      if (!providerId) {
        throw new Error("Missing required parameter: providerId");
      }

      const userParams = stripInternalFields(rawParams);
      ProvidersDeleteContract.request.parse(userParams);

      const existing = deps.providerEntries[providerId];
      if (existing === undefined) {
        throw new Error(`Provider not found: ${providerId}`);
      }

      // Three-slot reference check: block deletion if any agent references this provider
      const refs = findAgentReferences(deps.agents, providerId);
      if (hasAnyReferences(refs)) {
        throw new Error(
          `Cannot delete provider "${providerId}": referenced by agents -- ${formatReferenceMessage(refs)}. ` +
          "Remove agent references first, then retry deletion.",
        );
      }

      delete deps.providerEntries[providerId];

      // Best-effort persistence with removePaths
      if (deps.persistDeps) {
        const ctx = rawParams._context as { agentId?: string; userId?: string; traceId?: string } | undefined;
        const persistResult = await persistToConfig(deps.persistDeps, {
          patch: {},
          removePaths: [["providers", "entries", providerId]],
          actionType: "providers.delete",
          entityId: providerId,
          actingUser: ctx?.userId ?? (rawParams._agentId as string | undefined),
          traceId: ctx?.traceId ?? (rawParams._traceId as string | undefined),
        });
        if (!persistResult.ok) {
          deps.persistDeps.logger.warn(
            { method: "providers.delete", providerId, err: persistResult.error, hint: "Provider deleted in memory but config persistence failed", errorKind: "config" as const },
            "Provider config persistence failed",
          );
        }
      }

      const result = { providerId, deleted: true as const };
      if (IS_DEV) ProvidersDeleteContract.response.parse(result);
      return result;
    },

    [ProvidersEnableContract.method]: async (rawParams) => {
      const trustLevel = rawParams._trustLevel as string | undefined;
      if (trustLevel !== "admin") {
        throw new AuthorizationError("Admin access required for provider enable");
      }

      const providerId = rawParams.providerId as string | undefined;
      if (!providerId) {
        throw new Error("Missing required parameter: providerId");
      }

      const userParams = stripInternalFields(rawParams);
      ProvidersEnableContract.request.parse(userParams);

      const existing = deps.providerEntries[providerId];
      if (existing === undefined) {
        throw new Error(`Provider not found: ${providerId}`);
      }

      deps.providerEntries[providerId].enabled = true;

      // Best-effort persistence
      if (deps.persistDeps) {
        const ctx = rawParams._context as { agentId?: string; userId?: string; traceId?: string } | undefined;
        const persistResult = await persistToConfig(deps.persistDeps, {
          patch: { providers: { entries: { [providerId]: { enabled: true } } } },
          actionType: "providers.enable",
          entityId: providerId,
          actingUser: ctx?.userId ?? (rawParams._agentId as string | undefined),
          traceId: ctx?.traceId ?? (rawParams._traceId as string | undefined),
        });
        if (!persistResult.ok) {
          deps.persistDeps.logger.warn(
            { method: "providers.enable", providerId, err: persistResult.error, hint: "Provider enabled in memory but config persistence failed", errorKind: "config" as const },
            "Provider config persistence failed",
          );
        }
      }

      const result = { providerId, enabled: true as const };
      if (IS_DEV) ProvidersEnableContract.response.parse(result);
      return result;
    },

    [ProvidersDisableContract.method]: async (rawParams) => {
      const trustLevel = rawParams._trustLevel as string | undefined;
      if (trustLevel !== "admin") {
        throw new AuthorizationError("Admin access required for provider disable");
      }

      const providerId = rawParams.providerId as string | undefined;
      if (!providerId) {
        throw new Error("Missing required parameter: providerId");
      }

      const userParams = stripInternalFields(rawParams);
      ProvidersDisableContract.request.parse(userParams);

      const existing = deps.providerEntries[providerId];
      if (existing === undefined) {
        throw new Error(`Provider not found: ${providerId}`);
      }

      // Three-slot reference sweep: warn but do NOT reject
      const refs = findAgentReferences(deps.agents, providerId);
      let warning: string | undefined;
      if (hasAnyReferences(refs)) {
        warning =
          `Provider "${providerId}" is referenced by agents (${formatReferenceMessage(refs)}). ` +
          "Disabling will prevent these agents from using this provider until re-enabled.";
      }

      deps.providerEntries[providerId].enabled = false;

      // Best-effort persistence
      if (deps.persistDeps) {
        const ctx = rawParams._context as { agentId?: string; userId?: string; traceId?: string } | undefined;
        const persistResult = await persistToConfig(deps.persistDeps, {
          patch: { providers: { entries: { [providerId]: { enabled: false } } } },
          actionType: "providers.disable",
          entityId: providerId,
          actingUser: ctx?.userId ?? (rawParams._agentId as string | undefined),
          traceId: ctx?.traceId ?? (rawParams._traceId as string | undefined),
        });
        if (!persistResult.ok) {
          deps.persistDeps.logger.warn(
            { method: "providers.disable", providerId, err: persistResult.error, hint: "Provider disabled in memory but config persistence failed", errorKind: "config" as const },
            "Provider config persistence failed",
          );
        }
      }

      const result = { providerId, enabled: false as const, ...(warning ? { warning } : {}) };
      if (IS_DEV) ProvidersDisableContract.response.parse(result);
      return result;
    },
  };
}
