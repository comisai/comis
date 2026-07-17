// SPDX-License-Identifier: Apache-2.0
// @allow-throw: setup-agents registry guards; consumed at daemon.ts bootstrap catch boundary.
/**
 * Top-level agents-subsystem orchestrator: builds the `AgentsResult` registry
 * by iterating over configured agents and delegating to setupSingleAgent.
 * Constructs daemon-global state shared across every agent (OAuth credential
 * store, provider health monitor, last-known-model tracker, file lock,
 * encrypted OAuth profile store, periodic lock-cleanup timer).
 *
 * Imports `setupSingleAgent` + `SingleAgentDeps` from ./setup-agents-runtime.js
 * and `resolveSubAgentToolNames` from ./setup-agents-tooling.js.
 *
 * @module
 */

import { safePath, type AppContainer, type InjectionRateLimiter, type OAuthCredentialStorePort, type OAuthTokenManager, type SecretsCrypto, type ToolCapabilityPort } from "@comis/core";
import type { ComisLogger } from "@comis/infra";
import type Database from "better-sqlite3";
import type { SqliteMemoryAdapter, createSessionStore } from "@comis/memory";
// The encrypted-store factory is value-imported here because daemon owns
// secretsDb + secretsCrypto. Constructing the store at this composition
// site keeps agent free of any production @comis/memory import.
import { createOAuthProfileStoreEncrypted } from "@comis/memory";
import { homedir } from "node:os";
import { existsSync, mkdirSync } from "node:fs";
import { suppressError } from "@comis/shared";
import {
  createBudgetGuard,
  createCostTracker,
  createStepCounter,
  createSessionLifecycle,
  cleanupStaleLocks,
  createProviderHealthMonitor,
  createLastKnownModelTracker,
  setSanitizeLogger,
  setToolNormalizationLogger,
  type AgentExecutor,
  type ActiveRunRegistry,
  type AuthStorage,
  type ProviderHealthMonitor,
} from "@comis/agent";
// Symbols imported directly from @comis/core — the daemon composition
// root no longer goes through @comis/agent re-exports.
import {
  selectOAuthCredentialStore,
  // Canonical FileLockPort adapter consumed here as the production createFileLock()
  // target so the daemon no longer reaches into @comis/scheduler for it.
  createFileLock,
} from "@comis/core";
import {
  type SkillRegistry,
  type SkillWatcherHandle,
  type McpClientManager,
} from "@comis/skills";
// Session-scoped trajectory recorder registry.
// Construct once here so every per-agent executor shares the same registry
// and the daemon shutdown chain can drain all open recorders via closeAll().
import {
  createSessionTrajectoryHandleRegistry,
} from "@comis/observability";
import { setupSingleAgent } from "./setup-agents-runtime.js";
import type { SingleAgentDeps } from "./setup-agents-types.js";
import { resolveSubAgentToolNames } from "./setup-agents-tooling.js";
import { warnEncryptedModeOnce } from "./setup-agents-oauth.js";

// PiSessionAdapter type — inferred from @comis/agent's createComisSessionManager.
// Mirrored here (not imported from runtime) because the runtime module already
// has the same alias; both leaves derive it independently from the same factory.
import type { createComisSessionManager } from "@comis/agent";
type PiSessionAdapter = ReturnType<typeof createComisSessionManager>;

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

