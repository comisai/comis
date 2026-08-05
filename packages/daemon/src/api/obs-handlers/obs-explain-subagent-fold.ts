// SPDX-License-Identifier: Apache-2.0
/** Content-free sub-agent lifecycle folds used by `toIncidentSignals`. */

import { asNumber, asString } from "./obs-explain-signals-fields.js";
import type { Acc } from "./obs-explain-signals-acc.js";

export function accumulateSubagentIncidentRecord(
  acc: Acc,
  type: string,
  data: Record<string, unknown>,
  isCurrentTurn: boolean,
): void {
  if (type === "subagent.killed") {
    const killedBy = asString(data.killedBy);
    if (killedBy === undefined) return;
    acc.subagentKilledBy = killedBy;
    acc.subagentKilledRuntimeMs = asNumber(data.runtimeMs);
    acc.subagentKilledIdleMs = asNumber(data.idleMs);
    acc.subagentKilledThresholdMs = asNumber(data.thresholdMs);
    return;
  }
  if (!isCurrentTurn) return;
  const runId = asString(data.runId);
  if (runId === undefined) return;
  if (type === "subagent.background_processes_abandoned") {
    const count = asNumber(data.count);
    if (count === undefined || count <= 0) return;
    acc.subagentBackgroundProcessesAbandonedCount += count;
    acc.subagentBackgroundProcessesAbandonedLastRunId = runId;
    return;
  }
  if (type !== "subagent.delivery_skipped") return;
  const reason = asString(data.reason);
  if (reason !== "no_origin" && reason !== "no_channel_params") return;
  acc.subagentDeliverySkippedCount += 1;
  acc.subagentDeliverySkippedLastRunId = runId;
  acc.subagentDeliverySkippedLastReason = reason;
}
