// SPDX-License-Identifier: Apache-2.0
/**
 * Tool assembly pipeline for PiExecutor.
 *
 * Extracted from pi-executor.ts execute() to isolate tool merging, SettingsManager creation,
 * settings overrides, prompt assembly, resource loader config, tool deferral, lifecycle
 * management, JIT guide wrapping, schema pruning/snapshot, provider normalization, serializer.
 *
 * Consumers:
 * - pi-executor.ts: calls assembleTools() during execute()
 *
 * @module
 */

import {
  SettingsManager,
  DefaultResourceLoader,
} from "@earendil-works/pi-coding-agent";

/** Partial<Settings> extracted from SettingsManager.applyOverrides() parameter type.
 *  Settings is not re-exported from the SDK's index -- extract from the class method. */
type SettingsOverrides = Parameters<SettingsManager['applyOverrides']>[0];
import { formatSessionKey, scriptTokenFactor } from "@comis/core";
import type { ErrorKind } from "@comis/core";
import { applyToolDeferral, buildDeferredToolsContext, createDiscoverTool, createAutoDiscoveryStubs, extractRecentlyUsedToolNames, applyToolBudgetFit, computeWindowFitBudget, CORE_TOOLS } from "./tool-deferral.js";
import type { DeferralContext } from "./tool-deferral.js";
import type { CapabilityClass } from "./model-profile.js";
import { FAIL_CLOSED_PROFILE } from "./model-profile.js";
import { resolveScaffoldDefaults } from "./scaffold-defaults.js";
import { buildCapabilityIndexContext } from "./capability-index-context.js";
import { getOrCreateDiscoveryTracker } from "./discovery-tracker.js";
import type { DiscoveryTracker } from "./discovery-tracker.js";
import { getOrCreateTracker, DEFAULT_LIFECYCLE_CONFIG } from "./tool-lifecycle.js";
import { resolveProviderCapabilities } from "../provider/capabilities.js";
import type { ToolLifecycleConfig } from "./tool-lifecycle.js";
import { createJitGuideWrapper } from "./jit-guide-injector.js";
import {
  applySchemasPruning,
  applySchemaSnapshot,
  applyProviderNormalization,
  applyPersistedReactiveStrip,
  applyMutationSerializer,
} from "./executor-tool-pipeline.js";
import { assembleExecutionPrompt } from "./prompt-assembly.js";
import { toolDefOverheadChars } from "./tool-overhead.js";
import { CHARS_PER_TOKEN_RATIO } from "../context-engine/constants.js";
import { computeTokenBudgetForProfile } from "../context-engine/budget-capacity-cap.js";
import type {
  ToolAssemblyParams,
  ToolAssemblyResult,
} from "./executor-tool-assembly-types.js";

// ---------------------------------------------------------------------------
// Per-capability-class preamble WARN thresholds + deferred-tools caps
// ---------------------------------------------------------------------------

/**
 * Preamble WARN threshold (tokens) per capability class.
 * Warn when cachedFreshTailPreambleTokens exceeds this fraction of the
 * effective context window. frontier: Infinity (never warn). small/nano:
 * tight budget (~10% of effective window is a notable preamble spend).
 *
 * Exported: context-engine/viable-floor.ts consumes
 * this table as the freshTailReserve term of the boot minViable equation —
 * the codebase's single per-class number for expected preamble size.
 */
export const PREAMBLE_WARN_THRESHOLD_BY_CLASS: Readonly<Record<CapabilityClass, number>> = {
  frontier: Infinity,
  mid: 8_000,
  small: 3_200,   // ~10% of 32K effective window
  nano: 1_600,    // ~10% of 16K effective window
} as const;

/**
 * Max deferred-tools entries emitted in the preamble per capability class.
 * frontier: unlimited (Infinity). small/nano: cap to avoid bloating preamble.
 */
const DEFERRED_TOOLS_MAX_BY_CLASS: Readonly<Record<CapabilityClass, number>> = {
  frontier: Infinity,
  mid: 60,
  small: 20,
  nano: 10,
} as const;

