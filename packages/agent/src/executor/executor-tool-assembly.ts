// SPDX-License-Identifier: Apache-2.0
/**
 * Tool assembly pipeline for PiExecutor.
 *
 * Extracted from pi-executor.ts execute() to isolate tool merging,
 * SettingsManager creation, settings overrides, prompt assembly,
 * resource loader configuration, tool deferral, lifecycle management,
 * JIT guide wrapping, schema pruning, schema snapshot, provider
 * normalization, and mutation serializer into a focused module.
 *
 * Consumers:
 * - pi-executor.ts: calls assembleTools() during execute()
 *
 * @module
 */

import {
  SettingsManager,
  DefaultResourceLoader,
} from "@mariozechner/pi-coding-agent";
import type {
  ToolDefinition,
} from "@mariozechner/pi-coding-agent";

/** Partial<Settings> extracted from SettingsManager.applyOverrides() parameter type.
 *  Settings is not re-exported from the SDK's index -- extract from the class method. */
type SettingsOverrides = Parameters<SettingsManager['applyOverrides']>[0];
import type { AgentTool } from "@mariozechner/pi-agent-core";
import {
  formatSessionKey,
  type SessionKey,
  type NormalizedMessage,
  type PerAgentConfig,
  type TypedEventBus,
  type MemoryPort,
  type HookRunner,
  type SecretManager,
  type EnvelopeConfig,
  type SenderTrustDisplayConfig,
} from "@comis/core";
import type { ComisLogger, ErrorKind } from "@comis/infra";
import { applyToolDeferral, buildDeferredToolsContext, extractRecentlyUsedToolNames, resolveModelTier, CORE_TOOLS } from "./tool-deferral.js";
import type { DeferralContext, ExcludeDeferralResult } from "./tool-deferral.js";
import { getOrCreateDiscoveryTracker } from "./discovery-tracker.js";
import type { DiscoveryTracker } from "./discovery-tracker.js";
import { getOrCreateTracker, DEFAULT_LIFECYCLE_CONFIG } from "./tool-lifecycle.js";
import { isAnthropicFamily, isGoogleFamily } from "../provider/capabilities.js";
import type { ToolLifecycleConfig } from "./tool-lifecycle.js";
import { createJitGuideWrapper } from "./jit-guide-injector.js";
import {
  applySchemasPruning,
  applySchemaSnapshot,
  applyProviderNormalization,
  applyMutationSerializer,
} from "./executor-tool-pipeline.js";
import { assembleExecutionPrompt } from "./prompt-assembly.js";
import type { ExecutionPromptResult } from "./prompt-assembly.js";
import { CHARS_PER_TOKEN_RATIO } from "../context-engine/constants.js";
import type { ExecutionOverrides } from "./types.js";
import type { EmbeddingPort } from "@comis/core";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Subset of PiExecutorDeps used by the tool assembly pipeline. */
export interface ToolAssemblyDeps {
  customTools: ToolDefinition[];
  convertTools?: (tools: AgentTool[]) => ToolDefinition[];
  workspaceDir: string;
  agentDir: string;
  logger: ComisLogger;
  eventBus: TypedEventBus;
  memoryPort?: MemoryPort;
  hookRunner?: HookRunner;
  secretManager?: SecretManager;
  envelopeConfig?: EnvelopeConfig;
  outboundMediaEnabled?: boolean;
  mediaPersistenceEnabled?: boolean;
  autonomousMediaEnabled?: boolean;
  getPromptSkillsXml?: () => string;
  subAgentToolNames?: string[];
  mcpToolsInherited?: boolean;
  senderTrustDisplayConfig?: SenderTrustDisplayConfig;
  documentationConfig?: import("@comis/core").DocumentationConfig;
  deliveryMirror?: import("@comis/core").DeliveryMirrorPort;
  deliveryMirrorConfig?: { maxEntriesPerInjection: number; maxCharsPerInjection: number };
  embeddingPort?: EmbeddingPort;
  skillRegistry?: {
    getEligibleSkillNames(): Set<string>;
    initFromSdkSkills(sdkSkills: Array<{ name: string; description: string; filePath: string; baseDir: string; source: string; disableModelInvocation: boolean }>): void;
  };
  /** Resolve platform message character limit for a channel type. */
  getChannelMaxChars?: (channelType: string) => number | undefined;
}

