// SPDX-License-Identifier: Apache-2.0
/**
 * Post-execution cleanup for PiExecutor.
 *
 * Extracted from pi-executor.ts execute() `finally` block to isolate
 * bridge result merging, SDK stats delegation, cache metrics, planner
 * metrics, TTL recording, execution bookend logging, session metadata
 * persistence, memory store, active run deregister, schema stripping,
 * and session disposal into a focused module.
 *
 * Consumers:
 * - pi-executor.ts: calls postExecution() in the finally block
 *
 * @module
 */

import type { AgentSession } from "@mariozechner/pi-coding-agent";
import type { CacheRetention } from "@mariozechner/pi-ai";
import {
  type SessionKey,
  type NormalizedMessage,
  type PerAgentConfig,
  type TypedEventBus,
  type MemoryPort,
} from "@comis/core";
import type { ComisLogger, ErrorKind } from "@comis/infra";
import { suppressError } from "@comis/shared";
import type { ActiveRunRegistry } from "./active-run-registry.js";
import type { ComisSessionManager } from "../session/comis-session-manager.js";
import {
  setBreakpointIndex,
  deleteBreakpointIndex,
  getBreakpointIndexMapSize,
} from "./executor-session-state.js";
import { mergeSessionStats } from "./pi-executor.js";
import { recordLastResponseTs } from "./ttl-guard.js";
import { stripDiscoverySchemas } from "./schema-stripping.js";
import { getWorkspaceStatus } from "../workspace/index.js";
import type { ExecutionResult, ExecutionOverrides } from "./types.js";
import type { ExecutionPlan } from "../planner/types.js";
import type { ContextEngine } from "../context-engine/index.js";
import type { DiscoveryTracker } from "./discovery-tracker.js";
import { createHash, randomUUID } from "node:crypto";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Bridge result interface used by post-execution. */
export interface PostExecutionBridgeResult {
  tokensUsed?: { input: number; output: number; total: number; cacheRead?: number; cacheWrite?: number };
  cost?: { total: number; cacheSaved?: number; ghostCostUsd?: number; timedOutRequests?: number };
  stepsExecuted?: number;
  llmCalls?: number;
  toolCallHistory?: string[];
  finishReason?: ExecutionResult["finishReason"];
  lastActiveToolName?: string;
  failedToolCalls?: number;
  failedTools?: string[];
  cumulativeLlmDurationMs?: number;
  cumulativeToolDurationMs?: number;
  /** Wallclock-capped tool duration: parallel tool overlap does not inflate this value. */
  cumulativeToolWallclockMs?: number;
  textEmitted?: boolean;
  /** Estimated 5m TTL cache write tokens from TTL split data. */
  cacheWrite5mTokens?: number;
  /** Estimated 1h TTL cache write tokens from TTL split data. */
  cacheWrite1hTokens?: number;
  /** 1.3: Session-cumulative total cost across all turns (USD). */
  sessionCostUsd?: number;
  /** 1.3: Session-cumulative cache savings across all turns (USD). */
  sessionCacheSavedUsd?: number;
  /** 1.5: Thinking tokens from SDK reasoningTokens field. */
  thinkingTokens?: number;
}

/** Bridge interface used by post-execution. */
export interface PostExecutionBridge {
  getResult(): PostExecutionBridgeResult;
}

