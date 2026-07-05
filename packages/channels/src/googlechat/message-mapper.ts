// SPDX-License-Identifier: Apache-2.0
/**
 * Google Chat Message Mapper: converts a classic Chat interaction event into a
 * NormalizedMessage.
 *
 * Pure and transport-free — the pull loop (or webhook ingress) hands a plain,
 * already-decoded event object here, so the mapping is unit-testable without
 * any HTTP layer. It is the single point that decides the routing identity the
 * inbound path keys on:
 *
 * - space.spaceType DIRECT_MESSAGE (or legacy space.type DM) -> chatType "dm"
 *   with metadata.isGroup false; everything else is a "group" space
 * - space.name -> channelId (the space resource name "spaces/AAAA")
 * - message.sender.name -> senderId (the immutable "users/{id}" resource name,
 *   never a display name — it is what the sender allowlist gate keys on)
 * - message.argumentText (mention already stripped by the platform) preferred
 *   over message.text
 * - a USER_MENTION annotation -> metadata.wasMentioned
 * - message.thread.name -> metadata.googlechatThreadId (captured for routing;
 *   the mapper does not itself reply into a thread)
 *
 * Returns null for non-MESSAGE events (ADDED_TO_SPACE, CARD_CLICKED, …) and for
 * a MESSAGE event with no message payload, so the adapter early-returns on them.
 * The mapper never fetches a URL and never executes content; it only normalizes
 * untrusted JSON into the bounded NormalizedMessage the downstream path wraps.
 *
 * @module
 */

import type { Attachment, NormalizedMessage } from "@comis/core";
import { systemNowMs } from "@comis/core";
import { randomUUID } from "node:crypto";
import { mimeToAttachmentType } from "../shared/media-utils.js";

/**
 * Minimal classic Chat interaction-event shape — only the fields the inbound
 * path reads. Deliberately loose: the platform sends many more fields we ignore.
 */
export interface GoogleChatEvent {
  /** Event kind: "MESSAGE" | "ADDED_TO_SPACE" | "CARD_CLICKED" | … */
  type?: string;
  eventTime?: string;
  /** The acting user; a fallback source for senderId. */
  user?: { name?: string };
  /**
   * Top-level space. The current `spaceType` enum
   * (DIRECT_MESSAGE | SPACE | GROUP_CHAT) replaced the deprecated `type` enum
   * (DM | ROOM); an inbound event may carry either, so both are read.
   */
  space?: { name?: string; type?: string; spaceType?: string };
  message?: {
    /** "spaces/X/messages/Y" — the resource name used for dedup upstream. */
    name?: string;
    /** "users/123" — the immutable sender resource id. */
    sender?: { name?: string };
    text?: string;
    /** Mention pre-stripped by the platform — preferred over `text`. */
    argumentText?: string;
    /** "spaces/X/threads/Z" — captured, not replied into here. */
    thread?: { name?: string };
    annotations?: Array<{ type?: string }>;
    /** Per-message space; takes precedence over the top-level `space`. */
    space?: { name?: string; type?: string; spaceType?: string };
    /**
     * Inbound file/media attachments — the repeated Chat Message resource field
     * is named `attachment` (SINGULAR), NOT `attachments`; reading the plural
     * would always be empty. Only an attachment whose `attachmentDataRef` carries
     * a resource name is downloadable by an app (over media.download); a
     * `driveDataRef`-only share (source "DRIVE_FILE" from the Drive picker) has no
     * downloadable resource name. The wire also carries browser-facing
     * `downloadUri`/`thumbnailUri` links that reject an app bearer — they are
     * deliberately NOT modeled here so they can never be surfaced as a fetch URL.
     */
    attachment?: Array<{
      name?: string;
      contentName?: string;
      contentType?: string;
      /** Upload-origin marker; classification keys on resource-name presence, not this. */
      source?: string;
      /** Present with a resource name → the attachment is downloadable via media.download. */
      attachmentDataRef?: { resourceName?: string };
      /** A Drive-only reference → not downloadable by an app. */
      driveDataRef?: { driveFileId?: string };
    }>;
  };
}

/**
 * Extract inbound attachments from a Chat message, keying the resolve/skip
 * decision on the PRESENCE of a downloadable resource name — never on the upload
 * source. An attachment carrying `attachmentDataRef.resourceName` is surfaced as a
 * `googlechat-attachment://` ref the media resolver can fetch (with a coarse
 * `type` + `mimeType` + `fileName` so the standard pipeline routes it); a share
 * that carries no resource name is surfaced separately under `skipped` for the
 * caller to log. The ref URL is only ever the resource-name scheme — a
 * browser-facing download link is never read.
 *
 * Pure: no I/O, no logging. The caller (the adapter) logs the `skipped` half so
 * the mapper stays transport- and logger-free.
 *
 * @param message - The decoded Chat message payload (may be undefined)
 * @returns `{ attachments, skipped }` — resolvable refs and resource-name-less shares
 */
