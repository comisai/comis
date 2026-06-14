// SPDX-License-Identifier: Apache-2.0
/**
 * Per-domain API dependency slices for daemon RPC handlers.
 *
 * The monolithic dispatcher-deps superset is replaced with 11 per-domain
 * cluster slices. Each handler factory consumes its narrow slice; the
 * ApiDispatchDeps aggregator (extends all 11) is consumed ONLY by the
 * dispatcher itself.
 *
 * The field partition is exhaustive: every field on the legacy
 * dispatcher-deps interface maps to exactly one cluster slice. The
 * aggregator's `extends` clause unions all 11 slices back into the legacy
 * shape, preserving structural compatibility with the 27 still-legacy
 * `*HandlerDeps` interfaces in api/*-handlers.ts.
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
  MutableSecretManager,
} from "@comis/core";
import type { ComisLogger } from "@comis/infra";
import type { MemoryApi, SqliteMemoryAdapter, createEmbeddingQueue } from "@comis/memory";
import type { CronScheduler, ExecutionTracker, WakeCoalescer, PerAgentHeartbeatRunner } from "@comis/scheduler";
import type { BrowserService, LinkRunner, McpClientManager, TokenStore } from "@comis/skills";
import type { createCostTracker, createStepCounter, createSubAgentRunner } from "@comis/agent";
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
  securityConfig: { agentToAgent?: { enabled?: boolean; waitTimeoutMs: number; subAgentToolGroups?: string[] } };
  tenantId: string;
  /** Structured logger threaded through every cluster slice (DaemonApiDeps
   *  is required; SessionsApiDeps mirrors required for multi-extends parity). */
  logger: ComisLogger;
  /** Optional approval gate handle for clearing approval cache on session events.
   *  session-handlers reads `deps.approvalGate?.clearApprovalCache`. */
  approvalGate?: import("@comis/core").ApprovalGate;
  /** Optional LLM summarizer for session search results. */
  summarizeSession?: (messages: unknown[], query: string) => Promise<string | null>;
  /** Optional DeliveryQueuePort for the session.history handler's
   *  deliveryStatus join. Absent in deployments that have no delivery queue
   *  (no channel adapters) -- the handler then reports every message as
   *  confirmed (nothing pending to mark). The MCP resources/read surface
   *  consumes the derived field to filter to CONFIRMED-only messages, but the
   *  field is also useful to the dashboard / observers. */
  deliveryQueue?: import("@comis/core").DeliveryQueuePort;
  /** LCD lossless-store write+run surface — the `session.reset_conversation`
   *  handler (Phase 164-06) calls `deleteConversationLcd` inside
   *  `runOnConversation` to clear a conversation's lcd_* rows. Optional:
   *  the handler fails-closed (throws "LCD store not available") when absent,
   *  never silently returning a 0 count. The same ContextStorePort instance is
   *  also on MemoryApiDeps; the SessionsApiDeps copy here lets the
   *  session-archive.ts handler access it without widening the consumption type
   *  to the full MemoryApiDeps slice. */
  lcdStore?: import("@comis/core").ContextStorePort;
  /** MemoryPort for session-archive --memory reset (DIST-05). The concrete
   *  adapter is SqliteMemoryAdapter (which implements MemoryPort) — it is the
   *  SAME object as MemoryApiDeps.memoryAdapter, threaded onto this slice at the
   *  composition root (daemon.ts) so the session.reset_conversation handler can
   *  call `deleteBySessionKey` without widening to the full MemoryApiDeps slice.
   *  Optional so existing handler tests construct deps without it; when absent the
   *  --memory flag logs a not-available WARN and clears LCD + sessionStore only. */
  memoryPort?: import("@comis/core").MemoryPort;
  /** MemoryConsolidationStore for --memory consolidated-observation unlink /
   *  --purge-derived (DIST-05). The SAME instance as MemoryApiDeps.consolidationStore.
   *  Optional for the same handler-test reason; absent ⇒ the unlink/purge steps are
   *  skipped (the by-session memory delete itself still runs). */
  consolidationStore?: import("@comis/core").MemoryConsolidationStore;
  /** Runtime-layer (L3) destroy for `session.reset_conversation` — live finding
   *  2026-06-11: clearing LCD + sessionStore alone resurrects (the surviving pi
   *  runtime JSONL re-ingests wholesale via the lcd-ingest epoch rebase). Wired
   *  at the composition root from `createConversationReset(...).destroyRuntimeSession`
   *  bound to the default agent. Returns true when an adapter destroy ran.
   *  Optional: absent ⇒ the handler reports `runtimeSessionDestroyed: false`
   *  and WARNs with the resurrection consequence (honest degradation). */
  destroyRuntimeSession?: (formattedSessionKey: string) => Promise<boolean>;
  /** Executor session-scoped state cleanup (175-REVIEW CR-02): wired at the
   *  composition root (daemon.ts) to @comis/agent's clearSessionState — the
   *  single authoritative path that drops the per-key tool-schema snapshots,
   *  the GBNF-02 strip-retry once-gate, JIT-guide delivery, cache latches,
   *  etc. session.reset_conversation / session.delete call it so a reset or
   *  recreated session does not inherit the old key's executor state (the
   *  strip once-gate would otherwise terminal-fail the "fresh" session's
   *  first grammar-400 with zero repair attempts). Optional so existing
   *  handler tests construct deps without it; absent ⇒ skipped. */
  clearAgentSessionState?: (formattedSessionKey: string) => void;
}

