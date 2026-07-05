// SPDX-License-Identifier: Apache-2.0
/**
 * Google Chat EditPlace activity renderer.
 *
 * Structurally mirrors the other card-capable renderers — three parts:
 *
 *   1. `classifyGoogleChatRenderError` — maps a Chat REST failure onto the CLOSED
 *      `ActivityRenderError` union (never the send-path observability taxonomy,
 *      which reports `errorKind` / `retryable` for logging rather than a render
 *      variant). It reads the STRUCTURAL numeric `status` (and an optional
 *      `retryAfter` in seconds) off the error itself and — when the adapter
 *      wrapped the failure in `new Error(msg, { cause })` — off `error.cause`. The
 *      status is consulted ONLY to choose the variant, never rendered or logged as
 *      activity text, and no token/header/body is copied into the payload.
 *      Mapping: `429` → rate_limited; `401`/`403` → permission; `404` (message
 *      gone) → not_supported:edit (drop edits); anything else → internal.
 *
 *   2. `makeGoogleChatRenderActions` — the `ActivityRenderActions` adapter. `send`
 *      posts the placeholder and forwards the signed approval buttons when an
 *      approval frame produced them, RECORDING that message as a card frame (a
 *      plain send records nothing). `edit`/`delete` guard the optional
 *      `ChannelPort` methods and classify every failure structurally.
 *
 *      Terminal-gated card re-render (the one deliberate divergence from a
 *      text-only renderer): the shared EditPlace machine calls the SAME 2-arg
 *      `edit(id, text)` for BOTH the debounced streaming refresh (the frame text)
 *      AND the finalize success closing render (the shared `successLabel`). The
 *      port carries no discriminator and the shared machine is not this module's
 *      to change, so the render-actions recognizes the terminal render by
 *      EXACT-matching `successLabel(markers)` — reusing the shared helper so the
 *      recognized string can never drift from what the machine emits. On the
 *      terminal render of a CARD frame it patches a button-less card (the cardsV2
 *      patch) so the resolved buttons are retired in place; every other edit
 *      patches text only. Because a text-only patch leaves the card's widgets
 *      untouched, a mid-wait streaming refresh keeps Approve/Deny clickable, and a
 *      plain (non-card) completion stays text. A non-success terminal (failure /
 *      aborted) does not match the success label and is left text-only — the
 *      buttons stay inert (the downstream router rejects a stale click).
 *
 *   3. `createGoogleChatActivityRenderer` — wires the shared
 *      `createEditPlaceRenderer` (the debounce / edit / delete-after-delivery
 *      state machine). It does NOT re-implement any rendering logic and threads
 *      the resolved markers into BOTH the machine AND the render-actions so both
 *      compute the identical `successLabel(markers)`.
 *
 * 429 backoff: the channels package depends on `core` + `shared` only — no
 * observability substrate — so the buffer is a LOCAL fixed-cap latest-text slot
 * with a `retryAfterMs`-gated retry through the injected `TimerPort` (the handle
 * is `unref`'d and `cancel()`-able). It coalesces to the latest text and never
 * grows unbounded; a `not_supported` (message-gone) edit drops all further edits.
 */
import { ok, err, type Result } from "@comis/shared";
import type {
  ChannelActivityRenderer,
  ActivityRenderError,
  ChannelPort,
  TimerPort,
  TimerHandle,
  ClockPort,
  ActivityStatusMarkers,
} from "@comis/core";
import type { ActivityRenderActions } from "../shared/strategies/actions.js";
import { createEditPlaceRenderer } from "../shared/strategies/edit-place.js";
import { successLabel } from "../shared/strategies/render.js";
import {
  buildApprovalButtons,
  type SignCallbackData,
} from "../shared/strategies/approval-render.js";

/** Structural subset of a Chat REST error the classifier reads (also off `error.cause`). */
interface GoogleChatRenderErrorFields {
  /** The HTTP status of the Chat response (e.g. 429, 401, 404). */
  status?: number;
  /** Rate-limit backoff in SECONDS (the `Retry-After` header value). */
  retryAfter?: number;
  cause?: unknown;
}

