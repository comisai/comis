// SPDX-License-Identifier: Apache-2.0
/**
 * Stream wrapper composition for PiExecutor.
 *
 * Extracted from pi-executor.ts execute() to isolate the ordered
 * construction of the stream wrapper chain (TTL guard, validation
 * formatter, bouncer, turn budget, config resolver, request body
 * injector, Gemini cache injector, trace writers).
 *
 * Mutable refs (executionCacheRetention, adaptiveRetention,
 * executionMinTokensOverride) remain in pi-executor.ts. This module
 * receives getter callbacks for those values.
 *
 * Consumers:
 * - pi-executor.ts: calls setupStreamWrappers() during execute()
 *
 * Wrapper ordering (outermost first):
 * 1. TTL guard (cache TTL expiry detection)
 * 2. Validation error formatter (AJV error simplification)
 * 3. Tool result size bouncer (per-tool truncation)
 * 4. Turn result budget (per-turn aggregate budget)
 * 5. Config resolver (maxTokens, temperature, cacheRetention)
 * 6. Request body injector (Anthropic cache breakpoints)
 * 7. Gemini cache injector (Google CachedContent injection)
 * 8. Trace writers (JSONL cache trace, API payload trace)
 *
 * @module
 */

import {
  safePath,
  type SessionKey,
  type PerAgentConfig,
} from "@comis/core";
import type { ComisLogger, ErrorKind } from "@comis/core";
import type { CacheRetention } from "@earendil-works/pi-ai";
import type { StreamFnWrapper } from "./stream-wrappers/index.js";
import {
  createToolResultSizeBouncer,
  createTurnResultBudgetWrapper,
  createConfigResolver,
  createApiPayloadTraceWriter,
  createRequestBodyInjector,
  createValidationErrorFormatter,
} from "./stream-wrappers/index.js";
import { buildCacheTraceWrapper } from "@comis/observability";
import type { CacheTrace } from "@comis/observability";
import type { TruncationSummary } from "./stream-wrappers/tool-result-size-bouncer.js";
import type { TurnBudgetSummary } from "./stream-wrappers/turn-result-budget-wrapper.js";
import { FAIL_CLOSED_PROFILE } from "./model-profile.js";
import type { CapabilityClass, ModelProfile } from "./model-profile.js";
import { resolveScaffoldDefaults } from "./scaffold-defaults.js";
import { MIN_VISIBLE_OUTPUT_TOKENS } from "../context-engine/output-headroom.js";
import { resolveMainPathMaxOutputTokens } from "./verification-gate.js";
import { createStubFilterInjector } from "./stream-wrappers/stub-filter-injector.js";
import { createToolCallRepairWrapper } from "./stream-wrappers/tool-call-repair-wrapper.js";
import { computeFeatureFlagHash } from "./prompt-assembly.js";
import { createTtlGuard, getElapsedSinceLastResponse, getLastResponseTs } from "./ttl-guard.js";
import { isAnthropicFamily, isGoogleFamily } from "../provider/capabilities.js";
import type { TtlSplitEstimate } from "../bridge/pi-event-bridge.js";
import { createGeminiCacheInjector } from "./gemini-cache-injector.js";
import type { GeminiCacheManager } from "./gemini-cache-manager.js";
import { extractAnthropicPromptState, extractGeminiPromptState } from "./cache-detection/index.js";
import { createBlockStabilityTracker } from "./block-stability-tracker.js";
import {
  clearSessionCacheWarm,
  getOrCreateSessionLatches,
  clearSessionLatches,
  getCacheBreakDetector,
  getBreakpointIndex,
  getEvictionCooldown,
} from "./executor-session-state.js";
import type { SessionManager } from "@earendil-works/pi-coding-agent";
import { installMicrocompactionGuard } from "../context-engine/index.js";
import type { ContextEngine } from "../context-engine/index.js";
import type { AdaptiveCacheRetention } from "./adaptive-cache-retention.js";
import type { ExcludeDeferralResult } from "./tool-deferral.js";
import type { SystemPromptBlocks } from "../bootstrap/index.js";
import type { ExecutionOverrides } from "./types.js";
import { homedir } from "node:os";
import path from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Subset of PiExecutorDeps used by stream wrapper setup. */
export interface StreamSetupDeps {
  logger: ComisLogger;
  eventBus: import("@comis/core").TypedEventBus;
  agentId?: string;
  tenantId?: string;
  tracingDefaults?: { maxSize: string; maxFiles: number };
  geminiCacheManager?: GeminiCacheManager;
  /** Wall-clock + monotonic time reads. */
  clock: import("@comis/core").ClockPort;
  /**
   * Confinement base for the `@comis/observability` fs-safe substrate
   * (typically `~/.comis/`). Threaded into
   * `installMicrocompactionGuard` so the disk-offload writer can
   * confine its tool-results dir + file writes inside the operator's
   * data root — closes the ancestor-symlink escape gap (file-mode invariant).
   * Optional: when undefined, the caller falls back to
   * `safePath(homedir(), ".comis")` (the default daemon data dir).
   */
  dataDir?: string;
}

