// SPDX-License-Identifier: Apache-2.0
/**
 * PiEventBridge: Maps pi-coding-agent AgentSessionEvent stream to Comis's
 * TypedEventBus events and enforces safety controls (step counter, budget guard).
 *
 * This is the core event translation layer between pi-coding-agent and Comis.
 * PiExecutor subscribes this bridge to the AgentSession and uses
 * getResult() to extract execution stats.
 *
 * @module
 */

import { shouldCompact } from "@mariozechner/pi-coding-agent";
import type { AgentSessionEvent } from "@mariozechner/pi-coding-agent";
import type { AssistantMessage } from "@mariozechner/pi-ai";
import {
  formatSessionKey,
  sanitizeLogString,
  type SessionKey,
  type TypedEventBus,
  type MemoryPort,
  type MemoryEntry,
  type ModelOperationType,
} from "@comis/core";
import type { ComisLogger } from "@comis/infra";
import { suppressError } from "@comis/shared";
import { randomUUID } from "node:crypto";
import { resolveModelPricing } from "../model/model-catalog.js";
import { getCacheProviderInfo } from "../executor/cache-usage-helpers.js";
import { sanitizeMcpToolNameForAnalytics } from "../executor/cache-break-detection.js";
import type { BudgetGuard } from "../budget/budget-guard.js";
import type { CostTracker } from "../budget/cost-tracker.js";
import type { StepCounter } from "../executor/step-counter.js";
import type { CircuitBreaker } from "../safety/circuit-breaker.js";
import type { ToolRetryBreaker } from "../safety/tool-retry-breaker.js";
import type { ProviderHealthMonitor } from "../safety/provider-health-monitor.js";
import type { ContextWindowGuard, ContextUsageData } from "../safety/context-window-guard.js";
import type { ExecutionResult } from "../executor/types.js";
import type { ExecutionPlan } from "../planner/types.js";
import { extractPlanFromResponse } from "../planner/plan-extractor.js";
import { extractMcpServerName, classifyMcpErrorType, sanitizeToolArgs, extractErrorText } from "./bridge-event-handlers.js";
import { createBridgeMetrics, buildBridgeResult } from "./bridge-metrics.js";
import { checkStepLimit, emitStepLimitAbort, checkBudgetLimit, emitBudgetAbort, checkBudgetTrajectory, checkContextWindow, emitContextAbort, checkCircuitBreaker, emitCircuitBreakerAbort } from "./bridge-safety-controls.js";
import {
  computeThinkingBlockHashes,
  diffThinkingBlocksAgainstPersisted,
  WIRE_DIFF_HINT_FILE_MISSING,
  WIRE_DIFF_HINT_NOT_FOUND,
  type ThinkingBlockHash,
} from "./thinking-block-hash-invariant.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Per-call TTL split estimate, populated by requestBodyInjector's onPayload.
 *  Shared mutable object — written by the stream wrapper, read by the bridge. */
export interface TtlSplitEstimate {
  cacheWrite5mTokens: number;
  cacheWrite1hTokens: number;
}

/** Dependencies required by the PiEventBridge. */
export interface PiEventBridgeDeps {
  eventBus: TypedEventBus;
  budgetGuard: BudgetGuard;
  costTracker: CostTracker;
  stepCounter: StepCounter;
  circuitBreaker: CircuitBreaker;
  sessionKey: SessionKey;
  agentId: string;
  channelId: string;
  executionId: string;
  provider: string;
  model: string;
  /** Operation type for cost attribution. */
  operationType: ModelOperationType;
  logger: ComisLogger;
  /** Optional memory port for flushing compaction summaries to long-term memory. */
  memoryPort?: MemoryPort;
  /** Called with streaming text deltas for real-time response forwarding. */
  onDelta?: (delta: string) => void;
  /** Called when a safety control triggers -- PiExecutor uses this to call session.abort(). */
  onAbort?: () => void;
  /** SDK context usage accessor -- returns live context metrics from AgentSession. */
  getContextUsage?: () => ContextUsageData | undefined;
  /** Context window guard for percent-based warn/block checks. */
  contextGuard?: ContextWindowGuard;
  /** Compaction settings for shouldCompact() check. When provided, compaction:recommended events fire. */
  compactionSettings?: { enabled: boolean; reserveTokens: number; keepRecentTokens: number };
  /** Optional provider health monitor for cross-agent failure aggregation. */
  providerHealth?: ProviderHealthMonitor;
  /** Called when a tool execution completes -- used by pi-executor to reset prompt timeout. */
  onToolExecutionEnd?: () => void;
  /** Returns current model ID for per-turn pricing resolution. Updated on manual /model switch. */
  getCurrentModel?: () => string;
  /** Callback to record cache reads for adaptive retention escalation. */
  onCacheReads?: (tokens: number) => void;
  /** Callback to record a completed turn with cache write token count.
   *  Enables adaptive retention fast-path escalation for large system prompts. */
  onTurnWithCacheWrite?: (cacheWriteTokens: number) => void;
  /** Callback fired when cache break detection finds a break event.
   *  Receives the full CacheBreakEvent. PiExecutor uses this to trigger
   *  coordinated reset on server eviction. */
  onCacheBreakDetected?: (event: import("../executor/cache-break-detection.js").CacheBreakEvent) => void;
  /** Decrement eviction cooldown counter each turn (unconditional). */
  decrementEvictionCooldown?: () => void;
  /** Callback to record per-turn cache savings for cost gate evaluation.
   *  Receives the per-turn savedVsUncached value (can be negative). */
  onTurnCacheSavings?: (savedUsd: number) => void;
  /** Registry of per-tool truncation metadata populated by stream wrappers.
   *  Returns truncation info for a tool call, or undefined if no truncation occurred. */
  getTruncationMeta?: (toolCallId: string) => { truncated: boolean; fullChars: number; returnedChars: number } | undefined;
  /** Mutable reference to the SEP execution plan for step tracking. */
  executionPlan?: { current: ExecutionPlan | undefined };
  /** SEP config for mid-loop plan extraction. Required when executionPlan is provided. */
  sepConfig?: {
    maxSteps: number;
    minSteps: number;
  };
  /** Original user message text (truncated) for SEP plan request field. */
  sepMessageText?: string;
  /** Execution start timestamp for SEP timing metrics. */
  sepExecutionStartMs?: number;
  /** Cache break detection Phase 2 callback. Returns CacheBreakEvent if break detected. */
  checkCacheBreak?: (input: { sessionKey: string; provider: string; cacheReadTokens: number; cacheWriteTokens: number; totalInputTokens: number; apiError?: boolean }) => import("../executor/cache-break-detection.js").CacheBreakEvent | null;
  /** Called on each turn_end with the per-turn usage.input tokens.
   *  Used by pi-executor to update the TokenAnchor for API-grounded estimation. */
  onTurnUsage?: (inputTokens: number) => void;
  /** Per-execution token budget cap for trajectory warning. Omit to disable trajectory analysis. */
  perExecutionBudgetCap?: number;
  /** Mutable ref for budget warning state shared with prompt runner. */
  budgetWarningRef?: { current: boolean };
  /** Tool retry breaker for recording tool call success/failure. */
  toolRetryBreaker?: ToolRetryBreaker;
  /** Graph ID for cache write signal emission. Set only for graph subagents. */
  graphId?: string;
  /** Graph node ID for cache write signal emission. Set only for graph subagents. */
  nodeId?: string;
  /** + 49-01: Shared mutable TTL split estimate. Populated by request-body-injector
   *  on each API call, read by the bridge on turn_end for per-TTL cost calculation.
   *  The bridge normalizes these estimates against the actual SDK-reported cacheWriteTokens. */
  ttlSplit?: TtlSplitEstimate;
  /** 260428-hoy pre-call hook: invoked once per `turn_start` event, BEFORE
   *  pi-ai serializes the next request. The closure (defined in pi-executor)
   *  walks `session.agent.state.messages`, asserts the cross-turn
   *  hash-invariant per assistant message with a stored hash entry (logs
   *  ERROR on mutation), then runs the canonical-restore helper against the
   *  canonical store (heals any mutation in-place by writing the result
   *  back to `session.agent.state.messages`). The return value is unused by
   *  the bridge -- the side effect is the heal write-back. Optional: when
   *  omitted, both the diagnostic and the heal are silently disabled
   *  (e.g., unit tests that don't drive a full agent session). */
  getSessionMessages?: () => ReadonlyArray<unknown> | undefined;
  /** 260428-iag wire-edge diagnostic: returns the absolute path to the
   *  per-session JSONL on disk. The bridge invokes this only when the LLM
   *  error path detects the signed-replay rejection signature, then
   *  diff'd against the persisted canonical to surface mutation that
   *  occurred AFTER the bridge's restoration hook. Optional — when
   *  omitted, the wire-edge diagnostic is a silent no-op. */
  getSessionJsonlPath?: () => string | null;
}

