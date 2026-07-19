// SPDX-License-Identifier: Apache-2.0
/**
 * PiExecutor: Wraps pi-coding-agent's createAgentSession() behind the
 * AgentExecutor interface with all Comis safety controls.
 *
 * Composed from 9 focused modules under this subdirectory. The
 * closure-extracted helpers (`session-bootstrap.ts`, `compaction-trigger.ts`,
 * `safety-gate.ts`, `message-envelope.ts`, `executor-error-mapping.ts`)
 * take their state via an explicit `state` first parameter rather than
 * capturing it via closure.
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
 * Fallback note: the `withSession` callback body (~900L) was NOT
 * closure-extracted — its hundreds of inter-references between session
 * manager, bridge, stream wrappers, context engine, tool pipeline, and
 * runPrompt invocation would require either a state shape with 50+ fields
 * or further sub-decomposition that breaks the natural orchestrator-edge
 * boundary. The closure-extracted helpers handle the pre/post-lock concerns
 * (bootstrap, safety, compaction setup, message envelope outcome,
 * lock-failure mapping); the inside-lock callback is the thinned factory's
 * own composition root.
 *
 * @module
 */

import * as os from "node:os";

import {
  attachTrajectoryToEventBus,
  createTrajectoryRecorder,
  type TrajectoryRecorder,
  type TrajectoryResumeError,
  type TrajectoryResumeFailureKind,
  attachCacheTraceToEventBus,
  createCacheTrace,
  type CacheTrace,
} from "@comis/observability";
import {
  createAgentSession,
  DefaultResourceLoader,
} from "@earendil-works/pi-coding-agent";
import type {
  CreateAgentSessionOptions,
  SessionManager as SdkSessionManager,
} from "@earendil-works/pi-coding-agent";

import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { CacheRetention } from "@earendil-works/pi-ai";
import {
  formatSessionKey,
  createConversationRef,
  emitObservationalEventSafely,
  safePath,
  toSafeErrorLogString,
  tryGetContext,
  type SessionKey,
  type NormalizedMessage,
  type PerAgentConfig,
} from "@comis/core";
import type { ErrorKind } from "@comis/core";
import { ok, suppressError, type Result } from "@comis/shared";
import type { AgentTool, AgentMessage } from "@earendil-works/pi-agent-core";
import type { CommandDirectives } from "../command-directive-types.js";
import type { StepCounter } from "../step-counter.js";
import { createToolRetryBreaker } from "../../safety/tool-retry-breaker.js";
import { createMessageSendLimiter } from "../../safety/message-send-limiter.js";
import type { ComisSessionManager } from "../../session/comis-session-manager.js";
import type { RunHandle } from "../active-run-registry.js";
import { repairOrphanedMessages, scrubPoisonedThinkingBlocks } from "../../session/orphaned-message-repair.js";
import { scrubRedactedToolCalls } from "../../session/scrub-redacted-tool-calls.js";
import { scrubForgedContextMarkers } from "../../session/forged-context-markers.js";
import {
  appendInboundMessageProvenance,
} from "../../session/inbound-message-provenance.js";
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
import { resolveLocale } from "../resolve-response-locale-policy.js";
import { assembleTools } from "../executor-tool-assembly.js";
import { assembleModelRequest, prepareTurn } from "../turn-preparation.js";
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
  getWindowReconcileLogged,
  setWindowReconcileLogged,
} from "../executor-session-state.js";
import { normalizeModelCompat } from "../../provider/model-compat.js";
import { normalizeModelId } from "../../provider/model-id-normalize.js";
import { resolveModelProfile } from "../model-profile.js";
import { diagnoseUnresolvedModel } from "../model-resolution-hint.js";
import { observedModelId } from "../observed-model-id.js";
import type { ModelProfile } from "../model-profile.js";
import { resolveEffectiveContextWindow } from "../../model/effective-context-window.js";
import { DEFAULT_EFFECTIVE_CAP_BY_CLASS } from "../../context-engine/budget-capacity-cap.js";
import { isAnthropicFamily, isGoogleFamily, resolveProviderCapabilities } from "../../provider/capabilities.js";
import { detectOnboardingState } from "../../workspace/onboarding-detector.js";
import { validateRoleAttribution, sessionTreeHasSameRoleAnomaly } from "../../context-engine/index.js";
import type { TokenAnchor, WindowProvenance } from "../../context-engine/types.js";
import { getElapsedSinceLastResponse } from "../ttl-guard.js";
import { clearSessionBlockStability } from "../block-stability-tracker.js";
import { wrapToolForAutoBackground } from "../../background/index.js";
import { BackgroundTasksConfigSchema } from "@comis/core";
import type { BackgroundTaskOrigin } from "@comis/core";
import { OPERATION_TIMEOUT_DEFAULTS } from "../../model/operation-model-defaults.js";
import type { AgentExecutor, ExecutionResult, ExecutionOverrides } from "../types.js";
import { randomUUID } from "node:crypto";

// Closure-extracted helpers (state-first)
import { installCompactionTrigger } from "./compaction-trigger.js";
import { createDeltaResetComposer } from "./delta-reset.js";
import { createLocaleDeltaDelivery } from "./locale-delta-delivery.js";
import { resolveTrajectoryConfinedBase } from "./trajectory-confinement.js";
import { bootstrapSession, decodeExecutionOverrides, type MutableRef, type EffectiveTimeout } from "./session-bootstrap.js";
import { runSafetyGates } from "./safety-gate.js";
import { maybeRunBootstrapSweep } from "./maybe-run-bootstrap-sweep.js";
import { applyPromptRunOutcome, handleEnvelopeException } from "./message-envelope.js";
import { finalizeLockResult } from "./executor-error-mapping.js";
import { createBeforeToolCallGuard } from "./before-tool-call-guard.js";
import { createTurnLoopDetector } from "../turn-loop-detector.js";
import { buildPromptingSnapshot } from "./pi-executor-prompting.js";
import type { PiExecutorDeps } from "./pi-executor-types.js";
export type { PiExecutorDeps } from "./pi-executor-types.js";
import type { ExecutionBudgetWindow } from "../../budget/budget-guard.js";
import { computeOutputHeadroom } from "../../context-engine/output-headroom.js";

/** Number of turns to restrict breakpoints after server eviction. */
const EVICTION_COOLDOWN_TURNS = 2;

