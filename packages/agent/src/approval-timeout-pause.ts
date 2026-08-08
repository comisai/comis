// SPDX-License-Identifier: Apache-2.0
import type { EventMap, TypedEventBus } from "@comis/core";

export interface ApprovalPauseControl {
  pauseTimer(): void;
  resumeTimer(): void;
}

export interface ApprovalTurnIds {
  readonly agentId?: string;
  readonly sessionKey?: string;
  readonly traceId?: string;
}

/** Pause a timer only for approvals owned by the same live turn. */
export function pauseDuringCorrelatedApprovals(
  eventBus: TypedEventBus,
  control: ApprovalPauseControl,
  turnIds: ApprovalTurnIds,
): () => void {
  if (
    turnIds.agentId === undefined
    || turnIds.sessionKey === undefined
    || turnIds.traceId === undefined
  ) {
    return () => {};
  }

  const pending = new Set<string>();
  const onRequested = (request: EventMap["approval:requested"]): void => {
    if (
      request.agentId !== turnIds.agentId
      || request.sessionKey !== turnIds.sessionKey
      || request.traceId !== turnIds.traceId
    ) return;
    const wasEmpty = pending.size === 0;
    pending.add(request.requestId);
    if (wasEmpty) control.pauseTimer();
  };
  const onResolved = (resolution: EventMap["approval:resolved"]): void => {
    if (!pending.delete(resolution.requestId)) return;
    if (pending.size === 0) control.resumeTimer();
  };

  eventBus.on("approval:requested", onRequested);
  eventBus.on("approval:resolved", onResolved);
  return () => {
    eventBus.off("approval:requested", onRequested);
    eventBus.off("approval:resolved", onResolved);
  };
}
