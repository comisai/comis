// SPDX-License-Identifier: Apache-2.0
/**
 * Microsoft Teams Message Mapper: converts a Bot Framework activity into a
 * NormalizedMessage.
 *
 * Pure and transport-free — the adapter hands a plain activity object here so
 * the mapping is unit-testable without any HTTP layer. It is the single point
 * that decides the routing identity the inbound path keys on:
 *
 * - conversationType personal|groupChat|channel -> chatType dm|group|channel
 * - conversation.id ";messageid=…" reply suffix -> stripped channelId
 * - from.aadObjectId (stable directory id) preferred over from.id for senderId
 * - <at>…</at> mention markup stripped so the text is faithful plain text
 *
 * Returns null for non-message activities (conversationUpdate, messageReaction,
 * …) so the adapter early-returns on them.
 *
 * @module
 */

import type { NormalizedMessage } from "@comis/core";
import { systemNowMs } from "@comis/core";
import { randomUUID } from "node:crypto";

/**
 * Minimal Bot Framework activity shape — only the fields the inbound path
 * reads. Deliberately loose: the connector sends many more fields we ignore.
 */
export interface TeamsActivity {
  /** Activity kind: "message" | "conversationUpdate" | "messageReaction" | … */
  type: string;
  /** Activity id — the reply/edit/delete target. */
  id?: string;
  text?: string;
  conversation: {
    id: string;
    conversationType?: "personal" | "groupChat" | "channel";
    tenantId?: string;
  };
  from?: { id: string; aadObjectId?: string; name?: string };
  recipient?: { id: string; name?: string };
  serviceUrl?: string;
  replyToId?: string;
  channelData?: { tenant?: { id?: string } };
  entities?: Array<{ type: string; mentioned?: { id: string }; text?: string }>;
}

/**
 * Strip a trailing ";messageid=…" suffix from a conversation id.
 *
 * Channel replies arrive with the conversation id carrying the parent message
 * id (e.g. "19:abc@thread.tacv2;messageid=1700000000000"); the routing key is
 * the bare conversation id, so the suffix is removed.
 */
function stripMessageIdSuffix(conversationId: string): string {
  const idx = conversationId.indexOf(";messageid=");
  return idx >= 0 ? conversationId.slice(0, idx) : conversationId;
}

/**
 * Reduce Teams message text to plain text: drop <at>…</at> mention spans, strip
 * any remaining HTML tags, and collapse whitespace. A regex pass suffices for
 * the text this path carries; richer HTML (tables, links) would extend this.
 */
function toPlainText(raw: string | undefined): string {
  if (!raw) return "";
  return raw
    .replace(/<at\b[^>]*>.*?<\/at>/gi, "")
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Derive the normalized chatType from the Bot Framework conversationType.
 * Unknown/absent types default to "channel".
 */
function toChatType(
  conversationType: TeamsActivity["conversation"]["conversationType"],
): "dm" | "group" | "channel" {
  switch (conversationType) {
    case "personal":
      return "dm";
    case "groupChat":
      return "group";
    case "channel":
      return "channel";
    default:
      return "channel";
  }
}

/**
 * Map a Bot Framework activity to a NormalizedMessage.
 *
 * @param activity - A Bot Framework inbound activity
 * @returns A NormalizedMessage for message activities; null otherwise
 */
export function mapMsTeamsActivityToNormalized(
  activity: TeamsActivity,
): NormalizedMessage | null {
  if (activity.type !== "message") return null;

  const metadata: Record<string, unknown> = {};
  if (activity.id !== undefined) metadata.teamsActivityId = activity.id;
  if (activity.serviceUrl !== undefined) metadata.serviceUrl = activity.serviceUrl;
  const tenantId = activity.channelData?.tenant?.id ?? activity.conversation.tenantId;
  if (tenantId !== undefined) metadata.tenantId = tenantId;
  if (activity.replyToId !== undefined) metadata.replyToId = activity.replyToId;

  return {
    id: randomUUID(),
    channelId: stripMessageIdSuffix(activity.conversation.id),
    channelType: "msteams",
    senderId: activity.from?.aadObjectId ?? activity.from?.id ?? "unknown",
    text: toPlainText(activity.text),
    timestamp: systemNowMs(),
    attachments: [],
    chatType: toChatType(activity.conversation.conversationType),
    metadata,
  };
}
