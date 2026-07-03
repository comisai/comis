// SPDX-License-Identifier: Apache-2.0
/**
 * Public types for the daemon entry point.
 *
 * Single source of truth for the daemon's public interface types and the
 * boot-time context (`BootContext`) populated by the 5 `boot*` helpers in
 * `daemon.ts`. Also exports the SessionStoreBridge structural type, the
 * GatewayPreDispatchSlice helper Pick, and the PermissionCorrection record.
 *
 * Shared between daemon.ts and the stages/* helper modules without an import
 * cycle (helpers accept narrow Pick<BootContext> subsets; daemon.ts composes
 * BootContext into the DaemonInstance return).
 *
 * `BootContext` replaces the prior 4-handle chain
 * (Foundation → Agents → Channels → Gateway handles, composed via `extends`)
 * with a single interface. Group A (foundation) fields are strict;
 * Groups B/C/D (agents/channels/gateway) fields are optional.
 *
 * @module
 */

import type { TimerPort, SessionKey } from "@comis/core";
import type { AppContainer, ChannelPort, DeliveryQueuePort, DeliveryAdapter } from "@comis/core";
import type { BoundedAutonomyBudgetHolder } from "@comis/agent";
import type { ChannelActivityRenderer } from "@comis/core";
import type { ApprovalGate } from "@comis/core";
import type { ChannelManager } from "@comis/orchestrator";
import type { ChannelHealthMonitor } from "@comis/channels";
import type { ComisLogger, LeaseManager } from "@comis/infra";
import type { SessionResetScheduler, BackgroundTaskManager } from "@comis/agent";
import type { GatewayServerHandle, WsConnectionManager } from "@comis/gateway";
import type {
  HeartbeatRunner,
  CronScheduler,
} from "@comis/scheduler";
import type { BrowserService, SandboxProvider, ImageGenRateLimiter, VideoGenRateLimiter } from "@comis/skills";
import type { RpcCall } from "@comis/skills/platform-tools";
import type { LogLevelManager } from "./observability/log-infra.js";
import type { TokenTracker } from "./observability/token-tracker.js";
import type { DiagnosticCollector } from "./observability/diagnostic-collector.js";
import type { BillingEstimator } from "./observability/billing-estimator.js";
import type { ChannelActivityTracker } from "./observability/channel-activity-tracker.js";
import type { DeliveryTracer } from "./observability/delivery-tracer.js";
import type { ShutdownHandle } from "./wiring/setup-shutdown.js";
import type { ProcessMonitor } from "./process/process-monitor.js";

import type {
  bootstrap,
  PerAgentConfig,
  ToolCapabilityPort,
  WrapExternalContentOptions,
  createConfigGitManager,
  createInjectionRateLimiter,
  createAuditAggregator,
  createApprovalGate,
  createModelCatalog,
  preReadStorageMode,
  writeMasterKeyIfAbsent,
  MutableSecretManager,
} from "@comis/core";
import type { createActiveRunRegistry } from "@comis/agent";
import type { setupSecrets, ObservabilityStore } from "@comis/memory";
import type { createGatewayServer } from "@comis/gateway";
import type {
  GeminiCacheManager,
  createBackgroundSessionResolver,
  SessionTrackerRegistry,
} from "@comis/agent";
import type { createRestartContinuationTracker } from "./wiring/restart-continuation.js";
import type { createSystemEventQueue, createWakeCoalescer } from "@comis/scheduler";
import type { createFileStateTracker, createImageGenProvider, createVideoGenProvider } from "@comis/skills";
import type { createTracingLogger } from "./observability/trace-logger.js";
import type { createLogLevelManager } from "./observability/log-infra.js";
import type { createTokenTracker } from "./observability/token-tracker.js";
import type { createProcessMonitor } from "./process/process-monitor.js";
import type { setupMedia } from "./wiring/setup-media.js";
import type {
  setupLogging,
  setupObservability,
  setupHealth,
  setupMemory,
  setupAgents,
  setupSchedulers,
  setupChannels,
  setupCrossSession,
  setupMcp,
  selectMcpTokenStore,
  setupTools,
  setupMonitoring,
  setupHeartbeat,
  setupRpcBridge,
  setupDeliveryQueue,
  setupDeliveryMirror,
  setupOutputRetention,
  setupNotifications,
  setupBackgroundTasks,
  setupBackgroundCompletionRunner,
  setupTerminalWake,
} from "./wiring/index.js";
import type { BrokerHandle } from "./wiring/setup-broker.js";
import type { createNamedGraphStore } from "@comis/memory";
import type { createTokenRegistry } from "./api/token-handlers.js";
import type { createContextPipelineCollector } from "./observability/context-pipeline-collector.js";
import type { ObsPersistenceResult } from "./observability/obs-persistence-wiring.js";
import type { createGraphCoordinator, createNodeTypeRegistry } from "./graph/index.js";
import type { createExecGit } from "./config/exec-git.js";
import type { InboundMessageIdResolver } from "./wiring/inbound-message-id-resolver.js";
import type { SecretStorePort } from "@comis/core";

// ---------------------------------------------------------------------------
// Permission record
// ---------------------------------------------------------------------------

/**
 * Record of a single permission correction applied by `hardenDataDirPermissions`.
 * Used by `bootFoundation` to log corrections after the logger is available.
 */
