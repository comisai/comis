// SPDX-License-Identifier: Apache-2.0
/**
 * Channel setup orchestrator: bootstraps adapters (via setup-channels-adapters),
 * assembles media pipeline (via setup-channels-media), wires cron delivery
 * listener, voice response pipeline, and creates the ChannelManager.
 * Decomposed from a single 910-line file into three focused modules:
 * - setup-channels.ts (this file) -- orchestration (~300L)
 * - setup-channels-adapters.ts -- per-platform adapter bootstrap (~200L)
 * - setup-channels-media.ts -- media pipeline assembly (~300L)
 * @module
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { AppContainer, Attachment, ChannelPort, ChannelPluginPort, NormalizedMessage, SessionKey, TranscriptionPort, TTSPort, ImageAnalysisPort, FileExtractionPort, FileExtractionConfig, MemoryPort, QueueConfig } from "@comis/core";
import { formatSessionKey, runWithContext, createDeliveryOrigin, safePath } from "@comis/core";
import type { ComisLogger } from "@comis/infra";
import type { AgentExecutor, createSessionLifecycle, ActiveRunRegistry, CommandHandlerDeps } from "@comis/agent";
import type { createSessionStore } from "@comis/memory";
import { createMessageRouter, createCommandQueue, createCommandHandler, parseSlashCommand, sanitizeAssistantResponse, resolveOperationModel, resolveProviderFamily, runMemoryReview, type CommandQueue } from "@comis/agent";
import {
  createChannelManager,
  createRetryEngine,
  createApprovalNotifier,
  deliverToChannel,
  filterResponse,
  type ChannelManager,
  type VoiceResponsePipelineDeps,
  type ApprovalNotifier,
} from "@comis/channels";
import { RetryConfigSchema } from "@comis/core";
import type { MediaResolverPort } from "@comis/core";
import {
  shouldAutoTts,
  resolveOutputFormat,
  parseOutboundMedia,
  applyToolPolicy,
  type SsrfGuardedFetcher,
} from "@comis/skills";
import type { RpcCall } from "@comis/skills";
import type { LinkRunner, AudioConverter, MediaTempManager, MediaSemaphore } from "@comis/skills";
import type { ExecutionLogEntry } from "@comis/scheduler";
import { bootstrapAdapters } from "./setup-channels-adapters.js";
import { buildMediaPipeline } from "./setup-channels-media.js";
import type { LifecycleReactor } from "@comis/channels";
import { createLifecycleReactor, reactWithFallback, initTelegramFileGuardConfig } from "@comis/channels";

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

/** All services produced by the channel bootstrap phase. */
export interface ChannelsResult {
  /** Channel adapters keyed by platform type (telegram, discord, etc.). */
  adaptersByType: Map<string, ChannelPort>;
  /** Channel lifecycle manager (optional -- undefined when no adapters enabled). */
  channelManager?: ChannelManager;
  /** Composite media resolver routing to per-platform resolvers (optional -- undefined when no ssrfFetcher). */
  compositeResolver?: MediaResolverPort;
  /** Attachment resolver callback for media URL resolution -- used by RPC handlers. */
  resolveAttachment: (url: string) => Promise<Buffer | null>;
  /** Lifecycle reactors created per eligible adapter (for shutdown cleanup). */
  lifecycleReactors: LifecycleReactor[];
  /** Approval notifier for forwarding approval events to chat channels (optional -- undefined when no adapters enabled). */
  approvalNotifier?: ApprovalNotifier;
  /** Full plugin objects keyed by channel type for capabilities RPC */
  channelPlugins: Map<string, ChannelPluginPort>;
  /** The command queue instance for parent session TTL extension during graph execution. */
  commandQueue?: CommandQueue;
}

// ---------------------------------------------------------------------------
// Deps type
// ---------------------------------------------------------------------------

