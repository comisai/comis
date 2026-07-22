// SPDX-License-Identifier: Apache-2.0
import type { ErrorKind } from "@comis/core";
import { err, ok, type Result } from "@comis/shared";
import type {
  FollowupTaskAttemptRecord,
  FollowupTaskRecord,
  FollowupTaskStoreError,
  FollowupTaskStoreFile,
  SuccessfulTaskCheckExecutionEvidence,
  TaskAttemptFailureStage,
  TaskBeginDeliveryResult,
  TaskCheckExecutionEvidence,
  TaskDeliverySettlement,
} from "./task-types.js";
import { FollowupTaskAttemptRecordSchema } from "./task-types.js";

type CheckingAttempt = Extract<FollowupTaskAttemptRecord, { status: "checking" }>;
type DeliveringAttempt = Extract<FollowupTaskAttemptRecord, { status: "delivering" }>;
type CheckingTask = Extract<FollowupTaskRecord, { status: "checking" }>;
type ActiveAttempt = CheckingAttempt | DeliveringAttempt;
const RETRY_DELAYS_MS = [5 * 60_000, 30 * 60_000, 2 * 60 * 60_000] as const;

export function resolveClaimedTasks(
  root: FollowupTaskStoreFile,
  attempt: CheckingAttempt,
): Result<CheckingTask[], FollowupTaskStoreError> {
  const tasks: CheckingTask[] = [];
  for (const id of attempt.taskIds) {
    const task = root.tasks.find((candidate) => candidate.id === id);
    if (task === undefined || task.status !== "checking" || task.activeAttemptId !== attempt.id) {
      return err(transitionError("Task claim graph is inconsistent"));
    }
    tasks.push(task);
  }
  return ok(tasks);
}

export function terminalizeConfigurationDisabled(
  root: FollowupTaskStoreFile,
  attempt: CheckingAttempt,
  check: SuccessfulTaskCheckExecutionEvidence,
  nowMs: number,
): { root: FollowupTaskStoreFile; value: TaskBeginDeliveryResult } {
  const failedAttempt: FollowupTaskAttemptRecord = {
    ...attempt,
    status: "failed",
    check,
    deliveringAtMs: null,
    failureStage: "configuration_disabled",
    errorKind: "precondition",
    deliveredChunks: 0,
    failedChunks: 0,
    terminalAtMs: nowMs,
  };
  const ids = new Set(attempt.taskIds);
  const tasks = root.tasks.map((task): FollowupTaskRecord => {
    if (!ids.has(task.id) || task.status !== "checking") return task;
    const { activeAttemptId: _activeAttemptId, ...base } = task;
    return { ...base, status: "pending", nextAttemptAtMs: nowMs };
  });
  return {
    root: {
      ...root,
      tasks,
      attempts: root.attempts.map((candidate) => candidate.id === attempt.id ? failedAttempt : candidate),
    },
    value: { status: "configuration_disabled" },
  };
}

export function terminalizeClosedWindow(
  root: FollowupTaskStoreFile,
  attempt: CheckingAttempt,
  check: SuccessfulTaskCheckExecutionEvidence,
  claimed: readonly CheckingTask[],
  nowMs: number,
): { root: FollowupTaskStoreFile; value: TaskBeginDeliveryResult } {
  const failedAttempt: FollowupTaskAttemptRecord = {
    ...attempt,
    status: "failed",
    check,
    deliveringAtMs: null,
    failureStage: "delivery_window_closed",
    errorKind: "precondition",
    deliveredChunks: 0,
    failedChunks: 0,
    terminalAtMs: nowMs,
  };
  const claimedById = new Map(claimed.map((task) => [task.id, task]));
  const tasks = root.tasks.map((task): FollowupTaskRecord => {
    const owned = claimedById.get(task.id);
    if (owned === undefined) return task;
    const { activeAttemptId: _activeAttemptId, ...base } = owned;
    return nowMs > owned.dueLatestMs || nowMs > owned.expiresAtMs
      ? { ...base, status: "expired", terminalAttemptId: attempt.id, terminalAtMs: nowMs }
      : { ...base, status: "pending", nextAttemptAtMs: nowMs };
  });
  return {
    root: {
      ...root,
      tasks,
      attempts: root.attempts.map((candidate) => candidate.id === attempt.id ? failedAttempt : candidate),
    },
    value: { status: "delivery_window_closed" },
  };
}

