// SPDX-License-Identifier: Apache-2.0
// @allow-throw: RPC handler module — all throws are caught and converted to JSON-RPC error responses by rpc-dispatch.ts:306-321.
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

import { AuthorizationError } from "./errors.js";
import {
  PerAgentConfigSchema,
  AgentsCreateContract,
  AgentsGetContract,
  AgentsUpdateContract,
  AgentsDeleteContract,
  AgentsSuspendContract,
  AgentsResumeContract,
  AgentGetOperationModelsContract,
  stripInternalFields,
  systemGetEnv,
} from "@comis/core";
import type {
  PerAgentConfig,
  ModelOperationType,
  OperationModels,
} from "@comis/core";
import {
  resolveOperationModel,
  resolveProviderFamily,
  OPERATION_TIER_MAP,
  DEFAULT_PROVIDER_KEYS,
} from "@comis/agent";
import { resolveWorkspaceDir } from "@comis/core";

// ---------------------------------------------------------------------------
// Dev-mode response parse helper
// ---------------------------------------------------------------------------

/**
 * Run `contract.response.parse(result)` only when NODE_ENV !== "production".
 * Daemon side is the trust boundary; in production the trust check is
 * the in-handler logic, not the contract parse.
 */
const IS_DEV = systemGetEnv("NODE_ENV") !== "production";
import { persistToConfig } from "./shared/persist-to-config.js";
import {
  writeInlineWorkspaceFiles,
  type AgentInlineWorkspaceResult,
  type AgentInlineWorkspaceError,
} from "./agent-inline-workspace.js";
import { probeProviderAuth } from "./shared/probe-provider-auth.js";
import { resolveProviderCredential } from "./shared/credential-resolver.js";

import type { RpcHandler } from "./types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

// Re-aliased from the cluster slice in api/types.ts.
// Single source of truth: AgentsApiDeps (shared with model-handlers,
// provider-handlers).
import type { AgentsApiDeps as AgentHandlerDeps } from "./types.js";
export type { AgentHandlerDeps };

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a record of agent management RPC handlers bound to the given deps.
 */
