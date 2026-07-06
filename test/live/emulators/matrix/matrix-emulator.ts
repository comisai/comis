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
 *   - .../keys/{upload,query,claim}, .../sendToDevice/..., .../room_keys/...
 *                                          — the e2ee bootstrap surface: minimal
 *     valid shapes so a real crypto client reaches sync-ready (NOT a crypto
 *     server — no key material is generated or exchanged).
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

import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { lookup } from "node:dns/promises";
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
  makeWireEvent,
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
 * Addressing for {@link MatrixEmulator.injectRoomEvent} — a type-agnostic live
 * inbound event. Carries the caller-supplied `type` + `content` (and the optional
 * top-level `redacts` a redaction event needs), so reactions, redactions, and
 * edits can all be driven through the real adapter without a per-type verb.
 */
export interface InjectMatrixEventOpts {
  /** The room the event belongs to (the routing channelId). */
  readonly roomId: string;
  /** The sender's full MXID. */
  readonly sender: string;
  /** The event type (`m.reaction`, `m.room.redaction`, …). */
  readonly type: string;
  /** The event content (shape depends on `type`). */
  readonly content: Record<string, unknown>;
  /** An explicit `origin_server_ts` (ms). Defaults to a monotonic value. */
  readonly ts?: number;
  /** An explicit event id. Defaults to a monotonic `$evt_N`. */
  readonly eventId?: string;
  /** The redacted event id — set only for an `m.room.redaction` event. */
  readonly redacts?: string;
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
   * Queue a LIVE inbound event of an ARBITRARY type (reaction / redaction / edit):
   * delivered on the NEXT incremental `/sync` (post-PREPARED), so the adapter's
   * watermark guard admits it. The type-agnostic sibling of {@link injectRoomMessage}
   * that the reaction/edit/redaction paths drive. Returns the minted event id.
   */
  injectRoomEvent(opts: InjectMatrixEventOpts): string;
  /**
   * Add a BACKLOG inbound message to the INITIAL `/sync` batch (delivered
   * pre-PREPARED), so the adapter's watermark guard DROPS it — the backlog-not-
   * echoed proof. Must be called BEFORE the adapter starts (before the first
   * `/sync`). Returns the minted event id.
   */
  injectBacklog(opts: InjectMatrixMessageOpts): string;
  /**
   * Register downloadable media bytes for a media id. The authenticated
   * `GET .../media/download/{server}/{id}` route serves these verbatim (with the
   * given content-type) and records the `authorization` header the download hop
   * carried. Overwrites any prior registration for the id.
   */
  putMedia(mediaId: string, bytes: Buffer, contentType: string): void;
  /**
   * Register a media id whose download responds `307` to `location` (a stand-in
   * cross-host CDN). The homeserver hop still records its `authorization` header
   * before redirecting; the redirect target records its own.
   */
  putMediaRedirect(mediaId: string, location: string): void;
  /**
   * The `authorization` header the download hop for `mediaId` carried — `undefined`
   * when none arrived or the id was never downloaded. The homeserver hop IS
   * token-allowed, so a successful authed download records the bearer here.
   */
  downloadAuthorization(mediaId: string): string | undefined;
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

  // Media download surface (the resolver's inbound path).
  // - `mediaBytes`: media id → the bytes served on an authed download.
  // - `mediaRedirects`: media id → a cross-host `location` the download 307s to.
  // - `downloadAuth`: media id → the `authorization` header its download hop carried.
  const mediaBytes = new Map<string, { bytes: Buffer; contentType: string }>();
  const mediaRedirects = new Map<string, string>();
  const downloadAuth = new Map<string, string | undefined>();

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

