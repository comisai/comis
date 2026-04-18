/**
 * Daemon Entry Point: thin orchestrator calling setupXxx() factories in sequence.
 * @module
 */

import { bootstrap, loadEnvFile, createApprovalGate, parseFormattedSessionKey, createConfigGitManager, envSubset, generateStrongToken, createAuditAggregator, createInjectionRateLimiter, validateMemoryWrite, checkApprovalsConfig, safePath, resolveConfigSecretRefs } from "@comis/core";
import type { SecretStorePort, WrapExternalContentOptions, PerAgentConfig } from "@comis/core";
import { setupSecrets as _setupSecretsImpl, createSqliteSecretStore, createNamedGraphStore, createContextStore, createObservabilityStore } from "@comis/memory";
import type { ObservabilityStore } from "@comis/memory";
import { ok, err, suppressError } from "@comis/shared";
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
  setupMcp,
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
} from "./wiring/index.js";
import { setupSingleAgent } from "./wiring/setup-agents.js";
import { createActiveRunRegistry, createModelCatalog, wireSessionStateCleanup, wireMcpDisconnectCleanup, createGeminiCacheManager, wireGeminiCacheCleanup } from "@comis/agent";
import type { GeminiCacheManager } from "@comis/agent";
import { detectSandboxProvider, createImageGenProvider, createImageGenRateLimiter } from "@comis/skills";
import type { SandboxProvider, ImageGenRateLimiter } from "@comis/skills";
import { createGraphCoordinator, createNodeTypeRegistry } from "./graph/index.js";
import { createChannelHealthMonitor, type ChannelHealthMonitor } from "@comis/channels";
import { createWakeCoalescer, createSystemEventQueue, type WakeReasonKind } from "@comis/scheduler";
import { createTokenRegistry } from "./rpc/token-handlers.js";
import type { DaemonInstance, DaemonOverrides } from "./daemon-types.js";
export type { DaemonInstance, DaemonOverrides } from "./daemon-types.js";
import { createLatencyRecorder } from "./observability/latency-recorder.js";
import { setupObsPersistence } from "./observability/obs-persistence-wiring.js";
import type { ObsPersistenceResult } from "./observability/obs-persistence-wiring.js";
import { createContextPipelineCollector } from "./observability/context-pipeline-collector.js";
import { createLogLevelManager } from "./observability/log-infra.js";
import { createTokenTracker } from "./observability/token-tracker.js";
import { createTracingLogger } from "./observability/trace-logger.js";
import { setupDeliveryQueueLogging } from "./observability/delivery-queue-logger.js";
import { setupChannelHealthLogging } from "./observability/channel-health-logger.js";
import { registerGracefulShutdown } from "./process/graceful-shutdown.js";
import { createProcessMonitor } from "./process/process-monitor.js";
import { startWatchdog } from "./health/watchdog.js";
import { randomUUID, createHmac } from "node:crypto";
import { existsSync, chmodSync, statSync, mkdirSync, readFileSync, unlinkSync, cpSync } from "node:fs";
import { writeFile as fsWriteFile, rm } from "node:fs/promises";
import { createExecGit } from "./config/exec-git.js";
import { saveLastKnownGood, buildRollbackSuggestion, handleRestoreFlag } from "./config/last-known-good.js";
import { createRestartContinuationTracker, loadContinuations } from "./wiring/restart-continuation.js";
import { logOperationModelDryRun } from "./wiring/startup-dry-run.js";
import os from "node:os";
import { join as pathJoin, dirname as pathDirname, resolve as pathResolve } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_CONFIG_PATHS = [
  safePath(safePath(os.homedir(), ".comis"), "config.yaml"),
  safePath(safePath(os.homedir(), ".comis"), "config.local.yaml"),
];

/**
 * Sensitive environment variable prefixes to remove from process.env after
 * the SecretManager snapshot captures them. Prevents leakage through
 * subprocess inheritance.
 */
const SENSITIVE_PREFIXES = [
  "ANTHROPIC_",
  "OPENAI_",
  "TELEGRAM_",
  "DISCORD_",
  "SLACK_",
  "WHATSAPP_",
  "GOOGLE_",
  "GROQ_",
  "MISTRAL_",
  "DEEPGRAM_",
  "ELEVENLABS_",
  "SENDGRID_",
  "STRIPE_",
] as const;

/** Individual keys to scrub that don't match prefix patterns. */
const SENSITIVE_EXACT_KEYS = new Set([
  "SECRETS_MASTER_KEY",
]);

/**
 * Remove sensitive environment variables from process.env.
 * Called AFTER mergedEnv snapshot is built but BEFORE bootstrap().
 * Preserves operational vars: COMIS_*, PATH, HOME, NODE_ENV, etc.
 */
