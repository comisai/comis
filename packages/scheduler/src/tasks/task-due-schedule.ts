// SPDX-License-Identifier: Apache-2.0
/** Durable next-attempt timer for inferred follow-up tasks. */
import type {
  ClockPort,
  ComisLogger,
  ErrorKind,
  TimerHandle,
  TimerPort,
} from "@comis/core";
import { err, fromPromise, ok, suppressError, tryCatch, type Result } from "@comis/shared";
import type {
  HeartbeatWakeAdmissionError,
  HeartbeatWakeAdmissionOutcome,
  HeartbeatWakeRequest,
} from "../heartbeat/wake-coordinator.js";
import { FOLLOWUP_TASK_RETENTION_MS, type FollowupTaskStore } from "./task-store.js";
import type { FollowupTaskRecord } from "./task-types.js";

const TASK_WAKE_RETRY_MS = 30_000;
type TaskScheduleBoundaryKind = "task_due" | "retention";

export type TaskDueScheduleError =
  | { readonly code: "not_accepting"; readonly errorKind: "precondition" }
  | { readonly code: "store_unavailable"; readonly errorKind: ErrorKind }
  | { readonly code: "invalid_state"; readonly errorKind: "validation" | "internal" };

export interface TaskDueScheduleDeps {
  readonly agentId: string;
  readonly clock: ClockPort;
  readonly timers: TimerPort;
  readonly store: Pick<FollowupTaskStore, "read">;
  readonly submitTaskWake: (
    request: HeartbeatWakeRequest,
  ) => Result<HeartbeatWakeAdmissionOutcome, HeartbeatWakeAdmissionError>;
  readonly logger: Pick<ComisLogger, "debug" | "info" | "warn" | "error">;
}

export interface TaskDueSchedule {
  activate(): Promise<Result<{ readonly nextDueAtMs: number | null }, TaskDueScheduleError>>;
  requestRescan(): Promise<Result<{ readonly nextDueAtMs: number | null }, TaskDueScheduleError>>;
  getNextDueAtMs(): number | null;
  shutdown(): void;
}

