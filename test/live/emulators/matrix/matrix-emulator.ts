// SPDX-License-Identifier: Apache-2.0
/**
 * `MatrixEmulator` — the fake Matrix homeserver the REAL production Matrix
 * adapter talks to over loopback HTTP. Built ON the generalized `http-backend`
 * base and `extends ChannelEmulator`.
 *
 * MATRIX IS A PULL CHANNEL (the Telegram/Signal shape, NOT the Teams push shape).
 * The adapter connects OUT to this emulator via `homeserverUrl` and drives the
 * Client-Server `/sync` long-poll; the emulator ANSWERS `/sync`. There is no
 * gateway ingress, no inbound signing, no `/emu/*` drive routes (those are the
 * Teams push-only surface). The rig/scenario points the real adapter at this
 * loopback `apiRoot` with `allowPrivateHomeserver:true` — the SEC-01 opt-in that
 * lets the SSRF guard reach `127.0.0.1` (a feature exercised, not bypassed).
 *
 * It composes the shared loopback server (`createHttpBackend()`) and registers
 * the Client-Server wire surface on the base's GENERALIZED `registerPathRoute` —
 * it does NOT spin up its own `node:http` server (loopback-only, 127.0.0.1).
 *
 * Wire surface (the subset of the Client-Server API the adapter consumes):
 *   - GET  /_matrix/client/versions        — the supported spec versions probe.
 *   - GET/POST .../login                   — login flows / password credentials.
 *   - GET  .../account/whoami              — token liveness validation.
 *   - GET/POST .../user/{userId}/filter    — the sync filter create/validate.
 *   - GET  .../sync                        — THE PULL HEART (see below).
 *   - PUT  .../rooms/{roomId}/send/...     — the outbound ORACLE (records sends).
 *   - POST .../join/{roomId}               — records an auto-join.
 *   - any other path                       — a `{}`/200 safety net (records the
 *     path) so client-startup probes (pushrules, capabilities, …) never 404.
 *
 * `/sync` sequencing (the watermark-guard contract):
 *   - The FIRST `/sync` (no `since`) returns the INITIAL batch — the joined rooms
 *     with any `injectBacklog` events — and a `next_batch` token so the client
 *     reaches PREPARED. The initial batch's timeline events fire BEFORE PREPARED,
 *     so the adapter's watermark guard drops them (the backlog-not-echoed proof).
 *   - Every SUBSEQUENT `/sync` (with `since`) drains the `injectRoomMessage`
 *     LIVE queue — events delivered post-PREPARED, which the guard admits. A DM
 *     room's `m.direct` account-data rides in the SAME response (account-data is
 *     processed before rooms, so the room is DM-classified before its event
 *     fires). An idle incremental `/sync` waits briefly then returns empty, so
 *     the poll loop does not spin.
 *
 * TEST-HARNESS — lives under `test/`, never `packages`; ZERO production runtime
 * change. Imports NO `@comis/*` runtime.
 *
 * @module
 */

import {
  createHttpBackend,
  type HttpBackend,
  type RouteContext,
  type RouteResult,
} from "../../harness/backends/http-backend.js";
import type { ChannelCaps, ChannelEmulator } from "../../harness/channel-emulator.js";
import { matrixCaps } from "./matrix-caps.js";
import {
  makeDirectAccountDataEvent,
  makeJoinedRoom,
  makeJoinedRoomState,
  makeLoginResponse,
  makeRoomMessageEvent,
  makeSyncResponse,
  makeVersionsResponse,
  makeWhoamiResponse,
  MATRIX_TEST_BOT_MXID,
  MATRIX_TEST_DEVICE_ID,
  type MatrixJoinedRoom,
  type MatrixMessageContent,
  type MatrixWireEvent,
} from "./matrix-payloads.js";

/** How long an idle incremental `/sync` holds before returning empty (throttle, ms). */
const IDLE_SYNC_HOLD_MS = 25;

/** Options for {@link createMatrixEmulator}. */
export interface CreateMatrixEmulatorOptions {
  /** The bot's MXID `whoami`/login reports. Defaults to {@link MATRIX_TEST_BOT_MXID}. */
  readonly userId?: string;
  /** The device id `whoami`/login reports. Defaults to {@link MATRIX_TEST_DEVICE_ID}. */
  readonly deviceId?: string;
}

