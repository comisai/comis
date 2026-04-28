// SPDX-License-Identifier: Apache-2.0
/**
 * PiExecutor: Wraps pi-coding-agent's createAgentSession() behind the
 * AgentExecutor interface with all Comis safety controls.
 *
 * This is the replacement for the legacy agent-executor.ts. It delegates
 * session management, compaction, and streaming to AgentSession while
 * maintaining Comis's safety controls, event system, and error handling.
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
 * @module
 */

import {
  createAgentSession,
  DefaultResourceLoader,
} from "@mariozechner/pi-coding-agent";
import type {
  CreateAgentSessionOptions,
  ToolDefinition,
} from "@mariozechner/pi-coding-agent";

import type { AuthStorage, ModelRegistry } from "@mariozechner/pi-coding-agent";
import type { CacheRetention } from "@mariozechner/pi-ai";
import {
  formatSessionKey,
  // safePath moved to executor-command-handlers.ts
  tryGetContext,
  ContextEngineConfigSchema,
  type SessionKey,
  type NormalizedMessage,
  type PerAgentConfig,
  type TypedEventBus,
  type MemoryPort,
  type HookRunner,
  type SecretManager,
  type EnvelopeConfig,
  type OutputGuardPort,
  type InputValidationResult,
  type InputSecurityGuard,
  type InjectionRateLimiter,
  type SenderTrustDisplayConfig,
} from "@comis/core";
import type { ComisLogger, ErrorKind } from "@comis/infra";
import { suppressError } from "@comis/shared";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { CommandDirectives } from "../commands/types.js";
import type { BudgetGuard } from "../budget/budget-guard.js";
import type { CostTracker } from "../budget/cost-tracker.js";
import type { StepCounter } from "../executor/step-counter.js";
import type { CircuitBreaker } from "../safety/circuit-breaker.js";
import { createToolRetryBreaker } from "../safety/tool-retry-breaker.js";
import type { ToolRetryBreaker } from "../safety/tool-retry-breaker.js";
import { createMessageSendLimiter } from "../safety/message-send-limiter.js";
import type { MessageSendLimiter } from "../safety/message-send-limiter.js";
import type { ProviderHealthMonitor } from "../safety/provider-health-monitor.js";
import type { ComisSessionManager } from "../session/comis-session-manager.js";
import type { AuthRotationAdapter } from "../model/auth-rotation-adapter.js";
import type { ActiveRunRegistry, RunHandle } from "./active-run-registry.js";
import { repairOrphanedMessages, scrubPoisonedThinkingBlocks } from "../session/orphaned-message-repair.js";
import { scrubRedactedToolCalls } from "../session/scrub-redacted-tool-calls.js";
import { createPiEventBridge } from "../bridge/pi-event-bridge.js";
import { assertThinkingBlocksUnchanged, restoreCanonicalThinkingBlocks } from "../bridge/thinking-block-hash-invariant.js";
import { createAdaptiveCacheRetention, createStaticRetention } from "./adaptive-cache-retention.js";
import type { AdaptiveCacheRetention } from "./adaptive-cache-retention.js";
// SessionLatch types and createSessionLatch moved to executor-session-state.ts
import { createContextWindowGuard } from "../safety/context-window-guard.js";
import { composeStreamWrappers } from "./stream-wrappers/index.js";
import { setupStreamWrappers } from "./executor-stream-setup.js";
import type { DiscoveryTracker } from "./discovery-tracker.js";
import { resetTrackerTimers } from "./tool-lifecycle.js";
import { applyCommandDirectives } from "./executor-command-handlers.js";
import { setupContextEngine } from "./executor-context-engine-setup.js";
import { runPrompt } from "./executor-prompt-runner.js";
import { tryInjectSilentFailure } from "./fault-injector.js";
import { wrapToolResultWithGuide } from "./jit-guide-injector.js";
import { postExecution } from "./executor-post-execution.js";
import { assembleTools } from "./executor-tool-assembly.js";
import {
  getDeliveredGuides,
  setDeliveredGuides,
  setBreakpointIndex,
  // deleteBreakpointIndex, getBreakpointIndexMapSize moved to executor-post-execution.ts
  setCacheWarm,
  clearSessionCacheWarm,
  clearSessionLatches,
  getCacheBreakDetector,
  setEvictionCooldown,
  decrementEvictionCooldown as decrementEvictionCooldownForSession,
  recordCacheSavings,
  getCacheSavings,
  clearSessionCacheSavings,
} from "./executor-session-state.js";
import { validateInput } from "./executor-input-guard.js";
import {
  scanWithOutputGuard,
  // recoverEmptyFinalResponse, extractExecutionPlan, generateCompletenessNudge moved to executor-prompt-runner.ts
} from "./executor-response-filter.js";
import { normalizeModelCompat } from "../provider/model-compat.js";
import { normalizeModelId } from "../provider/model-id-normalize.js";
import { isAnthropicFamily, isGoogleFamily } from "../provider/capabilities.js";
import type { ExecutionPlan } from "../planner/types.js";
import { detectOnboardingState } from "../workspace/onboarding-detector.js";
import { PromptTimeoutError } from "./prompt-timeout.js";
import { classifyError, classifyPromptTimeout } from "./error-classifier.js";
import { installDagIngestionHook, validateRoleAttribution } from "../context-engine/index.js";
import type { TokenAnchor } from "../context-engine/types.js";
import { CHARS_PER_TOKEN_RATIO } from "../context-engine/constants.js";
import { getElapsedSinceLastResponse } from "./ttl-guard.js";
import { clearSessionBlockStability } from "./block-stability-tracker.js";
import type { GeminiCacheManager } from "./gemini-cache-manager.js";
import type { BackgroundTaskManager, NotifyFn } from "../background/index.js";
import { wrapToolForAutoBackground } from "../background/index.js";
import { BackgroundTasksConfigSchema } from "@comis/core";
import { OPERATION_TIMEOUT_DEFAULTS } from "../model/operation-model-defaults.js";
import type { AgentExecutor, ExecutionResult, ExecutionOverrides } from "./types.js";
import { randomUUID } from "node:crypto";