export function createTaskDueSchedule(deps: TaskDueScheduleDeps): TaskDueSchedule {
  let active = false;
  let closed = false;
  let timer: TimerHandle | undefined;
  let nextDueAtMs: number | null = null;
  let scanGeneration = 0;

  async function activate(): Promise<Result<{ readonly nextDueAtMs: number | null }, TaskDueScheduleError>> {
    if (closed) return err({ code: "not_accepting", errorKind: "precondition" });
    active = true;
    return requestRescan();
  }

  async function requestRescan(): Promise<Result<{ readonly nextDueAtMs: number | null }, TaskDueScheduleError>> {
    if (!active || closed) return err({ code: "not_accepting", errorKind: "precondition" });
    const generation = ++scanGeneration;
    const startedAtMs = deps.clock.now();
    const boundary = await fromPromise(deps.store.read());
    if (closed || generation !== scanGeneration) return ok({ nextDueAtMs });
    if (!boundary.ok || !boundary.value.ok) {
      let errorKind: ErrorKind = "internal";
      if (boundary.ok) {
        const read = boundary.value;
        if (!read.ok) errorKind = read.error.errorKind;
      }
      deps.logger.error({
        agentId: deps.agentId,
        step: "task_due_store_read",
        durationMs: Math.max(0, deps.clock.now() - startedAtMs),
        errorKind,
        hint: "Restore the strict task authority store before rearming due-task scheduling",
      }, "Task due schedule could not read durable authority");
      return err({ code: "store_unavailable", errorKind });
    }
    const pending = boundary.value.value.tasks.filter((task): task is Extract<FollowupTaskRecord, { status: "pending" }> => (
      task.agentId === deps.agentId && task.status === "pending"
    ));
    const nextTaskDueAtMs = pending.reduce<number | null>((earliest, task) => (
      earliest === null ? task.nextAttemptAtMs : Math.min(earliest, task.nextAttemptAtMs)
    ), null);
    const terminalTimes = boundary.value.value.tasks.flatMap((task) => (
      "terminalAtMs" in task ? [task.terminalAtMs] : []
    ));
    const nextRetentionAtMs = terminalTimes.reduce<number | null>((earliest, terminalAtMs) => {
      const retentionAtMs = terminalAtMs + FOLLOWUP_TASK_RETENTION_MS;
      if (!Number.isSafeInteger(retentionAtMs)) return Number.NaN;
      return earliest === null ? retentionAtMs : Math.min(earliest, retentionAtMs);
    }, null);
    if (
      nextTaskDueAtMs !== null && (!Number.isSafeInteger(nextTaskDueAtMs) || nextTaskDueAtMs < 0)
      || nextRetentionAtMs !== null && (!Number.isSafeInteger(nextRetentionAtMs) || nextRetentionAtMs < 0)
    ) {
      return err({ code: "invalid_state", errorKind: "validation" });
    }
    const boundaryPlan = nextTaskDueAtMs !== null && (
      nextRetentionAtMs === null || nextTaskDueAtMs <= nextRetentionAtMs
    )
      ? { atMs: nextTaskDueAtMs, kind: "task_due" as const }
      : nextRetentionAtMs === null
        ? null
        : { atMs: nextRetentionAtMs, kind: "retention" as const };
    armAt(boundaryPlan);
    deps.logger.debug({
      agentId: deps.agentId,
      step: "task_due_rescan",
      pendingCount: pending.length,
      terminalCount: terminalTimes.length,
      nextDueAtMs: boundaryPlan?.atMs ?? null,
      boundaryKind: boundaryPlan?.kind ?? "none",
      durationMs: Math.max(0, deps.clock.now() - startedAtMs),
    }, "Task due schedule rescanned");
    return ok({ nextDueAtMs: boundaryPlan?.atMs ?? null });
  }

  function armAt(boundary: { readonly atMs: number; readonly kind: TaskScheduleBoundaryKind } | null): void {
    timer?.cancel();
    timer = undefined;
    nextDueAtMs = boundary?.atMs ?? null;
    if (!active || closed || boundary === null) return;
    const handle = deps.timers.setTimeout(() => {
      if (timer === handle) timer = undefined;
      nextDueAtMs = null;
      if (boundary.kind === "task_due") {
        submitDueWake(boundary.atMs);
        return;
      }
      suppressError(
        requestRescan(),
        "task retention schedule rescan",
        (message) => deps.logger.debug({
          agentId: deps.agentId,
          step: "task_retention_rescan",
        }, message),
      );
    }, Math.max(0, boundary.atMs - deps.clock.now()));
    handle.unref();
    timer = handle;
  }

  function submitDueWake(nominalDueAtMs: number): void {
    if (!active || closed) return;
    const startedAtMs = deps.clock.now();
    const submitted = tryCatch(() => deps.submitTaskWake({
      target: { kind: "agent", agentId: deps.agentId },
      reason: "task",
      timing: { kind: "routine", notBeforeMs: nominalDueAtMs },
    }));
    if (submitted.ok && submitted.value.ok) {
      deps.logger.info({
        agentId: deps.agentId,
        correlationId: submitted.value.value.correlationId,
        step: "task_due_wake_admission",
        durationMs: Math.max(0, deps.clock.now() - startedAtMs),
      }, "Task due wake admitted");
      return;
    }
    let errorKind: ErrorKind = "internal";
    if (submitted.ok) {
      const admission = submitted.value;
      if (!admission.ok) errorKind = admission.error.errorKind;
    }
    deps.logger.warn({
      agentId: deps.agentId,
      step: "task_due_wake_admission",
      durationMs: Math.max(0, deps.clock.now() - startedAtMs),
      errorKind,
      hint: "Restore coordinator admission; one bounded task-wake retry remains armed",
    }, "Task due wake admission failed");
    const retryAtMs = deps.clock.now() + TASK_WAKE_RETRY_MS;
    if (Number.isSafeInteger(retryAtMs)) armAt({ atMs: retryAtMs, kind: "task_due" });
    else {
      deps.logger.error({
        agentId: deps.agentId,
        step: "task_due_wake_retry",
        errorKind: "internal" as const,
        hint: "Inspect the scheduler clock before reactivating due-task scheduling",
      }, "Task due wake retry time overflowed");
    }
  }

  function shutdown(): void {
    if (closed) return;
    closed = true;
    active = false;
    scanGeneration += 1;
    timer?.cancel();
    timer = undefined;
    nextDueAtMs = null;
  }

  return { activate, requestRescan, getNextDueAtMs: () => nextDueAtMs, shutdown };
}
