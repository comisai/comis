/**
 * Execution Pipeline Phase 2: LLM Execution.
 *
 * Runs the LLM execution with timeout, thinking tag filter, typing
 * indicator management, tool TTL tracking, and abort signal setup.
 *
 * @module
 */

import { randomUUID } from "node:crypto";
import type { ChannelPort, NormalizedMessage, SessionKey, TypedEventBus, PerChannelStreamingConfig } from "@comis/core";
import { formatSessionKey, runWithContext, createDeliveryOrigin } from "@comis/core";
import { withTimeout, TimeoutError } from "@comis/shared";
import type { AgentExecutor } from "@comis/agent";
import type { CommandDirectives } from "@comis/agent";
import { sanitizeAssistantResponse, createThinkingTagFilter } from "@comis/agent";

import type { ExecutionPipelineDeps } from "./execution-pipeline.js";
import type { TypingLifecycleController } from "./typing-lifecycle-controller.js";

// ---------------------------------------------------------------------------
// Deps narrowing
// ---------------------------------------------------------------------------

/** Minimal deps needed for the execution phase. */
export type ExecuteDeps = Pick<
  ExecutionPipelineDeps,
  "eventBus" | "logger" | "assembleToolsForAgent" | "executionTimeoutMs" | "enforceFinalTag"
>;

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

/** Result from LLM execution. */
export interface ExecuteResult {
  /** Raw execution result from the agent executor. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  result: any;
  /** Accumulated delta text (streaming path). */
  accumulated: string;
  /** Tokens used. */
  tokensUsed: number;
  /** Cost. */
  cost: number;
  /** Finish reason. */
  finishReason: string;
  /** Delivery abort signal (used in delivery phase). */
  deliverySignal: AbortSignal;
  /** Whether this was a resource abort (budget, steps, etc.). */
  resourceAborted: boolean;
  /** The abort reason if aborted. */
  abortReason: string | undefined;
  /** Cleanup function to remove event listeners. */
  cleanup: () => void;
  /** Whether timeout occurred (execution returned canned error). */
  timedOut: boolean;
}

// ---------------------------------------------------------------------------
// Phase function
// ---------------------------------------------------------------------------

/**
 * Run LLM execution with timeout, streaming delta accumulation,
 * thinking tag filtering, and abort signal management.
 *
 * Returns the execution result, accumulated text, and delivery abort signal
 * for use by downstream phases.
 */
