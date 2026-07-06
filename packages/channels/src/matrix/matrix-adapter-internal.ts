// SPDX-License-Identifier: Apache-2.0
/**
 * Matrix adapter internals: the pure/parameterized helpers and tuning constants
 * the `matrix-adapter.ts` controller composes. Extracted so the controller stays
 * within the per-file size cap while keeping every helper behavior-identical —
 * each is either pure (`reactionKey` / `resolveThreadRootId` / `toMatrixErrorInput`
 * / `isRoomDirect`) or takes its runtime deps explicitly (`sendEventWithRetry`),
 * so the controller's call sites are unchanged.
 *
 * @module
 */

import { Direction, EventType, type MatrixClient, type Room, type TimelineEvents } from "matrix-js-sdk";
import type {
  ComisLogger,
  ReconcileSendOutcome,
  ReconcileSendQuery,
  SendMessageOptions,
  TimerPort,
} from "@comis/core";
import { runWithContext } from "@comis/core";
import { err, fromPromise, ok, type Result } from "@comis/shared";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { classifyMatrixError, type MatrixErrorInput } from "./errors.js";
import {
  buildAttachmentContent,
  type MatrixAttachmentContent,
} from "./matrix-adapter-outbound.js";
import type { EncryptedAttachmentParts } from "./media-handler.js";

/**
 * The senderId a synthesized decrypt-degrade note carries. Deliberately NOT a
 * user MXID (no leading `@`) so it can never be mistaken for — or spoof — a real
 * room member, and the full-MXID speaker allowlist could never accidentally admit
 * it. The note bypasses the speaker gate anyway (it is delivered via fanOut).
 */
export const DEGRADE_NOTE_SENDER = "system";

/**
 * Upper bound on the per-session retained-reaction map (see {@link reactionKey}).
 * The intended caller adds and removes a reaction within one session, so the map
 * normally stays tiny; this cap guards against unbounded growth if a caller ever
 * reacts without removing. The oldest entry is evicted on overflow — a redact for
 * an evicted key then degrades to the idempotent not-found path.
 */
export const MAX_TRACKED_REACTIONS = 1000;

/**
 * The retained-reaction map key: one entry per (room, target message, emoji).
 * Serialized as a JSON array so a component that contains the old `|` delimiter
 * cannot make two distinct triples collide onto one key (which would let one
 * removeReaction redact another reaction's annotation).
 */
export function reactionKey(roomId: string, messageId: string, emoji: string): string {
  return JSON.stringify([roomId, messageId, emoji]);
}

/**
 * Parse a URL's hostname, guarded: a malformed url yields `""` rather than throwing.
 * The adapter computes the invariant media-token host ONCE with this (not per resolve)
 * so a parse slip can never later reject a `resolve()` across the port — `start()`
 * SSRF-validates the homeserver url before the media client is reachable, so on the
 * live path this returns the real host and the empty fallback is defense-in-depth.
 */
