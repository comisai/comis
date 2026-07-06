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

import type { Attachment, NormalizedMessage } from "@comis/core";
import { systemNowMs } from "@comis/core";
import { randomUUID } from "node:crypto";
import type { MatrixEvent, Room } from "matrix-js-sdk";
import { sanitizeInboundHtml } from "./format-matrix.js";
import { detectBotMention } from "./mentions.js";
import type { EncryptedFileLike } from "./media-handler.js";

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
 * The media message subtypes that carry an attachment, each mapped to the
 * normalized attachment type. A message with any other `msgtype` (e.g. `m.text`,
 * `m.notice`) carries no attachment and falls through to the text path. A `Map`
 * (not a plain object) so the untrusted `msgtype` lookup is prototype-safe — a
 * hostile `msgtype` like `constructor`/`__proto__` yields a clean miss, never an
 * inherited property.
 */
const MEDIA_MSGTYPE_TO_TYPE = new Map<string, Attachment["type"]>([
  ["m.image", "image"],
  ["m.audio", "audio"],
  ["m.video", "video"],
  ["m.file", "file"],
]);

/**
 * Read a possibly-present `content.file` as an encrypted-file record. Returns the
 * record ONLY when it is an object structurally shaped like a decryptable
 * encrypted file — a non-empty string `url` (the mxc the cache keys on), a `key`
 * object, a non-empty `iv`, a `hashes` object, and a non-empty version tag.
 * Anything else (absent, a non-object, or a partial record missing key material)
 * returns undefined so nothing unresolvable is cached. Untrusted, possibly-federated
 * content — every field is typeof-guarded.
 */
function readEncryptedFile(file: unknown): EncryptedFileLike | undefined {
  if (typeof file !== "object" || file === null) return undefined;
  const f = file as { url?: unknown; key?: unknown; iv?: unknown; hashes?: unknown; v?: unknown };
  if (typeof f.url !== "string" || f.url.length === 0) return undefined;
  if (typeof f.key !== "object" || f.key === null) return undefined;
  if (typeof f.iv !== "string" || f.iv.length === 0) return undefined;
  if (typeof f.hashes !== "object" || f.hashes === null) return undefined;
  if (typeof f.v !== "string" || f.v.length === 0) return undefined;
  return file as EncryptedFileLike;
}

/**
 * Detect an inbound media attachment on a message event's content.
 *
 * Returns undefined for a non-media message (it falls through to the text path).
 * For a media message it returns the normalized {@link Attachment} carrying the
 * `mxc://` url — from `content.url` in a plaintext room, or from the encrypted-file
 * record's url in an encrypted room — and, when the event carries an encrypted-file
 * record, that record so the caller can write it to the key side-channel. The strict
 * attachment schema cannot hold the JWK key/iv/hashes, so they never ride the
 * attachment. A media event with neither a plaintext url nor a valid encrypted-file
 * url yields undefined (nothing resolvable). The declared `mimetype`/`size`/`body`
 * are provisional metadata; the resolver's byte sniff is authoritative.
 *
 * Untrusted, possibly-federated content — every `content.*` read is typeof-guarded.
 */
function detectMediaAttachment(
  content: Record<string, unknown>,
): { attachment: Attachment; encrypted?: EncryptedFileLike } | undefined {
  const msgtype = content.msgtype;
  if (typeof msgtype !== "string") return undefined;
  const type = MEDIA_MSGTYPE_TO_TYPE.get(msgtype);
  if (type === undefined) return undefined;

  // The mxc rides on the encrypted-file record (encrypted room) or content.url
  // (plaintext room). No resolvable mxc → not a resolvable attachment.
  const encrypted = readEncryptedFile(content.file);
  const plaintextUrl =
    typeof content.url === "string" && content.url.length > 0 ? content.url : undefined;
  const mxc = encrypted?.url ?? plaintextUrl;
  if (mxc === undefined) return undefined;

  const attachment: Attachment = { type, url: mxc };
  // The event indicated E2EE for this media if it carried a `content.file` structure
  // at all. When it is a COMPLETE record the key is cached below; when it is present
  // but structurally incomplete NO key is cached — either way the attachment is marked
  // encrypted so the resolver fails closed (rather than serving the undecryptable
  // ciphertext as plaintext) if the key is unavailable at resolve time. A genuine
  // plaintext media event carries no `content.file` and is never marked.
  if (typeof content.file === "object" && content.file !== null) attachment.encrypted = true;
  const info = content.info;
  if (typeof info === "object" && info !== null) {
    const i = info as { mimetype?: unknown; size?: unknown };
    if (typeof i.mimetype === "string" && i.mimetype.length > 0) attachment.mimeType = i.mimetype;
    if (typeof i.size === "number" && Number.isInteger(i.size) && i.size >= 0) {
      attachment.sizeBytes = i.size;
    }
  }
  const body = content.body;
  if (typeof body === "string" && body.length > 0) attachment.fileName = body;

  return encrypted !== undefined ? { attachment, encrypted } : { attachment };
}

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
  /**
   * The bot's own MXID, used to decide whether an inbound message addresses the
   * bot (sets `metadata.isBotMentioned`). Absent/empty means the mention check is
   * skipped (never a false positive).
   */
  botUserId?: string;
  /**
   * Write seam for the encrypted-media key side-channel. Invoked ONLY for an
   * encrypted media event, with the `mxc://` url and the event's encrypted-file
   * record. The strict normalized attachment schema cannot carry the JWK
   * key/iv/hashes (they are the decryption secret), so the resolver reads them
   * back from the adapter cache this callback writes. A plaintext media event
   * never invokes it. NEVER log the record (key material).
   */
  cacheEncryptedFile?: (mxc: string, file: EncryptedFileLike) => void;
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

  // The exact key the shared group @-mention gate reads (`isBotMentioned`) — set
  // it so the bot answers when addressed in a group. Keyed on the bot's OWN MXID
  // (never a display name) against the untrusted mentions list / pill.
  metadata.isBotMentioned = detectBotMention(content, opts.botUserId ?? "");

  // A media message surfaces an attachment carrying the `mxc://` url the resolver
  // resolves later. For an encrypted media event the encrypted-file record cannot
  // ride the strict attachment schema, so it is written to the key side-channel
  // keyed by that mxc — the resolver reads it back to decrypt. A non-media message
  // yields no attachment and never touches the side-channel.
  const media = detectMediaAttachment(content);
  if (media?.encrypted !== undefined) {
    opts.cacheEncryptedFile?.(media.attachment.url, media.encrypted);
  }

  return {
    id: randomUUID(),
    channelId: room.roomId,
    channelType: "matrix",
    senderId,
    text,
    timestamp: systemNowMs(),
    attachments: media !== undefined ? [media.attachment] : [],
    chatType: isThread ? "thread" : opts.isDirect ? "dm" : "group",
    metadata,
  };
}
