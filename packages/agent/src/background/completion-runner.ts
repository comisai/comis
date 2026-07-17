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
 * completion's failure does not tear down the subscription.
 *
 * @module
 */

import { randomUUID } from "node:crypto";
import { fromPromise, suppressError, tryCatch, type Result } from "@comis/shared";
import {
  createDeliveryOrigin,
  createResolvedRequestContext,
  emitObservationalEventSafely,
  parseFormattedSessionKey,
  RequestContextSchema,
  runWithContext,
  systemNowMs,
  toSafeErrorLogString,
  type BackgroundTaskOrigin,
  type ComisLogger,
  type NormalizedMessage,
  type RequestContext,
  type ResolvedRequestContextSeed,
  type SessionKey,
  type TypedEventBus,
} from "@comis/core";
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
  getExecutor: (agentId: string) => AgentExecutor;
  sessionStore: RunnerSessionStore;
  /**
   * Includes `transitionDispatchState` in addition to `getTask`. fallbackForTask
   * uses transitionDispatchState to persist `dispatchState = "notified"` BEFORE
   * firing `fallbackNotifyFn`, so a daemon SIGKILL between persist and fire does
   * NOT leak a duplicate notification on recovery (the at-most-once gate binds
   * against on-disk state). The daemon-side wiring at
   * setup-background-completion-runner.ts already passes a manager with
   * both methods.
   */
  taskManager: Pick<BackgroundTaskManager, "getTask" | "transitionDispatchState">;
  fallbackNotifyFn: NotifyFn;
  maxBackgroundHops: number;
  /**
   * LIVE-TURN oracle (mirrors CompletionDispatcherDeps.isTurnInFlight): true
   * while the FORMATTED sessionKey has a turn currently executing. A task
   * promoted mid-turn is consumed by its own still-running turn via the
   * background_tasks stub protocol — a re-entry turn now would serialize a
   * redundant continuation behind the live turn. When absent, behavior is
   * unchanged.
   */
  isTurnInFlight?: (formattedSessionKey: string) => boolean;
  logger: ComisLogger;
}

/**
 * Rebuild the request authority for a persisted completion without consulting
 * ambient AsyncLocalStorage. A completion can resume after the originating
 * request ended or while an unrelated request is active, so persisted routing
 * identity is the only valid source and the resumed turn always starts as a
 * guest.
 */