export function safeHostname(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

/**
 * Fan one delivered, gated inbound item (a message or a reaction) out to its
 * registered handlers under a FRESH request context — the traceId is minted here,
 * at the channel ingress boundary, so one inbound stitches together across
 * packages. A throwing OR rejecting handler is logged and never aborts its
 * siblings. Generic over the item type so the message and reaction paths share one
 * implementation; the caller supplies the handler list plus the secret-free
 * `hint` / `errorMessage` for the per-handler failure log (never the item body).
 */
export function fanOutToHandlers<T>(
  item: T,
  handlers: ReadonlyArray<(item: T) => void | Promise<void>>,
  deps: { now: () => number; logger: ComisLogger; hint: string; errorMessage: string },
): void {
  const traceId = randomUUID();
  void runWithContext(
    {
      traceId,
      startedAt: deps.now(),
      channelType: "matrix",
      tenantId: "default",
      trustLevel: "admin",
    },
    () => {
      const onHandlerError = (handlerErr: unknown): void => {
        deps.logger.error(
          {
            channelType: "matrix" as const,
            err: handlerErr,
            hint: deps.hint,
            errorKind: "internal" as const,
          },
          deps.errorMessage,
        );
      };
      for (const handler of handlers) {
        try {
          Promise.resolve(handler(item)).catch(onHandlerError);
        } catch (handlerErr) {
          onHandlerError(handlerErr);
        }
      }
    },
  );
}

/**
 * The `/typing` timeout the adapter tells the homeserver a typing notice lasts.
 * The orchestrator refreshes at a shorter interval so a keepalive re-sends before
 * this expiry — the notice never lapses mid-turn, and it self-clears if the
 * process dies (no dangling "typing…" indicator).
 */
export const MATRIX_TYPING_TIMEOUT_MS = 30_000;

/**
 * Retries a rate-limited chunk send makes on top of the first attempt before
 * surfacing the failure. Only a retryable classification (429 / M_LIMIT_EXCEEDED,
 * or a 5xx) re-attempts; a non-retryable error stops immediately.
 */
const MATRIX_SEND_MAX_RETRIES = 4;
/** Exponential-backoff base + ceiling (ms) for a retryable chunk resend. */
const MATRIX_SEND_BACKOFF_BASE_MS = 500;
const MATRIX_SEND_BACKOFF_CAP_MS = 8_000;

/**
 * Resolve the thread-root event id a send should relate to, if any. An explicit
 * `threadId` (the thread-root event id) wins; otherwise a `threadReply` roots the
 * thread at the replied-to event. Absent both, the send is top-level.
 */
export function resolveThreadRootId(options?: SendMessageOptions): string | undefined {
  if (typeof options?.threadId === "string" && options.threadId.length > 0) {
    return options.threadId;
  }
  if (
    options?.threadReply === true &&
    typeof options?.replyTo === "string" &&
    options.replyTo.length > 0
  ) {
    return options.replyTo;
  }
  return undefined;
}

/** Extract the classifier's normalized fields from a thrown/reported SDK error. */
export function toMatrixErrorInput(cause: unknown): MatrixErrorInput {
  const e = cause as { errcode?: unknown; httpStatus?: unknown } | null;
  const input: MatrixErrorInput = { cause };
  if (e !== null && typeof e.errcode === "string") input.errcode = e.errcode;
  if (e !== null && typeof e.httpStatus === "number") input.status = e.httpStatus;
  return input;
}

/**
 * Whether a room is a direct (1:1) conversation, read from the client's
 * `m.direct` account data (each other-party MXID maps to the direct room ids
 * shared with them). Drives the mapper's `chatType: "dm"` classification; a room
 * absent from `m.direct` is a group. Pure over the client's account-data store.
 */
export function isRoomDirect(client: MatrixClient, room: Room): boolean {
  const direct = client.getAccountData(EventType.Direct);
  if (!direct) return false;
  const content = direct.getContent() as Record<string, unknown>;
  return Object.values(content).some(
    (rooms) => Array.isArray(rooms) && (rooms as unknown[]).includes(room.roomId),
  );
}

/**
 * Run one homeserver operation, retrying a rate-limited (429) or transient (5xx)
 * failure with bounded exponential backoff on the injected timer. A non-retryable
 * failure — or an exhausted retry budget, or no injected timer — surfaces the
 * error to the caller. The backoff never uses a raw timer; with no timer the
 * operation makes a single attempt (honest degrade). Generic over the operation
 * result so every outbound action (send, react, edit, redact) shares ONE uniform
 * rate-limit policy rather than each open-coding a bare call.
 */
export async function withRateLimitRetry<T>(
  op: () => Promise<T>,
  deps: { timer?: TimerPort; logger: ComisLogger },
): Promise<Result<T, Error>> {
  for (let attempt = 0; ; attempt++) {
    const done = await fromPromise(op());
    if (done.ok) return ok(done.value);

    const classified = classifyMatrixError(toMatrixErrorInput(done.error));
    const timer = deps.timer;
    if (!classified.retryable || attempt >= MATRIX_SEND_MAX_RETRIES || timer === undefined) {
      return err(done.error);
    }
    const delayMs = Math.min(
      MATRIX_SEND_BACKOFF_BASE_MS * 2 ** attempt,
      MATRIX_SEND_BACKOFF_CAP_MS,
    );
    deps.logger.debug(
      {
        channelType: "matrix" as const,
        step: "channels-outbound",
        attempt: attempt + 1,
        durationMs: delayMs,
        hint: classified.hint,
        errorKind: classified.errorKind,
      },
      "Matrix request retry scheduled after a retryable status",
    );
    await new Promise<void>((resolve) => {
      const handle = timer.setTimeout(() => resolve(), delayMs);
      handle.unref();
    });
  }
}

/**
 * Build the failure a chunked send returns. A chunked send is NON-ATOMIC: when a
 * later chunk fails after earlier ones already landed, the raw error alone leads a
 * caller to blind-full-resend and duplicate the delivered chunks. So once
 * `chunksSent > 0`, wrap the error to name how many chunks landed and the last
 * delivered event id, and swap the hint to "resend only the remainder". With
 * nothing delivered yet, the raw error and the generic send hint pass through.
 */
export function chunkedSendFailure(
  rawError: Error,
  chunksSent: number,
  chunkTotal: number,
  lastEventId: string,
): { error: Error; hint: string } {
  if (chunksSent <= 0) {
    return {
      error: rawError,
      hint: "Verify the room id and that the bot has permission to send in it",
    };
  }
  return {
    error: new Error(
      `${rawError.message} (${chunksSent} of ${chunkTotal} chunks already delivered; last delivered event ${lastEventId})`,
    ),
    hint: "Resend only the undelivered remainder; the earlier chunks already landed (a full resend duplicates them)",
  };
}

/**
 * Build the "adapter not started" failure for an outbound method invoked before
 * `start()` has authenticated the client: a secret-free precondition WARN naming the
 * exact method to call first, plus the Error to return. Shared by every port method's
 * pre-start guard so they carry one uniform shape.
 *
 * @param cannotVerb - The action phrase, e.g. `"send"` / `"edit a message"`.
 * @param method - The method name to call first, e.g. `"sendMessage"`.
 * @param blockedNoun - The blocked-operation noun for the log, e.g. `"reaction removal"`.
 */
export function notStartedFailure(
  cannotVerb: string,
  method: string,
  blockedNoun: string,
  logger: ComisLogger,
): Error {
  const notReady = new Error(`Matrix adapter cannot ${cannotVerb} before start()`);
  logger.warn(
    {
      channelType: "matrix" as const,
      hint: `Call start() (which authenticates the client) before ${method}()`,
      errorKind: "precondition" as const,
    },
    `Matrix ${blockedNoun} blocked: adapter not started`,
  );
  return notReady;
}

/**
 * Classify a failed outbound SDK operation and emit its secret-free WARN (the
 * classifier's `hint` + `errorKind`, never a body or secret). Shared by the outbound
 * actions (react, remove, fetch, edit, delete, platform action, attachment) so each
 * failure branch carries one uniform, classified shape.
 */
export function classifiedSendWarn(cause: unknown, message: string, logger: ComisLogger): void {
  const classified = classifyMatrixError(toMatrixErrorInput(cause));
  logger.warn(
    {
      channelType: "matrix" as const,
      hint: classified.hint,
      errorKind: classified.errorKind,
    },
    message,
  );
}

/**
 * Send one already-built `m.room.message` content object through the shared
 * rate-limit retry policy ({@link withRateLimitRetry}). A thin, type-pinning
 * wrapper the chunked-send loop calls.
 */
export async function sendEventWithRetry(
  activeClient: MatrixClient,
  roomId: string,
  content: TimelineEvents[EventType.RoomMessage],
  deps: { timer?: TimerPort; logger: ComisLogger },
): Promise<Result<{ event_id: string }, Error>> {
  return withRateLimitRetry(
    () => activeClient.sendEvent(roomId, EventType.RoomMessage, content),
    deps,
  );
}

/**
 * Upload attachment bytes and send the typed media event, encrypting first in an
 * encrypted room. The room-encryption decision is the rust-crypto authoritative
 * `getCrypto()?.isEncryptionEnabledInRoom(roomId)` — undefined crypto (a
 * plaintext-only install) is treated as not encrypted. In an encrypted room the
 * bytes are encrypted through the injected `encryptAttachment` and the CIPHERTEXT
 * is uploaded, so a plaintext `content.url` is never sent in an encrypted room; the
 * encrypted-file record rides `content.file`. In a plaintext room the bytes are
 * uploaded as-is and the mxc rides `content.url`. The upload/crypto step runs inside
 * a Result wrapper so a codec or upload rejection surfaces as an `err` rather than a
 * throw, and the send itself rides the shared 429/5xx retry policy.
 *
 * Parameterized (client + already-read bytes + the crypto seam) so it lives outside
 * the adapter controller — the adapter method is a thin delegator that reads the temp
 * file and maps this Result.
 */
export async function buildAndSendAttachment(
  client: MatrixClient,
  roomId: string,
  bytes: Buffer,
  mime: string,
  fileName: string,
  deps: {
    encryptAttachment: (bytes: Buffer) => Promise<EncryptedAttachmentParts>;
    timer?: TimerPort;
    logger: ComisLogger;
  },
): Promise<Result<{ event_id: string }, Error>> {
  // The SDK's uploadContent file param is a broad body-init union; a Node Buffer
  // rides it at runtime but needs a boundary cast (the union's variance rejects it).
  type UploadFile = Parameters<MatrixClient["uploadContent"]>[0];
  const prepared = await fromPromise(
    (async (): Promise<MatrixAttachmentContent> => {
      const encrypted =
        (await client.getCrypto()?.isEncryptionEnabledInRoom(roomId)) === true;
      if (encrypted) {
        const enc = await deps.encryptAttachment(bytes);
        // The media upload endpoint is NOT end-to-end encrypted and the homeserver is
        // adversarial under the E2EE threat model. Scrub the upload metadata: hand the
        // media repo a generic octet-stream with no filename so it learns neither the
        // real MIME type nor the name. Both still reach the recipient — they ride the
        // ENCRYPTED event content (content.info.mimetype / content.body) built below.
        const uploaded = await client.uploadContent(enc.ciphertext as unknown as UploadFile, {
          type: "application/octet-stream",
        });
        return buildAttachmentContent({
          mime,
          fileName,
          sizeBytes: bytes.length,
          contentUri: uploaded.content_uri,
          encryptedInfo: enc.info,
        });
      }
      const uploaded = await client.uploadContent(bytes as unknown as UploadFile, {
        type: mime,
        name: fileName,
      });
      return buildAttachmentContent({
        mime,
        fileName,
        sizeBytes: bytes.length,
        contentUri: uploaded.content_uri,
      });
    })(),
  );
  if (!prepared.ok) return err(prepared.error);
  // The SDK types m.room.message content as a broad XOR union; the builder emits the
  // exact media shape, so cast at this single sendEvent boundary (as sendMessage does).
  return sendEventWithRetry(
    client,
    roomId,
    prepared.value as unknown as TimelineEvents[EventType.RoomMessage],
    deps,
  );
}

/**
 * Read the temp file the shared outbound handler wrote and send it as a typed media
 * event (encrypting first in an encrypted room). The adapter's `sendAttachment` is a
 * thin delegator over this — the orchestration (the read seam, the upload/encrypt via
 * {@link buildAndSendAttachment}, and the classified secret-free failure warns) lives
 * here so the controller stays within the per-file size cap. Neither the temp path
 * contents nor the bytes are ever logged. Returns the sent event id on success.
 */
export async function runSendAttachment(
  client: MatrixClient,
  roomId: string,
  attachment: { url: string; mimeType?: string; fileName?: string },
  deps: {
    readFileImpl?: (path: string) => Promise<Buffer>;
    encryptAttachment: (bytes: Buffer) => Promise<EncryptedAttachmentParts>;
    timer?: TimerPort;
    logger: ComisLogger;
  },
): Promise<Result<string, Error>> {
  const read = await fromPromise((deps.readFileImpl ?? readFile)(attachment.url));
  if (!read.ok) {
    deps.logger.warn(
      {
        channelType: "matrix" as const,
        hint: "Verify the outbound attachment temp file exists and is readable",
        errorKind: "resource" as const,
      },
      "Matrix attachment send blocked: could not read the attachment bytes",
    );
    return err(read.error);
  }
  const sent = await buildAndSendAttachment(
    client,
    roomId,
    read.value,
    attachment.mimeType ?? "application/octet-stream",
    attachment.fileName ?? "file",
    { encryptAttachment: deps.encryptAttachment, timer: deps.timer, logger: deps.logger },
  );
  if (!sent.ok) {
    classifiedSendWarn(sent.error, "Matrix attachment send failed", deps.logger);
    return err(sent.error);
  }
  return ok(sent.value.event_id);
}

/**
 * The authed media view the plugin's resolver factory closes over: the started
 * client's mxc→http URL builder (bound), its access-token reader, and the
 * invariant homeserver host. Split out of the controller's `getMediaClient`
 * accessor so the controller stays within the per-file size cap; the accessor is
 * a thin `client === undefined ? undefined : buildMediaClientView(...)` guard.
 */
export function buildMediaClientView(
  client: MatrixClient,
  homeserverHost: string,
): {
  mxcUrlToHttp: (...args: unknown[]) => string | null;
  getAccessToken: () => string | null;
  homeserverHost: string;
} {
  return {
    mxcUrlToHttp: client.mxcUrlToHttp.bind(client) as (...args: unknown[]) => string | null,
    getAccessToken: () => client.getAccessToken(),
    homeserverHost,
  };
}

/**
 * How many recent room events one send-reconcile scans, most-recent first. Wide
 * enough to cover a crash-recovery window on a busy room in a single page; if the
 * page does not reach back past the query's lower bound AND more history remains,
 * the scan reports `unresolved` rather than a false `not_sent`.
 */
const RECONCILE_SCAN_LIMIT = 100;

/**
 * Crash-recovery send oracle: answer "did this interrupted outward send actually
 * land?" by scanning the room's recent `/messages` history (backward from the live
 * end) for a BOT-AUTHORED, in-window event whose plaintext body digests to the
 * outward-ledger digest. Parameterized (client + resolved bot MXID + query +
 * logger) so it lives outside the controller; the adapter's `reconcileSend` is a
 * thin delegator over it.
 *
 * The verdict contract — the whole point of the oracle: `not_sent` is returned
 * ONLY on a fully-covered clean scan; EVERY uncertainty — no started client, an
 * unknown bot id, a history read that throws, or a page that did not reach back
 * past the window's lower bound while more history remains — is `unresolved`. A
 * false `not_sent` would drive a double-send; a false `sent` would drop a message.
 *
 * Spoof guard: a match counts only when `event.sender` is the bot's OWN resolved
 * MXID. A federated room member who happens to post the same body (and thus the
 * same digest) is never counted as our send.
 *
 * The digest is `sha256(event.content.body).slice(0,16)` over the PLAINTEXT body —
 * the raw markdown the send ledger hashed — never the HTML `formatted_body` (which
 * would never match). Content-free: only channelType/chatId/hint/errorKind are
 * logged on a failed read, never the body, the digest input, or a pagination token.
 */
export async function reconcileSendByHistoryScan(
  client: MatrixClient | undefined,
  botUserId: string,
  query: ReconcileSendQuery,
  logger: ComisLogger,
): Promise<Result<ReconcileSendOutcome, Error>> {
  // Uncertain STAYS uncertain: with no started client or an unresolved bot MXID we
  // can neither read history nor spoof-guard a match — we cannot tell, so
  // unresolved (never a guess, never a false not_sent).
  if (client === undefined || botUserId === "") {
    return ok({ kind: "unresolved" });
  }

  // Encrypted rooms cannot be reconciled by a raw history read: the low-level
  // `/messages` call yields UNDECRYPTED `m.room.encrypted` events with no plaintext
  // `body`, so the body digest can NEVER match — a covered scan would then wrongly
  // report `not_sent` and drive a duplicate replay in the flagship e2ee path. The
  // room-encryption decision is the rust-crypto authoritative
  // `isEncryptionEnabledInRoom` (the same check the attachment path uses); a probe
  // that itself throws is likewise uncertain. Either outcome → unresolved
  // (park+escalate), never a false not_sent. A plaintext-only install (crypto
  // backend absent) skips the probe and scans as before.
  const crypto = client.getCrypto();
  if (crypto !== undefined) {
    const encryptedProbe = await fromPromise(crypto.isEncryptionEnabledInRoom(query.channelId));
    if (!encryptedProbe.ok || encryptedProbe.value === true) {
      return ok({ kind: "unresolved" });
    }
  }

  // Same backward `/messages` read the history fetch uses; a null `from` token
  // pages from the room's most-recent end.
  const page = await fromPromise(
    client.createMessagesRequest(query.channelId, null, RECONCILE_SCAN_LIMIT, Direction.Backward),
  );
  if (!page.ok) {
    // A failed history read can NEVER prove absence → unresolved, never not_sent.
    classifiedSendWarn(page.error, "Matrix send reconcile history scan failed", logger);
    return ok({ kind: "unresolved" });
  }

  const chunk = page.value.chunk;
  let sawBotAuthoredInWindow = false;
  for (const event of chunk) {
    // Spoof guard: only the bot's OWN sent events count toward "did we send this".
    if (event.sender !== botUserId) continue;
    if (event.origin_server_ts < query.sentAfterMs || event.origin_server_ts > query.sentBeforeMs) {
      continue;
    }
    sawBotAuthoredInWindow = true;
    const body = (event.content as { body?: string }).body ?? "";
    const digest = createHash("sha256").update(body).digest("hex").slice(0, 16);
    if (digest === query.contentDigest) {
      return ok({ kind: "sent", platformMessageId: event.event_id });
    }
  }

  // Window-coverage rule: if older history remains AND the oldest event we read is
  // still newer than the window's lower bound, the send may sit in a page we did
  // not read — unresolved, never a false not_sent.
  const oldest = chunk[chunk.length - 1];
  const moreHistoryRemains = typeof page.value.end === "string" && page.value.end.length > 0;
  if (moreHistoryRemains && (oldest === undefined || oldest.origin_server_ts > query.sentAfterMs)) {
    return ok({ kind: "unresolved" });
  }

  // The scan fully covered the window but no body matched. The digest is over the
  // agent's raw markdown, whereas the wire body is rendered in-adapter — mention
  // markup rewritten to pill links, and oversized text split into multiple events.
  // So a landed send's body may legitimately fail to match. If the bot authored ANY
  // in-window event, one of them could be that rewritten/chunked send: we cannot
  // prove absence → unresolved (park+escalate), never a false not_sent → replay →
  // duplicate. not_sent is reserved for the reliable case — a covered scan with NO
  // bot-authored in-window event, where the send provably did not land.
  if (sawBotAuthoredInWindow) {
    return ok({ kind: "unresolved" });
  }
  return ok({ kind: "not_sent" });
}
