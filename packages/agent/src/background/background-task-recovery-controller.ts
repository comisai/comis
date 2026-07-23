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
  let scanFailureAttempts = 0;
  let lastScanEvidenceAt: number | undefined;
  let lastScanEvidenceKey: string | undefined;
  const healthAnnounced = new Set<string>();
  const durableAnnounced = new Set<string>();
  const scanTaskIds = new Set<string>();
  const unresolvedTasks = new Map<
    string,
    Pick<BackgroundTask, "id" | "toolName" | "origin">
  >();
  const incidentRetries = new Map<string, {
    input: BackgroundRecoveryIncidentInput;
    timer?: TimerHandle;
  }>();

  function buildIncident(
    task: Pick<BackgroundTask, "id" | "toolName" | "origin">,
    reason: BackgroundRecoveryIncidentInput["reason"],
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
      reason,
    });
  }

  function emitRecoveryLifecycle(
    input: BackgroundRecoveryIncidentInput,
    trajectoryRecorded: boolean,
  ): void {
    emitObservationalEventSafely({ eventBus: deps.eventBus, logger: deps.logger }, "background_task:notified", {
      agentId: input.agentId,
      taskId: input.taskId,
      toolName: input.toolName,
      sessionKey: input.sessionKey,
      notified: false,
      reason: input.reason,
      traceId: input.traceId,
      timestamp: input.timestamp,
      trajectoryRecorded,
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
      const durableKey = `${input.taskId}:${input.reason}`;
      if (!durableAnnounced.has(durableKey)) {
        durableAnnounced.add(durableKey);
        emitRecoveryLifecycle(input, true);
      }
      return;
    }
    incidentRetries.set(input.taskId, {
      input,
      timer: incidentRetries.get(input.taskId)?.timer,
    });
    if (!healthAnnounced.has(input.taskId)) {
      healthAnnounced.add(input.taskId);
      emitRecoveryLifecycle(input, false);
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

  function recordTask(
    task: Pick<BackgroundTask, "id" | "toolName" | "origin">,
  ): void {
    if (unresolvedTasks.has(task.id)) return;
    const incident = buildIncident(task, "recovery_retry_required");
    if (!incident.ok) return;
    unresolvedTasks.set(task.id, task);
    persistIncident(incident.value);
  }

  function resolveTask(
    task: Pick<BackgroundTask, "id" | "toolName" | "origin">,
  ): void {
    const unresolved = unresolvedTasks.get(task.id);
    if (unresolved === undefined) return;
    unresolvedTasks.delete(task.id);
    scanTaskIds.delete(task.id);
    healthAnnounced.delete(task.id);
    incidentRetries.get(task.id)?.timer?.cancel();
    incidentRetries.delete(task.id);
    const resolved = buildIncident(task, "recovery_resolved");
    if (resolved.ok) persistIncident(resolved.value);
  }

  function reportScanFailures(
    failures: readonly TaskRecoveryFailure[],
    retry: () => void,
  ): void {
    const currentTaskIds = new Set(
      failures.flatMap((failure) => failure.identity === undefined ? [] : [failure.identity.id]),
    );
    if (failures.every((failure) => failure.identity !== undefined)) {
      for (const taskId of scanTaskIds) {
        if (currentTaskIds.has(taskId)) continue;
        const task = unresolvedTasks.get(taskId);
        if (task !== undefined) resolveTask(task);
      }
    }
    if (failures.length === 0) {
      scanFailureAttempts = 0;
      lastScanEvidenceAt = undefined;
      lastScanEvidenceKey = undefined;
      return;
    }
    const kinds = [...new Set(failures.map((failure) => failure.kind))].sort();
    const evidenceKey = `${kinds.join(",")}:${[...currentTaskIds].sort().join(",")}`;
    const now = deps.clock.now();
    if (
      evidenceKey !== lastScanEvidenceKey
      || lastScanEvidenceAt === undefined
      || now - lastScanEvidenceAt >= 60_000
    ) {
      lastScanEvidenceKey = evidenceKey;
      lastScanEvidenceAt = now;
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
    }
    for (const failure of failures) {
      if (failure.identity === undefined) continue;
      if (unresolvedTasks.has(failure.identity.id)) continue;
      scanTaskIds.add(failure.identity.id);
      recordTask(failure.identity);
    }
    if (scanRetry !== undefined) return;
    const delayMs = Math.min(60_000, 1_000 * (2 ** Math.min(scanFailureAttempts, 6)));
    scanFailureAttempts++;
    scanRetry = deps.timers.setTimeout(() => {
      scanRetry = undefined;
      retry();
    }, delayMs);
    scanRetry.unref();
  }

  return {
    setRecorder(next: typeof recorder): void {
      recorder = next;
    },
    recordTask,
    resolveTask,
    reportScanFailures,
  };
}
