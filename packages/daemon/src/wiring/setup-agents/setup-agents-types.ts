// SPDX-License-Identifier: Apache-2.0
/**
 * Daemon agents-subsystem types.
 *
 * Holds the `SingleAgentDeps` and `SingleAgentResult` interfaces so the
 * runtime and registry leaves can both reference them without inflating
 * either leaf.
 *
 * @module
 */

import type {
  AppContainer,
  ExecutionPlanPort,
  FileLockPort,
  InjectionRateLimiter,
  OAuthCredentialStorePort,
  SecretsCrypto,
  ToolCapabilityPort,
} from "@comis/core";
import type { ComisLogger } from "@comis/infra";
import type Database from "better-sqlite3";
import type { SqliteMemoryAdapter, createSessionStore } from "@comis/memory";
import type {
  AgentExecutor,
  ActiveRunRegistry,
  ProviderHealthMonitor,
  LastKnownModelTracker,
  createBudgetGuard,
  createComisSessionManager,
  createCostTracker,
  createStepCounter,
} from "@comis/agent";
import type { SkillRegistry, SkillWatcherHandle, McpClientManager } from "@comis/skills";

// PiSessionAdapter type — inferred from @comis/agent's createComisSessionManager.
// Mirrored in setup-agents-registry.ts (both leaves derive it independently
// from the same factory) to avoid a runtime-only dependency from registry.
type PiSessionAdapter = ReturnType<typeof createComisSessionManager>;

/** Shared dependencies computed once before the agent loop and passed to each
 *  setupSingleAgent() call. Exposed on AgentsResult so daemon.ts can capture
 *  the struct in a closure for hot-add without re-deriving deps. */
