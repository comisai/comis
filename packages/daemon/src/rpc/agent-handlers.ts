// SPDX-License-Identifier: Apache-2.0
/**
 * Agent management RPC handler module.
 * Provides 6 handlers for runtime agent fleet management:
 *   agents.create  — Create a new runtime agent with validated config
 *   agents.get     — Retrieve agent config and runtime state
 *   agents.update  — Patch an existing agent config
 *   agents.delete  — Remove an agent (cannot delete default)
 *   agents.suspend — Suspend an agent, preventing execution
 *   agents.resume  — Restore a suspended agent to active state
 * Follows the same factory pattern as session-handlers.ts and
 * approval-handlers.ts. Each handler validates input, operates on
 * the runtime agents map, and returns structured results.
 * @module
 */

import { PerAgentConfigSchema } from "@comis/core";
import type {
  PerAgentConfig,
  ProviderEntry,
  ModelOperationType,
  OperationModels,
  OAuthCredentialStorePort,
} from "@comis/core";
import {
  resolveWorkspaceDir,
  resolveOperationModel,
  resolveProviderFamily,
  OPERATION_TIER_MAP,
  DEFAULT_PROVIDER_KEYS,
} from "@comis/agent";
import { persistToConfig, type PersistToConfigDeps } from "./persist-to-config.js";
import {
  writeInlineWorkspaceFiles,
  type AgentInlineWorkspaceResult,
  type AgentInlineWorkspaceError,
} from "./agent-inline-workspace.js";
import { probeProviderAuth } from "./probe-provider-auth.js";
import { resolveProviderCredential } from "./credential-resolver.js";

