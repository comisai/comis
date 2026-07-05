// SPDX-License-Identifier: Apache-2.0
/**
 * Matrix `/sync` transport spine: composes the (already-proven) pure guards
 * into matrix-js-sdk event subscriptions behind an injected client seam.
 *
 * All correctness-critical logic is pure and unit-tested elsewhere — the
 * three-gate watermark guard (`shouldDeliverTimelineEvent`), the default-CLOSED
 * invite gate (`decideInvite`), the event mapper, and the error classifier.
 * This module is the WIRING: it subscribes to the SDK's sync-state, timeline,
 * and membership events and routes each through the matching pure decision,
 * owning only the persist/advance side effects and the lifecycle.
 *
 * Correctness posture:
 *  - Timeline delivery runs the watermark's three gates BEFORE mapping or
 *    delivering, so the initial-sync backlog of every joined room, paginated
 *    backfill, and any hostile re-feed of old events are all dropped (T-1).
 *  - After a delivered event the watermark is advanced to the event timestamp
 *    and persisted; a strictly-greater comparison means it is never reprocessed.
 *  - `/sync` resumes from the persisted sync token: matrix-js-sdk's default
 *    store is in-memory (it drops the token on restart), so the persisted token
 *    is seeded into the client store before `startClient` and the advanced
 *    token is persisted on each ready batch.
 *  - Invites are gated on the inviter's full MXID, never the room or a
 *    display name; a non-allowlisted or unresolved inviter is never joined.
 *
 * Injected client seam: the factory takes the authenticated `matrix-js-sdk`
 * client so the whole lifecycle is drivable from a fake EventEmitter in tests
 * without a homeserver. Everything returns across the port; no throw escapes.
 *
 * @module
 */

import {
  ClientEvent,
  RoomEvent,
  KnownMembership,
  SyncState,
  Filter,
  type MatrixClient,
  type MatrixEvent,
  type Room,
  type Membership,
} from "matrix-js-sdk";
import { systemNowMs } from "@comis/core";
import type { NormalizedMessage, ComisLogger } from "@comis/core";
import type { Result } from "@comis/shared";
import { ok, err, fromPromise } from "@comis/shared";
import { shouldDeliverTimelineEvent } from "./watermark.js";
import { decideInvite, type InviteAllowMode } from "./invite-policy.js";
import { mapMatrixEventToNormalized } from "./message-mapper.js";
import { classifyMatrixError, type MatrixErrorInput } from "./errors.js";
import type { MatrixState, MatrixStateStore } from "./matrix-state.js";

/** The Matrix event type that carries a chat message. */
const ROOM_MESSAGE_TYPE = "m.room.message";
/** Default `limit=` on the initial sync — bounds what is FETCHED (T-9). */
const DEFAULT_INITIAL_SYNC_LIMIT = 10;
/** Default per-room timeline event cap in the sync filter. */
const DEFAULT_TIMELINE_LIMIT = 20;

/** A callback the transport invokes for each delivered (post-guard) message. */
export type MatrixMessageHandler = (message: NormalizedMessage) => void | Promise<void>;

/** Inputs the `/sync` transport needs; the client is the injected seam. */
export interface MatrixClientDeps {
  /** The authenticated matrix-js-sdk client (from the auth lifecycle). */
  client: MatrixClient;
  /** Durable store for the `{ syncToken, watermark }` resume/persist state. */
  stateStore: MatrixStateStore;
  /** Invite gate: master auto-join switch. */
  autoJoinOnInvite: boolean;
  /** Invite gate: `"allowlist"` (default-closed) or `"open"`. */
  allowMode: InviteAllowMode;
  /** Invite gate: the trusted inviter MXIDs (empty = admit no inviter). */
  allowFrom: string[];
  /** Invoked for each delivered, mapped, post-watermark message. */
  onMessage: MatrixMessageHandler;
  /** Logger; failure branches emit only secret-safe `errorKind` + `hint`. */
  logger: ComisLogger;
  /** Resolve whether a room is a direct (1:1) room, for message mapping. */
  isDirectRoom?: (room: Room) => boolean;
  /** Override the initial-sync `limit=`. */
  initialSyncLimit?: number;
}

/** The `/sync` lifecycle handle the adapter drives. */
export interface MatrixSyncController {
  /** Load persisted state, wire subscriptions, and start `/sync`. */
  start(): Promise<Result<void, Error>>;
  /** Stop the `/sync` long-poll. */
  stop(): void;
}