/** Dependencies for channel adapter bootstrap. */
export interface ChannelsDeps {
  /** Bootstrap output: config, event bus, secret manager. */
  container: AppContainer;
  /** Per-agent executor instances keyed by agentId. */
  executors: Map<string, AgentExecutor>;
  /** Default agent ID from routing config. */
  defaultAgentId: string;
  /** Shared session manager across all agents. */
  sessionManager: ReturnType<typeof createSessionLifecycle>;
  /** Session persistence store (for getResetTriggers). */
  sessionStore: ReturnType<typeof createSessionStore>;
  /** Root logger (for cron delivery logs). */
  logger: ComisLogger;
  /** Module-bound logger for channels subsystem. */
  channelsLogger: ComisLogger;
  /** Link understanding runner for message text enrichment. */
  linkRunner: LinkRunner;
  /** SSRF-guarded fetcher for media downloads. */
  ssrfFetcher: SsrfGuardedFetcher;
  /** STT transcriber for audio preflight (optional -- config/key may be missing). */
  transcriber?: TranscriptionPort;
  /** Maximum media file size in bytes for inbound pre-check. */
  maxMediaBytes: number;
  /** Tool assembler passed through to channel-manager deps. Options.sessionKey threads
   *  the inbound session's persistent FileStateTracker via SessionTrackerRegistry. Cron
   *  delivery path (L370) intentionally omits options -- cron is heartbeat-style, no
   *  conversation session. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- AgentTool generic requires complex type parameters from pi-ai SDK
  assembleToolsForAgent?: (agentId: string, options?: { sessionKey?: import("@comis/core").SessionKey }) => Promise<any[]>;
  /** TTS adapter for voice response pipeline (optional -- TTS may not be configured). */
  ttsAdapter?: TTSPort;
  /** Audio converter for MP3-to-OGG/Opus conversion (optional -- ffmpeg may be absent). */
  audioConverter?: AudioConverter;
  /** Media temp manager for scratch files. */
  mediaTempManager?: MediaTempManager;
  /** Media semaphore for concurrency limiting. */
  mediaSemaphore?: MediaSemaphore;
  /** Optional image analyzer for text-description fallback when model lacks vision capability. */
  imageAnalyzer?: ImageAnalysisPort;
  /** File extractor for document attachment processing (optional -- documents skipped when absent). */
  fileExtractor?: FileExtractionPort;
  /** File extraction config for budget limits and feature flags. */
  fileExtractionConfig?: FileExtractionConfig;
  /** Per-agent workspace directory paths (for media file persistence). */
  workspaceDirs?: Map<string, string>;
  /** Default agent workspace directory path. */
  defaultWorkspaceDir?: string;
  /** Memory adapter for storing media file references. */
  memoryAdapter?: MemoryPort;
  /** Default tenant ID for memory storage. */
  tenantId?: string;
  /** Embedding queue for new memory entries (optional). */
  embeddingQueue?: { enqueue(id: string, content: string): void };
  /** Queue configuration for per-session serialization. When enabled, creates a CommandQueue for the ChannelManager. */
  queueConfig?: QueueConfig;
  /** Delivery queue for crash-safe persistence */
  deliveryQueue?: import("@comis/core").DeliveryQueuePort;
  /** Optional active run registry for SDK-native steer+followup inbound routing */
  activeRunRegistry?: ActiveRunRegistry;
  /** RPC call dispatcher for /config chat commands (deferred dispatch -- safe to pass before wireDispatch). */
  rpcCall?: RpcCall;
  /** Optional callback for task extraction after successful agent execution (gated by config.scheduler.tasks.enabled). */
  onTaskExtraction?: (conversationText: string, sessionKey: string, agentId: string) => Promise<void>;
  /**
   * Optional callback fired BEFORE each inbound message is dispatched to the
   * executor. Used by the restart continuation tracker so the session is
   * visible in tracker state before any tool call could trigger SIGUSR2.
   * Bypassed for early-return paths (no-adapter, graph-report intercept).
   */
  onMessageReceived?: (msg: NormalizedMessage, channelType: string) => void;
  /** Optional callback fired AFTER each successful inbound message processing. Used by post-processing state (e.g. notification session activity recording). */
  onMessageProcessed?: (msg: NormalizedMessage, channelType: string) => void;
  /** Optional approval gate for /approve and /deny chat commands in inbound pipeline (APPR-CHAT). */
  approvalGate?: import("@comis/core").ApprovalGate;
  /** Per-agent PI session adapters for session stats/destroy in slash commands (CMD-WIRE). */
  piSessionAdapters?: Map<string, {
    getSessionStats(key: SessionKey): { messageCount: number; createdAt?: number; tokens?: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number }; userMessages?: number; assistantMessages?: number; toolCalls?: number; toolResults?: number; cost?: number } | undefined;
    destroySession(key: SessionKey): Promise<void>;
  }>;
  /** Per-agent cost trackers for /usage and /status cost data (CMD-WIRE). */
  costTrackers?: Map<string, {
    getByProvider(): Array<{ provider: string; model: string; totalTokens: number; totalCost: number; callCount: number }>;
    getBySession(key: string): { totalTokens: number; totalCost: number };
  }>;
  /** Per-agent cron execution trackers for enriched JSONL entries. */
  cronExecutionTrackers?: Map<string, { record(entry: ExecutionLogEntry): Promise<void> }>;
}

