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
} from "@comis/core";
import type { ImageGenerationPort, OAuthTokenManager } from "@comis/core";
import { createChannelHealthMonitor } from "@comis/channels";
import { createImageGenRateLimiter } from "@comis/skills";
// DEL-01 (186): the per-agent media persistence getter mirrors the screenshot
// precedent (setup-tools.ts:69,305). Sibling-direct on the `@comis/skills/tools`
// subpath (the proven path), NOT the bare `@comis/skills` barrel.
import { createMediaPersistenceService, type MediaPersistenceService } from "@comis/skills/tools";
// SEC-02 (186): the per-agent/hour USD cost ceiling, a daemon-side accumulator
// (sibling api/ module) constructed beside the count rate limiter below.
import { createImageCostLimiter, type ImageCostLimiter } from "../api/image-cost-limiter.js";
import type { LoggingResult } from "./setup-logging.js";
import type { BootContext } from "../daemon-types.js";
// Sibling-direct imports (not via the wiring barrel) to keep main-helpers free
// of a barrel import edge — these are the image-gen bundle's collaborators.
import { createImageGenGetter } from "./setup-media.js";
import { createImageProviderSelector } from "./setup-image-provider.js";
import { resolveAgentModel } from "./setup-agents/setup-agents-tooling.js";
import { registerComisImageProviders } from "../api/pi-image-adapter.js";

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