/** Addressing for {@link MatrixEmulator.injectRoomMessage} / {@link MatrixEmulator.injectBacklog}. */
export interface InjectMatrixMessageOpts {
  /** The room the event belongs to (the routing channelId). */
  readonly roomId: string;
  /** The sender's full MXID (the mapper's `senderId`). */
  readonly sender: string;
  /** The plaintext body. */
  readonly body: string;
  /** An explicit `origin_server_ts` (ms). Defaults to a monotonic value. */
  readonly ts?: number;
  /** An explicit event id. Defaults to a monotonic `$evt_N`. */
  readonly eventId?: string;
  /** An optional inbound `formatted_body` (the adapter sanitizes it). */
  readonly formattedBody?: string;
  /**
   * When true, mark the room a DIRECT (1:1) conversation: the sender is recorded
   * as the other party in `m.direct`, which the adapter reconciles into
   * `chatType: "dm"`. Absent/false → a plaintext group room (`chatType: "group"`).
   */
  readonly direct?: boolean;
}

/**
 * `MatrixEmulator` — `ChannelEmulator` + the Matrix-specific inject/read verbs the
 * scenario drives. `start()`/`stop()` delegate to the http-backend base.
 *
 * A Matrix "chat" is the room id STRING; the per-room outbound ORACLE keys on it.
 */
export interface MatrixEmulator extends ChannelEmulator {
  /**
   * The SHARED loopback http-backend base this emulator composes. Exposed so a
   * rig / control API can register additional routes on the SAME loopback port.
   * The emulator owns the base's lifecycle — `start()`/`stop()` delegate to it;
   * callers MUST NOT call `backend.start()`/`stop()` directly.
   */
  readonly backend: HttpBackend;
  /**
   * Queue a LIVE inbound message: delivered on the NEXT incremental `/sync`
   * (post-PREPARED), so the adapter's watermark guard admits it. `direct:true`
   * marks the room a DM (via `m.direct`). Returns the minted event id.
   */
  injectRoomMessage(opts: InjectMatrixMessageOpts): string;
  /**
   * Add a BACKLOG inbound message to the INITIAL `/sync` batch (delivered
   * pre-PREPARED), so the adapter's watermark guard DROPS it — the backlog-not-
   * echoed proof. Must be called BEFORE the adapter starts (before the first
   * `/sync`). Returns the minted event id.
   */
  injectBacklog(opts: InjectMatrixMessageOpts): string;
  /** The recorded outbound `m.room.message` contents for a room, in send order (the ORACLE). `[]` for an unseen room. */
  sentMessages(roomId: string): readonly MatrixMessageContent[];
  /** The most recent recorded outbound content for a room, or `undefined`. */
  lastSent(roomId: string): MatrixMessageContent | undefined;
  /** The room ids the adapter auto-joined (via `POST /join/...`), in order. */
  joinedRooms(): readonly string[];
  /** Any request path that hit the catch-all safety net (client-startup probes). */
  unhandledPaths(): readonly string[];
}

