// SPDX-License-Identifier: Apache-2.0
/**
 * Background completion runner: subscribes to background_task:completed and
 * background_task:failed events from the TypedEventBus and re-enters the
 * originating agent session with a formatted completion announcement.
 *
 * Per-session lock serialization is delegated to the existing session
 * manager (ComisSessionManager.withSession in packages/agent/src/session/).
 * The runner does NOT introduce its own queueing -- one turn per completion
 * event, ordering follows the existing per-session lock.
 *
 * Recursion bound: per-task incoming hop count + 1 must stay below
 * `maxBackgroundHops` (default 3). When the cap is hit, the runner emits
 * the fallback notification instead of triggering executor.execute().
 * The hop count is read from `task.origin.backgroundHopCount`
 * (populated by the originResolver).
 *
 * Latency-instrumentation hook: emits `background_task:reentered`
 * immediately before executor.execute(). Integration tests compute the delta
 * from `background_task:completed.timestamp` to this event for SLO tracking.
 *
 * Failure isolation: each handler is wrapped in suppressError so a single
 * completion's failure does not tear down the subscription (AGENTS §2.1).
 *
 * @module
 */

import { randomUUID } from "node:crypto";
import { suppressError } from "@comis/shared";
import type { NormalizedMessage, TypedEventBus, BackgroundTaskOrigin } from "@comis/core";
import { parseFormattedSessionKey } from "@comis/core";
import type { ComisLogger } from "@comis/infra";
import type { AgentExecutor } from "../executor/types.js";
import { formatCompletionAnnouncement } from "./completion-formatter.js";
import type { BackgroundTaskManager, NotifyFn } from "./background-task-manager.js";

/** Public-facing handle on the runner returned by createBackgroundCompletionRunner. */
export interface BackgroundCompletionRunner {
  /** Unsubscribe from the event bus. Idempotent. Awaitable so callers can
   *  ensure no in-flight handler outlives the daemon shutdown. */
  shutdown(): Promise<void>;
}

/** Minimal session-store contract the runner needs (fallback gate). */
export interface RunnerSessionStore {
  loadByFormattedKey(sessionKey: string): unknown | undefined;
}

export interface BackgroundCompletionRunnerDeps {
  eventBus: TypedEventBus;
  executor: AgentExecutor;
  sessionStore: RunnerSessionStore;
  taskManager: Pick<BackgroundTaskManager, "getTask">;
  fallbackNotifyFn: NotifyFn;
  maxBackgroundHops: number;
  logger: ComisLogger;
}

/**
 * Wire the completion runner against an event bus + executor + session store.
 * Subscriptions are installed synchronously; call shutdown() to remove them.
 */
