/**
 * Central RPC dispatch router.
 * Merges all 14 domain handler modules into a single dispatch function
 * that routes method names to the correct handler. Replaces the ~1,000-line
 * rpcCallInner switch statement in daemon.ts.
 * @module
 */

import type { ChannelPort, VisionProvider, TTSPort, VisionScopeRule, TtsOutputFormat, TtsAutoMode, AppContainer, PerAgentConfig, MemoryWriteValidationResult, SecretStorePort, ExecGitFn } from "@comis/core";
import type { ComisLogger, ErrorKind } from "@comis/infra";
import type { MemoryApi, SqliteMemoryAdapter, createEmbeddingQueue } from "@comis/memory";
import type { CronScheduler, ExecutionTracker, WakeCoalescer, PerAgentHeartbeatRunner } from "@comis/scheduler";
import type { BrowserService, LinkRunner, RpcCall } from "@comis/skills";
import type { createCostTracker, createStepCounter, ModelCatalog } from "@comis/agent";
import type { createCrossSessionSender } from "../cross-session-sender.js";
import type { createSubAgentRunner } from "../sub-agent-runner.js";
import type { DiagnosticCollector } from "../observability/diagnostic-collector.js";
import type { BillingEstimator } from "../observability/billing-estimator.js";
import type { ChannelActivityTracker } from "../observability/channel-activity-tracker.js";
import type { DeliveryTracer } from "../observability/delivery-tracer.js";

import { createCronHandlers } from "./cron-handlers.js";
import { createMemoryHandlers } from "./memory-handlers.js";
import { createSessionHandlers } from "./session-handlers.js";
import { createMessageHandlers } from "./message-handlers.js";
import { createMediaHandlers } from "./media-handlers.js";
import { createConfigHandlers } from "./config-handlers.js";
import { createEnvHandlers } from "./env-handlers.js";
import { createBrowserHandlers } from "./browser-handlers.js";
import { createSubagentHandlers } from "./subagent-handlers.js";
import { createApprovalHandlers } from "./approval-handlers.js";
import { createAgentHandlers } from "./agent-handlers.js";
import { createObsHandlers } from "./obs-handlers.js";
import { createModelHandlers } from "./model-handlers.js";
import { createChannelHandlers } from "./channel-handlers.js";
import { createTokenHandlers, type TokenRegistry } from "./token-handlers.js";
import { createDaemonHandlers } from "./daemon-handlers.js";
import { createMcpHandlers } from "./mcp-handlers.js";
import { createContextHandlers } from "./context-handlers.js";
import { createGraphHandlers } from "./graph-handlers.js";
import { createWorkspaceHandlers } from "./workspace-handlers.js";
import { createHeartbeatHandlers } from "./heartbeat-handlers.js";
import { createSkillHandlers } from "./skill-handlers.js";
import { createNotificationHandlers } from "./notification-handlers.js";
import { createImageHandlers, type ImageHandlerDeps } from "./image-handlers.js";
import type { McpClientManager } from "@comis/skills";
import type { LogLevelManager } from "../observability/log-infra.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Superset of all handler deps interfaces.
 * Each createXxxHandlers factory only reads the fields it declares
 * via TypeScript's structural typing -- no casting needed.
 */
export interface RpcDispatchDeps {
  // Cron deps
  defaultAgentId: string;
  getAgentCronScheduler: (agentId: string) => CronScheduler;
  cronSchedulers: Map<string, CronScheduler>;
  executionTrackers: Map<string, ExecutionTracker>;
  wakeCoalescer: WakeCoalescer;

  // Memory deps
  defaultWorkspaceDir: string;
  workspaceDirs: Map<string, string>;
  memoryApi: MemoryApi;
  memoryAdapter: SqliteMemoryAdapter;
  embeddingQueue?: ReturnType<typeof createEmbeddingQueue>;
  tenantId: string;
  /** Optional memory write validator for security scanning */
  memoryWriteValidator?: (content: string) => MemoryWriteValidationResult;
  /** Optional event bus for memory write security events */
  eventBus?: { emit: (event: string, payload: unknown) => void };

