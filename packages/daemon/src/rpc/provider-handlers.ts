// SPDX-License-Identifier: Apache-2.0
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

import { ProviderEntrySchema } from "@comis/core";
import type { ProviderEntry, PerAgentConfig } from "@comis/core";
import { persistToConfig, type PersistToConfigDeps } from "./persist-to-config.js";
import { probeProviderAuth } from "./probe-provider-auth.js";
import type { RpcHandler } from "./types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Dependencies required by provider management RPC handlers. */
export interface ProviderHandlerDeps {
  /** Live provider entries map (NOT a spread copy -- mutations are same-object visible). */
  providerEntries: Record<string, ProviderEntry>;
  /** Runtime agents map for reference checks. */
  agents: Record<string, PerAgentConfig>;
  /** Optional persistence deps for writing changes to config.yaml. */
  persistDeps?: PersistToConfigDeps;
  /** SecretManager for apiKeyConfigured three-state and probe key retrieval. */
  secretManager?: { has(key: string): boolean; get(key: string): string | undefined };
}

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
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a record of provider management RPC handlers bound to the given deps.
 */
export function createProviderHandlers(deps: ProviderHandlerDeps): Record<string, RpcHandler> {
  return {
    "providers.list": async (params) => {
      const trustLevel = params._trustLevel as string | undefined;
      if (trustLevel !== "admin") {
        throw new Error("Admin access required for provider listing");
      }

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

      return { providers: summaries };
    },

    "providers.get": async (params) => {
      const trustLevel = params._trustLevel as string | undefined;
      if (trustLevel !== "admin") {
        throw new Error("Admin access required for provider retrieval");
      }

      const providerId = params.providerId as string | undefined;
      if (!providerId) {
        throw new Error("Missing required parameter: providerId");
      }

      const entry = deps.providerEntries[providerId];
      if (entry === undefined) {
        throw new Error(`Provider not found: ${providerId}`);
      }

      // Build agentsUsing list by scanning all three reference slots
      const refs = findAgentReferences(deps.agents, providerId);
      const agentsUsing = [
        ...new Set([...refs.primary, ...refs.fallback, ...refs.authProfile]),
      ];

      return {
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
    },

    "providers.create": async (params) => {
      const trustLevel = params._trustLevel as string | undefined;
      if (trustLevel !== "admin") {
        throw new Error("Admin access required for provider creation");
      }

      const providerId = params.providerId as string | undefined;
      if (!providerId) {
        throw new Error("Missing required parameter: providerId");
      }

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
      const parsedConfig = ProviderEntrySchema.parse(config);

      // Probe provider API key before committing config
      if (parsedConfig.apiKeyName && deps.secretManager) {
        const apiKey = deps.secretManager.get(parsedConfig.apiKeyName);
        if (apiKey) {
          const probeResult = await probeProviderAuth(parsedConfig.baseUrl, apiKey);
          if (!probeResult.ok) {
            throw new Error(
              `Provider "${providerId}" API key validation failed: ${probeResult.error}`,
            );
          }
        }
      }

      deps.providerEntries[providerId] = parsedConfig;

      // Best-effort persistence to config.yaml
      if (deps.persistDeps) {
        const ctx = params._context as { agentId?: string; userId?: string; traceId?: string } | undefined;
        const persistResult = await persistToConfig(deps.persistDeps, {
          patch: { providers: { entries: { [providerId]: config as unknown as Record<string, unknown> } } },
          actionType: "providers.create",
          entityId: providerId,
          actingUser: ctx?.userId ?? (params._agentId as string | undefined),
          traceId: ctx?.traceId ?? (params._traceId as string | undefined),
        });
        if (!persistResult.ok) {
          deps.persistDeps.logger.warn(
            { method: "providers.create", providerId, err: persistResult.error, hint: "Provider created in memory but config persistence failed", errorKind: "config" as const },
            "Provider config persistence failed",
          );
        }
      }

      return { providerId, config: parsedConfig, created: true };
    },

    "providers.update": async (params) => {
      const trustLevel = params._trustLevel as string | undefined;
      if (trustLevel !== "admin") {
        throw new Error("Admin access required for provider modification");
      }

      const providerId = params.providerId as string | undefined;
      if (!providerId) {
        throw new Error("Missing required parameter: providerId");
      }

      const existing = deps.providerEntries[providerId];
      if (existing === undefined) {
        throw new Error(`Provider not found: ${providerId}`);
      }

      const config = (params.config as Partial<ProviderEntry>) ?? {};
      // Capture user-provided fields BEFORE merge -- persistToConfig does deepMerge internally,
      // so we only persist the user's partial patch (not the fully merged config).
      const userPatch = params.config ? structuredClone(params.config as Record<string, unknown>) : {};

      // Headers: shallow merge per-key (preserve existing keys, overlay new ones)
      if (config.headers && existing.headers) {
        config.headers = { ...existing.headers, ...config.headers };
      }
      // models[] and capabilities: replaced wholesale via spread (no merge needed)

      const merged = { ...existing, ...config };
      const parsedConfig = ProviderEntrySchema.parse(merged);
      deps.providerEntries[providerId] = parsedConfig;

      // Best-effort persistence to config.yaml -- persist userPatch NOT merged config
      if (deps.persistDeps) {
        const ctx = params._context as { agentId?: string; userId?: string; traceId?: string } | undefined;
        const persistResult = await persistToConfig(deps.persistDeps, {
          patch: { providers: { entries: { [providerId]: userPatch } } },
          actionType: "providers.update",
          entityId: providerId,
          actingUser: ctx?.userId ?? (params._agentId as string | undefined),
          traceId: ctx?.traceId ?? (params._traceId as string | undefined),
        });
        if (!persistResult.ok) {
          deps.persistDeps.logger.warn(
            { method: "providers.update", providerId, err: persistResult.error, hint: "Provider updated in memory but config persistence failed", errorKind: "config" as const },
            "Provider config persistence failed",
          );
        }
      }

      return { providerId, config: parsedConfig, updated: true };
    },

    "providers.delete": async (params) => {
      const trustLevel = params._trustLevel as string | undefined;
      if (trustLevel !== "admin") {
        throw new Error("Admin access required for provider deletion");
      }

      const providerId = params.providerId as string | undefined;
      if (!providerId) {
        throw new Error("Missing required parameter: providerId");
      }

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
        const ctx = params._context as { agentId?: string; userId?: string; traceId?: string } | undefined;
        const persistResult = await persistToConfig(deps.persistDeps, {
          patch: {},
          removePaths: [["providers", "entries", providerId]],
          actionType: "providers.delete",
          entityId: providerId,
          actingUser: ctx?.userId ?? (params._agentId as string | undefined),
          traceId: ctx?.traceId ?? (params._traceId as string | undefined),
        });
        if (!persistResult.ok) {
          deps.persistDeps.logger.warn(
            { method: "providers.delete", providerId, err: persistResult.error, hint: "Provider deleted in memory but config persistence failed", errorKind: "config" as const },
            "Provider config persistence failed",
          );
        }
      }

      return { providerId, deleted: true };
    },

    "providers.enable": async (params) => {
      const trustLevel = params._trustLevel as string | undefined;
      if (trustLevel !== "admin") {
        throw new Error("Admin access required for provider enable");
      }

      const providerId = params.providerId as string | undefined;
      if (!providerId) {
        throw new Error("Missing required parameter: providerId");
      }

      const existing = deps.providerEntries[providerId];
      if (existing === undefined) {
        throw new Error(`Provider not found: ${providerId}`);
      }

      deps.providerEntries[providerId].enabled = true;

      // Best-effort persistence
      if (deps.persistDeps) {
        const ctx = params._context as { agentId?: string; userId?: string; traceId?: string } | undefined;
        const persistResult = await persistToConfig(deps.persistDeps, {
          patch: { providers: { entries: { [providerId]: { enabled: true } } } },
          actionType: "providers.enable",
          entityId: providerId,
          actingUser: ctx?.userId ?? (params._agentId as string | undefined),
          traceId: ctx?.traceId ?? (params._traceId as string | undefined),
        });
        if (!persistResult.ok) {
          deps.persistDeps.logger.warn(
            { method: "providers.enable", providerId, err: persistResult.error, hint: "Provider enabled in memory but config persistence failed", errorKind: "config" as const },
            "Provider config persistence failed",
          );
        }
      }

      return { providerId, enabled: true };
    },

    "providers.disable": async (params) => {
      const trustLevel = params._trustLevel as string | undefined;
      if (trustLevel !== "admin") {
        throw new Error("Admin access required for provider disable");
      }

      const providerId = params.providerId as string | undefined;
      if (!providerId) {
        throw new Error("Missing required parameter: providerId");
      }

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
        const ctx = params._context as { agentId?: string; userId?: string; traceId?: string } | undefined;
        const persistResult = await persistToConfig(deps.persistDeps, {
          patch: { providers: { entries: { [providerId]: { enabled: false } } } },
          actionType: "providers.disable",
          entityId: providerId,
          actingUser: ctx?.userId ?? (params._agentId as string | undefined),
          traceId: ctx?.traceId ?? (params._traceId as string | undefined),
        });
        if (!persistResult.ok) {
          deps.persistDeps.logger.warn(
            { method: "providers.disable", providerId, err: persistResult.error, hint: "Provider disabled in memory but config persistence failed", errorKind: "config" as const },
            "Provider config persistence failed",
          );
        }
      }

      return { providerId, enabled: false, ...(warning ? { warning } : {}) };
    },
  };
}