import type { RpcHandler } from "./types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Dependencies required by agent management RPC handlers. */
export interface AgentHandlerDeps {
  /** Runtime agents map keyed by agent ID. */
  agents: Record<string, PerAgentConfig>;
  /** Default agent ID (cannot be deleted). */
  defaultAgentId: string;
  /** Runtime state tracking which agent IDs are currently suspended. */
  suspendedAgents: Set<string>;
  /** Optional persistence deps for writing changes to config.yaml. When omitted, changes are memory-only. */
  persistDeps?: PersistToConfigDeps;
  /** Hot-add callback: instantiates a new agent at runtime without restart. When provided, skipRestart: true is passed to persistToConfig. */
  hotAdd?: (agentId: string, config: PerAgentConfig) => Promise<void>;
  /** Hot-remove callback: tears down agent runtime without restart. When provided, skipRestart: true is passed to persistToConfig. */
  hotRemove?: (agentId: string) => Promise<void>;
  /** SecretManager for API key availability checks and probe key retrieval. */
  secretManager?: { has(key: string): boolean; get(key: string): string | undefined };
  /** Provider entries map for probe lookups when agents switch providers. */
  providerEntries?: Record<string, ProviderEntry>;
  /**
   * Phase 9 R7/D-11: optional OAuth credential store for validating that
   * `oauthProfiles` patches reference existing stored profile IDs. The
   * agents.update handler iterates over each (provider, profileId) entry
   * in the patched config and calls `has(profileId)`; on miss it throws
   * with the documented "not found in store" wording BEFORE the
   * `deps.agents[agentId] = parsedConfig` reference-replacement at the
   * end of the handler — failure leaves the daemon's in-memory map AND
   * the YAML both unchanged. When this field is absent (e.g. test
   * contexts without OAuth wiring) the validation block is a no-op so
   * existing behavior is preserved.
   */
  oauthCredentialStore?: OAuthCredentialStorePort;
  /**
   * Models config — passed to the credential resolver so that
   * `provider: "default"` is resolved to `models.defaultProvider` for the
   * key check, mirroring runtime resolution in `resolveAgentModel`.
   */
  modelsConfig?: { defaultProvider?: string };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a record of agent management RPC handlers bound to the given deps.
 */
export function createAgentHandlers(deps: AgentHandlerDeps): Record<string, RpcHandler> {
  return {
    "agents.create": async (params) => {
      const trustLevel = params._trustLevel as string | undefined;
      if (trustLevel !== "admin") {
        throw new Error("Admin access required for agent creation");
      }

      const agentId = params.agentId as string | undefined;
      if (!agentId) {
        throw new Error("Missing required parameter: agentId");
      }
      if (deps.agents[agentId] !== undefined) {
        throw new Error(`Agent already exists: ${agentId}`);
      }

      // 260428-vyf L2: extract inlineContent BEFORE config processing.
      // role/identity are write-once side-effects (ROLE.md / IDENTITY.md
      // file writes), NOT durable state — they NEVER enter the persisted
      // config patch. The L1 tool boundary is responsible for stripping
      // them from `config.workspace` before this RPC is called; this
      // handler only consumes the dedicated top-level `inlineContent`
      // field. If a (mis)caller leaves them inside config.workspace, the
      // downstream Zod strict-object will reject them — that's an
      // explicit failure mode, not a silent drop.
      const inlineContent = (params.inlineContent as { role?: string; identity?: string } | undefined) ?? undefined;

      const config = (params.config as Partial<PerAgentConfig>) ?? {};
      // Strip workspacePath so new agents always get the auto-computed
      // isolated workspace (~/.comis/workspace-{agentId}) instead of
      // an LLM-guessed relative path that nests inside the default workspace.
      delete config.workspacePath;

      // Ensure runtime-created agents get all tools by default (except browser).
      // The Zod schema defaults all builtinTools to true (browser: false), but
      // LLMs tend to conservatively set tools to false for specialized agents.
      // Apply full defaults as base, then overlay the LLM's explicit choices.
      const raw = config as Record<string, unknown>;
      const DEFAULT_BUILTIN_TOOLS: Record<string, boolean> = {
        read: true, write: true, edit: true, grep: true, find: true,
        ls: true, exec: true, process: true, webSearch: true, webFetch: true,
        browser: false,
      };
      const existingSkills = (raw.skills as Record<string, unknown>) ?? {};
      const existingBt = (existingSkills.builtinTools as Record<string, boolean>) ?? {};
      existingSkills.builtinTools = { ...DEFAULT_BUILTIN_TOOLS, ...existingBt };
      raw.skills = existingSkills;

      const parsedConfig = PerAgentConfigSchema.parse(config);

      // Credential guard (260501-2pz): fail-loud if the new agent's
      // provider has no resolvable API key. Mirrors agents.update guard
      // ordering — runs BEFORE the in-memory commit so rejection prevents
      // assignment, file persist, and hot-add. Same helper as the patch /
      // update call sites for cross-handler consistency.
      const credCheck = resolveProviderCredential(parsedConfig.provider, {
        providerEntries: deps.providerEntries ?? {},
        secretManager: deps.secretManager,
        modelsConfig: deps.modelsConfig,
      });
      if (!credCheck.ok) {
        throw new Error(credCheck.reason!);
      }

      deps.agents[agentId] = parsedConfig;

      // Best-effort persistence to config.yaml
      if (deps.persistDeps) {
        const ctx = params._context as { agentId?: string; userId?: string; traceId?: string } | undefined;
        const persistResult = await persistToConfig(deps.persistDeps, {
          patch: { agents: { [agentId]: config as unknown as Record<string, unknown> } },
          actionType: "agents.create",
          entityId: agentId,
          actingUser: ctx?.userId ?? (params._agentId as string | undefined),
          traceId: ctx?.traceId ?? (params._traceId as string | undefined),
          skipRestart: !!deps.hotAdd,  // skip SIGUSR2 when hot-add handles it in-process
        });
        if (!persistResult.ok) {
          deps.persistDeps.logger.warn(
            { method: "agents.create", agentId, err: persistResult.error, hint: "Agent created in memory but config persistence failed", errorKind: "config" as const },
            "Agent config persistence failed",
          );
        }
      }

      // Hot-add agent to running daemon without restart
      if (deps.hotAdd) {
        try {
          await deps.hotAdd(agentId, parsedConfig);
        } catch (hotAddErr) {
          deps.persistDeps?.logger.warn(
            { method: "agents.create", agentId, err: hotAddErr,
              hint: "Agent persisted to config but hot-add failed; will be available after restart",
              errorKind: "internal" as const },
            "Agent hot-add failed",
          );
        }
      }

      const workspaceDir = resolveWorkspaceDir(parsedConfig, agentId);

      // 260428-vyf L2: best-effort inline ROLE.md / IDENTITY.md write.
      // Only invoke when inlineContent has at least one populated field
      // AND the persistDeps logger is available (the helper requires a
      // structured logger; the in-memory-only test path skips it).
      let inlineWritesResult:
        | AgentInlineWorkspaceResult
        | { ok: false; error: AgentInlineWorkspaceError }
        | undefined;
      if (
        deps.persistDeps?.logger
        && inlineContent
        && (inlineContent.role !== undefined || inlineContent.identity !== undefined)
      ) {
        const writeResult = await writeInlineWorkspaceFiles(
          { logger: deps.persistDeps.logger },
          { workspaceDir, agentId, role: inlineContent.role, identity: inlineContent.identity },
        );
        if (writeResult.ok) {
          inlineWritesResult = writeResult.value;
        } else {
          // Best-effort: don't fail the create. The helper has already
          // emitted a structured WARN for io / path_traversal. For the
          // oversize branch the helper does NOT log (the schema layer
          // is the canonical gate) — emit a defensive WARN here so the
          // daemon-side surface is not silent.
          if (writeResult.error.kind === "oversize") {
            deps.persistDeps.logger.warn(
              {
                method: "agents.create",
                agentId,
                file: writeResult.error.file,
                limit: writeResult.error.limit,
                actual: writeResult.error.actual,
                hint: "Inline content exceeded size limit at helper layer (schema should have caught this); agent exists with template files.",
                errorKind: "validation" as const,
              },
              "Inline workspace content oversize",
            );
          }
          inlineWritesResult = { ok: false, error: writeResult.error };
        }
      }

      return {
        agentId,
        config: parsedConfig,
        created: true,
        workspaceDir,
        ...(inlineWritesResult !== undefined ? { inlineWritesResult } : {}),
      };
    },

    "agents.get": async (params) => {
      const agentId = params.agentId as string | undefined;
      if (!agentId) {
        throw new Error("Missing required parameter: agentId");
      }

      const config = deps.agents[agentId];
      if (config === undefined) {
        throw new Error(`Agent not found: ${agentId}`);
      }

      return {
        agentId,
        config,
        suspended: deps.suspendedAgents.has(agentId),
        isDefault: agentId === deps.defaultAgentId,
        workspaceDir: resolveWorkspaceDir(config, agentId),
      };
    },

    "agents.update": async (params) => {
      const trustLevel = params._trustLevel as string | undefined;
      if (trustLevel !== "admin") {
        throw new Error("Admin access required for agent modification");
      }

      const agentId = params.agentId as string | undefined;
      if (!agentId) {
        throw new Error("Missing required parameter: agentId");
      }

      const existing = deps.agents[agentId];
      if (existing === undefined) {
        throw new Error(`Agent not found: ${agentId}`);
      }

      const config = (params.config as Partial<PerAgentConfig>) ?? {};
      // Capture user-provided fields before deep-merge mutates config.
      // persistToConfig does deepMerge(existingYAML, patch) internally,
      // so we only need to persist the user's partial change.
      const userPatch = params.config ? structuredClone(params.config as Record<string, unknown>) : {};

      // Deep-merge skills.builtinTools so partial updates (e.g. toggling
      // webSearch) don't reset other existing tool toggles to schema defaults.
      if (config.skills && existing.skills) {
        config.skills = {
          ...existing.skills,
          ...config.skills,
          builtinTools: {
            ...existing.skills.builtinTools,
            ...(config.skills.builtinTools ?? {}),
          },
        } as typeof existing.skills;
      }

      // Deep-merge scheduler so heartbeat updates don't lose cron config and vice versa.
      if (config.scheduler && existing.scheduler) {
        config.scheduler = {
          ...existing.scheduler,
          ...config.scheduler,
          heartbeat: config.scheduler.heartbeat
            ? { ...(existing.scheduler.heartbeat ?? {}), ...config.scheduler.heartbeat }
            : existing.scheduler.heartbeat,
        } as typeof existing.scheduler;
      }

      // Preserve scalar fields on partial modelFailover updates. fallbackModels,
      // authProfiles, and allowedModels are arrays -- they are replaced wholesale
      // by the spread (no element-wise merge), which matches the documented
      // "user provides the complete desired list" semantic. Scalar fields
      // (cooldownInitialMs, cooldownMultiplier, cooldownCapMs, maxAttempts) are
      // preserved when omitted from the patch.
      if (config.modelFailover && existing.modelFailover) {
        config.modelFailover = {
          ...existing.modelFailover,
          ...config.modelFailover,
        } as typeof existing.modelFailover;
      }

      const merged = { ...existing, ...config };
      const parsedConfig = PerAgentConfigSchema.parse(merged);

      // Phase 9 D-11: validate oauthProfiles patch — each profileId must
      // exist in the OAuth credential store. Skipped when no
      // oauthCredentialStore is wired (test contexts; non-OAuth-aware
      // setups). Critical: this throws BEFORE the
      // `deps.agents[agentId] = parsedConfig` reference-replacement at
      // the end of the handler, so on failure the daemon's in-memory map
      // AND the YAML are both unchanged (D-11 contract). The Zod-layer
      // format check (R1, plan 02) has already run during
      // PerAgentConfigSchema.parse(merged) above — this block ONLY
      // checks existence in the store.
      if (parsedConfig.oauthProfiles !== undefined && deps.oauthCredentialStore) {
        for (const [provider, profileId] of Object.entries(parsedConfig.oauthProfiles)) {
          const has = await deps.oauthCredentialStore.has(profileId);
          if (!has.ok || !has.value) {
            throw new Error(
              `profile ${profileId} not found in store. Run "comis auth list" to see available profiles.`,
            );
          }
          // The provider variable is iterated for completeness; the
          // existence check is keyed on profileId alone (validateProfileId
          // — invoked by R1's Zod refine — already enforced that the
          // profile-id's provider portion equals the map key).
          void provider;
        }
      }

      // Credential guard + probe (260501-2pz): when provider OR model
      // changes, (a) GUARD — fail-loud if the resulting provider's API key
      // is not resolvable from any source (no silent skip), then (b) PROBE
      // — preexisting wire validation when an explicit providers.entries
      // record with apiKeyName exists. Order matters: guard runs first
      // (cheap, all paths), probe runs second (only when applicable).
      const providerChanging = config.provider !== undefined && config.provider !== existing.provider;
      const modelChanging = config.model !== undefined && config.model !== existing.model;
      if (providerChanging || modelChanging) {
        const targetProvider = parsedConfig.provider;

        // (a) GUARD — fail-loud if no credential source resolves
        const resolution = resolveProviderCredential(targetProvider, {
          providerEntries: deps.providerEntries ?? {},
          secretManager: deps.secretManager,
          modelsConfig: deps.modelsConfig,
        });
        if (!resolution.ok) {
          throw new Error(resolution.reason!);
        }

        // (b) PROBE — preexisting behavior, fires only when an explicit
        // providers.entries record with apiKeyName exists and the secret
        // is retrievable. Validates the key works against the wire.
        if (deps.providerEntries) {
          const providerEntry = deps.providerEntries[targetProvider];
          if (providerEntry?.apiKeyName && deps.secretManager) {
            const apiKey = deps.secretManager.get(providerEntry.apiKeyName);
            if (apiKey) {
              const probeResult = await probeProviderAuth(providerEntry.baseUrl, apiKey, parsedConfig.model);
              if (!probeResult.ok) {
                throw new Error(
                  `Cannot switch agent "${agentId}" to provider "${targetProvider}": ${probeResult.error}`,
                );
              }
            }
          }
        }
      }

      deps.agents[agentId] = parsedConfig;

      // Best-effort persistence to config.yaml
      if (deps.persistDeps) {
        const ctx = params._context as { agentId?: string; userId?: string; traceId?: string } | undefined;
        const persistResult = await persistToConfig(deps.persistDeps, {
          patch: { agents: { [agentId]: userPatch as unknown as Record<string, unknown> } },
          actionType: "agents.update",
          entityId: agentId,
          actingUser: ctx?.userId ?? (params._agentId as string | undefined),
          traceId: ctx?.traceId ?? (params._traceId as string | undefined),
        });
        if (!persistResult.ok) {
          deps.persistDeps.logger.warn(
            { method: "agents.update", agentId, err: persistResult.error, hint: "Agent updated in memory but config persistence failed", errorKind: "config" as const },
            "Agent config persistence failed",
          );
        }
      }

      return { agentId, config: parsedConfig, updated: true };
    },

    "agents.delete": async (params) => {
      const trustLevel = params._trustLevel as string | undefined;
      if (trustLevel !== "admin") {
        throw new Error("Admin access required for agent deletion");
      }

      const agentId = params.agentId as string | undefined;
      if (!agentId) {
        throw new Error("Missing required parameter: agentId");
      }

      if (agentId === deps.defaultAgentId) {
        throw new Error(`Cannot delete default agent: ${agentId}`);
      }

      if (deps.agents[agentId] === undefined) {
        throw new Error(`Agent not found: ${agentId}`);
      }

      delete deps.agents[agentId];
      deps.suspendedAgents.delete(agentId);

      // Best-effort persistence to config.yaml
      if (deps.persistDeps) {
        const ctx = params._context as { agentId?: string; userId?: string; traceId?: string } | undefined;
        const persistResult = await persistToConfig(deps.persistDeps, {
          patch: {},
          removePaths: [["agents", agentId]],
          actionType: "agents.delete",
          entityId: agentId,
          actingUser: ctx?.userId ?? (params._agentId as string | undefined),
          traceId: ctx?.traceId ?? (params._traceId as string | undefined),
          skipRestart: !!deps.hotRemove,  // skip SIGUSR2 when hot-remove handles it in-process
        });
        if (!persistResult.ok) {
          deps.persistDeps.logger.warn(
            { method: "agents.delete", agentId, err: persistResult.error, hint: "Agent deleted in memory but config persistence failed", errorKind: "config" as const },
            "Agent config persistence failed",
          );
        }
      }

      // Hot-remove agent from running daemon without restart
      if (deps.hotRemove) {
        try {
          await deps.hotRemove(agentId);
        } catch (hotRemoveErr) {
          deps.persistDeps?.logger.warn(
            { method: "agents.delete", agentId, err: hotRemoveErr,
              hint: "Agent removed from config but hot-remove failed; will be gone after restart",
              errorKind: "internal" as const },
            "Agent hot-remove failed",
          );
        }
      }

      return { agentId, deleted: true };
    },

    "agents.suspend": async (params) => {
      const trustLevel = params._trustLevel as string | undefined;
      if (trustLevel !== "admin") {
        throw new Error("Admin access required for agent suspension");
      }

      const agentId = params.agentId as string | undefined;
      if (!agentId) {
        throw new Error("Missing required parameter: agentId");
      }

      if (deps.agents[agentId] === undefined) {
        throw new Error(`Agent not found: ${agentId}`);
      }

      if (deps.suspendedAgents.has(agentId)) {
        throw new Error(`Agent already suspended: ${agentId}`);
      }

      deps.suspendedAgents.add(agentId);

      return { agentId, suspended: true };
    },

    "agents.resume": async (params) => {
      const trustLevel = params._trustLevel as string | undefined;
      if (trustLevel !== "admin") {
        throw new Error("Admin access required for agent resumption");
      }

      const agentId = params.agentId as string | undefined;
      if (!agentId) {
        throw new Error("Missing required parameter: agentId");
      }

      if (deps.agents[agentId] === undefined) {
        throw new Error(`Agent not found: ${agentId}`);
      }

      if (!deps.suspendedAgents.has(agentId)) {
        throw new Error(`Agent is not suspended: ${agentId}`);
      }

      deps.suspendedAgents.delete(agentId);

      return { agentId, resumed: true };
    },

    // Runtime operation model inspection
    "agent.getOperationModels": async (params) => {
      const agentId = params.agentId as string | undefined;
      if (!agentId) throw new Error("Missing required parameter: agentId");

      const config = deps.agents[agentId];
      if (config === undefined) throw new Error(`Agent not found: ${agentId}`);

      const providerFamily = resolveProviderFamily(config.provider);
      const allOpTypes = Object.keys(OPERATION_TIER_MAP) as ModelOperationType[];

      const operations = allOpTypes.map((opType) => {
        const resolution = resolveOperationModel({
          operationType: opType,
          agentProvider: config.provider,
          agentModel: config.model,
          operationModels: (config.operationModels ?? {}) as OperationModels,
          providerFamily,
        });

        const resolvedFamily = resolveProviderFamily(resolution.provider);
        const crossProvider = resolvedFamily !== providerFamily;
        const keyName = DEFAULT_PROVIDER_KEYS[resolvedFamily];
        const apiKeyConfigured = keyName == null
          ? true  // Unknown provider -- cannot validate, assume OK
          : (deps.secretManager?.has(keyName) ?? true);

        return {
          operationType: resolution.operationType,
          model: resolution.model,
          provider: resolution.provider,
          modelId: resolution.modelId,
          source: resolution.source,
          timeoutMs: resolution.timeoutMs,
          cacheRetention: resolution.cacheRetention,
          tieringActive: resolution.source === "family_default" || resolution.source === "explicit_config",
          crossProvider,
          apiKeyConfigured,
        };
      });

      return {
        agentId,
        primaryModel: `${config.provider}:${config.model}`,
        primaryProvider: config.provider,
        providerFamily,
        tieringActive: operations.some((o) => o.tieringActive),
        operations,
      };
    },
  };
}