export function buildDeliveryTerminal(
  root: FollowupTaskStoreFile,
  attempt: DeliveringAttempt,
  outcome: TaskDeliverySettlement,
  nowMs: number,
): Result<FollowupTaskStoreFile, FollowupTaskStoreError> {
  let terminalAttempt: FollowupTaskAttemptRecord;
  let taskStatus: "delivered" | "delivery_partial" | "delivery_unknown";
  if (outcome.status === "accepted") {
    if (
      !Number.isSafeInteger(outcome.deliveredChunks)
      || outcome.deliveredChunks < 1
      || !validDeliveryTime(outcome.deliveredAtMs, attempt.deliveringAtMs, nowMs)
      || !validOptionalId(outcome.lastPlatformMessageId)
    ) return err(transitionError("Accepted task delivery evidence is invalid"));
    terminalAttempt = {
      ...attempt,
      status: "delivered",
      deliveredChunks: outcome.deliveredChunks,
      failedChunks: 0,
      lastPlatformMessageId: outcome.lastPlatformMessageId,
      deliveredAtMs: outcome.deliveredAtMs,
      terminalAtMs: nowMs,
      history: outcome.history,
    };
    taskStatus = "delivered";
  } else if (outcome.status === "partial") {
    if (
      !Number.isSafeInteger(outcome.deliveredChunks)
      || outcome.deliveredChunks < 1
      || !Number.isSafeInteger(outcome.failedChunks)
      || outcome.failedChunks < 1
      || !validDeliveryTime(outcome.deliveredAtMs, attempt.deliveringAtMs, nowMs)
      || !validOptionalId(outcome.lastPlatformMessageId)
    ) return err(transitionError("Partial task delivery evidence is invalid"));
    terminalAttempt = {
      ...attempt,
      status: "delivery_partial",
      errorKind: outcome.errorKind,
      deliveredChunks: outcome.deliveredChunks,
      failedChunks: outcome.failedChunks,
      lastPlatformMessageId: outcome.lastPlatformMessageId,
      deliveredAtMs: outcome.deliveredAtMs,
      terminalAtMs: nowMs,
    };
    taskStatus = "delivery_partial";
  } else {
    if (!validUnknownDelivery(outcome.delivery)) {
      return err(transitionError("Unknown task delivery evidence is invalid"));
    }
    terminalAttempt = {
      ...attempt,
      status: "delivery_unknown",
      delivery: outcome.delivery,
      terminalAtMs: nowMs,
    };
    taskStatus = "delivery_unknown";
  }
  const ids = new Set(attempt.taskIds);
  const tasks = root.tasks.map((task): FollowupTaskRecord => {
    if (!ids.has(task.id) || task.status !== "delivering" || task.activeAttemptId !== attempt.id) return task;
    const { activeAttemptId: _activeAttemptId, ...base } = task;
    return { ...base, status: taskStatus, terminalAttemptId: attempt.id, terminalAtMs: nowMs };
  });
  return ok({
    ...root,
    tasks,
    attempts: root.attempts.map((candidate) => candidate.id === attempt.id ? terminalAttempt : candidate),
  });
}

export function buildDismissedTerminal(
  root: FollowupTaskStoreFile,
  attempt: CheckingAttempt,
  check: SuccessfulTaskCheckExecutionEvidence,
  nowMs: number,
): Result<FollowupTaskStoreFile, FollowupTaskStoreError> {
  const terminalAttempt: FollowupTaskAttemptRecord = {
    ...attempt,
    status: "dismissed",
    check,
    terminalAtMs: nowMs,
  };
  const ids = new Set(attempt.taskIds);
  const tasks = root.tasks.map((task): FollowupTaskRecord => {
    if (!ids.has(task.id) || task.status !== "checking" || task.activeAttemptId !== attempt.id) return task;
    const { activeAttemptId: _activeAttemptId, ...base } = task;
    return { ...base, status: "dismissed", terminalAttemptId: attempt.id, terminalAtMs: nowMs };
  });
  return ok({
    ...root,
    tasks,
    attempts: root.attempts.map((candidate) => candidate.id === attempt.id ? terminalAttempt : candidate),
  });
}