/**
 * Dependencies for memory-handlers + context-handlers
 * (memory.read/write/search/embeddingCache, context.recall/expand).
 */
// @optional-field-count: 14 optional fields — MemoryApiDeps is the shared slice
// for memory-handlers, so it carries TWO feature-gated dep families: the
// memory-diagnostic deps (consolidationStore/entityStore/
// recallCounters/dataDir — each absent ⇒ the corresponding admin diagnostic is
// unavailable / zeroed, never a stub); and the
// dialectic deps (dialecticSeam/buildDialecticRecall — each absent ⇒ memory.ask
// returns the abstain sentinel, never a stub). Every optional is a real runtime
// feature-switch documented row-by-row in packages/daemon/AUDIT-memory.md;
// tightening them to required would force every dispatcher call site to
// fabricate stubs. Splitting the slice would break the structural-subtyping
// invariant the 27 legacy *HandlerDeps depend on (see ApiDispatchDeps).
// (Phase 126: the context-DAG quartet — contextStore/store/config/
// contextEngineConfig/resolveConversationId/rpcCall — was removed with the
// deleted context-handlers; the governed expansion surface is rebuilt fresh
// against the lcd_* store in Phase 131.)
export interface MemoryApiDeps {
  /** memory-handlers + context-handlers read deps.defaultAgentId / deps.tenantId. */
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
  /** memory-handlers reads deps.logger.warn/info; context-handlers reads
   *  deps.logger.info/warn. Required (matches other slices for multi-extends parity). */
  logger: ComisLogger;
  // Embedding cache stats accessors
  /** Embedding cache stats accessor for memory.embeddingCache RPC */
  embeddingCacheStats?: () => import("@comis/memory").EmbeddingCacheStats;
  /** Embedding circuit breaker state accessor for memory persistence operations. */
  embeddingCircuitBreakerState?: () => import("@comis/agent").CircuitState;
  // Memory-diagnostic deps
  /** Consolidation store — the `memory.observations` handler reads provenance
   *  via `listObservations(agentId, tenantId, limit)` (scoped). Same port type
   *  setup-memory builds; optional so existing handler tests construct deps
   *  without it. */
  consolidationStore?: import("@comis/core").MemoryConsolidationStore;
  /** Entity store — the `memory.entities` handler reads the entity graph via
   *  `listEntities(agentId, tenantId, limit)` (scoped). Optional for the
   *  same backward-compat reason. */
  entityStore?: import("@comis/core").MemoryEntityStore;
  /** Live in-process recall counters. The `memory.recall_stats`
   *  handler reads `snapshot()`; wired from `wireRecallCounters(eventBus)` at
   *  the composition root. Optional — when unset the handler returns zeroed
   *  counters (the gauge is process-lifetime, resets on restart). */
  recallCounters?: { snapshot: () => import("@comis/observability").RecallCountersSnapshot };
  /** Data directory (e.g. ~/.comis) for the `memory.recall_trace` JSONL read.
   *  The handler resolves `<dataDir>/logs/recall-trace.jsonl` via
   *  `resolveRecallTraceFilePath`. Optional — mirrors ObservabilityApiDeps.dataDir;
   *  defaults to ~/.comis at handler-construction time when omitted. */
  dataDir?: string;
  /** The diagnostics.recallTrace.enabled gate (live finding 2026-06-11) — the
   *  `memory.recall_trace` handler reports it as `tracingEnabled` and, on an
   *  empty result, hints WHY (recorder disabled vs no matching traces yet)
   *  instead of a silent `{records: []}`. Optional — absent reads as false
   *  (the schema default for the opt-in recorder). */
  recallTraceEnabled?: boolean;
  // Dialectic deps (the memory.ask handler).
  /** The INJECTED query-time dialectic synthesis seam (the `createDialecticSeam`
   *  output, built + injected from a cheap resolved model + key). The
   *  `memory.ask` handler calls it ONLY on the non-empty-recall path (empty recall ⇒
   *  abstain in CODE without the seam call). Optional so existing handler tests construct
   *  deps without it; the handler abstains gracefully when absent (no key / not wired). */
  dialecticSeam?: (
    agentId: string,
    question: string,
    groundingText: string,
  ) => Promise<import("@comis/agent").DialecticParsed>;
  /** A per-agent recall factory returning the FULL `createMemoryRecall` orchestrator built
   *  with the daemon's store set + the INVOKING agent's RagConfig (re-reads the calling
   *  agent's `rag`, not the default agent's). The `memory.ask` handler runs THIS over the
   *  question — NOT `deps.memoryApi.search` (which bypasses the trust filter). Injecting the
   *  builder keeps the 8-store deps off this slice. Optional so existing handler tests construct
   *  deps without it; the handler abstains when absent. */
  buildDialecticRecall?: (agentId: string) => import("@comis/agent").MemoryRecall;
  /** The per-agent dialectic grounding-set HARD ceiling resolver (`dialectic.maxRecall`, default
   *  10) — the DoS bound on the synthesis LLM input. The `memory.ask` handler calls
   *  it with the INVOKING agentId and clamps the caller-controlled `limit` to `[1, ceiling]`: a
   *  huge/negative `limit` can never flood the prompt or negative-slice the grounding. A function
   *  (not a scalar) so each agent's OWN bound is honored. Optional so existing handler tests omit
   *  it; the handler falls back to the schema default (10) when absent. */
  dialecticMaxRecall?: (agentId: string) => number;
  /** Suspicious-pattern telemetry callback for the dialectic grounding — surfaced to
   *  `wrapExternalContent` so a detected injection in recalled content is reported (the SAME
   *  hook rag-retriever threads). Optional; absent ⇒ no telemetry (sanitization still runs). */
  onSuspiciousContent?: import("@comis/core").WrapExternalContentOptions["onSuspiciousContent"];
  /** LCD lossless-store read surface — the `context.tree` handler resolves a
   *  conversation's context_items + summaries via `getContextItems` /
   *  `getSummaries` (R4 agent+tenant scoped). The SAME ContextStorePort
   *  setup-memory builds (`lcdStore`). Optional so existing handler tests build
   *  deps without it; the context.* handlers fail-closed (empty result) when absent. */
  lcdStore?: import("@comis/core").ContextStorePort;
  /** LCD operator-browse read surface — the `context.conversations` handler
   *  enumerates the agent's distinct conversations via `listConversations`
   *  (R4 agent+tenant scoped). Built by setup-memory (`createLcdBrowseStore`).
   *  Optional for the same handler-test reason; absent ⇒ empty result. */
  contextBrowse?: import("@comis/core").ContextBrowsePort;
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
  // Gateway attachment deps -- set after gateway init via mutable ref
  wsConnections?: { broadcast(method: string, params: unknown): boolean };
  mediaDir?: string;
  onGatewayAttachment?: (channelId: string, marker: string) => void;
  // Delivery queue + service
  deliveryQueue?: import("@comis/core").DeliveryQueuePort;
  /** DeliveryService constructed once at the daemon composition root
   *  (setup-channels.ts). Passed through to createMessageHandlers so
   *  `message.send` / `message.reply` use the method form
   *  `deps.deliveryService.deliverToChannel(...)`. */
  deliveryService: import("@comis/core").DeliveryService;
  // Channel health monitor
  healthMonitor?: import("@comis/channels").ChannelHealthMonitor;
  // Channel plugins for capabilities RPC. Required: the production
  // composition root (setup-channels-adapters.ts) always wires this Map
  // with ≥9 plugin entries before `buildRpcDispatchDeps` runs. Tests must
  // pass a Map (possibly empty) — see message-handlers.test.ts fixtures.
  channelPlugins: Map<string, import("@comis/core").ChannelPluginPort>;
  /** message-handlers reads deps.defaultAgentId, deps.defaultWorkspaceDir,
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
  /** Hot-add callback passed through to agent handlers for runtime agent creation without restart.
   *  `rawRerankEnabled` is the RAW (pre-Zod-default) rag.rerank.enabled from the RPC input so the
   *  hot-added agent's effective-rerank precedence distinguishes unset from explicit-off. */
  hotAdd?: (agentId: string, config: PerAgentConfig, rawRerankEnabled?: boolean | undefined) => Promise<void>;
  /** Hot-remove callback passed through to agent handlers for runtime agent deletion without restart. */
  hotRemove?: (agentId: string) => Promise<void>;
  // Model management
  modelCatalog: ModelCatalog;
  // Daemon-level OAuth credential store handle for the agents.update
  // oauthProfiles existence check. When absent (e.g. tests), the validation
  // block in agent-handlers becomes a no-op and existing behavior is
  // preserved.
  oauthCredentialStore?: import("@comis/core").OAuthCredentialStorePort;
  /** agent-handlers / model-handlers / provider-handlers read deps.agents
   *  (PerAgentConfig map). model-handlers expects a slightly narrower shape
   *  (provider + model only); structural subtyping accepts the broader
   *  PerAgentConfig record at the call site. */
  agents: Record<string, PerAgentConfig>;
  /** agent-handlers reads deps.defaultAgentId (cannot be deleted). */
  defaultAgentId: string;
  /** agent/provider-handlers read deps.persistDeps for YAML writes. */
  persistDeps?: PersistToConfigDeps;
  /** agent/provider-handlers read deps.secretManager for apiKey checks. */
  secretManager?: import("@comis/core").SecretManager;
  /** agent/model/provider-handlers read deps.providerEntries. */
  providerEntries?: Record<string, ProviderEntry>;
  /** agent-handlers reads deps.modelsConfig for credential resolver. */
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
   *  NodeTypeRegistry type is structurally compatible. */
  nodeTypeRegistry?: import("../graph/node-type-registry.js").NodeTypeRegistry;
  // Heartbeat deps
  perAgentRunner?: PerAgentHeartbeatRunner;
  globalHeartbeatConfig?: Record<string, unknown>;
  /** cron / graph / subagent handlers read deps.defaultAgentId. */
  defaultAgentId: string;
  /** graph / subagent handlers read deps.tenantId. */
  tenantId: string;
  /** heartbeat-handlers reads deps.agents (PerAgentConfig map). */
  agents: Record<string, PerAgentConfig>;
  /** heartbeat-handlers reads deps.persistDeps for YAML writes. */
  persistDeps?: PersistToConfigDeps;
  /** graph-handlers reads deps.securityConfig.agentToAgent.enabled. */
  securityConfig: { agentToAgent?: { enabled?: boolean; waitTimeoutMs: number; subAgentToolGroups?: string[] } };
  /** graph / subagent handlers read deps.logger.info/warn. Required
   *  (matches other slices for multi-extends parity; DaemonApiDeps.logger is required). */
  logger: ComisLogger;
  /** graph-handlers reads deps.dataDir for graph-runs output. */
  dataDir?: string;
  /** subagent-handlers reads deps.subAgentRunner.list/kill/steer. */
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
  // MCP management deps — always defined; setupMcp constructs the manager
  // unconditionally so runtime `mcp.connect` RPCs work even when zero
  // servers were configured at startup.
  mcpClientManager: McpClientManager;
  // Skill management deps
  skillRegistries?: Map<string, import("@comis/skills").SkillRegistry>;
  // Notification deps (Proactive v1)
  notificationService?: import("../notification/notification-service.js").NotificationService;
  // Workspace file management deps
  execGit: ExecGitFn;
  /** workspace-handlers reads deps.agents (PerAgentConfig map). */
  agents: Record<string, PerAgentConfig>;
  /** browser / skill handlers read deps.defaultAgentId. */
  defaultAgentId: string;
  /** workspace-handlers reads deps.defaultWorkspaceDir. */
  defaultWorkspaceDir: string;
  /** workspace / skill handlers read deps.workspaceDirs. */
  workspaceDirs: Map<string, string>;
  /** workspace / mcp handlers read deps.logger. */
  logger: ComisLogger;
  /** workspace-handlers reads deps.tenantId (memory-attach context).
   *  Required to align with SessionsApiDeps/MemoryApiDeps/OrchestratorApiDeps for
   *  the ApiDispatchDeps multi-extends. */
  tenantId: string;
  /** workspace-handlers reads deps.memoryApi (memory.attach RPC).
   *  Required to align with MemoryApiDeps for the ApiDispatchDeps multi-extends. */
  memoryApi: MemoryApi;
  /** workspace-handlers reads deps.memoryAdapter (memory.attach RPC).
   *  Required to align with MemoryApiDeps for the ApiDispatchDeps multi-extends. */
  memoryAdapter: SqliteMemoryAdapter;
  /** skill-handlers reads deps.container (bootstrap dataDir access). */
  container: AppContainer;
  /** skill-handlers reads deps.eventBus for skill lifecycle events. */
  eventBus?: AppContainer["eventBus"];
  /** mcp-handlers reads deps.secretManager?.has for env-ref validation. */
  secretManager?: import("@comis/core").SecretManager;
  /** mcp-handlers reads deps.secretStore for static-secret header extraction.
   *  Always wired (selectSecretStore returns a store for all modes).
   *  Same shape as AuthApiDeps.secretStore / ConfigApiDeps.secretStore
   *  so the ApiDispatchDeps multi-extends remains well-formed. */
  secretStore: SecretStorePort;
  /** mcp-handlers reads deps.persistDeps for YAML writes via persistMcpServers.
   *  Same shape as ChannelsApiDeps.persistDeps / AgentsApiDeps.persistDeps /
   *  OrchestratorApiDeps.persistDeps so the ApiDispatchDeps multi-extends
   *  remains well-formed. */
  persistDeps?: PersistToConfigDeps;
  /**
   * Factory for the per-server MCP-OAuth token store. mcp-handlers reads
   * this to check whether a token already exists for an `auth:"oauth"`
   * server before attempting `manager.connect` — when no token is present
   * yet, the daemon short-circuits to `needs_oauth_login` instead of
   * driving the SDK's DCR with empty `redirect_uris`. Same shape as
   * `McpOauthHandlerDeps.createTokenStore` so both handlers can share one
   * process-wide token-store factory. Optional — undefined skips the
   * pre-check (existing tests construct deps without it).
   *
   * The factory itself MAY return undefined: in `env` storage mode
   * `selectMcpTokenStore` yields no writable store, so the daemon's pass-through
   * (`() => boot.mcpTokenStore`) returns undefined. Consumers MUST guard the
   * returned value (treat undefined as "no token store" / fail loudly) rather
   * than dereferencing it.
   */
  createTokenStore?: () => TokenStore | undefined;
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
  // Env handler deps
  envFilePath: string;
  /** config-handlers + env-handlers read deps.logger.
   *  Required (matches other slices for multi-extends parity; DaemonApiDeps.logger is required). */
  logger: ComisLogger;
  /** config-handlers' credential guard reads deps.oauthCredentialStore
   *  to confirm an agent's `oauthProfiles[provider]` entry exists. Same shape as
   *  AgentsApiDeps.oauthCredentialStore + AuthApiDeps.oauthCredentialStore so the
   *  ApiDispatchDeps multi-extends remains well-formed. */
  oauthCredentialStore?: import("@comis/core").OAuthCredentialStorePort;
  /** env-handlers reads deps.secretStore for the secret write path.
   *  Always wired (selectSecretStore returns a store for all modes).
   *  Same shape as AuthApiDeps.secretStore so the ApiDispatchDeps multi-extends remains well-formed. */
  secretStore: SecretStorePort;
  /** Daemon-owned write handle over the shared SecretManager backing Map.
   *  Used by env-handlers to upsert new-name writes live (additive no-restart).
   *  MUST NOT appear on AppContainer. Required — always wired at the composition root. */
  mutableSecretManager: MutableSecretManager;
  /**
   * When `false`, config-handlers skip the config-audit JSONL append
   * at the config.patch RPC handler call sites (config-write.ts:124,
   * 390). Default-true semantics — when `undefined`, the audit hook
   * runs. Wired from
   * `container.config.diagnostics?.configAudit?.enabled !== false`
   * at the rpc-dispatch.ts composition root.
   */
  auditEnabled?: boolean;
}

