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
import type { ComisLogger, ErrorKind } from "@comis/infra";
import type { CacheRetention } from "@mariozechner/pi-ai";
import type { StreamFnWrapper } from "./stream-wrappers/index.js";
import {
  createToolResultSizeBouncer,
  createTurnResultBudgetWrapper,
  createConfigResolver,
  createCacheTraceWriter,
  createApiPayloadTraceWriter,
  createRequestBodyInjector,
  createValidationErrorFormatter,
} from "./stream-wrappers/index.js";
import type { TruncationSummary } from "./stream-wrappers/tool-result-size-bouncer.js";
import type { TurnBudgetSummary } from "./stream-wrappers/turn-result-budget-wrapper.js";
import { resolveToolCallingTemperature } from "./tool-deferral.js";
import { computeFeatureFlagHash } from "./prompt-assembly.js";
import { createTtlGuard, getElapsedSinceLastResponse } from "./ttl-guard.js";
import { isAnthropicFamily, isGoogleFamily } from "../provider/capabilities.js";
import type { TtlSplitEstimate } from "../bridge/pi-event-bridge.js";
import { createGeminiCacheInjector } from "./gemini-cache-injector.js";
import type { GeminiCacheManager } from "./gemini-cache-manager.js";
import { extractAnthropicPromptState, extractGeminiPromptState } from "./cache-break-detection.js";
import { createBlockStabilityTracker } from "./block-stability-tracker.js";
import {
  clearSessionCacheWarm,
  getOrCreateSessionLatches,
  clearSessionLatches,
  getCacheBreakDetector,
  getBreakpointIndex,
  getEvictionCooldown,
} from "./executor-session-state.js";
import type { SessionManager } from "@mariozechner/pi-coding-agent";
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
  modelTier: "small" | "medium" | "large";
  executionOverrides?: ExecutionOverrides;
  deferralResult?: ExcludeDeferralResult;
  systemPromptBlocks?: SystemPromptBlocks;
  agentId?: string;

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
}

// ---------------------------------------------------------------------------
// Setup function
// ---------------------------------------------------------------------------

/**
 * Build the ordered stream wrapper chain for a single execution.
 *
 * Pure function with params object ( extraction pattern). All mutable
 * refs and closure state remain in pi-executor.ts orchestrator scope and are
 * accessed via getter callbacks.
 *
 * @param params - Stream setup parameters including config, deps, and getter callbacks
 * @returns Stream setup result with wrappers array and shared state refs
 */
export function setupStreamWrappers(params: StreamSetupParams): StreamSetupResult {
  const {
    config, deps, formattedKey, sm,
    modelTier, executionOverrides, deferralResult, systemPromptBlocks, agentId,
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
  installMicrocompactionGuard(sm, sm.getSessionDir(), deps.logger, (_toolName) => {
    cacheBreakDetector.notifyContentModification(formattedKey);
  });

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
  const { wrapper: bouncerWrapper, getTruncationSummary } = createToolResultSizeBouncer(
    config.maxToolResultChars,
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

  // Capture adaptive retention into local const to prevent race condition.
  const capturedRetention = getAdaptiveRetention();
  const capturedCacheRetention = getExecutionCacheRetention();

  // Wrapper chain order (outermost first):
  // ttlGuard -> validationErrorFormatter -> toolResultSizeBouncer -> turnResultBudget ->
  //   configResolver -> requestBodyInjector (Anthropic) -> geminiCacheInjector (Google) -> [traceWriters]

  // TTL guard is outermost wrapper
  const onTtlExpiry = () => {
    // Four coordinated resets on TTL expiry
    capturedRetention?.reset();                         // 1. Reset adaptive retention to cold-start
    clearSessionCacheWarm(formattedKey);                // 2. Clear session warm state
    cacheBreakDetector.notifyTtlExpiry(formattedKey);   // 3. Notify detector
    clearSessionLatches(formattedKey);                  // 4. SESS-LATCH: Reset latches for fresh cache cycle
    // Latch idle thinking clear when elapsed > 1h
    if (!executionOverrides?.spawnPacket) {
      const elapsed = getElapsedSinceLastResponse(formattedKey);
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
    }),
    validationErrorFormatter,
    bouncerWrapper,
    turnBudgetWrapper,
    createConfigResolver(
      {
        maxTokens: config.maxTokens,
        temperature: config.temperature ?? resolveToolCallingTemperature(modelTier),
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
        getElapsedSinceLastResponse: () => getElapsedSinceLastResponse(formattedKey),
        observationKeepWindow: 25,
        microcompactTokenCeiling: 180_000,
        onContentModification: () => cacheBreakDetector.notifyContentModification(formattedKey),
        onAdaptiveRetentionReset: () => capturedRetention?.reset(),
        sessionKey: formattedKey,
        onBreakpointsPlaced: onBreakpointsPlaced
          ? (highestIdx: number) => onBreakpointsPlaced(highestIdx)
          : undefined,
        onPayloadForCacheDetection: (apiParams, model, headers) => {
          if (isAnthropicFamily(model.provider)) {
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
      },
      deps.logger,
    ),
  );

  // Gemini cache injector -- mutually exclusive with
  // requestBodyInjector via isGoogleFamily/isAnthropicFamily provider guards.
  if (deps.geminiCacheManager) {
    const geminiCacheConfig = config.geminiCache ?? { enabled: false, maxActiveCaches: 20 };
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
      const cacheTracePath = `${outputDir}/${sessionSlug}.cache-trace.jsonl`;
      const apiPayloadPath = `${outputDir}/${sessionSlug}.api-payload.jsonl`;

      // Rotation defaults from daemon.logging.tracing
      const traceMaxSize = deps.tracingDefaults?.maxSize ?? "5m";
      const traceMaxFiles = deps.tracingDefaults?.maxFiles ?? 3;

      wrappers.push(
        createCacheTraceWriter({ filePath: cacheTracePath, agentId, sessionId: formattedKey, maxSize: traceMaxSize, maxFiles: traceMaxFiles }, deps.logger),
        createApiPayloadTraceWriter({ filePath: apiPayloadPath, agentId, sessionId: formattedKey, maxSize: traceMaxSize, maxFiles: traceMaxFiles }, deps.logger),
      );

      deps.logger.info(
        { outputDir, cacheTracePath, apiPayloadPath },
        "JSONL tracing enabled",
      );
    }
  }

  return {
    wrappers,
    contextEngineRef,
    cacheBreakDetector,
    truncationMetaRegistry,
    getTruncationSummary,
    getTurnBudgetSummary,
    capturedRetention,
    ttlSplit,
  };
}
