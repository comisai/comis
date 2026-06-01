// SPDX-License-Identifier: Apache-2.0
// @allow-throw: setup-agents runtime guards; consumed at daemon.ts bootstrap catch boundary.
/**
 * Per-agent executor runtime: session manager, per-agent workspace, safety
 * dependencies (circuit breaker, budget guard, cost tracker, step counter),
 * and PiExecutor creation. Single-agent factory `setupSingleAgent` and the
 * shared `SingleAgentDeps` / `SingleAgentResult` interface declarations.
 *
 * Imports `resolveAgentModel` + `deriveCanaryFallback` from
 * ./setup-agents-tooling.js; the top-level orchestration loop lives in
 * ./setup-agents-registry.js.
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

import { safePath, SkillsConfigSchema, createScopedSecretManager, createOutputGuard, generateCanaryToken, createInputSecurityGuard, validateInput, PerAgentConfigSchema, type PerAgentConfig } from "@comis/core";
import { createToolCapabilityAdapter } from "../tool-capability-adapter.js";
import { suppressError } from "@comis/shared";
import { homedir } from "node:os";
import { mkdirSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import {
  createCircuitBreaker,
  createBudgetGuard,
  createCostTracker,
  createStepCounter,
  createPiExecutor,
  createComisSessionManager,
  cleanupStaleLocks,
  createAuthStorageAdapter,
  createModelRegistryAdapter,
  registerCustomProviders,
  createAuthProfileManager,
  createAuthRotationAdapter,
  resolveCompactionModel,
  LEAN_TOOL_DESCRIPTIONS,
  resolveDescription,
  type ToolDescriptionContext,
} from "@comis/agent";
import { ensureWorkspace, resolveWorkspaceDir } from "@comis/core";
import {
  agentToolsToToolDefinitions,
  createSkillRegistry,
  createRuntimeEligibilityContext,
  type SkillWatcherHandle,
} from "@comis/skills";
import { resolveAgentModel, deriveCanaryFallback, resolveEffectiveRerank } from "./setup-agents-tooling.js";
import { createAcpWiring } from "./setup-acp-wiring.js";
import {
  detectAndRecordModeSwitch,
  makeConsumePendingModeSwitch,
} from "./setup-agents-mode-switch.js";
import { wireAuthProvider } from "./setup-agents-oauth.js";
import type { SingleAgentDeps, SingleAgentResult } from "./setup-agents-types.js";
// Re-export types so consumers of the runtime leaf preserve the historic
// import shape (parity-tests + setup-agents.test.ts inspect by name).
export type { SingleAgentDeps, SingleAgentResult } from "./setup-agents-types.js";

// ---------------------------------------------------------------------------
// Single-agent setup (extracted for hot-add reuse)
// ---------------------------------------------------------------------------

/**
 * Set up a single agent's executor and all supporting services.
 * Validates agentConfig with PerAgentConfigSchema before any runtime setup.
 * On validation failure the Zod error propagates to the caller.
 * Extracted from the setupAgents() loop body so it can be called independently
 * for hot-add (adding an agent at runtime without daemon restart).
 *
 * `rawRerankEnabled` is the RAW (pre-Zod-default) `rag.rerank.enabled`
 * (`undefined` = operator unset) — see the resolution site below (CR-01).
 */
