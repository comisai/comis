// SPDX-License-Identifier: Apache-2.0
/**
 * Public types for the daemon entry point.
 *
 * Single source of truth for the daemon's public interface types and the
 * inter-stage Handle interfaces (FoundationHandle, AgentsHandle,
 * ChannelsHandle, GatewayHandle), the SessionStoreBridge structural type,
 * the GatewayPreDispatchSlice helper Pick, and the PermissionCorrection
 * record. Shared between daemon.ts and the stages/* helper modules
 * without an import cycle (helpers accept handles as parameters; daemon.ts
 * composes them into the DaemonInstance return).
 *
 * @module
 */

import type { DeviceIdentity, TimerPort } from "@comis/core";
import type { AppContainer, ChannelPort, DeliveryQueuePort, DeliveryAdapter } from "@comis/core";
import type { ApprovalGate } from "@comis/core";
import type { ChannelHealthMonitor } from "@comis/channels";
import type { ComisLogger } from "@comis/infra";
import type { SessionResetScheduler, BackgroundTaskManager } from "@comis/agent";
import type { GatewayServerHandle, WsConnectionManager } from "@comis/gateway";
import type {
  HeartbeatRunner,
  CronScheduler,
} from "@comis/scheduler";
import type { BrowserService, SandboxProvider, ImageGenRateLimiter } from "@comis/skills";
import type { RpcCall } from "@comis/skills/platform-tools";
import type { LatencyRecorder } from "./observability/latency-recorder.js";
import type { LogLevelManager } from "./observability/log-infra.js";
import type { TokenTracker } from "./observability/token-tracker.js";
import type { DiagnosticCollector } from "./observability/diagnostic-collector.js";
import type { BillingEstimator } from "./observability/billing-estimator.js";
import type { ChannelActivityTracker } from "./observability/channel-activity-tracker.js";
import type { DeliveryTracer } from "./observability/delivery-tracer.js";
import type { ShutdownHandle } from "./process/graceful-shutdown.js";
import type { ProcessMonitor } from "./process/process-monitor.js";
import type { WatchdogHandle } from "./health/watchdog.js";

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
import type { createFileStateTracker, createImageGenProvider } from "@comis/skills";
import type { createTracingLogger } from "./observability/trace-logger.js";
import type { createLogLevelManager } from "./observability/log-infra.js";
import type { createTokenTracker } from "./observability/token-tracker.js";
import type { createLatencyRecorder } from "./observability/latency-recorder.js";
import type { createProcessMonitor } from "./process/process-monitor.js";
import type { registerGracefulShutdown } from "./process/graceful-shutdown.js";
import type { startWatchdog } from "./health/watchdog.js";
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
  setupTools,
  setupMonitoring,
  setupHeartbeat,
  setupTaskExtraction,
  setupRpcBridge,
  setupDeliveryQueue,
  setupDeliveryMirror,
  setupOutputRetention,
  setupNotifications,
  setupBackgroundTasks,
  setupBackgroundCompletionRunner,
} from "./wiring/index.js";
import type { createNamedGraphStore } from "@comis/memory";
import type { createContextStore } from "@comis/memory";
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
 * Used by stageFoundation to log corrections after the logger is available.
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
  readonly latencyRecorder: LatencyRecorder;
  readonly processMonitor: ProcessMonitor;
  readonly shutdownHandle: ShutdownHandle;
  readonly watchdogHandle: WatchdogHandle;
  readonly cronSchedulers: Map<string, CronScheduler>;
  readonly resetSchedulers: Map<string, SessionResetScheduler>;
  readonly browserServices: Map<string, BrowserService>;
  readonly heartbeatRunner?: HeartbeatRunner;
  readonly gatewayHandle?: GatewayServerHandle;
  readonly adapterRegistry: Map<string, ChannelPort>;
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
  readonly deviceIdentity?: DeviceIdentity;
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
  /** Override createTracingLogger. */
  createTracingLogger?: typeof createTracingLogger;
  /** Override createLogLevelManager. */
  createLogLevelManager?: typeof createLogLevelManager;
  /** Override createTokenTracker. */
  createTokenTracker?: typeof createTokenTracker;
  /** Override createLatencyRecorder. */
  createLatencyRecorder?: typeof createLatencyRecorder;
  /** Override createProcessMonitor. */
  createProcessMonitor?: typeof createProcessMonitor;
  /** Override registerGracefulShutdown. */
  registerGracefulShutdown?: typeof registerGracefulShutdown;
  /** Override startWatchdog. */
  startWatchdog?: typeof startWatchdog;
  /** Override createGatewayServer. */
  createGatewayServer?: typeof createGatewayServer;
  /** Override setupMedia for test isolation (avoids ffmpeg/ffprobe spawns). */
  setupMedia?: typeof setupMedia;
  /** Override process.exit for testing. */
  exit?: (code: number) => void;
  /** Override native-dep preflight check for tests that don't need the probe. */
  preflightDoctor?: (exitFn: (code: number) => void) => Promise<void>;
  /**
   * Override TimerPort at composition root.
   *
   * When provided, replaces the production `createSystemTimers()` adapter in
   * the daemon composition root. The integration test wires a `createFakeTimers()`
   * here so it can observe `unref()` / `cancel()` invocations on every long-
   * running interval scheduled during bootstrap, then assert (after shutdown)
   * that every entry was either cancelled or unref'd — proving the
   * `.unref()` preservation contract.
   *
   * Production must never set this; the override is test-only.
   */
  timers?: TimerPort;
}

