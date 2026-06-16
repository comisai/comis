// SPDX-License-Identifier: Apache-2.0
/**
 * Channel adapter lifecycle wiring: ChannelManager construction (voice pipeline,
 * command queue, slash-command handler, lifecycle reactors). The registry invokes
 * `buildAndStartChannelManager` after adapters + media pipeline are bootstrapped and
 * receives the manager handle + lifecycle reactors + command queue for ChannelsResult.
 * @module
 */

import { readdir, readFile, stat } from "node:fs/promises";
import type { Attachment, ChannelPort, ChannelPluginPort, DeliveryService, ExecutionPlanPort, NormalizedMessage, SessionKey, ClockPort, TimerPort, ActivityStreamPort, TurnActivityContext } from "@comis/core";
import { formatSessionKey, safePath, systemNowDate, themeForName, chatProjection } from "@comis/core";
import { createPlanStream } from "@comis/observability";
import type { AppContainer } from "@comis/core";
import type { ComisLogger } from "@comis/infra";
import type { AgentExecutor, createSessionLifecycle, ActiveRunRegistry, BackgroundSessionResolver } from "@comis/agent";
import { createCommandHandler, parseSlashCommand, createMessageRouter, createCommandQueue, createActivityTurnCoordinator, type CommandHandlerDeps, type CommandQueue, type ActivityTurnCoordinator, type ActivityBreakerGate } from "@comis/orchestrator";
import { type VoiceResponsePipelineDeps, createLifecycleReactor, reactWithFallback, createTestSink, type LifecycleReactor, type ChannelRegistry } from "@comis/channels";
import { buildReadOnlyChannelRegistry, buildChannelCredentialMap } from "./setup-channels-registry-builder.js";
import { buildActivityRenderers, type ActivityRendererFactory } from "./setup-channels-activity-renderers.js";
import { resolveActivityKillSwitchSlice } from "./activity-kill-switch.js";
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
import type { ExecutionLogEntry } from "@comis/scheduler";

/** Closure-captured deps for building and starting the ChannelManager. */
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
  /** Per-channel plugin map; consumers read `plugin.capabilities` for
   *  features.reactions, replyToMetaKey, etc. */
  channelPlugins: Map<string, ChannelPluginPort>;
  // Composition root → buildActivityRenderers: clock/timer (EditPlace debounce + deliveredAtMs gate); signCallbackData (button channels) + mintApprovalLink (Email single-use link).
  clock: ClockPort;
  timers: TimerPort;
  // Test-only renderer-injection seam (DaemonOverrides.activityRendererFactory).
  // Applied AFTER buildActivityRenderers to swap a channelType's factory for the spy.
  // Optional + default-undefined; production never sets it.
  activityRendererFactory?: (channelType: string) => import("@comis/core").ChannelActivityRenderer | undefined;
  /** The redacted ActivityStream port. Present → coordinatorFactory is
   *  assembled + injected onto createChannelManager (pipeline gate true). Absent →
   *  no inbound coordinatorFactory (gate false, fail-closed §22.2). */
  activityStream?: ActivityStreamPort;
  /** Process-singleton circuit breaker (daemon.ts D2), shared across coordinators. */
  activityBreaker?: ActivityBreakerGate;
  /** SHARED ExecutionPlanHolder (DEFAULT agent) from createAcpWiring().holder — SAME ref as
   *  PiExecutorDeps.executionPlanHolder + AcpServerDeps.executionPlanPort (Pitfall 1: a parallel holder reads empty).
   *  Absent → no chat plan-stream built (frame.planSnapshot undefined; elapsed fallback). */
  executionPlanPort?: ExecutionPlanPort;
  signCallbackData?: import("@comis/channels").SignCallbackData;
  mintApprovalLink?: import("@comis/channels").MintApprovalLink;
  // Server-side interactive-callback router (verifier) — inbound-gate.ts verifies
  // a signed button callback BEFORE slash parsing so the payload never reaches the LLM.
  interactiveCallbackRouter?: import("@comis/orchestrator").InteractiveCallbackRouter;
  preprocessMessageCallback: (msg: NormalizedMessage) => Promise<NormalizedMessage>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- PreflightResult type from channels package is not re-exported; pass-through matches setup-channels-media.ts
  preflightFn?: (msg: NormalizedMessage) => Promise<any>;
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
  /** Complete three-layer forget for slash /new + /reset (live 2026-06-11: runtime-only destroy left LCD context the DAG re-presented). */
  destroyConversation?: (agentId: string, key: SessionKey) => Promise<unknown>;
  costTrackers?: Map<string, {
    getByProvider(): Array<{ provider: string; model: string; totalTokens: number; totalCost: number; callCount: number }>;
    getBySession(key: string): { totalTokens: number; totalCost: number };
  }>;
  cronExecutionTrackers?: Map<string, { record(entry: ExecutionLogEntry): Promise<void> }>;
  /** DI seam for /export-trajectory. Absent → command falls through to generic slash handling. */
  exportSessionBundle?: (sessionId: string) => Promise<{ bundlePath: string }>;
  /** Override for the credential→channelType map. Absent → auto-built from config. */
  channelCredentialMap?: Map<string, string>;
}

