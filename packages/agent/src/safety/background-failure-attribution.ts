// SPDX-License-Identifier: Apache-2.0
/**
 * Attribute a BACKGROUND task's failure to the tool that actually failed.
 *
 * The per-tool retry breaker is recorded against the tool that RETURNED the
 * error. Auto-backgrounding breaks that assumption: it converts a slow tool into
 * a non-error "moved to the background" result, so the originating tool reports
 * SUCCESS on every launch and its consecutive-failure counter resets each time —
 * it can never trip. The real failure surfaces later on the `background_tasks`
 * POLLER, which relays it and trips instead.
 *
 * The consequence is the exact inverse of what a breaker is for: the agent loses
 * its ability to OBSERVE results while the tool that is actually failing stays
 * completely unthrottled. Live: 20+ launches of one report tool, each burning the
 * full MCP call deadline, until the turn's wall-clock budget expired and the user
 * got a canned error after ten minutes.
 *
 * This module closes the loop. `background_task:failed` already carries the
 * ORIGINATING `toolName` (the manager stamps it from the task record), so the
 * breaker can be told which tool to count — no parsing of the poller's prose
 * error text, which names the tool only in free-form English.
 *
 * The other half of the fix lives at the recording site: the poller must NOT be
 * blamed for relaying a failure it merely reported. See
 * `isRelayedBackgroundFailure`.
 *
 * @module
 */

import type { ComisLogger, TypedEventBus } from "@comis/core";

/** The polling tool that reports background task outcomes. Never the culprit. */
export const BACKGROUND_POLLER_TOOL = "background_tasks";

/**
 * The marker our own poller result carries when it relays a task failure.
 * Matching on it keeps the poller's own genuine failures (a bad taskId, a
 * storage error) counting against it, while a relayed task failure does not.
 */
const RELAYED_FAILURE_MARKER = "Background task failed";

/**
 * True when this failure is the poller reporting SOMEONE ELSE's failure.
 * Such a result is the poller working correctly — counting it against the
 * poller trips the one tool the agent needs in order to see what went wrong.
 */
export function isRelayedBackgroundFailure(
  toolName: string,
  errorText: string | undefined,
): boolean {
  return toolName === BACKGROUND_POLLER_TOOL
    && errorText !== undefined
    && errorText.includes(RELAYED_FAILURE_MARKER);
}

/** The breaker surface this module needs (structural — no import cycle). */
export interface BackgroundFailureBreaker {
  recordResult(
    toolName: string,
    args: Record<string, unknown>,
    success: boolean,
    errorText?: string,
  ): unknown;
}

export interface BackgroundFailureAttributionDeps {
  readonly eventBus: TypedEventBus;
  readonly breaker: BackgroundFailureBreaker;
  readonly logger?: ComisLogger;
  /** Scope to one agent; undefined attributes every agent's failures. */
  readonly agentId?: string;
}

/**
 * Subscribe so every background-task failure counts against the tool that
 * launched it. Returns an unsubscribe function — callers MUST call it on
 * teardown or the listener outlives the execution that owns the breaker.
 *
 * Args are passed empty: the breaker's same-args fingerprint is a retry signal
 * for inline calls, and a backgrounded launch is already past that point. What
 * matters here is the per-tool consecutive-failure count, which empty args still
 * advance.
 */
export function attributeBackgroundFailuresToOriginatingTool(
  deps: BackgroundFailureAttributionDeps,
): () => void {
  const onFailed = (p: {
    toolName?: string;
    error?: string;
    agentId?: string;
    taskId?: string;
  }): void => {
    const toolName = p.toolName;
    if (toolName === undefined || toolName.length === 0) return;
    if (deps.agentId !== undefined && p.agentId !== undefined && p.agentId !== deps.agentId) {
      return;
    }
    // A poller task failing is not the poller's fault either — and it is never
    // the originating tool, so it would be meaningless to count.
    if (toolName === BACKGROUND_POLLER_TOOL) return;
    deps.breaker.recordResult(toolName, {}, false, p.error);
    deps.logger?.debug(
      {
        step: "background-failure-attribution",
        toolName,
        taskId: p.taskId,
        agentId: p.agentId,
        hint:
          "counted a background task failure against the tool that launched it — without this the tool reports success on every launch (auto-backgrounding) and its breaker never trips",
      },
      "background task failure attributed to its originating tool",
    );
  };
  deps.eventBus.on("background_task:failed", onFailed as never);
  return () => {
    deps.eventBus.off("background_task:failed", onFailed as never);
  };
}