function scrubProcessEnv(): void {
  // eslint-disable-next-line no-restricted-syntax -- direct process.env access required: runs before SecretManager during bootstrap security hardening
  for (const key of Object.keys(process.env)) {
    if (SENSITIVE_EXACT_KEYS.has(key)) {
      // eslint-disable-next-line no-restricted-syntax -- see scrubProcessEnv comment above
      delete process.env[key];
      continue;
    }
    for (const prefix of SENSITIVE_PREFIXES) {
      if (key.startsWith(prefix)) {
        // eslint-disable-next-line no-restricted-syntax -- see scrubProcessEnv comment above
        delete process.env[key];
        break;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Startup permission hardening
// ---------------------------------------------------------------------------

interface PermissionCorrection {
  file: string;
  oldMode: number;
  newMode: number;
}

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

/** Main daemon entry point. Wires all subsystem modules and returns DaemonInstance. */
export async function main(overrides: DaemonOverrides = {}): Promise<DaemonInstance> {
  const startupStartMs = Date.now();
  const instanceId = randomUUID().slice(0, 8);

  const _bootstrap = overrides.bootstrap ?? bootstrap;
  const _setupSecrets = overrides.setupSecrets ?? _setupSecretsImpl;
  const _createTracingLogger = overrides.createTracingLogger ?? createTracingLogger;
  const _createLogLevelManager = overrides.createLogLevelManager ?? createLogLevelManager;
  const _createTokenTracker = overrides.createTokenTracker ?? createTokenTracker;
  const _createLatencyRecorder = overrides.createLatencyRecorder ?? createLatencyRecorder;
  const _createProcessMonitor = overrides.createProcessMonitor ?? createProcessMonitor;
  const _registerGracefulShutdown = overrides.registerGracefulShutdown ?? registerGracefulShutdown;
  const _startWatchdog = overrides.startWatchdog ?? startWatchdog;
  const _createGatewayServer = overrides.createGatewayServer ?? createGatewayServer;
  const _setupMedia = overrides.setupMedia ?? setupMedia;
  const exitFn = overrides.exit ?? ((code: number) => process.exit(code));

  // 0. Load secrets from .env
  const envPath = safePath(safePath(os.homedir(), ".comis"), ".env");
  loadEnvFile(envPath);

  // 0.5. Decrypt secrets, merge with env, scrub process.env
  // eslint-disable-next-line no-restricted-syntax -- process.env access needed before SecretManager is initialized
  const dataDir = process.env["COMIS_DATA_DIR"]
    ?? safePath(os.homedir(), ".comis");

  // Scan and correct permissions on known sensitive files
  const permissionCorrections = hardenDataDirPermissions(dataDir);

  const secretsBootResult = _setupSecrets({
    env: process.env as Record<string, string | undefined>,
    dataDir,
  });

  let mergedEnv: Record<string, string | undefined> = process.env as Record<string, string | undefined>;
  let secretStore: SecretStorePort | undefined;

  if (!secretsBootResult.ok) {
    // Invalid master key -- fatal error
    throw new Error(`Secrets bootstrap failed: ${secretsBootResult.error.message}`);
  }

  if (secretsBootResult.value !== null) {
    // Valid master key -- create store and decrypt all secrets
    const { crypto, dbPath } = secretsBootResult.value;
    const store = createSqliteSecretStore(dbPath, crypto);
    secretStore = store;

    const decryptResult = store.decryptAll();
    if (!decryptResult.ok) {
      throw new Error(`Secret decryption failed: ${decryptResult.error.message}`);
    }

    // Build merged env: decrypted secrets as base, env vars override
    const merged: Record<string, string | undefined> = {};
    for (const [name, value] of decryptResult.value) {
      merged[name] = value;
    }
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined) merged[key] = value;
    }
    mergedEnv = merged;

    // Scrub process.env of sensitive prefixes (after snapshot)
    scrubProcessEnv();
  }

  // 1. Bootstrap core container
  // eslint-disable-next-line no-restricted-syntax -- process.env access needed before SecretManager for config path resolution
  const rawConfigPaths = process.env["COMIS_CONFIG_PATHS"];
  const configPaths = (
    rawConfigPaths
      ? rawConfigPaths.split(":")
      : DEFAULT_CONFIG_PATHS
  ).filter((p) => existsSync(p));

  const result = _bootstrap({ configPaths, env: mergedEnv });
  if (!result.ok) {
    throw new Error(`Bootstrap failed: ${result.error.message}`);
  }
  let container = result.value;

  // Resolve any SecretRef objects in config before subsystem startup
  const refResult = resolveConfigSecretRefs(
    container.config as unknown as Record<string, unknown>,
    { secretManager: container.secretManager },
  );
  if (!refResult.ok) {
    throw new Error(`SecretRef resolution failed: ${refResult.error.message}`);
  }
  container = { ...container, config: refResult.value as unknown as typeof container.config };

  // 1.5. Config git versioning
  const execGit = createExecGit();
  const configDir = configPaths.length > 0 ? pathDirname(configPaths[0]!) : "";
  const configGitManager = configDir
    ? createConfigGitManager({
        configDir,
        execGit,
        writeFile: async (relativePath, content) => {
          try {
            const targetPath = safePath(configDir, relativePath);
            await fsWriteFile(targetPath, content, "utf-8");
            return ok(undefined);
          } catch (e: unknown) {
            return err(e instanceof Error ? e.message : String(e));
          }
        },
        removeDir: async (relativePath) => {
          try {
            const targetPath = safePath(configDir, relativePath);
            await rm(targetPath, { recursive: true, force: true });
            return ok(undefined);
          } catch (e: unknown) {
            return err(e instanceof Error ? e.message : String(e));
          }
        },
      })
    : undefined;

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

  // 4. Observability
  const {
    tokenTracker, latencyRecorder,
    sharedCostTracker,  // needed for obs.reset billing clear
    diagnosticCollector, billingEstimator, channelActivityTracker, deliveryTracer,
  } = setupObservability({ eventBus: container.eventBus, _createTokenTracker, _createLatencyRecorder, logger: logLevelManager.getLogger("observability"), dataDir });

  // Context pipeline collector for obs.context.* RPC handlers
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
    embeddingCacheStats,
    embeddingCircuitBreakerState,
  } = await setupMemory({ container, memoryLogger });

  // Observability persistence (dual-write to SQLite)
  const obsConfig = container.config.observability;
  let obsStore: ObservabilityStore | undefined;
  let obsPersistence: ObsPersistenceResult | undefined;

  if (obsConfig.persistence.enabled) {
    obsStore = createObservabilityStore(db);

    // Prune stale data on startup only (avoids continuous overhead)
    const pruneResult = obsStore.prune(obsConfig.persistence.retentionDays);
    daemonLogger.info({
      retentionDays: obsConfig.persistence.retentionDays,
      pruned: pruneResult,
    }, "Observability data pruned on startup");

    // Wire dual-write listeners
    obsPersistence = setupObsPersistence({
      eventBus: container.eventBus,
      obsStore,
      db,
      channelActivityTracker,
      startupTimestamp: startupStartMs,
      snapshotIntervalMs: obsConfig.persistence.snapshotIntervalMs,
      logger: daemonLogger,
    });
  }

  // Create context store for DAG recall tools.
  // Shares the same better-sqlite3 database instance as the memory adapter.
  // contextSchema tables are created lazily by createContextStore if they don't exist.
  const contextStore = createContextStore(db);

  // Shared active run registry for steer+followup routing.
  // Created once and injected into both setupAgents (PiExecutor registration)
  // and setupChannels (inbound pipeline routing).
  const activeRunRegistry = createActiveRunRegistry();

  // Derive canary fallback secret from tenantId.
  // Used when CANARY_SECRET env var is not configured. The per-agent derivation
  // in setup-agents.ts uses this as a base combined with agentId for uniqueness.
  const canaryFallbackSecret = createHmac("sha256", container.config.tenantId)
    .update("comis:canary-fallback")
    .digest("hex");

  // Injection rate limiter as daemon-level singleton
  const injectionRateLimiter = createInjectionRateLimiter();

  // Session mirroring -- adapter + hook plugin registration.
  // MUST run before setupAgents() so agents receive a live deliveryMirror port.
  // Only needs db (from setupMemory) + config + pluginRegistry + logger.
  const { deliveryMirror, startPrune: startMirrorPrune, shutdown: shutdownMirror } = await setupDeliveryMirror({
    db, config: container.config, pluginRegistry: container.pluginRegistry, logger: daemonLogger,
  });

  // Gemini CachedContent lifecycle manager.
  // Always created (cheap -- closure-scoped Maps, lazy SDK client). Per-agent
  // geminiCache.enabled guard in the injector handles individual enablement.
  const geminiCacheManager: GeminiCacheManager = createGeminiCacheManager({
    getApiKey: () => container.secretManager.get("google-api-key") ?? container.secretManager.get("GOOGLE_API_KEY"),
    ttlSeconds: 3600,
    maxActiveCachesPerAgent: 20,
    refreshThreshold: 0.5,
    logger: daemonLogger,
  });

  // Deferred channel plugins ref for resolving platform character limits.
  // Populated after setupChannels; the callback is invoked at message time (always set by then).
  const channelPluginsRef: { ref?: Map<string, import("@comis/core").ChannelPluginPort> } = {};

  // 6.5.1. Background task system (Proactive v1 -- BGND)
  // Created before setupAgents so BackgroundTaskManager is available for executor deps.
  const { backgroundTaskManager } = setupBackgroundTasks({
    dataDir,
    eventBus: container.eventBus,
    logger: logLevelManager.getLogger("background-tasks"),
  });

  // Deferred notification ref for background task completion callbacks.
  // Populated after setupNotifications returns (below). The bgNotifyFn captures the
  // ref, so it is always set before any background task completes.
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
  {
    const skillsTarget = safePath(dataDir, "skills");
    const skillCreatorDest = safePath(skillsTarget, "skill-creator");
    const __filename = fileURLToPath(import.meta.url);
    const bundledSrc = pathResolve(__filename, "../../bundled-skills/skill-creator");
    if (existsSync(bundledSrc)) {
      const bundledSkillMd = safePath(bundledSrc, "SKILL.md");
      const installedSkillMd = safePath(skillCreatorDest, "SKILL.md");
      let shouldSeed = !existsSync(skillCreatorDest);
      if (!shouldSeed && existsSync(bundledSkillMd) && existsSync(installedSkillMd)) {
        // Compare version fields in frontmatter to detect upgrades
        const extractVersion = (path: string): string | undefined => {
          try {
            const head = readFileSync(path, "utf-8").slice(0, 512);
            const match = head.match(/^version:\s*["']?([^"'\n]+)/m);
            return match?.[1]?.trim();
          } catch { return undefined; }
        };
        const bundledVersion = extractVersion(bundledSkillMd);
        const installedVersion = extractVersion(installedSkillMd);
        if (bundledVersion && bundledVersion !== installedVersion) {
          shouldSeed = true;
          agentLogger.info(
            { skill: "skill-creator", installedVersion: installedVersion ?? "none", bundledVersion },
            "Bundled skill-creator version newer than installed — updating",
          );
        }
      }
      if (shouldSeed) {
        mkdirSync(skillsTarget, { recursive: true });
        cpSync(bundledSrc, skillCreatorDest, { recursive: true });
        agentLogger.info({ skill: "skill-creator" }, "Bundled skill-creator seeded into data directory");
      }
    }
  }

  // 6.6. Agents
  const agents = container.config.agents;
  const {
    sessionManager, executors, workspaceDirs, costTrackers, budgetGuards, stepCounters,
    defaultAgentId, defaultWorkspaceDir, getExecutor, piSessionAdapters,
    skillWatcherHandles, skillRegistries, lockCleanupTimer, singleAgentDeps, providerHealth,
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
    geminiCacheManager,  // Gemini cache lifecycle manager
    // Resolve platform char limit via deferred channelPlugins ref
    getChannelMaxChars: (channelType: string) => {
      const plugin = channelPluginsRef.ref?.get(channelType);
      return plugin?.capabilities?.limits?.maxMessageChars;
    },
    backgroundTaskManager,  // Auto-background middleware in executor pipeline
    backgroundNotifyFn: bgNotifyFn,  // Completion notification via deferred notificationService ref
  });

  // Log operation model resolutions at startup (dry-run validation)
  logOperationModelDryRun({
    agents: container.config.agents,
    secretManager: container.secretManager,
    logger: daemonLogger,
  });

  // Restart continuation tracker: track recently-active sessions for SIGUSR1 replay
  const continuationTracker = createRestartContinuationTracker();

  // Filtered subprocess environment (used by setupSchedulers and MCP spawns)
  // System vars needed for basic process operation + all user-managed secrets.
  // SecretManager only contains values explicitly provisioned for the agent
  // (via env_set, .env file, or secrets.db). Host process.env was already
  // scrubbed by scrubProcessEnv() so no host credentials leak through here.
  //
  // IMPORTANT: This env is for TRUSTED children (scheduler-spawned tasks and
  // MCP server processes whose env is declared in config.yaml). It is NOT safe
  // for exec-tool children, which run agent-issued shell commands sourced from
  // attacker-controllable channels (Discord, email, webhooks, prompt injection,
  // etc.). Exec-tool gets its own credential-free env (`execToolEnv` below).
  const SUBPROCESS_SYSTEM = ["PATH", "HOME", "LANG", "TERM", "NODE_ENV", "TZ"] as const;
  const subprocessEnv = envSubset(container.secretManager, [...SUBPROCESS_SYSTEM, ...container.secretManager.keys()]);

  // Credential-free env for the exec tool (agent-issued shell commands).
  // Strips ANTHROPIC_API_KEY, OPENAI_API_KEY, COMIS_GATEWAY_TOKEN, etc. so an
  // LLM-induced prompt injection cannot exfiltrate daemon credentials via a
  // simple `env` or `printenv` call inside the sandbox. System vars only.
  const execToolEnv = envSubset(container.secretManager, [...SUBPROCESS_SYSTEM]);

  // Deferred wake callback -- wired after wakeCoalescer is created
  // eslint-disable-next-line prefer-const -- assigned later after wakeCoalescer is created
  let cronWakeCallback: ((reason: string) => void) | undefined;

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
    onCronWake: (reason: string) => cronWakeCallback?.(reason),  // deferred
  });

  // Clean up all session-scoped state on session expiry
  wireSessionStateCleanup(container.eventBus);

  // Dispose Gemini cache on session expiry (fire-and-forget)
  wireGeminiCacheCleanup(container.eventBus, geminiCacheManager);

  // Clean up orphaned comis:* caches from previous daemon runs
  suppressError(
    geminiCacheManager.cleanupOrphaned().then((result) => {
      if (result.ok && (result.value.deleted > 0 || result.value.skipped > 0)) {
        daemonLogger.info(
          { deleted: result.value.deleted, skipped: result.value.skipped },
          "Gemini cache: orphan cleanup complete",
        );
      }
    }),
    "gemini-cache-orphan-cleanup",
  );

  // Clean up discovery state when MCP servers disconnect or remove tools
  wireMcpDisconnectCleanup(container.eventBus);

  // 6.6.5.5. Task extraction (conversation -> extracted tasks pipeline)
  const { extractFromConversation } = setupTaskExtraction({
    container, workspaceDirs, schedulerLogger,
  });

  // Audit aggregator for deduplicating security events
  const auditAggregator = createAuditAggregator(container.eventBus, undefined, skillsLogger);
  const onSuspiciousContent: WrapExternalContentOptions["onSuspiciousContent"] = (info) => {
    auditAggregator.record({
      source: "external_content",
      patterns: info.patterns,
    });
  };

  // 6.6.7. Media (moved up from 6.6.8 -- media infrastructure must be ready before channels)
  const {
    ttsAdapter, visionRegistry, linkRunner,
    mediaTempManager, mediaSemaphore, audioConverter,
    transcriber, ssrfFetcher, fileExtractor,
  } = await _setupMedia({ container, skillsLogger, onSuspiciousContent });

  // 6.6.7.5. RPC bridge (deferred dispatch) -- moved before setupChannels so rpcCall
  // can be threaded into channel config command handling. The deferred dispatch pattern
  // ensures rpcCall is safe to pass now; actual dispatch wires later via wireDispatch().
  const { rpcCall, wireDispatch } = setupRpcBridge({ gatewayLogger });

  // 6.6.8.6. Approval gate (moved before channels for APPR-CHAT command interception)
  const approvalGate = createApprovalGate({
    eventBus: container.eventBus,
    getTimeoutMs: () => container.config.approvals?.defaultTimeoutMs ?? 30_000,
    getDenialCacheTtlMs: () => container.config.approvals?.denialCacheTtlMs ?? 60_000,
    getBatchApprovalTtlMs: () => container.config.approvals?.batchApprovalTtlMs ?? 30_000,
    logger: daemonLogger, // Approval cache hit/miss debug logging
  });

  // 6.6.8.6.1. Restore pending approvals from previous restart (quick-174)
  const approvalRestorePath = pathJoin(container.config.dataDir || dataDir, "restart-approvals.json");
  if (existsSync(approvalRestorePath)) {
    try {
      const raw = readFileSync(approvalRestorePath, "utf-8");
      const records = JSON.parse(raw);
      unlinkSync(approvalRestorePath);
      const restored = approvalGate.restorePending(records);
      if (restored > 0) {
        daemonLogger.info({ count: restored, total: records.length }, "Pending approvals restored from previous session");
      }
    } catch (restoreErr) {
      daemonLogger.warn(
        { err: restoreErr, hint: "Could not restore pending approvals; operators may need to re-approve", errorKind: "internal" as const },
        "Failed to restore pending approvals",
      );
      try { unlinkSync(approvalRestorePath); } catch { /* ignore */ }
    }
  }

  // 6.6.8.6.2. Restore approval cache from previous session
  const approvalCacheRestorePath = pathJoin(container.config.dataDir || dataDir, "restart-approval-cache.json");
  if (existsSync(approvalCacheRestorePath)) {
    try {
      const raw = readFileSync(approvalCacheRestorePath, "utf-8");
      unlinkSync(approvalCacheRestorePath); // Consume immediately
      const entries = JSON.parse(raw);
      const restored = approvalGate.restoreApprovalCache(entries);
      if (restored > 0) {
        daemonLogger.info({ count: restored, total: entries.length }, "Approval cache restored from previous session");
      }
    } catch (restoreErr) {
      daemonLogger.warn(
        { err: restoreErr, hint: "Could not restore approval cache; users may need to re-approve", errorKind: "internal" as const },
        "Failed to restore approval cache",
      );
      try { unlinkSync(approvalCacheRestorePath); } catch { /* ignore */ }
    }
  }

  // 6.6.7.8. Delivery queue: create adapter BEFORE setupChannels.
  // channelAdapters map is passed by reference -- populated after setupChannels.
  // drainAndStartPrune() is called AFTER setupChannels (two-phase lifecycle).
  const channelAdaptersRef = new Map<string, import("@comis/channels").DeliveryAdapter>();
  const { deliveryQueue, drainAndStartPrune: drainAndStartDeliveryPrune, shutdown: shutdownDeliveryQueue } = await setupDeliveryQueue({
    db, config: container.config, eventBus: container.eventBus, logger: daemonLogger, channelAdapters: channelAdaptersRef,
  });

  // 6.6.8. Channels (moved down from 6.6.6 -- needs ssrfFetcher and transcriber from setupMedia)
  // Deferred tool assembler ref: wired after setupTools returns (avoids TDZ --
  // the Telegram adapter starts polling immediately and messages can arrive
  // before setupTools completes).
  // Deferred notification session tracker ref: wired after setupNotifications returns.
  // The onMessageProcessed callback reads this at call time (not definition time),
  // so it is always set before any message arrives.
  const sessionTrackerRef: { ref?: import("./notification/session-tracker.js").SessionTracker } = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- matches assembleToolsForAgent signature
  const toolAssemblerRef: { ref?: (agentId: string) => Promise<any[]> } = {};
  const { adaptersByType, channelManager, resolveAttachment, lifecycleReactors, channelPlugins, commandQueue } = await setupChannels({
    container, executors, defaultAgentId, sessionManager, sessionStore,
    logger, channelsLogger,
    linkRunner,
    ssrfFetcher,
    transcriber,
    maxMediaBytes: container.config.integrations.media.infrastructure.maxRemoteFetchBytes,
    assembleToolsForAgent: (agentId: string) => toolAssemblerRef.ref ? toolAssemblerRef.ref(agentId) : Promise.resolve([]),
    // Voice response pipeline deps
    ttsAdapter,
    audioConverter,
    mediaTempManager,
    mediaSemaphore,
    // Document extraction pipeline
    fileExtractor,
    fileExtractionConfig: container.config.integrations.media.documentExtraction,
    // Media file persistence pipeline
    workspaceDirs,
    defaultWorkspaceDir,
    memoryAdapter,
    tenantId: container.config.tenantId,
    embeddingQueue,
    // Pass queue config for per-session serialization
    queueConfig: container.config.queue,
    // steer+followup inbound routing
    activeRunRegistry,
    // /config chat command handling via deferred RPC dispatch
    rpcCall,
    // Task extraction callback (gated by config.scheduler.tasks.enabled)
    onTaskExtraction: extractFromConversation,
    // Restart continuation: track recently-active sessions for SIGUSR1 replay
    onMessageProcessed: (msg, channelType) => {
      continuationTracker.track({
        agentId: defaultAgentId,
        channelType,
        channelId: msg.channelId,
        userId: msg.senderId,
        tenantId: container.config.tenantId,
        timestamp: Date.now(),
      });
      // Record session activity for notification channel resolution fallback.
      // sessionTrackerRef is populated after setupNotifications() returns (below).
      sessionTrackerRef.ref?.recordActivity(defaultAgentId, channelType, msg.channelId);
    },
    // /approve and /deny chat command interception
    approvalGate: container.config.approvals?.enabled ? approvalGate : undefined,
    // CMD-WIRE: Per-agent session adapters and cost trackers for slash commands
    piSessionAdapters,
    costTrackers,
    // Delivery queue for crash-safe persistence
    deliveryQueue,
    // Cron execution trackers for enriched JSONL entries
    cronExecutionTrackers: executionTrackers,
  });

  // Populate channel plugins ref for per-message char limit resolution.
  channelPluginsRef.ref = channelPlugins;

  // Populate channelAdapters ref now that setupChannels has returned.
  // The drain cycle needs adapters to re-deliver pending messages.
  for (const [type, adapter] of adaptersByType) {
    channelAdaptersRef.set(type, adapter);
  }
  // Run drain + start prune timer (two-phase lifecycle: adapter was created above).
  await drainAndStartDeliveryPrune();
  // Register delivery queue shutdown (clears prune interval)
  container.eventBus.on("system:shutdown", () => { shutdownDeliveryQueue(); });
  // Start mirror prune timer and register shutdown
  startMirrorPrune();
  container.eventBus.on("system:shutdown", () => { shutdownMirror(); });
  // Structured logging for delivery queue lifecycle events
  setupDeliveryQueueLogging({ eventBus: container.eventBus, logger: daemonLogger });

  // 6.6.8.0.1. Notification system (Proactive v1)
  // setupNotifications creates the NotificationService and SessionTracker.
  // The factory is already complete -- this call wires it into the daemon.
  const notificationContext = setupNotifications({
    eventBus: container.eventBus,
    deliveryQueue,
    agents,
    quietHoursConfig: container.config.scheduler.quietHours,
    criticalBypass: container.config.scheduler.quietHours.criticalBypass,
    activeAdapterTypes: new Set(adaptersByType.keys()),
    logger: daemonLogger,
    tenantId: container.config.tenantId,
  });
  // Wire deferred session tracker ref for onMessageProcessed callback
  sessionTrackerRef.ref = notificationContext.sessionTracker;

  // Wire deferred notification ref for background task completion callbacks
  bgNotifyRef.ref = notificationContext.notificationService;

  // Channel health monitor -- polls adapter getStatus() at configurable interval.
  // Created after adapters are initialized, started immediately with the adapter map.
  let channelHealthMonitor: ChannelHealthMonitor | undefined;
  let stopChannelHealthMonitor: (() => void) | undefined;

  const healthCheckConfig = container.config.channels?.healthCheck;
  if (healthCheckConfig?.enabled !== false) {
    channelHealthMonitor = createChannelHealthMonitor({
      eventBus: container.eventBus,
      pollIntervalMs: healthCheckConfig?.pollIntervalMs,
      staleThresholdMs: healthCheckConfig?.staleThresholdMs,
      idleThresholdMs: healthCheckConfig?.idleThresholdMs,
      errorThreshold: healthCheckConfig?.errorThreshold,
      stuckThresholdMs: healthCheckConfig?.stuckThresholdMs,
      startupGraceMs: healthCheckConfig?.startupGraceMs,
      autoRestartOnStale: healthCheckConfig?.autoRestartOnStale,
      maxRestartsPerHour: healthCheckConfig?.maxRestartsPerHour,
      restartCooldownMs: healthCheckConfig?.restartCooldownMs,
      restartAdapter: async (channelType: string) => {
        const adapter = adaptersByType.get(channelType);
        if (!adapter) return;
        daemonLogger.info({ channelType }, "Health monitor triggering auto-restart for stale adapter");
        await adapter.stop();
        await adapter.start();
      },
    });
    stopChannelHealthMonitor = channelHealthMonitor.start(adaptersByType);
  }
  // Register health monitor shutdown on system:shutdown event
  container.eventBus.on("system:shutdown", () => { stopChannelHealthMonitor?.(); });
  // Structured logging for channel health state transitions
  setupChannelHealthLogging({ eventBus: container.eventBus, logger: daemonLogger });

  // 6.6.8.7. MCP server connections (external tool servers)
  const { mcpClientManager } = await setupMcp({
    servers: container.config.integrations.mcp.servers,
    logger: skillsLogger,
    callToolTimeoutMs: container.config.integrations.mcp.callToolTimeoutMs,
    defaultCwd: defaultWorkspaceDir,
    eventBus: container.eventBus,
    stdioDefaultConcurrency: container.config.integrations.mcp.stdioDefaultConcurrency,
    httpDefaultConcurrency: container.config.integrations.mcp.httpDefaultConcurrency,
  });

  // Detect sandbox provider once at startup
  const sandboxProvider: SandboxProvider | undefined = detectSandboxProvider(skillsLogger);
  if (sandboxProvider) {
    skillsLogger.info({ provider: sandboxProvider.name }, "Exec sandbox provider detected");
  }

  // 6.6.8.4.1. Image generation provider (Proactive v1 -- IMGN)
  const imageGenConfig = container.config.integrations.media.imageGeneration;
  const imageGenResult = createImageGenProvider(imageGenConfig, container.secretManager);
  const imageGenProvider = imageGenResult.ok ? imageGenResult.value : undefined;
  const imageGenRateLimiter: ImageGenRateLimiter | undefined = imageGenProvider
    ? createImageGenRateLimiter({ maxPerHour: imageGenConfig.maxPerHour })
    : undefined;
  if (imageGenProvider) {
    skillsLogger.info({ provider: imageGenConfig.provider }, "Image generation provider initialized");
  } else if (imageGenResult.ok) {
    skillsLogger.debug("Image generation disabled: API key not configured");
  } else {
    skillsLogger.warn(
      { err: imageGenResult.error, hint: "Check image generation config provider value", errorKind: "config" as const },
      "Image generation provider creation failed",
    );
  }

  // 6.6.8.5. Tools + message preprocessing
  const { assembleToolsForAgent, preprocessMessageText } = setupTools({
    rpcCall, agents, defaultAgentId, workspaceDirs, defaultWorkspaceDir,
    dataDir: container.config.dataDir || ".",
    secretManager: container.secretManager, eventBus: container.eventBus, skillsLogger, linkRunner,
    approvalGate: container.config.approvals?.enabled ? approvalGate : undefined,
    subprocessEnv: execToolEnv,
    onSuspiciousContent,
    mcpClientManager,
    sandboxProvider,
    imageGenProvider,  // Conditional: only registered when API key is present
    backgroundTaskManager,  // Background_tasks tool registration
  });

  // Wire deferred tool assembler ref now that setupTools has returned
  toolAssemblerRef.ref = assembleToolsForAgent;

  // 6.6.9. Cross-session sender + sub-agent runner
  // Deferred gateway send ref: wired after setupGateway returns wsConnections
  const gatewaySendRef: { ref?: (channelId: string, text: string) => boolean } = {};
  const { crossSessionSender, subAgentRunner, sendToChannel, announceToParent, deadLetterQueue, announcementBatcher } = setupCrossSession({
    sessionStore, container, assembleToolsForAgent, getExecutor, adaptersByType,
    logger: agentLogger,
    memoryAdapter,
    gatewaySend: gatewaySendRef,
    activeRunRegistry,
    deliveryQueue,
  });

  // Rolling prompt timeout counter (sliding 5-minute window).
  // Timestamps are pushed on every execution:prompt_timeout event. Pruning
  // happens at read time inside the health log handler to avoid timer overhead.
  const promptTimeoutTimestamps: number[] = [];
  container.eventBus.on("execution:prompt_timeout", () => {
    promptTimeoutTimestamps.push(Date.now());
  });

  // 6.6.9.0. Node type registry (initially empty; drivers registered at startup)
  const nodeTypeRegistry = createNodeTypeRegistry();

  // 6.6.9.1. Graph coordinator for DAG execution
  const graphCoordinator = createGraphCoordinator({
    subAgentRunner,
    eventBus: container.eventBus,
    sendToChannel,
    announceToParent,
    batcher: announcementBatcher,
    tenantId: container.config.tenantId,
    defaultAgentId,
    maxConcurrency: (container.config.security.agentToAgent as Record<string, unknown>).graphMaxConcurrency as number | undefined ?? 4,
    maxResultLength: (container.config.security.agentToAgent as Record<string, unknown>).graphMaxResultLength as number | undefined,
    maxGlobalSubAgents: (container.config.security.agentToAgent as Record<string, unknown>).graphMaxGlobalSubAgents as number | undefined,
    logger: agentLogger?.child?.({ submodule: "graph-coordinator" }),
    dataDir: container.config.dataDir || dataDir,
    nodeTypeRegistry,
    activeRunRegistry,  // Parent-session-gone detection for graph completion
    // Provide tool assembly for graph-wide superset computation and prewarm.
    // Returns full tool definitions (name + description + inputSchema) so prewarm
    // can send byte-identical tool schemas to seed the cache prefix.
    assembleToolsForAgent: async (agentId: string) => {
      const tools = await assembleToolsForAgent(agentId);
      return tools.map((t: { name: string; description?: string; inputSchema?: unknown }) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      }));
    },
    // Keep parent session lane alive during graph execution
    touchParentSession: commandQueue
      ? (sessionKey: string) => commandQueue.touchLane(sessionKey)
      : undefined,
    // Pre-warm cache prefix for Anthropic graph executions.
    // Seeds system prompt + tools into Anthropic's cache before graph nodes spawn,
    // so all nodes get cache reads instead of independent cold writes.
    // Tools field is populated eagerly -- the graph coordinator awaits toolSupersetPromise
    // before calling preWarmGraphCache, but the deps.preWarm.tools field provides the full
    // tool definitions (with description + inputSchema) for the prewarm API call.
    // assembleToolsForAgent is called lazily at graph start time, so we provide the
    // resolver function via a getter pattern: the coordinator resolves tools from
    // the superset at prewarm time using deps.assembleToolsForAgent (already wired above).
    preWarm: (() => {
      const agentCfg = agents[defaultAgentId];
      const provider = agentCfg?.provider ?? "anthropic";
      const resolvedModel = agentCfg?.model === "default" || !agentCfg?.model
        ? "claude-sonnet-4-5-20250929"
        : agentCfg.model;
      const apiKey = container.secretManager.get("anthropic-api-key")
        ?? container.secretManager.get("ANTHROPIC_API_KEY") ?? "";
      if (!apiKey) return undefined;
      return {
        provider,
        modelId: resolvedModel,
        apiKey,
        systemPrompt: agentCfg?.name
          ? `You are ${agentCfg.name}. You are a helpful AI assistant.`
          : "You are a helpful AI assistant.",
        tools: [] as Array<{ name: string; description?: string; inputSchema?: unknown }>,
      };
    })(),
  });

  // Late-bind graph coordinator into sub-agent runner for direct kill cascade
  subAgentRunner.setGraphCoordinator(graphCoordinator);

  // 6.6.9.2. Named graph store for server-side pipeline persistence
  const namedGraphStore = createNamedGraphStore(db);

  // 6.7. Monitoring (adaptersByType passed for delivery bridge wiring)
  const { heartbeatRunner, duplicateDetector } = setupMonitoring({ container, schedulerLogger, logger, adaptersByType });

  // 6.7.0.0. Per-agent heartbeat with LLM-driven agent turns
  const { perAgentRunner } = setupHeartbeat({
    container,
    executors,
    assembleToolsForAgent,
    workspaceDirs,
    activeRunRegistry,
    duplicateDetector,
    adaptersByType,
    systemEventQueue,
    memoryApi,
    schedulerLogger,
  });

  // 6.7.0.1. Wake coalescer wrapping heartbeatRunner
  const wakeCoalescer = createWakeCoalescer({
    runOnce: () => (heartbeatRunner ? heartbeatRunner.runOnce() : Promise.resolve()),
    logger: schedulerLogger,
  });

  // Wire deferred cron wake callback
  cronWakeCallback = (reason) => wakeCoalescer.requestHeartbeatNow(reason as WakeReasonKind);

  // 6.7.0.2. Agent management runtime state
  const suspendedAgents = new Set<string>();

  // Model catalog for model management handlers
  const modelCatalog = createModelCatalog();
  modelCatalog.loadStatic();

  // Channel config for channel management handlers
  const channelConfig: Record<string, { enabled: boolean }> = Object.fromEntries(
    Object.entries(container.config.channels ?? {}).filter(
      ([k, v]) => k !== "healthCheck" && typeof v === "object" && v !== null && "enabled" in v,
    ).map(([k, v]) => [k, { enabled: !!(v as Record<string, unknown>).enabled }]),
  );

  // Token registry for token management handlers
  const gwTokens = (container.config.gateway?.tokens ?? []).map((t: { id?: string; scopes?: readonly string[] }) => ({
    id: t.id ?? "unknown",
    scopes: [...(t.scopes ?? [])],
  }));
  const tokenRegistry = createTokenRegistry(gwTokens);
  const runtimeTokens: Array<{ id: string; secretBuf: Buffer; scopes: string[] }> = [];
  const removedTokenIds = new Set<string>();

  // Resolve gateway token secrets at startup (config -> env -> auto-generate)
  const resolvedGatewayTokens: Array<{ id: string; secret: string; scopes: string[] }> = [];
  for (const t of container.config.gateway?.tokens ?? []) {
    const tokenId = t.id ?? "unknown";
    const tokenScopes = [...(t.scopes ?? [])];
    if (typeof t.secret === "string" && t.secret.length >= 32) {
      // Source: config (explicit secret present and valid)
      resolvedGatewayTokens.push({ id: tokenId, secret: t.secret, scopes: tokenScopes });
    } else {
      const envKey = `GATEWAY_TOKEN_${tokenId.toUpperCase().replace(/-/g, "_")}`;
      const envSecret = container.secretManager.get(envKey);
      if (envSecret) {
        // Source: env / SecretManager
        resolvedGatewayTokens.push({ id: tokenId, secret: envSecret, scopes: tokenScopes });
      } else {
        // Source: auto-generated (ephemeral)
        const generated = generateStrongToken();
        resolvedGatewayTokens.push({ id: tokenId, secret: generated, scopes: tokenScopes });
        daemonLogger.warn(
          { tokenId, envVar: envKey, hint: `Set ${envKey} in environment or secrets store for persistence`, errorKind: "config" as const },
          "Gateway token auto-generated (ephemeral -- will be lost on restart)",
        );
      }
    }
  }

  // 6.7.0.5. Session store bridge (shared between RPC dispatch and DaemonInstance return)
  const sessionStoreBridge = {
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

  // Mutable shutdown ref for hot-add guard.
  // Closures must be defined before wireDispatch() so the { ...deps }
  // spread in createAgentHandlers captures them. But shutdownHandle is created
  // after wireDispatch at setupShutdown(). We use a mutable ref that
  // is assigned after setupShutdown -- closures read it at RPC call time, not
  // definition time, so it is always set before any RPC arrives.
  const shutdownRef: { value?: { readonly isShuttingDown: boolean } } = {};

  // Hot-add/hot-remove closures for runtime agent lifecycle.
  // These closures capture the destructured Maps by reference. All consumers
  // (channels, tools, gateway, RPC) hold references to the same Maps, so
  // inserting/deleting once makes the agent visible/invisible everywhere.
  const hotAdd = async (agentId: string, config: PerAgentConfig): Promise<void> => {
    const startMs = Date.now();
    if (shutdownRef.value?.isShuttingDown) {
      throw new Error("Cannot hot-add agent during shutdown");
    }
    const result = await setupSingleAgent(agentId, config, singleAgentDeps);
    executors.set(agentId, result.executor);
    workspaceDirs.set(agentId, result.workspaceDir);
    costTrackers.set(agentId, result.costTracker);
    budgetGuards.set(agentId, result.budgetGuard);
    stepCounters.set(agentId, result.stepCounter);
    piSessionAdapters.set(agentId, result.piSessionAdapter);
    if (result.skillWatcherHandle) {
      skillWatcherHandles.set(agentId, result.skillWatcherHandle);
    }
    skillRegistries.set(agentId, result.skillRegistry);
    container.eventBus.emit("agent:hot_added", { agentId, timestamp: Date.now() });
    daemonLogger.info({ agentId, durationMs: Date.now() - startMs }, "Agent hot-added to running daemon");
  };

  const hotRemove = async (agentId: string): Promise<void> => {
    const startMs = Date.now();
    // Warn if agent may have active executions.
    // ActiveRunRegistry is keyed by sessionKey, not agentId. Since hot-remove is
    // rare and the registry is small, a coarse size > 0 check is sufficient for v1.
    if (activeRunRegistry.size > 0) {
      daemonLogger.warn(
        { agentId, activeRuns: activeRunRegistry.size,
          hint: "Agent removed while daemon has active executions; if this agent has an in-flight run it will complete but response delivery may fail",
          errorKind: "operational" as const },
        "Hot-removing agent with possible active executions",
      );
    }
    // Stop skill watcher if present
    const watcher = skillWatcherHandles.get(agentId);
    if (watcher) {
      await watcher.close();
      skillWatcherHandles.delete(agentId);
    }
    // Remove from all Maps (workspace dir preserved on disk for data safety)
    executors.delete(agentId);
    workspaceDirs.delete(agentId);
    costTrackers.delete(agentId);
    budgetGuards.delete(agentId);
    stepCounters.delete(agentId);
    piSessionAdapters.delete(agentId);
    skillRegistries.delete(agentId);
    container.eventBus.emit("agent:hot_removed", { agentId, timestamp: Date.now() });
    daemonLogger.info({ agentId, durationMs: Date.now() - startMs }, "Agent hot-removed from running daemon");
  };

  // 6.7.1. Wire RPC dispatch now that heartbeatRunner is available
  // Keep a reference so we can add wsConnections/mediaDir after gateway setup (quick-91).
  const rpcDispatchDeps: import("./rpc/rpc-dispatch.js").RpcDispatchDeps = {
    defaultAgentId, getAgentCronScheduler, cronSchedulers, executionTrackers,
    wakeCoalescer, defaultWorkspaceDir, workspaceDirs, memoryApi, memoryAdapter,
    embeddingQueue, tenantId: container.config.tenantId, agents, costTrackers,
    stepCounters,
    agentDataDir: pathJoin(container.config.dataDir ?? pathJoin(os.homedir(), ".comis"), "agents"),
    sessionStore: sessionStoreBridge,
    crossSessionSender, subAgentRunner, graphCoordinator, namedGraphStore, nodeTypeRegistry,
    securityConfig: container.config.security, adaptersByType, visionRegistry,
    mediaConfig: container.config.integrations.media, ttsAdapter, linkRunner,
    logger, container, configPaths, defaultConfigPaths: DEFAULT_CONFIG_PATHS,
    configGitManager,
    configWebhook: container.config.daemon.configWebhook as { url?: string; timeoutMs?: number; secret?: string },
    secretStore,
    envFilePath: envPath,
    logLevelManager,
    getAgentBrowserService,
    resolveAttachment, transcriber, fileExtractor,
    approvalGate,
    suspendedAgents,
    hotAdd,      // runtime agent creation without restart
    hotRemove,   // runtime agent deletion without restart
    diagnosticCollector, billingEstimator, channelActivityTracker, deliveryTracer,
    budgetGuards,
    modelCatalog,
    channelConfig,
    tokenRegistry,
    addToTokenStore: (entry) => {
      runtimeTokens.push({ id: entry.id, secretBuf: Buffer.from(entry.secret, "utf-8"), scopes: entry.scopes });
    },
    removeFromTokenStore: (id) => {
      removedTokenIds.add(id);
      const idx = runtimeTokens.findIndex((t) => t.id === id);
      if (idx >= 0) runtimeTokens.splice(idx, 1);
    },
    memoryWriteValidator: validateMemoryWrite,  // memory content validation
    eventBus: container.eventBus as { emit(event: string, payload: unknown): void },  // security event emission for memory writes
    mcpClientManager,  // Phase quick-81: MCP server management
    contextStore,  // DAG recall RPC handlers
    contextEngineConfig: {
      maxRecallsPerDay: agents[defaultAgentId]?.contextEngine?.maxRecallsPerDay ?? 10,
      maxExpandTokens: agents[defaultAgentId]?.contextEngine?.maxExpandTokens ?? 4000,
      recallTimeoutMs: agents[defaultAgentId]?.contextEngine?.recallTimeoutMs ?? 120000,
    },
    obsStore,  // dual-source reads in obs-handlers
    startupTimestamp: startupStartMs,  // dedup boundary for dual-source merge
    sharedCostTracker,  // obs.reset needs to clear in-memory billing data
    contextPipelineCollector,  // context engine pipeline/DAG RPC handlers
    execGit,  // workspace file management
    deliveryQueue,  // crash-safe delivery queue
    channelPlugins,  // channel plugins for capabilities RPC
    healthMonitor: channelHealthMonitor,  // channel health monitor for channels.health RPC
    embeddingCacheStats,  // embedding cache stats for memory.embeddingCache RPC
    embeddingCircuitBreakerState,  // Embedding circuit breaker state for memory operations
    skillRegistries,  // skill management handlers in rpc-dispatch
    notificationService: notificationContext.notificationService,  // Proactive v1: notification.send RPC handler
    // Image generation RPC handler deps
    imageHandlerDeps: imageGenProvider && imageGenRateLimiter ? {
      provider: imageGenProvider,
      rateLimiter: imageGenRateLimiter,
      config: imageGenConfig,
      logger: skillsLogger,
      getChannelAdapter: (channelType: string) => adaptersByType.get(channelType),
    } : undefined,
  };
  wireDispatch(rpcDispatchDeps);

  // 7. Gateway
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
  });

  // 7.0.1. Wire deferred gateway attachment deps (quick-91)
  // wsConnections and mediaDir are now available after gateway setup; message.attach
  // handler closures read from the mutable rpcDispatchDeps reference at call time.
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
      gatewayLogger.warn({ textLength: text.length, hint: "No WebSocket clients connected to receive sub-agent notification", errorKind: "internal" }, "Sub-agent notification broadcast failed: no connections");
    }
    return sent;
  };

  // 7.5. Restart continuation replay
  const continuationFilePath = pathJoin(container.config.dataDir || dataDir, "restart-continuations.json");
  const continuations = loadContinuations(continuationFilePath, 5 * 60_000, daemonLogger);
  if (continuations.length > 0 && channelManager) {
    daemonLogger.info({ count: continuations.length }, "Replaying restart continuations");
    for (const record of continuations) {
      // Skip sessions that already received a message during this startup cycle
      // (e.g., Telegram webhook delivered before continuation replay ran).
      if (continuationTracker.isTracked(record)) {
        daemonLogger.debug(
          { channelType: record.channelType, channelId: record.channelId },
          "Skipping continuation replay: session already active this cycle",
        );
        continue;
      }
      const syntheticMsg = {
        id: randomUUID(),
        channelId: record.channelId,
        channelType: record.channelType,
        senderId: record.userId,
        text: "[system: daemon restarted after config change — session restored. Do NOT repeat, re-send, or re-execute anything from the previous conversation. Simply greet the user or wait for their next message.]",
        timestamp: Date.now(),
        attachments: [] as never[],
        metadata: { isRestartContinuation: true } as Record<string, unknown>,
      };
      channelManager.injectMessage(record.channelType, syntheticMsg).catch((injectErr) => {
        daemonLogger.warn(
          { err: injectErr, channelType: record.channelType, channelId: record.channelId, hint: "Continuation replay failed; user can re-send to resume", errorKind: "internal" as const },
          "Failed to replay continuation",
        );
      });
    }
  }

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
    lockCleanupTimer,  // quick-112: clear periodic lock cleanup timer
    dataDir: container.config.dataDir || dataDir,
    continuationTracker,
    lifecycleReactors,  // destroy lifecycle reactors on shutdown
    obsPersistence,  // drain write buffers before db.close
    geminiCacheManager,  // Dispose all Gemini caches on shutdown
  });

  // Wire shutdown ref for hot-add guard.
  shutdownRef.value = shutdownHandle;

  // 8.5. Health logging: subscribe to process metrics events
  container.eventBus.on("observability:metrics", async (metrics) => {
    // Prune prompt timeout timestamps to 5-minute window
    const fiveMinAgo = Date.now() - 5 * 60_000;
    while (promptTimeoutTimestamps.length > 0 && promptTimeoutTimestamps[0]! < fiveMinAgo) {
      promptTimeoutTimestamps.shift();
    }

    // Database size metrics for health monitoring
    let memoryDbSizeBytes: number | undefined;
    let memoryDbWalSizeBytes: number | undefined;
    try {
      const dbFilePath = db.name;
      if (dbFilePath) {
        memoryDbSizeBytes = statSync(dbFilePath).size;
        try {
          memoryDbWalSizeBytes = statSync(dbFilePath + "-wal").size;
        } catch { /* WAL file may not exist */ }
      }
    } catch { /* stat failure must not crash health check */ }

    // Compute sub-agent health metrics (threshold-aware split)
    const stuckKillThresholdMs = container.config.security.agentToAgent.subagentContext?.stuckKillThresholdMs ?? 180_000;
    const graphStuckKillThresholdMs = container.config.security.agentToAgent.subagentContext?.graphStuckKillThresholdMs ?? 600_000;
    const allRuns = subAgentRunner.listRuns();
    const now = Date.now();
    let activeSubAgentRuns = 0;
    let stuckSubAgentRuns = 0;
    for (const run of allRuns) {
      if (run.status !== "running") continue;
      activeSubAgentRuns++;
      const threshold = run.graphId ? graphStuckKillThresholdMs : stuckKillThresholdMs;
      if (threshold > 0 && (now - run.startedAt) > threshold) {
        stuckSubAgentRuns++;
      }
    }

    // Kill stuck sub-agents and track actual killed count.
    // Graph sub-agents get a longer threshold since they do multi-step analytical work.
    let stuckKilledThisTick = 0;
    if (stuckKillThresholdMs > 0 || graphStuckKillThresholdMs > 0) {
      for (const run of allRuns) {
        if (run.status !== "running") continue;
        const threshold = run.graphId ? graphStuckKillThresholdMs : stuckKillThresholdMs;
        if (threshold <= 0) continue;
        if ((now - run.startedAt) <= threshold) continue;
        subAgentRunner.killRun(run.runId);
        stuckKilledThisTick++;
        daemonLogger.warn({
          runId: run.runId,
          agentId: run.agentId,
          runtimeMs: now - run.startedAt,
          thresholdMs: threshold,
          isGraphRun: !!run.graphId,
          hint: run.graphId
            ? "Graph sub-agent exceeded graphStuckKillThresholdMs; force-killed by health handler. Adjust security.agentToAgent.subagentContext.graphStuckKillThresholdMs if needed."
            : "Sub-agent exceeded stuckKillThresholdMs; force-killed by health handler. Adjust security.agentToAgent.subagentContext.stuckKillThresholdMs if needed.",
          errorKind: "timeout" as const,
        }, "Stuck sub-agent killed by health handler");
      }
    }

    daemonLogger.debug({
      rssBytes: metrics.rssBytes,
      heapUsedBytes: metrics.heapUsedBytes,
      heapTotalBytes: metrics.heapTotalBytes,
      externalBytes: metrics.externalBytes,
      eventLoopP99Ms: Math.round(metrics.eventLoopDelayMs.p99 * 100) / 100,
      activeHandles: metrics.activeHandles,
      activeConnections: getActiveConnectionCount(),
      activeExecutions: activeExecutions.size,
      uptimeSeconds: Math.round(metrics.uptimeSeconds),
      // Resilience metrics
      activeSubAgentRuns,
      stuckSubAgentRuns,
      stuckKilledThisTick,
      deadLetterQueueSize: deadLetterQueue?.size() ?? 0,
      degradedProviders: [...providerHealth.getHealthSummary().entries()]
        .filter(([, v]) => v.degraded)
        .map(([k]) => k),
      promptTimeoutsLast5m: promptTimeoutTimestamps.length,
      // Database file size and delivery queue depth for health monitoring
      ...(memoryDbSizeBytes !== undefined && { memoryDbSizeBytes }),
      ...(memoryDbWalSizeBytes !== undefined && { memoryDbWalSizeBytes }),
      pendingDeliveryCount: await deliveryQueue.pendingEntries().then(r => r.ok ? r.value.length : 0),
    }, "Daemon health");
  });

  // 9. Startup banner
  daemonLogger.info({
    version: daemonVersion, agents: Object.keys(agents),
    channels: Array.from(adaptersByType.keys()),
    port: gwConfig.enabled ? gwConfig.port : undefined, instanceId,
    startupDurationMs: Date.now() - startupStartMs, configPaths, dbPath: db.name,
    logLevel: container.config.logLevel ?? "info", nodeVersion: process.versions.node,
    manifest: {
      secrets: { encrypted: !!secretStore },
      memory: { embedding: !!cachedPort, dbPath: db.name },
      agents: Object.fromEntries(
        Object.entries(agents).map(([id, cfg]) => [id, { model: cfg.model }]),
      ),
      skills: {
        tts: !!ttsAdapter,
        vision: visionRegistry ? [...visionRegistry.keys()] : [],
        linkUnderstanding: container.config.integrations.media.linkUnderstanding.enabled,
      },
      gateway: {
        enabled: gwConfig.enabled,
        port: gwConfig.enabled ? gwConfig.port : undefined,
        tls: !!gwConfig.tls?.certPath,
      },
    },
  }, "Comis daemon started");

  // Snapshot current config as last-known-good after successful startup
  if (configPaths.length > 0) {
    const activeConfigPath = configPaths[configPaths.length - 1]!;
    const lkg = saveLastKnownGood(activeConfigPath);
    if (lkg.saved) {
      daemonLogger.debug({ lkgPath: lkg.path }, "Last-known-good config snapshot saved");
    }
  }

  return {
    container, logger, logLevelManager, tokenTracker, latencyRecorder,
    processMonitor, shutdownHandle, watchdogHandle, cronSchedulers, resetSchedulers,
    browserServices, heartbeatRunner, gatewayHandle, adapterRegistry: adaptersByType,
    rpcCall, deviceIdentity, diagnosticCollector, billingEstimator,
    channelActivityTracker, deliveryTracer, approvalGate, channelHealthMonitor, sessionStoreBridge,
  };
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
