// SPDX-License-Identifier: Apache-2.0
/**
 * Overflow Policy: Prevents unbounded queue growth per session.
 *
 * When pending messages exceed the configured maxDepth, one of three
 * policies is applied:
 * - `drop-old`: Remove oldest messages until within limit
 * - `drop-new`: Reject the newest message (caller should not push)
 * - `summarize`: Concatenate all messages into one synthetic message
 *
 * Emits `queue:overflow` event for observability.
 *
 * @module
 */

import type {
  NormalizedMessage,
  OverflowConfig,
  TypedEventBus,
  SessionKey,
} from "@comis/core";
import { getOriginalInboundMessages, systemNowMs } from "@comis/core";
import { fromPromise, tryCatch } from "@comis/shared";
import type { QueuedMessageEntry } from "./lane.js";
import { mergeSourceTerminalScopes } from "../source-message-terminal.js";

/**
 * Result of applying an overflow policy to pending messages.
 */
export interface OverflowResult {
  /** Number of messages dropped or consolidated */
  dropped: number;
  /** The resulting messages after policy application */
  messages: NormalizedMessage[];
}

export interface QueueEntryOverflowResult {
  /** Number of queued messages dropped or consolidated. */
  dropped: number;
  /** Atomic queue entries retained after applying the policy. */
  entries: QueuedMessageEntry[];
}

interface InternalOverflowResult<T> {
  dropped: number;
  items: T[];
}

type OverflowEventErrorHandler = (error: Error) => void;

function summarizeMessages(messages: NormalizedMessage[]): NormalizedMessage {
  const lastMsg = messages[messages.length - 1]!;
  const concatenated =
    `[Summarized from ${messages.length} messages]:\n` +
    messages.map((message) => message.text).join("\n---\n");

  const mergedMetadata: Record<string, unknown> = {};
  for (const message of messages) {
    if (message.metadata) {
      Object.assign(mergedMetadata, message.metadata);
    }
  }

  return {
    id: lastMsg.id,
    channelId: lastMsg.channelId,
    channelType: lastMsg.channelType,
    senderId: lastMsg.senderId,
    text: concatenated,
    timestamp: lastMsg.timestamp,
    attachments: messages.flatMap((message) => message.attachments ?? []),
    metadata: mergedMetadata,
    originalMessages: messages.flatMap(getOriginalInboundMessages),
  };
}

function applyOverflowPolicyToItems<T>(
  pendingItems: T[],
  config: OverflowConfig,
  eventBus: TypedEventBus,
  sessionKey: SessionKey,
  channelType: string,
  getMessage: (item: T) => NormalizedMessage,
  createSummary: (items: T[], message: NormalizedMessage) => T,
  onEventError?: OverflowEventErrorHandler,
): InternalOverflowResult<T> {
  if (pendingItems.length <= config.maxDepth) {
    return { dropped: 0, items: pendingItems };
  }

  let result: InternalOverflowResult<T>;

  switch (config.policy) {
    case "drop-old": {
      const excess = pendingItems.length - config.maxDepth;
      result = {
        dropped: excess,
        items: pendingItems.slice(excess),
      };
      break;
    }

    case "drop-new": {
      result = {
        dropped: 1,
        items: pendingItems.slice(0, -1),
      };
      break;
    }

    case "summarize": {
      const summary = summarizeMessages(pendingItems.map(getMessage));
      result = {
        dropped: pendingItems.length - 1,
        items: [createSummary(pendingItems, summary)],
      };
      break;
    }

    default: {
      const _exhaustive: never = config.policy;
      void _exhaustive;
      result = {
        dropped: 1,
        items: pendingItems.slice(0, -1),
      };
    }
  }

  const emission = eventBus.emitSafely("queue:overflow", {
    sessionKey,
    channelType,
    policy: config.policy,
    droppedCount: result.dropped,
    timestamp: systemNowMs(),
  });
  if (onEventError) {
    const reportFailure = (error: Error): void => {
      void tryCatch(() => onEventError(error));
    };
    for (const failure of emission.failures) {
      reportFailure(failure.error);
    }
    const pendingFailures = (emission as {
      pendingFailures?: Promise<readonly { error: Error }[]>;
    }).pendingFailures;
    if (pendingFailures !== undefined) {
      void fromPromise(pendingFailures).then((settled) => {
        if (!settled.ok) {
          reportFailure(settled.error);
          return;
        }
        for (const failure of settled.value) reportFailure(failure.error);
      });
    }
  }

  return result;
}

/**
 * Apply an overflow policy to pending messages when maxDepth is exceeded.
 *
 * @param pendingMessages - Current pending messages in the lane
 * @param config - Overflow configuration (maxDepth + policy)
 * @param eventBus - Event bus for overflow event emission
 * @param sessionKey - Session key for event payload
 * @param channelType - Channel type for event payload
 * @returns The overflow result with dropped count and remaining messages
 */
export function applyOverflowPolicy(
  pendingMessages: NormalizedMessage[],
  config: OverflowConfig,
  eventBus: TypedEventBus,
  sessionKey: SessionKey,
  channelType: string,
  onEventError?: OverflowEventErrorHandler,
): OverflowResult {
  const result = applyOverflowPolicyToItems(
    pendingMessages,
    config,
    eventBus,
    sessionKey,
    channelType,
    (message) => message,
    (_messages, summary) => summary,
    onEventError,
  );
  return { dropped: result.dropped, messages: result.items };
}

/** Apply overflow without separating a message from its captured turn owner. */
export function applyOverflowPolicyToQueueEntries(
  pendingEntries: QueuedMessageEntry[],
  config: OverflowConfig,
  eventBus: TypedEventBus,
  sessionKey: SessionKey,
  channelType: string,
  onEventError?: OverflowEventErrorHandler,
): QueueEntryOverflowResult {
  const result = applyOverflowPolicyToItems(
    pendingEntries,
    config,
    eventBus,
    sessionKey,
    channelType,
    (entry) => entry.message,
    (entries, summary) => {
      const lastEntry = entries[entries.length - 1]!;
      return {
        ...lastEntry,
        message: summary,
        enqueuedAt: Math.min(...entries.map((entry) => entry.enqueuedAt)),
        receivedAt: Math.min(...entries.map((entry) => entry.receivedAt)),
        logicalCount: 1,
        sourceTerminalScope: mergeSourceTerminalScopes(
          entries.map((entry) => entry.sourceTerminalScope),
        ),
      };
    },
    onEventError,
  );
  return { dropped: result.dropped, entries: result.items };
}