export interface SingleAgentDeps {
  container: AppContainer;
  memoryAdapter: SqliteMemoryAdapter;
  sessionStore: ReturnType<typeof createSessionStore>;
  agentLogger: ComisLogger;
  resolvedAgentDir: string;
  daemonTracingDefaults?: { outputDir: string; maxSize: string; maxFiles: number };
  subAgentToolNames?: string[];
  mcpToolsInherited: boolean;
  outboundMediaEnabled?: boolean;
  autonomousMediaEnabled?: boolean;
  activeRunRegistry?: ActiveRunRegistry;
  canaryFallbackSecret?: string;
  injectionRateLimiter?: InjectionRateLimiter;
  embeddingQueue?: { enqueue(entryId: string, content: string): void };
  contextStore?: import("@comis/core").ContextEngineStore;
  db?: unknown;
  /** Global provider health monitor shared across all agents */
  providerHealth?: ProviderHealthMonitor;
  /** Global last-known-working model tracker shared across all agents */
  lastKnownModel?: LastKnownModelTracker;
  /** Optional embedding port for discover_tools semantic search. */
  embeddingPort?: import("@comis/core").EmbeddingPort;
  /** Optional cross-encoder reranker (built in setup-memory only when an agent enables
   *  rerank). Threaded into createPiExecutor like memoryPort; absent -> fusion order. */
  rerankerPort?: import("@comis/core").RerankerPort;
  /** Phase 92: model-present probe result from setup-memory; drives per-agent effective
   *  rerank precedence. Same value as the build gate (Pitfall 4 — one source). */
  rerankerModelPresent?: boolean;
  /** Entity-associative store (Phase 83). Threaded into each per-agent createPiExecutor
   *  (the executor recall read path -> createMemoryRecall). Built in setup-memory on the
   *  shared db handle; the entity lane stays dormant until an operator enables
   *  `agents.<id>.rag.entityLane.enabled` (default OFF). */
  entityStore?: import("@comis/core").MemoryEntityStore;
  /** Temporal-spread store (Phase 95, LANES-02). Threaded into each per-agent createPiExecutor
   *  (the executor recall read path -> createMemoryRecall). Built in setup-memory on the shared
   *  db handle; the segregated port TYPE (agent↛memory cut). Dormant until an operator enables
   *  `agents.<id>.rag.lanes.temporal.enabled` (default OFF). */
  temporalStore?: import("@comis/core").MemoryTemporalStore;
  /** Causal store (Phase 96, EXTRACT-03). Threaded into each per-agent createPiExecutor
   *  (the executor recall read path -> createMemoryRecall, the 5th causal lane). Built in
   *  setup-memory on the shared db handle; the segregated port TYPE (agent↛memory cut). Dormant
   *  until an operator enables `agents.<id>.rag.lanes.causal.enabled` (default OFF). */
  causalStore?: import("@comis/core").MemoryCausalStore;
  /** Triple store (Phase 100, KG-01). Threaded into each per-agent createPiExecutor (the
   *  executor recall read path -> createMemoryRecall, the 6th graph-spread lane). Built in
   *  setup-memory on the shared db handle; the segregated port TYPE (agent↛memory cut). Dormant
   *  until an operator enables `agents.<id>.rag.lanes.graphSpread.enabled` (default OFF). */
  tripleStore?: import("@comis/core").TripleStorePort;
  /** Embedding read store (Phase 102, IQ-01). Threaded into each per-agent createPiExecutor
   *  (the executor recall read path -> createMemoryRecall, the MMR diversity re-rank's scoped
   *  embedding read). Built in setup-memory on the shared db handle; the segregated port TYPE
   *  (agent↛memory cut). Dormant until an operator enables `agents.<id>.rag.mmr.enabled`
   *  (default OFF). */
  embeddingStore?: import("@comis/core").MemoryEmbeddingStore;
  /** Usefulness store (Phase 93, FEED-03). Threaded into each per-agent createPiExecutor
   *  (the executor recall read path -> createMemoryRecall). Built in setup-memory on the
   *  shared db handle; the segregated port TYPE (agent↛memory cut). Dormant until an operator
   *  enables `agents.<id>.rag.feedback.enabled` (default OFF). */
  usefulnessStore?: import("@comis/core").MemoryUsefulnessStore;
  /** Per-user representation store (Phase 107, USER-03 — Track E1). Threaded into each per-agent
   *  createPiExecutor (the executor recall read path -> prompt-assembly's LLM-free `<user_profile>`
   *  standing-block injection). Built in setup-memory on the shared db handle; the segregated port
   *  TYPE (agent↛memory cut). Dormant until the offline builder writes rows (default-OFF cost gate);
   *  absent ⇒ no read, no push, byte-identical prompt. */
  userRepresentationStore?: import("@comis/core").UserRepresentationStore;
  /** Directional relationship store (Phase 108, SOCIAL-02/03 — Track E2). Threaded into each per-agent
   *  createPiExecutor (the executor recall read path -> prompt-assembly's LLM-free `<channel_relationships>`
   *  standing-block injection). Built in setup-memory on the shared db handle; the segregated port TYPE
   *  (agent↛memory cut). Dormant until the offline builder writes rows AND the operator enables the
   *  SOCIAL-03 dual gate (`socialModeling.enabled` + a recorded `privacyReviewSignedOffBy`); absent ⇒
   *  no read, no push, byte-identical prompt. */
  relationshipStore?: import("@comis/core").RelationshipStore;
  /** Tuned-alpha store (Phase 111, LEARN-03 — Track H2). Threaded into each per-agent createPiExecutor
   *  (the executor recall read path -> prompt-assembly's buildScoringAlphas overlay; the four learned
   *  non-trust alphas, the trust weight stays config-sourced — belt #2). Built in setup-memory on the
   *  shared db handle; the segregated port TYPE (agent↛memory cut). Dormant until BOTH the recall-side
   *  gate (`rag.onlineTuning.enabled`) AND the OFFLINE bandit cron (`memoryOnlineTuning.enabled`) are on;
   *  absent ⇒ no read, byte-identical recall. */
  tunedAlphaStore?: import("@comis/core").TunedAlphaStore;
  /** Delivery mirror port for session mirroring injection */
  deliveryMirror?: import("@comis/core").DeliveryMirrorPort;
  /** Delivery mirror config for injection budget */
  deliveryMirrorConfig?: { maxEntriesPerInjection: number; maxCharsPerInjection: number };
  /** Gemini CachedContent lifecycle manager. */
  geminiCacheManager?: import("@comis/agent").GeminiCacheManager;
  /** Resolve platform message character limit for a channel type.
   * Uses deferred channelPlugins ref populated after setupChannels. */
  getChannelMaxChars?: (channelType: string) => number | undefined;
  /** Background task manager for auto-promotion of long-running tools. */
  backgroundTaskManager?: import("@comis/agent").BackgroundTaskManager;
  /**
   * SecretsCrypto engine bound to SECRETS_MASTER_KEY. Defined when the daemon
   * was started with a valid master key (encrypted-secrets mode). Required
   * when `appConfig.security.storage === "encrypted"` — selectOAuthCredentialStore
   * fails fast with an operator hint when missing.
   */
  secretsCrypto?: SecretsCrypto;
  /**
   * Shared better-sqlite3 handle to secrets.db (the SqliteSecretStoreHandle.db
   * field, plumbed through from daemon.ts after createSqliteSecretStore).
   * Required when `appConfig.security.storage === "encrypted"` so the OAuth
   * profile adapter can share the existing connection rather than opening a
   * second handle to the same DB file — eliminates the dual-handle lifecycle
   * hazards: close-order, schema-init double-execution, prepared-statement
   * cache fragmentation.
   */
  secretsDb?: Database.Database;
  /**
   * The daemon-level OAuthCredentialStore handle. Constructed ONCE in
   * setupAgents() and passed down to every per-agent setupSingleAgent call
   * AND surfaced on AgentsResult so daemon.ts can thread it into
   * RpcDispatchDeps for `agents.update` existence checks. Single shared
   * handle (file backend is stateless on a shared path; encrypted backend
   * shares the secretsDb connection).
   */
  oauthCredentialStore: OAuthCredentialStorePort;
  /**
   * Daemon-global MCP client manager. Live-runtime view consumed by the
   * per-agent ToolCapabilityPort adapter constructed inside setupSingleAgent.
   * Threaded from daemon.ts; setupMcp runs before setupAgents.
   */
  mcpClientManager: McpClientManager;
  /**
   * Canonical FileLockPort adapter (proper-lockfile-backed `createFileLock()`).
   * Constructed once here so agent/session/oauth modules no longer import
   * `@comis/scheduler` directly. The port is stateless — one instance
   * shared across every per-agent OAuth store, OAuth token manager, and
   * session-write-lock call site is safe.
   */
  fileLock: FileLockPort;
  /** Wall-clock + monotonic time reads. */
  clock: import("@comis/core").ClockPort;
  /** Environment-variable reads. */
  env: import("@comis/core").EnvPort;
  /** Timer scheduling. */
  timers: import("@comis/core").TimerPort;
  /**
   * Daemon-level in-memory record of pending engine-mode switches, keyed by
   * agentId. Set at the rebuild seam (setupSingleAgent) ONLY when an operator
   * config reload CHANGES contextEngine.version (old defined AND old !== new),
   * then consumed one-shot by the DAG engine at the next reconcile to emit
   * context:mode_switched with the real import cost. A single shared Map: the
   * daemon reload re-invokes setupSingleAgent with the SAME deps object, so the
   * Map persists across reloads. NOT triggered by fullImport — a brand-new
   * DAG-default conversation records nothing here.
   */
  pendingModeSwitches: Map<string, { from: "pipeline" | "dag"; to: "pipeline" | "dag" }>;
  /**
   * ObservabilityStore for SystemPromptReport persistence in the
   * production prompt-assembly path. Constructed in daemon.ts
   * (createObservabilityStore(db) when obsConfig.persistence.enabled is
   * true). Undefined when persistence is disabled — the build+persist
   * block in prompt-assembly.ts remains a no-op in that mode.
   * Threaded through createPiExecutor in setup-agents-runtime.ts.
   */
  obsStore?: import("@comis/memory").ObservabilityStore;
  /**
   * Session-scoped trajectory recorder registry — owns one
   * `TrajectoryRecorder` per session (across N turns) so the design
   * §6.4 + §6.5 + §6.8 invariants hold (monotonic `seq`, single
   * `session.started`/`session.ended` per session). Constructed once
   * in `setupAgents` via
   * `createSessionTrajectoryHandleRegistry()` and threaded into
   * every per-agent executor. Daemon shutdown calls `closeAll()` to
   * drain open recorders.
   */
  trajectoryRegistry: import("@comis/observability").SessionTrajectoryHandleRegistry;
}

