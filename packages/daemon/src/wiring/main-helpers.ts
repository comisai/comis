// SPDX-License-Identifier: Apache-2.0
/**
 * Bootstrap helpers extracted from `daemon.ts` to keep the composition root
 * under its architecture line cap. These run during `main()`/`bootAgents`;
 * see `daemon.ts` for the boot sequence that consumes them.
 *
 * @module
 */
import { existsSync, readFileSync, unlinkSync, chmodSync, statSync, mkdirSync } from "node:fs";
import {
  safePath,
  createApprovalGate,
  generateStrongToken,
  resolveMultilingual,
  EMBED_MULTILINGUAL,
  RERANK_MULTILINGUAL,
} from "@comis/core";
import type { ImageGenerationPort, OAuthTokenManager, ClockPort, VideoGenerationPort } from "@comis/core";
import { createChannelHealthMonitor } from "@comis/channels";
import { createImageGenRateLimiter } from "@comis/skills";
// Video generation (Phase 188 / Plan 04): the FAL queue factory + per-agent rate
// limiter, imported from the bare @comis/skills barrel exactly like the image
// route (the adapter + @fal-ai/client dep stay in @comis/skills — no daemon
// phantom dep).
import { createVideoGenProvider, createVideoGenRateLimiter } from "@comis/skills";
// JOB-01/JOB-02 (189): the durable async job store (shared memory.db) + the
// two-phase background poller. createVideoJobStore is from @comis/memory (the
// store lives beside the delivery queue); createVideoPoller is the sibling daemon
// wiring. Both are CONSTRUCTED here in buildVideoGenBundle (the construction site
// the wiring guard pins) so a future refactor cannot regress the path to unwired.
import { createVideoJobStore } from "@comis/memory";
import { createVideoPoller, type VideoPoller } from "./setup-video-poller.js";
import type { DeliveryAdapter, TimerPort, ChannelPort } from "@comis/core";
// DEL-01 (186): the per-agent media persistence getter mirrors the screenshot
// precedent (setup-tools.ts:69,305). Sibling-direct on the `@comis/skills/tools`
// subpath (the proven path), NOT the bare `@comis/skills` barrel.
import { createMediaPersistenceService, type MediaPersistenceService } from "@comis/skills/tools";
// SEC-02 (186): the per-agent/hour USD cost ceiling, a daemon-side accumulator
// (sibling api/ module) constructed beside the count rate limiter below.
import { createImageCostLimiter, type ImageCostLimiter } from "../api/image-cost-limiter.js";
// SEC-02 (188 / DIVERGENCE 3): the per-agent/hour video USD cost ceiling, gated
// PRE-submit against a worst-case estimate (sibling api/ module).
import { createVideoCostLimiter, type VideoCostLimiter } from "../api/video-cost-limiter.js";
import type { LoggingResult } from "./setup-logging.js";
import type { BootContext, PermissionCorrection } from "../daemon-types.js";
// Sibling-direct imports (not via the wiring barrel) to keep main-helpers free
// of a barrel import edge — these are the image-gen bundle's collaborators.
import { createImageGenGetter } from "./setup-media.js";
import { createImageProviderSelector } from "./setup-image-provider.js";
import { createVideoProviderSelector } from "./setup-video-provider.js";
import { resolveAgentModel } from "./setup-agents/setup-agents-tooling.js";
import { registerComisImageProviders } from "../api/pi-image-adapter.js";
// VIS-01 (187): the provider-following vision bridge (Plan 01) — the bundle
// builds its capability by closing over the cred resolvers + resolveAgentModel.
import { createMainProviderVision, type MainProviderVision } from "../api/main-provider-vision.js";

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
      await adapter.stop();
      await adapter.start();
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
 * EMB-01: resolve the two advisory multilingual booleans for the boot
 * `model_health` snapshot, PROVIDER-AWARE.
 *
 * The embedder id mirrors `setup-memory.ts:308,316` — OpenAI provider →
 * `embedding.openai.model`; local/auto → `embedding.local.modelUri`. It is NOT
 * the legacy `memory.embeddingModel` field (Pitfall 3 — that predates the
 * top-level embedding block and is not the running embedder). The reranker id is
 * `memory.rerankerModel` (default `bge-reranker-v2-m3`, which the core heuristic
 * classifies multilingual — Pitfall 2). Only the embedder has a config override
 * flag today, so the reranker passes `undefined` declared.
 *
 * Pure (config in → booleans out); no I/O. ADVISORY ONLY — nothing gates recall
 * on the result (I4; the FTS trigram floor carries recall regardless). Extracted
 * from `daemon.ts` to keep the composition root under its architecture line cap.
 */
