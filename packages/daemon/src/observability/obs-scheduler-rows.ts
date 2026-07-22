// SPDX-License-Identifier: Apache-2.0
import type { EventMap, TypedEventBus } from "@comis/core";
import type { DiagnosticRow } from "@comis/memory";

type TaskDiagnosticEventName =
  | "scheduler:task_extraction_completed"
  | "scheduler:task_extraction_failed"
  | "scheduler:task_check_started"
  | "scheduler:task_check_terminal"
  | "scheduler:task_delivery_history_failed"
  | "scheduler:task_cap_deferred"
  | "scheduler:task_store_degraded"
  | "scheduler:task_cancelled"
  | "scheduler:task_store_reset";

export function cronOwnershipReconciliationEventToRow(
  payload: EventMap["scheduler:cron_ownership_reconciliation"],
): DiagnosticRow {
  const outcome = payload.status === "completed"
    ? {
      status: payload.status,
      recoveredBeforeStart: payload.recoveredBeforeStart,
      ownerLostAfterStart: payload.ownerLostAfterStart,
      settledFromTerminal: payload.settledFromTerminal,
      retainedCurrentBoot: payload.retainedCurrentBoot,
    }
    : {
      status: payload.status,
      errorCode: payload.errorCode,
      errorKind: payload.errorKind,
    };
  return {
    timestamp: payload.timestamp,
    category: "health_signal",
    severity: payload.status === "completed" ? "info" : "warning",
    agentId: payload.agentId,
    sessionKey: "",
    message: "scheduler:cron_ownership_reconciliation",
    details: JSON.stringify({
      signal: "cron_ownership_reconciliation",
      ...outcome,
      durationMs: payload.durationMs,
    }),
    traceId: undefined,
  };
}

export function cronStoreResetEventToRow(
  payload: EventMap["scheduler:cron_store_reset"],
): DiagnosticRow {
  return {
    timestamp: payload.timestamp,
    category: "health_signal",
    severity: "info",
    agentId: payload.agentId,
    sessionKey: "",
    message: "scheduler:cron_store_reset",
    details: JSON.stringify({
      signal: "cron_store_reset",
      operationId: payload.operationId,
      target: payload.target,
      beforeDigests: payload.beforeDigests,
      afterDigests: payload.afterDigests,
      reactivated: payload.reactivated,
    }),
    traceId: undefined,
  };
}

export function cronModelDriftEventToRow(
  payload: EventMap["scheduler:cron_model_drift"],
): DiagnosticRow {
  const { agentId, timestamp, ...details } = payload;
  return {
    timestamp,
    category: "health_signal",
    severity: "info",
    agentId,
    sessionKey: "",
    message: "scheduler:cron_model_drift",
    details: JSON.stringify({ signal: "cron_model_drift", ...details }),
    traceId: undefined,
  };
}

export function taskEventToRow<K extends TaskDiagnosticEventName>(
  eventName: K,
  payload: EventMap[K],
): DiagnosticRow {
  const record = payload as EventMap[TaskDiagnosticEventName] & Record<string, unknown>;
  const {
    agentId: _agentId,
    timestamp: _timestamp,
    sessionKey: _sessionKey,
    ...details
  } = record;
  return {
    timestamp: payload.timestamp,
    category: "health_signal",
    severity: taskEventSeverity(eventName, record),
    agentId: payload.agentId,
    sessionKey: typeof record.sessionKey === "string" ? record.sessionKey : "",
    message: eventName,
    details: JSON.stringify({ signal: eventName.slice("scheduler:".length).replaceAll(":", "_"), ...details }),
    traceId: undefined,
  };
}

function taskEventSeverity(
  eventName: TaskDiagnosticEventName,
  payload: Record<string, unknown>,
): "info" | "warning" {
  if (
    eventName === "scheduler:task_extraction_failed"
    || eventName === "scheduler:task_delivery_history_failed"
    || eventName === "scheduler:task_store_degraded"
  ) return "warning";
  if (eventName === "scheduler:task_check_terminal") {
    return payload.outcome === "delivery_unknown" || payload.outcome === "failed" ? "warning" : "info";
  }
  return "info";
}

export function wireSchedulerDiagnostics(input: {
  eventBus: TypedEventBus;
  diagnosticBuffer: { push(row: DiagnosticRow): void };
}): void {
  input.eventBus.on("scheduler:cron_ownership_reconciliation", (payload) => {
    input.diagnosticBuffer.push(cronOwnershipReconciliationEventToRow(payload));
  });
  input.eventBus.on("scheduler:cron_store_reset", (payload) => {
    input.diagnosticBuffer.push(cronStoreResetEventToRow(payload));
  });
  input.eventBus.on("scheduler:cron_model_drift", (payload) => {
    input.diagnosticBuffer.push(cronModelDriftEventToRow(payload));
  });
  input.eventBus.on("scheduler:task_extraction_completed", (payload) => {
    input.diagnosticBuffer.push(taskEventToRow("scheduler:task_extraction_completed", payload));
  });
  input.eventBus.on("scheduler:task_extraction_failed", (payload) => {
    input.diagnosticBuffer.push(taskEventToRow("scheduler:task_extraction_failed", payload));
  });
  input.eventBus.on("scheduler:task_check_started", (payload) => {
    input.diagnosticBuffer.push(taskEventToRow("scheduler:task_check_started", payload));
  });
  input.eventBus.on("scheduler:task_check_terminal", (payload) => {
    input.diagnosticBuffer.push(taskEventToRow("scheduler:task_check_terminal", payload));
  });
  input.eventBus.on("scheduler:task_delivery_history_failed", (payload) => {
    input.diagnosticBuffer.push(taskEventToRow("scheduler:task_delivery_history_failed", payload));
  });
  input.eventBus.on("scheduler:task_cap_deferred", (payload) => {
    input.diagnosticBuffer.push(taskEventToRow("scheduler:task_cap_deferred", payload));
  });
  input.eventBus.on("scheduler:task_store_degraded", (payload) => {
    input.diagnosticBuffer.push(taskEventToRow("scheduler:task_store_degraded", payload));
  });
  input.eventBus.on("scheduler:task_cancelled", (payload) => {
    input.diagnosticBuffer.push(taskEventToRow("scheduler:task_cancelled", payload));
  });
  input.eventBus.on("scheduler:task_store_reset", (payload) => {
    input.diagnosticBuffer.push(taskEventToRow("scheduler:task_store_reset", payload));
  });
}
