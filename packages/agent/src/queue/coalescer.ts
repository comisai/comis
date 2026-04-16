/**
 * Message Coalescer: Merges multiple rapid messages into a single turn.
 *
 * In collect mode, messages that arrive during an active agent execution
 * are accumulated and coalesced into a single NormalizedMessage with
 * numbered delimiters. This gives the agent clear context about the
 * multi-message nature of the input.
 *
 * @module
 */

import type { NormalizedMessage } from "@comis/core";

/**
 * Coalesce multiple messages into a single NormalizedMessage.
 *
 * Single messages are returned unchanged. For multiple messages:
 * - Text is formatted with `[Message N]:` delimiters
 * - Metadata is merged (later messages override earlier)
 * - Attachments are concatenated
 * - channelId, channelType, senderId from the last message
 * - timestamp is the latest timestamp
 *
 * @param messages - Messages to coalesce (must have at least one)
 * @returns A single coalesced NormalizedMessage
 */
export function coalesceMessages(
  messages: NormalizedMessage[],
): NormalizedMessage {
  if (messages.length === 0) {
    throw new Error("coalesceMessages requires at least one message");
  }

  if (messages.length === 1) {
    return messages[0]!;
  }

  const lastMsg = messages[messages.length - 1]!;

  // Format text with numbered delimiters
  const text = messages
    .map((m, i) => `[Message ${i + 1}]: ${m.text}`)
    .join("\n\n");

  // Merge all metadata (later messages override earlier)
  const mergedMetadata: Record<string, unknown> = {};
  for (const m of messages) {
    if (m.metadata) {
      Object.assign(mergedMetadata, m.metadata);
    }
  }

  // Concatenate all attachments
  const allAttachments = messages.flatMap((m) => m.attachments ?? []);

  // Use the latest timestamp
  const latestTimestamp = Math.max(...messages.map((m) => m.timestamp));

  return {
    id: lastMsg.id,
    channelId: lastMsg.channelId,
    channelType: lastMsg.channelType,
    senderId: lastMsg.senderId,
    text,
    timestamp: latestTimestamp,
    attachments: allAttachments,
    metadata: mergedMetadata,
  };
}