export function resolveModelHealthMultilingual(
  config: BootContext["container"]["config"],
): { embeddingMultilingual: boolean | "unknown"; rerankerMultilingual: boolean | "unknown" } {
  const emb = config.embedding;
  const embedModelId = emb.provider === "openai" ? emb.openai.model : emb.local.modelUri;
  const rerankerModelId = config.memory.rerankerModel;
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
 * RES-02/CRED-01: the selector routes provider:"auto"/pi-ai-backed providers to
 * the Plan-03 pi-image-adapter (following the DEFAULT agent's resolved main
 * provider, key via SecretManager), keeps explicit fal/openai on the legacy
 * skills adapter (additive), and returns an honest-unavailable port (with the
 * knob hint) for an image-incapable main (RES-03) — never a misroute. The
 * getter reads the config + secretManager on use, but is invoked ONCE here at
 * boot and the handler holds that boot-built adapter instance — so key rotation
 * requires a daemon restart to take effect (NOT live per-request; IN-01
 * 183-REVIEW — parity with the pre-existing fal/openai one-shot probe).
 * Per-call per-agent re-selection (and live rotation) is a 186/multi-agent
 * refinement; Phase 183 resolves the common case (the default agent's main
 * provider) at boot.
 */
export function buildImageGenBundle(deps: {
  container: BootContext["container"];
  defaultAgentId: string;
  skillsLogger: BootContext["skillsLogger"];
  /**
   * The DEFAULT agent's OAuthTokenManager (184), surfaced from setupAgents
   * (AgentsResult.oauthManagers). Threaded into the selector so the Codex image
   * path resolves its OAuth bearer (CDX-01/CRED-01). Undefined when the default
   * agent has no OAuth config → codex is honest-unavailable (never a crash).
   */
  oauthManager?: OAuthTokenManager;
  /**
   * DEL-01 (186): the per-agent workspace dirs + default, threaded from
   * `c.workspaceDirs`/`c.defaultWorkspaceDir` at the call site. The per-agent
   * `persistImage` getter (below) resolves the agent's confined workspace from
   * these (mirrors the screenshot getter at setup-tools.ts:305-316).
   */
  workspaceDirs: Map<string, string>;
  defaultWorkspaceDir: string;
}): {
  imageGenConfig: BootContext["container"]["config"]["integrations"]["media"]["imageGeneration"];
  imageGenProvider: ImageGenerationPort | undefined;
  imageGenRateLimiter: ReturnType<typeof createImageGenRateLimiter> | undefined;
  /** DEL-01 (186): per-agent persist getter → MediaPersistenceService.persist. */
  persistImage: (
    agentId: string,
    buffer: Buffer,
    opts: { mediaKind: "image"; mimeType: string },
  ) => ReturnType<MediaPersistenceService["persist"]>;
  /** SEC-02 (186): per-agent/hour USD cost ceiling. Undefined when
   *  `maxCostPerHourUsd` is unset (ceiling skipped — count limit still applies). */
  imageGenCostLimiter: ImageCostLimiter | undefined;
} {
  const { container, defaultAgentId, skillsLogger, oauthManager, workspaceDirs, defaultWorkspaceDir } = deps;
  const imageGenConfig = container.config.integrations.media.imageGeneration;
  registerComisImageProviders(); // PI-02 — once at boot, before any generateImages().
  // defaultAgentId is tried FIRST; the literal "default" is only a redundant
  // secondary guard for the agents-omitted case (WR-01's fix aligns the HANDLER
  // accessor with this boot selector — defaultAgentId-first).
  const defaultAgentCfg =
    container.config.agents[defaultAgentId] ?? container.config.agents["default"];
  const defaultMain = defaultAgentCfg
    ? resolveAgentModel(defaultAgentCfg, container.config.models).provider
    : "default";
  const getImageGenProvider = createImageProviderSelector({
    imageGenConfig,
    secretManager: container.secretManager,
    mainProviderId: defaultMain,
    legacyGetter: createImageGenGetter(imageGenConfig, container.secretManager),
    logger: skillsLogger,
    // 184: the DEFAULT agent's OAuth manager + its per-agent oauthProfiles map.
    // The Codex image path resolves its bearer through this exact manager
    // (CDX-01/CRED-01). defaultAgentCfg is the same defaultAgentId-first lookup
    // used for defaultMain above (the agents-omitted "default" guard).
    oauthManager,
    oauthProfiles: defaultAgentCfg?.oauthProfiles,
  });
  const imageGenProvider = getImageGenProvider(); // boot-time probe for rate-limiter + logging
  const imageGenRateLimiter = imageGenProvider
    ? createImageGenRateLimiter({ maxPerHour: imageGenConfig.maxPerHour })
    : undefined;
  // SEC-02 (186): the USD cost ceiling is wired BESIDE the count rate limiter
  // (which is retained). Constructed ONLY when `maxCostPerHourUsd` is set AND a
  // provider exists — otherwise undefined, and the handler skips the ceiling
  // (count-only, no regression). Mirrors the createImageGenRateLimiter guard.
  const imageGenCostLimiter =
    imageGenProvider && imageGenConfig.maxCostPerHourUsd
      ? createImageCostLimiter({ maxCostPerHourUsd: imageGenConfig.maxCostPerHourUsd })
      : undefined;
  // DEL-01 (186): per-agent MediaPersistenceService getter — the EXACT shape of
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
 * WR-04 (186-REVIEW): extracted from `daemon.ts` (buildRpcDispatchDeps) to keep
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
    resolveAgentMainProvider, // RES-01
    workspaceDirs: c.workspaceDirs, // IN-01 (185): reference_image path
    defaultWorkspaceDir: c.defaultWorkspaceDir,
    persist: c.persistImage, // DEL-01 (186): persist getter
    trajectoryRegistry: c.trajectoryRegistry, // OBS-04 (186): trajectory direct-emit
    eventBus: c.container.eventBus, // OBS-03 (186): synthetic cost
    costLimiter: c.imageGenCostLimiter, // SEC-02 (186): USD cost ceiling
  };
}