// ---------------------------------------------------------------------------
// Types — extracted to executor-tool-assembly-types.ts (file-size cap)
// ---------------------------------------------------------------------------

export type {
  ToolAssemblyDeps,
  ToolAssemblyResult,
  ToolAssemblyParams,
} from "./executor-tool-assembly-types.js";

// ---------------------------------------------------------------------------
// Script-aware system-tokens estimate
// ---------------------------------------------------------------------------

/** System-tokens estimate with script-aware effective chars.
 *  systemPrompt text gets its own factor (recalled content can be non-Latin);
 *  the tool-def overhead is an aggregate char count (machine-Latin JSON) and
 *  rides flat. ONE ceil over the summed effective chars — per-term ceils would
 *  inflate ASCII results and break byte-identity with a flat sum. Shared by the
 *  pre-deferral AND post-deferral (#190) sites so the two estimates cannot
 *  drift — the same anti-drift rule as the tool-overhead.ts extraction. */
function estimateSystemTokensFactored(systemPrompt: string, toolOverheadChars: number): number {
  return Math.ceil(
    (systemPrompt.length / scriptTokenFactor(systemPrompt) + toolOverheadChars) / CHARS_PER_TOKEN_RATIO,
  );
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
 * Pure function with params object. All mutable refs and closure state
 * remain in pi-executor.ts orchestrator scope.
 *
 * @param params - Tool assembly parameters
 * @returns Tool assembly result with all outputs needed by the orchestrator
 */
export async function assembleTools(params: ToolAssemblyParams): Promise<ToolAssemblyResult> {
  const {
    config, deps, sessionKey, msg, tools, executionOverrides,
    isFirstMessageInSession, sm, deliveredGuides,
    resolvedModel, modelCompat, modelProfile: modelProfileParam, windowProvenance, agentId, safetyReinforcement, _directives,
  } = params;

  const effectiveWorkspaceDir = executionOverrides?.workspaceDir ?? deps.workspaceDir; // Worktree jail when present.

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
    settingsManager = SettingsManager.create(effectiveWorkspaceDir, deps.agentDir);
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
      provider: {
        maxRetryDelayMs: config.sdkRetry?.maxDelayMs ?? 60000,
      },
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

  // 3b. Degenerate-window compact-prompt budget. The
  // system prompt is NON-EVICTABLE; on a window smaller than the full prompt (an
  // ~8K mid-class model whose ~10K prompt overflows even after every tool defers —
  // compact-secure never fires for mid/frontier), the pre-flight would throw
  // fixed_overhead_exceeds_window. The user's requirement is the agent NEVER
  // context-exhausts, so assembleExecutionPrompt gets this budget and falls back to
  // compact-secure when the full prompt can't fit. computeWindowFitBudget is the
  // SINGLE source the prompt-fit fallback AND the tool-budget fit pass (below)
  // share, so they can't diverge — its window is input-independent of systemTokens
  // (== the step-7 budget window).
  const fitWindowBudget = computeWindowFitBudget({
    profile: modelProfileParam ?? FAIL_CLOSED_PROFILE,
    thinkingLevel: _directives?.thinkingLevel ?? config.thinkingLevel,
    minVisibleOutputTokens: config.contextEngine?.budget?.minVisibleOutputTokens,
    effectiveContextCapSmall: config.contextEngine?.budget?.effectiveContextCapSmall,
    effectiveContextCapNano: config.contextEngine?.budget?.effectiveContextCapNano,
    windowProvenance,
  });

  // -------------------------------------------------------------------
  // 4. Prompt assembly (extracted to prompt-assembly.ts)
  // -------------------------------------------------------------------
  const promptResult = await assembleExecutionPrompt({
    config,
    deps: {
      workspaceDir: effectiveWorkspaceDir, // AGENTS.md/BOOT.md from the run's working tree.
      workspacePolicySnapshot: deps.workspacePolicySnapshot,
      isOnboarding: deps.isOnboarding,
      // Forward the data dir so the recall-trace recorder's base resolves
      // from the same source as the memory.recall_trace reader.
      dataDir: deps.dataDir,
      // Forward the recall-trace config so buildRecallTrace receives the
      // operator's `enabled` gate + bounds. Sourced from
      // AppConfig.diagnostics.recallTrace by daemon wiring (mirrors cacheTraceConfig).
      // When omitted/disabled, buildRecallTrace returns null (default-off).
      recallTraceConfig: deps.recallTraceConfig,
      memoryPort: deps.memoryPort,
      reranker: deps.reranker,
      entityStore: deps.entityStore,
      // Lane stores (temporal/causal/triple/embedding): forwarded to prompt-assembly;
      // a missing forward silently disables the corresponding RAG lane.
      temporalStore: deps.temporalStore,
      causalStore: deps.causalStore,
      tripleStore: deps.tripleStore,
      embeddingStore: deps.embeddingStore,
      usefulnessStore: deps.usefulnessStore,
      // Forward the pinned-memory store so the recall pipeline's Step-0 pinned-first
      // lane can fire. A missing forward here is a silent no-op: the gate
      // `cfg_pinned?.enabled === true && deps.pinnedStore !== undefined` never passes
      // and pinned entries are never prepended to recall results even when the operator
      // has set `rag.pinned.enabled: true` and pinned memories in the DB.
      pinnedStore: deps.pinnedStore,
      // Forward the mental-model store — the kind:"profile" source for the
      // <user_profile> block (prompt-assembly's deps.mentalModelStore.list(scope,"profile")
      // → buildProfileBlock). A missing forward here is a silent no-op (the profile
      // block never renders even with the store wired daemon-side).
      mentalModelStore: deps.mentalModelStore,
      timers: deps.timers,
      hookRunner: deps.hookRunner,
      secretManager: deps.secretManager,
      envelopeConfig: deps.envelopeConfig,
      outboundMediaEnabled: deps.outboundMediaEnabled,
      mediaPersistenceEnabled: deps.mediaPersistenceEnabled,
      autonomousMediaEnabled: deps.autonomousMediaEnabled,
      getPromptSkillsXml: deps.getPromptSkillsXml,
      getPromptSkillLocations: deps.getPromptSkillLocations,
      getMcpServerInstructions: deps.getMcpServerInstructions,
      subAgentToolNames: deps.subAgentToolNames,
      mcpToolsInherited: deps.mcpToolsInherited,
      isFirstMessageInSession,
      senderTrustDisplayConfig: deps.senderTrustDisplayConfig,
      eventBus: deps.eventBus,
      spawnPacket: executionOverrides?.spawnPacket,
      deliveryMirror: deps.deliveryMirror,
      deliveryMirrorConfig: deps.deliveryMirrorConfig,
      channelMaxChars: deps.getChannelMaxChars?.(msg.channelType),
      // Forward the tool-capability port so prompt-assembly.ts can read
      // `port.isCapabilityIndexEnabled()` for the static-prompt swap gate.
      toolCapabilityPort: deps.toolCapabilityPort,
      clock: deps.clock,
      // SystemPromptReport persistence wiring. Forwarded from
      // ToolAssemblyDeps -> PromptAssemblyParams.deps. When
      // observabilityStore is undefined the build+persist block in
      // prompt-assembly.ts is a no-op.
      observabilityStore: deps.observabilityStore,
      policyFilteredToolNames: deps.policyFilteredToolNames,
      runId: deps.runId,
      tenantId: deps.tenantId,
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
    // "interactive" default guards the optional overrides; mirrors pi-executor.ts:1077.
    operationType: executionOverrides?.operationType ?? "interactive",
    // Forward ModelProfile to prompt-assembly.ts for compact-secure mode selection.
    // modelProfileParam is the validated ModelProfile resolved at pi-executor.ts:323;
    // it is undefined when the executor has no profile resolution (rare path).
    modelProfile: modelProfileParam,
    // Degenerate-window compact-prompt fallback budget: when the full
    // prompt can't fit this window, assembleExecutionPrompt falls back to
    // compact-secure so the agent still runs instead of context-exhausting on its
    // fixed overhead. Only engages in the genuinely-degenerate case (normal windows
    // are byte-identical).
    windowFitBudget: fitWindowBudget,
  });

  // -------------------------------------------------------------------
  // 5. System token estimate
  // -------------------------------------------------------------------
  // The char-overhead reduce lives in tool-overhead.ts —
  // shared with the boot viable-floor so the two estimates cannot drift.
  const toolDefOverheadCharsValue = toolDefOverheadChars(mergedCustomTools);
  // Computed over the PRE-deferral set here so the input-independent windowTokens
  // (computeTokenBudgetForProfile below) has a value; RECOMPUTED over the
  // post-deferral active set after applyToolDeferral so the history-budget
  // partition + pre-flight fit check reserve for the tools that actually ship,
  // not the ~58 deferred ones the stub filter strips from the wire (live
  // finding: the pre-deferral 82-tool estimate over-reserved ~16K and
  // falsely context-exhausted multi-turn local-model sessions).
  // Script-aware effective chars — see estimateSystemTokensFactored.
  let cachedSystemTokensEstimate = estimateSystemTokensFactored(
    promptResult.systemPrompt,
    toolDefOverheadCharsValue,
  );
  // The WHOLE fresh-tail preamble token estimate — the entire
  // dynamicPreamble + inlineMemory blob envelope-wrapper prepends into the latest
  // user message (skills XML, MCP instructions, deferred-tools context, date/channel
  // lines, recalled memory, …, NOT just recall), measured as a SEPARATE budget
  // subtrahend (NOT folded into S above — the recall-dag-budget-partition lock).
  // The whole preamble is counted deliberately: it rides the unconditionally-shipped
  // fresh tail and is reserved nowhere else, so this is the only window-headroom
  // reservation for it (recall is a strict subset → a heavier recall block still
  // grows this and compacts harder). See token-budget.ts.
  // Both terms are TEXT (the preamble carries recalled
  // memories/skills which can be non-Latin) — each term's chars divided by its
  // own script factor, ONE ceil over the summed effective chars (ASCII
  // factors are 1.0 → byte-identical to a flat sum).
  const inlineMemoryText = promptResult.inlineMemory ?? "";
  const cachedFreshTailPreambleTokens = Math.ceil(
    (promptResult.dynamicPreamble.length / scriptTokenFactor(promptResult.dynamicPreamble) +
      inlineMemoryText.length / scriptTokenFactor(inlineMemoryText)) / CHARS_PER_TOKEN_RATIO,
  );

  // -------------------------------------------------------------------
  // 6. ResourceLoader options
  // -------------------------------------------------------------------
  const resourceLoaderOptions: ConstructorParameters<typeof DefaultResourceLoader>[0] = {
    cwd: effectiveWorkspaceDir,
    agentDir: deps.agentDir,
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
  const modelProfile = modelProfileParam ?? FAIL_CLOSED_PROFILE;
  const capabilityClass = modelProfile.capabilityClass;
  // Resolve capacity defaults (bootstrapMaxChars + activeToolCeiling).
  const capacityDefaults = resolveScaffoldDefaults(modelProfile, config);

  // Preamble size guard — warn when preamble tokens exceed the profile cap.
  // This is a soft operator signal: the preamble is already assembled, but the
  // warn lets operators know they may want to reduce MCP tools or deferred-tools
  // list size for this capability class.
  const preambleWarnThreshold = PREAMBLE_WARN_THRESHOLD_BY_CLASS[capabilityClass];
  if (cachedFreshTailPreambleTokens > preambleWarnThreshold) {
    deps.logger.warn({
      hint: `Per-turn preamble (${cachedFreshTailPreambleTokens} tokens) exceeds the ${capabilityClass} profile cap (${preambleWarnThreshold}); consider reducing MCP tools or deferred-tools list`,
      errorKind: "resource" as const,
      cachedFreshTailPreambleTokens,
      preambleWarnThreshold,
      capabilityClass,
    }, "C3: preamble size exceeds profile cap");
  }

  // Profile-aware budget — 8K-starvation fix + 256K-overfill cap + window
  // provenance. windowTokens is input-independent of the systemTokens args.
  const profileBudget = computeTokenBudgetForProfile(
    modelProfile,
    cachedSystemTokensEstimate,
    cachedFreshTailPreambleTokens,
    -1,
    config.contextEngine?.budget?.effectiveContextCapSmall,
    config.contextEngine?.budget?.effectiveContextCapNano,
    windowProvenance,
  );
  // contextWindow: the per-turn effective window the tool-budget fit pass uses.
  // profileBudget.windowTokens === fitWindowBudget.effectiveWindow (step 3b) by
  // construction — both are min(modelProfile.contextWindow, classCap) from the same
  // profile, the SAME value the pre-flight throws on. (Window source was never the
  // bug — the VPS under-defer was the auto-discovery stubs inflating the systemTokens
  // estimate; fixed in toolDefOverheadChars. Window parity holds regardless.)
  const contextWindow = profileBudget.windowTokens;

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
    // Per-message trust resolution. The deferral context must consult
    // `senderTrustMap` entries (e.g. {"678314278": "admin"}), not just the
    // GLOBAL `defaultTrustLevel` — otherwise privileged tools like
    // `mcp_manage`, `agents_manage`, `obs_query` (all 14 in
    // `PRIVILEGED_TOOL_NAMES`) stay in the deferred set even for
    // explicitly-mapped admin users, forcing them through indirection
    // tools. Mirrors the resolution at
    // packages/orchestrator/src/execution/execution-policy.ts:82:
    //   elevCfg.senderTrustMap[senderId] ?? elevCfg.defaultTrustLevel
    trustLevel:
      config.elevatedReply?.senderTrustMap?.[msg.senderId]
      ?? config.elevatedReply?.defaultTrustLevel
      ?? "external",
    channelType: msg.channelType,
    capabilityClass,
    recentlyUsedToolNames: recentlyUsedTools,
    toolNames: mergedCustomTools.map(t => t.name),
    lifecycleDemotedNames,
    discoveryTracker,
    neverDefer: config.deferredTools?.neverDefer,
    alwaysDefer: config.deferredTools?.alwaysDefer,
    providerFamily: resolvedModel?.provider
      ? resolveProviderCapabilities(resolvedModel.provider).providerFamily
      : "default",
    // Capability-class active-tool ceiling.
    activeToolCeiling: capacityDefaults.activeToolCeiling,
  };
  const deferralResult = applyToolDeferral(
    mergedCustomTools,
    contextWindow,
    deferralCtx,
    deps.logger,
    deps.embeddingPort,
    config.skills?.toolDiscovery,
  );

  // Rebuild discover_tools with the now-known active set so it can answer
  // "already active" queries correctly. Post-deferral set (active +
  // discovered) is the only factually-accurate set -- using mergedCustomTools
  // (pre-deferral) would false-positive on currently-deferred tools and tell
  // the agent "call directly, no discovery needed" for tools that aren't
  // actually loaded.
  if (deferralResult.discoverTool) {
    const activeAfterDeferral = new Set<string>([
      ...deferralResult.activeTools.map(t => t.name),
      ...deferralResult.discoveredTools.map(t => t.name),
    ]);
    deferralResult.discoverTool = createDiscoverTool(
      deferralResult.deferredEntries,
      deps.logger,
      deps.embeddingPort,
      config.skills?.toolDiscovery,
      activeAfterDeferral,
    );
  }

  // Context-exhaustion guard: applyToolDeferral defers
  // by COUNT (activeToolCeiling / CORE_TOOLS heuristic) and never against a token
  // budget — its `_contextWindow` arg is ignored. So on a small window a large
  // system prompt + even a CORE_TOOLS-only active set can exceed effectiveWindow −
  // headroom, making the pre-flight fit check (lcd-preflight.ts) throw
  // ContextExhaustionError on EVERY turn — even a 10-token "What is the capital of
  // France?". The codex `nano` classes (~16K effective window) hit this on every
  // message. applyToolBudgetFit defers MORE active tools (lowest-priority first;
  // CORE_TOOLS preferentially kept; discover_tools dropped only when nothing
  // remains to discover) until the SHIPPING active-tool overhead fits the residual
  // budget, refining deferralResult in place (incl. rebuilding discover_tools over
  // the new deferred set). Dropped tools stay reachable via discover_tools (no
  // capability loss for adequate windows). The fixed S term is non-evictable, so
  // the degenerate window<S case still throws — but with the honest cause
  // (fixed_overhead_exceeds_window), never "your message is too big". The
  // headroom mirrors lcd-preflight.ts exactly (same reasoningStyle / thinkingLevel
  // / minVisibleFloor) so the two passes agree. The headroom + floor + window are
  // the SAME values computed once in step 3b (fitWindowBudget) — reused here so the
  // prompt-fit and tool-fit passes can never diverge. contextWindow === the budget's
  // effectiveWindow (windowTokens is input-independent of the systemTokens args).
  applyToolBudgetFit(deferralResult, {
    systemPromptText: promptResult.systemPrompt,
    contextWindow,
    outputHeadroom: fitWindowBudget.outputHeadroom,
    messageFloorTokens: fitWindowBudget.messageFloorTokens,
    recentlyUsedToolNames: recentlyUsedTools,
    // Honor the operator's deferredTools.neverDefer here too — the count-based deferral pass
    // (applyToolDeferral) respects it, but this window-aware fit pass must as well, or a small
    // window silently drops a neverDefer-pinned tool (e.g. the dag-mode ctx_* expansion tools).
    neverDeferToolNames: config.deferredTools?.neverDefer ? new Set(config.deferredTools.neverDefer) : undefined,
    logger: deps.logger,
    embeddingPort: deps.embeddingPort,
    scoreConfig: config.skills?.toolDiscovery,
  });

  mergedCustomTools = [...deferralResult.activeTools, ...deferralResult.discoveredTools];
  if (deferralResult.discoverTool) {
    mergedCustomTools.push(deferralResult.discoverTool);
  }

  // Recompute the system-token reservation over the tools that ACTUALLY ship
  // (active + discovered + discover_tools — the current mergedCustomTools, BEFORE
  // the auto-discovery stubs added below, which the stub filter strips from the
  // wire). The pre-deferral estimate above counted every registered tool, so a
  // small-class agent that defers most of its surface over-reserved budget and
  // falsely context-exhausted multi-turn sessions (observed in a live session).
  // windowTokens is input-independent of this value, so the earlier budget call's
  // window is unaffected; only the downstream history partition + fit check use
  // this corrected, smaller reservation.
  // The recompute (the third char→token site, #190) MUST use the same factored
  // helper as the pre-deferral estimate — a flat recompute here would silently
  // UNDO the script factor right before the history partition + fit check consume it.
  cachedSystemTokensEstimate = estimateSystemTokensFactored(
    promptResult.systemPrompt,
    toolDefOverheadChars(mergedCustomTools),
  );

  // 7b. Auto-discovery stubs for deferred tools.
  // Lightweight stubs so the SDK's agent-loop finds deferred tools during
  // tool resolution. Prevents "Tool X not found" errors when skills
  // reference deferred MCP tools directly. Stubs are filtered from the
  // API request by createStubFilterInjector (see stream-wrappers/
  // stub-filter-injector.ts) -- zero token cost guarantee.
  // Position: BEFORE JIT guide wrapping / schema pruning / sideEffects
  // wrapping -- stubs receive all downstream wrappers automatically.
  if (deferralResult.deferredEntries.length > 0) {
    const stubs = createAutoDiscoveryStubs(
      deferralResult.deferredEntries,
      discoveryTracker,
      deps.logger,
    );
    mergedCustomTools.push(...stubs);
  }

  // Build deferred-tools context for dynamic preamble injection (mechanism-neutral).
  // Provider-specific payload reshaping (stripping the client-side discovery
  // tool, appending the server-side tool-search regex tool for Anthropic
  // Sonnet/Opus 4.x) lives entirely in `request-body-injector.ts` and is
  // gated there by a model-id capability check. See tool-deferral.ts JSDoc
  // on `buildDeferredToolsContext` for the rationale.
  //
  // Cap the deferred-tools list for small/nano to bound preamble size.
  // frontier/mid: DEFERRED_TOOLS_MAX_BY_CLASS[class] = Infinity → pass undefined (no cap).
  const deferredToolsMax = DEFERRED_TOOLS_MAX_BY_CLASS[capabilityClass];
  let deferredContext = "";
  if (deferralResult.deferredEntries.length > 0) {
    deferredContext = buildDeferredToolsContext(
      deferralResult.deferredEntries,
      deferredToolsMax !== Infinity ? { maxEntries: deferredToolsMax } : undefined,
    );
  }

  // Per-turn capability index.
  // Lives AFTER applyToolDeferral so the renderer sees the post-partition
  // state (active vs deferred entries). When the port is the no-op, the
  // renderer's gate check still respects port.isCapabilityIndexEnabled();
  // if false, returns EMPTY which the runner filters via .filter(Boolean).
  const capabilityIndexResult = buildCapabilityIndexContext(
    deferralResult,
    deps.toolCapabilityPort,
  );

  // -------------------------------------------------------------------
  // 8. JIT guide wrapping, schema pruning, snapshot, normalization, serializer
  // -------------------------------------------------------------------

  // Wrap tool execute() methods to inject operational guides on first use.
  mergedCustomTools = createJitGuideWrapper(mergedCustomTools, deliveredGuides, deps.logger);

  // Schema pruning for small models
  mergedCustomTools = applySchemasPruning({ tools: mergedCustomTools, capabilityClass, logger: deps.logger });

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
      // Thread the gbnfConstrain authoring gate end-to-end.
      // The flag lives on the top-level AppConfig (config.orchestration.authoring),
      // NOT PerAgentConfig — so it arrives via a deps resolver that reads
      // container.config live (runtime-mutable; see getGbnfConstrain JSDoc).
      // Absent resolver ⇒ false ⇒ FLAGS-OFF byte-identical.
      gbnfConstrain: deps.getGbnfConstrain?.() ?? false,
    });
  }

  // Re-apply the session's reactive pattern/format strip
  // AFTER normalization — the per-turn snapshot→normalize rebuild constructs
  // fresh parameter objects, so a strip that healed turn N must be re-applied
  // here or turn N+1 re-sends the rejected keywords and (with the once-gate
  // closed) permanently bricks the session. Identity no-op when never armed.
  mergedCustomTools = applyPersistedReactiveStrip({
    tools: mergedCustomTools,
    sessionKey: schemaSnapshotKey,
  });

  // Mutation serializer
  mergedCustomTools = applyMutationSerializer(mergedCustomTools, deps.logger);

  return {
    mergedCustomTools,
    deferralResult,
    deferredContext,
    capabilityIndexResult,
    deliveredGuides,
    capabilityClass,
    // The per-turn budget window (min(reconciled contextWindow, class
    // cap)) — the single-sourced contextWindow (== fitWindowBudget.effectiveWindow),
    // the same value the pre-flight throws on and every budget computation reports.
    budgetWindowTokens: contextWindow,
    discoveryTracker,
    currentDiscoveryTracker,
    lifecycleDemotedNames,
    settingsManager,
    persistentSettings,
    resourceLoaderOptions,
    promptResult,
    cachedSystemTokensEstimate,
    cachedFreshTailPreambleTokens,
  };
}
