// SPDX-License-Identifier: Apache-2.0
import type { BackgroundTask } from "../background/background-task-types.js";

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
 * tool promoted by that same request is still running. The persisted task
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
    (task) => task.status === "running" && task.origin.traceId === input.executionId,
  );
  if (pending.length === 0) {
    return { response: input.response, finishReason: undefined, pendingCount: 0 };
  }
  const labels = pending.map((task) => `${task.toolName} (${task.id})`).join(", ");
  return {
    response: `⏳ Background work is still running: ${labels}. I will continue this conversation when it finishes.`,
    finishReason: "background_pending",
    pendingCount: pending.length,
  };
}
