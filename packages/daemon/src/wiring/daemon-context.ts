/**
 * DaemonContext: The full typed container of all wired daemon services.
 * This interface describes every service, adapter, and resolver that the
 * daemon's main() function creates during startup. Extraction functions
 * in Phases 169-172 accept DaemonContext (or a partial subset) as input
 * and return partial results that assemble into it.
 * DaemonContext is the single source of truth for the daemon's wired
 * dependency graph -- eliminating ad-hoc parameter lists and preventing
 * circular imports between extraction modules.
 * @module
 */

import type { AppContainer, ChannelPort, EmbeddingPort, TTSPort, VisionProvider } from "@comis/core";
import type { ComisLogger } from "@comis/infra";
import type { AgentExecutor, createCostTracker, createBudgetGuard, createStepCounter, createSessionLifecycle, SessionResetScheduler } from "@comis/agent";
import type { SqliteMemoryAdapter, createSessionStore, createEmbeddingQueue, MemoryApi } from "@comis/memory";
import type { HeartbeatRunner, CronScheduler, createExecutionTracker } from "@comis/scheduler";
import type { GatewayServerHandle } from "@comis/gateway";
import type { BrowserService, RpcCall, LinkRunner } from "@comis/skills";
import type { ChannelManager } from "@comis/channels";
import type { DeviceIdentity } from "@comis/core";

import type { LogLevelManager } from "../observability/log-infra.js";
import type { TokenTracker } from "../observability/token-tracker.js";
import type { LatencyRecorder } from "../observability/latency-recorder.js";
import type { DiagnosticCollector } from "../observability/diagnostic-collector.js";
import type { BillingEstimator } from "../observability/billing-estimator.js";
import type { ChannelActivityTracker } from "../observability/channel-activity-tracker.js";
import type { DeliveryTracer } from "../observability/delivery-tracer.js";
import type { ProcessMonitor } from "../process/process-monitor.js";
import type { WatchdogHandle } from "../health/watchdog.js";
import type { ShutdownHandle } from "../process/graceful-shutdown.js";
import type { createCrossSessionSender } from "../cross-session-sender.js";
import type { createSubAgentRunner } from "../sub-agent-runner.js";

/**
 * The full container of wired daemon services, passed between
 * `wireXxx()` and `setupXxx()` functions during daemon decomposition.
 * Each field corresponds to a local variable in the current daemon.ts
 * main() function. As extraction progresses (Phases 169-173), setup
 * functions will populate subsets of this context incrementally.
 */
export interface DaemonContext {
  // -- Core ------------------------------------------------------------------

  /** Bootstrap output: config, event bus, secret manager. */
  container: AppContainer;
  /** Startup instance UUID (first 8 chars). */
  instanceId: string;
  /** High-resolution startup timer (Date.now() at entry). */
  startupStartMs: number;

  // -- Logging ---------------------------------------------------------------

  /** Root tracing logger (structured JSON with AsyncLocalStorage context). */
  logger: ComisLogger;
  /** Per-module runtime log level control. */
  logLevelManager: LogLevelManager;
  /** Module-bound logger: gateway subsystem. */
  gatewayLogger: ComisLogger;
  /** Module-bound logger: channels subsystem. */
  channelsLogger: ComisLogger;
  /** Module-bound logger: agent subsystem. */
  agentLogger: ComisLogger;
  /** Module-bound logger: scheduler subsystem. */
  schedulerLogger: ComisLogger;
  /** Module-bound logger: skills subsystem. */
  skillsLogger: ComisLogger;
  /** Module-bound logger: memory subsystem. */
  memoryLogger: ComisLogger;
  /** Daemon package version string (from package.json). */
  daemonVersion: string;

  // -- Observability ---------------------------------------------------------

  /** Token usage tracking across all agents. */
  tokenTracker: TokenTracker;
  /** Latency recording for timed operations. */
  latencyRecorder: LatencyRecorder;
  /** Shared cost tracker for cross-agent billing aggregation. */
  sharedCostTracker: ReturnType<typeof createCostTracker>;
  /** Diagnostic event collector. */
  diagnosticCollector: DiagnosticCollector;
  /** Billing estimation from cost data. */
  billingEstimator: BillingEstimator;
  /** Per-channel activity tracking. */
  channelActivityTracker: ChannelActivityTracker;
  /** End-to-end message delivery tracing. */
  deliveryTracer: DeliveryTracer;

