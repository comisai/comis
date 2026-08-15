// SPDX-License-Identifier: Apache-2.0
import type { ToolExecutionResultRecord } from "../../bridge/tool-failure-recovery.js";

export function hasAcceptedDelegation(
  records: readonly Pick<ToolExecutionResultRecord, "toolName" | "success">[] | undefined,
): boolean {
  return records?.some(
    (record) => record.toolName === "sessions_spawn" && record.success,
  ) ?? false;
}

export function delegationOwnsPromptSkillWorkflow(
  records: readonly Pick<
    ToolExecutionResultRecord,
    "toolName" | "success" | "delegatedToolNames" | "delegationScope"
  >[] | undefined,
  workflowToolNames: readonly string[] | undefined,
): boolean {
  if (workflowToolNames === undefined || workflowToolNames.length === 0) return false;
  return records?.some((record) => {
    if (
      record.toolName !== "sessions_spawn"
      || !record.success
      || record.delegationScope !== "whole_request"
      || record.delegatedToolNames === undefined
    ) return false;
    const delegated = new Set(record.delegatedToolNames);
    return workflowToolNames.every((toolName) => delegated.has(toolName));
  }) ?? false;
}
