// SPDX-License-Identifier: Apache-2.0
/**
 * Matrix Client-Server API wire builders — the fixtures the loopback emulator
 * serves and the round-trip scenario drives through the REAL production Matrix
 * adapter.
 *
 * The emulator answers the subset of the Client-Server `/sync` long-poll + REST
 * surface the adapter consumes: `/versions`, `/login`, `/account/whoami`,
 * `/sync`, `/rooms/{id}/send/...`, `/join/{id}`. These builders produce the exact
 * JSON shapes `matrix-js-sdk` parses into its `MatrixEvent` / sync objects, so a
 * timeline event carries `sender` (a full MXID), `event_id`, `origin_server_ts`,
 * and an `m.room.message` `content` — the fields the adapter's mapper reads
 * (`getSender()` / `getId()` / `getTs()` / `getContent()`). A direct room is
 * expressed via `m.direct` account-data (the flag the adapter reconciles into
 * `chatType: "dm"`).
 *
 * The shapes are the standard Matrix wire structures (real identifiers like
 * `m.room.message`, `org.matrix.custom.html`, `m.direct` are kept); the neutral
 * `hs.test` homeserver + placeholder MXIDs keep the fixtures identity-free.
 *
 * TEST-HARNESS — lives under `test/`, never `packages`; ZERO production runtime
 * change. Imports NO `@comis/*` runtime.
 *
 * @module
 */

/** The Matrix event type that carries a chat message. */
export const ROOM_MESSAGE_TYPE = "m.room.message";
/** The account-data type marking a room a direct (1:1) conversation. */
export const DIRECT_ACCOUNT_DATA_TYPE = "m.direct";
/** The formatting marker Matrix requires alongside a `formatted_body`. */
export const CUSTOM_HTML_FORMAT = "org.matrix.custom.html";

/** The neutral test homeserver domain the fixtures address. */
export const MATRIX_TEST_HS = "hs.test";
/** The bot's full MXID (the adapter's own user id / `whoami` identity). */
export const MATRIX_TEST_BOT_MXID = `@bot:${MATRIX_TEST_HS}`;
/** The bot's device id (the identity `whoami`/login resolves). */
export const MATRIX_TEST_DEVICE_ID = "DEVICETEST1";

/** An `m.room.message` `content` (the wire shape the mapper reads `body` from). */
export interface MatrixMessageContent {
  /** Message subtype; `m.text` for a plaintext chat message. */
  msgtype: string;
  /** The plaintext body — the mapper's normalized `text`. */
  body: string;
  /** The formatting marker, when a formatted body is present. */
  format?: string;
  /** The formatted (HTML) body, sanitized by the adapter on inbound. */
  formatted_body?: string;
}

/** A single Matrix event as it appears on the wire (timeline or state). */
export interface MatrixWireEvent {
  /** The event type (`m.room.message`, `m.room.member`, `m.room.create`, …). */
  type: string;
  /** The full MXID of the sender — the mapper's `senderId` (never a display name). */
  sender: string;
  /** The event content (shape depends on `type`). */
  content: Record<string, unknown>;
  /** The homeserver-assigned event id — the mapper's `metadata.matrixEventId`. */
  event_id: string;
  /** The origin server timestamp (ms) — the watermark ordering key. */
  origin_server_ts: number;
  /** The state key (present on state events; `""` for room-scoped state). */
  state_key?: string;
  /** The redacted event id (present only on an `m.room.redaction` event). */
  redacts?: string;
  /** Server-added unsigned data (age, etc.). */
  unsigned?: Record<string, unknown>;
}

/** A joined-room object inside a `/sync` response (`rooms.join[roomId]`). */
export interface MatrixJoinedRoom {
  timeline: { events: MatrixWireEvent[]; prev_batch: string; limited: boolean };
  state: { events: MatrixWireEvent[] };
  ephemeral: { events: MatrixWireEvent[] };
  account_data: { events: MatrixWireEvent[] };
  unread_notifications: { notification_count: number; highlight_count: number };
}

/** A Client-Server `/sync` response (the subset the adapter's SyncApi consumes). */
export interface MatrixSyncResponse {
  next_batch: string;
  account_data: { events: MatrixWireEvent[] };
  rooms: { join: Record<string, MatrixJoinedRoom> };
}

/** The `/account/whoami` response — validates a token is live. */
export interface MatrixWhoamiResponse {
  user_id: string;
  device_id?: string;
}

/** The `POST /login` response — the credentials a password login yields. */
export interface MatrixLoginResponse {
  user_id: string;
  device_id: string;
  access_token: string;
}

/** The `/versions` response — the supported spec versions the client probes. */
export interface MatrixVersionsResponse {
  versions: string[];
  unstable_features: Record<string, boolean>;
}

/** Options for {@link makeRoomMessageEvent}. */
export interface MakeRoomMessageOpts {
  /** The full MXID of the sender. */
  sender: string;
  /** The plaintext body. */
  body: string;
  /** The homeserver-assigned event id. */
  eventId: string;
  /** The origin server timestamp (ms). */
  ts: number;
  /** An optional inbound `formatted_body` (the adapter sanitizes it). */
  formattedBody?: string;
}

/**
 * Build an `m.room.message` timeline event.
 *
 * @returns the wire event `matrix-js-sdk` parses into a `MatrixEvent` whose
 *   `getSender()`/`getId()`/`getTs()`/`getContent()` feed the adapter's mapper.
 */