/** Estimated cost payload for a timed-out API request. */
export interface GhostCostEstimate {
  inputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  costUsd: number;
}

/** Result of createPiEventBridge -- a listener function and a result accessor. */
export interface PiEventBridgeResult {
  /** Event listener to subscribe to AgentSession events. */
  listener: (event: AgentSessionEvent) => void;
  /** Returns accumulated execution stats (includes last known context usage and duration breakdown). */
  getResult: () => Partial<ExecutionResult> & { contextUsage?: ContextUsageData; textEmitted?: boolean; cumulativeLlmDurationMs?: number; cumulativeToolDurationMs?: number; cumulativeToolWallclockMs?: number; toolCallHistory?: string[]; lastActiveToolName?: string; lastLlmErrorMessage?: string; failedToolCalls?: number; failedTools?: string[]; toolExecResults?: Array<{ toolName: string; success: boolean; durationMs: number; errorText?: string }>; turnCount?: number; lastStopReason?: string; cacheWrite5mTokens?: number; cacheWrite1hTokens?: number; sessionCostUsd?: number; sessionCacheSavedUsd?: number; thinkingTokens?: number; budgetWarningEmitted?: boolean };
  /** Accumulate estimated cost from a timed-out API request. */
  addGhostCost: (estimated: GhostCostEstimate) => void;
  /** 260428-hoy: ReadonlyMap views of the per-responseId hash store and
   *  canonical-snapshot store, both populated at stream-close in lockstep.
   *  The executor's pre-LLM-call closure reads both stores to drive the
   *  hash-invariant assertion plus the canonical restore helper. Returns
   *  ReadonlyMap views to preserve internal-state encapsulation -- the
   *  underlying `m` object is never exported. */
  getThinkingBlockStores: () => {
    hashes: ReadonlyMap<string, ReadonlyArray<ThinkingBlockHash>>;
    canonical: ReadonlyMap<string, ReadonlyArray<unknown>>;
  };
}

// Re-export helper functions for backward compatibility with existing imports
export { sanitizeToolArgs, extractErrorText } from "./bridge-event-handlers.js";

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a PiEventBridge that translates AgentSessionEvent to TypedEventBus
 * events and enforces safety controls.
 *
 * The returned listener handles all AgentSessionEvent types:
 * - message_update (text_delta) -> onDelta callback
 * - tool_execution_start -> start time tracking + DEBUG log (no event emission)
 * - tool_execution_end -> step counter + tool:executed event + safety check
 * - turn_end -> budget guard + cost tracker + observability:token_usage event
 * - compaction_start -> INFO log + compaction:started event
 * - compaction_end -> INFO/WARN log + compaction:flush event
 * - error (from turn_end with stopReason) -> circuit breaker failure
 */
