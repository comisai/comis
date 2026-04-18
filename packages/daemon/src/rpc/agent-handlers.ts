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
import type { PerAgentConfig, ModelOperationType, OperationModels } from "@comis/core";
import {
  resolveWorkspaceDir,
  resolveOperationModel,
  resolveProviderFamily,
  OPERATION_TIER_MAP,
  DEFAULT_PROVIDER_KEYS,
} from "@comis/agent";
import { persistToConfig, type PersistToConfigDeps } from "./persist-to-config.js";

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
  /** SecretManager for API key availability checks. */
  secretManager?: { has(key: string): boolean };
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

      return { agentId, config: parsedConfig, created: true, workspaceDir: resolveWorkspaceDir(parsedConfig, agentId) };
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

      const merged = { ...existing, ...config };
      const parsedConfig = PerAgentConfigSchema.parse(merged);
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
