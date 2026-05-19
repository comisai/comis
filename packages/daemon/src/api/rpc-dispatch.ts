// SPDX-License-Identifier: Apache-2.0
// @allow-throw: RPC dispatcher boundary itself (line 304 unknown-method + line 320 re-throw); the re-throw IS the JSON-RPC error path -- gateway/method-router catches and converts to JSON-RPC error response.
/**
 * Central RPC dispatch router.
 * Merges all 14 domain handler modules into a single dispatch function
 * that routes method names to the correct handler.
 *
 * The aggregator dependency type is `ApiDispatchDeps`, defined in
 * `./types.js` as the union of 11 per-domain `*ApiDeps` cluster slices.
 * This file re-exports it for call-site convenience and never duplicates
 * the field set inline.
 * @module
 */

import type { ErrorKind } from "@comis/infra";
import type { RpcCall } from "@comis/skills";

import type { ApiDispatchDeps } from "./types.js";
export type { ApiDispatchDeps };

import { createCronHandlers } from "./cron-handlers.js";
import { createMemoryHandlers } from "./memory-handlers.js";
import { createSessionHandlers } from "./session-handlers/index.js";
import { createMessageHandlers } from "./message-handlers.js";
import { createMediaHandlers } from "./media-handlers.js";
import { createConfigHandlers } from "./config-handlers/index.js";
import { createEnvHandlers } from "./env-handlers.js";
import { createSecretsHandlers } from "./secrets-handlers.js";
import { createAuthHandlers } from "./auth-handlers.js";
import { createBrowserHandlers } from "./browser-handlers.js";
import { createSubagentHandlers } from "./subagent-handlers.js";
import { createApprovalHandlers } from "./approval-handlers.js";
import { createAgentHandlers } from "./agent-handlers.js";
import { createObsHandlers } from "./obs-handlers/index.js";
import { createCacheHandlers } from "./cache-handlers.js";
import { createModelHandlers } from "./model-handlers.js";
import { createChannelHandlers } from "./channel-handlers.js";
import { createTokenHandlers } from "./token-handlers.js";
import { createDaemonHandlers } from "./daemon-handlers.js";
import { createMcpHandlers } from "./mcp-handlers.js";
import { createContextHandlers } from "./context-handlers.js";
import { createGraphHandlers } from "./graph-handlers/index.js";
import { createWorkspaceHandlers } from "./workspace-handlers.js";
import { createHeartbeatHandlers } from "./heartbeat-handlers.js";
import { createSkillHandlers } from "./skill-handlers.js";
import { createNotificationHandlers } from "./notification-handlers.js";
import { createImageHandlers } from "./image-handlers.js";
import { createProviderHandlers } from "./provider-handlers.js";

// ---------------------------------------------------------------------------
// Aggregator type
// ---------------------------------------------------------------------------
//
// `ApiDispatchDeps` lives in `./types.js` as the union of 11 per-domain
// `*ApiDeps` cluster slices. It is re-exported at the top of this file for
// call-site convenience. The field set is partitioned across SessionsApiDeps,
// MemoryApiDeps, ChannelsApiDeps, AgentsApiDeps, OrchestratorApiDeps,
// WorkspaceApiDeps, ConfigApiDeps, AuthApiDeps, MediaApiDeps,
// ObservabilityApiDeps, DaemonApiDeps.
//
// Any remaining legacy `*HandlerDeps` interfaces in api/*-handlers.ts are
// assignable from ApiDispatchDeps via structural subtyping.

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------

/**
 * Classify an RPC error message for structured logging.
 * Returns an ErrorKind and actionable hint for Pino structured logs.
 */
