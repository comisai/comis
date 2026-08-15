// SPDX-License-Identifier: Apache-2.0
import type { ToolExecutionResultRecord } from "../../bridge/tool-failure-recovery.js";

export function hasAcceptedDelegation(
  records: readonly Pick<ToolExecutionResultRecord, "toolName" | "success">[] | undefined,
): boolean {
  return records?.some(
    (record) => record.toolName === "sessions_spawn" && record.success,
  ) ?? false;
}

const SINGLE_BACKGROUND_HANDOFF_PATTERNS = [
  /\b(?:start|run|launch)\b[^.\n]{0,120}\b(?:one|a|an)\s+(?:durable\s+)?background\s+(?:task|job|run|research|review|work)\b/iu,
  /\b(?:task|job|run|research|review|work)\b[^.\n]{0,100}\bin the background\b/iu,
] as const;

const PUSH_COMPLETION_PATTERNS = [
  /\b(?:without\s+(?:me\s+|us\s+)?polling|do not poll|don't poll|no polling)\b/iu,
  /\b(?:acknowledge|ack)\b[^.\n]{0,100}\bnow\b/iu,
  /\b(?:send|deliver|post|return)\b[^.\n]{0,120}\b(?:when|once|after)\b[^.\n]{0,80}\b(?:complete|completed|finish|finished|done|settled)\b/iu,
] as const;

/** Whether one accepted child owns a requested push-delivered background result. */
export function requestsPushDeliveredBackgroundCompletion(requestText: string): boolean {
  return SINGLE_BACKGROUND_HANDOFF_PATTERNS.some((pattern) => pattern.test(requestText))
    && PUSH_COMPLETION_PATTERNS.some((pattern) => pattern.test(requestText));
}