/** Extract the classifier's normalized fields from a thrown/reported SDK error. */
function toMatrixErrorInput(cause: unknown): MatrixErrorInput {
  const e = cause as { errcode?: unknown; httpStatus?: unknown } | null;
  const input: MatrixErrorInput = { cause };
  if (e !== null && typeof e.errcode === "string") input.errcode = e.errcode;
  if (e !== null && typeof e.httpStatus === "number") input.status = e.httpStatus;
  return input;
}

/**
 * Build the `/sync` filter: lazy-loaded members + a timeline scoped to message
 * events. `initialSyncLimit` bounds the fetch; this filter trims each batch.
 * The watermark remains the correctness backstop if the filter is imperfect.
 */
function buildSyncFilter(userId: string | null): Filter {
  const filter = new Filter(userId);
  filter.setDefinition({
    room: {
      timeline: {
        types: [ROOM_MESSAGE_TYPE],
        limit: DEFAULT_TIMELINE_LIMIT,
        lazy_load_members: true,
      },
      state: { lazy_load_members: true },
    },
  });
  return filter;
}

/**
 * Create the Matrix `/sync` transport controller.
 *
 * @param deps - The authenticated client, the state store, the invite-gate
 *   config, the message handler, and a logger.
 * @returns A `start()`/`stop()` handle over the wired `/sync` lifecycle.
 */
