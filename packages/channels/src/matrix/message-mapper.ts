// SPDX-License-Identifier: Apache-2.0
/**
 * Matrix message mapper: converts a Matrix timeline event into a
 * NormalizedMessage.
 *
 * Pure and transport-free — the adapter hands a plain event + room here so the
 * mapping is unit-testable without a homeserver. It is the single point that
 * decides the routing identity the inbound path keys on:
 *
 * - a chat message (`m.room.message`) or a redaction (`m.room.redaction`) is
 *   surfaced; every other event type maps to null so the adapter early-returns
 * - `senderId` is the full MXID from `getSender()` — never a display name,
 *   which any user can set to impersonate another; an event with no verifiable
 *   sender maps to null rather than emit an identity-less message
 * - the Matrix event id rides in `metadata.matrixEventId` (the reply target)
 * - `chatType` is `thread` when the event hangs under a thread root (its
 *   `threadRootId` rides in `metadata.matrixThreadId`), else `dm` for a direct
 *   room and `group` otherwise
 * - a `formatted_body` is reduced to a safe subset by `sanitizeInboundHtml`
 *   before any of it is carried into metadata (the normalized `text` is always
 *   the plaintext `body`, never the HTML)
 *
 * Inbound edits and redactions arrive as NEW events; prior context is never
 * rewritten. A remote edit (an `m.replace` relation) surfaces as a fresh
 * normalized event carrying the NEW content and an advisory
 * `metadata.matrixReplacesEventId` pointer — the original receipt-time event the
 * bot already saw is left untouched, so the agent reasons on immutable history and
 * cannot be tricked into acting on a silently-rewritten past. A redaction
 * likewise surfaces as a fresh honest event naming the redacted target in
 * `metadata.matrixRedactsEventId`, with a body-free marker as its text — none of
 * the removed content is ever reconstructed.
 *
 * @module
 */

import type { NormalizedMessage } from "@comis/core";
import { systemNowMs } from "@comis/core";
import { randomUUID } from "node:crypto";
import type { MatrixEvent, Room } from "matrix-js-sdk";
import { sanitizeInboundHtml } from "./format-matrix.js";

/** The Matrix event type that carries a chat message. */
const ROOM_MESSAGE_TYPE = "m.room.message";
/** The Matrix event type of a redaction (a message deletion). */
const ROOM_REDACTION_TYPE = "m.room.redaction";
/** The `rel_type` of an edit — an event that replaces the content of another. */
const REPLACE_REL_TYPE = "m.replace";
/**
 * The honest, body-free marker an inbound redaction surfaces as its text. It
 * states that a message was removed WITHOUT reconstructing any of the removed
 * content; the redacted target id rides in advisory metadata, never in this text.
 */
const REDACTION_MARKER_TEXT = "A previous message in this room was deleted.";

/**
 * The replaced event id of an `m.replace` relation, or undefined when the relation
 * is absent, not an object, not a replacement, or names no target. Pure — reads the
 * untrusted `m.relates_to` envelope defensively.
 */
function replaceTargetId(relatesTo: unknown): string | undefined {
  if (typeof relatesTo !== "object" || relatesTo === null) return undefined;
  const rel = relatesTo as { rel_type?: unknown; event_id?: unknown };
  if (rel.rel_type !== REPLACE_REL_TYPE) return undefined;
  return typeof rel.event_id === "string" && rel.event_id.length > 0 ? rel.event_id : undefined;
}

/** Per-event mapping inputs the adapter resolves from room state. */
export interface MatrixMapOptions {
  /** Whether the room is a direct (1:1) conversation, from the `m.direct` flag. */
  isDirect: boolean;
}

/**
 * Map a Matrix timeline event to a NormalizedMessage.
 *
 * @param event - A Matrix `m.room.message` (or other) timeline event.
 * @param room - The room the event belongs to; its id is the routing channelId.
 * @param opts - Room-derived mapping inputs (the direct-room flag).
 * @returns A NormalizedMessage for a message event with a verifiable sender;
 *   null otherwise.
 */
