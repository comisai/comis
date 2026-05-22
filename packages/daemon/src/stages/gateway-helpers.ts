// SPDX-License-Identifier: Apache-2.0
/**
 * Gateway-stage helpers for daemon.ts's stageGateway.
 *
 * Top-level helpers (not closures) consumed by stageGateway in daemon.ts:
 *   - resolveGatewayTokens
 *   - createHotAdd / createHotRemove
 *   - buildImageHandlerDeps
 *   - buildTokenStoreMutators
 *   - buildContextEngineConfig
 *   - buildRpcDispatchDeps
 *   - buildSyntheticRestartMessage
 *   - replayContinuationsIfAny
 *
 * To avoid an import cycle (daemon.ts → gateway-helpers.ts → daemon.ts),
 * `DEFAULT_CONFIG_PATHS`-shaped data is passed in via deps when
 * `buildRpcDispatchDeps` needs it rather than imported back from daemon.ts.
 *
 * @module
 */

import {
  generateStrongToken,
  safePath,
  validateMemoryWrite,
  type PerAgentConfig,
} from "@comis/core";
import {
  loadContinuations,
  buildMcpStatusLine,
} from "../wiring/restart-continuation.js";
import { setupSingleAgent } from "../wiring/setup-agents/index.js";
import { randomUUID } from "node:crypto";
import os from "node:os";
import type { BootContext, GatewayPreDispatchSlice } from "../daemon-types.js";

/**
 * Internal alias: a "post-channels BootContext" where Group B/C fields are
 * known to be populated. The 5 boot* helpers run in sequence; helpers in this
 * file are called only after bootChannels has completed, so the optional
 * Group B/C/D fields they touch are non-undefined. Using `Required<Pick<>>`
 * for the touched subset preserves type-safety without forcing the caller to
 * narrow each access. Plan 59-03 will inline these helpers into daemon.ts
 * where direct local-variable references replace this alias.
 */
type PostChannelsBootContext = BootContext & Required<Pick<BootContext,
  | "defaultAgentId" | "defaultWorkspaceDir" | "agentsConfig"
  | "executors" | "workspaceDirs" | "costTrackers" | "budgetGuards" | "stepCounters"
  | "piSessionAdapters" | "skillWatcherHandles" | "skillRegistries" | "toolCapabilityPorts"
  | "singleAgentDeps" | "providerHealth" | "oauthCredentialStore"
  | "activeRunRegistry" | "mcpClientManager"
  | "subAgentRunner" | "crossSessionSender" | "channelManager" | "deliveryService"
  | "adaptersByType" | "channelPlugins" | "inboundMessageIdResolver"
  | "graphCoordinator" | "namedGraphStore" | "nodeTypeRegistry"
  | "channelHealthMonitor" | "notificationContext"
  | "modelCatalog" | "channelConfig" | "suspendedAgents"
  | "approvalGate" | "wakeCoalescer"
  | "cronSchedulers" | "executionTrackers" | "getAgentCronScheduler" | "getAgentBrowserService"
  | "memoryApi" | "memoryAdapter" | "embeddingQueue" | "continuationTracker"
  | "ttsAdapter" | "visionRegistry" | "linkRunner" | "transcriber" | "fileExtractor"
  | "resolveAttachment" | "deliveryQueue"
  | "imageGenProvider" | "imageGenRateLimiter" | "imageGenConfig"
>>;

/**
 * Resolve gateway tokens from config (config -> env -> auto-generated).
 */
export function resolveGatewayTokens(deps: {
  container: BootContext["container"];
  daemonLogger: BootContext["daemonLogger"];
}): Array<{ id: string; secret: string; scopes: string[] }> {
  const { container, daemonLogger } = deps;
  const resolved: Array<{ id: string; secret: string; scopes: string[] }> = [];
  for (const t of container.config.gateway?.tokens ?? []) {
    const tokenId = t.id ?? "unknown";
    const tokenScopes = [...(t.scopes ?? [])];
    if (typeof t.secret === "string" && t.secret.length >= 32) {
      // Source: config (explicit secret present and valid)
      resolved.push({ id: tokenId, secret: t.secret, scopes: tokenScopes });
    } else {
      const envKey = `GATEWAY_TOKEN_${tokenId.toUpperCase().replace(/-/g, "_")}`;
      const envSecret = container.secretManager.get(envKey);
      if (envSecret) {
        // Source: env / SecretManager
        resolved.push({ id: tokenId, secret: envSecret, scopes: tokenScopes });
      } else {
        // Source: auto-generated (ephemeral)
        const generated = generateStrongToken();
        resolved.push({ id: tokenId, secret: generated, scopes: tokenScopes });
        daemonLogger.warn(
          { tokenId, envVar: envKey, hint: `Set ${envKey} in environment or secrets store for persistence`, errorKind: "config" as const },
          "Gateway token auto-generated (ephemeral -- will be lost on restart)",
        );
      }
    }
  }
  return resolved;
}

