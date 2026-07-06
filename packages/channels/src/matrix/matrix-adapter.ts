// SPDX-License-Identifier: Apache-2.0
/**
 * Matrix Channel Adapter: a pull-model `ChannelPort` over matrix-js-sdk.
 *
 * This is the controller that composes the already-proven, separately-tested
 * pieces into the port surface the daemon wires and the emulator drives:
 *
 *  - `start()` runs two preconditions BEFORE any connection is opened — the
 *    credential presence check and the homeserver SSRF guard. A blocked
 *    or malformed homeserver errs without ever building a client. It then
 *    authenticates (token or password, validated by whoami) and starts the
 *    `/sync` transport, whose three-gate watermark and default-CLOSED invite
 *    gate keep the inbound path safe.
 *  - Inbound: the `/sync` controller hands each mapped, post-watermark message
 *    to the adapter, which applies the MXID speaker-trust gate and then fans it
 *    out to the registered handlers under a fresh request context (the traceId
 *    is minted here, at the channel ingress boundary).
 *  - Outbound: `sendMessage` renders markdown into an `m.room.message`
 *    (plaintext `body` + `org.matrix.custom.html` `formatted_body`) and sends
 *    it through the authenticated client.
 *
 * Speaker-trust vs invite-trust: the speaker gate is default-OPEN when
 * `allowFrom` is empty — the invite gate (in the `/sync` controller) is the
 * channel's default-CLOSED boundary, so the bot joins no room without a
 * permitted inviter. Once it is legitimately in a room it hears every member
 * unless the operator has populated `allowFrom` to also restrict speakers; both
 * trust decisions read the one `allowFrom` key, and both key on the full MXID.
 *
 * Everything returns across the port — no throw escapes. Secrets (token,
 * password) are never logged; failure branches carry only `errorKind` + `hint`.
 *
 * @module
 */

import { Direction, EventType, type MatrixClient, type TimelineEvents } from "matrix-js-sdk";
import * as sdk from "matrix-js-sdk";
import type {
  ChannelPort,
  ChannelStatus,
  ComisLogger,
  FetchedMessage,
  FetchMessagesOptions,
  MessageHandler,
  NormalizedMessage,
  NormalizedReaction,
  ReactionHandler,
  SendMessageOptions,
  TimerPort,
} from "@comis/core";
import { systemNowMs } from "@comis/core";
import { err, fromPromise, ok, type Result } from "@comis/shared";
import { randomUUID } from "node:crypto";
import {
  validateHomeserverUrl,
  validateMatrixCredentials,
} from "./credential-validator.js";
import { createMatrixAuth } from "./matrix-auth.js";
import {
  createMatrixClient,
  type DecryptFailureSignal,
  type MatrixClientDeps,
  type MatrixHealthSignal,
  type MatrixSyncController,
  type MatrixVerificationStatus,
} from "./matrix-client.js";
import { createMatrixStateStore } from "./matrix-state.js";
import {
  buildEditContent,
  buildReactionContent,
  buildThreadRelation,
  chunkBySerializedBytes,
  MATRIX_EVENT_BYTE_BUDGET,
  type MatrixThreadRelation,
} from "./matrix-adapter-outbound.js";
import { classifyDecryptDegrade, type DecryptDegradeKind } from "./decrypt-degrade.js";
import { classifyMatrixError } from "./errors.js";
import { extractMentions } from "./mentions.js";
import { decodeMatrixAction } from "./matrix-actions.js";

// The pure/parameterized helpers + tuning constants live in the internal module
// so this controller stays within the per-file size cap; call sites are unchanged.
import {
  DEGRADE_NOTE_SENDER,
  MAX_TRACKED_REACTIONS,
  MATRIX_TYPING_TIMEOUT_MS,
  fanOutToHandlers,
  reactionKey,
  resolveThreadRootId,
  toMatrixErrorInput,
  isRoomDirect,
  sendEventWithRetry,
} from "./matrix-adapter-internal.js";

// MAX_TRACKED_REACTIONS stays on the adapter's public surface (asserted by the
// adapter test); re-export the value the internal module now owns.
export { MAX_TRACKED_REACTIONS };

/**
 * Dependencies for the Matrix adapter. Secrets are resolved to plain strings by
 * the composition root before they reach here; the `createClientImpl` seam lets
 * a unit test drive the whole lifecycle from a fake client without a homeserver.
 */
