// SPDX-License-Identifier: Apache-2.0
// @allow-throw: RPC handlers throw typed boundary errors that rpc-dispatch maps to JSON-RPC errors.
/** Content-free admin inspection and cancellation for inferred follow-up tasks. */
import {
  TasksCancelContract,
  TasksListContract,
  TasksResetContract,
  TasksStatusContract,
  emitObservationalEventSafely,
  stripInternalFields,
  systemGetEnv,
  type ComisLogger,
  type ErrorKind,
  type TypedEventBus,
} from "@comis/core";
import type {
  FollowupTaskCancellationOutcome,
  FollowupTaskStore,
  FollowupTaskStoreError,
  FollowupTaskStoreInspection,
} from "@comis/scheduler";
import { fromPromise, type Result } from "@comis/shared";
import type {
  TaskMaintenanceController,
  TaskMaintenanceControllerError,
} from "../wiring/task-maintenance-controller.js";
import { emitSchedulerOperatorAudit } from "../wiring/scheduler-operator-audit.js";
import { PreconditionError, ValidationError } from "./errors.js";
import type { RpcHandler } from "./types.js";

const IS_DEV = systemGetEnv("NODE_ENV") !== "production";

export interface TaskHandlerDeps {
  readonly defaultAgentId: string;
  readonly tenantId: string;
  readonly followupTaskStores: ReadonlyMap<string, Pick<FollowupTaskStore, "inspect" | "cancelPending">>;
  readonly taskMaintenanceControllers: ReadonlyMap<string, Pick<TaskMaintenanceController, "status" | "reset">>;
  readonly tasksEnabled: () => boolean;
  readonly requestTaskRescan?: (agentId: string) => Promise<Result<void, { readonly errorKind: ErrorKind }>>;
  readonly schedulerNowMs: () => number;
  readonly eventBus: Pick<TypedEventBus, "emitSafely">;
  readonly logger: Pick<ComisLogger, "info" | "warn">;
}

export function createTaskHandlers(deps: TaskHandlerDeps): Record<string, RpcHandler> {
  return {
    [TasksStatusContract.method]: async (rawParams) => {
      const startedAtMs = deps.schedulerNowMs();
      const params = TasksStatusContract.request.parse(stripInternalFields(rawParams));
      const agentId = params.agentId ?? deps.defaultAgentId;
      const status = unwrapMaintenance(await resolveController(deps, agentId).status());
      const inspected = status.strictAuthorityValid ? await inspectStore(deps, agentId) : undefined;
      const active = inspected?.tasks.filter((task) => task.status === "checking" || task.status === "delivering").length
        ?? status.activeAttemptCount;
      const pending = inspected?.tasks.filter((task) => task.status === "pending").length ?? 0;
      const total = inspected?.tasks.length ?? status.taskCount;
      const result = {
        resolvedAgentId: agentId,
        configuredEnabled: status.configuredEnabled,
        state: status.state,
        strictAuthorityValid: status.strictAuthorityValid,
        ownershipReconciled: status.ownershipReconciled,
        store: status.store,
        intent: status.intent,
        counts: {
          total,
          pending,
          active,
          terminal: total - pending - active,
        },
      };
      logCompletion(deps, TasksStatusContract.method, startedAtMs, "inspected");
      if (IS_DEV) TasksStatusContract.response.parse(result);
      return result;
    },
    [TasksListContract.method]: async (rawParams) => {
      const startedAtMs = deps.schedulerNowMs();
      const params = TasksListContract.request.parse(stripInternalFields(rawParams));
      const agentId = params.agentId ?? deps.defaultAgentId;
      const inspected = await inspectStore(deps, agentId);
      const matching = params.status === undefined
        ? inspected.tasks
        : inspected.tasks.filter((task) => task.status === params.status);
      const result = {
        resolvedAgentId: agentId,
        fileDigest: inspected.fileDigest,
        tasks: matching.slice(0, params.limit ?? 100),
      };
      logCompletion(deps, TasksListContract.method, startedAtMs, "inspected");
      if (IS_DEV) TasksListContract.response.parse(result);
      return result;
    },
    [TasksCancelContract.method]: async (rawParams) => {
      const startedAtMs = deps.schedulerNowMs();
      const parsed = TasksCancelContract.request.safeParse(stripInternalFields(rawParams));
      if (!parsed.success) {
        auditCancellationFailure(deps, deps.defaultAgentId, "validation", undefined);
        throw new ValidationError("Invalid task cancellation request");
      }
      const params = parsed.data;
      const agentId = params.agentId ?? deps.defaultAgentId;
      const store = deps.followupTaskStores.get(agentId);
      if (store === undefined) {
        auditCancellationFailure(deps, agentId, "store_unavailable", "taskId" in params ? params.taskId : undefined);
        throw new PreconditionError("Follow-up task authority store is unavailable");
      }
      const cancelled = await store.cancelPending({
        agentId,
        ...("taskId" in params ? { taskId: params.taskId } : {}),
      });
      if (!cancelled.ok) {
        auditCancellationFailure(
          deps,
          agentId,
          cancelled.error.code,
          "taskId" in params ? params.taskId : undefined,
        );
      }
      const outcome = unwrapStore(cancelled);
      auditCancellation(deps, agentId, outcome);
      if (outcome.status === "cancelled") {
        const timestamp = deps.schedulerNowMs();
        emitObservationalEventSafely({ eventBus: deps.eventBus, logger: deps.logger }, "scheduler:task_cancelled", {
          agentId,
          taskIds: outcome.taskIds,
          activeTaskCount: outcome.activeTaskIds.length,
          durationMs: Math.max(0, timestamp - startedAtMs),
          timestamp,
        });
      }
      const scheduleRescan = await rescanAfterCancellation(deps, agentId, outcome);
      const result = { outcome, scheduleRescan };
      logCompletion(deps, TasksCancelContract.method, startedAtMs, outcome.status);
      if (IS_DEV) TasksCancelContract.response.parse(result);
      return result;
    },
    [TasksResetContract.method]: async (rawParams) => {
      const startedAtMs = deps.schedulerNowMs();
      const params = TasksResetContract.request.parse(stripInternalFields(rawParams));
      const agentId = params.agentId ?? deps.defaultAgentId;
      const reset = unwrapMaintenance(await resolveController(deps, agentId).reset({
        expectedDigest: params.expectedDigest,
        confirmed: params.confirmed,
        actorScope: "admin",
      }));
      const result = { resolvedAgentId: agentId, ...reset };
      logCompletion(deps, TasksResetContract.method, startedAtMs, "reset");
      if (IS_DEV) TasksResetContract.response.parse(result);
      return result;
    },
  };
}