/** Raised persistence cap for video (DEL-01) — clips are far larger than images,
 *  so override the 50 MB media-persistence default. 200 MB comfortably holds a
 *  multi-minute 1080p mp4 while still bounding a runaway download. */
const VIDEO_PERSIST_MAX_BYTES = 200 * 1024 * 1024;

/**
 * WR-06: narrow a live channel adapter to its attachment-send capability at
 * RUNTIME. `channelAdaptersRef` is typed `Map<string, DeliveryAdapter>` (the
 * delivery queue only needs `sendMessage`), but the runtime entries are the FULL
 * channel adapters — some of which expose `sendAttachment`, some of which (IRC)
 * do not. Rather than a blind `as unknown as Pick<ChannelPort,"sendAttachment">`
 * double-cast (which asserts a capability the static type can't see and silently
 * passes a non-attaching adapter to the poller), check `sendAttachment` is a
 * function and surface `undefined` otherwise. The poller's IRC-degrade branch
 * then triggers on a typed `undefined`, not just a defensive call-site guard.
 * The single `as` is the runtime-verified narrowing of the structural-superset
 * channel adapter; it is sound because the predicate proves the method exists.
 */
function resolveAttachmentAdapter(
  adapter: DeliveryAdapter | undefined,
): Pick<ChannelPort, "sendAttachment"> | undefined {
  if (
    adapter &&
    typeof (adapter as { sendAttachment?: unknown }).sendAttachment === "function"
  ) {
    return adapter as Pick<ChannelPort, "sendAttachment">;
  }
  return undefined;
}