export interface MatrixAdapterDeps {
  /** Homeserver base URL — SSRF-validated at `start()` before any connect. */
  homeserverUrl: string;
  /** Full MXID; required for password login, optional for token login. */
  userId?: string;
  /** Bot access token (token login). Never logged. */
  accessToken?: string;
  /** Password (password login). Never logged. */
  password?: string;
  /** A device id to pin, when configured. */
  deviceId?: string;
  /**
   * E2EE master switch. When `true`, the `/sync` transport bootstraps the crypto
   * store (`initMatrixCrypto`) before `startClient`; false/undefined keeps the
   * plaintext path (no WASM loaded).
   */
  e2ee?: boolean;
  /** Recovery-key SecretRef (resolved string) for cross-signing. Never logged. */
  recoveryKey?: string;
  /** Absolute per-adapter state directory (created 0700) for the durable store. */
  stateDir: string;
  /** Trusted MXIDs — the one key both the invite gate and the speaker gate read. */
  allowFrom: string[];
  /** `"allowlist"` (default) or `"open"` (admit every speaker/inviter). */
  allowMode: "allowlist" | "open";
  /** Master invite auto-join switch (still inviter-gated by allowMode/allowFrom). */
  autoJoinOnInvite: boolean;
  /** Opt-in: relax the private/loopback SSRF range block (metadata still denied). */
  allowPrivateHomeserver: boolean;
  /** Logger; failure branches emit only secret-safe `errorKind` + `hint`. */
  logger: ComisLogger;
  /** Test seam: defaults to `sdk.createClient` in production. */
  createClientImpl?: typeof sdk.createClient;
  /** Test seam for the crypto bootstrap; forwarded to the `/sync` controller. */
  initCryptoImpl?: MatrixClientDeps["initCryptoImpl"];
  /** Injected clock in ms, defaulting to systemNowMs; makes timing deterministic. */
  now?: () => number;
  /**
   * Injected timer for the bounded rate-limit (429) backoff on a chunked send.
   * OPTIONAL — mirrors the `now` seam; never a raw `setTimeout`. When absent the
   * send makes a single attempt per chunk (no retry), so a rate-limited chunk
   * surfaces its failure immediately rather than blocking on a raw timer.
   */
  timer?: TimerPort;
  /**
   * Sink for the dark-access-token health signal: when a mid-run token
   * expiry cannot auto-recover (no password), the `/sync` controller emits a
   * loud, secret-free signal naming `channels.matrix.accessToken`. The daemon
   * wires this to the event bus so `comis fleet`/doctor surface it; absent, the
   * loud ERROR log still fires. Never carries a token or message body.
   */
  emitHealth?: (signal: MatrixHealthSignal) => void;
  /**
   * Content-free decrypt-health obs seam. The adapter classifies each fail-closed
   * decrypt signal into a closed degrade `kind` (never a raw failure code, never
   * ciphertext or key material) and calls this once per fired per-room note, so
   * the daemon can bridge it to the fleet lens. Absent, the degrade note still
   * fires; only the obs mirror is skipped.
   */
  emitDecryptHealth?: (signal: { roomId: string; reason: DecryptDegradeKind }) => void;
}

/**
 * Create a Matrix adapter implementing the `ChannelPort` interface.
 *
 * @param deps - Credentials, gating config, the state directory, and seams.
 * @returns A `ChannelPort` whose `connectionMode` is `"polling"`.
 */
