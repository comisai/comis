// SPDX-License-Identifier: Apache-2.0
/** Content-free sub-agent lifecycle folds used by `toIncidentSignals`. */

import { asNumber, asString } from "./obs-explain-signals-fields.js";
import type { Acc } from "./obs-explain-signals-acc.js";
import { accumulateSubAgentCompletedRecord } from "./obs-explain-signal-folds.js";

export function accumulateSubagentIncidentRecord(
  acc: Acc,
  type: string,
  data: Record<string, unknown>,
  isCurrentTurn: boolean,
): void {
  if (type === "subagent.wait_finished") {
    const childRunId = asString(data.runId);
    const parentRunId = asString(data.parentRunId);
    const status = asString(data.status);
    const requestedTimeoutMs = asNumber(data.requestedTimeoutMs);
    const effectiveTimeoutMs = asNumber(data.effectiveTimeoutMs);
    const durationMs = asNumber(data.durationMs);
    if (
      childRunId !== undefined
      && (status === "completed" || status === "timeout"
        || status === "cancelled" || status === "denied_unknown")
      && requestedTimeoutMs !== undefined
      && effectiveTimeoutMs !== undefined
      && durationMs !== undefined
    ) {
      acc.subagentWait = {
        ...(parentRunId !== undefined ? { parentRunId } : {}),
        childRunId,
        status,
        requestedTimeoutMs,
        effectiveTimeoutMs,
        durationMs,
      };
      if (status === "completed" && typeof data.success === "boolean") {
        accumulateSubAgentCompletedRecord(
          acc,
          { runId: childRunId, success: data.success },
          isCurrentTurn,
        );
      }
    }
    return;
  }
  if (type === "subagent.routed_child_preserved") {
    const parentRunId = asString(data.parentRunId);
    const childRunId = asString(data.childRunId);
    const reason = asString(data.reason);
    if (
      parentRunId !== undefined
      && childRunId !== undefined
      && reason === "announcement_route"
    ) {
      acc.routedChildPreserved = { parentRunId, childRunId, reason };
    }
    return;
  }
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
  if (
    reason !== "no_origin"
    && reason !== "no_channel_params"
    && reason !== "route_validation_failed"
  ) return;
  acc.subagentDeliverySkippedCount += 1;
  acc.subagentDeliverySkippedLastRunId = runId;
  acc.subagentDeliverySkippedLastReason = reason;
}
