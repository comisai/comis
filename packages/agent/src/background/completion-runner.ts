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

import type { AgentTool } from "@earendil-works/pi-agent-core";
import { randomUUID } from "node:crypto";
import { fromPromise, isSilentResponse, suppressError, tryCatch, type Result } from "@comis/shared";
import {
  createDeliveryOrigin,
  createResolvedRequestContext,
  conversationScopeToSessionKey,
  emitObservationalEventSafely,
  formatSessionKey,
  RequestContextSchema,
  runWithContext,
  systemNowMs,
  toSafeErrorLogString,
  type BackgroundTaskOrigin,
  type ComisLogger,
  type ErrorKind,
  type NormalizedMessage,
  type RequestContext,
  type ResolvedRequestContextSeed,
  type SessionKey,
  type SessionQueryScope,
  type SessionStoreError,
  type TypedEventBus,
} from "@comis/core";
import type { AgentExecutor } from "../executor/types.js";
import { formatCompletionAnnouncement } from "./completion-formatter.js";
import type { BackgroundTaskManager } from "./background-task-manager.js";

/** Public-facing handle on the runner returned by createBackgroundCompletionRunner. */
export interface BackgroundCompletionRunner {
  /** Unsubscribe from the event bus. Idempotent. Awaitable so callers can
   *  ensure no in-flight handler outlives the daemon shutdown. */
  shutdown(): Promise<void>;
}

export interface BackgroundCompletionDeliveryError {
  readonly errorKind: ErrorKind;
  readonly message: string;
}

export interface BackgroundCompletionDeliveryInput {
  readonly taskId: string;
  readonly origin: BackgroundTaskOrigin;
  readonly response: string;
  readonly executionId: string;
  readonly idempotencyKey: string;
}

/** Session-store dependency retained by daemon composition; it is not routing authority. */
export interface RunnerSessionStore {
  loadByRef(scope: SessionQueryScope, conversationRef: BackgroundTaskOrigin["conversationRef"]): Result<unknown | undefined, SessionStoreError>;
}