/** All services produced by the per-agent executor setup phase. */
export interface AgentsResult {
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
  /** Resolve executor for an agent ID, falling back to default agent. */
  getExecutor: (agentId: string) => AgentExecutor;
  /** Per-agent JSONL session adapters (keyed by agentId). */
  piSessionAdapters: Map<string, PiSessionAdapter>;
  /** Per-agent skill watcher handles for shutdown cleanup. */
  skillWatcherHandles: Map<string, SkillWatcherHandle>;
  /** Per-agent skill registries for skills.list RPC method. */
  skillRegistries: Map<string, SkillRegistry>;
  /** Per-agent ToolCapabilityPort instances. Consumed by setupTools via the
   * getCapabilityPortForAgent closure on ToolsDeps; mutated by hot-add / hot-remove in daemon.ts. */
  toolCapabilityPorts: Map<string, ToolCapabilityPort>;
  /** Periodic lock cleanup timer (cleared on shutdown). */
  lockCleanupTimer: import("@comis/core").TimerHandle;
  /** Shared single-agent dependencies for hot-add closure capture. */
  singleAgentDeps: SingleAgentDeps;
  /** Global provider health monitor for daemon-level health metrics */
  providerHealth: ProviderHealthMonitor;
  /** Daemon-level OAuthCredentialStore handle. Threaded into RpcDispatchDeps so agents.update
   * can validate oauthProfiles patches via has(). */
  oauthCredentialStore: OAuthCredentialStorePort;
  /** Per-agent OAuthTokenManager instances — the SAME managers the executors use (no 2nd
   * instance). daemon.ts threads the DEFAULT agent's into buildImageGenBundle → the Codex image
   * adapter. Only OAuth-configured agents appear (setupSingleAgent's `oauth` is undefined). */
  oauthManagers: Map<string, OAuthTokenManager>;
  /** Per-agent pi AuthStorage (piAuthStorage) → the memory.ask dialectic OAuth resolver's
   *  runtime-override target. Mirrors oauthManagers (every agent has one). */
  authStorages: Map<string, AuthStorage>;
  /** Session-scoped trajectory recorder registry. Daemon shutdown MUST call `closeAll()` to
   * flush every open per-session recorder. */
  trajectoryRegistry: import("@comis/observability").SessionTrajectoryHandleRegistry;
  /** Per-agent ExecutionPlanHolder reference (read-only port). Surfaced so daemon.ts threads the
   * DEFAULT agent's holder into ChannelsDeps.executionPlanPort; the same ref flows into
   * PiExecutorDeps.executionPlanHolder + AcpServerDeps.executionPlanPort (Pitfall 1). */
  executionPlanPorts: Map<string, import("@comis/core").ExecutionPlanPort>;
}

// ---------------------------------------------------------------------------
// Setup function
// ---------------------------------------------------------------------------

/**
 * Create the full per-agent executor subsystem: session manager, per-agent
 * workspace directories, safety dependencies (circuit breaker, budget guard,
 * cost tracker, step counter), and PiExecutor instances.
 * @param deps.container      - Bootstrap output (config, event bus, secret manager)
 * @param deps.memoryAdapter  - SQLite memory adapter (from setupMemory result)
 * @param deps.sessionStore   - Session persistence store (from setupMemory result)
 * @param deps.agentLogger    - Module-bound logger for agent subsystem
 */
