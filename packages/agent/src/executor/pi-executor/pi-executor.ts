// SPDX-License-Identifier: Apache-2.0
/**
 * PiExecutor: Wraps pi-coding-agent's createAgentSession() behind the
 * AgentExecutor interface with all Comis safety controls.
 *
 * Phase 42 split per EXEC-SPLIT-05/06: the pre-split 1,645L
 * `executor/pi-executor.ts` is replaced by this subdirectory of 9
 * focused modules. The closure-extracted helpers
 * (`session-bootstrap.ts`, `compaction-trigger.ts`, `safety-gate.ts`,
 * `message-envelope.ts`, `executor-error-mapping.ts`) take their state
 * via an explicit `state` first parameter — EXEC-SPLIT-06.
 *
 * Integrates:
 * - Circuit breaker: blocks calls when provider is failing
 * - Budget guard: pre-checks cost before each LLM call
 * - Step counter: halts after MAX_STEPS tool executions
 * - PiEventBridge: maps AgentSessionEvent to TypedEventBus
 * - JSONL session adapter: per-session write lock serialization
 * - Orphaned message repair: fixes trailing user messages
 * - System prompt override: via public DefaultResourceLoader.systemPromptOverride API
 * - Model fallback: retries with fallback models on prompt error
 * - Execution bookend log: INFO-level summary stats on every execution
 *
 * §13.3 fallback note (per 42-05-PLAN.md): the `withSession` callback body
 * (~900L) was NOT closure-extracted — its hundreds of inter-references
 * between session manager, bridge, stream wrappers, context engine, tool
 * pipeline, and runPrompt invocation would require either a state shape
 * with 50+ fields or further sub-decomposition that breaks the natural
 * orchestrator-edge boundary. The closure-extracted helpers handle the
 * pre/post-lock concerns (bootstrap, safety, compaction setup, message
 * envelope outcome, lock-failure mapping); the inside-lock callback is
 * the thinned factory's own composition root. See SUMMARY.md for the
 * `removedIn: "deferred"` allowlist entry rationale.
 *
 * @module
 */

import {
  createAgentSession,
  DefaultResourceLoader,
} from "@mariozechner/pi-coding-agent";
import type {
  CreateAgentSessionOptions,
  SessionManager as SdkSessionManager,
} from "@mariozechner/pi-coding-agent";

import type { ModelRegistry } from "@mariozechner/pi-coding-agent";
import type { CacheRetention } from "@mariozechner/pi-ai";
import {
  formatSessionKey,
  tryGetContext,
  ContextEngineConfigSchema,
  type SessionKey,
  type NormalizedMessage,
  type PerAgentConfig,
} from "@comis/core";
import type { ErrorKind } from "@comis/core";
import { suppressError } from "@comis/shared";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { CommandDirectives } from "../command-directive-types.js";
import type { StepCounter } from "../step-counter.js";
import { createToolRetryBreaker } from "../../safety/tool-retry-breaker.js";
import { createMessageSendLimiter } from "../../safety/message-send-limiter.js";
import type { ComisSessionManager } from "../../session/comis-session-manager.js";
import type { RunHandle } from "../active-run-registry.js";
import { repairOrphanedMessages, scrubPoisonedThinkingBlocks } from "../../session/orphaned-message-repair.js";
import { scrubRedactedToolCalls } from "../../session/scrub-redacted-tool-calls.js";
import { createPiEventBridge } from "../../bridge/pi-event-bridge.js";
import { assertThinkingBlocksUnchanged, restoreCanonicalThinkingBlocks } from "../../bridge/thinking-block-hash-invariant.js";
import type { AdaptiveCacheRetention } from "../adaptive-cache-retention.js";
import { createContextWindowGuard } from "../../safety/context-window-guard.js";
import { composeStreamWrappers } from "../stream-wrappers/index.js";
import { setupStreamWrappers } from "../executor-stream-setup.js";
import type { DiscoveryTracker } from "../discovery-tracker.js";
import { applyCommandDirectives } from "../executor-command-handlers.js";
import { setupContextEngine } from "../executor-context-engine-setup.js";
import { runPrompt } from "../prompt-runner/index.js";
import { wrapToolResultWithGuide } from "../jit-guide-injector.js";
import { postExecution } from "../executor-post-execution.js";
import { assembleTools } from "../executor-tool-assembly.js";
import {
  getDeliveredGuides,
  setDeliveredGuides,
  setBreakpointIndex,
  clearSessionCacheWarm,
  setEvictionCooldown,
  decrementEvictionCooldown as decrementEvictionCooldownForSession,
  recordCacheSavings,
  getCacheSavings,
  clearSessionCacheSavings,
  setSessionStateClock,
} from "../executor-session-state.js";
import { normalizeModelCompat } from "../../provider/model-compat.js";
import { normalizeModelId } from "../../provider/model-id-normalize.js";
import { isAnthropicFamily, isGoogleFamily, resolveProviderCapabilities } from "../../provider/capabilities.js";
import { detectOnboardingState } from "../../workspace/onboarding-detector.js";
import { installDagIngestionHook, validateRoleAttribution } from "../../context-engine/index.js";
import type { TokenAnchor } from "../../context-engine/types.js";
import { CHARS_PER_TOKEN_RATIO } from "../../context-engine/constants.js";
import { getElapsedSinceLastResponse } from "../ttl-guard.js";
import { clearSessionBlockStability } from "../block-stability-tracker.js";
import { wrapToolForAutoBackground } from "../../background/index.js";
import { BackgroundTasksConfigSchema } from "@comis/core";
import type { BackgroundTaskOrigin } from "@comis/core";
import { OPERATION_TIMEOUT_DEFAULTS } from "../../model/operation-model-defaults.js";
import type { AgentExecutor, ExecutionResult, ExecutionOverrides } from "../types.js";
import { randomUUID } from "node:crypto";

// Closure-extracted helpers (state-first per EXEC-SPLIT-06)
import { installCompactionTrigger } from "./compaction-trigger.js";
import { bootstrapSession, decodeExecutionOverrides, type MutableRef } from "./session-bootstrap.js";
import { runSafetyGates } from "./safety-gate.js";
import { applyPromptRunOutcome, handleEnvelopeException } from "./message-envelope.js";
import { finalizeLockResult } from "./executor-error-mapping.js";
import { createBeforeToolCallGuard } from "./before-tool-call-guard.js";
import type { PiExecutorDeps } from "./pi-executor-types.js";
export type { PiExecutorDeps } from "./pi-executor-types.js";

/** Number of turns to restrict breakpoints after server eviction. */
const EVICTION_COOLDOWN_TURNS = 2;

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a PiExecutor that wraps pi-coding-agent's AgentSession behind
 * the AgentExecutor interface.
 *
 * @param config - Per-agent configuration including session/compaction settings
 * @param deps - All required dependencies (injected for testability)
 */