/** Number of turns to restrict breakpoints after server eviction. */
const EVICTION_COOLDOWN_TURNS = 2;

// ---------------------------------------------------------------------------
// R-12: Proactive tool-call safety guard
// ---------------------------------------------------------------------------

/**
 * Create a beforeToolCall guard that proactively blocks tool execution when
 * safety limits are already reached: step counter exhausted, budget exceeded,
 * or circuit breaker open.
 *
 * Layering: beforeToolCall is PRIMARY (prevents execution).
 * Bridge's reactive checks on tool_execution_end (step counter) and
 * turn_end (budget/circuit breaker) are FALLBACK for limits crossed
 * during execution (e.g., budget consumed by the LLM call that
 * triggered the tool, not the tool itself).
 *
 * Extracted as a named function for independent unit testing.
 */
export function createBeforeToolCallGuard(
  stepCounter: StepCounter,
  budgetGuard: BudgetGuard,
  circuitBreaker: CircuitBreaker,
  toolRetryBreaker?: ToolRetryBreaker,
  messageSendLimiter?: MessageSendLimiter,
) {
  return async (context: unknown, _signal?: AbortSignal) => {
    // Proactive step limit check
    if (stepCounter.shouldHalt()) {
      return { block: true, reason: "Step limit reached -- blocking tool execution" };
    }
    // Proactive budget check (cost 0 = just check remaining budget)
    const budgetCheck = budgetGuard.checkBudget(0);
    if (!budgetCheck.ok) {
      return { block: true, reason: "Token budget exhausted" };
    }
    // Proactive circuit breaker check
    if (circuitBreaker.isOpen()) {
      return { block: true, reason: "Provider circuit breaker open" };
    }

    // Tool retry breaker check -- block tools after repeated failures
    if (toolRetryBreaker && context && typeof context === "object") {
      const ctx = context as { toolCall?: { name?: string }; args?: unknown };
      const toolName = ctx.toolCall?.name;
      const args = ctx.args;
      if (toolName && args && typeof args === "object") {
        const verdict = toolRetryBreaker.beforeToolCall(toolName, args as Record<string, unknown>);
        if (verdict.block) {
          return { block: true, reason: verdict.reason ?? "Tool blocked by retry breaker" };
        }
      }
    }

    // Per-execution message send limiter -- prevent spam
    if (messageSendLimiter && context && typeof context === "object") {
      const ctx = context as { toolCall?: { name?: string }; args?: unknown };
      const toolName = ctx.toolCall?.name;
      const args = ctx.args;
      if (toolName && args && typeof args === "object") {
        const verdict = messageSendLimiter.check(toolName, args as Record<string, unknown>);
        if (verdict) return verdict;
      }
    }

    return undefined; // allow execution
  };
}

// ---------------------------------------------------------------------------
// R-13: Session stats delegation helper
// ---------------------------------------------------------------------------

/**
 * Merge SDK session stats into execution result for token totals (R-13).
 *
 * Token counts (input, output, cacheRead, cacheWrite, total) are sourced
 * from the SDK's cumulative session stats -- single source of truth.
 * Cost is intentionally NOT overridden: the bridge's `resolveModelPricing()`
 * provides `cacheSaved` and maintains consistency with per-turn
 * `observability:token_usage` events.
 *
 * Exported for independent unit testing.
 */
export function mergeSessionStats(
  result: { tokensUsed: { input: number; output: number; total: number; cacheRead?: number; cacheWrite?: number } },
  getSessionStats: (() => { tokens?: { input: number; output: number; total: number; cacheRead?: number; cacheWrite?: number } }) | undefined,
): void {
  if (!getSessionStats) return;
  try {
    const stats = getSessionStats();
    if (stats?.tokens) {
      result.tokensUsed = {
        input: stats.tokens.input,
        output: stats.tokens.output,
        total: stats.tokens.total,
        cacheRead: stats.tokens.cacheRead ?? result.tokensUsed.cacheRead,
        cacheWrite: stats.tokens.cacheWrite ?? result.tokensUsed.cacheWrite,
      };
    }
  } catch {
    // Non-fatal: fall back to existing bridge-accumulated values.
    // This can happen if the session was aborted before any LLM calls completed.
  }
}

// ---------------------------------------------------------------------------
// Timeout cost estimation
// ---------------------------------------------------------------------------


