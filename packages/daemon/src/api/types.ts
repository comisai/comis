// SPDX-License-Identifier: Apache-2.0
/**
 * Per-domain API dependency slices for daemon RPC handlers.
 *
 * Phase 34 (DAEMON-API-03) replaces the monolithic dispatcher-deps superset
 * with 11 per-domain cluster slices. Each handler factory consumes its narrow
 * slice; the ApiDispatchDeps aggregator (extends all 11) is consumed ONLY by
 * the dispatcher itself.
 *
 * This file is scaffolded in Plan 34-08a; handler files in api/*-handlers.ts
 * are retargeted to consume their cluster slice in Plans 34-08b (Sessions +
 * Memory + Channels + Agents + Orchestrator + Workspace = 18 files) and
 * 34-08c (Config + Auth + Media + Observability + Daemon = 9 files). Split
 * is required by ORCH-EXT-21 (25-file fanout cap per commit).
 *
 * The field partition matches RESEARCH §"Per-Handler ApiDeps Slice Inventory"
 * (lines 486-540): every field on the legacy dispatcher-deps interface maps
 * to exactly one cluster slice. The aggregator's `extends` clause unions
 * all 11 slices back into the legacy shape, preserving structural
 * compatibility with the 27 still-legacy `*HandlerDeps` interfaces in
 * api/*-handlers.ts.
 *
 * @module
 */

import type {
  ChannelPort,
  VisionProvider,
  TTSPort,
  VisionScopeRule,
  TtsOutputFormat,
  TtsAutoMode,
  AppContainer,
  PerAgentConfig,
  ProviderEntry,
  MemoryWriteValidationResult,
  SecretStorePort,
  ExecGitFn,
  ContextStorePort,
} from "@comis/core";
import type { ComisLogger } from "@comis/infra";
import type { MemoryApi, SqliteMemoryAdapter, createEmbeddingQueue } from "@comis/memory";
import type { CronScheduler, ExecutionTracker, WakeCoalescer, PerAgentHeartbeatRunner } from "@comis/scheduler";
import type { BrowserService, LinkRunner, McpClientManager } from "@comis/skills";
import type { createCostTracker, createStepCounter, createSubAgentRunner } from "@comis/agent";
// Phase 35 Plan 35-04 (D-01 #4): ModelCatalog type relocated to @comis/core.
import type { ModelCatalog } from "@comis/core";
import type { createCrossSessionSender } from "@comis/orchestrator";
import type { DiagnosticCollector } from "../observability/diagnostic-collector.js";
import type { BillingEstimator } from "../observability/billing-estimator.js";
import type { ChannelActivityTracker } from "../observability/channel-activity-tracker.js";
import type { DeliveryTracer } from "../observability/delivery-tracer.js";
import type { LogLevelManager } from "../observability/log-infra.js";
import type { PersistToConfigDeps } from "./shared/persist-to-config.js";

/** Handler function signature for RPC methods. */
export type RpcHandler = (params: Record<string, unknown>) => Promise<unknown>;

// ============================================================================
// Per-domain slices
// ============================================================================

/**
 * Dependencies for session-handlers
 * (session.list, session.load, session.delete, session.spawn, session.search).
 */
