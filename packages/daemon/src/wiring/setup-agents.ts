// SPDX-License-Identifier: Apache-2.0
/**
 * Per-agent executor setup: session manager, per-agent workspace, safety
 * dependencies (circuit breaker, budget guard, cost tracker, step counter),
 * and PiExecutor creation.
 * All agents use PiExecutor (pi-coding-agent AgentSession wrapper).
 * @module
 */

import { safePath, SkillsConfigSchema, createScopedSecretManager, createOutputGuard, generateCanaryToken, createInputSecurityGuard, validateInput, PerAgentConfigSchema, type AppContainer, type InjectionRateLimiter, type PerAgentConfig } from "@comis/core";
import { suppressError } from "@comis/shared";
import { createHmac } from "node:crypto";
import type { ComisLogger } from "@comis/infra";
import type { SqliteMemoryAdapter, createSessionStore } from "@comis/memory";
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
  ensureWorkspace,
  resolveWorkspaceDir,
  createPiExecutor,
  createComisSessionManager,
  cleanupStaleLocks,
  createAuthStorageAdapter,
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
import {
  agentToolsToToolDefinitions,
  createSkillRegistry,
  createRuntimeEligibilityContext,
  TOOL_PROFILES,
  type SkillRegistry,
  type SkillWatcherHandle,
} from "@comis/skills";
// Types inferred from adapter return types to avoid adding
// @mariozechner/pi-coding-agent as a daemon dependency.
type PiSessionAdapter = ReturnType<typeof createComisSessionManager>;

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
  contextStore?: import("@comis/memory").ContextStore;
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
  /** Callback to send completion notifications for background tasks. */
  backgroundNotifyFn?: import("@comis/agent").NotifyFn;
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
  /** Periodic lock cleanup timer (cleared on shutdown). */
  lockCleanupTimer: ReturnType<typeof setInterval>;
  /** Shared single-agent dependencies for hot-add closure capture. */
  singleAgentDeps: SingleAgentDeps;
  /** Global provider health monitor for daemon-level health metrics */
  providerHealth: ProviderHealthMonitor;
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
  const circuitBreaker = createCircuitBreaker(effectiveConfig.circuitBreaker);
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
  });

  // Clean up stale lock sentinel files from previous daemon runs
  suppressError(
    cleanupStaleLocks(lockDir).then((removed) => {
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
    // DAG context engine deps (optional -- only when context engine version is dag)
    contextStore: deps.contextStore,
    db: deps.db,
    tenantId: container.config.tenantId,
    deliveryMirror: deps.deliveryMirror,
    deliveryMirrorConfig: deps.deliveryMirrorConfig,
    geminiCacheManager: deps.geminiCacheManager,  // Gemini cache lifecycle manager
    getChannelMaxChars: deps.getChannelMaxChars,  // Platform char limit for verbosity hints
    backgroundTaskManager: deps.backgroundTaskManager,  // Auto-background middleware
    backgroundNotifyFn: deps.backgroundNotifyFn,  // Background task completion notifications
    // Provider compatibility config threading
    enforceFinalTag: effectiveConfig.enforceFinalTag,
    fastMode: effectiveConfig.fastMode,
    storeCompletions: effectiveConfig.storeCompletions,
    providerCapabilities: container.config.providers?.entries?.[resolved.provider]?.capabilities,
    maxSendsPerExecution: container.config.messages?.maxSendsPerExecution,
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
  contextStore?: import("@comis/memory").ContextStore;
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
  /** Callback to send completion notifications for background tasks. */
  backgroundNotifyFn?: import("@comis/agent").NotifyFn;
}): Promise<AgentsResult> {
  const { container, memoryAdapter, sessionStore, agentLogger } = deps;

  // Inject module-level logger for response sanitization pipeline
  setSanitizeLogger(agentLogger.child({ module: "response-sanitize" }));

  // Inject module-level logger for tool schema normalization pipeline
  setToolNormalizationLogger(agentLogger.child({ module: "tool-normalize" }));

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
    backgroundNotifyFn: deps.backgroundNotifyFn,
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
  const lockCleanupTimer = setInterval(() => {
    for (const [agentId, dir] of workspaceDirs) {
      const lockDir = safePath(dir, ".locks");
      suppressError(
        cleanupStaleLocks(lockDir).then((removed) => {
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
    lockCleanupTimer,
    singleAgentDeps,
    providerHealth,
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