export interface PermissionCorrection {
  file: string;
  oldMode: number;
  newMode: number;
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * The running daemon instance with all wired services.
 */
export interface DaemonInstance {
  readonly container: AppContainer;
  readonly logger: ComisLogger;
  readonly logLevelManager: LogLevelManager;
  readonly tokenTracker: TokenTracker;
  readonly processMonitor: ProcessMonitor;
  readonly shutdownHandle: ShutdownHandle;
  readonly cronSchedulers: Map<string, CronScheduler>;
  readonly resetSchedulers: Map<string, SessionResetScheduler>;
  readonly browserServices: Map<string, BrowserService>;
  readonly heartbeatRunner?: HeartbeatRunner;
  readonly gatewayHandle?: GatewayServerHandle;
  readonly adapterRegistry: Map<string, ChannelPort>;
  /**
   * The orchestrator ChannelManager (undefined when no channel adapters are
   * configured at boot — `setup-channels-runtime.ts` only constructs it when
   * `adaptersByType.size > 0`). Exposed so integration tests can drive a real
   * inbound turn through the daemon's REAL pipeline deps via
   * `channelManager.injectMessage(channelType, msg)` — the activation
   * test (`test/integration/activity-composition.test.ts`) registers a test
   * adapter on `adapterRegistry` and drives `renderer.apply` end-to-end.
   */
  readonly channelManager?: ChannelManager;
  /**
   * Delivery-queue-side adapter map. Adapters registered here are
   * used by the recurring delivery-queue drainer for crash-safe outbound
   * delivery. Distinct from `adapterRegistry` (which serves direct dispatch
   * via the RPC message.* path) -- daemon.ts populates this map AFTER
   * setupChannels returns. Tests that exercise the recurring drainer must
   * register adapters in this map so the drainer can find them.
   */
  readonly deliveryAdapters: Map<string, DeliveryAdapter>;
  /**
   * Crash-safe delivery queue port. Exposed for tests that need
   * to assert on queue depth (depth returns to 0 after drain).
   */
  readonly deliveryQueue: DeliveryQueuePort;
  /**
   * Background task manager. Exposed for integration tests that
   * need to promote synthetic tasks and call complete()/fail() to drive the
   * completion runner pipeline without a live LLM.
   */
  readonly backgroundTaskManager: BackgroundTaskManager;
  readonly rpcCall: RpcCall;
  readonly diagnosticCollector: DiagnosticCollector;
  readonly billingEstimator: BillingEstimator;
  readonly channelActivityTracker: ChannelActivityTracker;
  readonly deliveryTracer: DeliveryTracer;
  readonly approvalGate?: ApprovalGate;
  /** Channel health monitor for observability and auto-restart. */
  readonly channelHealthMonitor?: ChannelHealthMonitor;
  readonly sessionStoreBridge?: {
    listDetailed: (tenantId?: string) => Array<{
      sessionKey: string;
      userId: string;
      channelId: string;
      metadata: Record<string, unknown>;
      createdAt: number;
      updatedAt: number;
    }>;
    loadByFormattedKey: (sessionKey: string) => { messages: unknown[]; metadata: Record<string, unknown>; createdAt: number; updatedAt: number } | undefined;
    deleteByFormattedKey: (sessionKey: string) => boolean;
    saveByFormattedKey: (sessionKey: string, messages: unknown[], metadata?: Record<string, unknown>) => void;
  };
}

/**
 * Overrides for dependency injection during testing.
 */
export interface DaemonOverrides {
  /** Override bootstrap function. */
  bootstrap?: typeof bootstrap;
  /** Override setupSecrets for test isolation */
  setupSecrets?: typeof setupSecrets;
  /** Override preReadStorageMode for test isolation (avoids reading real ~/.comis/config.yaml). */
  preReadStorageMode?: typeof preReadStorageMode;
  /** Override writeMasterKeyIfAbsent for test isolation (spy on key-material creation gate). */
  writeMasterKeyIfAbsent?: typeof writeMasterKeyIfAbsent;
  /** Override createTracingLogger. */
  createTracingLogger?: typeof createTracingLogger;
  /** Override createLogLevelManager. */
  createLogLevelManager?: typeof createLogLevelManager;
  /** Override createTokenTracker. */
  createTokenTracker?: typeof createTokenTracker;
  /** Override createProcessMonitor. */
  createProcessMonitor?: typeof createProcessMonitor;
  /** Override createGatewayServer. */
  createGatewayServer?: typeof createGatewayServer;
  /** Override setupMedia for test isolation (avoids ffmpeg/ffprobe spawns). */
  setupMedia?: typeof setupMedia;
  /** Override process.exit for testing. */
  exit?: (code: number) => void;
  /** Override native-dep preflight check for tests that don't need the probe. */
  preflightDoctor?: (exitFn: (code: number) => void) => Promise<void>;
  /** Override TimerPort at composition root (test-only — production never sets it).
   *  The integration test wires `createFakeTimers()` to observe `unref()`/`cancel()`
   *  on every bootstrap interval, then asserts (post-shutdown) each was cancelled or
   *  unref'd — the `.unref()` preservation contract. */
  timers?: TimerPort;
  /**
   * Override the per-channelType activity-renderer factory at the composition
   * root (test seam). When provided, replaces the renderer produced by
   * `buildActivityRenderers` for a given channelType so an integration test can
   * inject a spy/TestSink it retains a reference to and assert `apply` fired on
   * a real inbound turn. Production must never set this; the override is test-only.
   */
  activityRendererFactory?: (channelType: string) => ChannelActivityRenderer | undefined;
}

// ---------------------------------------------------------------------------
// Session store bridge
// ---------------------------------------------------------------------------

/**
 * Shape of the session-store bridge object literal constructed inside
 * `bootGateway`. Captured as a named type so BootContext declares a precise
 * field type (rather than a TypeScript `object`) and so consumers can satisfy
 * the type without re-stating the literal. Mirrors the four-method facade
 * consumed by the RPC dispatch layer (rpc-dispatch.ts:88-101).
 */
export type SessionStoreBridge = {
  listDetailed: (tenantId?: string) => Array<{
    sessionKey: string;
    userId: string;
    channelId: string;
    metadata: Record<string, unknown>;
    createdAt: number;
    updatedAt: number;
    messageCount: number;
  }>;
  loadByFormattedKey: (sessionKey: string) => { messages: unknown[]; metadata: Record<string, unknown>; createdAt: number; updatedAt: number } | undefined;
  deleteByFormattedKey: (sessionKey: string) => boolean;
  saveByFormattedKey: (sessionKey: string, messages: unknown[], metadata?: Record<string, unknown>) => void;
};

// ---------------------------------------------------------------------------
// BootContext: single boot-time context
// ---------------------------------------------------------------------------

/**
 * Single boot-time context populated by 5 `boot*` helper functions in
 * `daemon.ts` (`bootFoundation`, `bootAgents`, `bootChannels`, `bootGateway`,
 * `bootShutdown`).
 *
 * Group A fields (foundation, ~60 strict) are always defined after
 * `bootFoundation` runs. Group B/C/D fields (agents/channels/gateway, ~85
 * optional) are `?` because they're not populated until the corresponding
 * `boot*` helper runs.
 *
 * Reads of optional fields use guard pattern: `if (!boot.X) throw …`. The
 * bootstrap-order runtime invariant is enforced by integration test
 * `test/integration/daemon-lifecycle.test.ts:89-99` (5 log lines emit in
 * source order).
 *
 * Replaces the prior 4-handle chain (foundation → agents → channels →
 * gateway handles, composed via `extends`).
 *
 * The 6 true forward-ref slots (`channelPluginsRef`, `bgNotifyRef`,
 * `cronWakeCallbackRef`, `gatewaySendRef`, `shutdownRef`,
 * `channelAdaptersRef`) are preserved as documented BootContext fields —
 * they are cross-stage forward refs that cannot be eliminated by reordering
 * construction.
 *
 * The 3 local-scope deferred refs (`sessionTrackerRef`, `toolAssemblerRef`,
 * `inboundMessageIdResolverRef`) are NOT declared on BootContext — they live
 * inside `bootChannels` as locals; a future refactor will eliminate them
 * entirely by reordering construction.
 */
// @optional-field-count: BootContext is the composition-root accumulator for
// the 5 boot* helpers. Group B/C/D fields are optional by design — they exist
// on the type but are unpopulated until the matching boot* helper runs. The
// integration test test/integration/daemon-lifecycle.test.ts:89-99 (5 log
// lines in source order) is the runtime invariant gate that replaces the
// prior compile-time 4-handle chain enforcement.
export interface BootContext {
  // ===========================================================================
  // Group A: foundation (strict, populated by bootFoundation)
  // ===========================================================================
  // Core (4 fields)
  container: Awaited<ReturnType<typeof bootstrap>> extends import("@comis/shared").Result<infer C, unknown> ? C : never;
  dataDir: string;
  configPaths: string[];
  envPath: string;
  // Runtime adapters (constructed at composition root, threaded through
  // later stages and consumer factories).
  clock: import("@comis/core").ClockPort;
  env: import("@comis/core").EnvPort;
  timers: import("@comis/core").TimerPort;
  // The single process-singleton ActivityCircuitBreaker, constructed once
  // in bootFoundation and threaded to `buildChannelManagerDeps` → `ChannelsDeps`
  // → the inbound coordinatorFactory, where it is shared across every per-turn
  // coordinator. Structurally the `ActivityBreakerGate` slice the coordinator
  // consumes (the concrete breaker's record/isTripped satisfy it).
  activityBreaker: import("@comis/orchestrator").ActivityBreakerGate;
  // Test-only renderer-injection seam, captured from the daemon override in
  // bootFoundation and threaded to `buildChannelManagerDeps` → `ChannelsDeps` →
  // `buildActivityRenderers` (named distinctly from the DaemonOverrides field, the
  // canonical test seam). Optional + default-undefined; production never sets it.
  activityRendererFactoryOverride?: (channelType: string) => ChannelActivityRenderer | undefined;
  // Secrets (5 fields) — secretStore is always wired
  secretStore: SecretStorePort;
  /** Daemon-owned write handle over the shared SecretManager backing Map.
   *  Threaded from bootFoundation to buildRpcDispatchDeps via PostChannelsBootContext.
   *  MUST NOT appear on AppContainer or any agent-accessible path. */
  mutableHandle: MutableSecretManager;
  secretsCrypto: import("@comis/core").SecretsCrypto | undefined;
  secretsDb: import("better-sqlite3").Database | undefined;
  permissionCorrections: PermissionCorrection[];
  // Config-git (2 fields)
  execGit: ReturnType<typeof createExecGit>;
  configGitManager: ReturnType<typeof createConfigGitManager> | undefined;
  // Logging (10 fields)
  logger: ReturnType<typeof setupLogging>["logger"];
  logLevelManager: ReturnType<typeof setupLogging>["logLevelManager"];
  daemonLogger: ReturnType<typeof setupLogging>["daemonLogger"];
  gatewayLogger: ReturnType<typeof setupLogging>["gatewayLogger"];
  channelsLogger: ReturnType<typeof setupLogging>["channelsLogger"];
  agentLogger: ReturnType<typeof setupLogging>["agentLogger"];
  schedulerLogger: ReturnType<typeof setupLogging>["schedulerLogger"];
  skillsLogger: ReturnType<typeof setupLogging>["skillsLogger"];
  memoryLogger: ReturnType<typeof setupLogging>["memoryLogger"];
  daemonVersion: string;
  // Observability (10). setupObservability is ASYNC (the OTel exporter seam) → Awaited.
  tokenTracker: Awaited<ReturnType<typeof setupObservability>>["tokenTracker"];
  sharedCostTracker: Awaited<ReturnType<typeof setupObservability>>["sharedCostTracker"];
  diagnosticCollector: Awaited<ReturnType<typeof setupObservability>>["diagnosticCollector"];
  billingEstimator: Awaited<ReturnType<typeof setupObservability>>["billingEstimator"];
  channelActivityTracker: Awaited<ReturnType<typeof setupObservability>>["channelActivityTracker"];
  deliveryTracer: Awaited<ReturnType<typeof setupObservability>>["deliveryTracer"];
  // The canonical ActivityStream (orchestrator-facing ActivityStreamPort)
  // + its drain hook, threaded from bootFoundation to bootShutdown.
  activityStream: Awaited<ReturnType<typeof setupObservability>>["activityStream"];
  disposeActivityStream: Awaited<ReturnType<typeof setupObservability>>["disposeActivityStream"]; spendAccumulator: Awaited<ReturnType<typeof setupObservability>>["spendAccumulator"]; otelHandle: Awaited<ReturnType<typeof setupObservability>>["otelHandle"]; // spendAccumulator = the dollars kill-switch (daemon-wide ref → bridge); otelHandle = the OTLP/Prometheus exporter handle → setupShutdown.
  contextPipelineCollector: ReturnType<typeof createContextPipelineCollector>;
  // Process (1 field)
  processMonitor: ReturnType<typeof setupHealth>["processMonitor"];
  // Memory + embedding (~14 fields)
  disposeEmbedding: Awaited<ReturnType<typeof setupMemory>>["disposeEmbedding"];
  cachedPort: Awaited<ReturnType<typeof setupMemory>>["cachedPort"];
  memoryAdapter: Awaited<ReturnType<typeof setupMemory>>["memoryAdapter"];
  db: Awaited<ReturnType<typeof setupMemory>>["db"];
  sessionStore: Awaited<ReturnType<typeof setupMemory>>["sessionStore"];
  memoryApi: Awaited<ReturnType<typeof setupMemory>>["memoryApi"];
  embeddingQueue: Awaited<ReturnType<typeof setupMemory>>["embeddingQueue"];
  backgroundIndexingPromise: Awaited<ReturnType<typeof setupMemory>>["backgroundIndexingPromise"];
  embeddingCacheStats: Awaited<ReturnType<typeof setupMemory>>["embeddingCacheStats"];
  embeddingCircuitBreakerState: Awaited<ReturnType<typeof setupMemory>>["embeddingCircuitBreakerState"];
  /** The daemon-owned per-tenant summarizer spend+breaker — threaded
   *  into setupAgents -> createPiExecutor -> setupContextEngine (the getSummarizerDeps
   *  leaf-seam gate). Built in setup-memory; ONE instance partitions by tenantId. */
  summarizerSpendBreaker: Awaited<ReturnType<typeof setupMemory>>["summarizerSpendBreaker"];
  rerankerPort: Awaited<ReturnType<typeof setupMemory>>["rerankerPort"];
  /** The no-download model-present probe result computed once in
   *  setup-memory. Carried through BootContext so bootAgents threads the SAME boolean into
   *  setupAgents (the per-agent effective rerank precedence consults one source). */
  rerankerModelPresent: Awaited<ReturnType<typeof setupMemory>>["rerankerModelPresent"];
  disposeReranker: Awaited<ReturnType<typeof setupMemory>>["disposeReranker"];
  /** Entity-associative store — threaded into setupAgents (executor recall
   *  read path) + the cron review (write path). Built in setup-memory on the shared db. */
  entityStore: Awaited<ReturnType<typeof setupMemory>>["entityStore"];
  /** LCD lossless context store — threaded into setupAgents (the
   *  executor `contextStore` -> the `dag` branch in context-engine.ts). Built in
   *  setup-memory on the shared db (`createLcdStore(db)`); injected as the CORE
   *  `ContextStorePort` TYPE on SingleAgentDeps (agent↛memory cut). The `dag`
   *  engine is opt-in (`contextEngine.version: "dag"`); the default stays pipeline,
   *  so absent/unselected this is dormant. */
  lcdStore: Awaited<ReturnType<typeof setupMemory>>["lcdStore"];
  /** LCD provenance READ store — threaded into
   *  setupAgents → createPiExecutor → prompt-assembly → createMemoryRecall's
   *  post-fusion provenance down-weighting pass. Built in setup-memory on the
   *  shared db (`buildProvenanceReadStore(db)`); the agent receives the core
   *  LcdProvenanceReadStore TYPE only (the agent↛memory cut). */
  provenanceStore: Awaited<ReturnType<typeof setupMemory>>["provenanceStore"];
  /** LCD read-only operator-browse store (ContextBrowsePort) — threaded into the
   *  context.* RPC dispatch deps to back the Context DAG browser's
   *  context.conversations. Built in setup-memory on the shared db
   *  (`createLcdBrowseStore(db)`). */
  contextBrowse: Awaited<ReturnType<typeof setupMemory>>["contextBrowse"];
  /** Temporal-spread store — threaded into setupAgents (the executor recall
   *  read path → createMemoryRecall) ONLY. NOT the cron/diagnostic paths. Built in setup-memory
   *  on the shared db; injected as the port TYPE (agent↛memory cut). Dormant until an operator
   *  enables `agents.<id>.rag.lanes.temporal.enabled` (default OFF). */
  temporalStore: Awaited<ReturnType<typeof setupMemory>>["temporalStore"];
  /** Causal store — threaded into setupAgents (the executor recall read
   *  path → createMemoryRecall, the 5th causal lane) AND the cron-review write path
   *  (registerCronEventListeners → runMemoryReview → linkCausal). Built in setup-memory on the
   *  shared db; injected as the port TYPE (agent↛memory cut). Dormant until an operator enables
   *  `agents.<id>.rag.lanes.causal.enabled` (default OFF); the write guards on extracted causes. */
  causalStore: Awaited<ReturnType<typeof setupMemory>>["causalStore"];
  /** Triple store — threaded into setupAgents (the executor recall read
   *  path → createMemoryRecall, the 6th graph-spread lane). Built in setup-memory on the shared
   *  db; injected as the port TYPE (agent↛memory cut). Dormant until an operator enables
   *  `agents.<id>.rag.lanes.graphSpread.enabled` (default OFF). */
  tripleStore: Awaited<ReturnType<typeof setupMemory>>["tripleStore"];
  /** Embedding read store — threaded into setupAgents (the executor recall
   *  read path → createMemoryRecall, the MMR diversity re-rank). Built in setup-memory on the
   *  shared db; injected as the port TYPE (agent↛memory cut). Dormant until an operator enables
   *  `agents.<id>.rag.mmr.enabled` (default OFF). */
  embeddingStore: Awaited<ReturnType<typeof setupMemory>>["embeddingStore"];
  /** Usefulness store — threaded into setupAgents (the executor recall
   *  read path → createMemoryRecall) + exposed to the memory.* diagnostic deps alongside its
   *  siblings. Built in setup-memory on the shared db; injected as the port TYPE (agent↛memory
   *  cut). Dormant until an operator enables `agents.<id>.rag.feedback.enabled` (default OFF). */
  usefulnessStore: Awaited<ReturnType<typeof setupMemory>>["usefulnessStore"];
  /** Memory-lifecycle sweep store — cron path ONLY (KEYLESS __MEMORY_LIFECYCLE__ → DORMANT
   *  runLifecycleSweep; NOT the executor recall path). Shared db; port TYPE only (agent↛memory cut).
   *  Dormant — even with `memoryLifecycle.enabled` (default OFF) the sweep evicts/demotes 0 rows. */
  memoryLifecycleStore: Awaited<ReturnType<typeof setupMemory>>["memoryLifecycleStore"];
  /** Consolidation store — no live writer or cron consumer. Shared db; port TYPE only (agent↛memory cut). */
  consolidationStore: Awaited<ReturnType<typeof setupMemory>>["consolidationStore"];
  outcomeStore: Awaited<ReturnType<typeof setupMemory>>["outcomeStore"]; // the __REFLECT__ cron success gate (agent↛memory cut)
  learnedSkillStore: Awaited<ReturnType<typeof setupMemory>>["learnedSkillStore"]; // the __REFLECT__ get/admit target
  learnedSkillSurfaceRegistry: import("./wiring/setup-agents/learned-skill-surface-registry.js").LearnedSkillSurfaceRegistry; // shared per-agent surface registry created in bootFoundation; bootAgents registers each agent + the promote/demote loop re-refreshes
  /** Live recall-counter wiring — the single `wireRecallCounters(eventBus)` subscriber (setup-memory holds the bus); threaded into MemoryApiDeps.recallCounters so `memory.recall_stats` reads the live gauge. */
  recallCounters: Awaited<ReturnType<typeof setupMemory>>["recallCounters"];
  maintenanceTick: Awaited<ReturnType<typeof setupMemory>>["maintenanceTick"];
  /** Outbound-message → trajectory capture (built in setup-memory behind the byte-identity gate); threaded into setupDeliveryQueue. `undefined` when learning-outcome is off for all agents. */
  recordOutboundMessage?: Awaited<ReturnType<typeof setupMemory>>["recordOutboundMessage"];
  /** Tear down the reaction/session trajectory maps + dedicated reaction rate limiter on shutdown (cancels their unref'd TTL timers). Threaded into setupShutdown. */
  destroyReactionWiring?: Awaited<ReturnType<typeof setupMemory>>["destroyReactionWiring"];
  obsStore: ObservabilityStore | undefined;
  obsPersistence: ObsPersistenceResult | undefined;
  // Runtime registries (4 fields)
  activeRunRegistry: ReturnType<typeof createActiveRunRegistry>;
  sessionResolver: ReturnType<typeof createBackgroundSessionResolver>;
  canaryFallbackSecret: string;
  injectionRateLimiter: ReturnType<typeof createInjectionRateLimiter>;
  // Session mirroring (3 fields)
  deliveryMirror: Awaited<ReturnType<typeof setupDeliveryMirror>>["deliveryMirror"];
  startMirrorPrune: Awaited<ReturnType<typeof setupDeliveryMirror>>["startPrune"];
  shutdownMirror: Awaited<ReturnType<typeof setupDeliveryMirror>>["shutdown"];
  // Gemini cache (1 field)
  geminiCacheManager: GeminiCacheManager;
  // Background tasks (1 field — manager is strict; bgNotifyFn is a forward-ref
  // closure populated by bootFoundation, declared in the "True forward refs"
  // section below).
  backgroundTaskManager: ReturnType<typeof setupBackgroundTasks>["backgroundTaskManager"];