export function extractGoogleChatAttachments(
  message: GoogleChatEvent["message"],
): { attachments: Attachment[]; skipped: Array<{ source?: string; contentName?: string }> } {
  const attachments: Attachment[] = [];
  const skipped: Array<{ source?: string; contentName?: string }> = [];
  for (const a of message?.attachment ?? []) {
    // Untrusted inbound JSON: a decoded array element can be the literal null or a
    // non-object scalar. Guard before any dereference so a hostile element is
    // dropped rather than crashing the mapper.
    if (a === null || typeof a !== "object") continue;
    const resourceName = a.attachmentDataRef?.resourceName;
    if (typeof resourceName === "string" && resourceName.length > 0) {
      // encodeURIComponent guarantees no bare "://" inside the payload, so the
      // resolver's scheme split sees exactly `googlechat-attachment` and the
      // decode is its exact inverse.
      attachments.push({
        type: mimeToAttachmentType(a.contentType),
        url: `googlechat-attachment://${encodeURIComponent(resourceName)}`,
        ...(a.contentType != null && { mimeType: a.contentType }),
        ...(a.contentName != null && { fileName: a.contentName }),
      });
    } else {
      skipped.push({ source: a.source, contentName: a.contentName });
    }
  }
  return { attachments, skipped };
}

/** The non-empty sentinel space name. */
const UNKNOWN_SPACE = "spaces/unknown";
/** The non-empty sentinel sender id. */
const UNKNOWN_SENDER = "unknown";

/**
 * Map a classic Chat interaction event to a NormalizedMessage.
 *
 * @param event - A decoded classic Chat interaction event
 * @returns A NormalizedMessage for MESSAGE events; null otherwise
 */
export function mapGoogleChatEventToNormalized(
  event: GoogleChatEvent,
): NormalizedMessage | null {
  // Untrusted-input boundary: a decoded payload can be the literal JSON `null`
  // (typeof null === "object", and null.type throws) or a non-object scalar.
  // Guard before any dereference so a hostile/malformed payload returns null and
  // is ACK-dropped, never crashing into the enqueue-backpressure redelivery path.
  if (event === null || typeof event !== "object") return null;
  if (event.type !== "MESSAGE" || !event.message) return null;

  const message = event.message;
  const space = message.space ?? event.space;
  // Accept both the current and the legacy DM encoding; anything else is a
  // multi-person space (a "group").
  const isDm = space?.spaceType === "DIRECT_MESSAGE" || space?.type === "DM";
  const wasMentioned = (message.annotations ?? []).some((a) => a.type === "USER_MENTION");

  const metadata: Record<string, unknown> = { isGroup: !isDm, wasMentioned };
  // The message resource name is the platform reply target the plugin advertises
  // as replyToMetaKey "googlechatMessageName" — write it so the inbound-message-id
  // resolver records the native id and the reply-to path can quote this message.
  if (message.name) metadata.googlechatMessageName = message.name;
  // Capture the inbound thread resource name for routing. The generic
  // metadata.threadId key is the one the shared inbound→outbound thread
  // propagation consumes to route a reply back into the same thread; the
  // channel-scoped key is retained alongside it. Replying into the thread is
  // handled on the send path, not here.
  if (message.thread?.name) {
    metadata.threadId = message.thread.name;
    metadata.googlechatThreadId = message.thread.name;
  }

  return {
    id: randomUUID(),
    // channelId is a required, non-empty field; a malformed MESSAGE event that
    // omits the space name still maps to the non-empty sentinel so the message
    // stays schema-valid rather than being silently dropped.
    channelId: space?.name ?? UNKNOWN_SPACE,
    channelType: "googlechat",
    senderId: message.sender?.name ?? event.user?.name ?? UNKNOWN_SENDER,
    // The platform strips the app mention into argumentText; prefer it so the
    // text is the faithful command without hand-stripping.
    text: message.argumentText ?? message.text ?? "",
    timestamp: systemNowMs(),
    // Attachments carrying a downloadable resource name are surfaced as
    // googlechat-attachment:// refs the resolver fetches; a share without one is
    // separated into `skipped` for the caller to log, so the mapper stays pure.
    attachments: extractGoogleChatAttachments(message).attachments,
    chatType: isDm ? "dm" : "group",
    metadata,
  };
}
