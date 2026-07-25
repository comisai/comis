// SPDX-License-Identifier: Apache-2.0
/**
 * Bootstrap helpers extracted from `daemon.ts` to keep the composition root
 * under its architecture line cap. These run during `main()`/`bootAgents`;
 * see `daemon.ts` for the boot sequence that consumes them.
 *
 * @module
 */
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import {
  safePath,
  createApprovalGate,
  generateStrongToken,
  resolveMultilingual,
  EMBED_MULTILINGUAL,
  RERANK_MULTILINGUAL,
  BackgroundTasksConfigSchema,
  tryGetContext,
} from "@comis/core";
import type { ImageGenerationPort, OAuthTokenManager, ClockPort, VideoGenerationPort, RootRunIdResolver, ComisLogger, TypedEventBus } from "@comis/core";
import { createChannelHealthMonitor } from "@comis/channels";
import { createImageGenRateLimiter } from "@comis/skills";
import { createLeaseManager, type LeaseManager } from "@comis/infra";
import type { BoundedAutonomyBudgetHolder } from "@comis/agent";
import { createRootRunIdResolver } from "./setup-capability-endpoint-boot.js";
// Video generation: the FAL queue factory + per-agent rate
// limiter, imported from the bare @comis/skills barrel exactly like the image
// route (the adapter + @fal-ai/client dep stay in @comis/skills — no daemon
// phantom dep).
import { createVideoGenProvider, createVideoGenRateLimiter } from "@comis/skills";
// The durable async job store (shared memory.db) + the
// two-phase background poller. createVideoJobStore is from @comis/memory (the
// store lives beside the delivery queue); createVideoPoller is the sibling daemon
// wiring. Both are CONSTRUCTED here in buildVideoGenBundle (the construction site
// the wiring guard pins) so a future refactor cannot regress the path to unwired.
import { createVideoJobStore } from "@comis/memory";
import { createVideoPoller, type VideoPoller } from "./setup-video-poller.js";
import { resolveVideoSecretsForRedaction } from "./video-log-redaction.js";
import type { DeliveryAdapter, TimerPort, ChannelPort } from "@comis/core";
// The per-agent media persistence getter mirrors the screenshot
// precedent (setup-tools.ts:69,305). Sibling-direct on the `@comis/skills/tools`
// subpath (the proven path), NOT the bare `@comis/skills` barrel.
import { createMediaPersistenceService, type MediaPersistenceService } from "@comis/skills/tools";
// The per-agent/hour USD cost ceiling, a daemon-side accumulator
// (sibling api/ module) constructed beside the count rate limiter below.
import { createImageCostLimiter, type ImageCostLimiter } from "../api/image-cost-limiter.js";
// The per-agent/hour video USD cost ceiling, gated
// PRE-submit against a worst-case estimate (sibling api/ module).
import { createVideoCostLimiter, type VideoCostLimiter } from "../api/video-cost-limiter.js";
import type { LoggingResult } from "./setup-logging.js";
import type { BootContext } from "../daemon-types.js";
// Sibling-direct imports (not via the wiring barrel) to keep main-helpers free
// of a barrel import edge — these are the image-gen bundle's collaborators.
import { createImageGenGetter } from "./setup-media.js";
import { createImageProviderSelector } from "./setup-image-provider.js";
import { createVideoProviderSelector } from "./setup-video-provider.js";
import { resolveAgentModel } from "./setup-agents/setup-agents-tooling.js";
import { registerComisImageProviders } from "../api/pi-image-adapter.js";
// The provider-following vision bridge — the bundle
// builds its capability by closing over the cred resolvers + resolveAgentModel.
import { createMainProviderVision, type MainProviderVision } from "../api/main-provider-vision.js";
import { restartChannelAdapter } from "./channel-adapter-restart.js";
import type { SessionTracker } from "../notification/session-tracker.js";

/** The bounded-autonomy late-bind seam built in
 *  `bootAgents`: the per-root budget holder (populated by the cap layer in bootChannels) +
 *  the session→rootRunId index + resolver (synthetic root-session-* fallback) + the
 *  daemon-wide LeaseManager (shared by the cron-fire mint AND the cap layer). Built before
 *  setupAgents/setupSchedulers since the cap layer is LATER — reads at fire time. */
export interface BoundedAutonomyWiring {
  boundedAutonomyBudgetHolder: BoundedAutonomyBudgetHolder;
  rootRunIdIndex: Map<string, string>;
  resolveRootRunId: RootRunIdResolver;
  sharedLeaseManager: LeaseManager;
}

export function resolveAgentBackgroundTasksConfig(
  agents: BootContext["container"]["config"]["agents"],
  agentId: string,
) {
  // eslint-disable-next-line security/detect-object-injection -- agentId selects a key from the validated agent configuration map.
  return BackgroundTasksConfigSchema.parse(agents[agentId]?.backgroundTasks ?? {});
}

export function recordCurrentSessionEndpoint(
  getSessionTracker: () => SessionTracker | undefined,
): void {
  const requestContext = tryGetContext();
  const endpoint = requestContext?.turnScope?.endpoint;
  const agentId = requestContext?.agentId;
  if (endpoint !== undefined && agentId !== undefined) {
    getSessionTracker()?.recordActivity(agentId, endpoint);
  }
}