// ---------------------------------------------------------------------------
// Inter-stage Handle interfaces
// ---------------------------------------------------------------------------

/**
 * Handle returned by `stageFoundation`. Consumed by later stages (stageAgents,
 * stageChannels, stageGateway, stageShutdown) and by the remainder of `main()`.
 *
 * Every field listed here is either:
 *   - consumed by a later stage call, OR
 *   - returned to callers via DaemonInstance, OR
 *   - read by main()'s tail.
 */
export interface FoundationHandle {
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
  // Secrets (4 fields)
  secretStore: SecretStorePort | undefined;
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
  // Observability (8 fields)
  tokenTracker: ReturnType<typeof setupObservability>["tokenTracker"];
  latencyRecorder: ReturnType<typeof setupObservability>["latencyRecorder"];
  sharedCostTracker: ReturnType<typeof setupObservability>["sharedCostTracker"];
  diagnosticCollector: ReturnType<typeof setupObservability>["diagnosticCollector"];
  billingEstimator: ReturnType<typeof setupObservability>["billingEstimator"];
  channelActivityTracker: ReturnType<typeof setupObservability>["channelActivityTracker"];
  deliveryTracer: ReturnType<typeof setupObservability>["deliveryTracer"];
  contextPipelineCollector: ReturnType<typeof createContextPipelineCollector>;
  // Process (3 fields)
  processMonitor: ReturnType<typeof setupHealth>["processMonitor"];
  watchdogHandle: ReturnType<typeof setupHealth>["watchdogHandle"];
  deviceIdentity: ReturnType<typeof setupHealth>["deviceIdentity"];
  // Memory + embedding (~11 fields)
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
  maintenanceTick: Awaited<ReturnType<typeof setupMemory>>["maintenanceTick"];
  obsStore: ObservabilityStore | undefined;
  obsPersistence: ObsPersistenceResult | undefined;
  contextStore: ReturnType<typeof createContextStore>;
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
  // Deferred refs populated by later stages
  channelPluginsRef: { ref?: Map<string, import("@comis/core").ChannelPluginPort> };
  backgroundTaskManager: ReturnType<typeof setupBackgroundTasks>["backgroundTaskManager"];
  bgNotifyRef: { ref?: import("./notification/notification-service.js").NotificationService };
  bgNotifyFn: (opts: { agentId: string; message: string; priority: "normal"; origin: "background_task" }) => Promise<void>;
}

/**
 * Handle returned by `stageAgents`. Extends `FoundationHandle` so main() and
 * later stages can keep a single destructure surface.
 *
 * stageAgents owns the agent-runtime startup block (agents map, executors,
 * mcpClientManager, schedulers, media, RPC bridge, approval gate with
 * restore, delivery queue). cronWakeCallbackRef is a deferred-ref slot
 * populated by stageChannels once wakeCoalescer is constructed.
 */
