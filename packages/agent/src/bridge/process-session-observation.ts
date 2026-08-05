// SPDX-License-Identifier: Apache-2.0
/** Content-free process-registry state extracted from trusted tool results. */

export type ProcessSessionStatus = "running" | "completed" | "failed" | "killed";

export interface ProcessSessionObservation {
  readonly processSessionId: string;
  readonly processSessionStatus: ProcessSessionStatus;
}

const PROCESS_SESSION_STATUSES = new Set<ProcessSessionStatus>([
  "running",
  "completed",
  "failed",
  "killed",
]);

function boundedSessionId(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= 256
    ? value
    : undefined;
}

/**
 * Extract the opaque process id and closed state needed to correlate an exec
 * auto-background handoff with a later process.status or process.kill call.
 */
export function extractProcessSessionObservation(params: {
  readonly toolName: string;
  readonly resultBackgrounded: boolean;
  readonly resultDetails: Record<string, unknown> | undefined;
  readonly toolArgs: Record<string, unknown> | undefined;
}): ProcessSessionObservation | undefined {
  const { toolName, resultBackgrounded, resultDetails, toolArgs } = params;
  if (resultBackgrounded) {
    const processSessionId = boundedSessionId(resultDetails?.sessionId);
    return processSessionId === undefined
      ? undefined
      : { processSessionId, processSessionStatus: "running" };
  }
  if (toolName !== "process") return undefined;

  const processSessionId = boundedSessionId(resultDetails?.sessionId)
    ?? boundedSessionId(toolArgs?.sessionId);
  if (processSessionId === undefined) return undefined;
  if (resultDetails?.killed === true) {
    return { processSessionId, processSessionStatus: "killed" };
  }
  const status = resultDetails?.status;
  return typeof status === "string" && PROCESS_SESSION_STATUSES.has(status as ProcessSessionStatus)
    ? { processSessionId, processSessionStatus: status as ProcessSessionStatus }
    : undefined;
}