  // ===========================================================================
  // Group B: agents (optional, populated by bootAgents)
  // ===========================================================================
  // Credential broker handle (optional — only present when executor.broker is configured)
  brokerHandle?: BrokerHandle;
  // Agents (core, 17 fields)
  defaultAgentId?: string;
  defaultWorkspaceDir?: string;
  agentsConfig?: Record<string, PerAgentConfig>;
  sessionManager?: Awaited<ReturnType<typeof setupAgents>>["sessionManager"];
  executors?: Awaited<ReturnType<typeof setupAgents>>["executors"];
  workspaceDirs?: Awaited<ReturnType<typeof setupAgents>>["workspaceDirs"];
  costTrackers?: Awaited<ReturnType<typeof setupAgents>>["costTrackers"];
  budgetGuards?: Awaited<ReturnType<typeof setupAgents>>["budgetGuards"];
  stepCounters?: Awaited<ReturnType<typeof setupAgents>>["stepCounters"];
  getExecutor?: Awaited<ReturnType<typeof setupAgents>>["getExecutor"];
  piSessionAdapters?: Awaited<ReturnType<typeof setupAgents>>["piSessionAdapters"];
  skillWatcherHandles?: Awaited<ReturnType<typeof setupAgents>>["skillWatcherHandles"];
  skillRegistries?: Awaited<ReturnType<typeof setupAgents>>["skillRegistries"];
  lockCleanupTimer?: Awaited<ReturnType<typeof setupAgents>>["lockCleanupTimer"];
  singleAgentDeps?: Awaited<ReturnType<typeof setupAgents>>["singleAgentDeps"];
  providerHealth?: Awaited<ReturnType<typeof setupAgents>>["providerHealth"];
  oauthCredentialStore?: Awaited<ReturnType<typeof setupAgents>>["oauthCredentialStore"];
  toolCapabilityPorts?: Awaited<ReturnType<typeof setupAgents>>["toolCapabilityPorts"];
  /** Session-scoped trajectory recorder registry. Drained on shutdown. */
  trajectoryRegistry?: Awaited<ReturnType<typeof setupAgents>>["trajectoryRegistry"];
  /** Per-agent ExecutionPlanHolder reference map (typed as the read-only port). Surfaces the
   * per-agent holder so the daemon can thread the DEFAULT agent's reference into
   * ChannelsDeps.executionPlanPort — the SAME object createAcpWiring shares (single-shared-holder). */
  executionPlanPorts?: Awaited<ReturnType<typeof setupAgents>>["executionPlanPorts"];
  /** Per-agent OAuthTokenManager map. The DEFAULT agent's manager is threaded into
   * buildImageGenBundle → the Codex image adapter so the image path resolves its OAuth
   * bearer. Populated by bootAgents' setupAgents Object.assign; read by bootChannels. */
  oauthManagers?: Awaited<ReturnType<typeof setupAgents>>["oauthManagers"];
  /** Per-agent pi AuthStorage map — assigned alongside oauthManagers (above); the
   * memory.ask dialectic OAuth resolver's runtime-override target. */
  authStorages?: Awaited<ReturnType<typeof setupAgents>>["authStorages"];
  mcpClientManager?: Awaited<ReturnType<typeof setupMcp>>["mcpClientManager"];
  /** The ONE mode-selected MCP OAuth token store (selectMcpTokenStore), constructed at the
   * composition root in bootAgents and threaded as the SAME instance into both consumers:
   * setupMcp's manager wiring (consumed at construction) AND the login/handler path
   * (buildRpcDispatchDeps reads it for createTokenStore). Undefined in env mode (no writable
   * MCP OAuth persistence); kills the encrypted-mode split-brain. */
  mcpTokenStore?: Awaited<ReturnType<typeof selectMcpTokenStore>>;
  /** Daemon-owned collector — one served-vs-configured comparison
   *  per provider, populated in setup-agents (bootAgents), read at the bootShutdown posture
   *  write (servedBelowConfiguredCount — one comparison, two surfaces, no drift). */
  servedWindowComparisons?: Map<string, import("@comis/agent").ServedWindowComparison>;
  /** Daemon-owned collector of per-agent boot window info (configured
   *  + reconciled effective window + profile), populated in setup-agents (bootAgents),
   *  consumed by the bootChannels viable-floor loop between setupTools and setupChannels. */
  agentBootWindowInfo?: Map<string, import("@comis/agent").AgentBootWindowInfo>;
  // Restart continuation tracker
  continuationTracker?: ReturnType<typeof createRestartContinuationTracker>;
  // Subprocess envs
  subprocessEnv?: Record<string, string>;
  execToolEnv?: Record<string, string>;
  // The LATE-BOUND bounded-autonomy seam (bootAgents → boot → cap layer populates/shares it).
  boundedAutonomyBudgetHolder?: BoundedAutonomyBudgetHolder;
  resolveRootRunId?: (sessionKey: SessionKey) => string;
  sharedLeaseManager?: LeaseManager;
  // Schedulers
  systemEventQueue?: ReturnType<typeof createSystemEventQueue>;
  cronSchedulers?: Awaited<ReturnType<typeof setupSchedulers>>["cronSchedulers"];
  executionTrackers?: Awaited<ReturnType<typeof setupSchedulers>>["executionTrackers"];
  browserServices?: Awaited<ReturnType<typeof setupSchedulers>>["browserServices"];
  resetSchedulers?: Awaited<ReturnType<typeof setupSchedulers>>["resetSchedulers"];
  getAgentCronScheduler?: Awaited<ReturnType<typeof setupSchedulers>>["getAgentCronScheduler"];
  getAgentBrowserService?: Awaited<ReturnType<typeof setupSchedulers>>["getAgentBrowserService"];
  sessionTrackerRegistry?: SessionTrackerRegistry<ReturnType<typeof createFileStateTracker>>;
  auditAggregator?: ReturnType<typeof createAuditAggregator>;
  onSuspiciousContent?: WrapExternalContentOptions["onSuspiciousContent"];
  // Media
  ttsAdapter?: Awaited<ReturnType<typeof setupMedia>>["ttsAdapter"];
  visionRegistry?: Awaited<ReturnType<typeof setupMedia>>["visionRegistry"];
  /** Stable holder for the vision registry — updated on first
   *  materialisation (undefined → Map) so late-bound consumers observe rotation. */
  visionRegistryHolder?: Awaited<ReturnType<typeof setupMedia>>["visionRegistryHolder"];
  linkRunner?: Awaited<ReturnType<typeof setupMedia>>["linkRunner"];
  mediaTempManager?: Awaited<ReturnType<typeof setupMedia>>["mediaTempManager"];
  mediaSemaphore?: Awaited<ReturnType<typeof setupMedia>>["mediaSemaphore"];
  audioConverter?: Awaited<ReturnType<typeof setupMedia>>["audioConverter"];
  transcriber?: Awaited<ReturnType<typeof setupMedia>>["transcriber"];
  ssrfFetcher?: Awaited<ReturnType<typeof setupMedia>>["ssrfFetcher"];
  fileExtractor?: Awaited<ReturnType<typeof setupMedia>>["fileExtractor"];
  /** Boot-resolved STT/TTS selections for the media RPC trajectory emit. */
  voiceSelection?: Awaited<ReturnType<typeof setupMedia>>["voiceSelection"];
  // RPC bridge (deferred-dispatch)
  rpcCall?: ReturnType<typeof setupRpcBridge>["rpcCall"];
  wireDispatch?: ReturnType<typeof setupRpcBridge>["wireDispatch"];
  // Approval gate
  approvalGate?: ReturnType<typeof createApprovalGate>;
  // Interactive-callback wiring: signer + single-use email link minter + gateway
  // approval-token map/resolver + the InteractiveCallbackRouter. Built in the agents
  // phase; consumed by bootChannels (signer/minter) + bootGateway (token map/route).
  interactiveCallbackWiring?: import("./wiring/setup-interactive-callback.js").InteractiveCallbackWiring;
  // Delivery queue (channelAdaptersRef is a forward ref — declared below)
  deliveryQueue?: Awaited<ReturnType<typeof setupDeliveryQueue>>["deliveryQueue"];
  drainAndStartDeliveryPrune?: Awaited<ReturnType<typeof setupDeliveryQueue>>["drainAndStart"];
  shutdownDeliveryQueue?: Awaited<ReturnType<typeof setupDeliveryQueue>>["shutdown"];
  // Durable-run + resume engine outputs (undefined when off); shutdown cancels the watchdog.
  durableRunStore?: import("@comis/core").DurableRunPort;
  outwardLedger?: import("@comis/core").OutwardSendLedgerPort;
  durableResumeShutdown?: () => void;