export interface AgentsHandle extends FoundationHandle {
  // Agents (core)
  defaultAgentId: string;
  defaultWorkspaceDir: string;
  agentsConfig: Record<string, PerAgentConfig>;
  sessionManager: Awaited<ReturnType<typeof setupAgents>>["sessionManager"];
  executors: Awaited<ReturnType<typeof setupAgents>>["executors"];
  workspaceDirs: Awaited<ReturnType<typeof setupAgents>>["workspaceDirs"];
  costTrackers: Awaited<ReturnType<typeof setupAgents>>["costTrackers"];
  budgetGuards: Awaited<ReturnType<typeof setupAgents>>["budgetGuards"];
  stepCounters: Awaited<ReturnType<typeof setupAgents>>["stepCounters"];
  getExecutor: Awaited<ReturnType<typeof setupAgents>>["getExecutor"];
  piSessionAdapters: Awaited<ReturnType<typeof setupAgents>>["piSessionAdapters"];
  skillWatcherHandles: Awaited<ReturnType<typeof setupAgents>>["skillWatcherHandles"];
  skillRegistries: Awaited<ReturnType<typeof setupAgents>>["skillRegistries"];
  lockCleanupTimer: Awaited<ReturnType<typeof setupAgents>>["lockCleanupTimer"];
  singleAgentDeps: Awaited<ReturnType<typeof setupAgents>>["singleAgentDeps"];
  providerHealth: Awaited<ReturnType<typeof setupAgents>>["providerHealth"];
  oauthCredentialStore: Awaited<ReturnType<typeof setupAgents>>["oauthCredentialStore"];
  toolCapabilityPorts: Awaited<ReturnType<typeof setupAgents>>["toolCapabilityPorts"];
  /** Session-scoped trajectory recorder registry. Drained on shutdown. */
  trajectoryRegistry: Awaited<ReturnType<typeof setupAgents>>["trajectoryRegistry"];
  mcpClientManager: Awaited<ReturnType<typeof setupMcp>>["mcpClientManager"];
  // Restart continuation tracker
  continuationTracker: ReturnType<typeof createRestartContinuationTracker>;
  // Subprocess envs
  subprocessEnv: Record<string, string>;
  execToolEnv: Record<string, string>;
  // Schedulers
  systemEventQueue: ReturnType<typeof createSystemEventQueue>;
  cronSchedulers: Awaited<ReturnType<typeof setupSchedulers>>["cronSchedulers"];
  executionTrackers: Awaited<ReturnType<typeof setupSchedulers>>["executionTrackers"];
  browserServices: Awaited<ReturnType<typeof setupSchedulers>>["browserServices"];
  resetSchedulers: Awaited<ReturnType<typeof setupSchedulers>>["resetSchedulers"];
  getAgentCronScheduler: Awaited<ReturnType<typeof setupSchedulers>>["getAgentCronScheduler"];
  getAgentBrowserService: Awaited<ReturnType<typeof setupSchedulers>>["getAgentBrowserService"];
  sessionTrackerRegistry: SessionTrackerRegistry<ReturnType<typeof createFileStateTracker>>;
  extractFromConversation: ReturnType<typeof setupTaskExtraction>["extractFromConversation"];
  auditAggregator: ReturnType<typeof createAuditAggregator>;
  onSuspiciousContent: WrapExternalContentOptions["onSuspiciousContent"];
  // Media
  ttsAdapter: Awaited<ReturnType<typeof setupMedia>>["ttsAdapter"];
  visionRegistry: Awaited<ReturnType<typeof setupMedia>>["visionRegistry"];
  linkRunner: Awaited<ReturnType<typeof setupMedia>>["linkRunner"];
  mediaTempManager: Awaited<ReturnType<typeof setupMedia>>["mediaTempManager"];
  mediaSemaphore: Awaited<ReturnType<typeof setupMedia>>["mediaSemaphore"];
  audioConverter: Awaited<ReturnType<typeof setupMedia>>["audioConverter"];
  transcriber: Awaited<ReturnType<typeof setupMedia>>["transcriber"];
  ssrfFetcher: Awaited<ReturnType<typeof setupMedia>>["ssrfFetcher"];
  fileExtractor: Awaited<ReturnType<typeof setupMedia>>["fileExtractor"];
  // RPC bridge (deferred-dispatch)
  rpcCall: ReturnType<typeof setupRpcBridge>["rpcCall"];
  wireDispatch: ReturnType<typeof setupRpcBridge>["wireDispatch"];
  // Approval gate
  approvalGate: ReturnType<typeof createApprovalGate>;
  // Delivery queue
  channelAdaptersRef: Map<string, import("@comis/core").DeliveryAdapter>;
  deliveryQueue: Awaited<ReturnType<typeof setupDeliveryQueue>>["deliveryQueue"];
  drainAndStartDeliveryPrune: Awaited<ReturnType<typeof setupDeliveryQueue>>["drainAndStart"];
  shutdownDeliveryQueue: Awaited<ReturnType<typeof setupDeliveryQueue>>["shutdown"];
  // Deferred wake-callback ref (populated in stageChannels post-wakeCoalescer)
  cronWakeCallbackRef: { ref?: (reason: string) => void };
}

