// SPDX-License-Identifier: Apache-2.0
/**
 * Matrix message mapper: converts a Matrix timeline event into a
 * NormalizedMessage.
 *
 * Pure and transport-free — the adapter hands a plain event + room here so the
 * mapping is unit-testable without a homeserver. It is the single point that
 * decides the routing identity the inbound path keys on:
 *
 * - a non-`m.room.message` event maps to null so the adapter early-returns
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
 * @module
 */

import type { NormalizedMessage } from "@comis/core";
import { systemNowMs } from "@comis/core";
import { randomUUID } from "node:crypto";
import type { MatrixEvent, Room } from "matrix-js-sdk";
import { sanitizeInboundHtml } from "./format-matrix.js";

/** The Matrix event type that carries a chat message. */
const ROOM_MESSAGE_TYPE = "m.room.message";

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
  if (event.getType() !== ROOM_MESSAGE_TYPE) return null;

  // Identity keys on the full MXID. A message with no sender is unverifiable
  // and must never surface — it cannot be attributed or trust-gated.
  const senderId = event.getSender();
  if (senderId === null || senderId === undefined || senderId.length === 0) return null;

  const content = event.getContent();
  const text = typeof content.body === "string" ? content.body : "";

  const metadata: Record<string, unknown> = {};
  const eventId = event.getId();
  if (eventId !== null && eventId !== undefined && eventId.length > 0) {
    metadata.matrixEventId = eventId;
  }
  // Any formatted_body carried into the normalized message is sanitized to a
  // safe subset first — inbound HTML is attacker-controllable.
  const formattedBody = content.formatted_body;
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
