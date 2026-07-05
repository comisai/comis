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
  type SyncStateData,
} from "matrix-js-sdk";
import { systemNowMs } from "@comis/core";
import type { NormalizedMessage, ComisLogger } from "@comis/core";
import type { Result } from "@comis/shared";
import { ok, err, fromPromise } from "@comis/shared";
import {
  shouldDeliverTimelineEvent,
  isLiveDeliverableEvent,
  resolveRoomWatermark,
} from "./watermark.js";
import { decideInvite, type InviteAllowMode } from "./invite-policy.js";
import { mapMatrixEventToNormalized } from "./message-mapper.js";
import { classifyMatrixError, type MatrixErrorInput, type MatrixErrorKind } from "./errors.js";
import type { MatrixState, MatrixStateStore } from "./matrix-state.js";
import { initMatrixCrypto, type MatrixCryptoHandle } from "./crypto-store.js";

/** The Matrix event type that carries a chat message. */
const ROOM_MESSAGE_TYPE = "m.room.message";
/**
 * The Matrix WIRE event type of an encrypted message. Its clear type only becomes
 * `m.room.message` AFTER local decryption, so the server-side `/sync` filter must
 * request this wire type explicitly on the e2ee path — otherwise the homeserver
 * never returns encrypted events for the crypto engine to decrypt (E2EE-01).
 */
const ROOM_ENCRYPTED_TYPE = "m.room.encrypted";
/** Default `limit=` on the initial sync — bounds what is FETCHED (T-9). */
const DEFAULT_INITIAL_SYNC_LIMIT = 10;
/** Default per-room timeline event cap in the sync filter. */
const DEFAULT_TIMELINE_LIMIT = 20;

/** A callback the transport invokes for each delivered (post-guard) message. */
export type MatrixMessageHandler = (message: NormalizedMessage) => void | Promise<void>;

/** Fresh credentials a reauthenticate seam yields after a mid-run token expiry. */
export interface MatrixReauthResult {
  /** The freshly minted access token, persisted so a restart resumes with it. */
  accessToken: string;
  /** The device id the re-login resolved, when the homeserver reported one. */
  deviceId?: string;
}

/** A loud, secret-free health signal for the operator dashboard / event bus. */
export interface MatrixHealthSignal {
  /** The observability error kind (`auth` for a dark token). */
  errorKind: MatrixErrorKind;
  /** An operator-actionable next step naming the exact config knob. Never a secret. */
  hint: string;
}

/**
 * The raw, pre-classification signal the transport hands the adapter when an
 * inbound encrypted event fails to decrypt. The adapter's degrade decider turns
 * it into a one-per-room operator note; this carries only ids + the SDK failure
 * enum — NEVER ciphertext, a sender display name, or any key material (T-4).
 */
export interface DecryptFailureSignal {
  /** The room the undecryptable event arrived in (an id — safe to carry). */
  roomId: string;
  /** Whether e2ee was configured on this channel (`deps.e2ee`). */
  e2eeConfigured: boolean;
  /** Whether the crypto backend is live (`client.getCrypto() !== undefined`). */
  cryptoAvailable: boolean;
  /** The SDK `DecryptionFailureCode` (a content-free enum string), or null. */
  failureReason: string | null;
}

