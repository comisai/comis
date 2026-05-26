// SPDX-License-Identifier: Apache-2.0
/**
 * Channel-subsystem composition root: bootstraps adapters (delegated to
 * setup-channels-adapters.ts), assembles the media pipeline (delegated to
 * setup-channels-media.ts), registers cron-delivery event listeners
 * (delegated to setup-channels-credentials.ts), and constructs the
 * ChannelManager + lifecycle reactors (delegated to
 * setup-channels-runtime.ts).
 *
 * Holds the `ChannelsDeps` / `ChannelsResult` interfaces and the
 * `setupChannels` entry that the daemon composition root calls.
 *
 * @module
 */

import type { AppContainer, Attachment, ChannelPort, ChannelPluginPort, NormalizedMessage, SessionKey, TranscriptionPort, TTSPort, ImageAnalysisPort, FileExtractionPort, FileExtractionConfig, MemoryPort, QueueConfig, DeliveryService, WrapExternalContentOptions, ClockPort, TimerPort } from "@comis/core";
import { createDeliveryService, createNoOpDeliveryQueue } from "@comis/core";
import type { ComisLogger } from "@comis/infra";
import type { AgentExecutor, createSessionLifecycle, ActiveRunRegistry, BackgroundSessionResolver } from "@comis/agent";
import type { createSessionStore } from "@comis/memory";
import type { CommandQueue } from "@comis/orchestrator";
import type { VoiceResponsePipelineDeps, LifecycleReactor } from "@comis/channels";
import type { ChannelManager } from "@comis/orchestrator";
import { initTelegramFileGuardConfig } from "@comis/core";
import type { MediaResolverPort } from "@comis/core";
import type { SsrfGuardedFetcher, LinkRunner, AudioConverter, MediaTempManager, MediaSemaphore } from "@comis/skills";
import type { RpcCall } from "@comis/skills/platform-tools";
import type { ExecutionLogEntry } from "@comis/scheduler";
import { bootstrapAdapters } from "../setup-channels-adapters.js";
import { buildMediaPipeline } from "../setup-channels-media.js";
import { registerCronEventListeners } from "./setup-channels-credentials.js";
import { buildAndStartChannelManager } from "./setup-channels-runtime.js";