export function createMatrixAdapter(deps: MatrixAdapterDeps): ChannelPort {
  const now = deps.now ?? systemNowMs;
  const stateStore = createMatrixStateStore(deps.stateDir, deps.logger);
  const handlers: MessageHandler[] = [];
  const reactionHandlers: ReactionHandler[] = [];
  // Stable adapter identity; the per-message room id rides on each
  // NormalizedMessage.channelId, so the adapter reports a constant channelId.
  const channelId = "matrix";
  // Fire-once-per-room-per-cause gate for the decrypt-degrade note: roomId → the
  // last degrade kind that fired for it. A repeat of the same cause class is
  // suppressed (a busy undecryptable room emits one note per cause, not per event);
  // a changed cause class re-fires, since it is a meaningfully different operator
  // action (once per room per cause).
  const degradeFiredByRoom = new Map<string, DecryptDegradeKind>();
  // Retained reaction annotation ids so `removeReaction` can redact the bot's own
  // annotation (Matrix has no emoji-keyed unreact — you redact the annotation event
  // by id). Keyed `${roomId}|${messageId}|${emoji}` (see reactionKey). This is
  // PER-SESSION: a restart loses it, so a reaction added before a restart can no
  // longer be removed by emoji — the intended caller (the lifecycle reactor) adds
  // and removes within one session. The restart-robust alternative is a
  // `client.relations(roomId, messageId, "m.annotation", "m.reaction")` lookup of
  // the bot's own annotation; deferred until a persistent removal is required.
  // Insertion-ordered so overflow eviction drops the oldest entry.
  const reactionEventIds = new Map<string, string>();

  let connected = false;
  let startedAt: number | undefined;
  let lastError: string | undefined;
  let client: MatrixClient | undefined;
  let controller: MatrixSyncController | undefined;
  // Last-known device verification posture, surfaced on the
  // channel status. Refreshed after start and (best-effort) on each status read;
  // undefined until first read, on the plaintext path, or when crypto is absent.
  let lastVerification: MatrixVerificationStatus | undefined;

  /**
   * Refresh the cached verification posture from the `/sync` controller. Best-
   * effort: a read failure leaves the last-known value untouched rather than
   * flapping the status. Sets undefined only when the controller reports no crypto
   * surface (plaintext, or the crypto bootstrap failed).
   *
   * The read delegates into the crypto store (`isCrossSigningReady` /
   * `getDeviceVerificationStatus`), which CAN reject. That must never escape: this
   * runs inside the awaited `start()` seed AND the fire-and-forget `getStatus()`
   * refresh, so an unguarded reject would reject `start()` (violating the no-throw
   * -escapes-the-port contract) and spawn an unhandled rejection on every health
   * read. Swallow it to a secret-free debug and keep the last-known posture.
   */
  async function refreshVerification(): Promise<void> {
    if (controller === undefined) return;
    try {
      lastVerification = await controller.getVerificationStatus();
    } catch (readErr) {
      deps.logger.debug(
        { channelType: "matrix" as const, step: "verification-refresh", err: readErr },
        "Matrix verification status read failed; keeping the last-known posture",
      );
    }
  }

  /**
   * Speaker-trust gate keyed on the FULL MXID. Default-OPEN when `allowFrom` is
   * empty: the invite gate is the default-CLOSED boundary, so once the bot is
   * legitimately in a room it hears every member unless the operator has
   * populated `allowFrom` to also restrict speakers.
   */
  function isAllowedSpeaker(senderMxid: string): boolean {
    if (deps.allowMode === "open") return true;
    if (deps.allowFrom.length === 0) return true;
    return deps.allowFrom.includes(senderMxid);
  }

  /**
   * Fan a delivered, mapped, speaker-gated message out to the registered handlers
   * under a fresh request context (traceId minted at the ingress boundary). See
   * {@link fanOutToHandlers} — a throwing or rejecting handler never aborts its siblings.
   */
  function fanOut(message: NormalizedMessage): void {
    fanOutToHandlers(message, handlers, {
      now,
      logger: deps.logger,
      hint: "Check the Matrix inbound message handler",
      errorMessage: "Inbound Matrix message handler error",
    });
  }

  /**
   * The handler the `/sync` controller invokes for every delivered, mapped,
   * post-watermark message: apply the speaker gate, then fan out. A dropped
   * sender is a security-relevant WARN (never the message body / a secret).
   */
  function onSyncMessage(message: NormalizedMessage): void {
    if (!isAllowedSpeaker(message.senderId)) {
      deps.logger.warn(
        {
          channelType: "matrix" as const,
          step: "speaker-gate",
          hint: "Add the sender MXID to channels.matrix.allowFrom, or set channels.matrix.allowMode 'open', to admit this speaker",
          errorKind: "precondition" as const,
        },
        "Inbound Matrix message from non-allowlisted sender dropped",
      );
      return;
    }
    fanOut(message);
  }

  /**
   * Fan a delivered, mapped, speaker-gated reaction out to the registered reaction
   * handlers — the reaction sibling of {@link fanOut}, minting its own traceId at the
   * ingress boundary. See {@link fanOutToHandlers}; the emoji body is never logged.
   */
  function fanOutReactions(reaction: NormalizedReaction): void {
    fanOutToHandlers(reaction, reactionHandlers, {
      now,
      logger: deps.logger,
      hint: "Check the Matrix inbound reaction handler",
      errorMessage: "Inbound Matrix reaction handler error",
    });
  }

  /**
   * The handler the `/sync` controller invokes for every delivered, mapped,
   * post-watermark reaction: apply the SAME MXID speaker gate the message path
   * uses (keyed on the reactor MXID), then fan out. A dropped reactor is a
   * security-relevant WARN that never carries the emoji body.
   */
  function onSyncReaction(reaction: NormalizedReaction): void {
    if (!isAllowedSpeaker(reaction.reactorId)) {
      deps.logger.warn(
        {
          channelType: "matrix" as const,
          step: "speaker-gate",
          hint: "Add the reactor MXID to channels.matrix.allowFrom, or set channels.matrix.allowMode 'open', to admit this reactor",
          errorKind: "precondition" as const,
        },
        "Inbound Matrix reaction from non-allowlisted reactor dropped",
      );
      return;
    }
    fanOutReactions(reaction);
  }

  /**
   * Turn a raw, fail-closed decrypt signal into an HONEST, cause-branched operator
   * note. Runs the pure decider, fires at most one note per room
   * per cause class, synthesizes a system note, and delivers it via `fanOut`
   * DIRECTLY — bypassing the speaker gate, since a synthesized system note is not a
   * room speaker — so it re-enters the inbound path and reaches a session (the
   * per-session `comis explain` "why didn't the bot reply here?" answer). Also
   * mirrors a content-free health signal to the obs seam. Carries NO ciphertext,
   * raw failure code, sender display name, or key material.
   */
  function onDecryptFailure(signal: DecryptFailureSignal): void {
    const verdict = classifyDecryptDegrade(signal);
    // Once per room per cause: suppress a repeat of the same cause class.
    if (degradeFiredByRoom.get(signal.roomId) === verdict.kind) return;
    degradeFiredByRoom.set(signal.roomId, verdict.kind);

    const note: NormalizedMessage = {
      id: randomUUID(),
      channelId: signal.roomId,
      channelType: "matrix",
      senderId: DEGRADE_NOTE_SENDER,
      // The decider's fixed, secret-free operator hint — never the failure text.
      text: verdict.hint,
      timestamp: now(),
      attachments: [],
      chatType: "group",
      metadata: { matrixSystemNote: true, decryptDegradeReason: verdict.kind },
    };
    // fanOut, NOT onSyncMessage: bypass the speaker gate (a system note is not a
    // speaker) so the note re-enters the inbound path and reaches a session/agent.
    fanOut(note);
    // Content-free obs mirror: the closed kind + room id only (feeds the fleet lens).
    deps.emitDecryptHealth?.({ roomId: signal.roomId, reason: verdict.kind });
  }

  const adapter: ChannelPort = {
    get channelId(): string {
      return channelId;
    },

    get channelType(): string {
      return "matrix";
    },

    async start(): Promise<Result<void, Error>> {
      const startAt = now();

      // Precondition 1: the required credentials are present.
      const creds = validateMatrixCredentials({
        homeserverUrl: deps.homeserverUrl,
        userId: deps.userId,
        accessToken: deps.accessToken,
        password: deps.password,
      });
      if (!creds.ok) {
        lastError = creds.error.message;
        deps.logger.error(
          {
            channelType: "matrix" as const,
            err: creds.error,
            hint: "Set channels.matrix.homeserverUrl plus an accessToken (or a password + userId)",
            errorKind: "auth" as const,
          },
          "Matrix adapter start failed",
        );
        return err(creds.error);
      }

      // Precondition 2: SSRF-validate the homeserver BEFORE any connect.
      const hs = await validateHomeserverUrl(
        deps.homeserverUrl,
        deps.allowPrivateHomeserver,
        deps.logger,
      );
      if (!hs.ok) {
        lastError = hs.error.message;
        deps.logger.error(
          {
            channelType: "matrix" as const,
            err: hs.error,
            hint: "Set channels.matrix.homeserverUrl to a public https homeserver, or enable channels.matrix.allowPrivateHomeserver for a self-hosted/loopback one",
            errorKind: "validation" as const,
          },
          "Matrix adapter start failed: homeserver blocked",
        );
        return err(hs.error);
      }

      // Authenticate (token or password) into a whoami-validated client.
      const auth = createMatrixAuth({
        homeserverUrl: deps.homeserverUrl,
        userId: deps.userId,
        accessToken: deps.accessToken,
        password: deps.password,
        deviceId: deps.deviceId,
        stateStore,
        logger: deps.logger,
        createClientImpl: deps.createClientImpl,
      });
      const authed = await auth.authenticate();
      if (!authed.ok) {
        lastError = authed.error.message;
        return err(authed.error);
      }
      const authedClient = authed.value.client;
      client = authedClient;
      // The bot's own MXID (resolved by whoami/login) — the inbound mention check
      // keys on it to set the `metadata.isBotMentioned` group @-gate key. Empty when
      // the homeserver returned no user id and none was configured (mention check skipped).
      const botUserId = authed.value.userId ?? "";

      // Wire and start the `/sync` transport; speakers are gated on the way out.
      // `isDirectRoom` reads the client's `m.direct` account data so a 1:1 room
      // maps to `chatType: "dm"` (a room absent from it is a group).
      //
      // Recovery seams: wire `reauthenticate` ONLY when a password is
      // configured — a mid-run `M_UNKNOWN_TOKEN` then re-logins (fresh token, same
      // device, resumed sync); without a password the controller emits the loud
      // health signal (naming `channels.matrix.accessToken`) instead of going
      // silently dark. `emitHealth` bridges that signal to the injected sink.
      const canReauthenticate = deps.password !== undefined && deps.password.length > 0;
      controller = createMatrixClient({
        client: authedClient,
        stateStore,
        autoJoinOnInvite: deps.autoJoinOnInvite,
        allowMode: deps.allowMode,
        allowFrom: deps.allowFrom,
        onMessage: onSyncMessage,
        onReaction: onSyncReaction,
        isDirectRoom: (room) => isRoomDirect(authedClient, room),
        logger: deps.logger,
        // The bot MXID rides into the mapper so an inbound @-mention of the bot
        // sets the group @-gate key; conditionally spread so an empty id is omitted.
        ...(botUserId.length > 0 ? { botUserId } : {}),
        // E2EE threading: the crypto store bootstraps before /sync starts on the
        // e2ee path; recoveryKey rides the conditional-spread convention, and every
        // fail-closed decrypt signal is wired to the adapter's degrade decider.
        e2ee: deps.e2ee === true,
        stateDir: deps.stateDir,
        onDecryptFailure,
        ...(canReauthenticate ? { reauthenticate: () => auth.reauthenticate() } : {}),
        ...(deps.emitHealth !== undefined ? { emitHealth: deps.emitHealth } : {}),
        ...(deps.recoveryKey !== undefined ? { recoveryKey: deps.recoveryKey } : {}),
        ...(deps.initCryptoImpl !== undefined ? { initCryptoImpl: deps.initCryptoImpl } : {}),
      });
      const started = await controller.start();
      if (!started.ok) {
        controller = undefined;
        client = undefined;
        lastError = started.error.message;
        return err(started.error);
      }

      // Seed the verification posture so the first status read already reflects the
      // startup cross-signing / device-verified state.
      await refreshVerification();

      connected = true;
      startedAt = startAt;
      lastError = undefined;
      deps.logger.info(
        { channelType: "matrix" as const, durationMs: now() - startAt },
        "Matrix adapter started",
      );
      return ok(undefined);
    },

    async stop(): Promise<Result<void, Error>> {
      // Await the controller's stop so the final crypto snapshot flush (device
      // identity + Megolm keys) completes before this adapter reports stopped —
      // the daemon does `await adapter.stop()`, so this is what guarantees the
      // keys are persisted before teardown/exit.
      await controller?.stop();
      controller = undefined;
      client = undefined;
      connected = false;
      // The posture is meaningless once the channel is down; a fresh start reseeds it.
      lastVerification = undefined;
      deps.logger.info({ channelType: "matrix" as const }, "Matrix adapter stopped");
      return ok(undefined);
    },

    async sendMessage(
      roomId: string,
      text: string,
      options?: SendMessageOptions,
    ): Promise<Result<string, Error>> {
      if (client === undefined) {
        const notReady = new Error("Matrix adapter cannot send before start()");
        lastError = notReady.message;
        deps.logger.warn(
          {
            channelType: "matrix" as const,
            hint: "Call start() (which authenticates the client) before sendMessage()",
            errorKind: "precondition" as const,
          },
          "Matrix send blocked: adapter not started",
        );
        return err(notReady);
      }
      const activeClient = client;

      // Outbound mentions: rewrite `@[Name](@mxid)` markup to matrix.to pill links
      // (rendered by the shared markdown escaper) and collect the referenced MXIDs
      // to advertise as `m.mentions.user_ids`. Text with no valid mention is
      // unchanged and collects nothing.
      const { userIds: mentionUserIds, rewrittenMarkdown } = extractMentions(text);

      // A thread reply relates every chunk to the thread root. Reserve the
      // relation's serialized bytes in the chunker so each event stays within the
      // federation cap AFTER the relation is merged in.
      const threadRootId = resolveThreadRootId(options);
      const relation: MatrixThreadRelation | undefined =
        threadRootId !== undefined ? buildThreadRelation(threadRootId) : undefined;
      const relationReserveBytes =
        relation !== undefined
          ? Buffer.byteLength(JSON.stringify({ "m.relates_to": relation }))
          : 0;
      // The `m.mentions` list rides the FIRST chunk only, also merged AFTER
      // chunking — so its serialized bytes must be reserved too, or a mention-heavy
      // first event overflows the cap. Reserving on every chunk (the second chunk
      // onward carries no mentions) at worst adds one extra boundary; it is always
      // within budget, which is the invariant that matters.
      const mentionReserveBytes =
        mentionUserIds.length > 0
          ? Buffer.byteLength(JSON.stringify({ "m.mentions": { user_ids: mentionUserIds } }))
          : 0;
      const reserveBytes = relationReserveBytes + mentionReserveBytes;

      // Split by SERIALIZED bytes (not chars): the HTML formatted_body roughly
      // doubles the plaintext, so a char-bounded split overflows the cap on
      // HTML-heavy content. A fitting message stays a single event.
      const chunks = chunkBySerializedBytes(rewrittenMarkdown, MATRIX_EVENT_BYTE_BUDGET, reserveBytes);

      // Send each chunk sequentially through the rate-limit taxonomy. A chunked
      // send yields N events; the returned id is the LAST chunk's (a single-chunk
      // message returns that one id). A mid-sequence failure stops and returns err.
      // The `m.mentions` list rides the FIRST chunk only (a chunked send still
      // pings each named user exactly once).
      let lastEventId = "";
      let isFirstChunk = true;
      for (const chunk of chunks) {
        let content: Record<string, unknown> =
          relation !== undefined ? { ...chunk, "m.relates_to": relation } : { ...chunk };
        if (isFirstChunk && mentionUserIds.length > 0) {
          content = { ...content, "m.mentions": { user_ids: mentionUserIds } };
        }
        isFirstChunk = false;
        // The SDK types `m.room.message` content as a broad XOR union; the builder
        // emits the exact m.text (+ optional relation / mentions) shape, so cast at
        // this single boundary.
        const sent = await sendEventWithRetry(
          activeClient,
          roomId,
          content as unknown as TimelineEvents[EventType.RoomMessage],
          { timer: deps.timer, logger: deps.logger },
        );
        if (!sent.ok) {
          lastError = sent.error.message;
          deps.logger.warn(
            {
              channelType: "matrix" as const,
              hint: "Verify the room id and that the bot has permission to send in it",
              errorKind: "platform" as const,
            },
            "Matrix message send failed",
          );
          return err(sent.error);
        }
        lastEventId = sent.value.event_id;
      }

      lastError = undefined;
      return ok(lastEventId);
    },

    async reactToMessage(
      roomId: string,
      messageId: string,
      emoji: string,
    ): Promise<Result<void, Error>> {
      if (client === undefined) {
        const notReady = new Error("Matrix adapter cannot react before start()");
        lastError = notReady.message;
        deps.logger.warn(
          {
            channelType: "matrix" as const,
            hint: "Call start() (which authenticates the client) before reactToMessage()",
            errorKind: "precondition" as const,
          },
          "Matrix reaction blocked: adapter not started",
        );
        return err(notReady);
      }

      const content = buildReactionContent(messageId, emoji);
      // The SDK types reaction content as `ReactionEventContent`; the builder emits
      // the exact `m.annotation` shape, so cast at this single sendEvent boundary.
      const sent = await fromPromise(
        client.sendEvent(
          roomId,
          EventType.Reaction,
          content as unknown as TimelineEvents[EventType.Reaction],
        ),
      );
      if (!sent.ok) {
        lastError = sent.error.message;
        const classified = classifyMatrixError(toMatrixErrorInput(sent.error));
        deps.logger.warn(
          {
            channelType: "matrix" as const,
            hint: classified.hint,
            errorKind: classified.errorKind,
          },
          "Matrix reaction send failed",
        );
        return err(sent.error);
      }

      // Retain the annotation id so removeReaction can redact it this session.
      // Bounded: evict the oldest entry (insertion order) once the cap is reached.
      if (reactionEventIds.size >= MAX_TRACKED_REACTIONS) {
        const oldest = reactionEventIds.keys().next().value;
        if (oldest !== undefined) reactionEventIds.delete(oldest);
      }
      reactionEventIds.set(reactionKey(roomId, messageId, emoji), sent.value.event_id);
      lastError = undefined;
      return ok(undefined);
    },

    async removeReaction(
      roomId: string,
      messageId: string,
      emoji: string,
    ): Promise<Result<void, Error>> {
      if (client === undefined) {
        const notReady = new Error("Matrix adapter cannot remove a reaction before start()");
        lastError = notReady.message;
        deps.logger.warn(
          {
            channelType: "matrix" as const,
            hint: "Call start() (which authenticates the client) before removeReaction()",
            errorKind: "precondition" as const,
          },
          "Matrix reaction removal blocked: adapter not started",
        );
        return err(notReady);
      }

      const key = reactionKey(roomId, messageId, emoji);
      const reactionEventId = reactionEventIds.get(key);
      // Idempotent: with no retained annotation id (never reacted this session, or a
      // restart cleared the map) there is nothing to redact — report success.
      if (reactionEventId === undefined) {
        lastError = undefined;
        return ok(undefined);
      }

      const redacted = await fromPromise(client.redactEvent(roomId, reactionEventId));
      if (!redacted.ok) {
        lastError = redacted.error.message;
        const classified = classifyMatrixError(toMatrixErrorInput(redacted.error));
        deps.logger.warn(
          {
            channelType: "matrix" as const,
            hint: classified.hint,
            errorKind: classified.errorKind,
          },
          "Matrix reaction removal failed",
        );
        return err(redacted.error);
      }
      // Drop the retained id so a later re-react tracks a fresh annotation.
      reactionEventIds.delete(key);
      lastError = undefined;
      return ok(undefined);
    },

    async fetchMessages(
      roomId: string,
      options?: FetchMessagesOptions,
    ): Promise<Result<FetchedMessage[], Error>> {
      if (client === undefined) {
        const notReady = new Error("Matrix adapter cannot fetch messages before start()");
        lastError = notReady.message;
        deps.logger.warn(
          {
            channelType: "matrix" as const,
            hint: "Call start() (which authenticates the client) before fetchMessages()",
            errorKind: "precondition" as const,
          },
          "Matrix history fetch blocked: adapter not started",
        );
        return err(notReady);
      }

      const limit = options?.limit ?? 20;
      // A null `from` token pages from the room's most-recent end, backward. If a
      // homeserver ever rejects a null token, seed `from` from the room's
      // live-timeline backward pagination token
      // (room.getLiveTimeline().getPaginationToken(Direction.Backward)).
      const page = await fromPromise(
        client.createMessagesRequest(roomId, null, limit, Direction.Backward),
      );
      if (!page.ok) {
        lastError = page.error.message;
        const classified = classifyMatrixError(toMatrixErrorInput(page.error));
        deps.logger.warn(
          {
            channelType: "matrix" as const,
            hint: classified.hint,
            errorKind: classified.errorKind,
          },
          "Matrix history fetch failed",
        );
        return err(page.error);
      }

      const mapped: FetchedMessage[] = page.value.chunk.map((event): FetchedMessage => ({
        id: event.event_id,
        senderId: event.sender,
        text: (event.content as { body?: string }).body ?? "",
        timestamp: event.origin_server_ts,
      }));
      lastError = undefined;
      return ok(mapped);
    },

    async editMessage(
      roomId: string,
      messageId: string,
      text: string,
    ): Promise<Result<void, Error>> {
      if (client === undefined) {
        const notReady = new Error("Matrix adapter cannot edit a message before start()");
        lastError = notReady.message;
        deps.logger.warn(
          {
            channelType: "matrix" as const,
            hint: "Call start() (which authenticates the client) before editMessage()",
            errorKind: "precondition" as const,
          },
          "Matrix edit blocked: adapter not started",
        );
        return err(notReady);
      }

      // An edit sends an m.replace whose m.new_content is the authoritative new
      // message; the target event is never overwritten in place on the wire. The
      // SDK types m.room.message content as a broad XOR union, so cast the exact
      // builder shape at this single sendEvent boundary.
      const content = buildEditContent(messageId, text);
      const sent = await fromPromise(
        client.sendEvent(
          roomId,
          EventType.RoomMessage,
          content as unknown as TimelineEvents[EventType.RoomMessage],
        ),
      );
      if (!sent.ok) {
        lastError = sent.error.message;
        const classified = classifyMatrixError(toMatrixErrorInput(sent.error));
        deps.logger.warn(
          {
            channelType: "matrix" as const,
            hint: classified.hint,
            errorKind: classified.errorKind,
          },
          "Matrix message edit failed",
        );
        return err(sent.error);
      }
      // The port returns void: the replacement's own event id is discarded.
      lastError = undefined;
      return ok(undefined);
    },

    async deleteMessage(roomId: string, messageId: string): Promise<Result<void, Error>> {
      if (client === undefined) {
        const notReady = new Error("Matrix adapter cannot delete a message before start()");
        lastError = notReady.message;
        deps.logger.warn(
          {
            channelType: "matrix" as const,
            hint: "Call start() (which authenticates the client) before deleteMessage()",
            errorKind: "precondition" as const,
          },
          "Matrix delete blocked: adapter not started",
        );
        return err(notReady);
      }

      // Deleting a message is redacting the target event by its id.
      const redacted = await fromPromise(client.redactEvent(roomId, messageId));
      if (!redacted.ok) {
        lastError = redacted.error.message;
        const classified = classifyMatrixError(toMatrixErrorInput(redacted.error));
        deps.logger.warn(
          {
            channelType: "matrix" as const,
            hint: classified.hint,
            errorKind: classified.errorKind,
          },
          "Matrix message delete failed",
        );
        return err(redacted.error);
      }
      lastError = undefined;
      return ok(undefined);
    },

    onMessage(handler: MessageHandler): void {
      handlers.push(handler);
    },

    onReaction(handler: ReactionHandler): void {
      reactionHandlers.push(handler);
    },

    getStatus(): ChannelStatus {
      // Best-effort refresh for the NEXT read so the posture tracks a mid-run
      // device verification without blocking this (synchronous) status call.
      if (connected) void refreshVerification();
      return {
        connected,
        channelId,
        channelType: "matrix",
        uptime: connected && startedAt !== undefined ? now() - startedAt : undefined,
        error: lastError,
        // Long-poll `/sync`, like Telegram — stale-exempt in the health check.
        connectionMode: "polling",
        // Verification posture for e2ee channels; absent on the plaintext path.
        ...(lastVerification !== undefined ? { verification: lastVerification } : {}),
      };
    },

    async platformAction(
      action: string,
      params: Record<string, unknown>,
    ): Promise<Result<unknown, Error>> {
      const decoded = decodeMatrixAction(action, params);

      // Unknown/invalid action: err with a validation hint, regardless of whether
      // the client is up (a malformed request is a client error, not a lifecycle one).
      if (decoded.kind === "unsupported") {
        const unsupportedErr = new Error(`Unsupported action: ${action} on matrix`);
        deps.logger.warn(
          {
            channelType: "matrix" as const,
            hint: `Action '${action}' is not supported by the Matrix adapter`,
            errorKind: "validation" as const,
          },
          "Unsupported platform action",
        );
        return err(unsupportedErr);
      }

      // A supported action still needs an authenticated client.
      if (client === undefined) {
        const notReady = new Error("Matrix adapter cannot run a platform action before start()");
        lastError = notReady.message;
        deps.logger.warn(
          {
            channelType: "matrix" as const,
            hint: "Call start() (which authenticates the client) before platformAction()",
            errorKind: "precondition" as const,
          },
          "Matrix platform action blocked: adapter not started",
        );
        return err(notReady);
      }
      const activeClient = client;

      /** Classify + WARN a failed SDK action, record lastError, and err. */
      const actionFailed = (cause: Error): Result<never, Error> => {
        lastError = cause.message;
        const classified = classifyMatrixError(toMatrixErrorInput(cause));
        deps.logger.warn(
          {
            channelType: "matrix" as const,
            hint: classified.hint,
            errorKind: classified.errorKind,
          },
          "Matrix platform action failed",
        );
        return err(cause);
      };

      switch (decoded.kind) {
        case "sendTyping": {
          const sent = await fromPromise(
            activeClient.sendTyping(decoded.roomId, decoded.typing, MATRIX_TYPING_TIMEOUT_MS),
          );
          if (!sent.ok) return actionFailed(sent.error);
          lastError = undefined;
          return ok({ typing: decoded.typing });
        }
        case "join": {
          const joined = await fromPromise(activeClient.joinRoom(decoded.roomId));
          if (!joined.ok) return actionFailed(joined.error);
          lastError = undefined;
          return ok({ joined: true });
        }
        case "leave": {
          const left = await fromPromise(activeClient.leave(decoded.roomId));
          if (!left.ok) return actionFailed(left.error);
          lastError = undefined;
          return ok({ left: true });
        }
        case "setTopic": {
          const topicSet = await fromPromise(
            activeClient.setRoomTopic(decoded.roomId, decoded.topic, decoded.htmlTopic),
          );
          if (!topicSet.ok) return actionFailed(topicSet.error);
          lastError = undefined;
          return ok({ topicSet: true });
        }
        case "markRead": {
          // A read receipt needs a resident MatrixEvent, not a bare id. When the
          // target is not in the room's timeline, best-effort ok(marked:false)
          // rather than err — a missing receipt target is not an operator failure.
          const event = activeClient.getRoom(decoded.roomId)?.findEventById(decoded.eventId);
          if (event === undefined || event === null) {
            lastError = undefined;
            return ok({ marked: false });
          }
          const marked = await fromPromise(activeClient.sendReadReceipt(event));
          if (!marked.ok) return actionFailed(marked.error);
          lastError = undefined;
          return ok({ marked: true });
        }
      }
    },
  };

  return adapter;
}
