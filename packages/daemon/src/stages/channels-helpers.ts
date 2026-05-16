// SPDX-License-Identifier: Apache-2.0
/**
 * Channels-stage helpers for daemon.ts's stageChannels.
 *
 * Block-moved verbatim from daemon.ts in Phase 43 Wave 8c (FILE-SPLIT-06):
 *   - buildChannelManagerDeps (daemon.ts:1289-1338)
 *   - buildGraphCoordinatorDeps (daemon.ts:1346-1382)
 *   - buildGraphPreWarm (daemon.ts:1389-1409)
 *   - setupChannelHealthMonitor (daemon.ts:1419-1448)
 *   - createCapabilityPortResolver (daemon.ts:1458-1471)
 *   - wirePostChannelsLifecycle (daemon.ts:1480-1512)
 *   - buildImageGenBundle (daemon.ts:1520-1546)
 *
 * Each helper is a top-level function (not a closure) — mechanical block-move
 * is safe per RESEARCH §"No-cycles invariant". Consumed by stageChannels in
 * daemon.ts.
 *
 * @module
 */

import type { ToolCapabilityPort } from "@comis/core";
import {
  createChannelHealthMonitor,
  type ChannelHealthMonitor,
} from "@comis/channels";
import {
  createImageGenProvider,
  createImageGenRateLimiter,
  type ImageGenRateLimiter,
} from "@comis/skills";
import type { AgentsHandle, ChannelsHandle } from "../daemon-types.js";
import type { InboundMessageIdResolver } from "../wiring/inbound-message-id-resolver.js";
import {
  setupDeliveryQueueLogging,
} from "../observability/delivery-queue-logger.js";
import {
  setupChannels,
  setupCrossSession,
  setupTools,
  setupOutputRetention,
  type setupLogging,
} from "../wiring/index.js";
import type { createGraphCoordinator, createNodeTypeRegistry } from "../graph/index.js";

/**
 * Build the deps object passed to `setupChannels`. Lifted from the inline
 * argument-construction block inside stageChannels to keep the stage body
 * under the DAEMON-API-06 ≤200L cap (helper itself ≤50L per DAEMON-API-07).
 *
 * All closure inputs flow through `deps`. The returned object is consumed
 * verbatim by `setupChannels(...)`; no inline mutation here.
 */
export function buildChannelManagerDeps(deps: {
  agents: AgentsHandle;
  toolAssemblerRef: { ref?: (agentId: string, options?: import("../wiring/setup-tools.js").AssembleToolsOptions) => Promise<unknown[]> };
  inboundMessageIdResolverRef: { ref?: InboundMessageIdResolver };
  sessionTrackerRef: { ref?: import("../notification/session-tracker.js").SessionTracker };
}): Parameters<typeof setupChannels>[0] {
  const { agents, toolAssemblerRef, inboundMessageIdResolverRef, sessionTrackerRef } = deps;
  const {
    container, executors, defaultAgentId, sessionManager, sessionStore,
    logger, channelsLogger, linkRunner, ssrfFetcher, transcriber,
    ttsAdapter, audioConverter, mediaTempManager, mediaSemaphore, fileExtractor,
    workspaceDirs, defaultWorkspaceDir, memoryAdapter, embeddingQueue,
    activeRunRegistry, sessionResolver, rpcCall, extractFromConversation,
    continuationTracker, approvalGate,
    piSessionAdapters, costTrackers, deliveryQueue, executionTrackers,
  } = agents;
  return {
    container, executors, defaultAgentId, sessionManager, sessionStore,
    logger, channelsLogger,
    linkRunner, ssrfFetcher, transcriber,
    maxMediaBytes: container.config.integrations.media.infrastructure.maxRemoteFetchBytes,
    /* eslint-disable @typescript-eslint/no-explicit-any -- matches assembleToolsForAgent signature from setup-tools.ts */
    assembleToolsForAgent: (agentId: string, options?: { sessionKey?: import("@comis/core").SessionKey }): Promise<any[]> =>
      toolAssemblerRef.ref ? toolAssemblerRef.ref(agentId, options) as Promise<any[]> : Promise.resolve([]),
    /* eslint-enable @typescript-eslint/no-explicit-any */
    ttsAdapter, audioConverter, mediaTempManager, mediaSemaphore,
    fileExtractor, fileExtractionConfig: container.config.integrations.media.documentExtraction,
    workspaceDirs, defaultWorkspaceDir, memoryAdapter,
    tenantId: container.config.tenantId,
    embeddingQueue, queueConfig: container.config.queue,
    activeRunRegistry, sessionResolver, rpcCall,
    onTaskExtraction: extractFromConversation,
    onMessageReceived: (msg, channelType) => {
      const chatType = typeof msg.metadata?.telegramChatType === "string"
        ? msg.metadata.telegramChatType
        : undefined;
      continuationTracker.track({
        agentId: defaultAgentId, channelType, channelId: msg.channelId,
        userId: msg.senderId, chatType, tenantId: container.config.tenantId, timestamp: Date.now(),
      });
      inboundMessageIdResolverRef.ref?.record(msg, channelType);
    },
    onMessageProcessed: (msg, channelType) => {
      sessionTrackerRef.ref?.recordActivity(defaultAgentId, channelType, msg.channelId);
    },
    approvalGate: container.config.approvals?.enabled ? approvalGate : undefined,
    piSessionAdapters, costTrackers, deliveryQueue,
    cronExecutionTrackers: executionTrackers,
  };
}