export function createPiEventBridge(deps: PiEventBridgeDeps): PiEventBridgeResult {
  // Internal accumulation state (managed by bridge-metrics module)
  const m = createBridgeMetrics();

  const listener = (event: AgentSessionEvent): void => {
    try {
      switch (event.type) {
        // -----------------------------------------------------------------
        // Streaming text deltas
        // -----------------------------------------------------------------
        case "message_update": {
          const ame = (event as { assistantMessageEvent?: { type: string; delta?: string } }).assistantMessageEvent;
          if (ame && (ame.type === "text_delta" || ame.type === "thinking_delta")) {
            if (ame.type === "text_delta") {
              // Track that visible text was produced in some turn.
              // thinking_delta intentionally excluded — empty-final-turn detection
              // depends on this flag reflecting user-visible text only.
              m.textEmitted = true;
            }
            if (deps.onDelta && typeof ame.delta === "string") {
              try {
                deps.onDelta(ame.delta);
              } catch {
                // Never abort agent due to streaming callback error
              }
            }
          }
          break;
        }

        // -----------------------------------------------------------------
        // Tool execution lifecycle
        // -----------------------------------------------------------------
        case "tool_execution_start": {
          const toolEvent = event as { toolName: string; toolCallId: string; args?: unknown };
          m.toolStartTimes.set(toolEvent.toolCallId, Date.now());
          m.toolCallHistory.push(toolEvent.toolName);
          m.lastActiveToolName = toolEvent.toolName;

          // Build truncated args preview for observability (1000 chars max, sanitized)
          let argsPreview: string | undefined;
          if (toolEvent.args !== undefined) {
            try {
              const raw = JSON.stringify(toolEvent.args);
              const sanitized = sanitizeLogString(raw);
              argsPreview = sanitized.length > 1000 ? sanitized.slice(0, 1000) + "…" : sanitized;
            } catch {
              argsPreview = "[unserializable]";
            }
          }

          // Store sanitized arg snapshot for failure correlation
          if (toolEvent.args !== undefined && typeof toolEvent.args === "object" && toolEvent.args !== null) {
            try {
              m.toolArgSnapshots.set(toolEvent.toolCallId, sanitizeToolArgs(toolEvent.args as Record<string, unknown>));
            } catch {
              // Never fail execution due to arg snapshot error
            }
          }

          deps.eventBus.emit("tool:started", {
            toolName: toolEvent.toolName,
            toolCallId: toolEvent.toolCallId,
            timestamp: Date.now(),
            agentId: deps.agentId,
            sessionKey: formatSessionKey(deps.sessionKey),
            traceId: deps.executionId,
          });

          deps.logger.debug(
            { toolName: toolEvent.toolName, ...(argsPreview && { argsPreview }) },
            argsPreview ? `Tool execution started: ${toolEvent.toolName}(${argsPreview})` : "Tool execution started",
          );
          break;
        }

        case "tool_execution_end": {
          const endEvent = event as {
            toolCallId: string;
            toolName: string;
            result: unknown;
            isError: boolean;
          };

          deps.stepCounter.increment();

          // Calculate duration from tracked start time
          const startTime = m.toolStartTimes.get(endEvent.toolCallId);
          const durationMs = startTime ? Date.now() - startTime : 0;
          m.toolStartTimes.delete(endEvent.toolCallId);
          // Clear active tool once completed (no tool in-flight after this point)
          if (m.lastActiveToolName === endEvent.toolName) m.lastActiveToolName = undefined;
          m.cumulativeToolDurationMs += durationMs;
          m.turnToolDurationMs += durationMs;

          // Determine success: SDK isError flag + exit code inspection.
          // Tools like exec never throw — they return { details: { exitCode: N } }.
          // The SDK only sets isError on thrown exceptions, so we also inspect the result.
          let toolSuccess = !endEvent.isError;
          let toolErrorKind: string | undefined;
          if (toolSuccess && endEvent.result != null) {
            const details = (endEvent.result as Record<string, unknown>)?.details;
            if (
              details != null &&
              typeof (details as Record<string, unknown>).exitCode === "number" &&
              (details as Record<string, unknown>).exitCode !== 0
            ) {
              toolSuccess = false;
              toolErrorKind = "nonzero-exit";
            }
          }

          // Retrieve stored args and extract error text for failure diagnostics
          const sanitizedArgs = m.toolArgSnapshots.get(endEvent.toolCallId);
          m.toolArgSnapshots.delete(endEvent.toolCallId); // Cleanup regardless of success/failure

          let errorText: string | undefined;
          // Extract MCP server name for attribution
          const mcpServer = extractMcpServerName(endEvent.toolName);
          if (!toolSuccess) {
            errorText = extractErrorText(endEvent.result);
            m.failedToolCount++;
            if (!m.failedToolNames.includes(endEvent.toolName)) {
              m.failedToolNames.push(endEvent.toolName);
            }

            // WARN log with error text + sanitized args
            // Include mcpServer and mcpErrorType for MCP tools
            deps.logger.warn(
              {
                toolName: endEvent.toolName,
                toolCallId: endEvent.toolCallId,
                durationMs,
                ...(errorText && { errorText: sanitizeLogString(errorText).slice(0, 1500) }),
                ...(sanitizedArgs && { toolArgs: sanitizedArgs }),
                ...(mcpServer !== undefined && { mcpServer, mcpErrorType: classifyMcpErrorType(errorText) }),
                errorKind: toolErrorKind ?? ("dependency" as const),
                hint: "Tool execution failed; check errorText and toolArgs for root cause",
              },
              "Tool execution failed",
            );
          }

          // Record tool result in retry breaker for consecutive failure tracking
          if (deps.toolRetryBreaker) {
            deps.toolRetryBreaker.recordResult(
              endEvent.toolName,
              (sanitizedArgs ?? {}) as Record<string, unknown>,
              toolSuccess,
              errorText,
            );
          }

          // Track all tool execution results
          m.toolExecResults.push({
            toolName: endEvent.toolName,
            success: toolSuccess,
            durationMs,
            ...(errorText && { errorText }),
          });

          // Look up truncation metadata from stream wrapper registry
          const truncMeta = deps.getTruncationMeta?.(endEvent.toolCallId);

          deps.eventBus.emit("tool:executed", {
            toolName: endEvent.toolName,
            durationMs,
            success: toolSuccess,
            timestamp: Date.now(),
            agentId: deps.agentId,
            sessionKey: formatSessionKey(deps.sessionKey),
            ...(toolErrorKind !== undefined && { errorKind: toolErrorKind }),
            ...(errorText && { errorMessage: sanitizeLogString(errorText).slice(0, 1500) }),
            ...(!toolSuccess && mcpServer !== undefined && { mcpServer, mcpErrorType: classifyMcpErrorType(errorText) }),
            ...(truncMeta && { truncated: truncMeta.truncated, fullChars: truncMeta.fullChars, returnedChars: truncMeta.returnedChars }),
          });

          // Reset prompt timeout after each tool completion so slow tools
          // do not starve subsequent LLM turns (Quick 215).
          deps.onToolExecutionEnd?.();

          // Safety: check step limit (delegated to bridge-safety-controls)
          {
            const stepCheck = checkStepLimit(deps.stepCounter, m.aborted);
            if (stepCheck.shouldAbort) {
              m.finishReason = stepCheck.finishReason!;
              m.aborted = true;
              emitStepLimitAbort(deps);
            }
          }

          // SEP: Track step progress on tool completion
          {
            const plan = deps.executionPlan?.current;
            if (plan?.active) {
              const currentStep = plan.steps.find(s => s.status === "in_progress")
                ?? plan.steps.find(s => s.status === "pending");
              if (currentStep) {
                const oldStatus = currentStep.status;
                if (currentStep.status === "pending") {
                  currentStep.status = "in_progress";
                }
                currentStep.completedBy ??= [];
                currentStep.completedBy.push(endEvent.toolCallId);
                if (oldStatus !== currentStep.status) {
                  deps.logger.debug(
                    { agentId: deps.agentId, stepIndex: currentStep.index, oldStatus, newStatus: currentStep.status },
                    "SEP step status changed",
                  );
                }
              }
            }
          }

          break;
        }

        // -----------------------------------------------------------------
        // LLM turn about to start (pre-serialize hook for assert+restore)
        // -----------------------------------------------------------------
        case "turn_start": {
          // 260428-hoy: Run the executor-supplied pre-call closure once per
          // turn, before pi-ai reads `session.agent.state.messages` to
          // serialize the next API request. The closure performs the
          // assert-then-restore pass over the live transcript and writes the
          // healed array back into session state when at least one swap
          // happens, so the bytes Anthropic sees match the canonical
          // stream-close snapshot. The closure swallows its own throws; the
          // wrapper here is belt-and-braces.
          //
          // 260428-j0v: ALWAYS emit ONE INFO log carrying the counters the
          // bridge can derive — even when the closure is unwired or returns
          // undefined / no candidates. This closes the silent-success
          // ambiguity observed on trace c5680133 where ZERO agent.bridge.*
          // events appeared despite the helpers having shipped.
          //
          // Counters are computed by the bridge's own walk of the messages
          // returned by the closure (or empty when unwired) so the executor
          // closure stays untouched. `mismatchesLogged` and `restoredCount`
          // are derived from positional hash diffs — they equal the work the
          // closure's helpers actually emit/heal.
          const hashStoreSize = m.thinkingBlockHashes.size;
          const canonicalStoreSize = m.thinkingBlockCanonical.size;

          let candidatesChecked = 0;
          let mismatchesLogged = 0;
          let anyResponseIdMatched = false;

          if (deps.getSessionMessages) {
            let liveBeforeClosure: ReadonlyArray<unknown> | undefined;
            try {
              liveBeforeClosure = deps.getSessionMessages();
            } catch {
              // Pre-call hook must NEVER abort agent flow.
              liveBeforeClosure = undefined;
            }

            if (Array.isArray(liveBeforeClosure)) {
              for (const msg of liveBeforeClosure) {
                if (!msg || typeof msg !== "object") continue;
                const sm = msg as { role?: string; responseId?: string; content?: unknown };
                if (sm.role !== "assistant") continue;
                if (typeof sm.responseId !== "string") continue;
                const prior = m.thinkingBlockHashes.get(sm.responseId);
                if (!prior) continue;
                candidatesChecked++;
                anyResponseIdMatched = true;
                const currentBlocks = Array.isArray(sm.content)
                  ? (sm.content as Array<Record<string, unknown>>)
                  : [];
                const currentHashes = computeThinkingBlockHashes(currentBlocks);
                const byIndex = new Map<number, ThinkingBlockHash>();
                for (const h of currentHashes) byIndex.set(h.blockIndex, h);
                for (const old of prior) {
                  const now = byIndex.get(old.blockIndex);
                  if (!now || now.hash !== old.hash) mismatchesLogged++;
                }
              }
            }
          }

          // restoredCount equals mismatchesLogged in the current symmetric
          // implementation; surfaced as a separate field so future asymmetric
          // assert/restore semantics are observable.
          const restoredCount = mismatchesLogged;

          deps.logger.info(
            {
              module: "agent.bridge.hash-invariant",
              candidatesChecked,
              mismatchesLogged,
              restoredCount,
              anyResponseIdMatched,
              hashStoreSize,
              canonicalStoreSize,
            },
            "Pre-call assertion ran",
          );
          break;
        }

        // -----------------------------------------------------------------
        // LLM turn completed
        // -----------------------------------------------------------------
        case "turn_end": {
          m.llmCallCount++;

          const turnEvent = event as { message: unknown };
          const assistantMsg = turnEvent.message as AssistantMessage | undefined;

          // Capture stopReason for output escalation detection
          if (assistantMsg && "stopReason" in assistantMsg) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- SDK interop boundary
            m.lastStopReason = (assistantMsg as any).stopReason as string | undefined;
          }

          // Block-accounting diagnostic: captures the post-stream shape of any
          // assistant message that contains signed thinking blocks. Used to
          // diagnose Anthropic 400 `messages.N.content.M: thinking/redacted_thinking
          // blocks cannot be modified` errors by comparing wire shape vs. persisted
          // shape vs. replay request body. Only fires when at least one signed
          // thinking block is present to keep the log budget bounded.
          if (assistantMsg && Array.isArray((assistantMsg as { content?: unknown }).content)) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- SDK interop boundary
            const blocks = (assistantMsg as any).content as Array<Record<string, unknown>>;
            const signedThinkingCount = blocks.filter(
              (b) => b.type === "thinking" && typeof b.thinkingSignature === "string" && (b.thinkingSignature as string).length > 0,
            ).length;
            if (signedThinkingCount > 0) {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any -- SDK interop boundary
              const responseIdForLog = (assistantMsg as any).responseId as string | undefined;
              deps.logger.info(
                {
                  responseId: responseIdForLog,
                  wireBlockCount: blocks.length,
                  signedThinkingCount,
                  blockShape: blocks.map((b) => ({
                    type: b.type,
                    sigLen: typeof b.thinkingSignature === "string" ? (b.thinkingSignature as string).length : 0,
                    redacted: b.redacted === true,
                    textLen: typeof b.text === "string" ? (b.text as string).length : 0,
                    thinkingLen: typeof b.thinking === "string" ? (b.thinking as string).length : 0,
                  })),
                },
                "Assistant message block accounting at stream close",
              );

              // Bug A diagnostic + 260428-hoy heal: capture hashes AND a
              // canonical (pre-mutation) snapshot of the full content array,
              // keyed by responseId, in lockstep across both stores. The
              // hash store powers the assertion ERROR log (mutation
              // diagnostic); the canonical store powers the pre-call
              // restore pass that heals cross-turn mutation before the next
              // API serialize. Both stores are FIFO-evicted at 32 entries
              // in lockstep so they always share the same keyset.
              if (typeof responseIdForLog === "string") {
                const hashes = computeThinkingBlockHashes(blocks);
                if (hashes.length > 0) {
                  while (m.thinkingBlockHashes.size >= 32) {
                    const oldestKey = m.thinkingBlockHashes.keys().next().value;
                    if (oldestKey === undefined) break;
                    m.thinkingBlockHashes.delete(oldestKey);
                    m.thinkingBlockCanonical.delete(oldestKey);
                  }
                  m.thinkingBlockHashes.set(responseIdForLog, hashes);
                  // 260428-hoy: capture canonical (pre-mutation) full
                  // content array so the pre-LLM-call restore pass can heal
                  // any cross-turn mutation before pi-ai serializes the
                  // next request. structuredClone is a Node 22 global; the
                  // try/catch is defensive against rare exotic input shapes.
                  try {
                    const canonical = Object.freeze(structuredClone(blocks)) as ReadonlyArray<unknown>;
                    m.thinkingBlockCanonical.set(responseIdForLog, canonical);
                  } catch {
                    // Canonical capture failure is non-fatal: the hash store
                    // still fires the assertion diagnostic on resend; only
                    // the heal step degrades to no-op for this responseId.
                  }
                }
              }
            }
          }

          // Compute LLM latency: turn wallclock minus tool execution time
          const turnWallclockMs = Date.now() - m.turnStartMs;
          // Cap per-turn tool duration to turn wallclock (parallel tools can sum > wallclock)
          const effectiveTurnToolMs = Math.min(m.turnToolDurationMs, turnWallclockMs);
          m.cumulativeToolWallclockMs += effectiveTurnToolMs;
          const llmLatencyMs = turnWallclockMs - effectiveTurnToolMs;
          m.cumulativeLlmDurationMs += llmLatencyMs;
          m.turnToolDurationMs = 0;

          // R-04: Extract responseId from assistant message (optional -- not all providers supply it)
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- SDK interop boundary
          const responseId = (assistantMsg as any)?.responseId as string | undefined;

          if (assistantMsg && "usage" in assistantMsg && assistantMsg.usage) {
            const usage = assistantMsg.usage;

            // Accumulate token totals
            m.totalInputTokens += usage.input;
            // Report per-turn input tokens for TokenAnchor recording
            deps.onTurnUsage?.(usage.input);
            m.totalOutputTokens += usage.output;
            m.totalTokens += usage.totalTokens;
            // NOTE: m.totalCost accumulation deferred until after cost correction (see COST-FIX below)
            m.totalCacheReadTokens += usage.cacheRead ?? 0;
            m.totalCacheWriteTokens += usage.cacheWrite ?? 0;

            // Hoist cache token locals for use in savings formula
            const cacheReadTokens = usage.cacheRead ?? 0;
            const cacheWriteTokens = usage.cacheWrite ?? 0;

            // Emit graph cache-write signal on first turn of a graph subagent
            if (deps.graphId && deps.nodeId && m.llmCallCount === 1 && cacheWriteTokens > 0) {
              deps.eventBus.emit("cache:graph_prefix_written", {
                graphId: deps.graphId,
                nodeId: deps.nodeId,
                cacheWriteTokens,
                timestamp: Date.now(),
              });
            }

            // Per-turn pricing resolution via getCurrentModel().
            const currentModelId = deps.getCurrentModel?.() ?? deps.model;
            const pricing = resolveModelPricing(deps.provider, currentModelId);

            // Feed cache reads to adaptive retention escalation callback
            if (cacheReadTokens > 0 && deps.onCacheReads) {
              deps.onCacheReads(cacheReadTokens);
            }

            // Feed turn completion with cache write tokens to adaptive retention.
            // The fast-path evaluates whether first turn wrote >20K tokens for early escalation.
            // Must run AFTER onCacheReads so totalCacheReads is current when tryEscalate runs.
            if (deps.onTurnWithCacheWrite) {
              deps.onTurnWithCacheWrite(cacheWriteTokens);
            }

            // Cache break detection Phase 2 (all providers, unconditional)
            // MUST NOT guard with cacheReadTokens > 0 -- complete cache misses (drop to 0) must be detected
            if (deps.checkCacheBreak) {
              // Detect API errors -- zero usage with error stop reason
              const isApiError = usage.input === 0 && usage.output === 0 && m.lastStopReason === "error";

              const breakEvent = deps.checkCacheBreak({
                sessionKey: formatSessionKey(deps.sessionKey),
                provider: deps.provider,
                cacheReadTokens,
                cacheWriteTokens,
                totalInputTokens: usage.input ?? 0,
                apiError: isApiError || undefined,
              });
              if (breakEvent) {
                deps.eventBus.emit("observability:cache_break", {
                  ...breakEvent,
                  // Structured analytics fields from detection pipeline
                  // Sanitize MCP tool names to bare 'mcp' for analytics
                  toolsAdded: breakEvent.changes.addedTools.map(sanitizeMcpToolNameForAnalytics),
                  toolsRemoved: breakEvent.changes.removedTools.map(sanitizeMcpToolNameForAnalytics),
                  toolsSchemaChanged: breakEvent.changes.changedSchemaTools.map(sanitizeMcpToolNameForAnalytics),
                  systemCharDelta: (breakEvent.currentSystem?.length ?? 0) - (breakEvent.previousSystem?.length ?? 0),
                  model: currentModelId,
                });

                // Forward cache break event to executor for coordinated reset.
                if (deps.onCacheBreakDetected) {
                  deps.onCacheBreakDetected(breakEvent);
                }
              }
            }

            // R-08: Extract cacheCreation breakdown (future upstream -- runtime check)
            const rawUsage = usage as unknown as Record<string, unknown>;
            const cacheCreation = rawUsage.cacheCreation && typeof rawUsage.cacheCreation === "object"
              // eslint-disable-next-line @typescript-eslint/no-explicit-any -- SDK interop boundary
              ? { shortTtl: (rawUsage.cacheCreation as any).shortTtl ?? 0, longTtl: (rawUsage.cacheCreation as any).longTtl ?? 0 }
              : undefined;

            if (cacheWriteTokens > 0) {
              deps.logger.debug({
                cacheWriteTokens,
                // Whether the pi-ai SDK exposes the per-TTL cache_creation breakdown
                // (usage.cacheCreation.shortTtl/longTtl). Expected: false -- pi-ai does
                // not surface this field. Per-TTL split is only visible on the Anthropic
                // dashboard. This does NOT mean cache writes are failing; cacheWriteTokens
                // above confirms writes are happening normally.
                sdkTtlBreakdownAvailable: cacheCreation !== undefined,
                shortTtl: cacheCreation?.shortTtl,
                longTtl: cacheCreation?.longTtl,
              }, "Cache write TTL breakdown (pi-ai SDK does not expose per-TTL split; see Anthropic dashboard)");
            }

            // Record usage in budget guard (token-based, not cost-based -- stays before correction)
            deps.budgetGuard.recordUsage(usage.totalTokens);

            // 49-01 + COST-FIX ordering: Normalize TTL split estimates BEFORE cost correction.
            // The injector provides raw per-TTL estimates; normalize so they sum to the
            // SDK-reported total (eliminates the 28% estimation error).
            // Mutate in-place so per-TTL cost and accumulation use normalized values.
            // CRITICAL: Must run before cost correction to prevent inflated 1h token counts from over-charging.
            if (deps.ttlSplit && (deps.ttlSplit.cacheWrite5mTokens > 0 || deps.ttlSplit.cacheWrite1hTokens > 0)) {
              const rawTotal = deps.ttlSplit.cacheWrite5mTokens + deps.ttlSplit.cacheWrite1hTokens;
              if (rawTotal > 0 && cacheWriteTokens > 0) {
                const scale = cacheWriteTokens / rawTotal;
                const norm5m = Math.round(deps.ttlSplit.cacheWrite5mTokens * scale);
                deps.ttlSplit.cacheWrite5mTokens = norm5m;
                deps.ttlSplit.cacheWrite1hTokens = cacheWriteTokens - norm5m; // remainder ensures exact sum
              }
            }

            // COST-FIX: Compute cost correction for 1h tokens the SDK underpriced at the 5m rate.
            // The SDK prices ALL cacheWrite tokens at pricing.cacheWrite (5m rate).
            // When TTL split is available, 1h tokens should be priced at pricing.cacheWrite1h.
            // Delta = cacheWrite1hTokens * (cacheWrite1h - cacheWrite) -- the underpayment per 1h token.
            let costCorrectionDelta = 0;
            if (deps.ttlSplit && deps.ttlSplit.cacheWrite1hTokens > 0 && pricing.cacheWrite1h > pricing.cacheWrite) {
              costCorrectionDelta = deps.ttlSplit.cacheWrite1hTokens * (pricing.cacheWrite1h - pricing.cacheWrite);
            }

            // Build cost object: apply correction to total if delta > 0, otherwise SDK passthrough
            const sdkCost = usage.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
            const cost = costCorrectionDelta > 0
              ? { ...sdkCost, total: sdkCost.total + costCorrectionDelta }
              : sdkCost;

            // Accumulate corrected cost
            m.totalCost += cost.total;

            if (costCorrectionDelta > 0) {
              deps.logger.debug({
                costCorrectionDelta,
                sdkCostTotal: sdkCost.total,
                correctedCostTotal: cost.total,
                cacheWrite1hTokens: deps.ttlSplit!.cacheWrite1hTokens,
                rate5m: pricing.cacheWrite,
                rate1h: pricing.cacheWrite1h,
              }, "Cost correction applied: SDK underpriced 1h cache writes at 5m rate");
            }

            // Record in cost tracker (uses corrected cost)
            deps.costTracker.record(
              deps.agentId,
              deps.channelId,
              deps.executionId,
              {
                input: usage.input,
                output: usage.output,
                totalTokens: usage.totalTokens,
                cost,
                provider: deps.provider,
                model: deps.getCurrentModel?.() ?? deps.model,
                sessionKey: formatSessionKey(deps.sessionKey),
                operationType: deps.operationType,
              },
            );

            // Compute savedVsUncached: per-TTL split formula when available,
            // single-rate fallback otherwise.
            let savedVsUncached = 0;
            if ((cacheReadTokens > 0 || cacheWriteTokens > 0) && pricing.input > 0) {
              const readSavings = cacheReadTokens * (pricing.input - pricing.cacheRead);
              // Per-TTL write overhead split. When ttlSplit data is available,
              // use separate rates for 5m and 1h writes. Otherwise fall back to single-rate.
              let writeOverhead: number;
              if (deps.ttlSplit && (deps.ttlSplit.cacheWrite5mTokens > 0 || deps.ttlSplit.cacheWrite1hTokens > 0)) {
                const write5mOverhead = deps.ttlSplit.cacheWrite5mTokens * (pricing.cacheWrite - pricing.input);
                const write1hOverhead = deps.ttlSplit.cacheWrite1hTokens * (pricing.cacheWrite1h - pricing.input);
                writeOverhead = write5mOverhead + write1hOverhead;
                // Accumulate TTL-split tokens
                m.totalCacheWrite5mTokens += deps.ttlSplit.cacheWrite5mTokens;
                m.totalCacheWrite1hTokens += deps.ttlSplit.cacheWrite1hTokens;
              } else {
                // Fallback: all writes priced at 5m rate (prior behavior)
                writeOverhead = cacheWriteTokens * (pricing.cacheWrite - pricing.input);
              }
              const raw = readSavings - writeOverhead;
              savedVsUncached = Number.isFinite(raw) ? raw : 0;
            }

            // Accumulate cache savings across turns
            m.totalCacheSaved += savedVsUncached;

            // Record per-turn cache savings for cost gate evaluation.
            if (deps.onTurnCacheSavings) {
              deps.onTurnCacheSavings(savedVsUncached);
            }

            // 1.3: Accumulate session-cumulative costs alongside per-turn values
            m.sessionCumulativeCostUsd += cost.total;
            m.sessionCumulativeCacheSavedUsd += savedVsUncached;

            // 1.5: Track thinking tokens from SDK usage object.
            // The pi-ai SDK Usage type does not have a dedicated thinking/reasoning field,
            // but future versions or raw API responses may include `reasoningTokens`.
            // Runtime-check the raw usage object for this field.
            {
              const rawUsageForThinking = usage as unknown as Record<string, unknown>;
              const sdkThinkingTokens = typeof rawUsageForThinking.reasoningTokens === "number"
                ? rawUsageForThinking.reasoningTokens
                : 0;
              if (sdkThinkingTokens > 0) {
                m.totalThinkingTokens += sdkThinkingTokens;
              }
            }

            // 49-01: Populate cacheCreation from bridge metrics TTL split when SDK doesn't provide it.
            // SDK-sourced cacheCreation (from R-08 extraction) takes priority; bridge metrics
            // provide the fallback when pi-ai doesn't surface per-TTL breakdown.
            const effectiveCacheCreation = cacheCreation ?? (
              (m.totalCacheWrite5mTokens > 0 || m.totalCacheWrite1hTokens > 0)
                ? { shortTtl: m.totalCacheWrite5mTokens, longTtl: m.totalCacheWrite1hTokens }
                : undefined
            );

            // Emit observability event
            deps.eventBus.emit("observability:token_usage", {
              timestamp: Date.now(),
              traceId: deps.executionId,
              agentId: deps.agentId,
              channelId: deps.channelId,
              executionId: deps.executionId,
              provider: deps.provider,
              model: deps.getCurrentModel?.() ?? deps.model,
              tokens: {
                prompt: usage.input,
                completion: usage.output,
                total: usage.totalTokens,
              },
              cost: {
                input: cost.input,
                output: cost.output,
                cacheRead: cost.cacheRead,
                cacheWrite: cost.cacheWrite,
                total: cost.total,
              },
              latencyMs: llmLatencyMs,
              cacheReadTokens,
              cacheWriteTokens,
              sessionKey: formatSessionKey(deps.sessionKey),
              savedVsUncached,
              cacheEligible: getCacheProviderInfo(deps.provider, deps.getCurrentModel?.() ?? deps.model).cacheEligible,
              responseId,
              cacheCreation: effectiveCacheCreation,
            });

            // Safety: check budget after recording (delegated to bridge-safety-controls)
            {
              const budgetCheck = checkBudgetLimit(deps.budgetGuard, m.aborted);
              if (budgetCheck.shouldAbort) {
                m.finishReason = budgetCheck.finishReason!;
                m.aborted = true;
                emitBudgetAbort(deps, m.totalTokens);
              }
            }

            // Budget trajectory warning: detect approaching exhaustion before hard abort
            if (!m.budgetWarningEmitted) {
              const trajectory = checkBudgetTrajectory(m, deps.perExecutionBudgetCap);
              if (trajectory.shouldWarn) {
                m.budgetWarningEmitted = true;
                if (deps.budgetWarningRef) {
                  deps.budgetWarningRef.current = true;
                }
                const avgTokensPerCall = m.totalTokens / m.llmCallCount;
                deps.eventBus.emit("execution:budget_warning", {
                  agentId: deps.agentId,
                  sessionKey: formatSessionKey(deps.sessionKey),
                  totalTokens: m.totalTokens,
                  llmCallCount: m.llmCallCount,
                  projectedCallsLeft: Math.floor((deps.perExecutionBudgetCap! - m.totalTokens) / avgTokensPerCall),
                  timestamp: Date.now(),
                });
                deps.logger.warn({
                  totalTokens: m.totalTokens,
                  llmCallCount: m.llmCallCount,
                  perExecutionCap: deps.perExecutionBudgetCap,
                  hint: "Budget trajectory shows ~2 LLM calls remaining; warning injected into next turn",
                  errorKind: "resource" as const,
                }, "Budget trajectory warning emitted");
              }
            }
          }

          // Decrement eviction cooldown each turn (unconditional).
          deps.decrementEvictionCooldown?.();

          // Context guard: check context window usage after each turn
          // Delegated to bridge-safety-controls
          if (deps.contextGuard && deps.getContextUsage && !m.aborted) {
            const contextUsage = deps.getContextUsage();
            if (contextUsage) {
              // Store last known usage for external consumers (/status)
              m.lastContextUsage = contextUsage;

              const contextCheck = checkContextWindow(deps.contextGuard, contextUsage, m.aborted, deps.logger);
              if (contextCheck.shouldAbort) {
                m.finishReason = contextCheck.finishReason!;
                m.aborted = true;
                emitContextAbort(deps, contextUsage);
              }
            }
          }

          // Proactive compaction advice: check if SDK would recommend compaction
          if (deps.compactionSettings && deps.getContextUsage && !m.aborted) {
            const contextUsage = m.lastContextUsage ?? deps.getContextUsage();
            if (contextUsage && contextUsage.tokens !== null) {
              const compactNeeded = shouldCompact(
                contextUsage.tokens,
                contextUsage.contextWindow,
                deps.compactionSettings,
              );
              if (compactNeeded) {
                deps.eventBus.emit("compaction:recommended", {
                  agentId: deps.agentId,
                  sessionKey: deps.sessionKey,
                  contextPercent: contextUsage.percent ?? Math.round((contextUsage.tokens / contextUsage.contextWindow) * 100),
                  contextTokens: contextUsage.tokens,
                  contextWindow: contextUsage.contextWindow,
                  timestamp: Date.now(),
                });
                deps.logger.debug(
                  {
                    contextPercent: contextUsage.percent,
                    contextTokens: contextUsage.tokens,
                  },
                  "Compaction recommended by SDK",
                );
              }
            }
          }

          // Record successful LLM call in circuit breaker + provider health
          deps.circuitBreaker.recordSuccess();
          deps.providerHealth?.recordSuccess(deps.provider, deps.agentId);

          // SEP: Advance step status on turn completion
          m.turnCount++;

          // SEP: Extract plan from first LLM turn that has tool calls + assistant text.
          // This runs inside the agentic loop so subsequent turns can track against the plan.
          if (deps.executionPlan && deps.sepConfig && !deps.executionPlan.current) {
            const assistantTextForPlan = Array.isArray(assistantMsg?.content)
              ? assistantMsg!.content
                  .filter((c: unknown) => (c as { type?: string })?.type === "text")
                  .map((c: unknown) => (c as { text?: string }).text ?? "")
                  .join(" ")
              : "";

            if (assistantTextForPlan.length > 0) {
              const steps = extractPlanFromResponse(assistantTextForPlan, deps.sepConfig.maxSteps);
              if (steps && steps.length >= deps.sepConfig.minSteps) {
                const plan: ExecutionPlan = {
                  active: true,
                  request: (deps.sepMessageText ?? "").slice(0, 200),
                  steps,
                  completedCount: 0,
                  createdAtMs: Date.now(),
                };
                deps.executionPlan.current = plan;
                deps.logger.info(
                  {
                    agentId: deps.agentId,
                    stepCount: steps.length,
                    durationMs: deps.sepExecutionStartMs ? Date.now() - deps.sepExecutionStartMs : undefined,
                  },
                  "SEP plan extracted (mid-loop)",
                );
                deps.eventBus.emit("sep:plan_extracted", {
                  agentId: deps.agentId ?? "default",
                  sessionKey: formatSessionKey(deps.sessionKey),
                  stepCount: steps.length,
                  timestamp: Date.now(),
                });
              }
            }
          }

          {
            const plan = deps.executionPlan?.current;
            if (plan?.active) {
              const assistantContent = assistantMsg?.content;
              const assistantText = Array.isArray(assistantContent)
                ? assistantContent
                    .filter((c: unknown) => (c as { type?: string })?.type === "text")
                    .map((c: unknown) => (c as { text?: string }).text ?? "")
                    .join(" ")
                : "";

              const completionSignals = /\b(?:done|completed|finished|configured|set up|created|updated|verified|installed|removed|deleted|moved|renamed)\b/i;
              const currentStep = plan.steps.find(s => s.status === "in_progress");
              if (currentStep && completionSignals.test(assistantText)) {
                const oldStatus = currentStep.status;
                currentStep.status = "done";
                plan.completedCount++;
                deps.logger.debug(
                  { agentId: deps.agentId, stepIndex: currentStep.index, oldStatus, newStatus: "done" },
                  "SEP step completed",
                );
                // Advance to next pending step
                const nextStep = plan.steps.find(s => s.status === "pending");
                if (nextStep) {
                  nextStep.status = "in_progress";
                  deps.logger.debug(
                    { agentId: deps.agentId, stepIndex: nextStep.index, oldStatus: "pending", newStatus: "in_progress" },
                    "SEP step advanced",
                  );
                }
              }
            }
          }

          // Consecutive empty assistant turn detection
          {
            const assistantContent = assistantMsg?.content;
            const hasTextContent = Array.isArray(assistantContent) && assistantContent.some(
              (c: unknown) => {
                const block = c as { type?: string; text?: string };
                return block.type === "text" && block.text?.trim();
              },
            );
            const hasToolCalls = Array.isArray(assistantContent) && assistantContent.some(
              (c: unknown) => {
                const block = c as { type?: string };
                return block.type === "toolCall" || block.type === "tool_use";
              },
            );

            if (!hasTextContent && !hasToolCalls) {
              // Truly empty turn: no text, no tool calls
              m.consecutiveEmptyTurns++;
              if (m.consecutiveEmptyTurns >= 2) {
                deps.logger.warn(
                  {
                    consecutiveEmptyTurns: m.consecutiveEmptyTurns,
                    model: deps.model,
                    lastToolUsed: m.lastActiveToolName ?? "none",
                    contextTokens: m.lastContextUsage?.tokens ?? 0,
                    hint: "Model produced consecutive empty responses; may indicate a stall pattern or context issue",
                    errorKind: "dependency" as const,
                  },
                  "Consecutive empty assistant turns detected",
                );
              }
            } else {
              // Reset counter on any turn with content (text or tool calls)
              m.consecutiveEmptyTurns = 0;
            }
          }

          // Reset LLM turn timer for next turn
          m.turnStartMs = Date.now();
          break;
        }

        // -----------------------------------------------------------------
        // Auto-compaction lifecycle
        // -----------------------------------------------------------------
        case "compaction_start": {
          m.compactionStartMs = Date.now();
          deps.logger.info(
            { sessionKey: formatSessionKey(deps.sessionKey) },
            "Auto-compaction started",
          );
          deps.eventBus.emit("compaction:started", {
            agentId: deps.agentId,
            sessionKey: deps.sessionKey,
            timestamp: Date.now(),
          });
          break;
        }

        case "compaction_end": {
          const compactionEvent = event as {
            result: { summary: string; firstKeptEntryId: string; tokensBefore: number } | undefined;
            aborted: boolean;
            willRetry: boolean;
            errorMessage?: string;
          };

          // Flush compaction summary to long-term memory
          let memoriesWritten = 0;
          if (compactionEvent.result?.summary && deps.memoryPort) {
            const entry = {
              id: randomUUID(),
              tenantId: deps.sessionKey.tenantId,
              userId: deps.sessionKey.userId,
              agentId: deps.agentId,
              content: compactionEvent.result.summary,
              trustLevel: "learned" as const,
              source: { who: "compaction", channel: deps.channelId },
              tags: ["compaction-summary"],
              createdAt: Date.now(),
            };
            // Fire-and-forget: never block event processing on memory I/O
            suppressError(deps.memoryPort.store(entry as MemoryEntry), "compaction memory flush");
            memoriesWritten = 1;
          }

          deps.eventBus.emit("compaction:flush", {
            sessionKey: deps.sessionKey,
            memoriesWritten,
            trigger: "soft",
            success: !compactionEvent.aborted && !!compactionEvent.result,
            timestamp: Date.now(),
          });

          const durationMs = m.compactionStartMs ? Date.now() - m.compactionStartMs : 0;
          m.compactionStartMs = 0; // reset

          // WARN for failure/abort
          if (compactionEvent.aborted || compactionEvent.errorMessage) {
            deps.logger.warn(
              {
                durationMs,
                aborted: compactionEvent.aborted,
                hasSummary: !!compactionEvent.result?.summary,
                memoriesWritten,
                ...(compactionEvent.errorMessage && { err: compactionEvent.errorMessage }),
                hint: compactionEvent.aborted
                  ? "Auto-compaction was aborted; context may be near capacity -- check if agent is stuck in a tool loop"
                  : "Auto-compaction failed; the session will retry on next turn",
                errorKind: "internal" as const,
              },
              "Auto-compaction failed",
            );
          } else {
            // INFO for successful completion
            deps.logger.info(
              {
                durationMs,
                aborted: false,
                hasSummary: !!compactionEvent.result?.summary,
                memoriesWritten,
              },
              "Auto-compaction completed",
            );
          }
          break;
        }

        // -----------------------------------------------------------------
        // Default: ignore unknown event types (future SDK events)
        // -----------------------------------------------------------------
        default:
          break;
      }

      // Handle error detection from turn_end messages (stopReason === "error")
      if (event.type === "turn_end") {
        const turnMsg = (event as { message: unknown }).message as AssistantMessage | undefined;
        if (turnMsg && "stopReason" in turnMsg && turnMsg.stopReason === "error") {
          m.lastLlmErrorMessage = turnMsg.errorMessage ?? "Unknown LLM error";
          deps.logger.warn(
            {
              err: m.lastLlmErrorMessage,
              hint: "Check LLM provider status",
              errorKind: "dependency" as const,
            },
            "LLM call returned error",
          );
          // 260428-iag wire-edge diagnostic: when the LLM error matches the
          // Anthropic signed-replay rejection signature ("thinking blocks ...
          // cannot be modified"), diff the in-memory content against the
          // persisted JSONL canonical and emit one ERROR per divergent block.
          // Fully async / fire-and-forget — never blocks the existing error
          // path. Silent no-op when the signature doesn't match or when
          // either getSessionMessages / getSessionJsonlPath is unwired.
          //
          // 260428-j0v: ALWAYS emit ONE dispatch-decision INFO log carrying
          // boolean flags that explain WHY the wire-diff dispatch was or was
          // not entered (regex match, candidate count, callback presence) —
          // even when regexMatched is false or callbacks are unwired. When
          // the dispatch IS entered, emit a second dispatch-completion INFO
          // after the async candidates loop completes.
          //
          // The signature regex matches Anthropic's actual 400 message:
          // "messages.N.content.M: thinking blocks cannot be modified"
          // and the redacted_thinking variant. Both `thinking|redacted_thinking`
          // AND `modif|cannot` must be present to avoid false positives on
          // unrelated 400s (rate limits, auth, schema errors).
          {
            const errMsg = m.lastLlmErrorMessage;
            const regexMatched =
              typeof errMsg === "string" &&
              /thinking|redacted_thinking/.test(errMsg) &&
              /modif|cannot/.test(errMsg);
            const liveForDecision = deps.getSessionMessages?.();
            const jsonlPathForDecision = deps.getSessionJsonlPath?.();

            // Pre-compute candidatesFound by walking liveForDecision with the
            // same filter the dispatch uses. Cap at 3 to mirror dispatch behavior.
            type Candidate = { responseId: string; content: ReadonlyArray<Record<string, unknown>> };
            const candidates: Candidate[] = [];
            if (Array.isArray(liveForDecision)) {
              for (let i = liveForDecision.length - 1; i >= 0 && candidates.length < 3; i--) {
                // eslint-disable-next-line security/detect-object-injection -- numeric loop index
                const msg = liveForDecision[i] as { role?: string; responseId?: string; content?: unknown };
                if (!msg || typeof msg !== "object") continue;
                if (msg.role !== "assistant") continue;
                if (typeof msg.responseId !== "string") continue;
                if (!Array.isArray(msg.content)) continue;
                const blocks = msg.content as Array<Record<string, unknown>>;
                const hasSigned = blocks.some(
                  (b) =>
                    b.type === "thinking" &&
                    typeof b.thinkingSignature === "string" &&
                    (b.thinkingSignature as string).length > 0 &&
                    b.redacted !== true,
                );
                if (!hasSigned) continue;
                candidates.push({ responseId: msg.responseId, content: blocks });
              }
            }

            const jsonlPathPresent =
              typeof jsonlPathForDecision === "string" && jsonlPathForDecision.length > 0;

            deps.logger.info(
              {
                module: "agent.bridge.wire-diff",
                regexMatched,
                candidatesFound: candidates.length,
                jsonlPathPresent,
                getSessionMessagesPresent: typeof deps.getSessionMessages === "function",
                getSessionJsonlPathPresent: typeof deps.getSessionJsonlPath === "function",
              },
              "Wire-edge diff dispatch decision",
            );

            if (regexMatched && jsonlPathPresent && candidates.length > 0) {
              const capturedJsonlPath = jsonlPathForDecision;
              // Async non-blocking dispatch -- never blocks the error path.
              void Promise.resolve().then(async () => {
                let candidatesProcessed = 0;
                let totalDivergences = 0;
                let persistedNotFound = 0;
                let fileReadErrors = 0;

                // Wrapped logger forwards to deps.logger AND counts the
                // helper's WARN outcomes by hint-constant identity (no regex).
                const countingLogger = {
                  warn: (obj: Record<string, unknown>, msg: string) => {
                    deps.logger.warn(obj, msg);
                    if (obj.hint === WIRE_DIFF_HINT_FILE_MISSING) fileReadErrors++;
                    else if (obj.hint === WIRE_DIFF_HINT_NOT_FOUND) persistedNotFound++;
                  },
                };

                try {
                  for (const c of candidates) {
                    candidatesProcessed++;
                    const entries = await diffThinkingBlocksAgainstPersisted(
                      c.content,
                      c.responseId,
                      capturedJsonlPath,
                      { logger: countingLogger },
                    );
                    totalDivergences += entries.length;
                    for (const entry of entries) {
                      deps.logger.error(
                        {
                          module: "agent.bridge.wire-diff",
                          responseId: c.responseId,
                          blockIndex: entry.blockIndex,
                          persistedHash: entry.persistedHash,
                          inMemoryHash: entry.inMemoryHash,
                          persistedText: entry.persistedText,
                          inMemoryText: entry.inMemoryText,
                          persistedSigLen: entry.persistedSigLen,
                          inMemorySigLen: entry.inMemorySigLen,
                          errorKind: "internal" as const,
                          hint:
                            "Mutation occurred between bridge restoration hook and " +
                            "pi-ai serialization — likely inside pi-ai or its dependencies",
                        },
                        "Wire-edge thinking-block divergence vs persisted JSONL",
                      );
                    }
                  }
                } catch {
                  // Diagnostic must NEVER abort the error path.
                }

                // ALWAYS emit the completion INFO, even on totalDivergences=0
                // or when every helper call hit a read error.
                deps.logger.info(
                  {
                    module: "agent.bridge.wire-diff",
                    candidatesProcessed,
                    totalDivergences,
                    persistedNotFound,
                    fileReadErrors,
                  },
                  "Wire-edge diff dispatch complete",
                );
              });
            }
          }
          deps.circuitBreaker.recordFailure();
          deps.providerHealth?.recordFailure(deps.provider, deps.agentId);
          // If circuit breaker just opened, abort mid-execution
          // Delegated to bridge-safety-controls
          {
            const cbCheck = checkCircuitBreaker(deps.circuitBreaker, m.aborted);
            if (cbCheck.shouldAbort) {
              m.finishReason = cbCheck.finishReason!;
              m.aborted = true;
              emitCircuitBreakerAbort(deps);
            }
          }
        }
      }
    } catch (listenerError) {
      // Never throw from the listener -- all errors must be caught and logged
      deps.logger.warn(
        {
          err: listenerError,
          eventType: event.type,
          hint: "Event bridge listener encountered unexpected error; execution continues",
          errorKind: "internal" as const,
        },
        "Event bridge listener error",
      );
    }
  };

  const getResult = () => buildBridgeResult(m, deps.stepCounter.getCount());

  /** Accumulate estimated cost from a timed-out API request. */
  const addGhostCost = (estimated: GhostCostEstimate): void => {
    m.ghostCostUsd += estimated.costUsd;
    m.timedOutRequests += 1;
  };

  // 260428-hoy: typed ReadonlyMap accessor for the executor's pre-call
  // closure. Returns views over the live maps -- the executor never receives
  // the mutable `m` object itself.
  const getThinkingBlockStores = (): {
    hashes: ReadonlyMap<string, ReadonlyArray<ThinkingBlockHash>>;
    canonical: ReadonlyMap<string, ReadonlyArray<unknown>>;
  } => ({
    hashes: m.thinkingBlockHashes,
    canonical: m.thinkingBlockCanonical,
  });

  return { listener, getResult, addGhostCost, getThinkingBlockStores };
}