// Re-export for backward compatibility with consumers that import from pi-executor.ts
export {
  clearSessionDeliveredGuides,
  clearSessionToolSchemaSnapshot,
  clearSessionToolSchemaSnapshotHash,
  clearSessionBreakpointIndex,
  clearSessionCacheWarm,
  clearSessionLatches,
  clearSessionLatches as _clearSessionLatchesForTest,
  getOrCreateSessionLatches as _getOrCreateSessionLatchesForTest,
} from "./executor-session-state.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Dependencies required by the PiExecutor. */
export interface PiExecutorDeps {
  // Safety controls
  circuitBreaker: CircuitBreaker;
  /** Optional provider health monitor for cross-agent pre-check. */
  providerHealth?: ProviderHealthMonitor;
  budgetGuard: BudgetGuard;
  costTracker: CostTracker;
  stepCounter: StepCounter;
  eventBus: TypedEventBus;
  logger: ComisLogger;
  // Adapters
  authStorage: AuthStorage;
  modelRegistry: ModelRegistry;
  // Session management
  sessionAdapter: ComisSessionManager;
  // Workspace
  workspaceDir: string;
  // Tools
  customTools: ToolDefinition[];
  /** Convert per-request AgentTool[] to ToolDefinition[] for SDK registration.
   * Injected by daemon wiring to avoid agent->skills circular dependency.
   * When provided, per-request `tools` parameter is converted and merged with customTools. */
  convertTools?: (tools: AgentTool[]) => ToolDefinition[];
  /** SDK agent directory for persistent settings file storage. */
  agentDir: string;
  // Optional
  memoryPort?: MemoryPort;
  hookRunner?: HookRunner;
  // System prompt config
  outboundMediaEnabled?: boolean;
  mediaPersistenceEnabled?: boolean;
  autonomousMediaEnabled?: boolean;
  getPromptSkillsXml?: () => string;
  /** Tool names available to sub-agents, injected by daemon from TOOL_PROFILES + config. */
  subAgentToolNames?: string[];
  /** Whether sub-agents inherit MCP tools from parent (subAgentMcpTools: "inherit"). */
  mcpToolsInherited?: boolean;
  // Full prompt assembly
  secretManager?: SecretManager;
  envelopeConfig?: EnvelopeConfig;
  // Model fallback
  /** Fallback models in "provider:modelId" format, e.g. ["anthropic:claude-sonnet-4-20250514"] */
  fallbackModels?: string[];
  /** Optional auth rotation adapter for multi-key providers. */
  authRotation?: AuthRotationAdapter;
  /** Active run registry for mid-execution steering. */
  activeRunRegistry?: ActiveRunRegistry;
  /** Daemon-level tracing defaults for rotation. */
  tracingDefaults?: { maxSize: string; maxFiles: number };
  /** OutputGuard for scanning and redacting critical secrets in LLM responses. */
  outputGuard?: OutputGuardPort;
  /** Canary token for detecting canary leakage in LLM responses. */
  canaryToken?: string;
  /** InputValidator for structural message checks. */
  inputValidator?: (text: string) => InputValidationResult;
  /** InputSecurityGuard for jailbreak detection with scoring. */
  inputGuard?: InputSecurityGuard;
  /** InjectionRateLimiter for progressive cooldown on repeated high-risk detections. */
  rateLimiter?: InjectionRateLimiter;
  /** Optional skill registry for SDK skill discovery integration.
   * Defined as a minimal interface to avoid agent->skills circular dependency.
   * When provided, SDK-discovered skills are filtered through Comis eligibility
   * and the registry is populated from SDK discovery results. */
  skillRegistry?: {
    getEligibleSkillNames(): Set<string>;
    initFromSdkSkills(sdkSkills: Array<{ name: string; description: string; filePath: string; baseDir: string; source: string; disableModelInvocation: boolean }>): void;
  };
  /** Fire-and-forget embedding enqueue callback. Injected by daemon wiring. */
  embeddingEnqueue?: (entryId: string, content: string) => void;
  /** Optional embedding port for semantic search in discover_tools. */
  embeddingPort?: import("@comis/core").EmbeddingPort;
  /** Sender trust display config from AppConfig. */
  senderTrustDisplayConfig?: SenderTrustDisplayConfig;
  /** Documentation config from AppConfig. */
  documentationConfig?: import("@comis/core").DocumentationConfig;
  /** Context store for DAG mode. Optional -- only present when DAG tables exist. */
  contextStore?: import("@comis/memory").ContextStore;
  /** Raw database handle for DAG transactions. */
  db?: unknown;
  /** Tenant ID for conversation creation. */
  tenantId?: string;
  /** Delivery mirror port for session mirroring injection. */
  deliveryMirror?: import("@comis/core").DeliveryMirrorPort;
  /** Delivery mirror config for injection budget limits. */
  deliveryMirrorConfig?: { maxEntriesPerInjection: number; maxCharsPerInjection: number };
  // Provider compatibility config ( -- wired now, consumed in )
  /** When true, only content inside <final> blocks reaches users. Consumer: ThinkingTagFilter. */
  enforceFinalTag?: boolean;
  /** When true, enables fast/cheap model routing. Consumer: stream wrappers. */
  fastMode?: boolean;
  /** When true, OpenAI store: true is injected. Consumer: stream wrappers. */
  storeCompletions?: boolean;
  /** Provider capabilities resolved from config. Consumer: resolveProviderCapabilities(). */
  providerCapabilities?: import("@comis/core").ProviderCapabilities;
  /** Optional Gemini CachedContent lifecycle manager for explicit cache reuse. */
  geminiCacheManager?: GeminiCacheManager;
  /** Resolve platform message character limit for a channel type.
   * Injected by daemon wiring via channelPlugins capabilities. */
  getChannelMaxChars?: (channelType: string) => number | undefined;
  /** Background task manager for auto-promotion of long-running tools. */
  backgroundTaskManager?: BackgroundTaskManager;
  /** Callback to send completion notifications for background tasks. */
  backgroundNotifyFn?: NotifyFn;
  /** Max message.send/reply calls per execution (0 = unlimited, default: 3). */
  maxSendsPerExecution?: number;
}

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
  // Compaction resets lifecycle timers (prevents stale demotion data).
  // Uses resetTrackerTimers which checks Map membership -- never creates phantom entries.
  deps.eventBus.on("compaction:flush", (event) => {
    const key = formatSessionKey(event.sessionKey);
    if (resetTrackerTimers(key)) {
      deps.logger.info(
        { sessionKey: key },
        "Tool lifecycle timers reset after compaction",
      );
    }
    // Notify cache break detector of compaction (resets baseline).
    getCacheBreakDetector(deps.logger).notifyCompaction(key);
    // Reset latches for fresh cache cycle after compaction
    clearSessionLatches(key);
  });

  // Mutable ref for per-execution cache retention override.
  // Set at execution start, cleared in finally. Read by wrapper chain getter closures.
  let executionCacheRetention: CacheRetention | undefined;
  // Adaptive retention strategy for Anthropic cold-start optimization.
  // Starts "short" (5m), escalates to "long" (1h) after cache reads confirm utilization.
  let adaptiveRetention: AdaptiveCacheRetention | undefined;
  // Mutable ref for per-execution minTokens override.
  // Sub-agents use a lower threshold (512) since their short sessions still benefit from caching.
  let executionMinTokensOverride: number | undefined;

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
      // a. Record execution start time
      const executionStartMs = Date.now();

      // b. Initialize result
      const result: ExecutionResult = {
        response: "",
        sessionKey,
        tokensUsed: { input: 0, output: 0, total: 0 },
        cost: { total: 0 },
        stepsExecuted: 0,
        llmCalls: 0,
        finishReason: "stop",
      };

      // SEP: Initialize execution plan ref (shared with bridge via mutable ref)
      const sepEnabled = config.sep?.enabled !== false && !overrides?.skipSep;
      const executionPlanRef: { current: ExecutionPlan | undefined } = { current: undefined };

      // : Structural validation, jailbreak scoring, rate limiting
      // Extracted to executor-input-guard.ts
      const inputGuardResult = validateInput({
        msg,
        sessionKey,
        agentId,
        inputValidator: deps.inputValidator,
        inputGuard: deps.inputGuard,
        rateLimiter: deps.rateLimiter,
        eventBus: deps.eventBus,
        logger: deps.logger,
      });
      if (!inputGuardResult.passed) {
        result.finishReason = (inputGuardResult.earlyFinishReason ?? "error") as ExecutionResult["finishReason"];
        result.response = inputGuardResult.earlyResponse ?? "";
        return result;
      }
      const safetyReinforcement = inputGuardResult.safetyReinforcement;

      // c. Provider-level degradation pre-check (before per-agent circuit breaker)
      if (deps.providerHealth?.isDegraded(config.provider)) {
        result.finishReason = "provider_degraded";
        deps.logger.warn(
          {
            provider: config.provider,
            hint: "Provider is degraded across multiple agents; skipping execution",
            errorKind: "dependency" as ErrorKind,
          },
          "Provider degraded, skipping execution",
        );
        return result;
      }

      // d. Circuit breaker pre-check
      if (deps.circuitBreaker.isOpen()) {
        result.finishReason = "circuit_open";
        deps.logger.warn(
          {
            hint: "Circuit breaker is open, skipping execution",
            errorKind: "dependency" as ErrorKind,
          },
          "Circuit breaker open",
        );
        return result;
      }

      // d'. Test-only silent-LLM-failure fault injection.
      // Gated by COMIS_TEST_SILENT_FAIL_FLAG env var. Lets operators validate
      // the FINDING-2 retry/reuseSessionKey path end-to-end without waiting
      // for real Anthropic instability. Env var is absent in all shipped
      // configs; see packages/agent/src/executor/fault-injector.ts for the
      // safety analysis.
      {
        const injection = tryInjectSilentFailure(deps.logger, {
          agentId,
          sessionKey: formatSessionKey(sessionKey),
        });
        if (injection) {
          result.finishReason = injection.finishReason;
          result.response = injection.response;
          result.llmCalls = injection.llmCalls;
          result.stepsExecuted = injection.stepsExecuted;
          return result;
        }
      }

      // d. Reset per-execution state
      // Capture execution overrides before local SettingsOverrides shadows the name
      const executionOverrides = overrides;
      // Per-execution cache retention override (mutable ref read by wrapper chain getter)
      executionCacheRetention = executionOverrides?.cacheRetention as CacheRetention | undefined;
      // Per-operation timeout merge.
      // 3-tier priority: explicit override > OPERATION_TIMEOUT_DEFAULTS[operationType] > agent-level config.
      const operationDefaultTimeout = executionOverrides?.operationType
        ? OPERATION_TIMEOUT_DEFAULTS[executionOverrides.operationType]
        : undefined;
      const effectiveTimeout = {
        promptTimeoutMs:
          executionOverrides?.promptTimeout?.promptTimeoutMs
          ?? operationDefaultTimeout
          ?? config.promptTimeout.promptTimeoutMs,
        retryPromptTimeoutMs:
          executionOverrides?.promptTimeout?.retryPromptTimeoutMs
          ?? config.promptTimeout.retryPromptTimeoutMs,
      };
      // Create adaptive retention.
      // Parent agents start at configRetention directly (typically "long"/1h) so the
      // initial system prompt write gets 1h TTL -- surviving gaps >5m (e.g. graph execution).
      // Sub-agents start at "short" (5m) since they complete in <60s and share prefix via stagger.
      // Session-scoped warm state is still useful for escalation tracking (onEscalated callback).
      const configRetention = executionCacheRetention ?? config.cacheRetention;
      if (configRetention && configRetention !== "none") {
        const formattedKeyForRetention = formatSessionKey(sessionKey);
        const isSubAgent = !!executionOverrides?.spawnPacket;
        // + Design 2.2: Sub-agents use static retention. Graph subagents
        // (cacheRetention: "long" from setup-cross-session) get static "long" --
        // they never escalate but get 1h TTL. Non-graph subagents get static "short".
        // Design 2.4: Parent agents use turn-based escalation (3+ turns required).
        const configRetentionForSubagent = (executionOverrides?.cacheRetention ?? "short") as CacheRetention;
        adaptiveRetention = isSubAgent
          ? createStaticRetention(configRetentionForSubagent)
          : createAdaptiveCacheRetention({
              coldStartRetention: configRetention,
              warmRetention: configRetention,
              escalationThreshold: 1000,
              onEscalated: () => setCacheWarm(formattedKeyForRetention, true),
            });
      } else {
        adaptiveRetention = undefined;
      }
      // Lower threshold for parent agents (1024) to enable message breakpoints.
      // Parent conversations have 500-2000 token messages -- 4096 default is too high.
      // Sub-agents: 512 (short sessions, system prompt dominates).
      executionMinTokensOverride = executionOverrides?.spawnPacket ? 512 : 1024;
      const activeStepCounter = executionOverrides?.stepCounter ?? deps.stepCounter;
      activeStepCounter.reset();
      deps.budgetGuard.resetExecution();

      // e. Resolve model using ModelRegistry
      // Apply per-node model override from ExecutionOverrides and normalize shortcuts before registry lookup
      const normalizedPrimary = normalizeModelId(config.provider, config.model);
      let resolvedModel = deps.modelRegistry.find(config.provider, normalizedPrimary.modelId);
      if (normalizedPrimary.normalized) {
        deps.logger.debug(
          { original: config.model, resolved: normalizedPrimary.modelId },
          "Model ID normalized via shortcut",
        );
      }
      // Surface the silent-fallback case where pi-coding-agent picks a different
      // provider than the user configured. When find() returns undefined for an
      // explicit (non-default) provider/model, pi will silently shop `findInitialModel`
      // and pick whatever built-in has env-var auth -- e.g., GEMINI_API_KEY → google.
      // The wiring fix in setup-agents.ts should cover the YAML-provider case; this
      // log catches stragglers (typos, disabled providers, missing API keys).
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
        // Model override format: "provider:modelId" (same as compactionModel pattern)
        const parts = executionOverrides.model.split(":");
        const overrideProvider = parts[0];
        const overrideModelId = parts.slice(1).join(":"); // Handle model IDs with colons
        if (overrideProvider && overrideModelId) {
          // Normalize override model ID before registry lookup
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
      // Model<Api> from pi-ai has no comisCompat field -- normalizeModelCompat() provides it.
      const modelCompat = resolvedModel ? normalizeModelCompat({
        provider: resolvedModel.provider,
        id: resolvedModel.id,
      }) : undefined;

      // f. Execute within session adapter (R-11: use ephemeral adapter if provided)
      const sessionAdapter = overrides?.ephemeralSessionAdapter ?? deps.sessionAdapter;
      const lockResult = await sessionAdapter.withSession(
        sessionKey,
        async (sm) => {
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
            deferralResult, deferredContext,
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

          // R-12: Proactive safety -- block tool execution before it starts
          // when safety limits are already reached. Existing reactive checks in
          // pi-event-bridge remain as fallback for limits crossed during execution.
          // NOTE: beforeToolCall replaces the extension runner's hook. Comis does
          // not load pi-mono extensions, so this override is safe.
          // v0.65.0: setBeforeToolCall() removed; beforeToolCall is now a direct property.
          session.agent.beforeToolCall =
            createBeforeToolCallGuard(activeStepCounter, deps.budgetGuard, deps.circuitBreaker, toolRetryBreaker, messageSendLimiter);

          // Mid-turn tool injection -- when discover_tools returns sideEffects.discoveredTools,
          // inject the full ToolDefinitions into the live agentic loop tools array so the LLM can
          // call them in the same turn (not just the next message).
          session.agent.afterToolCall = async (ctx) => {
            const sideEffects = (ctx.result as unknown as Record<string, unknown>)?.sideEffects as
              { discoveredTools?: string[] } | undefined;
            if (!sideEffects?.discoveredTools?.length) return undefined;

            const contextTools = ctx.context.tools;
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
                { injectedCount, discoveredTools: sideEffects.discoveredTools, toolName: ctx.toolCall.name },
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
            getAdaptiveRetention: () => adaptiveRetention,
            getExecutionCacheRetention: () => executionCacheRetention,
            getExecutionMinTokensOverride: () => executionMinTokensOverride,
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

          // 260428-k8d: shared closure for active-tool-name snapshot, used by
          // BOTH the bridge (capture at stream close) and the replay-drift
          // detector (compare against snapshots). Bound here so a single
          // execute() turn always sees a consistent view of the live SDK
          // active-tools list, even mid-conversation `discover_tools`.
          const getActiveToolNamesForDrift = (): ReadonlySet<string> =>
            new Set<string>(session.getActiveToolNames?.() ?? []);

          // 260428-k8d: lazy ref so the context engine's drift detector can
          // reach into the bridge's signedThinkingToolSnapshot store. The
          // bridge is created AFTER setupContextEngine in this file, so the
          // ref's `current` field is populated post-creation and read on
          // demand by the memoized computeDriftIfNeeded() closure. The ref
          // object itself is never reassigned (only its `current` field).
          const bridgeRef: { current?: { getThinkingBlockStores: () => { toolSnapshot: ReadonlyMap<string, ReadonlySet<string>> } } } = { current: undefined };

          // Context engine: transformContext hook
          // Runs BEFORE convertToLlm in the SDK pipeline (pre-LLM-call context management).
          // Same runtime override pattern as streamFn above.
          // TypeScript declares transformContext as private, but it's a plain instance property
          // accessible at runtime. Same pattern as streamFn override above (line ~651).
          const ceSetup = setupContextEngine({
            config, deps: frozenDeps, formattedKey, sessionKey: formattedKey, msg, sm, session,
            resolvedModel, executionOverrides,
            cacheBreakDetector,
            contextEngineRef,
            getCachedSystemTokensEstimate: () => cachedSystemTokensEstimate,
            getTokenAnchor: () => tokenAnchor,
            onAnchorReset: () => { tokenAnchor = null; },
            currentDiscoveryTracker,
            // 260428-k8d: tool-set drift wiring. Both getters are no-ops when
            // bridgeRef.current is unset (e.g., during the brief window before
            // bridge creation completes), so the detector defaults to no_drift
            // — matches the "snapshots empty" branch of the pure helper.
            getActiveToolNames: getActiveToolNamesForDrift,
            getToolSnapshotStore: () =>
              bridgeRef.current?.getThinkingBlockStores().toolSnapshot ?? new Map(),
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

          // Register active run for mid-execution steering
          if (deps.activeRunRegistry) {
            const handle: RunHandle = {
              steer: (text: string) => session.steer(text),
              followUp: (text: string) => session.followUp(text),
              abort: async () => { session.abortCompaction(); await session.abort(); },
              isStreaming: () => session.isStreaming,
              isCompacting: () => session.isCompacting,
            };
            const registered = deps.activeRunRegistry.register(formattedKey, handle);
            if (!registered) {
              deps.logger.warn(
                { sessionKey: formattedKey, hint: "Session already has an active run; concurrent execution may cause issues", errorKind: "resource" as const },
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
          // REQUIREMENTS.md refers to appendCustomEntry() which is the SessionManager-level API;
          // the AgentSession wrapper exposes this as sendCustomMessage({ customType, content, display, details }).
          // Future commands or hooks can call this to inject custom entries into the JSONL session.

          // Apply command directives (thinking, compact, model, export, fork, branch)
          const cmdResult = await applyCommandDirectives({
            directives: _directives,
            session: session as unknown as import("./executor-command-handlers.js").CommandSession,
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
          const capturedBridgeRetention = adaptiveRetention;
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
            operationType: executionOverrides?.operationType ?? "interactive", // all callers supply operationType; fallback guards the optional `overrides` param
            logger: deps.logger,
            onDelta,
            memoryPort: deps.memoryPort,
            onAbort: () => {
              // Abort compaction first to prevent compaction results from being
              // saved -- the session file retains its pre-compaction state.
              session.abortCompaction();
              suppressError(session.abort(), "session abort on compaction cancel");
            },
            getContextUsage: () => {
              // Defensive try-catch: upstream estimateTokens() in pi-coding-agent
              // crashes with "message.content is not iterable" when an assistant
              // message has content: null (OpenAI Responses API, tool-call-only turns).
              // See: https://github.com/badlogic/pi-mono/issues/3120
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
            // Model ID getter for bridge per-turn pricing re-resolution.
            getCurrentModel: () => session.model?.id ?? config.model,
            // Feed cache reads back to adaptive retention for TTL escalation.
            onCacheReads: capturedBridgeRetention
              ? (tokens: number) => { capturedBridgeRetention.recordCacheReads(tokens); }
              : undefined,
            // Wire turn completion with cache write tokens for fast-path escalation.
            onTurnWithCacheWrite: capturedBridgeRetention
              ? (cacheWriteTokens: number) => { capturedBridgeRetention.recordTurnWithCacheWrite(cacheWriteTokens); }
              : undefined,
            // Pass truncation metadata registry to bridge for audit event enrichment.
            getTruncationMeta: (toolCallId: string) => truncationMetaRegistry.get(toolCallId),
            // SEP: Pass execution plan ref to bridge for step tracking
            executionPlan: sepEnabled ? executionPlanRef : undefined,
            // SEP: Mid-loop extraction config, message text, and start time
            sepConfig: sepEnabled ? { maxSteps: config.sep?.maxSteps ?? 15, minSteps: config.sep?.minSteps ?? 3 } : undefined,
            sepMessageText: sepEnabled ? (msg.text ?? "") : undefined,
            sepExecutionStartMs: sepEnabled ? executionStartMs : undefined,
            // Cache break detection Phase 2 callback.
            // Enrich with elapsed time for tiered server-side attribution.
            checkCacheBreak: (input) => cacheBreakDetector.checkResponseForCacheBreak({
              ...input,
              lastResponseElapsedMs: getElapsedSinceLastResponse(formattedKey),
              // W4: Thread message block count for lookback window detection.
              messageBlockCount: session.agent.state.messages?.length ?? 0,
            }),
            // Record per-turn input tokens as TokenAnchor
            onTurnUsage: (inputTokens: number) => {
              // usage.input counts prompt tokens (NOT output). The turn_end fires AFTER
              // the assistant message is appended to session.agent.state.messages, so
              // messageCount = messages.length - 1 (the count AT the API call, before response).
              const messages = session.agent.state.messages;
              const messageCount = messages ? messages.length - 1 : 0;
              tokenAnchor = {
                inputTokens,
                messageCount: Math.max(0, messageCount),
                timestamp: Date.now(),
              };
            },
            // 260428-hoy: pre-LLM-call hook -- runs once per `turn_start`,
            // BEFORE pi-ai serializes the next request. Asserts the
            // cross-turn hash invariant (logs ERROR per mutated block, with
            // module:"agent.bridge.hash-invariant"), then heals any mutated
            // thinking blocks against the canonical stream-close snapshot
            // and writes the healed array back into session.agent.state.messages
            // so persistence and downstream layers see the same shape pi-ai
            // serializes. Order matters: assert FIRST so the diagnostic
            // captures every mutation before the heal overwrites it. Both
            // helpers swallow throws internally; the outer try/catch is a
            // belt-and-braces fallback -- the pre-call hook must NEVER abort
            // agent flow.
            getSessionMessages: () => {
              const live = session.agent.state.messages;
              if (!Array.isArray(live)) return live;
              try {
                const stores = bridge.getThinkingBlockStores();
                if (stores.hashes.size > 0) {
                  for (const sessMsg of live) {
                    if (!sessMsg || typeof sessMsg !== "object") continue;
                    const sm = sessMsg as { role?: string; responseId?: string; content?: unknown };
                    if (sm.role !== "assistant") continue;
                    if (typeof sm.responseId !== "string") continue;
                    const prior = stores.hashes.get(sm.responseId);
                    if (!prior) continue;
                    const currentContent = Array.isArray(sm.content)
                      ? (sm.content as Array<Record<string, unknown>>)
                      : [];
                    assertThinkingBlocksUnchanged(prior, currentContent, sm.responseId, {
                      logger: deps.logger,
                    });
                  }
                }
                if (stores.canonical.size > 0) {
                  const result = restoreCanonicalThinkingBlocks(
                    live,
                    stores.canonical,
                    { logger: deps.logger },
                  );
                  if (result.restoredCount > 0) {
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- SDK interop boundary; healed array preserves AgentMessage shape
                    session.agent.state.messages = result.messages as any;
                    return result.messages;
                  }
                }
              } catch {
                // Pre-call hook must NEVER abort agent flow.
              }
              return live;
            },
            // 260428-iag wire-edge diagnostic: resolves the per-session JSONL
            // path on demand. The bridge invokes this only after detecting the
            // signed-replay rejection signature on a 400 — never on the happy
            // path. Path comes from the same sessionAdapter that already
            // governs read/write of the file, so safePath / sessionKey routing
            // is reused (sessionKeyToPath -> safePath under the hood).
            getSessionJsonlPath: () => sessionAdapter.getSessionPath(sessionKey),
            // 260428-k8d: capture the active tool name set at stream close so
            // the replay-drift detector can compare it against the live set
            // on the next turn. Same closure passed into setupContextEngine
            // above so bridge + detector see a consistent view per turn.
            getActiveToolNames: getActiveToolNamesForDrift,
            // Budget trajectory warning: shared ref and per-execution cap
            perExecutionBudgetCap: config.budgets?.perExecution,
            budgetWarningRef,
            // Tool retry breaker for recording results
            toolRetryBreaker,
            // Shared mutable TTL split estimate for per-TTL cost calculation.
            ttlSplit,
            // Thread graphId/nodeId for cache write signal emission
            graphId: executionOverrides?.graphId,
            nodeId: executionOverrides?.nodeId,
            // Coordinated reset on server-side cache eviction.
            onCacheBreakDetected: capturedBridgeRetention
              ? (event) => {
                  // Skip coordinated reset for lookback window misses.
                  // Lookback misses need MORE breakpoints (which multi-zone already provides),
                  // not the destructive 4-step reset that reduces caching.
                  if (event.reason === "lookback_window_exceeded") {
                    deps.logger.warn(
                      {
                        sessionKey: formattedKey,
                        reason: event.reason,
                        tokenDrop: event.tokenDrop,
                        conversationBlockCount: event.conversationBlockCount,
                        hint: "Long conversation exceeded lookback window. Multi-zone breakpoints mitigate this. No action needed.",
                        errorKind: "performance" as const,
                      },
                      "Cache miss from lookback window exceeded (not server eviction)",
                    );
                    return; // Skip coordinated reset
                  }
                  if (event.reason === "likely_server_eviction" || event.reason === "server_eviction") {
                    // 4-step coordinated reset (matching ttlGuard.onTtlExpiry pattern):
                    capturedBridgeRetention.reset();                          // 1. Reset adaptive retention to cold-start
                    clearSessionCacheWarm(formattedKey);                      // 2. Clear session warm state
                    setEvictionCooldown(formattedKey, EVICTION_COOLDOWN_TURNS); // 3. Activate 2-turn cooldown
                    clearSessionBlockStability(formattedKey);                 // 4. Reset block stability tracker
                    // Also reset cost gate savings (cost profile changes after eviction)
                    clearSessionCacheSavings(formattedKey);
                    deps.logger.info(
                      { sessionKey: formattedKey, reason: event.reason, tokenDrop: event.tokenDrop, cooldownTurns: EVICTION_COOLDOWN_TURNS },
                      "Server eviction detected, coordinated reset activated",
                    );
                  }
                }
              : undefined,
            // Decrement cooldown each turn (unconditional).
            decrementEvictionCooldown: () => {
              decrementEvictionCooldownForSession(formattedKey);
            },
            // Track per-turn cache savings for cost gate evaluation.
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

          // 260428-k8d: populate the lazy bridge ref so the context engine's
          // memoized drift detector (created above) can read the live
          // signedThinkingToolSnapshot store on demand.
          bridgeRef.current = bridge;

          const unsubscribe = session.subscribe(bridge.listener);

          // Execution started bookend (Finding 1, )
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
              ctx: Parameters<typeof origExecute>[4],
            ) {
              // Inject parent discovery state into sessions_spawn params
              // so sub-agent-runner can persist it in session metadata.
              if (tool.name === "sessions_spawn" && discoveryTracker.getDiscoveredNames().size > 0) {
                const paramsObj = typeof params === "object" && params !== null ? params as Record<string, unknown> : {};
                paramsObj.discoveredDeferredTools = discoveryTracker.serialize();
                params = paramsObj;
              }

              const toolResult = await origExecute(toolCallId, params, signal, onUpdate, ctx);

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
          if (deps.backgroundTaskManager && config.backgroundTasks?.enabled !== false) {
            const bgConfig = BackgroundTasksConfigSchema.parse(config.backgroundTasks ?? {});
            for (const tool of mergedCustomTools) {
               
              const wrapped = wrapToolForAutoBackground(
                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- SDK interop boundary
                tool as any,
                deps.backgroundTaskManager!,
                bgConfig,
                deps.backgroundNotifyFn ?? (async () => {}),
                agentId ?? "default",
              );
              tool.execute = (wrapped as unknown as typeof tool).execute;
            }
          }

          // Prompt execution: envelope, preamble, images, budget, retry, escalation, recovery
          // Extracted to executor-prompt-runner.ts
          try {
            const promptRunResult = await runPrompt({
              msg, session, config, sessionKey, formattedKey, agentId, result,
              executionOverrides, executionStartMs, effectiveTimeout, executionId,
              bridge, dynamicPreamble, deferredContext, inlineMemory,
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
                envelopeConfig: deps.envelopeConfig,
                outputGuard: deps.outputGuard,
                canaryToken: deps.canaryToken,
              },
              onResetTimer: (fn) => { currentResetTimer = fn; },
              // Provide last cache write tokens for improved timeout cost estimation
              getLastCacheWriteTokens: () => bridge.getResult().tokensUsed?.cacheWrite ?? 0,
              budgetWarningRef,
            });
            // Aggregate ghost cost from timed-out request into bridge metrics
            if (promptRunResult.ghostCost) {
              bridge.addGhostCost(promptRunResult.ghostCost);
            }

            // Handle stuck session -- flag for post-withSession destroy
            if (promptRunResult.stuckSessionDetected) {
              deps.logger.warn(
                {
                  agentId,
                  sessionKey: formattedKey,
                  hint: "Resetting stuck session -- user must resend their message",
                  errorKind: "internal" as ErrorKind,
                },
                "Destroying stuck session",
              );
              result.finishReason = "session_reset";
              result.response = "Session was in an inconsistent state and has been reset. Please send your message again.";
            }
          } catch (error) {
            deps.logger.warn(
              {
                err: error,
                hint: "PiExecutor unexpected error",
                errorKind: "internal" as ErrorKind,
              },
              "Unexpected execution error",
            );
            result.finishReason = "error";
            // Never expose raw error internals (API keys, URLs, stack traces) to users.
            // The raw error is already logged to deps.logger.warn above for operator diagnostics.
            // Classify the error to give the user an actionable (but safe) message.
            const classifiedOuter = error instanceof PromptTimeoutError
              ? classifyPromptTimeout(error.timeoutMs)
              : classifyError(error);
            result.response = classifiedOuter.userMessage;
            result.errorContext = {
              errorType: error instanceof PromptTimeoutError ? "PromptTimeout" : "UnexpectedError",
              retryable: classifiedOuter.retryable,
              originalError: error instanceof Error ? error.message : String(error),
            };

            // OutputGuard: scan catch-block error responses (unified in executor-response-filter.ts)
            if (deps.outputGuard && result.response) {
              const guardScan = scanWithOutputGuard({
                outputGuard: deps.outputGuard, response: result.response, context: "exception",
                canaryToken: deps.canaryToken, agentId: agentId ?? "unknown",
                tenantId: sessionKey.tenantId, sessionKey, eventBus: deps.eventBus, logger: deps.logger,
              });
              result.response = guardScan.response;
            }
          } finally {
            // Clear thinking ceiling so next execution recalculates from current state.
            // Defense-in-depth: context engine is recreated per execute(), but explicit clear
            // ensures no stale ceiling if engine lifetime changes in the future.
            ceSetup?.contextEngine?.setThinkingCeiling?.(undefined);

            // Post-execution cleanup: stats merge, cache metrics, memory persist, session cleanup
            // Extracted to executor-post-execution.ts
            await postExecution({
              result, session, sm, config, msg, sessionKey, formattedKey, agentId,
              executionStartMs, executionId, executionOverrides,
              bridge, unsubscribe,
              contextEngineRef, ceSetup, streamSetup,
              getTruncationSummary, getTurnBudgetSummary,
              executionPlanRef, sepEnabled, isOnboarding,
              geminiCacheHit, geminiCachedTokens, modelTier,
              deferralResult, mergedCustomTools, deliveredGuides,
              deps: {
                eventBus: deps.eventBus,
                logger: deps.logger,
                memoryPort: deps.memoryPort,
                activeRunRegistry: deps.activeRunRegistry,
                embeddingEnqueue: deps.embeddingEnqueue,
                workspaceDir: deps.workspaceDir,
              },
              sessionAdapter,
              executionCacheRetentionClear: () => { executionCacheRetention = undefined; },
              adaptiveRetentionClear: () => { adaptiveRetention = undefined; },
              executionMinTokensOverrideClear: () => { executionMinTokensOverride = undefined; },
            });
          }

          return result;
        },
      );

      // Destroy session file after withSession releases the lock.
      // This must happen outside withSession to avoid file conflicts under lock.
      if (lockResult.ok && lockResult.value.finishReason === "session_reset") {
        await sessionAdapter.destroySession(sessionKey);
      }

      // Handle lock failure
      if (!lockResult.ok) {
        result.finishReason = "error";
        result.response =
          lockResult.error === "locked"
            ? "Session is currently locked. Please try again."
            : "Session access error.";
        deps.logger.warn(
          {
            error: lockResult.error,
            hint: "Session lock failed",
            errorKind: "resource" as ErrorKind,
          },
          "Session lock error",
        );
        return result;
      }

      return lockResult.value;
    },
  };
}

