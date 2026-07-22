// SPDX-License-Identifier: Apache-2.0
/** Content-free trajectory projection for inferred follow-up task events. */

export type TaskTrajectoryEventName =
  | "scheduler:task_extraction_completed"
  | "scheduler:task_extraction_failed"
  | "scheduler:task_check_started"
  | "scheduler:task_check_terminal"
  | "scheduler:task_delivery_history_failed"
  | "scheduler:task_cap_deferred"
  | "scheduler:task_store_degraded"
  | "scheduler:task_cancelled"
  | "scheduler:task_store_reset";

export function translateTaskPayload(
  eventName: TaskTrajectoryEventName,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  switch (eventName) {
    case "scheduler:task_extraction_completed":
      return pick(payload, [
        "rootRunId", "itemCount", "candidateCount", "createdCount", "mergedCount",
        "sourceExecutionIds", "taskIds", "releaseErrorKind", "durationMs",
      ]);
    case "scheduler:task_extraction_failed":
      return pick(payload, [
        "rootRunId", "itemCount", "sourceExecutionIds", "stage", "errorKind",
        "releaseErrorKind", "durationMs",
      ]);
    case "scheduler:task_check_started":
      return pick(payload, [
        "attemptId", "rootRunId", "correlationId", "taskIds", "sourceExecutionIds",
        "originTraceIds", "durationMs",
      ]);
    case "scheduler:task_check_terminal":
      return pick(payload, [
        "attemptId", "rootRunId", "correlationId", "taskIds", "sourceExecutionIds",
        "originTraceIds", "outcome", "recovery", "errorKind", "deliveredChunks",
        "failedChunks", "ambiguousChunks", "durationMs",
      ]);
    case "scheduler:task_delivery_history_failed":
      return pick(payload, ["attemptId", "rootRunId", "taskIds", "errorKind", "durationMs"]);
    case "scheduler:task_cap_deferred":
      return pick(payload, [
        "rootRunId", "correlationId", "deferredTaskCount", "expiredTaskCount", "durationMs",
      ]);
    case "scheduler:task_store_degraded":
      return pick(payload, [
        "operation", "errorCode", "errorKind", "rootRunId", "attemptId", "durationMs",
      ]);
    case "scheduler:task_cancelled":
      return pick(payload, ["taskIds", "activeTaskCount", "durationMs"]);
    case "scheduler:task_store_reset":
      return pick(payload, ["operationId", "beforeDigest", "afterDigest", "durationMs"]);
    default: {
      const _exhaustive: never = eventName;
      return _exhaustive;
    }
  }
}

function pick(
  payload: Record<string, unknown>,
  keys: readonly string[],
): Record<string, unknown> {
  return Object.fromEntries(keys.flatMap((key) => {
    const value = Reflect.get(payload, key) as unknown;
    return value === undefined ? [] : [[key, value]];
  }));
}