/** Build the {@link BoundedAutonomyWiring} late-bind seam (see the interface doc). */
export function createBoundedAutonomyWiring(deps: {
  clock: ClockPort;
  logger: ComisLogger;
  eventBus: TypedEventBus;
}): BoundedAutonomyWiring {
  const boundedAutonomyBudgetHolder: BoundedAutonomyBudgetHolder = {};
  const rootRunIdIndex = new Map<string, string>();
  const resolveRootRunId = createRootRunIdResolver({
    holder: boundedAutonomyBudgetHolder,
    index: rootRunIdIndex,
    onContextMismatch: (error, agentId) => {
      deps.logger.audit(
        { agentId, outcome: "denied", reason: error.code },
        "Trusted root context identity rejected",
      );
      deps.eventBus.emit("security:warn", {
        category: "root_context_mismatch",
        agentId,
        message: "Trusted root context identity rejected",
        timestamp: deps.clock.now(),
      });
    },
  });
  const sharedLeaseManager = createLeaseManager({ clock: deps.clock });
  return { boundedAutonomyBudgetHolder, rootRunIdIndex, resolveRootRunId, sharedLeaseManager };
}

/**
 * Restore approval pending requests and cache from disk at startup.
 *
 * Reads `<dataDir>/restart-approvals.json` and
 * `<dataDir>/restart-approval-cache.json` (written by graceful shutdown),
 * restores into the in-memory ApprovalGate, then deletes the files.
 * Best-effort on JSON parse failure: log warn + unlink.
 */
export function restoreApprovalState(deps: {
  approvalGate: ReturnType<typeof createApprovalGate>;
  dataDir: string;
  containerDataDir: string | undefined;
  daemonLogger: LoggingResult["daemonLogger"];
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
 * Set up the channel health monitor. Returns `{ monitor, stop }`; both let
 * slots disappear from bootChannels into this single helper return value.
 *
 * Extracted from `daemon.ts` to keep the composition root under its
 * architecture line cap (runs during `bootChannels`).
 */
export function setupChannelHealthMonitor(deps: {
  adaptersByType: NonNullable<BootContext["adaptersByType"]>;
  daemonLogger: LoggingResult["daemonLogger"];
  container: BootContext["container"];
}): { monitor: ReturnType<typeof createChannelHealthMonitor> | undefined; stop: (() => void) | undefined } {
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
      await restartChannelAdapter({ adapter, channelType, logger: daemonLogger });
    },
  });
  const stop = monitor.start(adaptersByType);
  return { monitor, stop };
}

/**
 * Per-token MCP-client config block. Surface to the gateway TokenStore via
 * `TokenEntry.mcpClient` so the verified TokenClient carries the allowlist +
 * sessionAllowlist + per-tool rate-limit overrides.
 */
export interface ResolvedGatewayToken {
  id: string;
  secret: string;
  scopes: string[];
  mcpClient?: {
    allowlist: string[];
    sessionAllowlist: string[];
    toolRateLimit: Record<string, number>;
  };
}

/**
 * Resolve gateway tokens from config (config -> env -> auto-generated).
 *
 * Extracted from `daemon.ts` to keep the composition root under its
 * architecture line cap (runs during `bootGateway`).
 */
