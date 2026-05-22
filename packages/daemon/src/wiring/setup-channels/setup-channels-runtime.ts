// SPDX-License-Identifier: Apache-2.0
/**
 * Channel adapter lifecycle wiring. Hosts the ChannelManager construction
 * (with voice response pipeline, command queue, slash-command handler,
 * lifecycle reactors, approval notifier).
 *
 * The registry orchestrator invokes `buildAndStartChannelManager` after the
 * adapters and media pipeline have been bootstrapped; this helper returns
 * the manager handle + lifecycle reactors + approval notifier + command
 * queue so the registry can assemble the final ChannelsResult.
 *
 * @module
 */

import { readdir, readFile, stat } from "node:fs/promises";
import type { Attachment, ChannelPort, ChannelPluginPort, DeliveryService, NormalizedMessage, SessionKey } from "@comis/core";
import { formatSessionKey, safePath, systemNowDate } from "@comis/core";
import type { AppContainer } from "@comis/core";
import type { ComisLogger } from "@comis/infra";
import type { AgentExecutor, createSessionLifecycle, ActiveRunRegistry, BackgroundSessionResolver } from "@comis/agent";
import { createCommandHandler, parseSlashCommand, createMessageRouter, createCommandQueue, type CommandHandlerDeps, type CommandQueue } from "@comis/orchestrator";
import {
  createApprovalNotifier,
  type VoiceResponsePipelineDeps,
  type ApprovalNotifier,
  createLifecycleReactor,
  reactWithFallback,
  type LifecycleReactor,
} from "@comis/channels";
import { createChannelManager, processInboundMessage, type ChannelManager } from "@comis/orchestrator";
import { RetryConfigSchema, createRetryEngine } from "@comis/core";
import {
  shouldAutoTts,
  resolveOutputFormat,
  parseOutboundMedia,
  type SsrfGuardedFetcher,
  type LinkRunner,
  type AudioConverter,
  type MediaTempManager,
  type MediaSemaphore,
} from "@comis/skills";
import type { RpcCall } from "@comis/skills/platform-tools";
import type { TTSPort, QueueConfig } from "@comis/core";
import type { ChannelCapabilityInfo } from "../setup-channels-adapters.js";
import type { ExecutionLogEntry } from "@comis/scheduler";

/**
 * Closure-captured deps for building and starting the ChannelManager.
 */
// @optional-field-count: Inherits the optional-field surface of ChannelsDeps (allowlisted at optionalFieldAllowlist for setup-channels-registry.ts/ChannelsDeps, optionalCount: 26). The runtime leaf passes through the ChannelsDeps optionals (ttsAdapter, audioConverter, queueConfig, etc.) unchanged; tightening these to required would force the registry caller (and every downstream consumer of ChannelsDeps) to fabricate stub values at every call site. The split mirrors the ChannelsDeps optional surface so the rebuild matches the pre-split call shape byte-for-byte.
export interface ChannelManagerBuildDeps {
  container: AppContainer;
  executors: Map<string, AgentExecutor>;
  defaultAgentId: string;
  sessionManager: ReturnType<typeof createSessionLifecycle>;
  channelsLogger: ComisLogger;
  ssrfFetcher: SsrfGuardedFetcher;
  linkRunner: LinkRunner;
  deliveryService: DeliveryService;
  adaptersByType: Map<string, ChannelPort>;
  channelCapabilities: Map<string, ChannelCapabilityInfo>;
  preprocessMessageCallback: (msg: NormalizedMessage) => Promise<NormalizedMessage>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- PreflightResult type from channels package is not re-exported; pass-through matches setup-channels-media.ts
  preflightFn?: (msg: NormalizedMessage) => Promise<any>;
  // Optional deps drawn from ChannelsDeps:
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- AgentTool generic requires complex type parameters from pi-ai SDK
  assembleToolsForAgent?: (agentId: string, options?: { sessionKey?: SessionKey }) => Promise<any[]>;
  ttsAdapter?: TTSPort;
  audioConverter?: AudioConverter;
  mediaTempManager?: MediaTempManager;
  mediaSemaphore?: MediaSemaphore;
  queueConfig?: QueueConfig;
  deliveryQueue?: import("@comis/core").DeliveryQueuePort;
  activeRunRegistry?: ActiveRunRegistry;
  sessionResolver?: BackgroundSessionResolver;
  rpcCall?: RpcCall;
  onMessageReceived?: (msg: NormalizedMessage, channelType: string) => void;
  onMessageProcessed?: (msg: NormalizedMessage, channelType: string) => void;
  approvalGate?: import("@comis/core").ApprovalGate;
  piSessionAdapters?: Map<string, {
    getSessionStats(key: SessionKey): { messageCount: number; createdAt?: number; tokens?: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number }; userMessages?: number; assistantMessages?: number; toolCalls?: number; toolResults?: number; cost?: number } | undefined;
    destroySession(key: SessionKey): Promise<void>;
  }>;
  costTrackers?: Map<string, {
    getByProvider(): Array<{ provider: string; model: string; totalTokens: number; totalCost: number; callCount: number }>;
    getBySession(key: string): { totalTokens: number; totalCost: number };
  }>;
  cronExecutionTrackers?: Map<string, { record(entry: ExecutionLogEntry): Promise<void> }>;
}