/**
 * Build the deps object passed to `createGraphCoordinator`. Lifted from the
 * inline argument-construction block inside stageChannels to keep the stage
 * body under the DAEMON-API-06 ≤200L cap (helper itself ≤50L per
 * DAEMON-API-07).
 */
export function buildGraphCoordinatorDeps(deps: {
  agents: AgentsHandle;
  channels: {
    subAgentRunner: ReturnType<typeof setupCrossSession>["subAgentRunner"];
    sendToChannel: ReturnType<typeof setupCrossSession>["sendToChannel"];
    announceToParent: ReturnType<typeof setupCrossSession>["announceToParent"];
    announcementBatcher: ReturnType<typeof setupCrossSession>["announcementBatcher"];
    commandQueue: Awaited<ReturnType<typeof setupChannels>>["commandQueue"];
    assembleToolsForAgent: ReturnType<typeof setupTools>["assembleToolsForAgent"];
    nodeTypeRegistry: ReturnType<typeof createNodeTypeRegistry>;
  };
}): Parameters<typeof createGraphCoordinator>[0] {
  const { agents, channels } = deps;
  const { container, defaultAgentId, dataDir, agentLogger, activeRunRegistry, agentsConfig } = agents;
  const a2aSec = container.config.security.agentToAgent as Record<string, unknown>;
  return {
    subAgentRunner: channels.subAgentRunner, eventBus: container.eventBus,
    sendToChannel: channels.sendToChannel, announceToParent: channels.announceToParent,
    batcher: channels.announcementBatcher, tenantId: container.config.tenantId, defaultAgentId,
    maxConcurrency: (a2aSec.graphMaxConcurrency as number | undefined) ?? 4,
    maxResultLength: a2aSec.graphMaxResultLength as number | undefined,
    maxGlobalSubAgents: a2aSec.graphMaxGlobalSubAgents as number | undefined,
    logger: agentLogger?.child?.({ submodule: "graph-coordinator" }),
    dataDir: container.config.dataDir || dataDir,
    nodeTypeRegistry: channels.nodeTypeRegistry, activeRunRegistry,
    assembleToolsForAgent: async (agentId: string) => {
      const tools = await channels.assembleToolsForAgent(agentId);
      return tools.map((t: { name: string; description?: string; inputSchema?: unknown }) => ({
        name: t.name, description: t.description, inputSchema: t.inputSchema,
      }));
    },
    touchParentSession: channels.commandQueue
      ? (sessionKey: string) => channels.commandQueue!.touchLane(sessionKey)
      : undefined,
    preWarm: buildGraphPreWarm({ agentsConfig, defaultAgentId, secretManager: container.secretManager }),
  };
}

/**
 * Build the optional pre-warm cache config for Anthropic graph executions.
 * Returns undefined if no Anthropic API key is resolvable. Extracted from
 * buildGraphCoordinatorDeps to keep both helpers under DAEMON-API-07 ≤50L.
 */