function auditCancellationFailure(
  deps: TaskHandlerDeps,
  agentId: string,
  code: string,
  taskId: string | undefined,
): void {
  emitCancellationAudit(deps, agentId, "rejected", {
    ...(taskId === undefined ? {} : { targetTaskId: taskId }),
    code,
  });
}

function auditCancellation(
  deps: TaskHandlerDeps,
  agentId: string,
  outcome: FollowupTaskCancellationOutcome,
): void {
  switch (outcome.status) {
    case "cancelled":
      emitCancellationAudit(deps, agentId, "accepted", {
        targetTaskIds: outcome.taskIds,
      });
      return;
    case "active_attempt":
      emitCancellationAudit(deps, agentId, "rejected", {
        targetTaskId: outcome.taskId,
        attemptId: outcome.attemptId,
        code: outcome.status,
      });
      return;
    case "already_terminal":
    case "not_found":
      emitCancellationAudit(deps, agentId, "rejected", {
        targetTaskId: outcome.taskId,
        code: outcome.status,
      });
      return;
    case "nothing_pending":
      emitCancellationAudit(deps, agentId, "rejected", {
        activeTaskCount: outcome.activeTaskIds.length,
        code: outcome.status,
      });
      return;
    default: {
      const _exhaustive: never = outcome;
      return _exhaustive;
    }
  }
}

function emitCancellationAudit(
  deps: TaskHandlerDeps,
  agentId: string,
  decision: "accepted" | "rejected",
  metadata: Readonly<Record<string, unknown>>,
): void {
  emitSchedulerOperatorAudit({
    tenantId: deps.tenantId,
    eventBus: deps.eventBus,
    logger: deps.logger,
    nowMs: deps.schedulerNowMs,
  }, {
    agentId,
    actionType: "tasks.cancel",
    classification: "mutate",
    decision,
    metadata,
  });
}

async function inspectStore(deps: TaskHandlerDeps, agentId: string): Promise<FollowupTaskStoreInspection> {
  return unwrapStore(await resolveStore(deps, agentId).inspect());
}

function resolveStore(
  deps: TaskHandlerDeps,
  agentId: string,
): Pick<FollowupTaskStore, "inspect" | "cancelPending"> {
  const store = deps.followupTaskStores.get(agentId);
  if (store === undefined) throw new PreconditionError("Follow-up task authority store is unavailable");
  return store;
}

function resolveController(
  deps: TaskHandlerDeps,
  agentId: string,
): Pick<TaskMaintenanceController, "status" | "reset"> {
  const controller = deps.taskMaintenanceControllers.get(agentId);
  if (controller === undefined) throw new PreconditionError("Follow-up task maintenance controller is unavailable");
  return controller;
}

function unwrapStore<T>(result: Result<T, FollowupTaskStoreError>): T {
  if (result.ok) return result.value;
  if (result.error.errorKind === "validation") throw new ValidationError(result.error.message);
  throw new PreconditionError(result.error.message);
}

function unwrapMaintenance<T>(result: Result<T, TaskMaintenanceControllerError>): T {
  if (result.ok) return result.value;
  if (result.error.errorKind === "validation") throw new ValidationError(result.error.message);
  throw new PreconditionError(result.error.message);
}

async function rescanAfterCancellation(
  deps: TaskHandlerDeps,
  agentId: string,
  outcome: FollowupTaskCancellationOutcome,
): Promise<"not_required" | "completed" | "failed"> {
  if (outcome.status !== "cancelled" || !deps.tasksEnabled()) return "not_required";
  if (deps.requestTaskRescan === undefined) {
    logRescanFailure(deps, agentId, "precondition");
    return "failed";
  }
  const rescanned = await fromPromise(deps.requestTaskRescan(agentId));
  if (rescanned.ok && rescanned.value.ok) return "completed";
  let errorKind: ErrorKind = "internal";
  if (rescanned.ok) {
    const outcomeResult = rescanned.value;
    if (!outcomeResult.ok) errorKind = outcomeResult.error.errorKind;
  }
  logRescanFailure(deps, agentId, errorKind);
  return "failed";
}

function logRescanFailure(deps: TaskHandlerDeps, agentId: string, errorKind: ErrorKind): void {
  deps.logger.warn({
    agentId,
    method: TasksCancelContract.method,
    step: "task_due_rescan",
    errorKind,
    hint: "Inspect the due-task schedule; the locked cancellation is already authoritative",
  }, "Follow-up task schedule could not rearm after cancellation");
}

function logCompletion(
  deps: TaskHandlerDeps,
  method: string,
  startedAtMs: number,
  outcome: string,
): void {
  deps.logger.info({
    method,
    outcome,
    durationMs: Math.max(0, deps.schedulerNowMs() - startedAtMs),
  }, "Follow-up task operator request completed");
}