  // ===========================================================================
  // Group C: channels (optional, populated by bootChannels)
  // ===========================================================================
  // Channels (core)
  adaptersByType?: Awaited<ReturnType<typeof setupChannels>>["adaptersByType"];
  channelManager?: Awaited<ReturnType<typeof setupChannels>>["channelManager"];
  resolveAttachment?: Awaited<ReturnType<typeof setupChannels>>["resolveAttachment"];
  lifecycleReactors?: Awaited<ReturnType<typeof setupChannels>>["lifecycleReactors"];
  channelPlugins?: Awaited<ReturnType<typeof setupChannels>>["channelPlugins"];
  commandQueue?: Awaited<ReturnType<typeof setupChannels>>["commandQueue"];
  deliveryService?: Awaited<ReturnType<typeof setupChannels>>["deliveryService"];
  inboundMessageIdResolver?: InboundMessageIdResolver;
  // Channel health monitor
  channelHealthMonitor?: ChannelHealthMonitor;
  stopChannelHealthMonitor?: () => void;
  // Notifications + background completion
  notificationContext?: ReturnType<typeof setupNotifications>;
  bgCompletionRunnerContext?: ReturnType<typeof setupBackgroundCompletionRunner>;
  // Terminal-driver wake-FSM — drained on shutdown.
  terminalWakeContext?: ReturnType<typeof setupTerminalWake>;
  // Cross-session + sub-agent runtime
  crossSessionSender?: ReturnType<typeof setupCrossSession>["crossSessionSender"];
  subAgentRunner?: ReturnType<typeof setupCrossSession>["subAgentRunner"];
  sendToChannel?: ReturnType<typeof setupCrossSession>["sendToChannel"];
  announceToParent?: ReturnType<typeof setupCrossSession>["announceToParent"];
  deadLetterQueue?: ReturnType<typeof setupCrossSession>["deadLetterQueue"];
  announcementBatcher?: ReturnType<typeof setupCrossSession>["announcementBatcher"];
  // Sandbox + image generation capability layer (built in bootChannels, read in bootShutdown).
  sandboxProvider?: SandboxProvider;
  capEndpointHandle?: import("./wiring/setup-capability-endpoint-boot.js").CapabilityLayerHandle;
  namespacePreflightOk?: boolean;
  imageGenProvider?: ReturnType<typeof createImageGenProvider> extends import("@comis/shared").Result<infer P, unknown> ? P | undefined : never;
  imageGenRateLimiter?: ImageGenRateLimiter;
  imageGenConfig?: BootContext["container"]["config"]["integrations"]["media"]["imageGeneration"];
  /** Per-agent persist getter from buildImageGenBundle — persists
   *  the generated image to the agent's confined workspace (`~/.comis/workspace/
   *  media/photos/`) via MediaPersistenceService. Folded onto imageHandlerDeps
   *  (daemon.ts:932) as the `persist` dep; the handler hands the returned
   *  filePath to sendAttachment (no more tmpdir write+delete). */
  persistImage?: (
    agentId: string,
    buffer: Buffer,
    opts: { mediaKind: "image"; mimeType: string },
  ) => Promise<import("@comis/shared").Result<import("@comis/skills/tools").PersistedFile, Error>>;
  /** Per-agent/hour USD cost ceiling from buildImageGenBundle.
   *  Undefined when `maxCostPerHourUsd` is unset (ceiling skipped, count-only).
   *  Folded onto imageHandlerDeps (daemon.ts:932) as the `costLimiter` dep. */
  imageGenCostLimiter?: import("./api/image-cost-limiter.js").ImageCostLimiter;
  // Video generation — the buildVideoGenBundle outputs,
  // mirroring the image-gen fields. Folded onto videoHandlerDeps in
  // buildVideoHandlerDeps; daemon.ts threads them through the boot context.
  videoGenProvider?: ReturnType<typeof createVideoGenProvider> extends import("@comis/shared").Result<infer P, unknown> ? P | undefined : never;
  videoGenRateLimiter?: VideoGenRateLimiter;
  videoGenConfig?: BootContext["container"]["config"]["integrations"]["media"]["videoGeneration"];
  /** Per-agent persist getter from buildVideoGenBundle — persists
   *  the generated video to `~/.comis/workspace/media/videos/` (raised maxBytes).
   *  Folded onto videoHandlerDeps as the `persist` dep. */
  persistVideo?: (
    agentId: string,
    buffer: Buffer,
    opts: { mediaKind: "video"; mimeType: string },
  ) => Promise<import("@comis/shared").Result<import("@comis/skills/tools").PersistedFile, Error>>;
  /** Per-agent/hour video USD cost ceiling, gated
   *  PRE-submit. Undefined when `maxCostPerHourUsd` is unset (count-only). Folded
   *  onto videoHandlerDeps as the `costLimiter` dep. */
  videoGenCostLimiter?: import("./api/video-cost-limiter.js").VideoCostLimiter;
  /** The durable async video-job store (shared memory.db), built in
   *  buildVideoGenBundle; folded onto videoHandlerDeps (insert-on-submit). */
  videoJobStore?: import("@comis/memory").VideoJobStore;
  /** The two-phase background poller, built in buildVideoGenBundle;
   *  started post-setupChannels + shut down via setupShutdown; on videoHandlerDeps. */
  videoPoller?: import("./wiring/setup-video-poller.js").VideoPoller;
  /** The provider-following vision bundle from buildMediaVisionBundle
   *  — `capability` is the main-provider vision bridge (folded onto
   *  MediaApiDeps.mainProviderVision) and `resolveMainModelId` is the single-source
   *  main model-id resolver (folded onto MediaApiDeps.mainModelIdFor for the
   *  handler-side vision gate). Built beside buildImageGenBundle at the same
   *  construction site, reusing the DEFAULT agent's OAuth manager + boot clock.
   *  Inlined (not `ReturnType<typeof buildMediaVisionBundle>`) to keep
   *  daemon-types.ts free of an import edge back to wiring/main-helpers.ts (which
   *  imports BootContext from here — a cycle). */
  mediaVisionBundle?: {
    capability: import("./api/main-provider-vision.js").MainProviderVision;
    resolveMainModelId: (agentId: string) => string | undefined;
  };
  // Tools (assembler + preprocessor)
  assembleToolsForAgent?: ReturnType<typeof setupTools>["assembleToolsForAgent"];
  preprocessMessageText?: ReturnType<typeof setupTools>["preprocessMessageText"];
  /** Per-agent terminal session registries: threaded to bootGateway
   *  so the webhook route can reap a turn's LIVE never-tasked drives (the unattended honest-fail backstop). */
  terminalRegistries?: ReturnType<typeof setupTools>["terminalRegistries"];
  getCapabilityPortForAgent?: (agentId: string) => ToolCapabilityPort;
  // Monitoring + heartbeat
  heartbeatRunner?: ReturnType<typeof setupMonitoring>["heartbeatRunner"];
  duplicateDetector?: ReturnType<typeof setupMonitoring>["duplicateDetector"];
  perAgentRunner?: ReturnType<typeof setupHeartbeat>["perAgentRunner"];
  wakeCoalescer?: ReturnType<typeof createWakeCoalescer>;
  // Graph
  nodeTypeRegistry?: ReturnType<typeof createNodeTypeRegistry>;
  graphCoordinator?: ReturnType<typeof createGraphCoordinator>;
  namedGraphStore?: ReturnType<typeof createNamedGraphStore>;
  // Agent management runtime state
  suspendedAgents?: Set<string>;
  modelCatalog?: ReturnType<typeof createModelCatalog>;
  channelConfig?: Record<string, { enabled: boolean }>;
  promptTimeoutTimestamps?: number[];
  // Teardown handles surfaced from bootChannels for ShutdownDeps wiring.
  /** Drain per-agent background-process registries (from setupTools). */
  shutdownBackgroundProcesses?: ReturnType<typeof setupTools>["shutdownBackgroundProcesses"];
  /** Cleanup proxy typing controllers + sweep timer (from registerProxyTypingListeners). */
  proxyTypingCleanup?: ReturnType<typeof setupCrossSession>["proxyTypingCleanup"];
  /** Output retention housekeeper handle (from setupOutputRetention). Undefined when defaultWorkspaceDir is empty. */
  outputRetentionHandle?: ReturnType<typeof setupOutputRetention>;