export function makeRoomMessageEvent(opts: MakeRoomMessageOpts): MatrixWireEvent {
  const content: MatrixMessageContent = { msgtype: "m.text", body: opts.body };
  if (opts.formattedBody !== undefined) {
    content.format = CUSTOM_HTML_FORMAT;
    content.formatted_body = opts.formattedBody;
  }
  return {
    type: ROOM_MESSAGE_TYPE,
    sender: opts.sender,
    content: content as unknown as Record<string, unknown>,
    event_id: opts.eventId,
    origin_server_ts: opts.ts,
    unsigned: { age: 0 },
  };
}

/** Options for {@link makeWireEvent}. */
export interface MakeWireEventOpts {
  /** The event type (`m.reaction`, `m.room.redaction`, `m.room.message`, …). */
  type: string;
  /** The full MXID of the sender. */
  sender: string;
  /** The event content (shape depends on `type`). */
  content: Record<string, unknown>;
  /** The homeserver-assigned event id. */
  eventId: string;
  /** The origin server timestamp (ms). */
  ts: number;
  /** The redacted event id — set only for an `m.room.redaction` event. */
  redacts?: string;
}

/**
 * Build a timeline event of an ARBITRARY type with caller-supplied content — the
 * type-agnostic sibling of {@link makeRoomMessageEvent}. Reactions, redactions,
 * and edits all ride the timeline as ordinary events with a relation-bearing
 * content, so a single builder covers them; `redacts` is threaded to the top
 * level for the redaction case.
 */
export function makeWireEvent(opts: MakeWireEventOpts): MatrixWireEvent {
  return {
    type: opts.type,
    sender: opts.sender,
    content: opts.content,
    event_id: opts.eventId,
    origin_server_ts: opts.ts,
    unsigned: { age: 0 },
    ...(opts.redacts !== undefined ? { redacts: opts.redacts } : {}),
  };
}

/**
 * Build the minimal joined-room state so the client treats the room as a room
 * the bot is in: an `m.room.create` plus a `join` membership for each member.
 */
export function makeJoinedRoomState(opts: {
  members: string[];
  ts: number;
}): MatrixWireEvent[] {
  const creator = opts.members[0] ?? MATRIX_TEST_BOT_MXID;
  const events: MatrixWireEvent[] = [
    {
      type: "m.room.create",
      sender: creator,
      content: { creator, room_version: "9" },
      event_id: `$create_${opts.ts}`,
      origin_server_ts: opts.ts,
      state_key: "",
    },
  ];
  for (const [i, mxid] of opts.members.entries()) {
    events.push({
      type: "m.room.member",
      sender: mxid,
      content: { membership: "join" },
      event_id: `$member_${opts.ts}_${i}`,
      origin_server_ts: opts.ts,
      state_key: mxid,
    });
  }
  return events;
}

/** Build an empty joined-room object (timeline + state supplied by the caller). */
export function makeJoinedRoom(opts: {
  timeline: MatrixWireEvent[];
  state: MatrixWireEvent[];
  prevBatch: string;
}): MatrixJoinedRoom {
  return {
    timeline: { events: opts.timeline, prev_batch: opts.prevBatch, limited: false },
    state: { events: opts.state },
    ephemeral: { events: [] },
    account_data: { events: [] },
    unread_notifications: { notification_count: 0, highlight_count: 0 },
  };
}

/**
 * Build an `m.direct` account-data event mapping each other-party MXID to the
 * direct room ids shared with them. The adapter reconciles a room in this map to
 * `chatType: "dm"`.
 */
export function makeDirectAccountDataEvent(
  content: Record<string, string[]>,
): MatrixWireEvent {
  return {
    type: DIRECT_ACCOUNT_DATA_TYPE,
    sender: MATRIX_TEST_BOT_MXID,
    content: content as unknown as Record<string, unknown>,
    event_id: `$mdirect_${Object.keys(content).length}`,
    origin_server_ts: 0,
  };
}

/** Build a `/sync` response from a next-batch token, global account data, and joined rooms. */
export function makeSyncResponse(opts: {
  nextBatch: string;
  accountData?: MatrixWireEvent[];
  join?: Record<string, MatrixJoinedRoom>;
}): MatrixSyncResponse {
  return {
    next_batch: opts.nextBatch,
    account_data: { events: opts.accountData ?? [] },
    rooms: { join: opts.join ?? {} },
  };
}

/** Build a `/account/whoami` response. */
export function makeWhoamiResponse(opts?: {
  userId?: string;
  deviceId?: string;
}): MatrixWhoamiResponse {
  return {
    user_id: opts?.userId ?? MATRIX_TEST_BOT_MXID,
    device_id: opts?.deviceId ?? MATRIX_TEST_DEVICE_ID,
  };
}

/** Build a `POST /login` response (a password login's returned credentials). */
export function makeLoginResponse(opts?: {
  userId?: string;
  deviceId?: string;
  accessToken?: string;
}): MatrixLoginResponse {
  return {
    user_id: opts?.userId ?? MATRIX_TEST_BOT_MXID,
    device_id: opts?.deviceId ?? MATRIX_TEST_DEVICE_ID,
    access_token: opts?.accessToken ?? "emulator-access-token",
  };
}

/** Build a `/versions` response advertising modern spec versions. */
export function makeVersionsResponse(): MatrixVersionsResponse {
  return {
    versions: ["v1.1", "v1.5", "v1.11"],
    unstable_features: {},
  };
}