  // -- Process ---------------------------------------------------------------

  /** System resource monitoring (CPU, memory, event loop). */
  processMonitor: ProcessMonitor;
  /** Systemd watchdog health gating handle. */
  watchdogHandle: WatchdogHandle;
  /** Device identity for pairing (optional -- warn on failure). */
  deviceIdentity?: DeviceIdentity;

  // -- Memory / Embedding ----------------------------------------------------

  /** Raw embedding provider (optional -- FTS5-only if unavailable). */
  embeddingPort?: EmbeddingPort;
  /** Cached embedding provider wrapper (optional). */
  cachedPort?: EmbeddingPort;
  /** SQLite memory adapter with FTS5 + vector search. */
  memoryAdapter: SqliteMemoryAdapter;
  /** Session persistence store. */
  sessionStore: ReturnType<typeof createSessionStore>;
  /** High-level memory query/store API. */
  memoryApi: MemoryApi;
  /** Background embedding queue for new entries (optional). */
  embeddingQueue?: ReturnType<typeof createEmbeddingQueue>;

  // -- Agents ----------------------------------------------------------------

  /** Shared session manager across all agents. */
  sessionManager: ReturnType<typeof createSessionLifecycle>;
  /** Per-agent executor instances keyed by agentId. */
  executors: Map<string, AgentExecutor>;
  /** Per-agent workspace directory paths. */
  workspaceDirs: Map<string, string>;
  /** Per-agent cost trackers. */
  costTrackers: Map<string, ReturnType<typeof createCostTracker>>;
  /** Per-agent budget guards. */
  budgetGuards: Map<string, ReturnType<typeof createBudgetGuard>>;
  /** Per-agent step counters. */
  stepCounters: Map<string, ReturnType<typeof createStepCounter>>;
  /** Default agent ID from routing config. */
  defaultAgentId: string;
  /** Default agent workspace directory path. */
  defaultWorkspaceDir: string;

  // -- Schedulers ------------------------------------------------------------

  /** Per-agent cron schedulers. */
  cronSchedulers: Map<string, CronScheduler>;
  /** Per-agent execution history trackers. */
  executionTrackers: Map<string, ReturnType<typeof createExecutionTracker>>;
  /** Per-agent session reset schedulers. */
  resetSchedulers: Map<string, SessionResetScheduler>;

  // -- Browser ---------------------------------------------------------------

  /** Per-agent browser automation services. */
  browserServices: Map<string, BrowserService>;

  // -- Channels --------------------------------------------------------------

  /** Channel adapters keyed by platform type (telegram, discord, etc.). */
  adaptersByType: Map<string, ChannelPort>;

  // -- Media -----------------------------------------------------------------

  /** Text-to-speech adapter (optional). */
  ttsAdapter?: TTSPort;
  /** Vision provider registry keyed by provider name (optional). */
  visionRegistry?: Map<string, VisionProvider>;
  /** Link understanding pipeline runner. */
  linkRunner: LinkRunner;

  // -- Cross-session ---------------------------------------------------------

  /** Cross-session message sender for agent-to-agent communication. */
  crossSessionSender: ReturnType<typeof createCrossSessionSender>;
  /** Sub-agent task runner for delegated execution. */
  subAgentRunner: ReturnType<typeof createSubAgentRunner>;

  // -- RPC / Gateway ---------------------------------------------------------

  /** In-process RPC dispatcher for platform tools. */
  rpcCall: RpcCall;
  /** Heartbeat runner for periodic health checks (optional). */
  heartbeatRunner?: HeartbeatRunner;
  /** Gateway HTTP/WebSocket server handle (optional). */
  gatewayHandle?: GatewayServerHandle;
  /** Graceful shutdown orchestrator. */
  shutdownHandle: ShutdownHandle;
  /** Channel lifecycle manager (optional). */
  channelManager?: ChannelManager;

  // -- Resolver functions (closures from main) -------------------------------

  /** Resolve executor for an agent ID, falling back to default agent. */
  getExecutor: (agentId: string) => AgentExecutor;
  /** Resolve the CronScheduler for a given agent ID. */
  getAgentCronScheduler: (agentId: string) => CronScheduler;
  /** Resolve the BrowserService for a given agent ID. */
  getAgentBrowserService: (agentId: string) => BrowserService;
}
