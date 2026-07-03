// SPDX-License-Identifier: Apache-2.0
/**
 * Execution pipeline stage: LLM execution.
 *
 * Runs the LLM execution with timeout, thinking tag filter, typing
 * indicator management, tool TTL tracking, and abort signal setup.
 *
 * @module
 */

import { randomUUID } from "node:crypto";
import type { ChannelPort, NormalizedMessage, SessionKey, PerChannelStreamingConfig } from "@comis/core";
import { formatSessionKey, runWithContext, tryGetContext, createDeliveryOrigin, systemNowMs, systemSetInterval, systemClearInterval, systemScheduleTimeout } from "@comis/core";
import { withTimeout, TimeoutError } from "@comis/shared";
import type { AgentExecutor } from "@comis/agent";
import type { CommandDirectives } from "../commands/index.js";
import { sanitizeAssistantResponse, createThinkingTagFilter } from "@comis/agent";

import type { ExecutionPipelineDeps } from "./execution-pipeline.js";
import type { TypingLifecycleController } from "@comis/channels";

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
// Pipeline stage function
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
      toolTtlRefreshTimer = systemSetInterval(() => {
        typingLifecycle?.controller.refreshTtl();
      }, 30_000);
    }
  };

  const onToolExecuted = (): void => {
    activeToolCount = Math.max(0, activeToolCount - 1);
    if (activeToolCount === 0 && toolTtlRefreshTimer) {
      systemClearInterval(toolTtlRefreshTimer);
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
    if (toolTtlRefreshTimer) { systemClearInterval(toolTtlRefreshTimer); toolTtlRefreshTimer = null; }
    deps.eventBus.off("execution:aborted", onExecutionAborted);
  };

  // 'thinking' mode: start typing when execution begins
  if (blockStreamCfg.typingMode === "thinking" && typingLifecycle?.controller && !typingLifecycle.controller.isActive) {
    typingLifecycle.controller.start(effectiveMsg.channelId);
    deps.eventBus.emit("typing:started", {
      channelId: adapter.channelId,
      chatId: effectiveMsg.channelId,
      mode: blockStreamCfg.typingMode,
      timestamp: systemNowMs(),
    });
  }

  // Accumulate full response via onDelta -- NO placeholder message sent
  // Only text deltas contribute to accumulated; thinking deltas (native-reasoning
  // models) still refresh the typing TTL so the indicator stays alive during
  // extended LLM reasoning, but never reach the channel.
  let accumulated = "";
  // SA2: createThinkingTagFilter is only constructed when enforceFinalTag is true
  // (Comis's own <think>/<final> coaching path). Native-reasoning models (qwen3.6,
  // deepseek-r1) set enforceFinalTag=false and take a pure SDK path -- no regex
  // over a tagless stream.
  const thinkFilter = deps.enforceFinalTag
    ? createThinkingTagFilter({ enforceFinalTag: true })
    : null;
  const onDelta = (delta: string, kind: "text" | "thinking"): void => {
    if (kind === "text") {
      // SA1: only text deltas accumulate. thinking deltas are forwarded by the
      // bridge with kind='thinking' so we still refresh TTL below, but they
      // must not reach the channel.
      const filtered = thinkFilter ? thinkFilter.feed(delta) : delta;
      if (filtered) {
        accumulated += filtered;
      }
    }
    // Refresh TTL on BOTH kinds — any delta proves the agent is alive.
    // Prevents typing indicator expiry during extended reasoning phases.
    typingLifecycle?.controller.refreshTtl();
  };

  let result;
  try {
    result = await withTimeout(
      runWithContext({
        // Reuse the ingress traceId from the channel-adapter runWithContext
        // wrap. Fall back to a fresh mint only when called outside any
        // ingress scope (scheduler heartbeats, background tasks, direct RPC
        // entries that don't carry channel context).
        traceId: tryGetContext()?.traceId ?? randomUUID(),
        tenantId: sessionKey.tenantId,
        userId: sessionKey.userId,
        // Stamp the RESOLVED agentId onto the request ALS so
        // the delivery stage (deliverToChannel, which runs inside this context)
        // reads ctx.agentId and binds the outbound reply → trajectory (the
        // reaction-attribution keystone). Without this, ctx.agentId is undefined
        // at delivery → the reply's agentId is never persisted into the queue
        // optionsJson and BOTH binding paths (the direct ack + the drain)
        // fail-closed, so a reaction on the reply map-misses.
        // agentId is the resolved-agent parameter (non-empty).
        agentId,
        sessionKey: formatSessionKey(sessionKey),
        startedAt: systemNowMs(),
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
      systemScheduleTimeout,
      "Agent execution",
    );
  } catch (err) {
    if (err instanceof TimeoutError) {
      deps.logger.warn({
        agentId,
        sessionKey: formatSessionKey(sessionKey),
        durationMs: deps.executionTimeoutMs ?? 600_000,
        hint: "Agent execution timed out; sending canned error to user",
        errorKind: "timeout" as const,
      }, "Execution pipeline timeout");

      deps.eventBus.emit("execution:aborted", {
        sessionKey,
        reason: "pipeline_timeout",
        agentId,
        timestamp: systemNowMs(),
      });

      await adapter.sendMessage(
        effectiveMsg.channelId,
        "I'm having trouble processing your request right now. Please try again in a moment.",
        { replyTo },
      // eslint-disable-next-line no-restricted-syntax -- intentional fire-and-forget
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
    // @allow-throw: re-raise non-TimeoutError to the inbound orchestrator pipeline (executeAndDeliver -> inbound-route); channel-adapter context catches and converts to user-visible degraded response. Boundary adapter pattern for channel/RPC inbound boundaries.
    throw err;
  }

  // Flush any buffered partial text from the thinking filter (coaching path only).
  // SA2: thinkFilter is null for native-reasoning models — guard required to prevent crash.
  if (thinkFilter) {
    const flushed = thinkFilter.flush();
    if (flushed) accumulated += flushed;
  }

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
