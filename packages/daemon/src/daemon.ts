// SPDX-License-Identifier: Apache-2.0
// @allow-throw: daemon bootstrap composition-root failures (secrets bootstrap, decryption, etc.); hard-fail at startup is the correct contract (bootstrap() returns Result but daemon.ts is the entry point that catches it and exits).
/**
 * Daemon Entry Point: composition root for the entire daemon process.
 *
 * The 5 `stages/*-helpers.ts` files plus the `stages/index.ts` barrel
 * were inlined back into this file. 23 helpers either became top-level
 * functions here (the ones called from multiple sites or large enough to
 * warrant naming) or were inlined directly at their single call site
 * (the ones whose only purpose was keeping the old per-stage cap under
 * 200L).
 *
 * BootContext lives in `./daemon-types.ts`; the only out-of-file lifted
 * helper is `emitBootstrapConfigObserveRecords` (+ kin) which moved to
 * `./config/bootstrap-observe.ts` because `daemon-config-observe.test.ts`
 * is the sole external test consumer of any former stages/* helper.
 *
 * Structure of this file:
 *   1.  Imports
 *   2.  DEFAULT_CONFIG_PATHS + applyInspectDefaultsForLogging
 *   3.  hardenDataDirPermissions
 *   4.  runPreflightDoctor
 *   5.  process.env scrub helpers (SENSITIVE_PREFIXES, SENSITIVE_EXACT_KEYS,
 *       scrubProcessEnv, buildMergedEnv)
 *   6.  Agents-stage helpers (restoreApprovalState, wirePostAgentsCleanup)
 *   7.  Channels-stage helpers (buildChannelManagerDeps,
 *       buildGraphCoordinatorDeps, wirePostChannelsLifecycle;
 *       setupChannelHealthMonitor lives in wiring/main-helpers.ts)
 *   8.  Gateway-stage helpers (resolveGatewayTokens, createHotAdd,
 *       createHotRemove, buildRpcDispatchDeps, replayContinuationsIfAny)
 *   9.  Shutdown-stage helpers (wireHealthLogging, emitStartupBanner)
 *  10.  bootFoundation / bootAgents / bootChannels / bootGateway /
 *       bootShutdown
 *  11.  main()
 *  12.  Direct-run guard block
 *
 * The 4-handle chain (Foundation → Agents → Channels → Gateway) was collapsed
 * into a single BootContext: each boot* helper takes `boot: BootContext` and
 * mutates it via Object.assign; main() constructs it via createEmptyBootContext()
 * and chains the 5 helpers in order. The 6 true forward-ref slots (channelPluginsRef,
 * bgNotifyRef, cronWakeCallbackRef, gatewaySendRef, shutdownRef, channelAdaptersRef)
 * persist on BootContext; the 3 former bootChannels local-scope deferred refs are gone
 * (setupTools is hoisted before setupChannels; the other two are local `let` slots
 * captured by message-arrival lambdas).
 *
 * The 23 helpers from an earlier stages/* decomposition are back here in two forms:
 * 11 as top-level functions (called once but large enough to name — e.g. buildMergedEnv,
 * buildChannelManagerDeps, createHotAdd, emitStartupBanner; restoreApprovalState went to
 * wiring/main-helpers.ts) and 11 inlined verbatim at their single call site (e.g.
 * setupMcpManager, buildAuditBundle, the buildImageHandlerDeps/buildTokenStoreMutators/
 * buildContextEngineConfig fold into buildRpcDispatchDeps, etc.).
 *
 * @module
 */

import {
  bootstrap,
  loadEnvFile,
  createApprovalGate,
  createAuditAggregator,
  createConfigGitManager,
  parseFormattedSessionKey,
  envSubset,
  createInjectionRateLimiter,
  checkApprovalsConfig,
  formatSessionKey,
  safePath,
  resolveConfigSecretRefs,
  validateMemoryWrite,
  themeForName,
  BackgroundTasksConfigSchema,
  writeMasterKeyIfAbsent,
  preReadStorageMode,
  systemNowMs,
  ObsExplainContract,
  ObsFleetHealthContract,
  type SecretStorePort,
  type CredentialStorageMode,
  type ToolCapabilityPort,
  type PerAgentConfig,
  type WrapExternalContentOptions,
} from "@comis/core";
// Runtime adapter factories — constructed at the composition root and
// threaded through wiring helpers that retarget Date.now / process.env /
// setTimeout / setInterval. Sanctioned construction site.
import { createSystemClock, createSystemEnv, createSystemTimers } from "@comis/infra";
import {
  installProxyAtBoot,
  logProxyPosture,
  type ProxyBootPosture,
} from "./daemon-proxy-boot-helpers.js";
import {
  setupSecrets as _setupSecretsImpl,
  createNamedGraphStore,
  createObservabilityStore,
  selectSecretStore,
} from "@comis/memory";
import { createGatewayServer } from "@comis/gateway";
import {
  setupLogging,
  setupObservability, rehydrateSpendFromStore,
  setupHealth,
  setupMemory,
  setupAgents,
  setupSchedulers,
  setupChannels,
  createInteractiveCallbackWiring,
  setupMedia,
  setupCrossSession,
  setupTools,
  setupMonitoring,
  setupHeartbeat,
  setupShutdown,
  setupGateway,
  setupRpcBridge,
  setupDeliveryQueue,
  setupDeliveryMirror,
  setupNotifications,
  setupBackgroundTasks,
  setupBackgroundCompletionRunner,
  setupTerminalWake,
  setupMcp,
  selectMcpTokenStore,
  setupSkillBundles,
  buildSkillRegistriesForBundles,
  setupOutputRetention,
  type SetupOutputRetentionHandle,
  setupBroker,
  acquireDataDirLock,
  releaseDataDirLock,
} from "./wiring/index.js";
import {
  createActiveRunRegistry,
  createBackgroundSessionResolver,
  clearSessionState,
  createGeminiCacheManager,
  createSessionTrackerRegistry,
  evaluateViableFloorForAgent,
  probeAllOllamaProviders,
  seedDefaultDagTemplates,
  validateProviderOverrides,
  wireGeminiCacheCleanup,
  wireMcpDisconnectCleanup,
  wireSessionStateCleanup,
  type AgentBootWindowInfo,
  type GeminiCacheManager,
  type ServedWindowComparison,
  type SessionTrackerRegistry,
} from "@comis/agent";
// resolveAgentMainProvider is the handler-side accessor that delegates to the
// EXACT completion-path resolveAgentModel (I4 lockstep / RES-01). Imported
// directly (not via the wiring barrel) to avoid widening the barrel surface.
import { resolveAgentMainProvider } from "./wiring/setup-agents/setup-agents-tooling.js";
import { seedBundledSkills, defaultSeedBundledSkillsDeps } from "./wiring/seed-bundled-skills.js";
// createModelCatalog + resolveWorkspaceDir live in @comis/core.
import { createModelCatalog, resolveWorkspaceDir } from "@comis/core";
import {
  createFileStateTracker,
  detectSandboxProvider,
} from "@comis/skills";
// The single process-singleton activity circuit breaker is constructed
// here and threaded down through ChannelsDeps → buildAndStartChannelManager
// into every per-turn coordinator. The daemon is the composition root that owns
// the breaker's lifetime; the orchestrator owns its logic.
import { createActivityCircuitBreaker } from "@comis/orchestrator";
import { createGraphCoordinator, createNodeTypeRegistry } from "./graph/index.js";
import { resolveGraphConcurrencyDefaults } from "./graph/graph-capability-defaults.js";
import { createWakeCoalescer, createSystemEventQueue, type WakeReasonKind } from "@comis/scheduler";
import { createTokenRegistry } from "./api/token-handlers.js";
// 154-03: the shared obs.explain assembler + production reader, for the
// trust-flag-FREE obsExplainForMcpClient closure (obs_explain MCP tool runs the
// assembler directly under daemon authority — no admin RPC, no admin trust).
import { assembleIncidentReportFromSources, assembleFleetHealthReport, makeRealReader } from "./api/obs-handlers/index.js";
import type { DaemonInstance, DaemonOverrides, BootContext, SessionStoreBridge } from "./daemon-types.js";
import { createEmptyBootContext } from "./daemon-boot-context.js";
export type { DaemonInstance, DaemonOverrides } from "./daemon-types.js";
import { setupObsPersistence } from "./observability/obs-persistence-wiring.js";
import { recordModelHealth } from "./observability/record-model-health.js";
import { emitConfigPostureRecord } from "./wiring/emit-config-posture.js";
import { setupDeliveryQueueLogging } from "./observability/delivery-queue-logger.js";
import { createContextPipelineCollector } from "./observability/context-pipeline-collector.js";
import { createLogLevelManager, expandTilde } from "./observability/log-infra.js";
import { createTokenTracker } from "./observability/token-tracker.js";
import { createTracingLogger } from "./observability/trace-logger.js";
import { setupChannelHealthLogging } from "./observability/channel-health-logger.js";
import { createProcessMonitor } from "./process/process-monitor.js";
import { ok, err, suppressError } from "@comis/shared";
import { exportTrajectoryBundle } from "@comis/observability";
import { randomUUID } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { writeFile as fsWriteFile, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve as pathResolve } from "node:path";
import { createExecGit } from "./config/exec-git.js";
import { saveLastKnownGood, buildRollbackSuggestion, handleRestoreFlag } from "./config/last-known-good.js";
import { runConfigBootstrapAndEmitObserve } from "./config/bootstrap-observe.js";
import {
  createRestartContinuationTracker,
  loadContinuations,
  buildMcpStatusLine,
} from "./wiring/restart-continuation.js";
import { setupSingleAgent, createLearnedSkillSurfaceRegistry } from "./wiring/setup-agents/index.js";
import { buildDialecticWiring, dialecticWiringDepsFromBoot } from "./wiring/setup-dialectic.js";
import { createConversationReset } from "./wiring/conversation-reset.js";
import { setupSecretManager } from "./wiring/setup-secret-manager.js";
import { restoreApprovalState, resolveGatewayTokens, setupChannelHealthMonitor, resolveModelHealthMultilingual, buildImageGenBundle, buildImageHandlerDeps, buildVideoGenBundle, buildVideoHandlerDeps, buildVideoStatusHandlerDeps, buildMediaVisionBundle } from "./wiring/main-helpers.js";
import { hardenDataDirPermissions } from "./wiring/harden-data-dir.js";
import { buildAudioResolverDeps } from "./wiring/setup-audio-provider.js";
import { runPreflightDoctor } from "./wiring/preflight-doctor.js";
import { createInboundMessageIdResolver, type InboundMessageIdResolver } from "./wiring/inbound-message-id-resolver.js";
import { logOperationModelDryRun } from "./wiring/startup-dry-run.js";
import { emitDockerRestartPolicyWarn } from "./setup-docker-restart-warn.js";
import { hasAnyOAuthAgent, emitOAuthTlsPreflightWarn } from "./wiring/oauth-preflight.js";
import { emitStartupInvariants } from "./wiring/setup-startup-invariants.js";
import { checkStorageModeConsistency } from "./wiring/setup-storage-mismatch-warn.js";
import { buildPlaceholdersFromBindings } from "./wiring/broker-placeholder-builder.js";
import { warnOnProviderTimeoutRedirect } from "./wiring/provider-timeout-redirect.js";
import os from "node:os";
import { dirname as pathDirname } from "node:path";
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

// Preflight native-dep doctor — extracted to wiring/preflight-doctor.ts to keep
// this composition root ≤3000 lines (v2.25 audio wiring pushed it over). Imported
// for the boot call site below AND re-exported so `runPreflightDoctor` stays on
// daemon.ts's public surface (daemon.test.ts imports it from "./daemon.js").
export { runPreflightDoctor };

// ---------------------------------------------------------------------------
// Foundation helpers — scrub + store-wins env merge
// ---------------------------------------------------------------------------

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
 * Stage-1 scrub: remove sensitive env vars from process.env (ALL storage modes).
 * Preserves COMIS_* (filesystem-layout pointers, not credentials — kept for
 * subprocess path resolution; per-spawn-site envSubset() excludes them from
 * untrusted-child envs). Preserves PATH, HOME, NODE_ENV, etc.
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

/** Build mergedEnv: store-wins, stage-1 scrub for ALL modes.
 * Returns shadowed names for deferred WARN logging (logger not yet available). */
function buildMergedEnv(
  secretStore: SecretStorePort,
  mode: CredentialStorageMode,
): { mergedEnv: Record<string, string | undefined>; shadowedNames: string[] } {
  const merged: Record<string, string | undefined> = {
    ...(process.env as Record<string, string | undefined>),
  };
  if (mode === "env") {
    // Env mode: env IS the source. No store values to overlay.
    scrubProcessEnv();
    return { mergedEnv: merged, shadowedNames: [] };
  }
  // file / encrypted: store is authoritative.
  const decryptResult = secretStore.decryptAll();
  if (!decryptResult.ok) {
    throw new Error(`Secret decryption failed: ${decryptResult.error.message}`);
  }
  const shadowedNames: string[] = [];
  for (const [name, value] of decryptResult.value) {
    if (merged[name] !== undefined && merged[name] !== value) {
      // store wins; collect name for deferred WARN (logger not yet available).
      shadowedNames.push(name);
    }
    merged[name] = value;
  }
  scrubProcessEnv();
  return { mergedEnv: merged, shadowedNames };
}

// ---------------------------------------------------------------------------
// Agents helpers
// ---------------------------------------------------------------------------
// Helpers consumed by `bootAgents`. `wirePostAgentsCleanup` (eventBus.on
// subscriber wiring for session:expired → registry release + Gemini cache
// cleanup + MCP disconnect cleanup; returns the per-session FileStateTracker
// pool) is kept here as a top-level function (large body, single call site).
// `restoreApprovalState` (file I/O against the approvals JSON snapshot left by
// graceful shutdown) lives in `wiring/main-helpers.ts` to keep this file under
// its architecture line cap. Three other helpers (setupMcpManager,
// buildAuditBundle, buildDeferredCronWakeCallback) were inlined into bootAgents.
// ---------------------------------------------------------------------------

/**
 * Wire post-setupAgents cleanup listeners: session:expired releases
 * sessionTrackerRegistry, Gemini cache disposal, and MCP disconnect cleanup.
 * Schedules an orphan-cache cleanup pass for any stale comis:* caches.
 */