export interface BackgroundCompletionRunnerDeps {
  eventBus: TypedEventBus;
  getExecutor: (agentId: string) => AgentExecutor;
  /** Assemble the same agent-scoped tools available to an ordinary inbound turn. */
  assembleToolsForAgent?: (
    agentId: string,
    options?: { sessionKey?: SessionKey },
  ) => Promise<AgentTool[]>;
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
  taskManager: Pick<
    BackgroundTaskManager,
    "getTask" | "transitionDispatchState" | "scheduleDispatchRetry"
  >;
  /** Deliver the finalized continuation through the exact persisted channel
   *  authority. The runner owns execution; the composition root owns adapters. */
  deliverCompletion: (
    input: BackgroundCompletionDeliveryInput,
  ) => Promise<Result<void, BackgroundCompletionDeliveryError>>;
  deliverFallback: (
    input: BackgroundCompletionDeliveryInput,
  ) => Promise<Result<void, BackgroundCompletionDeliveryError>>;
  maxBackgroundHops: number;
  /**
   * LIVE-TURN oracle (mirrors CompletionDispatcherDeps.isTurnInFlight): true
   * while the FORMATTED sessionKey has a turn currently executing. A task
   * promoted mid-turn is consumed by its own still-running turn via the
   * single blocking `background_tasks read_output` protocol, so a re-entry
   * turn would serialize a redundant continuation behind the live turn. When
   * absent, behavior is unchanged.
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
    const deliveryOrigin = createDeliveryOrigin(origin.deliveryOrigin);
    const seed: ResolvedRequestContextSeed = {
      tenantId: origin.turnScope.conversation.tenantId,
      userId: parsedKey.userId,
      sessionKey: parsedKey,
      agentId: origin.turnScope.conversation.agentId,
      traceId,
      startedAt: systemNowMs(),
      trustLevel: "guest" as const,
      channelType: deliveryOrigin.channelType,
      deliveryOrigin,
      turnScope: origin.turnScope,
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
    if (
      task.dispatchState === "delivered"
      || task.dispatchState === "fallback_delivered"
      || task.dispatchState === "consumed_live"
    ) {
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
    if (!deps.taskManager.transitionDispatchState(taskId, "executing", ["pending"])) {
      log.debug(
        { taskId, dispatchState: task.dispatchState, hint: "Another completion attempt owns this task" },
        "Background completion runner: retry claim not acquired",
      );
      return;
    }

    // origin is producer-required (background-task-manager promote()
    // rejects missing-origin) so we read it directly.
    const origin = task.origin;
    const agentId = origin.turnScope.conversation.agentId;
    if (task.notificationPolicy === "silent") {
      deps.taskManager.transitionDispatchState(taskId, "delivered", ["executing"]);
      return;
    }
    if (task.notificationPolicy === "immediate") {
      await fallbackForTask(
        task.id,
        agentId,
        task.toolName,
        `Background task "${task.toolName}" ${kind}.`,
      );
      return;
    }
    const projectedSession = conversationScopeToSessionKey(origin.turnScope.conversation);
    if (!projectedSession.ok) {
      log.warn({
        taskId,
        conversationRef: origin.conversationRef,
        hint: "Inspect or remove the persisted background task authority before retrying",
        errorKind: projectedSession.error.errorKind,
      }, "Background completion: invalid persisted conversation scope");
      await fallbackForTask(task.id, agentId, task.toolName, `Background task "${task.toolName}" completed (routing failed).`);
      return;
    }
    const parsedKey = projectedSession.value;
    const formattedSessionKey = formatSessionKey(parsedKey);

    // Hop cap. Read incoming hop count from origin (schema field populated
    // by the originResolver).
    const nextHopCount = (origin.backgroundHopCount ?? 0) + 1;
    if (nextHopCount >= deps.maxBackgroundHops) {
      log.info(
        {
          taskId,
          toolName: task.toolName,
          agentId,
          hopCount: nextHopCount,
          max: deps.maxBackgroundHops,
          // traceId from origin keeps operator logs threaded.
          traceId: origin.traceId ?? undefined,
        },
        "Background completion: hop cap reached, falling back to user notification",
      );
      await fallbackForTask(
        task.id,
        agentId,
        task.toolName,
        `Background task "${task.toolName}" completed but follow-up was skipped — recursion limit reached. Run again or check the result manually.`,
      );
      return;
    }

    // LIVE-TURN skip (when wired): the origin turn is STILL EXECUTING and owns
    // consumption through one blocking background_tasks read_output call — a
    // re-entry turn would only serialize a redundant continuation behind the
    // live turn. The dispatcher's matching check already suppressed the
    // fallback notice; the result stays readable if the live turn raced past it.
    if (deps.isTurnInFlight?.(formattedSessionKey) === true) {
      deps.taskManager.transitionDispatchState(taskId, "consumed_live", ["executing"]);
      log.debug(
        {
          taskId,
          sessionKey: formattedSessionKey,
          traceId: origin.traceId ?? undefined,
          hint: "Origin turn in flight — live turn owns consumption; no re-entry",
        },
        "Background completion runner: skipped (origin turn live)",
      );
      return;
    }

    const reentryContext = createReentryContext(origin, parsedKey);
    if (!reentryContext.ok) {
      log.warn(
        {
          taskId,
          sessionKey: formattedSessionKey,
          hint: "Persisted completion route is invalid; inspect or remove the task state before retrying",
          errorKind: "validation" as const,
        },
        "Background completion: invalid re-entry context",
      );
      await fallbackForTask(
        task.id,
        agentId,
        task.toolName,
        `Background task "${task.toolName}" completed (routing failed).`,
      );
      return;
    }

    // Format the announcement (byte-identical trailing instruction).
    const announcement = formatCompletionAnnouncement(task);

    // Construct the synthetic NormalizedMessage (hop counter in metadata).
    const syntheticMsg: NormalizedMessage = {
      id: task.continuationExecutionId,
      channelId: origin.deliveryOrigin.channelId,
      channelType: "background_task",
      senderId: "background-task-runner",
      text: announcement,
      timestamp: systemNowMs(),
      attachments: [],
      metadata: {
        backgroundHopCount: nextHopCount,
        backgroundTaskId: task.id,
        toolName: task.toolName,
        agentId,
        traceId: reentryContext.value.traceId,
      },
    };

    const scopedInvocation = tryCatch(() => runWithContext(
      reentryContext.value,
      async () => {
        log.debug(
          {
            taskId,
            sessionKey: formattedSessionKey,
            agentId,
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
          agentId,
          sessionKey: formattedSessionKey,
          hopCount: nextHopCount,
          traceId: reentryContext.value.traceId,
          timestamp: systemNowMs(),
        });

        // One turn per event. Existing session lock orders concurrent calls.
        const executor = tryCatch(() => deps.getExecutor(agentId));
        if (!executor.ok) return executor;
        const toolAssembly = deps.assembleToolsForAgent
          ? await fromPromise(deps.assembleToolsForAgent(agentId, { sessionKey: parsedKey }))
          : undefined;
        if (toolAssembly !== undefined && !toolAssembly.ok) return toolAssembly;
        const execution = tryCatch(() => executor.value.execute(
          syntheticMsg,
          parsedKey,
          toolAssembly?.value,
          undefined,
          agentId,
          undefined,
          undefined,
          {
            operationType: "interactive",
            responseLocalePolicy: origin.responseLocalePolicy,
          },
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
      deps.taskManager.transitionDispatchState(taskId, "pending", ["executing"]);
      deps.taskManager.scheduleDispatchRetry(taskId);
      return;
    }

    const result = executionResult.value;
    if (isSilentResponse(result.response)) {
      deps.taskManager.transitionDispatchState(taskId, "delivered", ["executing"]);
      log.info(
        {
          taskId,
          agentId,
          durationMs: 0,
          traceId: reentryContext.value.traceId,
        },
        "Background completion intentionally suppressed",
      );
      return;
    }

    if (!deps.taskManager.transitionDispatchState(taskId, "delivering", ["executing"])) return;
    const deliveryStartedAt = systemNowMs();
    const deliveryAttempt = await fromPromise(deps.deliverCompletion({
      taskId: task.id,
      origin,
      response: result.response,
      executionId: result.executionId,
      idempotencyKey: `background-continuation:${task.continuationExecutionId}`,
    }));
    const deliveryResult = deliveryAttempt.ok ? deliveryAttempt.value : deliveryAttempt;
    const deliveryDurationMs = Math.max(0, systemNowMs() - deliveryStartedAt);
    if (!deliveryResult.ok) {
      const errorKind = "errorKind" in deliveryResult.error
        ? deliveryResult.error.errorKind
        : ("internal" as const);
      log.warn(
        {
          taskId,
          agentId,
          channelType: origin.deliveryOrigin.channelType,
          durationMs: deliveryDurationMs,
          err: toSafeErrorLogString(new Error(deliveryResult.error.message)),
          traceId: reentryContext.value.traceId,
          hint: "Inspect the exact originating channel adapter and delivery queue before retrying the completion",
          errorKind,
        },
        "Background completion delivery failed",
      );
      deps.taskManager.transitionDispatchState(taskId, "pending", ["delivering"]);
      deps.taskManager.scheduleDispatchRetry(taskId);
      return;
    }
    deps.taskManager.transitionDispatchState(taskId, "delivered", ["delivering"]);
    log.info(
      {
        taskId,
        agentId,
        channelType: origin.deliveryOrigin.channelType,
        durationMs: deliveryDurationMs,
        traceId: reentryContext.value.traceId,
      },
      "Background completion delivered",
    );
  }

  async function fallbackForTask(taskId: string, agentId: string, toolName: string, message: string): Promise<void> {
    const task = deps.taskManager.getTask(taskId);
    if (!task) return;
    if (!deps.taskManager.transitionDispatchState(taskId, "fallback_pending", ["executing"])) return;
    const attempted = await fromPromise(deps.deliverFallback({
      taskId,
      origin: task.origin,
      response: message,
      executionId: task.continuationExecutionId,
      idempotencyKey: `background-fallback:${task.continuationExecutionId}`,
    }));
    const result = attempted.ok ? attempted.value : attempted;
    if (!result.ok) {
      deps.taskManager.transitionDispatchState(taskId, "pending", ["fallback_pending"]);
      deps.taskManager.scheduleDispatchRetry(taskId);
      log.warn(
        {
          taskId,
          toolName,
          agentId,
          err: result.error.message,
          hint: "Fallback delivery remains pending and will retry on recovery",
          errorKind: "errorKind" in result.error ? result.error.errorKind : "internal" as const,
        },
        "Background completion fallback delivery failed",
      );
      return;
    }
    deps.taskManager.transitionDispatchState(taskId, "fallback_delivered", ["fallback_pending"]);
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