// ---------------------------------------------------------------------------
// Setup function
// ---------------------------------------------------------------------------

/**
 * Bootstrap all enabled channel adapters from config, wire cron delivery and
 * tool audit event listeners, and create + start the ChannelManager.
 * This is the largest single extraction due to 8 platform
 * adapter blocks, each with credential resolution, validation, and plugin
 * creation.
 * @param deps - Channel bootstrap dependencies
 * @returns Channel adapters map and optional channel manager
 */
export async function setupChannels(deps: ChannelsDeps): Promise<ChannelsResult> {
  const {
    container,
    executors,
    defaultAgentId,
    sessionManager,
    logger,
    channelsLogger,
    linkRunner,
    ssrfFetcher,
    transcriber,
    maxMediaBytes,
  } = deps;

  const agents = container.config.agents;
  const routingConfig = container.config.routing;

  // Initialize Telegram file-ref guard config
  initTelegramFileGuardConfig(container.config.telegramFileRefGuard);

  // 6.6.6. Bootstrap enabled channel adapters from config
  const { adaptersByType, tgPlugin, linePlugin, channelCapabilities, channelPlugins } = await bootstrapAdapters({ container, channelsLogger });

  // 6.6.6.5. Assemble media pipeline (resolvers, preprocessor, preflight)
  const {
    compositeResolver,
    resolveAttachment,
    preprocessMessage: preprocessMessageCallback,
    audioPreflight: preflightFn,
  } = await buildMediaPipeline({
    container,
    channelsLogger,
    adaptersByType,
    tgPlugin,
    linePlugin,
    ssrfFetcher,
    linkRunner,
    transcriber,
    maxMediaBytes,
    defaultAgentId,
    imageAnalyzer: deps.imageAnalyzer,
    fileExtractor: deps.fileExtractor,
    fileExtractionConfig: deps.fileExtractionConfig,
    workspaceDirs: deps.workspaceDirs,
    memoryAdapter: deps.memoryAdapter,
    tenantId: deps.tenantId,
    embeddingQueue: deps.embeddingQueue,
  });

  // 6.6.7. Cron delivery listener — delivers scheduled job results to channels
  container.eventBus.on("scheduler:job_result", async (payload) => {
    // -- Memory review sentinel intercept --
    const resultText = payload.result;
    if (resultText === "__MEMORY_REVIEW__") {
      const { agentId } = payload;
      if (!agentId) {
        logger.warn({ hint: "Memory review job fired without agentId", errorKind: "config" as const }, "Skipping memory review -- no agentId");
        payload.onComplete?.({ status: "error", error: "No agentId for memory review" });
        return;
      }

      const agentConfig = agents[agentId];
      const memReviewConfig = agentConfig?.memoryReview;
      if (!memReviewConfig?.enabled) {
        logger.debug({ agentId }, "Memory review disabled for agent, skipping");
        payload.onComplete?.({ status: "ok" });
        return;
      }

      // Resolve cheap model for review via "cron" operation type
      const resolved = resolveOperationModel({
        operationType: "cron",
        agentProvider: agentConfig.provider ?? "anthropic",
        agentModel: agentConfig.model ?? "anthropic:claude-sonnet-4-20250514",
        operationModels: agentConfig.operationModels ?? {},
        providerFamily: resolveProviderFamily(agentConfig.provider ?? "anthropic"),
      });

      // Resolve API key for the provider
      const providerEntry = container.config.providers?.entries?.[resolved.provider];
      const apiKeyName = providerEntry?.apiKeyName || `${resolved.provider.toUpperCase()}_API_KEY`;
      const apiKey = container.secretManager.get(apiKeyName) ?? "";
      if (!apiKey) {
        logger.warn({ agentId, provider: resolved.provider, hint: `Set ${apiKeyName} in secrets for memory review`, errorKind: "config" as const }, "Skipping memory review -- no API key");
        payload.onComplete?.({ status: "error", error: `No API key for ${resolved.provider}` });
        return;
      }

      const workspacePath = deps.workspaceDirs?.get(agentId) ?? "";

      const reviewLogger = logger.child({ agentId, module: "memory-review" });
      const reviewResult = await runMemoryReview({
        agentId,
        tenantId: deps.tenantId ?? container.config.tenantId ?? "default",
        agentName: agentConfig.name ?? agentId,
        config: memReviewConfig,
        memoryPort: deps.memoryAdapter!,
        sessionStore: deps.sessionStore as unknown as {
          listDetailed(tenantId?: string): Array<{ sessionKey: string; tenantId: string; userId: string; channelId: string; metadata: Record<string, unknown> | null; createdAt: number; updatedAt: number; messageCount: number }>;
          loadByFormattedKey(sessionKey: string): { messages: unknown[]; metadata: Record<string, unknown>; createdAt: number; updatedAt: number } | undefined;
        },
        eventBus: container.eventBus,
        workspacePath,
        provider: resolved.provider,
        modelId: resolved.modelId,
        apiKey,
        logger: reviewLogger,
      });

      if (!reviewResult.ok) {
        logger.error({ agentId, err: reviewResult.error, hint: "Memory review failed -- will retry next cycle", errorKind: "internal" as const }, "Memory review error");
      }
      payload.onComplete?.({ status: reviewResult.ok ? "ok" : "error", error: reviewResult.ok ? undefined : reviewResult.error?.message });
      return;
    }

    const { deliveryTarget, jobName, payloadKind } = payload;
    if (!deliveryTarget?.channelType) {
      logger.warn(
        { jobName, hint: "Delivery target missing channelType — ensure cron job was created from a channel context", errorKind: "config" as const },
        "Cron job result has no delivery target channel type, skipping delivery",
      );
      payload.onComplete?.({ status: "error", error: "No delivery target channel type" });
      return;
    }
    const adapter = adaptersByType.get(deliveryTarget.channelType);
    if (!adapter) {
      logger.warn(
        { channelType: deliveryTarget.channelType, jobName, hint: "Ensure the target channel adapter is started and registered", errorKind: "config" as const },
        "No adapter found for cron delivery target",
      );
      payload.onComplete?.({ status: "error", error: `No adapter for ${deliveryTarget.channelType}` });
      return;
    }

    // --- agentTurn: execute agent and deliver response ---
    if (payloadKind === "agent_turn") {
      const executor = executors.get(payload.agentId) ?? executors.get(defaultAgentId);
      if (!executor) {
        logger.error(
          { agentId: payload.agentId, jobName, hint: "Ensure executor is created for the agent referenced by the cron job", errorKind: "config" as const },
          "No executor found for cron agentTurn",
        );
        // Fallback: send raw text so the user at least gets something
        await deliverToChannel(adapter, deliveryTarget.channelId, resultText, undefined,
          deps.deliveryQueue ? { deliveryQueue: deps.deliveryQueue } : undefined);
        payload.onComplete?.({ status: "error", error: "No executor found for agent" });
        return;
      }

      // Extract session strategy from event payload (defaults: fresh, 3 turns)
      const sessionStrategy = payload.sessionStrategy ?? "fresh";
      const maxHistoryTurns = payload.maxHistoryTurns ?? 3;

      // Resolve cron operation model via 5-level priority chain
      const agentConfig = agents[payload.agentId];
      let cronOverrides: { model: string; operationType: "cron"; promptTimeout: { promptTimeoutMs: number }; cacheRetention?: "none" | "short" | "long" } | undefined;
      if (agentConfig) {
        const resolution = resolveOperationModel({
          operationType: "cron",
          agentProvider: agentConfig.provider,
          agentModel: agentConfig.model,
          operationModels: agentConfig.operationModels ?? {},
          providerFamily: resolveProviderFamily(agentConfig.provider),
          invocationOverride: payload.cronJobModel,
          agentPromptTimeoutMs: agentConfig.promptTimeout?.promptTimeoutMs,
        });
        cronOverrides = {
          model: resolution.model,
          operationType: "cron",
          promptTimeout: { promptTimeoutMs: resolution.timeoutMs },
          cacheRetention: payload.cacheRetention ?? resolution.cacheRetention,
        };
        logger.info(
          { jobName, model: resolution.model, source: resolution.source, agentId: payload.agentId },
          "Cron model resolved",
        );
      }

      const sessionKey: SessionKey = {
        tenantId: deliveryTarget.tenantId,
        userId: deliveryTarget.userId,
        channelId: `cron:${payload.jobId}`,
      };

      // Fresh strategy — expire existing session before each execution
      if (sessionStrategy === "fresh") {
        sessionManager.expire(sessionKey);

        const piAdapter = deps.piSessionAdapters?.get(payload.agentId)
                       ?? deps.piSessionAdapters?.get(defaultAgentId);
        if (piAdapter) {
          await piAdapter.destroySession(sessionKey);
        } else {
          logger.warn(
            { agentId: payload.agentId, jobName, hint: "No piSessionAdapter found — JSONL may accumulate", errorKind: "config" as const },
            "Cron fresh strategy could not destroy JSONL",
          );
        }

        container.eventBus.emit("session:expired", { sessionKey, reason: "cron-fresh" });
      }

      const syntheticMsg: NormalizedMessage = {
        id: `cron-${payload.jobId}-${Date.now()}`,
        channelId: deliveryTarget.channelId,
        channelType: deliveryTarget.channelType,
        senderId: "system",
        text: resultText,
        timestamp: Date.now(),
        attachments: [],
        metadata: { isCronAgentTurn: true, jobId: payload.jobId, jobName },
      };

      const execStartTs = Date.now();
      try {
        const allTools = deps.assembleToolsForAgent
          ? await deps.assembleToolsForAgent(payload.agentId)
          : [];
        // Resolve effective tool policy: job > agent > passthrough `{ profile: "full" }`.
        // Opt-in per job — omitting payload.toolPolicy preserves the agent's interactive
        // tool set. The explicit "full" fallback makes the no-silent-default contract
        // readable in the call site (see design-doc §"no silent default").
        const effectivePolicy =
          payload.toolPolicy ??
          agentConfig?.skills?.toolPolicy ??
          { profile: "full" as const, allow: [] as string[], deny: [] as string[] };
        const { tools, filtered: policyFiltered } = applyToolPolicy(
          allTools as Parameters<typeof applyToolPolicy>[0],
          effectivePolicy,
        );
        if (policyFiltered.length > 0) {
          logger.debug(
            {
              jobName,
              agentId: payload.agentId,
              profile: effectivePolicy.profile,
              filteredCount: policyFiltered.length,
              filtered: policyFiltered.map((f) => ({ tool: f.toolName, reason: f.reason.kind })),
            },
            "Cron tool policy applied",
          );
        }
        logger.info(
          { jobName, agentId: payload.agentId, channelType: deliveryTarget.channelType, toolCount: Array.isArray(tools) ? tools.length : 0 },
          "Executing cron agentTurn",
        );
        const execResult = await runWithContext({
          traceId: randomUUID(),
          tenantId: sessionKey.tenantId,
          userId: sessionKey.userId,
          sessionKey: formatSessionKey(sessionKey),
          startedAt: Date.now(),
          trustLevel: "user",
          channelType: deliveryTarget.channelType,
          deliveryOrigin: deliveryTarget ? createDeliveryOrigin({
            channelType: deliveryTarget.channelType,
            channelId: deliveryTarget.channelId,
            userId: deliveryTarget.userId,
            tenantId: deliveryTarget.tenantId,
          }) : undefined,
        }, () => executor.execute(syntheticMsg, sessionKey, tools, undefined, payload.agentId,
          undefined, undefined, cronOverrides));

        // Sanitize raw executor response: strip thinking tags, provider artifacts, unwrap <final>
        const rawResponse = execResult.response;
        const cleaned = sanitizeAssistantResponse(rawResponse);

        // Rolling strategy — prune to last N turns after execution
        if (sessionStrategy === "rolling") {
          const messages = sessionManager.loadOrCreate(sessionKey);
          if (messages.length > 0) {
            // Find the start index of the last N turns.
            // A "turn" starts at a user message and includes all following non-user messages.
            // Walk backwards, counting user messages as turn boundaries.
            let turnCount = 0;
            let keepFromIndex = 0; // default: keep all
            for (let i = messages.length - 1; i >= 0; i--) {
              const msg = messages[i] as { role?: string };
              if (msg.role === "user") {
                turnCount++;
                if (turnCount <= maxHistoryTurns) {
                  keepFromIndex = i; // this user message starts a turn we want to keep
                } else {
                  break; // found more turns than maxHistoryTurns, stop
                }
              }
            }
            if (turnCount > maxHistoryTurns) {
              const pruned = messages.slice(keepFromIndex);
              sessionManager.save(sessionKey, pruned);
            }
          }
        }

        // Enriched completion log with token/cost/tool metrics
        logger.info(
          {
            jobName,
            agentId: payload.agentId,
            durationMs: Date.now() - execStartTs,
            responseLen: cleaned.length,
            totalTokens: execResult.tokensUsed.total,
            costUsd: execResult.cost.total,
            toolCalls: execResult.stepsExecuted,
            llmCalls: execResult.llmCalls,
          },
          "Cron agentTurn execution complete",
        );

        // Record enriched execution entry with token/cost metrics
        const execTracker = deps.cronExecutionTrackers?.get(payload.agentId);
        if (execTracker) {
          await execTracker.record({
            ts: Date.now(),
            jobId: payload.jobId,
            status: "ok",
            durationMs: Date.now() - execStartTs,
            summary: cleaned.slice(0, 200),
            totalTokens: execResult.tokensUsed.total,
            costUsd: execResult.cost.total,
            toolCalls: execResult.stepsExecuted,
            llmCalls: execResult.llmCalls,
          });
        }

        // Report execution result back to scheduler for consecutiveErrors tracking.
        // errorContext is set when the executor caught a classified error (overloaded, auth, etc.)
        // and returned the user-friendly message as the response instead of throwing.
        if (execResult.errorContext) {
          payload.onComplete?.({ status: "error", error: execResult.errorContext.originalError ?? execResult.errorContext.errorType });
        } else {
          payload.onComplete?.({ status: "ok" });
        }

        // Suppress error message delivery for cron jobs.
        // When errorContext is set, the executor caught a classified error
        // (timeout, overloaded, auth, etc.) and set result.response to a
        // user-facing error message. For cron jobs this is nonsensical.
        // The error is already reported via onComplete above.
        if (execResult.errorContext) {
          logger.info(
            { jobName, errorType: execResult.errorContext.errorType, hint: "Error already reported to scheduler — suppressing channel delivery" },
            "Cron agentTurn error response suppressed",
          );
          return;
        }

        // Filter out NO_REPLY / HEARTBEAT_OK / empty responses
        const filtered = filterResponse(cleaned);
        if (!filtered.shouldDeliver) {
          logger.debug({ jobName, suppressedBy: filtered.suppressedBy }, "Cron agentTurn response suppressed");
          return;
        }

        const sendResult = await deliverToChannel(adapter, deliveryTarget.channelId, filtered.cleanedText, undefined,
          deps.deliveryQueue ? { deliveryQueue: deps.deliveryQueue } : undefined);
        if (!sendResult.ok || !sendResult.value.ok) {
          logger.error(
            { err: sendResult.ok ? undefined : sendResult.error, jobName, hint: "Verify channel adapter is running and channel ID is valid", errorKind: "platform" as const },
            "Cron agentTurn delivery failed",
          );
        }
      } catch (err) {
        logger.error(
          { err, jobName, hint: "Agent execution failed, delivering raw text as fallback", errorKind: "internal" as const },
          "Cron agentTurn execution failed",
        );
        // Record error execution entry
        const execTracker = deps.cronExecutionTrackers?.get(payload.agentId);
        if (execTracker) {
          await execTracker.record({
            ts: Date.now(),
            jobId: payload.jobId,
            status: "error",
            durationMs: Date.now() - execStartTs,
            error: err instanceof Error ? err.message : String(err),
          });
        }
        await deliverToChannel(adapter, deliveryTarget.channelId, resultText, undefined,
          deps.deliveryQueue ? { deliveryQueue: deps.deliveryQueue } : undefined);
        payload.onComplete?.({ status: "error", error: err instanceof Error ? err.message : String(err) });
      }
      return;
    }

    // --- systemEvent (or undefined): send raw text (existing behavior) ---
    const sendResult = await deliverToChannel(adapter, deliveryTarget.channelId, resultText, undefined,
      deps.deliveryQueue ? { deliveryQueue: deps.deliveryQueue } : undefined);
    if (!sendResult.ok || !sendResult.value.ok) {
      logger.error(
        { err: sendResult.ok ? undefined : sendResult.error, target: deliveryTarget, jobName, hint: "Verify channel adapter is running and channel ID is valid", errorKind: "platform" as const },
        "Cron delivery failed",
      );
    } else {
      logger.debug({ jobName, channelId: deliveryTarget.channelId }, "Cron result delivered");
    }
  });

  // CRON-CIRCUIT: Notify user when a cron job is auto-suspended
  container.eventBus.on("scheduler:job_suspended", async (payload) => {
    const { deliveryTarget, jobName, jobId, consecutiveErrors, lastError } = payload;
    if (!deliveryTarget?.channelType) {
      logger.warn(
        { jobName, hint: "Suspended job has no delivery target for notification", errorKind: "config" as const },
        "Cannot notify user of job suspension — no delivery target",
      );
      return;
    }
    const adapter = adaptersByType.get(deliveryTarget.channelType);
    if (!adapter) {
      logger.warn(
        { channelType: deliveryTarget.channelType, jobName, hint: "Ensure the target channel adapter is started", errorKind: "config" as const },
        "No adapter found for job suspension notification",
      );
      return;
    }

    const message = [
      `Scheduled task "${jobName}" was suspended after ${consecutiveErrors} consecutive failures.`,
      `Last error: ${lastError.slice(0, 200)}`,
      `Re-enable with /cron enable ${jobId}`,
    ].join("\n");

    try {
      await deliverToChannel(adapter, deliveryTarget.channelId, message, undefined,
        deps.deliveryQueue ? { deliveryQueue: deps.deliveryQueue } : undefined);
      logger.info({ jobName, jobId, channelType: deliveryTarget.channelType }, "Job suspension notification delivered");
    } catch (err: unknown) {
      logger.error(
        { jobName, jobId, err, hint: "Failed to deliver job suspension notification", errorKind: "internal" as const },
        "Job suspension notification delivery failed",
      );
    }
  });

  // 6.6.10. Create and start ChannelManager
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
      // Task extraction callback (gated by config.scheduler.tasks.enabled)
      onTaskExtraction: deps.onTaskExtraction,
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
          try {
            graphDir = safePath(join(dataDir, "graph-runs"), graphId);
          } catch {
            channelsLogger.warn({ graphId, hint: "Path traversal attempt in graphId", errorKind: "validation" as const }, "Graph report request rejected");
            return;
          }

          // Check directory exists
          try {
            await stat(graphDir);
          } catch {
            channelsLogger.warn({ graphId, graphDir, hint: "Graph run directory not found", errorKind: "not_found" as const }, "Graph report directory missing");
            await adapter.sendMessage(channelId, "Report not available \u2014 graph run data not found.", threadId ? { extra: { threadId } } : undefined);
            return;
          }

          // Find the leaf output file
          const files = await readdir(graphDir);
          const outputFiles = files.filter((f) => f.endsWith("-output.md"));

          if (outputFiles.length === 0) {
            await adapter.sendMessage(channelId, "Report not available \u2014 no output files found.", threadId ? { extra: { threadId } } : undefined);
            return;
          }

          // Try to identify leaf nodes from metadata
          let leafOutputFile: string | undefined;
          try {
            const metadataRaw = await readFile(join(graphDir, "_run-metadata.json"), "utf8");
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
                const fileStat = await stat(join(graphDir, f));
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
              const fileStat = await stat(join(graphDir, f));
              if (fileStat.size > maxSize) {
                maxSize = fileStat.size;
                leafOutputFile = f;
              }
            }
          }

          if (!leafOutputFile) {
            await adapter.sendMessage(channelId, "Report not available \u2014 could not identify output file.", threadId ? { extra: { threadId } } : undefined);
            return;
          }

          const filePath = join(graphDir, leafOutputFile);
          const nodeId = leafOutputFile.replace(/-output\.md$/, "");
          const caption = `Full report \u2014 ${nodeId} (graph ${graphId.slice(0, 8)})`;

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
      // CMD-WIRE: General slash command handling via createCommandHandler
      handleSlashCommand: async (text: string, sessionKey: SessionKey, agentId: string) => {
        const parsed = parseSlashCommand(text);
        if (!parsed.found) return undefined;

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
            deps.sessionManager.expire(key);
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
        const now = new Date();
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
    });
    approvalNotifier.start();
    channelsLogger.debug("Approval notifier started");

    // Clean up notifier on shutdown
    container.eventBus.on("system:shutdown", () => {
      approvalNotifier?.stop();
    });
  }

  // URL-based resolver for RPC handler use (resolves by URL without full Attachment object)
  const resolveAttachmentByUrl = async (url: string): Promise<Buffer | null> => {
    return resolveAttachment({ url, type: "file" } as Attachment);
  };

  return { adaptersByType, channelManager, compositeResolver, resolveAttachment: resolveAttachmentByUrl, lifecycleReactors, approvalNotifier, channelPlugins, commandQueue };
}
