// SPDX-License-Identifier: Apache-2.0
import {
  conversationScopeToSessionKey,
  type BackgroundTaskOrigin,
} from "@comis/core";
import { isSilentResponse, type Result } from "@comis/shared";
import type { BackgroundTaskManager } from "./background-task-manager.js";
import type {
  BackgroundContinuationOutbox,
  BackgroundSessionState,
} from "./background-task-types.js";
import type {
  BackgroundCompletionDeliveryInput,
  BackgroundCompletionDeliveryOutcome,
  BackgroundFinalizedResultRecoveryInput,
} from "./completion-runner.js";

type RecoveryTaskManager = Pick<
  BackgroundTaskManager,
  | "getTask"
  | "persistContinuationOutbox"
  | "persistCleanupPendingOutbox"
  | "scheduleDispatchRetry"
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
    input: BackgroundCompletionDeliveryInput,
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
  async function finishCleanup(
    taskId: string,
    origin: BackgroundTaskOrigin,
    toolName: string,
  ): Promise<void> {
    const task = deps.taskManager.getTask(taskId);
    if (task?.dispatchState !== "cleanup_pending" || task.continuationOutbox === undefined) return;
    const projected = conversationScopeToSessionKey(origin.turnScope.conversation);
    if (!projected.ok) {
      deps.taskManager.scheduleDispatchRetry(taskId);
      deps.emitRoutingOutcome(taskId, origin, toolName, false, "retry_scheduled");
      return;
    }
    const cleaned = await deps.cleanupFinalizedSession({
      agentId: origin.turnScope.conversation.agentId,
      sessionKey: projected.value,
    });
    if (!cleaned.ok) {
      deps.taskManager.scheduleDispatchRetry(taskId);
      deps.emitRoutingOutcome(taskId, origin, toolName, false, "retry_scheduled");
      return;
    }
    if (isSilentResponse(task.continuationOutbox.response)) {
      const delivered = deps.commitState(taskId, "delivered", ["cleanup_pending"]);
      if (!delivered.ok) {
        deps.taskManager.scheduleDispatchRetry(taskId);
        deps.emitRoutingOutcome(taskId, origin, toolName, false, "retry_scheduled");
      }
      return;
    }
    const ready = deps.commitState(taskId, "ready_to_deliver", ["cleanup_pending"]);
    if (!ready.ok) {
      deps.taskManager.scheduleDispatchRetry(taskId);
      deps.emitRoutingOutcome(taskId, origin, toolName, false, "retry_scheduled");
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
        deps.taskManager.scheduleDispatchRetry(taskId);
        deps.emitRoutingOutcome(taskId, origin, toolName, false, "retry_scheduled");
      }
      return;
    }
    const recovered = await deps.recoverFinalizedResult({
      agentId: origin.turnScope.conversation.agentId,
      sessionKey: projected.value,
      journalKey: task.continuationExecutionId,
    });
    if (!recovered.ok) {
      deps.taskManager.scheduleDispatchRetry(taskId);
      deps.emitRoutingOutcome(taskId, origin, toolName, false, "retry_scheduled");
      return;
    }
    if (recovered.value === undefined) {
      if (currentState === "execution_claimed") {
        const pending = deps.commitState(taskId, "pending", ["execution_claimed"]);
        if ((pending.ok && pending.value) || !pending.ok) {
          deps.taskManager.scheduleDispatchRetry(taskId);
          deps.emitRoutingOutcome(taskId, origin, toolName, false, "retry_scheduled");
        }
      } else {
        const parked = deps.commitState(taskId, "parked_uncertain", ["executing"]);
        if (parked.ok && parked.value) {
          deps.emitRoutingOutcome(taskId, origin, toolName, false, "uncertain_parked");
        } else if (!parked.ok) {
          deps.taskManager.scheduleDispatchRetry(taskId);
          deps.emitRoutingOutcome(taskId, origin, toolName, false, "retry_scheduled");
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
        deps.taskManager.scheduleDispatchRetry(taskId);
        deps.emitRoutingOutcome(taskId, origin, toolName, false, "retry_scheduled");
        return;
      }
      await finishCleanup(taskId, origin, toolName);
      return;
    }
    if (isSilentResponse(recovered.value.response)) {
      const delivered = deps.commitState(taskId, "delivered", [currentState]);
      if (!delivered.ok) {
        deps.taskManager.scheduleDispatchRetry(taskId);
        deps.emitRoutingOutcome(taskId, origin, toolName, false, "retry_scheduled");
      }
      return;
    }
    const persisted = deps.taskManager.persistContinuationOutbox(
      taskId,
      recoveredOutbox,
      [currentState],
    );
    if (!persisted.ok) {
      deps.taskManager.scheduleDispatchRetry(taskId);
      deps.emitRoutingOutcome(taskId, origin, toolName, false, "retry_scheduled");
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
      deps.taskManager.scheduleDispatchRetry(taskId);
      deps.emitRoutingOutcome(taskId, origin, toolName, false, "retry_scheduled");
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
      }
      return;
    }
    if (reconciled.value.kind === "retryable_pre_send") {
      const ready = deps.commitState(taskId, "ready_to_deliver", ["delivering"]);
      if ((ready.ok && ready.value) || !ready.ok) {
        deps.taskManager.scheduleDispatchRetry(taskId);
        deps.emitRoutingOutcome(taskId, origin, toolName, false, "retry_scheduled");
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
    }
  }

  return { finishCleanup, recoverClaimedTask, reconcileDeliveryClaim };
}
