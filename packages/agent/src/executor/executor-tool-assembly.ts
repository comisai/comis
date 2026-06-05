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
import type {
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";

/** Partial<Settings> extracted from SettingsManager.applyOverrides() parameter type.
 *  Settings is not re-exported from the SDK's index -- extract from the class method. */
type SettingsOverrides = Parameters<SettingsManager['applyOverrides']>[0];
import type { AgentTool } from "@earendil-works/pi-agent-core";
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
  type ToolCapabilityPort,
} from "@comis/core";
import type { ComisLogger, ErrorKind } from "@comis/core";
import { applyToolDeferral, buildDeferredToolsContext, createDiscoverTool, createAutoDiscoveryStubs, extractRecentlyUsedToolNames, resolveModelTier, CORE_TOOLS } from "./tool-deferral.js";
import type { DeferralContext, ExcludeDeferralResult } from "./tool-deferral.js";
import { buildCapabilityIndexContext } from "./capability-index-context.js";
import type { CapabilityIndexRenderResult } from "./capability-index-context.js";
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
  /** Optional cross-encoder reranker, threaded into prompt-assembly's createMemoryRecall. */
  reranker?: import("@comis/core").RerankerPort;
  /** Optional entity-associative store, threaded into prompt-assembly's
   *  createMemoryRecall. TYPE-only from @comis/core (the agent↛memory build cut). */
  entityStore?: import("@comis/core").MemoryEntityStore;
  /** Optional temporal-spread store, threaded into prompt-assembly's
   *  createMemoryRecall (the 4th temporal lane). TYPE-only from @comis/core (the agent↛memory cut). */
  temporalStore?: import("@comis/core").MemoryTemporalStore;
  /** Optional causal store, threaded into prompt-assembly's createMemoryRecall
   *  (the 5th causal lane). TYPE-only from @comis/core (the agent↛memory build cut). */
  causalStore?: import("@comis/core").MemoryCausalStore;
  /** Optional triple store, threaded into prompt-assembly's createMemoryRecall
   *  (the 6th graph-spread lane). TYPE-only from @comis/core (the agent↛memory build cut). */
  tripleStore?: import("@comis/core").TripleStorePort;
  /** Optional embedding read store, threaded into prompt-assembly's createMemoryRecall
   *  (the MMR diversity re-rank's scoped embedding read). TYPE-only from @comis/core (the
   *  agent↛memory build cut). */
  embeddingStore?: import("@comis/core").MemoryEmbeddingStore;
  /** Optional usefulness store, threaded into prompt-assembly's createMemoryRecall.
   *  TYPE-only from @comis/core (the agent↛memory build cut). */
  usefulnessStore?: import("@comis/core").MemoryUsefulnessStore;
  /** Optional pinned-memory store. Forwarded into prompt-assembly's createMemoryRecall
   *  Step-0 pinned-first lane (the `deps.pinnedStore !== undefined` half of the gate).
   *  A missing forward here is a silent no-op: pinned memories never appear in
   *  agent recall even when the store is wired in the daemon and `rag.pinned.enabled`
   *  is true (the R6 blocker). TYPE-only from @comis/core (the agent↛memory build cut). */
  pinnedStore?: import("@comis/core").MemoryPinnedStore;
  /** Optional learned-alpha store, threaded into prompt-assembly's deterministic
   *  apply overlay (the gated buildScoringAlphas read on the recall scoring arg). Absent /
   *  off / no-row -> no read, the static config.rag.scoring alphas pass unchanged (byte-identical
   *  recall). A missing forward of the daemon construction + the createPiExecutor forward leaves
   *  the overlay a silent no-op (the field-plumbing hazard). TYPE-only from
   *  @comis/core (the agent↛memory build cut). */
  tunedAlphaStore?: import("@comis/core").TunedAlphaStore;
  /** Optional per-user representation store, threaded into prompt-assembly's LLM-free
   *  `<user_profile>` standing-block injection (a deterministic scoped read + pure formatter, NO
   *  model call). Absent -> no read, no push, byte-identical prompt. TYPE-only from @comis/core
   *  (the agent↛memory build cut). A missing forward here leaves the profile injection a silent
   *  no-op even when the store is wired in the daemon (the documented latent field-plumbing drop —
   *  Pitfall 1). */
  userRepresentationStore?: import("@comis/core").UserRepresentationStore;
  /** Optional directional relationship store. Forwarded into
   *  prompt-assembly's LLM-free `<channel_relationships>` standing-block injection (a deterministic
   *  channel-scoped read + pure formatter, NO model call). Absent -> no read, no push, byte-identical
   *  prompt. TYPE-only from @comis/core (the agent↛memory build cut). A missing forward here leaves the
   *  relationship injection a silent no-op even when the store is wired in the daemon (Pitfall 6). */
  relationshipStore?: import("@comis/core").RelationshipStore;
  /** Timer port for the rerank wall-clock deadline (createMemoryRecall). */
  timers?: import("@comis/core").TimerPort;
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
  /**
   * Tool-capability port for the per-turn capability-index renderer.
   * Daemon wiring injects createNoOpCapabilityPort() from @comis/core; the
   * live adapter is swapped in elsewhere. The no-op is a real production
   * code path — NOT a transitional shim.
   */
  toolCapabilityPort: ToolCapabilityPort;
  skillRegistry?: {
    getEligibleSkillNames(): Set<string>;
    initFromSdkSkills(sdkSkills: Array<{ name: string; description: string; filePath: string; baseDir: string; source: string; disableModelInvocation: boolean }>): void;
  };
  /** Resolve platform message character limit for a channel type. */
  getChannelMaxChars?: (channelType: string) => number | undefined;
  /** Wall-clock + monotonic time reads. */
  clock: import("@comis/core").ClockPort;
  /**
   * ObservabilityStore for SystemPromptReport SQLite persistence.
   * Forwarded from PiExecutorDeps via frozenDeps spread in
   * pi-executor.ts. Threaded through to prompt-assembly.ts deps for
   * the build+persist hook.
   */
  observabilityStore?: import("@comis/observability").ObservabilityStoreLike;
  /**
   * Set of tool names registered in the prompt but filtered out by
   * policy (toolPolicy.deny / capability gate). The
   * SystemPromptReport's tools.entries[].callable reflects this.
   */
  policyFilteredToolNames?: ReadonlySet<string>;
  /**
   * Run-scoped identifier (per pi-mono turn). Becomes the report's
   * `runId` field for cross-correlation with trajectory events.
   */
  runId?: string;
  /** Tenant ID for multi-tenant deployments. */
  tenantId?: string;
  /** Daemon data dir (COMIS_DATA_DIR / config.dataDir). Forwarded to
   *  prompt-assembly so the recall-trace recorder resolves its containment base
   *  from the SAME source the memory.recall_trace reader uses. */
  dataDir?: string;
  /** Recall-trace writer configuration. Forwarded from
   *  PiExecutorDeps.recallTraceConfig (sourced from AppConfig.diagnostics.recallTrace
   *  by daemon wiring) into PromptAssemblyParams.deps.recallTraceConfig, where
   *  buildRecallTrace reads the `enabled` gate. Mirrors the dataDir thread above.
   *  When omitted or `enabled: false`, the recorder is null (default-off, opt-in). */
  recallTraceConfig?: {
    readonly enabled?: boolean;
    readonly filePath?: string;
    readonly maxFileBytes?: number;
  };
}

