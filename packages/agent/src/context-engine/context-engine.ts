// SPDX-License-Identifier: Apache-2.0
/**
 * Context engine factory: layer pipeline with circuit breaker.
 *
 * Creates a `ContextEngine` that runs a pipeline of context layers
 * (starting with the thinking block cleaner) before each LLM call.
 * The engine is assigned to `session.agent.transformContext` in pi-executor.ts.
 *
 * Key behaviors:
 * - When `config.enabled === false`, returns a pass-through (zero overhead)
 * - When the model does not support reasoning, skips the thinking cleaner (zero overhead)
 * - Layer errors are caught, logged WARN, and context passes through unmodified
 * - Circuit breaker disables a layer after consecutive failures for the session
 * - per-layer timing, metrics collection, event emission, INFO summary
 *
 * @module
 */

import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { ContextEngineConfig } from "@comis/core";
import type {
  ContextEngine,
  ContextEngineDeps,
  ContextEngineMetrics,
  ContextLayer,
  LayerCircuitBreaker,
  TokenBudget,
} from "./types.js";
import { LAYER_CIRCUIT_BREAKER_THRESHOLD, CHARS_PER_TOKEN_RATIO, DEFAULT_COMPACTION_PREFIX_ANCHOR_TURNS } from "./constants.js";
import { computeTokenBudget } from "./token-budget.js";
import { createThinkingBlockCleaner } from "./thinking-block-cleaner.js";
import { createReasoningTagStripper } from "./reasoning-tag-stripper.js";
import { createHistoryWindowLayer } from "./history-window.js";
import { createObservationMaskerLayer } from "./observation-masker.js";
import { createLlmCompactionLayer } from "./llm-compaction.js";
import { createRehydrationLayer } from "./rehydration.js";
import { createObjectiveReinforcementLayer } from "./objective-reinforcement.js";
import { createDeadContentEvictorLayer } from "./dead-content-evictor.js";
import { detectRereads } from "./reread-detector.js";
import type { Message } from "@mariozechner/pi-ai";
import { estimateContextCharsWithDualRatio, estimateWithAnchor } from "../safety/token-estimator.js";
import { createDagContextEngine } from "./dag-reconciliation.js";
import type { DagContextEngineDeps } from "./types.js";

// ---------------------------------------------------------------------------
// Layer Circuit Breaker (internal)
// ---------------------------------------------------------------------------

/**
 * Create a per-layer circuit breaker tracking consecutive failures.
 *
 * After `threshold` consecutive failures, the layer is disabled for the
 * remainder of the session. Reset is session-scoped (new session = fresh
 * circuit breakers).
 */