/** Parameters for the setupStreamWrappers function. */
export interface StreamSetupParams {
  config: PerAgentConfig;
  deps: StreamSetupDeps;
  sessionKey: SessionKey;
  formattedKey: string;
  /** Session manager instance for microcompaction guard installation. */
  sm: SessionManager;
  resolvedModel?: { id: string; provider: string };
  modelCompat?: { supportsTools?: boolean };
  capabilityClass: CapabilityClass;
  /**
   * ModelProfile resolved once per execution in pi-executor.ts.
   * Threaded into RequestBodyInjectorConfig so the factory and
   * tool-deferral-injection use capability flags
   * instead of provider-string predicates.
   */
  modelProfile?: ModelProfile;
  executionOverrides?: ExecutionOverrides;
  deferralResult?: ExcludeDeferralResult;
  systemPromptBlocks?: SystemPromptBlocks;
  agentId?: string;

  /**
   * Per-session cache-trace recorder. The recorder is
   * instantiated + bus-subscribed in `pi-executor.ts` (mirroring the
   * trajectory-recorder lifecycle). This field forwards it into
   * `setupStreamWrappers` so the wrapper chain can include the
   * cache-trace `stream:context` emit. When undefined, no cache-trace
   * wrapper is added.
   */
  cacheTrace?: CacheTrace;

  // Getter callbacks for mutable refs that stay in pi-executor.ts scope
  /** Get the current adaptive cache retention (may be undefined). */
  getAdaptiveRetention: () => AdaptiveCacheRetention | undefined;
  /** Get the per-execution cache retention override. */
  getExecutionCacheRetention: () => CacheRetention | undefined;
  /** Get the per-execution minTokens override. */
  getExecutionMinTokensOverride: () => number | undefined;

  // Callback for breakpoint index feedback
  /** Callback invoked when cache breakpoints are placed (feeds index back to context engine). */
  onBreakpointsPlaced?: (highestIdx: number) => void;
  /** Callback invoked when Gemini cache hit is detected. */
  onGeminiCacheHit?: (entry: { cachedTokens: number }) => void;
}

/** Result of stream wrapper setup. */
export interface StreamSetupResult {
  /** Ordered stream function wrappers (outermost first). */
  wrappers: StreamFnWrapper[];
  /** Mutable holder for context engine reference (wired after context engine creation). */
  contextEngineRef: { current?: ContextEngine };
  /** Cache break detector singleton for this execution. */
  cacheBreakDetector: ReturnType<typeof getCacheBreakDetector>;
  /** Truncation metadata registry (toolCallId -> truncation stats). */
  truncationMetaRegistry: Map<string, { truncated: boolean; fullChars: number; returnedChars: number }>;
  /** Get truncation summary for bookend log. */
  getTruncationSummary: () => TruncationSummary;
  /** Get turn budget summary for bookend log. */
  getTurnBudgetSummary: () => TurnBudgetSummary;
  /** Captured adaptive retention snapshot (for TTL guard timestamp recording). */
  capturedRetention: AdaptiveCacheRetention | undefined;
  /** Shared mutable TTL split estimate, populated by requestBodyInjector,
   *  consumed by pi-event-bridge on turn_end for per-TTL cost calculation. */
  ttlSplit: TtlSplitEstimate;
  /** Mutable ref for assembled input tokens (set by lcd-assembler via onAssembledInputTokens).
   *  Exposed so pi-executor.ts can wire the callback into setupContextEngine. */
  assembledInputTokensRef: { current: number };
  /** Mutable ref for effective window (set by lcd-assembler via onEffectiveWindow).
   *  Exposed so pi-executor.ts can wire the callback into setupContextEngine. */
  effectiveWindowRef: { current: number };
  /** Mutable ref for reasoning-aware output headroom.
   *  Initialised to MIN_VISIBLE_OUTPUT_TOKENS (768). pi-executor.ts updates it via
   *  computeOutputHeadroom(reasoningStyle, thinkingLevel) in the onEffectiveWindow
   *  and onThinkingDownshifted callbacks so config-resolver always uses the REAL
   *  floor for the current dispatch (8960 for native/high, not 768). */
  outputHeadroomRef: { current: number };
}