export function createAgentHandlers(deps: AgentHandlerDeps): Record<string, RpcHandler> {
  return {
    [AgentsCreateContract.method]: async (rawParams) => {
      const trustLevel = rawParams._trustLevel as string | undefined;
      if (trustLevel !== "admin") {
        throw new AuthorizationError("Admin access required for agent creation");
      }

      // Bespoke pre-Zod validation FIRST (preserves user-friendly error
      // messages matching existing handler-test assertions).
      const agentId = rawParams.agentId as string | undefined;
      if (!agentId) {
        throw new Error("Missing required parameter: agentId");
      }
      if (deps.agents[agentId] !== undefined) {
        throw new Error(`Agent already exists: ${agentId}`);
      }

      const userParams = stripInternalFields(rawParams);
      const params = AgentsCreateContract.request.parse(userParams);

      // Extract inlineContent BEFORE config processing. role/identity
      // are write-once side-effects (ROLE.md / IDENTITY.md file writes),
      // NOT durable state — they NEVER enter the persisted config patch.
      // The tool boundary is responsible for stripping them from
      // `config.workspace` before this RPC is called; this handler only
      // consumes the dedicated top-level `inlineContent`
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

      // Credential guard: fail-loud if the new agent's provider has no
      // resolvable API key. Mirrors agents.update guard
      // ordering — runs BEFORE the in-memory commit so rejection prevents
      // assignment, file persist, and hot-add. Same helper as the patch /
      // update call sites for cross-handler consistency.
      //
      // Also plumb agents.<id>.oauthProfiles + the daemon-level OAuth
      // credential store so OAuth-only providers (e.g. openai-codex) can
      // resolve via Source C. Pre-resolve has() so the resolver itself stays
      // synchronous (port-side validator does no I/O).
      {
        const targetProvider = parsedConfig.provider;
        // eslint-disable-next-line security/detect-object-injection -- typed Record<string, string> read; targetProvider validated by schema parse
        const configuredProfileId = parsedConfig.oauthProfiles?.[targetProvider];
        let loaderHasProfile = false;
        if (configuredProfileId && deps.oauthCredentialStore) {
          const hasResult = await deps.oauthCredentialStore.has(configuredProfileId);
          loaderHasProfile = hasResult.ok && hasResult.value === true;
        }
        const credCheck = resolveProviderCredential(targetProvider, {
          providerEntries: deps.providerEntries ?? {},
          secretManager: deps.secretManager,
          modelsConfig: deps.modelsConfig,
          oauthProfiles: parsedConfig.oauthProfiles,
          oauthProfileLoader: configuredProfileId
            ? { has: (id) => id === configuredProfileId && loaderHasProfile }
            : undefined,
        });
        if (!credCheck.ok) {
          throw new Error(credCheck.reason!);
        }
      }

      deps.agents[agentId] = parsedConfig;

      // Best-effort persistence to config.yaml
      if (deps.persistDeps) {
        const ctx = rawParams._context as { agentId?: string; userId?: string; traceId?: string } | undefined;
        const persistResult = await persistToConfig(deps.persistDeps, {
          patch: { agents: { [agentId]: config as unknown as Record<string, unknown> } },
          actionType: "agents.create",
          entityId: agentId,
          actingUser: ctx?.userId ?? (rawParams._agentId as string | undefined),
          traceId: ctx?.traceId ?? (rawParams._traceId as string | undefined),
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
          // Derive the RAW (pre-Zod-default) rag.rerank.enabled from the
          // RPC `config` (NOT parsedConfig — the parse defaults unset to a concrete false and
          // erases the signal). Coerce only genuine booleans; anything else -> undefined (unset)
          // so the hot-added agent's effective-rerank precedence distinguishes unset from off.
          const rawRerank = (() => {
            const rag = (config as Record<string, unknown> | undefined)?.["rag"];
            const rerank =
              rag !== null && typeof rag === "object" ? (rag as Record<string, unknown>)["rerank"] : undefined;
            const enabled =
              rerank !== null && typeof rerank === "object" ? (rerank as Record<string, unknown>)["enabled"] : undefined;
            return typeof enabled === "boolean" ? enabled : undefined;
          })();
          await deps.hotAdd(agentId, parsedConfig, rawRerank);
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

      // Best-effort inline ROLE.md / IDENTITY.md write.
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

      const result = {
        agentId,
        config: parsedConfig,
        created: true as const,
        workspaceDir,
        ...(inlineWritesResult !== undefined ? { inlineWritesResult } : {}),
      };
      if (IS_DEV) AgentsCreateContract.response.parse(result);
      return result;
    },

    [AgentsGetContract.method]: async (rawParams) => {
      const agentId = rawParams.agentId as string | undefined;
      if (!agentId) {
        throw new Error("Missing required parameter: agentId");
      }

      const userParams = stripInternalFields(rawParams);
      AgentsGetContract.request.parse(userParams);

      const config = deps.agents[agentId];
      if (config === undefined) {
        throw new Error(`Agent not found: ${agentId}`);
      }

      const result = {
        agentId,
        config,
        suspended: deps.suspendedAgents.has(agentId),
        isDefault: agentId === deps.defaultAgentId,
        workspaceDir: resolveWorkspaceDir(config, agentId),
      };
      if (IS_DEV) AgentsGetContract.response.parse(result);
      return result;
    },

    [AgentsUpdateContract.method]: async (rawParams) => {
      const trustLevel = rawParams._trustLevel as string | undefined;
      if (trustLevel !== "admin") {
        throw new AuthorizationError("Admin access required for agent modification");
      }

      const agentId = rawParams.agentId as string | undefined;
      if (!agentId) {
        throw new Error("Missing required parameter: agentId");
      }

      const existing = deps.agents[agentId];
      if (existing === undefined) {
        throw new Error(`Agent not found: ${agentId}`);
      }

      const userParams = stripInternalFields(rawParams);
      const params = AgentsUpdateContract.request.parse(userParams);

      // dryRun: run the SAME validation below (deep-merge + Zod parse +
      // oauthProfiles existence check + credential guard/probe) but skip BOTH
      // the in-memory hot-apply and the config.yaml persist at the end. The
      // web editor's "Validate" button sends this so validating prod config
      // does not silently mutate config.yaml / config.last-good.yaml.
      const dryRun = params.dryRun === true;

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

      // Validate oauthProfiles patch — each profileId must exist in the
      // OAuth credential store. Skipped when no oauthCredentialStore is
      // wired (test contexts; non-OAuth-aware setups). Critical: this
      // throws BEFORE the `deps.agents[agentId] = parsedConfig`
      // reference-replacement at the end of the handler, so on failure the
      // daemon's in-memory map AND the YAML are both unchanged. The
      // Zod-layer format check has already run during
      // PerAgentConfigSchema.parse(merged) above — this block ONLY checks
      // existence in the store.
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
          // — invoked by the Zod refine — already enforced that the
          // profile-id's provider portion equals the map key).
          void provider;
        }
      }

      // Credential guard + probe: when provider changes,
      // (a) GUARD — fail-loud if the resulting provider's API key is not
      // resolvable from any source (no silent skip), then (b) PROBE —
      // preexisting wire validation when an explicit providers.entries
      // record with apiKeyName exists. Order matters: guard runs first
      // (cheap, all paths), probe runs second (only when applicable).
      //
      // Model-only changes with unchanged provider DO NOT fire the guard
      // or probe — they introduce no new credential surface.
      // Stale-broken-config detection moves to the next chat turn
      // (fail-loud at the request boundary), where the message is
      // correctly shaped for the actual failure mode (not a pre-emptive
      // API-key prompt that is wrong for OAuth providers like
      // openai-codex). Also plumbs agents.<id>.oauthProfiles + the
      // daemon-level OAuth credential store so Source C can fire.
      const providerChanging = config.provider !== undefined && config.provider !== existing.provider;
      if (providerChanging) {
        const targetProvider = parsedConfig.provider;

        // Pre-resolve has() at the daemon edge so the resolver stays sync.
        // eslint-disable-next-line security/detect-object-injection -- typed Record<string, string> read; targetProvider validated by schema parse
        const configuredProfileId = parsedConfig.oauthProfiles?.[targetProvider];
        let loaderHasProfile = false;
        if (configuredProfileId && deps.oauthCredentialStore) {
          const hasResult = await deps.oauthCredentialStore.has(configuredProfileId);
          loaderHasProfile = hasResult.ok && hasResult.value === true;
        }

        // (a) GUARD — fail-loud if no credential source resolves
        const resolution = resolveProviderCredential(targetProvider, {
          providerEntries: deps.providerEntries ?? {},
          secretManager: deps.secretManager,
          modelsConfig: deps.modelsConfig,
          oauthProfiles: parsedConfig.oauthProfiles,
          oauthProfileLoader: configuredProfileId
            ? { has: (id) => id === configuredProfileId && loaderHasProfile }
            : undefined,
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

      // dryRun stops here: validation above has passed (it would have thrown
      // otherwise), so report success WITHOUT hot-applying or persisting. The
      // in-memory agent map is left as the pre-call reference and config.yaml
      // is untouched.
      if (dryRun) {
        deps.persistDeps?.logger.debug(
          { method: "agents.update", agentId, step: "dry-run-validate" },
          "agents.update dry-run validated config without persisting or hot-applying",
        );
        const result = { agentId, config: parsedConfig, updated: true as const };
        if (IS_DEV) AgentsUpdateContract.response.parse(result);
        return result;
      }

      deps.agents[agentId] = parsedConfig;

      // Best-effort persistence to config.yaml
      if (deps.persistDeps) {
        const ctx = rawParams._context as { agentId?: string; userId?: string; traceId?: string } | undefined;
        const persistResult = await persistToConfig(deps.persistDeps, {
          patch: { agents: { [agentId]: userPatch as unknown as Record<string, unknown> } },
          actionType: "agents.update",
          entityId: agentId,
          actingUser: ctx?.userId ?? (rawParams._agentId as string | undefined),
          traceId: ctx?.traceId ?? (rawParams._traceId as string | undefined),
        });
        if (!persistResult.ok) {
          deps.persistDeps.logger.warn(
            { method: "agents.update", agentId, err: persistResult.error, hint: "Agent updated in memory but config persistence failed", errorKind: "config" as const },
            "Agent config persistence failed",
          );
        }
      }

      const result = { agentId, config: parsedConfig, updated: true as const };
      if (IS_DEV) AgentsUpdateContract.response.parse(result);
      return result;
    },

    [AgentsDeleteContract.method]: async (rawParams) => {
      const trustLevel = rawParams._trustLevel as string | undefined;
      if (trustLevel !== "admin") {
        throw new AuthorizationError("Admin access required for agent deletion");
      }

      const agentId = rawParams.agentId as string | undefined;
      if (!agentId) {
        throw new Error("Missing required parameter: agentId");
      }

      if (agentId === deps.defaultAgentId) {
        throw new Error(`Cannot delete default agent: ${agentId}`);
      }

      if (deps.agents[agentId] === undefined) {
        throw new Error(`Agent not found: ${agentId}`);
      }

      const userParams = stripInternalFields(rawParams);
      AgentsDeleteContract.request.parse(userParams);

      delete deps.agents[agentId];
      deps.suspendedAgents.delete(agentId);

      // Best-effort persistence to config.yaml
      if (deps.persistDeps) {
        const ctx = rawParams._context as { agentId?: string; userId?: string; traceId?: string } | undefined;
        const persistResult = await persistToConfig(deps.persistDeps, {
          patch: {},
          removePaths: [["agents", agentId]],
          actionType: "agents.delete",
          entityId: agentId,
          actingUser: ctx?.userId ?? (rawParams._agentId as string | undefined),
          traceId: ctx?.traceId ?? (rawParams._traceId as string | undefined),
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

      const result = { agentId, deleted: true as const };
      if (IS_DEV) AgentsDeleteContract.response.parse(result);
      return result;
    },

    [AgentsSuspendContract.method]: async (rawParams) => {
      const trustLevel = rawParams._trustLevel as string | undefined;
      if (trustLevel !== "admin") {
        throw new AuthorizationError("Admin access required for agent suspension");
      }

      const agentId = rawParams.agentId as string | undefined;
      if (!agentId) {
        throw new Error("Missing required parameter: agentId");
      }

      const userParams = stripInternalFields(rawParams);
      AgentsSuspendContract.request.parse(userParams);

      if (deps.agents[agentId] === undefined) {
        throw new Error(`Agent not found: ${agentId}`);
      }

      if (deps.suspendedAgents.has(agentId)) {
        throw new Error(`Agent already suspended: ${agentId}`);
      }

      deps.suspendedAgents.add(agentId);

      const result = { agentId, suspended: true as const };
      if (IS_DEV) AgentsSuspendContract.response.parse(result);
      return result;
    },

    [AgentsResumeContract.method]: async (rawParams) => {
      const trustLevel = rawParams._trustLevel as string | undefined;
      if (trustLevel !== "admin") {
        throw new AuthorizationError("Admin access required for agent resumption");
      }

      const agentId = rawParams.agentId as string | undefined;
      if (!agentId) {
        throw new Error("Missing required parameter: agentId");
      }

      const userParams = stripInternalFields(rawParams);
      AgentsResumeContract.request.parse(userParams);

      if (deps.agents[agentId] === undefined) {
        throw new Error(`Agent not found: ${agentId}`);
      }

      if (!deps.suspendedAgents.has(agentId)) {
        throw new Error(`Agent is not suspended: ${agentId}`);
      }

      deps.suspendedAgents.delete(agentId);

      const result = { agentId, resumed: true as const };
      if (IS_DEV) AgentsResumeContract.response.parse(result);
      return result;
    },

    // Runtime operation model inspection
    [AgentGetOperationModelsContract.method]: async (rawParams) => {
      const agentId = rawParams.agentId as string | undefined;
      if (!agentId) throw new Error("Missing required parameter: agentId");

      const userParams = stripInternalFields(rawParams);
      AgentGetOperationModelsContract.request.parse(userParams);

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

      const result = {
        agentId,
        primaryModel: `${config.provider}:${config.model}`,
        primaryProvider: config.provider,
        providerFamily,
        tieringActive: operations.some((o) => o.tieringActive),
        operations,
      };
      if (IS_DEV) AgentGetOperationModelsContract.response.parse(result);
      return result;
    },
  };
}