export async function setupAgents(deps: {
  container: AppContainer;
  memoryAdapter: SqliteMemoryAdapter;
  sessionStore: ReturnType<typeof createSessionStore>;
  agentLogger: ComisLogger;
  /** The daemon package.json version → each agent's trace.metadata build stamp. */
  daemonVersion?: string;
  /** When true, executor includes MEDIA: directive instructions in system prompt. */
  outboundMediaEnabled?: boolean;
  /** When true, executor system prompt includes attachment hint processing guidance.
   * Set to true when at least one auto-processing pipeline is disabled. */
  autonomousMediaEnabled?: boolean;
  /** Optional active run registry for SDK-native steer+followup */
  activeRunRegistry?: ActiveRunRegistry;
  /** Fallback secret for canary token generation when CANARY_SECRET not configured. */
  canaryFallbackSecret?: string;
  /** Injection rate limiter singleton for progressive cooldown (optional). */
  injectionRateLimiter?: InjectionRateLimiter;
  /** Embedding queue for async vector generation. Wired into executor for conversation persistence. */
  embeddingQueue?: { enqueue(entryId: string, content: string): void };
  /** Optional embedding port for discover_tools semantic search. */
  embeddingPort?: import("@comis/core").EmbeddingPort;
  /** Optional cross-encoder reranker (built in setup-memory only when an agent enables
   *  rerank). Threaded into each per-agent createPiExecutor like memoryPort. */
  rerankerPort?: import("@comis/core").RerankerPort;
  /** Model-present probe result from setup-memory; forwarded into each
   *  SingleAgentDeps so the per-agent effective rerank precedence consults the SAME
   *  value as the build gate (Pitfall 4 — one source). */
  rerankerModelPresent?: boolean;
  /** Entity-associative store. Threaded into each per-agent createPiExecutor
   *  like memoryPort (the recall read path). Built in setup-memory on the shared db. */
  entityStore?: import("@comis/core").MemoryEntityStore;
  /** LCD lossless context store. Threaded into each per-agent
   *  createPiExecutor like entityStore — as `contextStore` (the dag-mode assembly
   *  read path -> context-engine.ts `dag` branch). Built in setup-memory on the
   *  shared db (`createLcdStore(db)`); injected as the core `ContextStorePort` TYPE
   *  (agent↛memory cut). Opt-in (`contextEngine.version: "dag"`); default pipeline. */
  lcdStore?: import("@comis/core").ContextStorePort;
  /** The daemon-owned per-tenant summarizer spend+breaker; threaded
   *  into each per-agent createPiExecutor -> setupContextEngine (the getSummarizerDeps
   *  leaf-seam gate). ONE daemon instance, partitions by tenantId. */
  summarizerSpendBreaker?: import("@comis/agent").SummarizerSpendBreaker; spendAccumulator?: import("@comis/agent").SpendAccumulator; // spendAccumulator = the daemon-wide spend kill-switch: the ONE accumulator (setupObservability), threaded per-agent so every bridge holds the SAME reference.
  /** The late-bound per-root budget holder + rootRunId
   *  resolver, forwarded into each SingleAgentDeps (every bridge holds the SAME
   *  holder, populated by the cap layer); absent ⇒ the per-root reserve is a no-op. */
  boundedAutonomyBudget?: import("@comis/agent").BoundedAutonomyBudgetHolder;
  resolveRootRunId?: (agentId: string, sessionKey: import("@comis/core").SessionKey) => string;
  /** Temporal-spread store. Threaded into each per-agent createPiExecutor like entityStore (the recall temporal-spread read path). Built in setup-memory on the shared db. */
  temporalStore?: import("@comis/core").MemoryTemporalStore;
  /** Causal store. Threaded into each per-agent createPiExecutor like entityStore (the recall 5th causal lane read path). Built in setup-memory on the shared db. */
  causalStore?: import("@comis/core").MemoryCausalStore;
  /** Triple store. Threaded into each per-agent createPiExecutor like
   *  entityStore (the recall 6th graph-spread lane read path). Built in setup-memory on the shared db. */
  tripleStore?: import("@comis/core").TripleStorePort;
  /** Embedding read store. Threaded into each per-agent createPiExecutor like
   *  entityStore (the recall MMR diversity re-rank's scoped embedding read). Built in setup-memory on the shared db. */
  embeddingStore?: import("@comis/core").MemoryEmbeddingStore;
  /** Usefulness store. Threaded into each per-agent createPiExecutor like entityStore (the recall usefulness read path). Built in setup-memory on the shared db. */
  usefulnessStore?: import("@comis/core").MemoryUsefulnessStore;
  /** Pinned-memory store (the `MemoryPinnedStore` face of `memoryAdapter`). Threaded into
   *  each per-agent createPiExecutor so the recall pipeline's Step-0 pinned-first lane can fire.
   *  Without this the lane gate is always false and pinned memories are silently absent from every
   *  agent response (a blocking defect). The same `SqliteMemoryAdapter` already passed as `memoryPort`
   *  implements `MemoryPinnedStore`; the daemon supplies it here as the segregated port TYPE.
   *  Built in setup-memory on the shared db. */
  pinnedStore?: import("@comis/core").MemoryPinnedStore;
  provenanceStore?: import("@comis/core").LcdProvenanceReadStore; // LCD provenance READ store → createPiExecutor → createMemoryRecall down-weighting; built in setup-memory; core TYPE only (agent↛memory cut)
  learnedSkillStore?: import("@comis/core").MentalModelStorePort; // forwarded into each SingleAgentDeps -> the getPromptSkillsXml surface seam; segregated port TYPE (agent↛memory cut); default-OFF
  learnedSkillSurfaceRegistry?: import("./learned-skill-surface-registry.js").LearnedSkillSurfaceRegistry; // shared per-agent surface registry; each agent registers its refresh closure so the promote/demote loop re-refreshes it (next-session pickup)
  /** Delivery mirror port for session mirroring injection */
  deliveryMirror?: import("@comis/core").DeliveryMirrorPort;
  /** Delivery mirror config for injection budget */
  deliveryMirrorConfig?: { maxEntriesPerInjection: number; maxCharsPerInjection: number };
  /** Gemini CachedContent lifecycle manager. */
  geminiCacheManager?: import("@comis/agent").GeminiCacheManager;
  /** Resolve platform message character limit for a channel type. */
  getChannelMaxChars?: (channelType: string) => number | undefined;
  /** Background task manager for auto-promotion of long-running tools. */
  backgroundTaskManager?: import("@comis/agent").BackgroundTaskManager;
  /**
   * SecretsCrypto engine bound to SECRETS_MASTER_KEY. Defined when daemon
   * was started with a valid master key. Required for
   * `appConfig.security.storage === "encrypted"` mode.
   */
  secretsCrypto?: SecretsCrypto;
  /**
   * Shared better-sqlite3 handle to secrets.db. Plumbed from daemon.ts where
   * createSqliteSecretStore now exposes its db field. Required for
   * `appConfig.security.storage === "encrypted"` mode.
   */
  secretsDb?: Database.Database;
  /**
   * Daemon-global MCP client manager. setupSingleAgent constructs a
   * per-agent ToolCapabilityPort adapter that closes over this manager.
   * daemon.ts threads it in after running setupMcp before setupAgents.
   */
  mcpClientManager: McpClientManager;
  /** Wall-clock + monotonic time reads. */
  clock: import("@comis/core").ClockPort;
  /** Environment-variable reads. */
  env: import("@comis/core").EnvPort;
  /** Timer scheduling. */
  timers: import("@comis/core").TimerPort;
  /**
   * ObservabilityStore for SystemPromptReport persistence. Forwarded
   * into SingleAgentDeps and then into createPiExecutor's
   * `observabilityStore` slot — drives the build+persist block in
   * prompt-assembly.ts. When undefined (persistence disabled), the
   * block is a no-op.
   */
  obsStore?: import("@comis/memory").ObservabilityStore;
  /** Ollama served context-window probe result from bootAgents.
   *  Map from provider config key (e.g. "qwen36-local") to discovered num_ctx.
   *  Absent → probe not run or all failed; executors fall back to configured window. */
  servedWindowByProvider?: Map<string, number>;
  /** Daemon-owned collector — one served-vs-configured comparison per
   *  provider; daemon.ts derives servedBelowConfiguredCount from it at the posture
   *  write (one comparison, two surfaces — no drift). */
  servedWindowComparisons?: Map<string, import("@comis/agent").ServedWindowComparison>;
  /** Daemon-owned collector of per-agent boot window info (registry-mirrored
   *  configured window + reconciled effective window + profile) — consumed by the
   *  daemon's viable-floor loop after setupTools. */
  agentBootWindowInfo?: Map<string, import("@comis/agent").AgentBootWindowInfo>;
}): Promise<AgentsResult> {
  const { container, memoryAdapter, sessionStore, agentLogger } = deps;

  // Inject module-level logger for response sanitization pipeline
  setSanitizeLogger(agentLogger.child({ submodule: "response-sanitize" }));

  // Inject module-level logger for tool schema normalization pipeline
  setToolNormalizationLogger(agentLogger.child({ submodule: "tool-normalize" }));

  // Once-per-daemon encrypted-store hot-reload notice (module latch lives in
  // setup-agents-oauth.ts — the leaf that owns the limitation it describes).
  warnEncryptedModeOnce(container.config.security.storage, agentLogger);

  const agents = container.config.agents; // Always populated after schema transform
  const routingConfig = container.config.routing;

  // Daemon-level tracing defaults
  const daemonTracingDefaults = container.config.daemon?.logging?.tracing;

  // Resolve agentDir for SDK persistent settings (root config, defaults to ~/.pi/agent)
  const agentDir = container.config.agentDir;
  const resolvedAgentDir = agentDir.startsWith("~")
    ? agentDir.replace("~", homedir())
    : agentDir;

  agentLogger.debug({ agentDir: resolvedAgentDir }, "SDK agent directory resolved");

  // Auto-create agentDir if missing (SDK needs this directory for settings files)
  try {
    if (!existsSync(resolvedAgentDir)) {
      // fs-safe-allowed: resolvedAgentDir is operator-configured (root config `agentDir`, defaults to ~/.pi/agent); follow-up plan should migrate to ensureContainedDir
      mkdirSync(resolvedAgentDir, { recursive: true });
      agentLogger.info({ agentDir: resolvedAgentDir }, "Created SDK agent directory");
    }
  } catch (mkdirError) {
    agentLogger.warn(
      {
        agentDir: resolvedAgentDir,
        err: mkdirError,
        hint: "Failed to create agentDir; SettingsManager will fall back to in-memory",
        errorKind: "config" as const,
      },
      "Agent directory creation failed",
    );
  }

  // Create shared services (session manager is shared across agents)
  const sessionManager = createSessionLifecycle(sessionStore);

  // Per-agent executor map
  const executors = new Map<string, AgentExecutor>();
  const workspaceDirs = new Map<string, string>();
  const costTrackers = new Map<string, ReturnType<typeof createCostTracker>>();
  const budgetGuards = new Map<string, ReturnType<typeof createBudgetGuard>>();
  const stepCounters = new Map<string, ReturnType<typeof createStepCounter>>();
  const piSessionAdapters = new Map<string, PiSessionAdapter>();
  const skillWatcherHandles = new Map<string, SkillWatcherHandle>();
  const skillRegistries = new Map<string, SkillRegistry>();
  // Per-agent live ToolCapabilityPort adapters, parallel to skillRegistries;
  // mutated in lockstep by hot-add/hot-remove.
  const toolCapabilityPorts = new Map<string, ToolCapabilityPort>();
  // Per-agent ExecutionPlanHolder reference map (typed as the read-only port).
  // Surfaced so daemon.ts can thread the DEFAULT agent's holder
  // into ChannelsDeps.executionPlanPort. Same reference across ACP + chat
  // (Pitfall 1 single-shared-holder invariant).
  const executionPlanPorts = new Map<string, import("@comis/core").ExecutionPlanPort>();
  // Per-agent OAuthTokenManager map — see AgentsResult.oauthManagers.
  const oauthManagers = new Map<string, OAuthTokenManager>();
  // Per-agent pi AuthStorage map — see AgentsResult.authStorages.
  const authStorages = new Map<string, AuthStorage>();

  // Resolve sub-agent tool names from config for delegation awareness
  const subAgentToolGroups = container.config.security?.agentToAgent?.subAgentToolGroups ?? [];
  const subAgentToolNames = subAgentToolGroups.length === 0 || subAgentToolGroups.includes("full")
    ? undefined  // Full profile or unconfigured = all tools, no need for awareness section
    : resolveSubAgentToolNames(subAgentToolGroups);
  // MCP-AWARE: Whether sub-agents inherit MCP tools (used in system prompt to avoid false "do NOT have" claims)
  const mcpToolsInherited = (container.config.security?.agentToAgent?.subAgentMcpTools ?? "inherit") === "inherit";

  // Global provider health monitor (shared across all agents)
  const providerHealth = createProviderHealthMonitor({
    degradedThreshold: 2,
    consecutiveFailureThreshold: 3,
    windowMs: 60_000,
    recoveryThreshold: 1,
    eventBus: container.eventBus,
  });

  // Global last-known-working model tracker (shared across all agents)
  const lastKnownModel = createLastKnownModelTracker();

  // Construct the daemon-level OAuthCredentialStore handle ONCE (instead of
  // per-agent inside setupSingleAgent). Same handle is reused across every
  // agent setup AND surfaced on AgentsResult so daemon.ts can plumb it into
  // RpcDispatchDeps for the agents.update oauthProfiles existence check.
  const dataDirAbsForOauth =
    container.config.dataDir && container.config.dataDir.length > 0
      ? container.config.dataDir
      : safePath(homedir(), ".comis");

  // Construct the encrypted-mode store HERE — daemon already owns secretsDb
  // + secretsCrypto, so the agent selector does not reach into @comis/memory.
  //
  // EXPLICIT GUARDS (NOT non-null assertions): if storage is "encrypted" but
  // either secretsDb or secretsCrypto is unset, throw a clear bootstrap error
  // pointing operators at SECRETS_MASTER_KEY. Non-null assertions (!) would
  // produce a `TypeError: Cannot read properties of undefined` at runtime —
  // exactly the failure mode the old in-selector pre-check avoided.
  let encryptedStore: OAuthCredentialStorePort | undefined;
  if (container.config.security.storage === "encrypted") {
    if (!deps.secretsDb || !deps.secretsCrypto) {
      throw new Error(
        "OAuth storage mode is 'encrypted' but secretsDb/secretsCrypto were not initialized. " +
          "Hint: set SECRETS_MASTER_KEY env var (and restart the daemon) so the encrypted " +
          "secrets store boots, or change security.storage to 'file' in your config.yaml to use the " +
          "plaintext file backend.",
      );
    }
    encryptedStore = createOAuthProfileStoreEncrypted(deps.secretsDb, deps.secretsCrypto);
  }

  // Construct the canonical FileLockPort adapter ONCE here. Reused for
  // OAuth store/manager locking AND session-write-lock + stale-lock
  // cleanup across every per-agent setup. The port is stateless (per
  // `createFileLock` semantics in @comis/scheduler), so a
  // single shared instance is correct.
  const fileLock = createFileLock();

  // In "env" mode, OAuth credential storage is unavailable (read-only secret store).
  // Construct a minimal stub that returns err() on mutations so the daemon boots
  // without throwing, and OAuth-write RPCs surface an actionable error at runtime.
  const oauthCredentialStore: OAuthCredentialStorePort =
    container.config.security.storage === "env"
      ? {
          async get() { return { ok: true as const, value: undefined }; },
          async set() { return { ok: false as const, error: new Error("OAuth credential store is read-only in 'env' storage mode. Set security.storage to 'file' or 'encrypted' in config.yaml to enable OAuth login.") }; },
          async delete() { return { ok: false as const, error: new Error("OAuth credential store is read-only in 'env' storage mode. Set security.storage to 'file' or 'encrypted' in config.yaml to enable OAuth login.") }; },
          async list() { return { ok: true as const, value: [] }; },
          async has() { return { ok: true as const, value: false }; },
        }
      : selectOAuthCredentialStore({
          storage: container.config.security.storage,
          dataDir: dataDirAbsForOauth,
          fileLock,
          encryptedStore,
        });

  // Construct the session-scoped trajectory recorder registry ONCE here.
  // The registry is the single owner of per-session TrajectoryRecorder
  // lifecycle: getOrCreate(formattedKey, init, eventBus) on the first
  // turn, reuse across subsequent turns, close on session-destroy, and
  // closeAll() in the daemon shutdown chain. Lifting ownership out of
  // pi-executor.runSessionLocked; this ensures proper lifecycle ownership
  // for session-scoped trajectory recorders.
  const trajectoryRegistry = createSessionTrajectoryHandleRegistry();

  // Construct shared deps struct once before the loop (for hot-add reuse)
  const singleAgentDeps: SingleAgentDeps = {
    container,
    ...(deps.daemonVersion !== undefined ? { appVersion: deps.daemonVersion } : {}),
    memoryAdapter,
    sessionStore,
    agentLogger,
    resolvedAgentDir,
    daemonTracingDefaults,
    subAgentToolNames,
    mcpToolsInherited,
    outboundMediaEnabled: deps.outboundMediaEnabled,
    autonomousMediaEnabled: deps.autonomousMediaEnabled,
    activeRunRegistry: deps.activeRunRegistry,
    canaryFallbackSecret: deps.canaryFallbackSecret,
    injectionRateLimiter: deps.injectionRateLimiter,
    embeddingQueue: deps.embeddingQueue,
    providerHealth,
    lastKnownModel,
    embeddingPort: deps.embeddingPort,
    rerankerPort: deps.rerankerPort,
    rerankerModelPresent: deps.rerankerModelPresent,
    entityStore: deps.entityStore,
    lcdStore: deps.lcdStore,
    summarizerSpendBreaker: deps.summarizerSpendBreaker, spendAccumulator: deps.spendAccumulator,
    // Forward the per-root budget holder + resolver per-agent (daemon-wide REF; absent ⇒ no-op).
    ...(deps.boundedAutonomyBudget ? { boundedAutonomyBudget: deps.boundedAutonomyBudget } : {}),
    ...(deps.resolveRootRunId ? { resolveRootRunId: deps.resolveRootRunId } : {}),
    temporalStore: deps.temporalStore,
    causalStore: deps.causalStore,
    tripleStore: deps.tripleStore,
    embeddingStore: deps.embeddingStore,
    usefulnessStore: deps.usefulnessStore,
    pinnedStore: deps.pinnedStore,
    provenanceStore: deps.provenanceStore,
    learnedSkillStore: deps.learnedSkillStore, learnedSkillSurfaceRegistry: deps.learnedSkillSurfaceRegistry,
    deliveryMirror: deps.deliveryMirror,
    deliveryMirrorConfig: deps.deliveryMirrorConfig,
    geminiCacheManager: deps.geminiCacheManager,
    getChannelMaxChars: deps.getChannelMaxChars,
    backgroundTaskManager: deps.backgroundTaskManager,
    // Secrets bootstrap output for OAuth wiring.
    secretsCrypto: deps.secretsCrypto,
    secretsDb: deps.secretsDb,
    // Daemon-level OAuth credential store handle (constructed once above,
    // reused per-agent + threaded into RPC deps).
    oauthCredentialStore,
    // Daemon-global MCP client manager. Threaded through so each
    // setupSingleAgent invocation can construct a per-agent
    // ToolCapabilityPort adapter that closes over the live MCP state.
    mcpClientManager: deps.mcpClientManager,
    // Canonical FileLockPort adapter — see comment at construction site.
    fileLock,
    // Runtime adapter ports.
    clock: deps.clock,
    env: deps.env,
    timers: deps.timers,
    // ObservabilityStore for SystemPromptReport persistence —
    // forwarded from daemon.ts into createPiExecutor via setupSingleAgent.
    obsStore: deps.obsStore,
    // Session-scoped trajectory recorder registry — threaded into every
    // per-agent executor so the same registry is shared across agents.
    trajectoryRegistry,
    // Ollama served-window probe result from bootAgents.
    servedWindowByProvider: deps.servedWindowByProvider,
    // The daemon-owned boot-honesty collector maps —
    // populated per-agent in setupSingleAgent beside the pi ModelRegistry.
    servedWindowComparisons: deps.servedWindowComparisons,
    agentBootWindowInfo: deps.agentBootWindowInfo,
  };

  for (const [agentId, agentConfig] of Object.entries(agents)) {
    // Pass the RAW (pre-Zod-default) rerank signal from the
    // daemon-wide map so the per-agent effective-rerank precedence sees genuine
    // unset (undefined) vs explicit-off (false). `agentConfig` here is the PARSED
    // config — its rag.rerank.enabled is always a concrete boolean and would erase
    // the unset signal if read directly.
    const result = await setupSingleAgent(
      agentId,
      agentConfig,
      singleAgentDeps,
      container.rawAgentRerankEnabled?.get(agentId),
    );
    executors.set(agentId, result.executor);
    workspaceDirs.set(agentId, result.workspaceDir);
    costTrackers.set(agentId, result.costTracker);
    budgetGuards.set(agentId, result.budgetGuard);
    stepCounters.set(agentId, result.stepCounter);
    piSessionAdapters.set(agentId, result.piSessionAdapter);
    if (result.skillWatcherHandle) skillWatcherHandles.set(agentId, result.skillWatcherHandle);
    skillRegistries.set(agentId, result.skillRegistry);
    toolCapabilityPorts.set(agentId, result.toolCapabilityPort);
    executionPlanPorts.set(agentId, result.executionPlanPort);
    if (result.oauth) oauthManagers.set(agentId, result.oauth); // per-agent OAuth manager (when present)
    if (result.authStorage) authStorages.set(agentId, result.authStorage); // per-agent pi AuthStorage
  }

  const defaultAgentId = routingConfig.defaultAgentId;
  const defaultWorkspaceDir = workspaceDirs.get(defaultAgentId)!;

  /** Resolve executor for an agent ID, falling back to default agent. */
  function getExecutor(agentId: string): AgentExecutor {
    const exec = executors.get(agentId);
    if (!exec) {
      const fallback = executors.get(defaultAgentId);
      if (!fallback) throw new Error(`No executor found for agent: ${agentId}`);
      return fallback;
    }
    return exec;
  }

  // Periodic stale lock cleanup (every 30 minutes)
  const LOCK_CLEANUP_INTERVAL_MS = 30 * 60_000;
  const lockCleanupTimer = deps.timers.setInterval(() => {
    for (const [agentId, dir] of workspaceDirs) {
      const lockDir = safePath(dir, ".locks");
      suppressError(
        cleanupStaleLocks(fileLock, lockDir).then((removed) => {
          if (removed > 0) {
            agentLogger.info({ agentId, removed, lockDir }, "Periodic stale lock cleanup");
          }
        }),
        "periodic lock cleanup",
      );
    }
  }, LOCK_CLEANUP_INTERVAL_MS);
  // Prevent timer from keeping the process alive during shutdown
  lockCleanupTimer.unref();

  return {
    sessionManager,
    executors,
    workspaceDirs,
    costTrackers,
    budgetGuards,
    stepCounters,
    defaultAgentId,
    defaultWorkspaceDir,
    getExecutor,
    piSessionAdapters,
    skillWatcherHandles,
    skillRegistries,
    // daemon.ts threads this Map into setupTools via
    // getCapabilityPortForAgent and mutates it on hot-add/hot-remove.
    toolCapabilityPorts,
    lockCleanupTimer,
    singleAgentDeps,
    providerHealth,
    // Daemon-level OAuth credential store, plumbed by daemon.ts into
    // RpcDispatchDeps.oauthCredentialStore so agents.update can validate
    // oauthProfiles patches via has().
    oauthCredentialStore,
    // Session-scoped trajectory recorder registry. daemon.ts MUST call
    // `closeAll()` on this in the shutdown chain — see the trajectory
    // sidecar drain step in daemon shutdown wiring.
    trajectoryRegistry,
    // Per-agent shared ExecutionPlanHolder reference. The
    // daemon threads the DEFAULT agent's holder into ChannelsDeps so the
    // chat plan-stream reads from the SAME object SEP publishes into.
    executionPlanPorts,
    oauthManagers, // per-agent OAuth managers → buildImageGenBundle (Codex image adapter)
    authStorages, // per-agent pi AuthStorage → memory.ask dialectic OAuth resolver
  };
}

// OAuth credential store selection: @comis/agent/src/model/oauth-credential-store-selector.ts
// (CLI cannot import from @comis/daemon, so the helper lives where both daemon and CLI consume it)