// ---------------------------------------------------------------------------
// Offload callback
// ---------------------------------------------------------------------------

/** Minimal deps for the microcompaction offload callback. */
export interface OffloadCallbackDeps {
  eventBus: import("@comis/core").TypedEventBus;
  /** Injected wall-clock read — the callback timestamps via `clock.now()`, never the global clock. */
  clock: import("@comis/core").ClockPort;
  /** Existing cache-break side-effect (cacheBreakDetector.notifyContentModification). */
  onCacheBreak: () => void;
}

/**
 * Build the 4-arg callback the microcompaction guard invokes on each offload.
 *
 * The guard holds no eventBus/clock — it computes the payload
 * (already with a WORKSPACE-RELATIVE pointer) and passes it here.
 * This callback performs the two observable effects: it preserves the
 * existing cache-break notification and emits `tool:result_offloaded` so the
 * offload lands in the trajectory (the `IncidentReport.offloads[]`
 * drill-down). Extracted as a pure factory so the emit shape is unit-testable
 * without standing up the full `setupStreamWrappers` dependency graph.
 */
export function buildOffloadCallback(
  deps: OffloadCallbackDeps,
): (toolName: string, originalChars: number, toolCallId: string, diskPathRel: string) => void {
  return (toolName, originalChars, toolCallId, diskPathRel) => {
    deps.onCacheBreak(); // KEEP — existing cacheBreakDetector.notifyContentModification behavior
    deps.eventBus.emit("tool:result_offloaded", {
      toolName,
      toolCallId,
      originalChars,
      diskPathRel,
      timestamp: deps.clock.now(), // injected clock, not the global one
    });
  };
}

// ---------------------------------------------------------------------------
// Setup function
// ---------------------------------------------------------------------------

/**
 * Build the ordered stream wrapper chain for a single execution.
 *
 * Pure function with params object. All mutable refs and closure state
 * remain in pi-executor.ts orchestrator scope and are accessed via getter
 * callbacks.
 *
 * @param params - Stream setup parameters including config, deps, and getter callbacks
 * @returns Stream setup result with wrappers array and shared state refs
 */