export function createPiExecutor(
  config: PerAgentConfig,
  deps: PiExecutorDeps,
): AgentExecutor {
  // Phase 39 PORTS-11: initialize module-level clock provider for session-state Maps.
  // The Maps in executor-session-state.ts cannot accept per-call clock since they're
  // module-level shared state — set once at executor construction time.
  setSessionStateClock(deps.clock);

  // Compaction-flush event handler installation (state-first per EXEC-SPLIT-06).
  installCompactionTrigger({}, deps);

  // Mutable refs for per-execution overrides. The factory IS allowed closure
  // capture (it's the composition root); the closure-extracted helpers below
  // read these via `MutableRef<T>` accessor pairs, never via direct capture.
  // Set at execution start, cleared in postExecution finally. Read by wrapper
  // chain getter closures.
  let executionCacheRetention: CacheRetention | undefined;
  // Adaptive retention strategy for Anthropic cold-start optimization.
  // Starts "short" (5m), escalates to "long" (1h) after cache reads confirm utilization.
  let adaptiveRetention: AdaptiveCacheRetention | undefined;
  // Mutable ref for per-execution minTokens override.
  // Sub-agents use a lower threshold (512) since their short sessions still benefit from caching.
  let executionMinTokensOverride: number | undefined;

  const cacheRetentionRef: MutableRef<CacheRetention | undefined> = {
    get: () => executionCacheRetention,
    set: (value) => { executionCacheRetention = value; },
  };
  const adaptiveRetentionRef: MutableRef<AdaptiveCacheRetention | undefined> = {
    get: () => adaptiveRetention,
    set: (value) => { adaptiveRetention = value; },
  };
  const minTokensOverrideRef: MutableRef<number | undefined> = {
    get: () => executionMinTokensOverride,
    set: (value) => { executionMinTokensOverride = value; },
  };

  return {
    async execute(
      msg: NormalizedMessage,
      sessionKey: SessionKey,
      tools?: AgentTool[],
      onDelta?: (delta: string) => void,
      agentId?: string,
      _directives?: CommandDirectives,
      _prevTimestamp?: number,
      overrides?: ExecutionOverrides,
    ): Promise<ExecutionResult> {
      // 1. Bootstrap: OAuth pre-resolve + ExecutionResult init + SEP plan ref
      //    (closure-extracted per EXEC-SPLIT-06)
      const { executionStartMs, result, sepEnabled, executionPlanRef } = await bootstrapSession(
        {},
        deps,
        { config, sessionKey, overrides },
      );

      // 2. Pre-lock safety gates: input validation, provider health, circuit
      //    breaker, fault injector (closure-extracted per EXEC-SPLIT-06)
      const safetyOutcome = runSafetyGates(
        { result },
        deps,
        { msg, sessionKey, agentId, provider: config.provider },
      );
      if (!safetyOutcome.passed) return result;
      const safetyReinforcement = safetyOutcome.safetyReinforcement;

      // 3. Decode per-execute overrides into the factory's mutable refs
      //    (closure-extracted per EXEC-SPLIT-06)
      const executionOverrides = overrides;
      const { effectiveTimeout } = decodeExecutionOverrides(
        {},
        deps,
        {
          config,
          sessionKey,
          overrides: executionOverrides,
          operationDefaults: OPERATION_TIMEOUT_DEFAULTS as unknown as Record<string, number | undefined>,
          cacheRetentionRef,
          adaptiveRetentionRef,
          minTokensOverrideRef,
        },
      );
      const activeStepCounter = executionOverrides?.stepCounter ?? deps.stepCounter;
      activeStepCounter.reset();
      deps.budgetGuard.resetExecution();

      // 4. Resolve model using ModelRegistry
      //    Apply per-node model override from ExecutionOverrides and normalize shortcuts before registry lookup
      const normalizedPrimary = normalizeModelId(config.provider, config.model);
      let resolvedModel = deps.modelRegistry.find(config.provider, normalizedPrimary.modelId);
      if (!resolvedModel && deps.providerAliases) {
        const builtInName = deps.providerAliases.get(config.provider);
        if (builtInName) {
          resolvedModel = deps.modelRegistry.find(builtInName, normalizedPrimary.modelId);
        }
      }
      if (normalizedPrimary.normalized) {
        deps.logger.debug(
          { original: config.model, resolved: normalizedPrimary.modelId },
          "Model ID normalized via shortcut",
        );
      }
      if (!resolvedModel
        && config.provider.toLowerCase() !== "default"
        && config.model.toLowerCase() !== "default") {
        deps.logger.warn(
          {
            agentId,
            configuredProvider: config.provider,
            configuredModel: normalizedPrimary.modelId,
            hint: "Provider not registered in pi ModelRegistry. Check providers.entries.<name> in config.yaml has type/baseUrl/apiKeyName set, the API key resolves via SecretManager, and the provider is enabled. Without a match, pi-coding-agent silently falls back to whatever built-in provider has env-var credentials.",
            errorKind: "config" as ErrorKind,
          },
          "Configured provider/model not found in registry; pi-coding-agent will fall back",
        );
      }
      if (executionOverrides?.model) {
        const parts = executionOverrides.model.split(":");
        const overrideProvider = parts[0];
        const overrideModelId = parts.slice(1).join(":");
        if (overrideProvider && overrideModelId) {
          const normalizedOverride = normalizeModelId(overrideProvider, overrideModelId);
          const overrideResolved = deps.modelRegistry.find(overrideProvider, normalizedOverride.modelId);
          if (normalizedOverride.normalized) {
            deps.logger.debug(
              { original: overrideModelId, resolved: normalizedOverride.modelId },
              "Override model ID normalized via shortcut",
            );
          }
          if (overrideResolved) {
            resolvedModel = overrideResolved;
            deps.logger.info(
              { defaultModel: config.model, overrideModel: executionOverrides.model },
              "Model override applied from execution overrides",
            );
          } else {
            deps.logger.warn(
              {
                overrideModel: executionOverrides.model,
                provider: overrideProvider,
                modelId: overrideModelId,
                hint: "Model override not found in registry; falling back to agent default model",
                errorKind: "config" as ErrorKind,
              },
              "Model override resolution failed",
            );
          }
        }
      }

      // Store resolved model on ALS context for sub-agent parent inheritance
      const alsCtx = tryGetContext();
      if (alsCtx && resolvedModel) {
        (alsCtx as Record<string, unknown>).resolvedModel = `${resolvedModel.provider}:${resolvedModel.id}`;
      }

      // Derive compat config via normalizeModelCompat (xAI auto-detection).
      const modelCompat = resolvedModel ? normalizeModelCompat({
        provider: resolvedModel.provider,
        id: resolvedModel.id,
      }) : undefined;

      // 5. Execute within session adapter (use ephemeral adapter if provided)
      const sessionAdapter = overrides?.ephemeralSessionAdapter ?? deps.sessionAdapter;
      const lockResult = await sessionAdapter.withSession(
        sessionKey,
        (sm) => runSessionLocked(sm, {
          config,
          deps,
          result,
          msg,
          sessionKey,
          tools,
          onDelta,
          agentId,
          _directives,
          _prevTimestamp,
          executionOverrides,
          executionStartMs,
          effectiveTimeout,
          sepEnabled,
          executionPlanRef,
          safetyReinforcement,
          resolvedModel,
          modelCompat,
          activeStepCounter,
          sessionAdapter,
          cacheRetentionRef,
          adaptiveRetentionRef,
          minTokensOverrideRef,
        }),
      );

      // 6. Post-lock outcome: destroy session if session_reset; map lock failure
      //    (closure-extracted per EXEC-SPLIT-06)
      return finalizeLockResult(
        { result },
        deps,
        { lockResult, sessionAdapter, sessionKey },
      );
    },
  };
}