/** Result of the tool assembly pipeline. */
export interface ToolAssemblyResult {
  /** Final processed tools ready for session creation. */
  mergedCustomTools: ToolDefinition[];
  /** Tool deferral result with active, deferred, and discover tool. */
  deferralResult: ExcludeDeferralResult;
  /** Formatted deferred tools context for dynamic preamble injection. */
  deferredContext: string;
  /** Session-scoped guide delivery tracking set. */
  deliveredGuides: Set<string>;
  /** Model tier derived from context window: "small" | "medium" | "large". */
  modelTier: "small" | "medium" | "large";
  /** Discovery tracker for deferred tool discovery state. */
  discoveryTracker: DiscoveryTracker;
  /** Mutable ref for compaction deps to serialize discovered tools. */
  currentDiscoveryTracker: DiscoveryTracker;
  /** Tool names demoted by lifecycle management (optional). */
  lifecycleDemotedNames?: Set<string>;
  /** SDK SettingsManager (file-based or in-memory). */
  settingsManager: ReturnType<typeof SettingsManager.create>;
  /** Whether SettingsManager uses persistent file storage. */
  persistentSettings: boolean;
  /** Resource loader options for DefaultResourceLoader construction. */
  resourceLoaderOptions: ConstructorParameters<typeof DefaultResourceLoader>[0];
  /** Assembled execution prompt (system prompt, dynamic preamble, inline memory). */
  promptResult: ExecutionPromptResult;
  /** Estimated system token count (system prompt + tool definition overhead). */
  cachedSystemTokensEstimate: number;
}

/** Parameters for the assembleTools function. */
export interface ToolAssemblyParams {
  config: PerAgentConfig;
  deps: ToolAssemblyDeps;
  sessionKey: SessionKey;
  msg: NormalizedMessage;
  tools?: AgentTool[];
  executionOverrides?: ExecutionOverrides;
  isFirstMessageInSession: boolean;
  /** Session manager instance for session context and messages. */
  sm: {
    buildSessionContext(): { messages: unknown[] };
    getSessionDir(): string;
  };
  formattedKeyForGuides: string;
  deliveredGuides: Set<string>;
  resolvedModel?: { id: string; provider: string; contextWindow?: number; reasoning?: boolean };
  modelCompat?: { supportsTools?: boolean; toolSchemaProfile?: "default" | "xai"; toolCallArgumentsEncoding?: "json" | "html-entities"; nativeWebSearchTool?: boolean };
  agentId?: string;
  safetyReinforcement?: string;
  _directives?: { thinkingLevel?: string; compact?: unknown };
}

// ---------------------------------------------------------------------------
// Assembly function
// ---------------------------------------------------------------------------

/**
 * Execute the full tool assembly pipeline: merge per-request tools, create
 * SettingsManager, apply settings overrides, assemble prompt, configure
 * resource loader, run tool deferral with lifecycle management, apply JIT
 * guide wrapping, schema pruning, schema snapshots, provider normalization,
 * and mutation serializer.
 *
 * Pure function with params object ( extraction pattern). All mutable
 * refs and closure state remain in pi-executor.ts orchestrator scope.
 *
 * @param params - Tool assembly parameters
 * @returns Tool assembly result with all outputs needed by the orchestrator
 */