  // ===========================================================================
  // Group D: gateway (optional, populated by bootGateway)
  // ===========================================================================
  // Token registry (4 fields)
  tokenRegistry?: ReturnType<typeof createTokenRegistry>;
  runtimeTokens?: Array<{ id: string; secretBuf: Buffer; scopes: string[] }>;
  removedTokenIds?: Set<string>;
  resolvedGatewayTokens?: Array<{ id: string; secret: string; scopes: string[] }>;
  // Session store bridge (1 field)
  sessionStoreBridge?: SessionStoreBridge;
  // Hot-add / hot-remove closures (2 fields)
  // `rawRerankEnabled` is the RAW (pre-Zod-default) rag.rerank.enabled from the
  // agents.create RPC input — threaded so the hot-added agent's effective-rerank
  // precedence sees genuine unset (undefined) vs explicit-off, same as the boot path.
  hotAdd?: (agentId: string, config: PerAgentConfig, rawRerankEnabled?: boolean | undefined) => Promise<void>;
  hotRemove?: (agentId: string) => Promise<void>;
  // RPC dispatch deps (1 field; mutated post-gateway-init for wsConnections/mediaDir/onGatewayAttachment)
  rpcDispatchDeps?: import("./api/rpc-dispatch.js").ApiDispatchDeps;
  // Gateway server (4 fields)
  gatewayHandle?: GatewayServerHandle;
  activeExecutions?: Map<string, { agentId: string; startedAt: number }>;
  getActiveConnectionCount?: () => number;
  wsConnections?: WsConnectionManager;