export function createBackgroundCompletionRunner(
  deps: BackgroundCompletionRunnerDeps,
): BackgroundCompletionRunner {
  const log = deps.logger.child({ submodule: "background-completion-runner" });
  let stopped = false;
  let inflight: Promise<void> = Promise.resolve();

  const onCompleted = (data: { agentId: string; taskId: string; toolName: string; durationMs: number; origin: BackgroundTaskOrigin; timestamp: number }) => {
    if (stopped) return;
    const promise = handleEvent(data.taskId, "completed");
    inflight = inflight.then(() => promise).catch(() => undefined);
    suppressError(promise, "background completion handler (completed)");
  };

  const onFailed = (data: { agentId: string; taskId: string; toolName: string; error: string; durationMs: number; origin: BackgroundTaskOrigin; timestamp: number }) => {
    if (stopped) return;
    const promise = handleEvent(data.taskId, "failed");
    inflight = inflight.then(() => promise).catch(() => undefined);
    suppressError(promise, "background completion handler (failed)");
  };

  deps.eventBus.on("background_task:completed", onCompleted);
  deps.eventBus.on("background_task:failed", onFailed);

  async function handleEvent(taskId: string, kind: "completed" | "failed"): Promise<void> {
    const task = deps.taskManager.getTask(taskId);
    if (!task) {
      log.warn(
        { taskId, kind, hint: "Task disappeared from manager before runner could resolve it; no announcement injected", errorKind: "internal" as const },
        "Background completion: task not in manager",
      );
      return;
    }

    // Legacy task without origin -- emit fallback, keep file for audit.
    const origin = task.origin;
    if (!origin || !origin.sessionKey || !origin.agentId) {
      await fallbackForTask(task.toolName, task.origin?.agentId ?? "default", `Background task "${task.toolName}" completed.`);
      return;
    }

    // Hop cap. Read incoming hop count from origin (schema field populated
    // by the originResolver).
    const nextHopCount = (origin.backgroundHopCount ?? 0) + 1;
    if (nextHopCount >= deps.maxBackgroundHops) {
      log.info(
        { taskId, toolName: task.toolName, agentId: origin.agentId, hopCount: nextHopCount, max: deps.maxBackgroundHops },
        "Background completion: hop cap reached, falling back to user notification",
      );
      await fallbackForTask(
        task.toolName,
        origin.agentId,
        `Background task "${task.toolName}" completed but follow-up was skipped — recursion limit reached. Run again or check the result manually.`,
      );
      return;
    }

    // Missing session -- session expired while the task ran. No channel to deliver
    // to, so skip fallback (which would only produce a WARN from notification-service).
    const sessionExists = deps.sessionStore.loadByFormattedKey(origin.sessionKey) !== undefined;
    if (!sessionExists) {
      log.info(
        { taskId, sessionKey: origin.sessionKey },
        "Background completion: session expired, skipping re-entry",
      );
      return;
    }

    // Reconstruct the SessionKey object for executor.execute().
    const parsedKey = parseFormattedSessionKey(origin.sessionKey);
    if (!parsedKey) {
      log.warn(
        { taskId, sessionKey: origin.sessionKey, hint: "Persisted sessionKey is malformed; cannot route announcement", errorKind: "internal" as const },
        "Background completion: invalid sessionKey",
      );
      await fallbackForTask(task.toolName, origin.agentId, `Background task "${task.toolName}" completed (routing failed).`);
      return;
    }

    // Format the announcement (byte-identical trailing instruction).
    const announcement = formatCompletionAnnouncement(task);

    // Construct the synthetic NormalizedMessage (hop counter in metadata).
    const syntheticMsg: NormalizedMessage = {
      id: randomUUID(),
      channelId: origin.channelId,
      channelType: "background_task",
      senderId: "background-task-runner",
      text: announcement,
      timestamp: Date.now(),
      attachments: [],
      metadata: {
        backgroundHopCount: nextHopCount,
        backgroundTaskId: task.id,
        toolName: task.toolName,
        agentId: origin.agentId,
        traceId: origin.traceId ?? undefined,
      },
    };

    log.debug(
      { taskId, sessionKey: origin.sessionKey, agentId: origin.agentId, toolName: task.toolName, hopCount: nextHopCount },
      "Background completion runner: invoking executor",
    );

    // Emit background_task:reentered immediately before executor.execute().
    // Integration tests compute p95 latency from
    // background_task:completed.timestamp to this event's timestamp.
    deps.eventBus.emit("background_task:reentered", {
      taskId: task.id,
      agentId: origin.agentId,
      sessionKey: origin.sessionKey,
      hopCount: nextHopCount,
      timestamp: Date.now(),
    });

    // One turn per event. Existing session lock orders concurrent calls.
    try {
      await deps.executor.execute(
        syntheticMsg,
        parsedKey,
        undefined,
        undefined,
        origin.agentId,
      );
    } catch (err) {
      log.warn(
        { taskId, err, hint: "Executor failed mid-completion turn; subscription remains active", errorKind: "internal" as const },
        "Background completion: executor.execute() rejected",
      );
    }
  }

  async function fallbackForTask(toolName: string, agentId: string, message: string): Promise<void> {
    try {
      await deps.fallbackNotifyFn({
        agentId,
        message,
        priority: "normal",
        origin: "background_task",
      });
    } catch (err) {
      log.warn(
        { toolName, agentId, err, hint: "fallbackNotifyFn rejected; user will not see the completion notification for this task", errorKind: "internal" as const },
        "Background completion: fallbackNotifyFn rejected",
      );
    }
  }

  return {
    async shutdown(): Promise<void> {
      if (stopped) return;
      stopped = true;
      deps.eventBus.off("background_task:completed", onCompleted);
      deps.eventBus.off("background_task:failed", onFailed);
      // Wait for any in-flight handler to settle before returning.
      await inflight;
    },
  };
}