/** Result of the tool assembly pipeline. */
export interface ToolAssemblyResult {
  /** Final processed tools ready for session creation. */
  mergedCustomTools: ToolDefinition[];
  /** Tool deferral result with active, deferred, and discover tool. */
  deferralResult: ExcludeDeferralResult;
  /** Formatted deferred tools context for dynamic preamble injection. */
  deferredContext: string;
  /**
   * Per-turn capability-index render result.
   * `text` is concatenated into the dynamic preamble; the count fields feed
   * the Pino debug log emitted in `executor-prompt-runner.ts`.
   * When the port returns gate-disabled or all counts are zero, the renderer
   * returns the EMPTY sentinel and `text === ""` filters out via
   * `[...].filter(Boolean)` in the runner.
   */
  capabilityIndexResult: CapabilityIndexRenderResult;
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
  /** I1 / WR-01: estimated WHOLE fresh-tail preamble token count (the entire
   *  `dynamicPreamble` + `inlineMemory` blob envelope-wrapper prepends into the
   *  latest user message — skills XML, MCP instructions, deferred-tools context,
   *  date/channel lines, recalled memory, …, NOT just recall) — a SEPARATE budget
   *  subtrahend, never folded into the system estimate above. The whole preamble is
   *  counted on purpose (it rides the unconditionally-shipped fresh tail and is
   *  reserved nowhere else); see token-budget.ts WR-01. */
  cachedFreshTailPreambleTokens: number;
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