/**
 * Build the video-generation bundle (lazy boot selector + boot probe + rate
 * limiter + cost limiter + per-agent persist getter + config). Mirrors
 * `buildImageGenBundle`. Extracted from `daemon.ts` to keep the composition root
 * under its 3000-line architecture cap — daemon.ts gains only the two call sites
 * (Plan 04 / Phase 188).
 *
 * RES-02/CRED-01: the selector routes explicit `fal` to the skills FAL adapter,
 * follows the DEFAULT agent's resolved main provider for `auto` (veo/grok
 * selection, live adapters land Phase 190 → honest-unavailable here), and returns
 * an honest-unavailable port (with the knob hint) for a video-incapable main
 * (RES-03) — never a misroute. The getter reads the config + secretManager on
 * use, but is invoked ONCE here at boot and the handler holds that boot-built
 * port — key rotation requires a daemon restart (parity with the image bundle).
 */
export function buildVideoGenBundle(deps: {
  container: BootContext["container"];
  defaultAgentId: string;
  skillsLogger: BootContext["skillsLogger"];
  /** DEL-01: per-agent workspace dirs + default, threaded from the call site;
   *  the per-agent `persistVideo` getter resolves the agent's confined workspace
   *  from these. */
  workspaceDirs: Map<string, string>;
  defaultWorkspaceDir: string;
  /** JOB-01 (189): the shared better-sqlite3 memory.db handle the VideoJobStore
   *  binds (the SAME handle setupDeliveryQueue takes — typed `unknown` to avoid a
   *  cross-package better-sqlite3 type dep, exactly like setupDeliveryQueue). */
  db: unknown;
  /** JOB-03 (189) — WARNING-1: the EARLY-created channel-adapter registry the
   *  delivery queue closes over. It is populated BY REFERENCE in
   *  wirePostChannelsLifecycle (after setupChannels), so the poller resolves a
   *  LIVE adapter at delivery time — NOT the late `adaptersByType` (which is not
   *  in scope at this call site). Mirrors `setupDeliveryQueue({ channelAdapters })`. */
  channelAdaptersRef: Map<string, DeliveryAdapter>;
  /** The daemon TimerPort drives the poller's outer sweeper (sanctioned, unref'd). */
  timers: TimerPort;
  /** DEFAULT agent's OAuthTokenManager — threaded to the selector for the Grok-video OAuth path (190 / CRED-01). @see buildImageGenBundle. */
  oauthManager?: OAuthTokenManager;
}): {
  videoGenConfig: BootContext["container"]["config"]["integrations"]["media"]["videoGeneration"];
  videoGenProvider: VideoGenerationPort | undefined;
  videoGenRateLimiter: ReturnType<typeof createVideoGenRateLimiter> | undefined;
  /** DEL-01: per-agent persist getter → MediaPersistenceService.persist (videos/). */
  persistVideo: (
    agentId: string,
    buffer: Buffer,
    opts: { mediaKind: "video"; mimeType: string },
  ) => ReturnType<MediaPersistenceService["persist"]>;
  /** SEC-02 (DIVERGENCE 3): per-agent/hour USD cost ceiling, gated PRE-submit.
   *  Undefined when `maxCostPerHourUsd` is unset (ceiling skipped, count-only). */
  videoGenCostLimiter: VideoCostLimiter | undefined;
  /** JOB-01 (189): the durable async job store (undefined when video disabled). */
  videoJobStore: ReturnType<typeof createVideoJobStore> | undefined;
  /** JOB-02 (189): the two-phase background poller (undefined when video disabled). */
  videoPoller: VideoPoller | undefined;
} {
  const { container, defaultAgentId, skillsLogger, workspaceDirs, defaultWorkspaceDir, db, channelAdaptersRef, timers, oauthManager } = deps;
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
    // 190 (CRED-01): the DEFAULT agent's OAuth manager + oauthProfiles for the
    // Grok-video key-or-OAuth path (mirrors buildImageGenBundle:331-332).
    oauthManager,
    oauthProfiles: defaultAgentCfg?.oauthProfiles,
  });
  const videoGenProvider = getVideoGenProvider(); // boot-time probe
  const videoGenRateLimiter = videoGenProvider
    ? createVideoGenRateLimiter({ maxPerHour: videoGenConfig.maxPerHour })
    : undefined;
  // SEC-02 (DIVERGENCE 3): the USD cost ceiling, constructed ONLY when
  // `maxCostPerHourUsd` is set AND a provider exists — otherwise undefined and
  // the handler skips the ceiling (count-only, no regression).
  const videoGenCostLimiter =
    videoGenProvider && videoGenConfig.maxCostPerHourUsd
      ? createVideoCostLimiter({ maxCostPerHourUsd: videoGenConfig.maxCostPerHourUsd })
      : undefined;
  // DEL-01: per-agent MediaPersistenceService getter (mirrors persistImage) with
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
  // JOB-01/JOB-02 (189): construct the durable store + background poller ONLY when
  // a provider exists (else they are undefined and the boot wiring + handler-deps
  // builder short-circuit on `!videoGenProvider`). The store binds the SHARED
  // memory.db handle (Q1/O3 LOCKED). The poller closes over `channelAdaptersRef`
  // (WARNING-1: the EARLY registry the delivery queue uses, populated by reference
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
      ...(videoGenCostLimiter ? { costLimiter: videoGenCostLimiter } : {}),
      // The poller resolves a LIVE adapter at delivery time from the early
      // channelAdaptersRef (populated by reference post-setupChannels) — the
      // delivery-queue mechanism, retyped for an attachment send. WR-06: the map
      // is typed `Map<string, DeliveryAdapter>` for the delivery queue (which only
      // needs sendMessage), but the runtime objects are the FULL channel adapters.
      // Narrow at RUNTIME (a `typeof sendAttachment === "function"` check) rather
      // than a blind `as unknown as` double-cast: a channel that cannot attach
      // (e.g. IRC) is reported as undefined, so the poller's IRC-degrade branch
      // is exercised by the type, not just defensively at the call site.
      getChannelAdapter: (channelType: string): Pick<ChannelPort, "sendAttachment"> | undefined =>
        resolveAttachmentAdapter(channelAdaptersRef.get(channelType)),
      config: videoGenConfig,
      logger: skillsLogger,
      timers,
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
type VideoHandlerBootSlice = Pick<BootContext, "videoGenProvider" | "videoGenRateLimiter" | "videoGenCostLimiter" | "videoJobStore" | "videoPoller" | "skillsLogger" | "container"> &
  Required<Pick<BootContext, "videoGenConfig" | "adaptersByType" | "workspaceDirs" | "defaultWorkspaceDir" | "persistVideo">>;

