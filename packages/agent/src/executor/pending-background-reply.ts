// SPDX-License-Identifier: Apache-2.0
import {
  isClosedBackgroundTask,
  type BackgroundTask,
} from "../background/background-task-types.js";
import { backgroundToolLabel } from "../background/background-tool-label.js";

export interface PendingBackgroundTurnInput {
  response: string;
  executionId: string | undefined;
  tasks: ReadonlyArray<BackgroundTask>;
}

export interface PendingBackgroundTurnResult {
  response: string;
  finishReason: "background_pending" | undefined;
  pendingCount: number;
}

/**
 * Prevent a foreground turn from presenting unrelated terminal text while a
 * tool promoted by that same request still owns an undelivered continuation.
 * This includes the race where the tool finishes before the originating turn
 * settles: completion delivery waits for that turn to end, so painting the
 * origin as successful would precede the actual result. The persisted task
 * origin provides the ownership boundary; tasks from other requests do not
 * affect this turn.
 */
export function reconcilePendingBackgroundTurn(
  input: PendingBackgroundTurnInput,
): PendingBackgroundTurnResult {
  if (input.executionId === undefined) {
    return { response: input.response, finishReason: undefined, pendingCount: 0 };
  }
  const pending = input.tasks.filter(
    (task) => (
      task.origin.traceId === input.executionId
      && !isClosedBackgroundTask(task)
    ),
  );
  if (pending.length === 0) {
    return { response: input.response, finishReason: undefined, pendingCount: 0 };
  }
  const labels = pending
    .map((task) => `${backgroundToolLabel(task.toolName)} (${task.id})`)
    .join(", ");
  const runningCount = pending.filter((task) => task.status === "running").length;
  const response = runningCount === pending.length
    ? `⏳ Background work is still running: ${labels}. I will continue this conversation when it finishes.`
    : runningCount === 0
      ? `⏳ A background result is ready: ${labels}. I will continue this conversation with it.`
      : `⏳ Background work has updates pending: ${labels}. I will continue this conversation as they are ready.`;
  return {
    response,
    finishReason: "background_pending",
    pendingCount: pending.length,
  };
}