/**
 * Factory: hot-add agent closure. Returns the closure that captures
 * destructured Maps + setupSingleAgent + shutdownRef + eventBus by reference
 * (all consumers hold the same Map references).
 */
// @allow-throw: hot-add agent closure throws during shutdown; consumed at daemon bootstrap catch boundary.
export function createHotAdd(deps: {
  channels: PostChannelsBootContext;
  shutdownRef: { value?: { readonly isShuttingDown: boolean } };
}): (agentId: string, config: PerAgentConfig) => Promise<void> {
  const { channels, shutdownRef } = deps;
  const {
    singleAgentDeps, executors, workspaceDirs, costTrackers, budgetGuards,
    stepCounters, piSessionAdapters, skillWatcherHandles, skillRegistries,
    toolCapabilityPorts, container, daemonLogger,
  } = channels;
  return async (agentId, config) => {
    const startMs = Date.now();
    if (shutdownRef.value?.isShuttingDown) {
      throw new Error("Cannot hot-add agent during shutdown");
    }
    const result = await setupSingleAgent(agentId, config, singleAgentDeps);
    executors.set(agentId, result.executor);
    workspaceDirs.set(agentId, result.workspaceDir);
    costTrackers.set(agentId, result.costTracker);
    budgetGuards.set(agentId, result.budgetGuard);
    stepCounters.set(agentId, result.stepCounter);
    piSessionAdapters.set(agentId, result.piSessionAdapter);
    if (result.skillWatcherHandle) {
      skillWatcherHandles.set(agentId, result.skillWatcherHandle);
    }
    skillRegistries.set(agentId, result.skillRegistry);
    toolCapabilityPorts.set(agentId, result.toolCapabilityPort);
    container.eventBus.emit("agent:hot_added", { agentId, timestamp: Date.now() });
    daemonLogger.info({ agentId, durationMs: Date.now() - startMs }, "Agent hot-added to running daemon");
  };
}

/**
 * Factory: hot-remove agent closure. Mirror of createHotAdd.
 */
export function createHotRemove(deps: {
  channels: PostChannelsBootContext;
}): (agentId: string) => Promise<void> {
  const {
    activeRunRegistry, daemonLogger, skillWatcherHandles, executors, workspaceDirs,
    costTrackers, budgetGuards, stepCounters, piSessionAdapters, skillRegistries,
    toolCapabilityPorts, container,
  } = deps.channels;
  return async (agentId) => {
    const startMs = Date.now();
    // Warn if agent may have active executions.
    // ActiveRunRegistry is keyed by sessionKey, not agentId. Since hot-remove is
    // rare and the registry is small, a coarse size > 0 check is sufficient for v1.
    if (activeRunRegistry.size > 0) {
      daemonLogger.warn(
        { agentId, activeRuns: activeRunRegistry.size,
          hint: "Agent removed while daemon has active executions; if this agent has an in-flight run it will complete but response delivery may fail",
          errorKind: "internal" as const },
        "Hot-removing agent with possible active executions",
      );
    }
    // Stop skill watcher if present
    const watcher = skillWatcherHandles.get(agentId);
    if (watcher) {
      await watcher.close();
      skillWatcherHandles.delete(agentId);
    }
    // Remove from all Maps (workspace dir preserved on disk for data safety)
    executors.delete(agentId);
    workspaceDirs.delete(agentId);
    costTrackers.delete(agentId);
    budgetGuards.delete(agentId);
    stepCounters.delete(agentId);
    piSessionAdapters.delete(agentId);
    skillRegistries.delete(agentId);
    toolCapabilityPorts.delete(agentId);
    container.eventBus.emit("agent:hot_removed", { agentId, timestamp: Date.now() });
    daemonLogger.info({ agentId, durationMs: Date.now() - startMs }, "Agent hot-removed from running daemon");
  };
}

/**
 * Build the image-handler deps used by the RPC dispatch's image handlers.
 * Returns undefined when image generation is disabled (no provider or rate
 * limiter wired in stageChannels).
 */
export function buildImageHandlerDeps(deps: {
  channels: PostChannelsBootContext;
}): import("../api/rpc-dispatch.js").ApiDispatchDeps["imageHandlerDeps"] {
  const { imageGenProvider, imageGenRateLimiter, imageGenConfig, skillsLogger, adaptersByType } = deps.channels;
  if (!imageGenProvider || !imageGenRateLimiter) return undefined;
  return {
    provider: imageGenProvider,
    rateLimiter: imageGenRateLimiter,
    config: imageGenConfig,
    logger: skillsLogger,
    getChannelAdapter: (channelType: string) => adaptersByType.get(channelType),
  };
}