export function mapMatrixEventToNormalized(
  event: MatrixEvent,
  room: Room,
  opts: MatrixMapOptions,
): NormalizedMessage | null {
  const type = event.getType();
  // Chat messages (including edits, which are m.room.message + an m.replace
  // relation) and redactions are surfaced; every other event type maps to null so
  // the adapter early-returns.
  if (type !== ROOM_MESSAGE_TYPE && type !== ROOM_REDACTION_TYPE) return null;

  // Identity keys on the full MXID. An event with no sender is unverifiable
  // and must never surface — it cannot be attributed or trust-gated.
  const senderId = event.getSender();
  if (senderId === null || senderId === undefined || senderId.length === 0) return null;

  const metadata: Record<string, unknown> = {};
  const eventId = event.getId();
  if (eventId !== null && eventId !== undefined && eventId.length > 0) {
    metadata.matrixEventId = eventId;
  }

  // A redaction surfaces HONESTLY as a NEW event: the bot learns a message was
  // removed (the redacted target id rides in advisory metadata) WITHOUT any of the
  // removed content being reconstructed. Prior context is never silently rewritten
  // or dropped — this is a fresh, additional event, and the immutable receipt-time
  // events the bot already saw are left untouched. A body-free marker is its text.
  if (type === ROOM_REDACTION_TYPE) {
    const redactedId = event.getAssociatedId();
    if (typeof redactedId === "string" && redactedId.length > 0) {
      metadata.matrixRedactsEventId = redactedId;
    }
    return {
      id: randomUUID(),
      channelId: room.roomId,
      channelType: "matrix",
      senderId,
      text: REDACTION_MARKER_TEXT,
      timestamp: systemNowMs(),
      attachments: [],
      chatType: opts.isDirect ? "dm" : "group",
      metadata,
    };
  }

  const content = event.getContent();

  // An inbound edit (an m.replace relation) surfaces as a NEW event carrying the
  // NEW content plus an advisory pointer to the replaced event — never an in-place
  // rewrite of what the bot already received. The authoritative new message rides
  // under m.new_content; the top-level body is only the "* "-prefixed fallback.
  // Surfacing it as a distinct event (not a mutation of the original) is what keeps
  // the agent reasoning on immutable receipt-time history.
  const replacesEventId = replaceTargetId(content["m.relates_to"]);
  let text: string;
  let formattedBody: unknown;
  if (replacesEventId !== undefined) {
    metadata.matrixReplacesEventId = replacesEventId;
    const newContent = content["m.new_content"];
    const nc =
      typeof newContent === "object" && newContent !== null
        ? (newContent as { body?: unknown; formatted_body?: unknown })
        : undefined;
    text = typeof nc?.body === "string" ? nc.body : "";
    formattedBody = nc?.formatted_body;
  } else {
    text = typeof content.body === "string" ? content.body : "";
    formattedBody = content.formatted_body;
  }

  // Any formatted_body carried into the normalized message is sanitized to a
  // safe subset first — inbound HTML is attacker-controllable.
  if (typeof formattedBody === "string" && formattedBody.length > 0) {
    metadata.matrixFormattedBody = sanitizeInboundHtml(formattedBody);
  }

  // A thread event hangs under a thread root. The root id is advisory routing
  // metadata (federated, untrusted) — identity still keys on the sender MXID
  // above; here it only classifies the chatType and rides in metadata so a reply
  // can target the same thread. `chatType: "thread"` takes precedence over
  // dm/group when present.
  const threadRootId = event.threadRootId;
  const isThread = typeof threadRootId === "string" && threadRootId.length > 0;
  if (isThread) {
    metadata.matrixThreadId = threadRootId;
  }

  return {
    id: randomUUID(),
    channelId: room.roomId,
    channelType: "matrix",
    senderId,
    text,
    timestamp: systemNowMs(),
    attachments: [],
    chatType: isThread ? "thread" : opts.isDirect ? "dm" : "group",
    metadata,
  };
}
