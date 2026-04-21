// SPDX-License-Identifier: Apache-2.0
/**
 * Signal Message Mapper: Converts signal-cli envelopes to NormalizedMessage.
 *
 * Handles DMs, group messages, and reaction events. Delegates attachment
 * extraction to the media-handler module.
 *
 * @module
 */

import type { NormalizedMessage } from "@comis/core";
import { randomUUID } from "node:crypto";
import type { SignalEnvelope } from "./signal-client.js";
import { buildSignalAttachments } from "./media-handler.js";

/**
 * Map a signal-cli SSE envelope to a NormalizedMessage.
 *
 * @param envelope - The parsed signal-cli envelope
 * @param baseUrl - signal-cli base URL for attachment download URLs
 * @returns A NormalizedMessage, or null if the envelope has no processable content
 */
export function mapSignalToNormalized(
  envelope: SignalEnvelope,
  baseUrl: string,
): NormalizedMessage | null {
  const dataMessage = envelope.dataMessage;
  if (!dataMessage) return null;

  const senderId = envelope.sourceUuid ?? envelope.sourceNumber ?? envelope.source ?? "unknown";
  const groupInfo = dataMessage.groupInfo;
  const isGroup = Boolean(groupInfo?.groupId);
  const channelId = isGroup ? `group:${groupInfo!.groupId}` : senderId;

  const metadata: Record<string, unknown> = {
    signalTimestamp: envelope.timestamp,
    signalSenderName: envelope.sourceName ?? undefined,
  };

  if (isGroup) {
    metadata.signalGroupId = groupInfo!.groupId;
    metadata.signalGroupName = groupInfo!.groupName ?? undefined;
  }

  // Handle reaction events
  const reaction = dataMessage.reaction;
  if (reaction?.emoji && reaction.targetSentTimestamp) {
    metadata.signalReaction = true;
    metadata.signalReactionTarget = reaction.targetSentTimestamp;
    metadata.signalReactionEmoji = reaction.emoji;
    if (reaction.isRemove) {
      metadata.signalReactionRemove = true;
    }

    return {
      id: randomUUID(),
      channelId,
      channelType: "signal",
      senderId,
      text: reaction.emoji,
      timestamp: envelope.timestamp ?? Date.now(),
      attachments: [],
      chatType: isGroup ? "group" as const : "dm" as const,
      metadata,
    };
  }

  // Regular data message
  const text = dataMessage.message ?? "";
  const attachments = buildSignalAttachments(dataMessage.attachments ?? [], baseUrl);

  // Skip empty messages with no attachments
  if (!text && attachments.length === 0) return null;

  // Quote metadata
  if (dataMessage.quote) {
    metadata.signalQuoteId = dataMessage.quote.id;
    metadata.signalQuoteAuthor = dataMessage.quote.authorUuid ?? dataMessage.quote.author;
    metadata.signalQuoteText = dataMessage.quote.text;
  }

  return {
    id: randomUUID(),
    channelId,
    channelType: "signal",
    senderId,
    text,
    timestamp: envelope.timestamp ?? Date.now(),
    attachments,
    chatType: isGroup ? "group" as const : "dm" as const,
    metadata,
  };
}
