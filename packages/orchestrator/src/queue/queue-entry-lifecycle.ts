// SPDX-License-Identifier: Apache-2.0
import { AsyncResource } from "node:async_hooks";
import {
  formatSessionKey,
  sanitizeLogString,
  type ComisLogger,
  type RequestContext,
  type SessionKey,
} from "@comis/core";
import { tryCatch } from "@comis/shared";
import { coalesceMessages } from "./coalescer.js";
import type {
  QueueAsyncScope,
  QueuedMessageEntry,
} from "./lane.js";
import { mergeSourceTerminalScopes } from "../source-message-terminal.js";

export type QueueDiscardReason = "coalesced" | "overflow" | "shutdown";

/** Build a collision-safe lane key from the immutable enqueue principal. */
export function createQueueLaneIdentity(
  sessionKey: SessionKey,
  channelType: string,
  context: RequestContext | undefined,
): { baseSessionKey: string; laneKey: string } {
  const baseSessionKey = formatSessionKey(sessionKey);
  const origin = context?.deliveryOrigin;
  const fallbackAgentId = context === undefined ? sessionKey.agentId : undefined;
  return {
    baseSessionKey,
    laneKey: JSON.stringify([
      baseSessionKey,
      channelType,
      context?.tenantId ?? null,
      context?.userId ?? null,
      context?.sessionKey ?? null,
      context?.agentId ?? fallbackAgentId ?? null,
      context?.trustLevel ?? null,
      context?.clientId ?? null,
      origin === undefined
        ? null
        : [
            origin.tenantId,
            origin.channelType,
            origin.channelId,
            origin.userId,
            origin.threadId ?? null,
          ],
    ]),
  };
}

/** Capture the enqueue-time async context for later execution and cleanup. */
export function captureQueueAsyncScope(): QueueAsyncScope {
  return AsyncResource.bind(
    <T>(task: () => T): T => task(),
    "CommandQueueEntry",
  );
}

/** Merge queued messages while releasing resources owned by superseded entries. */
export function coalesceQueuedEntries(
  entries: QueuedMessageEntry[],
  releaseEntry: (entry: QueuedMessageEntry, reason: QueueDiscardReason) => void,
): QueuedMessageEntry {
  const lastEntry = entries[entries.length - 1]!;
  for (const entry of entries.slice(0, -1)) releaseEntry(entry, "coalesced");
  return {
    ...lastEntry,
    message: coalesceMessages(entries.map((entry) => entry.message)),
    inboundProvenancePlans: entries.flatMap((entry) => entry.inboundProvenancePlans),
    enqueuedAt: Math.min(...entries.map((entry) => entry.enqueuedAt)),
    receivedAt: Math.min(...entries.map((entry) => entry.receivedAt)),
    logicalCount: entries.reduce((count, entry) => count + entry.logicalCount, 0),
    sourceTerminalScope: mergeSourceTerminalScopes(
      entries.map((entry) => entry.sourceTerminalScope),
    ),
  };
}

/** Release a queue entry's transferred resources at most once. */
export function releaseQueueEntryResources(
  entry: QueuedMessageEntry,
  reason: QueueDiscardReason,
  logger?: ComisLogger,
): void {
  if (
    entry.ownership.resourcesReleased
    || (entry.ownership.executionStarted && reason !== "shutdown")
  ) return;
  entry.ownership.resourcesReleased = true;
  const releaseResources = entry.ownership.releaseResources;
  if (releaseResources === undefined) return;
  const discarded = tryCatch(() => entry.runInAsyncScope(releaseResources));
  if (discarded.ok || !logger) return;
  void tryCatch(() => logger.warn({
    step: "queue-discard",
    channelType: entry.channelType,
    reason,
    err: sanitizeLogString(discarded.error.message.slice(0, 1_500)),
    errorKind: "internal" as const,
    hint: "Fix the queue entry discard callback; terminal publication and later queue cleanup continued.",
  }, "Command queue entry discard cleanup failed"));
}