// Re-export the unused VoiceResponsePipelineDeps + LifecycleReactor types to
// silence lint and document the public-surface boundary: callers of this
// barrel may want to inspect the shape of the channel-runtime helpers.
export type { VoiceResponsePipelineDeps, LifecycleReactor };

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
  /** Full plugin objects keyed by channel type. Consumers read
   *  `plugin.capabilities` for features.reactions (lifecycle reactor gate)
   *  and replyToMetaKey (the platform-native message id used by the inbound
   *  UUID resolver to translate daemon UUIDs back to native ids before
   *  calling the channel adapter). */
  channelPlugins: Map<string, ChannelPluginPort>;
  /** The command queue instance for parent session TTL extension during graph execution. */
  commandQueue?: CommandQueue;
  /** DeliveryService constructed once at the daemon composition root. Threaded
   *  through setupCrossSession + createMessageHandlers so all production callers
   *  share a single closure-captured deps record. */
  deliveryService: DeliveryService;
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
  /** System clock (composition root). Threaded to buildActivityRenderers so the
   *  EditPlace renderer gates its delete on outcome.delivery.deliveredAtMs. */
  clock: ClockPort;
  /** System timers (composition root). Threaded to buildActivityRenderers so the
   *  EditPlace renderer debounces edits via TimerPort (no raw setTimeout). */
  timers: TimerPort;
  /** Secret-bound callback signer (73-10). Threaded to buildActivityRenderers so
   *  button-capable renderers (Telegram/Discord/Slack/LINE) paint signed
   *  approval callback_data. Optional: absent → button-less approval prompts. */
  signCallbackData?: import("@comis/channels").SignCallbackData;
  /** Single-use approval-link minter (73-10). Threaded to the Email DigestOnly
   *  renderer (it has no buttons). Optional: absent → no approval link in the
   *  [FAILED] digest. */
  mintApprovalLink?: import("@comis/channels").MintApprovalLink;
  /** Server-side interactive-callback router (CR-01 / 73-04). Threaded through
   *  buildAndStartChannelManager → createChannelManager → the inbound pipeline so
   *  inbound-gate.ts intercepts a signed button callback and verifies it BEFORE
   *  slash parsing (the signed payload must never reach the LLM). Optional: absent
   *  → button callbacks fall through to the normal pipeline (degrade, not crash). */
  interactiveCallbackRouter?: import("@comis/orchestrator").InteractiveCallbackRouter;
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
  assembleToolsForAgent?: (agentId: string, options?: { sessionKey?: SessionKey }) => Promise<any[]>;
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
  /** Optional callback for suspicious-content detection. Forwarded from the
   *  daemon's BootContext.onSuspiciousContent into buildMediaPipeline so media
   *  handlers fire the callback when wrapExternalContent detects injection patterns. */
  onSuspiciousContent?: WrapExternalContentOptions["onSuspiciousContent"];
  /** Queue configuration for per-session serialization. When enabled, creates a CommandQueue for the ChannelManager. */
  queueConfig?: QueueConfig;
  /** Delivery queue for crash-safe persistence */
  deliveryQueue?: import("@comis/core").DeliveryQueuePort;
  /** Optional active run registry for SDK-native steer+followup inbound routing */
  activeRunRegistry?: ActiveRunRegistry;
  /**
   * Optional composite-key resolver. Wired by the daemon as
   * `createBackgroundSessionResolver({ activeRunRegistry })`; supersedes
   * `activeRunRegistry.has/.get` for production lookups in the inbound
   * pipeline.
   */
  sessionResolver?: BackgroundSessionResolver;
  /** RPC call dispatcher for /config chat commands (deferred dispatch -- safe to pass before wireDispatch). */
  rpcCall?: RpcCall;
  /**
   * Optional callback fired BEFORE each inbound message is dispatched to the
   * executor. Used by the restart continuation tracker so the session is
   * visible in tracker state before any tool call could trigger SIGUSR2.
   * Bypassed for early-return paths (no-adapter, graph-report intercept).
   */
  onMessageReceived?: (msg: NormalizedMessage, channelType: string) => void;
  /** Optional callback fired AFTER each successful inbound message processing. Used by post-processing state (e.g. notification session activity recording). */
  onMessageProcessed?: (msg: NormalizedMessage, channelType: string) => void;
  /** Optional approval gate for /approve and /deny chat commands in inbound pipeline. */
  approvalGate?: import("@comis/core").ApprovalGate;
  /** Per-agent PI session adapters for session stats/destroy in slash commands. */
  piSessionAdapters?: Map<string, {
    getSessionStats(key: SessionKey): { messageCount: number; createdAt?: number; tokens?: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number }; userMessages?: number; assistantMessages?: number; toolCalls?: number; toolResults?: number; cost?: number } | undefined;
    destroySession(key: SessionKey): Promise<void>;
  }>;
  /** Per-agent cost trackers for /usage and /status cost data. */
  costTrackers?: Map<string, {
    getByProvider(): Array<{ provider: string; model: string; totalTokens: number; totalCost: number; callCount: number }>;
    getBySession(key: string): { totalTokens: number; totalCost: number };
  }>;
  /** Per-agent cron execution trackers for enriched JSONL entries. */
  cronExecutionTrackers?: Map<string, { record(entry: ExecutionLogEntry): Promise<void> }>;
  /**
   * DI seam for /export-trajectory slash command.
   * Threaded into buildAndStartChannelManager → createChannelManager →
   * pipelineDeps → inbound-gate dispatch guard. When absent, /export-trajectory
   * falls through to generic slash command handling (no-op). Production daemon
   * populates this from exportTrajectoryBundle (@comis/observability).
   */
  exportSessionBundle?: (sessionId: string) => Promise<{ bundlePath: string }>;
}

// ---------------------------------------------------------------------------
// Setup function
// ---------------------------------------------------------------------------