  /** Build a live inbound event of an arbitrary type from caller-supplied content. */
  function buildGenericEvent(o: InjectMatrixEventOpts): MatrixWireEvent {
    return makeWireEvent({
      type: o.type,
      sender: o.sender,
      content: o.content,
      eventId: o.eventId ?? nextEventId(),
      ts: o.ts ?? nextTs(),
      ...(o.redacts !== undefined ? { redacts: o.redacts } : {}),
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

  // GET .../media/download/{server}/{mediaId} — the AUTHENTICATED media download.
  // matrix-js-sdk builds the `/_matrix/client/v1/media/download/{server}/{id}` path
  // when `useAuthentication` is set (the resolver passes it), so match any download
  // path and take the media id as the final segment. Records the `authorization`
  // header this hop carried (the homeserver hop IS token-allowed — a successful
  // authed download proves the bearer arrived here), then either 307s to a
  // cross-host CDN fixture or serves the registered bytes verbatim.
  backend.registerPathRoute(
    (p) => p.includes("/media/download/"),
    (ctx: RouteContext): RouteResult => {
      const segments = ctx.path.split("/");
      const mediaId = segments[segments.length - 1] ?? "";
      const auth = ctx.headers?.authorization;
      downloadAuth.set(mediaId, typeof auth === "string" ? auth : undefined);

      const redirect = mediaRedirects.get(mediaId);
      if (redirect !== undefined) {
        // 307 preserves the request method; the fetcher re-validates the target
        // host on the next hop and drops the bearer because it is a different host.
        return { status: 307, body: {}, headers: { location: redirect } };
      }
      const media = mediaBytes.get(mediaId);
      if (media === undefined) {
        return { status: 404, body: { errcode: "M_NOT_FOUND", error: "unknown media id" } };
      }
      return { status: 200, body: media.bytes, contentType: media.contentType };
    },
  );

  // -------------------------------------------------------------------------
  // Crypto-startup endpoints — the e2ee bootstrap surface. An adapter started
  // with encryption on publishes its device + one-time keys and probes device
  // keys as it prepares `/sync`; these routes answer that handshake with the
  // minimal valid shapes so the real crypto client reaches sync-ready. This is
  // NOT a crypto server: no key material is generated, stored, or exchanged and
  // no Megolm session is ever established (the real encrypted round-trip is
  // proven elsewhere with the audited WASM codec). They exist only so a real
  // e2ee client does not error against the emulator's key surface — which,
  // absent these, falls through to the catch-all `{}` that fails the rust
  // engine's response deserialization and drives an unbounded upload retry.
  // -------------------------------------------------------------------------

  // The running server-side tally of one-time keys the bot has published. It is
  // echoed on EVERY `/keys/upload` — the engine reads the returned count as "the
  // keys are registered" and stops re-uploading; a static `0`/`{}` would look
  // like the upload never took, so it would re-upload the same keys forever.
  let publishedOtkCount = 0;

  // POST .../keys/upload — record + acknowledge published keys. A device-keys-only
  // upload carries no `one_time_keys`; an OTK upload carries a map whose size is
  // the batch count. Returns the running total so the engine's OTK target is met.
  backend.registerPathRoute(
    (p) => p.includes("/keys/upload"),
    (ctx: RouteContext): RouteResult => {
      const body = parseJson(ctx.body);
      const otks = body["one_time_keys"];
      if (typeof otks === "object" && otks !== null) {
        publishedOtkCount += Object.keys(otks as Record<string, unknown>).length;
      }
      return {
        status: 200,
        body: { one_time_key_counts: { signed_curve25519: publishedOtkCount } },
      };
    },
  );

  // POST .../keys/query — no other devices exist in this loopback room; return the
  // empty-but-well-formed device map + failures so the engine's device probe
  // completes instead of choking on a missing field.
  backend.registerPathRoute(
    (p) => p.includes("/keys/query"),
    (): RouteResult => ({ status: 200, body: { device_keys: {}, failures: {} } }),
  );

  // POST .../keys/claim — there are no one-time keys to claim from a loopback stub;
  // the empty claim response is the shape the engine expects.
  backend.registerPathRoute(
    (p) => p.includes("/keys/claim"),
    (): RouteResult => ({ status: 200, body: { one_time_keys: {}, failures: {} } }),
  );

  // PUT .../sendToDevice/{type}/{txnId} — accept to-device traffic (key requests,
  // verification starts) with the empty acknowledgement a real homeserver returns.
  backend.registerPathRoute(
    (p) => p.includes("/sendToDevice/"),
    (): RouteResult => ({ status: 200, body: {} }),
  );

  // GET/PUT .../room_keys/... — no server-side key backup exists here. A real
  // homeserver answers the backup-version probe with `404 M_NOT_FOUND`, which the
  // engine reads as "no backup" and moves on; a `200 {}` would instead fail to
  // parse as a backup descriptor (missing algorithm/auth_data/version).
  backend.registerPathRoute(
    (p) => p.includes("/room_keys"),
    (): RouteResult => ({ status: 404, body: { errcode: "M_NOT_FOUND", error: "no key backup" } }),
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

    injectRoomEvent(o) {
      const event = buildGenericEvent(o);
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

    putMedia(mediaId, bytes, contentType) {
      mediaBytes.set(mediaId, { bytes, contentType });
    },

    putMediaRedirect(mediaId, location) {
      mediaRedirects.set(mediaId, location);
    },

    downloadAuthorization(mediaId) {
      return downloadAuth.get(mediaId);
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

/**
 * A loopback redirect target — a stand-in CDN on a DISTINCT host from the
 * homeserver, for the cross-host token-drop proof.
 *
 * The homeserver emulator is reached at `127.0.0.1`; this target's origin uses the
 * `localhost` hostname, which is a DIFFERENT host from the SSRF fetcher's
 * perspective (its auth allowlist is host-scoped, so the bearer is dropped on the
 * hop to `localhost`). To stay robust whether `localhost` resolves to `127.0.0.1`
 * or `::1`, it binds to the SAME address `localhost` resolves to — so the fetcher's
 * DNS-pin (which resolves `localhost` too) targets an address this server is
 * actually listening on. It records the `authorization` header the redirect hop
 * carried (it MUST be absent — the bearer was dropped) and serves fixed bytes.
 */
export interface LoopbackRedirectTarget {
  /** The origin (`http://localhost:<port>`) — a distinct host from the homeserver's `127.0.0.1`. */
  readonly origin: string;
  /** The `authorization` header the last hop carried — `undefined` (none) is the expected, secure result. */
  authorizationSeen(): string | undefined;
  /** How many requests the target received. */
  requestCount(): number;
  /** Close the listener. */
  stop(): Promise<void>;
}

/**
 * Start a {@link LoopbackRedirectTarget} serving `bytes`/`contentType`. Bind to the
 * address `localhost` resolves to so the fetcher's pinned connection lands here.
 */
export async function startLoopbackRedirectTarget(opts: {
  bytes: Buffer;
  contentType: string;
}): Promise<LoopbackRedirectTarget> {
  const { address } = await lookup("localhost");
  let authHeader: string | undefined;
  let count = 0;
  const server = createServer((req, res) => {
    count += 1;
    const auth = req.headers.authorization;
    authHeader = typeof auth === "string" ? auth : undefined;
    res.writeHead(200, {
      "content-type": opts.contentType,
      "content-length": String(opts.bytes.length),
    });
    res.end(opts.bytes);
  });
  await new Promise<void>((resolve) => server.listen(0, address, () => resolve()));
  const port = (server.address() as AddressInfo).port;
  return {
    origin: `http://localhost:${port}`,
    authorizationSeen: () => authHeader,
    requestCount: () => count,
    stop: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}
