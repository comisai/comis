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

import { safePath, type AppContainer, type InjectionRateLimiter, type OAuthCredentialStorePort, type SecretsCrypto, type ToolCapabilityPort } from "@comis/core";
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
  type ProviderHealthMonitor,
} from "@comis/agent";
// Symbols imported directly from @comis/core — the daemon composition
// root no longer goes through @comis/agent re-exports.
import {
  selectOAuthCredentialStore,
  // Canonical FileLockPort adapter consumed here as the production
  // createFileLock() target so the daemon no longer reaches into
  // @comis/scheduler for it.
  createFileLock,
} from "@comis/core";
import {
  type SkillRegistry,
  type SkillWatcherHandle,
  type McpClientManager,
} from "@comis/skills";
// Session-scoped trajectory recorder registry (design §6.4 + §6.5 + §6.8).
// Construct once here so every per-agent executor shares the same registry
// and the daemon shutdown chain can drain all open recorders via closeAll().
import {
  createSessionTrajectoryHandleRegistry,
} from "@comis/observability";
import { setupSingleAgent } from "./setup-agents-runtime.js";
import type { SingleAgentDeps } from "./setup-agents-types.js";
import { resolveSubAgentToolNames } from "./setup-agents-tooling.js";

// PiSessionAdapter type — inferred from @comis/agent's createComisSessionManager.
// Mirrored here (not imported from runtime) because the runtime module already
// has the same alias; both leaves derive it independently from the same factory.
import type { createComisSessionManager } from "@comis/agent";
type PiSessionAdapter = ReturnType<typeof createComisSessionManager>;

