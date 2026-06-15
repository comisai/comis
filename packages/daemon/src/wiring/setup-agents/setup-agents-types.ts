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
  OAuthTokenManager,
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
  /** Global provider health monitor shared across all agents */
  providerHealth?: ProviderHealthMonitor;
  /** Global last-known-working model tracker shared across all agents */
  lastKnownModel?: LastKnownModelTracker;
  /** Optional embedding port for discover_tools semantic search. */
  embeddingPort?: import("@comis/core").EmbeddingPort;
  /** Optional cross-encoder reranker (built in setup-memory only when an agent enables
   *  rerank). Threaded into createPiExecutor like memoryPort; absent -> fusion order. */
  rerankerPort?: import("@comis/core").RerankerPort;
  /** Model-present probe result from setup-memory; drives per-agent effective
   *  rerank precedence. Same value as the build gate (Pitfall 4 — one source). */
  rerankerModelPresent?: boolean;
  /** Entity-associative store. Threaded into each per-agent createPiExecutor
   *  (the executor recall read path -> createMemoryRecall). Built in setup-memory on the
   *  shared db handle; the entity lane stays dormant until an operator enables
   *  `agents.<id>.rag.entityLane.enabled` (default OFF). */
  entityStore?: import("@comis/core").MemoryEntityStore;
  /** LCD lossless context store (Phase 128 dag-mode write-path + assembly).
   *  Threaded into each per-agent createPiExecutor as `contextStore` (the
   *  PiExecutorDeps.contextStore landing site) — flows on to setupContextEngine
   *  -> the `dag` branch in context-engine.ts. Built in setup-memory on the shared
   *  db handle (`createLcdStore(db)`); the daemon injects the CONCRETE store as the
   *  CORE `ContextStorePort` TYPE (the agent↛memory cut — the agent never imports
   *  @comis/memory). Absent ⇒ the `dag` branch falls back to pipeline. The `dag`
   *  engine is opt-in (`contextEngine.version: "dag"`); the default stays pipeline. */
  lcdStore?: import("@comis/core").ContextStorePort;
  /** R1 (132-05): the daemon-owned per-tenant summarizer spend+breaker. Threaded
   *  into each per-agent createPiExecutor (PiExecutorDeps.summarizerSpendBreaker)
   *  -> setupContextEngine so getSummarizerDeps gates the leaf seam per tenant.
   *  ONE daemon instance partitions by tenantId (aggregate per-tenant spend across
   *  sessions/agents); absent ⇒ the raw seam. */
  summarizerSpendBreaker?: import("@comis/agent").SummarizerSpendBreaker;
  /** Temporal-spread store. Threaded into each per-agent createPiExecutor
   *  (the executor recall read path -> createMemoryRecall). Built in setup-memory on the shared
   *  db handle; the segregated port TYPE (agent↛memory cut). Dormant until an operator enables
   *  `agents.<id>.rag.lanes.temporal.enabled` (default OFF). */
  temporalStore?: import("@comis/core").MemoryTemporalStore;
  /** Causal store. Threaded into each per-agent createPiExecutor
   *  (the executor recall read path -> createMemoryRecall, the 5th causal lane). Built in
   *  setup-memory on the shared db handle; the segregated port TYPE (agent↛memory cut). Dormant
   *  until an operator enables `agents.<id>.rag.lanes.causal.enabled` (default OFF). */
  causalStore?: import("@comis/core").MemoryCausalStore;
  /** Triple store. Threaded into each per-agent createPiExecutor (the
   *  executor recall read path -> createMemoryRecall, the 6th graph-spread lane). Built in
   *  setup-memory on the shared db handle; the segregated port TYPE (agent↛memory cut). Dormant
   *  until an operator enables `agents.<id>.rag.lanes.graphSpread.enabled` (default OFF). */
  tripleStore?: import("@comis/core").TripleStorePort;
  /** Embedding read store. Threaded into each per-agent createPiExecutor
   *  (the executor recall read path -> createMemoryRecall, the MMR diversity re-rank's scoped
   *  embedding read). Built in setup-memory on the shared db handle; the segregated port TYPE
   *  (agent↛memory cut). Dormant until an operator enables `agents.<id>.rag.mmr.enabled`
   *  (default OFF). */
  embeddingStore?: import("@comis/core").MemoryEmbeddingStore;
  /** Usefulness store. Threaded into each per-agent createPiExecutor
   *  (the executor recall read path -> createMemoryRecall). Built in setup-memory on the
   *  shared db handle; the segregated port TYPE (agent↛memory cut). Dormant until an operator
   *  enables `agents.<id>.rag.feedback.enabled` (default OFF). */
  usefulnessStore?: import("@comis/core").MemoryUsefulnessStore;
  /** Pinned-memory store. The SAME `memoryAdapter` (SqliteMemoryAdapter) already
   *  threaded as `memoryPort` — it implements both `MemoryPort` AND `MemoryPinnedStore`.
   *  Supplied HERE as the segregated `MemoryPinnedStore` port so each per-agent
   *  createPiExecutor can inject it into createMemoryRecall's Step-0 pinned-first lane.
   *  Without this field, the lane gate (`cfg_pinned?.enabled === true && deps.pinnedStore !== undefined`)
   *  is always false and pinned memories are silently absent from every recall result (R6 blocker).
   *  DEFAULT-OFF BYTE-IDENTITY: with `rag.pinned.enabled=false` (the default), no pinnedStore
   *  query runs even when the store is injected. The segregated port TYPE is from @comis/core
   *  (the agent↛memory cut) — the agent package never imports @comis/memory. */
  pinnedStore?: import("@comis/core").MemoryPinnedStore;
  /** LCD provenance READ store (Phase 173, DIST-03 read side). Supplied to each
   *  per-agent createPiExecutor so createMemoryRecall's post-fusion provenance
   *  down-weighting pass fires (gate `deps.provenanceStore != null`) — it was BUILT
   *  but never injected in Phase 172 (the built-but-not-wired class the milestone
   *  hit 3×). Byte-identical no-op when absent OR when no lcd_distilled result is
   *  present. The core LcdProvenanceReadStore TYPE only (the agent↛memory cut). */
  provenanceStore?: import("@comis/core").LcdProvenanceReadStore;
  /** Per-user representation store. Threaded into each per-agent
   *  createPiExecutor (the executor recall read path -> prompt-assembly's LLM-free `<user_profile>`
   *  standing-block injection). Built in setup-memory on the shared db handle; the segregated port
   *  TYPE (agent↛memory cut). Dormant until the offline builder writes rows (default-OFF cost gate);
   *  absent ⇒ no read, no push, byte-identical prompt. */
  userRepresentationStore?: import("@comis/core").UserRepresentationStore;
  /** Directional relationship store. Threaded into each per-agent
   *  createPiExecutor (the executor recall read path -> prompt-assembly's LLM-free `<channel_relationships>`
   *  standing-block injection). Built in setup-memory on the shared db handle; the segregated port TYPE
   *  (agent↛memory cut). Dormant until the offline builder writes rows AND the operator enables the
   *  dual gate (`socialModeling.enabled` + a recorded `privacyReviewSignedOffBy`); absent ⇒
   *  no read, no push, byte-identical prompt. */
  relationshipStore?: import("@comis/core").RelationshipStore;
  /** Tuned-alpha store. Threaded into each per-agent createPiExecutor
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
  /** Ollama served context-window probe result from bootAgents (CWF-03).
   *  Map from provider config key (e.g. "qwen36-local") to discovered num_ctx.
   *  Absent → probe not run or all failed; executors fall back to configured window. */
  servedWindowByProvider?: Map<string, number>;
  /** KNOB-01/03: daemon-owned collector — one served-vs-configured comparison per
   *  provider; daemon.ts derives servedBelowConfiguredCount from it at the posture
   *  write (one comparison, two surfaces — no drift). */
  servedWindowComparisons?: Map<string, import("@comis/agent").ServedWindowComparison>;
  /** FLOOR-01: daemon-owned collector of per-agent boot window info (registry-mirrored
   *  configured window + reconciled effective window + profile) — consumed by the
   *  daemon's viable-floor loop after setupTools. */
  agentBootWindowInfo?: Map<string, import("@comis/agent").AgentBootWindowInfo>;
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
   * AND AcpServerDeps.executionPlanPort via createAcpWiring. It is exposed here
   * so the daemon can also thread it into
   * ChannelsDeps.executionPlanPort — keeping the single-shared-holder
   * invariant (Pitfall 1: a parallel holder would always read empty).
   */
  executionPlanPort: ExecutionPlanPort;
  /**
   * Per-agent OAuthTokenManager (184). The SAME instance consumed for the
   * executor's OAuth resolution — surfaced so the registry collects it into
   * AgentsResult.oauthManagers and the image path can resolve the Codex bearer
   * through the agent's exact manager (no second instance). Undefined when the
   * agent has no OAuth config.
   */
  oauth?: OAuthTokenManager;
}
