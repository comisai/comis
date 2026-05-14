// SPDX-License-Identifier: Apache-2.0
/**
 * Per-agent executor setup: session manager, per-agent workspace, safety
 * dependencies (circuit breaker, budget guard, cost tracker, step counter),
 * and PiExecutor creation.
 * All agents use PiExecutor (pi-coding-agent AgentSession wrapper).
 *
 * The live ToolCapabilityPort adapter is constructed inside setupSingleAgent
 * (this function), NOT at a higher composition site (daemon.ts). Rationale:
 * skillRegistry is per-agent and the skill-allow/deny precedence chain is
 * per-agent; a daemon-global adapter cannot satisfy this without breaking
 * the port interface (would require adding agentId to every method). The
 * per-agent port is exposed via AgentsResult.toolCapabilityPorts and threaded
 * into setupTools via the getCapabilityPortForAgent closure on ToolsDeps.
 *
 * @module
 */

import { safePath, SkillsConfigSchema, createScopedSecretManager, createOutputGuard, generateCanaryToken, createInputSecurityGuard, validateInput, PerAgentConfigSchema, type AppContainer, type FileLockPort, type InjectionRateLimiter, type OAuthCredentialStorePort, type SecretsCrypto, type PerAgentConfig, type ToolCapabilityPort } from "@comis/core";
import { createToolCapabilityAdapter } from "./tool-capability-adapter.js";
import { suppressError } from "@comis/shared";
import { createHmac } from "node:crypto";
import type { ComisLogger } from "@comis/infra";
import type Database from "better-sqlite3";
import type { SqliteMemoryAdapter, createSessionStore } from "@comis/memory";
// Phase 31 commit 4 (MEM-CTX-PORTS-07): the encrypted-store factory value-import
// moved from packages/agent/src/model/oauth-credential-store-selector.ts to here.
// Daemon already owns secretsDb + secretsCrypto, so constructing the store at
// this composition site removes agent's last production @comis/memory import.
import { createOAuthProfileStoreEncrypted } from "@comis/memory";
import { homedir } from "node:os";
import { existsSync, mkdirSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { getModels, getProviders, type KnownProvider } from "@mariozechner/pi-ai";
import {
  createCircuitBreaker,
  createBudgetGuard,
  createCostTracker,
  createStepCounter,
  createSessionLifecycle,
  createPiExecutor,
  createComisSessionManager,
  cleanupStaleLocks,
  createAuthStorageAdapter,
  createAuthProvider,
  createModelRegistryAdapter,
  registerCustomProviders,
  createProviderHealthMonitor,
  createLastKnownModelTracker,
  createAuthProfileManager,
  createAuthRotationAdapter,
  setSanitizeLogger,
  setToolNormalizationLogger,
  resolveOperationDefaults,
  resolveCompactionModel,
  LEAN_TOOL_DESCRIPTIONS,
  resolveDescription,
  type AgentExecutor,
  type ActiveRunRegistry,
  type ProviderHealthMonitor,
  type LastKnownModelTracker,
  type ToolDescriptionContext,
} from "@comis/agent";
// Phase 35 Plan 35-04 (D-01): symbols relocated from @comis/agent to
// @comis/core. The daemon composition root now imports them directly via
// @comis/core; agent re-exports are deleted in the same plan.
import {
  ensureWorkspace,
  resolveWorkspaceDir,
  selectOAuthCredentialStore,
  // Canonical FileLockPort adapter. Relocated from @comis/scheduler in Plan
  // 35-02; consumed here as the production createFileLock() target so the
  // daemon no longer reaches into @comis/scheduler for it (D-01 #1).
  createFileLock,
} from "@comis/core";
import {
  agentToolsToToolDefinitions,
  createSkillRegistry,
  createRuntimeEligibilityContext,
  TOOL_PROFILES,
  type SkillRegistry,
  type SkillWatcherHandle,
  type McpClientManager,
} from "@comis/skills";
// Types inferred from adapter return types to avoid adding
// @mariozechner/pi-coding-agent as a daemon dependency.
type PiSessionAdapter = ReturnType<typeof createComisSessionManager>;

// Once-per-daemon-process WARN flag for the encrypted-store hot-reload
// limitation. Lifted to module scope so the flag survives across per-agent
// setupSingleAgent calls AND any future re-invocations of setupAgents within
// the same process. Operator-friendly notice — fires exactly once per daemon
// process so the operator sees it in startup logs without N-times-per-agent
// noise.
let encryptedModeWarnFired = false;

// ---------------------------------------------------------------------------
// Single-agent dependency and result types (extracted for hot-add reuse)
// ---------------------------------------------------------------------------

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
  contextStore?: import("@comis/core").ContextStorePort;
  db?: unknown;
  /** Global provider health monitor shared across all agents */
  providerHealth?: ProviderHealthMonitor;
  /** Global last-known-working model tracker shared across all agents */
  lastKnownModel?: LastKnownModelTracker;
  /** Optional embedding port for discover_tools semantic search. */
  embeddingPort?: import("@comis/core").EmbeddingPort;
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
   * when `appConfig.oauth.storage === "encrypted"` — selectOAuthCredentialStore
   * fails fast with an operator hint when missing.
   */
  secretsCrypto?: SecretsCrypto;
  /**
   * Shared better-sqlite3 handle to secrets.db (the SqliteSecretStoreHandle.db
   * field, plumbed through from daemon.ts after createSqliteSecretStore).
   * Required when `appConfig.oauth.storage === "encrypted"` so the OAuth
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
   * Canonical FileLockPort adapter (proper-lockfile-backed `createFileLock()`
   * from `@comis/scheduler`). Phase 32 commit 12 (ORCH-EXT-15) moved
   * construction here so agent/session/oauth modules no longer import
   * `@comis/scheduler` directly. The port is stateless — one instance
   * shared across every per-agent OAuth store, OAuth token manager, and
   * session-write-lock call site is safe.
   */
  fileLock: FileLockPort;
  /** Wall-clock + monotonic time reads (Phase 39 PORTS-11). */
  clock: import("@comis/core").ClockPort;
  /** Environment-variable reads (Phase 39 PORTS-12). */
  env: import("@comis/core").EnvPort;
  /** Timer scheduling (Phase 39 PORTS-13). */
  timers: import("@comis/core").TimerPort;
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
}

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
  /** Periodic lock cleanup timer (cleared on shutdown). Phase 39 PORTS-13: TimerHandle. */
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
}

