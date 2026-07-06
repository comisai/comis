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

import { EventType, type MatrixClient, type Room, type TimelineEvents } from "matrix-js-sdk";
import type { ComisLogger, SendMessageOptions, TimerPort } from "@comis/core";
import { runWithContext } from "@comis/core";
import { err, fromPromise, ok, type Result } from "@comis/shared";
import { randomUUID } from "node:crypto";
import { classifyMatrixError, type MatrixErrorInput } from "./errors.js";

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
