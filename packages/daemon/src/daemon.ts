// SPDX-License-Identifier: Apache-2.0
// @allow-throw: daemon bootstrap composition-root failures (secrets bootstrap, decryption, etc.); hard-fail at startup is the correct contract per AGENTS.md §6.2 (bootstrap() returns Result but daemon.ts is the entry point that catches it and exits).
/**
 * Daemon Entry Point: thin orchestrator calling setupXxx() factories in sequence.
 *
 * Helpers live in `./stages/` (5 modules + 1 barrel); Handle interfaces and
 * SessionStoreBridge live in `./daemon-types.ts`. This file is the
 * composition root: 5 stage* orchestrators + main() + 4 small helpers
 * (DEFAULT_CONFIG_PATHS / applyInspectDefaultsForLogging /
 * hardenDataDirPermissions / runPreflightDoctor).
 *
 * @module
 */

import {
  bootstrap,
  loadEnvFile,
  createApprovalGate,
  parseFormattedSessionKey,
  envSubset,
  createInjectionRateLimiter,
  checkApprovalsConfig,
  safePath,
  resolveConfigSecretRefs,
  BackgroundTasksConfigSchema,
} from "@comis/core";
import type { PerAgentConfig } from "@comis/core";
// Runtime adapter factories — constructed at the composition root and
// threaded through wiring helpers that retarget Date.now / process.env /
// setTimeout / setInterval. Sanctioned construction site.
import { createSystemClock, createSystemEnv, createSystemTimers } from "@comis/infra";
import { setupSecrets as _setupSecretsImpl, createNamedGraphStore, createContextStore, createObservabilityStore } from "@comis/memory";
import { createGatewayServer } from "@comis/gateway";
import {
  setupLogging,
  setupObservability,
  setupHealth,
  setupMemory,
  setupAgents,
  setupSchedulers,
  setupChannels,
  setupMedia,
  setupCrossSession,
  setupTools,
  setupMonitoring,
  setupHeartbeat,
  setupTaskExtraction,
  setupShutdown,
  setupGateway,
  setupRpcBridge,
  setupDeliveryQueue,
  setupDeliveryMirror,
  setupNotifications,
  setupBackgroundTasks,
  setupBackgroundCompletionRunner,
} from "./wiring/index.js";
import {
  createActiveRunRegistry,
  createBackgroundSessionResolver,
  createGeminiCacheManager,
  validateProviderOverrides,
} from "@comis/agent";
// createModelCatalog + resolveWorkspaceDir live in @comis/core.
import { createModelCatalog, resolveWorkspaceDir } from "@comis/core";
import type { GeminiCacheManager } from "@comis/agent";
import { detectSandboxProvider } from "@comis/skills";
import { createGraphCoordinator, createNodeTypeRegistry } from "./graph/index.js";
import { createWakeCoalescer, createSystemEventQueue, type WakeReasonKind } from "@comis/scheduler";
import { createTokenRegistry } from "./api/token-handlers.js";
import type { DaemonInstance, DaemonOverrides, FoundationHandle, AgentsHandle, ChannelsHandle, GatewayHandle, PermissionCorrection, SessionStoreBridge } from "./daemon-types.js";
export type { DaemonInstance, DaemonOverrides } from "./daemon-types.js";
import { createLatencyRecorder } from "./observability/latency-recorder.js";
import { setupObsPersistence } from "./observability/obs-persistence-wiring.js";
import { createContextPipelineCollector } from "./observability/context-pipeline-collector.js";
import { createLogLevelManager } from "./observability/log-infra.js";
import { createTokenTracker } from "./observability/token-tracker.js";
import { createTracingLogger } from "./observability/trace-logger.js";
import { setupChannelHealthLogging } from "./observability/channel-health-logger.js";
import { registerGracefulShutdown } from "./process/graceful-shutdown.js";
import { createProcessMonitor } from "./process/process-monitor.js";
import { startWatchdog } from "./health/watchdog.js";
import { randomUUID } from "node:crypto";
import { existsSync, chmodSync, statSync, mkdirSync } from "node:fs";
import { createExecGit } from "./config/exec-git.js";
import { saveLastKnownGood, buildRollbackSuggestion, handleRestoreFlag } from "./config/last-known-good.js";
import { createRestartContinuationTracker } from "./wiring/restart-continuation.js";
import { createInboundMessageIdResolver, type InboundMessageIdResolver } from "./wiring/inbound-message-id-resolver.js";
import { logOperationModelDryRun } from "./wiring/startup-dry-run.js";
import os from "node:os";
import { dirname as pathDirname } from "node:path";
import { inspect } from "node:util";

// Stage-helper imports.
import {
  seedBundledSkillCreator,
  bootstrapSecretsAndEnv,
  wireConfigGitManager,
  emitBootstrapConfigObserveRecords,
} from "./stages/foundation-helpers.js";
import {
  resolveConfigAuditLogPath,
  getDefaultConfigAuditConfinedBase,
} from "@comis/observability";
import {
  restoreApprovalState,
  setupMcpManager,
  wirePostAgentsCleanup,
  buildAuditBundle,
  buildDeferredCronWakeCallback,
} from "./stages/agents-helpers.js";
import {
  buildChannelManagerDeps,
  buildGraphCoordinatorDeps,
  setupChannelHealthMonitor,
  createCapabilityPortResolver,
  wirePostChannelsLifecycle,
  buildImageGenBundle,
} from "./stages/channels-helpers.js";
import {
  resolveGatewayTokens,
  createHotAdd,
  createHotRemove,
  buildRpcDispatchDeps,
  replayContinuationsIfAny,
} from "./stages/gateway-helpers.js";
import {
  wireHealthLogging,
  emitStartupBanner,
} from "./stages/shutdown-helpers.js";

export const DEFAULT_CONFIG_PATHS = [
  safePath(safePath(os.homedir(), ".comis"), "config.yaml"),
  safePath(safePath(os.homedir(), ".comis"), "config.local.yaml"),
];

/**
 * When ANTHROPIC_LOG=debug|info is set, the Anthropic SDK calls
 * `console.debug('[req] sending request', { ...payload })`, which Node
 * formats with util.inspect using the default `depth: 2`. That collapses
 * the request body to `messages: [Array]`, so we lose the actual body
 * we are trying to capture.
 *
 * This helper deepens util.inspect ONLY when the SDK debug logger is
 * actually enabled. When ANTHROPIC_LOG is unset, the SDK emits no debug
 * lines anyway, so we leave inspect defaults alone — keeping production
 * logs unchanged.
 *
 * `breakLength: Infinity` keeps each log line single-line so grep-based
 * inspection of the daemon log keeps working.
 *
 * Returns whether each default was changed (used by tests; ignored at
 * runtime).
 */
export function applyInspectDefaultsForLogging(
  env: Record<string, string | undefined>,
): { depthChanged: boolean; breakLengthChanged: boolean } {
  const lvl = env["ANTHROPIC_LOG"];
  if (lvl !== "debug" && lvl !== "info") {
    return { depthChanged: false, breakLengthChanged: false };
  }
  const depthChanged = inspect.defaultOptions.depth !== null;
  const breakLengthChanged = inspect.defaultOptions.breakLength !== Infinity;
  inspect.defaultOptions.depth = null;
  inspect.defaultOptions.breakLength = Infinity;
  return { depthChanged, breakLengthChanged };
}

// ---------------------------------------------------------------------------
// Startup permission hardening
// ---------------------------------------------------------------------------

/**
 * Scan ~/.comis/ and fix permissions on the data directory and known
 * sensitive files. Returns an array of corrections for deferred logging.
 */