function trajectoryResumeErrorKind(
  failureKind: TrajectoryResumeFailureKind,
): ErrorKind {
  switch (failureKind) {
    case "invalid_jsonl":
      return "validation";
    case "confinement":
    case "symlink":
    case "non_regular":
      return "precondition";
    case "permission":
    case "size_limit":
    case "changed":
    case "io":
      return "resource";
    default: {
      const _exhaustive: never = failureKind;
      return _exhaustive;
    }
  }
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
  // Initialize module-level clock provider for session-state Maps.
  // The Maps in executor-session-state.ts cannot accept per-call clock since
  // they're module-level shared state — set once at executor construction time.
  setSessionStateClock(deps.clock);

  // Compaction-flush event handler installation (state-first).
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
      onDelta?: (delta: string, kind: "text" | "thinking") => void,
      agentId?: string,
      _directives?: CommandDirectives,
      _prevTimestamp?: number,
      overrides?: ExecutionOverrides,
    ): Promise<ExecutionResult> {
      // Resolved request identity is write-once. An executor selected for a
      // different agent/session must not relabel the live ALS object and retain
      // the original principal's trust or delivery origin. Reject before OAuth,
      // model, tool, or session work. An unresolved agentId remains unresolved
      // here; only the inbound boundary may enrich authorization identity.
      const alsCtx = tryGetContext();
      const requestedAgentMismatch = agentId !== undefined && agentId !== deps.agentId;
      const contextAgentMismatch = alsCtx?.agentId !== undefined
        && alsCtx.agentId !== deps.agentId;
      const contextSessionMismatch = alsCtx?.sessionKey !== undefined
        && alsCtx.sessionKey !== formatSessionKey(sessionKey);
      if (requestedAgentMismatch || contextAgentMismatch || contextSessionMismatch) {
        const rejectedAgentId = agentId ?? alsCtx?.agentId ?? deps.agentId;
        deps.logger.warn(
          {
            step: "request-context-identity",
            agentId: rejectedAgentId,
            agentMismatch: contextAgentMismatch,
            sessionMismatch: contextSessionMismatch,
            hint: "Reject the execution and verify the inbound resolver and executor selection use the same agent and session",
            errorKind: "precondition" as ErrorKind,
          },
          "Agent execution rejected due to request context identity mismatch",
        );
        emitObservationalEventSafely({ eventBus: deps.eventBus, logger: deps.logger }, "security:warn", {
          category: "request_context_identity_mismatch",
          agentId: rejectedAgentId,
          message: "Agent execution rejected because request context identity did not match the selected execution identity",
          timestamp: deps.clock.now(),
        });
        return {
          response: "The request could not be executed safely because its identity context was inconsistent.",
          sessionKey,
          tokensUsed: { input: 0, output: 0, total: 0 },
          cost: { total: 0 },
          stepsExecuted: 0,
          llmCalls: 0,
          finishReason: "error",
          errorContext: {
            errorType: "RequestContextIdentityMismatch",
            retryable: false,
            originalError: "Resolved request context identity did not match execution identity",
          },
        };
      }

      agentId = deps.agentId;

      // 1. Bootstrap: OAuth pre-resolve + ExecutionResult init + SEP plan ref
      //    (closure-extracted)
      const { executionStartMs, result, sepEnabled, executionPlanRef } = await bootstrapSession(
        {},
        deps,
        { config, sessionKey, overrides, executionPlanHolder: deps.executionPlanHolder },
      );

      // 2. Pre-lock safety gates: input validation, provider health, circuit
      //    breaker, fault injector (closure-extracted)
      const safetyOutcome = runSafetyGates(
        { result },
        deps,
        { msg, sessionKey, agentId, provider: config.provider },
      );
      if (!safetyOutcome.passed) return result;
      const safetyReinforcement = safetyOutcome.safetyReinforcement;

      // 3. Decode per-execute overrides into the factory's mutable refs
      //    (closure-extracted)
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
      // A per-spawn tokenBudget becomes THIS execution's effective
      // per-execution cap (min(config.perExecution, cap)); undefined ⇒ no cap
      // override, byte-identical to the no-budget path.
      // resetExecution returns an EXECUTION-LOCAL window owning this run's
      // per-execution total + cap. Thread it (not the shared per-agent guard)
      // into the before-tool-call guard and the event bridge so two concurrent
      // same-agent executions never clobber each other's per-execution budget.
      const budgetWindow = deps.budgetGuard.resetExecution(executionOverrides?.tokenBudget);

      // 4. Resolve model using ModelRegistry
      //    Apply per-node model override from ExecutionOverrides and normalize shortcuts before registry lookup
      const normalizedPrimary = normalizeModelId(config.provider, config.model);
      // Track the provider key (config providers.entries space) the
      // EXECUTING model resolves to — the agent's primary by default, the
      // override provider when a per-execution model override resolves below.
      // The served-window gate compares against THIS key rather than
      // resolvedModel.provider because the registry's alias fallback can
      // rename a custom provider entry to its built-in pi name.
      let resolvedProviderKey = config.provider;
      let resolvedModel = deps.modelRegistry.find(config.provider, normalizedPrimary.modelId);
      // Hoisted so the unresolved-model diagnostic below can list the alias
      // target's ids too (the second lookup find() tries).
      const aliasBuiltInName = deps.providerAliases?.get(config.provider);
      if (!resolvedModel && aliasBuiltInName) {
        resolvedModel = deps.modelRegistry.find(aliasBuiltInName, normalizedPrimary.modelId);
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
        // Distinguish "provider unregistered" from "provider OK, model id unknown"
        // (the far more common typo/alias case — e.g. `gpt-5.6` where the real
        // openai-codex ids are gpt-5.6-terra/luna/sol). The old hint blamed
        // providers.entries unconditionally and misdirected; the model-id class
        // needs the available ids + the fail-closed-nano cause of the downstream
        // context_exhausted. availableForProvider spans config.provider AND its
        // built-in alias (the same two lookups find() tried above).
        const availableForProvider = [
          ...new Set(
            deps.modelRegistry
              .getAll()
              .filter(m => m.provider === config.provider
                || (aliasBuiltInName !== undefined && m.provider === aliasBuiltInName))
              .map(m => m.id),
          ),
        ];
        const diag = diagnoseUnresolvedModel(config.provider, normalizedPrimary.modelId, availableForProvider);
        deps.logger.warn(
          {
            agentId,
            configuredProvider: config.provider,
            configuredModel: normalizedPrimary.modelId,
            unresolvedReason: diag.reason,
            availableModelCount: availableForProvider.length,
            hint: diag.hint,
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
            resolvedProviderKey = overrideProvider; // the execution now runs on the override's provider
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
      if (alsCtx && resolvedModel) {
        (alsCtx as Record<string, unknown>).resolvedModel = `${resolvedModel.provider}:${resolvedModel.id}`;
      }
      // Derive compat config via normalizeModelCompat (xAI + GBNF auto-detection;
      // providerType/comisCompat resolved per-execution because model overrides
      // can switch providers).
      const modelCompat = resolvedModel ? normalizeModelCompat({
        provider: resolvedModel.provider,
        id: resolvedModel.id,
        providerType: deps.getProviderType?.(resolvedModel.provider),
        comisCompat: deps.getModelCompat?.(resolvedModel.provider, resolvedModel.id),
      }) : undefined;

      // Resolve ModelProfile once per execution (resolve-once, thread everywhere).
      // Must be after executionOverrides.model override (above) so the profile reflects
      // the actual resolved model. Added to RunSessionLockedContext (per-execution record,
      // NOT PiExecutorDeps which is long-lived across multiple execute() calls).
      // resolvedModel.input is ("text"|"image")[] — assignable to readonly string[]
      // without a cast now that resolveModelProfile accepts readonly string[] | undefined.
      // Wire operator capabilityClass override from providers.entries.<id>.capabilities.capabilityClass.
      // deps.providerCapabilities is already populated by setup-agents-runtime.ts from
      // container.config.providers?.entries?.[resolved.provider]?.capabilities.
      // When set, this overrides the provider-family heuristic (ollama → "small" etc.)
      // and lets operators pin a specific capabilityClass in config (e.g., to treat a
      // large quantized ollama model as "mid" for context budget + security purposes).

      // Reconcile effective context window before resolveModelProfile.
      // capabilityCap is derived from deps.providerCapabilities?.capabilityClass (pre-resolver,
      // config-side value) — NOT from modelProfile.capabilityClass, which does not exist yet
      // (resolveModelProfile is what creates it). Using modelProfile here would be circular.
      // When no explicit capabilityClass is present (e.g. plain anthropic/openai
      // provider with no providers.entries block), treat the cap as Infinity (no constraint).
      // Only apply a class-derived cap when the operator explicitly set capabilityClass.
      // Cross-provider stress enabler: the AGENT-level pin
      // (agents.<id>.capabilityClass) takes precedence over the PROVIDER-level
      // value (providers.entries.<id>.capabilities.capabilityClass), so an operator
      // can force a small-window nano/small treatment on a large-window model
      // (gpt-5-nano/claude-haiku/gemini-flash) to exercise the context-fit path on
      // ANY provider. Resolved ONCE here so the capabilityCap below and the
      // resolveModelProfile override agree on the same class. Unset on both →
      // undefined → the provider-family heuristic (byte-identical).
      const explicitClass = config.capabilityClass ?? deps.providerCapabilities?.capabilityClass;
      const capabilityCap = explicitClass != null
        ? (DEFAULT_EFFECTIVE_CAP_BY_CLASS[explicitClass] ?? Infinity)
        : Infinity;
      // The probed served window binds ONLY
      // executions on the provider it was probed from. deps.servedContextWindow
      // is bound once at construction to the agent's PRIMARY provider, but
      // executionOverrides.model can switch providers per-execution (graph
      // per-node models, subagent spawns). On mismatch: no served clamp AND no served attribution —
      // otherwise an Ollama-primary agent's 8K num_ctx would silently crush an
      // override model on another provider and the diagnostics would assert
      // "Ollama serves only 8192" for a model Ollama does not serve.
      const servedWindow =
        deps.servedContextWindow !== undefined &&
        deps.servedContextWindow.providerKey === resolvedProviderKey
          ? deps.servedContextWindow.window
          : undefined;
      const effectiveContextWindowResult = resolveEffectiveContextWindow({
        configured: resolvedModel?.contextWindow ?? 8_192,
        served: servedWindow,
        capabilityCap,
      });
      // The window provenance is BORN here — the TRUE
      // configured window before resolveModelProfile below overwrites
      // profile.contextWindow with the reconciled value. Threaded along the
      // modelProfile chain into BOTH computeTokenBudgetForProfile call sites
      // (executor-tool-assembly + lcd-assembler via ContextEngineDeps) so a
      // served-bound budget reports raw=configured with windowCapSource "served".
      const windowProvenance: WindowProvenance = {
        configuredWindow: resolvedModel?.contextWindow ?? 8_192,
        ...(servedWindow !== undefined && { served: servedWindow }),
        reconcileSource: effectiveContextWindowResult.source,
      };
      if (effectiveContextWindowResult.source !== "configured") {
        deps.logger.debug({
          source: effectiveContextWindowResult.source,
          effectiveWindow: effectiveContextWindowResult.effectiveWindow,
          configured: resolvedModel?.contextWindow,
          served: servedWindow,
          capabilityCap,
          submodule: "context-window-reconcile",
        }, "Context window reconciled (served or capability cap bound)");
        // Promote the FIRST reconcile of a session to INFO — the
        // reconcile is load-bearing diagnostic evidence (which window actually
        // bound, and why) and must not depend on logLevel=debug having been set
        // before the incident. The bounded session latch keeps it to exactly
        // once per session (clearSessionState grants a fresh INFO on
        // delete/reset/expiry); the DEBUG above stays per-turn.
        const reconcileLatchKey = formatSessionKey(sessionKey);
        if (!getWindowReconcileLogged(reconcileLatchKey)) {
          setWindowReconcileLogged(reconcileLatchKey);
          deps.logger.info({
            source: effectiveContextWindowResult.source,
            effectiveWindow: effectiveContextWindowResult.effectiveWindow,
            configured: resolvedModel?.contextWindow ?? 8_192,
            served: servedWindow,
            capabilityCap,
            submodule: "context-window-reconcile",
          }, "Context window reconciled (served or capability cap bound)");
        }
      }
      const modelProfile = resolveModelProfile(
        resolvedModel
          ? { ...resolvedModel, contextWindow: effectiveContextWindowResult.effectiveWindow }
          : undefined,
        // Use the resolved explicitClass (agent-level pin > provider-level) so the
        // pinned class drives BOTH the capabilityCap above and the profile here.
        explicitClass,
      );

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
          modelProfile,
          windowProvenance,
          activeStepCounter,
          budgetWindow,
          sessionAdapter,
          cacheRetentionRef,
          adaptiveRetentionRef,
          minTokensOverrideRef,
        }),
      );

      // 6. Post-lock outcome: destroy session if session_reset; map lock failure
      //    (closure-extracted)
      return finalizeLockResult(
        { result },
        deps,
        { lockResult, sessionAdapter, sessionKey },
      );
    },
  };
}

