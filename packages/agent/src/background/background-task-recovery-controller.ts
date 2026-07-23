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
  BackgroundRecoveryRecorderFailure,
  BackgroundRecoveryRecorderFailureKind,
  BackgroundRecoveryRecorderDisposition,
} from "./background-task-manager.js";
import type { BackgroundTask } from "./background-task-types.js";
import type {
  AtomicTaskPersistenceOps,
  TaskRecoveryFailure,
  TaskRecoveryOps,
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
  authorityRecoveryOps?: TaskRecoveryOps;
}

export function createBackgroundTaskRecoveryController(deps: RecoveryControllerDeps) {
  let recorder:
    ((
      input: BackgroundRecoveryIncidentInput,
    ) => Result<
      BackgroundRecoveryRecorderDisposition,
      BackgroundRecoveryRecorderFailure
    >)
    | undefined;
  let scanRetry: TimerHandle | undefined;
  let authorityLoadRetry: TimerHandle | undefined;
  let scanFailureAttempts = 0;
  let lastScanEvidenceAt: number | undefined;
  let lastScanEvidenceKey: string | undefined;
  let authorityLoadAnnounced = false;
  let authoritiesLoaded = false;
  let scanSnapshot:
    | {
      complete: boolean;
      presentTaskIds: ReadonlySet<string>;
    }
    | undefined;
  const healthAnnounced = new Set<string>();
  const durableAnnounced = new Set<string>();
  const trajectoryAccepted = new Set<string>();
  const authorities = new Map<string, BackgroundRecoveryAuthority>();
  const dirtyAuthorities = new Set<string>();
  const incidentRetries = new Map<string, TimerHandle>();
  const incidentRetryAttempts = new Map<string, number>();
  const pendingResolutionTaskIds = new Set<string>();
  const restoredAuthorityIds = new Set<string>();
  const pendingRecordTasks = new Map<
    string,
    {
      task: Pick<BackgroundTask, "id" | "toolName" | "origin">;
      source: BackgroundRecoveryAuthority["source"];
    }
  >();

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
    const attempt = incidentRetryAttempts.get(taskId) ?? 0;
    const delayMs = Math.min(60_000, 1_000 * (2 ** Math.min(attempt, 6)));
    incidentRetryAttempts.set(taskId, attempt + 1);
    const timer = deps.timers.setTimeout(() => {
      incidentRetries.delete(taskId);
      driveAuthority(taskId);
    }, delayMs);
    timer.unref();
    incidentRetries.set(taskId, timer);
  }

  function resetIncidentRetry(taskId: string): void {
    incidentRetryAttempts.delete(taskId);
    incidentRetries.get(taskId)?.cancel();
    incidentRetries.delete(taskId);
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

  function reportFailure(
    input: BackgroundRecoveryIncidentInput,
    kind:
      | "authority_storage"
      | "configuration"
      | `trajectory_${BackgroundRecoveryRecorderFailureKind}`,
    source: string,
    message: string,
    hint: string,
    errorKind: "resource" | "config" | "precondition" | "validation",
    retry: boolean,
  ): void {
    const key = `${input.taskId}:${kind}`;
    if (!healthAnnounced.has(key)) {
      healthAnnounced.add(key);
      emitObservationalEventSafely(
        { eventBus: deps.eventBus, logger: deps.logger },
        "system:error",
        {
          error: new Error(message),
          source,
        },
      );
      deps.logger.warn(
        {
          taskId: input.taskId,
          toolName: input.toolName,
          hint,
          errorKind,
        },
        message,
      );
    }
    if (retry) scheduleIncidentRetry(input.taskId);
  }

  function reportAuthorityStorageFailure(
    authority: BackgroundRecoveryAuthority,
    reason: BackgroundRecoveryIncidentInput["reason"],
  ): void {
    reportFailure(
      incidentInput(authority, reason),
      "authority_storage",
      "background-recovery-authority-storage",
      "Background recovery authority persistence failed",
      "Repair protected background recovery authority storage; persistence will retry",
      "resource",
      true,
    );
  }

  function reportTrajectoryFailure(
    input: BackgroundRecoveryIncidentInput,
    failure: BackgroundRecoveryRecorderFailure,
  ): void {
    switch (failure.kind) {
      case "session_adapter_unavailable":
        reportFailure(
          input,
          "trajectory_session_adapter_unavailable",
          "background-recovery-session-adapter",
          "Background recovery session adapter unavailable",
          "Configure and start the affected agent session adapter; recovery will retry",
          "precondition",
          true,
        );
        return;
      case "protected_path_unavailable":
        reportFailure(
          input,
          "trajectory_protected_path_unavailable",
          "background-recovery-trajectory-path",
          "Background recovery trajectory path unavailable",
          "Repair trajectory path permissions, confinement, symlinks, or I/O; recovery will retry",
          "resource",
          true,
        );
        return;
      case "persisted_state_invalid":
        reportFailure(
          input,
          "trajectory_persisted_state_invalid",
          "background-recovery-trajectory-state",
          "Background recovery trajectory state invalid",
          "Repair or remove the invalid or oversized persisted trajectory JSONL; recovery will retry",
          "validation",
          true,
        );
        return;
      case "recorder_rejected":
        reportFailure(
          input,
          "trajectory_recorder_rejected",
          "background-recovery-recorder-capacity",
          "Background recovery trajectory admission rejected",
          "Inspect diagnostics.trajectory.maxFileBytes and recorder queue capacity; recovery will retry",
          "resource",
          true,
        );
        return;
      default: {
        const exhaustive: never = failure.kind;
        return exhaustive;
      }
    }
  }

  function reportResolutionSuppressed(input: BackgroundRecoveryIncidentInput): void {
    resetIncidentRetry(input.taskId);
    reportFailure(
      input,
      "configuration",
      "background-recovery-configuration",
      "Background recovery resolution is suppressed",
      "Enable diagnostics.trajectory.enabled and allow background_task.notified in diagnostics.trajectory.eventTypes, then restart the daemon",
      "config",
      false,
    );
  }

  function commitAuthority(authority: BackgroundRecoveryAuthority): boolean {
    const persisted = persistBackgroundRecoveryAuthority(
      deps.dataDir,
      authority,
      deps.persistenceOps,
    );
    if (!persisted.ok || persisted.value.kind !== "committed") {
      reportAuthorityStorageFailure(
        authority,
        authority.resolutionRequested
          ? "recovery_resolved"
          : "recovery_retry_required",
      );
      return false;
    }
    dirtyAuthorities.delete(authority.taskId);
    healthAnnounced.delete(`${authority.taskId}:authority_storage`);
    resetIncidentRetry(authority.taskId);
    return true;
  }

  function announceAccepted(input: BackgroundRecoveryIncidentInput): void {
    const key = `${input.taskId}:${input.reason}`;
    if (durableAnnounced.has(key)) return;
    durableAnnounced.add(key);
    emitRecoveryLifecycle(input, true);
  }

  function removeAuthority(authority: BackgroundRecoveryAuthority): boolean {
    const removed = removeBackgroundRecoveryAuthority(
      deps.dataDir,
      authority,
      deps.persistenceOps,
    );
    if (!removed.ok) {
      reportAuthorityStorageFailure(authority, "recovery_resolved");
      return false;
    }
    authorities.delete(authority.taskId);
    dirtyAuthorities.delete(authority.taskId);
    restoredAuthorityIds.delete(authority.taskId);
    for (const key of healthAnnounced) {
      if (key.startsWith(`${authority.taskId}:`)) healthAnnounced.delete(key);
    }
    resetIncidentRetry(authority.taskId);
    return true;
  }

  function driveAuthority(taskId: string): void {
    let authority = authorities.get(taskId);
    if (authority === undefined) return;
    if (
      recorder === undefined
      || (restoredAuthorityIds.has(taskId) && scanSnapshot === undefined)
    ) {
      return;
    }
    const requiredKey = `${taskId}:recovery_retry_required`;
    if (dirtyAuthorities.has(taskId) && !commitAuthority(authority)) return;

    if (authority.requiredDisposition === "pending") {
      const required = incidentInput(authority, "recovery_retry_required");
      if (!trajectoryAccepted.has(requiredKey)) {
        const recorded = recorder(required);
        if (!recorded.ok) {
          reportTrajectoryFailure(required, recorded.error);
          return;
        }
        for (const key of healthAnnounced) {
          if (key.startsWith(`${taskId}:trajectory_`)) {
            healthAnnounced.delete(key);
          }
        }
        if (recorded.value === "accepted") {
          resetIncidentRetry(taskId);
          trajectoryAccepted.add(requiredKey);
          announceAccepted(required);
        }
        authority = {
          ...authority,
          requiredDisposition: recorded.value,
        };
        authorities.set(taskId, authority);
        dirtyAuthorities.add(taskId);
      }
      if (!commitAuthority(authority)) return;
    }

    if (!authority.resolutionRequested) return;
    if (authority.requiredDisposition === "suppressed") {
      removeAuthority(authority);
      return;
    }
    const resolvedKey = `${taskId}:recovery_resolved`;
    const resolved = incidentInput(authority, "recovery_resolved");
    if (!trajectoryAccepted.has(resolvedKey)) {
      const recorded = recorder(resolved);
      if (!recorded.ok) {
        reportTrajectoryFailure(resolved, recorded.error);
        return;
      }
      for (const key of healthAnnounced) {
        if (key.startsWith(`${taskId}:trajectory_`)) {
          healthAnnounced.delete(key);
        }
      }
      if (recorded.value === "suppressed") {
        reportResolutionSuppressed(resolved);
        return;
      }
      healthAnnounced.delete(`${taskId}:configuration`);
      resetIncidentRetry(taskId);
      trajectoryAccepted.add(resolvedKey);
      announceAccepted(resolved);
    }
    removeAuthority(authority);
  }

  function installTaskAuthority(
    task: Pick<BackgroundTask, "id" | "toolName" | "origin">,
    source: BackgroundRecoveryAuthority["source"],
  ): void {
    if (authorities.has(task.id)) return;
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
      requiredDisposition: "pending",
      resolutionRequested: false,
    };
    authorities.set(task.id, authority);
    dirtyAuthorities.add(task.id);
  }

  function recordTask(
    task: Pick<BackgroundTask, "id" | "toolName" | "origin">,
    source: BackgroundRecoveryAuthority["source"] = "task",
  ): void {
    if (!authoritiesLoaded) {
      pendingRecordTasks.set(task.id, { task, source });
      return;
    }
    installTaskAuthority(task, source);
    driveAuthority(task.id);
  }

  function resolveTask(
    task: Pick<BackgroundTask, "id">,
  ): void {
    const authority = authorities.get(task.id);
    if (authority === undefined) {
      if (!authoritiesLoaded) pendingResolutionTaskIds.add(task.id);
      return;
    }
    const requested = { ...authority, resolutionRequested: true };
    authorities.set(task.id, requested);
    dirtyAuthorities.add(task.id);
    driveAuthority(task.id);
  }

  function reportScanFailures(
    failures: readonly TaskRecoveryFailure[],
    recoveredTaskIds: readonly string[],
    retry: () => void,
  ): void {
    const failedTaskIds = new Set(
      failures.flatMap((failure) => failure.identity === undefined ? [] : [failure.identity.id]),
    );
    scanSnapshot = {
      complete: failures.every((failure) => failure.identity !== undefined),
      presentTaskIds: new Set([...recoveredTaskIds, ...failedTaskIds]),
    };
    reconcileAuthorities();
    if (failures.length === 0) {
      scanFailureAttempts = 0;
      lastScanEvidenceAt = undefined;
      lastScanEvidenceKey = undefined;
      return;
    }
    const kinds = [...new Set(failures.map((failure) => failure.kind))].sort();
    const evidenceKey = `${kinds.join(",")}:${[...failedTaskIds].sort().join(",")}`;
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

  function reconcileAuthorities(): void {
    if (!authoritiesLoaded) return;
    for (const taskId of pendingResolutionTaskIds) {
      const authority = authorities.get(taskId);
      if (authority !== undefined) {
        authorities.set(taskId, {
          ...authority,
          resolutionRequested: true,
        });
        dirtyAuthorities.add(taskId);
      }
    }
    pendingResolutionTaskIds.clear();
    if (scanSnapshot?.complete) {
      for (const [taskId, authority] of authorities) {
        if (scanSnapshot.presentTaskIds.has(taskId)) continue;
        authorities.set(taskId, {
          ...authority,
          resolutionRequested: true,
        });
        dirtyAuthorities.add(taskId);
      }
    }
    if (scanSnapshot !== undefined) restoredAuthorityIds.clear();
    if (recorder !== undefined) {
      for (const taskId of authorities.keys()) driveAuthority(taskId);
    }
  }

  function restoreAuthorities(): void {
    const recovered = recoverBackgroundRecoveryAuthorities(
      deps.dataDir,
      deps.authorityRecoveryOps,
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
    authoritiesLoaded = true;
    for (const authority of recovered.value) {
      if (!authorities.has(authority.taskId)) {
        authorities.set(authority.taskId, authority);
        restoredAuthorityIds.add(authority.taskId);
      }
    }
    for (const { task, source } of pendingRecordTasks.values()) {
      installTaskAuthority(task, source);
    }
    pendingRecordTasks.clear();
    reconcileAuthorities();
  }

  restoreAuthorities();

  return {
    setRecorder(next: typeof recorder): void {
      recorder = next;
      if (authoritiesLoaded) {
        reconcileAuthorities();
      }
    },
    recordTask,
    resolveTask,
    reportScanFailures,
  };
}