// Once-per-daemon-process WARN flag for the encrypted-store hot-reload
// limitation. Lifted to module scope so the flag survives across per-agent
// setupSingleAgent calls AND any future re-invocations of setupAgents within
// the same process. Operator-friendly notice — fires exactly once per daemon
// process so the operator sees it in startup logs without N-times-per-agent
// noise.
let encryptedModeWarnFired = false;

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
  /**
   * Per-agent ToolCapabilityPort instances. Consumed by setupTools via the
   * getCapabilityPortForAgent closure on ToolsDeps; mutated by hot-add /
   * hot-remove in daemon.ts to keep the parallel map consistent with
   * skillRegistries.
   */
  toolCapabilityPorts: Map<string, ToolCapabilityPort>;
  /** Periodic lock cleanup timer (cleared on shutdown). */
  lockCleanupTimer: import("@comis/core").TimerHandle;
  /** Shared single-agent dependencies for hot-add closure capture. */
  singleAgentDeps: SingleAgentDeps;
  /** Global provider health monitor for daemon-level health metrics */
  providerHealth: ProviderHealthMonitor;
  /**
   * Daemon-level OAuthCredentialStore handle. Threaded into
   * RpcDispatchDeps so agents.update can validate oauthProfiles patches
   * via has().
   */
  oauthCredentialStore: OAuthCredentialStorePort;
  /**
   * Session-scoped trajectory recorder registry. Daemon shutdown MUST
   * call `closeAll()` to flush every open per-session recorder.
   */
  trajectoryRegistry: import("@comis/observability").SessionTrajectoryHandleRegistry;
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
  /** Context store for DAG mode context engine. Narrowed to ContextEngineStore
   *  (the engine half of ContextStorePort) — the agent never calls admin
   *  methods (listConversations, cleanupExpiredGrants, deleteConversation,
   *  touchConversation), so the narrower view prevents structural misuse at
   *  compile time. Phase 60-02 / REFACTOR-04 / T-60-07 mitigation. */
  contextStore?: import("@comis/core").ContextEngineStore;
  /** Raw better-sqlite3 database handle for DAG transactions */
  db?: unknown;
  /** Optional embedding port for discover_tools semantic search. */
  embeddingPort?: import("@comis/core").EmbeddingPort;
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
   * `appConfig.oauth.storage === "encrypted"` mode.
   */
  secretsCrypto?: SecretsCrypto;
  /**
   * Shared better-sqlite3 handle to secrets.db. Plumbed from daemon.ts where
   * createSqliteSecretStore now exposes its db field. Required for
   * `appConfig.oauth.storage === "encrypted"` mode.
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
}): Promise<AgentsResult> {
  const { container, memoryAdapter, sessionStore, agentLogger } = deps;

  // Inject module-level logger for response sanitization pipeline
  setSanitizeLogger(agentLogger.child({ submodule: "response-sanitize" }));

  // Inject module-level logger for tool schema normalization pipeline
  setToolNormalizationLogger(agentLogger.child({ submodule: "tool-normalize" }));

  // Once-per-daemon WARN for the encrypted-store hot-reload limitation.
  // Placed in setupAgents() body (NOT setupSingleAgent) so the notice fires
  // exactly once per daemon process — not N times for N agents. Operator
  // sees this in startup logs without surprise; daemon restart is required
  // to pick up CLI-written OAuth profiles in encrypted-store mode.
  const overallStorageMode = container.config.oauth.storage;
  if (overallStorageMode === "encrypted" && !encryptedModeWarnFired) {
    encryptedModeWarnFired = true;
    agentLogger.warn(
      {
        hint: "CLI auth login changes require daemon restart in encrypted mode (file-watch unsupported on encrypted SQLite WAL)",
        errorKind: "config" as const,
        submodule: "setup-agents",
      },
      "OAuth hot-reload disabled in encrypted-store mode",
    );
  }

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
  if (container.config.oauth.storage === "encrypted") {
    if (!deps.secretsDb || !deps.secretsCrypto) {
      throw new Error(
        "OAuth storage mode is 'encrypted' but secretsDb/secretsCrypto were not initialized. " +
          "Hint: set SECRETS_MASTER_KEY env var (and restart the daemon) so the encrypted " +
          "secrets store boots, or change appConfig.oauth.storage to 'file' to use the " +
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

  const oauthCredentialStore = selectOAuthCredentialStore({
    storage: container.config.oauth.storage,
    dataDir: dataDirAbsForOauth,
    fileLock,
    encryptedStore,
  });

  // Construct the session-scoped trajectory recorder registry ONCE here.
  // The registry is the single owner of per-session TrajectoryRecorder
  // lifecycle: getOrCreate(formattedKey, init, eventBus) on the first
  // turn, reuse across subsequent turns, close on session-destroy, and
  // closeAll() in the daemon shutdown chain. Lifting ownership out of
  // pi-executor.runSessionLocked closes design §6.4 + §6.5 + §6.8
  // deviations E + F.
  const trajectoryRegistry = createSessionTrajectoryHandleRegistry();

  // Construct shared deps struct once before the loop (for hot-add reuse)
  const singleAgentDeps: SingleAgentDeps = {
    container,
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
    contextStore: deps.contextStore,
    db: deps.db,
    providerHealth,
    lastKnownModel,
    embeddingPort: deps.embeddingPort,
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
  };

  for (const [agentId, agentConfig] of Object.entries(agents)) {
    const result = await setupSingleAgent(agentId, agentConfig, singleAgentDeps);
    executors.set(agentId, result.executor);
    workspaceDirs.set(agentId, result.workspaceDir);
    costTrackers.set(agentId, result.costTracker);
    budgetGuards.set(agentId, result.budgetGuard);
    stepCounters.set(agentId, result.stepCounter);
    piSessionAdapters.set(agentId, result.piSessionAdapter);
    if (result.skillWatcherHandle) skillWatcherHandles.set(agentId, result.skillWatcherHandle);
    skillRegistries.set(agentId, result.skillRegistry);
    toolCapabilityPorts.set(agentId, result.toolCapabilityPort);
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
  };
}

// ---------------------------------------------------------------------------
// OAuth credential store selection lives in @comis/agent (CLI cannot import
// from @comis/daemon, so the helper must live where both daemon and CLI
// consume it).
// See: packages/agent/src/model/oauth-credential-store-selector.ts
// ---------------------------------------------------------------------------