export function classifyRpcError(errMsg: string): { errorKind: ErrorKind; hint: string } {
  if (errMsg.includes("immutable")) return { errorKind: "config", hint: "This config path requires daemon restart to change" };
  if (errMsg.includes("Admin access required")) return { errorKind: "auth", hint: "Use an admin-level token for this operation" };
  if (errMsg.includes("Unknown RPC method")) return { errorKind: "validation", hint: "Check method name spelling and registered methods" };
  if (errMsg.includes("not found")) return { errorKind: "validation", hint: "The requested resource does not exist" };
  if (errMsg.includes("validation failed") || errMsg.includes("Invalid input")) return { errorKind: "validation", hint: "Check parameter types and values against the schema" };
  return { errorKind: "internal", hint: "Check the RPC method handler and its dependencies" };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create the central RPC dispatch function.
 * Merges all 14 domain handler maps into a single lookup table and returns
 * an async function that routes method names to the correct handler.
 * @param deps - Superset of all handler dependencies
 * @returns RpcCall function that dispatches to domain handlers
 */
export function createRpcDispatch(deps: ApiDispatchDeps): RpcCall {
  // Late-binding ref for context.recall -> session.spawn self-dispatch
  let selfDispatch: RpcCall = async () => { throw new Error("dispatch not ready"); };

  // Build handler maps from each domain factory
  const handlers: Record<string, (params: Record<string, unknown>) => Promise<unknown>> = {
    ...createCronHandlers(deps),
    ...createMemoryHandlers(deps),
    ...createSessionHandlers(deps),
    ...createMessageHandlers(deps),
    ...createMediaHandlers(deps),
    // Thread the daemon-level OAuth credential store into config.patch's
    // credential guard so model/provider patches on OAuth-only providers
    // (e.g. openai-codex) can resolve via Source C
    // (agents.<id>.oauthProfiles -> ~/.comis/auth-profiles.json). Explicit
    // pass-through mirrors the createAgentHandlers wiring below; do not
    // simplify back to `...createConfigHandlers(deps)` (the structural-typing
    // inheritance is fragile to future deps-shape narrowing).
    //
    // Wire auditEnabled from diagnostics.configAudit.enabled. Default-true
    // semantics via the `!== false` check preserves the schema's
    // default-true contract; operators who omit the knob (undefined via
    // optional-chain) or explicitly set true see the audit line; only an
    // explicit `enabled: false` skips the JSONL append in config-write.ts.
    ...createConfigHandlers({
      ...deps,
      oauthCredentialStore: deps.oauthCredentialStore,
      auditEnabled:
        deps.container.config.diagnostics?.configAudit?.enabled !== false,
    }),
    ...createEnvHandlers(deps),
    // Encrypted secret management. Admin scope is enforced both at
    // registration (setup-gateway-api.ts) and inside each handler
    // (params._trustLevel === "admin" check).
    ...createSecretsHandlers(deps),
    // Encrypted OAuth-profile management. Admin scope enforced at
    // registration + per-handler. The un-projected OAuthProfile[] (with
    // access/refresh/accountId) lives in handler closure scope ONLY; the
    // projection strips tokens before the RPC response. See
    // api/auth-handlers.ts. Spread `...deps` so the auth cluster slice's
    // required fields (tokenRegistry, addToTokenStore, removeFromTokenStore)
    // are present alongside the auth-specific narrow wiring.
    ...createAuthHandlers({
      ...deps,
      oauthCredentialStore: deps.oauthCredentialStore,
      container: deps.container,
      logger: deps.logger,
    }),
    ...createBrowserHandlers(deps),
    ...createSubagentHandlers(deps),
    ...((deps.graphCoordinator || deps.namedGraphStore) ? createGraphHandlers({
      // Handler factory consumes OrchestratorApiDeps (narrowed to require
      // graphCoordinator). Spread `...deps` so broader slice fields
      // (cronSchedulers, executionTrackers, etc.) are present alongside the
      // narrow per-graph wiring below. The non-null assertion on
      // graphCoordinator preserves the long-standing behavior: graph.list /
      // save / load handlers can run with only namedGraphStore set, but
      // graph.execute / status / cancel handlers crash at runtime.
      ...deps,
      graphCoordinator: deps.graphCoordinator!,
      defaultAgentId: deps.defaultAgentId,
      securityConfig: deps.securityConfig,
      logger: deps.logger,
      namedGraphStore: deps.namedGraphStore,
      tenantId: deps.tenantId,
      dataDir: deps.container.config.dataDir || ".",
      nodeTypeRegistry: deps.nodeTypeRegistry,
    }) : {}),
    // approval-handlers consumes WorkspaceApiDeps; spread `...deps` so the
    // cluster slice's required fields (e.g. mcpClientManager, execGit,
    // container) are present alongside the guarded approvalGate.
    ...(deps.approvalGate ? createApprovalHandlers({ ...deps, approvalGate: deps.approvalGate }) : {}),
    ...createAgentHandlers({
      ...deps,
      secretManager: deps.container?.secretManager,
      providerEntries: deps.container.config.providers.entries,
      // Thread the daemon-level OAuth credential store into agents.update
      // so the oauthProfiles existence check can run via has(). When unset
      // (e.g. unwired test setups) the validation block in agent-handlers
      // becomes a no-op.
      oauthCredentialStore: deps.oauthCredentialStore,
      // Resolves `provider: "default"` to `models.defaultProvider` in the
      // credential check, mirroring `resolveAgentModel` runtime resolution.
      modelsConfig: deps.container.config.models,
      persistDeps: {
        container: deps.container,
        configPaths: deps.configPaths,
        defaultConfigPaths: deps.defaultConfigPaths,
        configGitManager: deps.configGitManager,
        logger: deps.logger,
      },
    }),
    // provider-handlers consumes AgentsApiDeps; spread `...deps` so required
    // slice fields (suspendedAgents, modelCatalog) are present alongside the
    // explicit provider-handler wiring.
    ...createProviderHandlers({
      ...deps,
      agents: deps.agents,
      providerEntries: deps.container.config.providers.entries,
      secretManager: deps.container?.secretManager,
      persistDeps: {
        container: deps.container,
        configPaths: deps.configPaths,
        defaultConfigPaths: deps.defaultConfigPaths,
        configGitManager: deps.configGitManager,
        logger: deps.logger,
      },
    }),
    ...createObsHandlers(deps),
    // Durable cache-stats window aggregator. Distinct from obs-handlers
    // (in-memory) — reads from `obs_token_usage` SQLite.
    ...createCacheHandlers(deps),
    ...createModelHandlers({
      ...deps,
      providerEntries: deps.container.config.providers.entries,
    }),
    ...createChannelHandlers({
      ...deps,
      persistDeps: {
        container: deps.container,
        configPaths: deps.configPaths,
        defaultConfigPaths: deps.defaultConfigPaths,
        configGitManager: deps.configGitManager,
        logger: deps.logger,
      },
    }),
    ...createTokenHandlers({
      ...deps,
      persistDeps: {
        container: deps.container,
        configPaths: deps.configPaths,
        defaultConfigPaths: deps.defaultConfigPaths,
        configGitManager: deps.configGitManager,
        logger: deps.logger,
      },
    }),
    // mcp-handlers consumes WorkspaceApiDeps; spread `...deps` so cluster
    // slice's required fields (e.g. execGit, approvalGate-bearer-context)
    // are present alongside the mcp-specific wiring.
    ...createMcpHandlers({
      ...deps,
      mcpClientManager: deps.mcpClientManager,
      logger: deps.logger,
      // Threaded for env-ref validation on mcp.connect. Same pattern as
      // agent/provider handlers above. When undefined the validator becomes
      // a no-op.
      secretManager: deps.container?.secretManager,
    }),
    // daemon-handlers consumes DaemonApiDeps; spread `...deps` so the
    // cluster slice's required `logger` is present alongside the
    // daemon-specific narrow wiring (logLevelManager).
    ...createDaemonHandlers({ ...deps, logLevelManager: deps.logLevelManager }),
    // workspace-handlers consumes WorkspaceApiDeps; spread `...deps` so
    // cluster slice's required fields are present.
    ...createWorkspaceHandlers({
      ...deps,
      agents: deps.agents,
      workspaceDirs: deps.workspaceDirs,
      defaultWorkspaceDir: deps.defaultWorkspaceDir,
      logger: deps.logger,
      execGit: deps.execGit,
      memoryApi: deps.memoryApi,
      memoryAdapter: deps.memoryAdapter,
      tenantId: deps.tenantId,
    }),
    // Heartbeat management handlers — consumes OrchestratorApiDeps.
    ...createHeartbeatHandlers({
      ...deps,
      perAgentRunner: deps.perAgentRunner,
      agents: deps.agents,
      persistDeps: deps.container ? {
        container: deps.container,
        configPaths: deps.configPaths,
        defaultConfigPaths: deps.defaultConfigPaths,
        configGitManager: deps.configGitManager,
        logger: deps.logger,
      } : undefined,
      globalHeartbeatConfig: deps.globalHeartbeatConfig,
    }),
    // Skill management handlers — consumes WorkspaceApiDeps.
    ...createSkillHandlers({
      ...deps,
      skillRegistries: deps.skillRegistries,
      workspaceDirs: deps.workspaceDirs,
      defaultAgentId: deps.defaultAgentId,
      container: deps.container,
      eventBus: deps.container.eventBus,
    }),
    // Proactive v1: Notification handlers — consumes WorkspaceApiDeps.
    ...(deps.notificationService
      ? createNotificationHandlers({ ...deps, notificationService: deps.notificationService })
      : {}),
    // Proactive v1: Image generation handlers
    ...(deps.imageHandlerDeps
      ? createImageHandlers(deps.imageHandlerDeps)
      : {}),
    // Context DAG recall handlers (conditional on contextStore) — consumes
    // MemoryApiDeps. Spread `...deps` so cluster slice's required fields
    // (memoryApi, memoryAdapter, etc.) are present.
    ...(deps.contextStore ? createContextHandlers({
      ...deps,
      store: deps.contextStore,
      tenantId: deps.tenantId,
      resolveConversationId: (sessionKey: string) =>
        deps.contextStore!.getConversationBySession(deps.tenantId, sessionKey)?.conversation_id,
      rpcCall: async (method, params) => selfDispatch(method, params),
      config: deps.contextEngineConfig ?? { maxRecallsPerDay: 5, maxExpandTokens: 4000, recallTimeoutMs: 120000 },
      logger: deps.logger,
    }) : {}),
  };

  // Return the dispatch function
  // All handler errors are caught and logged through Pino with structured fields
  // before re-throwing, ensuring errors never escape to raw stderr.
  const dispatch: RpcCall = async (method: string, params: Record<string, unknown>): Promise<unknown> => {
    const handler = handlers[method];
    if (!handler) {
      throw new Error(`Unknown RPC method: ${method}`);
    }
    try {
      return await handler(params);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      const classified = classifyRpcError(errMsg);
      deps.logger.error(
        {
          method,
          err,
          hint: classified.hint,
          errorKind: classified.errorKind,
        },
        "JSON-RPC method error",
      );
      throw err;
    }
  };

  // Wire self-dispatch for context.recall -> session.spawn delegation
  selfDispatch = dispatch;

  return dispatch;
}
