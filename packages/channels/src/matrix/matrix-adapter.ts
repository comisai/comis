// SPDX-License-Identifier: Apache-2.0
/**
 * Matrix Channel Adapter: a pull-model `ChannelPort` over matrix-js-sdk.
 *
 * This is the controller that composes the already-proven, separately-tested
 * pieces into the port surface the daemon wires and the emulator drives:
 *
 *  - `start()` runs two preconditions BEFORE any connection is opened — the
 *    credential presence check and the homeserver SSRF guard (T-3). A blocked
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

import { EventType, type MatrixClient, type Room, type TimelineEvents } from "matrix-js-sdk";
import * as sdk from "matrix-js-sdk";
import type {
  ChannelPort,
  ChannelStatus,
  ComisLogger,
  MessageHandler,
  NormalizedMessage,
  SendMessageOptions,
} from "@comis/core";
import { runWithContext, systemNowMs } from "@comis/core";
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
import { buildTextMessageContent } from "./matrix-adapter-outbound.js";
import { classifyDecryptDegrade, type DecryptDegradeKind } from "./decrypt-degrade.js";

/**
 * The senderId a synthesized decrypt-degrade note carries. Deliberately NOT a
 * user MXID (no leading `@`) so it can never be mistaken for — or spoof — a real
 * room member, and the full-MXID speaker allowlist could never accidentally admit
 * it. The note bypasses the speaker gate anyway (it is delivered via fanOut).
 */
const DEGRADE_NOTE_SENDER = "system";

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
  /** SEC-01 opt-in: relax the private/loopback SSRF range block (metadata still denied). */
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
   * Sink for the dark-access-token health signal (CORE-02): when a mid-run token
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
 * Whether a room is a direct (1:1) conversation, read from the client's
 * `m.direct` account data (each other-party MXID maps to the direct room ids
 * shared with them). Drives the mapper's `chatType: "dm"` classification; a room
 * absent from `m.direct` is a group. Pure over the client's account-data store.
 */
function isRoomDirect(client: MatrixClient, room: Room): boolean {
  const direct = client.getAccountData(EventType.Direct);
  if (!direct) return false;
  const content = direct.getContent() as Record<string, unknown>;
  return Object.values(content).some(
    (rooms) => Array.isArray(rooms) && (rooms as unknown[]).includes(room.roomId),
  );
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
  // Stable adapter identity; the per-message room id rides on each
  // NormalizedMessage.channelId, so the adapter reports a constant channelId.
  const channelId = "matrix";
  // Fire-once-per-room-per-cause gate for the decrypt-degrade note: roomId → the
  // last degrade kind that fired for it. A repeat of the same cause class is
  // suppressed (a busy undecryptable room emits one note per cause, not per event);
  // a changed cause class re-fires, since it is a meaningfully different operator
  // action (OQ-5: once per room per cause).
  const degradeFiredByRoom = new Map<string, DecryptDegradeKind>();

  let connected = false;
  let startedAt: number | undefined;
  let lastError: string | undefined;
  let client: MatrixClient | undefined;
  let controller: MatrixSyncController | undefined;
  // Last-known device verification posture (E2EE-04 / OBS-01), surfaced on the
  // channel status. Refreshed after start and (best-effort) on each status read;
  // undefined until first read, on the plaintext path, or when crypto is absent.
  let lastVerification: MatrixVerificationStatus | undefined;

  /**
   * Refresh the cached verification posture from the `/sync` controller. Best-
   * effort: a read failure leaves the last-known value untouched rather than
   * flapping the status. Sets undefined only when the controller reports no crypto
   * surface (plaintext, or the crypto bootstrap failed).
   */
  async function refreshVerification(): Promise<void> {
    if (controller === undefined) return;
    const status = await controller.getVerificationStatus();
    lastVerification = status;
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
   * Fan a delivered, mapped, speaker-gated message out to the registered
   * handlers under a fresh request context. The traceId is minted here — the
   * channel ingress boundary — so one inbound stitches together across packages.
   * A throwing or rejecting handler is logged and never aborts its siblings.
   */
  function fanOut(message: NormalizedMessage): void {
    const traceId = randomUUID();
    void runWithContext(
      {
        traceId,
        startedAt: now(),
        channelType: "matrix",
        tenantId: "default",
        trustLevel: "admin",
      },
      () => {
        for (const handler of handlers) {
          try {
            Promise.resolve(handler(message)).catch((handlerErr) => {
              deps.logger.error(
                {
                  channelType: "matrix" as const,
                  err: handlerErr,
                  hint: "Check the Matrix inbound message handler",
                  errorKind: "internal" as const,
                },
                "Inbound Matrix message handler error",
              );
            });
          } catch (handlerErr) {
            deps.logger.error(
              {
                channelType: "matrix" as const,
                err: handlerErr,
                hint: "Check the Matrix inbound message handler",
                errorKind: "internal" as const,
              },
              "Inbound Matrix message handler error",
            );
          }
        }
      },
    );
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
   * Turn a raw, fail-closed decrypt signal into an HONEST, cause-branched operator
   * note (INV-3, E2EE-03). Runs the pure decider, fires at most one note per room
   * per cause class, synthesizes a system note, and delivers it via `fanOut`
   * DIRECTLY — bypassing the speaker gate, since a synthesized system note is not a
   * room speaker — so it re-enters the inbound path and reaches a session (the
   * per-session `comis explain` "why didn't the bot reply here?" answer). Also
   * mirrors a content-free health signal to the obs seam. Carries NO ciphertext,
   * raw failure code, sender display name, or key material (T-4).
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

      // Precondition 2: SSRF-validate the homeserver BEFORE any connect (T-3).
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

      // Wire and start the `/sync` transport; speakers are gated on the way out.
      // `isDirectRoom` reads the client's `m.direct` account data so a 1:1 room
      // maps to `chatType: "dm"` (a room absent from it is a group).
      //
      // CORE-02 recovery seams: wire `reauthenticate` ONLY when a password is
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
        isDirectRoom: (room) => isRoomDirect(authedClient, room),
        logger: deps.logger,
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
      // startup cross-signing / device-verified state (E2EE-04 / OBS-01).
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
      controller?.stop();
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
      _options?: SendMessageOptions,
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

      const content = buildTextMessageContent(text);
      // The SDK types `m.room.message` content as a broad XOR union; the builder
      // emits the exact m.text shape, so cast to the expected content type at
      // this single boundary.
      const sent = await fromPromise(
        client.sendEvent(
          roomId,
          EventType.RoomMessage,
          content as unknown as TimelineEvents[EventType.RoomMessage],
        ),
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
      lastError = undefined;
      return ok(sent.value.event_id);
    },

    onMessage(handler: MessageHandler): void {
      handlers.push(handler);
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
      _params: Record<string, unknown>,
    ): Promise<Result<unknown, Error>> {
      const unsupported = new Error(`Unsupported action: ${action} on matrix`);
      deps.logger.warn(
        {
          channelType: "matrix" as const,
          hint: `Action '${action}' is not supported by the Matrix adapter`,
          errorKind: "validation" as const,
        },
        "Unsupported platform action",
      );
      return err(unsupported);
    },
  };

  return adapter;
}