/** Inputs the `/sync` transport needs; the client is the injected seam. */
export interface MatrixClientDeps {
  /** The authenticated matrix-js-sdk client (from the auth lifecycle). */
  client: MatrixClient;
  /** Durable store for the `{ syncToken, watermarks }` resume/persist state. */
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
  /**
   * Token-expiry recovery seam. When configured (a password login is
   * available), a mid-run `M_UNKNOWN_TOKEN` triggers a re-login that yields a
   * fresh token + device id; absent, the transport emits a loud health signal
   * rather than silently going dark.
   */
  reauthenticate?: () => Promise<Result<MatrixReauthResult, Error>>;
  /** Health-signal seam for the dark-token branch (never carries a secret). */
  emitHealth?: (signal: MatrixHealthSignal) => void;
  /**
   * Wall-clock source (ms). A newly-joined room's watermark is seeded to `now()`
   * so its pre-join backlog is excluded (T-1). Defaults to the system clock;
   * injected in tests for a deterministic join moment.
   */
  now?: () => number;
  /**
   * E2EE master switch. When `true`, the transport bootstraps the crypto store
   * (`initMatrixCrypto`) BEFORE `startClient` so encrypted rooms decrypt from the
   * first sync batch. When false/undefined the crypto path is NEVER touched — the
   * lazy import boundary holds and no WASM is loaded on a plaintext install.
   */
  e2ee?: boolean;
  /**
   * The per-adapter state directory the crypto snapshot lives under (a 0600
   * sibling of the sync-state file). Required for the e2ee path; the adapter
   * always supplies it. Unused when `e2ee` is false/undefined.
   */
  stateDir?: string;
  /**
   * Recovery-key SecretRef (resolved string). Forwarded to the crypto bootstrap
   * for cross-signing; NEVER logged (mirror the accessToken discipline, T-4).
   */
  recoveryKey?: string;
  /**
   * Fail-closed decrypt seam: invoked with a raw signal when an inbound encrypted
   * event cannot be decrypted, so the adapter can degrade honestly (one note per
   * room). The event itself is always DROPPED regardless (T-5).
   */
  onDecryptFailure?: (signal: DecryptFailureSignal) => void;
  /** Test seam for the crypto bootstrap; defaults to the real `initMatrixCrypto`. */
  initCryptoImpl?: typeof initMatrixCrypto;
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

/** The Matrix `errcode` string of an SDK error, when present. */
function errcodeOf(cause: unknown): string | undefined {
  const e = cause as { errcode?: unknown } | null;
  return e !== null && typeof e.errcode === "string" ? e.errcode : undefined;
}

/**
 * Build the `/sync` filter: lazy-loaded members + a timeline scoped to message
 * events. On the e2ee path (`includeEncrypted`) the `m.room.encrypted` wire type
 * is added so the homeserver actually returns encrypted events — without it the
 * server-side filter (which keys on the wire type) excludes them and the crypto
 * engine + fail-closed branch would see nothing in a real encrypted room.
 * `initialSyncLimit` bounds the fetch; this filter trims each batch. The
 * watermark remains the correctness backstop if the filter is imperfect.
 */
function buildSyncFilter(userId: string | null, includeEncrypted: boolean): Filter {
  const filter = new Filter(userId);
  filter.setDefinition({
    room: {
      timeline: {
        types: includeEncrypted ? [ROOM_MESSAGE_TYPE, ROOM_ENCRYPTED_TYPE] : [ROOM_MESSAGE_TYPE],
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
  const now = deps.now ?? systemNowMs;

  // In-memory mirror of the persisted state; every save writes the whole object
  // so a prior deviceId / accessToken is never dropped (that would orphan E2EE
  // keys or reset the watermarks → backlog replay). `watermarks` is per room.
  let persistedState: MatrixState = { watermarks: {} };
  let syncReady = false;
  // Guards against parallel re-logins while one recovery is in flight — a
  // homeserver re-emits the sync error until the token is actually replaced.
  let reauthInFlight = false;
  // The E2EE snapshot handle, retained so stop() can flush a final snapshot.
  // Undefined on the plaintext path or when the crypto bootstrap failed (the
  // channel then runs as an UNVERIFIED device rather than going dark, D3).
  let cryptoHandle: MatrixCryptoHandle | undefined;

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

  /**
   * Advance a single room's watermark to `ts` and persist, but only when it
   * moves the room's own watermark forward (a strictly-greater bump). Keyed per
   * room so a busy room never advances a quiet room's guard.
   */
  async function bumpRoomWatermark(roomId: string, ts: number, persistField: string): Promise<void> {
    if (ts <= resolveRoomWatermark(persistedState.watermarks, roomId)) return;
    persistedState = {
      ...persistedState,
      watermarks: { ...persistedState.watermarks, [roomId]: ts },
    };
    await persistState(persistField);
  }

  /** Resolve the inviter's full MXID: the sender of the bot's own invite event. */
  function resolveInviterMxid(room: Room): string | undefined {
    const myUserId = client.getUserId();
    if (myUserId === null) return undefined;
    const sender = room.getMember(myUserId)?.events?.member?.getSender();
    return sender !== null && sender !== undefined && sender.length > 0 ? sender : undefined;
  }

  /** ClientEvent.Sync: track readiness, persist the batch token, route errors. */
  async function onSyncState(
    state: SyncState,
    _prevState: SyncState | null,
    data?: SyncStateData,
  ): Promise<void> {
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
      return;
    }

    if (state === SyncState.Error && data?.error !== undefined) {
      await handleSyncError(data.error);
    }
  }

  /** RoomEvent.Timeline: three-gate guard → map → deliver → advance watermark. */
  async function onTimeline(
    event: MatrixEvent,
    room: Room | undefined,
    toStartOfTimeline?: boolean,
  ): Promise<void> {
    if (room === undefined) return;

    // Never process the bot's own messages. They appear in the room timeline
    // two ways — a real homeserver returns them in `/sync`, and matrix-js-sdk
    // local-echoes an outbound send onto the timeline the instant it is sent —
    // and delivering one to `onMessage` (which replies) would echo the reply,
    // local-echo that, and loop until the stack overflows. Drop on the full MXID.
    if (event.getSender() === client.getUserId()) return;

    // Liveness pre-gate BEFORE decryption: drop the initial-sync backlog, paginated
    // backfill, and any at-or-behind-watermark event WITHOUT decrypting it. An
    // encrypted room's restart backlog must never be decrypted here — that would
    // fire a spurious degrade note for old, already-seen messages. The event TYPE
    // is deferred to the authoritative gate below, because an encrypted event's
    // clear type is unknown until it is decrypted.
    if (
      !isLiveDeliverableEvent({
        syncReady,
        toStartOfTimeline: toStartOfTimeline === true,
        eventTs: event.getTs(),
        watermark: resolveRoomWatermark(persistedState.watermarks, room.roomId),
      })
    ) {
      logger.debug(
        { channelType: "matrix", step: "timeline-gate" },
        "Matrix timeline event gated before delivery",
      );
      return;
    }

    // Fail-closed decrypt: an encrypted inbound event must be resolved to its CLEAR
    // type BEFORE the type gate reads it. matrix-js-sdk kicks off decryption
    // fire-and-forget and emits the timeline event synchronously while the event is
    // still `m.room.encrypted`, so the gate would drop every encrypted event unread
    // if it ran first. `decryptEventIfNeeded` is idempotent — it starts decryption
    // if it has not begun, returns the in-flight promise if it has, and resolves at
    // once if the event is already decrypted or there is no crypto backend — so
    // awaiting it covers every case with a single call. A decrypt FAILURE (crypto
    // present, decryption failed) OR an event STILL encrypted after the await (no
    // crypto backend — e2ee on but init failed) is DROPPED: we never map the
    // ciphertext or the SDK's synthesized "** Unable to decrypt **" placeholder —
    // surfacing either is the plaintext-garbage leak this branch forbids, and there
    // is deliberately no fallback to the raw wire content. A decrypted-OK event
    // falls through to the SAME mapper below, whose sanitizer already handles the
    // CLEAR content the SDK yields once the event is decrypted.
    if (event.isEncrypted()) {
      const decryptStartedAt = systemNowMs();
      await client.decryptEventIfNeeded(event);
      if (event.isDecryptionFailure() || event.getType() === ROOM_ENCRYPTED_TYPE) {
        const signal: DecryptFailureSignal = {
          roomId: room.roomId,
          e2eeConfigured: deps.e2ee === true,
          cryptoAvailable: client.getCrypto() !== undefined,
          failureReason: event.decryptionFailureReason ?? null,
        };
        deps.onDecryptFailure?.(signal);
        // Content-free: the SDK failure enum + the room id (an id) ONLY — never
        // ciphertext, the placeholder body, a sender display name, or key material.
        logger.warn(
          {
            channelType: "matrix",
            step: "decrypt",
            errorKind: "internal" as const,
            roomId: room.roomId,
            failureReason: signal.failureReason,
            hint: "Encrypted event could not be decrypted — dropped (fail-closed); the per-room degrade note carries the operator hint",
          },
          "Matrix decrypt failed — event dropped",
        );
        // Advance the watermark so the undecryptable event is not reprocessed on
        // the next sync (it would fail identically). FAIL CLOSED — never map.
        await bumpRoomWatermark(room.roomId, event.getTs(), "watermark");
        return;
      }
      logger.info(
        {
          channelType: "matrix",
          step: "decrypt",
          roomId: room.roomId,
          durationMs: systemNowMs() - decryptStartedAt,
        },
        "Matrix event decrypted",
      );
    }

    // Authoritative delivery gate on the (now-decrypted) CLEAR type: deliver only a
    // live, past-watermark `m.room.message`. Liveness was checked above; re-running
    // the full gate here also enforces the message-type requirement on the clear
    // type and re-reads the watermark, which a concurrent event may have advanced
    // during the awaited decryption.
    if (
      !shouldDeliverTimelineEvent({
        syncReady,
        toStartOfTimeline: toStartOfTimeline === true,
        eventType: event.getType(),
        eventTs: event.getTs(),
        watermark: resolveRoomWatermark(persistedState.watermarks, room.roomId),
      })
    ) {
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

    // Advance + persist THIS ROOM's watermark to the event's timestamp. Guard
    // against a regression if a later event's handler resolved first (events are
    // ordered, but delivery is async). Persist even on handler failure — the
    // event was handed off, so reprocessing it on the next sync would loop.
    await bumpRoomWatermark(room.roomId, event.getTs(), "watermark");
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
    // Seed the newly-joined room's watermark to the join moment so its pre-join
    // backlog — which /sync delivers live (syncReady, !toStartOfTimeline) right
    // after the join — is excluded. Without this seed the room defaults to 0 and
    // the bot would act on stale, pre-allowlist history (T-1).
    await bumpRoomWatermark(room.roomId, now(), "watermark-seed");

    logger.info(
      { channelType: "matrix", step: "invite-join" },
      "Matrix auto-joined room on a permitted invite",
    );
  }

  /** Route a mid-run sync error: token-expiry recovery, stale-since, or WARN. */
  async function handleSyncError(cause: unknown): Promise<void> {
    const classified = classifyMatrixError(toMatrixErrorInput(cause));
    const errcode = errcodeOf(cause);

    // The access token was revoked/expired mid-run.
    if (errcode === "M_UNKNOWN_TOKEN") {
      await recoverFromTokenExpiry();
      return;
    }

    // The homeserver rejected the sync request (e.g. a purged/stale `since`
    // token). Clear the persisted token and re-enter initial sync; the retained
    // watermark keeps that re-entry guarded (a forced full re-sync is safe
    // precisely because the watermark blocks the room backlog).
    if (errcode === "M_UNKNOWN") {
      if (persistedState.syncToken !== undefined) {
        const { syncToken: _dropped, ...rest } = persistedState;
        persistedState = rest;
        await persistState("syncToken");
      }
      // Reset the LIVE client, not just the persisted copy. The rejected `since`
      // was seeded into client.store at start, so the running SyncApi keeps
      // retrying it until the store token is cleared. Clear it and restart so the
      // process genuinely re-enters initial sync in-process; the retained
      // per-room watermarks keep that re-entry guarded against the room backlog.
      // (getSyncToken() is typed `string | null`; only the setter's type is too
      // narrow to accept the null clear.)
      (client.store as { setSyncToken(token: string | null): void }).setSyncToken(null);
      client.stopClient();
      const resumed = await fromPromise(
        client.startClient({ initialSyncLimit, filter: buildSyncFilter(client.getUserId(), deps.e2ee === true) }),
      );
      if (!resumed.ok) {
        const reclassified = classifyMatrixError(toMatrixErrorInput(resumed.error));
        logger.error(
          {
            channelType: "matrix",
            step: "sync-recover",
            errorKind: reclassified.errorKind,
            hint: reclassified.hint,
          },
          "Matrix failed to re-enter initial sync after a rejected sync position",
        );
        return;
      }
      logger.warn(
        {
          channelType: "matrix",
          step: "sync-recover",
          errorKind: classified.errorKind,
          hint: "The homeserver rejected the stored sync position; re-entered initial sync (the persisted watermarks keep this guarded)",
        },
        "Matrix sync token rejected: re-entered initial sync",
      );
      return;
    }

    logger.warn(
      {
        channelType: "matrix",
        step: "sync-recover",
        errorKind: classified.errorKind,
        hint: classified.hint,
      },
      "Matrix sync error",
    );
  }

  /** Re-login on a fresh token when a seam is configured, else signal loudly. */
  async function recoverFromTokenExpiry(): Promise<void> {
    if (deps.reauthenticate !== undefined) {
      if (reauthInFlight) return;
      reauthInFlight = true;
      try {
        const re = await deps.reauthenticate();
        if (re.ok) {
          persistedState = {
            ...persistedState,
            accessToken: re.value.accessToken,
            ...(re.value.deviceId !== undefined ? { deviceId: re.value.deviceId } : {}),
          };
          await persistState("accessToken");
          // Apply the fresh token to the LIVE client and force a clean restart so
          // /sync resumes authenticated with it. matrix-js-sdk no-ops a second
          // startClient on an already-started client and never picks up a new
          // token on its own — so stop, swap the credential in place, then
          // restart. Restarting without applying the token would silently resume
          // on the DEAD one (the secondary half of the recovery bug).
          client.stopClient();
          client.setAccessToken(re.value.accessToken);
          const resumed = await fromPromise(
            client.startClient({ initialSyncLimit, filter: buildSyncFilter(client.getUserId(), deps.e2ee === true) }),
          );
          if (resumed.ok) {
            logger.info(
              { channelType: "matrix", step: "token-recovery" },
              "Matrix access token refreshed after expiry; resumed sync",
            );
            return;
          }
          const classified = classifyMatrixError(toMatrixErrorInput(resumed.error));
          logger.error(
            {
              channelType: "matrix",
              step: "token-recovery",
              errorKind: classified.errorKind,
              hint: classified.hint,
            },
            "Matrix sync failed to resume after token refresh",
          );
          return;
        }
        // Re-login failed — fall through to the loud dark-token signal.
      } finally {
        reauthInFlight = false;
      }
    }

    // No recovery seam (or the re-login failed): never go silently dark. Name
    // the exact knob the operator must turn.
    const hint =
      "Replace channels.matrix.accessToken (it was revoked or expired), or configure channels.matrix.password for automatic re-login";
    logger.error(
      { channelType: "matrix", step: "token-recovery", errorKind: "auth" as const, hint },
      "Matrix access token rejected: the channel is dark until it is replaced",
    );
    deps.emitHealth?.({ errorKind: "auth", hint });
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

      // E2EE (E2EE-01): bootstrap the crypto store BEFORE startClient so the rust
      // engine is initialised and inbound events from the very first sync batch
      // can decrypt. A bootstrap failure is NON-FATAL (D3): log loud, run as an
      // UNVERIFIED device, and STILL start /sync — never brick the channel. The
      // handle is retained so stop() flushes a final snapshot. On the non-e2ee
      // path this branch is skipped entirely, so the lazy crypto import boundary
      // is never crossed and no WASM is loaded (D1).
      if (deps.e2ee === true && deps.stateDir !== undefined) {
        const cryptoStartedAt = systemNowMs();
        const initCrypto = deps.initCryptoImpl ?? initMatrixCrypto;
        const cryptoResult = await initCrypto(client, {
          stateDir: deps.stateDir,
          logger,
          ...(deps.recoveryKey !== undefined ? { recoveryKey: deps.recoveryKey } : {}),
        });
        if (cryptoResult.ok) {
          cryptoHandle = cryptoResult.value;
          logger.info(
            {
              channelType: "matrix",
              step: "crypto-init",
              durationMs: systemNowMs() - cryptoStartedAt,
            },
            "Matrix E2EE crypto store initialized",
          );
        } else {
          // Loud + actionable, but content-free (no error object → no chance of
          // leaking the recoveryKey or key material into the log line, T-4).
          logger.warn(
            {
              channelType: "matrix",
              step: "crypto-init",
              errorKind: "internal" as const,
              hint: "E2EE backend failed to initialize — the bot runs as an UNVERIFIED device and encrypted rooms may not decrypt. Set channels.matrix.recoveryKey or verify the device from Element",
            },
            "Matrix E2EE crypto bootstrap failed — running unverified",
          );
        }
      }

      const startedAt = systemNowMs();
      const filter = buildSyncFilter(client.getUserId(), deps.e2ee === true);
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
      // Flush a final crypto snapshot (best-effort) before tearing down /sync so
      // the device identity + Megolm keys survive the restart. The handle logs
      // its own failure; a plaintext channel has no handle to flush.
      void cryptoHandle?.stop();
      client.stopClient();
      logger.info({ channelType: "matrix", step: "sync-stop" }, "Matrix sync stopped");
    },
  };
}
