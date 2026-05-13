// SPDX-License-Identifier: Apache-2.0
/**
 * Daemon Entry Point: thin orchestrator calling setupXxx() factories in sequence.
 * @module
 */

import { bootstrap, loadEnvFile, createApprovalGate, parseFormattedSessionKey, createConfigGitManager, envSubset, generateStrongToken, createAuditAggregator, createInjectionRateLimiter, validateMemoryWrite, checkApprovalsConfig, safePath, resolveConfigSecretRefs, formatSessionKey, BackgroundTasksConfigSchema } from "@comis/core";
import type { SecretStorePort, WrapExternalContentOptions, PerAgentConfig, ToolCapabilityPort } from "@comis/core";
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
  setupBackgroundCompletionRunner,
  setupOutputRetention,
} from "./wiring/index.js";
import { setupSingleAgent } from "./wiring/setup-agents.js";
import { createActiveRunRegistry, createBackgroundSessionResolver, wireSessionStateCleanup, wireMcpDisconnectCleanup, createGeminiCacheManager, wireGeminiCacheCleanup, createSessionTrackerRegistry, validateProviderOverrides } from "@comis/agent";
// Phase 35 Plan 35-04 (D-01 #4/#5): createModelCatalog + resolveWorkspaceDir
// relocated from @comis/agent to @comis/core.
import { createModelCatalog, resolveWorkspaceDir } from "@comis/core";
import type { GeminiCacheManager } from "@comis/agent";
import { detectSandboxProvider, createImageGenProvider, createImageGenRateLimiter, createFileStateTracker } from "@comis/skills";
import type { SandboxProvider, ImageGenRateLimiter } from "@comis/skills";
import { createGraphCoordinator, createNodeTypeRegistry } from "./graph/index.js";
import { createChannelHealthMonitor, type ChannelHealthMonitor } from "@comis/channels";
import { createWakeCoalescer, createSystemEventQueue, type WakeReasonKind } from "@comis/scheduler";
import { createTokenRegistry } from "./api/token-handlers.js";
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
import { emitDockerRestartPolicyWarn } from "./setup-docker-restart-warn.js";
import { hasAnyOAuthAgent, emitOAuthTlsPreflightWarn } from "./wiring/oauth-preflight.js";
import { randomUUID, createHmac } from "node:crypto";
import { existsSync, chmodSync, statSync, mkdirSync, readFileSync, unlinkSync, cpSync } from "node:fs";
import { writeFile as fsWriteFile, rm } from "node:fs/promises";
import { createExecGit } from "./config/exec-git.js";
import { saveLastKnownGood, buildRollbackSuggestion, handleRestoreFlag } from "./config/last-known-good.js";
import { createRestartContinuationTracker, loadContinuations, buildMcpStatusLine } from "./wiring/restart-continuation.js";
import { createInboundMessageIdResolver, type InboundMessageIdResolver } from "./wiring/inbound-message-id-resolver.js";
import { logOperationModelDryRun } from "./wiring/startup-dry-run.js";
import os from "node:os";
import { dirname as pathDirname, resolve as pathResolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inspect } from "node:util";

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
 *
 * COMIS_* PRESERVATION (WR-08): `COMIS_DATA_DIR` and `COMIS_CONFIG_PATHS` are
 * INTENTIONALLY preserved across the scrub. They are filesystem-layout
 * pointers, not credentials -- subprocesses (MCP stdio servers, exec tools,
 * the apply-patch helper) need them to locate the daemon's data dir.
 *
 * Filesystem-layout pointers are still mildly sensitive (a misbehaving
 * subprocess could log them, surfacing the daemon's on-disk location). The
 * mitigation is per-spawn-site: untrusted-child spawns (exec-tool, MCP stdio
 * adapters, ffmpeg, etc.) MUST go through `envSubset(secretManager,
 * [...SUBPROCESS_SYSTEM])` -- see stageAgents line 1039 -- which yields a
 * minimal env (PATH, HOME, LANG, ...) and explicitly EXCLUDES COMIS_*. New
 * subprocess spawn sites MUST follow this pattern; do NOT pass `process.env`
 * directly to a child even after scrub, because COMIS_* values are still
 * present.
 */
function scrubProcessEnv(): void {
   
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
// Stage 1: foundation (DAEMON-API-06)
// ---------------------------------------------------------------------------

/**
 * Handle returned by `stageFoundation`. Consumed by later stages (stageAgents,
 * stageChannels, stageGateway, stageShutdown — Plans 04-07) and by the
 * remainder of `main()` until those stages absorb the destructure.
 *
 * Every field listed here is either:
 *   - consumed by a later stage call, OR
 *   - returned to callers via DaemonInstance, OR
 *   - read by main()'s tail (Plans 04-07 absorb these reads).
 */
export interface FoundationHandle {
  // Core (4 fields)
  container: Awaited<ReturnType<typeof bootstrap>> extends import("@comis/shared").Result<infer C, unknown> ? C : never;
  dataDir: string;
  configPaths: string[];
  envPath: string;
  // Secrets (4 fields)
  secretStore: SecretStorePort | undefined;
  secretsCrypto: import("@comis/core").SecretsCrypto | undefined;
  secretsDb: import("better-sqlite3").Database | undefined;
  permissionCorrections: PermissionCorrection[];
  // Config-git (2 fields)
  execGit: ReturnType<typeof createExecGit>;
  configGitManager: ReturnType<typeof createConfigGitManager> | undefined;
  // Logging (10 fields)
  logger: ReturnType<typeof setupLogging>["logger"];
  logLevelManager: ReturnType<typeof setupLogging>["logLevelManager"];
  daemonLogger: ReturnType<typeof setupLogging>["daemonLogger"];
  gatewayLogger: ReturnType<typeof setupLogging>["gatewayLogger"];
  channelsLogger: ReturnType<typeof setupLogging>["channelsLogger"];
  agentLogger: ReturnType<typeof setupLogging>["agentLogger"];
  schedulerLogger: ReturnType<typeof setupLogging>["schedulerLogger"];
  skillsLogger: ReturnType<typeof setupLogging>["skillsLogger"];
  memoryLogger: ReturnType<typeof setupLogging>["memoryLogger"];
  daemonVersion: string;
  // Observability (8 fields)
  tokenTracker: ReturnType<typeof setupObservability>["tokenTracker"];
  latencyRecorder: ReturnType<typeof setupObservability>["latencyRecorder"];
  sharedCostTracker: ReturnType<typeof setupObservability>["sharedCostTracker"];
  diagnosticCollector: ReturnType<typeof setupObservability>["diagnosticCollector"];
  billingEstimator: ReturnType<typeof setupObservability>["billingEstimator"];
  channelActivityTracker: ReturnType<typeof setupObservability>["channelActivityTracker"];
  deliveryTracer: ReturnType<typeof setupObservability>["deliveryTracer"];
  contextPipelineCollector: ReturnType<typeof createContextPipelineCollector>;
  // Process (3 fields)
  processMonitor: ReturnType<typeof setupHealth>["processMonitor"];
  watchdogHandle: ReturnType<typeof setupHealth>["watchdogHandle"];
  deviceIdentity: ReturnType<typeof setupHealth>["deviceIdentity"];
  // Memory + embedding (~11 fields)
  disposeEmbedding: Awaited<ReturnType<typeof setupMemory>>["disposeEmbedding"];
  cachedPort: Awaited<ReturnType<typeof setupMemory>>["cachedPort"];
  memoryAdapter: Awaited<ReturnType<typeof setupMemory>>["memoryAdapter"];
  db: Awaited<ReturnType<typeof setupMemory>>["db"];
  sessionStore: Awaited<ReturnType<typeof setupMemory>>["sessionStore"];
  memoryApi: Awaited<ReturnType<typeof setupMemory>>["memoryApi"];
  embeddingQueue: Awaited<ReturnType<typeof setupMemory>>["embeddingQueue"];
  backgroundIndexingPromise: Awaited<ReturnType<typeof setupMemory>>["backgroundIndexingPromise"];
  embeddingCacheStats: Awaited<ReturnType<typeof setupMemory>>["embeddingCacheStats"];
  embeddingCircuitBreakerState: Awaited<ReturnType<typeof setupMemory>>["embeddingCircuitBreakerState"];
  maintenanceTick: Awaited<ReturnType<typeof setupMemory>>["maintenanceTick"];
  obsStore: ObservabilityStore | undefined;
  obsPersistence: ObsPersistenceResult | undefined;
  contextStore: ReturnType<typeof createContextStore>;
  // Runtime registries (4 fields)
  activeRunRegistry: ReturnType<typeof createActiveRunRegistry>;
  sessionResolver: ReturnType<typeof createBackgroundSessionResolver>;
  canaryFallbackSecret: string;
  injectionRateLimiter: ReturnType<typeof createInjectionRateLimiter>;
  // Session mirroring (3 fields)
  deliveryMirror: Awaited<ReturnType<typeof setupDeliveryMirror>>["deliveryMirror"];
  startMirrorPrune: Awaited<ReturnType<typeof setupDeliveryMirror>>["startPrune"];
  shutdownMirror: Awaited<ReturnType<typeof setupDeliveryMirror>>["shutdown"];
  // Gemini cache (1 field)
  geminiCacheManager: GeminiCacheManager;
  // Deferred refs populated by later stages
  channelPluginsRef: { ref?: Map<string, import("@comis/core").ChannelPluginPort> };
  backgroundTaskManager: ReturnType<typeof setupBackgroundTasks>["backgroundTaskManager"];
  bgNotifyRef: { ref?: import("./notification/notification-service.js").NotificationService };
  bgNotifyFn: (opts: { agentId: string; message: string; priority: "normal"; origin: "background_task" }) => Promise<void>;
}

/**
 * Seed the bundled skill-creator skill into the user's data directory.
 * Idempotent: only writes if the destination is missing OR the bundled
 * version is newer than the installed version (frontmatter `version:` field).
 *
 * Extracted from `main()` (Phase 34 commit 3) to keep `stageFoundation`
 * under the DAEMON-API-06 200-line cap. Lifted verbatim from the original
 * inline block (36 lines) -- no behavior change.
 */
function seedBundledSkillCreator(deps: {
  dataDir: string;
  agentLogger: ReturnType<typeof setupLogging>["agentLogger"];
}): void {
  const { dataDir, agentLogger } = deps;
  const skillsTarget = safePath(dataDir, "skills");
  const skillCreatorDest = safePath(skillsTarget, "skill-creator");
  const __filename = fileURLToPath(import.meta.url);
  const bundledSrc = pathResolve(__filename, "../../bundled-skills/skill-creator");
  if (!existsSync(bundledSrc)) return;
  const bundledSkillMd = safePath(bundledSrc, "SKILL.md");
  const installedSkillMd = safePath(skillCreatorDest, "SKILL.md");
  let shouldSeed = !existsSync(skillCreatorDest);
  if (!shouldSeed && existsSync(bundledSkillMd) && existsSync(installedSkillMd)) {
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

/**
 * Bootstrap secrets and build merged-env / process.env scrub. Extracted from
 * stageFoundation to fit the DAEMON-API-06 ≤200-line cap. Returns a bundle of
 * the secret store + crypto + db handle and the merged-env map. The control
 * flow (decryptAll throws → fatal; null secretsBootResult → no-op) is the same
 * as the original inline form.
 *
 * Implements DAEMON-API-09 refs #1-#4 (mergedEnv / secretStore / secretsCrypto
 * / secretsDb) via single-IIFE init.
 */
function bootstrapSecretsAndEnv(deps: {
  setupSecrets: typeof _setupSecretsImpl;
  dataDir: string;
}): {
  mergedEnv: Record<string, string | undefined>;
  secretStore: SecretStorePort | undefined;
  secretsCrypto: import("@comis/core").SecretsCrypto | undefined;
  secretsDb: import("better-sqlite3").Database | undefined;
} {
  const secretsBootResult = deps.setupSecrets({
    env: process.env as Record<string, string | undefined>,
    dataDir: deps.dataDir,
  });
  if (!secretsBootResult.ok) {
    throw new Error(`Secrets bootstrap failed: ${secretsBootResult.error.message}`);
  }
  if (secretsBootResult.value === null) {
    return {
      mergedEnv: process.env as Record<string, string | undefined>,
      secretStore: undefined,
      secretsCrypto: undefined,
      secretsDb: undefined,
    };
  }
  const { crypto, dbPath } = secretsBootResult.value;
  const store = createSqliteSecretStore(dbPath, crypto);
  const decryptResult = store.decryptAll();
  if (!decryptResult.ok) {
    throw new Error(`Secret decryption failed: ${decryptResult.error.message}`);
  }
  const merged: Record<string, string | undefined> = {};
  for (const [name, value] of decryptResult.value) merged[name] = value;
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) merged[key] = value;
  }
  scrubProcessEnv();
  return {
    mergedEnv: merged,
    secretStore: store as SecretStorePort,
    secretsCrypto: crypto,
    secretsDb: store.db,
  };
}

/**
 * Build a `ConfigGitManager` bound to `configDir` (or `undefined` if no config
 * file was resolved). Extracted from stageFoundation to fit the DAEMON-API-06
 * ≤200-line cap.
 */
function wireConfigGitManager(deps: {
  configDir: string;
  execGit: ReturnType<typeof createExecGit>;
}): ReturnType<typeof createConfigGitManager> | undefined {
  if (!deps.configDir) return undefined;
  return createConfigGitManager({
    configDir: deps.configDir,
    execGit: deps.execGit,
    writeFile: async (relativePath, content) => {
      try {
        const targetPath = safePath(deps.configDir, relativePath);
        await fsWriteFile(targetPath, content, "utf-8");
        return ok(undefined);
      } catch (e: unknown) {
        return err(e instanceof Error ? e.message : String(e));
      }
    },
    removeDir: async (relativePath) => {
      try {
        const targetPath = safePath(deps.configDir, relativePath);
        await rm(targetPath, { recursive: true, force: true });
        return ok(undefined);
      } catch (e: unknown) {
        return err(e instanceof Error ? e.message : String(e));
      }
    },
  });
}

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
 * Body extracted from main() lines 296→~599. Hard cap: ≤200 lines AST-measured
 * (DAEMON-API-06). Per-line-source order preserved so daemon-lifecycle.test.ts
 * log-sequence assertions remain green.
 *
 * Implements DAEMON-API-06 (part 1 of 5) and DAEMON-API-09 (refs #1-#7).
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

  // 0.5. Decrypt secrets, merge with env, scrub process.env (DAEMON-API-09 #1-#4)
  const permissionCorrections = hardenDataDirPermissions(dataDir);
  const { mergedEnv, secretStore, secretsCrypto, secretsDb } = bootstrapSecretsAndEnv({
    setupSecrets: _setupSecrets,
    dataDir,
  });

  // 1. Bootstrap core container
  // eslint-disable-next-line no-restricted-syntax -- process.env access needed before SecretManager for config path resolution
  const rawConfigPaths = process.env["COMIS_CONFIG_PATHS"];
  const configPaths = (rawConfigPaths ? rawConfigPaths.split(":") : DEFAULT_CONFIG_PATHS)
    .filter((p) => existsSync(p));
  const bootResult = _bootstrap({ configPaths, env: mergedEnv });
  if (!bootResult.ok) {
    throw new Error(`Bootstrap failed: ${bootResult.error.message}`);
  }
  // DAEMON-API-09 ref #5: container via const+resolve-then-spread
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
  } = await setupMemory({ container, memoryLogger });

  // Observability persistence (dual-write to SQLite)
  // DAEMON-API-09 refs #6/#7: obsStore + obsPersistence via const+IIFE
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
  const obsStore = obsBundle?.obsStore;
  const obsPersistence = obsBundle?.obsPersistence;

  // Create context store + daemon-level runtime registries
  const contextStore = createContextStore(db);
  const activeRunRegistry = createActiveRunRegistry();
  const sessionResolver = createBackgroundSessionResolver({ activeRunRegistry });
  const canaryFallbackSecret = createHmac("sha256", container.config.tenantId)
    .update("comis:canary-fallback")
    .digest("hex");
  const injectionRateLimiter = createInjectionRateLimiter();

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
  });

  // Deferred channel plugins ref (populated after setupChannels)
  const channelPluginsRef: { ref?: Map<string, import("@comis/core").ChannelPluginPort> } = {};

  // 6.5.1. Background task system (created before setupAgents)
  const { backgroundTaskManager } = setupBackgroundTasks({
    dataDir,
    eventBus: container.eventBus,
    logger: logLevelManager.getLogger("background-tasks"),
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
// Stage 2: agents (DAEMON-API-06 part 2 / Plan 34-04)
// ---------------------------------------------------------------------------

/**
 * Handle returned by `stageAgents`. Extends `FoundationHandle` so main() and
 * later stages can keep a single destructure surface.
 *
 * Plan 34-04 extracts the agent-runtime startup block (agents map, executors,
 * mcpClientManager, schedulers, media, RPC bridge, approval gate with restore,
 * delivery queue) from main() into stageAgents. cronWakeCallbackRef is a
 * deferred-ref slot populated by stageChannels (Plan 05) once wakeCoalescer
 * is constructed.
 */
export interface AgentsHandle extends FoundationHandle {
  // Agents (core)
  defaultAgentId: string;
  defaultWorkspaceDir: string;
  agentsConfig: Record<string, PerAgentConfig>;
  sessionManager: Awaited<ReturnType<typeof setupAgents>>["sessionManager"];
  executors: Awaited<ReturnType<typeof setupAgents>>["executors"];
  workspaceDirs: Awaited<ReturnType<typeof setupAgents>>["workspaceDirs"];
  costTrackers: Awaited<ReturnType<typeof setupAgents>>["costTrackers"];
  budgetGuards: Awaited<ReturnType<typeof setupAgents>>["budgetGuards"];
  stepCounters: Awaited<ReturnType<typeof setupAgents>>["stepCounters"];
  getExecutor: Awaited<ReturnType<typeof setupAgents>>["getExecutor"];
  piSessionAdapters: Awaited<ReturnType<typeof setupAgents>>["piSessionAdapters"];
  skillWatcherHandles: Awaited<ReturnType<typeof setupAgents>>["skillWatcherHandles"];
  skillRegistries: Awaited<ReturnType<typeof setupAgents>>["skillRegistries"];
  lockCleanupTimer: Awaited<ReturnType<typeof setupAgents>>["lockCleanupTimer"];
  singleAgentDeps: Awaited<ReturnType<typeof setupAgents>>["singleAgentDeps"];
  providerHealth: Awaited<ReturnType<typeof setupAgents>>["providerHealth"];
  oauthCredentialStore: Awaited<ReturnType<typeof setupAgents>>["oauthCredentialStore"];
  toolCapabilityPorts: Awaited<ReturnType<typeof setupAgents>>["toolCapabilityPorts"];
  mcpClientManager: Awaited<ReturnType<typeof setupMcp>>["mcpClientManager"];
  // Restart continuation tracker
  continuationTracker: ReturnType<typeof createRestartContinuationTracker>;
  // Subprocess envs
  subprocessEnv: Record<string, string>;
  execToolEnv: Record<string, string>;
  // Schedulers
  systemEventQueue: ReturnType<typeof createSystemEventQueue>;
  cronSchedulers: Awaited<ReturnType<typeof setupSchedulers>>["cronSchedulers"];
  executionTrackers: Awaited<ReturnType<typeof setupSchedulers>>["executionTrackers"];
  browserServices: Awaited<ReturnType<typeof setupSchedulers>>["browserServices"];
  resetSchedulers: Awaited<ReturnType<typeof setupSchedulers>>["resetSchedulers"];
  getAgentCronScheduler: Awaited<ReturnType<typeof setupSchedulers>>["getAgentCronScheduler"];
  getAgentBrowserService: Awaited<ReturnType<typeof setupSchedulers>>["getAgentBrowserService"];
  sessionTrackerRegistry: import("@comis/agent").SessionTrackerRegistry<ReturnType<typeof createFileStateTracker>>;
  extractFromConversation: ReturnType<typeof setupTaskExtraction>["extractFromConversation"];
  auditAggregator: ReturnType<typeof createAuditAggregator>;
  onSuspiciousContent: WrapExternalContentOptions["onSuspiciousContent"];
  // Media
  ttsAdapter: Awaited<ReturnType<typeof setupMedia>>["ttsAdapter"];
  visionRegistry: Awaited<ReturnType<typeof setupMedia>>["visionRegistry"];
  linkRunner: Awaited<ReturnType<typeof setupMedia>>["linkRunner"];
  mediaTempManager: Awaited<ReturnType<typeof setupMedia>>["mediaTempManager"];
  mediaSemaphore: Awaited<ReturnType<typeof setupMedia>>["mediaSemaphore"];
  audioConverter: Awaited<ReturnType<typeof setupMedia>>["audioConverter"];
  transcriber: Awaited<ReturnType<typeof setupMedia>>["transcriber"];
  ssrfFetcher: Awaited<ReturnType<typeof setupMedia>>["ssrfFetcher"];
  fileExtractor: Awaited<ReturnType<typeof setupMedia>>["fileExtractor"];
  // RPC bridge (deferred-dispatch)
  rpcCall: ReturnType<typeof setupRpcBridge>["rpcCall"];
  wireDispatch: ReturnType<typeof setupRpcBridge>["wireDispatch"];
  // Approval gate
  approvalGate: ReturnType<typeof createApprovalGate>;
  // Delivery queue
  channelAdaptersRef: Map<string, import("@comis/core").DeliveryAdapter>;
  deliveryQueue: Awaited<ReturnType<typeof setupDeliveryQueue>>["deliveryQueue"];
  drainAndStartDeliveryPrune: Awaited<ReturnType<typeof setupDeliveryQueue>>["drainAndStart"];
  shutdownDeliveryQueue: Awaited<ReturnType<typeof setupDeliveryQueue>>["shutdown"];
  // Deferred wake-callback ref (populated in stageChannels post-wakeCoalescer)
  cronWakeCallbackRef: { ref?: (reason: string) => void };
}

/**
 * Restore approval pending requests and cache from disk at startup.
 *
 * Extracted from the original daemon.ts approval-restore block (39L) to keep
 * `stageAgents` under the DAEMON-API-06 ≤200L cap. Reads
 * `<dataDir>/restart-approvals.json` and `<dataDir>/restart-approval-cache.json`
 * (written by graceful shutdown), restores into the in-memory ApprovalGate,
 * then deletes the files. Best-effort on JSON parse failure: log warn + unlink.
 */
function restoreApprovalState(deps: {
  approvalGate: ReturnType<typeof createApprovalGate>;
  dataDir: string;
  containerDataDir: string | undefined;
  daemonLogger: ReturnType<typeof setupLogging>["daemonLogger"];
}): void {
  const { approvalGate, dataDir, containerDataDir, daemonLogger } = deps;
  // 6.6.8.6.1. Restore pending approvals from previous restart
  const approvalRestorePath = safePath(containerDataDir || dataDir, "restart-approvals.json");
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
  const approvalCacheRestorePath = safePath(containerDataDir || dataDir, "restart-approval-cache.json");
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
}

/**
 * Construct the daemon-global MCP client manager. Hoisted to its own helper
 * to fit stageAgents under DAEMON-API-06 ≤200L. The manager is a pure
 * in-memory state holder (no I/O), so construction is safe before any
 * server-connect attempts and BEFORE setupAgents (per-agent
 * ToolCapabilityPort adapter construction closes over the manager).
 */
async function setupMcpManager(deps: {
  container: Awaited<ReturnType<typeof bootstrap>> extends import("@comis/shared").Result<infer C, unknown> ? C : never;
  skillsLogger: ReturnType<typeof setupLogging>["skillsLogger"];
  defaultWorkspaceDir: string;
}): Promise<Awaited<ReturnType<typeof setupMcp>>["mcpClientManager"]> {
  const { container, skillsLogger, defaultWorkspaceDir } = deps;
  const { mcpClientManager } = await setupMcp({
    servers: container.config.integrations.mcp.servers,
    logger: skillsLogger,
    callToolTimeoutMs: container.config.integrations.mcp.callToolTimeoutMs,
    defaultCwd: defaultWorkspaceDir,
    eventBus: container.eventBus,
    stdioDefaultConcurrency: container.config.integrations.mcp.stdioDefaultConcurrency,
    httpDefaultConcurrency: container.config.integrations.mcp.httpDefaultConcurrency,
  });
  return mcpClientManager;
}

/**
 * Wire post-setupAgents cleanup listeners: session:expired releases
 * sessionTrackerRegistry, Gemini cache disposal, and MCP disconnect cleanup.
 * Schedules an orphan-cache cleanup pass for any stale comis:* caches.
 *
 * Extracted from stageAgents to fit the DAEMON-API-06 ≤200L cap.
 */
function wirePostAgentsCleanup(deps: {
  eventBus: Awaited<ReturnType<typeof bootstrap>> extends import("@comis/shared").Result<infer C, unknown> ? C extends { eventBus: infer EB } ? EB : never : never;
  geminiCacheManager: GeminiCacheManager;
  daemonLogger: ReturnType<typeof setupLogging>["daemonLogger"];
}): import("@comis/agent").SessionTrackerRegistry<ReturnType<typeof createFileStateTracker>> {
  const { eventBus, geminiCacheManager, daemonLogger } = deps;
  // Clean up all session-scoped state on session expiry
  wireSessionStateCleanup(eventBus);
  // Per-session FileStateTracker pool -- keeps the LLM's file read state alive
  // across turns. Registered trackers are released on session:expired.
  const sessionTrackerRegistry = createSessionTrackerRegistry(createFileStateTracker);
  eventBus.on("session:expired", (payload) => {
    sessionTrackerRegistry.release(formatSessionKey(payload.sessionKey));
  });
  // Dispose Gemini cache on session expiry (fire-and-forget)
  wireGeminiCacheCleanup(eventBus, geminiCacheManager);
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
  wireMcpDisconnectCleanup(eventBus);
  return sessionTrackerRegistry;
}

/**
 * Build the audit aggregator + onSuspiciousContent reporter pair used by
 * stageAgents and threaded into setupMedia. Extracted to keep stageAgents
 * under the DAEMON-API-06 ≤200L cap.
 */
function buildAuditBundle(deps: {
  eventBus: Awaited<ReturnType<typeof bootstrap>> extends import("@comis/shared").Result<infer C, unknown> ? C extends { eventBus: infer EB } ? EB : never : never;
  skillsLogger: ReturnType<typeof setupLogging>["skillsLogger"];
}): {
  auditAggregator: ReturnType<typeof createAuditAggregator>;
  onSuspiciousContent: WrapExternalContentOptions["onSuspiciousContent"];
} {
  const auditAggregator = createAuditAggregator(deps.eventBus, undefined, deps.skillsLogger);
  const onSuspiciousContent: WrapExternalContentOptions["onSuspiciousContent"] = (info) => {
    auditAggregator.record({ source: "external_content", patterns: info.patterns });
  };
  return { auditAggregator, onSuspiciousContent };
}

/**
 * Build the onCronWake callback handed to setupSchedulers. Reads
 * `cronWakeCallbackRef.ref` at INVOCATION time (deferred), so the live
 * wakeCoalescer wired up later in stageChannels is what actually receives
 * the wake. If a cron fires in the gap between stageAgents returning and
 * stageChannels populating the ref (typically milliseconds, but a heavy
 * startup may stretch it to seconds), surface the drop with a debug log
 * line so the silent miss is visible (WR-07).
 *
 * Observability-only: we intentionally do NOT buffer-then-drain (the
 * precedent set by channelPluginsRef / bgNotifyRef etc.). Cron wakes are
 * timer-driven; replaying a backlog could cause a wake storm if N timers
 * fired during a slow startup.
 *
 * Extracted from stageAgents to keep it under the DAEMON-API-06 ≤200L cap.
 */
function buildDeferredCronWakeCallback(
  cronWakeCallbackRef: { ref?: (reason: string) => void },
  daemonLogger: ReturnType<typeof setupLogging>["daemonLogger"],
): (reason: string) => void {
  return (reason: string) => {
    const callback = cronWakeCallbackRef.ref;
    if (callback) {
      callback(reason);
    } else {
      daemonLogger.debug(
        { reason, hint: "wakeCoalescer not yet constructed; cron wake dropped" },
        "Cron wake dropped during stage handoff",
      );
    }
  };
}

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
 * Body extracted from main() lines 793→1031 of the post-Plan-03 daemon.ts. Hard
 * cap: ≤200 lines AST-measured (DAEMON-API-06). Per-line-source order preserved
 * so daemon-lifecycle.test.ts log-sequence assertions remain green ("Agent
 * executor initialized", "Per-agent CronScheduler started").
 *
 * mcpClientManager construction order is preserved (BEFORE setupAgents). Per
 * RESEARCH §"stageAgents" lines 339-341: production-correctness constraint --
 * do not invert.
 *
 * Implements DAEMON-API-06 (part 2 of 5) and DAEMON-API-11 (commit 2 of 5).
 */
async function stageAgents(input: {
  overrides: DaemonOverrides;
  foundation: FoundationHandle;
}): Promise<AgentsHandle> {
  const { overrides, foundation } = input;
  const {
    container, dataDir,
    daemonLogger, gatewayLogger, agentLogger, schedulerLogger, skillsLogger,
    memoryAdapter, db, sessionStore, cachedPort, embeddingQueue,
    contextStore,
    activeRunRegistry, canaryFallbackSecret, injectionRateLimiter,
    deliveryMirror, geminiCacheManager,
    channelPluginsRef, backgroundTaskManager, bgNotifyFn,
    secretsCrypto, secretsDb,
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
    // hot-add / hot-remove.
    toolCapabilityPorts,
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
    // Plumb the secrets bootstrap result through so setup-agents can wire the
    // OAuth credential store. encrypted-mode shares the existing
    // better-sqlite3 connection (no dual-handle).
    secretsCrypto,
    secretsDb,
    // Daemon-global MCP manager threaded into setupSingleAgent for
    // per-agent ToolCapabilityPort adapter construction.
    mcpClientManager,
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

  // Deferred wake callback ref -- populated by stageChannels (Plan 05) once
  // wakeCoalescer is constructed. Same shape as channelPluginsRef / bgNotifyRef
  // (DAEMON-API-09 cross-stage deferred-ref pattern).
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
    cronWakeCallbackRef,
  };
}

// ---------------------------------------------------------------------------
// Stage 3: channels (DAEMON-API-06 part 3 / Plan 34-05)
// ---------------------------------------------------------------------------

/**
 * Handle returned by `stageChannels`. Extends `AgentsHandle` so main() and
 * later stages keep a single destructure surface.
 *
 * Plan 34-05 extracts the channel-runtime startup block (channel adapters,
 * cross-session sender + subAgentRunner, sandbox/image-gen providers, tools,
 * heartbeat, wake coalescer, graph coordinator, monitoring, agent management
 * runtime state) from main() into stageChannels. The deferred cronWakeCallback
 * ref (DAEMON-API-09 ref #8) is populated inside stageChannels once
 * wakeCoalescer is constructed.
 */
export interface ChannelsHandle extends AgentsHandle {
  // Channels (core)
  adaptersByType: Awaited<ReturnType<typeof setupChannels>>["adaptersByType"];
  channelManager: Awaited<ReturnType<typeof setupChannels>>["channelManager"];
  resolveAttachment: Awaited<ReturnType<typeof setupChannels>>["resolveAttachment"];
  lifecycleReactors: Awaited<ReturnType<typeof setupChannels>>["lifecycleReactors"];
  channelPlugins: Awaited<ReturnType<typeof setupChannels>>["channelPlugins"];
  channelCapabilities: Awaited<ReturnType<typeof setupChannels>>["channelCapabilities"];
  commandQueue: Awaited<ReturnType<typeof setupChannels>>["commandQueue"];
  deliveryService: Awaited<ReturnType<typeof setupChannels>>["deliveryService"];
  inboundMessageIdResolver: InboundMessageIdResolver;
  // Channel health monitor (refs #10 + #11 subsumed by helper return value)
  channelHealthMonitor: ChannelHealthMonitor | undefined;
  stopChannelHealthMonitor: (() => void) | undefined;
  // Notifications + background completion
  notificationContext: ReturnType<typeof setupNotifications>;
  bgCompletionRunnerContext: ReturnType<typeof setupBackgroundCompletionRunner>;
  // Cross-session + sub-agent runtime
  crossSessionSender: ReturnType<typeof setupCrossSession>["crossSessionSender"];
  subAgentRunner: ReturnType<typeof setupCrossSession>["subAgentRunner"];
  sendToChannel: ReturnType<typeof setupCrossSession>["sendToChannel"];
  announceToParent: ReturnType<typeof setupCrossSession>["announceToParent"];
  deadLetterQueue: ReturnType<typeof setupCrossSession>["deadLetterQueue"];
  announcementBatcher: ReturnType<typeof setupCrossSession>["announcementBatcher"];
  gatewaySendRef: { ref?: (channelId: string, text: string) => boolean };
  // Sandbox + image generation
  sandboxProvider: SandboxProvider | undefined;
  imageGenProvider: ReturnType<typeof createImageGenProvider> extends import("@comis/shared").Result<infer P, unknown> ? P | undefined : never;
  imageGenRateLimiter: ImageGenRateLimiter | undefined;
  imageGenConfig: AgentsHandle["container"]["config"]["integrations"]["media"]["imageGeneration"];
  // Tools (assembler + preprocessor)
  assembleToolsForAgent: ReturnType<typeof setupTools>["assembleToolsForAgent"];
  preprocessMessageText: ReturnType<typeof setupTools>["preprocessMessageText"];
  getCapabilityPortForAgent: (agentId: string) => ToolCapabilityPort;
  // Monitoring + heartbeat
  heartbeatRunner: ReturnType<typeof setupMonitoring>["heartbeatRunner"];
  duplicateDetector: ReturnType<typeof setupMonitoring>["duplicateDetector"];
  perAgentRunner: ReturnType<typeof setupHeartbeat>["perAgentRunner"];
  wakeCoalescer: ReturnType<typeof createWakeCoalescer>;
  // Graph
  nodeTypeRegistry: ReturnType<typeof createNodeTypeRegistry>;
  graphCoordinator: ReturnType<typeof createGraphCoordinator>;
  namedGraphStore: ReturnType<typeof createNamedGraphStore>;
  // Agent management runtime state
  suspendedAgents: Set<string>;
  modelCatalog: ReturnType<typeof createModelCatalog>;
  channelConfig: Record<string, { enabled: boolean }>;
  promptTimeoutTimestamps: number[];
}

/**
 * Build the deps object passed to `setupChannels`. Lifted from the inline
 * argument-construction block inside stageChannels to keep the stage body
 * under the DAEMON-API-06 ≤200L cap (helper itself ≤50L per DAEMON-API-07).
 *
 * All closure inputs flow through `deps`. The returned object is consumed
 * verbatim by `setupChannels(...)`; no inline mutation here.
 */
function buildChannelManagerDeps(deps: {
  agents: AgentsHandle;
  toolAssemblerRef: { ref?: (agentId: string, options?: import("./wiring/setup-tools.js").AssembleToolsOptions) => Promise<unknown[]> };
  inboundMessageIdResolverRef: { ref?: InboundMessageIdResolver };
  sessionTrackerRef: { ref?: import("./notification/session-tracker.js").SessionTracker };
}): Parameters<typeof setupChannels>[0] {
  const { agents, toolAssemblerRef, inboundMessageIdResolverRef, sessionTrackerRef } = deps;
  const {
    container, executors, defaultAgentId, sessionManager, sessionStore,
    logger, channelsLogger, linkRunner, ssrfFetcher, transcriber,
    ttsAdapter, audioConverter, mediaTempManager, mediaSemaphore, fileExtractor,
    workspaceDirs, defaultWorkspaceDir, memoryAdapter, embeddingQueue,
    activeRunRegistry, sessionResolver, rpcCall, extractFromConversation,
    continuationTracker, approvalGate,
    piSessionAdapters, costTrackers, deliveryQueue, executionTrackers,
  } = agents;
  return {
    container, executors, defaultAgentId, sessionManager, sessionStore,
    logger, channelsLogger,
    linkRunner, ssrfFetcher, transcriber,
    maxMediaBytes: container.config.integrations.media.infrastructure.maxRemoteFetchBytes,
    /* eslint-disable @typescript-eslint/no-explicit-any -- matches assembleToolsForAgent signature from setup-tools.ts */
    assembleToolsForAgent: (agentId: string, options?: { sessionKey?: import("@comis/core").SessionKey }): Promise<any[]> =>
      toolAssemblerRef.ref ? toolAssemblerRef.ref(agentId, options) as Promise<any[]> : Promise.resolve([]),
    /* eslint-enable @typescript-eslint/no-explicit-any */
    ttsAdapter, audioConverter, mediaTempManager, mediaSemaphore,
    fileExtractor, fileExtractionConfig: container.config.integrations.media.documentExtraction,
    workspaceDirs, defaultWorkspaceDir, memoryAdapter,
    tenantId: container.config.tenantId,
    embeddingQueue, queueConfig: container.config.queue,
    activeRunRegistry, sessionResolver, rpcCall,
    onTaskExtraction: extractFromConversation,
    onMessageReceived: (msg, channelType) => {
      const chatType = typeof msg.metadata?.telegramChatType === "string"
        ? msg.metadata.telegramChatType
        : undefined;
      continuationTracker.track({
        agentId: defaultAgentId, channelType, channelId: msg.channelId,
        userId: msg.senderId, chatType, tenantId: container.config.tenantId, timestamp: Date.now(),
      });
      inboundMessageIdResolverRef.ref?.record(msg, channelType);
    },
    onMessageProcessed: (msg, channelType) => {
      sessionTrackerRef.ref?.recordActivity(defaultAgentId, channelType, msg.channelId);
    },
    approvalGate: container.config.approvals?.enabled ? approvalGate : undefined,
    piSessionAdapters, costTrackers, deliveryQueue,
    cronExecutionTrackers: executionTrackers,
  };
}

/**
 * Build the deps object passed to `createGraphCoordinator`. Lifted from the
 * inline argument-construction block inside stageChannels to keep the stage
 * body under the DAEMON-API-06 ≤200L cap (helper itself ≤50L per
 * DAEMON-API-07).
 */
function buildGraphCoordinatorDeps(deps: {
  agents: AgentsHandle;
  channels: {
    subAgentRunner: ReturnType<typeof setupCrossSession>["subAgentRunner"];
    sendToChannel: ReturnType<typeof setupCrossSession>["sendToChannel"];
    announceToParent: ReturnType<typeof setupCrossSession>["announceToParent"];
    announcementBatcher: ReturnType<typeof setupCrossSession>["announcementBatcher"];
    commandQueue: Awaited<ReturnType<typeof setupChannels>>["commandQueue"];
    assembleToolsForAgent: ReturnType<typeof setupTools>["assembleToolsForAgent"];
    nodeTypeRegistry: ReturnType<typeof createNodeTypeRegistry>;
  };
}): Parameters<typeof createGraphCoordinator>[0] {
  const { agents, channels } = deps;
  const { container, defaultAgentId, dataDir, agentLogger, activeRunRegistry, agentsConfig } = agents;
  const a2aSec = container.config.security.agentToAgent as Record<string, unknown>;
  return {
    subAgentRunner: channels.subAgentRunner, eventBus: container.eventBus,
    sendToChannel: channels.sendToChannel, announceToParent: channels.announceToParent,
    batcher: channels.announcementBatcher, tenantId: container.config.tenantId, defaultAgentId,
    maxConcurrency: (a2aSec.graphMaxConcurrency as number | undefined) ?? 4,
    maxResultLength: a2aSec.graphMaxResultLength as number | undefined,
    maxGlobalSubAgents: a2aSec.graphMaxGlobalSubAgents as number | undefined,
    logger: agentLogger?.child?.({ submodule: "graph-coordinator" }),
    dataDir: container.config.dataDir || dataDir,
    nodeTypeRegistry: channels.nodeTypeRegistry, activeRunRegistry,
    assembleToolsForAgent: async (agentId: string) => {
      const tools = await channels.assembleToolsForAgent(agentId);
      return tools.map((t: { name: string; description?: string; inputSchema?: unknown }) => ({
        name: t.name, description: t.description, inputSchema: t.inputSchema,
      }));
    },
    touchParentSession: channels.commandQueue
      ? (sessionKey: string) => channels.commandQueue!.touchLane(sessionKey)
      : undefined,
    preWarm: buildGraphPreWarm({ agentsConfig, defaultAgentId, secretManager: container.secretManager }),
  };
}

/**
 * Build the optional pre-warm cache config for Anthropic graph executions.
 * Returns undefined if no Anthropic API key is resolvable. Extracted from
 * buildGraphCoordinatorDeps to keep both helpers under DAEMON-API-07 ≤50L.
 */
function buildGraphPreWarm(deps: {
  agentsConfig: AgentsHandle["agentsConfig"];
  defaultAgentId: string;
  secretManager: AgentsHandle["container"]["secretManager"];
}): NonNullable<Parameters<typeof createGraphCoordinator>[0]["preWarm"]> | undefined {
  const { agentsConfig, defaultAgentId, secretManager } = deps;
  const agentCfg = agentsConfig[defaultAgentId];
  const provider = agentCfg?.provider ?? "anthropic";
  const resolvedModel = agentCfg?.model === "default" || !agentCfg?.model
    ? "claude-sonnet-4-5-20250929"
    : agentCfg.model;
  const apiKey = secretManager.get("anthropic-api-key") ?? secretManager.get("ANTHROPIC_API_KEY") ?? "";
  if (!apiKey) return undefined;
  return {
    provider, modelId: resolvedModel, apiKey,
    systemPrompt: agentCfg?.name
      ? `You are ${agentCfg.name}. You are a helpful AI assistant.`
      : "You are a helpful AI assistant.",
    tools: [] as Array<{ name: string; description?: string; inputSchema?: unknown }>,
  };
}

/**
 * Set up the channel health monitor. Returns `{ monitor, stop }`, subsuming
 * today's `let channelHealthMonitor` + `let stopChannelHealthMonitor`
 * (DAEMON-API-09 refs #10 + #11) into a single helper return value -- both
 * `let`s disappear from stageChannels.
 *
 * Extracted to keep stageChannels under the DAEMON-API-06 ≤200L cap.
 */
function setupChannelHealthMonitor(deps: {
  adaptersByType: Awaited<ReturnType<typeof setupChannels>>["adaptersByType"];
  daemonLogger: ReturnType<typeof setupLogging>["daemonLogger"];
  container: AgentsHandle["container"];
}): { monitor: ChannelHealthMonitor | undefined; stop: (() => void) | undefined } {
  const { adaptersByType, daemonLogger, container } = deps;
  const healthCheckConfig = container.config.channels?.healthCheck;
  if (healthCheckConfig?.enabled === false) return { monitor: undefined, stop: undefined };
  const monitor = createChannelHealthMonitor({
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
  const stop = monitor.start(adaptersByType);
  return { monitor, stop };
}

/**
 * Factory: resolve a `ToolCapabilityPort` for an agentId; falls back to the
 * default agent's port. Throws if neither is registered (mirrors setup-tools.ts
 * `agents[agentId] ?? agents[defaultAgentId]` convention).
 *
 * Extracted to keep stageChannels under the DAEMON-API-06 ≤200L cap. The
 * original 17L closure is logically a factory; factory form is clearer.
 */
function createCapabilityPortResolver(
  toolCapabilityPorts: Map<string, ToolCapabilityPort>,
  defaultAgentId: string,
): (agentId: string) => ToolCapabilityPort {
  return (agentId: string) => {
    const port = toolCapabilityPorts.get(agentId) ?? toolCapabilityPorts.get(defaultAgentId);
    if (!port) {
      throw new Error(
        `No ToolCapabilityPort registered for agent '${agentId}' and no default agent ('${defaultAgentId}') fallback available -- the agent may have been removed or the daemon failed to initialize.`,
      );
    }
    return port;
  };
}

/**
 * Wire post-setupChannels lifecycle hooks: populate the delivery-queue
 * channelAdapters map, drain + start prune timer, mirror prune lifecycle,
 * delivery-queue logging, and output retention housekeeper.
 *
 * Extracted to keep stageChannels under the DAEMON-API-06 ≤200L cap.
 */
async function wirePostChannelsLifecycle(deps: {
  adaptersByType: Awaited<ReturnType<typeof setupChannels>>["adaptersByType"];
  channelAdaptersRef: AgentsHandle["channelAdaptersRef"];
  drainAndStartDeliveryPrune: AgentsHandle["drainAndStartDeliveryPrune"];
  shutdownDeliveryQueue: AgentsHandle["shutdownDeliveryQueue"];
  startMirrorPrune: AgentsHandle["startMirrorPrune"];
  shutdownMirror: AgentsHandle["shutdownMirror"];
  daemonLogger: ReturnType<typeof setupLogging>["daemonLogger"];
  container: AgentsHandle["container"];
  defaultWorkspaceDir: string;
  outputRetentionConfig: AgentsHandle["container"]["config"]["outputRetention"];
}): Promise<void> {
  const { adaptersByType, channelAdaptersRef, drainAndStartDeliveryPrune, shutdownDeliveryQueue,
    startMirrorPrune, shutdownMirror, daemonLogger, container, defaultWorkspaceDir,
    outputRetentionConfig } = deps;
  for (const [type, adapter] of adaptersByType) channelAdaptersRef.set(type, adapter);
  await drainAndStartDeliveryPrune();
  container.eventBus.on("system:shutdown", () => { shutdownDeliveryQueue(); });
  startMirrorPrune();
  container.eventBus.on("system:shutdown", () => { shutdownMirror(); });
  setupDeliveryQueueLogging({ eventBus: container.eventBus, logger: daemonLogger });
  if (defaultWorkspaceDir) {
    const outputRetentionHandle = setupOutputRetention({
      config: outputRetentionConfig, workspaceDir: defaultWorkspaceDir, logger: daemonLogger,
    });
    container.eventBus.on("system:shutdown", () => { outputRetentionHandle.shutdown(); });
  } else {
    daemonLogger.debug(
      { hint: "No defaultWorkspaceDir; output retention housekeeper skipped" },
      "Output retention: skipped (no default workspace)",
    );
  }
}

/**
 * Build the image-generation provider bundle: provider + rate limiter + config.
 * Logs the same info/debug/warn lines as the original inline block.
 *
 * Extracted to keep stageChannels under the DAEMON-API-06 ≤200L cap.
 */
function buildImageGenBundle(deps: {
  container: AgentsHandle["container"];
  skillsLogger: ReturnType<typeof setupLogging>["skillsLogger"];
}): {
  imageGenProvider: ChannelsHandle["imageGenProvider"];
  imageGenRateLimiter: ImageGenRateLimiter | undefined;
  imageGenConfig: ChannelsHandle["imageGenConfig"];
} {
  const { container, skillsLogger } = deps;
  const imageGenConfig = container.config.integrations.media.imageGeneration;
  const imageGenResult = createImageGenProvider(imageGenConfig, container.secretManager);
  const imageGenProvider = imageGenResult.ok ? imageGenResult.value : undefined;
  const imageGenRateLimiter = imageGenProvider
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
  return { imageGenProvider, imageGenRateLimiter, imageGenConfig };
}

/**
 * stageChannels — channel-runtime startup. Owns:
 *   - channel adapters + composite media resolution + delivery service
 *   - inbound message id resolver
 *   - notification system + background completion runner
 *   - channel health monitor (refs #10 + #11 subsumed via helper return)
 *   - sandbox + image generation providers
 *   - per-agent ToolCapabilityPort resolver (factory helper)
 *   - tools assembly + message preprocessing
 *   - cross-session sender + sub-agent runner
 *   - node type registry + graph coordinator + named graph store
 *   - monitoring (heartbeat runner) + per-agent heartbeat + wake coalescer
 *   - cronWakeCallbackRef populated (DAEMON-API-09 ref #8 cross-stage handoff)
 *   - agent management runtime state (suspended set, model catalog, channel cfg)
 *
 * Body extracted from main() lines 1264→1709 of the post-Plan-04 daemon.ts.
 * Hard cap: ≤200 lines AST-measured (DAEMON-API-06). Per-line-source order
 * preserved so daemon-lifecycle.test.ts log-sequence assertions remain green.
 *
 * Implements DAEMON-API-06 (part 3 of 5), DAEMON-API-09 (refs #8-#11), and
 * DAEMON-API-11 (commit 3 of 5).
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
  // DAEMON-API-09 ref #9: `{ ref?: T }` indirection captured by onMessageReceived
  // lambda; populated below once channelCapabilities is available.
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

  // Channel health monitor (refs #10 + #11 subsumed by helper return)
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
  // DAEMON-API-09 ref #8 (cross-stage): populate cronWakeCallbackRef now that
  // wakeCoalescer is constructed. The setupSchedulers `onCronWake` lambda
  // (wired in stageAgents) reads `.ref` at call time -- Pitfall 2 avoided.
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

/**
 * Shape of the session-store bridge object literal constructed inside
 * stageGateway. Captured as a named type so GatewayHandle declares a precise
 * field type (rather than a TypeScript `object`) and so consumers can satisfy
 * the type without re-stating the literal. Mirrors the four-method facade
 * consumed by the RPC dispatch layer (rpc-dispatch.ts:88-101).
 */
type SessionStoreBridge = {
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

/**
 * Handle returned by `stageGateway`. Extends `ChannelsHandle` so main() and
 * `stageShutdown` (Plan 07) can read every field constructed across all four
 * runtime stages. Carries ~13 new fields covering token registry, session
 * store bridge, hot-add/hot-remove closures, RPC dispatch deps, gateway server
 * handle, active execution tracker, and WebSocket connection manager.
 *
 * The `shutdownRef` slot is declared empty inside stageGateway and populated
 * by `stageShutdown` (Plan 07) once the live shutdown handle is constructed
 * (hot-add closures read `.value` at RPC call time, not at definition time).
 */
export interface GatewayHandle extends ChannelsHandle {
  // Token registry (4 fields)
  tokenRegistry: ReturnType<typeof createTokenRegistry>;
  runtimeTokens: Array<{ id: string; secretBuf: Buffer; scopes: string[] }>;
  removedTokenIds: Set<string>;
  resolvedGatewayTokens: Array<{ id: string; secret: string; scopes: string[] }>;
  // Session store bridge (1 field)
  sessionStoreBridge: SessionStoreBridge;
  // Shutdown ref (populated by stageShutdown -- Plan 07)
  shutdownRef: { value?: { readonly isShuttingDown: boolean } };
  // Hot-add / hot-remove closures (2 fields)
  hotAdd: (agentId: string, config: PerAgentConfig) => Promise<void>;
  hotRemove: (agentId: string) => Promise<void>;
  // RPC dispatch deps (1 field; mutated post-gateway-init for wsConnections/mediaDir/onGatewayAttachment)
  rpcDispatchDeps: import("./api/rpc-dispatch.js").ApiDispatchDeps;
  // Gateway server (4 fields)
  gatewayHandle: import("@comis/gateway").GatewayServerHandle | undefined;
  activeExecutions: Map<string, { agentId: string; startedAt: number }>;
  getActiveConnectionCount: () => number;
  wsConnections: import("@comis/gateway").WsConnectionManager;
}

/**
 * Resolve gateway tokens from config (config -> env -> auto-generated).
 * Extracted from stageGateway to fit the DAEMON-API-06 ≤200L cap. Lifts the
 * 24L config-token resolution block verbatim.
 */
function resolveGatewayTokens(deps: {
  container: ChannelsHandle["container"];
  daemonLogger: ChannelsHandle["daemonLogger"];
}): Array<{ id: string; secret: string; scopes: string[] }> {
  const { container, daemonLogger } = deps;
  const resolved: Array<{ id: string; secret: string; scopes: string[] }> = [];
  for (const t of container.config.gateway?.tokens ?? []) {
    const tokenId = t.id ?? "unknown";
    const tokenScopes = [...(t.scopes ?? [])];
    if (typeof t.secret === "string" && t.secret.length >= 32) {
      // Source: config (explicit secret present and valid)
      resolved.push({ id: tokenId, secret: t.secret, scopes: tokenScopes });
    } else {
      const envKey = `GATEWAY_TOKEN_${tokenId.toUpperCase().replace(/-/g, "_")}`;
      const envSecret = container.secretManager.get(envKey);
      if (envSecret) {
        // Source: env / SecretManager
        resolved.push({ id: tokenId, secret: envSecret, scopes: tokenScopes });
      } else {
        // Source: auto-generated (ephemeral)
        const generated = generateStrongToken();
        resolved.push({ id: tokenId, secret: generated, scopes: tokenScopes });
        daemonLogger.warn(
          { tokenId, envVar: envKey, hint: `Set ${envKey} in environment or secrets store for persistence`, errorKind: "config" as const },
          "Gateway token auto-generated (ephemeral -- will be lost on restart)",
        );
      }
    }
  }
  return resolved;
}

/**
 * Factory: hot-add agent closure. Returns the closure that captures
 * destructured Maps + setupSingleAgent + shutdownRef + eventBus by reference
 * (all consumers hold the same Map references). Extracted to fit stageGateway
 * under the DAEMON-API-06 ≤200L cap.
 */
function createHotAdd(deps: {
  channels: ChannelsHandle;
  shutdownRef: { value?: { readonly isShuttingDown: boolean } };
}): (agentId: string, config: PerAgentConfig) => Promise<void> {
  const { channels, shutdownRef } = deps;
  const {
    singleAgentDeps, executors, workspaceDirs, costTrackers, budgetGuards,
    stepCounters, piSessionAdapters, skillWatcherHandles, skillRegistries,
    toolCapabilityPorts, container, daemonLogger,
  } = channels;
  return async (agentId, config) => {
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
    toolCapabilityPorts.set(agentId, result.toolCapabilityPort);
    container.eventBus.emit("agent:hot_added", { agentId, timestamp: Date.now() });
    daemonLogger.info({ agentId, durationMs: Date.now() - startMs }, "Agent hot-added to running daemon");
  };
}

/**
 * Factory: hot-remove agent closure. Mirror of createHotAdd. Extracted to fit
 * stageGateway under the DAEMON-API-06 ≤200L cap.
 */
function createHotRemove(deps: {
  channels: ChannelsHandle;
}): (agentId: string) => Promise<void> {
  const {
    activeRunRegistry, daemonLogger, skillWatcherHandles, executors, workspaceDirs,
    costTrackers, budgetGuards, stepCounters, piSessionAdapters, skillRegistries,
    toolCapabilityPorts, container,
  } = deps.channels;
  return async (agentId) => {
    const startMs = Date.now();
    // Warn if agent may have active executions.
    // ActiveRunRegistry is keyed by sessionKey, not agentId. Since hot-remove is
    // rare and the registry is small, a coarse size > 0 check is sufficient for v1.
    if (activeRunRegistry.size > 0) {
      daemonLogger.warn(
        { agentId, activeRuns: activeRunRegistry.size,
          hint: "Agent removed while daemon has active executions; if this agent has an in-flight run it will complete but response delivery may fail",
          errorKind: "internal" as const },
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
    toolCapabilityPorts.delete(agentId);
    container.eventBus.emit("agent:hot_removed", { agentId, timestamp: Date.now() });
    daemonLogger.info({ agentId, durationMs: Date.now() - startMs }, "Agent hot-removed from running daemon");
  };
}

/**
 * Build the rpcDispatchDeps literal. Single largest extraction (was ~76L).
 * Returns the full ApiDispatchDeps shape consumed by `wireDispatch` -- every
 * field name MUST match the ApiDispatchDeps aggregator in api/types.ts.
 * Extracted to fit stageGateway under the DAEMON-API-06 ≤200L cap.
 */
function buildImageHandlerDeps(deps: {
  channels: ChannelsHandle;
}): import("./api/rpc-dispatch.js").ApiDispatchDeps["imageHandlerDeps"] {
  const { imageGenProvider, imageGenRateLimiter, imageGenConfig, skillsLogger, adaptersByType } = deps.channels;
  if (!imageGenProvider || !imageGenRateLimiter) return undefined;
  return {
    provider: imageGenProvider,
    rateLimiter: imageGenRateLimiter,
    config: imageGenConfig,
    logger: skillsLogger,
    getChannelAdapter: (channelType: string) => adaptersByType.get(channelType),
  };
}

function buildTokenStoreMutators(deps: {
  runtimeTokens: Array<{ id: string; secretBuf: Buffer; scopes: string[] }>;
  removedTokenIds: Set<string>;
}): Pick<import("./api/rpc-dispatch.js").ApiDispatchDeps, "addToTokenStore" | "removeFromTokenStore"> {
  const { runtimeTokens, removedTokenIds } = deps;
  return {
    addToTokenStore: (entry) => {
      runtimeTokens.push({ id: entry.id, secretBuf: Buffer.from(entry.secret, "utf-8"), scopes: entry.scopes });
    },
    removeFromTokenStore: (id) => {
      removedTokenIds.add(id);
      const idx = runtimeTokens.findIndex((t) => t.id === id);
      if (idx >= 0) runtimeTokens.splice(idx, 1);
    },
  };
}

function buildContextEngineConfig(channels: ChannelsHandle): { maxRecallsPerDay: number; maxExpandTokens: number; recallTimeoutMs: number } {
  const { agentsConfig: agents, defaultAgentId } = channels;
  return {
    maxRecallsPerDay: agents[defaultAgentId]?.contextEngine?.maxRecallsPerDay ?? 10,
    maxExpandTokens: agents[defaultAgentId]?.contextEngine?.maxExpandTokens ?? 4000,
    recallTimeoutMs: agents[defaultAgentId]?.contextEngine?.recallTimeoutMs ?? 120000,
  };
}

export type GatewayPreDispatchSlice = Pick<GatewayHandle,
  "tokenRegistry" | "runtimeTokens" | "removedTokenIds" | "sessionStoreBridge" | "hotAdd" | "hotRemove">;

function buildRpcDispatchDeps(deps: {
  channels: ChannelsHandle;
  startupStartMs: number;
  gateway: GatewayPreDispatchSlice;
}): import("./api/rpc-dispatch.js").ApiDispatchDeps {
  const { channels: c, gateway: g, startupStartMs } = deps;
  return {
    defaultAgentId: c.defaultAgentId, getAgentCronScheduler: c.getAgentCronScheduler,
    cronSchedulers: c.cronSchedulers, executionTrackers: c.executionTrackers, wakeCoalescer: c.wakeCoalescer,
    defaultWorkspaceDir: c.defaultWorkspaceDir, workspaceDirs: c.workspaceDirs,
    memoryApi: c.memoryApi, memoryAdapter: c.memoryAdapter, embeddingQueue: c.embeddingQueue,
    tenantId: c.container.config.tenantId, agents: c.agentsConfig, costTrackers: c.costTrackers, stepCounters: c.stepCounters,
    agentDataDir: safePath(c.container.config.dataDir ?? safePath(os.homedir(), ".comis"), "agents"),
    sessionStore: g.sessionStoreBridge,
    crossSessionSender: c.crossSessionSender, subAgentRunner: c.subAgentRunner,
    graphCoordinator: c.graphCoordinator, namedGraphStore: c.namedGraphStore, nodeTypeRegistry: c.nodeTypeRegistry,
    securityConfig: c.container.config.security, adaptersByType: c.adaptersByType,
    inboundMessageIdResolver: c.inboundMessageIdResolver, visionRegistry: c.visionRegistry,
    mediaConfig: c.container.config.integrations.media, ttsAdapter: c.ttsAdapter, linkRunner: c.linkRunner,
    logger: c.logger, container: c.container, configPaths: c.configPaths, defaultConfigPaths: DEFAULT_CONFIG_PATHS,
    configGitManager: c.configGitManager,
    configWebhook: c.container.config.daemon.configWebhook as { url?: string; timeoutMs?: number; secret?: string },
    secretStore: c.secretStore, envFilePath: c.envPath, logLevelManager: c.logLevelManager,
    getAgentBrowserService: c.getAgentBrowserService,
    resolveAttachment: c.resolveAttachment, transcriber: c.transcriber, fileExtractor: c.fileExtractor,
    approvalGate: c.approvalGate, suspendedAgents: c.suspendedAgents,
    hotAdd: g.hotAdd, hotRemove: g.hotRemove,
    diagnosticCollector: c.diagnosticCollector, billingEstimator: c.billingEstimator,
    channelActivityTracker: c.channelActivityTracker, deliveryTracer: c.deliveryTracer, budgetGuards: c.budgetGuards,
    modelCatalog: c.modelCatalog, channelConfig: c.channelConfig,
    tokenRegistry: g.tokenRegistry,
    ...buildTokenStoreMutators({ runtimeTokens: g.runtimeTokens, removedTokenIds: g.removedTokenIds }),
    memoryWriteValidator: validateMemoryWrite,
    // Plan 34-08b: MemoryApiDeps.eventBus now accepts the full
    // AppContainer["eventBus"] type. The legacy down-cast to `{ emit }` is
    // unnecessary and was rejected by the broadened cluster slice.
    eventBus: c.container.eventBus,
    mcpClientManager: c.mcpClientManager, contextStore: c.contextStore,
    contextEngineConfig: buildContextEngineConfig(c),
    obsStore: c.obsStore, startupTimestamp: startupStartMs, sharedCostTracker: c.sharedCostTracker,
    contextPipelineCollector: c.contextPipelineCollector, execGit: c.execGit,
    deliveryQueue: c.deliveryQueue, deliveryService: c.deliveryService,
    channelPlugins: c.channelPlugins, healthMonitor: c.channelHealthMonitor,
    embeddingCacheStats: c.embeddingCacheStats, embeddingCircuitBreakerState: c.embeddingCircuitBreakerState,
    skillRegistries: c.skillRegistries, notificationService: c.notificationContext.notificationService,
    imageHandlerDeps: buildImageHandlerDeps({ channels: c }),
    oauthCredentialStore: c.oauthCredentialStore,
  };
}

/**
 * Build the synthetic-restart message payload for a single continuation
 * record. Rehydrates chat-type metadata so downstream resolveChatType /
 * isGroupMessage classify the resumed session correctly. Extracted from
 * replayContinuationsIfAny to keep the per-record loop under the
 * DAEMON-API-07 ≤50L helper cap.
 */
function buildSyntheticRestartMessage(deps: {
  record: ReturnType<typeof loadContinuations>[number];
  baseText: string;
  mcpStatusLine: string | undefined;
}): { id: string; channelId: string; channelType: string; senderId: string; text: string; timestamp: number; attachments: never[]; metadata: Record<string, unknown> } {
  const { record, baseText, mcpStatusLine } = deps;
  const metadata: Record<string, unknown> = {
    isRestartContinuation: true,
    mcpStatusLine: mcpStatusLine ?? null,
  };
  if (record.channelType === "telegram" && record.chatType) {
    metadata.telegramChatType = record.chatType;
  }
  if (record.chatType === "group" || record.chatType === "supergroup") {
    // Channel-agnostic flag mirrored by other adapters (e.g. WhatsApp).
    metadata.isGroup = true;
  }
  return {
    id: randomUUID(),
    channelId: record.channelId,
    channelType: record.channelType,
    senderId: record.userId,
    text: mcpStatusLine ? `${baseText}\n${mcpStatusLine}` : baseText,
    timestamp: Date.now(),
    attachments: [] as never[],
    metadata,
  };
}

/**
 * Replay restart continuations from disk if any. Owns the block that
 * loads persisted continuation records and re-injects synthetic restart
 * messages through channelManager. Extracted to fit stageGateway under the
 * DAEMON-API-06 ≤200L cap; per-record message construction further
 * extracted into buildSyntheticRestartMessage to fit DAEMON-API-07 ≤50L.
 */
async function replayContinuationsIfAny(deps: {
  channels: ChannelsHandle;
}): Promise<void> {
  const { container, dataDir, daemonLogger, mcpClientManager, continuationTracker, channelManager } = deps.channels;
  const continuationFilePath = safePath(container.config.dataDir || dataDir, "restart-continuations.json");
  const continuations = loadContinuations(continuationFilePath, 5 * 60_000, daemonLogger);
  if (continuations.length === 0 || !channelManager) return;
  daemonLogger.info({ count: continuations.length }, "Replaying restart continuations");
  const mcpStatusLine = buildMcpStatusLine(mcpClientManager.getAllConnections());
  if (mcpStatusLine) {
    daemonLogger.warn(
      { mcpStatusLine, continuationCount: continuations.length,
        hint: "One or more MCP servers failed to handshake after restart; surfacing status to agents via synthetic system message",
        errorKind: "dependency" as const },
      "MCP connection failures detected during restart continuation replay",
    );
  }
  const baseText = "[system: daemon restarted to apply a config change. The result of your previous tool call is in the conversation above — react to it naturally, confirm or surface any issue, then yield to the user.]";
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
    const syntheticMsg = buildSyntheticRestartMessage({ record, baseText, mcpStatusLine });
    channelManager.injectMessage(record.channelType, syntheticMsg).catch((injectErr) => {
      daemonLogger.warn(
        { err: injectErr, channelType: record.channelType, channelId: record.channelId, hint: "Continuation replay failed; user can re-send to resume", errorKind: "internal" as const },
        "Failed to replay continuation",
      );
    });
  }
}

/**
 * stageGateway -- gateway-runtime startup. Owns:
 *   token registry + session store bridge + shutdown ref + hot-add/hot-remove
 *   closures + RPC dispatch deps assembly + gateway server + deferred gateway
 *   attachment wiring + gatewaySendRef.ref population + restart continuation
 *   replay.
 * Inputs: ChannelsHandle (yields foundation + agents + channels) + overrides.
 *
 * DAEMON-API-06 (part 4 of 5): hard cap ≤200 lines AST-measured. Five helpers
 * extracted to fit (resolveGatewayTokens, createHotAdd, createHotRemove,
 * buildRpcDispatchDeps, replayContinuationsIfAny).
 *
 * Log-sequence: "Gateway server started" emits inside setupGateway here in
 * source order; daemon-lifecycle.test.ts test#4 unchanged.
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

  // Mutable shutdown ref for hot-add guard. Populated by stageShutdown (Plan 07)
  // -- closures read .value at RPC call time, not definition time.
  const shutdownRef: { value?: { readonly isShuttingDown: boolean } } = {};

  // Hot-add / hot-remove closures (factory pattern; deps captured by closure)
  const hotAdd = createHotAdd({ channels, shutdownRef });
  const hotRemove = createHotRemove({ channels });

  // 6.7.1. Build RPC dispatch deps and wire dispatch
  const rpcDispatchDeps = buildRpcDispatchDeps({
    channels,
    startupStartMs,
    gateway: { tokenRegistry, runtimeTokens, removedTokenIds, sessionStoreBridge, hotAdd, hotRemove },
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
  // INVARIANT (DAEMON-API-09 / WR-05): handler factory bodies in
  // `packages/daemon/src/api/*-handlers.ts` MUST read these three fields
  // off `deps` at RPC INVOCATION time (`deps.wsConnections`, `deps.mediaDir`,
  // `deps.onGatewayAttachment`). They MUST NOT destructure them at factory
  // creation time -- the factory runs INSIDE `wireDispatch(rpcDispatchDeps)`
  // at line 2071, BEFORE the mutations below. A destructure like
  //   const { wsConnections, mediaDir } = deps;
  // at the top of `createMessageHandlers` would capture `undefined` (the
  // pre-mutation values) and silently break gateway-bound RPC paths. The
  // wireDispatch call must remain BEFORE the mutations so the gateway server
  // (setupGateway, line 2075) can register methods on the dynamic router
  // before its HTTP listener starts; "fix by mutating earlier" is not an
  // option.
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
  // load -> mcp-status -> per-record inject; preserves Pitfall T-34-06-03)
  await replayContinuationsIfAny({ channels });

  return {
    ...channels,
    tokenRegistry, runtimeTokens, removedTokenIds, resolvedGatewayTokens,
    sessionStoreBridge, shutdownRef, hotAdd, hotRemove, rpcDispatchDeps,
    gatewayHandle, activeExecutions, getActiveConnectionCount, wsConnections,
  };
}

/**
 * Wire eventBus health subscriptions to structured logger metrics. Lifted from
 * the ~88L block in main() (single largest extraction win for stageShutdown).
 * Reads metrics from the observability event bus, prunes prompt timeouts,
 * computes stuck-sub-agent counters, force-kills sub-agents past threshold,
 * and emits the canonical "Daemon health" DEBUG line.
 */
/** Read DB file + WAL file sizes (best-effort; returns undefined fields on failure). */
function readDbSizeMetrics(db: GatewayHandle["db"]): {
  memoryDbSizeBytes?: number;
  memoryDbWalSizeBytes?: number;
} {
  let memoryDbSizeBytes: number | undefined;
  let memoryDbWalSizeBytes: number | undefined;
  try {
    const dbFilePath = db.name;
    if (dbFilePath) {
      memoryDbSizeBytes = statSync(dbFilePath).size;
      try { memoryDbWalSizeBytes = statSync(dbFilePath + "-wal").size; }
      catch { /* WAL file may not exist */ }
    }
  } catch { /* stat failure must not crash health check */ }
  return { memoryDbSizeBytes, memoryDbWalSizeBytes };
}

/**
 * Count active sub-agent runs and force-kill any past the threshold-aware cutoff.
 * Graph sub-agents get a longer threshold since they do multi-step analytical work.
 * Returns { activeSubAgentRuns, stuckSubAgentRuns, stuckKilledThisTick } counters.
 */
function computeAndKillStuckSubAgents(deps: {
  container: GatewayHandle["container"];
  daemonLogger: GatewayHandle["daemonLogger"];
  subAgentRunner: GatewayHandle["subAgentRunner"];
}): { activeSubAgentRuns: number; stuckSubAgentRuns: number; stuckKilledThisTick: number } {
  const { container, daemonLogger, subAgentRunner } = deps;
  const stuckKillThresholdMs = container.config.security.agentToAgent.subagentContext?.stuckKillThresholdMs ?? 180_000;
  const graphStuckKillThresholdMs = container.config.security.agentToAgent.subagentContext?.graphStuckKillThresholdMs ?? 600_000;
  const allRuns = subAgentRunner.listRuns();
  const now = Date.now();
  let activeSubAgentRuns = 0;
  let stuckSubAgentRuns = 0;
  let stuckKilledThisTick = 0;
  for (const run of allRuns) {
    if (run.status !== "running") continue;
    activeSubAgentRuns++;
    const threshold = run.graphId ? graphStuckKillThresholdMs : stuckKillThresholdMs;
    if (threshold > 0 && (now - run.startedAt) > threshold) stuckSubAgentRuns++;
    if (threshold <= 0) continue;
    if ((now - run.startedAt) <= threshold) continue;
    subAgentRunner.killRun(run.runId);
    stuckKilledThisTick++;
    daemonLogger.warn({
      runId: run.runId, agentId: run.agentId, runtimeMs: now - run.startedAt,
      thresholdMs: threshold, isGraphRun: !!run.graphId,
      hint: run.graphId
        ? "Graph sub-agent exceeded graphStuckKillThresholdMs; force-killed by health handler. Adjust security.agentToAgent.subagentContext.graphStuckKillThresholdMs if needed."
        : "Sub-agent exceeded stuckKillThresholdMs; force-killed by health handler. Adjust security.agentToAgent.subagentContext.stuckKillThresholdMs if needed.",
      errorKind: "timeout" as const,
    }, "Stuck sub-agent killed by health handler");
  }
  return { activeSubAgentRuns, stuckSubAgentRuns, stuckKilledThisTick };
}

function wireHealthLogging(deps: {
  container: GatewayHandle["container"];
  daemonLogger: GatewayHandle["daemonLogger"];
  db: GatewayHandle["db"];
  maintenanceTick: GatewayHandle["maintenanceTick"];
  subAgentRunner: GatewayHandle["subAgentRunner"];
  promptTimeoutTimestamps: GatewayHandle["promptTimeoutTimestamps"];
  activeExecutions: GatewayHandle["activeExecutions"];
  getActiveConnectionCount: GatewayHandle["getActiveConnectionCount"];
  deadLetterQueue: GatewayHandle["deadLetterQueue"];
  providerHealth: GatewayHandle["providerHealth"];
  deliveryQueue: GatewayHandle["deliveryQueue"];
}): void {
  const {
    container, daemonLogger, db, maintenanceTick, subAgentRunner,
    promptTimeoutTimestamps, activeExecutions, getActiveConnectionCount,
    deadLetterQueue, providerHealth, deliveryQueue,
  } = deps;
  container.eventBus.on("observability:metrics", async (metrics) => {
    // Prune prompt timeout timestamps to 5-minute window
    const fiveMinAgo = Date.now() - 5 * 60_000;
    while (promptTimeoutTimestamps.length > 0 && promptTimeoutTimestamps[0]! < fiveMinAgo) {
      promptTimeoutTimestamps.shift();
    }
    const { memoryDbSizeBytes, memoryDbWalSizeBytes } = readDbSizeMetrics(db);
    maintenanceTick();
    const { activeSubAgentRuns, stuckSubAgentRuns, stuckKilledThisTick } =
      computeAndKillStuckSubAgents({ container, daemonLogger, subAgentRunner });
    daemonLogger.debug({
      rssBytes: metrics.rssBytes, heapUsedBytes: metrics.heapUsedBytes,
      heapTotalBytes: metrics.heapTotalBytes, externalBytes: metrics.externalBytes,
      eventLoopP99Ms: Math.round(metrics.eventLoopDelayMs.p99 * 100) / 100,
      activeHandles: metrics.activeHandles, activeConnections: getActiveConnectionCount(),
      activeExecutions: activeExecutions.size, uptimeSeconds: Math.round(metrics.uptimeSeconds),
      activeSubAgentRuns, stuckSubAgentRuns, stuckKilledThisTick,
      deadLetterQueueSize: deadLetterQueue?.size() ?? 0,
      degradedProviders: [...providerHealth.getHealthSummary().entries()]
        .filter(([, v]) => v.degraded).map(([k]) => k),
      promptTimeoutsLast5m: promptTimeoutTimestamps.length,
      ...(memoryDbSizeBytes !== undefined && { memoryDbSizeBytes }),
      ...(memoryDbWalSizeBytes !== undefined && { memoryDbWalSizeBytes }),
      pendingDeliveryCount: await deliveryQueue.pendingEntries().then(r => r.ok ? r.value.length : 0),
    }, "Daemon health");
  });
}

/**
 * Emit startup banner + docker restart-policy warn + OAuth TLS preflight.
 * Lifted from the ~25L block in main(). Emits the canonical
 * "Comis daemon started" INFO line (log line 5 in daemon-lifecycle.test.ts).
 */
/** Build the startup-banner manifest sub-object (secrets/memory/agents/skills/gateway). */
function buildStartupBannerManifest(deps: {
  container: GatewayHandle["container"];
  agents: GatewayHandle["agentsConfig"];
  db: GatewayHandle["db"];
  secretStore: GatewayHandle["secretStore"];
  cachedPort: GatewayHandle["cachedPort"];
  ttsAdapter: GatewayHandle["ttsAdapter"];
  visionRegistry: GatewayHandle["visionRegistry"];
}): Record<string, unknown> {
  const { container, agents, db, secretStore, cachedPort, ttsAdapter, visionRegistry } = deps;
  const gwConfig = container.config.gateway;
  return {
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
  };
}

function emitStartupBanner(deps: {
  container: GatewayHandle["container"];
  daemonLogger: GatewayHandle["daemonLogger"];
  daemonVersion: GatewayHandle["daemonVersion"];
  agents: GatewayHandle["agentsConfig"];
  adaptersByType: GatewayHandle["adaptersByType"];
  configPaths: GatewayHandle["configPaths"];
  db: GatewayHandle["db"];
  secretStore: GatewayHandle["secretStore"];
  cachedPort: GatewayHandle["cachedPort"];
  ttsAdapter: GatewayHandle["ttsAdapter"];
  visionRegistry: GatewayHandle["visionRegistry"];
  startupStartMs: number;
  instanceId: string;
}): void {
  const {
    container, daemonLogger, daemonVersion, agents, adaptersByType, configPaths,
    db, secretStore, cachedPort, ttsAdapter, visionRegistry,
    startupStartMs, instanceId,
  } = deps;
  const gwConfig = container.config.gateway;
  daemonLogger.info({
    version: daemonVersion, agents: Object.keys(agents),
    channels: Array.from(adaptersByType.keys()),
    port: gwConfig.enabled ? gwConfig.port : undefined, instanceId,
    startupDurationMs: Date.now() - startupStartMs, configPaths, dbPath: db.name,
    logLevel: container.config.logLevel ?? "info", nodeVersion: process.versions.node,
    manifest: buildStartupBannerManifest({
      container, agents, db, secretStore, cachedPort, ttsAdapter, visionRegistry,
    }),
  }, "Comis daemon started");
  // Docker-only: surface restart-policy requirement immediately after the
  // startup banner. No-op outside containers. Wired here so the WARN lands
  // in `docker logs` next to the banner, where operators look first.
  emitDockerRestartPolicyWarn(daemonLogger);
  // Boot-time TLS preflight against auth.openai.com.
  // Fire-and-forget -- daemon is already serving by this point; the WARN
  // is purely advisory. Skipped when no OAuth-using agent is configured.
  if (hasAnyOAuthAgent(container.config.agents)) {
    void emitOAuthTlsPreflightWarn(daemonLogger);
  }
}

/**
 * stageShutdown -- final stage. Constructs the shutdown handle, populates
 * gateway.shutdownRef.value (cross-stage deferred-ref pattern), wires the
 * health-metrics event-bus subscription, emits the startup banner, snapshots
 * last-known-good config, and returns the DaemonInstance to main()'s callers.
 *
 * Hard cap: ≤200 lines AST-measured (DAEMON-API-06).
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
  });

  // Wire shutdown ref for hot-add guard. Cross-stage deferred-ref populate:
  // stageGateway declared the empty ref + captured it in hot-add closure;
  // here we point .value at the live shutdown handle so the closure reads
  // .isShuttingDown at call time (T-34-06-04 / T-34-07-03 mitigation).
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

  // Stage 1: foundation (DAEMON-API-06 / Plan 34-03). Owns data-dir + secrets +
  // bootstrap + logging + observability + memory + obs-persistence + context
  // store + session mirroring + Gemini cache + background tasks + deferred refs.
  const foundation = await stageFoundation({ overrides, startupStartMs, instanceId });

  // Stage 2: agents (DAEMON-API-06 / Plan 34-04). Owns agent executors +
  // mcpClientManager + schedulers + media + RPC bridge + approval gate (with
  // restore) + delivery queue.
  const agents = await stageAgents({ overrides, foundation });

  // Stage 3: channels (DAEMON-API-06 / Plan 34-05). Owns channel adapters +
  // notifications + bg completion runner + sandbox/image-gen + tools + cross-
  // session + graph + monitoring + heartbeat + wake coalescer + agent runtime
  // state.
  const channels = await stageChannels({ agents });

  // Stage 4: gateway (DAEMON-API-06 / Plan 34-06). Owns token registry +
  // session store bridge + shutdown ref slot + hot-add/hot-remove closures +
  // RPC dispatch deps assembly + gateway server + restart continuation replay.
  const gateway = await stageGateway({ overrides, channels, startupStartMs, instanceId });

  // Stage 5: shutdown (DAEMON-API-06 / Plan 34-07). Constructs shutdown handle,
  // populates gateway.shutdownRef.value (cross-stage deferred-ref), wires health
  // logging, emits the startup banner (log line 5: "Comis daemon started"), and
  // returns the DaemonInstance.
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
