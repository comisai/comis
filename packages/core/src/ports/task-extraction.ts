// SPDX-License-Identifier: Apache-2.0
import type { Result } from "@comis/shared";
import type { BackgroundTaskOrigin } from "../domain/background-task-origin.js";
import type { ResponseLocalePolicy } from "../domain/response-locale-policy.js";
import type { WorkspacePolicySnapshot } from "../domain/workspace-policy.js";

/** Immutable, fully attributed successful interactive turn admitted for inference. */
export interface TaskExtractionTurn {
  readonly sourceExecutionId: string;
  readonly origin: BackgroundTaskOrigin;
  readonly workspacePolicySnapshot: WorkspacePolicySnapshot;
  readonly responseLocalePolicy: ResponseLocalePolicy;
  readonly capturedAtMs: number;
  readonly userText: string;
  readonly deliveredAssistantText: string;
}

export type TaskExtractionQueueError =
  | { readonly code: "invalid_turn"; readonly errorKind: "validation" }
  | { readonly code: "not_accepting"; readonly errorKind: "precondition" };

/** Bounded, non-blocking capture boundary implemented by the scheduler package. */
export interface TaskExtractionPort {
  enqueue(
    turn: TaskExtractionTurn,
  ): Result<"enqueued" | "oldest_dropped", TaskExtractionQueueError>;
}