export async function executeLlm(
  deps: ExecuteDeps,
  adapter: ChannelPort,
  effectiveMsg: NormalizedMessage,
  sessionKey: SessionKey,
  agentId: string,
  executor: AgentExecutor,
  trustLevel: "guest" | "user" | "admin",
  blockStreamCfg: PerChannelStreamingConfig,
  replyTo: string | undefined,
  typingLifecycle: TypingLifecycleController | undefined,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tools: any[] | undefined,
  directives: Record<string, unknown> | undefined,
): Promise<ExecuteResult> {
  // Track active tools and periodically refresh TTL while tools are in-flight
  let activeToolCount = 0;
  let toolTtlRefreshTimer: ReturnType<typeof setInterval> | null = null;

  const onToolStarted = (): void => {
    typingLifecycle?.controller.refreshTtl();
    activeToolCount++;
    if (!toolTtlRefreshTimer && typingLifecycle?.controller.isActive) {
      toolTtlRefreshTimer = setInterval(() => {
        typingLifecycle?.controller.refreshTtl();
      }, 30_000);
    }
  };

  const onToolExecuted = (): void => {
    activeToolCount = Math.max(0, activeToolCount - 1);
    if (activeToolCount === 0 && toolTtlRefreshTimer) {
      clearInterval(toolTtlRefreshTimer);
      toolTtlRefreshTimer = null;
    }
  };

  deps.eventBus.on("tool:started", onToolStarted);
  deps.eventBus.on("tool:executed", onToolExecuted);

  // Delivery-scoped AbortController: cancelled when execution:aborted fires for this session
  const deliveryAbortController = new AbortController();
  let deliveryAbortReason: string | undefined;
  const onExecutionAborted = (event: { sessionKey: SessionKey; reason: string }): void => {
    if (formatSessionKey(event.sessionKey) === formatSessionKey(sessionKey)) {
      deliveryAbortReason = event.reason;
      deliveryAbortController.abort(event.reason);
    }
  };
  deps.eventBus.on("execution:aborted", onExecutionAborted);

  const cleanup = (): void => {
    deps.eventBus.off("tool:started", onToolStarted);
    deps.eventBus.off("tool:executed", onToolExecuted);
    if (toolTtlRefreshTimer) { clearInterval(toolTtlRefreshTimer); toolTtlRefreshTimer = null; }
    deps.eventBus.off("execution:aborted", onExecutionAborted);
  };

  // 'thinking' mode: start typing when execution begins
  if (blockStreamCfg.typingMode === "thinking" && typingLifecycle?.controller && !typingLifecycle.controller.isActive) {
    typingLifecycle.controller.start(effectiveMsg.channelId);
    deps.eventBus.emit("typing:started", {
      channelId: adapter.channelId,
      chatId: effectiveMsg.channelId,
      mode: blockStreamCfg.typingMode,
      timestamp: Date.now(),
    });
  }

  // Accumulate full response via onDelta -- NO placeholder message sent
  let accumulated = "";
  const thinkFilter = createThinkingTagFilter({ enforceFinalTag: deps.enforceFinalTag });
  const onDelta = (delta: string): void => {
    const filtered = thinkFilter.feed(delta);
    if (filtered) {
      accumulated += filtered;
    }
    // Refresh TTL unconditionally — any delta (thinking or visible) proves
    // the agent is alive. Prevents typing indicator expiry during extended
    // LLM reasoning phases where thinkFilter strips all content.
    typingLifecycle?.controller.refreshTtl();
  };

  let result;
  try {
    result = await withTimeout(
      runWithContext({
        traceId: randomUUID(),
        tenantId: sessionKey.tenantId,
        userId: sessionKey.userId,
        sessionKey: formatSessionKey(sessionKey),
        startedAt: Date.now(),
        trustLevel,
        channelType: adapter.channelType,
        deliveryOrigin: createDeliveryOrigin({
          channelType: adapter.channelType,
          channelId: effectiveMsg.channelId,
          userId: sessionKey.userId,
          threadId: effectiveMsg.metadata?.threadId as string | undefined,
          tenantId: sessionKey.tenantId,
        }),
      }, () => executor.execute(effectiveMsg, sessionKey, tools, onDelta, agentId, directives as CommandDirectives | undefined, undefined, { operationType: "interactive" as const })),
      deps.executionTimeoutMs ?? 600_000,
      "Agent execution",
    );
  } catch (err) {
    if (err instanceof TimeoutError) {
      deps.logger.warn({
        agentId,
        sessionKey: formatSessionKey(sessionKey),
        durationMs: deps.executionTimeoutMs ?? 600_000,
        hint: "Agent execution timed out; sending canned error to user",
        errorKind: "timeout",
      }, "Execution pipeline timeout");

      deps.eventBus.emit("execution:aborted", {
        sessionKey,
        reason: "pipeline_timeout",
        agentId,
        timestamp: Date.now(),
      });

      await adapter.sendMessage(
        effectiveMsg.channelId,
        "I'm having trouble processing your request right now. Please try again in a moment.",
        { replyTo },
      ).catch(() => { /* adapter logs internally */ });

      return {
        result: undefined,
        accumulated: "",
        tokensUsed: 0,
        cost: 0,
        finishReason: "timeout",
        deliverySignal: deliveryAbortController.signal,
        resourceAborted: false,
        abortReason: undefined,
        cleanup,
        timedOut: true,
      };
    }
    throw err;
  }

  // Flush any buffered partial text from the thinking filter
  const flushed = thinkFilter.flush();
  if (flushed) accumulated += flushed;

  // Sanitize accumulated text
  if (accumulated) {
    accumulated = sanitizeAssistantResponse(accumulated);
  }

  // Resource aborts with recovered response
  const RESOURCE_ABORT_REASONS = new Set(["budget_exceeded", "max_steps", "context_exhausted", "circuit_breaker"]);
  const resourceAborted = deliveryAbortController.signal.aborted && deliveryAbortReason != null && RESOURCE_ABORT_REASONS.has(deliveryAbortReason);
  const recoveryAbortController = resourceAborted ? new AbortController() : undefined;
  const deliverySignal = recoveryAbortController?.signal ?? deliveryAbortController.signal;
  if (resourceAborted) {
    deps.logger.info({
      agentId,
      abortReason: deliveryAbortReason,
      finishReason: result.finishReason,
      hasResponse: !!result.response,
      hint: "Resource abort detected; using fresh delivery signal so recovered response can reach user",
      errorKind: "resource" as const,
    }, "Bypassing pre-aborted delivery signal for resource abort recovery");
  }

  return {
    result,
    accumulated,
    tokensUsed: result.tokensUsed.total,
    cost: result.cost.total,
    finishReason: result.finishReason,
    deliverySignal,
    resourceAborted,
    abortReason: deliveryAbortReason,
    cleanup,
    timedOut: false,
  };
}