export function hardenDataDirPermissions(dataDir: string): PermissionCorrection[] {
  const corrections: PermissionCorrection[] = [];

  // Ensure data dir exists with 0o700
  try {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  } catch { /* may already exist */ }

  // Fix data directory permissions
  try {
    const stat = statSync(dataDir);
    const currentMode = stat.mode & 0o777;
    if (currentMode !== 0o700) {
      chmodSync(dataDir, 0o700);
      corrections.push({ file: dataDir, oldMode: currentMode, newMode: 0o700 });
    }
  } catch { /* best-effort */ }

  // Fix known sensitive files
  const sensitiveFiles = ["config.yaml", "config.local.yaml", ".env", "secrets.db"];
  for (const filename of sensitiveFiles) {
    try {
      const filePath = `${dataDir}/${filename}`;
      const stat = statSync(filePath);
      const currentMode = stat.mode & 0o777;
      if (currentMode !== 0o600) {
        chmodSync(filePath, 0o600);
        corrections.push({ file: filePath, oldMode: currentMode, newMode: 0o600 });
      }
    } catch { /* file may not exist; best-effort */ }
  }

  return corrections;
}

// ---------------------------------------------------------------------------
// Preflight native-dep doctor
// ---------------------------------------------------------------------------

interface PreflightProbeDatabase {
  prepare(sql: string): { get(): unknown };
  close(): void;
}
type PreflightDatabaseCtor = new (path: string) => PreflightProbeDatabase;

/**
 * Probe better-sqlite3 before any subsystem init. A missing transitive
 * `bindings` folder (known failure mode from partial npm upgrades) makes
 * better-sqlite3 throw at first require, which otherwise surfaces as an
 * opaque mid-boot crash and a systemd restart loop. Here we catch it up
 * front and exit 78 (EX_CONFIG) with an actionable hint, so operators can
 * repair instead of chasing a cascading failure.
 */