/**
 * Bootstrap all enabled channel adapters from config, wire cron delivery and
 * tool audit event listeners, and create + start the ChannelManager.
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

  // Initialize Telegram file-ref guard config
  initTelegramFileGuardConfig(container.config.telegramFileRefGuard);

  // Construct DeliveryService ONCE at the daemon composition root. The
  // closure captures hookRunner + deliveryQueue + eventBus, so all production
  // callers below use the method form `deliveryService.deliverToChannel(...)`
  // instead of threading an optional 5th-arg deps record. The reference is
  // also threaded through ChannelManagerDeps, MessageHandlerDeps, and the
  // cross-session-sender deps so every callsite
  // sees the same closure-captured deps record. `deps.deliveryQueue` is
  // always defined in production (real SQLite queue when enabled,
  // createNoOpDeliveryQueue when disabled — see setup-delivery.ts); the
  // defensive `?? createNoOpDeliveryQueue()` guards against a downstream
  // caller passing undefined.
  const deliveryService: DeliveryService = createDeliveryService({
    hookRunner: container.hookRunner,
    deliveryQueue: deps.deliveryQueue ?? createNoOpDeliveryQueue(),
    eventBus: container.eventBus,
  });

  // Bootstrap enabled channel adapters from config
  const { adaptersByType, tgPlugin, linePlugin, channelPlugins } = await bootstrapAdapters({ container, channelsLogger });

  // Assemble media pipeline (resolvers, preprocessor, preflight)
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
    onSuspiciousContent: deps.onSuspiciousContent,
  });

  // Register cron-delivery event listeners (scheduler:job_result + scheduler:job_suspended).
  registerCronEventListeners({
    container,
    executors,
    defaultAgentId,
    sessionManager,
    sessionStore: deps.sessionStore,
    logger,
    adaptersByType,
    deliveryService,
    assembleToolsForAgent: deps.assembleToolsForAgent,
    transcriber,
    workspaceDirs: deps.workspaceDirs,
    memoryAdapter: deps.memoryAdapter,
    tenantId: deps.tenantId,
    piSessionAdapters: deps.piSessionAdapters,
    cronExecutionTrackers: deps.cronExecutionTrackers,
    activeRunRegistry: deps.activeRunRegistry,
  });

  // Build the ChannelManager (voice pipeline + command queue + slash handlers +
  // lifecycle reactors).
  const { channelManager, lifecycleReactors, commandQueue } =
    await buildAndStartChannelManager({
      container,
      executors,
      defaultAgentId,
      sessionManager,
      channelsLogger,
      ssrfFetcher,
      linkRunner,
      deliveryService,
      adaptersByType,
      channelPlugins,
      clock: deps.clock,
      timers: deps.timers,
      signCallbackData: deps.signCallbackData,
      mintApprovalLink: deps.mintApprovalLink,
      interactiveCallbackRouter: deps.interactiveCallbackRouter, // CR-01: verifier → inbound pipeline
      preprocessMessageCallback,
      preflightFn,
      assembleToolsForAgent: deps.assembleToolsForAgent,
      ttsAdapter: deps.ttsAdapter,
      audioConverter: deps.audioConverter,
      mediaTempManager: deps.mediaTempManager,
      mediaSemaphore: deps.mediaSemaphore,
      queueConfig: deps.queueConfig,
      deliveryQueue: deps.deliveryQueue,
      activeRunRegistry: deps.activeRunRegistry,
      sessionResolver: deps.sessionResolver,
      rpcCall: deps.rpcCall,
      onMessageReceived: deps.onMessageReceived,
      onMessageProcessed: deps.onMessageProcessed,
      approvalGate: deps.approvalGate,
      piSessionAdapters: deps.piSessionAdapters,
      costTrackers: deps.costTrackers,
      cronExecutionTrackers: deps.cronExecutionTrackers,
      exportSessionBundle: deps.exportSessionBundle,
    });

  // URL-based resolver for RPC handler use (resolves by URL without full Attachment object)
  const resolveAttachmentByUrl = async (url: string): Promise<Buffer | null> => {
    return resolveAttachment({ url, type: "file" } as Attachment);
  };

  return {
    adaptersByType,
    channelManager,
    compositeResolver,
    resolveAttachment: resolveAttachmentByUrl,
    lifecycleReactors,
    channelPlugins,
    commandQueue,
    deliveryService,
  };
}