/** Parse a raw JSON body defensively (a malformed body → empty object). */
function parseJson(body: string): Record<string, unknown> {
  if (body.length === 0) return {};
  try {
    const parsed = JSON.parse(body) as unknown;
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** Extract the room id from a `.../rooms/{roomId}/send/...` path (URL-decoded). */
function roomIdFromSendPath(path: string): string | undefined {
  const parts = path.split("/");
  const idx = parts.indexOf("rooms");
  if (idx < 0 || idx + 1 >= parts.length) return undefined;
  const seg = parts[idx + 1];
  return seg === undefined ? undefined : decodeURIComponent(seg);
}

/** Extract the room id from a `.../join/{roomIdOrAlias}` path (URL-decoded). */
function roomIdFromJoinPath(path: string): string | undefined {
  const parts = path.split("/");
  const idx = parts.indexOf("join");
  if (idx < 0 || idx + 1 >= parts.length) return undefined;
  const seg = parts[idx + 1];
  return seg === undefined ? undefined : decodeURIComponent(seg);
}

/** Resolve after `ms` (the idle-sync throttle). */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Create the Matrix homeserver emulator on the shared http-backend base.
 *
 * Mirrors `createSignalEmulator`: composes `createHttpBackend()`, registers the
 * Client-Server wire surface on the base's generalized path routes, and returns
 * an object literal whose `caps`/`start`/`stop` delegate to the base + the
 * per-room outbound oracle + the inject verbs.
 */
export function createMatrixEmulator(opts: CreateMatrixEmulatorOptions = {}): MatrixEmulator {
  const backend: HttpBackend = createHttpBackend();
  const userId = opts.userId ?? MATRIX_TEST_BOT_MXID;
  const deviceId = opts.deviceId ?? MATRIX_TEST_DEVICE_ID;

  // Inbound state.
  // - `backlog`: per-room events served in the INITIAL (no-since) /sync — the
  //   pre-PREPARED batch the watermark guard must drop.
  // - `liveQueue`: events served on incremental (with-since) /sync — delivered
  //   post-PREPARED, so the guard admits them. Drained once served.
  // - `directMap`: other-party MXID → the DM room ids (the `m.direct` content).
  const backlog = new Map<string, MatrixWireEvent[]>();
  const liveQueue: Array<{ roomId: string; event: MatrixWireEvent }> = [];
  const directMap = new Map<string, Set<string>>();

  // Outbound ORACLE + join log.
  const sent = new Map<string, MatrixMessageContent[]>();
  const joins: string[] = [];
  const unhandled: string[] = [];

  // Monotonic sources (deterministic, > 0 so any event clears the initial 0 watermark).
  let eventSeq = 0;
  let tsSeq = 1_700_000_000_000;
  let batchSeq = 0;
  let outboundSeq = 0;
  let stopped = false;

  function nextEventId(): string {
    eventSeq += 1;
    return `$evt_${eventSeq}`;
  }
  function nextTs(): number {
    tsSeq += 1;
    return tsSeq;
  }
  function nextBatch(): string {
    batchSeq += 1;
    return `s_${batchSeq}`;
  }

  /** The current `m.direct` account-data events (empty when no DM registered). */
  function directAccountData(): MatrixWireEvent[] {
    if (directMap.size === 0) return [];
    const content: Record<string, string[]> = {};
    for (const [other, rooms] of directMap.entries()) content[other] = [...rooms];
    return [makeDirectAccountDataEvent(content)];
  }

  /** Build a joined-room object with minimal state + the supplied timeline events. */
  function buildRoom(roomId: string, events: MatrixWireEvent[]): MatrixJoinedRoom {
    const senders = new Set<string>([userId]);
    for (const e of events) senders.add(e.sender);
    return makeJoinedRoom({
      timeline: events,
      state: makeJoinedRoomState({ members: [...senders], ts: tsSeq }),
      prevBatch: `p_${roomId}`,
    });
  }

  /** Register a room as DIRECT keyed on the other party (the sender). */
  function markDirect(roomId: string, otherMxid: string): void {
    let rooms = directMap.get(otherMxid);
    if (rooms === undefined) {
      rooms = new Set<string>();
      directMap.set(otherMxid, rooms);
    }
    rooms.add(roomId);
  }

  function buildEvent(o: InjectMatrixMessageOpts): MatrixWireEvent {
    return makeRoomMessageEvent({
      sender: o.sender,
      body: o.body,
      eventId: o.eventId ?? nextEventId(),
      ts: o.ts ?? nextTs(),
      ...(o.formattedBody !== undefined ? { formattedBody: o.formattedBody } : {}),
    });
  }

  // -------------------------------------------------------------------------
  // Register the Client-Server wire surface on the generalized http-backend base.
  // Specific routes FIRST; the catch-all safety net LAST (registration order is
  // preserved, and specific matchers win).
  // -------------------------------------------------------------------------

  // GET /_matrix/client/versions — the supported spec versions probe.
  backend.registerPathRoute(
    (p) => p === "/_matrix/client/versions",
    (): RouteResult => ({ status: 200, body: makeVersionsResponse() }),
  );

  // GET/POST .../login — GET returns the login flows; POST returns credentials.
  backend.registerPathRoute(
    (p) => p.endsWith("/login"),
    (ctx: RouteContext): RouteResult => {
      if (ctx.httpMethod === "GET") {
        return { status: 200, body: { flows: [{ type: "m.login.password" }] } };
      }
      return { status: 200, body: makeLoginResponse({ userId, deviceId }) };
    },
  );

  // GET .../account/whoami — validates the token is live.
  backend.registerPathRoute(
    (p) => p.endsWith("/account/whoami"),
    (): RouteResult => ({ status: 200, body: makeWhoamiResponse({ userId, deviceId }) }),
  );

  // GET/POST .../user/{userId}/filter[/{filterId}] — create returns a filter id;
  // validate (GET a specific id) returns a filter definition.
  backend.registerPathRoute(
    (p) => /\/user\/[^/]+\/filter(\/[^/]+)?$/.test(p),
    (ctx: RouteContext): RouteResult => {
      if (ctx.httpMethod === "POST") return { status: 200, body: { filter_id: "0" } };
      return { status: 200, body: { room: { timeline: { limit: 20 } } } };
    },
  );

  // GET .../sync — THE PULL HEART.
  backend.registerPathRoute(
    (p) => p.endsWith("/sync"),
    async (ctx: RouteContext): Promise<RouteResult> => {
      const params = new URLSearchParams(ctx.query);
      const since = params.get("since");

      // INITIAL sync (no since): serve the backlog batch so the client reaches
      // PREPARED. These timeline events fire pre-PREPARED → dropped by the guard.
      if (since === null || since.length === 0) {
        const join: Record<string, MatrixJoinedRoom> = {};
        for (const [roomId, events] of backlog.entries()) {
          join[roomId] = buildRoom(roomId, events);
        }
        return {
          status: 200,
          body: makeSyncResponse({
            nextBatch: nextBatch(),
            accountData: directAccountData(),
            join,
          }),
        };
      }

      // INCREMENTAL sync (with since): drain the LIVE queue (post-PREPARED).
      if (liveQueue.length > 0) {
        const byRoom = new Map<string, MatrixWireEvent[]>();
        for (const { roomId, event } of liveQueue.splice(0)) {
          const list = byRoom.get(roomId) ?? [];
          list.push(event);
          byRoom.set(roomId, list);
        }
        const join: Record<string, MatrixJoinedRoom> = {};
        for (const [roomId, events] of byRoom.entries()) {
          join[roomId] = buildRoom(roomId, events);
        }
        return {
          status: 200,
          body: makeSyncResponse({
            nextBatch: nextBatch(),
            // Account-data (m.direct) rides ALONGSIDE the room event; it is
            // processed before rooms, so the DM room is classified before its
            // timeline event fires.
            accountData: directAccountData(),
            join,
          }),
        };
      }

      // Idle: hold briefly (throttle the poll) then return an empty batch.
      if (!stopped) await delay(IDLE_SYNC_HOLD_MS);
      return { status: 200, body: makeSyncResponse({ nextBatch: nextBatch() }) };
    },
  );

  // PUT .../rooms/{roomId}/send/{eventType}/{txnId} — the outbound ORACLE.
  backend.registerPathRoute(
    (p) => p.includes("/rooms/") && p.includes("/send/"),
    (ctx: RouteContext): RouteResult => {
      const roomId = roomIdFromSendPath(ctx.path);
      if (roomId === undefined) {
        return { status: 404, body: { errcode: "M_NOT_FOUND", error: "not a send path" } };
      }
      const content = parseJson(ctx.body) as unknown as MatrixMessageContent;
      const log = sent.get(roomId) ?? [];
      log.push(content);
      sent.set(roomId, log);
      outboundSeq += 1;
      return { status: 200, body: { event_id: `$out_${outboundSeq}` } };
    },
  );

  // POST .../join/{roomIdOrAlias} — records an auto-join.
  backend.registerPathRoute(
    (p) => /\/join\/[^/]+$/.test(p),
    (ctx: RouteContext): RouteResult => {
      const roomId = roomIdFromJoinPath(ctx.path);
      if (roomId === undefined) {
        return { status: 404, body: { errcode: "M_NOT_FOUND", error: "not a join path" } };
      }
      joins.push(roomId);
      return { status: 200, body: { room_id: roomId } };
    },
  );

  // Catch-all safety net (registered LAST): client-startup probes (pushrules,
  // capabilities, keys, presence, …) get a benign `{}`/200 instead of a 404 that
  // could derail startup. Records the path for diagnostics.
  backend.registerPathRoute(
    () => true,
    (ctx: RouteContext): RouteResult => {
      unhandled.push(ctx.path);
      return { status: 200, body: {} };
    },
  );

  const emulator: MatrixEmulator = {
    caps: matrixCaps satisfies ChannelCaps,
    backend,

    start() {
      stopped = false;
      return backend.start();
    },

    async stop() {
      stopped = true;
      await backend.stop();
    },

    injectRoomMessage(o) {
      const event = buildEvent(o);
      if (o.direct === true) markDirect(o.roomId, o.sender);
      liveQueue.push({ roomId: o.roomId, event });
      return event.event_id;
    },

    injectBacklog(o) {
      const event = buildEvent(o);
      if (o.direct === true) markDirect(o.roomId, o.sender);
      const list = backlog.get(o.roomId) ?? [];
      list.push(event);
      backlog.set(o.roomId, list);
      return event.event_id;
    },

    sentMessages(roomId) {
      return sent.get(roomId) ?? [];
    },

    lastSent(roomId) {
      const log = sent.get(roomId);
      return log && log.length > 0 ? log[log.length - 1] : undefined;
    },

    joinedRooms() {
      return joins;
    },

    unhandledPaths() {
      return unhandled;
    },
  };

  return emulator;
}
