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

import type { AppContainer, Attachment, ChannelPort, ChannelPluginPort, ExecutionPlanPort, NormalizedMessage, SessionKey, TranscriptionPort, TTSPort, ImageAnalysisPort, FileExtractionPort, FileExtractionConfig, MemoryPort, MemoryEntityStore, MemoryCausalStore, MemoryConsolidationStore, TripleStorePort, RelationshipStore, MemoryLifecyclePort, OutcomeSignalPort, MentalModelStorePort, QueueConfig, DeliveryService, WrapExternalContentOptions, ClockPort, TimerPort, ActivityStreamPort } from "@comis/core";
import { createDeliveryService, createNoOpDeliveryQueue } from "@comis/core";
import type { ComisLogger } from "@comis/infra";
import type { AgentExecutor, createSessionLifecycle, ActiveRunRegistry, BackgroundSessionResolver } from "@comis/agent";
import type { createSessionStore, MemoryApi } from "@comis/memory";
import type { CommandQueue } from "@comis/orchestrator";
import type { VoiceResponsePipelineDeps, LifecycleReactor } from "@comis/channels";
import type { ChannelManager, ActivityBreakerGate } from "@comis/orchestrator";
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
  /** Per-agent OAuth access-token resolver (LEARN-01) — forwarded to the cron
   *  event listeners so background memory/learning jobs run on an OAuth main
   *  provider (openai-codex) instead of skipping for "no API key". */
  resolveAccessToken?: (agentId: string, provider: string) => Promise<string | undefined>;
  /** System timers (composition root). Threaded to buildActivityRenderers so the
   *  EditPlace renderer debounces edits via TimerPort (no raw setTimeout). */
  timers: TimerPort;
  /** The orchestrator-facing redacted activity stream port (the
   *  setupObservability ActivityStream). Threaded into the inbound
   *  coordinatorFactory built in buildAndStartChannelManager as its
   *  activityStreamPort. Optional: absent → no inbound coordinatorFactory is built
   *  (the pipeline gate stays false, fail-closed §22.2 Day-0). */
  activityStream?: ActivityStreamPort;
  /** The process-singleton activity circuit breaker (constructed once in
   *  daemon.ts). Threaded into every per-turn coordinator so a permission/error
   *  storm on one (agentId, channelKey) pair auto-quiesces it across turns.
   *  Optional: absent → no breaker gating (the un-wired path is unaffected). */
  activityBreaker?: ActivityBreakerGate;
  /**
   * The SHARED ExecutionPlanHolder reference for the DEFAULT
   * agent (the same object createAcpWiring already shares with the gateway).
   * Threaded into buildAndStartChannelManager → createPlanStream so the chat
   * coordinator reads the SAME SEP plan SEP publishes into.
   *
   * Lock: this MUST NOT be a fresh `createExecutionPlanHolder()` —
   * a parallel holder would always read empty since SEP publishes into the one
   * threaded into PiExecutorDeps.executionPlanHolder. The composition test in
   * setup-channels-plan-stream.composition.test.ts asserts the identity
   * relationship `acpWiring.holder === channelsDeps.executionPlanPort`.
   *
   * Multi-agent limitation: this carries the DEFAULT agent's holder only; per-
   * turn cross-agent updates are filtered out by the coordinator's (agentId,
   * sessionKey) guard so non-default-agent turns simply omit the plan header.
   * A per-agent plan-stream Map is a clean follow-up.
   *
   * Optional: absent → no plan-stream is built (frame.planSnapshot stays
   * undefined; the elapsed-time fallback applies).
   */
  executionPlanPort?: ExecutionPlanPort;
  /** Test-only renderer-injection seam (daemon-types.ts
   *  DaemonOverrides.activityRendererFactory). When set, replaces the renderer
   *  produced by buildActivityRenderers for a given channelType so an integration
   *  test can inject a spy/TestSink and assert `apply` fired on a real inbound
   *  turn. Optional + default-undefined; production never sets it. */
  activityRendererFactory?: (channelType: string) => import("@comis/core").ChannelActivityRenderer | undefined;
  /** Secret-bound callback signer. Threaded to buildActivityRenderers so
   *  button-capable renderers (Telegram/Discord/Slack/LINE) paint signed
   *  approval callback_data. Optional: absent → button-less approval prompts. */
  signCallbackData?: import("@comis/channels").SignCallbackData;
  /** Single-use approval-link minter. Threaded to the Email DigestOnly
   *  renderer (it has no buttons). Optional: absent → no approval link in the
   *  [FAILED] digest. */
  mintApprovalLink?: import("@comis/channels").MintApprovalLink;
  /** Server-side interactive-callback router. Threaded through
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
  /** LCD store + browse — the memory-review session source reads DAG
   *  transcripts from them (live finding 2026-06-11: the daemon session store
   *  is near-empty in DAG mode, so the nightly extraction was a silent
   *  no-op). Absent ⇒ daemon-store-only review (pipeline byte-identical). */
  lcdStore?: import("@comis/core").ContextStorePort;
  contextBrowse?: import("@comis/core").ContextBrowsePort;
  /** Memory read API — the __USER_REPRESENTATION__ sentinel scopes the
   *  per-(tenant, agent, user) high-trust source read over `inspect`. Built in setup-memory;
   *  daemon-side (the agent imports no memory package). */
  memoryApi?: MemoryApi;
  /** Entity-associative store — forwarded to registerCronEventListeners so
   *  runMemoryReview (the write path) populates entity links after each successful store.
   *  Built in setup-memory on the shared db handle. */
  entityStore?: MemoryEntityStore;
  /** Causal store — forwarded to registerCronEventListeners so
   *  runMemoryReview (the write path) links cause->effect edges via linkCausal after each
   *  successful store. Built in setup-memory on the shared db handle; injected as the port
   *  TYPE (agent↛memory cut). */
  causalStore?: MemoryCausalStore;
  /** Consolidation store — ORPHANED in Phase 225-05 (the runMemoryConsolidation job +
   *  the __MEMORY_CONSOLIDATION__ sentinel were deleted); the port is retired in Phase 226.
   *  Still forwarded (no live writer). Built in setup-memory on the shared db handle; injected
   *  as the port TYPE (agent↛memory cut). */
  consolidationStore?: MemoryConsolidationStore;
  /** Triple store — forwarded to registerCronEventListeners so
   *  the opt-in __MEMORY_TRIPLE_EXTRACTION__ sentinel runs runMemoryTripleExtraction's DEDUCTIVE
   *  write via the trust-first upsertTriple. Built in setup-memory on the shared db handle;
   *  injected as the port TYPE (agent↛memory cut). Threaded the full daemon → registry →
   *  credentials chain — a missing thread silently disables the deductive
   *  write path. Absent => the sentinel cannot run (the cron is off-by-default
   *  anyway, so a default-config agent never reaches it). */
  tripleStore?: TripleStorePort;
  /** Directional relationship store — forwarded to the cron path
   *  so the opt-in + sign-off-gated __SOCIAL_MODELING__ sentinel runs runRelationshipBuild's offline
   *  per-channel directional-edge upsert write. Built in setup-memory on the shared db handle; injected
   *  as the port TYPE (agent↛memory cut). Threaded the full daemon → registry → credentials chain — a
   *  missing thread silently disables the offline-builder write path. Absent => the
   *  relationship sentinel cannot run (the cron is off-by-default + sign-off-gated anyway). */
  relationshipStore?: RelationshipStore;
  /** Memory-lifecycle sweep store — forwarded to the cron path so
   *  the opt-in KEYLESS __MEMORY_LIFECYCLE__ sentinel runs the DORMANT runLifecycleSweep. Built in
   *  setup-memory on the shared db handle; injected as the port TYPE (agent↛memory cut). Threaded
   *  the full daemon → registry → credentials chain — a missing thread silently disables the sweep
   *  (the field-plumbing lesson). Absent => off-by-default, never reached. */
  memoryLifecycleStore?: MemoryLifecyclePort;
  // (The cron-path `usefulnessStore` field was DELETED in Phase 226-03 — its sole reader was
  //  the deleted usefulness-judge sentinel. The FORGET-02 recordUsage reward write rides
  //  setup-learning.ts, not this cron forward; the store survives.)
  /** Outcome-signal store (WS1) — forwarded to the __REFLECT__ cron path (runReflection
   *  fail-closed success gate). Built in setup-memory; port TYPE only (agent↛memory cut). */
  outcomeStore?: OutcomeSignalPort;
  /** Mental-model store (WS2/skills) — forwarded to the __REFLECT__ cron path (runReflection get/admit).
   *  Built in setup-memory on the shared db; port TYPE only (the agent↛memory closed-graph cut). */
  learnedSkillStore?: MentalModelStorePort;
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
  /**
   * REACT-04 (Verified Learning, Phase 206-04): the SAME outbound → trajectory
   * binding threaded into the delivery-queue drain (setup-delivery.ts). Wired
   * into createDeliveryService so the PRIMARY inbound-reply path (which sends via
   * the direct ack, not the drain) also binds the minted reply id → trajectory —
   * else a reaction on a normal agent reply map-misses (the 206-03 live finding).
   * `undefined` when learning-outcome is off for all agents (byte-identity).
   * `participantId` (FLAG-2) carries the conversation participant (the inbound
   * sender) so a reaction from an unmapped group bystander resolves to "external"
   * (inert) and cannot spoof reaction-learning.
   */
  recordOutboundMessage?: (
    messageId: string,
    scope: { traceId: string; tenantId: string; agentId: string; sessionId: string; participantId?: string },
  ) => void;
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
  /** Complete three-layer conversation forget for slash /new + /reset
   *  (createConversationReset — live finding 2026-06-11: runtime-only destroy
   *  left the LCD context the DAG re-presented on the next turn). */
  destroyConversation?: (agentId: string, key: SessionKey) => Promise<unknown>;
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
    // REACT-04 (206-04): bind the minted reply id → trajectory on the DIRECT ack
    // path too (the primary inbound-reply path sends here, not via the drain).
    // Same callback instance the drain receives (foundation.recordOutboundMessage);
    // undefined when learning-outcome is off for all agents (byte-identity).
    recordOutboundMessage: deps.recordOutboundMessage,
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
    clock: deps.clock,
    resolveAccessToken: deps.resolveAccessToken, // LEARN-01: OAuth-provider background jobs
    adaptersByType,
    deliveryService,
    assembleToolsForAgent: deps.assembleToolsForAgent,
    transcriber,
    workspaceDirs: deps.workspaceDirs,
    memoryAdapter: deps.memoryAdapter,
    lcdStore: deps.lcdStore,
    contextBrowse: deps.contextBrowse,
    entityStore: deps.entityStore,
    causalStore: deps.causalStore,
    consolidationStore: deps.consolidationStore,
    tripleStore: deps.tripleStore,
    relationshipStore: deps.relationshipStore,
    memoryLifecycleStore: deps.memoryLifecycleStore,
    // v2.31 Reflection: the outcome gate + mental-model store ride the SAME cron-deps chain →
    // the __REFLECT__ sentinel assembles the closed-graph reflection bundle (no embedder — the
    // reflection job groups by topicKey, not clustering embeddings).
    outcomeStore: deps.outcomeStore,
    learnedSkillStore: deps.learnedSkillStore,
    memoryApi: deps.memoryApi,
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
      activityStream: deps.activityStream, // ActivityStreamPort for the inbound coordinatorFactory
      activityBreaker: deps.activityBreaker, // process-singleton breaker (shared)
      executionPlanPort: deps.executionPlanPort, // shared ExecutionPlanHolder for the chat plan-stream
      activityRendererFactory: deps.activityRendererFactory, // test seam
      signCallbackData: deps.signCallbackData,
      mintApprovalLink: deps.mintApprovalLink,
      interactiveCallbackRouter: deps.interactiveCallbackRouter, // verifier → inbound pipeline
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
      destroyConversation: deps.destroyConversation,
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