/**
 * Classify a raw Chat REST failure into the closed {@link ActivityRenderError}
 * union by its STRUCTURAL numeric `status`. Reads `status`/`retryAfter` off the
 * error itself and, when the adapter wrapped the failure in
 * `new Error(msg, { cause })`, off `error.cause`. The status is consulted ONLY to
 * pick the variant — never rendered or logged, and no token/body is copied in.
 */
export function classifyGoogleChatRenderError(e: unknown): ActivityRenderError {
  const direct = (e ?? {}) as GoogleChatRenderErrorFields;
  // Prefer the status attached directly; when absent, unwrap the cause the
  // adapter attached (`new Error(msg, { cause })`).
  const ce: GoogleChatRenderErrorFields =
    direct.status === undefined && direct.cause != null
      ? ((direct.cause as GoogleChatRenderErrorFields) ?? direct)
      : direct;

  const status = ce.status;
  if (status === 429) {
    return { kind: "rate_limited", retryAfterMs: (ce.retryAfter ?? 1) * 1000 };
  }
  if (status === 401 || status === 403) {
    // Content-free: only the numeric status, never a token/header/body.
    return { kind: "permission", detail: `chat status ${status}` };
  }
  if (status === 404) {
    // The message is gone — stop editing entirely.
    return { kind: "not_supported", capability: "edit" };
  }
  return { kind: "internal", cause: e };
}

/** Optional deps for the render-actions. */
export interface GoogleChatRenderActionsDeps {
  /** Timer for the local 429 retry buffer. Omit it and a 429 simply propagates. */
  timer?: TimerPort;
  /**
   * Resolved theme markers. MUST be the same markers the shared machine is given
   * so `successLabel(markers)` here matches the finalize success closing text
   * verbatim — that exact match is how the terminal resolving render is
   * recognized (and thus when the buttons are retired).
   */
  markers?: ActivityStatusMarkers;
}

/** Latest-text retry cap — a 429 storm coalesces to the latest text; we never replay a backlog. */
const MAX_RETRY_ATTEMPTS = 4;

/**
 * Build the {@link ActivityRenderActions} for a Google Chat space. `send` records
 * a card frame when it painted buttons; `edit` retires the buttons ONLY on the
 * terminal resolving render (exact-match on `successLabel(markers)`) via a
 * button-less cardsV2 patch, and patches text only otherwise; `delete` is the
 * delete-on-success op. When a `timer` is supplied, a `rate_limited` edit
 * schedules a single bounded retry of the LATEST text.
 */
