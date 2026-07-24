// SPDX-License-Identifier: Apache-2.0
import {
  conversationScopeToSessionKey,
  type BackgroundTaskOrigin,
} from "@comis/core";
import { isSilentResponse, ok, type Result } from "@comis/shared";
import type { BackgroundTaskManager } from "./background-task-manager.js";
import type {
  BackgroundCompletionDeliveryInput,
  BackgroundCompletionDeliveryOutcome,
  BackgroundContinuationOutbox,
  BackgroundFinalizedResultRecoveryInput,
  BackgroundSessionState,
} from "./background-task-types.js";

type RecoveryTaskManager = Pick<
  BackgroundTaskManager,
  | "getTask"
  | "persistContinuationOutbox"
  | "persistCleanupPendingOutbox"
  | "persistFinalizedResult"
  | "scheduleDispatchRetry"
  | "scheduleStateRetry"
  | "recordRecoveryIncident"
>;

interface CompletionRecoveryDeps {
  taskManager: RecoveryTaskManager;
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
  deliveryProtection: BackgroundContinuationOutbox["deliveryProtection"];
  commitState(
    taskId: string,
    next: BackgroundSessionState,
    expected: readonly BackgroundSessionState[],
  ): Result<boolean, Error>;
  emitRoutingOutcome(
    taskId: string,
    origin: BackgroundTaskOrigin,
    toolName: string,
    notified: boolean,
    reason:
      | "continuation_accepted"
      | "fallback_accepted"
      | "silent_consumed"
      | "retry_scheduled"
      | "permanent_parked"
      | "uncertain_parked",
  ): void;
  deliverPersistedOutbox(
    taskId: string,
    origin: BackgroundTaskOrigin,
    outbox: BackgroundContinuationOutbox,
  ): Promise<void>;
}

