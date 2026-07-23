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
import type {
  AtomicTaskPersistenceOps,
} from "./background-task-persistence.js";
import {
  persistBackgroundRecoveryAuthority,
  recoverBackgroundRecoveryAuthorities,
  removeBackgroundRecoveryAuthority,
  type BackgroundRecoveryAuthority,
} from "./background-recovery-authority.js";

interface RecoveryControllerDeps {
  eventBus: TypedEventBus;
  logger: {
    warn(obj: Record<string, unknown>, msg: string): void;
  };
  clock: ClockPort;
  timers: TimerPort;
  dataDir: string;
  persistenceOps?: AtomicTaskPersistenceOps;
}

export function createBackgroundTaskRecoveryController(deps: RecoveryControllerDeps) {
  let recorder:
    ((input: BackgroundRecoveryIncidentInput) => Result<void, Error>)
    | undefined;
  let scanRetry: TimerHandle | undefined;
  let authorityLoadRetry: TimerHandle | undefined;
  let scanFailureAttempts = 0;
  let lastScanEvidenceAt: number | undefined;
  let lastScanEvidenceKey: string | undefined;
  let authorityLoadAnnounced = false;
  const healthAnnounced = new Set<string>();
  const durableAnnounced = new Set<string>();
  const trajectoryAccepted = new Set<string>();
  const authorities = new Map<string, BackgroundRecoveryAuthority>();
  const dirtyAuthorities = new Set<string>();
  const incidentRetries = new Map<string, TimerHandle>();

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
    if (incidentRetries.has(taskId)) return;
    const timer = deps.timers.setTimeout(() => {
      incidentRetries.delete(taskId);
      driveAuthority(taskId);
    }, 1_000);
    timer.unref();
    incidentRetries.set(taskId, timer);
  }

  function incidentInput(
    authority: BackgroundRecoveryAuthority,
    reason: BackgroundRecoveryIncidentInput["reason"],
  ): BackgroundRecoveryIncidentInput {
    return {
      agentId: authority.agentId,
      taskId: authority.taskId,
      toolName: authority.toolName,
      sessionKey: authority.sessionKey,
      projectedSessionKey: authority.projectedSessionKey,
      traceId: authority.traceId,
      timestamp: reason === "recovery_retry_required"
        ? authority.timestamp
        : deps.clock.now(),
      reason,
    };
  }

  function reportIncidentFailure(input: BackgroundRecoveryIncidentInput): void {
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

  function commitAuthority(authority: BackgroundRecoveryAuthority): boolean {
    const persisted = persistBackgroundRecoveryAuthority(
      deps.dataDir,
      authority,
      deps.persistenceOps,
    );
    if (!persisted.ok) {
      reportIncidentFailure(
        incidentInput(authority, "recovery_retry_required"),
      );
      return false;
    }
    dirtyAuthorities.delete(authority.taskId);
    return true;
  }

  function announceAccepted(input: BackgroundRecoveryIncidentInput): void {
    const key = `${input.taskId}:${input.reason}`;
    if (durableAnnounced.has(key)) return;
    durableAnnounced.add(key);
    emitRecoveryLifecycle(input, true);
  }

  function driveAuthority(taskId: string): void {
    let authority = authorities.get(taskId);
    if (authority === undefined) return;
    const requiredKey = `${taskId}:recovery_retry_required`;
    if (dirtyAuthorities.has(taskId) && !commitAuthority(authority)) {
      if (!authority.requiredAccepted && !trajectoryAccepted.has(requiredKey)) {
        const required = incidentInput(authority, "recovery_retry_required");
        const persisted = recorder?.(required)
          ?? err(new Error("Background recovery incident recorder is not configured"));
        if (!persisted.ok) {
          reportIncidentFailure(required);
          return;
        }
        trajectoryAccepted.add(requiredKey);
        announceAccepted(required);
        authority = { ...authority, requiredAccepted: true };
        authorities.set(taskId, authority);
        dirtyAuthorities.add(taskId);
      }
      return;
    }

    if (!authority.requiredAccepted) {
      const required = incidentInput(authority, "recovery_retry_required");
      if (!trajectoryAccepted.has(requiredKey)) {
        const persisted = recorder?.(required)
          ?? err(new Error("Background recovery incident recorder is not configured"));
        if (!persisted.ok) {
          reportIncidentFailure(required);
          return;
        }
        trajectoryAccepted.add(requiredKey);
        announceAccepted(required);
      }
      authority = { ...authority, requiredAccepted: true };
      authorities.set(taskId, authority);
      dirtyAuthorities.add(taskId);
      if (!commitAuthority(authority)) return;
    }

    if (!authority.resolutionRequested) return;
    const resolvedKey = `${taskId}:recovery_resolved`;
    const resolved = incidentInput(authority, "recovery_resolved");
    if (!trajectoryAccepted.has(resolvedKey)) {
      const persisted = recorder?.(resolved)
        ?? err(new Error("Background recovery incident recorder is not configured"));
      if (!persisted.ok) {
        reportIncidentFailure(resolved);
        return;
      }
      trajectoryAccepted.add(resolvedKey);
      announceAccepted(resolved);
    }
    const removed = removeBackgroundRecoveryAuthority(
      deps.dataDir,
      authority,
      deps.persistenceOps,
    );
    if (!removed.ok) {
      reportIncidentFailure(resolved);
      return;
    }
    authorities.delete(taskId);
    dirtyAuthorities.delete(taskId);
    healthAnnounced.delete(taskId);
    incidentRetries.get(taskId)?.cancel();
    incidentRetries.delete(taskId);
  }

  function recordTask(
    task: Pick<BackgroundTask, "id" | "toolName" | "origin">,
    source: BackgroundRecoveryAuthority["source"] = "task",
  ): void {
    if (authorities.has(task.id)) {
      driveAuthority(task.id);
      return;
    }
    const incident = buildIncident(task, "recovery_retry_required");
    if (!incident.ok) return;
    const authority: BackgroundRecoveryAuthority = {
      agentId: incident.value.agentId,
      taskId: incident.value.taskId,
      toolName: incident.value.toolName,
      sessionKey: incident.value.sessionKey,
      projectedSessionKey: incident.value.projectedSessionKey,
      traceId: incident.value.traceId,
      timestamp: incident.value.timestamp,
      source,
      requiredAccepted: false,
      resolutionRequested: false,
    };
    authorities.set(task.id, authority);
    dirtyAuthorities.add(task.id);
    driveAuthority(task.id);
  }

  function resolveTask(
    task: Pick<BackgroundTask, "id">,
  ): void {
    const authority = authorities.get(task.id);
    if (authority === undefined) return;
    const requested = { ...authority, resolutionRequested: true };
    authorities.set(task.id, requested);
    dirtyAuthorities.add(task.id);
    driveAuthority(task.id);
  }

  function reportScanFailures(
    failures: readonly TaskRecoveryFailure[],
    retry: () => void,
  ): void {
    const currentTaskIds = new Set(
      failures.flatMap((failure) => failure.identity === undefined ? [] : [failure.identity.id]),
    );
    if (failures.every((failure) => failure.identity !== undefined)) {
      for (const [taskId, authority] of authorities) {
        if (authority.source !== "scan") continue;
        if (currentTaskIds.has(taskId)) continue;
        resolveTask({
          id: authority.taskId,
        });
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
      if (authorities.has(failure.identity.id)) continue;
      recordTask(failure.identity, "scan");
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

  function restoreAuthorities(): void {
    const recovered = recoverBackgroundRecoveryAuthorities(
      deps.dataDir,
    );
    if (!recovered.ok) {
      if (!authorityLoadAnnounced) {
        authorityLoadAnnounced = true;
        deps.logger.warn(
          {
            hint: "Repair protected background recovery authority storage; loading will retry",
            errorKind: "resource" as const,
          },
          "Background recovery authority loading failed",
        );
        emitObservationalEventSafely(
          { eventBus: deps.eventBus, logger: deps.logger },
          "system:error",
          {
            error: new Error("Background recovery authority loading failed"),
            source: "background-task-recovery",
          },
        );
      }
      if (authorityLoadRetry === undefined) {
        authorityLoadRetry = deps.timers.setTimeout(() => {
          authorityLoadRetry = undefined;
          restoreAuthorities();
        }, 1_000);
        authorityLoadRetry.unref();
      }
      return;
    }
    authorityLoadAnnounced = false;
    for (const authority of recovered.value) {
      if (!authorities.has(authority.taskId)) {
        authorities.set(authority.taskId, authority);
      }
    }
    if (recorder !== undefined) {
      for (const taskId of authorities.keys()) driveAuthority(taskId);
    }
  }

  restoreAuthorities();

  return {
    setRecorder(next: typeof recorder): void {
      recorder = next;
      for (const taskId of authorities.keys()) driveAuthority(taskId);
    },
    recordTask,
    resolveTask,
    reportScanFailures,
  };
}
