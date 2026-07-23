// SPDX-License-Identifier: Apache-2.0

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
import { createCompletionRecovery } from "./completion-recovery.js";
import type { BackgroundTaskManager } from "./background-task-manager.js";
import type { BackgroundContinuationOutbox } from "./background-task-types.js";

export interface BackgroundCompletionRunner {
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
  readonly onSendStart: () => Result<void, Error>;
}

export interface BackgroundFinalizedResultRecoveryInput {
  readonly agentId: string;
  readonly sessionKey: SessionKey;
  readonly journalKey: string;
}

export interface RunnerSessionStore {
  loadByRef(scope: SessionQueryScope, conversationRef: BackgroundTaskOrigin["conversationRef"]): Result<unknown | undefined, SessionStoreError>;
}

export interface BackgroundCompletionRunnerDeps {
  eventBus: TypedEventBus;
  getExecutor: (agentId: string) => AgentExecutor;
  assembleToolsForAgent?: (
    agentId: string,
    options?: { sessionKey?: SessionKey },
  ) => Promise<AgentTool[]>;
  sessionStore: RunnerSessionStore;
  taskManager:
    Pick<
      BackgroundTaskManager,
      "getTask"
      | "persistContinuationOutbox"
      | "persistCleanupPendingOutbox"
      | "scheduleDispatchRetry"
      | "commitDispatchState"
      | "persistFinalizedResult"
      | "recordRecoveryIncident"
      | "scheduleStateRetry"
    >;
  recoverFinalizedResult(
    input: BackgroundFinalizedResultRecoveryInput,
  ): Promise<Result<{
    response: string;
    executionId: string;
    cleanupRequired: boolean;
  } | undefined, Error>>;
  cleanupFinalizedSession(
    input: Omit<BackgroundFinalizedResultRecoveryInput, "journalKey">,
  ): Promise<Result<void, Error>>;
  reconcileDelivery(
    input: Omit<BackgroundCompletionDeliveryInput, "onSendStart">,
  ): Promise<Result<BackgroundCompletionDeliveryOutcome, Error>>;
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
  ): Result<boolean, Error> {
    const committed = deps.taskManager.commitDispatchState(taskId, next, expected);
    if (committed.ok) return committed;
    log.warn(
      {
        taskId,
        err: toSafeErrorLogString(committed.error),
        hint: "Repair protected background-task storage before retrying the lifecycle transition",
        errorKind: "resource" as const,
      },
      "Background completion state persistence failed",
    );
    return committed;
  }

  const recovery = createCompletionRecovery({
    taskManager: deps.taskManager,
    recoverFinalizedResult: deps.recoverFinalizedResult,
    cleanupFinalizedSession: deps.cleanupFinalizedSession,
    reconcileDelivery: deps.reconcileDelivery,
    deliveryProtection: deps.deliveryProtection,
    commitState,
    emitRoutingOutcome,
    deliverPersistedOutbox,
  });

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
    if (task.dispatchState === "cleanup_pending") {
      await recovery.finishCleanup(task.id, task.origin, task.toolName);
      return;
    }
    if (task.dispatchState === "delivering" && task.continuationOutbox !== undefined) {
      await recovery.reconcileDeliveryClaim(task.id, task.origin, task.continuationOutbox);
      return;
    }
    if (task.dispatchState === "pre_send" && task.continuationOutbox !== undefined) {
      await deliverPersistedOutbox(task.id, task.origin, task.continuationOutbox);
      return;
    }
    if (
      task.dispatchState === "ready_to_deliver"
      && task.continuationOutbox !== undefined
    ) {
      await deliverPersistedOutbox(task.id, task.origin, task.continuationOutbox);
      return;
    }
    if (
      task.dispatchState === "execution_claimed"
      || task.dispatchState === "executing"
    ) {
      await recovery.recoverClaimedTask(taskId, task.origin, task.toolName);
      return;
    }
    const claim = commitState(taskId, "execution_claimed", ["pending"]);
    if (!claim.ok) {
      deps.taskManager.scheduleDispatchRetry(taskId);
      emitRoutingOutcome(taskId, task.origin, task.toolName, false, "retry_scheduled");
      return;
    }
    if (!claim.value) {
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
      const consumed = commitState(taskId, "consumed_live", ["execution_claimed"]);
      if (consumed.ok && consumed.value) {
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
        let finalizedOutbox: BackgroundContinuationOutbox | undefined;
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
            finalizedResultJournalKey: task.continuationExecutionId,
            onJournalFinalizedResult: async (finalized) => {
              const persisted = deps.taskManager.persistFinalizedResult(
                taskId,
                {
                  response: finalized.response,
                  executionId: finalized.executionId,
                  cleanupRequired: finalized.finishReason === "session_reset",
                },
                ["execution_claimed", "executing"],
              );
              if (!persisted.ok) return Promise.reject(persisted.error);
            },
            onProviderStart: () => {
              const current = deps.taskManager.getTask(taskId);
              if (current?.dispatchState === "executing") return ok(undefined);
              const executing = commitState(taskId, "executing", ["execution_claimed"]);
              return executing.ok && executing.value
                ? ok(undefined)
                : err(executing.ok
                  ? new Error("Background continuation provider start claim was not acquired")
                  : executing.error);
            },
            onFinalizedResult: async (finalized, phase) => {
              const outbox: BackgroundContinuationOutbox = {
                kind: "continuation",
                response: finalized.response,
                executionId: finalized.executionId,
                idempotencyKey: `background-continuation:${task.continuationExecutionId}`,
                deliveryProtection: deps.deliveryProtection,
              };
              if (phase === "cleanup_pending") {
                const persisted = deps.taskManager.persistCleanupPendingOutbox(
                  taskId,
                  outbox,
                  ["execution_claimed", "executing"],
                );
                if (!persisted.ok) return Promise.reject(persisted.error);
                finalizedOutbox = outbox;
                return;
              }
              const current = deps.taskManager.getTask(taskId);
              if (current?.dispatchState === "cleanup_pending") {
                if (isSilentResponse(finalized.response)) {
                  const delivered = commitState(taskId, "delivered", ["cleanup_pending"]);
                  if (!delivered.ok) return Promise.reject(delivered.error);
                  if (!delivered.value) {
                    return Promise.reject(new Error("Background continuation cleanup terminal state was not claimable"));
                  }
                  return;
                }
                const ready = commitState(taskId, "ready_to_deliver", ["cleanup_pending"]);
                if (!ready.ok) return Promise.reject(ready.error);
                if (!ready.value) {
                  return Promise.reject(new Error("Background continuation cleanup handoff was not claimable"));
                }
                finalizedOutbox = outbox;
                return;
              }
              if (isSilentResponse(finalized.response)) {
                const delivered = commitState(
                  taskId,
                  "delivered",
                  ["execution_claimed", "executing"],
                );
                if (!delivered.ok) return Promise.reject(delivered.error);
                if (!delivered.value) {
                  return Promise.reject(new Error("Background continuation terminal state was not claimable"));
                }
                return;
              }
              const persisted = deps.taskManager.persistContinuationOutbox(
                taskId,
                outbox,
                ["execution_claimed", "executing"],
              );
              if (!persisted.ok) return Promise.reject(persisted.error);
              finalizedOutbox = outbox;
            },
          },
        ));
        if (!execution.ok) return execution;
        const settled = await fromPromise(execution.value);
        return settled.ok
          ? ok({ result: settled.value, finalizedOutbox })
          : settled;
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
      if (
        current?.dispatchState === "ready_to_deliver"
        && current.continuationOutbox !== undefined
      ) {
        await deliverPersistedOutbox(taskId, origin, current.continuationOutbox);
      } else if (current?.dispatchState === "cleanup_pending") {
        await recovery.finishCleanup(taskId, origin, task.toolName);
      } else if (
        current?.dispatchState === "execution_claimed"
        || current?.dispatchState === "executing"
      ) {
        await recovery.recoverClaimedTask(taskId, origin, task.toolName);
      }
      return;
    }

    const result = executionResult.value.result;
    if (isSilentResponse(result.response)) {
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

    const outbox = executionResult.value.finalizedOutbox
      ?? deps.taskManager.getTask(taskId)?.continuationOutbox;
    if (outbox === undefined) {
      log.warn(
        {
          taskId,
          agentId,
          hint: "Inspect the executor finalization hook before reconciling this continuation",
          errorKind: "internal" as const,
        },
        "Background completion finalized without a protected outbox",
      );
      const parked = commitState(taskId, "parked_uncertain", ["executing"]);
      if (parked.ok && parked.value) {
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
    const current = deps.taskManager.getTask(taskId);
    const deliveryClaim = current?.dispatchState === "pre_send"
      ? ok(true)
      : commitState(taskId, "pre_send", ["ready_to_deliver"]);
    if (!deliveryClaim.ok) {
      deps.taskManager.scheduleDispatchRetry(taskId);
      const task = deps.taskManager.getTask(taskId);
      emitRoutingOutcome(
        taskId,
        origin,
        task?.toolName ?? "background_task",
        false,
        "retry_scheduled",
      );
      return;
    }
    if (!deliveryClaim.value) {
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
      onSendStart: () => {
        const started = commitState(taskId, "delivering", ["pre_send"]);
        return started.ok && started.value
          ? ok(undefined)
          : err(started.ok
            ? new Error("Background delivery send-start claim was not acquired")
            : started.error);
      },
    }));
    const stateAfterAttempt = deps.taskManager.getTask(taskId)?.dispatchState;
    const outcome: BackgroundCompletionDeliveryOutcome = attempted.ok
      ? attempted.value
      : stateAfterAttempt === "pre_send"
        ? {
            kind: "retryable_pre_send",
            errorKind: "internal",
            message: toSafeErrorLogString(attempted.error),
          }
        : {
            kind: "uncertain",
            errorKind: "internal",
            message: toSafeErrorLogString(attempted.error),
          };
    const durationMs = Math.max(0, systemNowMs() - deliveryStartedAt);
    if (outcome.kind === "accepted") {
      const delivered = commitState(taskId, "delivered", ["delivering"]);
      const task = deps.taskManager.getTask(taskId);
      if (delivered.ok && delivered.value) {
        emitRoutingOutcome(
          taskId,
          origin,
          task?.toolName ?? "background_task",
          true,
          outbox.kind === "continuation" ? "continuation_accepted" : "fallback_accepted",
        );
      } else if (!delivered.ok) {
        deps.taskManager.scheduleStateRetry(taskId, "delivered", ["delivering"]);
        emitRoutingOutcome(
          taskId,
          origin,
          task?.toolName ?? "background_task",
          false,
          "retry_scheduled",
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
      const retryState = deps.taskManager.getTask(taskId)?.dispatchState;
      const retryable = retryState === "pre_send"
        ? ok(true)
        : commitState(taskId, "pre_send", ["delivering"]);
      if (retryable.ok && retryable.value) {
        deps.taskManager.scheduleDispatchRetry(taskId);
        emitRoutingOutcome(taskId, origin, deps.taskManager.getTask(taskId)?.toolName ?? "background_task", false, "retry_scheduled");
      } else if (!retryable.ok) {
        deps.taskManager.scheduleStateRetry(taskId, "pre_send", ["delivering"]);
        emitRoutingOutcome(taskId, origin, deps.taskManager.getTask(taskId)?.toolName ?? "background_task", false, "retry_scheduled");
      }
    } else if (outcome.kind === "permanent") {
      const parked = commitState(taskId, "parked_permanent", ["delivering"]);
      if (parked.ok && parked.value) {
        emitRoutingOutcome(taskId, origin, deps.taskManager.getTask(taskId)?.toolName ?? "background_task", false, "permanent_parked");
      } else if (!parked.ok) {
        deps.taskManager.scheduleStateRetry(taskId, "parked_permanent", ["delivering"]);
        emitRoutingOutcome(taskId, origin, deps.taskManager.getTask(taskId)?.toolName ?? "background_task", false, "retry_scheduled");
      }
    } else {
      const parked = commitState(taskId, "parked_uncertain", ["delivering"]);
      if (parked.ok && parked.value) {
        emitRoutingOutcome(taskId, origin, deps.taskManager.getTask(taskId)?.toolName ?? "background_task", false, "uncertain_parked");
      } else if (!parked.ok) {
        deps.taskManager.scheduleStateRetry(taskId, "parked_uncertain", ["delivering"]);
        emitRoutingOutcome(taskId, origin, deps.taskManager.getTask(taskId)?.toolName ?? "background_task", false, "retry_scheduled");
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
      const pending = commitState(taskId, "pending", ["execution_claimed"]);
      if (pending.ok && pending.value) {
        deps.taskManager.scheduleDispatchRetry(taskId);
        emitRoutingOutcome(taskId, task.origin, toolName, false, "retry_scheduled");
      } else if (!pending.ok) {
        deps.taskManager.scheduleDispatchRetry(taskId);
        emitRoutingOutcome(taskId, task.origin, toolName, false, "retry_scheduled");
      }
      log.warn(
        {
          taskId,
          toolName,
          agentId,
          err: persisted.error.message,
          hint: "Repair protected background-task storage; fallback persistence will retry before any send",
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