/**
 * Outputs of `buildAndStartChannelManager` — returned to the registry caller
 * for inclusion in the final ChannelsResult.
 */
export interface ChannelManagerBuildResult {
  channelManager?: ChannelManager;
  lifecycleReactors: LifecycleReactor[];
  commandQueue?: CommandQueue;
  activityRenderers: Map<string, ActivityRendererFactory>; // per-channelId factory, see buildActivityRenderers
}

/**
 * Construct + start the ChannelManager (voice pipeline + command queue + slash handler +
 * retry engine) and wire lifecycle reactors. Builds the manager when adapters exist OR an
 * ActivityStream is injected (the inbound activity path needs it). The
 * coordinatorFactory is assembled here, where the activityRenderers map is in scope.
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
    channelPlugins,
    preprocessMessageCallback,
    preflightFn,
  } = deps;

  const agents = container.config.agents;
  const routingConfig = container.config.routing;

  const messageRouter = createMessageRouter(routingConfig);
  let channelManager: ChannelManager | undefined;

  let voiceResponsePipeline: VoiceResponsePipelineDeps | undefined;
  if (deps.ttsAdapter) {
    const ttsConfig = container.config.integrations.media.tts;

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
        provider: ttsConfig.provider, // OBS-01 §2.7 voice-identity (INFO line)
        keyless: ttsConfig.provider === "edge" || ttsConfig.provider === "local", // edge/local ⇒ $0
        ...(ttsConfig.model !== undefined ? { model: ttsConfig.model } : {}),
      },
      logger: channelsLogger,
    };
    channelsLogger.debug({ autoMode: ttsConfig.autoMode, providerFormatKey, provider: ttsConfig.provider }, "Voice response pipeline wired");
  }

  let commandQueue: CommandQueue | undefined;
  if (deps.queueConfig?.enabled) {
    commandQueue = createCommandQueue({
      eventBus: container.eventBus,
      config: deps.queueConfig,
      logger: channelsLogger,
    });
    channelsLogger.info({ mode: deps.queueConfig.defaultMode }, "Command queue enabled");
  }

  const lifecycleReactionsConfig = container.config.lifecycleReactions;
  const lifecycleEnabled = lifecycleReactionsConfig.enabled;
  const lifecycleReactors: LifecycleReactor[] = [];

  // Build the activity renderer map BEFORE the manager so the
  // coordinatorFactory can close over it (markers from the default agent activity.theme).
  const activityMarkers = themeForName(agents[defaultAgentId]?.activity?.theme ?? "default").markers;
  const activityRenderers = buildActivityRenderers(adaptersByType, channelPlugins, channelsLogger, { timer: deps.timers, clock: deps.clock, signCallbackData: deps.signCallbackData, mintApprovalLink: deps.mintApprovalLink, markers: activityMarkers });
  // The SOLE renderer-injection point is the per-turn `deps.activityRendererFactory?.(ctx.channelType)`
  // fallback in the coordinatorFactory below — fires for any channelType the live map does not serve (test-only seam).
  // The per-turn coordinatorFactory the inbound pipeline gate (execution-pipeline.ts:395) needs — over
  // renderers + redacted ActivityStream + breaker + live kill-switch. Built ONLY when stream is injected (absent → gate
  // false, fail-closed §22.2). Closure lives in the daemon (root importing @comis/orchestrator + observability — Pitfall 1).
  const activityStream = deps.activityStream;
  // Build the SEP plan-stream ONCE outside the per-turn closure. SHARED across turns;
  // per-turn (agentId, sessionKey) filter inside the coordinator prevents cross-turn snapshot leaks.
  const planStream = deps.executionPlanPort !== undefined
    ? createPlanStream({ eventBus: container.eventBus, executionPlanPort: deps.executionPlanPort, logger: channelsLogger })
    : undefined;
  const coordinatorFactory = activityStream
    ? (ctx: TurnActivityContext): ActivityTurnCoordinator => {
        // D1: renderer from live map; unmapped channelType consults the injection seam then falls back to createTestSink().
        // Resolve theme markers PER-TURN from THIS agent's activity.theme (not the default agent's, baked
        // once at boot); verbosity is already per-agent (config below); markers now match.
        const turnMarkers = themeForName(agents[ctx.agentId]?.activity?.theme ?? "default").markers;
        const make = activityRenderers.get(ctx.channelType);
        const renderer = make?.(ctx.channelKey, turnMarkers) ?? deps.activityRendererFactory?.(ctx.channelType) ?? createTestSink();
        return createActivityTurnCoordinator({
          activityStreamPort: activityStream,
          renderer,
          projection: chatProjection,
          timer: deps.timers,
          clock: deps.clock,
          logger: channelsLogger,
          config: { verbosity: agents[ctx.agentId]?.activity?.verbosity ?? "normal" },
          // Live getter RE-READS config FRESH per flushApply — never capture an `agentActivity` const (per-agent
          // object is REPLACED wholesale on hot-reload, setup-agents-runtime.ts:99). Fail-CLOSED resolver, never
          // returns undefined (see module).
          killSwitch: () => resolveActivityKillSwitchSlice(agents, ctx.agentId),
          breaker: deps.activityBreaker, // process-singleton (shared across coordinators)
          planStream, // shared SEP plan-stream (built ONCE outside the closure)
        });
      }
    : undefined;

  if (adaptersByType.size > 0 || activityStream) {
    // Create retry engine for resilient message delivery (rate limit retry + HTML parse fallback)
    const retryConfig = RetryConfigSchema.parse({});
    const retryEngine = createRetryEngine(retryConfig, container.eventBus, channelsLogger);

    // Read-only ChannelRegistry over channelPlugins (lifecycle owned by setup-channels-adapters).
    const channelRegistry: ChannelRegistry = buildReadOnlyChannelRegistry(channelPlugins);
    // credential→channelType map; auto-built from enabled channels or overridden by caller.
    const channelCredentialMap = deps.channelCredentialMap ?? buildChannelCredentialMap(container.config.channels);
    channelManager = createChannelManager({
      eventBus: container.eventBus,
      messageRouter,
      commandQueue,
      sessionManager,
      retryEngine,
      deliveryQueue: deps.deliveryQueue,
      deliveryService,
      channelRegistry,
      // Required: orchestrator inbound entrypoint (channels avoids a back-edge import).
      processInboundMessage,
      createExecutor: (agentId: string) => executors.get(agentId) ?? executors.get(defaultAgentId),
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
      // The redacted stream port + per-turn coordinatorFactory (gate at :395).
      activityStreamPort: deps.activityStream,
      coordinatorFactory,
      // Live boot adapter registry — injectMessage falls back to it for post-startAll adapters.
      adapterRegistry: adaptersByType,
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

      // Static refusals — channel-originated /config is never admin-trusted
      // (admin is CLI/gateway-only). Body returns only string literals, so the old
      // try/catch was dead and the old `deps.rpcCall ?` gate was misleading (rpcCall
      // unused, yet its absence dropped /config to `undefined`). Always defined now.
      handleConfigCommand: async (args: string[], _channelType: string) => {
        const subcommand = args[0] ?? "show";
        if (subcommand === "show" || subcommand === "history") {
          return "Config read requires admin trust. Use the CLI or gateway client with admin scope.";
        }
        if (subcommand === "set") {
          return "Config modification requires admin trust. Use the CLI or gateway client with admin scope.";
        }
        return `Unknown config subcommand: ${subcommand}. Available: show, set, history`;
      },
      onMessageReceived: deps.onMessageReceived,
      onMessageProcessed: deps.onMessageProcessed,
      // Graph report button callback intercept: deliver full report as .md file attachment
      onGraphReportRequest: async (graphId, _channelType, channelId, adapter, threadId) => {
        const dataDir = container.config.dataDir || ".";
        try {
          if (!/^[a-f0-9-]{8,64}$/i.test(graphId)) {
            channelsLogger.warn({ graphId, hint: "Invalid graphId format in report request", errorKind: "validation" as const }, "Graph report request rejected");
            return;
          }

          let graphDir: string;
          // Two-step safePath (throws on traversal; the catch emits one operator WARN).
          try {
            const graphRunsDir = safePath(dataDir, "graph-runs");
            graphDir = safePath(graphRunsDir, graphId);
          } catch {
            channelsLogger.warn({ graphId, hint: "Path traversal attempt in graphId", errorKind: "validation" as const }, "Graph report request rejected");
            return;
          }

          try {
            await stat(graphDir);
          } catch {
            channelsLogger.warn({ graphId, graphDir, hint: "Graph run directory not found", errorKind: "validation" as const }, "Graph report directory missing");
            await adapter.sendMessage(channelId, "Report not available — graph run data not found.", threadId ? { extra: { threadId } } : undefined);
            return;
          }

          const files = await readdir(graphDir);
          const outputFiles = files.filter((f) => f.endsWith("-output.md"));

          if (outputFiles.length === 0) {
            await adapter.sendMessage(channelId, "Report not available — no output files found.", threadId ? { extra: { threadId } } : undefined);
            return;
          }

          let leafOutputFile: string | undefined;
          try {
            const metadataRaw = await readFile(safePath(graphDir, "_run-metadata.json"), "utf8");
            const metadata = JSON.parse(metadataRaw) as {
              nodes: Record<string, { status: string }>;
            };
            const completedNodes = Object.entries(metadata.nodes)
              .filter(([, v]) => v.status === "completed")
              .map(([k]) => k);

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

          // sendAttachment is optional on ChannelPort; attachment-less platforms (IRC)
          // omit it — degrade to a text message referencing the caption.
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
      approvalGate: deps.approvalGate,
      // Signed button-callback verifier (inbound-gate.ts), via pipelineDeps = deps.
      interactiveCallbackRouter: deps.interactiveCallbackRouter,
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
            // Complete three-layer forget when wired (live 2026-06-11); legacy runtime-only destroy otherwise.
            const adapter = deps.piSessionAdapters?.get(agentId);
            if (deps.destroyConversation) {
              // eslint-disable-next-line no-restricted-syntax -- intentional fire-and-forget
              deps.destroyConversation(agentId, key).catch(() => { /* fire-and-forget */ });
            } else if (adapter) {
              // eslint-disable-next-line no-restricted-syntax -- intentional fire-and-forget
              adapter.destroySession(key).catch(() => { /* fire-and-forget */ });
            } else {
              sessionManager.expire(key);
            }
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

        // /new and /reset use the command handler's static response (LLM greeting
        // generation is gateway-only; channels use the plain "New session created." text).
        return {
          handled: result.handled,
          response: result.response,
          directives: result.directives as Record<string, unknown> | undefined,
          cleanedText: parsed.cleanedText,
        };
      },
      lifecycleReactionsEnabled: lifecycleEnabled,
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
      exportSessionBundle: deps.exportSessionBundle,
      channelCredentialMap, // activates targeted adapter reconnect on rotation
    });

    await channelManager.startAll();
    channelsLogger.info({ activeCount: channelManager.activeCount }, "ChannelManager started");

    // Lifecycle reactors: one per eligible adapter, gated on global enabled +
    // per-channel features.reactions + per-channel perChannel[type].enabled.
    if (lifecycleEnabled) {
      for (const [channelType, adapter] of adaptersByType) {
        const plugin = channelPlugins.get(channelType);
        const caps = plugin?.capabilities;
        if (!caps?.features.reactions) {
          channelsLogger.debug({ channelType }, "Lifecycle reactor skipped: reactions not supported");
          continue;
        }

        const perChannelConfig = lifecycleReactionsConfig.perChannel[channelType];
        if (perChannelConfig?.enabled === false) {
          channelsLogger.debug({ channelType }, "Lifecycle reactor skipped: per-channel disabled");
          continue;
        }

        // replyToMetaKey lets the reactor map the inbound platform id to a reply target;
        // skip channels whose plugin declares none (e.g. echo — defensive).
        if (!caps.replyToMetaKey) {
          channelsLogger.debug({ channelType }, "Lifecycle reactor skipped: replyToMetaKey not declared in plugin capabilities");
          continue;
        }

        const reactor = createLifecycleReactor({
          eventBus: container.eventBus,
          adapter,
          channelType,
          replyToMetaKey: caps.replyToMetaKey,
          config: lifecycleReactionsConfig,
          logger: channelsLogger,
          reactWithFallback: channelType === "telegram" ? reactWithFallback : undefined,
        });

        lifecycleReactors.push(reactor);
        channelsLogger.debug({ channelType }, "Lifecycle reactor created");
      }

      if (lifecycleReactors.length > 0) channelsLogger.info({ reactorCount: lifecycleReactors.length }, "Lifecycle reactors initialized");
    }
  }

  // activityRenderers + coordinatorFactory built BEFORE the manager (above); map returned for the registry's ChannelsResult activity-counters scrape.
  return { channelManager, lifecycleReactors, commandQueue, activityRenderers };
}
// Re-export Attachment + ChannelPluginPort (silences lint; public-surface boundary).
export type { Attachment, ChannelPluginPort };