export function makeGoogleChatRenderActions(
  adapter: ChannelPort,
  channelId: string,
  deps: GoogleChatRenderActionsDeps = {},
): ActivityRenderActions {
  const { timer, markers } = deps;
  // The exact text the finalize success closing edit emits — recognizing it is
  // how the terminal resolving render is told apart from a mid-wait refresh.
  const resolveText = successLabel(markers);

  // Message ids sent as interactive cards. Only these retire buttons on resolve;
  // a plain completion is never turned into a card.
  const cardFrameIds = new Set<string>();

  // --- Local bounded 429 buffer (single latest-text slot + single retry) ---
  let pendingText: string | undefined;
  let pendingId: string | undefined;
  let retryHandle: TimerHandle | undefined;
  let retryAttempts = 0;
  let editsDropped = false;

  function cancelRetry(): void {
    if (retryHandle && !retryHandle.cancelled) retryHandle.cancel();
    retryHandle = undefined;
  }

  async function attemptEdit(id: string, text: string): Promise<Result<void, ActivityRenderError>> {
    if (editsDropped) return err({ kind: "not_supported", capability: "edit" });
    if (!adapter.editMessage) return err({ kind: "not_supported", capability: "edit" });

    // Retire the buttons ONLY on the terminal resolving render of a card frame:
    // the button-less resolved card, patched through the adapter's pinned
    // `text,cardsV2` mask, replaces the interactive widgets in place. Every other
    // edit (mid-wait streaming refresh, non-card completion, non-success terminal)
    // patches text only — the `text` mask leaves any existing card untouched.
    const isResolve = cardFrameIds.has(id) && text === resolveText;
    const r = isResolve
      ? await adapter.editMessage(channelId, id, text, { cards: [{ description: text }] })
      : await adapter.editMessage(channelId, id, text);

    if (r.ok) {
      cancelRetry();
      pendingText = undefined;
      retryAttempts = 0;
      return ok(undefined);
    }

    const classified = classifyGoogleChatRenderError(r.error);
    if (classified.kind === "not_supported") {
      // Message gone → stop editing entirely.
      editsDropped = true;
      cancelRetry();
      pendingText = undefined;
      return err(classified);
    }
    if (classified.kind === "rate_limited" && timer !== undefined) {
      pendingText = text;
      pendingId = id;
      scheduleRetry(timer, classified.retryAfterMs);
    }
    return err(classified);
  }

  function scheduleRetry(t: TimerPort, retryAfterMs: number): void {
    if (retryAttempts >= MAX_RETRY_ATTEMPTS) {
      cancelRetry();
      pendingText = undefined;
      return;
    }
    cancelRetry();
    retryAttempts += 1;
    retryHandle = t.setTimeout(() => {
      const text = pendingText;
      const id = pendingId;
      retryHandle = undefined;
      if (text === undefined || id === undefined || editsDropped) return;
      void attemptEdit(id, text);
    }, retryAfterMs);
    retryHandle.unref();
  }

  return {
    async send(text, opts): Promise<Result<string, ActivityRenderError>> {
      // The placeholder carries the signed approval buttons when an approval frame
      // produced them (each button's callback_data is the wire string
      // v1.<choice>.<shortId>.<hmac>); a non-approval / absent-signer frame
      // forwards none, leaving a bare text message. Buttons are a DISPLAY
      // affordance — the InteractiveCallbackRouter owns resolution.
      const r = await adapter.sendMessage(
        channelId,
        text,
        opts?.buttons !== undefined ? { buttons: opts.buttons } : undefined,
      );
      if (!r.ok) return err(classifyGoogleChatRenderError(r.error));
      // Record the message as a card frame only when it actually carried
      // interactive buttons — the resolve later retires them in place.
      if ((opts?.buttons?.length ?? 0) > 0) cardFrameIds.add(r.value);
      return ok(r.value);
    },

    async edit(id, text): Promise<Result<void, ActivityRenderError>> {
      return attemptEdit(id, text);
    },

    async delete(id): Promise<Result<void, ActivityRenderError>> {
      cancelRetry();
      pendingText = undefined;
      // The required delete-on-success op (gated on deliveredAtMs by the
      // EditPlace finalize).
      if (!adapter.deleteMessage) return err({ kind: "not_supported", capability: "delete" });
      const r = await adapter.deleteMessage(channelId, id);
      return r.ok ? ok(undefined) : err(classifyGoogleChatRenderError(r.error));
    },
  };
}

/**
 * Create the Google Chat EditPlace activity renderer — wires the
 * {@link createEditPlaceRenderer} with the per-space render-actions adapter. The
 * daemon composition root constructs this with its runtime `TimerPort` /
 * `ClockPort` and the space id.
 *
 * `signCallbackData` is the secret-bound signer injected at the composition root:
 * the renderer CONSUMES it to build the signed approval button rows and never
 * imports the orchestrator package. When omitted, an approval frame degrades to a
 * button-less text prompt.
 *
 * `markers` is threaded into BOTH the shared machine AND the render-actions so the
 * render-actions computes the SAME `successLabel(markers)` the finalize emits —
 * the exact-match that gates the button retire.
 */
export function createGoogleChatActivityRenderer(
  adapter: ChannelPort,
  channelId: string,
  deps: { timer: TimerPort; clock: ClockPort; signCallbackData?: SignCallbackData; markers?: ActivityStatusMarkers },
): ChannelActivityRenderer {
  const { signCallbackData } = deps;
  return createEditPlaceRenderer({
    actions: makeGoogleChatRenderActions(adapter, channelId, { timer: deps.timer, markers: deps.markers }),
    timer: deps.timer,
    clock: deps.clock,
    markers: deps.markers,
    // Approval frame → signed native button rows. The signer is the only path to
    // the callback wire; without it, no buttons are painted.
    buildButtons:
      signCallbackData === undefined
        ? undefined
        : (events) => events.flatMap((event) => buildApprovalButtons(event, signCallbackData)),
  });
}