  // Session deps
  agents: Record<string, PerAgentConfig>;
  costTrackers: Map<string, ReturnType<typeof createCostTracker>>;
  stepCounters: Map<string, ReturnType<typeof createStepCounter>>;
  /** Base directory for agent data (e.g., ~/.comis/agents). Used to scan JSONL sessions. */
  agentDataDir?: string;
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

  // Message deps
  adaptersByType: Map<string, ChannelPort>;

  // Media deps
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
  logger: ComisLogger;
  /** Attachment URL resolver for on-demand media tool RPC handlers. */
  resolveAttachment?: (url: string) => Promise<Buffer | null>;
  /** Speech-to-text transcriber for media.transcribe RPC handler. */
  transcriber?: import("@comis/core").TranscriptionPort;
  /** File extractor for media.extract_document RPC handler. */
  fileExtractor?: import("@comis/core").FileExtractionPort;

  // Config deps
  container: AppContainer;
  configPaths: string[];
  defaultConfigPaths: string[];
  configGitManager?: import("@comis/core").ConfigGitManager;
  configWebhook?: { url?: string; timeoutMs?: number; secret?: string };

  // Browser deps
  getAgentBrowserService: (agentId: string) => BrowserService;

  // Approval deps
  approvalGate?: import("@comis/core").ApprovalGate;

  // Agent management deps
  suspendedAgents: Set<string>;
  /** Hot-add callback passed through to agent handlers for runtime agent creation without restart. */
  hotAdd?: (agentId: string, config: PerAgentConfig) => Promise<void>;
  /** Hot-remove callback passed through to agent handlers for runtime agent deletion without restart. */
  hotRemove?: (agentId: string) => Promise<void>;

  // Observability bridge deps
  diagnosticCollector: DiagnosticCollector;
  billingEstimator: BillingEstimator;
  channelActivityTracker: ChannelActivityTracker;
  deliveryTracer: DeliveryTracer;
  budgetGuards?: Map<string, { getSnapshot(): { perExecution: number; perHour: number; perDay: number } }>;

  // Model management deps
  modelCatalog: ModelCatalog;

  // Channel management deps
  channelConfig: Record<string, { enabled: boolean }>;

  // Token management deps
  tokenRegistry: TokenRegistry;
  addToTokenStore: (entry: { id: string; secret: string; scopes: string[] }) => void;
  removeFromTokenStore: (id: string) => void;

  // Env handler deps (Phase quick-47)
  secretStore?: SecretStorePort;
  envFilePath: string;

  // MCP management deps (Phase quick-81)
  mcpClientManager?: McpClientManager;

  // Graph coordinator deps
  graphCoordinator?: import("../graph/graph-coordinator.js").GraphCoordinator;

  // Named graph persistence deps
  namedGraphStore?: import("@comis/memory").NamedGraphStore;

  /** Node type registry for driver config validation */
  nodeTypeRegistry?: import("../graph/node-type-registry.js").NodeTypeRegistry;

  // Daemon infrastructure deps
  logLevelManager: LogLevelManager;

  // Context DAG recall deps
  contextStore?: import("@comis/memory").ContextStore;
  contextEngineConfig?: { maxRecallsPerDay: number; maxExpandTokens: number; recallTimeoutMs: number };

  // Observability persistence deps
  obsStore?: import("@comis/memory").ObservabilityStore;
  startupTimestamp?: number;
  sharedCostTracker?: { reset(): number };

  // Context pipeline collector deps
  contextPipelineCollector?: import("../observability/context-pipeline-collector.js").ContextPipelineCollector;

  // Workspace file management deps
  execGit: ExecGitFn;

  // Gateway attachment deps (Phase quick-91) -- set after gateway init via mutable ref
  wsConnections?: { broadcast(method: string, params: unknown): boolean };
  mediaDir?: string;
  onGatewayAttachment?: (channelId: string, marker: string) => void;