  // -------------------------------------------------------------------
  // 4. Prompt assembly (extracted to prompt-assembly.ts)
  // -------------------------------------------------------------------
  const promptResult = await assembleExecutionPrompt({
    config,
    deps: {
      workspaceDir: deps.workspaceDir,
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
      // The lane stores ride the SAME forwarded subset as entityStore/usefulnessStore.
      // temporalStore + causalStore were previously DROPPED here
      // (a latent field-plumbing no-op: ToolAssemblyDeps carried them and
      // prompt-assembly's createMemoryRecall reads them, but this enumeration omitted
      // them, so both lanes were dead via the real pi-executor path). tripleStore
      // (the 6th graph-spread lane) is forwarded the same way — a missing
      // forward leaves the lane dormant even when its config flag is on. embeddingStore
      // (the MMR diversity re-rank's scoped embedding read) is forwarded the same
      // way — a missing forward leaves MMR a silent no-op even when rag.mmr.enabled is on.
      temporalStore: deps.temporalStore,
      causalStore: deps.causalStore,
      tripleStore: deps.tripleStore,
      embeddingStore: deps.embeddingStore,
      usefulnessStore: deps.usefulnessStore,
      // R6: forward the pinned-memory store so the recall pipeline's Step-0 pinned-first
      // lane can fire. A missing forward here is a silent no-op: the gate
      // `cfg_pinned?.enabled === true && deps.pinnedStore !== undefined` never passes
      // and pinned entries are never prepended to recall results even when the operator
      // has set `rag.pinned.enabled: true` and pinned memories in the DB.
      pinnedStore: deps.pinnedStore,
      // Forward the per-user representation store the SAME way as usefulnessStore — a
      // missing forward here is a silent no-op (the profile <user_profile> block never renders even
      // with the store wired in the daemon). prompt-assembly's deps.userRepresentationStore.read is
      // the LLM-free standing-block read.
      userRepresentationStore: deps.userRepresentationStore,
      // Forward the directional relationship store the SAME way as
      // userRepresentationStore — a missing forward here is a silent no-op (the
      // <channel_relationships> block never renders even with the store wired in the daemon).
      // prompt-assembly's deps.relationshipStore.read is the LLM-free standing-block read.
      relationshipStore: deps.relationshipStore,
      // Forward the learned-alpha store the SAME way as usefulnessStore — a
      // missing forward here is a silent no-op (buildScoringAlphas never reads the tuned vector
      // even with the store wired through the daemon → BootContext → createPiExecutor chain AND
      // rag.onlineTuning.enabled). prompt-assembly's gated read `if (onlineTuningEnabled &&
      // deps.tunedAlphaStore)` (the deterministic apply overlay) consumes it. This is the final hop in the
      // ToolAssemblyDeps → PromptAssemblyParams.deps enumeration. Default-OFF byte-identity is
      // preserved: when the store is absent/undefined (off) the static config.rag.scoring alphas
      // pass unchanged, and the trust-freeze belts hold (trustAlpha is sourced only from config).
      tunedAlphaStore: deps.tunedAlphaStore,
      timers: deps.timers,
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
  // I1 / WR-01: the WHOLE fresh-tail preamble token estimate — the entire
  // dynamicPreamble + inlineMemory blob envelope-wrapper prepends into the latest
  // user message (skills XML, MCP instructions, deferred-tools context, date/channel
  // lines, recalled memory, …, NOT just recall), measured as a SEPARATE budget
  // subtrahend (NOT folded into S above — the recall-dag-budget-partition lock).
  // The whole preamble is counted deliberately: it rides the unconditionally-shipped
  // fresh tail and is reserved nowhere else, so this is the only window-headroom
  // reservation for it (recall is a strict subset → a heavier recall block still
  // grows this and compacts harder, preserving I1's intent). See token-budget.ts WR-01.
  const cachedFreshTailPreambleTokens = Math.ceil(
    (promptResult.dynamicPreamble.length + (promptResult.inlineMemory?.length ?? 0)) / CHARS_PER_TOKEN_RATIO,
  );

  // -------------------------------------------------------------------
  // 6. ResourceLoader options
  // -------------------------------------------------------------------
  const resourceLoaderOptions: ConstructorParameters<typeof DefaultResourceLoader>[0] = {
    cwd: deps.workspaceDir,
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
    // 260521-0bn: per-message trust resolution. Previously the deferral
    // context used the GLOBAL `defaultTrustLevel` only, which meant
    // `senderTrustMap` entries (e.g. {"678314278": "admin"}) never
    // reached this code path — privileged tools like `mcp_manage`,
    // `agents_manage`, `obs_query` (all 14 in `PRIVILEGED_TOOL_NAMES`)
    // stayed in the deferred set even for explicitly-mapped admin users,
    // forcing them through indirection tools. This now mirrors the
    // resolution at packages/orchestrator/src/execution/execution-policy.ts:82:
    //   elevCfg.senderTrustMap[senderId] ?? elevCfg.defaultTrustLevel
    trustLevel:
      config.elevatedReply?.senderTrustMap?.[msg.senderId]
      ?? config.elevatedReply?.defaultTrustLevel
      ?? "external",
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
      : "default",
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

  mergedCustomTools = [...deferralResult.activeTools, ...deferralResult.discoveredTools];
  if (deferralResult.discoverTool) {
    mergedCustomTools.push(deferralResult.discoverTool);
  }

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
  let deferredContext = "";
  if (deferralResult.deferredEntries.length > 0) {
    deferredContext = buildDeferredToolsContext(deferralResult.deferredEntries);
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
    capabilityIndexResult,
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
    cachedFreshTailPreambleTokens,
  };
}