export function createMatrixClient(deps: MatrixClientDeps): MatrixSyncController {
  const { client, stateStore, logger } = deps;
  const initialSyncLimit = deps.initialSyncLimit ?? DEFAULT_INITIAL_SYNC_LIMIT;

  // In-memory mirror of the persisted state; every save writes the whole object
  // so a prior deviceId / accessToken is never dropped (that would orphan E2EE
  // keys or reset the watermark → backlog replay).
  let persistedState: MatrixState = { watermark: 0 };
  let watermark = 0;
  let syncReady = false;

  /** Persist the current state; a write failure is loud but non-fatal. */
  async function persistState(persistField: string): Promise<void> {
    const saved = await stateStore.save({ ...persistedState });
    if (!saved.ok) {
      logger.warn(
        {
          channelType: "matrix",
          errorKind: "resource" as const,
          persistField,
          hint: "Verify the Matrix state directory is writable and has free space; the sync position was not persisted and a restart may re-sync",
        },
        "Failed to persist Matrix sync state",
      );
    }
  }

  /** Resolve the inviter's full MXID: the sender of the bot's own invite event. */
  function resolveInviterMxid(room: Room): string | undefined {
    const myUserId = client.getUserId();
    if (myUserId === null) return undefined;
    const sender = room.getMember(myUserId)?.events?.member?.getSender();
    return sender !== null && sender !== undefined && sender.length > 0 ? sender : undefined;
  }

  /** ClientEvent.Sync: track readiness and persist the advanced batch token. */
  async function onSyncState(state: SyncState): Promise<void> {
    syncReady = state === SyncState.Prepared || state === SyncState.Syncing;
    logger.debug(
      { channelType: "matrix", step: "sync-state", syncState: state },
      "Matrix sync state changed",
    );

    if (syncReady) {
      // Persist the advanced sync token per batch so a restart resumes from it.
      const token = client.store.getSyncToken();
      if (token !== null && token !== persistedState.syncToken) {
        persistedState = { ...persistedState, syncToken: token };
        await persistState("syncToken");
      }
    }
  }

  /** RoomEvent.Timeline: three-gate guard → map → deliver → advance watermark. */
  async function onTimeline(
    event: MatrixEvent,
    room: Room | undefined,
    toStartOfTimeline?: boolean,
  ): Promise<void> {
    if (room === undefined) return;

    const deliver = shouldDeliverTimelineEvent({
      syncReady,
      toStartOfTimeline: toStartOfTimeline === true,
      eventType: event.getType(),
      eventTs: event.getTs(),
      watermark,
    });
    if (!deliver) {
      logger.debug(
        { channelType: "matrix", step: "timeline-gate" },
        "Matrix timeline event gated before delivery",
      );
      return;
    }

    const isDirect = deps.isDirectRoom?.(room) ?? false;
    const message = mapMatrixEventToNormalized(event, room, { isDirect });
    if (message === null) return;

    logger.info(
      {
        channelType: "matrix",
        step: "matrix-inbound",
        messageId: message.id,
        chatId: message.channelId,
        previewLen: message.text.length,
      },
      "Inbound Matrix message accepted",
    );

    const delivered = await fromPromise(Promise.resolve(deps.onMessage(message)));
    if (!delivered.ok) {
      logger.error(
        {
          channelType: "matrix",
          errorKind: "internal" as const,
          hint: "Inspect the inbound message handler; the event was delivered but downstream processing failed",
        },
        "Matrix inbound handler failed",
      );
    }

    // Advance + persist the watermark to this event's timestamp. Guard against a
    // regression if a later event's handler resolved first (events are ordered,
    // but delivery is async). Persist even on handler failure — the event was
    // handed off, so reprocessing it on the next sync would loop indefinitely.
    const ts = event.getTs();
    if (ts > watermark) {
      watermark = ts;
      persistedState = { ...persistedState, watermark: ts };
      await persistState("watermark");
    }
  }

  /** RoomEvent.MyMembership: gate an invite on the inviter MXID, then join. */
  async function onMyMembership(room: Room, membership: Membership): Promise<void> {
    if (membership !== KnownMembership.Invite) return;

    const inviterMxid = resolveInviterMxid(room);
    if (inviterMxid === undefined) {
      logger.warn(
        {
          channelType: "matrix",
          step: "invite-gate",
          errorKind: "precondition" as const,
          hint: "The invite carried no resolvable inviter MXID; not auto-joining (the trust decision keys on the inviter identity)",
        },
        "Matrix invite ignored: inviter MXID unresolved",
      );
      return;
    }

    const decision = decideInvite({
      autoJoinOnInvite: deps.autoJoinOnInvite,
      allowMode: deps.allowMode,
      allowFrom: deps.allowFrom,
      inviterMxid,
    });

    if (decision === "ignore") {
      logger.info(
        { channelType: "matrix", step: "invite-ignore" },
        "Matrix invite left pending: inviter not permitted by the invite gate",
      );
      return;
    }

    const joined = await fromPromise(client.joinRoom(room.roomId));
    if (!joined.ok) {
      const classified = classifyMatrixError(toMatrixErrorInput(joined.error));
      logger.error(
        {
          channelType: "matrix",
          step: "invite-join",
          errorKind: classified.errorKind,
          hint: classified.hint,
        },
        "Matrix auto-join failed",
      );
      return;
    }
    logger.info(
      { channelType: "matrix", step: "invite-join" },
      "Matrix auto-joined room on a permitted invite",
    );
  }

  return {
    async start(): Promise<Result<void, Error>> {
      const loaded = await stateStore.load();
      if (!loaded.ok) {
        logger.error(
          {
            channelType: "matrix",
            errorKind: "precondition" as const,
            hint: "The Matrix state file could not be read; refusing to start (a silent reset would replay the room backlog). Repair or remove the state file",
          },
          "Matrix sync start aborted: state load failed",
        );
        return err(loaded.error);
      }
      persistedState = loaded.value;
      watermark = loaded.value.watermark;

      // Subscribe before starting so no batch is missed.
      client.on(ClientEvent.Sync, onSyncState);
      client.on(RoomEvent.Timeline, onTimeline);
      client.on(RoomEvent.MyMembership, onMyMembership);

      // Resume: seed the persisted since-token into the client store so `/sync`
      // resumes rather than forcing a full re-sync. matrix-js-sdk 41.8.0 has no
      // `since` option on startClient — the token lives in the client store.
      if (persistedState.syncToken !== undefined && persistedState.syncToken.length > 0) {
        client.store.setSyncToken(persistedState.syncToken);
      }

      const startedAt = systemNowMs();
      const filter = buildSyncFilter(client.getUserId());
      const started = await fromPromise(client.startClient({ initialSyncLimit, filter }));
      if (!started.ok) {
        const classified = classifyMatrixError(toMatrixErrorInput(started.error));
        logger.error(
          {
            channelType: "matrix",
            step: "sync-start",
            errorKind: classified.errorKind,
            hint: classified.hint,
          },
          "Matrix sync failed to start",
        );
        return err(started.error);
      }

      logger.info(
        { channelType: "matrix", step: "sync-start", durationMs: systemNowMs() - startedAt },
        "Matrix sync started",
      );
      return ok(undefined);
    },

    stop(): void {
      client.stopClient();
      logger.info({ channelType: "matrix", step: "sync-stop" }, "Matrix sync stopped");
    },
  };
}