/**
 * Dependencies for auth-handlers + secrets-handlers + token-handlers
 * (auth.oauth.list/connect, secrets.get/set, tokens.list/create/revoke).
 */
export interface AuthApiDeps {
  // Secret store (env-handlers, secrets-handlers) — always wired
  secretStore: SecretStorePort;
  /** Daemon-owned write handle over the shared SecretManager backing Map.
   *  Used by secrets-handlers to upsert/remove live (additive no-restart). Required. */
  mutableSecretManager: MutableSecretManager;
  // Token management deps. The structural shape mirrors `TokenRegistry`
  // declared in `./token-handlers.ts` -- inlined here to keep this file at
  // the bottom of the api/ import graph (madge cycle constraint).
  tokenRegistry: {
    list(): Array<{ id: string; scopes: readonly string[]; createdAt: number; revoked: boolean }>;
    get(id: string): { id: string; scopes: readonly string[]; createdAt: number; revoked: boolean } | undefined;
    create(id: string, secret: string, scopes: string[]): { id: string; scopes: readonly string[]; createdAt: number; revoked: boolean };
    revoke(id: string): boolean;
  };
  addToTokenStore: (entry: { id: string; secret: string; scopes: string[] }) => void;
  removeFromTokenStore: (id: string) => void;
  /** auth-handlers reads deps.oauthCredentialStore for OAuth
   *  profile list / delete. Same shape as AgentsApiDeps.oauthCredentialStore
   *  + ConfigApiDeps.oauthCredentialStore so the ApiDispatchDeps multi-extends
   *  remains well-formed. */
  oauthCredentialStore?: import("@comis/core").OAuthCredentialStorePort;
  /** auth + secrets handlers read deps.container for audit
   *  eventBus emit + tenant lookup. Same shape as ConfigApiDeps.container
   *  + WorkspaceApiDeps.container so the ApiDispatchDeps multi-extends
   *  remains well-formed. */
  container: AppContainer;
  /** auth + secrets handlers read deps.logger. Required (matches other
   *  slices for multi-extends parity; DaemonApiDeps.logger is required). */
  logger: ComisLogger;
  /** token-handlers reads deps.persistDeps for runtime token
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
  // Image generation deps. The structural shape mirrors `ImageHandlerDeps`
  // declared in `./image-handlers.ts` -- inlined here to keep this file at
  // the bottom of the api/ import graph (madge cycle constraint). The
  // dispatcher in api/rpc-dispatch.ts is responsible for passing this
  // through to createImageHandlers.
  imageHandlerDeps?: {
    provider: import("@comis/core").ImageGenerationPort;
    rateLimiter: import("@comis/skills").ImageGenRateLimiter;
    config: import("@comis/core").ImageGenerationConfig;
    logger: ComisLogger;
    /** Direct channel delivery -- resolve adapter by channel type. */
    getChannelAdapter: (channelType: string) => Pick<import("@comis/core").ChannelPort, "sendAttachment"> | undefined;
    /** RES-01: resolve the agent's main provider in lockstep with the
     *  completion path (I4 — delegates to the same resolveAgentModel). The
     *  handler uses this only for observability + lockstep verification; the
     *  provider INSTANCE is selected at wiring time (setup-image-provider.ts),
     *  never re-derived here (no second source of truth). */
    resolveAgentMainProvider: (agentId: string) => { providerId: string };
    /** IN-01 (185): resolve a `reference_image` workspace file path under the
     *  caller's agent dir (safePath confinement). Mirror MediaApiDeps:572-573. */
    workspaceDirs: Map<string, string>;
    defaultWorkspaceDir: string;
    /** DEL-01 (186): the per-agent persistence getter. Persists the generated
     *  image buffer to the agent's confined workspace (`~/.comis/workspace/media/
     *  photos/`) via MediaPersistenceService — replacing the ephemeral tmpdir
     *  write+delete. The agentId resolves the workspace inside the getter
     *  (mirrors the screenshot precedent at setup-tools.ts:305). Never throws —
     *  returns `err` on a persistence failure so the handler falls through to the
     *  base64 fallback. `PersistedFile` is on the `@comis/skills/tools` subpath
     *  (NOT the bare barrel — the proven import path, setup-tools.ts:69). */
    persist: (
      agentId: string,
      buffer: Buffer,
      opts: { mediaKind: "image"; mimeType: string },
    ) => Promise<import("@comis/shared").Result<import("@comis/skills/tools").PersistedFile, Error>>;
    /** OBS-04 (186): the per-session trajectory recorder registry. The handler
     *  resolves the recorder by `_callerSessionKey` and direct-emits the 4
     *  image.* lifecycle events via `getRecorder(sessionKey)?.recordEvent(...)`
     *  (the comis-session-manager.ts:298 precedent — the daemon RPC context has
     *  NO eventBus bridge). Optional: `getRecorder?.()` no-ops to a non-crash on
     *  a boot mode without a registry, and a null recorder is skipped. Read off
     *  the BootContext `c.trajectoryRegistry` (already a field). */
    trajectoryRegistry?: import("@comis/observability").SessionTrajectoryHandleRegistry;
    /** SEC-02 (186): the per-agent/hour USD cost ceiling. Optional — undefined
     *  when `integrations.media.imageGeneration.maxCostPerHourUsd` is unset, in
     *  which case the ceiling check is skipped and only the count rate limit
     *  applies (no regression). When present, the handler pre-checks
     *  `canSpend(agentId)` BEFORE provider.execute (block with quota_exceeded)
     *  and `record(agentId, costUsd)` AFTER a successful generation. The count
     *  rate limiter (maxPerHour) is RETAINED and orthogonal. Constructed in
     *  buildImageGenBundle (main-helpers.ts), gated on maxCostPerHourUsd. */
    costLimiter?: import("./image-cost-limiter.js").ImageCostLimiter;
    /** OBS-03 (186, optional secondary): the typed event bus. After a successful
     *  generation with a non-zero costUsd the handler emits a synthetic
     *  `observability:token_usage` (tokens all 0, cost.total = costUsd) so the
     *  image cost reaches sharedCostTracker + the token_usage SQLite table +
     *  billing — the BINDING OBS-03 assertion is the trajectory `image.generated`
     *  cost-carry (Route a), this is the secondary. Same shape as the
     *  MemoryApiDeps / WorkspaceApiDeps eventBus so the slices unify. */
    eventBus?: AppContainer["eventBus"];
  };
  /** media-handlers reads deps.workspaceDirs / deps.defaultWorkspaceDir
   *  / deps.defaultAgentId for STT / vision / link-processing file paths.
   *  Same shape as ChannelsApiDeps + WorkspaceApiDeps for ApiDispatchDeps multi-extends parity. */
  workspaceDirs: Map<string, string>;
  defaultWorkspaceDir: string;
  defaultAgentId: string;
  /** media-handlers reads deps.logger. Required (matches other
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
  /** obs-handlers emits `observability:reset` on obs.reset. Same
   *  shape as MemoryApiDeps.eventBus / WorkspaceApiDeps.eventBus so the
   *  ApiDispatchDeps multi-extends remains well-formed. */
  eventBus?: AppContainer["eventBus"];
  /** obs-handlers reads deps.agents?.[id]?.budgets for budget
   *  snapshot RPCs. Same shape as AgentsApiDeps.agents / OrchestratorApiDeps.agents
   *  / WorkspaceApiDeps.agents so the ApiDispatchDeps multi-extends remains
   *  well-formed. obs-handlers tolerates the broader PerAgentConfig record
   *  structurally (only `.budgets?` is read). */
  agents: Record<string, PerAgentConfig>;
  /** obs-handlers exposes embedding cache stats via the
   *  memory.embeddingCache RPC. Same shape as MemoryApiDeps.embeddingCacheStats
   *  so the ApiDispatchDeps multi-extends remains well-formed. */
  embeddingCacheStats?: () => import("@comis/memory").EmbeddingCacheStats;
  /** obs-handlers exposes embedding circuit breaker state.
   *  Same shape as MemoryApiDeps.embeddingCircuitBreakerState so the
   *  ApiDispatchDeps multi-extends remains well-formed. */
  embeddingCircuitBreakerState?: () => import("@comis/agent").CircuitState;
  /** obs-handlers reads deps.tokenTracker for cache stats RPC.
   *  Only used by obs-handlers; no cross-slice collision. */
  tokenTracker?: import("../observability/token-tracker.js").TokenTracker;
  /**
   * Directory containing session-index.YYYY-MM-DD.jsonl files.
   * Used by obs.trace.* handlers. Defaults to $HOME/.comis at handler-construction
   * time when omitted. Optional preserves backward compatibility with existing
   * handler tests that pass {} for deps.
   */
  dataDir?: string;
  /**
   * Injected ClockPort for obs.fleet.health's `sinceHours` -> `sinceMs`
   * conversion (the globals gate forbids Date.now()/new Date() in the
   * handler/assembler). Populated by `buildRpcDispatchDeps` in daemon.ts
   * (Phase 161-02) from `boot.clock`. Optional preserves existing handler
   * tests that pass {} for deps; the fleet handler asserts `deps.clock!`
   * because 161-02 always populates it, and the fleet tests inject a fakeClock.
   */
  clock?: import("@comis/core").ClockPort;
  /**
   * DI seam for the bundle pipeline.
   * Tests inject a stub that returns ok({ bundleDir: "/tmp/bundle", ... }).
   * Production wires the real exportTrajectoryBundle from @comis/observability.
   * Optional preserves backward compatibility.
   */
  exportTrajectoryBundle?: typeof import("@comis/observability").exportTrajectoryBundle;
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
 * in api/rpc-dispatch.ts; never by individual handler factories. The
 * architecture test bans handler-to-handler imports; aggregator narrowing is
 * structural and happens at the dispatcher boundary.
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