// ---------------------------------------------------------------------------
// Inside-lock session callback (§13.3 fallback — kept as a top-level helper
// rather than further closure-extracted because the body's hundreds of
// inter-references between session manager, bridge, stream wrappers, context
// engine, tool pipeline, and runPrompt invocation make a clean state-by-
// parameter decomposition impractical without sub-decomposing the bridge
// construction and stream-wrapper wiring separately; see SUMMARY.md for the
// deferred-allowlist rationale).
// ---------------------------------------------------------------------------

interface RunSessionLockedContext {
  readonly config: PerAgentConfig;
  readonly deps: PiExecutorDeps;
  readonly result: ExecutionResult;
  readonly msg: NormalizedMessage;
  readonly sessionKey: SessionKey;
  readonly tools: AgentTool[] | undefined;
  readonly onDelta: ((delta: string) => void) | undefined;
  readonly agentId: string | undefined;
  readonly _directives: CommandDirectives | undefined;
  readonly _prevTimestamp: number | undefined;
  readonly executionOverrides: ExecutionOverrides | undefined;
  readonly executionStartMs: number;
  readonly effectiveTimeout: { promptTimeoutMs: number; retryPromptTimeoutMs: number };
  readonly sepEnabled: boolean;
  readonly executionPlanRef: { current: import("../../planner/types.js").ExecutionPlan | undefined };
  readonly safetyReinforcement: string | undefined;
  readonly resolvedModel: ReturnType<ModelRegistry["find"]> | undefined;
  readonly modelCompat: ReturnType<typeof normalizeModelCompat> | undefined;
  readonly activeStepCounter: StepCounter;
  readonly sessionAdapter: ComisSessionManager;
  readonly cacheRetentionRef: MutableRef<CacheRetention | undefined>;
  readonly adaptiveRetentionRef: MutableRef<AdaptiveCacheRetention | undefined>;
  readonly minTokensOverrideRef: MutableRef<number | undefined>;
}