/**
 * Build the token store mutators (addToTokenStore + removeFromTokenStore) used
 * by the gateway's token-management handlers.
 */
export function buildTokenStoreMutators(deps: {
  runtimeTokens: Array<{ id: string; secretBuf: Buffer; scopes: string[] }>;
  removedTokenIds: Set<string>;
}): Pick<import("../api/rpc-dispatch.js").ApiDispatchDeps, "addToTokenStore" | "removeFromTokenStore"> {
  const { runtimeTokens, removedTokenIds } = deps;
  return {
    addToTokenStore: (entry) => {
      runtimeTokens.push({ id: entry.id, secretBuf: Buffer.from(entry.secret, "utf-8"), scopes: entry.scopes });
    },
    removeFromTokenStore: (id) => {
      removedTokenIds.add(id);
      const idx = runtimeTokens.findIndex((t) => t.id === id);
      if (idx >= 0) runtimeTokens.splice(idx, 1);
    },
  };
}

/**
 * Build the context-engine config used by the RPC dispatch's context handlers.
 * Reads the default agent's contextEngine sub-tree with fallbacks.
 */
export function buildContextEngineConfig(channels: PostChannelsBootContext): { maxRecallsPerDay: number; maxExpandTokens: number; recallTimeoutMs: number } {
  const { agentsConfig: agents, defaultAgentId } = channels;
  return {
    maxRecallsPerDay: agents[defaultAgentId]?.contextEngine?.maxRecallsPerDay ?? 10,
    maxExpandTokens: agents[defaultAgentId]?.contextEngine?.maxExpandTokens ?? 4000,
    recallTimeoutMs: agents[defaultAgentId]?.contextEngine?.recallTimeoutMs ?? 120000,
  };
}

/**
 * Build the rpcDispatchDeps literal.
 * Returns the full ApiDispatchDeps shape consumed by `wireDispatch` -- every
 * field name MUST match the ApiDispatchDeps aggregator in api/types.ts.
 */
export function buildRpcDispatchDeps(deps: {
  channels: PostChannelsBootContext;
  startupStartMs: number;
  gateway: GatewayPreDispatchSlice;
  defaultConfigPaths: string[];
}): import("../api/rpc-dispatch.js").ApiDispatchDeps {
  const { channels: c, gateway: g, startupStartMs, defaultConfigPaths } = deps;
  return {
    defaultAgentId: c.defaultAgentId, getAgentCronScheduler: c.getAgentCronScheduler,
    cronSchedulers: c.cronSchedulers, executionTrackers: c.executionTrackers, wakeCoalescer: c.wakeCoalescer,
    defaultWorkspaceDir: c.defaultWorkspaceDir, workspaceDirs: c.workspaceDirs,
    memoryApi: c.memoryApi, memoryAdapter: c.memoryAdapter, embeddingQueue: c.embeddingQueue,
    tenantId: c.container.config.tenantId, agents: c.agentsConfig, costTrackers: c.costTrackers, stepCounters: c.stepCounters,
    agentDataDir: safePath(c.container.config.dataDir ?? safePath(os.homedir(), ".comis"), "agents"),
    sessionStore: g.sessionStoreBridge,
    crossSessionSender: c.crossSessionSender, subAgentRunner: c.subAgentRunner,
    graphCoordinator: c.graphCoordinator, namedGraphStore: c.namedGraphStore, nodeTypeRegistry: c.nodeTypeRegistry,
    securityConfig: c.container.config.security, adaptersByType: c.adaptersByType,
    inboundMessageIdResolver: c.inboundMessageIdResolver, visionRegistry: c.visionRegistry,
    mediaConfig: c.container.config.integrations.media, ttsAdapter: c.ttsAdapter, linkRunner: c.linkRunner,
    logger: c.logger, container: c.container, configPaths: c.configPaths, defaultConfigPaths,
    configGitManager: c.configGitManager,
    configWebhook: c.container.config.daemon.configWebhook as { url?: string; timeoutMs?: number; secret?: string },
    secretStore: c.secretStore, envFilePath: c.envPath, logLevelManager: c.logLevelManager,
    getAgentBrowserService: c.getAgentBrowserService,
    resolveAttachment: c.resolveAttachment, transcriber: c.transcriber, fileExtractor: c.fileExtractor,
    approvalGate: c.approvalGate, suspendedAgents: c.suspendedAgents,
    hotAdd: g.hotAdd, hotRemove: g.hotRemove,
    diagnosticCollector: c.diagnosticCollector, billingEstimator: c.billingEstimator,
    channelActivityTracker: c.channelActivityTracker, deliveryTracer: c.deliveryTracer, budgetGuards: c.budgetGuards,
    modelCatalog: c.modelCatalog, channelConfig: c.channelConfig,
    tokenRegistry: g.tokenRegistry,
    ...buildTokenStoreMutators({ runtimeTokens: g.runtimeTokens, removedTokenIds: g.removedTokenIds }),
    memoryWriteValidator: validateMemoryWrite,
    // MemoryApiDeps.eventBus accepts the full AppContainer["eventBus"] type;
    // no down-cast to `{ emit }` is needed.
    eventBus: c.container.eventBus,
    mcpClientManager: c.mcpClientManager, contextStore: c.contextStore,
    contextEngineConfig: buildContextEngineConfig(c),
    obsStore: c.obsStore, startupTimestamp: startupStartMs, sharedCostTracker: c.sharedCostTracker,
    contextPipelineCollector: c.contextPipelineCollector, execGit: c.execGit,
    deliveryQueue: c.deliveryQueue, deliveryService: c.deliveryService,
    channelPlugins: c.channelPlugins, healthMonitor: c.channelHealthMonitor,
    embeddingCacheStats: c.embeddingCacheStats, embeddingCircuitBreakerState: c.embeddingCircuitBreakerState,
    skillRegistries: c.skillRegistries, notificationService: c.notificationContext.notificationService,
    imageHandlerDeps: buildImageHandlerDeps({ channels: c }),
    oauthCredentialStore: c.oauthCredentialStore,
  };
}

