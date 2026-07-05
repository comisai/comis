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
import { detectBotMention } from "./mentions.js";
import { mimeToAttachmentType } from "../shared/media-utils.js";

/** The reply-suffix marker that carries the parent-message id in a channel conversation id. */
const MESSAGE_ID_MARKER = ";messageid=";

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
  /** Invoke sub-kind, e.g. "adaptiveCard/action" for a card-action click. */
  name?: string;
  /**
   * Card-action invoke payload. Client-controllable — read only on an invoke,
   * and only for the rendered `verb` and the signed callback `data.cb`; no
   * identity is ever sourced from here.
   */
  value?: { action?: { verb?: string; data?: { cb?: string } } };
  /**
   * Inbound file/media attachments. `contentUrl` is a hosted-content link that
   * needs the Connector Bearer at fetch time; `content.downloadUrl` is a
   * pre-authed SharePoint link that carries no header and 302-redirects to
   * storage. The mapper never fetches these — it only rewrites each to the
   * custom `msteams-file://` scheme so the composite routes deferred,
   * SSRF-guarded resolution to the Teams resolver rather than the https
   * fallback.
   */
  attachments?: Array<{
    contentType: string;
    contentUrl?: string;
    name?: string;
    content?: { downloadUrl?: string };
  }>;
}

/**
 * Strip a trailing ";messageid=…" suffix from a conversation id.
 *
 * Channel replies arrive with the conversation id carrying the parent message
 * id (e.g. "19:abc@thread.tacv2;messageid=1700000000000"); the routing key is
 * the bare conversation id, so the suffix is removed.
 */
export function stripMessageIdSuffix(conversationId: string): string {
  const idx = conversationId.indexOf(MESSAGE_ID_MARKER);
  return idx >= 0 ? conversationId.slice(0, idx) : conversationId;
}

/**
 * Extract the thread root of a channel/group activity: the parent-message id
 * carried in the conversation id's ";messageid=…" suffix (preferred), else the
 * replyToId. Returns undefined when neither is present. Surfaced under a
 * Teams-specific metadata key so the session-key path can isolate one thread
 * per session without affecting any other channel's mapping.
 */
function extractThreadRoot(activity: TeamsActivity): string | undefined {
  const convId = activity.conversation.id;
  const idx = convId.indexOf(MESSAGE_ID_MARKER);
  if (idx >= 0) return convId.slice(idx + MESSAGE_ID_MARKER.length);
  return activity.replyToId;
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
 * The thread root to persist for a conversation-reference capture: the
 * channel/group thread parent, or undefined for a 1:1 DM (which is always
 * top-level). Shared by the inbound message capture (via the mapped
 * `msteamsThreadId` metadata) and the inbound reaction capture so both key the
 * same routing tuple and neither clobbers the other's stored thread root.
 */
export function resolveCaptureThreadId(activity: TeamsActivity): string | undefined {
  if (toChatType(activity.conversation.conversationType) === "dm") return undefined;
  return extractThreadRoot(activity);
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

  const chatType = toChatType(activity.conversation.conversationType);

  const metadata: Record<string, unknown> = {};
  if (activity.id !== undefined) metadata.teamsActivityId = activity.id;
  if (activity.serviceUrl !== undefined) metadata.serviceUrl = activity.serviceUrl;
  const tenantId = activity.channelData?.tenant?.id ?? activity.conversation.tenantId;
  if (tenantId !== undefined) metadata.tenantId = tenantId;
  if (activity.replyToId !== undefined) metadata.replyToId = activity.replyToId;

  // Thread isolation is a channel/group concern; a 1:1 DM has no thread root.
  const threadRoot = resolveCaptureThreadId(activity);
  if (threadRoot !== undefined) metadata.msteamsThreadId = threadRoot;
  metadata.mentionedBot = detectBotMention(activity.entities, activity.recipient?.id);

  // Rewrite each attachment to the custom `msteams-file://` scheme carrying the
  // encodeURIComponent-wrapped real URL. encodeURIComponent guarantees no bare
  // "://" inside the payload, so the composite resolver's scheme split sees
  // exactly `msteams-file` and routes to the Teams resolver (never the https
  // fallback). The pre-authed `content.downloadUrl` is preferred over the
  // hosted-content `contentUrl`; an attachment with no fetchable URL is dropped.
  const attachments = (activity.attachments ?? []).flatMap((att) => {
    const realUrl = att.content?.downloadUrl ?? att.contentUrl;
    if (realUrl == null || realUrl.length === 0) return [];
    return [
      {
        type: mimeToAttachmentType(att.contentType),
        url: `msteams-file://${encodeURIComponent(realUrl)}`,
        ...(att.contentType != null && { mimeType: att.contentType }),
        ...(att.name != null && { fileName: att.name }),
      },
    ];
  });

  return {
    id: randomUUID(),
    channelId: stripMessageIdSuffix(activity.conversation.id),
    channelType: "msteams",
    senderId: activity.from?.aadObjectId ?? activity.from?.id ?? "unknown",
    text: toPlainText(activity.text),
    timestamp: systemNowMs(),
    attachments,
    chatType,
    metadata,
  };
}
