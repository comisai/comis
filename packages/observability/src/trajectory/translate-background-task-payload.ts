// SPDX-License-Identifier: Apache-2.0
/** Content-free trajectory projections for the background-task lifecycle. */

export type BackgroundTaskTrajectoryEventName =
  | "background_task:promoted"
  | "background_task:completed"
  | "background_task:failed"
  | "background_task:cancelled"
  | "background_task:reentered"
  | "background_task:notified";

function translateFailureDiagnostic(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return {};
  const diagnostic = value as Record<string, unknown>;
  if (
    diagnostic.kind !== "mcp_call_deadline_exceeded"
    || diagnostic.configKey !== "integrations.mcp.callToolTimeoutMs"
    || typeof diagnostic.configuredMs !== "number"
    || !Number.isFinite(diagnostic.configuredMs)
    || diagnostic.configuredMs < 0
    || typeof diagnostic.queueWaitedMs !== "number"
    || !Number.isFinite(diagnostic.queueWaitedMs)
    || diagnostic.queueWaitedMs < 0
    || typeof diagnostic.requestBudgetMs !== "number"
    || !Number.isFinite(diagnostic.requestBudgetMs)
    || diagnostic.requestBudgetMs < 0
  ) return {};
  return {
    failureConfigKey: diagnostic.configKey,
    failureConfiguredMs: diagnostic.configuredMs,
    failureQueueWaitedMs: diagnostic.queueWaitedMs,
    failureRequestBudgetMs: diagnostic.requestBudgetMs,
  };
}

export function translateBackgroundTaskPayload(
  eventName: BackgroundTaskTrajectoryEventName,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  switch (eventName) {
    case "background_task:promoted":
      return { taskId: payload.taskId, toolName: payload.toolName };
    case "background_task:completed":
      return {
        taskId: payload.taskId,
        toolName: payload.toolName,
        durationMs: payload.durationMs,
        ...(payload.resultOutcome === "success" || payload.resultOutcome === "degraded"
          ? { resultOutcome: payload.resultOutcome }
          : {}),
        ...(payload.persistence === "persisted"
          || payload.persistence === "runtime_only"
          || payload.persistence === "skipped"
          ? { persistence: payload.persistence }
          : {}),
        ...(payload.errorKind === "config" ? { errorKind: payload.errorKind } : {}),
        ...(payload.failureCode === "mutation_not_persisted"
          ? { failureCode: payload.failureCode }
          : {}),
      };
    case "background_task:failed":
      return {
        taskId: payload.taskId,
        toolName: payload.toolName,
        durationMs: payload.durationMs,
        errorKind: payload.errorKind,
        ...(payload.failureCode === "skill_import_incomplete"
          || payload.failureCode === "mcp_connection_details_missing"
          || payload.failureCode === "mcp_secret_reference_missing"
          || payload.failureCode === "mcp_call_deadline_exceeded"
          ? { failureCode: payload.failureCode }
          : {}),
        ...translateFailureDiagnostic(payload.failureDiagnostic),
      };
    case "background_task:cancelled":
      return { taskId: payload.taskId, toolName: payload.toolName };
    case "background_task:reentered":
      return { taskId: payload.taskId, hopCount: payload.hopCount };
    case "background_task:notified":
      return {
        taskId: payload.taskId,
        toolName: payload.toolName,
        notified: payload.notified,
        reason: payload.reason,
      };
    default: {
      const _exhaustive: never = eventName;
      return _exhaustive;
    }
  }
}
