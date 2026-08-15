// SPDX-License-Identifier: Apache-2.0
/** Content-free direct-child completion evidence for `obs.explain`. */
import type { Acc } from "./obs-explain-signals-acc.js";
import { asNumber, asString } from "./obs-explain-signals-fields.js";

/** Fold one parent-routed child terminal record into topology and acute counts. */
export function accumulateSubAgentCompletedRecord(
  acc: Acc,
  data: Record<string, unknown>,
  countForCurrentTurn: boolean,
): void {
  const runId = asString(data.runId);
  if (runId === undefined) return;
  const success = data.success === true;
  if (countForCurrentTurn && !acc.subagentCompletedRunIds.has(runId)) {
    acc.subagentCompletedRunIds.add(runId);
    acc.subagentCompletedCount += 1;
    if (!success) {
      acc.subagentFailedCount += 1;
      acc.subagentLastFailedRunId = runId;
    }
  }
  const node = acc.spawnNodesByLease.get(runId);
  if (node === undefined) return;
  node.terminalOutcome = success ? "completed" : "failed";
  const runtimeMs = asNumber(data.runtimeMs);
  const tokensUsed = asNumber(data.tokensUsed);
  const costUsd = asNumber(data.costUsd);
  if (runtimeMs !== undefined) node.runtimeMs = Math.max(0, runtimeMs);
  if (tokensUsed !== undefined) node.tokensUsed = Math.max(0, tokensUsed);
  if (costUsd !== undefined) node.costUsd = Math.max(0, costUsd);
  const expected = asNumber(data.expectedOutputs);
  const verified = asNumber(data.verifiedOutputs);
  const attachmentsPrepared = asNumber(data.attachmentsPrepared);
  if (
    expected !== undefined && verified !== undefined && attachmentsPrepared !== undefined
    && Number.isSafeInteger(expected) && Number.isSafeInteger(verified)
    && Number.isSafeInteger(attachmentsPrepared)
  ) {
    node.outputValidation = {
      expected: Math.max(0, expected),
      verified: Math.max(0, verified),
      attachmentsPrepared: Math.max(0, attachmentsPrepared),
    };
  }
}