export interface SessionsApiDeps {
  defaultAgentId: string;
  agents: Record<string, PerAgentConfig>;
  costTrackers: Map<string, ReturnType<typeof createCostTracker>>;
  stepCounters: Map<string, ReturnType<typeof createStepCounter>>;
  /** Base directory for agent data (e.g., ~/.comis/agents). Used to scan JSONL sessions. */
  agentDataDir?: string;
  /** Default workspace directory (e.g., ~/.comis/workspace). Used to scan workspace JSONL sessions. */
  defaultWorkspaceDir: string;
  sessionStore: {
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
  crossSessionSender: ReturnType<typeof createCrossSessionSender>;
  subAgentRunner: ReturnType<typeof createSubAgentRunner>;
  securityConfig: { agentToAgent?: { enabled?: boolean; waitTimeoutMs: number } };
  tenantId: string;
  /** Structured logger threaded through every cluster slice (DaemonApiDeps
   *  is required; SessionsApiDeps mirrors required for multi-extends parity).
   *  Plan 34-08b. */
  logger: ComisLogger;
  /** Optional approval gate handle for clearing approval cache on session events.
   *  Plan 34-08b — session-handlers reads `deps.approvalGate?.clearApprovalCache`. */
  approvalGate?: import("@comis/core").ApprovalGate;
  /** Optional LLM summarizer for session search results. Plan 34-08b. */
  summarizeSession?: (messages: unknown[], query: string) => Promise<string | null>;
}

/**
 * Dependencies for memory-handlers + context-handlers
 * (memory.read/write/search/embeddingCache, context.recall/expand).
 */
export interface MemoryApiDeps {
  /** Plan 34-08b — memory-handlers + context-handlers read deps.defaultAgentId / deps.tenantId. */
  defaultAgentId: string;
  defaultWorkspaceDir: string;
  tenantId: string;
  workspaceDirs: Map<string, string>;
  memoryApi: MemoryApi;
  memoryAdapter: SqliteMemoryAdapter;
  embeddingQueue?: ReturnType<typeof createEmbeddingQueue>;
  /** Optional memory write validator for security scanning */
  memoryWriteValidator?: (content: string) => MemoryWriteValidationResult;
  /** Optional event bus for memory write security events. Use AppContainer["eventBus"]
   *  so the slice unifies with WorkspaceApiDeps' eventBus (skill-handlers). */
  eventBus?: AppContainer["eventBus"];
  /** Plan 34-08b — memory-handlers reads deps.logger.warn/info; context-handlers
   *  reads deps.logger.info/warn. Required (matches other slices for multi-extends parity). */
  logger: ComisLogger;
  // Context DAG recall deps
  contextStore?: ContextStorePort;
  contextEngineConfig?: { maxRecallsPerDay: number; maxExpandTokens: number; recallTimeoutMs: number };
  /** Plan 34-08b — context-handlers reads deps.store. Aliases contextStore. */
  store?: ContextStorePort;
  /** Plan 34-08b — context-handlers reads deps.config (recall-quota / token-cap / timeout). Aliases contextEngineConfig. */
  config?: { maxRecallsPerDay: number; maxExpandTokens: number; recallTimeoutMs: number };
  /** Plan 34-08b — context-handlers reads deps.resolveConversationId. */
  resolveConversationId?: (sessionKey: string) => string | undefined;
  /** Plan 34-08b — context-handlers reads deps.rpcCall for ctx_recall -> session.spawn self-dispatch. */
  rpcCall?: (method: string, params: Record<string, unknown>) => Promise<unknown>;
  // Embedding cache stats accessors
  /** Embedding cache stats accessor for memory.embeddingCache RPC */
  embeddingCacheStats?: () => import("@comis/memory").EmbeddingCacheStats;
  /** Embedding circuit breaker state accessor for memory persistence operations. */
  embeddingCircuitBreakerState?: () => import("@comis/agent").CircuitState;
}

/**
 * Dependencies for channel-handlers + message-handlers
 * (channel.list/start/stop, message.send/reply/edit/delete/react).
 */
export interface ChannelsApiDeps {
  adaptersByType: Map<string, ChannelPort>;
  /** Resolves daemon NormalizedMessage.id UUIDs back to platform-native
   *  message ids for message.delete/edit/react. Optional for backward compat
   *  with daemon configs that disable channel adapters entirely. */
  inboundMessageIdResolver?: import("../wiring/inbound-message-id-resolver.js").InboundMessageIdResolver;
  channelConfig: Record<string, { enabled: boolean }>;
  // Gateway attachment deps (Phase quick-91) -- set after gateway init via mutable ref
  wsConnections?: { broadcast(method: string, params: unknown): boolean };
  mediaDir?: string;
  onGatewayAttachment?: (channelId: string, marker: string) => void;
  // Delivery queue + service
  deliveryQueue?: import("@comis/core").DeliveryQueuePort;
  /** DeliveryService constructed once at the daemon composition root
   *  (setup-channels.ts). Phase 30 plan 04 (CONFIG-DELIV-05) — passed through
   *  to createMessageHandlers so `message.send` / `message.reply` use the
   *  method form `deps.deliveryService.deliverToChannel(...)`. */
  deliveryService: import("@comis/core").DeliveryService;
  // Channel health monitor
  healthMonitor?: import("@comis/channels").ChannelHealthMonitor;
  // Channel plugins for capabilities RPC
  channelPlugins?: Map<string, import("@comis/core").ChannelPluginPort>;
  /** Plan 34-08b — message-handlers reads deps.defaultAgentId, deps.defaultWorkspaceDir,
   *  deps.workspaceDirs, deps.logger. channel-handlers reads deps.persistDeps. */
  defaultAgentId: string;
  defaultWorkspaceDir: string;
  workspaceDirs: Map<string, string>;
  logger: ComisLogger;
  persistDeps?: PersistToConfigDeps;
}

/**
 * Dependencies for agent-handlers + model-handlers + provider-handlers
 * (agents.list/get/update/suspend, models.list, providers.list).
 */
export interface AgentsApiDeps {
  // Agent management
  suspendedAgents: Set<string>;
  /** Hot-add callback passed through to agent handlers for runtime agent creation without restart. */
  hotAdd?: (agentId: string, config: PerAgentConfig) => Promise<void>;
  /** Hot-remove callback passed through to agent handlers for runtime agent deletion without restart. */
  hotRemove?: (agentId: string) => Promise<void>;
  // Model management
  modelCatalog: ModelCatalog;
  // Daemon-level OAuth credential store handle for the agents.update
  // oauthProfiles existence check. When absent (e.g. tests), the validation
  // block in agent-handlers becomes a no-op and existing behavior is
  // preserved.
  oauthCredentialStore?: import("@comis/core").OAuthCredentialStorePort;
  /** Plan 34-08b — agent-handlers / model-handlers / provider-handlers read
   *  deps.agents (PerAgentConfig map). model-handlers expects a slightly
   *  narrower shape (provider + model only); structural subtyping accepts the
   *  broader PerAgentConfig record at the call site. */
  agents: Record<string, PerAgentConfig>;
  /** Plan 34-08b — agent-handlers reads deps.defaultAgentId (cannot be deleted). */
  defaultAgentId: string;
  /** Plan 34-08b — agent/provider-handlers read deps.persistDeps for YAML writes. */
  persistDeps?: PersistToConfigDeps;
  /** Plan 34-08b — agent/provider-handlers read deps.secretManager for apiKey checks. */
  secretManager?: import("@comis/core").SecretManager;
  /** Plan 34-08b — agent/model/provider-handlers read deps.providerEntries. */
  providerEntries?: Record<string, ProviderEntry>;
  /** Plan 34-08b — agent-handlers reads deps.modelsConfig for credential resolver. */
  modelsConfig?: { defaultProvider?: string };
}

/**
 * Dependencies for cron-handlers + graph-handlers + heartbeat-handlers + subagent-handlers
 * (cron.list/run, graph.list/run, heartbeat.list/run, subagent.list).
 */
export interface OrchestratorApiDeps {
  getAgentCronScheduler: (agentId: string) => CronScheduler;
  cronSchedulers: Map<string, CronScheduler>;
  executionTrackers: Map<string, ExecutionTracker>;
  wakeCoalescer: WakeCoalescer;
  // Graph coordinator deps
  graphCoordinator?: import("../graph/graph-coordinator.js").GraphCoordinator;
  // Named graph persistence deps
  namedGraphStore?: import("@comis/memory").NamedGraphStore;
  /** Node type registry for driver config validation. The legacy GraphHandlerDeps
   *  declared an inline shape; the @comis/scheduler / graph-local
   *  NodeTypeRegistry type is structurally compatible. Plan 34-08b. */
  nodeTypeRegistry?: import("../graph/node-type-registry.js").NodeTypeRegistry;
  // Heartbeat deps
  perAgentRunner?: PerAgentHeartbeatRunner;
  globalHeartbeatConfig?: Record<string, unknown>;
  /** Plan 34-08b — cron / graph / subagent handlers read deps.defaultAgentId. */
  defaultAgentId: string;
  /** Plan 34-08b — graph / subagent handlers read deps.tenantId. */
  tenantId: string;
  /** Plan 34-08b — heartbeat-handlers reads deps.agents (PerAgentConfig map). */
  agents: Record<string, PerAgentConfig>;
  /** Plan 34-08b — heartbeat-handlers reads deps.persistDeps for YAML writes. */
  persistDeps?: PersistToConfigDeps;
  /** Plan 34-08b — graph-handlers reads deps.securityConfig.agentToAgent.enabled. */
  securityConfig: { agentToAgent?: { enabled?: boolean; waitTimeoutMs: number } };
  /** Plan 34-08b — graph / subagent handlers read deps.logger.info/warn. Required
   *  (matches other slices for multi-extends parity; DaemonApiDeps.logger is required). */
  logger: ComisLogger;
  /** Plan 34-08b — graph-handlers reads deps.dataDir for graph-runs output. */
  dataDir?: string;
  /** Plan 34-08b — subagent-handlers reads deps.subAgentRunner.list/kill/steer. */
  subAgentRunner: ReturnType<typeof createSubAgentRunner>;
}

/**
 * Dependencies for workspace-handlers + browser-handlers + approval-handlers
 * + mcp-handlers + skill-handlers + notification-handlers.
 */
export interface WorkspaceApiDeps {
  // Browser deps
  getAgentBrowserService: (agentId: string) => BrowserService;
  // Approval deps
  approvalGate?: import("@comis/core").ApprovalGate;
  // MCP management deps (Phase quick-81) — always defined; setupMcp constructs
  // the manager unconditionally so runtime `mcp.connect` RPCs work even when
  // zero servers were configured at startup.
  mcpClientManager: McpClientManager;
  // Skill management deps
  skillRegistries?: Map<string, import("@comis/skills").SkillRegistry>;
  // Notification deps (Proactive v1)
  notificationService?: import("../notification/notification-service.js").NotificationService;
  // Workspace file management deps
  execGit: ExecGitFn;
  /** Plan 34-08b — workspace-handlers reads deps.agents (PerAgentConfig map). */
  agents: Record<string, PerAgentConfig>;
  /** Plan 34-08b — browser / skill handlers read deps.defaultAgentId. */
  defaultAgentId: string;
  /** Plan 34-08b — workspace-handlers reads deps.defaultWorkspaceDir. */
  defaultWorkspaceDir: string;
  /** Plan 34-08b — workspace / skill handlers read deps.workspaceDirs. */
  workspaceDirs: Map<string, string>;
  /** Plan 34-08b — workspace / mcp handlers read deps.logger. */
  logger: ComisLogger;
  /** Plan 34-08b — workspace-handlers reads deps.tenantId (memory-attach context).
   *  Required to align with SessionsApiDeps/MemoryApiDeps/OrchestratorApiDeps for
   *  the ApiDispatchDeps multi-extends. */
  tenantId: string;
  /** Plan 34-08b — workspace-handlers reads deps.memoryApi (memory.attach RPC).
   *  Required to align with MemoryApiDeps for the ApiDispatchDeps multi-extends. */
  memoryApi: MemoryApi;
  /** Plan 34-08b — workspace-handlers reads deps.memoryAdapter (memory.attach RPC).
   *  Required to align with MemoryApiDeps for the ApiDispatchDeps multi-extends. */
  memoryAdapter: SqliteMemoryAdapter;
  /** Plan 34-08b — skill-handlers reads deps.container (bootstrap dataDir access). */
  container: AppContainer;
  /** Plan 34-08b — skill-handlers reads deps.eventBus for skill lifecycle events. */
  eventBus?: AppContainer["eventBus"];
  /** Plan 34-08b — mcp-handlers reads deps.secretManager?.has for env-ref validation. */
  secretManager?: import("@comis/core").SecretManager;
}

/**
 * Dependencies for config-handlers + env-handlers
 * (config.get/patch/reload, env.get/set).
 */
export interface ConfigApiDeps {
  container: AppContainer;
  configPaths: string[];
  defaultConfigPaths: string[];
  configGitManager?: import("@comis/core").ConfigGitManager;
  configWebhook?: { url?: string; timeoutMs?: number; secret?: string };
  // Env handler deps (Phase quick-47)
  envFilePath: string;
  /** Plan 34-08c — config-handlers + env-handlers read deps.logger.
   *  Required (matches other slices for multi-extends parity; DaemonApiDeps.logger is required). */
  logger: ComisLogger;
  /** Plan 34-08c — config-handlers' credential guard reads deps.oauthCredentialStore
   *  to confirm an agent's `oauthProfiles[provider]` entry exists. Same shape as
   *  AgentsApiDeps.oauthCredentialStore + AuthApiDeps.oauthCredentialStore so the
   *  ApiDispatchDeps multi-extends remains well-formed. */
  oauthCredentialStore?: import("@comis/core").OAuthCredentialStorePort;
  /** Plan 34-08c — env-handlers reads deps.secretStore for the encrypted-secret
   *  write path. Same shape as AuthApiDeps.secretStore so the ApiDispatchDeps
   *  multi-extends remains well-formed. */
  secretStore?: SecretStorePort;
}

/**
 * Dependencies for auth-handlers + secrets-handlers + token-handlers
 * (auth.oauth.list/connect, secrets.get/set, tokens.list/create/revoke).
 */
export interface AuthApiDeps {
  // Secret store (env-handlers, secrets-handlers)
  secretStore?: SecretStorePort;
  // Token management deps. The structural shape mirrors `TokenRegistry`
  // declared in `./token-handlers.ts` -- inlined here to keep this file at
  // the bottom of the api/ import graph (madge cycle constraint, Phase 27
  // ARCH-BASE-05). Plan 34-09 (api/shared/ extraction) may relocate the
  // TokenRegistry interface to a sibling that both modules import from.
  tokenRegistry: {
    list(): Array<{ id: string; scopes: readonly string[]; createdAt: number; revoked: boolean }>;
    get(id: string): { id: string; scopes: readonly string[]; createdAt: number; revoked: boolean } | undefined;
    create(id: string, secret: string, scopes: string[]): { id: string; scopes: readonly string[]; createdAt: number; revoked: boolean };
    revoke(id: string): boolean;
  };
  addToTokenStore: (entry: { id: string; secret: string; scopes: string[] }) => void;
  removeFromTokenStore: (id: string) => void;
  /** Plan 34-08c — auth-handlers reads deps.oauthCredentialStore for OAuth
   *  profile list / delete. Same shape as AgentsApiDeps.oauthCredentialStore
   *  + ConfigApiDeps.oauthCredentialStore so the ApiDispatchDeps multi-extends
   *  remains well-formed. */
  oauthCredentialStore?: import("@comis/core").OAuthCredentialStorePort;
  /** Plan 34-08c — auth + secrets handlers read deps.container for audit
   *  eventBus emit + tenant lookup. Same shape as ConfigApiDeps.container
   *  + WorkspaceApiDeps.container so the ApiDispatchDeps multi-extends
   *  remains well-formed. */
  container: AppContainer;
  /** Plan 34-08c — auth + secrets handlers read deps.logger. Required
   *  (matches other slices for multi-extends parity; DaemonApiDeps.logger
   *  is required). */
  logger: ComisLogger;
  /** Plan 34-08c — token-handlers reads deps.persistDeps for runtime token
   *  persistence to config.yaml. Same shape as ChannelsApiDeps.persistDeps /
   *  AgentsApiDeps.persistDeps / OrchestratorApiDeps.persistDeps so the
   *  ApiDispatchDeps multi-extends remains well-formed. */
  persistDeps?: PersistToConfigDeps;
}

/**
 * Dependencies for media-handlers + image-handlers
 * (media.transcribe/extract_document/tts, image.generate).
 */
export interface MediaApiDeps {
  visionRegistry?: Map<string, VisionProvider>;
  mediaConfig: {
    imageAnalysis: { maxFileSizeMb: number };
    vision: {
      scopeRules: ReadonlyArray<VisionScopeRule>;
      defaultScopeAction: "allow" | "deny";
      defaultProvider?: string;
    };
    tts: {
      provider?: string;
      autoMode: TtsAutoMode;
      tagPattern: string;
      voice?: string;
      format?: string;
      outputFormats?: TtsOutputFormat;
    };
  };
  ttsAdapter?: TTSPort;
  linkRunner: LinkRunner;
  /** Attachment URL resolver for on-demand media tool RPC handlers. */
  resolveAttachment?: (url: string) => Promise<Buffer | null>;
  /** Speech-to-text transcriber for media.transcribe RPC handler. */
  transcriber?: import("@comis/core").TranscriptionPort;
  /** File extractor for media.extract_document RPC handler. */
  fileExtractor?: import("@comis/core").FileExtractionPort;
  // Image generation deps (Proactive v1 -- IMGN). The structural shape mirrors
  // `ImageHandlerDeps` declared in `./image-handlers.ts` -- inlined here to
  // keep this file at the bottom of the api/ import graph (madge cycle
  // constraint, Phase 27 ARCH-BASE-05). The dispatcher in api/rpc-dispatch.ts
  // is responsible for passing this through to createImageHandlers.
  imageHandlerDeps?: {
    provider: import("@comis/core").ImageGenerationPort;
    rateLimiter: import("@comis/skills").ImageGenRateLimiter;
    config: import("@comis/core").ImageGenerationConfig;
    logger: ComisLogger;
    /** Direct channel delivery -- resolve adapter by channel type. */
    getChannelAdapter: (channelType: string) => Pick<import("@comis/core").ChannelPort, "sendAttachment"> | undefined;
  };
  /** Plan 34-08c — media-handlers reads deps.workspaceDirs / deps.defaultWorkspaceDir
   *  / deps.defaultAgentId for STT / vision / link-processing file paths.
   *  Same shape as ChannelsApiDeps + WorkspaceApiDeps for ApiDispatchDeps multi-extends parity. */
  workspaceDirs: Map<string, string>;
  defaultWorkspaceDir: string;
  defaultAgentId: string;
  /** Plan 34-08c — media-handlers reads deps.logger. Required (matches other
   *  slices for multi-extends parity; DaemonApiDeps.logger is required). */
  logger: ComisLogger;
}

/**
 * Dependencies for obs-handlers
 * (obs.usage/billing/diagnostics/budget).
 */
export interface ObservabilityApiDeps {
  // Observability bridge deps
  diagnosticCollector: DiagnosticCollector;
  billingEstimator: BillingEstimator;
  channelActivityTracker: ChannelActivityTracker;
  deliveryTracer: DeliveryTracer;
  budgetGuards?: Map<string, { getSnapshot(): { perExecution: number; perHour: number; perDay: number } }>;
  // Observability persistence deps
  obsStore?: import("@comis/memory").ObservabilityStore;
  startupTimestamp?: number;
  sharedCostTracker?: { reset(): number };
  // Context pipeline collector deps
  contextPipelineCollector?: import("../observability/context-pipeline-collector.js").ContextPipelineCollector;
  /** Plan 34-08c — obs-handlers emits `observability:reset` on obs.reset. Same
   *  shape as MemoryApiDeps.eventBus / WorkspaceApiDeps.eventBus so the
   *  ApiDispatchDeps multi-extends remains well-formed. */
  eventBus?: AppContainer["eventBus"];
  /** Plan 34-08c — obs-handlers reads deps.agents?.[id]?.budgets for budget
   *  snapshot RPCs. Same shape as AgentsApiDeps.agents / OrchestratorApiDeps.agents
   *  / WorkspaceApiDeps.agents so the ApiDispatchDeps multi-extends remains
   *  well-formed. obs-handlers tolerates the broader PerAgentConfig record
   *  structurally (only `.budgets?` is read). */
  agents: Record<string, PerAgentConfig>;
  /** Plan 34-08c — obs-handlers exposes embedding cache stats via the
   *  memory.embeddingCache RPC. Same shape as MemoryApiDeps.embeddingCacheStats
   *  so the ApiDispatchDeps multi-extends remains well-formed. */
  embeddingCacheStats?: () => import("@comis/memory").EmbeddingCacheStats;
  /** Plan 34-08c — obs-handlers exposes embedding circuit breaker state.
   *  Same shape as MemoryApiDeps.embeddingCircuitBreakerState so the
   *  ApiDispatchDeps multi-extends remains well-formed. */
  embeddingCircuitBreakerState?: () => import("@comis/agent").CircuitState;
  /** Plan 34-08c — obs-handlers reads deps.tokenTracker for cache stats RPC.
   *  Only used by obs-handlers; no cross-slice collision. */
  tokenTracker?: import("../observability/token-tracker.js").TokenTracker;
}

/**
 * Dependencies for daemon-handlers
 * (daemon.log_level — log-level control only).
 */
export interface DaemonApiDeps {
  logLevelManager: LogLevelManager;
  /** Daemon-wide structured logger threaded into per-handler logger fields. */
  logger: ComisLogger;
}

// ============================================================================
// Aggregator (used by api/rpc-dispatch.ts ONLY -- never destructured by handlers)
// ============================================================================

/**
 * Aggregator union of all per-domain slices. Consumed ONLY by the dispatcher
 * in api/rpc-dispatch.ts; never by individual handler factories. Architecture
 * test (Plan 09) bans handler-to-handler imports; aggregator narrowing is
 * structural and happens at the dispatcher boundary.
 *
 * Renamed from the legacy dispatcher-deps aggregator in Phase 34 commit 8a
 * (DAEMON-API-03).
 *
 * Structural-typing invariant: the union of the 11 slices is structurally
 * IDENTICAL to the legacy aggregator. Every field name and type was
 * lifted verbatim and partitioned across slices with NO duplication. The
 * 27 legacy `*HandlerDeps` interfaces in api/*-handlers.ts remain assignable
 * from ApiDispatchDeps via structural subtyping at every dispatcher call
 * site (createSessionHandlers(deps), createMemoryHandlers(deps), ...).
 */
export interface ApiDispatchDeps
  extends SessionsApiDeps,
    MemoryApiDeps,
    ChannelsApiDeps,
    AgentsApiDeps,
    OrchestratorApiDeps,
    WorkspaceApiDeps,
    ConfigApiDeps,
    AuthApiDeps,
    MediaApiDeps,
    ObservabilityApiDeps,
    DaemonApiDeps {}