/**
 * Build the `videoHandlerDeps` slice of `ApiDispatchDeps` — `undefined` when
 * video generation is disabled (no provider or no rate limiter), else the dep
 * object the video.generate RPC handler consumes. Mirrors
 * `buildImageHandlerDeps`. OBSERVABILITY SCOPE (Phase 188 = logger-only): NO
 * trajectoryRegistry/eventBus is wired (OBS-04 / Phase 192 adds them).
 */
export function buildVideoHandlerDeps(
  c: VideoHandlerBootSlice,
  resolveAgentMainProvider: (agentId: string) => { providerId: string },
): import("../api/rpc-dispatch.js").ApiDispatchDeps["videoHandlerDeps"] {
  // 189: the async store + poller are REQUIRED for the submit path. They are
  // constructed in buildVideoGenBundle alongside the provider, so when the
  // provider exists they always do — but guard explicitly (no undefined slip).
  if (!c.videoGenProvider || !c.videoGenRateLimiter || !c.videoJobStore || !c.videoPoller) return undefined;
  return {
    provider: c.videoGenProvider,
    rateLimiter: c.videoGenRateLimiter,
    config: c.videoGenConfig,
    logger: c.skillsLogger,
    getChannelAdapter: (channelType: string) => c.adaptersByType.get(channelType),
    resolveAgentMainProvider, // RES-01 (obs/lockstep only)
    workspaceDirs: c.workspaceDirs, // SEC-03: image_url path confinement
    defaultWorkspaceDir: c.defaultWorkspaceDir,
    persist: c.persistVideo, // DEL-01: persist getter (videos/)
    costLimiter: c.videoGenCostLimiter, // SEC-02 (DIVERGENCE 3): pre-submit ceiling
    videoJobStore: c.videoJobStore, // JOB-01: handler inserts a pending row on submit
    videoPoller: c.videoPoller, // JOB-02: hand the job to the background poller
  };
}