export async function assembleTools(params: ToolAssemblyParams): Promise<ToolAssemblyResult> {
  const {
    config, deps, sessionKey, msg, tools, executionOverrides,
    isFirstMessageInSession, sm, deliveredGuides,
    resolvedModel, modelCompat, agentId, safetyReinforcement, _directives,
  } = params;

  // -------------------------------------------------------------------
  // 1. Merge per-request tools (AgentTool[]) with deps.customTools
  // -------------------------------------------------------------------
  let mergedCustomTools = deps.customTools;
  if (tools && tools.length > 0 && deps.convertTools) {
    const converted = deps.convertTools(tools);
    const existingNames = new Set(deps.customTools.map(t => t.name));
    const uniqueConverted = converted.filter(t => !existingNames.has(t.name));
    mergedCustomTools = [...deps.customTools, ...uniqueConverted];
  }

  // -------------------------------------------------------------------
  // 2. Create SettingsManager -- prefer file-based for persistent SDK settings
  // -------------------------------------------------------------------
  let settingsManager: ReturnType<typeof SettingsManager.create>;
  let persistentSettings = true;
  try {
    settingsManager = SettingsManager.create(deps.workspaceDir, deps.agentDir);
  } catch (createError) {
    deps.logger.warn(
      {
        err: createError,
        hint: "SettingsManager.create() failed, falling back to in-memory settings",
        errorKind: "config" as ErrorKind,
      },
      "Settings file load failed",
    );
    settingsManager = SettingsManager.inMemory();
    persistentSettings = false;
  }

  // -------------------------------------------------------------------
  // 3. Apply Comis config overrides on top of SDK file-based settings
  // -------------------------------------------------------------------
  const compactionConfig = config.session?.compaction;
  const reserveTokens = compactionConfig?.reserveTokens ?? 16384;
  const keepRecentTokens = compactionConfig?.keepRecentTokens ?? 32768;

  if (compactionConfig?.reserveTokens !== undefined && (typeof compactionConfig.reserveTokens !== "number" || compactionConfig.reserveTokens <= 0)) {
    deps.logger.warn(
      { field: "session.compaction.reserveTokens", hint: "reserveTokens must be a positive number; using default 16384", errorKind: "config" as ErrorKind },
      "Invalid settings override skipped",
    );
  }
  if (compactionConfig?.keepRecentTokens !== undefined && (typeof compactionConfig.keepRecentTokens !== "number" || compactionConfig.keepRecentTokens <= 0)) {
    deps.logger.warn(
      { field: "session.compaction.keepRecentTokens", hint: "keepRecentTokens must be a positive number; using default 32768", errorKind: "config" as ErrorKind },
      "Invalid settings override skipped",
    );
  }

  // Disable SDK auto-compaction when Comis context engine handles compaction.
  const comisContextEngineActive = config.contextEngine?.enabled !== false;

  const overrides: SettingsOverrides = {
    compaction: {
      enabled: !comisContextEngineActive,
      reserveTokens,
      keepRecentTokens,
    },
    hideThinkingBlock: true,
    retry: {
      enabled: config.sdkRetry?.enabled ?? true,
      maxRetries: config.sdkRetry?.maxRetries ?? 5,
      baseDelayMs: config.sdkRetry?.baseDelayMs ?? 4000,
      maxDelayMs: config.sdkRetry?.maxDelayMs ?? 60000,
    },
  };

  // Selective override: directive takes precedence over config
  const effectiveThinkingLevel = _directives?.thinkingLevel ?? config.thinkingLevel;
  const validThinkingLevels = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
  if (effectiveThinkingLevel !== undefined) {
    if ((validThinkingLevels as readonly string[]).includes(effectiveThinkingLevel)) {
      overrides.defaultThinkingLevel = effectiveThinkingLevel as typeof validThinkingLevels[number];
    } else {
      deps.logger.warn(
        { field: "thinkingLevel", hint: `Invalid thinkingLevel '${effectiveThinkingLevel}'; must be one of: ${validThinkingLevels.join(", ")}`, errorKind: "config" as ErrorKind },
        "Invalid settings override skipped",
      );
    }
  }

  settingsManager.applyOverrides(overrides);

  deps.logger.debug(
    {
      persistent: persistentSettings,
      reserveTokens: compactionConfig?.reserveTokens ?? 16384,
      keepRecentTokens: compactionConfig?.keepRecentTokens ?? 32768,
      ...(effectiveThinkingLevel !== undefined && { thinkingLevel: effectiveThinkingLevel }),
      ...(_directives?.thinkingLevel !== undefined && { directiveOverride: true }),
      sdkRetry: {
        enabled: config.sdkRetry?.enabled ?? true,
        maxRetries: config.sdkRetry?.maxRetries ?? 5,
        baseDelayMs: config.sdkRetry?.baseDelayMs ?? 4000,
        maxDelayMs: config.sdkRetry?.maxDelayMs ?? 60000,
      },
    },
    "SettingsManager overrides applied",
  );

  // Validate thinking level against model capability
  if (effectiveThinkingLevel !== undefined && effectiveThinkingLevel !== "off" && resolvedModel && !resolvedModel.reasoning) {
    deps.logger.warn(
      {
        thinkingLevel: effectiveThinkingLevel,
        model: resolvedModel.id,
        provider: resolvedModel.provider,
        hint: `Model '${resolvedModel.id}' does not support reasoning; thinkingLevel '${effectiveThinkingLevel}' may be ignored by the SDK`,
        errorKind: "config" as ErrorKind,
      },
      "Thinking level exceeds model capability",
    );
  }

  deps.logger.info(
    { persistent: persistentSettings },
    "Settings manager initialized",
  );

  // -------------------------------------------------------------------
  // 4. Prompt assembly (extracted to prompt-assembly.ts)
  // -------------------------------------------------------------------
  const promptResult = await assembleExecutionPrompt({
    config,
    deps: {
      workspaceDir: deps.workspaceDir,
      memoryPort: deps.memoryPort,
      hookRunner: deps.hookRunner,
      secretManager: deps.secretManager,
      envelopeConfig: deps.envelopeConfig,
      outboundMediaEnabled: deps.outboundMediaEnabled,
      mediaPersistenceEnabled: deps.mediaPersistenceEnabled,
      autonomousMediaEnabled: deps.autonomousMediaEnabled,
      getPromptSkillsXml: deps.getPromptSkillsXml,
      subAgentToolNames: deps.subAgentToolNames,
      mcpToolsInherited: deps.mcpToolsInherited,
      isFirstMessageInSession,
      senderTrustDisplayConfig: deps.senderTrustDisplayConfig,
      documentationConfig: deps.documentationConfig,
      eventBus: deps.eventBus,
      spawnPacket: executionOverrides?.spawnPacket,
      deliveryMirror: deps.deliveryMirror,
      deliveryMirrorConfig: deps.deliveryMirrorConfig,
      channelMaxChars: deps.getChannelMaxChars?.(msg.channelType),
    },
    msg,
    sessionKey,
    agentId,
    mergedCustomTools,
    logger: deps.logger,
    safetyReinforcement,
    skipRag: executionOverrides?.skipRag,
    sepEnabled: config.sep?.enabled !== false,
    resolvedModelId: resolvedModel?.id,
    resolvedModelProvider: resolvedModel?.provider,
    resolvedModelReasoning: resolvedModel?.reasoning,
  });

  // -------------------------------------------------------------------
  // 5. System token estimate
  // -------------------------------------------------------------------
  const toolDefOverheadChars = mergedCustomTools.reduce((sum, t) => {
    const descLen = t.description?.length ?? 0;
    const paramLen = t.parameters ? JSON.stringify(t.parameters).length : 0;
    return sum + (t.name?.length ?? 0) + descLen + paramLen;
  }, 0);
  const cachedSystemTokensEstimate = Math.ceil(
    (promptResult.systemPrompt.length + toolDefOverheadChars) / CHARS_PER_TOKEN_RATIO,
  );

  // -------------------------------------------------------------------
  // 6. ResourceLoader options
  // -------------------------------------------------------------------
  const resourceLoaderOptions: ConstructorParameters<typeof DefaultResourceLoader>[0] = {
    cwd: deps.workspaceDir,
    settingsManager,
    noExtensions: true,
    additionalSkillPaths: config.skills?.discoveryPaths ?? [],
    noPromptTemplates: true,
    noThemes: true,
    systemPromptOverride: (_base) => promptResult.systemPrompt,
  };

  // Filter SDK-discovered skills through Comis's policy.
  const promptSkillsConfig = config.skills?.promptSkills;
  if (promptSkillsConfig) {
    const allowed = promptSkillsConfig.allowedSkills ?? [];
    const denied = promptSkillsConfig.deniedSkills ?? [];
    if (allowed.length > 0 || denied.length > 0) {
      resourceLoaderOptions.skillsOverride = (base) => {
        const filtered = base.skills.filter(skill => {
          if (allowed.length > 0 && !allowed.includes(skill.name)) return false;
          if (denied.includes(skill.name)) return false;
          return true;
        });
        return { skills: filtered, diagnostics: base.diagnostics };
      };
    }
  }

  // -------------------------------------------------------------------
  // 7. Tool deferral with lifecycle management
  // -------------------------------------------------------------------
  const sessionMessages = sm.buildSessionContext()?.messages ?? [];
  const recentlyUsedTools = extractRecentlyUsedToolNames(
    sessionMessages as unknown as Array<Record<string, unknown>>,
  );
  const contextWindow = resolvedModel?.contextWindow ?? 128_000;
  const modelTier = resolveModelTier(contextWindow);

  // Tool lifecycle management
  const lifecycleConfig: ToolLifecycleConfig = config.toolLifecycle ?? DEFAULT_LIFECYCLE_CONFIG;
  const formattedKeyForLifecycle = formatSessionKey(sessionKey);
  const tracker = getOrCreateTracker(formattedKeyForLifecycle, isFirstMessageInSession);

  const previousTurnTools = extractRecentlyUsedToolNames(
    sessionMessages as unknown as Array<Record<string, unknown>>,
    1,
  );
  tracker.recordTurn(previousTurnTools);

  let lifecycleDemotedNames: Set<string> | undefined;
  if (lifecycleConfig.enabled && tracker.getCurrentTurn() > lifecycleConfig.demotionThreshold) {
    const demotedSet = tracker.getDemotedToolNames(
      mergedCustomTools.map(t => t.name),
      lifecycleConfig.demotionThreshold,
      CORE_TOOLS,
    );
    if (demotedSet.size > 0) {
      lifecycleDemotedNames = demotedSet;
      deps.logger.info(
        {
          demotedCount: demotedSet.size,
          demotedNames: [...demotedSet],
          currentTurn: tracker.getCurrentTurn(),
          threshold: lifecycleConfig.demotionThreshold,
        },
        "Tool lifecycle demotion applied",
      );
    }
  }

  const formattedKeyForDeferral = formatSessionKey(sessionKey);
  const discoveryTracker = getOrCreateDiscoveryTracker(formattedKeyForDeferral, isFirstMessageInSession);

  // Mutable reference for getCompactionDeps closure.
  const currentDiscoveryTracker: DiscoveryTracker = discoveryTracker;

  // Restore discovery state from compaction metadata after daemon restart.
  if (!isFirstMessageInSession && discoveryTracker.getDiscoveredNames().size === 0) {
    try {
      /* eslint-disable @typescript-eslint/no-explicit-any */
      const sessionMgr = sm as any;
      const entries = sessionMgr?.fileEntries;
      if (Array.isArray(entries)) {
        for (const entry of entries) {
          const entryMsg = entry?.message;
          if (entryMsg?.compactionSummary === true && Array.isArray(entryMsg.discoveredTools) && entryMsg.discoveredTools.length > 0) {
            discoveryTracker.restore(entryMsg.discoveredTools);
            deps.logger.info(
              { restoredCount: entryMsg.discoveredTools.length, sessionKey: formattedKeyForDeferral },
              "Discovery state restored from compaction metadata",
            );
            break; // Only one compaction summary per session
          }
        }
      }
      /* eslint-enable @typescript-eslint/no-explicit-any */
    } catch {
      // Restore is best-effort -- compaction metadata may not exist or be malformed
    }
  }

  // Restore parent's discovery state for subagent inheritance.
  if (executionOverrides?.spawnPacket?.discoveredDeferredTools?.length) {
    discoveryTracker.restore(executionOverrides.spawnPacket.discoveredDeferredTools);
    deps.logger.info(
      {
        restoredCount: executionOverrides.spawnPacket.discoveredDeferredTools.length,
        sessionKey: formattedKeyForDeferral,
      },
      "Discovery state restored from parent SpawnPacket",
    );
  }

  const deferralCtx: DeferralContext = {
    trustLevel: config.elevatedReply?.defaultTrustLevel ?? "external",
    channelType: msg.channelType,
    modelTier,
    recentlyUsedToolNames: recentlyUsedTools,
    toolNames: mergedCustomTools.map(t => t.name),
    contextEngineVersion: config.contextEngine?.version,
    lifecycleDemotedNames,
    discoveryTracker,
    neverDefer: config.deferredTools?.neverDefer,
    alwaysDefer: config.deferredTools?.alwaysDefer,
    providerFamily: resolvedModel?.provider
      ? (isAnthropicFamily(resolvedModel.provider) ? "anthropic"
        : isGoogleFamily(resolvedModel.provider) ? "google"
        : "other")
      : undefined,
  };
  const deferralResult = applyToolDeferral(
    mergedCustomTools,
    contextWindow,
    deferralCtx,
    deps.logger,
    deps.embeddingPort,
    config.skills?.toolDiscovery,
  );
  mergedCustomTools = [...deferralResult.activeTools, ...deferralResult.discoveredTools];
  if (deferralResult.discoverTool) {
    mergedCustomTools.push(deferralResult.discoverTool);
  }

  // Build deferred context for dynamic preamble injection
  let deferredContext = "";
  if (deferralResult.deferredEntries.length > 0) {
    deferredContext = buildDeferredToolsContext(deferralResult.deferredEntries);
  }

  // -------------------------------------------------------------------
  // 8. JIT guide wrapping, schema pruning, snapshot, normalization, serializer
  // -------------------------------------------------------------------

  // Wrap tool execute() methods to inject operational guides on first use.
  mergedCustomTools = createJitGuideWrapper(mergedCustomTools, deliveredGuides, deps.logger);

  // Schema pruning for small models
  mergedCustomTools = applySchemasPruning({ tools: mergedCustomTools, modelTier, logger: deps.logger });

  // Schema snapshot management
  const schemaSnapshotKey = formatSessionKey(sessionKey);
  mergedCustomTools = applySchemaSnapshot({
    tools: mergedCustomTools,
    sessionKey: schemaSnapshotKey,
    deferredNames: deferralResult.deferredNames,
  });

  // Provider normalization + xAI decoding
  if (resolvedModel) {
    mergedCustomTools = applyProviderNormalization({
      tools: mergedCustomTools,
      provider: resolvedModel.provider,
      modelId: resolvedModel.id,
      compat: modelCompat,
    });
  }

  // Mutation serializer
  mergedCustomTools = applyMutationSerializer(mergedCustomTools, deps.logger);

  return {
    mergedCustomTools,
    deferralResult,
    deferredContext,
    deliveredGuides,
    modelTier,
    discoveryTracker,
    currentDiscoveryTracker,
    lifecycleDemotedNames,
    settingsManager,
    persistentSettings,
    resourceLoaderOptions,
    promptResult,
    cachedSystemTokensEstimate,
  };
}
