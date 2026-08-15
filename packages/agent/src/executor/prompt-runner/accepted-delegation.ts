// SPDX-License-Identifier: Apache-2.0
import type { ToolExecutionResultRecord } from "../../bridge/tool-failure-recovery.js";

export function hasAcceptedDelegation(
  records: readonly Pick<ToolExecutionResultRecord, "toolName" | "success">[] | undefined,
): boolean {
  return records?.some(
    (record) => record.toolName === "sessions_spawn" && record.success,
  ) ?? false;
}