/**
 * Handle returned by `stageChannels`. Extends `AgentsHandle` so main() and
 * later stages keep a single destructure surface.
 *
 * stageChannels owns the channel-runtime startup block (channel adapters,
 * cross-session sender + subAgentRunner, sandbox/image-gen providers, tools,
 * heartbeat, wake coalescer, graph coordinator, monitoring, agent management
 * runtime state). The deferred cronWakeCallback ref is populated inside
 * stageChannels once wakeCoalescer is constructed.
 */
export interface ChannelsHandle extends AgentsHandle {
  // Channels (core)
  adaptersByType: Awaited<ReturnType<typeof setupChannels>>["adaptersByType"];
  channelManager: Awaited<ReturnType<typeof setupChannels>>["channelManager"];
  resolveAttachment: Awaited<ReturnType<typeof setupChannels>>["resolveAttachment"];
  lifecycleReactors: Awaited<ReturnType<typeof setupChannels>>["lifecycleReactors"];
  channelPlugins: Awaited<ReturnType<typeof setupChannels>>["channelPlugins"];
  channelCapabilities: Awaited<ReturnType<typeof setupChannels>>["channelCapabilities"];
  commandQueue: Awaited<ReturnType<typeof setupChannels>>["commandQueue"];
  deliveryService: Awaited<ReturnType<typeof setupChannels>>["deliveryService"];
  inboundMessageIdResolver: InboundMessageIdResolver;
  // Channel health monitor (refs subsumed by helper return value)
  channelHealthMonitor: ChannelHealthMonitor | undefined;
  stopChannelHealthMonitor: (() => void) | undefined;
  // Notifications + background completion
  notificationContext: ReturnType<typeof setupNotifications>;
  bgCompletionRunnerContext: ReturnType<typeof setupBackgroundCompletionRunner>;
  // Cross-session + sub-agent runtime
  crossSessionSender: ReturnType<typeof setupCrossSession>["crossSessionSender"];
  subAgentRunner: ReturnType<typeof setupCrossSession>["subAgentRunner"];
  sendToChannel: ReturnType<typeof setupCrossSession>["sendToChannel"];
  announceToParent: ReturnType<typeof setupCrossSession>["announceToParent"];
  deadLetterQueue: ReturnType<typeof setupCrossSession>["deadLetterQueue"];
  announcementBatcher: ReturnType<typeof setupCrossSession>["announcementBatcher"];
  gatewaySendRef: { ref?: (channelId: string, text: string) => boolean };
  // Sandbox + image generation
  sandboxProvider: SandboxProvider | undefined;
  imageGenProvider: ReturnType<typeof createImageGenProvider> extends import("@comis/shared").Result<infer P, unknown> ? P | undefined : never;
  imageGenRateLimiter: ImageGenRateLimiter | undefined;
  imageGenConfig: AgentsHandle["container"]["config"]["integrations"]["media"]["imageGeneration"];
  // Tools (assembler + preprocessor)
  assembleToolsForAgent: ReturnType<typeof setupTools>["assembleToolsForAgent"];
  preprocessMessageText: ReturnType<typeof setupTools>["preprocessMessageText"];
  getCapabilityPortForAgent: (agentId: string) => ToolCapabilityPort;
  // Monitoring + heartbeat
  heartbeatRunner: ReturnType<typeof setupMonitoring>["heartbeatRunner"];
  duplicateDetector: ReturnType<typeof setupMonitoring>["duplicateDetector"];
  perAgentRunner: ReturnType<typeof setupHeartbeat>["perAgentRunner"];
  wakeCoalescer: ReturnType<typeof createWakeCoalescer>;
  // Graph
  nodeTypeRegistry: ReturnType<typeof createNodeTypeRegistry>;
  graphCoordinator: ReturnType<typeof createGraphCoordinator>;
  namedGraphStore: ReturnType<typeof createNamedGraphStore>;
  // Agent management runtime state
  suspendedAgents: Set<string>;
  modelCatalog: ReturnType<typeof createModelCatalog>;
  channelConfig: Record<string, { enabled: boolean }>;
  promptTimeoutTimestamps: number[];
  // ---------------------------------------------------------------------
  // CRIT-03: Teardown handles surfaced from stageChannels for ShutdownDeps
  // wiring. Each was previously hosted inside
  // container.eventBus.on("system:shutdown", ...) subscribers that
  // silently no-op'd in production because no production code emits the
  // system:shutdown event. Threaded through here so stageShutdown invokes
  // them directly.
  // ---------------------------------------------------------------------
  /** Drain per-agent background-process registries (from setupTools). */
  shutdownBackgroundProcesses: ReturnType<typeof setupTools>["shutdownBackgroundProcesses"];
  /** Cleanup proxy typing controllers + sweep timer (from registerProxyTypingListeners). */
  proxyTypingCleanup: ReturnType<typeof setupCrossSession>["proxyTypingCleanup"];
  /** Approval notifier handle (from setupChannels). Undefined when no channel adapters initialized. */
  approvalNotifier: Awaited<ReturnType<typeof setupChannels>>["approvalNotifier"];
  /** Output retention housekeeper handle (from setupOutputRetention). Undefined when defaultWorkspaceDir is empty. */
  outputRetentionHandle: ReturnType<typeof setupOutputRetention> | undefined;
}