function createReentryContext(
  origin: BackgroundTaskOrigin,
  parsedKey: SessionKey,
): Result<RequestContext, Error> {
  const built = tryCatch(() => {
    const persistedTrace = RequestContextSchema.shape.traceId.safeParse(origin.traceId);
    const traceId = persistedTrace.success ? persistedTrace.data : randomUUID();
    const deliveryOrigin = createDeliveryOrigin({
      channelType: origin.channelType,
      channelId: origin.channelId,
      userId: parsedKey.userId,
      tenantId: parsedKey.tenantId,
    });
    const seed: ResolvedRequestContextSeed = {
      tenantId: parsedKey.tenantId,
      userId: parsedKey.userId,
      sessionKey: parsedKey,
      agentId: origin.agentId,
      traceId,
      startedAt: systemNowMs(),
      trustLevel: "guest" as const,
      channelType: deliveryOrigin.channelType,
      deliveryOrigin,
    };
    return seed;
  });
  if (!built.ok) return built;
  return createResolvedRequestContext(built.value);
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

    // At-most-once: the dispatcher subscribed BEFORE this runner (see
    // setup-background-completion-runner.ts) and already transitioned
    // task.dispatchState. When state is "notified", the dispatcher fired
    // the user-visible fallback; the runner stays out of the way to
    // enforce single-owner notification routing (zero spurious outbound).
    if (task.dispatchState === "notified") {
      log.debug(
        {
          taskId,
          dispatchState: task.dispatchState,
          // Include originating traceId so operator log streams stay
          // continuous across the dispatcher / runner boundary.
          traceId: task.origin?.traceId ?? undefined,
          hint: "Dispatcher already fired fallback notification (at-most-once)",
        },
        "Background completion runner: skipped (dispatcher fired fallback)",
      );
      return;
    }

    // origin is producer-required (background-task-manager promote()
    // rejects missing-origin) so we read it directly.
    const origin = task.origin;

    // Hop cap. Read incoming hop count from origin (schema field populated
    // by the originResolver).
    const nextHopCount = (origin.backgroundHopCount ?? 0) + 1;
    if (nextHopCount >= deps.maxBackgroundHops) {
      log.info(
        {
          taskId,
          toolName: task.toolName,
          agentId: origin.agentId,
          hopCount: nextHopCount,
          max: deps.maxBackgroundHops,
          // traceId from origin keeps operator logs threaded.
          traceId: origin.traceId ?? undefined,
        },
        "Background completion: hop cap reached, falling back to user notification",
      );
      await fallbackForTask(
        task.id,
        origin.agentId,
        task.toolName,
        `Background task "${task.toolName}" completed but follow-up was skipped — recursion limit reached. Run again or check the result manually.`,
      );
      return;
    }

    // LIVE-TURN skip (when wired): the origin turn is STILL EXECUTING and owns
    // consumption via the background_tasks stub protocol — a re-entry turn now
    // would only serialize a redundant continuation behind the live turn. The
    // dispatcher's matching check already suppressed the fallback notice; the
    // result stays readable via `background_tasks` if the live turn raced past it.
    if (deps.isTurnInFlight?.(origin.sessionKey) === true) {
      log.debug(
        {
          taskId,
          sessionKey: origin.sessionKey,
          traceId: origin.traceId ?? undefined,
          hint: "Origin turn in flight — live turn owns consumption; no re-entry",
        },
        "Background completion runner: skipped (origin turn live)",
      );
      return;
    }

    // No active session for this sessionKey in the in-memory store. The
    // originating session may have ended (user closed the channel) OR may live
    // in JSONL but not be currently registered. Either way, there is no
    // streaming channel to inject into, so skip fallback (which would only
    // produce a WARN from notification-service).
    const sessionExists = deps.sessionStore.loadByFormattedKey(origin.sessionKey) !== undefined;
    if (!sessionExists) {
      log.info(
        {
          taskId,
          sessionKey: origin.sessionKey,
          // traceId from origin so this INFO log line stays threaded with the
          // originating request's trace stream even though the runner runs in a
          // background context (the ALS traceId at this point may differ from
          // origin.traceId).
          traceId: origin.traceId ?? undefined,
          hint: "No active in-memory session for this sessionKey; runner will skip re-entry. Task result remains in JSONL for offline review.",
        },
        "Background completion: no active session for re-entry",
      );
      return;
    }

    // Reconstruct the SessionKey object for executor.execute().
    const parsedKey = parseFormattedSessionKey(origin.sessionKey);
    if (!parsedKey) {
      log.warn(
        {
          taskId,
          sessionKey: origin.sessionKey,
          // traceId from origin keeps operator logs threaded.
          traceId: origin.traceId ?? undefined,
          hint: "Persisted sessionKey is malformed; cannot route announcement",
          errorKind: "internal" as const,
        },
        "Background completion: invalid sessionKey",
      );
      await fallbackForTask(task.id, origin.agentId, task.toolName, `Background task "${task.toolName}" completed (routing failed).`);
      return;
    }

    const reentryContext = createReentryContext(origin, parsedKey);
    if (!reentryContext.ok) {
      log.warn(
        {
          taskId,
          sessionKey: origin.sessionKey,
          hint: "Persisted completion route is invalid; inspect or remove the task state before retrying",
          errorKind: "validation" as const,
        },
        "Background completion: invalid re-entry context",
      );
      await fallbackForTask(
        task.id,
        origin.agentId,
        task.toolName,
        `Background task "${task.toolName}" completed (routing failed).`,
      );
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
      timestamp: systemNowMs(),
      attachments: [],
      metadata: {
        backgroundHopCount: nextHopCount,
        backgroundTaskId: task.id,
        toolName: task.toolName,
        agentId: origin.agentId,
        traceId: reentryContext.value.traceId,
      },
    };

    const scopedInvocation = tryCatch(() => runWithContext(
      reentryContext.value,
      async () => {
        log.debug(
          {
            taskId,
            sessionKey: origin.sessionKey,
            agentId: origin.agentId,
            toolName: task.toolName,
            hopCount: nextHopCount,
            traceId: reentryContext.value.traceId,
          },
          "Background completion runner: invoking executor",
        );

        // Emit immediately before executor.execute(). Integration tests compute
        // latency from background_task:completed.timestamp to this event.
        emitObservationalEventSafely({ eventBus: deps.eventBus, logger: log }, "background_task:reentered", {
          taskId: task.id,
          agentId: origin.agentId,
          sessionKey: origin.sessionKey,
          hopCount: nextHopCount,
          traceId: reentryContext.value.traceId,
          timestamp: systemNowMs(),
        });

        // One turn per event. Existing session lock orders concurrent calls.
        const executor = tryCatch(() => deps.getExecutor(origin.agentId));
        if (!executor.ok) return executor;
        const execution = tryCatch(() => executor.value.execute(
          syntheticMsg,
          parsedKey,
          undefined,
          undefined,
          origin.agentId,
        ));
        if (!execution.ok) return execution;
        return fromPromise(execution.value);
      },
    ));
    const scopedResult = scopedInvocation.ok
      ? await fromPromise(scopedInvocation.value)
      : scopedInvocation;
    const executionResult = scopedResult.ok ? scopedResult.value : scopedResult;
    if (!executionResult.ok) {
      log.warn(
        {
          taskId,
          err: toSafeErrorLogString(executionResult.error),
          traceId: reentryContext.value.traceId,
          hint: "Executor failed mid-completion turn; subscription remains active",
          errorKind: "internal" as const,
        },
        "Background completion: executor.execute() rejected",
      );
    }
  }

  /**
   * Two-phase commit:
   *
   * 1. transitionDispatchState(taskId, "notified") — synchronously persists
   *    `dispatchState = "notified"` to disk (via persistTaskSync inside the
   *    manager). This MUST run before fallbackNotifyFn so a SIGKILL between
   *    persist and fire does NOT leak a duplicate on recovery: the at-most-
   *    once gate at the top of handleEvent (which reads task.dispatchState)
   *    sees "notified" and skips re-firing. Without this ordering, the gate
   *    misses and the user receives the notification twice.
   *
   * 2. fallbackNotifyFn(...) — actually deliver the user-visible
   *    notification. May reject (channel offline, rate-limited, etc.); the
   *    failure is logged at WARN. The persisted state stays at "notified" —
   *    the user did not see the notification, but the at-most-once contract
   *    takes precedence over delivery completeness.
   */
  async function fallbackForTask(taskId: string, agentId: string, toolName: string, message: string): Promise<void> {
    // Phase 1: persist state. transitionDispatchState may return false if
    // the task disappeared from the manager between handler entry and this
    // call (e.g., explicit cleanup). In that case there is nothing to gate
    // on; we still fire so the user sees the completion. The persist is
    // synchronous so the on-disk state is updated before phase 2.
    deps.taskManager.transitionDispatchState(taskId, "notified");

    // Phase 2: fire user-visible notification.
    try {
      await deps.fallbackNotifyFn({
        agentId,
        message,
        priority: "normal",
        origin: "background_task",
      });
    } catch (err) {
      log.warn(
        { taskId, toolName, agentId, err, hint: "fallbackNotifyFn rejected; user will not see the completion notification for this task. dispatchState already persisted as \"notified\" — no duplicate on recovery.", errorKind: "internal" as const },
        "Background completion: fallbackNotifyFn rejected (post-persist)",
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
