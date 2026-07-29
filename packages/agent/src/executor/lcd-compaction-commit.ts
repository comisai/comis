// SPDX-License-Identifier: Apache-2.0
/**
 * Short LCD compaction commit critical sections.
 *
 * Slow summarization happens outside the live-ingest serializer. These helpers
 * reacquire that serializer only for the synchronous range-replace and verify
 * that the selected refs still occupy the expected ordinal window first.
 */

import type {
  AppendCondensedSummaryInput,
  AppendSummaryInput,
  ContextStorePort,
  ContextStoreScope,
  ComisLogger,
  LcdRefKind,
  TypedEventBus,
} from "@comis/core";

function windowMatches(
  store: ContextStorePort,
  scope: ContextStoreScope,
  startOrdinal: number,
  endOrdinal: number,
  refKind: LcdRefKind,
  expectedRefIds: string[],
): boolean {
  const current = store.getContextItems(scope)
    .filter((item) => item.ordinal >= startOrdinal && item.ordinal <= endOrdinal);
  if (current.length !== expectedRefIds.length) return false;
  return current.every((item, index) =>
    item.ordinal === startOrdinal + index
    && item.refKind === refKind
    && item.refId === expectedRefIds.at(index)
  );
}

export async function commitLeafSummaryIfCurrent(
  store: ContextStorePort,
  scope: ContextStoreScope,
  expectedMessageIds: string[],
  input: AppendSummaryInput,
): Promise<boolean> {
  return store.runOnConversation(scope.conversationRef, () => {
    if (!windowMatches(
      store,
      scope,
      input.startOrdinal,
      input.endOrdinal,
      "message",
      expectedMessageIds,
    )) return false;
    store.appendLeafSummary(input);
    return true;
  });
}

export async function commitCondensedSummaryIfCurrent(
  store: ContextStorePort,
  scope: ContextStoreScope,
  expectedSummaryIds: string[],
  input: AppendCondensedSummaryInput,
): Promise<string | undefined> {
  return store.runOnConversation(scope.conversationRef, () => {
    if (!windowMatches(
      store,
      scope,
      input.startOrdinal,
      input.endOrdinal,
      "summary",
      expectedSummaryIds,
    )) return undefined;
    return store.appendCondensedSummary(input);
  });
}

export function reportStaleCompactionCommit(args: {
  kind: "leaf" | "condense";
  scope: ContextStoreScope;
  durationMs: number;
  timestamp: number;
  logger: ComisLogger;
  eventBus?: TypedEventBus;
}): void {
  const { kind, scope, durationMs, timestamp, logger, eventBus } = args;
  let reason: "leaf_window_divergence" | "condense_window_divergence";
  let message: string;
  switch (kind) {
    case "leaf":
      reason = "leaf_window_divergence";
      message = "LCD leaf pass skipped: stale selection";
      break;
    case "condense":
      reason = "condense_window_divergence";
      message = "LCD condense pass skipped: stale selection";
      break;
    default: {
      const _exhaustive: never = kind;
      return _exhaustive;
    }
  }
  logger.warn(
    {
      conversationRef: scope.conversationRef,
      agentId: scope.agentId,
      sessionKey: scope.sessionKey,
      hint: `${kind} selection changed before the compaction commit; the stale summary was discarded to preserve context ordering`,
      errorKind: "precondition" as const,
    },
    message,
  );
  eventBus?.emit("context:dag_degraded", {
    conversationId: scope.conversationRef,
    agentId: scope.agentId,
    sessionKey: scope.sessionKey,
    reason,
    durationMs,
    timestamp,
  });
}
