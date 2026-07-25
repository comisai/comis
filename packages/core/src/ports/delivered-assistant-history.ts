// SPDX-License-Identifier: Apache-2.0
import type { Result } from "@comis/shared";
import type { ConversationLocator } from "../domain/conversation-scope.js";

/** Exact platform-accepted assistant text to make available to the next turn. */
export interface DeliveredAssistantHistoryInput {
  readonly conversation: ConversationLocator;
  readonly deliveredText: string;
  readonly sourceExecutionId: string;
  readonly attemptId: string;
  readonly lastPlatformMessageId?: string;
  readonly deliveredAtMs: number;
}

/** Closed failure contract for the locked delivered-history adapter. */
export type DeliveredAssistantHistoryError =
  | { readonly code: "invalid_input"; readonly errorKind: "validation" }
  | { readonly code: "invalid_conversation"; readonly errorKind: "validation" }
  | { readonly code: "conflict"; readonly errorKind: "precondition" }
  | { readonly code: "not_accepting"; readonly errorKind: "precondition" }
  | { readonly code: "session_locked"; readonly errorKind: "resource" }
  | { readonly code: "append_failed"; readonly errorKind: "resource" };

/** Appends idempotent delivery evidence while holding the canonical SDK session lock. */
export interface DeliveredAssistantHistoryPort {
  append(
    input: DeliveredAssistantHistoryInput,
  ): Promise<Result<"appended" | "already_present", DeliveredAssistantHistoryError>>;
}