export function setupStreamWrappers(params: StreamSetupParams): StreamSetupResult {
  const {
    config, deps, formattedKey, sm,
    capabilityClass, executionOverrides, deferralResult, systemPromptBlocks, agentId,
    cacheTrace, modelProfile,
    getAdaptiveRetention, getExecutionCacheRetention, getExecutionMinTokensOverride,
    onBreakpointsPlaced, onGeminiCacheHit,
  } = params;

  // Mutable holder for context engine -- allows the requestBodyInjector
  // callback closure to reference contextEngine before it's created (assigned below).
  const contextEngineRef: { current?: ContextEngine } = {};

  // Obtain cache break detector singleton for this execution.
  const cacheBreakDetector = getCacheBreakDetector(deps.logger);

  // Block stability tracker for adaptive TTL promotion.
  // Singleton per module (same pattern as cacheBreakDetector) -- state is per-session inside the tracker.
  const blockStabilityTracker = createBlockStabilityTracker();

  // Offload oversized tool results to disk before JSONL session write.
  // dataDir is threaded as the fs-safe substrate's confinedBaseDir so
  // the disk-offload writer's mkdir+chmod+open chain rejects any
  // ancestor-symlink escape (file-mode invariant). Falls back to ~/.comis/ when
  // the daemon hasn't explicitly forwarded its dataDir.
  const microcompactionDataDir = deps.dataDir ?? safePath(homedir(), ".comis");
  installMicrocompactionGuard(
    sm,
    sm.getSessionDir(),
    microcompactionDataDir,
    deps.logger,
    // The guard hands offload payloads (with a workspace-relative pointer) here;
    // this callback owns both observable effects — cache-break detection AND the
    // tool:result_offloaded trajectory emit (timestamped via the injected clock).
    buildOffloadCallback({
      eventBus: deps.eventBus,
      clock: deps.clock,
      onCacheBreak: () => cacheBreakDetector.notifyContentModification(formattedKey),
    }),
  );

  const wrappers: StreamFnWrapper[] = [];

  // Reformat AJV validation errors before the LLM sees them.
  const validationErrorFormatter = createValidationErrorFormatter(deps.logger);

  // Shared truncation metadata registry for audit event flow.
  const truncationMetaRegistry = new Map<string, { truncated: boolean; fullChars: number; returnedChars: number }>();
  const registerTruncation = (toolCallId: string, meta: { fullChars: number; returnedChars: number }) => {
    truncationMetaRegistry.set(toolCallId, { truncated: true, fullChars: meta.fullChars, returnedChars: meta.returnedChars });
  };

  // Bouncer with tool-specific truncation hints and summary accumulator
  const truncationHints = new Map<string, string>([
    ["bash", "Use head/tail/grep to limit output, or add --max-lines flag"],
    ["file_ops", "Read specific line ranges instead of entire files"],
    ["memory_search", "Reduce limit parameter or narrow search query"],
  ]);
  // small/nano cap a single tool result far below the 50_000-char schema default
  // so one oversized web_search/read result cannot blow the window (the live NVDA analysts
  // exhausted at assembled ~33-35K from 20-35K-char results). The scaffold returns a number
  // only when it wants to override; otherwise fall back to the operator/schema config value.
  const effectiveMaxToolResultChars =
    (modelProfile ? resolveScaffoldDefaults(modelProfile, config).maxToolResultChars : undefined)
    ?? config.maxToolResultChars;
  const { wrapper: bouncerWrapper, getTruncationSummary } = createToolResultSizeBouncer(
    effectiveMaxToolResultChars,
    deps.logger,
    truncationHints,
    registerTruncation,
  );

  // Per-turn aggregate result budget
  const { wrapper: turnBudgetWrapper, getTurnBudgetSummary } = createTurnResultBudgetWrapper(
    200_000, // MAX_TOOL_RESULTS_PER_TURN_CHARS
    500,     // MIN_CHARS_PER_TOOL
    deps.logger,
    registerTruncation,
  );

  // Shared TTL split estimate, populated by requestBodyInjector, consumed by bridge
  const ttlSplit: TtlSplitEstimate = { cacheWrite5mTokens: 0, cacheWrite1hTokens: 0 };

  // Assembled input tokens + effective window set by lcd-assembler via callbacks,
  // read lazily by configResolver at dispatch time (lazy evaluation — assembler runs AFTER wrapper chain is built).
  const assembledInputTokensRef = { current: 0 };
  const effectiveWindowRef = { current: Infinity };
  const outputHeadroomRef = { current: MIN_VISIBLE_OUTPUT_TOKENS };

  // Capture adaptive retention into local const to prevent race condition.
  const capturedRetention = getAdaptiveRetention();
  const capturedCacheRetention = getExecutionCacheRetention();

  // Wrapper chain order (outermost first):
  // ttlGuard -> toolCallRepairWrapper -> validationErrorFormatter -> toolResultSizeBouncer ->
  //   turnResultBudget -> configResolver -> requestBodyInjector (Anthropic) ->
  //   geminiCacheInjector (Google) -> [traceWriters]

  // TTL guard is outermost wrapper
  const onTtlExpiry = () => {
    // Four coordinated resets on TTL expiry
    capturedRetention?.reset();                         // 1. Reset adaptive retention to cold-start
    clearSessionCacheWarm(formattedKey);                // 2. Clear session warm state
    cacheBreakDetector.notifyTtlExpiry(formattedKey);   // 3. Notify detector
    clearSessionLatches(formattedKey);                  // 4. SESS-LATCH: Reset latches for fresh cache cycle
    // Latch idle thinking clear when elapsed > 1h
    if (!executionOverrides?.spawnPacket) {
      const elapsed = getElapsedSinceLastResponse(formattedKey, deps.clock);
      if (elapsed !== undefined && elapsed > 60 * 60 * 1000) {
        getOrCreateSessionLatches(formattedKey).idleThinkingClear.setOnce(true);
      }
    }
  };

  wrappers.push(
    createTtlGuard({
      sessionKey: formattedKey,
      getRetention: () => capturedRetention?.getRetention(),
      onTtlExpiry,
      logger: deps.logger,
      clock: deps.clock,
    }),
    // Shape-only tool-call JSON repair inserted BEFORE
    // validationErrorFormatter so near-miss args are repaired then re-validated
    // by the existing downstream gates (validateExecCommand for exec tools).
    // Irreparable args produce "Validation failed" prefix → PARAMETER_VALIDATION_TAGS
    // carve-out → no breaker trip. Uses modelProfile for supportsStructuredOutput gate.
    createToolCallRepairWrapper(modelProfile ?? FAIL_CLOSED_PROFILE, deps.logger),
    validationErrorFormatter,
    bouncerWrapper,
    turnBudgetWrapper,
    createConfigResolver(
      {
        // When the operator has not set an explicit maxTokens override,
        // size the MAIN-path budget from the model profile's REAL maxOutputTokens.
        // resolveMainPathMaxOutputTokens returns the full profile budget for
        // non-reasoning models (NEVER the 512-token verdict reserve, which would
        // truncate every visible answer) and sizes UP for native-reasoning
        // profiles so reasoning_content cannot starve the answer. The critic path
        // keeps its own resolveMaxOutputTokens(verdict reserve) — do not reuse it
        // here. The operator's explicit config.maxTokens always takes precedence.
        maxTokens: config.maxTokens ?? (modelProfile
          ? resolveMainPathMaxOutputTokens(modelProfile)
          : undefined),
        // Dynamic max_tokens clamp via closure-ref getters.
        // The assembler sets these refs during transformContext (AFTER wrapper chain is built).
        // When the guard fires (assembled > 0 AND effectiveWindow < Infinity), config-resolver
        // clamps max_tokens per-dispatch. Frontier/mid: refs stay at defaults (0/Infinity) →
        // guard never fires → static maxTokens path is byte-identical.
        getAssembledInputTokens: () => assembledInputTokensRef.current > 0
          ? assembledInputTokensRef.current
          : undefined,
        getEffectiveWindow: () => effectiveWindowRef.current,
        getOutputHeadroom: () => outputHeadroomRef.current,
        temperature: config.temperature ?? (capabilityClass === "nano" ? 0.0 : 0.1),
        // SDK breakpoint on last message must always use "short" (5m).
        // getMessageRetention() now returns "long" after escalation, but the SDK's
        // own last-message breakpoint is the most volatile position.
        // Only override when adaptive retention or explicit config exists; otherwise
        // let the original resolution chain (undefined) flow through so the provider
        // guard in config-resolver.ts skips non-configured agents.
        cacheRetention: () => {
          if (capturedRetention || capturedCacheRetention || config.cacheRetention) {
            return "short" as CacheRetention;
          }
          return undefined;
        },
      },
      deps.logger,
    ),
    createRequestBodyInjector(
      {
        clock: deps.clock,
        getCacheRetention: () => capturedRetention?.getRetention()
          ?? capturedCacheRetention ?? config.cacheRetention,
        getMessageRetention: () => capturedRetention?.getMessageRetention(),
        getSystemPromptBlocks: () => systemPromptBlocks,
        fastMode: config.fastMode,
        storeCompletions: config.storeCompletions,
        getMinTokensOverride: getExecutionMinTokensOverride,
        cacheBreakpointStrategy: config.cacheBreakpointStrategy,
        skipCacheWrite: !!executionOverrides?.spawnPacket,
        cacheWriteTimestamp: executionOverrides?.spawnPacket?.cacheSafeParams?.cacheWriteTimestamp,
        parentCacheRetention: executionOverrides?.spawnPacket?.cacheSafeParams?.cacheRetention,
        getCacheFenceIndex: () => getBreakpointIndex(formattedKey) ?? -1,
        getElapsedSinceLastResponse: () => getElapsedSinceLastResponse(formattedKey, deps.clock),
        getLastResponseTs: () => getLastResponseTs(formattedKey),
        promoteRecentZoneOnSlowCadence:
          config.advancedCacheOptimization?.enableRecentZonePromotion ?? true,
        observationKeepWindow: 25,
        microcompactTokenCeiling: 180_000,
        onContentModification: () => cacheBreakDetector.notifyContentModification(formattedKey),
        onAdaptiveRetentionReset: () => capturedRetention?.reset(),
        sessionKey: formattedKey,
        onBreakpointsPlaced: onBreakpointsPlaced
          ? (highestIdx: number) => onBreakpointsPlaced(highestIdx)
          : undefined,
        onPayloadForCacheDetection: (apiParams, model, headers) => {
          // Read the supportsPromptCache flag from ModelProfile when present.
          // Falls back to isAnthropicFamily for callers that do not yet thread modelProfile.
          if (modelProfile?.supportsPromptCache ?? isAnthropicFamily(model.provider)) {
            const stateInput = extractAnthropicPromptState(
              apiParams,
              model.id,
              capturedRetention?.getRetention(),
              formattedKey,
              agentId ?? "unknown",
              headers,
            );
            cacheBreakDetector.recordPromptState(stateInput);
          }
        },
        getDeferredToolNames: () => {
          return new Set(deferralResult?.deferredNames ?? []);
        },
        getBetaHeaderLatch: () => formattedKey ? getOrCreateSessionLatches(formattedKey).betaHeader : null,
        getRetentionLatch: () => formattedKey ? getOrCreateSessionLatches(formattedKey).retention : null,
        getDeferLoadingLatch: () => formattedKey ? getOrCreateSessionLatches(formattedKey).deferLoading : null,
        // Total MCP tool count for all-deferred detection.
        // MCP tools use "mcp:" or "mcp__" name prefix (see tool-deferral.ts).
        getTotalMcpToolCount: () => {
          if (!deferralResult) return 0;
          const allTools = [...deferralResult.activeTools, ...deferralResult.deferredEntries.map(e => ({ name: e.name }))];
          return allTools.filter(t => t.name.startsWith("mcp:") || t.name.startsWith("mcp__")).length;
        },
        // Feature flag hash for config-aware tool cache invalidation.
        featureFlagHash: computeFeatureFlagHash({ toolPolicy: { mode: config.skills?.toolPolicy?.profile } }),
        // Eviction cooldown getter for breakpoint budget override.
        getEvictionCooldown: () => getEvictionCooldown(formattedKey),
        // Block stability tracker for message breakpoint TTL promotion.
        // Only active for non-subagent sessions (skipCacheWrite=false).
        blockStabilityTracker,
        stabilityThreshold: 3,  // Promote after 3 consecutive identical calls
        // TTL split estimate callback — updates shared mutable object for bridge consumption.
        onTtlSplitEstimate: (estimate) => {
          ttlSplit.cacheWrite5mTokens = estimate.cacheWrite5mTokens;
          ttlSplit.cacheWrite1hTokens = estimate.cacheWrite1hTokens;
        },
        // Per-session call counter — read directly from the cache-break
        // detector's existing per-session state. `upgradeSdkMarkers`
        // gates 5m → 1h promotion on callCount >= 2 so first-turn writes
        // that may be evicted server-side don't pay the 1h premium.
        // The getter runs AFTER `onPayloadForCacheDetection` increments
        // the counter for this turn, so the gate sees the correct value.
        getCallCount: () => cacheBreakDetector.getCallCount(formattedKey),
        // Thread ModelProfile flags so factory.ts and
        // tool-deferral-injection.ts use capability flags instead of
        // provider-string predicates. Optional so callers without a resolved
        // modelProfile (tests, secondary injectors) keep the existing fallback.
        ...(modelProfile !== undefined && { modelProfile }),
      },
      deps.logger,
    ),
  );

  // Gemini cache injector -- mutually exclusive with
  // requestBodyInjector via isGoogleFamily/isAnthropicFamily provider guards.
  if (deps.geminiCacheManager) {
    // Explicit Gemini CachedContent caching is ON by default (GeminiCacheConfigSchema). This
    // fallback only applies when geminiCache is entirely absent from the resolved config, and
    // mirrors that default so the cache floor is never silently lost.
    const geminiCacheConfig = config.geminiCache ?? { enabled: true, maxActiveCaches: 20 };
    wrappers.push(
      createGeminiCacheInjector(
        {
          enabled: geminiCacheConfig.enabled,
          cacheManager: deps.geminiCacheManager,
          sessionKey: formattedKey,
          agentId: agentId ?? "unknown",
          onCacheHit: onGeminiCacheHit
            ? (entry) => onGeminiCacheHit(entry)
            : undefined,
          onPayloadForCacheDetection: (apiParams, model) => {
            if (isGoogleFamily(model.provider)) {
              const stateInput = extractGeminiPromptState(
                apiParams,
                model.id,
                formattedKey,
                agentId ?? "unknown",
              );
              cacheBreakDetector.recordPromptState(stateInput);
            }
          },
        },
        deps.logger,
      ),
    );
  }

  // Conditional JSONL trace wrappers
  if (config.tracing?.enabled) {
    const rawOutputDir = config.tracing.outputDir.replace(/^~/, homedir());
    // Validate trace output directory with safePath
    let outputDir: string;
    try {
      const baseDir = config.tracing.outputDir.startsWith("~") ? homedir() : path.dirname(rawOutputDir);
      const relativePart = config.tracing.outputDir.startsWith("~")
        ? config.tracing.outputDir.slice(2) // strip "~/"
        : path.basename(rawOutputDir);
      outputDir = safePath(baseDir, relativePart);
    } catch {
      deps.logger.warn(
        { outputDir: rawOutputDir, hint: "Trace output directory failed path validation", errorKind: "validation" as ErrorKind },
        "Trace output directory rejected by safePath -- tracing disabled for this session",
      );
      outputDir = ""; // sentinel to skip
    }
    if (outputDir) {
      const sessionSlug = formattedKey.replace(/[^a-zA-Z0-9-_]/g, "_");
      const apiPayloadPath = `${outputDir}/${sessionSlug}.api-payload.jsonl`;

      // Rotation defaults from daemon.logging.tracing
      const traceMaxSize = deps.tracingDefaults?.maxSize ?? "5m";
      const traceMaxFiles = deps.tracingDefaults?.maxFiles ?? 3;

      // api-payload-trace is gated by the per-agent
      // `agents.<name>.tracing.enabled` flag. The cache-trace artifact has
      // its own gate — `diagnostics.cacheTrace.enabled` — handled by the
      // sibling `if (cacheTrace)` block below.
      wrappers.push(
        createApiPayloadTraceWriter(
          { filePath: apiPayloadPath, agentId, sessionId: formattedKey, maxSize: traceMaxSize, maxFiles: traceMaxFiles, clock: deps.clock },
          deps.logger,
        ),
      );

      deps.logger.info(
        { outputDir, apiPayloadPath },
        "JSONL api-payload tracing enabled",
      );
    }
  }

  // Cache-trace artifact (independent of agents.<name>.tracing.enabled).
  // The recorder + EventBus subscription are owned by pi-executor.ts
  // (per-execution lifecycle, alongside the trajectory recorder); this
  // block only adds the StreamFn wrapper to the chain when the recorder
  // is present.
  if (cacheTrace) {
    wrappers.push(buildCacheTraceWrapper(cacheTrace));
  }

  // MUST be the last wrapper pushed (innermost). In `composeStreamWrappers`'
  // reduceRight composition, each wrapper's onPayload calls `existingOnPayload`
  // FIRST and then runs its own logic — so the innermost wrapper's onPayload
  // runs LAST in the chain. That means the stub-filter strips stubs AFTER
  // injectToolDeferral has already seen the payload. The defense against
  // stubs leaking into DEFER-TOOL bookkeeping lives in injectToolDeferral
  // itself (the DEFERRAL_STUB_MARKER guard, tool-deferral-injection.ts).
  // This wrapper's job is to keep stubs out of the FINAL wire payload so
  // they (a) do not consume input tokens, (b) do not enter the Anthropic
  // rendered-tool cache hash, and (c) do not persist into the Gemini
  // CachedContent entry for the cache's whole lifetime.
  wrappers.push(
    createStubFilterInjector(
      {
        getStubToolNames: () => {
          if (!deferralResult?.deferredEntries.length) return new Set<string>();
          return new Set(deferralResult.deferredEntries.map(e => e.name));
        },
      },
      deps.logger,
    ),
  );

  return {
    wrappers,
    contextEngineRef,
    cacheBreakDetector,
    truncationMetaRegistry,
    getTruncationSummary,
    getTurnBudgetSummary,
    capturedRetention,
    ttlSplit,
    assembledInputTokensRef,
    effectiveWindowRef,
    outputHeadroomRef,
  };
}