/**
 * Build the `videoStatusHandlerDeps` slice of `ApiDispatchDeps` (Phase 189 /
 * Plan 03 — JOB-04). The READ side of the async lifecycle: `video.status` reads
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
    videoJobStore: c.videoJobStore, // JOB-04: agent-scoped get(job_id, agentId)
    logger: c.skillsLogger,
  };
}

/**
 * VIS-01 (187): resolve the VISION API key by PROVIDER. Mirrors
 * `resolveImageApiKey` (pi-image-adapter.ts:279) but keyed by PROVIDER, since
 * vision keys are the SAME completion-path keys (`OPENAI_API_KEY` /
 * `ANTHROPIC_API_KEY` / `GOOGLE_API_KEY`) — there is no separate vision key
 * (I7). Reads the SAME `SecretManager` the main provider uses, never the raw
 * environment. Returns undefined for `openai-codex` (its bearer comes from the
 * OAuth manager, the 184 path) and for any unknown / key-less provider, which
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
      // CRED-01 lockstep (185): GOOGLE_API_KEY — the SAME key the completion
      // path, the vision provider registry, and the env-vars docs use for google.
      return secretManager.get("GOOGLE_API_KEY");
    // "openai-codex" → oauthManager.getApiKey("openai-codex") via the bundle's
    // resolveCodexKey closure (184 precedent); image-incapable/unknown → honest-
    // unavailable inside the bridge.
    default:
      return undefined;
  }
}

/**
 * VIS-01 (187): build the provider-following VISION bridge capability the media
 * handler consumes via `MediaApiDeps.mainProviderVision`. Mirrors
 * `buildImageGenBundle`'s cred closure (:290-313) + `buildImageHandlerDeps`'s
 * literal assembly — it closes over `container.secretManager` + the default
 * agent's `oauthManager`/`oauthProfiles` + `resolveAgentModel` + the
 * agents/models config, and delegates to Plan 01's `createMainProviderVision`.
 *
 * The capability resolves the agent's main `{ provider, modelId }` via the
 * EXACT completion-path `resolveAgentModel` (the I4 lockstep — no second source
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
  /** The DEFAULT agent's OAuth manager (184), for the codex cred path. Undefined
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
  // The I4 lockstep — the SAME resolver the completion path uses. A
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
    // codex bearer via the DEFAULT agent's OAuth manager (184 precedent),
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
 * Scan ~/.comis/ and fix permissions on the data directory and known sensitive
 * files. Returns an array of corrections for deferred logging. Extracted from
 * `daemon.ts` to keep the composition root under its 3000-line architecture cap
 * (runs at startup; the result is logged after the logger is up). Self-contained
 * — a `dataDir` string in, a `PermissionCorrection[]` out, only node:fs sync I/O.
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
  const sensitiveFiles = ["config.yaml", "config.local.yaml", ".env", "secrets.db", "secrets.json"];
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