export function buildRetryableFailure(input: {
  readonly root: FollowupTaskStoreFile;
  readonly attempt: ActiveAttempt;
  readonly check: TaskCheckExecutionEvidence;
  readonly failureStage: TaskAttemptFailureStage;
  readonly errorKind: ErrorKind;
  readonly failedChunks: number;
  readonly nowMs: number;
  readonly retryLimit: number;
}): Result<{
  root: FollowupTaskStoreFile;
  disposition: "retry_scheduled" | "expired";
}, FollowupTaskStoreError> {
  const deliveringAtMs = input.failureStage === "delivery_rejected" && input.attempt.status === "delivering"
    ? input.attempt.deliveringAtMs
    : null;
  const failedAttempt = FollowupTaskAttemptRecordSchema.safeParse({
    ...input.attempt,
    status: "failed",
    check: input.check,
    deliveringAtMs,
    failureStage: input.failureStage,
    errorKind: input.errorKind,
    deliveredChunks: 0,
    failedChunks: input.failedChunks,
    terminalAtMs: input.nowMs,
  });
  if (!failedAttempt.success) return err(transitionError("Task failure evidence is invalid"));
  const ids = new Set(input.attempt.taskIds);
  let retryScheduled = false;
  const tasks = input.root.tasks.map((task): FollowupTaskRecord => {
    if (
      !ids.has(task.id)
      || (task.status !== "checking" && task.status !== "delivering")
      || task.activeAttemptId !== input.attempt.id
    ) return task;
    const { activeAttemptId: _activeAttemptId, ...base } = task;
    const failureCount = task.preAcceptanceFailureCount + 1;
    const delayMs = RETRY_DELAYS_MS[failureCount - 1];
    const retryAtMs = delayMs === undefined ? Number.NaN : input.nowMs + delayMs;
    if (
      failureCount <= input.retryLimit
      && Number.isSafeInteger(retryAtMs)
      && retryAtMs <= task.dueLatestMs
      && retryAtMs <= task.expiresAtMs
    ) {
      retryScheduled = true;
      return {
        ...base,
        preAcceptanceFailureCount: failureCount,
        status: "pending",
        nextAttemptAtMs: retryAtMs,
      };
    }
    return {
      ...base,
      preAcceptanceFailureCount: failureCount,
      status: "expired",
      terminalAttemptId: input.attempt.id,
      terminalAtMs: input.nowMs,
    };
  });
  return ok({
    root: {
      ...input.root,
      tasks,
      attempts: input.root.attempts.map((candidate) => (
        candidate.id === input.attempt.id ? failedAttempt.data : candidate
      )),
    },
    disposition: retryScheduled ? "retry_scheduled" : "expired",
  });
}

function validDeliveryTime(value: number, minimum: number, maximum: number): boolean {
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}

function validOptionalId(value: string | null): boolean {
  return value === null || (value.length > 0 && value.length <= 256 && Buffer.byteLength(value, "utf8") <= 256);
}

function validUnknownDelivery(delivery: Extract<TaskDeliverySettlement, { status: "unknown" }>["delivery"]): boolean {
  if (delivery.source === "platform_ambiguous") {
    return Number.isSafeInteger(delivery.deliveredChunks)
      && delivery.deliveredChunks >= 0
      && Number.isSafeInteger(delivery.failedChunks)
      && delivery.failedChunks > 0
      && Number.isSafeInteger(delivery.ambiguousChunks)
      && delivery.ambiguousChunks > 0
      && delivery.ambiguousChunks <= delivery.failedChunks
      && validOptionalId(delivery.lastPlatformMessageId);
  }
  return delivery.errorKind === (delivery.source === "owner_recovery" ? "internal" : "timeout");
}

function transitionError(message: string): FollowupTaskStoreError {
  return { code: "invalid_state", errorKind: "validation", message };
}