export function createCompletionRecovery(deps: CompletionRecoveryDeps) {
  function scheduleRecoveryRetry(
    taskId: string,
    origin: BackgroundTaskOrigin,
    toolName: string,
  ): void {
    deps.taskManager.recordRecoveryIncident(taskId);
    deps.taskManager.scheduleDispatchRetry(taskId);
    deps.emitRoutingOutcome(taskId, origin, toolName, false, "retry_scheduled");
  }

  function scheduleStateRecovery(
    taskId: string,
    origin: BackgroundTaskOrigin,
    toolName: string,
    next: BackgroundSessionState,
    expected: readonly BackgroundSessionState[],
  ): void {
    deps.taskManager.scheduleStateRetry(taskId, next, expected);
    deps.taskManager.recordRecoveryIncident(taskId);
    deps.emitRoutingOutcome(taskId, origin, toolName, false, "retry_scheduled");
  }

  async function finishCleanup(
    taskId: string,
    origin: BackgroundTaskOrigin,
    toolName: string,
  ): Promise<void> {
    const task = deps.taskManager.getTask(taskId);
    if (task?.dispatchState !== "cleanup_pending" || task.continuationOutbox === undefined) return;
    const projected = conversationScopeToSessionKey(origin.turnScope.conversation);
    if (!projected.ok) {
      scheduleRecoveryRetry(taskId, origin, toolName);
      return;
    }
    const cleaned = await deps.cleanupFinalizedSession({
      agentId: origin.turnScope.conversation.agentId,
      sessionKey: projected.value,
    });
    if (!cleaned.ok) {
      scheduleRecoveryRetry(taskId, origin, toolName);
      return;
    }
    if (isSilentResponse(task.continuationOutbox.response)) {
      const delivered = deps.commitState(taskId, "delivered", ["cleanup_pending"]);
      if (!delivered.ok) {
        deps.taskManager.scheduleStateRetry(taskId, "delivered", ["cleanup_pending"]);
        scheduleRecoveryRetry(taskId, origin, toolName);
      }
      return;
    }
    const ready = deps.commitState(taskId, "ready_to_deliver", ["cleanup_pending"]);
    if (!ready.ok) {
      deps.taskManager.scheduleStateRetry(taskId, "ready_to_deliver", ["cleanup_pending"]);
      scheduleRecoveryRetry(taskId, origin, toolName);
      return;
    }
    if (ready.value) {
      await deps.deliverPersistedOutbox(taskId, origin, task.continuationOutbox);
    }
  }

  async function recoverClaimedTask(
    taskId: string,
    origin: BackgroundTaskOrigin,
    toolName: string,
  ): Promise<void> {
    const task = deps.taskManager.getTask(taskId);
    if (
      task?.dispatchState !== "execution_claimed"
      && task?.dispatchState !== "executing"
    ) return;
    const currentState = task.dispatchState;
    const projected = conversationScopeToSessionKey(origin.turnScope.conversation);
    if (!projected.ok) {
      const parked = deps.commitState(taskId, "parked_uncertain", [currentState]);
      if (parked.ok && parked.value) {
        deps.emitRoutingOutcome(taskId, origin, toolName, false, "uncertain_parked");
      } else if (!parked.ok) {
        scheduleRecoveryRetry(taskId, origin, toolName);
      }
      return;
    }
    let protectedResult = task.finalizedResult ?? task._pendingFinalizedResult;
    if (task.finalizedResult === undefined && protectedResult !== undefined) {
      const persistedResult = deps.taskManager.persistFinalizedResult(
        taskId,
        protectedResult,
        [currentState],
      );
      if (!persistedResult.ok) {
        scheduleRecoveryRetry(taskId, origin, toolName);
        return;
      }
      protectedResult = deps.taskManager.getTask(taskId)?.finalizedResult;
    }
    const recovered = protectedResult === undefined
      ? await deps.recoverFinalizedResult({
          agentId: origin.turnScope.conversation.agentId,
          sessionKey: projected.value,
          journalKey: task.continuationExecutionId,
        })
      : ok(protectedResult);
    if (!recovered.ok) {
      scheduleRecoveryRetry(taskId, origin, toolName);
      return;
    }
    if (recovered.value === undefined) {
      if (currentState === "execution_claimed") {
        const pending = deps.commitState(taskId, "pending", ["execution_claimed"]);
        if (pending.ok && pending.value) {
          deps.taskManager.scheduleDispatchRetry(taskId);
          deps.emitRoutingOutcome(taskId, origin, toolName, false, "retry_scheduled");
        } else if (!pending.ok) {
          scheduleRecoveryRetry(taskId, origin, toolName);
        }
      } else {
        const parked = deps.commitState(taskId, "parked_uncertain", ["executing"]);
        if (parked.ok && parked.value) {
          deps.emitRoutingOutcome(taskId, origin, toolName, false, "uncertain_parked");
        } else if (!parked.ok) {
          scheduleRecoveryRetry(taskId, origin, toolName);
        }
      }
      return;
    }
    const recoveredOutbox: BackgroundContinuationOutbox = {
      kind: "continuation",
      response: recovered.value.response,
      executionId: recovered.value.executionId,
      idempotencyKey: `background-continuation:${task.continuationExecutionId}`,
      deliveryProtection: deps.deliveryProtection,
    };
    if (recovered.value.cleanupRequired) {
      const persisted = deps.taskManager.persistCleanupPendingOutbox(
        taskId,
        recoveredOutbox,
        [currentState],
      );
      if (!persisted.ok) {
        scheduleRecoveryRetry(taskId, origin, toolName);
        return;
      }
      await finishCleanup(taskId, origin, toolName);
      return;
    }
    if (isSilentResponse(recovered.value.response)) {
      const delivered = deps.commitState(taskId, "delivered", [currentState]);
      if (!delivered.ok) {
        deps.taskManager.scheduleStateRetry(taskId, "delivered", [currentState]);
        scheduleRecoveryRetry(taskId, origin, toolName);
      }
      return;
    }
    const persisted = deps.taskManager.persistContinuationOutbox(
      taskId,
      recoveredOutbox,
      [currentState],
    );
    if (!persisted.ok) {
      scheduleRecoveryRetry(taskId, origin, toolName);
      return;
    }
    await deps.deliverPersistedOutbox(taskId, origin, recoveredOutbox);
  }

  async function reconcileDeliveryClaim(
    taskId: string,
    origin: BackgroundTaskOrigin,
    outbox: BackgroundContinuationOutbox,
  ): Promise<void> {
    const reconciled = await deps.reconcileDelivery({
      taskId,
      origin,
      response: outbox.response,
      executionId: outbox.executionId,
      idempotencyKey: outbox.idempotencyKey,
    });
    const toolName = deps.taskManager.getTask(taskId)?.toolName ?? "background_task";
    if (!reconciled.ok) {
      scheduleRecoveryRetry(taskId, origin, toolName);
      return;
    }
    if (reconciled.value.kind === "accepted") {
      const delivered = deps.commitState(taskId, "delivered", ["delivering"]);
      if (delivered.ok && delivered.value) {
        deps.emitRoutingOutcome(
          taskId,
          origin,
          toolName,
          true,
          outbox.kind === "continuation" ? "continuation_accepted" : "fallback_accepted",
        );
      } else if (!delivered.ok) {
        deps.taskManager.scheduleStateRetry(taskId, "delivered", ["delivering"]);
        scheduleRecoveryRetry(taskId, origin, toolName);
      }
      return;
    }
    if (reconciled.value.kind === "retryable_pre_send") {
      const ready = deps.commitState(taskId, "pre_send", ["delivering"]);
      if ((ready.ok && ready.value) || !ready.ok) {
        if (!ready.ok) {
          deps.taskManager.scheduleStateRetry(taskId, "pre_send", ["delivering"]);
        }
        scheduleRecoveryRetry(taskId, origin, toolName);
      }
      return;
    }
    const parkedState = reconciled.value.kind === "permanent"
      ? "parked_permanent"
      : "parked_uncertain";
    const parked = deps.commitState(taskId, parkedState, ["delivering"]);
    if (parked.ok && parked.value) {
      deps.emitRoutingOutcome(
        taskId,
        origin,
        toolName,
        false,
        parkedState === "parked_permanent" ? "permanent_parked" : "uncertain_parked",
      );
    } else if (!parked.ok) {
      deps.taskManager.scheduleStateRetry(taskId, parkedState, ["delivering"]);
      scheduleRecoveryRetry(taskId, origin, toolName);
    }
  }

  return { finishCleanup, recoverClaimedTask, reconcileDeliveryClaim, scheduleStateRecovery };
}
