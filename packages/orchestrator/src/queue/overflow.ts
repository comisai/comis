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

/**
 * Result of applying an overflow policy to pending messages.
 */
export interface OverflowResult {
  /** Number of messages dropped or consolidated */
  dropped: number;
  /** The resulting messages after policy application */
  messages: NormalizedMessage[];
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
): OverflowResult {
  // No overflow — within limits
  if (pendingMessages.length < config.maxDepth) {
    return { dropped: 0, messages: pendingMessages };
  }

  let result: OverflowResult;

  switch (config.policy) {
    case "drop-old": {
      const excess = pendingMessages.length - config.maxDepth;
      result = {
        dropped: excess,
        messages: pendingMessages.slice(excess),
      };
      break;
    }

    case "drop-new": {
      // Caller should not have pushed the new message; return original
      // minus the last element (the new one that triggered overflow).
      result = {
        dropped: 1,
        messages: pendingMessages.slice(0, -1),
      };
      break;
    }

    case "summarize": {
      // Cheap concatenation fallback (actual LLM summarization is a future enhancement)
      const lastMsg = pendingMessages[pendingMessages.length - 1]!;
      const concatenated =
        `[Summarized from ${pendingMessages.length} messages]:\n` +
        pendingMessages.map((m) => m.text).join("\n---\n");

      // Merge all metadata (later overrides earlier)
      const mergedMetadata: Record<string, unknown> = {};
      for (const m of pendingMessages) {
        if (m.metadata) {
          Object.assign(mergedMetadata, m.metadata);
        }
      }

      // Concatenate all attachments
      const allAttachments = pendingMessages.flatMap((m) => m.attachments ?? []);

      const synthetic: NormalizedMessage = {
        id: lastMsg.id,
        channelId: lastMsg.channelId,
        channelType: lastMsg.channelType,
        senderId: lastMsg.senderId,
        text: concatenated,
        timestamp: lastMsg.timestamp,
        attachments: allAttachments,
        metadata: mergedMetadata,
      };

      result = {
        dropped: pendingMessages.length - 1,
        messages: [synthetic],
      };
      break;
    }

    default: {
      // Unknown policy — treat as drop-new for safety
      result = {
        dropped: 1,
        messages: pendingMessages.slice(0, -1),
      };
      break;
    }
  }

  // Emit overflow event for observability
  eventBus.emit("queue:overflow", {
    sessionKey,
    channelType,
    policy: config.policy,
    droppedCount: result.dropped,
    timestamp: Date.now(),
  });

  return result;
}