async function runSessionLocked(
  sm: SdkSessionManager,
  ctx: RunSessionLockedContext,
): Promise<ExecutionResult> {
  const {
    config, deps, result, msg, sessionKey, tools, onDelta, agentId,
    _directives, _prevTimestamp, executionOverrides, executionStartMs,
    effectiveTimeout, sepEnabled, executionPlanRef, safetyReinforcement,
    resolvedModel, modelCompat, activeStepCounter,
    sessionAdapter,
    cacheRetentionRef, adaptiveRetentionRef, minTokensOverrideRef,
  } = ctx;
  // Reset closure for postExecution finally-block (writes back through the
  // factory's MutableRef-backed `let`s so the next execute() starts fresh).
  const executionCacheRetentionClear = () => { cacheRetentionRef.set(undefined); };
  const adaptiveRetentionClear = () => { adaptiveRetentionRef.set(undefined); };
  const executionMinTokensOverrideClear = () => { minTokensOverrideRef.set(undefined); };

  // Repair orphaned messages
  const repairResult = repairOrphanedMessages(sm);
  if (repairResult.repaired) {
    deps.logger.info(
      { reason: repairResult.reason },
      "Repaired orphaned message",
    );
  }

  // One-time scrub for sessions poisoned by an earlier on-disk thinking-signature stripper.
  // Must run before buildSessionContext so the context pipeline sees the clean fileEntries.
  const scrubResult = scrubPoisonedThinkingBlocks(sm);
  if (scrubResult.scrubbed) {
    deps.logger.info(
      { blocksRemoved: scrubResult.blocksRemoved },
      "Scrubbed poisoned thinking blocks",
    );
  }

  // Neutralize tool_use/tool_result pairs whose args were redacted by
  // sanitizeSessionSecrets. Must run before buildSessionContext so the
  // model never sees its own prior env_set tool calls with
  // env_value:"[REDACTED]" (which it would otherwise copy forward into
  // the next env_set call — observed in production).
  const redactScrub = scrubRedactedToolCalls(sm);
  if (redactScrub.scrubbed) {
    deps.logger.info(
      {
        blocksRewritten: redactScrub.blocksRewritten,
        resultsRewritten: redactScrub.resultsRewritten,
      },
      "Scrubbed redacted tool-call pairs from replay context",
    );
  }

  // Detect first message in session for BOOT.md injection
  const sessionContext = sm.buildSessionContext();

  // Diagnostic assertion -- detect role attribution anomalies
  // in continued sessions. Fires WARN log only; repair is handled by
  // repairOrphanedMessages() above.
  validateRoleAttribution(sessionContext.messages, deps.logger);

  const isFirstMessageInSession = sessionContext.messages.length === 0;

  // Get or create session-scoped guide delivery tracking.
  // Clear on session reset (isFirstMessageInSession) so guides re-inject.
  const formattedKeyForGuides = formatSessionKey(sessionKey);
  let deliveredGuides = getDeliveredGuides(formattedKeyForGuides);
  if (!deliveredGuides || isFirstMessageInSession) {
    deliveredGuides = new Set();
    setDeliveredGuides(formattedKeyForGuides, deliveredGuides);
  }

  // Detect onboarding state for post-execution completion check
  const isOnboarding = await detectOnboardingState(deps.workspaceDir);

  // Capture prompt skills XML once at execution start.
  // Skills registered during tool calls (e.g., skill-creator creating stock-scanner)
  // do not mutate the system prompt until the next execution.
  const frozenPromptSkillsXml = deps.getPromptSkillsXml?.();
  const stableGetPromptSkillsXml = frozenPromptSkillsXml !== undefined
    ? () => frozenPromptSkillsXml
    : deps.getPromptSkillsXml;
  // toolCapabilityPort flows through frozenDeps spread — no explicit re-assignment.
  const frozenDeps = { ...deps, getPromptSkillsXml: stableGetPromptSkillsXml };

  // Tool assembly pipeline: merge, settings, prompt, deferral, JIT, pruning, snapshot, normalization, serializer
  // Extracted to executor-tool-assembly.ts
  const toolAssembly = await assembleTools({
    config, deps: frozenDeps, sessionKey, msg, tools, executionOverrides,
    isFirstMessageInSession, sm, formattedKeyForGuides, deliveredGuides,
    resolvedModel, modelCompat, agentId, safetyReinforcement, _directives,
  });
  const {
    mergedCustomTools,
  } = toolAssembly;
  const {
    deferralResult, deferredContext, capabilityIndexResult,
    modelTier, discoveryTracker, settingsManager,
    resourceLoaderOptions, promptResult, cachedSystemTokensEstimate,
  } = toolAssembly;
  const currentDiscoveryTracker: DiscoveryTracker | undefined = toolAssembly.currentDiscoveryTracker;
  const { systemPrompt, systemPromptBlocks, dynamicPreamble, inlineMemory } = promptResult;

  // DAG ingestion hook -- install BEFORE microcompaction
  // so microcompaction is the outer wrapper. Execution order: microcompaction first -> DAG ingest second.
  // DAG ingest receives the post-microcompaction message (with disk offload references).
  const baseContextEngineConfigForHook = config.contextEngine ?? ContextEngineConfigSchema.parse({});
  if (baseContextEngineConfigForHook.version === "dag" && deps.contextStore) {
    const tenantId = deps.tenantId ?? "default";
    const hookFormattedKey = formatSessionKey(sessionKey);
    const existingConv = deps.contextStore.getConversationBySession(tenantId, hookFormattedKey);
    let hookConversationId: string;
    if (existingConv) {
      hookConversationId = existingConv.conversation_id;
    } else {
      hookConversationId = deps.contextStore.createConversation({
        tenantId,
        agentId: agentId ?? config.name,
        sessionKey: hookFormattedKey,
      });
    }
    // Store for later use by context engine
    (sm as unknown as Record<string, string>).__dagConversationId = hookConversationId;
    installDagIngestionHook(
      sm,
      deps.contextStore,
      hookConversationId,
      deps.logger,
      (text: string) => Math.ceil(text.length / CHARS_PER_TOKEN_RATIO),
    );
  }

  const resourceLoader = new DefaultResourceLoader(resourceLoaderOptions);
  await resourceLoader.reload();

  // The SDK's `tools` is an allowlist of tool *names* (not definitions).
  // An empty array is treated as a non-empty allowlist that allows zero
  // tools, including all customTools — which is why the agent ran
  // tool-less from every entry point (chat API, SSE, Telegram, etc.):
  // every Comis tool was filtered out of the SDK's tool registry, the
  // Anthropic API request went out with `tools: []`, and the model
  // emitted `<tool_call>...</tool_call>` markup as plaintext that
  // Comis's loop never parsed back.
  //
  // Pass our customTool names as the explicit allowlist so:
  //   1. All customTools land in the SDK's tool registry (their names
  //      pass `isAllowedTool`).
  //   2. SDK built-ins like `bash` that conflict with Comis's policy
  //      controls are filtered out (Comis uses `exec` instead, with
  //      its own sandbox/audit hooks).
  //   3. Where names overlap (read/edit/write), Comis's customTools
  //      override the SDK built-ins via Map.set() in the registry
  //      build (`agent-session.js:1810-1813` in pi-coding-agent@0.68.0).
  const sessionOptions: CreateAgentSessionOptions = {
    cwd: deps.workspaceDir,
    authStorage: deps.authStorage,
    modelRegistry: deps.modelRegistry,
    model: resolvedModel ?? undefined,
    sessionManager: sm,
    settingsManager,
    resourceLoader,
    tools: mergedCustomTools.map((t) => t.name),
    customTools: mergedCustomTools,
  };
  const { session, modelFallbackMessage } = await createAgentSession(sessionOptions);
  if (modelFallbackMessage) {
    deps.logger.warn(
      { hint: modelFallbackMessage, errorKind: "config" as ErrorKind },
      "SDK model fallback during session creation",
    );
  }

  // Compute formatted key early for trace file paths and active run registry
  const formattedKey = formatSessionKey(sessionKey);

  // Per-execution tool retry breaker (state resets each message)
  const toolRetryBreakerConfig = config.toolRetryBreaker;
  const toolRetryBreaker = toolRetryBreakerConfig?.enabled !== false
    ? createToolRetryBreaker({
        maxConsecutiveFailures: toolRetryBreakerConfig?.maxConsecutiveFailures ?? 3,
        maxToolFailures: toolRetryBreakerConfig?.maxToolFailures ?? 5,
        suggestAlternatives: toolRetryBreakerConfig?.suggestAlternatives ?? true,
      })
    : undefined;

  // Per-execution message send limiter
  // maxSendsPerExecution lives in global MessagesConfigSchema (AppConfig.messages),
  // not PerAgentConfig. Use deps injection or default (3).
  const messageSendLimiter = createMessageSendLimiter({
    maxSendsPerExecution: deps.maxSendsPerExecution ?? 3,
  });

  // Proactive safety -- block tool execution before it starts when
  // safety limits are already reached. Existing reactive checks in
  // pi-event-bridge remain as fallback for limits crossed during execution.
  // NOTE: beforeToolCall replaces the extension runner's hook. Comis does
  // not load pi-mono extensions, so this override is safe.
  // v0.65.0: setBeforeToolCall() removed; beforeToolCall is now a direct property.
  session.agent.beforeToolCall =
    createBeforeToolCallGuard(activeStepCounter, deps.budgetGuard, deps.circuitBreaker, toolRetryBreaker, messageSendLimiter);

  // Mid-turn tool injection -- when discover_tools returns sideEffects.discoveredTools,
  // inject the full ToolDefinitions into the live agentic loop tools array so the LLM can
  // call them in the same turn (not just the next message).
  session.agent.afterToolCall = async (callCtx) => {
    const sideEffects = (callCtx.result as unknown as Record<string, unknown>)?.sideEffects as
      { discoveredTools?: string[] } | undefined;
    if (!sideEffects?.discoveredTools?.length) return undefined;

    const contextTools = callCtx.context.tools;
    if (!contextTools) return undefined;

    // Skip mid-turn injection for providers without explicit cache control.
    // Discovery state is already persisted via markDiscovered() in the tool execution
    // wrapper. Next execution includes these tools via applyToolDeferral() -> isDiscovered().
    if (!resolvedModel || (!isAnthropicFamily(resolvedModel.provider) && !isGoogleFamily(resolvedModel.provider))) {
      deps.logger.debug(
        { discoveredCount: sideEffects.discoveredTools.length, provider: resolvedModel?.provider },
        "Skipped mid-turn injection (provider uses automatic prefix caching)",
      );
      return undefined;
    }

    let injectedCount = 0;
    for (const name of sideEffects.discoveredTools) {
      // Skip if already in the live tools array
      if (contextTools.some((t: { name: string }) => t.name === name)) continue;

      // Look up the full ToolDefinition from deferralResult.deferredEntries
      const entry = deferralResult.deferredEntries.find(e => e.name === name);
      if (!entry) continue;

      // Create AgentTool-compatible wrapper and push into the live array.
      // The agentic loop's currentContext.tools is this same array reference,
      // so pushed tools are immediately findable by agent-loop.js prepareToolCall().
      //
      // IMPORTANT: the execute() closure routes the result through
      // wrapToolResultWithGuide so deferred tools (agents_manage,
      // sessions_spawn, MCP tools, ...) receive their TOOL_GUIDES entry
      // on first successful call. The session-start createJitGuideWrapper
      // only wrapped tools present then; without this, discovered tools
      // silently skipped their guides. Uses the same deliveredGuides Set
      // as the session-start wrapper so the "once per session" contract
      // holds whether the tool arrives initially or via discover_tools.
      const original = entry.original;
      contextTools.push({
        name: original.name,
        label: (original as unknown as Record<string, unknown>).label as string | undefined,
        description: original.description,
        parameters: original.parameters,
        execute: async (toolCallId: string, params: unknown, signal: AbortSignal | undefined, onUpdate: unknown) => {
          const res = await original.execute(
            toolCallId,
            params as Record<string, unknown>,
            signal,
            onUpdate as Parameters<typeof original.execute>[3],
            undefined as unknown as Parameters<typeof original.execute>[4],
          );
          return wrapToolResultWithGuide(original.name, res, deliveredGuides, deps.logger);
        },
      } as unknown as (typeof contextTools)[0]);
      injectedCount++;
    }

    if (injectedCount > 0) {
      deps.logger.info(
        { injectedCount, discoveredTools: sideEffects.discoveredTools, toolName: callCtx.toolCall.name },
        "Mid-turn tool injection -- discovered tools added to live agentic loop",
      );
    }

    return undefined; // No result modification needed
  };

  // Stream wrapper chain composition (extracted to executor-stream-setup.ts)
  // Gemini cache hit tracking for Execution complete log
  let geminiCacheHit = false;
  let geminiCachedTokens = 0;

  const streamSetup = setupStreamWrappers({
    config, deps, sessionKey, formattedKey, sm,
    resolvedModel, modelTier, executionOverrides,
    deferralResult, systemPromptBlocks, agentId,
    getAdaptiveRetention: () => adaptiveRetentionRef.get(),
    getExecutionCacheRetention: () => cacheRetentionRef.get(),
    getExecutionMinTokensOverride: () => minTokensOverrideRef.get(),
    onBreakpointsPlaced: (highestIdx: number) => {
      const trimOffset = streamSetup.contextEngineRef.current?.lastTrimOffset ?? 0;
      const preCeIdx = highestIdx + trimOffset;
      if (streamSetup.contextEngineRef.current) {
        streamSetup.contextEngineRef.current.lastBreakpointIndex = preCeIdx;
      }
      setBreakpointIndex(formattedKey, preCeIdx);
    },
    onGeminiCacheHit: (entry) => {
      geminiCacheHit = true;
      geminiCachedTokens = entry.cachedTokens;
    },
  });
  const {
    contextEngineRef, cacheBreakDetector,
    truncationMetaRegistry, getTruncationSummary, getTurnBudgetSummary,
    ttlSplit,
  } = streamSetup;

  session.agent.streamFn = composeStreamWrappers(
    streamSetup.wrappers,
    session.agent.streamFn,
    deps.logger,
  );

  // Context engine: transformContext hook
  // Runs BEFORE convertToLlm in the SDK pipeline (pre-LLM-call context management).
  // Same runtime override pattern as streamFn above.
  // TypeScript declares transformContext as private, but it's a plain instance property
  // accessible at runtime. Same pattern as streamFn override above.
  const ceSetup = setupContextEngine({
    config, deps: frozenDeps, formattedKey, sessionKey: formattedKey, msg, sm, session,
    resolvedModel, executionOverrides,
    cacheBreakDetector,
    contextEngineRef,
    getCachedSystemTokensEstimate: () => cachedSystemTokensEstimate,
    getTokenAnchor: () => tokenAnchor,
    onAnchorReset: () => { tokenAnchor = null; },
    currentDiscoveryTracker,
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- SDK internal: no public type for agent.transformContext
  (session.agent as any).transformContext = ceSetup.contextEngine.transformContext;

  // Freeze thinking block stripping threshold for this execution.
  // On the first transformContext call, snapshot the pre-execution assistant count
  // as a ceiling so new assistant turns during the agentic loop don't shift the
  // stripping cutoff. Cleared in the finally block.
  if (ceSetup?.contextEngine?.setThinkingCeiling) {
    let ceilingSet = false;
    const originalTransform = ceSetup.contextEngine.transformContext;
    ceSetup.contextEngine.transformContext = async (messages, signal) => {
      if (!ceilingSet) {
        const assistantCount = messages.filter(
          (m: { role: string }) => m.role === "assistant",
        ).length;
        ceSetup.contextEngine!.setThinkingCeiling!(assistantCount);
        ceilingSet = true;
      }
      return originalTransform(messages, signal);
    };
    // Re-assign to session.agent so the SDK calls the wrapped version
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (session.agent as any).transformContext = ceSetup.contextEngine.transformContext;
  }

  // Align register/deregister key shape with
  // BackgroundSessionResolver.formatComposite so production lookups via
  // resolveActiveSession({agentId, channelType, channelId}) find the
  // handle this execute() call registers. session-resolver.test.ts
  // locks the formula — drift on either side breaks that test.
  // NormalizedMessageSchema enforces channelType / channelId are
  // non-empty (z.string().min(1)), so this composition is unconditional.
  const resolverRegisterKey = formatSessionKey({
    tenantId: agentId ?? "default",
    channelId: `${msg.channelType}:${msg.channelId}`,
    userId: msg.channelId,
  });

  // Register active run for mid-execution steering
  if (deps.activeRunRegistry) {
    const handle: RunHandle = {
      steer: (text: string) => session.steer(text),
      followUp: (text: string) => session.followUp(text),
      abort: async () => { session.abortCompaction(); await session.abort(); },
      isStreaming: () => session.isStreaming,
      isCompacting: () => session.isCompacting,
    };
    const registered = deps.activeRunRegistry.register(resolverRegisterKey, handle);
    if (!registered) {
      deps.logger.warn(
        { sessionKey: resolverRegisterKey, hint: "Session already has an active run; concurrent execution may cause issues", errorKind: "resource" as const },
        "Active run already registered",
      );
    }
  }

  // SDK tool management validation and introspection.
  // Comis assembles tools per-request (platform tools, skill tools, policy filtering).
  // After session creation, we use SDK APIs to validate registration and provide
  // debug introspection. setActiveToolsByName() is safe here because
  // systemPromptOverride on DefaultResourceLoader caches the Comis-assembled
  // prompt during reload(), and _rebuildSystemPrompt reads it on every rebuild.
  try {
    const allSdkTools = session.getAllTools?.() ?? [];
    const activeToolNames = session.getActiveToolNames?.() ?? [];
    const mergedToolNames = mergedCustomTools.map(t => t.name);

    deps.logger.debug(
      {
        sdkRegisteredCount: allSdkTools.length,
        activeCount: activeToolNames.length,
        comisCount: mergedToolNames.length,
      },
      "SDK tool registry introspection",
    );

    const allSdkToolNames = allSdkTools.map(t => t.name);
    const ghostTools = allSdkToolNames.filter(n => !mergedToolNames.includes(n));
    const missingTools = mergedToolNames.filter(n => !allSdkToolNames.includes(n));

    if (ghostTools.length > 0 || missingTools.length > 0) {
      deps.logger.debug(
        {
          ghostTools,
          missingTools,
          hint: "ghostTools = in SDK but not Comis (e.g. SDK base bash); missingTools = in Comis but not SDK",
        },
        "SDK/Comis tool set mismatch diagnostic",
      );
    }

    // Validate: call setActiveToolsByName with our tool set.
    // This confirms SDK recognizes all tools and updates agent.tools.
    // systemPromptOverride on DefaultResourceLoader prevents prompt clobbering.
    session.setActiveToolsByName?.(mergedToolNames);

    // Check for SDK-filtered tools (tools Comis registered but SDK rejected)
    const postActiveNames = session.getActiveToolNames?.() ?? [];
    if (postActiveNames.length < mergedToolNames.length) {
      const rejected = mergedToolNames.filter(n => !postActiveNames.includes(n));
      const allRejected = postActiveNames.length === 0 && rejected.length === mergedToolNames.length;
      deps.logger.warn(
        {
          rejected,
          rejectedCount: rejected.length,
          registeredCount: mergedToolNames.length,
          postActiveCount: postActiveNames.length,
          allRejected,
          hint: allRejected
            ? "SDK has 0 active tools after setActiveToolsByName -- not a name collision (empty active list, every Comis tool dropped). Indicates the SDK ResourceLoader / agent.tools handoff is broken; the LLM will receive no structured tool definitions and may emit `<tool_call>` markup as plaintext instead of using tool_use content blocks."
            : "SDK filtered some Comis tools; likely name collisions with SDK built-ins (e.g. SDK reserves `bash`, `read_file`, etc.). Rename or omit the listed tools to avoid the conflict.",
          errorKind: "validation" as ErrorKind,
        },
        allRejected
          ? "SDK rejected ALL tool registrations -- agent will run with no tools"
          : "SDK rejected some tool registrations",
      );
    }
  } catch (toolMgmtError) {
    // Non-fatal: SDK tool management is validation/introspection only.
    // Comis's tool pipeline already registered tools via customTools.
    deps.logger.debug(
      { err: toolMgmtError },
      "SDK tool management call failed (non-fatal)",
    );
  }

  // Populate Comis registry from SDK-discovered skills.
  // After session creation, the ResourceLoader has discovered skills from
  // Comis's configured paths. We populate the registry so that content
  // scanning, audit, and progressive disclosure work on SDK-discovered skills.
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- SDK internal API not typed
    const sdkSkillResult = (sessionOptions.resourceLoader as any)?.getSkills?.();
    const sdkSkills = sdkSkillResult?.skills;
    if (sdkSkills && sdkSkills.length > 0 && deps.skillRegistry) {
      deps.skillRegistry.initFromSdkSkills(sdkSkills);
      deps.logger.debug(
        { sdkSkillCount: sdkSkills.length },
        "Comis registry populated from SDK discovery",
      );
    }
  } catch (sdkSkillError) {
    deps.logger.debug(
      { err: sdkSkillError, hint: "SDK skill population failed, Comis discovery still active", errorKind: "dependency" as ErrorKind },
      "SDK skill population non-fatal error",
    );
  }

  // session.sendCustomMessage() is available for operator annotations.
  // Note: appendCustomEntry() is the SessionManager-level API;
  // the AgentSession wrapper exposes this as sendCustomMessage({ customType, content, display, details }).
  // Future commands or hooks can call this to inject custom entries into the JSONL session.

  // Apply command directives (thinking, compact, model, export, fork, branch)
  const cmdResult = await applyCommandDirectives({
    directives: _directives,
    session: session as unknown as import("../executor-command-handlers.js").CommandSession,
    result, config, deps, sessionKey,
  });

  // Create context guard from per-agent config
  const contextGuardConfig = config.contextGuard;
  const contextGuard = contextGuardConfig?.enabled !== false
    ? createContextWindowGuard({
        warnPercent: contextGuardConfig?.warnPercent,
        blockPercent: contextGuardConfig?.blockPercent,
      })
    : undefined;

  // Quick 215: Resettable prompt timeout -- tool completions reset the timer
  let currentResetTimer: (() => void) | undefined;

  // API-grounded token anchor -- updated on each turn_end, reset on compaction
  let tokenAnchor: TokenAnchor | null = null;

  // Create event bridge
  // Capture for bridge closures (separate scope from wrapper closures above).
  // Read the live ref at bridge-creation time — adaptiveRetention is set
  // synchronously by decodeExecutionOverrides() before this callback runs.
  const capturedBridgeRetention = adaptiveRetentionRef.get();
  const executionId = randomUUID();
  // Budget trajectory warning: shared mutable ref between bridge (writer) and prompt runner (reader)
  const budgetWarningRef = { current: false };
  const bridge = createPiEventBridge({
    eventBus: deps.eventBus,
    budgetGuard: deps.budgetGuard,
    costTracker: deps.costTracker,
    stepCounter: activeStepCounter,
    circuitBreaker: deps.circuitBreaker,
    sessionKey,
    agentId: agentId ?? "default",
    channelId: msg.channelId ?? "",
    executionId,
    provider: config.provider,
    model: config.model,
    operationType: executionOverrides?.operationType ?? "interactive",
    logger: deps.logger,
    onDelta,
    memoryPort: deps.memoryPort,
    onAbort: () => {
      session.abortCompaction();
      suppressError(session.abort(), "session abort on compaction cancel");
    },
    onAbortRetry: () => session.abortRetry(),
    getContextUsage: () => {
      try {
        const usage = session.getContextUsage?.();
        return usage ?? undefined;
      } catch {
        return undefined;
      }
    },
    contextGuard,
    compactionSettings: {
      enabled: true,
      reserveTokens: config.session?.compaction?.reserveTokens ?? 16384,
      keepRecentTokens: config.session?.compaction?.keepRecentTokens ?? 32768,
    },
    providerHealth: deps.providerHealth,
    onToolExecutionEnd: () => { currentResetTimer?.(); },
    getCurrentModel: () => session.model?.id ?? config.model,
    onCacheReads: capturedBridgeRetention
      ? (tokens: number) => { capturedBridgeRetention.recordCacheReads(tokens); }
      : undefined,
    onTurnWithCacheWrite: capturedBridgeRetention
      ? (cacheWriteTokens: number) => { capturedBridgeRetention.recordTurnWithCacheWrite(cacheWriteTokens); }
      : undefined,
    getTruncationMeta: (toolCallId: string) => truncationMetaRegistry.get(toolCallId),
    executionPlan: sepEnabled ? executionPlanRef : undefined,
    sepConfig: sepEnabled ? { maxSteps: config.sep?.maxSteps ?? 15, minSteps: config.sep?.minSteps ?? 3 } : undefined,
    sepMessageText: sepEnabled ? (msg.text ?? "") : undefined,
    sepExecutionStartMs: sepEnabled ? executionStartMs : undefined,
    checkCacheBreak: (input) => cacheBreakDetector.checkResponseForCacheBreak({
      ...input,
      lastResponseElapsedMs: getElapsedSinceLastResponse(formattedKey, deps.clock),
      messageBlockCount: session.agent.state.messages?.length ?? 0,
    }),
    onTurnUsage: (inputTokens: number) => {
      const messages = session.agent.state.messages;
      const messageCount = messages ? messages.length - 1 : 0;
      tokenAnchor = {
        inputTokens,
        messageCount: Math.max(0, messageCount),
        timestamp: deps.clock.now(),
      };
    },
    getSessionMessages: () => {
      const live = session.agent.state.messages;
      if (!Array.isArray(live)) return live;
      try {
        const stores = bridge.getThinkingBlockStores();
        if (stores.hashes.size > 0) {
          for (const sessMsg of live) {
            if (!sessMsg || typeof sessMsg !== "object") continue;
            const sm2 = sessMsg as { role?: string; responseId?: string; content?: unknown };
            if (sm2.role !== "assistant") continue;
            if (typeof sm2.responseId !== "string") continue;
            const prior = stores.hashes.get(sm2.responseId);
            if (!prior) continue;
            const currentContent = Array.isArray(sm2.content)
              ? (sm2.content as Array<Record<string, unknown>>)
              : [];
            assertThinkingBlocksUnchanged(prior, currentContent, sm2.responseId, {
              logger: deps.logger,
            });
          }
        }
        if (stores.canonical.size > 0) {
          const restored = restoreCanonicalThinkingBlocks(
            live,
            stores.canonical,
            { logger: deps.logger },
          );
          if (restored.restoredCount > 0) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- SDK interop boundary; healed array preserves AgentMessage shape
            session.agent.state.messages = restored.messages as any;
            return restored.messages;
          }
        }
      } catch {
        // Pre-call hook must NEVER abort agent flow.
      }
      return live;
    },
    getSessionJsonlPath: () => sessionAdapter.getSessionPath(sessionKey),
    perExecutionBudgetCap: config.budgets?.perExecution,
    budgetWarningRef,
    toolRetryBreaker,
    ttlSplit,
    graphId: executionOverrides?.graphId,
    nodeId: executionOverrides?.nodeId,
    onCacheBreakDetected: capturedBridgeRetention
      ? (event) => {
          if (event.reason === "lookback_window_exceeded") {
            deps.logger.warn(
              {
                sessionKey: formattedKey,
                reason: event.reason,
                tokenDrop: event.tokenDrop,
                conversationBlockCount: event.conversationBlockCount,
                hint: "Long conversation exceeded lookback window. Multi-zone breakpoints mitigate this. No action needed.",
                errorKind: "internal" as const,
              },
              "Cache miss from lookback window exceeded (not server eviction)",
            );
            return;
          }
          if (event.reason === "likely_server_eviction" || event.reason === "server_eviction") {
            capturedBridgeRetention.reset();
            clearSessionCacheWarm(formattedKey);
            setEvictionCooldown(formattedKey, EVICTION_COOLDOWN_TURNS);
            clearSessionBlockStability(formattedKey);
            clearSessionCacheSavings(formattedKey);
            deps.logger.info(
              { sessionKey: formattedKey, reason: event.reason, tokenDrop: event.tokenDrop, cooldownTurns: EVICTION_COOLDOWN_TURNS },
              "Server eviction detected, coordinated reset activated",
            );
          }
        }
      : undefined,
    decrementEvictionCooldown: () => {
      decrementEvictionCooldownForSession(formattedKey);
    },
    onTurnCacheSavings: capturedBridgeRetention
      ? (savedUsd: number) => {
          recordCacheSavings(formattedKey, savedUsd);
          const state = getCacheSavings(formattedKey);
          if (state && state.turnCount >= 3) {
            const isNetPositive = state.cumulativeSavingsUsd > 0;
            capturedBridgeRetention.setCostGateOpen(isNetPositive);
            if (!isNetPositive) {
              deps.logger.debug(
                { sessionKey: formattedKey, cumulativeSavingsUsd: state.cumulativeSavingsUsd, turnCount: state.turnCount },
                "Negative savings, requiring extra evidence turns for escalation",
              );
            }
          }
        }
      : undefined,
  });

  const unsubscribe = session.subscribe(bridge.listener);

  // Execution started bookend (Finding 1)
  deps.logger.info(
    {
      agentId,
      sessionKey: formattedKey,
      modelId: resolvedModel?.id,
      modelTier,
      activeToolCount: mergedCustomTools.length,
    },
    "Execution started",
  );

  // Generic sideEffects processing for tool results.
  // IN-PLACE mutation: The SDK's agentic loop reads tool.execute at CALL TIME from
  // the original objects passed to createAgentSession(). A .map() spread creates new
  // objects the SDK never sees. Mutating tool.execute in-place IS picked up.
  for (const tool of mergedCustomTools) {
    const origExecute = tool.execute;
    tool.execute = async function (
      toolCallId: string,
      params: Record<string, unknown>,
      signal: AbortSignal | undefined,
      onUpdate: Parameters<typeof origExecute>[3],
      cbCtx: Parameters<typeof origExecute>[4],
    ) {
      // Inject parent discovery state into sessions_spawn params
      // so sub-agent-runner can persist it in session metadata.
      if (tool.name === "sessions_spawn" && discoveryTracker.getDiscoveredNames().size > 0) {
        const paramsObj = typeof params === "object" && params !== null ? params as Record<string, unknown> : {};
        paramsObj.discoveredDeferredTools = discoveryTracker.serialize();
        params = paramsObj;
      }

      const toolResult = await origExecute(toolCallId, params, signal, onUpdate, cbCtx);

      // Process sideEffects from any tool result
      const sideEffects = (toolResult as unknown as Record<string, unknown>)?.sideEffects as
        { discoveredTools?: string[] } | undefined;
      if (sideEffects?.discoveredTools?.length) {
        discoveryTracker.markDiscovered(sideEffects.discoveredTools);
        deps.logger.debug(
          { discoveredTools: sideEffects.discoveredTools, toolName: tool.name },
          "Deferred tools discovered via side-effect",
        );
      }

      return toolResult;
    };
  }

  // Auto-background middleware -- promotes long-running tool executions to background.
  // IN-PLACE mutation: same rationale as sideEffects above -- .map() spread was dead code.
  // Applied AFTER sideEffects so the background placeholder is returned instead of
  // waiting for sideEffects processing. When the tool completes in background,
  // the sideEffects are still processed by the original wrapped execute.
  // Capture origin at wrap-time via explicit threading.
  // The closure reads runPrompt-scope variables synchronously each invocation
  // so the captured origin reflects the originating session, not the
  // background-continuation context (which lacks these locals).
  if (deps.backgroundTaskManager && config.backgroundTasks?.enabled !== false) {
    const bgConfig = BackgroundTasksConfigSchema.parse(config.backgroundTasks ?? {});
    const resolvedAgentId = agentId ?? "default";
    const originResolver = (): BackgroundTaskOrigin | undefined => {
      // Defensive: if any required field is unexpectedly missing, fall through
      // to foreground execution (no background promotion). Promotion requires
      // a complete origin.
      if (!formattedKey || formattedKey.length === 0) return undefined;
      if (!msg.channelType || msg.channelType.length === 0) return undefined;
      if (!msg.channelId || msg.channelId.length === 0) return undefined;
      // Read incoming hop count off msg.metadata so the runner can enforce
      // the recursion bound. Top-level user messages have no
      // metadata.backgroundHopCount -> default to 0.
      const meta = msg.metadata as Record<string, unknown> | undefined;
      const rawHopCount = meta?.backgroundHopCount;
      const incomingHopCount = typeof rawHopCount === "number" && Number.isFinite(rawHopCount) && rawHopCount >= 0
        ? Math.floor(rawHopCount)
        : 0;
      return {
        agentId: resolvedAgentId,
        sessionKey: formattedKey,
        channelType: msg.channelType,
        channelId: msg.channelId,
        traceId: executionId ?? null,
        backgroundHopCount: incomingHopCount,
      };
    };
    for (const tool of mergedCustomTools) {
      const wrapped = wrapToolForAutoBackground(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- SDK interop boundary
        tool as any,
        deps.backgroundTaskManager!,
        bgConfig,
        originResolver,
      );
      tool.execute = (wrapped as unknown as typeof tool).execute;
    }
  }

  // Prompt execution: envelope, preamble, images, budget, retry, escalation, recovery
  // Extracted to prompt-runner/.
  try {
    const promptRunResult = await runPrompt({
      msg, session, config, sessionKey, formattedKey, agentId, result,
      executionOverrides, executionStartMs, effectiveTimeout, executionId,
      bridge, dynamicPreamble, deferredContext, capabilityIndexResult, inlineMemory,
      systemPrompt,
      mergedCustomTools,
      cmdResult, sepEnabled, executionPlanRef,
      _directives, _prevTimestamp, resolvedModel,
      deps: {
        eventBus: deps.eventBus,
        logger: deps.logger,
        budgetGuard: deps.budgetGuard,
        costTracker: deps.costTracker,
        authRotation: deps.authRotation,
        fallbackModels: deps.fallbackModels,
        modelRegistry: deps.modelRegistry,
        providerHealth: deps.providerHealth,
        lastKnownModel: deps.lastKnownModel,
        envelopeConfig: deps.envelopeConfig,
        outputGuard: deps.outputGuard,
        canaryToken: deps.canaryToken,
        clock: deps.clock,
        timers: deps.timers,
      },
      onResetTimer: (fn) => { currentResetTimer = fn; },
      getLastCacheWriteTokens: () => bridge.getResult().tokensUsed?.cacheWrite ?? 0,
      budgetWarningRef,
    });
    // Aggregate ghost cost from timed-out request into bridge metrics
    if (promptRunResult.ghostCost) {
      bridge.addGhostCost(promptRunResult.ghostCost);
    }

    // Apply stuck-session outcome (closure-extracted per EXEC-SPLIT-06).
    applyPromptRunOutcome(
      { result },
      {
        eventBus: deps.eventBus,
        logger: deps.logger,
        clock: deps.clock,
        outputGuard: deps.outputGuard,
        canaryToken: deps.canaryToken,
      },
      { promptRunResult, agentId, formattedKey },
    );
  } catch (error) {
    // Translate exception into ExecutionResult (closure-extracted per EXEC-SPLIT-06).
    handleEnvelopeException(
      { result },
      {
        eventBus: deps.eventBus,
        logger: deps.logger,
        clock: deps.clock,
        outputGuard: deps.outputGuard,
        canaryToken: deps.canaryToken,
      },
      { error, sessionKey, agentId },
    );
  } finally {
    // Clear thinking ceiling so next execution recalculates from current state.
    // Defense-in-depth: context engine is recreated per execute(), but explicit clear
    // ensures no stale ceiling if engine lifetime changes in the future.
    ceSetup?.contextEngine?.setThinkingCeiling?.(undefined);

    // Post-execution cleanup: stats merge, cache metrics, memory persist, session cleanup
    // Extracted to executor-post-execution.ts
    await postExecution({
      result, session, sm, config, msg, sessionKey, formattedKey, resolverRegisterKey, agentId,
      executionStartMs, executionId, executionOverrides,
      bridge, unsubscribe,
      contextEngineRef, ceSetup, streamSetup,
      getTruncationSummary, getTurnBudgetSummary,
      executionPlanRef, sepEnabled, isOnboarding,
      geminiCacheHit, geminiCachedTokens, modelTier,
      provider: resolvedModel?.provider ?? config.provider,
      providerFamily: resolveProviderCapabilities(resolvedModel?.provider ?? config.provider).providerFamily,
      deferralResult, mergedCustomTools, deliveredGuides,
      deps: {
        eventBus: deps.eventBus,
        logger: deps.logger,
        memoryPort: deps.memoryPort,
        activeRunRegistry: deps.activeRunRegistry,
        embeddingEnqueue: deps.embeddingEnqueue,
        workspaceDir: deps.workspaceDir,
        clock: deps.clock,
      },
      sessionAdapter,
      executionCacheRetentionClear,
      adaptiveRetentionClear,
      executionMinTokensOverrideClear,
    });
  }

  return result;
}
