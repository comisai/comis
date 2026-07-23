// SPDX-License-Identifier: Apache-2.0
import {
  conversationScopeToSessionKey,
  emitObservationalEventSafely,
  formatSessionKey,
  type ClockPort,
  type TimerHandle,
  type TimerPort,
  type TypedEventBus,
} from "@comis/core";
import { err, ok, type Result } from "@comis/shared";
import type {
  BackgroundRecoveryIncidentInput,
} from "./background-task-manager.js";
import type { BackgroundTask } from "./background-task-types.js";
import type { TaskRecoveryFailure } from "./background-task-persistence.js";

interface RecoveryControllerDeps {
  eventBus: TypedEventBus;
  logger: {
    warn(obj: Record<string, unknown>, msg: string): void;
  };
  clock: ClockPort;
  timers: TimerPort;
}

export function createBackgroundTaskRecoveryController(deps: RecoveryControllerDeps) {
  let recorder:
    ((input: BackgroundRecoveryIncidentInput) => Result<void, Error>)
    | undefined;
  let scanRetry: TimerHandle | undefined;
  const healthAnnounced = new Set<string>();
  const durableAnnounced = new Set<string>();
  const incidentRetries = new Map<string, {
    input: BackgroundRecoveryIncidentInput;
    timer?: TimerHandle;
  }>();

  function buildIncident(
    task: Pick<BackgroundTask, "id" | "toolName" | "origin">,
  ): Result<BackgroundRecoveryIncidentInput, Error> {
    const projected = conversationScopeToSessionKey(task.origin.turnScope.conversation);
    if (!projected.ok) return err(new Error(projected.error.message));
    return ok({
      agentId: task.origin.turnScope.conversation.agentId,
      taskId: task.id,
      toolName: task.toolName,
      sessionKey: formatSessionKey(projected.value),
      projectedSessionKey: projected.value,
      traceId: task.origin.traceId ?? null,
      timestamp: deps.clock.now(),
    });
  }

  function emitRecoveryRequired(input: BackgroundRecoveryIncidentInput): void {
    emitObservationalEventSafely({ eventBus: deps.eventBus, logger: deps.logger }, "background_task:notified", {
      agentId: input.agentId,
      taskId: input.taskId,
      toolName: input.toolName,
      sessionKey: input.sessionKey,
      notified: false,
      reason: "recovery_retry_required",
      traceId: input.traceId,
      timestamp: input.timestamp,
    });
  }

  function scheduleIncidentRetry(taskId: string): void {
    const pending = incidentRetries.get(taskId);
    if (pending === undefined || pending.timer !== undefined) return;
    pending.timer = deps.timers.setTimeout(() => {
      pending.timer = undefined;
      persistIncident(pending.input);
    }, 1_000);
    pending.timer.unref();
  }

  function persistIncident(input: BackgroundRecoveryIncidentInput): void {
    const persisted = recorder?.(input)
      ?? err(new Error("Background recovery incident recorder is not configured"));
    if (persisted.ok) {
      incidentRetries.delete(input.taskId);
      if (!durableAnnounced.has(input.taskId)) {
        durableAnnounced.add(input.taskId);
        emitRecoveryRequired(input);
      }
      return;
    }
    incidentRetries.set(input.taskId, {
      input,
      timer: incidentRetries.get(input.taskId)?.timer,
    });
    if (!healthAnnounced.has(input.taskId)) {
      healthAnnounced.add(input.taskId);
      emitRecoveryRequired(input);
      deps.logger.warn(
        {
          taskId: input.taskId,
          toolName: input.toolName,
          hint: "Repair the trajectory store; the background recovery incident will retry",
          errorKind: "resource" as const,
        },
        "Background recovery incident persistence failed",
      );
    }
    scheduleIncidentRetry(input.taskId);
  }

  function reportScanFailures(
    failures: readonly TaskRecoveryFailure[],
    retry: () => void,
  ): void {
    if (failures.length === 0) return;
    const kinds = [...new Set(failures.map((failure) => failure.kind))].sort();
    deps.logger.warn(
      {
        failureCount: failures.length,
        failureKinds: kinds,
        hint: "Repair protected background-task storage; startup recovery will retry",
        errorKind: "resource" as const,
      },
      "Background task recovery scan incomplete",
    );
    emitObservationalEventSafely({ eventBus: deps.eventBus, logger: deps.logger }, "system:error", {
      error: new Error("Background task recovery scan incomplete"),
      source: "background-task-recovery",
    });
    for (const failure of failures) {
      if (failure.identity === undefined) continue;
      const incident = buildIncident(failure.identity);
      if (incident.ok) persistIncident(incident.value);
    }
    if (scanRetry !== undefined) return;
    scanRetry = deps.timers.setTimeout(() => {
      scanRetry = undefined;
      retry();
    }, 1_000);
    scanRetry.unref();
  }

  return {
    setRecorder(next: typeof recorder): void {
      recorder = next;
    },
    recordTask(task: Pick<BackgroundTask, "id" | "toolName" | "origin">): void {
      const incident = buildIncident(task);
      if (incident.ok) persistIncident(incident.value);
    },
    reportScanFailures,
  };
}
