// SPDX-License-Identifier: Apache-2.0
/** Join cross-turn terminal evidence back to the trace that promoted each background task. */

const FOLLOWUP_TYPES: ReadonlySet<string> = new Set([
  "background_task.completed",
  "background_task.failed",
  "background_task.cancelled",
  "background_task.reentered",
  "background_task.notified",
]);

function taskIdOf(record: Record<string, unknown>): string | undefined {
  if (record.data === null || typeof record.data !== "object" || Array.isArray(record.data)) {
    return undefined;
  }
  const taskId = (record.data as Record<string, unknown>).taskId;
  return typeof taskId === "string" && taskId.length > 0 ? taskId : undefined;
}

/**
 * Add only lifecycle rows whose stable task id was promoted by the selected
 * execution. This keeps per-trace model/tool evidence isolated while letting a
 * later user cancellation or completion re-entry close its origin task.
 */
export function joinBackgroundTaskFollowups(
  allRecords: ReadonlyArray<Record<string, unknown>>,
  executionRecords: ReadonlyArray<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  const taskIds = new Set(
    executionRecords
      .filter((record) => record.type === "background_task.promoted")
      .map(taskIdOf)
      .filter((taskId): taskId is string => taskId !== undefined),
  );
  if (taskIds.size === 0) return [...executionRecords];
  const selected = new Set(executionRecords);
  return allRecords.filter((record) =>
    selected.has(record)
    || (
      typeof record.type === "string"
      && FOLLOWUP_TYPES.has(record.type)
      && taskIds.has(taskIdOf(record) ?? "")
    ));
}

export function recordHasTraceId(record: Record<string, unknown>, traceId: string): boolean {
  return record.traceId === traceId;
}

/** Collect the durable root identities spawned by one selected execution. */
export function spawnedRootRunIds(
  records: ReadonlyArray<Record<string, unknown>>,
): string[] {
  const roots = records.flatMap((record) => {
    if (record.type !== "subagent.spawned") return [];
    const data = record.data;
    if (typeof data !== "object" || data === null || Array.isArray(data)) return [];
    const rootRunId = (data as Record<string, unknown>).rootRunId;
    return typeof rootRunId === "string" && rootRunId.length > 0 ? [rootRunId] : [];
  });
  return [...new Set(roots)];
}

/** Select one prompt-anchored execution and its later background settlement rows. */
export function recordsForExecution(
  records: ReadonlyArray<Record<string, unknown>>,
  traceId: string,
): Array<Record<string, unknown>> {
  const start = records.findIndex(
    (record) => record.type === "prompt.submitted" && recordHasTraceId(record, traceId),
  );
  if (start < 0) {
    return joinBackgroundTaskFollowups(
      records,
      records.filter((record) => recordHasTraceId(record, traceId)),
    );
  }
  const relativeEnd = records.slice(start + 1).findIndex(
    (record) => record.type === "prompt.submitted",
  );
  const end = relativeEnd < 0 ? records.length : start + 1 + relativeEnd;
  const preparationRecords = records
    .slice(0, start)
    .filter((record) => recordHasTraceId(record, traceId));
  const settlementRecords = records
    .slice(end)
    .filter((record) => recordHasTraceId(record, traceId));
  return joinBackgroundTaskFollowups(
    records,
    [...preparationRecords, ...records.slice(start, end), ...settlementRecords],
  );
}

/** Return the trace identity of the most recently submitted prompt. */
export function latestPromptTraceId(
  records: ReadonlyArray<Record<string, unknown>>,
): string | undefined {
  const latestPrompt = [...records].reverse().find(
    (record) =>
      record.type === "prompt.submitted"
      && typeof record.traceId === "string"
      && record.traceId.length > 0,
  );
  return typeof latestPrompt?.traceId === "string"
    ? latestPrompt.traceId
    : undefined;
}