  // ===========================================================================
  // True forward refs (preserved as documented)
  // ===========================================================================
  // These cross-stage refs cannot be eliminated by reordering construction.
  // Each is a workaround for circular construction order between stages.
  /** Populated by bootChannels; read by bootAgents' getChannelMaxChars lambda. */
  channelPluginsRef: { ref?: Map<string, import("@comis/core").ChannelPluginPort> };
  /** Populated by bootChannels; read by bgNotifyFn closure constructed in bootFoundation. */
  bgNotifyRef: { ref?: import("./notification/notification-service.js").NotificationService };
  /** Closure constructed in bootFoundation; reads bgNotifyRef.ref at call time. */
  bgNotifyFn: (opts: { agentId: string; message: string; priority: "normal"; origin: "background_task" }) => Promise<void>;
  /** Populated by bootChannels post-wakeCoalescer; read by setupSchedulers onCronWake (bootAgents). */
  cronWakeCallbackRef?: { ref?: (reason: string) => void };
  /** Populated by bootGateway post-setupGateway; read by setupCrossSession's gatewaySend (bootChannels). */
  gatewaySendRef?: { ref?: (channelId: string, text: string) => boolean };
  /** Populated by bootShutdown post-setupShutdown; read by hot-add closure (bootGateway). */
  shutdownRef?: { value?: { readonly isShuttingDown: boolean } };
  /**
   * Two-phase delivery-queue lifecycle: queue created BEFORE channels;
   * adapters registered AFTER channels return (wirePostChannelsLifecycle loop).
   * The indirection is the Map itself, populated post-stage.
   */
  channelAdaptersRef?: Map<string, DeliveryAdapter>;
}

/**
 * Factory that returns a BootContext with only the 2 forward-ref slot objects
 * eagerly initialized (`channelPluginsRef`, `bgNotifyRef`). All other fields —
 * including Group A (strict) — are uninitialized; the 5 `boot*` helpers populate
 * them in sequence.
 *
 * The cast through `as unknown as BootContext` is the documented trade-off:
 * Group A fields are strictly typed (no `?`) but cannot be fully populated at
 * construction time. Reads before population fail at runtime — the integration
 * test `test/integration/daemon-lifecycle.test.ts:89-99` (5 log lines in source
 * order) is the regression gate.
 *
 * Why eager init for the 2 forward refs: closures captured during
 * `bootFoundation` (`getChannelMaxChars` for setupAgents, `bgNotifyFn` for
 * backgroundTaskManager) read `.ref` at invocation time, so the container
 * object MUST exist before bootAgents/bootChannels run.
 */
export function createEmptyBootContext(): BootContext {
  return {
    channelPluginsRef: { ref: undefined },
    bgNotifyRef: { ref: undefined },
    // bgNotifyFn is non-optional but is assigned in bootFoundation; the
    // factory cast allows incremental population.
  } as unknown as BootContext;
}

/**
 * Pre-dispatch slice used by buildRpcDispatchDeps to pass through gateway-local
 * data not yet on the broader BootContext at wireDispatch time.
 *
 * Each field is wrapped in `NonNullable<>` because bootGateway guarantees they
 * are populated by the time buildRpcDispatchDeps runs — even though the
 * underlying BootContext fields are declared `?` (uninitialized pre-bootGateway).
 */
export type GatewayPreDispatchSlice = {
  tokenRegistry: NonNullable<BootContext["tokenRegistry"]>;
  runtimeTokens: NonNullable<BootContext["runtimeTokens"]>;
  removedTokenIds: NonNullable<BootContext["removedTokenIds"]>;
  sessionStoreBridge: NonNullable<BootContext["sessionStoreBridge"]>;
  hotAdd: NonNullable<BootContext["hotAdd"]>;
  hotRemove: NonNullable<BootContext["hotRemove"]>;
};