export function resolveGatewayTokens(deps: {
  container: BootContext["container"];
  daemonLogger: BootContext["daemonLogger"];
}): Array<ResolvedGatewayToken> {
  const { container, daemonLogger } = deps;
  const resolved: Array<ResolvedGatewayToken> = [];
  for (const t of container.config.gateway?.tokens ?? []) {
    const tokenId = t.id ?? "unknown";
    const tokenScopes = [...(t.scopes ?? [])];
    // Preserve the per-MCP-client config block so the TokenStore can surface
    // it on verified TokenClient instances. Schema defaults guarantee the
    // fields are populated when the block is present.
    const mcpClient = t.mcpClient
      ? {
          allowlist: [...t.mcpClient.allowlist],
          sessionAllowlist: [...t.mcpClient.sessionAllowlist],
          toolRateLimit: { ...t.mcpClient.toolRateLimit },
        }
      : undefined;

    if (typeof t.secret === "string" && t.secret.length >= 32) {
      // Source: config (explicit secret present and valid)
      resolved.push({
        id: tokenId,
        secret: t.secret,
        scopes: tokenScopes,
        ...(mcpClient && { mcpClient }),
      });
    } else {
      const envKey = `GATEWAY_TOKEN_${tokenId.toUpperCase().replace(/-/g, "_")}`;
      const envSecret = container.secretManager.get(envKey);
      if (envSecret) {
        // Source: env / SecretManager
        resolved.push({
          id: tokenId,
          secret: envSecret,
          scopes: tokenScopes,
          ...(mcpClient && { mcpClient }),
        });
      } else {
        // Source: auto-generated (ephemeral)
        const generated = generateStrongToken();
        resolved.push({
          id: tokenId,
          secret: generated,
          scopes: tokenScopes,
          ...(mcpClient && { mcpClient }),
        });
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
 * Resolve the two advisory multilingual booleans for the boot
 * `model_health` snapshot, PROVIDER-AWARE.
 *
 * The embedder id mirrors `setup-memory.ts:308,316` — OpenAI provider →
 * `embedding.openai.model`; local/auto → `embedding.local.modelUri`. It is NOT
 * the legacy `memory.recall.embeddingModel` field (that predates the
 * top-level embedding block and is not the running embedder). The reranker id is
 * `memory.recall.rerankerModel` (default `bge-reranker-v2-m3`, which the core heuristic
 * classifies multilingual). Only the embedder has a config override
 * flag today, so the reranker passes `undefined` declared.
 *
 * Pure (config in → booleans out); no I/O. ADVISORY ONLY — nothing gates recall
 * on the result (the FTS trigram floor carries recall regardless). Extracted
 * from `daemon.ts` to keep the composition root under its architecture line cap.
 */
export function resolveModelHealthMultilingual(
  config: BootContext["container"]["config"],
): { embeddingMultilingual: boolean | "unknown"; rerankerMultilingual: boolean | "unknown" } {
  const emb = config.embedding;
  const embedModelId = emb.provider === "openai" ? emb.openai.model : emb.local.modelUri;
  const rerankerModelId = config.memory.recall.rerankerModel;
  return {
    embeddingMultilingual: resolveMultilingual(emb.multilingual, embedModelId, EMBED_MULTILINGUAL),
    rerankerMultilingual: resolveMultilingual(undefined, rerankerModelId, RERANK_MULTILINGUAL),
  };
}

/**
 * Build the image-generation bundle (lazy getter + boot probe + rate limiter +
 * config). Extracted from `daemon.ts` to keep the composition root under its
 * architecture line cap.
 *
 * The selector routes provider:"auto"/pi-ai-backed providers to
 * the pi-image-adapter (following the DEFAULT agent's resolved main
 * provider, key via SecretManager), keeps explicit fal/openai on the legacy
 * skills adapter (additive), and returns an honest-unavailable port (with the
 * knob hint) for an image-incapable main — never a misroute. The
 * getter reads the config + secretManager on use, but is invoked ONCE here at
 * boot and the handler holds that boot-built adapter instance — so key rotation
 * requires a daemon restart to take effect (NOT live per-request — parity with
 * the pre-existing fal/openai one-shot probe).
 * Per-call per-agent re-selection (and live rotation) is a multi-agent
 * refinement; boot resolves the common case (the default agent's main
 * provider).
 */
export async function buildImageGenBundle(deps: {
  container: BootContext["container"];
  defaultAgentId: string;
  skillsLogger: BootContext["skillsLogger"];
  /**
   * The DEFAULT agent's OAuthTokenManager, surfaced from setupAgents
   * (AgentsResult.oauthManagers). Threaded into the selector so the Codex image
   * path resolves its OAuth bearer. Undefined when the default
   * agent has no OAuth config → codex is honest-unavailable (never a crash).
   */
  oauthManager?: OAuthTokenManager;
  /**
   * The per-agent workspace dirs + default, threaded from
   * `c.workspaceDirs`/`c.defaultWorkspaceDir` at the call site. The per-agent
   * `persistImage` getter (below) resolves the agent's confined workspace from
   * these (mirrors the screenshot getter at setup-tools.ts:305-316).
   */
  workspaceDirs: Map<string, string>;
  defaultWorkspaceDir: string;
}): Promise<{
  imageGenConfig: BootContext["container"]["config"]["integrations"]["media"]["imageGeneration"];
  imageGenProvider: ImageGenerationPort | undefined;
  imageGenRateLimiter: ReturnType<typeof createImageGenRateLimiter> | undefined;
  /** Per-agent persist getter → MediaPersistenceService.persist. */
  persistImage: (
    agentId: string,
    buffer: Buffer,
    opts: { mediaKind: "image"; mimeType: string },
  ) => ReturnType<MediaPersistenceService["persist"]>;
  /** Per-agent/hour USD cost ceiling. Undefined when
   *  `maxCostPerHourUsd` is unset (ceiling skipped — count limit still applies). */
  imageGenCostLimiter: ImageCostLimiter | undefined;
}> {
  const { container, defaultAgentId, skillsLogger, oauthManager, workspaceDirs, defaultWorkspaceDir } = deps;
  const imageGenConfig = container.config.integrations.media.imageGeneration;
  registerComisImageProviders(); // Once at boot, before any generateImages().
  // defaultAgentId is tried FIRST; the literal "default" is only a redundant
  // secondary guard for the agents-omitted case (the HANDLER accessor aligns
  // with this boot selector — defaultAgentId-first).
  const defaultAgentCfg =
    container.config.agents[defaultAgentId] ?? container.config.agents["default"];
  // Resolve the default agent's provider AND chat model ONCE (the SAME
  // resolveAgentModel the completion path uses — lockstep). The chat model
  // (e.g. "gpt-5.5") is threaded to the codex image path: the Codex Responses
  // endpoint 400s on the image-API model id "gpt-image-1" and needs a CHAT model
  // with image_generation as a TOOL.
  const defaultResolved = defaultAgentCfg
    ? resolveAgentModel(defaultAgentCfg, container.config.models)
    : undefined;
  const defaultMain = defaultResolved?.provider ?? "default";
  // Store-aware: pre-resolve Codex availability from the PERSISTED
  // store (NOT the cold-at-boot in-memory cache) so a logged-in Codex profile
  // counts as available at boot — the fix for the follow-main regression where
  // a Codex agent's images froze unavailable for the daemon's life despite the
  // SAME OAuth credential answering its text completions. Resolved ONCE here
  // (async) and passed to the SYNC selector as a snapshot, keeping the selector
  // and the pure resolveImageProvider synchronous.
  const codexCredentialsAvailable = oauthManager
    ? await oauthManager.hasStoredCredentials("openai-codex")
    : false;
  const getImageGenProvider = createImageProviderSelector({
    imageGenConfig,
    secretManager: container.secretManager,
    mainProviderId: defaultMain,
    legacyGetter: createImageGenGetter(imageGenConfig, container.secretManager),
    logger: skillsLogger,
    // The DEFAULT agent's OAuth manager + its per-agent oauthProfiles map.
    // The Codex image path resolves its bearer through this exact manager.
    // defaultAgentCfg is the same defaultAgentId-first lookup
    // used for defaultMain above (the agents-omitted "default" guard).
    oauthManager,
    oauthProfiles: defaultAgentCfg?.oauthProfiles,
    codexCredentialsAvailable,
    codexChatModelId: defaultResolved?.model,
  });
  const imageGenProvider = getImageGenProvider(); // boot-time probe for rate-limiter + logging
  const imageGenRateLimiter = imageGenProvider
    ? createImageGenRateLimiter({ maxPerHour: imageGenConfig.maxPerHour })
    : undefined;
  // The USD cost ceiling is wired BESIDE the count rate limiter
  // (which is retained). Constructed ONLY when `maxCostPerHourUsd` is set AND a
  // provider exists — otherwise undefined, and the handler skips the ceiling
  // (count-only, no regression). Mirrors the createImageGenRateLimiter guard.
  const imageGenCostLimiter =
    imageGenProvider && imageGenConfig.maxCostPerHourUsd
      ? createImageCostLimiter({ maxCostPerHourUsd: imageGenConfig.maxCostPerHourUsd })
      : undefined;
  // Per-agent MediaPersistenceService getter — the EXACT shape of
  // the screenshot precedent (setup-tools.ts:305-316). Lazily built per agent,
  // keyed on agentId, writing to the agent's confined workspace
  // (`~/.comis/workspace/media/photos/` via KIND_TO_SUBDIR["image"]). Replaces
  // the handler's ephemeral tmpdir write+delete. `persist` never throws (returns
  // `err`), so the handler falls through to base64 on a persistence failure.
  const imagePersistenceServices = new Map<string, MediaPersistenceService>();
  const persistImage = (
    agentId: string,
    buffer: Buffer,
    opts: { mediaKind: "image"; mimeType: string },
  ): ReturnType<MediaPersistenceService["persist"]> => {
    let svc = imagePersistenceServices.get(agentId);
    if (!svc) {
      svc = createMediaPersistenceService({
        workspaceDir: workspaceDirs.get(agentId) ?? defaultWorkspaceDir,
        logger: skillsLogger,
      });
      imagePersistenceServices.set(agentId, svc);
    }
    return svc.persist(buffer, opts);
  };
  if (imageGenProvider) {
    skillsLogger.info(
      { provider: imageGenConfig.provider, mainProvider: defaultMain },
      "Image generation provider initialized",
    );
  } else {
    skillsLogger.debug("Image generation disabled: API key not configured or provider unknown");
  }
  return { imageGenConfig, imageGenProvider, imageGenRateLimiter, persistImage, imageGenCostLimiter };
}

/**
 * The post-channels boot-context fields `buildImageHandlerDeps` reads. The
 * image-gen bundle outputs (`buildImageGenBundle`) plus the channel/workspace
 * slots the boot sequence guarantees present by the time `buildRpcDispatchDeps`
 * runs (mirrors daemon.ts's local `PostChannelsBootContext` narrowing — typed
 * here off `BootContext` so the helper does not depend on the daemon-local alias).
 */
type ImageHandlerBootSlice = Pick<BootContext, "imageGenProvider" | "imageGenRateLimiter" | "trajectoryRegistry" | "imageGenCostLimiter" | "skillsLogger" | "container"> &
  Required<Pick<BootContext, "imageGenConfig" | "adaptersByType" | "workspaceDirs" | "defaultWorkspaceDir" | "persistImage">>;

/**
 * Build the `imageHandlerDeps` slice of `ApiDispatchDeps` — `undefined` when
 * image generation is disabled (no provider or no rate limiter), else the dep
 * object the image.generate RPC handler consumes.
 *
 * Extracted from `daemon.ts` (buildRpcDispatchDeps) to keep
 * the composition root under its 3000-line architecture cap. The original site
 * folded six concerns (workspaceDirs / defaultWorkspaceDir / persist /
 * trajectoryRegistry / eventBus / costLimiter) onto one >300-char line to stay
 * under the cap; this helper restores that headroom and gives each field its own
 * line. Behavior-neutral — a 1:1 move of the literal. Fields are read off the
 * post-channels boot context `c` (all guaranteed present by the boot sequence at
 * the call site); the image-gen pair is the disabled-image gate.
 */
export function buildImageHandlerDeps(
  c: ImageHandlerBootSlice,
  resolveAgentMainProvider: (agentId: string) => { providerId: string },
): import("../api/rpc-dispatch.js").ApiDispatchDeps["imageHandlerDeps"] {
  if (!c.imageGenProvider || !c.imageGenRateLimiter) return undefined;
  return {
    provider: c.imageGenProvider,
    rateLimiter: c.imageGenRateLimiter,
    config: c.imageGenConfig,
    logger: c.skillsLogger,
    getChannelAdapter: (channelType: string) => c.adaptersByType.get(channelType),
    resolveAgentMainProvider, // resolves the agent's main provider id
    workspaceDirs: c.workspaceDirs, // reference_image path resolution
    defaultWorkspaceDir: c.defaultWorkspaceDir,
    persist: c.persistImage, // per-agent persist getter
    trajectoryRegistry: c.trajectoryRegistry, // trajectory direct-emit
    eventBus: c.container.eventBus, // synthetic cost event
    costLimiter: c.imageGenCostLimiter, // USD cost ceiling
  };
}

/** Raised persistence cap for video: 200 MB (vs the 50 MB image
 *  default) holds a multi-minute 1080p mp4 while bounding a runaway download. */
const VIDEO_PERSIST_MAX_BYTES = 200 * 1024 * 1024;

/**
 * Narrow a live channel adapter to its capabilities at RUNTIME.
 * `channelAdaptersRef` is typed `Map<string, DeliveryAdapter>` (the delivery queue
 * needs only `sendMessage`), but the runtime entries are the FULL channel adapters
 * — some expose `sendAttachment`, some (IRC) do not. A `typeof sendAttachment ===
 * "function"` check (not a blind double-cast) returns `undefined` for a
 * non-attaching adapter, so the poller's IRC-degrade branch triggers on a typed
 * `undefined`. The return type also exposes `sendMessage` (a REQUIRED
 * ChannelPort + DeliveryAdapter method) for the oversized-degrade link/notice; the
 * cast stays sound — an adapter passing the typeof check is a full ChannelPort.
 */
function resolveAttachmentAdapter(
  adapter: DeliveryAdapter | undefined,
): Pick<ChannelPort, "sendAttachment" | "sendMessage"> | undefined {
  if (
    adapter &&
    typeof (adapter as { sendAttachment?: unknown }).sendAttachment === "function"
  ) {
    return adapter as unknown as Pick<ChannelPort, "sendAttachment" | "sendMessage">;
  }
  return undefined;
}

/**
 * Build the video-generation bundle (lazy boot selector + boot probe + rate
 * limiter + cost limiter + per-agent persist getter + config). Mirrors
 * `buildImageGenBundle`; extracted from `daemon.ts` to hold its 3000-line cap.
 *
 * The selector routes explicit `fal` to the skills FAL adapter,
 * follows the DEFAULT agent's resolved main provider for `auto` (veo/grok
 * selection → honest-unavailable here until those live adapters land), and returns
 * an honest-unavailable port (with the knob hint) for a video-incapable main
 * — never a misroute. The getter reads the config + secretManager on
 * use, but is invoked ONCE here at boot and the handler holds that boot-built
 * port — key rotation requires a daemon restart (parity with the image bundle).
 */
export function buildVideoGenBundle(deps: {
  container: BootContext["container"];
  defaultAgentId: string;
  skillsLogger: BootContext["skillsLogger"];
  /** Per-agent workspace dirs + default, threaded from the call site;
   *  the per-agent `persistVideo` getter resolves the agent's confined workspace
   *  from these. */
  workspaceDirs: Map<string, string>;
  defaultWorkspaceDir: string;
  /** The shared better-sqlite3 memory.db handle the VideoJobStore
   *  binds (the SAME handle setupDeliveryQueue takes — typed `unknown` to avoid a
   *  cross-package better-sqlite3 type dep, exactly like setupDeliveryQueue). */
  db: unknown;
  /** The EARLY-created channel-adapter registry the
   *  delivery queue closes over. It is populated BY REFERENCE in
   *  wirePostChannelsLifecycle (after setupChannels), so the poller resolves a
   *  LIVE adapter at delivery time — NOT the late `adaptersByType` (which is not
   *  in scope at this call site). Mirrors `setupDeliveryQueue({ channelAdapters })`. */
  channelAdaptersRef: Map<string, DeliveryAdapter>;
  /** The daemon TimerPort drives the poller's outer sweeper (sanctioned, unref'd). */
  timers: TimerPort;
  /** DEFAULT agent's OAuthTokenManager — threaded to the selector for the Grok-video OAuth path. @see buildImageGenBundle. */
  oauthManager?: OAuthTokenManager;
  /** Trajectory registry + event bus → createVideoPoller (off-turn video.* live emit by record.sessionKey + the cost route). Optional. */
  trajectoryRegistry?: import("@comis/observability").SessionTrajectoryHandleRegistry;
  eventBus?: BootContext["container"]["eventBus"];
}): {
  videoGenConfig: BootContext["container"]["config"]["integrations"]["media"]["videoGeneration"];
  videoGenProvider: VideoGenerationPort | undefined;
  videoGenRateLimiter: ReturnType<typeof createVideoGenRateLimiter> | undefined;
  /** Per-agent persist getter → MediaPersistenceService.persist (videos/). */
  persistVideo: (
    agentId: string,
    buffer: Buffer,
    opts: { mediaKind: "video"; mimeType: string },
  ) => ReturnType<MediaPersistenceService["persist"]>;
  /** Per-agent/hour USD cost ceiling, gated PRE-submit.
   *  Undefined when `maxCostPerHourUsd` is unset (ceiling skipped, count-only). */
  videoGenCostLimiter: VideoCostLimiter | undefined;
  /** The durable async job store (undefined when video disabled). */
  videoJobStore: ReturnType<typeof createVideoJobStore> | undefined;
  /** The two-phase background poller (undefined when video disabled). */
  videoPoller: VideoPoller | undefined;
} {
  const { container, defaultAgentId, skillsLogger, workspaceDirs, defaultWorkspaceDir, db, channelAdaptersRef, timers, oauthManager, trajectoryRegistry, eventBus } = deps;
  const videoGenConfig = container.config.integrations.media.videoGeneration;
  const defaultAgentCfg =
    container.config.agents[defaultAgentId] ?? container.config.agents["default"];
  const defaultMain = defaultAgentCfg
    ? resolveAgentModel(defaultAgentCfg, container.config.models).provider
    : "default";
  const getVideoGenProvider = createVideoProviderSelector({
    videoGenConfig,
    secretManager: container.secretManager,
    mainProviderId: defaultMain,
    // The skills FAL factory getter (explicit `provider:"fal"`). createVideoGenProvider
    // returns ok(undefined) when FAL_KEY is absent, else the adapter; unwrap to
    // the port|undefined the selector's legacyGetter expects.
    legacyGetter: () => {
      const r = createVideoGenProvider(videoGenConfig, container.secretManager);
      return r.ok ? r.value : undefined;
    },
    logger: skillsLogger,
    // The DEFAULT agent's OAuth manager + oauthProfiles for the
    // Grok-video key-or-OAuth path (mirrors buildImageGenBundle:331-332).
    oauthManager,
    oauthProfiles: defaultAgentCfg?.oauthProfiles,
  });
  const videoGenProvider = getVideoGenProvider(); // boot-time probe
  const videoGenRateLimiter = videoGenProvider
    ? createVideoGenRateLimiter({ maxPerHour: videoGenConfig.maxPerHour })
    : undefined;
  // The USD cost ceiling, constructed ONLY when
  // `maxCostPerHourUsd` is set AND a provider exists — otherwise undefined and
  // the handler skips the ceiling (count-only, no regression).
  const videoGenCostLimiter =
    videoGenProvider && videoGenConfig.maxCostPerHourUsd
      ? createVideoCostLimiter({ maxCostPerHourUsd: videoGenConfig.maxCostPerHourUsd })
      : undefined;
  // Per-agent MediaPersistenceService getter (mirrors persistImage) with
  // a RAISED maxBytes for video. Writes to `~/.comis/workspace/media/videos/`.
  const videoPersistenceServices = new Map<string, MediaPersistenceService>();
  const persistVideo = (
    agentId: string,
    buffer: Buffer,
    opts: { mediaKind: "video"; mimeType: string },
  ): ReturnType<MediaPersistenceService["persist"]> => {
    let svc = videoPersistenceServices.get(agentId);
    if (!svc) {
      svc = createMediaPersistenceService({
        workspaceDir: workspaceDirs.get(agentId) ?? defaultWorkspaceDir,
        logger: skillsLogger,
        maxBytes: VIDEO_PERSIST_MAX_BYTES,
      });
      videoPersistenceServices.set(agentId, svc);
    }
    return svc.persist(buffer, opts);
  };
  // Construct the durable store + background poller ONLY when
  // a provider exists (else they are undefined and the boot wiring + handler-deps
  // builder short-circuit on `!videoGenProvider`). The store binds the SHARED
  // memory.db handle. The poller closes over `channelAdaptersRef`
  // (the EARLY registry the delivery queue uses, populated by reference
  // after setupChannels) so announce-on-complete reaches a LIVE adapter outside a
  // turn — never the late `adaptersByType` (not in scope here).
  let videoJobStore: ReturnType<typeof createVideoJobStore> | undefined;
  let videoPoller: VideoPoller | undefined;
  if (videoGenProvider) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- db is better-sqlite3 Database; typed unknown to avoid a cross-package type dep (mirrors setupDeliveryQueue).
    videoJobStore = createVideoJobStore(db as any);
    videoPoller = createVideoPoller({
      store: videoJobStore,
      provider: videoGenProvider,
      persist: persistVideo,
      videoSecrets: resolveVideoSecretsForRedaction(container.secretManager), // exact-match log scrub
      ...(videoGenCostLimiter ? { costLimiter: videoGenCostLimiter } : {}),
      // The poller resolves a LIVE adapter at delivery time from the early
      // channelAdaptersRef (populated by reference post-setupChannels) — the
      // delivery-queue mechanism retyped for an attachment send. Runtime-narrowed
      // by resolveAttachmentAdapter (see its doc).
      getChannelAdapter: (
        channelType: string,
      ): Pick<ChannelPort, "sendAttachment" | "sendMessage"> | undefined =>
        resolveAttachmentAdapter(channelAdaptersRef.get(channelType)),
      config: videoGenConfig,
      logger: skillsLogger,
      timers,
      // Off-turn video.* live emit + the cost route (optional).
      ...(trajectoryRegistry ? { trajectoryRegistry } : {}),
      ...(eventBus ? { eventBus } : {}),
    });
    skillsLogger.info(
      { provider: videoGenConfig.provider, mainProvider: defaultMain },
      "Video generation provider initialized",
    );
  } else {
    skillsLogger.debug("Video generation disabled: API key not configured or provider unknown");
  }
  return { videoGenConfig, videoGenProvider, videoGenRateLimiter, persistVideo, videoGenCostLimiter, videoJobStore, videoPoller };
}

/**
 * The post-channels boot-context fields `buildVideoHandlerDeps` reads (mirrors
 * `ImageHandlerBootSlice`).
 */
type VideoHandlerBootSlice = Pick<BootContext, "videoGenProvider" | "videoGenRateLimiter" | "videoGenCostLimiter" | "videoJobStore" | "videoPoller" | "trajectoryRegistry" | "skillsLogger" | "container"> &
  Required<Pick<BootContext, "videoGenConfig" | "adaptersByType" | "workspaceDirs" | "defaultWorkspaceDir" | "persistVideo">>;

/**
 * Build the `videoHandlerDeps` slice of `ApiDispatchDeps` — `undefined` when
 * video disabled. Mirrors `buildImageHandlerDeps`. Threads
 * `trajectoryRegistry` (in-turn video.* direct-emit) + `eventBus` off `c`.
 */
export function buildVideoHandlerDeps(
  c: VideoHandlerBootSlice,
  resolveAgentMainProvider: (agentId: string) => { providerId: string },
): import("../api/rpc-dispatch.js").ApiDispatchDeps["videoHandlerDeps"] {
  // The async store + poller are REQUIRED for the submit path. They are
  // constructed in buildVideoGenBundle alongside the provider, so when the
  // provider exists they always do — but guard explicitly (no undefined slip).
  if (!c.videoGenProvider || !c.videoGenRateLimiter || !c.videoJobStore || !c.videoPoller) return undefined;
  return {
    provider: c.videoGenProvider,
    rateLimiter: c.videoGenRateLimiter,
    config: c.videoGenConfig,
    logger: c.skillsLogger,
    getChannelAdapter: (channelType: string) => c.adaptersByType.get(channelType),
    resolveAgentMainProvider, // obs/lockstep only
    workspaceDirs: c.workspaceDirs, // image_url path confinement
    defaultWorkspaceDir: c.defaultWorkspaceDir,
    persist: c.persistVideo, // persist getter (videos/)
    costLimiter: c.videoGenCostLimiter, // pre-submit ceiling
    videoJobStore: c.videoJobStore, // handler inserts a pending row on submit
    videoPoller: c.videoPoller, // hand the job to the background poller
    trajectoryRegistry: c.trajectoryRegistry, // in-turn video.* direct-emit
    eventBus: c.container.eventBus, // parity (off-turn cost route = poller)
  };
}

/**
 * Build the `videoStatusHandlerDeps` slice of `ApiDispatchDeps`.
 * The READ side of the async lifecycle: `video.status` reads
 * the SAME agent-scoped `videoJobStore` the poller writes (single source — no
 * second instance). `undefined` when video generation is disabled (no store),
 * which also leaves the `video_status` tool ungated (see `videoStatusEnabled`).
 * Far narrower than `buildVideoHandlerDeps` — the read handler needs only the
 * store + logger.
 */
export function buildVideoStatusHandlerDeps(
  c: VideoHandlerBootSlice,
): import("../api/rpc-dispatch.js").ApiDispatchDeps["videoStatusHandlerDeps"] {
  if (!c.videoJobStore) return undefined;
  return {
    videoJobStore: c.videoJobStore, // agent-scoped get(job_id, agentId)
    logger: c.skillsLogger,
  };
}

/**
 * Resolve the VISION API key by PROVIDER. Mirrors
 * `resolveImageApiKey` (pi-image-adapter.ts:279) but keyed by PROVIDER, since
 * vision keys are the SAME completion-path keys (`OPENAI_API_KEY` /
 * `ANTHROPIC_API_KEY` / `GOOGLE_API_KEY`) — there is no separate vision
 * key. Reads the SAME `SecretManager` the main provider uses, never the raw
 * environment. Returns undefined for `openai-codex` (its bearer comes from the
 * OAuth manager) and for any unknown / key-less provider, which
 * surfaces as honest-unavailable inside the bridge.
 */
export function resolveVisionApiKey(
  provider: string,
  secretManager: { get(key: string): string | undefined },
): string | undefined {
  switch (provider) {
    case "openai":
      return secretManager.get("OPENAI_API_KEY");
    case "anthropic":
      return secretManager.get("ANTHROPIC_API_KEY");
    case "google":
    case "google-vertex":
      // Lockstep: GOOGLE_API_KEY — the SAME key the completion
      // path, the vision provider registry, and the env-vars docs use for google.
      return secretManager.get("GOOGLE_API_KEY");
    // "openai-codex" → oauthManager.getApiKey("openai-codex") via the bundle's
    // resolveCodexKey closure; image-incapable/unknown → honest-
    // unavailable inside the bridge.
    default:
      return undefined;
  }
}

/**
 * Build the provider-following VISION bridge capability the media
 * handler consumes via `MediaApiDeps.mainProviderVision`. Mirrors
 * `buildImageGenBundle`'s cred closure (:290-313) + `buildImageHandlerDeps`'s
 * literal assembly — it closes over `container.secretManager` + the default
 * agent's `oauthManager`/`oauthProfiles` + `resolveAgentModel` + the
 * agents/models config, and delegates to `createMainProviderVision`.
 *
 * The capability resolves the agent's main `{ provider, modelId }` via the
 * EXACT completion-path `resolveAgentModel` (the lockstep — no second source
 * of truth), then the key by-provider (`resolveVisionApiKey`) with the codex
 * bearer fallback (the DEFAULT agent's OAuth manager). Also returns
 * `resolveMainModelId` — the SAME resolver, surfaced so the handler-side vision
 * gate (`isVisionCapable(getModel(provider, modelId))`) reads the model id from
 * one place (threaded onto `MediaApiDeps.mainModelIdFor`).
 */
export function buildMediaVisionBundle(deps: {
  container: BootContext["container"];
  defaultAgentId: string;
  skillsLogger: BootContext["skillsLogger"];
  /** The boot ClockPort (the bridge needs a non-Date.now() per-message timestamp). */
  clock: ClockPort;
  /** The DEFAULT agent's OAuth manager, for the codex cred path. Undefined
   *  → codex resolves no bearer → honest-unavailable (never a crash). */
  oauthManager?: OAuthTokenManager;
}): {
  capability: MainProviderVision;
  /** The single-source-of-truth main model-id resolver (→ MediaApiDeps.mainModelIdFor). */
  resolveMainModelId: (agentId: string) => string | undefined;
} {
  const { container, defaultAgentId, skillsLogger, clock, oauthManager } = deps;
  const cfgFor = (agentId: string): { model: string; provider: string } | undefined =>
    container.config.agents[agentId] ??
    container.config.agents[defaultAgentId] ??
    container.config.agents["default"];
  const oauthProfiles = (container.config.agents[defaultAgentId] ?? container.config.agents["default"])?.oauthProfiles;
  // The lockstep — the SAME resolver the completion path uses. A
  // missing/misconfigured agent resolves to a sentinel that the bridge maps to
  // honest-unavailable (getModel("unknown", "") fails the model guard).
  const resolveMain = (agentId: string): { provider: string; modelId: string } => {
    const cfg = cfgFor(agentId);
    if (!cfg) return { provider: "unknown", modelId: "" };
    const { provider, model } = resolveAgentModel(cfg, container.config.models);
    return { provider, modelId: model };
  };
  const capability = createMainProviderVision({
    resolveModel: resolveMain,
    // cred-by-PROVIDER (vision keys: OPENAI/ANTHROPIC/GOOGLE_API_KEY) via the
    // SAME SecretManager the completion path reads.
    resolveApiKey: (provider: string) => resolveVisionApiKey(provider, container.secretManager),
    // codex bearer via the DEFAULT agent's OAuth manager,
    // unwrapped to string | undefined so the bridge stays OAuthError-decoupled.
    resolveCodexKey: oauthManager
      ? async (provider: string) => {
          const r = await oauthManager.getApiKey(provider, { oauthProfiles });
          return r.ok ? r.value : undefined;
        }
      : undefined,
    clock,
    logger: skillsLogger,
  });
  return { capability, resolveMainModelId: (agentId: string) => resolveMain(agentId).modelId || undefined };
}

/**
 * Background-task notifier bound to a late-populated notification-service ref
 * (the service is constructed by bootChannels after this closure is wired).
 * Internal boundary: mints the delivery authority + destination endpoint the
 * notifyUser guard requires — there is no originating turn context here. A
 * missing service or a no-channel resolution is non-fatal: the background
 * notification is simply dropped.
 */
export function createBgNotifyFn(
  bgNotifyRef: { ref?: import("../notification/notification-service.js").NotificationService },
): (opts: { agentId: string; message: string; priority: "normal"; origin: "background_task" }) => Promise<void> {
  return async (opts) => {
    const service = bgNotifyRef.ref;
    if (!service) return;
    const destination = service.resolveDestination({ agentId: opts.agentId });
    if (!destination.ok) return;
    await service.notifyUser({
      agentId: opts.agentId,
      message: opts.message,
      priority: opts.priority,
      origin: opts.origin,
      authority: destination.value.authority,
      destinationEndpoint: destination.value.destinationEndpoint,
    });
  };
}