/**
 * Outputs of `buildAndStartChannelManager` — returned to the registry caller
 * for inclusion in the final ChannelsResult.
 */
export interface ChannelManagerBuildResult {
  channelManager?: ChannelManager;
  lifecycleReactors: LifecycleReactor[];
  approvalNotifier?: ApprovalNotifier;
  commandQueue?: CommandQueue;
}

/**
 * Construct and start the ChannelManager (voice response pipeline +
 * command queue + slash-command handler + retry engine), then wire the
 * lifecycle reactors and approval notifier for each registered adapter.
 *
 * Returns the four handles the registry needs to assemble ChannelsResult.
 * No-op when `adaptersByType.size === 0`.
 */
export async function buildAndStartChannelManager(
  deps: ChannelManagerBuildDeps,
): Promise<ChannelManagerBuildResult> {
  const {
    container,
    executors,
    defaultAgentId,
    sessionManager,
    channelsLogger,
    ssrfFetcher,
    deliveryService,
    adaptersByType,
    channelCapabilities,
    preprocessMessageCallback,
    preflightFn,
  } = deps;

  const agents = container.config.agents;
  const routingConfig = container.config.routing;

  const messageRouter = createMessageRouter(routingConfig);
  let channelManager: ChannelManager | undefined;

  // Build voice response pipeline deps
  let voiceResponsePipeline: VoiceResponsePipelineDeps | undefined;
  if (deps.ttsAdapter) {
    const ttsConfig = container.config.integrations.media.tts;

    // Derive providerFormatKey from the configured TTS provider.
    // This tells the pipeline which field of ResolvedOutputFormat to pass to synthesize().
    // - "openai" -> "opus" (OpenAI understands "opus", "mp3", etc.)
    // - "elevenlabs" -> "opus_48000_64" (ElevenLabs needs underscore-delimited format)
    // - "edge" -> SSML format string
    const providerFormatKey: "openai" | "elevenlabs" | "edge" =
      ttsConfig.provider === "elevenlabs" ? "elevenlabs"
      : ttsConfig.provider === "edge" ? "edge"
      : "openai";

    voiceResponsePipeline = {
      ttsAdapter: deps.ttsAdapter,
      audioConverter: deps.audioConverter,
      mediaTempManager: deps.mediaTempManager
        ? { getManagedDir: () => deps.mediaTempManager!.getManagedDir() }
        : { getManagedDir: () => undefined },
      mediaSemaphore: deps.mediaSemaphore
        ? { run: <T>(fn: () => Promise<T>) => deps.mediaSemaphore!.run(fn) }
        : { run: async <T>(fn: () => Promise<T>) => fn() },
      shouldAutoTts,
      resolveOutputFormat: resolveOutputFormat as VoiceResponsePipelineDeps["resolveOutputFormat"],
      ttsConfig: {
        autoMode: ttsConfig.autoMode,
        tagPattern: ttsConfig.tagPattern,
        voice: ttsConfig.voice,
        maxTextLength: ttsConfig.maxTextLength,
        outputFormats: ttsConfig.outputFormats,
        providerFormatKey,
      },
      logger: channelsLogger,
    };
    channelsLogger.debug({ autoMode: ttsConfig.autoMode, providerFormatKey }, "Voice response pipeline wired");
  }

  // Create command queue when enabled in config
  let commandQueue: CommandQueue | undefined;
  if (deps.queueConfig?.enabled) {
    commandQueue = createCommandQueue({
      eventBus: container.eventBus,
      config: deps.queueConfig,
      logger: channelsLogger,
    });
    channelsLogger.info({ mode: deps.queueConfig.defaultMode }, "Command queue enabled");
  }

  // Lifecycle reactions config
  const lifecycleReactionsConfig = container.config.lifecycleReactions;
  const lifecycleEnabled = lifecycleReactionsConfig.enabled;
  const lifecycleReactors: LifecycleReactor[] = [];

  if (adaptersByType.size > 0) {
    // Create retry engine for resilient message delivery (rate limit retry + HTML parse fallback)
    const retryConfig = RetryConfigSchema.parse({});
    const retryEngine = createRetryEngine(retryConfig, container.eventBus, channelsLogger);

    channelManager = createChannelManager({
      eventBus: container.eventBus,
      messageRouter,
      commandQueue,
      sessionManager,
      retryEngine,
      deliveryQueue: deps.deliveryQueue,
      deliveryService,
      // Required dep — orchestrator-side inbound pipeline entrypoint.
      // Routed through ChannelManagerDeps so channels does not create a
      // back-edge import of @comis/orchestrator.
      processInboundMessage,
      createExecutor: (agentId: string) => executors.get(agentId) ?? executors.get(defaultAgentId),
      adapters: Array.from(adaptersByType.values()),
      logger: channelsLogger,
      preprocessMessage: preprocessMessageCallback,
      audioPreflight: preflightFn,
      streamingConfig: container.config.streaming,
      autoReplyEngineConfig: container.config.autoReplyEngine,
      sendPolicyConfig: container.config.sendPolicy,
      getResetTriggers: (agentId: string) => {
        const agentConfig = agents[agentId];
        return agentConfig?.session?.resetPolicy?.resetTriggers ?? [];
      },
      assembleToolsForAgent: deps.assembleToolsForAgent,
      voiceResponsePipeline,
      parseOutboundMedia,
      activeRunRegistry: deps.activeRunRegistry,
      sessionResolver: deps.sessionResolver,
      queueConfig: deps.queueConfig,
      getElevatedReplyConfig: (agentId: string) => {
        const agentConfig = agents[agentId];
        return agentConfig?.elevatedReply;
      },
      getEnforceFinalTag: (agentId: string) => {
        const agentConfig = agents[agentId];
        return agentConfig?.enforceFinalTag;
      },
      getAllowFrom: (channelType: string) => {
        const cfg = container.config.channels?.[channelType as keyof typeof container.config.channels];
        if (!cfg || typeof cfg !== "object" || !("allowFrom" in cfg)) return [];
        return (cfg as { allowFrom: string[] }).allowFrom ?? [];
      },
      outboundMediaFetch: async (url: string) => {
        const result = await ssrfFetcher.fetch(url);
        if (!result.ok) return { ok: false as const, error: result.error };
        return { ok: true as const, value: { buffer: result.value.buffer, mimeType: result.value.mimeType } };
      },
      // /config chat command handling via RPC dispatch

      handleConfigCommand: deps.rpcCall ? async (args: string[], _channelType: string) => {
        const subcommand = args[0] ?? "show";
        try {
          if (subcommand === "show" || subcommand === "history") {
            // Channel-originated messages always have user trust
            return "Config read requires admin trust. Use the CLI or gateway client with admin scope.";
          }
          if (subcommand === "set") {
            // Channel-originated messages always have user trust
            return "Config modification requires admin trust. Use the CLI or gateway client with admin scope.";
          }
          return `Unknown config subcommand: ${subcommand}. Available: show, set, history`;
        } catch (err) {
          return `Config command failed: ${err instanceof Error ? err.message : String(err)}`;
        }
      } : undefined,
      onMessageReceived: deps.onMessageReceived,
      onMessageProcessed: deps.onMessageProcessed,
      // Graph report button callback intercept: deliver full report as .md file attachment
      onGraphReportRequest: async (graphId, _channelType, channelId, adapter, threadId) => {
        const dataDir = container.config.dataDir || ".";
        try {
          // Validate graphId format (alphanumeric + hyphens, UUID-like)
          if (!/^[a-f0-9-]{8,64}$/i.test(graphId)) {
            channelsLogger.warn({ graphId, hint: "Invalid graphId format in report request", errorKind: "validation" as const }, "Graph report request rejected");
            return;
          }

          let graphDir: string;
          // Two-step safePath composition matches the canonical daemon-wiring
          // pattern in setup-output-retention.ts. Both safePath calls throw on
          // traversal; the surrounding catch handles either failure with a
          // single operator-facing WARN.
          try {
            const graphRunsDir = safePath(dataDir, "graph-runs");
            graphDir = safePath(graphRunsDir, graphId);
          } catch {
            channelsLogger.warn({ graphId, hint: "Path traversal attempt in graphId", errorKind: "validation" as const }, "Graph report request rejected");
            return;
          }

          // Check directory exists
          try {
            await stat(graphDir);
          } catch {
            channelsLogger.warn({ graphId, graphDir, hint: "Graph run directory not found", errorKind: "validation" as const }, "Graph report directory missing");
            await adapter.sendMessage(channelId, "Report not available — graph run data not found.", threadId ? { extra: { threadId } } : undefined);
            return;
          }

          // Find the leaf output file
          const files = await readdir(graphDir);
          const outputFiles = files.filter((f) => f.endsWith("-output.md"));

          if (outputFiles.length === 0) {
            await adapter.sendMessage(channelId, "Report not available — no output files found.", threadId ? { extra: { threadId } } : undefined);
            return;
          }

          // Try to identify leaf nodes from metadata
          let leafOutputFile: string | undefined;
          try {
            const metadataRaw = await readFile(safePath(graphDir, "_run-metadata.json"), "utf8");
            const metadata = JSON.parse(metadataRaw) as {
              nodes: Record<string, { status: string }>;
            };
            const completedNodes = Object.entries(metadata.nodes)
              .filter(([, v]) => v.status === "completed")
              .map(([k]) => k);

            // Match output files to completed nodes, pick largest
            let maxSize = 0;
            for (const f of outputFiles) {
              const nodeId = f.replace(/-output\.md$/, "");
              if (completedNodes.includes(nodeId)) {
                const fileStat = await stat(safePath(graphDir, f));
                if (fileStat.size > maxSize) {
                  maxSize = fileStat.size;
                  leafOutputFile = f;
                }
              }
            }
          } catch {
            // Metadata read failed -- fall back to largest output file
          }

          if (!leafOutputFile) {
            // Fallback: pick largest output file
            let maxSize = 0;
            for (const f of outputFiles) {
              const fileStat = await stat(safePath(graphDir, f));
              if (fileStat.size > maxSize) {
                maxSize = fileStat.size;
                leafOutputFile = f;
              }
            }
          }

          if (!leafOutputFile) {
            await adapter.sendMessage(channelId, "Report not available — could not identify output file.", threadId ? { extra: { threadId } } : undefined);
            return;
          }

          const filePath = safePath(graphDir, leafOutputFile);
          const nodeId = leafOutputFile.replace(/-output\.md$/, "");
          const caption = `Full report — ${nodeId} (graph ${graphId.slice(0, 8)})`;

          // PORT-TRIM-14: sendAttachment is now optional on ChannelPort. Adapters
          // whose platform lacks attachments (e.g. IRC) omit the method; degrade
          // gracefully by sending a text message that references the caption.
          if (typeof adapter.sendAttachment !== "function") {
            await adapter.sendMessage(
              channelId,
              `${caption}\n(attachment not supported on this channel — full report at ${filePath})`,
              threadId ? { extra: { threadId } } : undefined,
            );
            channelsLogger.debug(
              { graphId, nodeId, channelId, hint: "channel lacks sendAttachment; sent caption + path text" },
              "Graph report delivered as text (no attachment capability)",
            );
            return;
          }

          await adapter.sendAttachment(channelId, {
            type: "file",
            url: filePath,
            fileName: `report-${graphId.slice(0, 8)}.md`,
            mimeType: "text/markdown",
            caption,
          }, threadId ? { extra: { threadId } } : undefined);

          channelsLogger.debug({ graphId, nodeId, channelId }, "Graph report delivered as file attachment");
        } catch (err: unknown) {
          channelsLogger.warn(
            { graphId, err, hint: "Failed to deliver graph report file", errorKind: "internal" as const },
            "Graph report delivery failed",
          );
        }
      },
      // /approve and /deny chat command interception
      approvalGate: deps.approvalGate,
      // General slash command handling via createCommandHandler
      handleSlashCommand: async (text: string, sessionKey: SessionKey, agentId: string) => {
        const parsed = parseSlashCommand(text);

        // /config and /stop are handled by dedicated inbound pipeline blocks
        if (parsed.command === "config" || parsed.command === "stop") return undefined;

        const execAgentConfig = agents[agentId] ?? agents[defaultAgentId];

        const cmdDeps: CommandHandlerDeps = {
          getSessionInfo: (key) => {
            const adapter = deps.piSessionAdapters?.get(agentId);
            if (adapter) {
              const stats = adapter.getSessionStats(key);
              return {
                messageCount: stats?.messageCount ?? 0,
                createdAt: stats?.createdAt,
                tokensUsed: stats?.tokens,
              };
            }
            return { messageCount: 0 };
          },
          getAgentConfig: () => ({
            name: execAgentConfig?.name ?? "Unknown",
            model: execAgentConfig?.model ?? "unknown",
            provider: execAgentConfig?.provider ?? "unknown",
            maxSteps: execAgentConfig?.maxSteps ?? 10,
          }),
          destroySession: (key) => {
            const adapter = deps.piSessionAdapters?.get(agentId);
            if (adapter) {
              // eslint-disable-next-line no-restricted-syntax -- intentional fire-and-forget
              adapter.destroySession(key).catch(() => { /* fire-and-forget session destroy */ });
              container.eventBus.emit("session:expired", { sessionKey: key, reason: "chat-reset" });
              return;
            }
            // Fallback: expire via session manager
            sessionManager.expire(key);
            container.eventBus.emit("session:expired", { sessionKey: key, reason: "chat-reset" });
          },
          getAvailableModels: () => [],
          getUsageBreakdown: () => {
            const tracker = deps.costTrackers?.get(agentId) ?? deps.costTrackers?.get(defaultAgentId);
            return tracker?.getByProvider() ?? [];
          },
          getSessionCost: (key) => {
            const tracker = deps.costTrackers?.get(agentId) ?? deps.costTrackers?.get(defaultAgentId);
            return tracker?.getBySession(formatSessionKey(key)) ?? { totalTokens: 0, totalCost: 0 };
          },
          getSDKSessionStats: (key) => {
            const adapter = deps.piSessionAdapters?.get(agentId);
            if (!adapter) return undefined;
            const stats = adapter.getSessionStats(key);
            if (!stats) return undefined;
            return {
              userMessages: stats.userMessages ?? 0,
              assistantMessages: stats.assistantMessages ?? 0,
              toolCalls: stats.toolCalls ?? 0,
              toolResults: stats.toolResults ?? 0,
              totalMessages: stats.messageCount,
              tokens: {
                input: stats.tokens?.input ?? 0,
                output: stats.tokens?.output ?? 0,
                cacheRead: stats.tokens?.cacheRead ?? 0,
                cacheWrite: stats.tokens?.cacheWrite ?? 0,
                total: stats.tokens?.total ?? 0,
              },
              cost: stats.cost ?? 0,
            };
          },
          getContextUsage: () => undefined,
          getBudgetInfo: () => undefined,
        };

        const handler = createCommandHandler(cmdDeps);
        const result = handler.handle(parsed, sessionKey);

        // For /new and /reset, the static response from command handler is used.
        // Greeting generation (LLM-powered) is available in the gateway; channels
        // use the simpler "New session created." / "Session reset." responses.

        return {
          handled: result.handled,
          response: result.response,
          directives: result.directives as Record<string, unknown> | undefined,
          cleanedText: parsed.cleanedText,
        };
      },
      // Lifecycle reactions: skip ack reaction when lifecycle reactor handles queued/thinking
      lifecycleReactionsEnabled: lifecycleEnabled,
      // Response prefix template engine
      responsePrefixConfig: container.config.responsePrefix,
      buildTemplateContext: (agentId: string, channelType: string, msg: NormalizedMessage) => {
        const agentConfig = agents[agentId] ?? agents[defaultAgentId];
        const modelsConfig = container.config.models;
        const resolvedModel = agentConfig?.model === "default"
          ? modelsConfig?.defaultModel ?? ""
          : agentConfig?.model ?? "";
        const resolvedProvider = agentConfig?.provider === "default"
          ? modelsConfig?.defaultProvider ?? ""
          : agentConfig?.provider ?? "";
        const now = systemNowDate();
        return {
          agent: agentConfig?.name ?? agentId,
          "agent.emoji": "",
          "identity.name": agentConfig?.name ?? agentId,
          model: resolvedModel,
          "model.full": `${resolvedProvider}/${resolvedModel}`,
          provider: resolvedProvider,
          thinking: agentConfig?.thinkingLevel ?? "",
          channel: channelType,
          "chat.type": (msg.metadata?.telegramChatType as string) ?? "",
          time: now.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false }),
          date: now.toISOString().slice(0, 10),
          uptime: `${Math.floor(process.uptime() / 60)}m`,
        };
      },
    });

    await channelManager.startAll();
    channelsLogger.info({ activeCount: channelManager.activeCount }, "ChannelManager started");

    // -----------------------------------------------------------------------
    // Lifecycle reactors
    // Create one reactor per eligible adapter. Gated on:
    // 1. Global lifecycleReactions.enabled
    // 2. Per-channel capabilities (features.reactions must be true)
    // 3. Per-channel override (lifecycleReactions.perChannel[type]?.enabled)
    // -----------------------------------------------------------------------
    if (lifecycleEnabled) {
      for (const [channelType, adapter] of adaptersByType) {
        const caps = channelCapabilities.get(channelType);
        if (!caps?.supportsReactions) {
          channelsLogger.debug({ channelType }, "Lifecycle reactor skipped: reactions not supported");
          continue;
        }

        // Check per-channel override
        const perChannelConfig = lifecycleReactionsConfig.perChannel[channelType];
        if (perChannelConfig?.enabled === false) {
          channelsLogger.debug({ channelType }, "Lifecycle reactor skipped: per-channel disabled");
          continue;
        }

        const reactor = createLifecycleReactor({
          eventBus: container.eventBus,
          adapter,
          channelType,
          replyToMetaKey: caps.replyToMetaKey,
          config: lifecycleReactionsConfig,
          logger: channelsLogger,
          // Telegram-specific emoji fallback for REACTION_INVALID errors
          reactWithFallback: channelType === "telegram" ? reactWithFallback : undefined,
        });

        lifecycleReactors.push(reactor);
        channelsLogger.debug({ channelType }, "Lifecycle reactor created");
      }

      if (lifecycleReactors.length > 0) {
        channelsLogger.info(
          { reactorCount: lifecycleReactors.length },
          "Lifecycle reactors initialized",
        );
      }
    }
  }

  // -----------------------------------------------------------------------
  // Approval notifier: forward approval:requested to chat channel
  // -----------------------------------------------------------------------
  let approvalNotifier: ApprovalNotifier | undefined;
  if (adaptersByType.size > 0) {
    approvalNotifier = createApprovalNotifier({
      eventBus: container.eventBus,
      getAdapter: (channelType) => adaptersByType.get(channelType),
      logger: channelsLogger,
      deliveryService,
    });
    approvalNotifier.start();
    channelsLogger.debug("Approval notifier started");

    // CRIT-03: eventBus.on("system:shutdown", () => approvalNotifier?.stop())
    // subscriber deleted. The notifier handle is already in the return shape;
    // the composition root invokes its .stop() directly via
    // ShutdownDeps.approvalNotifierStop.
  }

  return { channelManager, lifecycleReactors, approvalNotifier, commandQueue };
}

// Re-export the unused Attachment + ChannelPluginPort types to silence lint
// and document the public-surface boundary: the registry consumes the same
// node:fs/promises + core types here when assembling ChannelsResult.
export type { Attachment, ChannelPluginPort };