/**
 * Shape of the session-store bridge object literal constructed inside
 * stageGateway. Captured as a named type so GatewayHandle declares a precise
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

/**
 * Handle returned by `stageGateway`. Extends `ChannelsHandle` so main() and
 * `stageShutdown` can read every field constructed across all four runtime
 * stages. Carries ~13 new fields covering token registry, session store
 * bridge, hot-add/hot-remove closures, RPC dispatch deps, gateway server
 * handle, active execution tracker, and WebSocket connection manager.
 *
 * The `shutdownRef` slot is declared empty inside stageGateway and populated
 * by `stageShutdown` once the live shutdown handle is constructed (hot-add
 * closures read `.value` at RPC call time, not at definition time).
 */
export interface GatewayHandle extends ChannelsHandle {
  // Token registry (4 fields)
  tokenRegistry: ReturnType<typeof createTokenRegistry>;
  runtimeTokens: Array<{ id: string; secretBuf: Buffer; scopes: string[] }>;
  removedTokenIds: Set<string>;
  resolvedGatewayTokens: Array<{ id: string; secret: string; scopes: string[] }>;
  // Session store bridge (1 field)
  sessionStoreBridge: SessionStoreBridge;
  // Shutdown ref (populated by stageShutdown)
  shutdownRef: { value?: { readonly isShuttingDown: boolean } };
  // Hot-add / hot-remove closures (2 fields)
  hotAdd: (agentId: string, config: PerAgentConfig) => Promise<void>;
  hotRemove: (agentId: string) => Promise<void>;
  // RPC dispatch deps (1 field; mutated post-gateway-init for wsConnections/mediaDir/onGatewayAttachment)
  rpcDispatchDeps: import("./api/rpc-dispatch.js").ApiDispatchDeps;
  // Gateway server (4 fields)
  gatewayHandle: GatewayServerHandle | undefined;
  activeExecutions: Map<string, { agentId: string; startedAt: number }>;
  getActiveConnectionCount: () => number;
  wsConnections: WsConnectionManager;
}

/**
 * Pre-dispatch slice used by buildRpcDispatchDeps to pass through gateway-local
 * data not yet on the channels handle.
 */
export type GatewayPreDispatchSlice = Pick<GatewayHandle,
  "tokenRegistry" | "runtimeTokens" | "removedTokenIds" | "sessionStoreBridge" | "hotAdd" | "hotRemove">;