/** Parameters for postExecution(). */
export interface PostExecutionParams {
  result: ExecutionResult;
  session: AgentSession;
  sm: { buildSessionContext(): unknown };
  config: PerAgentConfig;
  msg: NormalizedMessage;
  sessionKey: SessionKey;
  formattedKey: string;
  agentId: string | undefined;
  executionStartMs: number;
  executionId: string;
  executionOverrides: ExecutionOverrides | undefined;
  bridge: PostExecutionBridge;
  unsubscribe: () => void;
  // Context engine
  contextEngineRef: { current?: ContextEngine };
  ceSetup: { getContextEngineDurationMs(): number };
  streamSetup: {
    capturedRetention?: { getRetention(): CacheRetention };
  };
  // Truncation and budget summaries
  getTruncationSummary: () => { truncatedTools: number; totalTruncatedChars: number };
  getTurnBudgetSummary: () => { turnsExceeded: number; totalBudgetTruncatedChars: number };
  // State
  executionPlanRef: { current: ExecutionPlan | undefined };
  sepEnabled: boolean;
  isOnboarding: boolean;
  geminiCacheHit: boolean;
  geminiCachedTokens: number;
  modelTier: string | undefined;
  deferralResult: { deferredCount: number };
  mergedCustomTools: Array<{ name: string }>;
  deliveredGuides: Set<string>;
  discoveryTracker?: DiscoveryTracker;
  // Deps
  deps: {
    eventBus: TypedEventBus;
    logger: ComisLogger;
    memoryPort?: MemoryPort;
    activeRunRegistry?: ActiveRunRegistry;
    embeddingEnqueue?: (entryId: string, content: string) => void;
    workspaceDir: string;
  };
  // Session adapter
  sessionAdapter: ComisSessionManager;
  // Mutable ref clearing callbacks
  executionCacheRetentionClear: () => void;
  adaptiveRetentionClear: () => void;
  executionMinTokensOverrideClear: () => void;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Max chars of agent response to include in paired memory content. */
const PAIRED_RESPONSE_MAX_CHARS = 300;

/**
 * Build paired memory content combining user message and agent response.
 * Format: "[user] <message>\n[agent] <response>" with truncated agent response.
 *
 * Pairing provides semantic context for RAG retrieval -- standalone user
 * messages like "Hello" carry no meaning without the agent's reply.
 */
function buildPairedMemoryContent(userText: string, agentResponse: string): string {
  const truncated = agentResponse.length > PAIRED_RESPONSE_MAX_CHARS
    ? agentResponse.slice(0, PAIRED_RESPONSE_MAX_CHARS - 3) + "..."
    : agentResponse;
  return `[user] ${userText}\n[agent] ${truncated}`;
}

/** Minimum trimmed user-message chars to qualify for paired memory storage. */
const PAIRED_MIN_USER_CHARS = 12;

/** Minimum combined (user + agent) trimmed chars to qualify for storage. */
const PAIRED_MIN_COMBINED_CHARS = 80;

/**
 * Quality gate for paired memory storage.
 *
 * Prevents trivially short user messages (emoji, single-word acks) from being
 * stored and embedded, which wastes embedding slots and dilutes RAG retrieval.
 *
 * @param userText - Raw user message text
 * @param agentResponse - Agent response text
 * @returns true if the turn qualifies for memory storage
 */
export function shouldStorePairedMemory(userText: string, agentResponse: string): boolean {
  const userLen = userText.trim().length;
  if (userLen < PAIRED_MIN_USER_CHARS) return false;

  const combinedLen = userLen + agentResponse.trim().length;
  if (combinedLen < PAIRED_MIN_COMBINED_CHARS) return false;

  return true;
}

/**
 * Operation types that must NOT create paired memories.
 *
 * Cron and heartbeat executions are stateless and repetitive -- storing their
 * prompts pollutes the vector space and degrades RAG recall for interactive
 * conversations. Compaction / taskExtraction / condensation are system-internal
 * operations that have their own dedicated memory paths (compaction summaries,
 * extracted tasks) and should not additionally create paired conversation
 * entries. Interactive and subagent are deliberately excluded.
 */
const MEMORY_SKIP_OPERATIONS: ReadonlySet<string> = new Set([
  "cron",
  "heartbeat",
  "compaction",
  "taskExtraction",
  "condensation",
]);

/**
 * In-memory dedup cache for paired memory content.
 *
 * Defense-in-depth for interactive conversations where the user sends the same
 * message multiple times (retries, reconnects). The Layer-1 operationType gate
 * is the primary defense against cron/heartbeat duplication; this Layer-2 hash
 * dedup catches residual duplicates that slip through.
 *
 * Keyed by a 64-bit truncation of sha256(agentId || content). Single-process
 * daemon deployment (pm2, no cluster) means this cache is always complete.
 */
const DEDUP_TTL_MS = 10 * 60 * 1000;
const DEDUP_MAX_ENTRIES = 500;
const pairedMemoryDedup = new Map<string, number>();

/**
 * Check whether paired memory content was stored recently for this agent.
 *
 * Exact-content hashing (not semantic similarity) -- targets the cron pattern
 * of identical prompt + identical NO_REPLY response. Lazy eviction keeps the
 * cache bounded without a timer.
 *
 * Exported for unit tests.
 */
export function isDuplicatePairedMemory(content: string, agentId: string): boolean {
  const now = Date.now();

  if (pairedMemoryDedup.size > DEDUP_MAX_ENTRIES) {
    for (const [key, ts] of pairedMemoryDedup) {
      if (now - ts > DEDUP_TTL_MS) pairedMemoryDedup.delete(key);
    }
  }

  const hash = createHash("sha256")
    .update(agentId)
    .update(content)
    .digest("hex")
    .slice(0, 16);

  const existing = pairedMemoryDedup.get(hash);
  if (existing != null && now - existing <= DEDUP_TTL_MS) return true;
  pairedMemoryDedup.set(hash, now);
  return false;
}

/** Reset the paired-memory dedup cache. Exported for unit tests. */
export function resetPairedMemoryDedupForTests(): void {
  pairedMemoryDedup.clear();
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Run post-execution cleanup for a PiExecutor turn.
 *
 * Handles: bridge unsubscribe, mutable ref clearing, breakpoint sync,
 * bridge stats merge, SDK stats delegation, cache metrics, planner metrics,
 * TTL recording, execution bookend logging, truncation summaries, session
 * metadata write, onboarding check, memory persistence, active run
 * deregister, schema stripping, and session disposal.
 *
 * @param params - All inputs needed for post-execution cleanup
 */
export async function postExecution(params: PostExecutionParams): Promise<void> {
  const {
    result, session, sm, config, msg, sessionKey, formattedKey, agentId,
    executionStartMs, executionId,
    bridge, unsubscribe,
    contextEngineRef, ceSetup, streamSetup,
    getTruncationSummary, getTurnBudgetSummary,
    executionPlanRef, isOnboarding,
    geminiCacheHit, geminiCachedTokens, modelTier,
    deferralResult, mergedCustomTools, deliveredGuides,
    deps, sessionAdapter,
    executionCacheRetentionClear, adaptiveRetentionClear,
  } = params;

  unsubscribe();
  // Clear per-execution cache retention to prevent state leakage
  executionCacheRetentionClear();
  // Clear adaptive retention to prevent state leakage
  adaptiveRetentionClear();

  // Sync final breakpoint index back to persistence (handles compaction reset)
  const finalBreakpointIdx = contextEngineRef.current?.lastBreakpointIndex;
  if (finalBreakpointIdx !== undefined) {
    setBreakpointIndex(formattedKey, finalBreakpointIdx);
  } else {
    deleteBreakpointIndex(formattedKey);
  }
  deps.logger.debug(
    { formattedKey, finalBreakpointIdx: finalBreakpointIdx ?? null, mapSize: getBreakpointIndexMapSize() },
    "Breakpoint index synced to session map",
  );

  // Merge bridge stats into result
  const bridgeResult = bridge.getResult();
  result.tokensUsed = bridgeResult.tokensUsed ?? result.tokensUsed;
  result.cost = bridgeResult.cost ?? result.cost;
  result.stepsExecuted = bridgeResult.stepsExecuted ?? result.stepsExecuted;
  result.llmCalls = bridgeResult.llmCalls ?? result.llmCalls;
  result.toolCallHistory = bridgeResult.toolCallHistory;
  if (bridgeResult.finishReason && bridgeResult.finishReason !== "stop") {
    result.finishReason = bridgeResult.finishReason;
  }
  // Enrich errorContext with the tool that was in-flight when failure occurred
  if (result.errorContext && bridgeResult.lastActiveToolName) {
    result.errorContext.failingTool = bridgeResult.lastActiveToolName;
  }

  // R-13: Delegate token totals to SDK session stats (single source of truth).
  // Cost stays from bridge for consistency with per-turn observability events.
  // Per-turn event emission in bridge remains manual (SDK stats are cumulative only).
  mergeSessionStats(result, () => session.getSessionStats());

  // Populate context engine cache metrics from actual API response data
  if (contextEngineRef.current?.lastMetrics) {
    const cacheReadTokens = bridgeResult.tokensUsed?.cacheRead ?? 0;
    const cacheWriteTokens = bridgeResult.tokensUsed?.cacheWrite ?? 0;
    const inputTokens = bridgeResult.tokensUsed?.input ?? 0;
    contextEngineRef.current.lastMetrics.cacheHitTokens = cacheReadTokens;
    contextEngineRef.current.lastMetrics.cacheWriteTokens = cacheWriteTokens;
    contextEngineRef.current.lastMetrics.cacheMissTokens = inputTokens;  // Already the uncached portion from the API

    // Emit supplementary cache event for pipeline collector (Issue 1 timing fix).
    // The context:pipeline event fires pre-LLM with zeros. This event patches actual data.
    if (deps.eventBus) {
      deps.eventBus.emit("context:pipeline:cache", {
        agentId: agentId ?? "unknown",
        sessionKey: formattedKey,
        cacheHitTokens: cacheReadTokens,
        cacheWriteTokens,
        cacheMissTokens: inputTokens,  // Already the uncached portion from the API
        timestamp: Date.now(),
      });
    }
  }

  // SEP: Attach planner metrics to result (observability-only post-L4 — the
  // legacy enforcement nudge was replaced by the post-batch continuation
  // handler; see post-batch-continuation.ts).
  if (executionPlanRef.current?.active) {
    const plan = executionPlanRef.current;
    result.plannerMetrics = {
      stepsPlanned: plan.steps.length,
      stepsCompleted: plan.completedCount,
      stepsSkipped: plan.steps.filter(s => s.status === "skipped").length,
      planExtractionTurn: 1,
    };

    // Emit plan_completed if all steps resolved
    const allResolved = plan.steps.every(s => s.status === "done" || s.status === "skipped");
    if (allResolved) {
      deps.eventBus.emit("sep:plan_completed", {
        agentId: agentId ?? "default",
        sessionKey: formattedKey,
        stepsPlanned: plan.steps.length,
        stepsCompleted: plan.completedCount,
        stepsSkipped: plan.steps.filter(s => s.status === "skipped").length,
        durationMs: Date.now() - plan.createdAtMs,
        timestamp: Date.now(),
      });
    }
  }

  // Record timestamp after successful execution for TTL guard.
  // Uses the stream-setup captured retention (same ref the wrapper chain captured)
  // because the TTL guard reads from the same module-level Map on next call.
  const capturedRetention = streamSetup.capturedRetention;
  if (capturedRetention) {
    recordLastResponseTs(formattedKey, capturedRetention.getRetention());
  }

  // Execution bookend INFO log with summary stats
  const durationMs = Date.now() - executionStartMs;
  // LLM/tool/contextEngine duration breakdown from bridge cumulative trackers
  const llmDurationMs = bridgeResult.cumulativeLlmDurationMs ?? 0;
  // Use wallclock-capped tool duration for overhead decomposition (parallel tools can inflate raw sum)
  const toolDurationMs = bridgeResult.cumulativeToolWallclockMs ?? bridgeResult.cumulativeToolDurationMs ?? 0;
  const toolCpuDurationMs = bridgeResult.cumulativeToolDurationMs ?? 0;
  const contextEngineDurationMs = ceSetup.getContextEngineDurationMs();
  const overheadDurationMs = durationMs - (llmDurationMs + toolDurationMs + contextEngineDurationMs);
  // Truncation summary from bouncer + turn budget summary
  const truncSummary = getTruncationSummary();
  const turnBudgetSummary = getTurnBudgetSummary();
  deps.logger.info(
    {
      sessionKey: formattedKey,
      durationMs,
      llmDurationMs,
      toolDurationMs,
      ...(toolCpuDurationMs !== toolDurationMs && { toolCpuDurationMs }),
      contextEngineDurationMs,
      overheadDurationMs,
      toolCalls: result.stepsExecuted,
      llmCalls: result.llmCalls,
      finishReason: result.finishReason,
      tokensIn: result.tokensUsed.input,
      tokensOut: result.tokensUsed.output,
      tokensTotal: result.tokensUsed.total,
      cacheReadTokens: result.tokensUsed.cacheRead ?? 0,
      cacheWriteTokens: result.tokensUsed.cacheWrite ?? 0,
      // Per-execution cache hit rate percentage
      cacheHitRate: (result.tokensUsed.cacheRead ?? 0) > 0
        ? Math.round(((result.tokensUsed.cacheRead ?? 0) / ((result.tokensUsed.cacheRead ?? 0) + (result.tokensUsed.input ?? 0))) * 100)
        : 0,
      cacheWrite5mTokens: bridgeResult.cacheWrite5mTokens ?? 0,
      cacheWrite1hTokens: bridgeResult.cacheWrite1hTokens ?? 0,
      comisEstimatedTtlSplit: (bridgeResult.cacheWrite5mTokens ?? 0) > 0 || (bridgeResult.cacheWrite1hTokens ?? 0) > 0,
      costUsd: result.cost.total,
      cacheSavedUsd: result.cost.cacheSaved ?? 0,
      // 1.3: Session-cumulative cost fields (alongside per-turn costUsd/cacheSavedUsd)
      sessionCostUsd: bridgeResult.sessionCostUsd ?? 0,
      sessionCacheSavedUsd: bridgeResult.sessionCacheSavedUsd ?? 0,
      // Session cache savings rate
      sessionCacheSavingsRate: (bridgeResult.sessionCacheSavedUsd ?? 0) > 0 || (bridgeResult.sessionCostUsd ?? 0) > 0
        ? Math.round(((bridgeResult.sessionCacheSavedUsd ?? 0) / ((bridgeResult.sessionCostUsd ?? 0) + (bridgeResult.sessionCacheSavedUsd ?? 0))) * 100)
        : 0,
      // Ghost cost from timed-out requests
      ghostCostUsd: result.cost.ghostCostUsd ?? 0,
      timedOutRequests: result.cost.timedOutRequests ?? 0,
      totalBilledUsd: (result.cost.total ?? 0) + (result.cost.ghostCostUsd ?? 0),
      geminiCacheHit,
      geminiCachedTokens,
      modelTier,
      deferredCount: deferralResult.deferredCount,
      activeToolCount: mergedCustomTools.length,
      guidesDelivered: deliveredGuides.size,
      schemaPruned: modelTier === "small",
      failedToolCalls: bridgeResult.failedToolCalls ?? 0,
      toolFailureRate: (result.stepsExecuted ?? 0) > 0
        ? Math.round(((bridgeResult.failedToolCalls ?? 0) / (result.stepsExecuted ?? 0)) * 100)
        : 0,
      ...(bridgeResult.failedTools && bridgeResult.failedTools.length > 0 && { failedTools: bridgeResult.failedTools }),
      truncatedTools: truncSummary.truncatedTools,
      totalTruncatedChars: truncSummary.totalTruncatedChars,
      turnsExceeded: turnBudgetSummary.turnsExceeded,
      totalBudgetTruncatedChars: turnBudgetSummary.totalBudgetTruncatedChars,
      ...(result.plannerMetrics && {
        sepStepsPlanned: result.plannerMetrics.stepsPlanned,
        sepStepsCompleted: result.plannerMetrics.stepsCompleted,
      }),
      ...(result.continuationMetrics && {
        postBatchContinuationFired: result.continuationMetrics.fired,
        postBatchContinuationAttempts: result.continuationMetrics.attempts,
        postBatchContinuationOutcome: result.continuationMetrics.outcome,
      }),
      // 1.5 + 3.2: Thinking token tracking (conditional -- only when thinking tokens detected)
      ...(bridgeResult.thinkingTokens != null && bridgeResult.thinkingTokens > 0 && {
        thinkingTokens: bridgeResult.thinkingTokens,
        totalOutputTokens: result.tokensUsed.output ?? 0,
        visibleOutputTokens: (result.tokensUsed.output ?? 0) - (bridgeResult.thinkingTokens ?? 0),
      }),
    },
    "Execution complete",
  );

  // Separate INFO summary when per-tool truncations occurred
  if (truncSummary.truncatedTools > 0) {
    deps.logger.info(
      {
        truncatedTools: truncSummary.truncatedTools,
        totalTruncatedChars: truncSummary.totalTruncatedChars,
        maxToolResultChars: config.maxToolResultChars,
        hint: "Increase agents.<name>.maxToolResultChars if these tools legitimately produce large output",
        errorKind: "resource" as const,
      },
      "Execution truncation summary",
    );
  }

  // Separate INFO summary when per-turn budget truncations occurred
  if (turnBudgetSummary.turnsExceeded > 0) {
    deps.logger.info(
      {
        turnsExceeded: turnBudgetSummary.turnsExceeded,
        totalBudgetTruncatedChars: turnBudgetSummary.totalBudgetTruncatedChars,
        maxTurnChars: 200_000,
        hint: "Per-turn aggregate tool result budget was exceeded; reduce tool output size or adjust budget",
        errorKind: "resource" as const,
      },
      "Turn budget truncation summary",
    );
  }

  // Write session metadata companion file with trace correlation
  // Fire-and-forget: metadata write failure must not affect execution
  const endReasonMap: Record<string, "success" | "error" | "timeout" | "budget_exceeded" | "budget_exhausted" | "circuit_open" | "provider_degraded"> = {
    stop: "success", end_turn: "success", error: "error",
    budget_exceeded: "budget_exceeded", budget_exhausted: "budget_exhausted",
    circuit_open: "circuit_open",
    provider_degraded: "provider_degraded", max_steps: "error",
    context_loop: "error", context_exhausted: "error",
  };
  try {
    sessionAdapter.writeSessionMetadata(sessionKey, {
      traceId: executionId,
      runId: executionId,
      sessionEnd: {
        type: "session_end",
        timestamp: new Date().toISOString(),
        endReason: endReasonMap[result.finishReason] ?? "error",
        durationMs,
        totalTokens: result.tokensUsed.total,
      },
    });
  } catch { /* fire-and-forget */ }

  // Check onboarding completion after execution
  // Fire-and-forget: triggers getWorkspaceStatus which records
  // onboardingCompletedAt when IDENTITY.md Name is filled or
  // BOOTSTRAP.md is deleted. Does not block response delivery.
  if (isOnboarding) {
    suppressError(getWorkspaceStatus(deps.workspaceDir), "onboarding status check");
  }

  // Persist user+agent paired content to memory (centralized in executor)
  // Pairing user message with agent response creates entries that carry enough
  // context for meaningful RAG retrieval. Standalone user messages like "Hello"
  // or "you choose" have no semantic value without the agent's response.
  //
  // Two-layer dedup defense:
  //   Layer 1: operationType gate -- skip cron/heartbeat/system-internal ops
  //            which are stateless/repetitive and would pollute the vector
  //            space with near-identical entries.
  //   Layer 2: content-hash dedup -- safety net for interactive retries.
  //
  // Non-blocking, non-fatal -- execution never fails due to memory store errors.
  const operationType = params.executionOverrides?.operationType;
  const skipMemoryForOperation =
    operationType != null && MEMORY_SKIP_OPERATIONS.has(operationType);

  if (
    deps.memoryPort &&
    result.response &&
    msg.text &&
    !skipMemoryForOperation &&
    shouldStorePairedMemory(msg.text, result.response)
  ) {
    const now = Date.now();
    const pairedContent = buildPairedMemoryContent(msg.text, result.response);
    const effectiveAgentId = agentId ?? "default";

    if (isDuplicatePairedMemory(pairedContent, effectiveAgentId)) {
      deps.logger.debug(
        { agentId: effectiveAgentId, sessionKey: formattedKey },
        "Paired memory skipped: duplicate content within dedup window",
      );
    } else {
      try {
        const userEntryId = randomUUID();
        const userStoreResult = await deps.memoryPort.store({
          id: userEntryId,
          tenantId: sessionKey.tenantId,
          agentId: effectiveAgentId,
          userId: sessionKey.userId,
          content: pairedContent,
          trustLevel: "learned",
          source: {
            who: sessionKey.userId,
            channel: msg.channelType ?? "unknown",
            sessionKey: formattedKey,
          },
          tags: ["conversation", "paired"],
          createdAt: now,
        });
        if (!userStoreResult.ok) {
          deps.logger.warn(
            { err: userStoreResult.error.message, hint: "Check database connectivity and disk space", errorKind: "dependency" as ErrorKind },
            "Memory store failed for user message",
          );
        } else if (deps.embeddingEnqueue) {
          deps.embeddingEnqueue(userEntryId, pairedContent);
        }
      } catch {
        // Memory storage failure is non-fatal -- errors already logged per-entry
      }
    }
  } else if (deps.memoryPort && result.response && msg.text) {
    // Memory not stored -- distinguish the two skip reasons for observability.
    if (skipMemoryForOperation) {
      deps.logger.debug(
        { operationType, sessionKey: formattedKey },
        "Paired memory skipped: non-interactive operation type",
      );
    } else {
      deps.logger.debug(
        { userLen: msg.text.trim().length, minUserChars: PAIRED_MIN_USER_CHARS, minCombinedChars: PAIRED_MIN_COMBINED_CHARS },
        "Paired memory skipped: content below quality threshold",
      );
    }
  }

  // Deregister active run before dispose
  if (deps.activeRunRegistry) {
    deps.activeRunRegistry.deregister(formattedKey);
  }

  // Strip verbose <functions> blocks from discover_tools results
  // in session history. Runs post-execution so the current turn's model
  // saw full schemas. Safe no-op when no discover_tools results exist.
  // Fence-aware: entries at or below the cache fence are not stripped to preserve prefix stability.
  stripDiscoverySchemas(sm, deps.logger, finalBreakpointIdx);

  session.dispose();
}