export async function runPreflightDoctor(
  exitFn: (code: number) => void,
  opts: {
    stderrWrite?: (s: string) => void;
    loadBetterSqlite3?: () => Promise<PreflightDatabaseCtor>;
  } = {},
): Promise<void> {
  const write = opts.stderrWrite ?? ((s: string) => { process.stderr.write(s); });
  const load = opts.loadBetterSqlite3
    ?? (async () => (await import("better-sqlite3")).default as unknown as PreflightDatabaseCtor);
  try {
    const Database = await load();
    const db = new Database(":memory:");
    try {
      const row = db.prepare("select 1 as ok").get();
      if (!row) throw new Error("better-sqlite3 returned no row from sentinel query");
    } finally {
      db.close();
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    write(JSON.stringify({
      level: 60,
      time: new Date().toISOString(),
      name: "comis-daemon",
      submodule: "preflight",
      errorKind: "dependency",
      err: message,
      hint: "Native module 'better-sqlite3' failed to load. Try: npm rebuild better-sqlite3 (or re-run install.sh). If this persists, reinstall comisai from a fresh tarball.",
      msg: "Preflight check failed: better-sqlite3 unavailable",
    }) + "\n");
    exitFn(78);
  }
}

// ---------------------------------------------------------------------------
// Stage 1: foundation
// ---------------------------------------------------------------------------

/**
 * stageFoundation — daemon-process foundation startup. Owns:
 *   - data directory + .env load + permission hardening
 *   - secret decryption + env merge + process.env scrub
 *   - bootstrap (core container) + config-secret-ref resolution
 *   - config git versioning
 *   - logging + observability + context-pipeline collector
 *   - health (process monitor + watchdog + device identity)
 *   - memory + embedding + observability-persistence
 *   - context store + active-run registry + session resolver
 *   - canary fallback + injection rate limiter
 *   - delivery mirror + Gemini cache manager
 *   - background task system + deferred channel/notification refs
 *   - bundled skill-creator seeding (idempotent)
 *
 * Hard cap: ≤200 lines AST-measured. Per-line-source order preserved so
 * daemon-lifecycle.test.ts log-sequence assertions remain green.
 */
async function stageFoundation(input: {
  overrides: DaemonOverrides;
  startupStartMs: number;
  instanceId: string;
}): Promise<FoundationHandle> {
  const { overrides, startupStartMs, instanceId } = input;
  const _bootstrap = overrides.bootstrap ?? bootstrap;
  const _setupSecrets = overrides.setupSecrets ?? _setupSecretsImpl;
  const _createTracingLogger = overrides.createTracingLogger ?? createTracingLogger;
  const _createLogLevelManager = overrides.createLogLevelManager ?? createLogLevelManager;
  const _createTokenTracker = overrides.createTokenTracker ?? createTokenTracker;
  const _createLatencyRecorder = overrides.createLatencyRecorder ?? createLatencyRecorder;
  const _createProcessMonitor = overrides.createProcessMonitor ?? createProcessMonitor;
  const _startWatchdog = overrides.startWatchdog ?? startWatchdog;

  // 0. Resolve data directory, then load secrets from <dataDir>/.env.
  // eslint-disable-next-line no-restricted-syntax -- process.env access needed before SecretManager is initialized
  const dataDir = process.env["COMIS_DATA_DIR"] ?? safePath(os.homedir(), ".comis");
  const envPath = safePath(dataDir, ".env");
  loadEnvFile(envPath);

  // 0.5. Decrypt secrets, merge with env, scrub process.env.
  const permissionCorrections = hardenDataDirPermissions(dataDir);
  const { mergedEnv, secretStore, secretsCrypto, secretsDb } = bootstrapSecretsAndEnv({
    setupSecrets: _setupSecrets,
    dataDir,
  });

  // 0.6. Runtime adapter construction (composition root). overrides.timers is opt-in for test fake-timers; never set in production.
  const clock = createSystemClock(); const env = createSystemEnv(mergedEnv); const timers = overrides.timers ?? createSystemTimers();

  // 1. Bootstrap core container
  // eslint-disable-next-line no-restricted-syntax -- process.env access needed before SecretManager for config path resolution
  const rawConfigPaths = process.env["COMIS_CONFIG_PATHS"];
  const configPaths = (rawConfigPaths ? rawConfigPaths.split(":") : DEFAULT_CONFIG_PATHS)
    .filter((p) => existsSync(p));
  const bootResult = _bootstrap({ configPaths, env: mergedEnv });
  if (!bootResult.ok) {
    throw new Error(`Bootstrap failed: ${bootResult.error.message}`);
  }

  // OBS-REVIEW-03: emit one `config.observe` audit record per resolved
  // configPath. Best-effort — Promise.allSettled() in the helper
  // absorbs per-path append failures so the JSONL log can't block
  // daemon startup. Audit-log is a forensics aid, not a correctness
  // gate (matches the write-side last-known-good + config.patch
  // hook pattern).
  const auditLogPath = resolveConfigAuditLogPath();
  const auditConfinedBase = getDefaultConfigAuditConfinedBase(auditLogPath);
  await emitBootstrapConfigObserveRecords({
    configPaths,
    auditLogPath,
    ...(auditConfinedBase !== undefined
      ? { confinedBaseDir: auditConfinedBase }
      : {}),
  });

  // Container via const+resolve-then-spread.
  const initialContainer = bootResult.value;
  const refResult = resolveConfigSecretRefs(
    initialContainer.config as unknown as Record<string, unknown>,
    { secretManager: initialContainer.secretManager },
  );
  if (!refResult.ok) {
    throw new Error(`SecretRef resolution failed: ${refResult.error.message}`);
  }
  const container = { ...initialContainer, config: refResult.value as unknown as typeof initialContainer.config };

  // 1.5. Config git versioning
  const execGit = createExecGit();
  const configDir = configPaths.length > 0 ? pathDirname(configPaths[0]!) : "";
  const configGitManager = wireConfigGitManager({ configDir, execGit });

  // 2-3. Logging
  const {
    logger, logLevelManager, daemonLogger, gatewayLogger, channelsLogger, agentLogger,
    schedulerLogger, skillsLogger, memoryLogger, daemonVersion,
  } = setupLogging({ container, instanceId, _createTracingLogger, _createLogLevelManager });

  // Log permission corrections (deferred until logger is available)
  if (permissionCorrections.length > 0) {
    for (const c of permissionCorrections) {
      daemonLogger.info(
        { file: c.file, oldMode: `0o${c.oldMode.toString(8)}`, newMode: `0o${c.newMode.toString(8)}`, hint: "Restrictive permissions applied", errorKind: "config" as const },
        `Fixed permissions on ${c.file}: 0o${c.oldMode.toString(8)} -> 0o${c.newMode.toString(8)}`,
      );
    }
  }

  // 3.5. Startup config warnings
  const approvalsWarning = checkApprovalsConfig(container.config.approvals ?? { enabled: false, defaultMode: "auto" as const, rules: [], defaultTimeoutMs: 30_000, waitTimeoutMs: 60_000 });
  if (approvalsWarning) {
    daemonLogger.warn({ hint: "Set approvals.enabled: true or remove unused rules", errorKind: "config" as const }, approvalsWarning);
  }

  // 3.6. Validate PROVIDER_OVERRIDES vs live pi-ai catalog (fire-and-forget).
  validateProviderOverrides(agentLogger);

  // 4. Observability
  const {
    tokenTracker, latencyRecorder, sharedCostTracker,
    diagnosticCollector, billingEstimator, channelActivityTracker, deliveryTracer,
  } = setupObservability({ eventBus: container.eventBus, _createTokenTracker, _createLatencyRecorder, logger: logLevelManager.getLogger("observability"), dataDir });
  const contextPipelineCollector = createContextPipelineCollector({
    eventBus: container.eventBus,
    logger: logLevelManager.getLogger("context-pipeline"),
  });

  // 5-6. Health / process
  const { processMonitor, watchdogHandle, deviceIdentity } = setupHealth({
    container, logger, daemonLogger, _createProcessMonitor, _startWatchdog,
  });

  // 6.5. Memory + embedding
  const {
    disposeEmbedding, cachedPort, memoryAdapter, db,
    sessionStore, memoryApi, embeddingQueue, backgroundIndexingPromise,
    embeddingCacheStats, embeddingCircuitBreakerState, maintenanceTick,
  } = await setupMemory({ container, memoryLogger, clock });

  // Observability persistence (dual-write to SQLite). obsStore +
  // obsPersistence via const+IIFE.
  const obsConfig = container.config.observability;
  const obsBundle = obsConfig.persistence.enabled
    ? (() => {
        const store = createObservabilityStore(db);
        const pruneResult = store.prune(obsConfig.persistence.retentionDays);
        daemonLogger.info({
          retentionDays: obsConfig.persistence.retentionDays,
          pruned: pruneResult,
        }, "Observability data pruned on startup");
        const persistence = setupObsPersistence({
          eventBus: container.eventBus,
          obsStore: store,
          db,
          channelActivityTracker,
          startupTimestamp: startupStartMs,
          snapshotIntervalMs: obsConfig.persistence.snapshotIntervalMs,
          logger: daemonLogger,
        });
        return { obsStore: store, obsPersistence: persistence };
      })()
    : undefined;
  const obsStore = obsBundle?.obsStore; // trajectory recorder is per-session (pi-executor.ts).
  const obsPersistence = obsBundle?.obsPersistence;

  // Create context store + daemon-level runtime registries
  const contextStore = createContextStore(db);
  const activeRunRegistry = createActiveRunRegistry();
  const sessionResolver = createBackgroundSessionResolver({ activeRunRegistry });
  const canaryFallbackSecret = (await import("node:crypto")).createHmac("sha256", container.config.tenantId)
    .update("comis:canary-fallback")
    .digest("hex");
  const injectionRateLimiter = createInjectionRateLimiter({ clock, timers });

  // Session mirroring (must precede setupAgents — agents receive a live deliveryMirror port)
  const { deliveryMirror, startPrune: startMirrorPrune, shutdown: shutdownMirror } = await setupDeliveryMirror({
    db, config: container.config, pluginRegistry: container.pluginRegistry, logger: daemonLogger,
  });

  // Gemini CachedContent lifecycle manager (per-agent enable gate lives in the injector)
  const geminiCacheManager: GeminiCacheManager = createGeminiCacheManager({
    getApiKey: () => container.secretManager.get("google-api-key") ?? container.secretManager.get("GOOGLE_API_KEY"),
    ttlSeconds: 3600,
    maxActiveCachesPerAgent: 20,
    refreshThreshold: 0.5,
    logger: daemonLogger,
    clock,
  });

  // Deferred channel plugins ref (populated after setupChannels)
  const channelPluginsRef: { ref?: Map<string, import("@comis/core").ChannelPluginPort> } = {};

  // 6.5.1. Background task system (created before setupAgents)
  const { backgroundTaskManager } = setupBackgroundTasks({
    dataDir,
    eventBus: container.eventBus,
    logger: logLevelManager.getLogger("background-tasks"),
    clock,
    timers,
  });

  // Deferred notification ref + bgNotifyFn closure
  const bgNotifyRef: { ref?: import("./notification/notification-service.js").NotificationService } = {};
  const bgNotifyFn = async (opts: { agentId: string; message: string; priority: "normal"; origin: "background_task" }) => {
    await bgNotifyRef.ref?.notifyUser({
      agentId: opts.agentId,
      message: opts.message,
      priority: opts.priority,
      origin: opts.origin,
    });
  };

  // 6.5.9. Seed bundled skill-creator into user data dir (version-aware)
  seedBundledSkillCreator({ dataDir, agentLogger });

  return {
    container, dataDir, configPaths, envPath,
    clock, env, timers,
    secretStore, secretsCrypto, secretsDb, permissionCorrections,
    execGit, configGitManager,
    logger, logLevelManager, daemonLogger, gatewayLogger, channelsLogger, agentLogger,
    schedulerLogger, skillsLogger, memoryLogger, daemonVersion,
    tokenTracker, latencyRecorder, sharedCostTracker,
    diagnosticCollector, billingEstimator, channelActivityTracker, deliveryTracer,
    contextPipelineCollector,
    processMonitor, watchdogHandle, deviceIdentity,
    disposeEmbedding, cachedPort, memoryAdapter, db, sessionStore, memoryApi,
    embeddingQueue, backgroundIndexingPromise, embeddingCacheStats,
    embeddingCircuitBreakerState, maintenanceTick,
    obsStore, obsPersistence, contextStore,
    activeRunRegistry, sessionResolver, canaryFallbackSecret, injectionRateLimiter,
    deliveryMirror, startMirrorPrune, shutdownMirror,
    geminiCacheManager,
    channelPluginsRef, backgroundTaskManager, bgNotifyRef, bgNotifyFn,
  };
}

// ---------------------------------------------------------------------------
// Stage 2: agents
// ---------------------------------------------------------------------------

/**
 * stageAgents — agent-runtime startup. Owns:
 *   - agents config map + default agent/workspace resolution
 *   - mcpClientManager (constructed BEFORE setupAgents per ordering constraint)
 *   - setupAgents (executors, costTrackers, skillRegistries, OAuth store, etc.)
 *   - subprocessEnv + execToolEnv (filtered envs for trusted/untrusted children)
 *   - systemEventQueue (cron-heartbeat routing) + setupSchedulers
 *   - sessionTrackerRegistry + Gemini-cache cleanup + MCP disconnect cleanup
 *   - setupTaskExtraction + auditAggregator + onSuspiciousContent
 *   - setupMedia + setupRpcBridge
 *   - approvalGate + restoreApprovalState (extracted helper)
 *   - setupDeliveryQueue (+ channelAdaptersRef placeholder)
 *
 * Hard cap: ≤200 lines AST-measured. Per-line-source order preserved so
 * daemon-lifecycle.test.ts log-sequence assertions remain green ("Agent
 * executor initialized", "Per-agent CronScheduler started").
 *
 * mcpClientManager construction order is a production-correctness
 * constraint: it must be constructed BEFORE setupAgents — do not invert.
 */
async function stageAgents(input: {
  overrides: DaemonOverrides;
  foundation: FoundationHandle;
}): Promise<AgentsHandle> {
  const { overrides, foundation } = input;
  const {
    container, dataDir,
    clock, env, timers,
    daemonLogger, gatewayLogger, agentLogger, schedulerLogger, skillsLogger,
    memoryAdapter, db, sessionStore, cachedPort, embeddingQueue,
    contextStore,
    activeRunRegistry, canaryFallbackSecret, injectionRateLimiter,
    deliveryMirror, geminiCacheManager,
    channelPluginsRef, backgroundTaskManager,
    secretsCrypto, secretsDb, obsStore, // thread into setupAgents
  } = foundation;
  const _setupMedia = overrides.setupMedia ?? setupMedia;

  // 6.6. Agents
  const agentsConfig = container.config.agents;

  // defaultWorkspaceDir hoisted upfront so setupMcp can run BEFORE
  // setupAgents (it consumes defaultWorkspaceDir as defaultCwd; per-agent
  // ToolCapabilityPort adapters constructed inside setupSingleAgent close
  // over the daemon-global mcpClientManager). Mirrors the per-agent
  // computation in setup-agents.ts (`resolveWorkspaceDir(effectiveConfig,
  // agentId)` for the agent's own workspace).
  const defaultAgentId = container.config.routing.defaultAgentId;
  const defaultAgentConfig =
    agentsConfig[defaultAgentId] ??
    agentsConfig.default ??
    ({} as PerAgentConfig);
  const defaultWorkspaceDir = resolveWorkspaceDir(defaultAgentConfig, defaultAgentId);

  // Construct daemon-global MCP manager BEFORE setupAgents (ordering constraint
  // -- per-agent ToolCapabilityPort adapters close over mcpClientManager).
  const mcpClientManager = await setupMcpManager({ container, skillsLogger, defaultWorkspaceDir });

  const {
    sessionManager, executors, workspaceDirs, costTrackers, budgetGuards, stepCounters,
    getExecutor, piSessionAdapters,
    skillWatcherHandles, skillRegistries, lockCleanupTimer, singleAgentDeps, providerHealth,
    // Daemon-level OAuth credential store, threaded into ApiDispatchDeps
    // below so agents.update can validate oauthProfiles patches via has().
    oauthCredentialStore,
    // Per-agent live ToolCapabilityPort adapters; daemon.ts threads
    // getCapabilityPortForAgent into setupTools and mutates this map on
    // hot-add / hot-remove. trajectoryRegistry is drained by setupShutdown.
    toolCapabilityPorts, trajectoryRegistry,
  } = await setupAgents({
    container, memoryAdapter, sessionStore, agentLogger, outboundMediaEnabled: true,
    autonomousMediaEnabled: !container.config.integrations.media.transcription.autoTranscribe
      || !container.config.integrations.media.vision.enabled
      || !container.config.integrations.media.documentExtraction.enabled,
    activeRunRegistry,  // steer+followup session tracking
    canaryFallbackSecret,  // Deterministic canary fallback
    injectionRateLimiter,  // Per-user injection rate limiting
    embeddingQueue,  // Conversation memory persistence in executor
    // DAG context engine deps
    contextStore,
    db,
    embeddingPort: cachedPort,  // Semantic search in discover_tools
    // Session mirroring -- mirror port + injection budget config
    deliveryMirror,
    deliveryMirrorConfig: container.config.deliveryMirror
      ? { maxEntriesPerInjection: container.config.deliveryMirror.maxEntriesPerInjection, maxCharsPerInjection: container.config.deliveryMirror.maxCharsPerInjection }
      : undefined,
    geminiCacheManager, obsStore,  // SystemPromptReport persistence
    // Resolve platform char limit via deferred channelPlugins ref
    getChannelMaxChars: (channelType: string) => {
      const plugin = channelPluginsRef.ref?.get(channelType);
      return plugin?.capabilities?.limits?.maxMessageChars;
    },
    backgroundTaskManager,  // Auto-background middleware in executor pipeline
    // Plumb the secrets bootstrap result through so setup-agents can wire the
    // OAuth credential store. encrypted-mode shares the existing
    // better-sqlite3 connection (no dual-handle).
    secretsCrypto,
    secretsDb,
    // Daemon-global MCP manager threaded into setupSingleAgent for
    // per-agent ToolCapabilityPort adapter construction.
    mcpClientManager,
    clock, env, timers,
  });

  // Log operation model resolutions at startup (dry-run validation)
  logOperationModelDryRun({
    agents: container.config.agents,
    secretManager: container.secretManager,
    logger: daemonLogger,
  });

  // Restart continuation tracker: track recently-active sessions for SIGUSR2 replay
  const continuationTracker = createRestartContinuationTracker();

  // Filtered subprocess environment (used by setupSchedulers and MCP spawns).
  // See original main() comment block for the trusted-vs-untrusted env split.
  const SUBPROCESS_SYSTEM = ["PATH", "HOME", "LANG", "TERM", "NODE_ENV", "TZ"] as const;
  const subprocessEnv = envSubset(container.secretManager, [...SUBPROCESS_SYSTEM, ...container.secretManager.keys()]);
  // Credential-free env for the exec tool (agent-issued shell commands).
  const execToolEnv = envSubset(container.secretManager, [...SUBPROCESS_SYSTEM]);

  // Deferred wake callback ref -- populated by stageChannels once
  // wakeCoalescer is constructed. Same shape as channelPluginsRef /
  // bgNotifyRef (cross-stage deferred-ref pattern).
  const cronWakeCallbackRef: { ref?: (reason: string) => void } = {};

  // 6.6.4.9. System event queue (created early for cron-heartbeat routing)
  const systemEventQueue = createSystemEventQueue({ logger: schedulerLogger });

  // 6.6.5. Schedulers
  const {
    cronSchedulers, executionTrackers, browserServices, resetSchedulers,
    getAgentCronScheduler, getAgentBrowserService,
  } = await setupSchedulers({
    container, workspaceDirs, sessionStore, sessionManager,
    schedulerLogger, agentLogger, skillsLogger,
    subprocessEnv,
    systemEventQueue,  // cron-heartbeat routing
    onCronWake: buildDeferredCronWakeCallback(cronWakeCallbackRef, daemonLogger),
    clock, timers,
  });

  // Post-setupAgents cleanup wiring: session expiry, Gemini cache disposal,
  // orphan cleanup, MCP disconnect cleanup. Returns the sessionTrackerRegistry
  // bound to the session:expired listener (helper keeps stageAgents ≤200L).
  const sessionTrackerRegistry = wirePostAgentsCleanup({
    eventBus: container.eventBus,
    geminiCacheManager,
    daemonLogger,
  });

  // 6.6.5.5. Task extraction (conversation -> extracted tasks pipeline)
  const { extractFromConversation } = setupTaskExtraction({
    container, workspaceDirs, schedulerLogger,
  });

  // Audit aggregator for deduplicating security events (extracted helper).
  const { auditAggregator, onSuspiciousContent } = buildAuditBundle({
    eventBus: container.eventBus,
    skillsLogger,
    clock,
    timers,
  });

  // 6.6.7. Media (moved up from 6.6.8 -- media infrastructure must be ready before channels)
  const {
    ttsAdapter, visionRegistry, linkRunner,
    mediaTempManager, mediaSemaphore, audioConverter,
    transcriber, ssrfFetcher, fileExtractor,
  } = await _setupMedia({ container, skillsLogger, onSuspiciousContent });

  // 6.6.7.5. RPC bridge (deferred dispatch) -- moved before setupChannels so rpcCall
  // can be threaded into channel config command handling.
  const { rpcCall, wireDispatch } = setupRpcBridge({ gatewayLogger });

  // 6.6.8.6. Approval gate (moved before channels for chat command interception)
  const approvalGate = createApprovalGate({
    eventBus: container.eventBus,
    getTimeoutMs: () => container.config.approvals?.defaultTimeoutMs ?? 30_000,
    getDenialCacheTtlMs: () => container.config.approvals?.denialCacheTtlMs ?? 60_000,
    getBatchApprovalTtlMs: () => container.config.approvals?.batchApprovalTtlMs ?? 30_000,
    clock,                // wall-clock reads
    timers,               // setTimeout scheduling
    logger: daemonLogger, // Approval cache hit/miss debug logging
  });

  // 6.6.8.6.1 + 6.6.8.6.2. Restore pending approvals + approval cache from previous session
  restoreApprovalState({
    approvalGate,
    dataDir,
    containerDataDir: container.config.dataDir,
    daemonLogger,
  });

  // 6.6.7.8. Delivery queue: create adapter BEFORE setupChannels.
  // channelAdapters map is passed by reference -- populated after setupChannels.
  // drainAndStart() is called AFTER setupChannels (two-phase lifecycle).
  const channelAdaptersRef = new Map<string, import("@comis/core").DeliveryAdapter>();
  const { deliveryQueue, drainAndStart: drainAndStartDeliveryPrune, shutdown: shutdownDeliveryQueue } = await setupDeliveryQueue({
    db, config: container.config, eventBus: container.eventBus, logger: daemonLogger, channelAdapters: channelAdaptersRef,
  });

  return {
    ...foundation,
    defaultAgentId, defaultWorkspaceDir, agentsConfig,
    sessionManager, executors, workspaceDirs, costTrackers, budgetGuards, stepCounters,
    getExecutor, piSessionAdapters, skillWatcherHandles, skillRegistries, lockCleanupTimer,
    singleAgentDeps, providerHealth, oauthCredentialStore, toolCapabilityPorts, mcpClientManager,
    continuationTracker, subprocessEnv, execToolEnv,
    systemEventQueue, cronSchedulers, executionTrackers, browserServices, resetSchedulers,
    getAgentCronScheduler, getAgentBrowserService,
    sessionTrackerRegistry, extractFromConversation, auditAggregator, onSuspiciousContent,
    ttsAdapter, visionRegistry, linkRunner, mediaTempManager, mediaSemaphore, audioConverter,
    transcriber, ssrfFetcher, fileExtractor,
    rpcCall, wireDispatch, approvalGate,
    channelAdaptersRef, deliveryQueue, drainAndStartDeliveryPrune, shutdownDeliveryQueue,
    cronWakeCallbackRef, trajectoryRegistry,
  };
}

// ---------------------------------------------------------------------------
// Stage 3: channels
// ---------------------------------------------------------------------------

/**
 * stageChannels — channel-runtime startup. Owns:
 *   - channel adapters + composite media resolution + delivery service
 *   - inbound message id resolver
 *   - notification system + background completion runner
 *   - channel health monitor
 *   - sandbox + image generation providers
 *   - per-agent ToolCapabilityPort resolver (factory helper)
 *   - tools assembly + message preprocessing
 *   - cross-session sender + sub-agent runner
 *   - node type registry + graph coordinator + named graph store
 *   - monitoring (heartbeat runner) + per-agent heartbeat + wake coalescer
 *   - cronWakeCallbackRef populated (cross-stage handoff)
 *   - agent management runtime state (suspended set, model catalog, channel cfg)
 *
 * Hard cap: ≤200 lines AST-measured. Per-line-source order preserved so
 * daemon-lifecycle.test.ts log-sequence assertions remain green.
 */
async function stageChannels(input: {
  agents: AgentsHandle;
}): Promise<ChannelsHandle> {
  const { agents: handle } = input;
  // Names consumed by stageChannels body itself; helper functions
  // re-destructure from `handle` directly so closure deps are explicit.
  const {
    container, sessionStore, db, daemonLogger, agentLogger, schedulerLogger,
    skillsLogger, logger, memoryAdapter, memoryApi,
    activeRunRegistry, sessionResolver, channelPluginsRef, backgroundTaskManager,
    bgNotifyRef, bgNotifyFn,
    defaultAgentId, defaultWorkspaceDir, executors, workspaceDirs,
    agentsConfig: agents, toolCapabilityPorts, mcpClientManager,
    linkRunner, systemEventQueue, rpcCall, approvalGate,
    deliveryQueue, cronWakeCallbackRef, singleAgentDeps,
  } = handle;
  const sessionTrackerRef: { ref?: import("./notification/session-tracker.js").SessionTracker } = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- matches assembleToolsForAgent signature from setup-tools.ts
  const toolAssemblerRef: { ref?: (agentId: string, options?: import("./wiring/setup-tools.js").AssembleToolsOptions) => Promise<any[]> } = {};
  // `{ ref?: T }` indirection captured by onMessageReceived lambda;
  // populated below once channelCapabilities is available.
  const inboundMessageIdResolverRef: { ref?: InboundMessageIdResolver } = {};

  // 6.6.8. Channels (lifted from main()'s setupChannels; deps via helper)
  const { adaptersByType, channelManager, resolveAttachment, lifecycleReactors, channelPlugins, channelCapabilities, commandQueue, deliveryService } = await setupChannels(
    buildChannelManagerDeps({ agents: handle, toolAssemblerRef, inboundMessageIdResolverRef, sessionTrackerRef }),
  );
  channelPluginsRef.ref = channelPlugins;
  const inboundMessageIdResolver = (() => {
    const metaKeyByChannel = new Map<string, string>();
    for (const [type, cap] of channelCapabilities) metaKeyByChannel.set(type, cap.replyToMetaKey);
    return createInboundMessageIdResolver({ metaKeyByChannel });
  })();
  inboundMessageIdResolverRef.ref = inboundMessageIdResolver;
  await wirePostChannelsLifecycle({
    adaptersByType,
    channelAdaptersRef: handle.channelAdaptersRef,
    drainAndStartDeliveryPrune: handle.drainAndStartDeliveryPrune,
    shutdownDeliveryQueue: handle.shutdownDeliveryQueue,
    startMirrorPrune: handle.startMirrorPrune,
    shutdownMirror: handle.shutdownMirror,
    daemonLogger, container, defaultWorkspaceDir,
    outputRetentionConfig: container.config.outputRetention,
  });

  // 6.6.8.0.1. Notifications + bg completion runner
  const notificationContext = setupNotifications({
    eventBus: container.eventBus, deliveryQueue, agents,
    quietHoursConfig: container.config.scheduler.quietHours,
    criticalBypass: container.config.scheduler.quietHours.criticalBypass,
    activeAdapterTypes: new Set(adaptersByType.keys()),
    logger: daemonLogger, tenantId: container.config.tenantId,
  });
  sessionTrackerRef.ref = notificationContext.sessionTracker;
  bgNotifyRef.ref = notificationContext.notificationService;
  const bgConfigForRunner = BackgroundTasksConfigSchema.parse(agents[defaultAgentId]?.backgroundTasks ?? {});
  const bgCompletionRunnerContext = setupBackgroundCompletionRunner({
    eventBus: container.eventBus, getExecutor: handle.getExecutor, sessionStore,
    taskManager: backgroundTaskManager, fallbackNotifyFn: bgNotifyFn,
    maxBackgroundHops: bgConfigForRunner.maxBackgroundHops, logger: daemonLogger,
  });
  container.eventBus.on("system:shutdown", () => { void bgCompletionRunnerContext.runner.shutdown(); });
  // 6.6.8.0.3. Recover background tasks NOW (after the runner is subscribed)
  backgroundTaskManager.recoverOnStartup();

  // Channel health monitor (start + stop produced by helper).
  const { monitor: channelHealthMonitor, stop: stopChannelHealthMonitor } = setupChannelHealthMonitor({ adaptersByType, daemonLogger, container });
  container.eventBus.on("system:shutdown", () => { stopChannelHealthMonitor?.(); });
  setupChannelHealthLogging({ eventBus: container.eventBus, logger: daemonLogger });

  // 6.6.8.4.1. Sandbox + image generation providers (helper)
  const sandboxProvider = detectSandboxProvider(skillsLogger);
  if (sandboxProvider) skillsLogger.info({ provider: sandboxProvider.name }, "Exec sandbox provider detected");
  const { imageGenProvider, imageGenRateLimiter, imageGenConfig } = buildImageGenBundle({ container, skillsLogger });

  // 6.6.8.5. Tools + message preprocessing
  const getCapabilityPortForAgent = createCapabilityPortResolver(toolCapabilityPorts, defaultAgentId);
  const { assembleToolsForAgent, preprocessMessageText } = setupTools({
    rpcCall, agents, defaultAgentId, workspaceDirs, defaultWorkspaceDir,
    dataDir: container.config.dataDir || ".",
    secretManager: container.secretManager, platformSecretNames: container.platformSecretNames,
    eventBus: container.eventBus, skillsLogger, linkRunner,
    approvalGate: container.config.approvals?.enabled ? approvalGate : undefined,
    subprocessEnv: handle.execToolEnv, onSuspiciousContent: handle.onSuspiciousContent,
    mcpClientManager, sandboxProvider, imageGenProvider, backgroundTaskManager,
    sessionTrackerRegistry: handle.sessionTrackerRegistry, getCapabilityPortForAgent,
  });
  toolAssemblerRef.ref = assembleToolsForAgent;

  // 6.6.9. Cross-session sender + sub-agent runner
  const gatewaySendRef: { ref?: (channelId: string, text: string) => boolean } = {};
  const { crossSessionSender, subAgentRunner, sendToChannel, announceToParent, deadLetterQueue, announcementBatcher } = setupCrossSession({
    sessionStore, container, assembleToolsForAgent, getExecutor: handle.getExecutor, adaptersByType,
    logger: agentLogger, memoryAdapter, gatewaySend: gatewaySendRef,
    activeRunRegistry, sessionResolver, deliveryQueue, deliveryService,
    fileLock: singleAgentDeps.fileLock,
    clock: handle.clock, timers: handle.timers,
  });
  const promptTimeoutTimestamps: number[] = [];
  container.eventBus.on("execution:prompt_timeout", () => { promptTimeoutTimestamps.push(Date.now()); });

  // 6.6.9.0-2. Node type registry + graph coordinator + named graph store
  const nodeTypeRegistry = createNodeTypeRegistry();
  const graphCoordinator = createGraphCoordinator(buildGraphCoordinatorDeps({
    agents: handle,
    channels: { subAgentRunner, sendToChannel, announceToParent, announcementBatcher, commandQueue, assembleToolsForAgent, nodeTypeRegistry },
  }));
  subAgentRunner.setGraphCoordinator(graphCoordinator);
  const namedGraphStore = createNamedGraphStore(db);

  // 6.7. Monitoring + per-agent heartbeat + wake coalescer
  const { heartbeatRunner, duplicateDetector } = setupMonitoring({ container, schedulerLogger, logger, adaptersByType });
  const { perAgentRunner } = setupHeartbeat({
    container, executors, assembleToolsForAgent, workspaceDirs,
    sessionResolver, duplicateDetector, adaptersByType, systemEventQueue, memoryApi, schedulerLogger,
  });
  const wakeCoalescer = createWakeCoalescer({
    runOnce: () => (heartbeatRunner ? heartbeatRunner.runOnce() : Promise.resolve()),
    logger: schedulerLogger,
  });
  // Cross-stage: populate cronWakeCallbackRef now that wakeCoalescer is
  // constructed. The setupSchedulers `onCronWake` lambda (wired in
  // stageAgents) reads `.ref` at call time.
  cronWakeCallbackRef.ref = (reason) => wakeCoalescer.requestHeartbeatNow(reason as WakeReasonKind);

  // 6.7.0.2. Agent management runtime state
  const suspendedAgents = new Set<string>();
  const modelCatalog = createModelCatalog();
  modelCatalog.loadStatic();
  const channelConfig: Record<string, { enabled: boolean }> = Object.fromEntries(
    Object.entries(container.config.channels ?? {}).filter(
      ([k, v]) => k !== "healthCheck" && typeof v === "object" && v !== null && "enabled" in v,
    ).map(([k, v]) => [k, { enabled: !!(v as Record<string, unknown>).enabled }]),
  );

  return {
    ...handle,
    adaptersByType, channelManager, resolveAttachment, lifecycleReactors, channelPlugins,
    channelCapabilities, commandQueue, deliveryService,
    inboundMessageIdResolver, channelHealthMonitor, stopChannelHealthMonitor,
    notificationContext, bgCompletionRunnerContext,
    crossSessionSender, subAgentRunner, sendToChannel, announceToParent,
    deadLetterQueue, announcementBatcher, gatewaySendRef,
    sandboxProvider, imageGenProvider, imageGenRateLimiter, imageGenConfig,
    assembleToolsForAgent, preprocessMessageText, getCapabilityPortForAgent,
    heartbeatRunner, duplicateDetector, perAgentRunner, wakeCoalescer,
    nodeTypeRegistry, graphCoordinator, namedGraphStore,
    suspendedAgents, modelCatalog, channelConfig, promptTimeoutTimestamps,
  };
}

// ---------------------------------------------------------------------------
// Stage 4: gateway
// ---------------------------------------------------------------------------

/**
 * stageGateway -- gateway-runtime startup. Owns:
 *   token registry + session store bridge + shutdown ref + hot-add/hot-remove
 *   closures + RPC dispatch deps assembly + gateway server + deferred gateway
 *   attachment wiring + gatewaySendRef.ref population + restart continuation
 *   replay.
 * Inputs: ChannelsHandle (yields foundation + agents + channels) + overrides.
 *
 * Hard cap ≤200 lines AST-measured. Five helpers extracted to fit
 * (resolveGatewayTokens, createHotAdd, createHotRemove,
 * buildRpcDispatchDeps, replayContinuationsIfAny).
 *
 * Log-sequence: "Gateway server started" emits inside setupGateway here in
 * source order; daemon-lifecycle.test.ts assertions remain unchanged.
 */
async function stageGateway(input: {
  overrides: DaemonOverrides;
  channels: ChannelsHandle;
  startupStartMs: number;
  instanceId: string;
}): Promise<GatewayHandle> {
  const { overrides, channels, startupStartMs, instanceId } = input;
  const {
    container, configPaths, sessionStore,
    daemonLogger, gatewayLogger,
    cachedPort, memoryApi, memoryAdapter, embeddingQueue,
    defaultAgentId, defaultWorkspaceDir,
    agentsConfig: agents,
    costTrackers, workspaceDirs, piSessionAdapters,
    getExecutor, rpcCall, wireDispatch,
    assembleToolsForAgent, preprocessMessageText,
    suspendedAgents, gatewaySendRef,
  } = channels;
  const _createGatewayServer = overrides.createGatewayServer ?? createGatewayServer;

  // Token registry for token management handlers
  const gwTokens = (container.config.gateway?.tokens ?? []).map((t: { id?: string; scopes?: readonly string[] }) => ({
    id: t.id ?? "unknown",
    scopes: [...(t.scopes ?? [])],
  }));
  const tokenRegistry = createTokenRegistry(gwTokens);
  const runtimeTokens: Array<{ id: string; secretBuf: Buffer; scopes: string[] }> = [];
  const removedTokenIds = new Set<string>();

  // Resolve gateway token secrets at startup (config -> env -> auto-generate)
  const resolvedGatewayTokens = resolveGatewayTokens({ container, daemonLogger });

  // 6.7.0.5. Session store bridge (shared between RPC dispatch and DaemonInstance return)
  const sessionStoreBridge: SessionStoreBridge = {
    listDetailed: (tenantId?: string) => sessionStore.listDetailed(tenantId),
    loadByFormattedKey: (key: string) => sessionStore.loadByFormattedKey(key),
    deleteByFormattedKey: (key: string) => {
      const parsed = parseFormattedSessionKey(key);
      if (!parsed) return false;
      return sessionStore.delete(parsed);
    },
    saveByFormattedKey: (key: string, messages: unknown[], metadata?: Record<string, unknown>) => {
      const parsed = parseFormattedSessionKey(key);
      if (!parsed) return;
      sessionStore.save(parsed, messages, metadata);
    },
  };

  // Mutable shutdown ref for hot-add guard. Populated by stageShutdown --
  // closures read .value at RPC call time, not definition time.
  const shutdownRef: { value?: { readonly isShuttingDown: boolean } } = {};

  // Hot-add / hot-remove closures (factory pattern; deps captured by closure)
  const hotAdd = createHotAdd({ channels, shutdownRef });
  const hotRemove = createHotRemove({ channels });

  // 6.7.1. Build RPC dispatch deps and wire dispatch
  const rpcDispatchDeps = buildRpcDispatchDeps({
    channels,
    startupStartMs,
    gateway: { tokenRegistry, runtimeTokens, removedTokenIds, sessionStoreBridge, hotAdd, hotRemove },
    defaultConfigPaths: DEFAULT_CONFIG_PATHS,
  });
  wireDispatch(rpcDispatchDeps);

  // 7. Gateway server
  const gwConfig = container.config.gateway;
  const { gatewayHandle, activeExecutions, getActiveConnectionCount, wsConnections } = await setupGateway({
    container, gwConfig, webhooksConfig: container.config.webhooks, agents, defaultAgentId,
    configPaths, defaultConfigPaths: DEFAULT_CONFIG_PATHS, gatewayLogger,
    embeddingQueue, memoryAdapter, memoryApi, cachedPort, sessionStore, getExecutor,
    assembleToolsForAgent, preprocessMessageText, rpcCall,
    costTrackers, workspaceDirs,
    _createGatewayServer, piSessionAdapters,
    resolvedTokens: resolvedGatewayTokens,
    suspendedAgents,
    instanceId, startupStartMs,
  });

  // 7.0.1. Wire deferred gateway attachment deps (wsConnections / mediaDir /
  // onGatewayAttachment) into the mutable rpcDispatchDeps reference; handler
  // closures read them at RPC call time, not at wireDispatch time.
  //
  // INVARIANT: handler factory bodies in
  // `packages/daemon/src/api/*-handlers.ts` MUST read these three fields
  // off `deps` at RPC INVOCATION time (`deps.wsConnections`, `deps.mediaDir`,
  // `deps.onGatewayAttachment`). They MUST NOT destructure them at factory
  // creation time -- the factory runs INSIDE `wireDispatch(rpcDispatchDeps)`
  // above, BEFORE the mutations below. A destructure like
  //   const { wsConnections, mediaDir } = deps;
  // at the top of `createMessageHandlers` would capture `undefined` (the
  // pre-mutation values) and silently break gateway-bound RPC paths. The
  // wireDispatch call must remain BEFORE the mutations so the gateway server
  // (setupGateway, above) can register methods on the dynamic router before
  // its HTTP listener starts; "fix by mutating earlier" is not an option.
  rpcDispatchDeps.wsConnections = wsConnections;
  if (defaultWorkspaceDir) {
    rpcDispatchDeps.mediaDir = safePath(defaultWorkspaceDir, "media");
  }
  // Persist gateway attachment markers to SQLite session store so images
  // survive page navigation (especially for sub-agent async deliveries).
  rpcDispatchDeps.onGatewayAttachment = (channelId: string, marker: string) => {
    try {
      const sk: import("@comis/core").SessionKey = {
        tenantId: container.config.tenantId,
        userId: "default",
        channelId,
      };
      const existing = sessionStore.load(sk);
      const messages: unknown[] = existing?.messages ?? [];
      // Deduplicate: skip if this media URL is already in the session
      const urlMatch = marker.match(/\/media\/[^"]+/);
      if (urlMatch) {
        const existingText = messages.map((m) => String((m as Record<string, unknown>).content ?? "")).join("\n");
        if (existingText.includes(urlMatch[0])) return;
      }
      messages.push({ role: "assistant", content: marker, timestamp: Date.now() });
      sessionStore.save(sk, messages);
    } catch {
      // Non-fatal: attachment persistence failure should not break delivery
    }
  };

  // 7.1. Wire deferred gateway send ref for sub-agent announcement delivery
  // channelId here is a session UUID (from announce_channel_id), not a clientId.
  // Use broadcast to deliver to all connected WebSocket clients since we cannot
  // map session UUIDs to clientIds.
  gatewaySendRef.ref = (_channelId, text) => {
    const sent = wsConnections.broadcast("notification.message", {
      text,
      timestamp: Date.now(),
    });
    if (sent) {
      gatewayLogger.info({ textLength: text.length, activeConnections: getActiveConnectionCount() }, "Sub-agent notification broadcast to WebSocket clients");
    } else {
      gatewayLogger.warn({ textLength: text.length, hint: "No WebSocket clients connected to receive sub-agent notification", errorKind: "internal" as const }, "Sub-agent notification broadcast failed: no connections");
    }
    return sent;
  };

  // 7.5. Restart continuation replay (helper enforces source order:
  // load -> mcp-status -> per-record inject).
  await replayContinuationsIfAny({ channels });

  return {
    ...channels,
    tokenRegistry, runtimeTokens, removedTokenIds, resolvedGatewayTokens,
    sessionStoreBridge, shutdownRef, hotAdd, hotRemove, rpcDispatchDeps,
    gatewayHandle, activeExecutions, getActiveConnectionCount, wsConnections,
  };
}

// ---------------------------------------------------------------------------
// Stage 5: shutdown
// ---------------------------------------------------------------------------

/**
 * stageShutdown -- final stage. Constructs the shutdown handle, populates
 * gateway.shutdownRef.value (cross-stage deferred-ref pattern), wires the
 * health-metrics event-bus subscription, emits the startup banner, snapshots
 * last-known-good config, and returns the DaemonInstance to main()'s callers.
 *
 * Hard cap: ≤200 lines AST-measured.
 */
async function stageShutdown(input: {
  overrides: DaemonOverrides;
  gateway: GatewayHandle;
  startupStartMs: number;
  instanceId: string;
}): Promise<DaemonInstance> {
  const { overrides, gateway, startupStartMs, instanceId } = input;
  const {
    container, dataDir, configPaths,
    logger, logLevelManager, daemonLogger, daemonVersion,
    tokenTracker, latencyRecorder, processMonitor, watchdogHandle, deviceIdentity,
    diagnosticCollector, billingEstimator, channelActivityTracker, deliveryTracer,
    contextPipelineCollector, backgroundIndexingPromise, db,
    disposeEmbedding, cachedPort, maintenanceTick, obsPersistence,
    injectionRateLimiter, geminiCacheManager, backgroundTaskManager,
    secretStore,
    executors: _execs, cronSchedulers, resetSchedulers, browserServices,
    skillWatcherHandles, lockCleanupTimer, continuationTracker,
    mediaTempManager, ttsAdapter, visionRegistry,
    rpcCall, approvalGate, auditAggregator,
    agentsConfig: agents, providerHealth, subAgentRunner,
    channelManager, channelAdaptersRef, deliveryQueue,
    adaptersByType, lifecycleReactors,
    channelHealthMonitor, deadLetterQueue, heartbeatRunner, perAgentRunner,
    wakeCoalescer, graphCoordinator, suspendedAgents: _suspended,
    promptTimeoutTimestamps,
    sessionStoreBridge, shutdownRef, gatewayHandle,
    activeExecutions, getActiveConnectionCount,
    trajectoryRegistry,
  } = gateway;
  void _execs; void _suspended;
  // Override-derived locals -- only consumed by setupShutdown below.
  const exitFn = overrides.exit ?? ((code: number) => process.exit(code));
  const _registerGracefulShutdown = overrides.registerGracefulShutdown ?? registerGracefulShutdown;

  // 8. Graceful shutdown
  const { shutdownHandle } = setupShutdown({
    logger, daemonLogger, processMonitor, container, exitFn, _registerGracefulShutdown,
    tokenTracker, startupTimestamp: startupStartMs,
    activeExecutions, graphCoordinator, subAgentRunner, cronSchedulers, resetSchedulers,
    browserServices, channelManager, heartbeatRunner, perAgentRunner, wakeCoalescer, gatewayHandle,
    mediaTempManager, skillWatcherHandles,
    diagnosticCollector, channelActivityTracker, deliveryTracer, contextPipelineCollector,
    backgroundIndexingPromise, db,
    disposeEmbedding,  // coordinated L1 -> L2 -> provider dispose chain
    approvalGate,
    secretStore,  // close secrets.db on shutdown
    auditAggregator,  // clear pending dedup timers
    injectionRateLimiter,  // clear rate limiter timers on shutdown
    lockCleanupTimer,  // clear periodic lock cleanup timer
    dataDir: container.config.dataDir || dataDir,
    continuationTracker,
    lifecycleReactors,  // destroy lifecycle reactors on shutdown
    obsPersistence,  // drain write buffers before db.close
    geminiCacheManager,  // Dispose all Gemini caches on shutdown
    trajectoryRegistry,  // Drain session-scoped trajectory recorders
  });

  // Wire shutdown ref for hot-add guard. Cross-stage deferred-ref populate:
  // stageGateway declared the empty ref + captured it in hot-add closure;
  // here we point .value at the live shutdown handle so the closure reads
  // .isShuttingDown at call time.
  shutdownRef.value = shutdownHandle;

  // 8.5. Health logging
  wireHealthLogging({
    container, daemonLogger, db, maintenanceTick, subAgentRunner,
    promptTimeoutTimestamps, activeExecutions, getActiveConnectionCount,
    deadLetterQueue, providerHealth, deliveryQueue,
  });

  // 9. Startup banner + docker restart-policy warn + OAuth TLS preflight
  emitStartupBanner({
    container, daemonLogger, daemonVersion, agents, adaptersByType, configPaths,
    db, secretStore, cachedPort, ttsAdapter, visionRegistry,
    startupStartMs, instanceId,
  });

  // Snapshot current config as last-known-good after successful startup.
  // Honor diagnostics.configAudit.enabled.
  // `!== false` semantics preserve the schema's default-true contract;
  // operators who omit the knob or explicitly set true see the audit
  // line; only `enabled: false` skips the JSONL append.
  if (configPaths.length > 0) {
    const activeConfigPath = configPaths[configPaths.length - 1]!;
    const auditEnabled =
      container.config.diagnostics?.configAudit?.enabled !== false;
    const lkg = saveLastKnownGood(activeConfigPath, auditEnabled);
    if (lkg.saved) {
      daemonLogger.debug({ lkgPath: lkg.path }, "Last-known-good config snapshot saved");
    }
  }

  return {
    container, logger, logLevelManager, tokenTracker, latencyRecorder,
    processMonitor, shutdownHandle, watchdogHandle, cronSchedulers, resetSchedulers,
    browserServices, heartbeatRunner, gatewayHandle, adapterRegistry: adaptersByType,
    // Expose the delivery-queue-side adapter map and the queue port itself so
    // integration tests can register adapters that the recurring drainer sees
    // and assert on queue depth.
    deliveryAdapters: channelAdaptersRef,
    deliveryQueue,
    // Expose the background task manager so integration tests can promote
    // synthetic tasks and call complete()/fail() to drive the completion
    // runner pipeline without requiring a live LLM call.
    backgroundTaskManager,
    rpcCall, deviceIdentity, diagnosticCollector, billingEstimator,
    channelActivityTracker, deliveryTracer, approvalGate, channelHealthMonitor, sessionStoreBridge,
  };
}

/** Main daemon entry point. Wires all subsystem modules and returns DaemonInstance. */
export async function main(overrides: DaemonOverrides = {}): Promise<DaemonInstance> {
  const startupStartMs = Date.now();
  const instanceId = randomUUID().slice(0, 8);

  // Anthropic SDK debug log lines route through console.debug -> util.inspect.
  // Deepen inspect defaults BEFORE any code path that may construct an
  // Anthropic client (skills/agent setup, prewarm, etc.) so the very first
  // `[req] sending request` line shows the full body. Gated on ANTHROPIC_LOG
  // so production runs are unaffected.
  // eslint-disable-next-line no-restricted-syntax -- process.env access required before SecretManager is initialized; ANTHROPIC_LOG is the SDK-owned switch, not a comis credential.
  applyInspectDefaultsForLogging(process.env as Record<string, string | undefined>);

  // Preflight: probe native deps before any subsystem init so a missing
  // better-sqlite3 'bindings' module fails fast with a clear repair hint
  // instead of cascading into a systemd restart loop.
  const exitFn = overrides.exit ?? ((code: number) => process.exit(code));
  await (overrides.preflightDoctor ?? ((fn) => runPreflightDoctor(fn)))(exitFn);

  // Stage 1: foundation. Owns data-dir + secrets + bootstrap + logging +
  // observability + memory + obs-persistence + context store + session
  // mirroring + Gemini cache + background tasks + deferred refs.
  const foundation = await stageFoundation({ overrides, startupStartMs, instanceId });

  // Stage 2: agents. Owns agent executors + mcpClientManager + schedulers +
  // media + RPC bridge + approval gate (with restore) + delivery queue.
  const agents = await stageAgents({ overrides, foundation });

  // Stage 3: channels. Owns channel adapters + notifications + bg completion
  // runner + sandbox/image-gen + tools + cross-session + graph + monitoring +
  // heartbeat + wake coalescer + agent runtime state.
  const channels = await stageChannels({ agents });

  // Stage 4: gateway. Owns token registry + session store bridge + shutdown
  // ref slot + hot-add/hot-remove closures + RPC dispatch deps assembly +
  // gateway server + restart continuation replay.
  const gateway = await stageGateway({ overrides, channels, startupStartMs, instanceId });

  // Stage 5: shutdown. Constructs shutdown handle, populates
  // gateway.shutdownRef.value (cross-stage deferred-ref), wires health
  // logging, emits the startup banner ("Comis daemon started"), and returns
  // the DaemonInstance.
  return await stageShutdown({ overrides, gateway, startupStartMs, instanceId });
}

// Only run when invoked directly (not imported).
// Under pm2, process.argv[1] is ProcessContainerFork.js — detect via pm_id env var.
const isDirectRun =
  typeof process !== "undefined" &&
  process.argv[1] &&
  (process.argv[1].endsWith("daemon.js") ||
    process.argv[1].endsWith("daemon.ts") ||
    // eslint-disable-next-line no-restricted-syntax -- Trusted: checking pm2 runtime indicator
    process.env["pm_id"] !== undefined);

if (isDirectRun) {
  // Handle --restore-last-good before startup
  if (process.argv.includes("--restore-last-good")) {
    // eslint-disable-next-line no-restricted-syntax -- process.env access needed for config path resolution
    const rawPaths = process.env["COMIS_CONFIG_PATHS"];
    const paths = (rawPaths ? rawPaths.split(":") : DEFAULT_CONFIG_PATHS).filter((p) => existsSync(p));
    handleRestoreFlag(paths, (code) => process.exit(code));
  } else {
    main().catch((error: unknown) => {
      // Fatal error -- log to stderr and exit
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`FATAL: ${message}\n`);

      // Suggest rollback from last-known-good config
      // eslint-disable-next-line no-restricted-syntax -- process.env access needed for config path resolution
      const rawPaths = process.env["COMIS_CONFIG_PATHS"];
      const paths = (rawPaths ? rawPaths.split(":") : DEFAULT_CONFIG_PATHS).filter((p) => existsSync(p));
      if (paths.length > 0) {
        const suggestion = buildRollbackSuggestion(paths[paths.length - 1]!);
        if (suggestion) {
          process.stderr.write(`\n--- Last-known-good config available ---\n`);
          process.stderr.write(`${suggestion.hint}\n`);
          if (suggestion.diff) {
            process.stderr.write(`\nChanges since last successful startup:\n${suggestion.diff}\n`);
          }
        }
      }

      process.exit(1);
    });
  }
}