  // Delivery queue
  deliveryQueue?: import("@comis/core").DeliveryQueuePort;

  // Channel health monitor
  healthMonitor?: import("@comis/channels").ChannelHealthMonitor;

  // Embedding cache stats
  /** Embedding cache stats accessor for memory.embeddingCache RPC */
  embeddingCacheStats?: () => import("@comis/memory").EmbeddingCacheStats;
  /** Embedding circuit breaker state accessor for memory persistence operations. */
  embeddingCircuitBreakerState?: () => import("@comis/agent").CircuitState;

  // Channel plugins for capabilities RPC
  channelPlugins?: Map<string, import("@comis/core").ChannelPluginPort>;

  // Skill management deps
  skillRegistries?: Map<string, import("@comis/skills").SkillRegistry>;

  // Heartbeat deps
  perAgentRunner?: PerAgentHeartbeatRunner;
  globalHeartbeatConfig?: Record<string, unknown>;

  // Notification deps (Proactive v1)
  notificationService?: import("../notification/notification-service.js").NotificationService;

  // Image generation deps (Proactive v1 -- IMGN)
  imageHandlerDeps?: ImageHandlerDeps;
}

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------

/**
 * Classify an RPC error message for structured logging.
 * Returns an ErrorKind and actionable hint for Pino structured logs.
 */
