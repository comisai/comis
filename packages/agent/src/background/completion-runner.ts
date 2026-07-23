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
import { err, fromPromise, isSilentResponse, ok, suppressError, tryCatch, type Result } from "@comis/shared";
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
import type { BackgroundContinuationOutbox } from "./background-task-types.js";

/** Public-facing handle on the runner returned by createBackgroundCompletionRunner. */
export interface BackgroundCompletionRunner {
  /** Unsubscribe from the event bus. Idempotent. Awaitable so callers can
   *  ensure no in-flight handler outlives the daemon shutdown. */
  shutdown(): Promise<void>;
}

export type BackgroundCompletionDeliveryOutcome =
  | { readonly kind: "accepted" }
  | { readonly kind: "retryable_pre_send"; readonly errorKind: ErrorKind; readonly message: string }
  | { readonly kind: "permanent"; readonly errorKind: ErrorKind; readonly message: string }
  | { readonly kind: "uncertain"; readonly errorKind: ErrorKind; readonly message: string };

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
   * persists the exact protected outbox before any delivery attempt.
   */
  taskManager:
    & Pick<BackgroundTaskManager, "getTask" | "persistContinuationOutbox" | "scheduleDispatchRetry">
    & Partial<Pick<BackgroundTaskManager, "commitDispatchState" | "transitionDispatchState">>;
  /** Deliver the finalized continuation through the exact persisted channel
   *  authority. The runner owns execution; the composition root owns adapters. */
  deliverCompletion: (
    input: BackgroundCompletionDeliveryInput,
  ) => Promise<BackgroundCompletionDeliveryOutcome>;
  deliverFallback: (
    input: BackgroundCompletionDeliveryInput,
  ) => Promise<BackgroundCompletionDeliveryOutcome>;
  deliveryProtection: BackgroundContinuationOutbox["deliveryProtection"];
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

  function emitRoutingOutcome(
    taskId: string,
    origin: BackgroundTaskOrigin,
    toolName: string,
    notified: boolean,
    reason:
      | "live_turn_consumed"
      | "continuation_accepted"
      | "fallback_accepted"
      | "retry_scheduled"
      | "permanent_parked"
      | "uncertain_parked",
  ): void {
    const projected = conversationScopeToSessionKey(origin.turnScope.conversation);
    emitObservationalEventSafely({ eventBus: deps.eventBus, logger: log }, "background_task:notified", {
      agentId: origin.turnScope.conversation.agentId,
      taskId,
      toolName,
      sessionKey: projected.ok ? formatSessionKey(projected.value) : origin.conversationRef,
      notified,
      reason,
      traceId: origin.traceId,
      timestamp: systemNowMs(),
    });
  }

  function commitState(
    taskId: string,
    next: Parameters<BackgroundTaskManager["commitDispatchState"]>[1],
    expected: readonly Parameters<BackgroundTaskManager["commitDispatchState"]>[1][],
  ): boolean {
    const committed = deps.taskManager.commitDispatchState
      ? deps.taskManager.commitDispatchState(taskId, next, expected)
      : ok(deps.taskManager.transitionDispatchState?.(taskId, next, expected) ?? false);
    if (committed.ok) return committed.value;
    log.warn(
      {
        taskId,
        err: toSafeErrorLogString(committed.error),
        hint: "Repair protected background-task storage before retrying the lifecycle transition",
        errorKind: "resource" as const,
      },
      "Background completion state persistence failed",
    );
    return false;
  }

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

    // Terminal and parked states never execute or deliver again automatically.
    if (
      task.dispatchState === "delivered"
      || task.dispatchState === "parked_permanent"
      || task.dispatchState === "parked_uncertain"
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
    if (task.continuationOutbox !== undefined) {
      await deliverPersistedOutbox(task.id, task.origin, task.continuationOutbox);
      return;
    }
    if (!commitState(taskId, "execution_claimed", ["pending"])) {
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
      commitState(taskId, "delivered", ["execution_claimed"]);
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
      if (commitState(taskId, "consumed_live", ["execution_claimed"])) {
        emitRoutingOutcome(taskId, origin, task.toolName, false, "live_turn_consumed");
      }
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
        if (!commitState(taskId, "executing", ["execution_claimed"])) {
          return err(new Error("Background continuation execution claim was not durably started"));
        }
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
      const current = deps.taskManager.getTask(taskId);
      if (current?.dispatchState === "execution_claimed") {
        if (commitState(taskId, "pending", ["execution_claimed"])) {
          deps.taskManager.scheduleDispatchRetry(taskId);
          emitRoutingOutcome(taskId, origin, task.toolName, false, "retry_scheduled");
        }
      } else if (commitState(taskId, "parked_uncertain", ["executing"])) {
        emitRoutingOutcome(taskId, origin, task.toolName, false, "uncertain_parked");
      }
      return;
    }

    const result = executionResult.value;
    if (isSilentResponse(result.response)) {
      commitState(taskId, "delivered", ["executing"]);
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

    const outbox: BackgroundContinuationOutbox = {
      kind: "continuation",
      response: result.response,
      executionId: result.executionId,
      idempotencyKey: `background-continuation:${task.continuationExecutionId}`,
      deliveryProtection: deps.deliveryProtection,
    };
    const persisted = deps.taskManager.persistContinuationOutbox(
      taskId,
      outbox,
      ["executing"],
    );
    if (!persisted.ok) {
      log.warn(
        {
          taskId,
          agentId,
          err: toSafeErrorLogString(persisted.error),
          hint: "Repair protected background-task storage before retrying execution",
          errorKind: "resource" as const,
        },
        "Background completion outbox persistence failed",
      );
      if (commitState(taskId, "parked_uncertain", ["executing"])) {
        emitRoutingOutcome(taskId, origin, task.toolName, false, "uncertain_parked");
      }
      return;
    }
    await deliverPersistedOutbox(taskId, origin, outbox);
  }

  async function deliverPersistedOutbox(
    taskId: string,
    origin: BackgroundTaskOrigin,
    outbox: BackgroundContinuationOutbox,
  ): Promise<void> {
    if (!commitState(taskId, "delivering", ["ready_to_deliver"])) {
      return;
    }
    const deliveryStartedAt = systemNowMs();
    const deliver = outbox.kind === "continuation"
      ? deps.deliverCompletion
      : deps.deliverFallback;
    const attempted = await fromPromise(deliver({
      taskId,
      origin,
      response: outbox.response,
      executionId: outbox.executionId,
      idempotencyKey: outbox.idempotencyKey,
    }));
    const outcome: BackgroundCompletionDeliveryOutcome = attempted.ok
      ? attempted.value
      : {
          kind: "uncertain",
          errorKind: "internal",
          message: toSafeErrorLogString(attempted.error),
        };
    const durationMs = Math.max(0, systemNowMs() - deliveryStartedAt);
    if (outcome.kind === "accepted") {
      const delivered = commitState(taskId, "delivered", ["delivering"]);
      const task = deps.taskManager.getTask(taskId);
      if (delivered) {
        emitRoutingOutcome(
          taskId,
          origin,
          task?.toolName ?? "background_task",
          true,
          outbox.kind === "continuation" ? "continuation_accepted" : "fallback_accepted",
        );
      }
      log.info(
        {
          taskId,
          channelType: origin.deliveryOrigin.channelType,
          durationMs,
          traceId: origin.traceId,
        },
        "Background completion delivered",
      );
      return;
    }
    if (outcome.kind === "retryable_pre_send") {
      if (commitState(taskId, "ready_to_deliver", ["delivering"])) {
        deps.taskManager.scheduleDispatchRetry(taskId);
        emitRoutingOutcome(taskId, origin, deps.taskManager.getTask(taskId)?.toolName ?? "background_task", false, "retry_scheduled");
      }
    } else if (outcome.kind === "permanent") {
      if (commitState(taskId, "parked_permanent", ["delivering"])) {
        emitRoutingOutcome(taskId, origin, deps.taskManager.getTask(taskId)?.toolName ?? "background_task", false, "permanent_parked");
      }
    } else {
      if (commitState(taskId, "parked_uncertain", ["delivering"])) {
        emitRoutingOutcome(taskId, origin, deps.taskManager.getTask(taskId)?.toolName ?? "background_task", false, "uncertain_parked");
      }
    }
    log.warn(
      {
        taskId,
        channelType: origin.deliveryOrigin.channelType,
        durationMs,
        deliveryOutcome: outcome.kind,
        err: toSafeErrorLogString(new Error(outcome.message)),
        traceId: origin.traceId,
        hint: outcome.kind === "retryable_pre_send"
          ? "Restore the originating channel adapter; the protected outbox will retry"
          : "Reconcile the parked delivery before authorizing another outward send",
        errorKind: outcome.errorKind,
      },
      "Background completion delivery did not reach accepted state",
    );
  }

  async function fallbackForTask(taskId: string, agentId: string, toolName: string, message: string): Promise<void> {
    const task = deps.taskManager.getTask(taskId);
    if (!task) return;
    const outbox: BackgroundContinuationOutbox = {
      kind: "fallback",
      response: message,
      executionId: task.continuationExecutionId,
      idempotencyKey: `background-fallback:${task.continuationExecutionId}`,
      deliveryProtection: deps.deliveryProtection,
    };
    const persisted = deps.taskManager.persistContinuationOutbox(taskId, outbox, ["execution_claimed"]);
    if (!persisted.ok) {
      if (commitState(taskId, "parked_uncertain", ["execution_claimed"])) {
        emitRoutingOutcome(taskId, task.origin, toolName, false, "uncertain_parked");
      }
      log.warn(
        {
          taskId,
          toolName,
          agentId,
          err: persisted.error.message,
          hint: "Repair protected background-task storage before reconciling fallback delivery",
          errorKind: "resource" as const,
        },
        "Background completion fallback outbox persistence failed",
      );
      return;
    }
    await deliverPersistedOutbox(taskId, task.origin, outbox);
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