/** Per-agent outputs from setupSingleAgent(), matching the Maps in AgentsResult. */
export interface SingleAgentResult {
  executor: AgentExecutor;
  workspaceDir: string;
  costTracker: ReturnType<typeof createCostTracker>;
  budgetGuard: ReturnType<typeof createBudgetGuard>;
  stepCounter: ReturnType<typeof createStepCounter>;
  piSessionAdapter: PiSessionAdapter;
  skillWatcherHandle?: SkillWatcherHandle;
  skillRegistry: SkillRegistry;
  /**
   * Per-agent live ToolCapabilityPort. Constructed via
   * createToolCapabilityAdapter using this agent's skillRegistry and the
   * daemon-global mcpClientManager.
   */
  toolCapabilityPort: ToolCapabilityPort;
  /**
   * Per-agent ExecutionPlanHolder (typed as the read-only port surface). This
   * is the SAME reference threaded into PiExecutorDeps.executionPlanHolder
   * AND AcpServerDeps.executionPlanPort via createAcpWiring (T-74-33). WS-D
   * Phase 78 exposes it here so the daemon can also thread it into
   * ChannelsDeps.executionPlanPort — keeping the single-shared-holder
   * invariant (Pitfall 1: a parallel holder would always read empty).
   */
  executionPlanPort: ExecutionPlanPort;
}