export function classifyRpcError(errMsg: string): { errorKind: ErrorKind; hint: string } {
  if (errMsg.includes("immutable")) return { errorKind: "config", hint: "This config path requires daemon restart to change" };
  if (errMsg.includes("Admin access required")) return { errorKind: "auth", hint: "Use an admin-level token for this operation" };
  if (errMsg.includes("Unknown RPC method")) return { errorKind: "validation", hint: "Check method name spelling and registered methods" };
  if (errMsg.includes("not found")) return { errorKind: "validation", hint: "The requested resource does not exist" };
  if (errMsg.includes("validation failed") || errMsg.includes("Invalid input")) return { errorKind: "validation", hint: "Check parameter types and values against the schema" };
  return { errorKind: "internal", hint: "Check the RPC method handler and its dependencies" };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create the central RPC dispatch function.
 * Merges all 14 domain handler maps into a single lookup table and returns
 * an async function that routes method names to the correct handler.
 * @param deps - Superset of all handler dependencies
 * @returns RpcCall function that dispatches to domain handlers
 */
export function createRpcDispatch(deps: RpcDispatchDeps): RpcCall {
  // Late-binding ref for context.recall -> session.spawn self-dispatch
  let selfDispatch: RpcCall = async () => { throw new Error("dispatch not ready"); };

  // Build handler maps from each domain factory
  const handlers: Record<string, (params: Record<string, unknown>) => Promise<unknown>> = {
    ...createCronHandlers(deps),
    ...createMemoryHandlers(deps),
    ...createSessionHandlers(deps),
    ...createMessageHandlers(deps),
    ...createMediaHandlers(deps),
    ...createConfigHandlers(deps),
    ...createEnvHandlers(deps),
    ...createBrowserHandlers(deps),
    ...createSubagentHandlers(deps),
    ...((deps.graphCoordinator || deps.namedGraphStore) ? createGraphHandlers({
      graphCoordinator: deps.graphCoordinator!,
      defaultAgentId: deps.defaultAgentId,
      securityConfig: deps.securityConfig,
      logger: deps.logger,
      namedGraphStore: deps.namedGraphStore,
      tenantId: deps.tenantId,
      dataDir: deps.container.config.dataDir || ".",
      nodeTypeRegistry: deps.nodeTypeRegistry,
    }) : {}),
    ...(deps.approvalGate ? createApprovalHandlers({ approvalGate: deps.approvalGate }) : {}),
    ...createAgentHandlers({
      ...deps,
      secretManager: deps.container?.secretManager,
      persistDeps: {
        container: deps.container,
        configPaths: deps.configPaths,
        defaultConfigPaths: deps.defaultConfigPaths,
        configGitManager: deps.configGitManager,
        logger: deps.logger,
      },
    }),
    ...createObsHandlers(deps),
    ...createModelHandlers(deps),
    ...createChannelHandlers({
      ...deps,
      persistDeps: {
        container: deps.container,
        configPaths: deps.configPaths,
        defaultConfigPaths: deps.defaultConfigPaths,
        configGitManager: deps.configGitManager,
        logger: deps.logger,
      },
    }),
    ...createTokenHandlers({
      ...deps,
      persistDeps: {
        container: deps.container,
        configPaths: deps.configPaths,
        defaultConfigPaths: deps.defaultConfigPaths,
        configGitManager: deps.configGitManager,
        logger: deps.logger,
      },
    }),
    ...createMcpHandlers({ mcpClientManager: deps.mcpClientManager, logger: deps.logger }),
    ...createDaemonHandlers({ logLevelManager: deps.logLevelManager }),
    // Workspace file management handlers
    ...createWorkspaceHandlers({
      agents: deps.agents,
      workspaceDirs: deps.workspaceDirs,
      defaultWorkspaceDir: deps.defaultWorkspaceDir,
      logger: deps.logger,
      execGit: deps.execGit,
      memoryApi: deps.memoryApi,
      memoryAdapter: deps.memoryAdapter,
      tenantId: deps.tenantId,
    }),
    // Heartbeat management handlers
    ...createHeartbeatHandlers({
      perAgentRunner: deps.perAgentRunner,
      agents: deps.agents,
      persistDeps: deps.container ? {
        container: deps.container,
        configPaths: deps.configPaths,
        defaultConfigPaths: deps.defaultConfigPaths,
        configGitManager: deps.configGitManager,
        logger: deps.logger,
      } : undefined,
      globalHeartbeatConfig: deps.globalHeartbeatConfig,
    }),
    // Skill management handlers
    ...createSkillHandlers({
      skillRegistries: deps.skillRegistries,
      workspaceDirs: deps.workspaceDirs,
      defaultAgentId: deps.defaultAgentId,
      container: deps.container,
      eventBus: deps.container.eventBus,
    }),
    // Proactive v1: Notification handlers
    ...(deps.notificationService
      ? createNotificationHandlers({ notificationService: deps.notificationService })
      : {}),
    // Proactive v1: Image generation handlers (IMGN)
    ...(deps.imageHandlerDeps
      ? createImageHandlers(deps.imageHandlerDeps)
      : {}),
    // Context DAG recall handlers (conditional on contextStore)
    ...(deps.contextStore ? createContextHandlers({
      store: deps.contextStore,
      tenantId: deps.tenantId,
      resolveConversationId: (sessionKey: string) =>
        deps.contextStore!.getConversationBySession(deps.tenantId, sessionKey)?.conversation_id,
      rpcCall: async (method, params) => selfDispatch(method, params),
      config: deps.contextEngineConfig ?? { maxRecallsPerDay: 5, maxExpandTokens: 4000, recallTimeoutMs: 120000 },
      logger: deps.logger,
    }) : {}),
  };

  // Return the dispatch function
  // All handler errors are caught and logged through Pino with structured fields
  // before re-throwing, ensuring errors never escape to raw stderr.
  const dispatch: RpcCall = async (method: string, params: Record<string, unknown>): Promise<unknown> => {
    const handler = handlers[method];
    if (!handler) {
      throw new Error(`Unknown RPC method: ${method}`);
    }
    try {
      return await handler(params);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      const classified = classifyRpcError(errMsg);
      deps.logger.error(
        {
          method,
          err,
          hint: classified.hint,
          errorKind: classified.errorKind,
        },
        "JSON-RPC method error",
      );
      throw err;
    }
  };

  // Wire self-dispatch for context.recall -> session.spawn delegation
  selfDispatch = dispatch;

  return dispatch;
}
