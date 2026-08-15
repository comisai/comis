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

const DELIVERY_MESSAGE_ID_CAP = 100;
const OUTWARD_DELIVERY_PART_CAP = 100;

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
    ...(acc.deliveryMessageIds.length > 0
      ? { messageIds: [...acc.deliveryMessageIds] }
      : {}),
  };
  acc.deliveryDispatch = signal;
  acc.deliveryMessageIds.length = 0;
}

/** Fold one platform reply binding, preserving first-seen delivery order. */
export function accumulateDeliveryReplyBound(
  acc: Acc,
  data: Record<string, unknown>,
): void {
  const messageId = typeof data.messageId === "string" ? data.messageId : undefined;
  if (
    messageId === undefined ||
    acc.deliveryMessageIds.includes(messageId) ||
    acc.deliveryMessageIds.length >= DELIVERY_MESSAGE_ID_CAP
  ) return;
  acc.deliveryMessageIds.push(messageId);
}

/** Fold one valid durable completion-delivery transition. */
export function accumulateOutwardDelivery(
  acc: Acc,
  data: Record<string, unknown>,
): void {
  const outcome = data.outcome;
  const transition = data.transition;
  const rootRunId = data.rootRunId;
  const stepIndex = data.stepIndex;
  const hasStepIndex = Number.isSafeInteger(stepIndex) && (stepIndex as number) >= 0;
  if (
    (outcome !== "prepared"
      && outcome !== "blocked"
      && outcome !== "in_flight"
      && outcome !== "committed"
      && outcome !== "failed"
      && outcome !== "parked")
    || (transition !== "prepare"
      && transition !== "lookup"
      && transition !== "begin"
      && transition !== "mark_unknown"
      && transition !== "commit"
      && transition !== "mark_failed"
      && transition !== "park")
    || typeof rootRunId !== "string"
    || (transition !== "prepare" && !hasStepIndex)
  ) return;
  const deliveryKind = data.deliveryKind;
  const runId = typeof data.runId === "string" ? data.runId : undefined;
  const rawPartId = typeof data.partId === "string" && data.partId.length > 0
    ? data.partId
    : hasStepIndex ? String(stepIndex) : "prepare";
  if (
    transition === "prepare"
    && outcome === "prepared"
    && deliveryKind === "attachment"
    && runId !== undefined
  ) {
    const preparedKey = runId + ":" + rawPartId;
    const node = acc.spawnNodesByLease.get(runId);
    if (node?.outputValidation !== undefined && !acc.preparedAttachmentParts.has(preparedKey)) {
      acc.preparedAttachmentParts.add(preparedKey);
      node.outputValidation.attachmentsPrepared = Math.min(
        node.outputValidation.verified,
        node.outputValidation.attachmentsPrepared + 1,
      );
    }
  }
  const partId = `${rootRunId}:${
    typeof data.partId === "string" && data.partId.length > 0
      ? data.partId
      : hasStepIndex ? String(stepIndex) : "prepare"
  }`;
  if (
    !acc.outwardDeliveryParts.has(partId)
    && acc.outwardDeliveryParts.size >= OUTWARD_DELIVERY_PART_CAP
  ) return;
  const signal = {
    status: outcome,
    rootRunId,
    transition,
    ...(hasStepIndex ? { stepIndex: stepIndex as number } : {}),
    ...(deliveryKind === "text" || deliveryKind === "attachment"
      ? { deliveryKind }
      : {}),
    ...(typeof data.platformMessageId === "string"
      ? { platformMessageId: data.platformMessageId }
      : {}),
  } satisfies NonNullable<IncidentSignals["outwardDeliveries"]>[number];
  acc.outwardDeliveryParts.set(partId, signal);

  const rootParts = [...acc.outwardDeliveryParts.values()]
    .filter((part) => part.rootRunId === rootRunId);
  const committed = rootParts.filter((part) => part.status === "committed");
  const terminalFailures = rootParts.filter(
    (part) => part.status === "failed" || part.status === "blocked" || part.status === "parked",
  );
  if (committed.length > 0 && terminalFailures.length > 0) {
    const receipt = committed.at(-1)!;
    acc.outwardDeliveriesByRoot.set(rootRunId, {
      status: "partial",
      rootRunId,
      transition,
      ...(receipt.stepIndex === undefined ? {} : { stepIndex: receipt.stepIndex }),
      ...(receipt.deliveryKind === undefined
        ? {}
        : { deliveryKind: receipt.deliveryKind }),
      ...(receipt.platformMessageId === undefined
        ? {}
        : { platformMessageId: receipt.platformMessageId }),
    });
    return;
  }
  if (terminalFailures.length > 0) {
    acc.outwardDeliveriesByRoot.set(rootRunId, terminalFailures.at(-1)!);
    return;
  }
  acc.outwardDeliveriesByRoot.set(rootRunId, signal);
}