function createLayerCircuitBreaker(
  threshold: number,
  logger: ContextEngineDeps["logger"],
): LayerCircuitBreaker {
  const state = new Map<string, { failures: number; disabled: boolean }>();

  function getOrCreate(name: string) {
    let entry = state.get(name);
    if (!entry) {
      entry = { failures: 0, disabled: false };
      state.set(name, entry);
    }
    return entry;
  }

  return {
    isDisabled(layerName: string): boolean {
      return getOrCreate(layerName).disabled;
    },

    recordSuccess(layerName: string): void {
      const entry = getOrCreate(layerName);
      entry.failures = 0;
    },

    recordFailure(layerName: string): void {
      const entry = getOrCreate(layerName);
      entry.failures++;
      if (entry.failures >= threshold) {
        entry.disabled = true;
        logger.warn(
          {
            layerName,
            consecutiveFailures: entry.failures,
            hint: `Layer disabled after ${entry.failures} consecutive failures; will remain disabled for this session`,
            errorKind: "dependency" as const,
          },
          "Context engine layer circuit breaker tripped",
        );
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Layer Pipeline Runner (internal, instrumented)
// ---------------------------------------------------------------------------

/** Per-layer timing data returned by the instrumented runLayer. */
interface LayerMetric {
  name: string;
  durationMs: number;
  messagesIn: number;
  messagesOut: number;
}

/**
 * Run a single layer with error isolation, circuit breaker integration,
 * and per-layer timing instrumentation.
 *
 * If the layer is disabled by the circuit breaker, it is skipped (returns
 * messages unchanged). If the layer throws, the error is caught, logged WARN,
 * recorded as a failure, and messages pass through unmodified.
 */
async function runLayer(
  layer: ContextLayer,
  messages: AgentMessage[],
  budget: TokenBudget,
  breaker: LayerCircuitBreaker,
  logger: ContextEngineDeps["logger"],
): Promise<{ messages: AgentMessage[]; layerMetric: LayerMetric; errored: boolean }> {
  const messagesIn = messages.length;
  if (breaker.isDisabled(layer.name)) {
    return {
      messages,
      layerMetric: { name: layer.name, durationMs: 0, messagesIn, messagesOut: messagesIn },
      errored: false,
    };
  }

  const start = Date.now();
  try {
    const result = await layer.apply(messages, budget);
    breaker.recordSuccess(layer.name);
    const durationMs = Date.now() - start;

    // Only log layers that actually modify messages
    if (messagesIn !== result.length) {
      logger.debug(
        { layerName: layer.name, messagesIn, messagesOut: result.length, durationMs },
        "Context engine layer applied",
      );
    }

    return {
      messages: result,
      layerMetric: { name: layer.name, durationMs, messagesIn, messagesOut: result.length },
      errored: false,
    };
  } catch (err) {
    breaker.recordFailure(layer.name);
    const durationMs = Date.now() - start;
    logger.warn(
      {
        layerName: layer.name,
        err,
        durationMs,
        hint: `Context engine layer '${layer.name}' failed; continuing with unmodified context`,
        errorKind: "dependency" as const,
      },
      "Context engine layer error",
    );
    return {
      messages,
      layerMetric: { name: layer.name, durationMs, messagesIn, messagesOut: messagesIn },
      errored: true,
    };
  }
}

// ---------------------------------------------------------------------------
// Callback State Snapshot (defeats TS closure narrowing)
// ---------------------------------------------------------------------------

/**
 * Read callback state at a point in time. TypeScript narrows closure-mutated
 * variables to `never` because it cannot see async callback assignments.
 * This indirection breaks the narrowing chain.
 */
function getCallbackSnapshot(state: {
  masker: { maskedCount: number; totalChars: number; persistedToDisk: boolean } | null;
  thinking: { blocksRemoved: number; cacheFenceIndex?: number; messagesProtected?: number; totalMessages?: number } | null;
  reasoningTags: { tagsStripped: number } | null;
  compaction: { fallbackLevel: 1 | 2 | 3; attempts: number; originalMessages: number; keptMessages: number } | null;
  rehydration: { sectionsInjected: number; filesInjected: number; overflowStripped: boolean } | null;
  overflow: { contextChars: number; budgetChars: number; recoveryAction: string } | null;
  evictor: { evictedCount: number; evictedChars: number; categories: Record<string, number> } | null;
}) {
  return {
    masker: state.masker,
    thinking: state.thinking,
    reasoningTags: state.reasoningTags,
    compaction: state.compaction,
    rehydration: state.rehydration,
    overflow: state.overflow,
    evictor: state.evictor,
  };
}

// ---------------------------------------------------------------------------
// Context Engine Factory
// ---------------------------------------------------------------------------

/**
 * Create a context engine with the given config and dependencies.
 *
 * @param config - Context engine config (enabled, thinkingKeepTurns)
 * @param deps - Dependencies (logger, lazy model getter)
 * @returns ContextEngine with a `transformContext` function for the SDK hook
 */
export function createContextEngine(
  config: ContextEngineConfig,
  deps: ContextEngineDeps,
): ContextEngine {
  // Pass-through when disabled (per locked decision: zero overhead)
  if (!config.enabled) {
    return { transformContext: async (msgs) => msgs, lastBreakpointIndex: undefined, lastTrimOffset: 0 };
  }

  // DAG mode branch -- entirely different layer pipeline
  if (config.version === "dag") {
    const dagDeps = deps as DagContextEngineDeps;
    if (dagDeps.contextStore && dagDeps.conversationId) {
      return createDagContextEngine(config, dagDeps);
    }
    // Fallback: DAG mode requested but deps missing -- log WARN and fall through to pipeline
    deps.logger.warn(
      {
        hint: "DAG mode configured but contextStore or conversationId not provided; falling back to pipeline mode",
        errorKind: "config" as const,
      },
      "DAG context engine deps missing",
    );
  }

  // Check model capabilities to determine which layers to activate.
  // The model getter is lazy and called once at creation time to build
  // the layer array. For model changes mid-session (cycleModel), the
  // transformContext closure calls getModel() on each invocation to
  // determine if the thinking cleaner should run.
  const model = deps.getModel();

  // --- Metrics accumulation state (closure-scoped) ---
  // Using a mutable container with explicit interface to prevent TS closure narrowing to `never`.
  interface CallbackState {
    masker: { maskedCount: number; totalChars: number; persistedToDisk: boolean } | null;
    thinking: { blocksRemoved: number; cacheFenceIndex?: number; messagesProtected?: number; totalMessages?: number } | null;
    reasoningTags: { tagsStripped: number } | null;
    compaction: { fallbackLevel: 1 | 2 | 3; attempts: number; originalMessages: number; keptMessages: number } | null;
    rehydration: { sectionsInjected: number; filesInjected: number; overflowStripped: boolean } | null;
    overflow: { contextChars: number; budgetChars: number; recoveryAction: string } | null;
    evictor: { evictedCount: number; evictedChars: number; categories: Record<string, number> } | null;
  }
  const callbackState: CallbackState = {
    masker: null,
    thinking: null,
    reasoningTags: null,
    compaction: null,
    rehydration: null,
    overflow: null,
    evictor: null,
  };

  // Build layers array based on model capabilities
  const layers: ContextLayer[] = [];

  // Thinking block cleaner: skip entirely for non-thinking providers
  // (zero overhead per locked decision)
  let thinkingCleaner: ReturnType<typeof createThinkingBlockCleaner> | undefined;
  if (model.reasoning) {
    thinkingCleaner = createThinkingBlockCleaner(
      config.thinkingKeepTurns,
      (stats) => { callbackState.thinking = stats; },
      deps.getThinkingKeepTurnsOverride,  // Idle thinking clear override
    );
    layers.push(thinkingCleaner);
  }

  // Reasoning tag stripper: always active (not gated by model.reasoning) because
  // inline tags come from OTHER providers' responses persisted in session history --
  // the current model's capabilities are irrelevant.
  layers.push(createReasoningTagStripper(
    (stats) => { callbackState.reasoningTags = stats; },
  ));

  // History window: always active when context engine is enabled (default 15 turns).
  // Operates on the already-resolved message array from buildSessionContext().
  const historyTurns = config.historyTurns ?? 15;
  if (historyTurns > 0) {
    layers.push(createHistoryWindowLayer(
      {
        historyTurns,
        historyTurnOverrides: config.historyTurnOverrides,
        channelType: deps.channelType,
      },
      () => { /* history window stats tracked via runLayer messagesIn/Out */ },
    ));
  }

  // Dead content evictor: removes superseded tool results.
  // Runs after history window to operate on the already-trimmed message set.
  // Runs before observation masker so masker operates on smaller context.
  const evictionMinAge = config.evictionMinAge ?? 15;
  layers.push(createDeadContentEvictorLayer(
    { evictionMinAge },
    (stats) => { callbackState.evictor = stats; },
  ));

  // Observation masker: masks old tool results beyond the keep window.
  // Always active when context engine is enabled. The threshold check inside the
  // masker handles short-session bypass.
  // Phase 8: Three-tier masking (protected/standard/ephemeral) with per-tier counters.
  const observationKeepWindow = config.observationKeepWindow ?? 25;
  const observationTriggerChars = config.observationTriggerChars ?? 120_000;
  const ephemeralKeepWindow = config.ephemeralKeepWindow;
  layers.push(createObservationMaskerLayer(
    { observationKeepWindow, observationTriggerChars, observationDeactivationChars: config.observationDeactivationChars, ephemeralKeepWindow },
    deps.getSessionManager,
    (stats) => { callbackState.masker = stats; if (stats.maskedCount > 0) deps.onContentModified?.(); },
  ));

  // LLM compaction: triggers when context > 85% of window after masking.
  // Requires CompactionLayerDeps to be present in ContextEngineDeps.
  const compactionEnabled = !!deps.getCompactionDeps;
  if (deps.getCompactionDeps) {
    const compactionDeps = deps.getCompactionDeps();
    const cooldownTurns = config.compactionCooldownTurns ?? 5;
    const prefixAnchorTurns = config.compactionPrefixAnchorTurns ?? DEFAULT_COMPACTION_PREFIX_ANCHOR_TURNS;
    layers.push(createLlmCompactionLayer(
      { compactionCooldownTurns: cooldownTurns, compactionPrefixAnchorTurns: prefixAnchorTurns },
      {
        ...compactionDeps,
        onCompacted: (stats) => { callbackState.compaction = stats; },
        getTokenAnchor: deps.getTokenAnchor,
      },
    ));
  }

  // Post-compaction rehydration: injects AGENTS.md sections, files, resume instruction.
  // Runs after compaction layer to detect freshly compacted context.
  const rehydrationEnabled = !!deps.getRehydrationDeps;
  if (deps.getRehydrationDeps) {
    const rehydrationDeps = deps.getRehydrationDeps();
    layers.push(createRehydrationLayer({
      ...rehydrationDeps,
      onRehydrated: (stats) => { callbackState.rehydration = stats; },
      onOverflow: (stats) => { callbackState.overflow = stats; },
    }));
  }

  // Objective reinforcement -- re-injects objective after compaction.
  // Must be the final layer so it runs after compaction and rehydration.
  if (deps.objective) {
    layers.push(createObjectiveReinforcementLayer(deps.objective));
  }

  // If no layers are active, return a pass-through
  if (layers.length === 0) {
    return { transformContext: async (msgs) => msgs, lastBreakpointIndex: undefined, lastTrimOffset: 0 };
  }

  // Create session-scoped circuit breaker
  const breaker = createLayerCircuitBreaker(LAYER_CIRCUIT_BREAKER_THRESHOLD, deps.logger);

  // Log startup info (per locked decision)
  deps.logger.info(
    {
      thinkingKeepTurns: config.thinkingKeepTurns,
      historyTurns,
      evictionMinAge,
      observationKeepWindow,
      ephemeralKeepWindow: ephemeralKeepWindow ?? 10,
      observationTriggerChars,
      compactionEnabled,
      compactionCooldownTurns: config.compactionCooldownTurns ?? 5,
      compactionPrefixAnchorTurns: config.compactionPrefixAnchorTurns ?? DEFAULT_COMPACTION_PREFIX_ANCHOR_TURNS,
      rehydrationEnabled,
      channelType: deps.channelType,
      layerCount: layers.length,
    },
    "Context engine active",
  );

  const engine: ContextEngine = {
    // Initialized to undefined (no fence). Set by executor after
    // each LLM call to track the highest cache breakpoint position.
    lastBreakpointIndex: undefined,
    // Number of messages trimmed by history-window in the most recent
    // pipeline run. Used to translate post-CE breakpoint indices back to pre-CE space.
    lastTrimOffset: 0,
    // Expose thinking cleaner ceiling control for cache stability.
    // Delegates to the cleaner's setAssistantCountCeiling when reasoning model active.
    setThinkingCeiling: thinkingCleaner
      ? (n: number | undefined) => thinkingCleaner!.setAssistantCountCeiling(n)
      : undefined,
    async transformContext(messages: AgentMessage[]): Promise<AgentMessage[]> {
      const pipelineStart = Date.now();

      // Reset callback state for this invocation
      callbackState.masker = null;
      callbackState.thinking = null;
      callbackState.reasoningTags = null;
      callbackState.compaction = null;
      callbackState.rehydration = null;
      callbackState.overflow = null;
      callbackState.evictor = null;

      // Estimate initial context tokens (best-effort; pathological messages may throw)
      // Use API-grounded anchor when available for accurate estimation
      let tokensLoaded = 0;
      try {
        /* eslint-disable @typescript-eslint/no-explicit-any */
        const initialChars = estimateContextCharsWithDualRatio(messages as any);
        /* eslint-enable @typescript-eslint/no-explicit-any */
        const charBasedTokens = Math.ceil(initialChars / CHARS_PER_TOKEN_RATIO);
        const anchor = deps.getTokenAnchor?.() ?? null;
        tokensLoaded = estimateWithAnchor(anchor, messages as unknown as Message[], charBasedTokens);
      } catch {
        // Estimation failure should not block the pipeline
      }

      // Get current model capabilities (lazy, handles model cycling)
      const currentModel = deps.getModel();

      // Compute token budget for this pipeline run
      // Pass lastBreakpointIndex as cacheFenceIndex so layers can skip cached messages
      const rawFence = engine.lastBreakpointIndex;
      const systemTokensEstimate = deps.getSystemTokensEstimate?.() ?? 0;
      const budget = computeTokenBudget(currentModel.contextWindow, systemTokensEstimate, rawFence ?? -1);

      // Reset lastTrimOffset at the start of each pipeline run.
      // Only overwritten inside history-window block if trimming occurs.
      engine.lastTrimOffset = 0;

      // Run each layer in order, collecting per-layer metrics
      let result = messages;
      const layerMetrics: LayerMetric[] = [];
      let layerErrors = 0;
      for (const layer of layers) {
        const messagesBeforeLayer = result.length;
        const outcome = await runLayer(layer, result, budget, breaker, deps.logger);
        result = outcome.messages;
        layerMetrics.push(outcome.layerMetric);
        if (outcome.errored) layerErrors++;

        // After history-window trims messages from the front,
        // adjust cacheFenceIndex so subsequent layers see correct indices.
        // Without this, fence >= array length makes all messages appear
        // protected, causing layers 3+ to become no-ops.
        if (layer.name === "history-window" && result.length < messagesBeforeLayer) {
          const trimmedCount = messagesBeforeLayer - result.length;
          budget.cacheFenceIndex = Math.max(-1, budget.cacheFenceIndex - trimmedCount);
          engine.lastTrimOffset = trimmedCount;
        }
      }

      // Estimate result context for budget utilization (best-effort)
      let resultChars = 0;
      try {
        /* eslint-disable @typescript-eslint/no-explicit-any */
        resultChars = estimateContextCharsWithDualRatio(result as any);
        /* eslint-enable @typescript-eslint/no-explicit-any */
      } catch {
        // Estimation failure should not block the pipeline
      }
      const resultTokens = Math.ceil(resultChars / CHARS_PER_TOKEN_RATIO);
      const budgetUtilization = budget.availableHistoryTokens > 0
        ? resultTokens / budget.availableHistoryTokens
        : 0;

      // Snapshot callback state -- using getters to defeat TS closure narrowing
      const snap = getCallbackSnapshot(callbackState);

      // Compaction replaces the entire message array, so the old
      // fence position is invalid. Instead of resetting to -1 (no protection),
      // set a conservative fence at 1/3 of the compacted message array. This preserves
      // prefix stability for microcompaction: messages in the first third of the
      // compacted context are likely the system-adjacent prefix that's still cached.
      if (snap.compaction !== null) {
        const prevFence = engine.lastBreakpointIndex;
        const compactedLength = Array.isArray(snap.compaction) ? snap.compaction.length : 0;
        engine.lastBreakpointIndex = compactedLength > 0
          ? Math.max(0, Math.floor(compactedLength / 3))
          : -1;
        engine.lastTrimOffset = 0;
        if (prevFence !== undefined && prevFence >= 0) {
          deps.logger.debug(
            { previousFence: prevFence, newFence: engine.lastBreakpointIndex, compactedLength },
            "Cache fence adjusted after compaction",
          );
        }
        // Signal anchor invalidation so executor resets closure-scoped anchor to null.
        // After compaction, message count no longer matches the anchor's recorded count.
        deps.onAnchorReset?.();
      }

      // --- Session depth counting (best-effort, try/catch) ---
      let sessionDepth = 0;
      let sessionToolResults = 0;
      /* eslint-disable @typescript-eslint/no-explicit-any */
      let fileEntries: unknown[] | null = null;
      try {
        if (deps.getSessionManager) {
          const sm = deps.getSessionManager() as any;
          if (sm && Array.isArray(sm.fileEntries)) {
            fileEntries = sm.fileEntries;
            sessionDepth = fileEntries!.length;
            for (const entry of fileEntries!) {
              if (
                entry &&
                typeof entry === "object" &&
                (entry as any).type === "message" &&
                (entry as any).message?.role === "toolResult"
              ) {
                sessionToolResults++;
              }
            }
          }
        }
      } catch {
        // Session manager access failure should not block the pipeline
      }
      /* eslint-enable @typescript-eslint/no-explicit-any */

      // --- Re-read detection ---
      let rereadResult = { rereadCount: 0, rereadTools: [] as string[] };
      try {
        if (fileEntries) {
          rereadResult = detectRereads(result, fileEntries);
        }
      } catch {
        // Re-read detection failure should not block the pipeline
      }

      // Build metrics
      const tokensMasked = snap.masker ? Math.ceil(snap.masker.totalChars / CHARS_PER_TOKEN_RATIO) : 0;
      const tokensCompacted = snap.compaction
        ? Math.max(0, tokensLoaded - Math.ceil(resultChars / CHARS_PER_TOKEN_RATIO))
        : 0;
      const tokensEvicted = snap.evictor ? Math.ceil(snap.evictor.evictedChars / CHARS_PER_TOKEN_RATIO) : 0;
      const durationMs = Date.now() - pipelineStart;

      const metrics: ContextEngineMetrics = {
        thinkingBlocksRemoved: snap.thinking?.blocksRemoved ?? 0,
        layerErrors,
        budgetUtilization,
        tokensLoaded,
        tokensMasked,
        tokensCompacted,
        cacheHitTokens: 0,
        cacheWriteTokens: 0,
        cacheMissTokens: 0,
        durationMs,
        layers: layerMetrics,
        // Pipeline observability
        tokensEvicted,
        evictionCategories: snap.evictor?.categories ?? {},
        rereadCount: rereadResult.rereadCount,
        rereadTools: rereadResult.rereadTools,
        sessionDepth,
        sessionToolResults,
      };

      // Store metrics on the engine instance
      engine.lastMetrics = metrics;

      // Emit events via eventBus (if provided)
      if (deps.eventBus) {
        const agentId = deps.agentId ?? "";
        const sessionKey = deps.sessionKey ?? "";
        const timestamp = Date.now();

        if (snap.masker && snap.masker.maskedCount > 0) {
          deps.eventBus.emit("context:masked", {
            agentId,
            sessionKey,
            maskedCount: snap.masker.maskedCount,
            totalChars: snap.masker.totalChars,
            persistedToDisk: snap.masker.persistedToDisk,
            timestamp,
          });
        }

        if (snap.compaction) {
          deps.eventBus.emit("context:compacted", {
            agentId,
            sessionKey,
            fallbackLevel: snap.compaction.fallbackLevel,
            attempts: snap.compaction.attempts,
            originalMessages: snap.compaction.originalMessages,
            keptMessages: snap.compaction.keptMessages,
            timestamp,
          });
        }

        if (snap.rehydration && (snap.rehydration.sectionsInjected + snap.rehydration.filesInjected > 0)) {
          deps.eventBus.emit("context:rehydrated", {
            agentId,
            sessionKey,
            sectionsInjected: snap.rehydration.sectionsInjected,
            filesInjected: snap.rehydration.filesInjected,
            overflowStripped: snap.rehydration.overflowStripped,
            timestamp,
          });
        }

        if (snap.overflow) {
          deps.eventBus.emit("context:overflow", {
            agentId,
            sessionKey,
            contextTokens: Math.ceil(snap.overflow.contextChars / CHARS_PER_TOKEN_RATIO),
            budgetTokens: Math.ceil(snap.overflow.budgetChars / CHARS_PER_TOKEN_RATIO),
            recoveryAction: snap.overflow.recoveryAction,
            timestamp,
          });
        }

        if (snap.evictor && snap.evictor.evictedCount > 0) {
          deps.eventBus.emit("context:evicted", {
            agentId,
            sessionKey,
            evictedCount: snap.evictor.evictedCount,
            evictedChars: snap.evictor.evictedChars,
            categories: snap.evictor.categories,
            timestamp,
          });
        }

        // Re-read event -- only when duplicates detected
        if (rereadResult.rereadCount > 0) {
          deps.eventBus.emit("context:reread", {
            agentId,
            sessionKey,
            rereadCount: rereadResult.rereadCount,
            rereadTools: rereadResult.rereadTools,
            timestamp,
          });
        }

        // Pipeline summary event -- always emitted
        deps.eventBus.emit("context:pipeline", {
          agentId,
          sessionKey,
          tokensLoaded: metrics.tokensLoaded,
          tokensEvicted: metrics.tokensEvicted,
          tokensMasked: metrics.tokensMasked,
          tokensCompacted: metrics.tokensCompacted,
          thinkingBlocksRemoved: metrics.thinkingBlocksRemoved,
          budgetUtilization: metrics.budgetUtilization,
          evictionCategories: metrics.evictionCategories,
          rereadCount: metrics.rereadCount,
          rereadTools: metrics.rereadTools,
          sessionDepth: metrics.sessionDepth,
          sessionToolResults: metrics.sessionToolResults,
          cacheFenceIndex: budget.cacheFenceIndex,
          durationMs: metrics.durationMs,
          layerCount: layers.length,
          // Per-layer timing for waterfall visualization
          layers: metrics.layers,
          timestamp,
        });
      }

      // DEBUG summary: fires N times per request (demoted from INFO)
      deps.logger.debug(
        {
          tokensLoaded: metrics.tokensLoaded,
          tokensEvicted: metrics.tokensEvicted,
          tokensMasked: metrics.tokensMasked,
          tokensCompacted: metrics.tokensCompacted,
          thinkingBlocksRemoved: metrics.thinkingBlocksRemoved,
          // Thinking block cleaner respected cache fence
          ...(snap.thinking?.cacheFenceIndex !== undefined && {
            thinkingFenceProtected: snap.thinking.messagesProtected,
            thinkingFenceIndex: snap.thinking.cacheFenceIndex,
          }),
          ...(snap.reasoningTags && snap.reasoningTags.tagsStripped > 0 ? { reasoningTagsStripped: snap.reasoningTags.tagsStripped } : {}),
          budgetUtilization: Math.round(metrics.budgetUtilization * 100) / 100,
          evictionCategories: metrics.evictionCategories,
          rereadCount: metrics.rereadCount,
          rereadTools: metrics.rereadTools,
          sessionDepth: metrics.sessionDepth,
          sessionToolResults: metrics.sessionToolResults,
          cacheFenceIndex: budget.cacheFenceIndex, // -1 = no fence, >= 0 = messages at/below are protected
          layerCount: layers.length,
          durationMs: metrics.durationMs,
        },
        "Context engine pipeline complete",
      );

      return result;
    },
  };

  return engine;
}