/**
 * Build the synthetic-restart message payload for a single continuation
 * record. Rehydrates chat-type metadata so downstream resolveChatType /
 * isGroupMessage classify the resumed session correctly.
 */
export function buildSyntheticRestartMessage(deps: {
  record: ReturnType<typeof loadContinuations>[number];
  baseText: string;
  mcpStatusLine: string | undefined;
}): { id: string; channelId: string; channelType: string; senderId: string; text: string; timestamp: number; attachments: never[]; metadata: Record<string, unknown> } {
  const { record, baseText, mcpStatusLine } = deps;
  const metadata: Record<string, unknown> = {
    isRestartContinuation: true,
    mcpStatusLine: mcpStatusLine ?? null,
  };
  if (record.channelType === "telegram" && record.chatType) {
    metadata.telegramChatType = record.chatType;
  }
  if (record.chatType === "group" || record.chatType === "supergroup") {
    // Channel-agnostic flag mirrored by other adapters (e.g. WhatsApp).
    metadata.isGroup = true;
  }
  return {
    id: randomUUID(),
    channelId: record.channelId,
    channelType: record.channelType,
    senderId: record.userId,
    text: mcpStatusLine ? `${baseText}\n${mcpStatusLine}` : baseText,
    timestamp: Date.now(),
    attachments: [] as never[],
    metadata,
  };
}

/**
 * Replay restart continuations from disk if any. Owns the block that
 * loads persisted continuation records and re-injects synthetic restart
 * messages through channelManager. Per-record message construction lives in
 * `buildSyntheticRestartMessage`.
 */
export async function replayContinuationsIfAny(deps: {
  channels: PostChannelsBootContext;
}): Promise<void> {
  const { container, dataDir, daemonLogger, mcpClientManager, continuationTracker, channelManager } = deps.channels;
  const continuationFilePath = safePath(container.config.dataDir || dataDir, "restart-continuations.json");
  const continuations = loadContinuations(continuationFilePath, 5 * 60_000, daemonLogger);
  if (continuations.length === 0 || !channelManager) return;
  daemonLogger.info({ count: continuations.length }, "Replaying restart continuations");
  const mcpStatusLine = buildMcpStatusLine(mcpClientManager.getAllConnections());
  if (mcpStatusLine) {
    daemonLogger.warn(
      { mcpStatusLine, continuationCount: continuations.length,
        hint: "One or more MCP servers failed to handshake after restart; surfacing status to agents via synthetic system message",
        errorKind: "dependency" as const },
      "MCP connection failures detected during restart continuation replay",
    );
  }
  const baseText = "[system: daemon restarted to apply a config change. The result of your previous tool call is in the conversation above — react to it naturally, confirm or surface any issue, then yield to the user.]";
  for (const record of continuations) {
    // Skip sessions that already received a message during this startup cycle
    // (e.g., Telegram webhook delivered before continuation replay ran).
    if (continuationTracker.isTracked(record)) {
      daemonLogger.debug(
        { channelType: record.channelType, channelId: record.channelId },
        "Skipping continuation replay: session already active this cycle",
      );
      continue;
    }
    const syntheticMsg = buildSyntheticRestartMessage({ record, baseText, mcpStatusLine });
    channelManager.injectMessage(record.channelType, syntheticMsg).catch((injectErr) => {
      daemonLogger.warn(
        { err: injectErr, channelType: record.channelType, channelId: record.channelId, hint: "Continuation replay failed; user can re-send to resume", errorKind: "internal" as const },
        "Failed to replay continuation",
      );
    });
  }
}