function wirePostAgentsCleanup(deps: {
  eventBus: BootContext["container"]["eventBus"];
  geminiCacheManager: GeminiCacheManager;
  daemonLogger: ReturnType<typeof setupLogging>["daemonLogger"];
}): SessionTrackerRegistry<ReturnType<typeof createFileStateTracker>> {
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

// ---------------------------------------------------------------------------
// Channels helpers
// ---------------------------------------------------------------------------
// Helpers consumed by `bootChannels`. Top-level functions:
//   - buildChannelManagerDeps — assembles the wide `setupChannels` deps
//     literal. The 3 deferred-ref slots that used to live here are gone;
//     the lambda payload (onMessageReceived / onMessageProcessed)
//     now reads its dynamic deps via accessor closures supplied by the
//     caller (bootChannels owns the local `let` slots and refreshes them
//     after setupChannels returns).
//   - buildGraphCoordinatorDeps — assembles the createGraphCoordinator
//     deps literal. Inlines the small `buildGraphPreWarm` (Anthropic
//     pre-warm cache config; undefined when no API key resolvable).
//   - setupChannelHealthMonitor — wraps createChannelHealthMonitor +
//     monitor.start so both let bindings (monitor, stop) move out of the
//     stage body into a single helper return value. Lives in
//     wiring/main-helpers.ts (extracted to keep this file under the
//     architecture line cap).
//   - wirePostChannelsLifecycle — populates the delivery-queue
//     channelAdapters map, drains + starts prune timer, mirrors prune
//     lifecycle, wires delivery-queue logging, and starts the output
//     retention housekeeper (when defaultWorkspaceDir is present).
// Inlined helpers: createCapabilityPortResolver (the resolver factory
// becomes a direct `const get… = (agentId) => …` at the call site) and
// buildImageGenBundle (provider + rate limiter + config triplet wired
// inline in bootChannels before setupTools needs them).
// ---------------------------------------------------------------------------

/**
 * Internal alias: a "post-agents BootContext" — Group A foundation + Group B
 * agents fields are known to be populated. Used by channels-stage helpers
 * called inside bootChannels after bootFoundation + bootAgents have completed.
 */
type PostAgentsBootContext = BootContext & Required<Pick<BootContext,
  | "defaultAgentId" | "defaultWorkspaceDir" | "agentsConfig"
  | "executors" | "workspaceDirs" | "sessionManager"
  | "activeRunRegistry" | "sessionResolver" | "approvalGate"
  | "getExecutor" | "piSessionAdapters" | "costTrackers" | "executionTrackers"
  | "linkRunner" | "ssrfFetcher" | "transcriber" | "ttsAdapter"
  | "audioConverter" | "mediaTempManager" | "mediaSemaphore" | "fileExtractor"
  | "rpcCall" | "continuationTracker" | "onSuspiciousContent"
  | "channelAdaptersRef" | "deliveryQueue" | "drainAndStartDeliveryPrune"
  | "shutdownDeliveryQueue" | "executionPlanPorts"
>>;

/**
 * Build the deps object passed to `setupChannels`. The tool-assembler /
 * session-tracker / inbound-message-id-resolver indirection slots are
 * gone — callers pass `assembleToolsForAgent` directly (setupTools is
 * hoisted before setupChannels) and pass `sessionTracker` /
 * `inboundMessageIdResolver` accessor closures that read local-`let` slots
 * captured at message-arrival time.
 */
function buildChannelManagerDeps(deps: {
  agents: PostAgentsBootContext;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- matches assembleToolsForAgent signature from setup-tools.ts
  assembleToolsForAgent: (agentId: string, options?: import("./wiring/setup-tools.js").AssembleToolsOptions) => Promise<any[]>;
  getInboundMessageIdResolver: () => InboundMessageIdResolver | undefined;
  getSessionTracker: () => import("./notification/session-tracker.js").SessionTracker | undefined;
}): Parameters<typeof setupChannels>[0] {
  const { agents, assembleToolsForAgent, getInboundMessageIdResolver, getSessionTracker } = deps;
  const {
    container, executors, defaultAgentId, sessionManager, sessionStore,
    logger, channelsLogger, linkRunner, ssrfFetcher, transcriber,
    ttsAdapter, audioConverter, mediaTempManager, mediaSemaphore, fileExtractor,
    workspaceDirs, defaultWorkspaceDir, memoryAdapter, memoryApi, entityStore, causalStore, consolidationStore, tripleStore, userRepresentationStore, relationshipStore, tunedAlphaStore, memoryLifecycleStore, usefulnessStore, outcomeStore, learnedSkillStore, embeddingQueue,
    activeRunRegistry, sessionResolver, rpcCall,
    continuationTracker, approvalGate, interactiveCallbackWiring,
    piSessionAdapters, costTrackers, deliveryQueue, executionTrackers,
    onSuspiciousContent, dataDir, clock, timers, activityBreaker, activityStream, activityRendererFactoryOverride,
    executionPlanPorts, oauthManagers, mergedEnv,
  } = agents;
  // LEARN-01: per-agent OAuth access-token resolver (auto-refreshing) so the
  // background memory/learning cron jobs run on an OAuth main provider
  // (openai-codex) instead of skipping for "no API key". Wraps the SAME
  // OAuthTokenManager.getApiKey the interactive + media-bundle paths use.
  const resolveCronAccessToken = async (
    agentId: string,
    provider: string,
  ): Promise<string | undefined> => {
    const mgr = oauthManagers?.get(agentId);
    if (!mgr) return undefined;
    const r = await mgr.getApiKey(provider, {
      oauthProfiles: container.config.agents?.[agentId]?.oauthProfiles,
    });
    return r.ok ? r.value : undefined;
  };
  // Complete three-layer forget for channel /new + /reset (live 2026-06-11).
  const channelConversationReset = createConversationReset({ lcdStore: agents.lcdStore, piSessionAdapters, tenantId: container.config.tenantId, logger });
  // Build exportSessionBundle DI closure for the /export-trajectory slash
  // command. Uses exportTrajectoryBundle from @comis/observability (same
  // pipeline as `comis trace export`).
  const exportSessionBundle = async (sessionId: string): Promise<{ bundlePath: string }> => {
    const sessionsDir = safePath(container.config.dataDir ?? dataDir, "sessions");
    const sessionFile = safePath(sessionsDir, `${sessionId}.jsonl`);
    const workspaceDir = defaultWorkspaceDir ?? safePath(container.config.dataDir ?? dataDir, "workspace");
    const result = await exportTrajectoryBundle({
      sessionId,
      sessionKey: sessionId,
      sessionFile,
      workspaceDir,
      traceId: sessionId,  // best-effort; bundle exporter uses for naming only
      agentId: "unknown",  // best-effort; available in session file header
    });
    if (!result.ok) throw new Error(`Bundle export failed: ${result.error.kind}`);
    return { bundlePath: result.value.bundleDir };
  };
  return {
    container, executors, defaultAgentId, sessionManager, sessionStore,
    logger, channelsLogger, clock, timers,
    mergedEnv,  // proxy-agent resolution
    resolveAccessToken: resolveCronAccessToken, // LEARN-01: OAuth-provider background jobs

    // the orchestrator-facing redacted ActivityStream (setupObservability)
    // injected into the inbound coordinatorFactory as its activityStreamPort.
    // the process-singleton circuit breaker shared across every coordinator.
    activityStream, activityBreaker,
    // the DEFAULT agent's shared ExecutionPlanHolder reference
    // (lock — same reference as PiExecutorDeps.executionPlanHolder +
    // AcpServerDeps.executionPlanPort, NOT a parallel createExecutionPlanHolder).
    // Multi-agent note: only the default agent's plan-state reaches chat in this
    // wave; non-default-agent plan updates are filtered out per-turn in the
    // coordinator by the (agentId, sessionKey) guard. A future per-agent
    // plan-stream Map plumbing lifts that single-agent limitation cleanly.
    executionPlanPort: executionPlanPorts.get(defaultAgentId),
    // test-only renderer-injection seam. Default-undefined in production
    // (the daemon override is never set); threaded into buildActivityRenderers so
    // an integration test can inject a spy renderer.
    activityRendererFactory: activityRendererFactoryOverride,
    // signed approval buttons (Telegram/Discord/Slack/LINE) + the Email
    // single-use approval link. The wiring is built once in the agents phase
    // (always present at runtime; optional-typed on BootContext).
    signCallbackData: interactiveCallbackWiring?.signCallbackData,
    mintApprovalLink: interactiveCallbackWiring?.mintApprovalLink,
    // thread the verifier. The InteractiveCallbackRouter is the server-side
    // authority that intercepts inbound button callbacks (inbound-gate.ts) BEFORE
    // slash parsing — without this hop the signed payload reaches the LLM as text.
    interactiveCallbackRouter: interactiveCallbackWiring?.router,
    linkRunner, ssrfFetcher, transcriber,
    maxMediaBytes: container.config.integrations.media.infrastructure.maxRemoteFetchBytes,
    assembleToolsForAgent,
    ttsAdapter, audioConverter, mediaTempManager, mediaSemaphore,
    fileExtractor, fileExtractionConfig: container.config.integrations.media.documentExtraction,
    workspaceDirs, defaultWorkspaceDir, memoryAdapter,
    // the entity-associative store (built in setup-memory on the shared db).
    // Forwarded into registerCronEventListeners -> runMemoryReview (the write path that
    // populates memory_entities / memory_entity_links after each successful store).
    entityStore,
    // the causal store (built in setup-memory on the shared db).
    // Forwarded into registerCronEventListeners -> runMemoryReview (the write path that
    // links cause->effect edges via linkCausal after each successful store). The SAME store
    // also rides the setupAgents read path (the 5th causal recall lane).
    causalStore,
    // the consolidation store (built in setup-memory on the shared db).
    // Forwarded into registerCronEventListeners -> runMemoryConsolidation (the opt-in
    // __MEMORY_CONSOLIDATION__ cron path). The executor recall path does NOT receive it.
    consolidationStore,
    // tripleStore + userRepresentationStore + relationshipStore +
    // tunedAlphaStore/usefulnessStore + memoryLifecycleStore + memoryApi ride the SAME cron-deps chain → the __MEMORY_REASONING__ /
    // __USER_REPRESENTATION__ / __SOCIAL_MODELING__ / __ONLINE_TUNING__ / __MEMORY_LIFECYCLE__ sentinels (the last two are KEYLESS: the bandit over the FEED signal + the DORMANT lifecycle sweep).
    // outcomeStore + learnedSkillStore ride the SAME chain → the __SKILL_SYNTHESIS__ sentinel (SKILL-08/09): the daemon assembles the closed-graph skillSynthesis bundle from them + the tool list/policy + the LCD source inside registerCronEventListeners.
    tripleStore, userRepresentationStore, relationshipStore, tunedAlphaStore, memoryLifecycleStore, usefulnessStore, outcomeStore, learnedSkillStore, memoryApi,
    tenantId: container.config.tenantId,
    embeddingQueue, queueConfig: container.config.queue,
    onSuspiciousContent,
    activeRunRegistry, sessionResolver, rpcCall,
    onMessageReceived: (msg, channelType) => {
      const chatType = typeof msg.metadata?.telegramChatType === "string"
        ? msg.metadata.telegramChatType
        : undefined;
      continuationTracker.track({
        agentId: defaultAgentId, channelType, channelId: msg.channelId,
        userId: msg.senderId, chatType, tenantId: container.config.tenantId, timestamp: Date.now(),
      });
      getInboundMessageIdResolver()?.record(msg, channelType);
    },
    onMessageProcessed: (msg, channelType) => {
      getSessionTracker()?.recordActivity(defaultAgentId, channelType, msg.channelId);
    },
    approvalGate: container.config.approvals?.enabled ? approvalGate : undefined,
    piSessionAdapters, costTrackers, deliveryQueue,
    destroyConversation: channelConversationReset.destroyConversationCompletely,
    lcdStore: agents.lcdStore, contextBrowse: agents.contextBrowse, // review session source (DAG transcripts)
    cronExecutionTrackers: executionTrackers,
    exportSessionBundle,
  };
}

/**
 * Build the deps object passed to `createGraphCoordinator`. The optional
 * pre-warm cache config (Anthropic graph executions) is inlined inside the
 * preWarm field — it returns undefined if no Anthropic API key is resolvable.
 */
function buildGraphCoordinatorDeps(deps: {
  agents: PostAgentsBootContext;
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
  // Pre-warm cache config: undefined if no Anthropic API key resolvable
  // (lifted from buildGraphPreWarm helper).
  const preWarm: NonNullable<Parameters<typeof createGraphCoordinator>[0]["preWarm"]> | undefined = (() => {
    const agentCfg = agentsConfig[defaultAgentId];
    const provider = agentCfg?.provider ?? "anthropic";
    const resolvedModel = agentCfg?.model === "default" || !agentCfg?.model
      ? "claude-sonnet-4-5-20250929"
      : agentCfg.model;
    const apiKey = container.secretManager.get("anthropic-api-key") ?? container.secretManager.get("ANTHROPIC_API_KEY") ?? "";
    if (!apiKey) return undefined;
    return {
      provider, modelId: resolvedModel, apiKey,
      systemPrompt: agentCfg?.name
        ? `You are ${agentCfg.name}. You are a helpful AI assistant.`
        : "You are a helpful AI assistant.",
      tools: [] as Array<{ name: string; description?: string; inputSchema?: unknown }>,
    };
  })();
  // F3: capability-gated graph concurrency — small/nano → 2, frontier/mid → 4.
  // Reads the default agent's model+provider — the same values the preWarm block uses,
  // but declared here in the outer function scope (not inside the IIFE above).
  // Explicit `graphMaxConcurrency` config always wins via the ?? chain below.
  const agentCfg = agentsConfig[defaultAgentId];
  const defaultModel = agentCfg?.model === "default" || !agentCfg?.model
    ? "claude-sonnet-4-5-20250929"
    : agentCfg.model;
  const defaultProvider = agentCfg?.provider ?? "anthropic";
  const capabilityOverride = (
    container.config.providers?.entries?.[defaultProvider]?.capabilities?.capabilityClass
  ) as import("@comis/agent").CapabilityClass | undefined;
  const graphDefaults = resolveGraphConcurrencyDefaults(
    { provider: defaultProvider, modelId: defaultModel },
    capabilityOverride,
  );
  return {
    subAgentRunner: channels.subAgentRunner, eventBus: container.eventBus,
    sendToChannel: channels.sendToChannel, announceToParent: channels.announceToParent,
    batcher: channels.announcementBatcher, tenantId: container.config.tenantId, defaultAgentId,
    maxConcurrency: (a2aSec.graphMaxConcurrency as number | undefined) ?? graphDefaults.maxConcurrency,
    maxResultLength: a2aSec.graphMaxResultLength as number | undefined,
    maxGlobalSubAgents: a2aSec.graphMaxGlobalSubAgents as number | undefined,
    // BUDGET-02/03 (D3): operator default per-node token-budget inherit-share source.
    subAgentTokenBudget: (a2aSec.tokenBudget as number | null | undefined) ?? null,
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
    preWarm,
  };
}

/**
 * Wire post-setupChannels lifecycle hooks: populate the delivery-queue
 * channelAdapters map, drain + start prune timer, mirror prune lifecycle,
 * delivery-queue logging, and output retention housekeeper.
 */
async function wirePostChannelsLifecycle(deps: {
  adaptersByType: Awaited<ReturnType<typeof setupChannels>>["adaptersByType"];
  channelAdaptersRef: NonNullable<BootContext["channelAdaptersRef"]>;
  drainAndStartDeliveryPrune: NonNullable<BootContext["drainAndStartDeliveryPrune"]>;
  shutdownDeliveryQueue: NonNullable<BootContext["shutdownDeliveryQueue"]>;
  /** JOB-03 (189): start + resume the background video poller. Runs AFTER the
   *  channelAdaptersRef.set loop below — the channel registry is now populated, so
   *  the poller's announce-on-complete reaches a LIVE adapter outside a turn. */
  startAndResumeVideoPoller?: () => Promise<void>;
  startMirrorPrune: BootContext["startMirrorPrune"];
  shutdownMirror: BootContext["shutdownMirror"];
  daemonLogger: ReturnType<typeof setupLogging>["daemonLogger"];
  container: BootContext["container"];
  defaultWorkspaceDir: string;
  outputRetentionConfig: BootContext["container"]["config"]["outputRetention"];
}): Promise<{ outputRetentionHandle?: SetupOutputRetentionHandle }> {
  const { adaptersByType, channelAdaptersRef, drainAndStartDeliveryPrune,
    startAndResumeVideoPoller, startMirrorPrune, daemonLogger, container, defaultWorkspaceDir,
    outputRetentionConfig } = deps;
  for (const [type, adapter] of adaptersByType) channelAdaptersRef.set(type, adapter);
  await drainAndStartDeliveryPrune();
  // JOB-03 (189): the channel registry is now populated (channelAdaptersRef was
  // just filled by reference) — start + resume the video poller so a pending
  // render's finished clip announces to the recorded channel outside any turn,
  // exactly like the delivery queue's drainAndStart above.
  await startAndResumeVideoPoller?.();
  // eventBus.on("system:shutdown", ...) subscribers deleted —
  // shutdownDeliveryQueue, shutdownMirror, and outputRetentionHandle.shutdown
  // are surfaced through BootContext / wirePostChannelsLifecycle return
  // shape so the composition root invokes them directly via ShutdownDeps.
  startMirrorPrune();
  setupDeliveryQueueLogging({ eventBus: container.eventBus, logger: daemonLogger });
  if (defaultWorkspaceDir) {
    const outputRetentionHandle = setupOutputRetention({
      config: outputRetentionConfig, workspaceDir: defaultWorkspaceDir, logger: daemonLogger,
    });
    return { outputRetentionHandle };
  }
  daemonLogger.debug(
    { hint: "No defaultWorkspaceDir; output retention housekeeper skipped" },
    "Output retention: skipped (no default workspace)",
  );
  return {};
}

// ---------------------------------------------------------------------------
// Gateway helpers
// ---------------------------------------------------------------------------

/**
 * Internal alias: a "post-channels BootContext" where Group B/C fields are
 * known to be populated.
 */
type PostChannelsBootContext = BootContext & Required<Pick<BootContext,
  | "defaultAgentId" | "defaultWorkspaceDir" | "agentsConfig"
  | "executors" | "workspaceDirs" | "costTrackers" | "budgetGuards" | "stepCounters"
  | "piSessionAdapters" | "skillWatcherHandles" | "skillRegistries" | "toolCapabilityPorts"
  | "singleAgentDeps" | "providerHealth" | "oauthCredentialStore"
  | "activeRunRegistry" | "mcpClientManager"
  | "subAgentRunner" | "crossSessionSender" | "channelManager" | "deliveryService"
  | "adaptersByType" | "channelPlugins" | "inboundMessageIdResolver"
  | "graphCoordinator" | "namedGraphStore" | "nodeTypeRegistry"
  | "channelHealthMonitor" | "notificationContext"
  | "modelCatalog" | "channelConfig" | "suspendedAgents"
  | "approvalGate" | "wakeCoalescer"
  | "cronSchedulers" | "executionTrackers" | "getAgentCronScheduler" | "getAgentBrowserService"
  | "memoryApi" | "memoryAdapter" | "embeddingQueue" | "continuationTracker"
  | "ttsAdapter" | "visionRegistry" | "linkRunner" | "transcriber" | "fileExtractor"
  | "resolveAttachment" | "deliveryQueue"
  | "imageGenProvider" | "imageGenRateLimiter" | "imageGenConfig" | "persistImage" | "imageGenCostLimiter"
  | "videoGenProvider" | "videoGenRateLimiter" | "videoGenConfig" | "persistVideo" | "videoGenCostLimiter"
>>;

/**
 * Factory: hot-add agent closure. Returns the closure that captures
 * destructured Maps + setupSingleAgent + shutdownRef + eventBus by reference
 * (all consumers hold the same Map references).
 */
function createHotAdd(deps: {
  channels: PostChannelsBootContext;
  shutdownRef: { value?: { readonly isShuttingDown: boolean } };
}): (agentId: string, config: PerAgentConfig, rawRerankEnabled?: boolean | undefined) => Promise<void> {
  const { channels, shutdownRef } = deps;
  const {
    singleAgentDeps, executors, workspaceDirs, costTrackers, budgetGuards,
    stepCounters, piSessionAdapters, skillWatcherHandles, skillRegistries,
    toolCapabilityPorts, container, daemonLogger,
  } = channels;
  return async (agentId, config, rawRerankEnabled) => {
    const startMs = systemNowMs();
    if (shutdownRef.value?.isShuttingDown) {
      throw new Error("Cannot hot-add agent during shutdown");
    }
    // forward the RAW rerank signal from the agents.create RPC input
    // so the hot-added agent's effective-rerank precedence matches the boot path.
    const result = await setupSingleAgent(agentId, config, singleAgentDeps, rawRerankEnabled);
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
    container.eventBus.emit("agent:hot_added", { agentId, timestamp: systemNowMs() });
    daemonLogger.info({ agentId, durationMs: systemNowMs() - startMs }, "Agent hot-added to running daemon");
  };
}

/**
 * Factory: hot-remove agent closure. Mirror of createHotAdd.
 */
function createHotRemove(deps: {
  channels: PostChannelsBootContext;
}): (agentId: string) => Promise<void> {
  const {
    activeRunRegistry, daemonLogger, skillWatcherHandles, executors, workspaceDirs,
    costTrackers, budgetGuards, stepCounters, piSessionAdapters, skillRegistries,
    toolCapabilityPorts, container,
  } = deps.channels;
  return async (agentId) => {
    const startMs = systemNowMs();
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
    container.eventBus.emit("agent:hot_removed", { agentId, timestamp: systemNowMs() });
    daemonLogger.info({ agentId, durationMs: systemNowMs() - startMs }, "Agent hot-removed from running daemon");
  };
}

/**
 * Build the rpcDispatchDeps literal. Inlines the image-handler-deps,
 * token-store-mutators, and context-engine-config helpers — each was a
 * trivial one-call-site builder.
 */
function buildRpcDispatchDeps(deps: {
  channels: PostChannelsBootContext;
  startupStartMs: number;
  gateway: import("./daemon-types.js").GatewayPreDispatchSlice;
  defaultConfigPaths: string[];
}): import("./api/rpc-dispatch.js").ApiDispatchDeps {
  const { channels: c, gateway: g, startupStartMs, defaultConfigPaths } = deps;
  // RES-01 keystone (I4 lockstep): the agent's main provider via the EXACT
  // completion-path resolver, falling back to the configurable defaultAgentId
  // (NOT literal "default"; WR-01 183-REVIEW). See resolveAgentMainProvider in
  // setup-agents-tooling.ts for the fallback + honest-sentinel semantics.
  const resolveAgentMainProviderFor = (agentId: string): { providerId: string } =>
    resolveAgentMainProvider(c.container.config.agents, c.container.config.models, agentId, c.defaultAgentId);
  // WR-04 (186-REVIEW): extracted to buildImageHandlerDeps (wiring/main-helpers.ts)
  // to keep this composition root under its 3000-line architecture cap — the
  // literal previously crammed six concerns onto one line to fit. Undefined when
  // image generation is disabled (no provider / rate limiter).
  const imageHandlerDeps = buildImageHandlerDeps(c, resolveAgentMainProviderFor);
  // Phase 188: video.generate handler deps (undefined when disabled). The spread
  // into ApiDispatchDeps below wires the live handler (source guard pins it).
  const videoHandlerDeps = buildVideoHandlerDeps(c, resolveAgentMainProviderFor);
  // Phase 189 (JOB-04): video.status read-handler deps (undefined when disabled) —
  // reads the SAME agent-scoped store the poller writes. Spread below (guard pins it).
  const videoStatusHandlerDeps = buildVideoStatusHandlerDeps(c);
  // Inlined buildTokenStoreMutators.
  const addToTokenStore: import("./api/rpc-dispatch.js").ApiDispatchDeps["addToTokenStore"] = (entry) => { g.runtimeTokens.push({ id: entry.id, secretBuf: Buffer.from(entry.secret, "utf-8"), scopes: entry.scopes }); };
  const removeFromTokenStore: import("./api/rpc-dispatch.js").ApiDispatchDeps["removeFromTokenStore"] = (id) => {
    g.removedTokenIds.add(id);
    const idx = g.runtimeTokens.findIndex((t) => t.id === id);
    if (idx >= 0) g.runtimeTokens.splice(idx, 1);
  };
  // Pass-through to the ONE mode-selected MCP OAuth token store the composition
  // root built via selectMcpTokenStore (threaded onto the boot context). Both
  // mcp-handlers (Fix 4 — pre-check no-token before manager.connect) and
  // mcp-oauth-handlers (read/write tokens during login) consume this factory and
  // receive the SAME instance setupMcp's manager wiring uses — no split-brain,
  // no plaintext-disk fallback. Returns undefined in env mode (no writable MCP
  // OAuth store); consumers guard on undefined.
  const createTokenStore: import("./api/rpc-dispatch.js").ApiDispatchDeps["createTokenStore"] = () => c.mcpTokenStore;
  // the single in-process recall-counter registry is stood up once in
  // setup-memory (the composition site that holds the event bus) and threaded
  // here on the boot context. The snapshot accessor feeds the
  // memory.recall_stats handler (comis memory stats reads live counters). The
  // gauge is daemon-lifetime — it resets on restart.
  const recallCounters = c.recallCounters;
  const dialecticWiring = buildDialecticWiring(dialecticWiringDepsFromBoot(c)); // the memory.ask seam + per-agent recall factory (setup-dialectic.ts owns the wiring; the cost gate returns {} when off). Spread into the dispatch deps below; the forward-presence belt locks the spread.
  // L3 destroy for session.reset_conversation (live 2026-06-11: skipping it resurrected the forget).
  const conversationReset = createConversationReset({ lcdStore: c.lcdStore, sessionStore: g.sessionStoreBridge, piSessionAdapters: c.piSessionAdapters, tenantId: c.container.config.tenantId, logger: c.logger });
  return {
    defaultAgentId: c.defaultAgentId, getAgentCronScheduler: c.getAgentCronScheduler,
    cronSchedulers: c.cronSchedulers, executionTrackers: c.executionTrackers, wakeCoalescer: c.wakeCoalescer,
    defaultWorkspaceDir: c.defaultWorkspaceDir, workspaceDirs: c.workspaceDirs,
    memoryApi: c.memoryApi, memoryAdapter: c.memoryAdapter, embeddingQueue: c.embeddingQueue,
    // DIST-05: thread the memory adapter as the MemoryPort for the
    // session.reset_conversation --memory honest reset. SqliteMemoryAdapter
    // implements MemoryPort (incl. deleteBySessionKey, Phase 172-03), so the
    // SAME object satisfies SessionsApiDeps.memoryPort. consolidationStore (the
    // unlink/purge surface) is already on the spread below.
    memoryPort: c.memoryAdapter,
    destroyRuntimeSession: (formattedSessionKey: string) => conversationReset.destroyRuntimeSession(c.defaultAgentId, formattedSessionKey),
    // CR-02 (175-REVIEW): session.reset_conversation / session.delete drop
    // the executor's session-scoped state (tool-schema snapshots, GBNF-02
    // strip-retry once-gate, JIT-guide delivery, cache latches) through the
    // agent's single authoritative cleanup path — the same function the
    // session:expired listener uses (wireSessionStateCleanup above).
    clearAgentSessionState: clearSessionState,
    // context.* operator-browse RPC deps (Context DAG browser): the LCD
    // ContextStorePort (context.tree reads getSummaries/getContextItems) + the
    // ContextBrowsePort (context.conversations). Both R4 agent+tenant scoped.
    lcdStore: c.lcdStore, contextBrowse: c.contextBrowse,
    // memory-diagnostic deps: the scoped consolidation + entity stores
    // (provenance + entity-graph reads) and the live recall counters
    // for the 4 admin-gated memory.* diagnostic handlers. (usefulnessStore is NOT
    // here — no diagnostic handler consumes it; its read path is the setupAgents
    // injection at the setupAgents({…}) call below, mirroring entityStore.)
    consolidationStore: c.consolidationStore, entityStore: c.entityStore, recallCounters, ...dialecticWiring, onSuspiciousContent: c.onSuspiciousContent,
    recallTraceEnabled: c.container.config.diagnostics?.recallTrace?.enabled ?? false, // memory.recall_trace honest-empty gate
    tenantId: c.container.config.tenantId, agents: c.agentsConfig, costTrackers: c.costTrackers, stepCounters: c.stepCounters,
    agentDataDir: safePath(c.container.config.dataDir ?? safePath(os.homedir(), ".comis"), "agents"),
    sessionStore: g.sessionStoreBridge,
    crossSessionSender: c.crossSessionSender, subAgentRunner: c.subAgentRunner,
    graphCoordinator: c.graphCoordinator, namedGraphStore: c.namedGraphStore, nodeTypeRegistry: c.nodeTypeRegistry,
    securityConfig: c.container.config.security, adaptersByType: c.adaptersByType,
    inboundMessageIdResolver: c.inboundMessageIdResolver, visionRegistry: c.visionRegistry, resolveAgentMainProvider: resolveAgentMainProviderFor, mainModelIdFor: c.mediaVisionBundle?.resolveMainModelId, mainProviderVision: c.mediaVisionBundle?.capability, trajectoryRegistry: c.trajectoryRegistry,
    mediaConfig: c.container.config.integrations.media, ttsAdapter: c.ttsAdapter, linkRunner: c.linkRunner,
    logger: c.logger, container: c.container, configPaths: c.configPaths, defaultConfigPaths,
    configGitManager: c.configGitManager,
    configWebhook: c.container.config.daemon.configWebhook as { url?: string; timeoutMs?: number; secret?: string },
    secretStore: c.secretStore, mutableSecretManager: c.mutableHandle, envFilePath: c.envPath, logLevelManager: c.logLevelManager,
    getAgentBrowserService: c.getAgentBrowserService,
    resolveAttachment: c.resolveAttachment, transcriber: c.transcriber, fileExtractor: c.fileExtractor, voiceSelection: c.voiceSelection,
    approvalGate: c.approvalGate, suspendedAgents: c.suspendedAgents,
    hotAdd: g.hotAdd, hotRemove: g.hotRemove,
    diagnosticCollector: c.diagnosticCollector, billingEstimator: c.billingEstimator,
    channelActivityTracker: c.channelActivityTracker, deliveryTracer: c.deliveryTracer, budgetGuards: c.budgetGuards,
    // WEBUI-02 (179-04): thread the LIVE spend snapshot the kill-switch enforces
    // (locked A1 — getSnapshot(), NOT the lagging SQL) + the configured ceilings, so
    // obs.spend.snapshot computes headroom = ceiling − spend. Absent ⇒ spend off
    // (the handler degrades to an honest enabled:false, never a misleading $0).
    spendSnapshot: c.spendAccumulator
      ? () => ({
          ...c.spendAccumulator!.getSnapshot(),
          ceilings: {
            perAgentUsd: c.container.config.observability.spend.perAgentUsd,
            perTenantUsd: c.container.config.observability.spend.perTenantUsd,
            daemonGlobalUsd: c.container.config.observability.spend.daemonGlobalUsd,
          },
        })
      : undefined,
    modelCatalog: c.modelCatalog, channelConfig: c.channelConfig,
    tokenRegistry: g.tokenRegistry,
    addToTokenStore, removeFromTokenStore,
    createTokenStore,
    memoryWriteValidator: validateMemoryWrite,
    // MemoryApiDeps.eventBus accepts the full AppContainer["eventBus"] type;
    // no down-cast to `{ emit }` is needed.
    eventBus: c.container.eventBus,
    mcpClientManager: c.mcpClientManager,
    // 161-02: ObservabilityApiDeps.clock = the SAME boot ClockPort (one createSystemClock()
    // at the composition root) so the obs.fleet.health assembler has a clock (asserts deps.clock!).
    obsStore: c.obsStore, clock: c.clock, startupTimestamp: startupStartMs, sharedCostTracker: c.sharedCostTracker,
    // obs.getCacheStats reads deps.tokenTracker for the in-memory hit-rate/effectiveness;
    // without this it fell to the `!deps.tokenTracker` branch and returned a silent 0/0
    // forever, even at an 85% live hit rate (live cache-management finding, 2026-06-12).
    tokenTracker: c.tokenTracker,
    contextPipelineCollector: c.contextPipelineCollector, execGit: c.execGit,
    deliveryQueue: c.deliveryQueue, deliveryService: c.deliveryService,
    channelPlugins: c.channelPlugins, healthMonitor: c.channelHealthMonitor,
    embeddingCacheStats: c.embeddingCacheStats, embeddingCircuitBreakerState: c.embeddingCircuitBreakerState,
    skillRegistries: c.skillRegistries, notificationService: c.notificationContext.notificationService,
    imageHandlerDeps,
    videoHandlerDeps,
    videoStatusHandlerDeps,
    oauthCredentialStore: c.oauthCredentialStore,
    // Wire observability DI seams.
    // ObservabilityApiDeps.dataDir: used by obs.trace.* handlers for session-index + bundle export.
    // ObservabilityApiDeps.exportTrajectoryBundle: DI seam for obs.trace.export RPC (comis trace export <sessionId>).
    dataDir: c.dataDir,
    exportTrajectoryBundle,
  };
}

/**
 * Replay restart continuations from disk if any. Owns the block that
 * loads persisted continuation records and re-injects synthetic restart
 * messages through channelManager. Per-record synthetic message construction
 * is inlined inside the per-record loop.
 */
async function replayContinuationsIfAny(deps: {
  channels: PostChannelsBootContext;
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
    // Inlined buildSyntheticRestartMessage: synthetic-restart message payload
    // for a single continuation record. Rehydrates chat-type metadata so
    // downstream resolveChatType / isGroupMessage classify correctly.
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
    const syntheticMsg = {
      id: randomUUID(),
      channelId: record.channelId,
      channelType: record.channelType,
      senderId: record.userId,
      text: mcpStatusLine ? `${baseText}\n${mcpStatusLine}` : baseText,
      timestamp: Date.now(),
      attachments: [] as never[],
      metadata,
    };
    channelManager.injectMessage(record.channelType, syntheticMsg).catch((injectErr) => {
      daemonLogger.warn(
        { err: injectErr, channelType: record.channelType, channelId: record.channelId, hint: "Continuation replay failed; user can re-send to resume", errorKind: "internal" as const },
        "Failed to replay continuation",
      );
    });
  }
}

// ---------------------------------------------------------------------------
// Shutdown helpers
// ---------------------------------------------------------------------------

/**
 * Wire eventBus health subscriptions to structured logger metrics.
 * Reads metrics from the observability event bus, prunes prompt timeouts,
 * computes stuck-sub-agent counters, force-kills sub-agents past threshold,
 * and emits the canonical "Daemon health" DEBUG line. The DB-size metrics
 * and stuck-sub-agent computation are inlined directly into the subscriber
 * body (each was a single-call-site helper).
 */
function wireHealthLogging(deps: {
  container: BootContext["container"];
  daemonLogger: BootContext["daemonLogger"];
  db: BootContext["db"];
  maintenanceTick: BootContext["maintenanceTick"];
  subAgentRunner: NonNullable<BootContext["subAgentRunner"]>;
  promptTimeoutTimestamps: NonNullable<BootContext["promptTimeoutTimestamps"]>;
  activeExecutions: NonNullable<BootContext["activeExecutions"]>;
  getActiveConnectionCount: NonNullable<BootContext["getActiveConnectionCount"]>;
  deadLetterQueue: BootContext["deadLetterQueue"];
  providerHealth: NonNullable<BootContext["providerHealth"]>;
  deliveryQueue: NonNullable<BootContext["deliveryQueue"]>;
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
    // Inlined readDbSizeMetrics: best-effort DB file + WAL file sizes.
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
    maintenanceTick();
    // Inlined computeAndKillStuckSubAgents: count active sub-agent runs and
    // force-kill any past the threshold-aware cutoff. Graph sub-agents get a
    // longer threshold since they do multi-step analytical work.
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
 * Emits the canonical "Comis daemon started" INFO line (log line 5 in
 * daemon-lifecycle.test.ts). The startup-banner-manifest sub-object is
 * inlined directly into the log call.
 */
function emitStartupBanner(deps: {
  container: BootContext["container"];
  daemonLogger: BootContext["daemonLogger"];
  daemonVersion: BootContext["daemonVersion"];
  agents: NonNullable<BootContext["agentsConfig"]>;
  adaptersByType: NonNullable<BootContext["adaptersByType"]>;
  configPaths: BootContext["configPaths"];
  db: BootContext["db"];
  secretStore: BootContext["secretStore"];
  cachedPort: BootContext["cachedPort"];
  ttsAdapter: BootContext["ttsAdapter"];
  visionRegistry: BootContext["visionRegistry"];
  startupStartMs: number;
  instanceId: string;
}): void {
  const {
    container, daemonLogger, daemonVersion, agents, adaptersByType, configPaths,
    db, secretStore, cachedPort, ttsAdapter, visionRegistry,
    startupStartMs, instanceId,
  } = deps;
  const gwConfig = container.config.gateway;
  // Inlined buildStartupBannerManifest: secrets/memory/agents/skills/gateway sub-object.
  const manifest: Record<string, unknown> = {
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
  daemonLogger.info({
    version: daemonVersion, agents: Object.keys(agents),
    channels: Array.from(adaptersByType.keys()),
    port: gwConfig.enabled ? gwConfig.port : undefined, instanceId,
    startupDurationMs: Date.now() - startupStartMs, configPaths, dbPath: db.name,
    logLevel: container.config.logLevel ?? "debug", nodeVersion: process.versions.node,
    manifest,
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

// ---------------------------------------------------------------------------
// Stage 1: foundation
// ---------------------------------------------------------------------------

/**
 * bootFoundation — daemon-process foundation startup. Owns:
 *   - data directory + .env load + permission hardening
 *   - secret decryption + env merge + process.env scrub
 *   - bootstrap (core container) + config-secret-ref resolution
 *   - config git versioning
 *   - logging + observability + context-pipeline collector
 *   - health (process monitor)
 *   - memory + embedding + observability-persistence
 *   - context store + active-run registry + session resolver
 *   - canary fallback + injection rate limiter
 *   - delivery mirror + Gemini cache manager
 *   - background task system + deferred channel/notification refs
 *   - bundled skill-creator seeding (idempotent)
 *
 * Mutates `boot` with all Group A foundation fields. Per-line-source order
 * preserved so daemon-lifecycle.test.ts log-sequence assertions remain green.
 */
async function bootFoundation(
  boot: BootContext,
  input: {
    overrides: DaemonOverrides;
    startupStartMs: number;
    instanceId: string;
  },
): Promise<void> {
  const { overrides, startupStartMs, instanceId } = input;
  const _bootstrap = overrides.bootstrap ?? bootstrap;
  const _preReadStorageMode = overrides.preReadStorageMode ?? preReadStorageMode;
  const _writeMasterKeyIfAbsent = overrides.writeMasterKeyIfAbsent ?? writeMasterKeyIfAbsent;
  const _createTracingLogger = overrides.createTracingLogger ?? createTracingLogger;
  const _createLogLevelManager = overrides.createLogLevelManager ?? createLogLevelManager;
  const _createTokenTracker = overrides.createTokenTracker ?? createTokenTracker;
  const _createProcessMonitor = overrides.createProcessMonitor ?? createProcessMonitor;

  // 0. Resolve data directory + config paths, then load secrets from <dataDir>/.env.
  // eslint-disable-next-line no-restricted-syntax -- process.env access needed before SecretManager is initialized
  const dataDir = process.env["COMIS_DATA_DIR"] ?? safePath(os.homedir(), ".comis");
  const envPath = safePath(dataDir, ".env");

  // Resolve config paths up front so we can pre-read security.storage
  // before writeMasterKeyIfAbsent. The full bootstrap (which validates the
  // whole config + does ${VAR} substitution) runs later — it depends on
  // mergedEnv, which depends on whether the encrypted store opened.
  // eslint-disable-next-line no-restricted-syntax -- process.env access needed before SecretManager for config path resolution + VITEST guard
  const rawConfigPaths = process.env["COMIS_CONFIG_PATHS"]; if (process.env["VITEST"] === "true" && !rawConfigPaths) throw new Error("VITEST=true and COMIS_CONFIG_PATHS unset — refusing to read ~/.comis/config.yaml from a test process. Set COMIS_CONFIG_PATHS to a sandbox path in your test setup, or import test/support/vitest-process-listeners.ts.");
  const requestedConfigPaths = rawConfigPaths ? rawConfigPaths.split(":") : DEFAULT_CONFIG_PATHS;

  // P0 boot gate: ensure file/env first boot creates no key material.
  //
  // Step 1: Pre-read security.storage from YAML (layered, last-wins). Returns
  // "encrypted"|"file"|"env". NEVER writes key material before this check.
  const storageMode = _preReadStorageMode(requestedConfigPaths);

  // Step 2: Write master key ONLY when storageMode is "encrypted".
  // file/env modes create NO key material on first boot.
  if (storageMode === "encrypted") {
    _writeMasterKeyIfAbsent(dataDir);
    // loadEnvFile below picks up the freshly-written key from the .env file,
    // so selectSecretStore can read SECRETS_MASTER_KEY from process.env.
  }

  loadEnvFile(envPath);

  // 0.5. Select secret store by mode, merge with env, scrub process.env.
  const permissionCorrections = hardenDataDirPermissions(dataDir);
  // singleton lock — must run before any store bootstrap.
  acquireDataDirLock(dataDir);
  // On boot failure (e.g. selectSecretStore error, bootstrap failure), release
  // the lock. Under normal boot setupShutdown.onShutdown owns the release.
  try {

  // selectSecretStore is called BEFORE scrubProcessEnv so encrypted mode
  // can still read SECRETS_MASTER_KEY from process.env.
  //
  // sensitiveNames: built here at the composition root (a sanctioned process.env
  // access point per AGENTS.md §2.8). In file/encrypted modes the names are
  // passed to the env adapter via selectSecretStore but ignored there.
  // NOTE: sensitiveNames and env snapshot must be built AFTER loadEnvFile so ~/.comis/.env vars are included.
  const sensitiveNames = new Set<string>([
    ...SENSITIVE_EXACT_KEYS,
    ...Object.keys(process.env).filter(k =>
      SENSITIVE_PREFIXES.some(p => k.startsWith(p))
    ),
  ]);
  const storeResult = selectSecretStore({
    mode: storageMode,
    dataDir,
    env: process.env as Record<string, string | undefined>,
    sensitiveNames,
  });
  if (!storeResult.ok) {
    throw new Error(`Failed to open secret store (mode: ${storageMode}): ${storeResult.error.message}`);
  }
  const selected = storeResult.value;
  const secretStore: import("@comis/core").SecretStorePort = selected.secretStore;
  let secretsCrypto: import("@comis/core").SecretsCrypto | undefined;
  let secretsDb: import("better-sqlite3").Database | undefined;
  if (selected.kind === "encrypted") {
    secretsCrypto = selected.secretsCrypto;
    secretsDb = selected.secretsDb;
  }

  // Build mergedEnv (store-wins) + stage-1 scrub.
  const { mergedEnv, shadowedNames } = buildMergedEnv(secretStore, storageMode);

  // 0.6. Runtime adapter construction (composition root). overrides.timers is opt-in for test fake-timers; never set in production.
  const clock = createSystemClock(); const env = createSystemEnv(mergedEnv); const timers = overrides.timers ?? createSystemTimers();
  // test-only renderer-injection seam (mirrors overrides.timers): captured here
  // and threaded onto BootContext so buildChannelManagerDeps can forward it into
  // buildActivityRenderers. Never set in production; inert on the inbound path.
  const activityRendererFactory = overrides.activityRendererFactory;
  // ONE process-singleton ActivityCircuitBreaker, constructed at the
  // composition root and shared across EVERY per-turn coordinator the inbound
  // coordinatorFactory builds. Constructed once here (NOT inside a per-turn or
  // per-agent loop) so a permission/error storm on one (agentId, channelKey) pair
  // auto-quiesces that pair across turns. Threaded down via BootContext →
  // buildChannelManagerDeps → ChannelsDeps → buildAndStartChannelManager.
  const activityBreaker = createActivityCircuitBreaker(clock);
  // Shared-map SecretManager: construct BEFORE bootstrap; same Map → AppContainer + mutableHandle.
  const { secretManager: sharedSecretManager, mutableHandle } = setupSecretManager(mergedEnv);
  const wrappedBootstrap = (opts: Parameters<typeof _bootstrap>[0]) => _bootstrap({ ...opts, secretManager: sharedSecretManager });
  // 1. Bootstrap core container. (security.storage pre-read in step 0 before encrypted-store bootstrap.)
  const { configPaths, bootResult } = await runConfigBootstrapAndEmitObserve({ requestedConfigPaths, mergedEnv, bootstrap: wrappedBootstrap });
  if (!bootResult.ok) {
    throw new Error(`Bootstrap failed: ${bootResult.error.message}`);
  }
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

  // Install global proxy dispatcher BEFORE the Stage-2 env scrub so mergedEnv
  // (store-wins snapshot) is still intact. ProxyConfigError → FATAL bootstrap
  // abort naming the configKey (fail-closed). Posture captured here (pre-logger);
  // deferred INFO line emitted after setupLogging().
  const proxyBootPosture: ProxyBootPosture = await installProxyAtBoot(container, mergedEnv);

  // Stage-2 scrub: remove config-referenced SecretRef names from process.env; runs after config parse.
  for (const name of container.platformSecretNames) {
    // eslint-disable-next-line no-restricted-syntax -- stage-2 scrub
    delete process.env[name];
  }

  // 1.5. Config git versioning (inlined wireConfigGitManager).
  const execGit = createExecGit();
  const configDir = configPaths.length > 0 ? pathDirname(configPaths[0]!) : "";
  const configGitManager: ReturnType<typeof createConfigGitManager> | undefined = configDir
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

  // Emit exactly one module:"proxy" INFO when proxy is active.
  // Deferred from the install site because daemonLogger was not yet available there.
  // Gate on configured — zero-config path emits nothing.
  logProxyPosture(daemonLogger, proxyBootPosture);

  // Deferred store-wins WARNs: shadow notifications (collected pre-logger).
  // Log name only — never value (residency invariant).
  for (const name of shadowedNames) {
    daemonLogger.warn(
      { submodule: "secrets-overlay", secretName: name },
      `Secret '${name}' defined in both the active store and process.env — ` +
      "store value is authoritative. The env var has been removed from process.env.",
    );
  }

  // Assert pre-read storageMode === post-bootstrap security.storage (invariant).
  // security.storage is a boot-critical, runtime-immutable switch that must be a literal
  // value — ${VAR} substitution is not supported for this field, because preReadStorageMode
  // (raw YAML scan, no variable expansion) gates key-material writes before
  // bootstrap resolves the substitution. A mismatch means ${VAR} was used and the two
  // values disagree — fail boot loudly rather than silently misrouting credential storage.
  if (container.config.security.storage !== storageMode) {
    throw new Error(
      `[CONFIG_ERROR] security.storage resolved to '${container.config.security.storage}' ` +
      `after config substitution, but pre-read value was '${storageMode}'. ` +
      "security.storage must be a literal value (encrypted|file|env); " +
      "${VAR} references are not supported for this field.",
    );
  }

  // P0 boot: file/env storage mode INFO log (logger now available).
  // No WARN needed — the legacy opt-out path now fails at the boot gate above.
  // If we reach here with storageMode !== "encrypted", it is a valid P0 mode.
  if (storageMode !== "encrypted") {
    daemonLogger.info(
      {
        storageMode,
        hint: "Credential stores operating in non-encrypted mode. SECRETS_MASTER_KEY and secrets.db are not created.",
      },
      `security.storage: ${storageMode} — no key material created.`,
    );
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
    tokenTracker, sharedCostTracker,
    diagnosticCollector, billingEstimator, channelActivityTracker, deliveryTracer,
    // the canonical redacted ActivityStream (the orchestrator-facing
    // ActivityStreamPort) + its drain hook. `activityStream` is injected into
    // ExecutionPipelineDeps + the ACP renderer hook; `disposeActivityStream` is
    // threaded into setupShutdown. The activity-stream logger + homeDir
    // are read here at the sanctioned composition root (no env reads in the
    // substrate; injected logger).
    activityStream, disposeActivityStream, spendAccumulator, otelHandle, // spendAccumulator: Phase 177 kill-switch (live-incremented, REHYDRATED below, threaded to bridges); otelHandle: Phase 178 OTLP/Prometheus exporter handle → setupShutdown.
  } = await setupObservability({
    eventBus: container.eventBus,
    _createTokenTracker,
    logger: logLevelManager.getLogger("observability"),
    activityLogger: logLevelManager.getLogger("activity-stream"),
    homeDir: mergedEnv["HOME"],
    dataDir, clock, config: container.config, version: daemonVersion, // Phase 177 (clock+config): construct the spend accumulator here (ceilings from config.observability.spend). Phase 178/CR-01: daemonVersion → comis_build_info{version}.
    // runtime reachability: resolve the DEFAULT agent's activity.theme →
    // themeForName bundle and forward it so the process-wide ActivityStream's
    // subagent marker follows the configured theme (the four themes are now
    // selectable at runtime; the schema fully-defaults activity.theme, the
    // `?? "default"` is belt-and-suspenders). Per-agent-per-turn theming via
    // TurnActivityContext is a documented future refinement.
    theme: themeForName(
      container.config.agents[container.config.routing.defaultAgentId]?.activity?.theme ?? "default",
    ),
  });
  const contextPipelineCollector = createContextPipelineCollector({
    eventBus: container.eventBus,
    logger: logLevelManager.getLogger("context-pipeline"),
  });

  // The ActivityStream substrate is live and subscribed to the
  // EventBus. The orchestrator-facing ActivityStreamPort +
  // the per-channel coordinator-factory are now threaded into the INBOUND
  // execution pipeline (ExecutionPipelineDeps.activityStreamPort /
  // coordinatorFactory) — `activityStream` flows through buildChannelManagerDeps →
  // ChannelsDeps → buildAndStartChannelManager, which assembles the
  // coordinatorFactory over the live activityRenderers map and injects it onto
  // createChannelManager. The substrate is drained on shutdown via
  // disposeActivityStream. Per-renderer egress stays fail-closed until an
  // operator opts in via activity.channels.<rendererKey> (§22.2 Day-0).
  daemonLogger.debug(
    { component: "activity-stream", counters: activityStream.counters() },
    "ActivityStream substrate constructed and subscribed to EventBus",
  );

  // 5. Health / process
  const { processMonitor } = setupHealth({
    container, logger, daemonLogger, _createProcessMonitor,
  });

  // WR-01: the shared per-agent learned-skill SURFACE registry — created BEFORE the memory
  // wiring (which stands up the promote/demote loop) and threaded into BOTH it and setupAgents,
  // so a promote/demote can re-refresh the agent that registered its surface cache.
  const learnedSkillSurfaceRegistry = createLearnedSkillSurfaceRegistry();

  // 6.5. Memory + embedding
  const {
    disposeEmbedding, cachedPort, memoryAdapter, db,
    sessionStore, memoryApi, embeddingQueue, backgroundIndexingPromise,
    embeddingCacheStats, embeddingCircuitBreakerState, maintenanceTick,
    summarizerSpendBreaker,
    rerankerPort, rerankerModelPresent, disposeReranker, entityStore, lcdStore, provenanceStore, contextBrowse, temporalStore, causalStore, tripleStore, embeddingStore, usefulnessStore, userRepresentationStore, relationshipStore, tunedAlphaStore, outcomeStore, learnedSkillStore, recordOutboundMessage, destroyReactionWiring, memoryLifecycleStore, consolidationStore, recallCounters,
  } = await setupMemory({ container, memoryLogger, clock, timers, learnedSkillSurfaceRegistry });

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
          // AUDIT-01: the security-audit.jsonl lives under <dataDir>/logs and
          // rides the shared observability.logRotation policy (the 6th stream).
          dataDir: container.config.dataDir || dataDir,
          logRotation: {
            maxSizeBytes: obsConfig.logRotation.maxSizeBytes,
            maxFiles: obsConfig.logRotation.maxFiles,
          },
          auditConfig: { persist: obsConfig.audit.persist, sink: obsConfig.audit.sink },
          // PERSIST-01: the cache_break subscriber is opt-out-able via this flag (default on).
          persistence: { cacheBreaks: obsConfig.persistence.cacheBreaks },
        });
        return { obsStore: store, obsPersistence: persistence };
      })()
    : undefined;
  const obsStore = obsBundle?.obsStore; // trajectory recorder is per-session (pi-executor.ts).
  const obsPersistence = obsBundle?.obsPersistence;
  // Phase 177: REHYDRATE the spend accumulator at the boot root, AFTER obsStore exists (the rolling-spend read lives there); NO-OPS when obsStore is undefined (persistence off → start at $0). 24h window.
  if (spendAccumulator) rehydrateSpendFromStore(spendAccumulator, obsStore, 24 * 60 * 60 * 1000);

  // OUTCOME-07: prune the append-only outcome_events ledger at EVERY boot,
  // UNCONDITIONALLY — deliberately OUTSIDE the obsConfig.persistence.enabled IIFE
  // above, because this is anti-DoS housekeeping that must run regardless of obs
  // persistence OR the learningOutcome enable flag (a ledger that grew while the
  // signal was briefly enabled must still be bounded after it is turned off). The
  // ledger is tenant/agent-agnostic, so retain the LONGEST horizon any agent asks
  // for (default 30 from the Plan-01 schema) — never prune one agent's data early.
  {
    const learningOutcomeRetentionDays = Math.max(
      30,
      ...Object.values(container.config.agents ?? {}).map(
        (a) => a?.learningOutcome?.retentionDays ?? 30,
      ),
    );
    const outcomePruneStart = systemNowMs();
    const outcomePruned = outcomeStore.prune(learningOutcomeRetentionDays);
    daemonLogger.info(
      {
        retentionDays: learningOutcomeRetentionDays,
        pruned: outcomePruned.changes,
        durationMs: systemNowMs() - outcomePruneStart,
      },
      "Outcome events pruned on startup",
    );
  }

  // I2: one-shot model_health boot snapshot — embedding/reranker load-level
  // signals as a queryable obs_diagnostics row (no-ops when persistence off).
  // EMB-01 adds the two advisory multilingual booleans (provider-aware resolution
  // in resolveModelHealthMultilingual; advisory only — no recall gated, I4).
  recordModelHealth(obsStore, {
    embeddingAvailable: !!cachedPort, rerankerModelPresent, rerankerBuilt: rerankerPort !== undefined,
    ...resolveModelHealthMultilingual(container.config),
  }, clock);

  // Create daemon-level runtime registries
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

  // 6.5.2. Credential broker (constructed only when executor.broker is configured)
  const brokerHandle = container.config.executor?.broker
    ? await setupBroker({
        dataDir,
        eventBus: container.eventBus,
        logger: daemonLogger,
        clock,
        timers,
        secretManager: container.secretManager,
        bindings: Object.values(container.config.executor.broker.bindings ?? {}),
        port: container.config.executor.broker.port,
        socketPath: container.config.executor.broker.socketPath ?? safePath(dataDir, "broker.sock"),
      })
    : undefined;

  // 6.5.9. Seed ALL bundled skills into the user data dir (version-aware, AUTO-SCANNED).
  // Generalized from the former single skill-creator IIFE — every
  // `bundled-skills/<name>/` (skill-creator, claude-code, codex, …) is seeded into
  // `<dataDir>/skills/<name>`, so shipping a bundled skill is ZERO engine code. Idempotent:
  // re-seeds only when missing or the bundled `version:` differs (see seed-bundled-skills.ts).
  {
    // Relative path resolves to packages/daemon/bundled-skills from this file in packages/daemon/src/.
    const bundledSkillsRoot = pathResolve(fileURLToPath(import.meta.url), "../../bundled-skills");
    seedBundledSkills(defaultSeedBundledSkillsDeps(bundledSkillsRoot, safePath(dataDir, "skills"), agentLogger));
  }

  // Mutate boot with all Group A foundation fields. The 2 forward-ref slots
  // (channelPluginsRef, bgNotifyRef) were eagerly initialized by
  // createEmptyBootContext(); here we wire the bgNotifyFn closure that reads
  // bgNotifyRef.ref at call time (populated later by bootChannels).
  boot.channelPluginsRef = channelPluginsRef;
  boot.bgNotifyRef = bgNotifyRef;
  Object.assign(boot, {
    container, dataDir, configPaths, envPath,
    clock, env, timers, activityBreaker, activityRendererFactoryOverride: activityRendererFactory,
    secretStore, mutableHandle, secretsCrypto, secretsDb, permissionCorrections, proxyBootPosture,
    mergedEnv,
    execGit, configGitManager,
    logger, logLevelManager, daemonLogger, gatewayLogger, channelsLogger, agentLogger,
    schedulerLogger, skillsLogger, memoryLogger, daemonVersion,
    tokenTracker, sharedCostTracker,
    diagnosticCollector, billingEstimator, channelActivityTracker, deliveryTracer,
    activityStream, disposeActivityStream, spendAccumulator, otelHandle, // spendAccumulator: Phase 177 kill-switch → bridge; otelHandle: Phase 178 OTLP/Prometheus exporter → setupShutdown.
    contextPipelineCollector,
    processMonitor,
    disposeEmbedding, cachedPort, memoryAdapter, db, sessionStore, memoryApi,
    embeddingQueue, backgroundIndexingPromise, embeddingCacheStats,
    embeddingCircuitBreakerState, summarizerSpendBreaker, rerankerPort, rerankerModelPresent, disposeReranker, entityStore, lcdStore, provenanceStore, contextBrowse, temporalStore, causalStore, tripleStore, embeddingStore, usefulnessStore, userRepresentationStore, relationshipStore, tunedAlphaStore, outcomeStore, learnedSkillStore, learnedSkillSurfaceRegistry, recordOutboundMessage, destroyReactionWiring, memoryLifecycleStore, consolidationStore, recallCounters, maintenanceTick,
    obsStore, obsPersistence,
    activeRunRegistry, sessionResolver, canaryFallbackSecret, injectionRateLimiter,
    deliveryMirror, startMirrorPrune, shutdownMirror,
    geminiCacheManager,
    backgroundTaskManager, bgNotifyFn,
    brokerHandle,
  });
  } catch (e: unknown) {
    // Boot failed — release the lock. Under normal boot, setupShutdown.onShutdown
    // owns the release; catch here handles bootstrap/selectSecretStore failures.
    releaseDataDirLock(dataDir);
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Stage 2: agents
// ---------------------------------------------------------------------------

/**
 * bootAgents — agent-runtime startup. Owns:
 *   - agents config map + default agent/workspace resolution
 *   - mcpClientManager (constructed BEFORE setupAgents per ordering constraint)
 *   - setupAgents (executors, costTrackers, skillRegistries, OAuth store, etc.)
 *   - subprocessEnv + execToolEnv (filtered envs for trusted/untrusted children)
 *   - systemEventQueue (cron-heartbeat routing) + setupSchedulers
 *   - sessionTrackerRegistry + Gemini-cache cleanup + MCP disconnect cleanup
 *   - auditAggregator + onSuspiciousContent
 *   - setupMedia + setupRpcBridge
 *   - approvalGate + restoreApprovalState
 *   - setupDeliveryQueue (+ channelAdaptersRef placeholder)
 *
 * Mutates `boot` with all Group B agent fields. Per-line-source order
 * preserved so daemon-lifecycle.test.ts log-sequence assertions remain green
 * ("Agent executor initialized", "Per-agent CronScheduler started").
 *
 * mcpClientManager construction order is a production-correctness
 * constraint: it must be constructed BEFORE setupAgents — do not invert.
 */
async function bootAgents(
  boot: BootContext,
  input: {
    overrides: DaemonOverrides;
  },
): Promise<void> {
  const { overrides } = input;
  // Alias `boot` as `foundation` for body-readability — Group A fields are
  // already populated by bootFoundation, destructuring from boot is equivalent.
  const foundation = boot;
  const {
    container, dataDir,
    clock, env, timers,
    daemonLogger, gatewayLogger, agentLogger, schedulerLogger, skillsLogger,
    memoryAdapter, db, sessionStore, cachedPort, embeddingQueue,
    rerankerPort, // built in setup-memory; threaded into setupAgents -> createPiExecutor
    rerankerModelPresent, // model-present probe result; threaded into setupAgents -> per-agent effective rerank precedence (same value as the build gate)
    entityStore, // threaded into setupAgents -> createPiExecutor (recall read path) + the cron review (write path)
    lcdStore, // Phase 128 LCD store; threaded into setupAgents -> createPiExecutor (contextStore) -> setupContextEngine -> the `dag` branch (context-engine.ts). Opt-in (version: "dag"); default pipeline. The agent receives the core ContextStorePort TYPE only (agent↛memory cut)
    provenanceStore, // Phase 173 DIST-03 read side; threaded into setupAgents -> createPiExecutor -> prompt-assembly -> createMemoryRecall's post-fusion provenance down-weighting pass (was BUILT but never injected in Phase 172). The agent receives the core LcdProvenanceReadStore TYPE only (agent↛memory cut)
    summarizerSpendBreaker, // R1 (132-05); daemon-owned per-tenant breaker; threaded into setupAgents -> createPiExecutor -> setupContextEngine so getSummarizerDeps gates the leaf seam per tenant (truncation-only degrade on open-breaker/over-cap)
    spendAccumulator, temporalStore, // spendAccumulator = Phase 177 dollars kill-switch (threaded setupAgents -> createPiExecutor -> bridge); temporalStore -> createMemoryRecall (recall temporal-spread read; dormant until rag.lanes.temporal.enabled)
    causalStore, // threaded into setupAgents -> createPiExecutor -> createMemoryRecall (the 5th causal read lane, dormant until rag.lanes.causal.enabled) AND the cron review -> runMemoryReview -> linkCausal (the write path) — one segregated port, both halves
    tripleStore, // threaded into setupAgents -> createPiExecutor -> createMemoryRecall (the 6th graph-spread read lane, dormant until rag.lanes.graphSpread.enabled); the agent receives the port TYPE only (the agent↛memory cut)
    embeddingStore, usefulnessStore, userRepresentationStore, relationshipStore, tunedAlphaStore, // the MMR re-rank's scoped embedding read + recall usefulness read + the LLM-free <user_profile> standing-block read + the LLM-free <channel_relationships> standing-block read (dormant until the offline builder writes rows + the social-modeling sign-off) + the buildScoringAlphas tuned-vector read (dormant until rag.onlineTuning.enabled + the bandit cron) -> setupAgents -> createPiExecutor -> prompt-assembly; the agent receives the port TYPEs only (the agent↛memory cut)
    activeRunRegistry, canaryFallbackSecret, injectionRateLimiter, learnedSkillStore, learnedSkillSurfaceRegistry, // learnedSkillStore (v2.26 SURFACE-01/03) -> setupAgents -> getPromptSkillsXml; learnedSkillSurfaceRegistry (WR-01) -> setupAgents register + the promote/demote re-refresh
    deliveryMirror, geminiCacheManager,
    channelPluginsRef, backgroundTaskManager,
    secretsCrypto, secretsDb, obsStore, // thread into setupAgents
    secretStore, // interactive-callback signing-secret resolution
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
  const defaultWorkspaceDir = resolveWorkspaceDir(defaultAgentConfig, defaultAgentId, container.config.dataDir || dataDir);

  // Boot-path skill-bundle re-merge MUST run BEFORE setupMcp (sequencing
  // gate). The orchestrator
  // re-runs the bundle resolver across every installed skill's mcpServers
  // block and persists the merged array via persistMcpServers — which
  // mutates container.config.integrations.mcp.servers via its in-memory
  // swap. setupMcp on the next line then connects from the POST-merge
  // state. Reversing the order leaves setupMcp connecting to the pre-merge
  // list (a new bundle entry persists on disk but stays disconnected).
  //
  // Pre-pass: build thin discovery-only skill registries inline (the real
  // per-agent registries with eligibility + watcher are built later inside
  // setupAgents). createSkillRegistry is idempotent so the two passes
  // don't race; the discovery-only registries are discarded after the
  // orchestrator returns.
  const skillRegistriesForBundles = buildSkillRegistriesForBundles(container, skillsLogger);
  await setupSkillBundles({
    container,
    skillRegistries: skillRegistriesForBundles,
    persistDeps: {
      container,
      configPaths: foundation.configPaths,
      defaultConfigPaths: DEFAULT_CONFIG_PATHS,
      configGitManager: foundation.configGitManager,
      logger: skillsLogger,
    },
    eventBus: container.eventBus,
    logger: skillsLogger,
  });

  // Construct the ONE mode-selected MCP OAuth token store at the composition
  // root. The SAME instance is threaded into BOTH consumers — setupMcp's manager
  // wiring (below) AND the login/handler path (buildRpcDispatchDeps reads it off
  // the boot context). This kills the encrypted-mode split-brain where the login
  // path wrote a plaintext disk store while the manager read the mode-selected
  // store. selectMcpTokenStore: encrypted → mcp_credentials (AES-256-GCM, no disk
  // files); file → chokidar mcp-tokens/ store; env → undefined (no MCP OAuth).
  const mcpTokenStore = selectMcpTokenStore({
    storage: container.config.security.storage,
    logger: skillsLogger,
    dataDir: container.config.dataDir && container.config.dataDir.length > 0
      ? container.config.dataDir
      : dataDir,
    secretsDb,
    secretsCrypto,
  });

  // Construct daemon-global MCP manager BEFORE setupAgents (ordering constraint
  // -- per-agent ToolCapabilityPort adapters close over mcpClientManager).
  // setupMcp consumes the injected mcpTokenStore; it no longer mode-selects.
  const { mcpClientManager } = await setupMcp({
    servers: container.config.integrations.mcp.servers,
    logger: skillsLogger,
    callToolTimeoutMs: container.config.integrations.mcp.callToolTimeoutMs,
    defaultCwd: defaultWorkspaceDir,
    eventBus: container.eventBus,
    stdioDefaultConcurrency: container.config.integrations.mcp.stdioDefaultConcurrency,
    httpDefaultConcurrency: container.config.integrations.mcp.httpDefaultConcurrency,
    // Forward the global reliability config so daemon-wide overrides
    // apply to startup-connected servers. keepaliveIntervalMs is the middle tier:
    // per-server server.keepaliveIntervalMs ?? globalKeepaliveIntervalMs ??
    // transport-aware default (resolveDefaultKeepaliveIntervalMs in ticker).
    globalKeepaliveIntervalMs: container.config.integrations.mcp.keepaliveIntervalMs,
    circuitBreakerThreshold: container.config.integrations.mcp.circuitBreakerThreshold,
    circuitBreakerCooldownMs: container.config.integrations.mcp.circuitBreakerCooldownMs,
    // The single mode-selected MCP OAuth token store (same instance threaded
    // into the login/handler path via the boot context). Undefined in env mode.
    mcpTokenStore,
  });

  // CWF-03: Ollama served-window probe — best-effort, fail-open.
  // Must run before setupAgents so the result can be threaded into each executor.
  // daemon.ts is the globals allowlist root; raw fetch is permitted here.
  const servedWindowByProvider = await probeAllOllamaProviders({
    providerEntries: container.config.providers?.entries ?? {},
    fetchFn: (url: string, init: RequestInit) => fetch(url, init),
    timeoutMs: 5_000,
    logger: agentLogger,
  }).catch((err: unknown) => {
    agentLogger.warn(
      {
        err,
        errorKind: "dependency" as const,
        hint: "probeAllOllamaProviders threw an unhandled exception; all executor servedContextWindow values will be undefined. Check @comis/agent version compatibility.",
      },
      "Ollama served-window probe threw unexpectedly — starting with empty map (fail-open)",
    );
    return new Map<string, number>();
  });

  // LAT-03: one-time redirect WARN for the config-echo-only providers.*.timeoutMs.
  try {
    warnOnProviderTimeoutRedirect({ providerEntries: container.config.providers?.entries ?? {}, logger: agentLogger });
  } catch { /* fail-open — a WARN helper must never block boot (I1) */ }

  // Daemon-owned boot-honesty collectors, populated
  // per-agent in setup-agents beside the registry; read by the bootChannels floor
  // loop + the bootShutdown posture count (ONE comparison feeds WARN + count).
  const servedWindowComparisons = new Map<string, ServedWindowComparison>();
  const agentBootWindowInfo = new Map<string, AgentBootWindowInfo>();

  const {
    sessionManager, executors, workspaceDirs, costTrackers, budgetGuards, stepCounters,
    getExecutor, piSessionAdapters,
    skillWatcherHandles, skillRegistries, lockCleanupTimer, singleAgentDeps, providerHealth,
    // Daemon-level OAuth credential store from setupAgents — same port instance
    // threaded into ApiDispatchDeps so agents.update can validate oauthProfiles
    // patches via has(). setupAgents constructs its own store internally via
    // selectOAuthCredentialStore. This is the OAuth *profile* store (provider
    // tokens), distinct from the MCP OAuth token store (`mcpTokenStore` above,
    // built via selectMcpTokenStore) — two separate credential families.
    oauthCredentialStore,
    // Per-agent live ToolCapabilityPort adapters; daemon.ts threads
    // getCapabilityPortForAgent into setupTools and mutates this map on
    // hot-add / hot-remove. trajectoryRegistry is drained by setupShutdown.
    toolCapabilityPorts, trajectoryRegistry,
    // per-agent shared ExecutionPlanHolder reference map.
    // Threaded through buildChannelManagerDeps so the chat plan-stream reads
    // from the SAME object SEP publishes into.
    executionPlanPorts, oauthManagers, // oauthManagers: DEFAULT agent's → buildImageGenBundle
  } = await setupAgents({
    container, memoryAdapter, sessionStore, agentLogger, rerankerPort, rerankerModelPresent, entityStore, lcdStore, provenanceStore, temporalStore, causalStore, tripleStore, embeddingStore, usefulnessStore, pinnedStore: memoryAdapter, userRepresentationStore, relationshipStore, tunedAlphaStore, learnedSkillStore, learnedSkillSurfaceRegistry, summarizerSpendBreaker, spendAccumulator, outboundMediaEnabled: true,
    autonomousMediaEnabled: !container.config.integrations.media.transcription.autoTranscribe
      || !container.config.integrations.media.vision.enabled
      || !container.config.integrations.media.documentExtraction.enabled,
    activeRunRegistry,  // steer+followup session tracking
    canaryFallbackSecret,  // Deterministic canary fallback
    injectionRateLimiter,  // Per-user injection rate limiting
    embeddingQueue,  // Conversation memory persistence in executor
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
    servedWindowByProvider,  // CWF-03: Ollama served context-window probe result
    servedWindowComparisons, agentBootWindowInfo,  // served-window + boot-window collectors
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

  // Deferred wake callback ref -- populated by bootChannels once
  // wakeCoalescer is constructed. Same shape as channelPluginsRef /
  // bgNotifyRef (cross-stage deferred-ref pattern).
  const cronWakeCallbackRef: { ref?: (reason: string) => void } = {};

  // 6.6.4.9. System event queue (created early for cron-heartbeat routing)
  const systemEventQueue = createSystemEventQueue({ logger: schedulerLogger });

  // 6.6.5. Schedulers — inline buildDeferredCronWakeCallback for the
  // onCronWake handler. Reads `cronWakeCallbackRef.ref` at INVOCATION time
  // (deferred), so the live wakeCoalescer wired up later in bootChannels is
  // what actually receives the wake. If a cron fires in the gap (typically
  // milliseconds, but a heavy startup may stretch it to seconds), surface
  // the drop with a debug log so the silent miss is visible.
  //
  // Observability-only: we intentionally do NOT buffer-then-drain (the
  // precedent set by channelPluginsRef / bgNotifyRef etc.). Cron wakes are
  // timer-driven; replaying a backlog could cause a wake storm if N timers
  // fired during a slow startup.
  const {
    cronSchedulers, executionTrackers, browserServices, resetSchedulers,
    getAgentCronScheduler, getAgentBrowserService,
  } = await setupSchedulers({
    container, workspaceDirs, sessionStore, sessionManager,
    schedulerLogger, agentLogger, skillsLogger,
    subprocessEnv,
    systemEventQueue,  // cron-heartbeat routing
    onCronWake: (reason: string) => {
      const callback = cronWakeCallbackRef.ref;
      if (callback) {
        callback(reason);
      } else {
        daemonLogger.debug(
          { reason, hint: "wakeCoalescer not yet constructed; cron wake dropped" },
          "Cron wake dropped during stage handoff",
        );
      }
    },
    clock, timers,
  });

  // Post-setupAgents cleanup wiring: session expiry, Gemini cache disposal,
  // orphan cleanup, MCP disconnect cleanup. Returns the sessionTrackerRegistry
  // bound to the session:expired listener.
  const sessionTrackerRegistry = wirePostAgentsCleanup({
    eventBus: container.eventBus,
    geminiCacheManager,
    daemonLogger,
  });

  // Audit aggregator for deduplicating security events. Inlined buildAuditBundle:
  // auditAggregator + onSuspiciousContent pair used by bootAgents and
  // threaded into setupMedia.
  const auditAggregator = createAuditAggregator(
    container.eventBus,
    { clock, timers },
    undefined,
    skillsLogger,
  );
  const onSuspiciousContent: WrapExternalContentOptions["onSuspiciousContent"] = (info) => {
    auditAggregator.record({ source: "external_content", patterns: info.patterns });
  };

  // 6.6.7. Media (moved up from 6.6.8 -- media infrastructure must be ready before channels)
  // Phase 193 keyless-first audio steering: setup-media gates STT/TTS construction
  // on this selector (resolveStt/resolveTts) BEFORE building any adapter — a
  // Codex/OAuth-only main never builds the empty-bearer OpenAI adapter (no 401).
  // Phase 194: buildAudioResolverDeps is async (runs the detectLocalSttEngine boot probe).
  const audioSelector = await buildAudioResolverDeps(container, defaultAgentId, skillsLogger);
  const {
    ttsAdapter, visionRegistry, visionRegistryHolder, linkRunner,
    mediaTempManager, mediaSemaphore, audioConverter,
    transcriber, ssrfFetcher, fileExtractor, voiceSelection,
  } = await _setupMedia({ container, skillsLogger, onSuspiciousContent, audioSelector });

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

  // 6.6.8.6.3. Interactive-callback wiring: resolve
  // the signing secret (store or in-memory fallback), bind the renderer signer,
  // construct the InteractiveCallbackRouter over the SAME gate + secret, and build
  // the Email single-use link minter + the gateway approval-token map/resolver.
  // Built here (gate + secretStore + clock all available) and consumed by both
  // bootChannels (signer + minter) and bootGateway (token map + resolveApproval).
  const interactiveCallbackWiring = createInteractiveCallbackWiring({
    secretStore,
    approvalGate,
    clock,
    config: container.config,
    logger: daemonLogger,
  });

  // 6.6.7.8. Delivery queue: create adapter BEFORE setupChannels.
  // channelAdapters map is passed by reference -- populated after setupChannels.
  // drainAndStart() is called AFTER setupChannels (two-phase lifecycle).
  const channelAdaptersRef = new Map<string, import("@comis/core").DeliveryAdapter>();
  const { deliveryQueue, drainAndStart: drainAndStartDeliveryPrune, shutdown: shutdownDeliveryQueue } = await setupDeliveryQueue({
    db, config: container.config, eventBus: container.eventBus, logger: daemonLogger, channelAdapters: channelAdaptersRef,
    // REACT-02 (Verified Learning, Phase 199): capture agent-authored outbound (messageId → trajectory).
    // `undefined` when learning-outcome is off for all agents (byte-identity: zero extra drain work).
    recordOutboundMessage: foundation.recordOutboundMessage,
  });

  Object.assign(boot, {
    defaultAgentId, defaultWorkspaceDir, agentsConfig,
    sessionManager, executors, workspaceDirs, costTrackers, budgetGuards, stepCounters,
    getExecutor, piSessionAdapters, skillWatcherHandles, skillRegistries, lockCleanupTimer,
    singleAgentDeps, providerHealth, oauthCredentialStore, toolCapabilityPorts, mcpClientManager,
    mcpTokenStore,
    continuationTracker, subprocessEnv, execToolEnv,
    systemEventQueue, cronSchedulers, executionTrackers, browserServices, resetSchedulers,
    getAgentCronScheduler, getAgentBrowserService,
    sessionTrackerRegistry, auditAggregator, onSuspiciousContent,
    ttsAdapter, visionRegistry, visionRegistryHolder, linkRunner, mediaTempManager, mediaSemaphore, audioConverter,
    transcriber, ssrfFetcher, fileExtractor, voiceSelection,
    rpcCall, wireDispatch, approvalGate, interactiveCallbackWiring,
    channelAdaptersRef, deliveryQueue, drainAndStartDeliveryPrune, shutdownDeliveryQueue,
    cronWakeCallbackRef, trajectoryRegistry, executionPlanPorts, oauthManagers, servedWindowComparisons, agentBootWindowInfo,
  });
}

// ---------------------------------------------------------------------------
// Stage 3: channels
// ---------------------------------------------------------------------------

/**
 * bootChannels — channel-runtime startup. Owns:
 *   - sandbox + image generation providers
 *   - per-agent ToolCapabilityPort resolver (inlined factory)
 *   - tools assembly + message preprocessing (setupTools HOISTED above
 *     setupChannels — eliminates the tool-assembler indirection)
 *   - channel adapters + composite media resolution + delivery service
 *   - inbound message id resolver (local-let; lambda reads at call time)
 *   - notification system + background completion runner
 *   - sessionTracker (local-let after notifications; lambda reads at call time)
 *   - channel health monitor
 *   - cross-session sender + sub-agent runner
 *   - node type registry + graph coordinator + named graph store
 *   - monitoring (heartbeat runner) + per-agent heartbeat + wake coalescer
 *   - cronWakeCallbackRef populated (cross-stage handoff)
 *   - agent management runtime state (suspended set, model catalog, channel cfg)
 *
 * setupTools is constructed BEFORE setupChannels (every setupTools input
 * was already foundation/agents-stage output or constructed inline before
 * setupChannels). sandbox/imageGen providers remain before setupChannels
 * (unchanged). This eliminates the tool-assembler indirection:
 * `assembleToolsForAgent` is now passed directly into
 * `buildChannelManagerDeps`. The remaining 2 eliminable refs
 * (sessionTracker / inboundMessageIdResolver) are local `let` slots
 * captured by accessor closures that read at message-arrival time.
 *
 * Mutates `boot` with all Group C channel fields. Per-line-source order
 * preserved so daemon-lifecycle.test.ts log-sequence assertions remain green.
 */
async function bootChannels(boot: BootContext): Promise<void> {
  // Alias `boot` as `handle` to preserve readability of the body destructure
  // pattern — bootChannels reads many fields populated by bootAgents +
  // bootFoundation. Both names refer to the same object; mutations to `handle`
  // are mutations to `boot`.
  const handle = boot as BootContext & Required<Pick<BootContext,
    | "defaultAgentId" | "defaultWorkspaceDir" | "agentsConfig"
    | "executors" | "workspaceDirs" | "sessionManager"
    | "activeRunRegistry" | "sessionResolver" | "approvalGate"
    | "getExecutor" | "piSessionAdapters" | "costTrackers"
    | "skillRegistries" | "skillWatcherHandles" | "toolCapabilityPorts"
    | "linkRunner" | "ssrfFetcher" | "transcriber" | "ttsAdapter"
    | "audioConverter" | "mediaTempManager" | "mediaSemaphore" | "fileExtractor"
    | "rpcCall" | "wireDispatch" | "continuationTracker" | "subprocessEnv" | "execToolEnv"
    | "systemEventQueue" | "cronSchedulers" | "executionTrackers" | "browserServices"
    | "sessionTrackerRegistry" | "auditAggregator" | "onSuspiciousContent"
    | "mcpClientManager" | "singleAgentDeps" | "providerHealth"
    | "channelAdaptersRef" | "deliveryQueue" | "drainAndStartDeliveryPrune"
    | "shutdownDeliveryQueue" | "cronWakeCallbackRef" | "trajectoryRegistry"
    | "executionPlanPorts" | "oauthManagers"
  >>;
  // Names consumed by bootChannels body itself; helper functions
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
    // Phase 131 (E1/E2): the concrete LCD ContextStorePort (createLcdStore),
    // populated on the BootContext by bootFoundation's setupMemory Object.assign.
    // Threaded into setupTools so assembleToolsForAgent wires the dag-mode ctx_*
    // in-session expansion tools. The agent sees only the core port TYPE (the cut).
    lcdStore,
  } = handle;

  // The 3 eliminable local-scope refs (session-tracker, tool-assembler,
  // inbound-message-id-resolver) are GONE.
  //   - assembleToolsForAgent is now a direct value (setupTools hoisted below).
  //   - sessionTracker / inboundMessageIdResolver use a `const {current?: T}`
  //     container pattern: the binding is `const` (satisfies prefer-const)
  //     and the `.current` field is mutated after setupChannels returns. The
  //     accessor closures passed into buildChannelManagerDeps read
  //     `container.current` at message-arrival time (lambdas captured by
  //     setupChannels are not invoked during setupChannels itself).
  const sessionTrackerSlot: { current?: import("./notification/session-tracker.js").SessionTracker } = {};
  const inboundMessageIdResolverSlot: { current?: InboundMessageIdResolver } = {};

  // 6.6.8.4.1. Sandbox + image generation providers (HOISTED before setupTools
  // because setupTools consumes both as direct inputs).
  const sandboxProvider = detectSandboxProvider(skillsLogger);
  if (sandboxProvider) skillsLogger.info({ provider: sandboxProvider.name }, "Exec sandbox provider detected");
  // Image-generation bundle (see buildImageGenBundle in wiring/main-helpers.ts). oauthManager threads the DEFAULT agent's OAuth manager for the Codex image path.
  const { imageGenConfig, imageGenProvider, imageGenRateLimiter, persistImage, imageGenCostLimiter } =
    await buildImageGenBundle({ container, defaultAgentId, skillsLogger, oauthManager: handle.oauthManagers.get(defaultAgentId), workspaceDirs, defaultWorkspaceDir });
  // Video-generation bundle (see buildVideoGenBundle in wiring/main-helpers.ts).
  // Pass the shared memory.db handle (the VideoJobStore binds it), the EARLY
  // channelAdaptersRef (the poller resolves a LIVE adapter from it after
  // wirePostChannelsLifecycle populates it), and the daemon TimerPort (the poller's
  // sweeper). oauthManager threads the DEFAULT agent's OAuth manager
  // for the Grok-video key-or-OAuth path (mirrors the image call above).
  // Destructure videoJobStore + videoPoller for the boot context + the handler deps.
  const { videoGenConfig, videoGenProvider, videoGenRateLimiter, persistVideo, videoGenCostLimiter, videoJobStore, videoPoller } =
    buildVideoGenBundle({ container, defaultAgentId, skillsLogger, oauthManager: handle.oauthManagers.get(defaultAgentId), workspaceDirs, defaultWorkspaceDir, db, channelAdaptersRef: handle.channelAdaptersRef, timers: handle.timers, trajectoryRegistry: handle.trajectoryRegistry, eventBus: container.eventBus });
  // The provider-following vision bundle — same construction site, reusing the DEFAULT agent's OAuth manager (codex bearer) + the boot clock (the bridge's per-message timestamp). See buildMediaVisionBundle in wiring/main-helpers.ts.
  const mediaVisionBundle = buildMediaVisionBundle({ container, defaultAgentId, skillsLogger, clock: handle.clock, oauthManager: handle.oauthManagers.get(defaultAgentId) });

  // 6.6.8.5. Tools + message preprocessing — HOISTED above setupChannels.
  // assembleToolsForAgent is now passed directly into
  // buildChannelManagerDeps; the tool-assembler indirection is GONE.
  // Inlined createCapabilityPortResolver — factory: resolve a
  // ToolCapabilityPort for an agentId; falls back to the default agent's
  // port. Throws if neither is registered.
  const getCapabilityPortForAgent: (agentId: string) => ToolCapabilityPort = (agentId) => {
    const port = toolCapabilityPorts.get(agentId) ?? toolCapabilityPorts.get(defaultAgentId);
    if (!port) {
      throw new Error(
        `No ToolCapabilityPort registered for agent '${agentId}' and no default agent ('${defaultAgentId}') fallback available -- the agent may have been removed or the daemon failed to initialize.`,
      );
    }
    return port;
  };
  // shutdownBackgroundProcesses returned from setupTools — the
  // previous eventBus.on("system:shutdown", ...) inline closure is now a
  // hoisted function threaded through ShutdownDeps.
  const { assembleToolsForAgent, preprocessMessageText, shutdownBackgroundProcesses, terminalRegistries, getTerminalAttentionConfig, terminalDurability } = setupTools({
    rpcCall, agents, defaultAgentId, workspaceDirs, defaultWorkspaceDir,
    // Resolve the per-provider operator capabilityClass override so
    // ctx_expand's walk depth honors a pinned tier (the same providers.entries source the
    // executor's live ModelProfile uses). Undefined ⇒ provider-family heuristic.
    getProviderCapabilityClass: (provider) =>
      container.config.providers?.entries?.[provider ?? ""]?.capabilities?.capabilityClass,
    dataDir: container.config.dataDir || ".",
    secretManager: container.secretManager, platformSecretNames: container.platformSecretNames,
    eventBus: container.eventBus, skillsLogger, linkRunner,
    approvalGate: container.config.approvals?.enabled ? approvalGate : undefined,
    subprocessEnv: handle.execToolEnv, onSuspiciousContent: handle.onSuspiciousContent,
    // 124-09 (WR-01 closure): the daemon TimerPort drives the terminal-driver reaper sweep.
    timers: handle.timers,
    // Phase 131 (E1/E2): the concrete LCD store, so assembleToolsForAgent can wire the
    // dag-mode ctx_* tools (gated on version === "dag" && a present store). The agent
    // receives only the core ContextStorePort TYPE (the agent-to-store cut holds).
    lcdStore,
    mcpClientManager,
    // Fresh accessor for per-server tool filtering — read live so
    // config:mutated server edits surface on the next tool assembly.
    getMcpServerEntries: () => container.config.integrations?.mcp?.servers ?? [],
    sandboxProvider, imageGenProvider, videoGenProvider, backgroundTaskManager,
    // JOB-04 (189): gate the video_status tool on the SAME condition video_generate
    // uses (the async store + poller are wired exactly when videoGenProvider exists).
    videoStatusEnabled: videoGenProvider,
    sessionTrackerRegistry: handle.sessionTrackerRegistry, getCapabilityPortForAgent,
    // broker activation seam. When executor.broker is configured,
    // thread the broker handle into setupTools so assembleToolsForAgent wires
    // the exec tool with broker-only network + proxy env + placeholder creds.
    // When absent (no executor.broker config), brokerContext is undefined and
    // the exec tool uses the default open-network path (no regression).
    brokerContext: handle.brokerHandle
      ? {
          tcpPort: handle.brokerHandle.tcpPort,
          socketPath: handle.brokerHandle.socketPath,
          caPath: handle.brokerHandle.caPath,
          sessionManager: handle.brokerHandle.sessionManager,
          placeholders: buildPlaceholdersFromBindings(
            container.config.executor?.broker?.bindings ?? {},
            daemonLogger,
          ),
        }
      : undefined,
  });

  // Boot-time viable-floor WARN per agent — WARN-only, awaited for determinism,
  // fail-open per agent (a throw never aborts boot).
  for (const [floorAgentId, bootInfo] of handle.agentBootWindowInfo ?? new Map<string, AgentBootWindowInfo>()) {
    try {
      evaluateViableFloorForAgent({ info: bootInfo, tools: await assembleToolsForAgent(floorAgentId), logger: daemonLogger });
    } catch (err) {
      daemonLogger.warn({ err, agentId: floorAgentId, errorKind: "internal" as const, hint: "viable-floor boot check failed — boot continues (fail-open); turn-time guards still apply (dag: CWF-02 preflight; pipeline: 85% compaction trigger + reactive classification)" }, "viable-floor boot evaluation threw — skipped for agent");
    }
  }

  // 6.6.8. Channels — pass assembleToolsForAgent DIRECTLY (no ref) and
  // pass accessor closures for sessionTracker / inboundMessageIdResolver
  // (const `{current?:T}` container pattern; populated after setupChannels
  // returns by mutating the .current field).
  const { adaptersByType, channelManager, resolveAttachment, lifecycleReactors, channelPlugins, commandQueue, deliveryService } = await setupChannels(
    buildChannelManagerDeps({
      agents: handle,
      assembleToolsForAgent,
      getInboundMessageIdResolver: () => inboundMessageIdResolverSlot.current,
      getSessionTracker: () => sessionTrackerSlot.current,
    }),
  );
  channelPluginsRef.ref = channelPlugins;
  inboundMessageIdResolverSlot.current = (() => {
    const metaKeyByChannel = new Map<string, string>();
    for (const [type, plugin] of channelPlugins) {
      const metaKey = plugin.capabilities.replyToMetaKey;
      if (metaKey) metaKeyByChannel.set(type, metaKey);
    }
    return createInboundMessageIdResolver({ metaKeyByChannel });
  })();
  // Local alias for the BootContext-bound publication below.
  const inboundMessageIdResolver = inboundMessageIdResolverSlot.current;
  // wirePostChannelsLifecycle now returns outputRetentionHandle so
  // the composition root can route .shutdown() through ShutdownDeps. The
  // eventBus.on("system:shutdown", ...) subscribers previously here are
  // deleted; shutdownDeliveryQueue + shutdownMirror remain reachable via
  // boot (they were always part of the agents/foundation groups).
  const { outputRetentionHandle } = await wirePostChannelsLifecycle({
    adaptersByType,
    channelAdaptersRef: handle.channelAdaptersRef,
    drainAndStartDeliveryPrune: handle.drainAndStartDeliveryPrune,
    shutdownDeliveryQueue: handle.shutdownDeliveryQueue,
    // JOB-03 (189): start + resume the background video poller after the channel
    // registry is populated (the local videoPoller from buildVideoGenBundle above;
    // undefined when video is disabled → the optional call no-ops).
    ...(videoPoller ? { startAndResumeVideoPoller: () => videoPoller.startAndResume() } : {}),
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
  sessionTrackerSlot.current = notificationContext.sessionTracker;
  bgNotifyRef.ref = notificationContext.notificationService;
  const bgConfigForRunner = BackgroundTasksConfigSchema.parse(agents[defaultAgentId]?.backgroundTasks ?? {});
  const bgCompletionRunnerContext = setupBackgroundCompletionRunner({
    eventBus: container.eventBus, getExecutor: handle.getExecutor, sessionStore,
    taskManager: backgroundTaskManager, fallbackNotifyFn: bgNotifyFn,
    maxBackgroundHops: bgConfigForRunner.maxBackgroundHops, logger: daemonLogger,
  });
  // eventBus.on("system:shutdown", () =>
  //   bgCompletionRunnerContext.runner.shutdown()) deleted — runner.shutdown
  // is threaded directly into setupShutdown via
  // ShutdownDeps.bgCompletionRunnerShutdown.
  // 6.6.8.0.2. Terminal-driver wake-FSM (v2.11 / 124-09 — THE KEYSTONE). One-per-daemon:
  // subscribes the re-published terminal:input_needed (the Task-1 fd3 hook) → dedupe/active-
  // check/hop-limit → wakes ONE turn that runs the safe-only auto-answer + loop-guard against
  // the SAME per-agent terminalRegistries the tools drive; escalations route via bgNotifyFn
  // (§4.7). Drained on shutdown via ShutdownDeps.terminalWakeShutdown.
  const terminalWakeContext = setupTerminalWake({
    eventBus: container.eventBus,
    registries: terminalRegistries,
    getTerminalAttentionConfig,
    notify: bgNotifyFn,
    dataDir: container.config.dataDir || ".",
    // 165-07 DUR-02 / LIVE-01 / ENDURE-01: the durable wake deps — the journal store
    // (persist-on-set + resume-on-re-attach), the liveness backstop (timers + heartbeatMs +
    // checkLiveness via the worker status round-trip, whose lastActivity stamp IS the I9 reaper
    // unify — LO-03), and the spend ceiling (maxCostUsd). timers = the reaper's TimerPort.
    ...terminalDurability,
    timers: handle.timers,
    logger: daemonLogger,
  });
  // 6.6.8.0.3. Recover background tasks NOW (after the runner is subscribed)
  backgroundTaskManager.recoverOnStartup();

  // Channel health monitor (start + stop produced by helper).
  const { monitor: channelHealthMonitor, stop: stopChannelHealthMonitor } = setupChannelHealthMonitor({ adaptersByType, daemonLogger, container });
  // eventBus.on("system:shutdown", () => stopChannelHealthMonitor?.())
  // deleted — stopChannelHealthMonitor is threaded directly into setupShutdown
  // via ShutdownDeps.stopChannelHealthMonitor.
  setupChannelHealthLogging({ eventBus: container.eventBus, logger: daemonLogger });

  // 6.6.9. Cross-session sender + sub-agent runner
  // proxyTypingCleanup returned from setupCrossSession — replaces
  // the eventBus.on("system:shutdown", ...) subscriber inside
  // registerProxyTypingListeners that silently no-op'd in production.
  const gatewaySendRef: { ref?: (channelId: string, text: string) => boolean } = {};
  const { crossSessionSender, subAgentRunner, sendToChannel, announceToParent, deadLetterQueue, announcementBatcher, proxyTypingCleanup } = setupCrossSession({
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
  // O2 (WR-02): seed the four canonical small-model DAG templates into the
  // named-graph store. Idempotent via INSERT-OR-IGNORE semantics inside the
  // seeder, so operator-customized templates are preserved across restarts and
  // re-running on every boot is safe.
  seedDefaultDagTemplates(namedGraphStore);

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
  // bootAgents) reads `.ref` at call time.
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

  Object.assign(boot, {
    adaptersByType, channelManager, resolveAttachment, lifecycleReactors, channelPlugins,
    commandQueue, deliveryService,
    inboundMessageIdResolver, channelHealthMonitor, stopChannelHealthMonitor,
    notificationContext, bgCompletionRunnerContext, terminalWakeContext,
    crossSessionSender, subAgentRunner, sendToChannel, announceToParent,
    deadLetterQueue, announcementBatcher, gatewaySendRef,
    sandboxProvider, imageGenProvider, imageGenRateLimiter, imageGenConfig, persistImage, imageGenCostLimiter, mediaVisionBundle,
    videoGenProvider, videoGenRateLimiter, videoGenConfig, persistVideo, videoGenCostLimiter, videoJobStore, videoPoller,
    assembleToolsForAgent, preprocessMessageText, getCapabilityPortForAgent,
    heartbeatRunner, duplicateDetector, perAgentRunner, wakeCoalescer,
    nodeTypeRegistry, graphCoordinator, namedGraphStore,
    suspendedAgents, modelCatalog, channelConfig, promptTimeoutTimestamps,
    // Teardown handles surfaced for ShutdownDeps wiring.
    shutdownBackgroundProcesses, proxyTypingCleanup,
    outputRetentionHandle,
  });
}

// ---------------------------------------------------------------------------
// Stage 4: gateway
// ---------------------------------------------------------------------------

/**
 * bootGateway -- gateway-runtime startup. Owns:
 *   token registry + session store bridge + shutdown ref + hot-add/hot-remove
 *   closures + RPC dispatch deps assembly + gateway server + deferred gateway
 *   attachment wiring + gatewaySendRef.ref population + restart continuation
 *   replay.
 *
 * Reads Group A/B/C fields populated by bootFoundation/bootAgents/bootChannels;
 * mutates `boot` with Group D gateway fields. Per-source-order:
 * "Gateway server started" emits inside setupGateway here in source order;
 * daemon-lifecycle.test.ts assertions remain unchanged.
 */
async function bootGateway(
  boot: BootContext,
  input: {
    overrides: DaemonOverrides;
    startupStartMs: number;
    instanceId: string;
  },
): Promise<void> {
  const { overrides, startupStartMs, instanceId } = input;
  // Alias `boot` as `channels` for body-readability — Group A/B/C fields are
  // already populated by bootFoundation/bootAgents/bootChannels.
  const channels = boot as PostChannelsBootContext & Required<Pick<BootContext,
    | "getExecutor" | "rpcCall" | "wireDispatch"
    | "assembleToolsForAgent" | "preprocessMessageText"
    | "gatewaySendRef"
  >>;
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
    interactiveCallbackWiring,
    obsStore, // 154-03: backs the obs_explain assembler closure (diagnostics rollup)
    dataDir: bootDataDir, // 154-03: absolute fallback data dir (always abs; ~/.comis or $COMIS_DATA_DIR)
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

  // Mutable shutdown ref for hot-add guard. Populated by bootShutdown --
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

  // 154-03: the trust-flag-FREE obs.explain assembler closure for the
  // operator-allowlisted obs_explain MCP tool. SECURITY — this closure runs the
  // SAME assembler the admin RPC handler delegates to, DIRECTLY under daemon
  // authority: it does NOT go through the admin-gated obs.explain RPC, does NOT
  // inject _trustLevel:"admin", and is NOT reached via daemonRpcForMcpClient.
  // Its only authorization boundary is the per-client mcpClient.allowlist (the
  // MCP dispatcher's registration filter + live re-check) plus the digest-only/
  // bounded report. `params` arrive already _trustLevel-stripped (the MCP
  // dispatcher strips for every tool); the contract request.parse validates the
  // {sessionKey?,traceId?,depth?} shape (its .refine rejects a neither-id call →
  // the dispatcher's try/catch turns the throw into a generic dispatch_error
  // sentinel, no raw leak) before the assembler reads any source.
  // Use the ABSOLUTE boot data dir as the fallback (NOT "."). makeRealReader
  // builds safePath(dataDir, "sessions"|"logs") eagerly, and safePath rejects a
  // relative base — a "." here crashes boot with PathTraversalError. bootDataDir
  // is always absolute (~/.comis or $COMIS_DATA_DIR). Mirrors daemon.ts:703.
  const obsExplainDataDir = container.config.dataDir || bootDataDir;
  const obsExplainReader = makeRealReader(obsExplainDataDir, obsStore);
  const obsExplainForMcpClient = (params: Record<string, unknown>): Promise<unknown> => {
    const parsed = ObsExplainContract.request.parse(params);
    return assembleIncidentReportFromSources(obsExplainReader, obsExplainDataDir, parsed);
  };

  // 161-02: the cross-session fleet sibling of obsExplainForMcpClient — same
  // never-inject-admin posture. boot.clock is the SAME ClockPort wired into the
  // RPC handler deps below (buildRpcDispatchDeps clock: c.clock); load-bearing (deps.clock!).
  const obsFleetHealthForMcpClient = (params: Record<string, unknown>): Promise<unknown> => {
    const parsed = ObsFleetHealthContract.request.parse(params);
    return assembleFleetHealthReport(
      { obsStore, dataDir: obsExplainDataDir, clock: boot.clock },
      parsed.sinceHours ?? 24,
    );
  };

  const { gatewayHandle, activeExecutions, getActiveConnectionCount, wsConnections } = await setupGateway({
    container, gwConfig, webhooksConfig: container.config.webhooks, agents, defaultAgentId,
    configPaths, defaultConfigPaths: DEFAULT_CONFIG_PATHS, gatewayLogger,
    embeddingQueue, memoryAdapter, memoryApi, cachedPort, sessionStore, getExecutor,
    assembleToolsForAgent, preprocessMessageText, rpcCall,
    costTrackers, workspaceDirs,
    _createGatewayServer, piSessionAdapters,
    // Complete three-layer forget for gateway slash /new + /reset (live 2026-06-11).
    destroyConversation: createConversationReset({ lcdStore: channels.lcdStore, sessionStore: sessionStoreBridge, piSessionAdapters, tenantId: container.config.tenantId, logger: gatewayLogger }).destroyConversationCompletely,
    resolvedTokens: resolvedGatewayTokens,
    daemonVersion: boot.daemonVersion,
    suspendedAgents,
    instanceId, startupStartMs,
    interactiveCallbackWiring,
    obsExplainForMcpClient,
    obsFleetHealthForMcpClient,
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

  Object.assign(boot, {
    tokenRegistry, runtimeTokens, removedTokenIds, resolvedGatewayTokens,
    sessionStoreBridge, shutdownRef, hotAdd, hotRemove, rpcDispatchDeps,
    gatewayHandle, activeExecutions, getActiveConnectionCount, wsConnections,
  });
}

// ---------------------------------------------------------------------------
// Stage 5: shutdown
// ---------------------------------------------------------------------------

/**
 * bootShutdown -- final stage. Constructs the shutdown handle, populates
 * gateway.shutdownRef.value (cross-stage deferred-ref pattern), wires the
 * health-metrics event-bus subscription, emits the startup banner, snapshots
 * last-known-good config, and returns the DaemonInstance to main()'s callers.
 *
 * Reads Group A-D fields populated by the prior 4 boot* helpers; returns
 * `DaemonInstance` (unlike the other boot* helpers which return void) so
 * main()'s contract is preserved.
 */
async function bootShutdown(
  boot: BootContext,
  input: {
    overrides: DaemonOverrides;
    startupStartMs: number;
    instanceId: string;
  },
): Promise<DaemonInstance> {
  const { overrides, startupStartMs, instanceId } = input;
  // Alias `boot` as `gateway` for body-readability — all 4 prior boot* helpers
  // have populated Group A-D fields.
  const gateway = boot as BootContext & Required<Pick<BootContext,
    | "defaultAgentId" | "defaultWorkspaceDir" | "agentsConfig"
    | "executors" | "workspaceDirs" | "costTrackers" | "budgetGuards" | "stepCounters"
    | "piSessionAdapters" | "skillWatcherHandles" | "skillRegistries" | "toolCapabilityPorts"
    | "singleAgentDeps" | "providerHealth" | "oauthCredentialStore"
    | "activeRunRegistry" | "mcpClientManager"
    | "subAgentRunner" | "crossSessionSender" | "channelManager" | "deliveryService"
    | "adaptersByType" | "channelPlugins" | "inboundMessageIdResolver"
    | "graphCoordinator" | "namedGraphStore" | "nodeTypeRegistry"
    | "channelHealthMonitor" | "notificationContext"
    | "modelCatalog" | "channelConfig" | "suspendedAgents"
    | "approvalGate" | "wakeCoalescer"
    | "cronSchedulers" | "resetSchedulers" | "executionTrackers" | "browserServices"
    | "getAgentCronScheduler" | "getAgentBrowserService"
    | "memoryApi" | "memoryAdapter" | "embeddingQueue" | "continuationTracker"
    | "ttsAdapter" | "visionRegistry" | "linkRunner" | "transcriber" | "fileExtractor"
    | "resolveAttachment" | "deliveryQueue" | "deadLetterQueue"
    | "imageGenProvider" | "imageGenRateLimiter" | "imageGenConfig" | "persistImage" | "imageGenCostLimiter"
    | "videoGenProvider" | "videoGenRateLimiter" | "videoGenConfig" | "persistVideo" | "videoGenCostLimiter"
    | "getExecutor" | "rpcCall" | "wireDispatch"
    | "assembleToolsForAgent" | "preprocessMessageText"
    | "gatewaySendRef" | "channelAdaptersRef" | "cronWakeCallbackRef"
    | "drainAndStartDeliveryPrune" | "shutdownDeliveryQueue"
    | "tokenRegistry" | "runtimeTokens" | "removedTokenIds" | "resolvedGatewayTokens"
    | "sessionStoreBridge" | "shutdownRef" | "hotAdd" | "hotRemove" | "rpcDispatchDeps"
    | "activeExecutions" | "getActiveConnectionCount" | "wsConnections"
    | "heartbeatRunner" | "duplicateDetector" | "perAgentRunner"
    | "stopChannelHealthMonitor" | "shutdownBackgroundProcesses" | "proxyTypingCleanup"
    | "outputRetentionHandle"
    | "bgCompletionRunnerContext" | "trajectoryRegistry"
    | "auditAggregator" | "onSuspiciousContent"
    | "sessionManager"
    | "subprocessEnv" | "execToolEnv" | "systemEventQueue"
    | "sessionTrackerRegistry" | "promptTimeoutTimestamps"
    | "lifecycleReactors" | "commandQueue"
    | "sandboxProvider" | "getCapabilityPortForAgent"
    | "audioConverter" | "mediaTempManager" | "mediaSemaphore" | "ssrfFetcher"
    | "lockCleanupTimer"
  >>;
  const {
    container, dataDir, configPaths,
    logger, logLevelManager, daemonLogger, daemonVersion,
    tokenTracker, processMonitor,
    diagnosticCollector, billingEstimator, channelActivityTracker, deliveryTracer,
    contextPipelineCollector, backgroundIndexingPromise, db,
    disposeEmbedding, disposeReranker, cachedPort, maintenanceTick, obsPersistence,
    disposeActivityStream, otelHandle,
    injectionRateLimiter, destroyReactionWiring, geminiCacheManager, backgroundTaskManager,
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
    // 9 new teardown handles surfaced through BootContext.
    shutdownBackgroundProcesses, proxyTypingCleanup,
    outputRetentionHandle, shutdownDeliveryQueue, shutdownMirror,
    bgCompletionRunnerContext, terminalWakeContext, stopChannelHealthMonitor, mcpClientManager,
    // Phase 189: the background video poller (undefined when video disabled) —
    // its shutdown is threaded into setupShutdown below.
    videoPoller,
  } = gateway;
  void _execs; void _suspended;
  // Override-derived locals -- only consumed by setupShutdown below.
  const exitFn = overrides.exit ?? ((code: number) => process.exit(code));

  // Declared here (before setupShutdown) so the thunk captures the ref;
  // assigned after emitStartupInvariants. Ref-object pattern mirrors
  // shutdownRef.value — setupShutdown reads .fn at teardown time.
  const _healthAggRef: { fn: (() => void) | undefined } = { fn: undefined };

  // 8. Graceful shutdown: signal-handler registration + teardown ordering
  //    both owned by setupShutdown; the previous
  //    `_registerGracefulShutdown` factory seam is gone.
  const { shutdownHandle } = setupShutdown({
    logger, daemonLogger, processMonitor, container, exitFn,
    tokenTracker, startupTimestamp: startupStartMs,
    activeExecutions, graphCoordinator, subAgentRunner, cronSchedulers, resetSchedulers,
    browserServices, channelManager, heartbeatRunner, perAgentRunner, wakeCoalescer, gatewayHandle,
    mediaTempManager, skillWatcherHandles,
    diagnosticCollector, channelActivityTracker, deliveryTracer, contextPipelineCollector,
    backgroundIndexingPromise, db,
    disposeEmbedding,  // coordinated L1 -> L2 -> provider dispose chain
    disposeReranker,  // release the reranker native context (ranking ctx -> model -> llama)
    approvalGate,
    secretStore,  // close secrets.db on shutdown
    auditAggregator,  // clear pending dedup timers
    injectionRateLimiter,  // clear rate limiter timers on shutdown
    destroyReactionWiring,  // WR-01: clear reaction/session map + reaction limiter timers on shutdown
    lockCleanupTimer,  // clear periodic lock cleanup timer
    dataDir: container.config.dataDir || dataDir,
    lockDataDir: dataDir,  // D14 lock release — must match acquireDataDirLock's boot path
    continuationTracker,
    lifecycleReactors,  // destroy lifecycle reactors on shutdown
    obsPersistence,  // drain write buffers before db.close
    disposeActivityStream, otelShutdown: otelHandle ? () => otelHandle.shutdown() : undefined, // drain ActivityStream; Phase 178 flush+close OTLP/Prometheus exporter (stops /metrics listener)
    geminiCacheManager,  // Dispose all Gemini caches on shutdown
    trajectoryRegistry,  // Drain session-scoped trajectory recorders
    // 9 new teardown fields (8 production subscribers + setup-tools
    // split into background-processes + mcp-client-manager).
    // Each was previously a silent no-op subscriber.
    shutdownBackgroundProcesses,
    mcpClientManagerDisconnectAll: () => mcpClientManager.disconnectAll(),
    bgCompletionRunnerShutdown: () => bgCompletionRunnerContext.runner.shutdown(),
    // 124-09: drain the terminal wake-FSM (unsubscribe + await in-flight woken turns).
    terminalWakeShutdown: terminalWakeContext ? () => terminalWakeContext.shutdown() : undefined,
    proxyTypingCleanup,
    shutdownDeliveryQueue,
    // Phase 189: SIGTERM clears the poller's sweeper interval + stops in-flight
    // per-job loops (no-op when video is disabled / poller undefined).
    ...(videoPoller ? { shutdownVideoPoller: () => videoPoller.shutdown() } : {}),
    shutdownDeliveryMirror: shutdownMirror,
    outputRetentionShutdown: outputRetentionHandle ? () => outputRetentionHandle.shutdown() : undefined,
    stopChannelHealthMonitor: stopChannelHealthMonitor ?? undefined,
    // Thunk reads _healthAggRef.fn at teardown time — populated by emitStartupInvariants.
    unsubscribeHealthAggregator: () => _healthAggRef.fn?.(),
    // Credential broker teardown (no-op when executor.broker is absent)
    brokerStop: boot.brokerHandle ? () => boot.brokerHandle!.stop() : undefined,
  });

  // Wire shutdown ref for hot-add guard. Cross-stage deferred-ref populate:
  // bootGateway declared the empty ref + captured it in hot-add closure;
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

  // 9.1. Boot invariant record + duplicate-wiring WARN.
  // Emitted AFTER the startup banner so the INFO record follows the human-readable
  // "Comis daemon started" line in log streams, and BEFORE saveLastKnownGood /
  // DaemonInstance return so WARNs fire before the daemon accepts traffic.
  // depSlotConsistency is passed explicitly — the daemon composition root is the
  // only site that knows which adapter slots were used (channelRegistry
  // only; adaptersList was removed from setup-channels-runtime.ts).
  // Derive logsDir from daemon.logging.filePath for the startup sweep.
  const _loggingFilePath = container.config.daemon?.logging?.filePath;
  const _logsDir = _loggingFilePath
    ? pathDirname(expandTilde(_loggingFilePath))
    : undefined;

  _healthAggRef.fn = emitStartupInvariants({
    logger: daemonLogger,
    adaptersByType,
    rawHandlerCounts: channelManager?.getRawHandlerCounts() ?? new Map(),
    channelPlugins: gateway.channelPlugins ?? new Map(),
    pluginRegistry: container.pluginRegistry ?? { count: () => 0 },
    mcpClientManager: mcpClientManager ?? { getTools: () => [] },
    agentsConfig: agents,
    depSlotConsistency: { adaptersList: false, channelRegistry: true },
    logRotationPolicy: container.config.observability?.logRotation,
    logsDir: _logsDir,
    alertBudgetPolicy: container.config.observability?.alertBudget,
    eventBus: container.eventBus,
  });
  const posture = checkStorageModeConsistency({ logger: daemonLogger, activeMode: boot.container.config.security.storage, dataDir: boot.dataDir, secretsDb: boot.secretsDb });

  // 9.2. I3 — config-posture SNAPSHOT (one-shot boot record, NOT an event).
  // See wiring/emit-config-posture.ts for the derivation + rationale.
  emitConfigPostureRecord(boot, posture.findings);

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
    container, logger, logLevelManager, tokenTracker,
    processMonitor, shutdownHandle, cronSchedulers, resetSchedulers,
    browserServices, heartbeatRunner, gatewayHandle, adapterRegistry: adaptersByType,
    // Expose the orchestrator ChannelManager so integration tests can drive a
    // real inbound turn through the daemon's REAL pipeline deps
    // (channelManager.injectMessage). Undefined when no channels are configured
    // at boot — see DaemonInstance.channelManager doc.
    channelManager,
    // Expose the delivery-queue-side adapter map and the queue port itself so
    // integration tests can register adapters that the recurring drainer sees
    // and assert on queue depth.
    deliveryAdapters: channelAdaptersRef,
    deliveryQueue,
    // Expose the background task manager so integration tests can promote
    // synthetic tasks and call complete()/fail() to drive the completion
    // runner pipeline without requiring a live LLM call.
    backgroundTaskManager,
    rpcCall, diagnosticCollector, billingEstimator,
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

  // The 4-handle chain collapsed into a single BootContext that the 5
  // boot* helpers populate in sequence. main() owns the single `boot`
  // variable; helpers mutate it via Object.assign.
  const boot: BootContext = createEmptyBootContext();

  // Stage 1: foundation. Owns data-dir + secrets + bootstrap + logging +
  // observability + memory + obs-persistence + context store + session
  // mirroring + Gemini cache + background tasks + deferred refs.
  await bootFoundation(boot, { overrides, startupStartMs, instanceId });

  // Stages 2-5: wrapped so a failure in any post-foundation stage releases the
  // singleton lock. Under normal boot, setupShutdown.onShutdown owns
  // the release; this catch handles partial-boot failures before that fires.
  try {
    // Stage 2: agents. Owns agent executors + mcpClientManager + schedulers +
    // media + RPC bridge + approval gate (with restore) + delivery queue.
    await bootAgents(boot, { overrides });
    // Stage 3: channels. Owns sandbox/image-gen + tools (HOISTED) + channel
    // adapters + notifications + bg completion runner + cross-session + graph
    // + monitoring + heartbeat + wake coalescer + agent runtime state.
    await bootChannels(boot);
    // Stage 4: gateway. Owns token registry + session store bridge + shutdown
    // ref slot + hot-add/hot-remove closures + RPC dispatch deps assembly +
    // gateway server + restart continuation replay.
    await bootGateway(boot, { overrides, startupStartMs, instanceId });
    // Stage 5: shutdown. Constructs shutdown handle, wires health logging,
    // emits the startup banner ("Comis daemon started"), returns DaemonInstance.
    return await bootShutdown(boot, { overrides, startupStartMs, instanceId });
  } catch (e: unknown) {
    releaseDataDirLock(boot.dataDir);
    throw e;
  }
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