export function buildGraphPreWarm(deps: {
  agentsConfig: AgentsHandle["agentsConfig"];
  defaultAgentId: string;
  secretManager: AgentsHandle["container"]["secretManager"];
}): NonNullable<Parameters<typeof createGraphCoordinator>[0]["preWarm"]> | undefined {
  const { agentsConfig, defaultAgentId, secretManager } = deps;
  const agentCfg = agentsConfig[defaultAgentId];
  const provider = agentCfg?.provider ?? "anthropic";
  const resolvedModel = agentCfg?.model === "default" || !agentCfg?.model
    ? "claude-sonnet-4-5-20250929"
    : agentCfg.model;
  const apiKey = secretManager.get("anthropic-api-key") ?? secretManager.get("ANTHROPIC_API_KEY") ?? "";
  if (!apiKey) return undefined;
  return {
    provider, modelId: resolvedModel, apiKey,
    systemPrompt: agentCfg?.name
      ? `You are ${agentCfg.name}. You are a helpful AI assistant.`
      : "You are a helpful AI assistant.",
    tools: [] as Array<{ name: string; description?: string; inputSchema?: unknown }>,
  };
}

/**
 * Set up the channel health monitor. Returns `{ monitor, stop }`, subsuming
 * today's `let channelHealthMonitor` + `let stopChannelHealthMonitor`
 * (DAEMON-API-09 refs #10 + #11) into a single helper return value -- both
 * `let`s disappear from stageChannels.
 *
 * Extracted to keep stageChannels under the DAEMON-API-06 ≤200L cap.
 */
export function setupChannelHealthMonitor(deps: {
  adaptersByType: Awaited<ReturnType<typeof setupChannels>>["adaptersByType"];
  daemonLogger: ReturnType<typeof setupLogging>["daemonLogger"];
  container: AgentsHandle["container"];
}): { monitor: ChannelHealthMonitor | undefined; stop: (() => void) | undefined } {
  const { adaptersByType, daemonLogger, container } = deps;
  const healthCheckConfig = container.config.channels?.healthCheck;
  if (healthCheckConfig?.enabled === false) return { monitor: undefined, stop: undefined };
  const monitor = createChannelHealthMonitor({
    eventBus: container.eventBus,
    pollIntervalMs: healthCheckConfig?.pollIntervalMs,
    staleThresholdMs: healthCheckConfig?.staleThresholdMs,
    idleThresholdMs: healthCheckConfig?.idleThresholdMs,
    errorThreshold: healthCheckConfig?.errorThreshold,
    stuckThresholdMs: healthCheckConfig?.stuckThresholdMs,
    startupGraceMs: healthCheckConfig?.startupGraceMs,
    autoRestartOnStale: healthCheckConfig?.autoRestartOnStale,
    maxRestartsPerHour: healthCheckConfig?.maxRestartsPerHour,
    restartCooldownMs: healthCheckConfig?.restartCooldownMs,
    restartAdapter: async (channelType: string) => {
      const adapter = adaptersByType.get(channelType);
      if (!adapter) return;
      daemonLogger.info({ channelType }, "Health monitor triggering auto-restart for stale adapter");
      await adapter.stop();
      await adapter.start();
    },
  });
  const stop = monitor.start(adaptersByType);
  return { monitor, stop };
}

/**
 * Factory: resolve a `ToolCapabilityPort` for an agentId; falls back to the
 * default agent's port. Throws if neither is registered (mirrors setup-tools.ts
 * `agents[agentId] ?? agents[defaultAgentId]` convention).
 *
 * Extracted to keep stageChannels under the DAEMON-API-06 ≤200L cap. The
 * original 17L closure is logically a factory; factory form is clearer.
 */
// @allow-throw: ToolCapabilityPort resolver; consumed at daemon bootstrap catch boundary (Phase 41 TS-HYG-07).
export function createCapabilityPortResolver(
  toolCapabilityPorts: Map<string, ToolCapabilityPort>,
  defaultAgentId: string,
): (agentId: string) => ToolCapabilityPort {
  return (agentId: string) => {
    const port = toolCapabilityPorts.get(agentId) ?? toolCapabilityPorts.get(defaultAgentId);
    if (!port) {
      throw new Error(
        `No ToolCapabilityPort registered for agent '${agentId}' and no default agent ('${defaultAgentId}') fallback available -- the agent may have been removed or the daemon failed to initialize.`,
      );
    }
    return port;
  };
}

