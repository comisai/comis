// SPDX-License-Identifier: Apache-2.0
/**
 * Content-free delivery-dispatch fold for `obs.explain`.
 *
 * A model execution can complete before its final channel send settles. The
 * dispatch record is therefore terminal user-delivery truth and must remain
 * distinct from the earlier execution summary.
 */
import type { IncidentSignals } from "@comis/core";
import type { Acc } from "./obs-explain-signals-acc.js";

function count(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : 0;
}

/** Fold one valid dispatch outcome, last record wins. */
export function accumulateDeliveryDispatch(
  acc: Acc,
  data: Record<string, unknown>,
): void {
  const status = data.status;
  if (status !== "success" && status !== "partial" && status !== "failure") return;
  const signal: NonNullable<IncidentSignals["deliveryDispatch"]> = {
    status,
    channelType: typeof data.channelType === "string" ? data.channelType : "unknown",
    totalChunks: count(data.totalChunks),
    deliveredChunks: count(data.deliveredChunks),
    failedChunks: count(data.failedChunks),
    ...(typeof data.errorKind === "string" ? { errorKind: data.errorKind } : {}),
  };
  acc.deliveryDispatch = signal;
}