// ---------------------------------------------------------------------------
// Inside-lock session callback — kept as a top-level helper rather than
// further closure-extracted because the body's hundreds of inter-references
// between session manager, bridge, stream wrappers, context engine, tool
// pipeline, and runPrompt invocation make a clean state-by-parameter
// decomposition impractical without sub-decomposing the bridge construction
// and stream-wrapper wiring separately.
// ---------------------------------------------------------------------------

interface RunSessionLockedContext {
  readonly config: PerAgentConfig;
  readonly deps: PiExecutorDeps;
  readonly result: ExecutionResult;
  readonly msg: NormalizedMessage;
  readonly sessionKey: SessionKey;
  readonly tools: AgentTool[] | undefined;
  readonly onDelta: ((delta: string, kind: "text" | "thinking") => void) | undefined;
  readonly agentId: string;
  readonly _directives: CommandDirectives | undefined;
  readonly _prevTimestamp: number | undefined;
  readonly executionOverrides: ExecutionOverrides | undefined;
  readonly executionStartMs: number;
  readonly effectiveTimeout: EffectiveTimeout;
  readonly sepEnabled: boolean;
  readonly executionPlanRef: { current: import("../../planner/types.js").ExecutionPlan | undefined };
  readonly safetyReinforcement: string | undefined;
  readonly resolvedModel: ReturnType<ModelRegistry["find"]> | undefined;
  readonly modelCompat: ReturnType<typeof normalizeModelCompat> | undefined;
  readonly modelProfile: ModelProfile;
  /** Served/capability window provenance built at the reconcile above —
   *  threaded as a sibling of modelProfile into both budget call sites. */
  readonly windowProvenance: WindowProvenance;
  readonly activeStepCounter: StepCounter;
  /** The per-execution budget window for THIS run — threaded into the
   *  before-tool-call guard and the event bridge instead of the shared per-agent
   *  guard, so concurrent same-agent executions never share the per-execution cap/total. */
  readonly budgetWindow: ExecutionBudgetWindow;
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
    resolvedModel, modelCompat, modelProfile, windowProvenance, activeStepCounter,
    budgetWindow,
    sessionAdapter,
    cacheRetentionRef, adaptiveRetentionRef, minTokensOverrideRef,
  } = ctx;
  const executionTurnScope = tryGetContext()?.turnScope;
  const executionConversationRef = executionTurnScope === undefined
    ? undefined
    : createConversationRef(executionTurnScope.conversation);
  if (executionTurnScope === undefined || !executionConversationRef?.ok) {
    deps.logger.error(
      {
        step: "context-authority",
        agentId: deps.agentId,
        hint: "Resolve the canonical turn scope before selecting and running the executor",
        errorKind: "precondition" as const,
      },
      "Agent execution stopped because context authority was unavailable",
    );
    result.finishReason = "error";
    result.response = "The request could not be prepared safely because its conversation authority was unavailable.";
    result.errorContext = {
      errorType: "ContextAuthorityUnavailable",
      retryable: false,
      originalError: "Canonical turn scope was unavailable",
    };
    return result;
  }
  // The per-run workspace jail. A `spawn --worktree` child runs in an
  // isolated git worktree (executionOverrides.workspaceDir, confined under the
  // agent's own jailed workspace), so the SDK session cwd + the
  // resource-loader / context-engine / command-handler workspace root all use it
  // — exec/read/write/edit resolve inside the worktree. Absent ⇒ deps.workspaceDir
  // (the agent's shared workspace — byte-identical to today's path).
  const effectiveWorkspaceDir = executionOverrides?.workspaceDir ?? deps.workspaceDir;
  // Reset closure for postExecution finally-block (writes back through the
  // factory's MutableRef-backed `let`s so the next execute() starts fresh).
  const executionCacheRetentionClear = () => { cacheRetentionRef.set(undefined); };
  const adaptiveRetentionClear = () => { adaptiveRetentionRef.set(undefined); };
  const executionMinTokensOverrideClear = () => { minTokensOverrideRef.set(undefined); };
  const recordProvenanceFailure = (error: Error, errorKind: ErrorKind): void => {
    const safeErrorMessage = toSafeErrorLogString(error);
    deps.logger.error(
      {
        step: "session-provenance",
        agentId,
        durationMs: Math.max(0, deps.clock.now() - executionStartMs),
        err: safeErrorMessage,
        hint: "Check session-storage limits, ownership, and free space, then resend the message; model dispatch was stopped.",
        errorKind,
      },
      "Inbound message provenance persistence failed",
    );
    result.finishReason = "error";
    result.response = "The message could not be saved safely. Please try again.";
    result.errorContext = {
      errorType: "SessionPersistenceError",
      retryable: true,
      originalError: "Inbound message provenance persistence failed",
    };
  };

  // Ingress already committed these immutable occurrence plans to the
  // dedicated ledger. Reuse the exact payloads for every SDK mirror; never
  // reconstruct them from the processed model-facing message.
  const inboundProvenancePlans = executionOverrides?.inboundProvenancePlans ?? [];
  const appendInboundProvenancePlans = (): Result<string, Error> => {
    let finalEntryId = "";
    for (const plan of inboundProvenancePlans) {
      const appended = appendInboundMessageProvenance(sm, plan);
      if (!appended.ok) return appended;
      finalEntryId = appended.value;
    }
    return ok(finalEntryId);
  };
  const provenanceWrite = appendInboundProvenancePlans();
  if (!provenanceWrite.ok) {
    recordProvenanceFailure(provenanceWrite.error, "resource");
    return result;
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

  // Repair orphaned messages — runs AFTER the scrubs so it validates the SAME
  // post-scrub tree the detector (validateRoleAttribution below) checks. When
  // repair ran BEFORE the scrubs, a scrub-induced anomaly was left unrepaired
  // while the detector flagged it every turn forever (the idx-47 incident).
  const repairResult = repairOrphanedMessages(sm);
  if (repairResult.repaired) {
    deps.logger.info(
      { reason: repairResult.reason },
      "Repaired orphaned message",
    );
  }

  // Neutralize any forged context-boundary markers the model emitted in its OWN
  // prior output ([System context]/[End system context] wrappers, or a line-start
  // [<channel>] <id> (<time>): inbound header) before buildSessionContext replays
  // them — so a self-forged "user turn" can never re-enter the SDK replay path as
  // real history (the comis-daniel 2026-07-09 incident; the LCD replay path is
  // guarded symmetrically at executor/lcd-ingest.ts). In-memory only + idempotent
  // (mirrors scrubRedactedToolCalls): the on-disk JSONL keeps the raw record for
  // forensics; the replayed prefix stays byte-stable.
  const forgedScrub = scrubForgedContextMarkers(sm);
  if (forgedScrub.scrubbed) {
    deps.logger.warn(
      {
        messagesRewritten: forgedScrub.messagesRewritten,
        markersStripped: forgedScrub.markersStripped,
        errorKind: "validation" as ErrorKind,
        hint: "assistant replay context contained self-emitted context-boundary markers — neutralized before buildSessionContext to prevent a fabricated turn re-entering history",
      },
      "Scrubbed forged context markers from replay context",
    );
  }

  // Detect first message in session for BOOT.md injection
  const sessionContext = sm.buildSessionContext();

  // Diagnostic assertion — classify any consecutive same-role adjacency in the
  // assembled context by whether the RAW tree still carries it after repair: a
  // still-anomalous raw tree is genuine unrepaired corruption (WARN); a
  // well-formed raw tree means the adjacency is an assembled/merged-view
  // artifact the provider adapter normalizes (benign DEBUG). No repair here.
  validateRoleAttribution(
    sessionContext.messages,
    sessionTreeHasSameRoleAnomaly(sm),
    deps.logger,
  );

  const isFirstMessageInSession = sessionContext.messages.length === 0;

  // Get or create session-scoped guide delivery tracking.
  // Clear on session reset (isFirstMessageInSession) so guides re-inject.
  const formattedKeyForGuides = formatSessionKey(sessionKey);
  let deliveredGuides = getDeliveredGuides(formattedKeyForGuides);
  if (!deliveredGuides || isFirstMessageInSession) {
    deliveredGuides = new Set();
    setDeliveredGuides(formattedKeyForGuides, deliveredGuides);
  }

  // Detect onboarding state for post-execution completion check (the
  // worktree is the child's actual working tree, so onboarding state reflects it).
  const isOnboarding = await detectOnboardingState(effectiveWorkspaceDir);

  let workspacePolicySnapshot = deps.workspacePolicySnapshot;
  if (workspacePolicySnapshot === undefined && deps.workspacePolicyPort !== undefined) {
    const policyAgentId = deps.agentId;
    const policyLoadStartMs = deps.clock.now();
    const policyResult = await deps.workspacePolicyPort.load(policyAgentId);
    const durationMs = Math.max(0, deps.clock.now() - policyLoadStartMs);
    if (!policyResult.ok) {
      deps.logger.error(
        {
          agentId: policyAgentId,
          step: "workspace-policy-load",
          failureKind: policyResult.error.kind,
          durationMs,
          hint: "Check the agent workspace path, file permissions, and workspace policy size before retrying.",
          errorKind: policyResult.error.kind === "agent_not_found"
            ? ("precondition" as const)
            : ("resource" as const),
        },
        "Workspace policy snapshot load failed",
      );
      result.finishReason = "error";
      result.response = "The agent policy could not be loaded safely. Please try again.";
      result.errorContext = {
        errorType: "WorkspacePolicyError",
        retryable: policyResult.error.kind !== "invalid_section",
        originalError: "Workspace policy snapshot load failed",
      };
      return result;
    }
    workspacePolicySnapshot = policyResult.value;
    result.workspacePolicyHash = workspacePolicySnapshot.combinedHash;
    deps.logger.info(
      {
        agentId: policyAgentId,
        step: "workspace-policy-load",
        durationMs,
        sectionCount: workspacePolicySnapshot.sections.length,
        workspacePolicyHash: workspacePolicySnapshot.combinedHash,
      },
      "Workspace policy snapshot loaded",
    );
  }
  if (workspacePolicySnapshot !== undefined) {
    result.workspacePolicyHash = workspacePolicySnapshot.combinedHash;
    const activeContext = tryGetContext();
    if (activeContext) {
      (activeContext as Record<string, unknown>).workspacePolicyHash = workspacePolicySnapshot.combinedHash;
    }
  }
  if (workspacePolicySnapshot === undefined) {
    deps.logger.error(
      {
        agentId: deps.agentId,
        step: "workspace-policy-load",
        hint: "Wire a workspace policy snapshot or WorkspacePolicyPort before starting the agent.",
        errorKind: "precondition" as const,
      },
      "Workspace policy snapshot is required",
    );
    result.finishReason = "error";
    result.response = "The agent policy is unavailable. Please try again.";
    result.errorContext = {
      errorType: "WorkspacePolicyError",
      retryable: false,
      originalError: "Workspace policy snapshot is required",
    };
    return result;
  }

  // Capture prompt skills XML once at execution start.
  // Skills registered during tool calls (e.g., skill-creator creating stock-scanner)
  // do not mutate the system prompt until the next execution.
  const frozenPromptSkillsXml = deps.getPromptSkillsXml?.();
  const frozenPromptSkillLocations = deps.getPromptSkillLocations?.();
  const frozenMcpInstructions = deps.getMcpServerInstructions?.() ?? [];
  const stableGetPromptSkillsXml = frozenPromptSkillsXml !== undefined
    ? () => frozenPromptSkillsXml
    : deps.getPromptSkillsXml;
  // toolCapabilityPort flows through frozenDeps spread — no explicit re-assignment.
  const frozenDeps = {
    ...deps,
    getPromptSkillsXml: stableGetPromptSkillsXml,
    ...(frozenPromptSkillLocations === undefined
      ? {}
      : { getPromptSkillLocations: () => frozenPromptSkillLocations }),
    getMcpServerInstructions: () => frozenMcpInstructions,
    workspacePolicySnapshot,
    isOnboarding,
  };

  // Tool assembly pipeline: merge, settings, prompt, deferral, JIT, pruning, snapshot, normalization, serializer
  // Extracted to executor-tool-assembly.ts
  const toolAssembly = await assembleTools({
    config, deps: frozenDeps, sessionKey, msg, tools, executionOverrides,
    isFirstMessageInSession, sm, formattedKeyForGuides, deliveredGuides,
    resolvedModel, modelCompat, modelProfile, windowProvenance, agentId, safetyReinforcement, _directives,
  });
  const {
    mergedCustomTools,
  } = toolAssembly;
  const {
    deferralResult, deferredContext, capabilityIndexResult,
    capabilityClass, budgetWindowTokens, discoveryTracker, settingsManager,
    resourceLoaderOptions, promptResult, cachedSystemTokensEstimate, cachedFreshTailPreambleTokens,
  } = toolAssembly;
  const currentDiscoveryTracker: DiscoveryTracker | undefined = toolAssembly.currentDiscoveryTracker;
  const {
    systemPrompt,
    systemPromptBlocks,
    dynamicPreamble,
    inlineMemory,
    recalledMemories,
    responseLocalePolicy,
  } = promptResult;

  // Publish the exact per-turn decision only after prompt preparation resolves
  // both operator configuration and request metadata. Sub-agent and graph legs
  // inherit this live context value instead of a config-only approximation.
  const turnContext = tryGetContext();
  if (turnContext) turnContext.resolvedLanguage = responseLocalePolicy.locale;

  const preparedTurnResult = await prepareTurn({
    scope: tryGetContext()?.turnScope,
    locale: resolveLocale({
      explicitLocale: responseLocalePolicy.source === "explicit" ? responseLocalePolicy.locale : undefined,
      requestLocale: responseLocalePolicy.source === "request" ? responseLocalePolicy.locale : undefined,
      translationTarget: responseLocalePolicy.translationTarget,
    }),
    selectedSkills: typeof msg.metadata?.promptSkillContent === "string"
      ? [{ id: "turn:selected-skill", content: msg.metadata.promptSkillContent }]
      : [],
    externalInstructions: frozenMcpInstructions.map((instruction) => ({
      id: `mcp:${instruction.serverId}`,
      content: instruction.instructions,
    })),
    resolvers: {
      resolveWorkspacePolicy: async () => ok(workspacePolicySnapshot),
      captureCapabilities: () => ok({
        tools: mergedCustomTools.map((tool) => ({
          name: tool.name,
          ...(tool.description === undefined ? {} : { description: tool.description }),
        })),
      }),
      assembleConversation: async () => ok({
        history: sessionContext.messages,
        currentRequest: msg,
      }),
      selectRecall: async () => ok({
        ...(inlineMemory === undefined ? {} : { inlineMemory }),
        memories: recalledMemories ?? [],
      }),
    },
  });
  if (!preparedTurnResult.ok) {
    deps.logger.error(
      {
        agentId: deps.agentId,
        step: "turn-preparation",
        failureKind: preparedTurnResult.error.kind,
        hint: "Ensure workspace policy, turn authority, capability inventory, conversation storage, and recall services are available.",
        errorKind: "precondition" as const,
      },
      "Turn preparation failed",
    );
    result.finishReason = "error";
    result.response = "The request could not be prepared safely. Please try again.";
    result.errorContext = {
      errorType: "TurnPreparationError",
      retryable: false,
      originalError: preparedTurnResult.error.kind,
    };
    return result;
  }
  const modelRequestResult = assembleModelRequest({
    preparedTurn: preparedTurnResult.value,
    compiledPrompt: { systemPrompt },
  });
  if (!modelRequestResult.ok) {
    deps.logger.error(
      {
        agentId: deps.agentId,
        step: "model-request-assembly",
        failureKind: modelRequestResult.error.kind,
        hint: "Ensure the assembled conversation contains the attributed current request.",
        errorKind: "precondition" as const,
      },
      "Model request assembly failed",
    );
    result.finishReason = "error";
    result.response = "The request could not be assembled safely. Please try again.";
    result.errorContext = {
      errorType: "ModelRequestAssemblyError",
      retryable: false,
      originalError: modelRequestResult.error.kind,
    };
    return result;
  }
  const assembledCurrentRequest = modelRequestResult.value.conversation.at(-1) as
    | { role: "user"; content: string }
    | undefined;
  const dispatchMessage: NormalizedMessage = {
    ...msg,
    text: assembledCurrentRequest?.content ?? "",
  };

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
    cwd: effectiveWorkspaceDir,
    modelRuntime: deps.modelRuntime,
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

  // Per-session trajectory recorder. The recorder writes one JSONL line
  // per typed-EventBus event the bridge translates; attachTrajectoryToEventBus
  // subscribes once for the duration of this execute() call. Both the
  // recorder and the bridge subscription are torn down in the runner-block
  // finally (after postExecution).
  // createTrajectoryRecorder returns ok(null) when disabled and an explicit
  // error for an unsafe persisted state. The setup block reports errors and
  // continues the turn without a recorder.
  let trajectoryRecorder: TrajectoryRecorder | null = null;
  let trajectoryUnsubscribe: (() => void) | undefined;
  // Cache-trace recorder local-variable lifecycle. Mirrors the trajectory
  // pattern — declared here, assigned inside the try below, torn down in
  // the finally block at end of execute().
  let cacheTrace: CacheTrace | null = null;
  let unsubscribeCacheTrace: (() => void) | undefined;
  try {
    // Confine trajectory writes to the operator's resolved data root (so an
    // ancestor-symlink escape is rejected at open()) UNLESS they explicitly set
    // `diagnostics.trajectory.dir` — then they own that path and confinement is
    // skipped. The base is `deps.dataDir` (config.dataDir / COMIS_DATA_DIR), NOT
    // a hardcoded ~/.comis: a custom-dataDir install keeps its session files —
    // and their co-located trajectory files — under that root, so a ~/.comis
    // base would silently reject every write while the pointer still advertises
    // the file. See resolveTrajectoryConfinedBase.
    const trajectoryConfinedBase = resolveTrajectoryConfinedBase(
      deps.trajectoryConfig?.dir,
      deps.dataDir,
    );
    // Recorder lifecycle:
    //   - `deps.trajectoryRegistry` present → session-scoped: registry
    //     owns the recorder + bridge subscription for the session's
    //     lifetime, this `execute()` call just looks it up (or
    //     materializes it on the first turn). `flushAndClose` runs in
    //     the daemon's shutdown chain via `closeAll()`, NOT in this
    //     execute's finally — that's what fixes per-turn seq reset
    //     and repeated session.started/ended deviations.
    //   - `deps.trajectoryRegistry` undefined → fall back to per-turn
    //     construction (legacy path; kept so tests + non-daemon callers
    //     keep working).
    const trajectoryInit = {
      agentId: agentId ?? config.name,
      logger: deps.logger,
      sessionId: formattedKey,
      sessionKey: formattedKey,
      // Record the run's ACTUAL working tree (the worktree when present)
      // so the trajectory reflects where exec/read/write ran, not the shared dir.
      workspaceDir: effectiveWorkspaceDir,
      // Pointer-file sidecar. createTrajectoryRecorder
      // calls writeTrajectoryPointerFileBestEffort when sessionFile is
      // set, producing <sessionFile>.trajectory-path.json next to the
      // per-session JSONL transcript. The pointer is best-effort
      // (symlinked parents / unwritable dirs no-op silently).
      // The registry's first-init-wins contract means the
      // pointer is written exactly once at recorder creation.
      // sessionAdapter.getSessionPath is sync + pure (safePath under
      // the hood) — zero overhead at trajectoryInit construction.
      sessionFile: sessionAdapter.getSessionPath(sessionKey),
      // provider + modelId + modelApi live inside the `model` cluster
      // on TrajectoryRecorderInit (architecture invariant: ≤12 optional
      // fields per interface). The runtime lifts each cluster field
      // onto the trajectory envelope when defined.
      // modelApi is not threaded from this site yet — wire it in when
      // resolvedModel exposes the API discriminator.
      model: {
        provider: resolvedModel?.provider ?? config.provider,
        modelId: resolvedModel?.id ?? config.model,
      },
      ...(trajectoryConfinedBase !== undefined
        ? { confinedBaseDir: trajectoryConfinedBase }
        : {}),
      ...(deps.trajectoryConfig?.enabled !== undefined
        ? { enabled: deps.trajectoryConfig.enabled }
        : {}),
      ...(deps.trajectoryConfig?.dir !== undefined
        ? { trajectoryDir: deps.trajectoryConfig.dir }
        : {}),
      ...(deps.trajectoryConfig?.maxFileBytes !== undefined
        ? { maxRuntimeFileBytes: deps.trajectoryConfig.maxFileBytes }
        : {}),
    };
    const eventTypes = deps.trajectoryConfig?.eventTypes;
    const eventTypesFilter =
      eventTypes && eventTypes.length > 0
        ? (n: string) => eventTypes.includes(n)
        : undefined;

    const reportTrajectoryResumeFailure = (
      error: TrajectoryResumeError,
    ): void => {
      deps.logger.error(
        {
          agentId: agentId ?? config.name,
          sessionKey: formattedKey,
          failureKind: error.failureKind,
          sourceCode: error.sourceCode,
          errorKind: trajectoryResumeErrorKind(error.failureKind),
          hint: "Inspect trajectory path confinement, file type, ownership, permissions, size cap, and JSONL envelope integrity; fix the artifact before retrying this session",
        },
        "Trajectory recorder could not resume persisted state",
      );
      deps.eventBus.emit("observability:trajectory_degraded", {
        agentId: agentId ?? config.name,
        sessionKey: formattedKey,
        traceId: tryGetContext()?.traceId ?? formattedKey,
        reason: "resume_failed",
        failureKind: error.failureKind,
        timestamp: deps.clock.now(),
      });
    };

    if (deps.trajectoryRegistry !== undefined) {
      // Session-scoped: registry returns the same recorder across turns.
      // The bridge subscription is owned by the registry — no
      // `trajectoryUnsubscribe` to track locally; the registry's
      // `close(formattedKey)` (driven by session-destroy) and
      // `closeAll()` (daemon shutdown) own the teardown.
      const trajectoryResult = deps.trajectoryRegistry.getOrCreate(
        formattedKey,
        trajectoryInit,
        deps.eventBus,
        eventTypesFilter as
          | ((n: import("@comis/observability").TrajectoryBridgedEventName) => boolean)
          | undefined,
      );
      if (trajectoryResult.ok) {
        trajectoryRecorder = trajectoryResult.value.recorder;
      } else {
        reportTrajectoryResumeFailure(trajectoryResult.error);
      }
      // trajectoryUnsubscribe stays undefined — registry owns it.
    } else {
      // Legacy per-turn path. flushAndClose still runs in this execute's
      // finally; seq resets between turns and session.started/ended
      // fires per turn (both break the session-trajectory invariants the
      // registry guarantees). Kept for tests and callers
      // that haven't wired the registry yet.
      const trajectoryResult = createTrajectoryRecorder(trajectoryInit);
      if (trajectoryResult.ok) {
        trajectoryRecorder = trajectoryResult.value;
      } else {
        reportTrajectoryResumeFailure(trajectoryResult.error);
      }
      if (trajectoryRecorder !== null) {
        trajectoryUnsubscribe = attachTrajectoryToEventBus({
          eventBus: deps.eventBus,
          recorder: trajectoryRecorder,
          // Session-scope the per-turn subscription too — same
          // cross-session-contamination guard the registry path applies.
          ownerSessionKey: formattedKey,
          ...(eventTypesFilter !== undefined
            ? {
                filter:
                  eventTypesFilter as (
                    n: import("@comis/observability").TrajectoryBridgedEventName,
                  ) => boolean,
              }
            : {}),
        });
      }
    }

    // Cache-trace recorder lifecycle (mirrors trajectory's).
    // Gated by `deps.cacheTraceConfig.enabled` (forwarded from
    // AppConfig.diagnostics.cacheTrace by daemon wiring; on by default).
    // When enabled, instantiate the recorder + subscribe to the live
    // `observability:token_usage` EventBus emit so the next
    // `recordStage("session:after", {...})` carries cacheReadInputTokens +
    // cacheCreationInputTokens. The recorder's null-return semantics
    // (createCacheTrace returns null when COMIS_DISABLE_CACHE_TRACE=1)
    // make this a no-op in that case.
    if (deps.cacheTraceConfig?.enabled) {
      const cacheTraceConfinedBase =
        deps.cacheTraceConfig.filePath === undefined
          ? safePath(os.homedir(), ".comis")
          : undefined;
      // Envelope cluster — wire the contextual fields reachable
      // from this site without widening the Deps interface. `runId`
      // and `modelApi` are intentionally OMITTED: neither is threaded
      // into the executor's scope today (runId has no producer; the
      // pi-ai Model interface does not expose an `api` discriminator).
      // A follow-up change can widen Deps when those values become
      // available; the optional cluster contract is "wire what's
      // reachable, omit cleanly otherwise".
      cacheTrace = createCacheTrace({
        enabled: true,
        ...(deps.cacheTraceConfig.filePath !== undefined
          ? { filePath: deps.cacheTraceConfig.filePath }
          : {}),
        ...(deps.cacheTraceConfig.maxFileBytes !== undefined
          ? { maxFileBytes: deps.cacheTraceConfig.maxFileBytes }
          : {}),
        includeMessages: deps.cacheTraceConfig.includeMessages ?? false,
        includePrompt: deps.cacheTraceConfig.includePrompt ?? true,
        includeSystem: deps.cacheTraceConfig.includeSystem ?? true,
        agentId: agentId ?? config.name,
        sessionId: formattedKey,
        provider: resolvedModel?.provider ?? config.provider,
        modelId: resolvedModel?.id ?? config.model,
        envelope: {
          sessionKey: formattedKey,
          ...(deps.tenantId !== undefined ? { tenantId: deps.tenantId } : {}),
          ...(effectiveWorkspaceDir !== undefined
            ? { workspaceDir: effectiveWorkspaceDir }
            : {}),
        },
        ...(cacheTraceConfinedBase !== undefined
          ? { confinedBaseDir: cacheTraceConfinedBase }
          : {}),
      });
      if (cacheTrace !== null) {
        unsubscribeCacheTrace = attachCacheTraceToEventBus(cacheTrace, deps.eventBus);
      }
    }
  } catch (err) {
    // Best-effort — recorder construction must never block execution.
    deps.logger.debug(
      { err, hint: "trajectory/cache-trace recorder init failed; continuing without sidecar", errorKind: "internal" as ErrorKind },
      "Trajectory/cache-trace recorder init failed",
    );
  }

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

  // Per-execution turn-loop detector: dedup idempotent reads + break a
  // runaway repeating-tool loop early. Closure-local, one per run.
  const turnLoopDetector = createTurnLoopDetector();

  // Proactive safety -- block tool execution before it starts when
  // safety limits are already reached. Existing reactive checks in
  // pi-event-bridge remain as fallback for limits crossed during execution.
  // NOTE: beforeToolCall replaces the extension runner's hook. Comis does
  // not load pi-mono extensions, so this override is safe.
  // v0.65.0: setBeforeToolCall() removed; beforeToolCall is now a direct property.
  session.agent.beforeToolCall =
    createBeforeToolCallGuard(activeStepCounter, budgetWindow, deps.circuitBreaker, toolRetryBreaker, messageSendLimiter, turnLoopDetector);

  // Mid-turn tool injection -- when discover_tools returns sideEffects.discoveredTools,
  // inject the full ToolDefinitions into the live agentic loop tools array so the LLM can
  // call them in the same turn (not just the next message).
  session.agent.afterToolCall = async (callCtx) => {
    // Populate the loop detector cache on EVERY tool result (before the
    // discovery early-return) so normal reads fill it; mutations clear it.
    turnLoopDetector.recordCall(callCtx.toolCall.name, callCtx.args, callCtx.result);

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
    resolvedModel, capabilityClass, modelProfile, executionOverrides,
    deferralResult, systemPromptBlocks, agentId,
    // Forward the cache-trace recorder so the wrapper chain
    // can include the cache-trace `stream:context` emit. When the
    // recorder is null (disabled), setupStreamWrappers skips the wrapper.
    ...(cacheTrace !== null ? { cacheTrace } : {}),
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
    config, deps: frozenDeps, formattedKey, sessionKey: formattedKey,
    conversationRef: executionConversationRef.value,
    // The dag assembler's LCD read scope tenant — the SAME source
    // executor-post-execution uses for the ingest scope (deps.tenantId ?? the
    // session key's tenant), so read + write scopes agree.
    tenantId: frozenDeps.tenantId ?? sessionKey.tenantId,
    // The selected executor owns the agent authority used by both LCD reads and writes.
    agentId: deps.agentId,
    msg, sm, session,
    resolvedModel, executionOverrides,
    cacheBreakDetector,
    contextEngineRef,
    getCachedSystemTokensEstimate: () => cachedSystemTokensEstimate,
    getCachedFreshTailPreambleTokens: () => cachedFreshTailPreambleTokens,
    getTokenAnchor: () => tokenAnchor,
    onAnchorReset: () => { tokenAnchor = null; },
    currentDiscoveryTracker,
    modelProfile,  // already in scope: resolved once per execution in step 4 (the resolveModelProfile call after the context-window reconcile); consumed by assembleTools' profile budget (step 5, "System token estimate")
    // Served/capability window provenance for the lcd-assembler's budget
    // (the second computeTokenBudgetForProfile call site) — sibling of modelProfile.
    windowProvenance,
    // Thread security-pin markers so the dag eviction never drops canary/security context.
    // contentDelimiter defaults to "" (fail-closed: isSecurityRelevantMessage with empty contentDelimiter
    // only matches on canaryToken — defense-in-depth).
    securityPinMarkers: frozenDeps.canaryToken
      ? { canaryToken: frozenDeps.canaryToken, contentDelimiter: "" }
      : undefined,
    // Thread assembled-input + effective-window tokens so
    // config-resolver can clamp max_tokens per-dispatch.
    onAssembledInputTokens: (tokens: number) => {
      streamSetup.assembledInputTokensRef.current = tokens;
    },
    onEffectiveWindow: (windowTokens: number) => {
      streamSetup.effectiveWindowRef.current = windowTokens;
      // Also update outputHeadroomRef so config-resolver uses the
      // REAL floor for this dispatch (not the stale MIN_VISIBLE_OUTPUT_TOKENS=768).
      // Re-derive from the current thinking level + model reasoning style so the
      // headroom always tracks the live values at the moment the pre-flight fires.
      const rsStyle = (modelProfile?.reasoningStyle ?? "none") as "none" | "native";
      const tLevel = (config.thinkingLevel ?? "medium") as "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
      streamSetup.outputHeadroomRef.current = computeOutputHeadroom(rsStyle, tLevel);
    },
    getThinkingLevel: () => config.thinkingLevel ?? undefined,
    // Thinking-effort governor — down-shifts session.setThinkingLevel
    // before the LLM call when the context engine detects the window is too tight.
    // Gated by config.thinking.downshiftOnTightWindow.
    // Pattern from executor-command-handlers.ts:98 — try/catch with WARN + errorKind.
    // A bare empty catch is PROHIBITED (AGENTS.md §2.2): silent swallow means thinking
    // is never reduced — the exact failure mode the governor must prevent.
    onThinkingDownshifted: config.thinking?.downshiftOnTightWindow !== false
      ? (level: string) => {
          // Update outputHeadroomRef with the POST-DOWNSHIFT headroom
          // so config-resolver clamps max_tokens to the REDUCED thinking reserve after
          // the governor fires. This must happen BEFORE session.setThinkingLevel so the
          // headroom tracks the final level that will be used for this dispatch.
          const rsStyle = (modelProfile?.reasoningStyle ?? "none") as "none" | "native";
          const downshiftedLevel = level as "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
          streamSetup.outputHeadroomRef.current = computeOutputHeadroom(rsStyle, downshiftedLevel);
          try {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- SDK internal API not typed
            (session as any).setThinkingLevel(level);
            frozenDeps.logger.debug(
              { thinkingLevel: level },
              "thinking-effort governor: session.setThinkingLevel applied",
            );
          } catch (govErr) {
            frozenDeps.logger.warn(
              {
                err: govErr,
                thinkingLevel: level,
                hint: "session.setThinkingLevel() failed in thinking-effort governor; thinking reserve not reduced — dispatch continues at original level",
                errorKind: "config" as const,
              },
              "thinking-effort governor: setThinkingLevel failed",
            );
          }
        }
      : undefined,
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

  // Bootstrap crash-recovery sweep. Runs ONCE per session —
  // after the context engine is wired, BEFORE the first turn's afterTurn ingest — so a
  // mid-turn crash gap (messages written to the JSONL trajectory but never ingested into
  // the durable LCD store because the daemon was killed before afterTurn) is
  // continue-appended EXACTLY ONCE. Gated on the existing
  // `isFirstMessageInSession` signal (truly run-once) — turns 2+ are already idempotent
  // via the durable cursor, so skipping them removes per-turn LCD single-flight overhead.
  // Extracted to `maybeRunBootstrapSweep` (state-first helper) to keep the in-lock
  // body from accreting another wiring block; the recovery itself (the EXISTING
  // ingestTurnGuarded path + the canonical context-store gate) lives in
  // `bootstrapLcdSweep`. The scope is built exactly as the afterTurn block does so read
  // scope == write scope: the opaque `conversationRef` is the storage authority,
  // `sessionKey` (formattedKey) rides along as display/path metadata — the two are
  // distinct values, never compared — and agentId is the executor-bound
  // authority. The JSONL-loaded live array is the
  // same ref executor-post-execution reads at the afterTurn site (typed unknown on
  // AgentSession — no public SDK type for it).
  await maybeRunBootstrapSweep({
    isFirstMessageInSession,
    contextStore: frozenDeps.contextStore,
    formattedKey,
    conversationRef: executionConversationRef.value,
    tenantId: frozenDeps.tenantId ?? sessionKey.tenantId,
    agentId: deps.agentId,
    live: ((session.agent as unknown as { state?: { messages?: unknown[] } }).state
      ?.messages ?? []) as AgentMessage[],
    clock: frozenDeps.clock,
    logger: frozenDeps.logger,
    eventBus: frozenDeps.eventBus,
    config,
  });

  const resolverRegisterKey = executionConversationRef.value;

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
        { conversationRef: resolverRegisterKey, hint: "Session already has an active run; concurrent execution may cause issues", errorKind: "resource" as const },
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

  // Resettable prompt timeout -- tool completions reset the timer
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
  // Deltas (text + thinking) reset the stall budget — ALWAYS-
  // defined (the bridge presence-gates on deps.onDelta), live-ref
  // (currentResetTimer is assigned later at onResetTimer), throttled ~1/s.
  const localeDeltaDelivery = createLocaleDeltaDelivery({}, {
    policy: responseLocalePolicy,
    downstream: onDelta,
  });
  const onDeltaWithStallReset = createDeltaResetComposer({}, {
    channelOnDelta: localeDeltaDelivery.onDelta,
    getResetTimer: () => currentResetTimer,
    clock: deps.clock,
  });
  const bridge = createPiEventBridge({
    eventBus: deps.eventBus,
    // This run's execution-local window (NOT the shared per-agent guard),
    // so recordUsage / the turn-end budget check are scoped to THIS execution.
    budgetGuard: budgetWindow,
    costTracker: deps.costTracker,
    // The daemon-wide spend accumulator REFERENCE (the per-agent guards read
    // the SAME instance) + its scope/config. The scope's
    // tenant is read directly off the structured SessionKey (it already carries
    // tenantId; the formatted-string parser is only needed on the bus path). When
    // spendAccumulator is absent the bridge's spend path is a no-op.
    ...(deps.spendAccumulator && deps.spendConfig
      ? {
          spendAccumulator: deps.spendAccumulator,
          spendConfig: deps.spendConfig,
          spendScope: { tenantId: sessionKey.tenantId, agentId: deps.agentId },
        }
      : {}),
    // Thread the late-bound per-root budget holder +
    // the run's rootRunId resolver into the bridge — the SAME daemon-wide-REF,
    // absent ⇒ no-op pattern as spendAccumulator. The bridge sibling's the per-root
    // reserve next to checkSpendCeiling so a self-spawning loop (incl. a zero-price
    // model) trips the token/wall-clock limbs on the live LLM-spend path.
    ...(deps.boundedAutonomyBudget && deps.resolveRootRunId
      ? {
          boundedAutonomyBudget: deps.boundedAutonomyBudget,
          resolveRootRunId: deps.resolveRootRunId,
        }
      : {}),
    stepCounter: activeStepCounter,
    circuitBreaker: deps.circuitBreaker,
    turnLoopDetector,
    sessionKey,
    agentId: deps.agentId,
    channelId: msg.channelId ?? "",
    inboundMessageId: msg.id,
    executionId,
    provider: config.provider,
    model: config.model,
    operationType: executionOverrides?.operationType ?? "interactive",
    logger: deps.logger,
    // Resolved daemon data dir — the bridge's session-index writer
    // (appendSessionIndexEntry) otherwise falls back to the REAL ~/.comis,
    // diverging from config.dataDir / COMIS_DATA_DIR installs.
    dataDir: deps.dataDir,
    // Thread the operator $HOME so the bridge's tool:started/tool:executed
    // params compact $HOME→~ for ALL bus consumers (delivery-tracer, trajectory
    // writers, plan-stream), not only the activity renderer. Matches the
    // os.homedir() sanctioned-root pattern already used in this file for the
    // trajectory-confinement base.
    homeDir: os.homedir(),
    onDelta: onDeltaWithStallReset,
    memoryPort: deps.memoryPort,
    ...(executionTurnScope !== undefined
      ? { memoryScope: { turnScope: executionTurnScope, visibility: { kind: "conversation" } as const } }
      : {}),
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
    // When the configured model is unregistered, pi
    // falls back to its own default model object (e.g. gemini-*); record the
    // CONFIGURED model so token_usage/cost are not mislabeled. See observedModelId.
    getCurrentModel: () => observedModelId(resolvedModel, session.model?.id, config.model),
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
    // Forward the session-scoped registry so the bridge's `agent_start`
    // case can suppress per-turn `session:started` re-emits (session-scoped recorder lifecycle).
    // When undefined (non-daemon callers), the bridge falls back to the
    // legacy unconditional emit.
    ...(deps.trajectoryRegistry !== undefined ? { trajectoryRegistry: deps.trajectoryRegistry } : {}),
    // Provide a snapshot of harness/model/config at
    // bridge-creation time so trace.metadata can be emitted once per session.
    // Fields that are not readily available at this scope are omitted;
    // buildTraceMetadata's compactObject strips undefined cleanly.
    runtimeSnapshot: {
      harness: {
        type: "comis" as const,
        // The daemon package.json version, threaded via deps.appVersion so the
        // trajectory records which build produced it (triage otherwise cannot
        // confirm the artifact's version). "unknown" when unwired (tests / a
        // non-daemon embedder).
        version: deps.appVersion ?? "unknown",
        os: process.platform,
        node: process.version,
        ...(effectiveWorkspaceDir !== undefined ? { workspaceDir: effectiveWorkspaceDir } : {}),
      },
      model: {
        provider: resolvedModel?.provider ?? config.provider,
        modelId: resolvedModel?.id ?? config.model,
        ...(resolvedModel?.api !== undefined ? { modelApi: resolvedModel.api } : {}),
      },
      config,
      // Populate plugins and skills from the registry snapshot.
      // The minimal deps interface exposes getSnapshot?() optionally; legacy
      // callers (tests with the two-method mock) safely degrade to [].
      // TODO: wire deps.pluginRegistry once a plugin-registry
      // seam exists at this scope. Until then, plugins[] stays empty by design.
      plugins: [],
      skills: deps.skillRegistry?.getSnapshot?.()?.skills?.map((s) => ({
        id: s.name,
        ...(s.version !== undefined ? { version: String(s.version) } : {}),
      })) ?? [],
      // Scaffold in place so future writers cannot bypass
      // the redactor. When userPromptPrefixText is wired from a config path,
      // pass it here; the helper routes it through redactString +
      // substitutePathsInString before assignment. See pi-executor-prompting.ts.
      prompting: buildPromptingSnapshot({}),
      redaction: { policy: "platform-aware" },
    },
    perExecutionBudgetCap: config.budgets?.perExecution,
    budgetWarningRef,
    toolRetryBreaker,
    ttlSplit,
    graphId: executionOverrides?.graphId,
    nodeId: executionOverrides?.nodeId,
    // Pass sub-agent's active tool groups for "Tool X not found" enrichment
    activeToolGroups: executionOverrides?.activeToolGroups,
    // The assembled tool names, so a "Tool X not found" error can suggest the
    // closest real tool when a small model hallucinates a name (e.g. an mcp__-prefixed
    // guess for a builtin). Names only — no schemas/secrets.
    allToolNames: mergedCustomTools.map((t) => t.name),
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

  // Execution started bookend
  deps.logger.info(
    {
      step: "agent-execute",
      agentId,
      sessionKey: formattedKey,
      modelId: resolvedModel?.id,
      capabilityClass,
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
    const originResolver = (): BackgroundTaskOrigin | undefined => {
      // Defensive: if any required field is unexpectedly missing, fall through
      // to foreground execution (no background promotion). Promotion requires
      // a complete origin.
      const context = tryGetContext();
      if (!context?.turnScope || !context.deliveryOrigin) return undefined;
      const conversationRef = createConversationRef(context.turnScope.conversation);
      if (!conversationRef.ok) return undefined;
      // Read incoming hop count off msg.metadata so the runner can enforce
      // the recursion bound. Top-level user messages have no
      // metadata.backgroundHopCount -> default to 0.
      const meta = msg.metadata as Record<string, unknown> | undefined;
      const rawHopCount = meta?.backgroundHopCount;
      const incomingHopCount = typeof rawHopCount === "number" && Number.isFinite(rawHopCount) && rawHopCount >= 0
        ? Math.floor(rawHopCount)
        : 0;
      return {
        turnScope: context.turnScope,
        conversationRef: conversationRef.value,
        deliveryOrigin: context.deliveryOrigin,
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
    // Repeat the marker directly at the model-dispatch boundary. The early
    // marker above protects setup failures; this adjacent marker lets a
    // bounded tail reader recover provenance when the 5,000-record boundary
    // falls between setup history and the SDK user record. The offline reader
    // deduplicates the shared physical identities.
    const dispatchProvenanceWrite = appendInboundProvenancePlans();
    if (!dispatchProvenanceWrite.ok) {
      recordProvenanceFailure(dispatchProvenanceWrite.error, "resource");
    } else {
      const promptRunResult = await runPrompt({
        msg: dispatchMessage, session, config, sessionKey, formattedKey, agentId, result,
        executionOverrides, executionStartMs, effectiveTimeout, executionId,
        bridge, dynamicPreamble, responseLocalePolicy, deferredContext, capabilityIndexResult, inlineMemory,
        systemPrompt,
        mergedCustomTools,
        cmdResult, sepEnabled, executionPlanRef,
        _directives, _prevTimestamp, resolvedModel, modelProfile,
        deps: {
          eventBus: deps.eventBus,
          logger: deps.logger,
          // This run's execution-local window (precheck + envelope snapshot).
          budgetGuard: budgetWindow,
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
          // The canonical system-tokens estimate the pre-flight throws on, so
          // wrapEnvelope can size the tight-window residual and drop the heavy
          // tool-discovery preamble before it overflows (same S → no drift).
          getSystemTokensEstimate: () => cachedSystemTokensEstimate,
        },
        onResetTimer: (fn) => { currentResetTimer = fn; },
        getLastCacheWriteTokens: () => bridge.getResult().tokensUsed?.cacheWrite ?? 0,
        budgetWarningRef,
      });
      // Aggregate ghost cost from timed-out request into bridge metrics
      if (promptRunResult.ghostCost) {
        bridge.addGhostCost(promptRunResult.ghostCost);
      }

      // Apply stuck-session outcome (closure-extracted).
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
    }
  } catch (error) {
    // Translate exception into ExecutionResult (closure-extracted).
    handleEnvelopeException(
      { result },
      {
        eventBus: deps.eventBus,
        logger: deps.logger,
        clock: deps.clock,
        outputGuard: deps.outputGuard,
        canaryToken: deps.canaryToken,
      },
      { error, sessionKey, agentId, executionStartMs },
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
      recalledMemories,
      // Read the per-turn skill-use carrier the bridge wrote
      // back into postExecution, which emits the memory:skill_used write-back.
      usedSkillIds: [...bridge.getUsedSkillIds()],
      responseLocalePolicy,
      executionStartMs, executionId, executionOverrides,
      bridge, unsubscribe,
      contextEngineRef, ceSetup, streamSetup,
      getTruncationSummary, getTurnBudgetSummary,
      executionPlanRef, isOnboarding,
      geminiCacheHit, geminiCachedTokens, capabilityClass, budgetWindowTokens,
      provider: resolvedModel?.provider ?? config.provider,
      providerFamily: resolveProviderCapabilities(resolvedModel?.provider ?? config.provider).providerFamily,
      deferralResult, mergedCustomTools, deliveredGuides,
      deps: {
        agentId: deps.agentId,
        eventBus: deps.eventBus,
        logger: deps.logger,
        memoryPort: deps.memoryPort,
        // Canonical afterTurn ingest authority. Both the store and tenant id
        // thread through so postExecution's scope is complete.
        contextStore: deps.contextStore,
        tenantId: deps.tenantId,
        // The leaf-summarizer deps getter sourced from the
        // context-engine setup's shared compaction-model chain. Present ⇒ the
        // afterTurn leaf pass fires live over threshold (gated additionally on
        // deps.contextStore inside postExecution); absent ⇒ the pass is gated off.
        getSummarizerDeps: ceSetup?.getSummarizerDeps,
        activeRunRegistry: deps.activeRunRegistry,
        embeddingEnqueue: deps.embeddingEnqueue,
        // The post-execution / context-engine workspace root is the run's
        // actual working tree (the worktree when present).
        workspaceDir: effectiveWorkspaceDir,
        clock: deps.clock,
        backgroundTaskManager: deps.backgroundTaskManager,
      },
      sessionAdapter,
      executionCacheRetentionClear,
      adaptiveRetentionClear,
      executionMinTokensOverrideClear,
    });
    localeDeltaDelivery.flush(result.response);

    // Tear down the trajectory recorder + bridge subscription as the very
    // last action of this execute() call. Both are best-effort — a
    // flush/unsubscribe failure must NEVER throw out of finally.
    //
    // When `deps.trajectoryRegistry` is present, the registry owns
    // both the recorder and its bridge subscription. The teardown
    // here is a no-op — `closeAll()` (daemon shutdown) and `close()`
    // (session-destroy) are the only paths that flush + unsubscribe.
    if (deps.trajectoryRegistry === undefined) {
      try {
        trajectoryUnsubscribe?.();
      } catch {
        // Unsubscribe failure is unreachable in practice (EventEmitter.off
        // is sync); swallow defensively so this never aborts cleanup.
      }
      if (trajectoryRecorder !== null) {
        try {
          await trajectoryRecorder.flushAndClose();
        } catch (err) {
          deps.logger.debug(
            { err, hint: "trajectory flushAndClose failed; sidecar may be partial", errorKind: "internal" as ErrorKind },
            "Trajectory recorder flushAndClose failed",
          );
        }
      }
    }

    // Tear down the cache-trace recorder + bridge subscription.
    // Sibling block to the trajectory teardown above — best-effort,
    // failures must never throw out of finally.
    try {
      unsubscribeCacheTrace?.();
    } catch {
      // Unsubscribe failure is unreachable in practice (EventEmitter.off
      // is sync); swallow defensively so this never aborts cleanup.
    }
    if (cacheTrace !== null) {
      try {
        await cacheTrace.flushAndClose();
      } catch (err) {
        deps.logger.debug(
          { err, hint: "cache-trace flushAndClose failed; sidecar may be partial", errorKind: "internal" as ErrorKind },
          "Cache-trace recorder flushAndClose failed",
        );
      }
    }
  }

  return result;
}