/**
 * Wire post-setupChannels lifecycle hooks: populate the delivery-queue
 * channelAdapters map, drain + start prune timer, mirror prune lifecycle,
 * delivery-queue logging, and output retention housekeeper.
 *
 * Extracted to keep stageChannels under the DAEMON-API-06 ≤200L cap.
 */
export async function wirePostChannelsLifecycle(deps: {
  adaptersByType: Awaited<ReturnType<typeof setupChannels>>["adaptersByType"];
  channelAdaptersRef: AgentsHandle["channelAdaptersRef"];
  drainAndStartDeliveryPrune: AgentsHandle["drainAndStartDeliveryPrune"];
  shutdownDeliveryQueue: AgentsHandle["shutdownDeliveryQueue"];
  startMirrorPrune: AgentsHandle["startMirrorPrune"];
  shutdownMirror: AgentsHandle["shutdownMirror"];
  daemonLogger: ReturnType<typeof setupLogging>["daemonLogger"];
  container: AgentsHandle["container"];
  defaultWorkspaceDir: string;
  outputRetentionConfig: AgentsHandle["container"]["config"]["outputRetention"];
}): Promise<void> {
  const { adaptersByType, channelAdaptersRef, drainAndStartDeliveryPrune, shutdownDeliveryQueue,
    startMirrorPrune, shutdownMirror, daemonLogger, container, defaultWorkspaceDir,
    outputRetentionConfig } = deps;
  for (const [type, adapter] of adaptersByType) channelAdaptersRef.set(type, adapter);
  await drainAndStartDeliveryPrune();
  container.eventBus.on("system:shutdown", () => { shutdownDeliveryQueue(); });
  startMirrorPrune();
  container.eventBus.on("system:shutdown", () => { shutdownMirror(); });
  setupDeliveryQueueLogging({ eventBus: container.eventBus, logger: daemonLogger });
  if (defaultWorkspaceDir) {
    const outputRetentionHandle = setupOutputRetention({
      config: outputRetentionConfig, workspaceDir: defaultWorkspaceDir, logger: daemonLogger,
    });
    container.eventBus.on("system:shutdown", () => { outputRetentionHandle.shutdown(); });
  } else {
    daemonLogger.debug(
      { hint: "No defaultWorkspaceDir; output retention housekeeper skipped" },
      "Output retention: skipped (no default workspace)",
    );
  }
}

/**
 * Build the image-generation provider bundle: provider + rate limiter + config.
 * Logs the same info/debug/warn lines as the original inline block.
 *
 * Extracted to keep stageChannels under the DAEMON-API-06 ≤200L cap.
 */
export function buildImageGenBundle(deps: {
  container: AgentsHandle["container"];
  skillsLogger: ReturnType<typeof setupLogging>["skillsLogger"];
}): {
  imageGenProvider: ChannelsHandle["imageGenProvider"];
  imageGenRateLimiter: ImageGenRateLimiter | undefined;
  imageGenConfig: ChannelsHandle["imageGenConfig"];
} {
  const { container, skillsLogger } = deps;
  const imageGenConfig = container.config.integrations.media.imageGeneration;
  const imageGenResult = createImageGenProvider(imageGenConfig, container.secretManager);
  const imageGenProvider = imageGenResult.ok ? imageGenResult.value : undefined;
  const imageGenRateLimiter = imageGenProvider
    ? createImageGenRateLimiter({ maxPerHour: imageGenConfig.maxPerHour })
    : undefined;
  if (imageGenProvider) {
    skillsLogger.info({ provider: imageGenConfig.provider }, "Image generation provider initialized");
  } else if (imageGenResult.ok) {
    skillsLogger.debug("Image generation disabled: API key not configured");
  } else {
    skillsLogger.warn(
      { err: imageGenResult.error, hint: "Check image generation config provider value", errorKind: "config" as const },
      "Image generation provider creation failed",
    );
  }
  return { imageGenProvider, imageGenRateLimiter, imageGenConfig };
}
