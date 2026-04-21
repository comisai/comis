// SPDX-License-Identifier: Apache-2.0
/**
 * IRC Message Mapper: Normalizes irc-framework events to NormalizedMessage.
 *
 * Handles both channel messages (target starts with "#") and DMs (target
 * is the bot's nick). Supports IRCv3 server-time and msgid tags when
 * the server advertises those capabilities.
 *
 * @module
 */

import type { NormalizedMessage } from "@comis/core";
import { randomUUID } from "node:crypto";

/**
 * IRC message event shape from irc-framework.
 * Used as the input for normalization.
 */
export interface IrcMessageEvent {
  /** Target channel (e.g. "#comis") or bot nick for DMs */
  target: string;
  /** Sender's IRC nick */
  nick: string;
  /** Message text content */
  message: string;
  /** IRCv3 message tags (optional, server-dependent) */
  tags?: Record<string, string>;
}

/**
 * Map an irc-framework message event to Comis's NormalizedMessage.
 *
 * - Channel messages: channelId = target ("#channel")
 * - DMs: channelId = sender nick
 * - Timestamps: IRCv3 server-time tag if present, otherwise Date.now()
 * - Attachments: always empty (IRC is text-only)
 * - Metadata: includes ircTarget, isDm flag, and msgid if available
 */
export function mapIrcToNormalized(event: IrcMessageEvent): NormalizedMessage {
  const isDm = !event.target.startsWith("#");
  const channelId = isDm ? event.nick : event.target;

  // IRCv3 server-time tag (ISO 8601 format)
  const timestamp =
    event.tags?.time ? new Date(event.tags.time).getTime() : Date.now();

  return {
    id: randomUUID(),
    channelId,
    channelType: "irc",
    senderId: event.nick,
    text: event.message,
    timestamp,
    attachments: [],
    chatType: isDm ? "dm" as const : "channel" as const,
    metadata: {
      ircTarget: event.target,
      ircIsDm: isDm,
      ...(event.tags?.msgid ? { ircMessageId: event.tags.msgid } : {}),
    },
  };
}