// ---------------------------------------------------------------------------
// Single-agent setup (extracted for hot-add reuse)
// ---------------------------------------------------------------------------

/**
 * Set up a single agent's executor and all supporting services.
 * Validates rawAgentConfig with PerAgentConfigSchema before any runtime setup.
 * On validation failure the Zod error propagates to the caller.
 * Extracted from the setupAgents() loop body so it can be called independently
 * for hot-add (adding an agent at runtime without daemon restart).
 */
export async function setupSingleAgent(
  agentId: string,
  rawAgentConfig: PerAgentConfig,
  deps: SingleAgentDeps,
): Promise<SingleAgentResult> {
  // Validate agent config with Zod before any runtime setup
  const agentConfig = PerAgentConfigSchema.parse(rawAgentConfig);

  const { container, memoryAdapter, agentLogger, resolvedAgentDir } = deps;

  // Resolve "default" model/provider to global defaults (MODELS-DEFAULT).
  // Resolution sources, in priority order:
  //   1. Per-agent explicit value (agentConfig.model / .provider)
  //   2. modelsConfig.defaultModel / .defaultProvider (YAML models.* section)
  //   3. Pi-ai catalog: most-populated native provider (heuristic), mid-tier
  //      cost model from resolveOperationDefaults
  // Surfaces resolution source at INFO once per agent so operators can see
  // which model got picked without having to read the resolver source.
  const modelsConfig = container.config.models;
  const resolved = resolveAgentModel(agentConfig, modelsConfig);
  const effectiveConfig = { ...agentConfig, model: resolved.model, provider: resolved.provider };

  // Write resolved values back to container.config.agents so all downstream
  // consumers (getConfig RPC, agents.get, session.status, REST /api/agents)
  // see the resolved model/provider instead of the placeholder "default".
  container.config.agents[agentId] = effectiveConfig;

  if (agentConfig.model !== resolved.model || agentConfig.provider !== resolved.provider) {
    const source =
      modelsConfig.defaultModel || modelsConfig.defaultProvider
        ? "explicit_yaml"
        : "catalog_heuristic";
    agentLogger.info(
      {
        agentId,
        originalModel: agentConfig.model,
        resolvedModel: resolved.model,
        originalProvider: agentConfig.provider,
        resolvedProvider: resolved.provider,
        source,
      },
      "Resolved default model/provider for agent",
    );
  }

  // Resolve contextEngine.compactionModel if it was left at the empty-string
  // schema default. The resolved value is informational — actual compaction
  // routing flows through resolveOperationModel(operationType: "compaction")
  // at execute-time. Logging at INFO once per agent at startup gives
  // operators a visible record of which model would back background ops.
  const ceCompactionRaw = effectiveConfig.contextEngine?.compactionModel ?? "";
  if (ceCompactionRaw.length === 0) {
    const resolvedCompaction = resolveCompactionModel(ceCompactionRaw, resolved.provider);
    if (resolvedCompaction.length > 0) {
      agentLogger.info(
        {
          agentId,
          primaryProvider: resolved.provider,
          resolvedCompactionModel: resolvedCompaction,
          source: "catalog_heuristic",
        },
        "Resolved compactionModel from pi-ai catalog",
      );
    }
  }

  // Each agent gets a dedicated workspace folder:
  //   default agent -> ~/.comis/workspace
  //   named agents  -> ~/.comis/workspace-{agentId}
  // ensureWorkspace bootstraps personality .md files (SOUL.md, IDENTITY.md, USER.md,
  // AGENTS.md, TOOLS.md, HEARTBEAT.md, BOOTSTRAP.md) -- write-if-missing semantics.
  const dir = resolveWorkspaceDir(effectiveConfig, agentId);
  await ensureWorkspace({ dir });

  // Per-agent safety controls (shared by PiExecutor)
  const circuitBreaker = createCircuitBreaker(effectiveConfig.circuitBreaker, deps.clock);
  const budgetGuard = createBudgetGuard(effectiveConfig.budgets);
  const costTracker = createCostTracker();
  const stepCounter = createStepCounter(effectiveConfig.maxSteps);

  // Per-agent scoped secret manager (credential isolation)
  const agentSecrets = effectiveConfig.secrets ?? { allow: [] };
  const scopedManager = createScopedSecretManager(container.secretManager, {
    agentId,
    allowPatterns: agentSecrets.allow,
    eventBus: container.eventBus,
  });
  agentLogger.debug({ agentId, allowPatterns: agentSecrets.allow }, "Per-agent ScopedSecretManager created");

  // Per-agent auth + model registry (moved from shared to per-agent for credential isolation).
  // Custom YAML providers under `providers.entries.*` are wired into both auth (runtime API
  // key overrides) and the registry (so `find(provider, modelId)` succeeds) -- without this,
  // pi-coding-agent silently falls back to whatever built-in provider has env-var auth (e.g.,
  // GEMINI_API_KEY → google), bypassing the configured provider entirely.
  const customProviderEntries = container.config.providers?.entries ?? {};
  const piAuthStorage = createAuthStorageAdapter({
    secretManager: scopedManager,
    customProviderEntries,
  });

  // -------------------------------------------------------------------------
  // FIRST daemon-side OAuth wiring.
  //
  // Closes the unwired-OAuth gap — the createAuthProvider symbol was exported
  // by @comis/agent but never called by the daemon, so refreshed OAuth tokens
  // lived only in the in-memory cache and silently disappeared on restart.
  // AuthProviderConfig.oauth credentialStore + logger + dataDir are REQUIRED
  // so this wiring is type-checked at compile time — future regressions
  // surface as TS errors, not silent runtime failures.
  //
  // All path constructions in this block use safePath from @comis/core (NOT
  // path.join — AGENTS.md §2.2 ESLint security rule).
  // When storage === "encrypted", the OAuth profile adapter SHARES the
  // existing secretsDb handle from createSqliteSecretStore (no dual-handle).
  // -------------------------------------------------------------------------
  const oauthStorageMode = container.config.oauth.storage;
  const dataDirAbs =
    container.config.dataDir && container.config.dataDir.length > 0
      ? container.config.dataDir
      : safePath(homedir(), ".comis");

  // Use the daemon-level OAuthCredentialStore handle that setupAgents()
  // constructed once and threaded through SingleAgentDeps. Same store
  // reference is also exposed on AgentsResult so daemon.ts can plumb it into
  // RpcDispatchDeps for the agents.update oauthProfiles existence check.
  const oauthCredentialStore = deps.oauthCredentialStore;

  const authProvider = createAuthProvider({
    secretManager: scopedManager,
    additionalProviderKeys: undefined,
    oauth: {
      eventBus: container.eventBus,
      credentialStore: oauthCredentialStore,
      logger: agentLogger.child({ submodule: "oauth-token-manager" }),
      dataDir: dataDirAbs,
      // Same canonical FileLockPort instance the OAuth credential store
      // was constructed with — both the file adapter and the token manager
      // need cross-process serialization on the same .locks/ directory.
      fileLock: deps.fileLock,
      keyPrefix: "OAUTH_",
      // Pass auth-profiles.json path when file adapter active so
      // OAuthTokenManager can register the chokidar watcher and pick up
      // CLI-written profiles within ~250ms without a daemon restart.
      // Encrypted-mode: undefined -> no watcher; documented limitation.
      watchPath:
        oauthStorageMode === "file"
          ? safePath(dataDirAbs, "auth-profiles.json")
          : undefined,
      // Closure-stability: the closure dereferences
      // container.config.agents[agentId]?.oauthProfiles on every call.
      // This is the only correct shape because:
      //   1. The `container.config.agents[agentId] = effectiveConfig`
      //      writeback above (search for that assignment in this file)
      //      stores a NEW object built from
      //      { ...agentConfig, model, provider } into the daemon's map.
      //      The local `agentConfig` parameter diverges from the map
      //      immediately at startup — capturing it would observe the
      //      wrong value.
      //   2. agents.update at agent-handlers.ts:341 executes
      //      `deps.agents[agentId] = parsedConfig`, REPLACING the
      //      reference at that key with a new validated object. Capturing
      //      the local agentConfig parameter would miss this hot-update.
      //   3. daemon.ts confirms `deps.agents` and `container.config.agents`
      //      are THE SAME map object — search for
      //      `agents: container.config.agents` in the RpcDispatchDeps
      //      construction. The daemon holds a single per-process
      //      Container.config instance.
      // The map identity is stable; only the value at the agent key
      // changes. The closure-evaluated dereference observes (1) at
      // startup AND (2) on every agents.update without an event-bus
      // invalidation or daemon restart, allowing the agents_manage tool to
      // update without a daemon restart.
      getAgentOauthProfiles: () =>
        container.config.agents?.[agentId]?.oauthProfiles,
    },
  });

  agentLogger.debug(
    {
      agentId,
      oauthStorage: oauthStorageMode,
      dataDir: dataDirAbs,
      submodule: "setup-agents",
    },
    "OAuth credential store + auth provider + per-LLM-call dispatch wired",
  );

  const piModelRegistry = createModelRegistryAdapter(piAuthStorage);
  const { registered: customProviderCount, providerAliases } = registerCustomProviders(
    piModelRegistry,
    customProviderEntries,
    scopedManager,
    agentLogger,
  );
  if (customProviderCount > 0) {
    agentLogger.debug(
      { agentId, customProviderCount },
      "Custom YAML providers registered with pi ModelRegistry",
    );
  }
  if (providerAliases.size > 0) {
    agentLogger.debug(
      { agentId, aliases: Object.fromEntries(providerAliases) },
      "Provider name aliases for built-in resolution",
    );
  }

  // Create JSONL session adapter for this agent
  const lockDir = safePath(dir, ".locks");
  const sessionAdapter = createComisSessionManager({
    sessionBaseDir: safePath(dir, "sessions"),
    lockDir,
    cwd: dir,
    // Same FileLockPort instance the OAuth path uses — single proper-lockfile
    // adapter per daemon process per Phase 32 commit 12 (ORCH-EXT-15).
    fileLock: deps.fileLock,
    // WR-07: thread the agent-scoped logger so withSessionLock can emit a
    // structured-cause line before collapsing the FileLockPort error
    // union to the legacy 'locked' | 'error' string. Enables operator
    // triage of EACCES / disk-full vs lock contention.
    logger: agentLogger,
  });

  // Clean up stale lock sentinel files from previous daemon runs
  suppressError(
    cleanupStaleLocks(deps.fileLock, lockDir).then((removed) => {
      if (removed > 0) {
        agentLogger.info({ agentId, removed, lockDir }, "Cleaned up stale lock sentinels");
      }
    }),
    "stale lock sentinel cleanup",
  );

  // Prompt skill registry: discover skills from per-agent discoveryPaths,
  // produce <available_skills> XML for system prompt injection.
  const skillsConfig = effectiveConfig.skills ?? SkillsConfigSchema.parse({});
  const perAgentLogger = agentLogger.child({ agentId });

  // Create runtime eligibility context for this agent
  const eligibilityContext = createRuntimeEligibilityContext(scopedManager);

  // Resolve relative discoveryPaths against dataDir so ./skills -> ~/.comis/skills
  const dataDir = container.config.dataDir || ".";
  const agentSkillsDir = safePath(dir, "skills");  // dir = agent workspace from resolveWorkspaceDir()
  mkdirSync(agentSkillsDir, { recursive: true });
  const resolvedPaths = skillsConfig.discoveryPaths.map((p: string) =>
    isAbsolute(p) ? p : resolve(dataDir, p),
  );
  // Prepend agent workspace skills dir (first-loaded-wins: agent skills take precedence)
  if (!resolvedPaths.includes(agentSkillsDir)) {
    resolvedPaths.unshift(agentSkillsDir);
  }

  const resolvedSkillsConfig = {
    ...skillsConfig,
    discoveryPaths: resolvedPaths,
  };

  const skillRegistry = createSkillRegistry(
    resolvedSkillsConfig,
    container.eventBus,
    { agentId, tenantId: container.config.tenantId, userId: "system" },
    perAgentLogger,
    eligibilityContext,  // Runtime eligibility context
  );
  skillRegistry.init();

  // Per-agent ToolCapabilityPort adapter. Construction sits here so the
  // adapter can close over this agent's skillRegistry; the adapter is
  // reused by pi-executor (capability-index renderer) AND by exec/process
  // tools (install-detour parser via setupTools.getCapabilityPortForAgent).
  const toolCapabilityPort = createToolCapabilityAdapter({
    toolingConfig: container.config.tooling,
    skillRegistry,
    mcpClientManager: deps.mcpClientManager,
    logger: perAgentLogger,
  });

  // Opt-in file watching for automatic skill reload
  let skillWatcherHandle: SkillWatcherHandle | undefined;
  if (skillsConfig.watchEnabled) {
    skillWatcherHandle = skillRegistry.startWatching(skillsConfig.watchDebounceMs);
    perAgentLogger.debug({ debounceMs: skillsConfig.watchDebounceMs }, "Skill file watcher started");
  }

  // OutputGuard + per-agent canary token
  const outputGuard = createOutputGuard();

  // Prefer CANARY_SECRET from env, fall back to deterministic derivation
  const configuredCanarySecret = scopedManager.get("CANARY_SECRET");
  const canarySecret = configuredCanarySecret
    ?? deriveCanaryFallback(deps.canaryFallbackSecret ?? container.config.tenantId, agentId);

  if (!configuredCanarySecret) {
    perAgentLogger.warn(
      {
        hint: "Set CANARY_SECRET environment variable for stable canary tokens across restarts",
        errorKind: "config" as const,
      },
      "Canary secret not configured, using deterministic fallback",
    );
  }

  const canaryToken = generateCanaryToken(agentId, canarySecret);

  // InputSecurityGuard per agent
  const inputGuard = createInputSecurityGuard();
  // Uses default config: mediumThreshold=0.4, highThreshold=0.7, action="warn"
  // Operator can override via agent config in future phases

  // Pre-resolve lean descriptions for this agent's session.
  // channelType unavailable at agent setup time; message tool resolves to "chat"
  // fallback. Per-channel resolution deferred to
  const descriptionContext: ToolDescriptionContext = {
    channelType: undefined,
    trustLevel: "default", // Trust comes from token/context at message time, not config
    // Deferral uses resolveModelTier(contextWindow) per-execution in pi-executor.
    // This setup-time modelTier only affects lean description text (e.g., admin suffix).
    modelTier: agentConfig.bootstrap?.promptMode === "minimal" ? "small" : "large",
  };
  const resolvedDescriptions: Record<string, string> = {};
  let dynamicCount = 0;
  for (const name of Object.keys(LEAN_TOOL_DESCRIPTIONS)) {
    const raw = LEAN_TOOL_DESCRIPTIONS[name];
    if (typeof raw === "function") dynamicCount++;
    resolvedDescriptions[name] = resolveDescription(
      { name },
      LEAN_TOOL_DESCRIPTIONS,
      descriptionContext,
    );
  }
  const totalDescriptionTokens = Object.values(resolvedDescriptions)
    .reduce((sum, d) => sum + Math.ceil(d.length / 4), 0);
  const overLimitCount = Object.values(resolvedDescriptions)
    .filter((d) => d.length > 300).length;
  // agentId already bound on perAgentLogger child -- do not duplicate
  perAgentLogger.info(
    {
      descriptionCount: Object.keys(resolvedDescriptions).length,
      tokenCount: totalDescriptionTokens,
      dynamicCount,
      overLimitCount,
      // Finding 7: setup-time modelTier for lean description selection (per-execution tier may differ)
      modelTier: descriptionContext.modelTier,
    },
    "Tool descriptions resolved",
  );

  // Tool pipeline for PiExecutor.
  // Platform tools (memory, cron, messaging, sessions) come per-request via
  // executor.execute(msg, sessionKey, tools) -- assembled by setupTools which
  // runs after setupAgents. The convertTools callback converts per-request
  // AgentTool[] to ToolDefinition[] inside PiExecutor without agent->skills dep.
  // customTools here is empty -- per-request tools provide the full pipeline.
  // No wrapWithAudit: PiEventBridge already emits tool:executed for ALL tools.
  // tools: [] -- all tools come exclusively through customTools where the full
  // Comis security pipeline (safePath + tool policy + audit) is enforced.

  // Model failover: convert config FallbackModel[] to "provider:modelId" strings
  // and create auth rotation adapter for multi-key providers.
  const failoverConfig = effectiveConfig.modelFailover;
  const fallbackModelStrings = failoverConfig.fallbackModels.map(
    (m) => `${m.provider}:${m.modelId}`,
  );
  const authProfileManager = failoverConfig.authProfiles.length > 0
    ? createAuthProfileManager({
        profiles: failoverConfig.authProfiles,
        secretManager: scopedManager,
        initialMs: failoverConfig.cooldownInitialMs,
        multiplier: failoverConfig.cooldownMultiplier,
        capMs: failoverConfig.cooldownCapMs,
      })
    : undefined;
  const authRotation = authProfileManager
    ? createAuthRotationAdapter({ authStorage: piAuthStorage, profileManager: authProfileManager })
    : undefined;

  const executor = createPiExecutor(effectiveConfig, {
    circuitBreaker,
    providerHealth: deps.providerHealth,
    lastKnownModel: deps.lastKnownModel,
    budgetGuard,
    costTracker,
    stepCounter,
    eventBus: container.eventBus,
    logger: perAgentLogger,
    authStorage: piAuthStorage,
    // Thread OAuthTokenManager into the executor so the per-LLM-call
    // dispatch hook (PiExecutor.execute pre-hook + the two compaction
    // getApiKey callbacks in executor-context-engine-setup.ts) can resolve
    // OAuth tokens via resolveProviderApiKey.
    oauthManager: authProvider.oauth,
    modelRegistry: piModelRegistry,
    providerAliases,
    fallbackModels: fallbackModelStrings.length > 0 ? fallbackModelStrings : undefined,
    authRotation,
    sessionAdapter,
    workspaceDir: dir,
    agentDir: resolvedAgentDir,
    customTools: [],
    convertTools: (tools) => agentToolsToToolDefinitions(tools, resolvedDescriptions),
    subAgentToolNames: deps.subAgentToolNames,
    mcpToolsInherited: deps.mcpToolsInherited,
    memoryPort: memoryAdapter,
    secretManager: scopedManager,
    envelopeConfig: container.config.envelope,
    senderTrustDisplayConfig: container.config.senderTrustDisplay,
    documentationConfig: container.config.documentation,
    hookRunner: container.hookRunner,
    outboundMediaEnabled: deps.outboundMediaEnabled,
    mediaPersistenceEnabled: container.config.integrations.media.persistence.enabled,
    autonomousMediaEnabled: deps.autonomousMediaEnabled,
    getPromptSkillsXml: () => skillRegistry.getSnapshot().prompt,
    skillRegistry,  // Enable SDK skill discovery -> registry population
    activeRunRegistry: deps.activeRunRegistry,
    outputGuard,    // Scan LLM responses for leaked secrets
    canaryToken,    // Detect canary token leakage
    inputValidator: validateInput,  // Structural validation
    inputGuard,                     // Jailbreak scoring
    rateLimiter: deps.injectionRateLimiter,  // Per-user rate limiting
    tracingDefaults: deps.daemonTracingDefaults
      ? { maxSize: deps.daemonTracingDefaults.maxSize, maxFiles: deps.daemonTracingDefaults.maxFiles }
      : undefined,
    embeddingEnqueue: deps.embeddingQueue?.enqueue.bind(deps.embeddingQueue),
    embeddingPort: deps.embeddingPort,  // Semantic search in discover_tools
    toolCapabilityPort,  // Live adapter constructed above from container.config.tooling + skillRegistry + mcpClientManager.
    // DAG context engine deps (optional -- only when context engine version is dag)
    contextStore: deps.contextStore,
    db: deps.db,
    tenantId: container.config.tenantId,
    deliveryMirror: deps.deliveryMirror,
    deliveryMirrorConfig: deps.deliveryMirrorConfig,
    geminiCacheManager: deps.geminiCacheManager,  // Gemini cache lifecycle manager
    getChannelMaxChars: deps.getChannelMaxChars,  // Platform char limit for verbosity hints
    backgroundTaskManager: deps.backgroundTaskManager,  // Auto-background middleware
    // Provider compatibility config threading
    enforceFinalTag: effectiveConfig.enforceFinalTag,
    fastMode: effectiveConfig.fastMode,
    storeCompletions: effectiveConfig.storeCompletions,
    providerCapabilities: container.config.providers?.entries?.[resolved.provider]?.capabilities,
    maxSendsPerExecution: container.config.messages?.maxSendsPerExecution,
    // Phase 39 PORTS-11/12/13: runtime adapter ports threaded into the executor.
    clock: deps.clock,
    env: deps.env,
    timers: deps.timers,
  });

  agentLogger.debug(
    { agentId, name: effectiveConfig.name, model: effectiveConfig.model },
    "Agent executor initialized",
  );

  return {
    executor,
    workspaceDir: dir,
    costTracker,
    budgetGuard,
    stepCounter,
    piSessionAdapter: sessionAdapter,
    skillWatcherHandle,
    skillRegistry,
    toolCapabilityPort,  // Exposed for AgentsResult.toolCapabilityPorts map
  };
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
  /** Context store for DAG mode context engine */
  contextStore?: import("@comis/core").ContextStorePort;
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
  /** Wall-clock + monotonic time reads (Phase 39 PORTS-11). */
  clock: import("@comis/core").ClockPort;
  /** Environment-variable reads (Phase 39 PORTS-12). */
  env: import("@comis/core").EnvPort;
  /** Timer scheduling (Phase 39 PORTS-13). */
  timers: import("@comis/core").TimerPort;
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

  // Phase 31 commit 4 (MEM-CTX-PORTS-07): construct the encrypted-mode store
  // HERE (daemon already owns secretsDb + secretsCrypto). The agent selector
  // no longer reaches into @comis/memory.
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

  // Phase 32 commit 12 (ORCH-EXT-15): construct the canonical FileLockPort
  // adapter ONCE here. Reused for OAuth store/manager locking AND session-
  // write-lock + stale-lock cleanup across every per-agent setup. The port
  // is stateless (per `createFileLock` semantics in @comis/scheduler), so a
  // single shared instance is correct.
  const fileLock = createFileLock();

  const oauthCredentialStore = selectOAuthCredentialStore({
    storage: container.config.oauth.storage,
    dataDir: dataDirAbsForOauth,
    fileLock,
    encryptedStore,
  });

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
    // Phase 39 PORTS-11/12/13: runtime adapter ports.
    clock: deps.clock,
    env: deps.env,
    timers: deps.timers,
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
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolve "default" model/provider placeholders to concrete values from the
 * pi-ai catalog. Called once per agent at daemon startup so executors always
 * receive concrete values.
 *
 * Resolution sources, in priority order:
 *   1. Per-agent explicit value (agentConfig.model / .provider not "default")
 *   2. YAML models.defaultModel / models.defaultProvider (operator override)
 *   3. Catalog heuristic for provider: most-populated native pi-ai provider
 *      (e.g. openrouter at 249 models > anthropic at 23). Single source of
 *      truth — no env var, no hardcoded FALLBACK_PROVIDER. If users want
 *      a specific default, they set models.defaultProvider in YAML.
 *   4. Catalog heuristic for model: resolveOperationDefaults(provider).mid
 *      (mid-tier cost), falling back to getModels(provider)[0].id.
 *
 * Throws when the pi-ai catalog is empty (zero providers / zero models for
 * the resolved provider) — the caller is asking for a default and we can't
 * synthesize one. Operators can recover by setting models.defaultProvider /
 * models.defaultModel explicitly.
 */
export function resolveAgentModel(
  agentConfig: { model: string; provider: string },
  modelsConfig: { defaultModel: string; defaultProvider: string },
): { model: string; provider: string } {
  const providerIsDefault = agentConfig.provider.toLowerCase() === "default";
  const modelIsDefault = agentConfig.model.toLowerCase() === "default";

  // Step 1: resolve provider
  let provider: string;
  if (!providerIsDefault) {
    provider = agentConfig.provider;
  } else if (modelsConfig.defaultProvider) {
    provider = modelsConfig.defaultProvider;
  } else {
    // Catalog heuristic: most-populated native provider wins.
    const allProviders = getProviders();
    if (allProviders.length === 0) {
      throw new Error(
        "Pi-ai catalog returned zero providers. " +
        "Install or upgrade @mariozechner/pi-ai, or set models.defaultProvider explicitly.",
      );
    }
    provider = allProviders
      .map((p) => ({ p, n: getModels(p as KnownProvider).length }))
      .sort((a, b) => b.n - a.n)[0]!.p;
  }

  // Step 2: resolve model
  let model: string;
  if (!modelIsDefault) {
    model = agentConfig.model;
  } else if (modelsConfig.defaultModel) {
    model = modelsConfig.defaultModel;
  } else {
    // Catalog read: prefer mid-tier from resolveOperationDefaults
    // (catalog-derived, cost-aware), fall back to first model id when
    // resolveOperationDefaults returns {} (custom YAML providers).
    const tier = resolveOperationDefaults(provider);
    const firstId = getModels(provider as KnownProvider)[0]?.id;
    const candidate = tier.mid ?? firstId;
    if (!candidate) {
      throw new Error(
        `No models found for provider "${provider}" in pi-ai catalog. ` +
        "Set models.defaultModel explicitly or upgrade @mariozechner/pi-ai.",
      );
    }
    model = candidate;
  }

  return { model, provider };
}

/**
 * Resolve the union of tool names from TOOL_PROFILES for the configured
 * sub-agent tool groups. Also includes builtin tools that sub-agents always get
 * (web_search, web_fetch, read, edit, write, grep, find, ls).
 */
function resolveSubAgentToolNames(groups: string[]): string[] {
  const builtins = [
    "web_search", "web_fetch", "read", "edit", "write",
    "grep", "find", "ls",
  ];
  const fromProfiles = groups.flatMap(g => TOOL_PROFILES[g] ?? []);
  return [...new Set([...builtins, ...fromProfiles])];
}

/**
 * Derive a deterministic canary fallback secret for an agent.
 * Used when CANARY_SECRET is not configured in environment.
 */
function deriveCanaryFallback(baseSecret: string, agentId: string): string {
  return createHmac("sha256", baseSecret)
    .update(`canary-fallback:${agentId}`)
    .digest("hex");
}

// ---------------------------------------------------------------------------
// OAuth credential store selection lives in @comis/agent (CLI cannot import
// from @comis/daemon, so the helper must live where both daemon and CLI
// consume it).
// See: packages/agent/src/model/oauth-credential-store-selector.ts
// ---------------------------------------------------------------------------