export async function setupSingleAgent(
  agentId: string,
  agentConfigInput: PerAgentConfig,
  deps: SingleAgentDeps,
  rawRerankEnabled?: boolean | undefined,
): Promise<SingleAgentResult> {
  // Validate agent config with Zod before any runtime setup
  const agentConfig = PerAgentConfigSchema.parse(agentConfigInput);

  const { container, memoryAdapter, agentLogger, resolvedAgentDir } = deps;

  // Resolve "default" model/provider to global defaults.
  // Resolution sources, in priority order:
  //   1. Per-agent explicit value (agentConfig.model / .provider)
  //   2. modelsConfig.defaultModel / .defaultProvider (YAML models.* section)
  //   3. Pi-ai catalog: most-populated native provider (heuristic), mid-tier
  //      cost model from resolveOperationDefaults
  // Surfaces resolution source at INFO once per agent so operators can see
  // which model got picked without having to read the resolver source.
  const modelsConfig = container.config.models;
  const resolved = resolveAgentModel(agentConfig, modelsConfig);
  // Phase 92 (RERANK-01/CR-01): EFFECTIVE rag.rerank.enabled — explicit wins, unset auto-ons
  // iff the model is present. The explicit signal MUST be RAW (parsed agentConfig defaults
  // unset to false, erasing it): explicit arg (hot-add) else the daemon-wide container map
  // (boot) — the SAME source the build gate reads (T-92-06/WR-03). Spread keeps sibling knobs.
  const rawRerank =
    rawRerankEnabled !== undefined ? rawRerankEnabled : container.rawAgentRerankEnabled?.get(agentId);
  const effectiveConfig = {
    ...agentConfig,
    model: resolved.model,
    provider: resolved.provider,
    rag: { ...agentConfig.rag, rerank: { ...agentConfig.rag.rerank, enabled: resolveEffectiveRerank(rawRerank, deps.rerankerModelPresent ?? false) } },
  };

  // DAG-05: detect a context-engine MODE SWITCH at the rebuild seam.
  // container.config.agents[agentId] still holds the PRIOR config here (on a
  // config-reload re-invocation); it is undefined on the very first build. We
  // must read the prior version BEFORE the overwrite below (which destroys the
  // prior config). The detection + INFO boundary log live in
  // detectAndRecordModeSwitch (setup-agents-mode-switch.ts).
  detectAndRecordModeSwitch(
    agentId,
    container.config.agents[agentId]?.contextEngine?.version,
    effectiveConfig.contextEngine?.version,
    deps.pendingModeSwitches,
    agentLogger,
  );

  // Write resolved values back to container.config.agents so all downstream
  // consumers (getConfig RPC, agents.get, session.status, REST /api/agents)
  // see the resolved model/provider instead of the placeholder "default".
  container.config.agents[agentId] = effectiveConfig;

  // Phase 92 (RERANK-01): surface the locally-gated auto-on once at the boundary (booleans
  // only — T-92-07). Now LIVE: fires ONLY for unset + model-present (not for explicit-on).
  if (rawRerank === undefined && effectiveConfig.rag.rerank.enabled === true) {
    agentLogger.info({ agentId, rerankAutoEnabled: true }, "Reranker auto-enabled (model present, unset config)");
  }

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

  // FIRST daemon-side OAuth wiring — see setup-agents-oauth.ts for the full
  // rationale (unwired-OAuth gap closure + closure-stability invariant).
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

  const authProvider = wireAuthProvider({
    agentId,
    container,
    scopedManager,
    oauthCredentialStore,
    fileLock: deps.fileLock,
    dataDirAbs,
    oauthStorageMode,
    agentLogger,
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
    // Same FileLockPort instance the OAuth path uses — single proper-lockfile
    // adapter per daemon process.
    fileLock: deps.fileLock,
    // Thread the agent-scoped logger so withSessionLock can emit a
    // structured-cause line before collapsing the FileLockPort error
    // union to the legacy 'locked' | 'error' string. Enables operator
    // triage of EACCES / disk-full vs lock contention.
    logger: agentLogger,
    // Bus + registry let destroySession emit `session:ended` and drain
    // the trajectory recorder before unlinking the JSONL (session lifecycle invariant).
    eventBus: container.eventBus,
    trajectoryRegistry: deps.trajectoryRegistry,
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
  // fs-safe-allowed: per-agent workspace skills dir (`<agentWorkspace>/skills`); workspace dir is operator-configured, not ~/.comis/ directly
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
  // Operator can override via agent config in the future

  // Pre-resolve lean descriptions for this agent's session.
  // channelType unavailable at agent setup time; message tool resolves to "chat"
  // fallback. Per-channel resolution deferred to runtime.
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
      // Setup-time modelTier for lean description selection (per-execution tier may differ)
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

  // ACP-03: one ExecutionPlanHolder per agent runtime, shared by reference into
  // PiExecutorDeps.executionPlanHolder AND AcpServerDeps via createAcpWiring (T-74-33).
  const { holder: executionPlanHolder } = createAcpWiring({ eventBus: container.eventBus, logger: perAgentLogger });

  const executor = createPiExecutor(effectiveConfig, {
    circuitBreaker,
    providerHealth: deps.providerHealth,
    executionPlanHolder,
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
    reranker: deps.rerankerPort,  // Cross-encoder reranker (built in setup-memory only when an agent enables rerank).
    entityStore: deps.entityStore, temporalStore: deps.temporalStore, causalStore: deps.causalStore, tripleStore: deps.tripleStore, embeddingStore: deps.embeddingStore, usefulnessStore: deps.usefulnessStore, userRepresentationStore: deps.userRepresentationStore, relationshipStore: deps.relationshipStore,  // P83/rag.entityLane + P95·LANES-02/rag.lanes.temporal + P96·EXTRACT-03/rag.lanes.causal + P100·KG-01/rag.lanes.graphSpread + P102·IQ-01/rag.mmr + P93·FEED-03/rag.feedback + P107·USER-03/memoryUserRepresentation + P108·SOCIAL-02/socialModeling standing-block -> createMemoryRecall/prompt-assembly read (default-OFF; JSDoc on AgentSetupDeps).
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
    // DAG-05: one-shot delete-on-read consumer of a pending engine-mode switch.
    // Threaded through PiExecutorDeps -> setupContextEngine -> DagContextEngineDeps
    // so the DAG reconcile seam can emit context:mode_switched once (with the
    // real import cost) and then clear the pending flag. Returns undefined when
    // there is no pending switch (e.g. a brand-new DAG-default conversation),
    // so no false event fires.
    consumePendingModeSwitch: makeConsumePendingModeSwitch(deps.pendingModeSwitches),
    tenantId: container.config.tenantId,
    deliveryMirror: deps.deliveryMirror,
    deliveryMirrorConfig: deps.deliveryMirrorConfig,
    // Thread diagnostics.trajectory into the per-session trajectory
    // recorder + bridge wiring. Handles enabled/dir/maxFileBytes plumbing
    // and threads `eventTypes` which the bridge consumes as a
    // subscription-time filter
    // (packages/observability/src/trajectory/event-bus-bridge.ts).
    //
    // Operators who set `diagnostics.trajectory.enabled: false` in YAML
    // disable the recorder entirely.
    //
    // Precedence for trajectoryDir:
    //   1. diagnostics.trajectory.dir (explicit YAML knob — unchanged)
    //   2. observability.trajectory.dirOverride (env-layer / YAML knob)
    //   3. env fallback inside paths.ts:readEnvDir() (defense-in-depth)
    //   4. session co-location / cwd (default)
    trajectoryConfig: container.config.diagnostics?.trajectory
      ? {
          enabled: container.config.diagnostics.trajectory.enabled,
          dir:
            container.config.diagnostics.trajectory.dir ??
            container.config.observability?.trajectory?.dirOverride,
          maxFileBytes: container.config.diagnostics.trajectory.maxFileBytes,
          eventTypes: container.config.diagnostics.trajectory.eventTypes,
        }
      : undefined,
    // Session-scoped trajectory recorder registry — same instance for
    // every per-agent executor so a session's recorder spans every
    // turn (session-scoped recorder lifecycle invariant). Daemon shutdown drains via
    // `closeAll()` on the registry surfaced through AgentsResult.
    trajectoryRegistry: deps.trajectoryRegistry,
    // Forward AppConfig.diagnostics.cacheTrace into the executor. The
    // per-session cache-trace recorder reads this; when omitted or
    // `enabled: false`, the recorder is a no-op.
    cacheTraceConfig: container.config.diagnostics?.cacheTrace
      ? {
          enabled: container.config.diagnostics.cacheTrace.enabled,
          filePath: container.config.diagnostics.cacheTrace.filePath,
          includeMessages: container.config.diagnostics.cacheTrace.includeMessages,
          includePrompt: container.config.diagnostics.cacheTrace.includePrompt,
          includeSystem: container.config.diagnostics.cacheTrace.includeSystem,
          maxFileBytes: container.config.diagnostics.cacheTrace.maxFileBytes,
        }
      : undefined,
    // Forward AppConfig.diagnostics.recallTrace into the executor (Phase 86 /
    // OBS-02), EXACTLY mirroring the cacheTraceConfig thread above. Threaded
    // onward via ToolAssemblyDeps → PromptAssemblyParams.deps.recallTraceConfig,
    // where buildRecallTrace reads the `enabled` gate. Without this thread
    // buildRecallTrace always saw cfg=undefined and returned null, so zero
    // recall traces were written even with diagnostics.recallTrace.enabled: true.
    // Recall-trace is OPT-IN (schema default enabled:false) and has NO
    // raw-content slot (unlike cacheTrace's includeMessages/includeSystem): the
    // recorder always full-sanitizes before disk (OBS-02).
    recallTraceConfig: container.config.diagnostics?.recallTrace
      ? {
          enabled: container.config.diagnostics.recallTrace.enabled,
          filePath: container.config.diagnostics.recallTrace.filePath,
          maxFileBytes: container.config.diagnostics.recallTrace.maxFileBytes,
        }
      : undefined,
    geminiCacheManager: deps.geminiCacheManager,  // Gemini cache lifecycle manager
    getChannelMaxChars: deps.getChannelMaxChars,  // Platform char limit for verbosity hints
    backgroundTaskManager: deps.backgroundTaskManager,  // Auto-background middleware
    // Provider compatibility config threading
    enforceFinalTag: effectiveConfig.enforceFinalTag,
    fastMode: effectiveConfig.fastMode,
    storeCompletions: effectiveConfig.storeCompletions,
    providerCapabilities: container.config.providers?.entries?.[resolved.provider]?.capabilities,
    maxSendsPerExecution: container.config.messages?.maxSendsPerExecution,
    // Runtime adapter ports threaded into the executor.
    clock: deps.clock,
    env: deps.env,
    timers: deps.timers,
    // Thread ObservabilityStore through to prompt-assembly for production
    // SystemPromptReport persistence. Without this thread, the
    // build+persist block at prompt-assembly.ts:920 is a no-op in
    // production (the library + isolated tests pass, but the operator
    // cannot answer "why didn't the model use IDENTITY.md?" against a
    // real daemon run).
    // The memory.sessionStore (createSessionStore) does NOT implement
    // SessionStoreReportSink — the per-session ledger sink is omitted
    // here; observabilityStore is the load-bearing sink.
    observabilityStore: deps.obsStore,
  });

  agentLogger.debug({ agentId, name: effectiveConfig.name, model: effectiveConfig.model }, "Agent executor initialized");

  return {
    executor,
    workspaceDir: dir,
    costTracker,
    budgetGuard,
    stepCounter,
    piSessionAdapter: sessionAdapter,
    skillWatcherHandle,
    skillRegistry,
    toolCapabilityPort,
    executionPlanPort: executionPlanHolder, // 78-04 WS-D: SAME ref as PiExecutorDeps + AcpServerDeps (Pitfall 1).
  };
}
