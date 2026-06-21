// SPDX-License-Identifier: Apache-2.0
/**
 * `control-api` — the generic, channel-agnostic `/control/*` driver surface +
 * an in-process typed client + the reply-wait primitive (RIG-03 + SEC-01,
 * Phase 204).
 *
 * This is THE driver surface. The rig (Plan 05) and the round-trip scenario
 * inject a message and await the reply through this one mechanism; Phase 205's
 * `chan`/`tg` CLI is a thin HTTP client over the SAME handlers, and channel #2
 * (Phase 209) reuses it unchanged. The control API is registered on the Plan-01
 * `http-backend` base (via `registerControlRoute`) so it shares ONE loopback
 * port with the Bot API — namespaced under `/control/` so it can never be
 * confused with the `/bot<token>/<method>` matcher (SEC-01 / T-204-10). Loopback
 * bind (127.0.0.1 only) is inherited from the base; there is no bespoke server.
 *
 * The design (§4.6): the HTTP route is the canonical surface; the in-process TS
 * path is "just a typed client that calls the same handlers without a socket".
 * So each route is factored into a HANDLER FUNCTION that the HTTP dispatch AND
 * the in-proc `ControlClient` both invoke — behavioral parity is STRUCTURAL, not
 * a duplicated re-implementation. The unit test asserts an in-process inject +
 * wait round-trips identically to the HTTP path.
 *
 * Scope (Phase 204): the MINIMAL route set —
 *   - POST /control/chats/:id/messages   { fromUserId, text, opts? } → { messageId }
 *   - GET  /control/chats/:id/outbound    ?afterMessageId&waitMs       → RecordedOutbound[]
 * The full §4.6 table (media/location/reactions/callbacks/edits/service/reset/
 * faults) is Phases 205-208. The dispatch is a route map so adding them later is
 * additive; only these two are implemented for 204.
 *
 * The reply-wait primitive (GET …/outbound) is the PRIME DIRECTIVE (I5): it
 * blocks up to `waitMs` for a NEW outbound whose message id is `> afterMessageId`
 * and, on TIMEOUT, returns an explicit EMPTY result — an honest "no reply within
 * Nms", NEVER a fabricated success. The caller can always distinguish "no reply"
 * from "a reply". For 204 "the reply = the first outbound with message id >
 * afterMessageId" (Open-Q3 — sufficient for one text reply).
 *
 * TEST-HARNESS — lives under `test/`, never `packages`; ZERO production code
 * change. `test/` is outside every `packages` source-tree ESLint/architecture
 * rule, so `setTimeout` / dynamic body reads / raw `throw` are fine here.
 *
 * @module
 */

import type { ReactionTypeEmoji } from "grammy/types";
import type {
  ControlRouteContext,
  HttpBackend,
  RouteResult,
} from "./backends/http-backend.js";
// The LIFTED channel-agnostic oracle types come from the harness/ layer (the
// foundation-fix, CHAN2-02): `RecordedOutbound` (the subset the generic control
// surface + the dual oracle consume) and `MediaKind` (already shared in
// channel-emulator.ts). A second channel (Phase 209) feeds these with NO
// telegram dependency.
import type { RecordedOutbound } from "./recorded-outbound.js";
import type { MediaKind } from "./channel-emulator.js";
// The telegram-ONLY route shapes (media/location/fault) the control-api's
// Phase-207/208 routes use — these are NOT part of the channel-agnostic oracle
// surface (the Signal send/react/explain proof does not exercise them), so they
// stay scoped to the telegram emulator until a second channel needs them.
import type { FailOpts, MediaMeta, PlaceInput, TgFault } from "../emulators/telegram/tg-emulator.js";

/**
 * The closed media-kind union as a runtime set, so the media route can validate
 * an arbitrary request `kind` string at the trust boundary (an unknown kind →
 * 400, never pushed at the emulator). Kept in lock-step with {@link MediaKind}
 * (a `satisfies` binding makes a drift a compile error).
 */
const MEDIA_KINDS = ["photo", "voice", "document", "video", "video_note"] as const satisfies readonly MediaKind[];
/** Type guard: is `value` one of the closed {@link MediaKind} union members? */
function isMediaKind(value: unknown): value is MediaKind {
  return typeof value === "string" && (MEDIA_KINDS as readonly string[]).includes(value);
}

/**
 * The minimal emulator surface the control handlers drive. A structural subset
 * of `TgEmulator` (NOT the whole interface) so the control API stays
 * channel-agnostic: any emulator that can queue an inbound + expose its outbound
 * oracle can be driven by this surface (Phase 209 channel #2 implements the same
 * shape).
 */
export interface ControlEmulator {
  /** Queue an inbound text message; returns the minted message id. */
  injectMessage(
    chat: { readonly chatId: number },
    from: { id: number; firstName: string; username?: string },
    text: string,
  ): number;
  /**
   * Queue an inbound reaction-ADD on an EXISTING bot reply (`botMessageId`).
   * Mints NO message id (the reacted-to message already exists) — returns
   * `void`. Kept the minimal channel-agnostic shape so Phase-209 channel #2
   * implements the same surface (REACT-02). The `emoji` is the closed grammy
   * union at this typed seam; the HTTP boundary casts a request string into it.
   */
  injectReaction(
    chat: { readonly chatId: number },
    from: { id: number; firstName: string; username?: string },
    botMessageId: number,
    emoji: ReactionTypeEmoji["emoji"],
  ): void;
  /**
   * Store `bytes` and queue an inbound media `message` of `kind` (the bytes
   * arrive base64-decoded — the route does the decode). Mints + returns a
   * `message_id` (a media message IS a new message). The `kind` is the closed
   * media union at this typed seam; the HTTP boundary validates a request string
   * into it (an unknown kind → 400 before this is called). Kept the minimal
   * channel-agnostic shape so Phase-209 channel #2 implements the same surface.
   */
  injectMedia(
    chat: { readonly chatId: number },
    from: { id: number; firstName: string; username?: string },
    kind: MediaKind,
    bytes: Buffer,
    meta?: MediaMeta,
  ): number;
  /**
   * Queue an inbound `location` OR `venue` `message` (exactly one, the
   * discriminated {@link PlaceInput}). Mints + returns a `message_id`.
   */
  injectLocation(
    chat: { readonly chatId: number },
    from: { id: number; firstName: string; username?: string },
    place: PlaceInput,
  ): number;
  /**
   * Queue an inbound `callback_query` tapping the EXISTING bot reply
   * `botMessageId` (the adapter answers it first + unconditionally, then forwards
   * `data` as a synthetic `isButtonCallback` message). Mints NO `message_id` —
   * the tapped reply already exists — returns `void`.
   */
  injectCallback(
    chat: { readonly chatId: number },
    from: { id: number; firstName: string; username?: string },
    botMessageId: number,
    data: string,
  ): void;
  /**
   * Queue an inbound `edited_message` for the EXISTING `messageId` (the adapter
   * routes it through the SAME inbound handler). References the passed id —
   * mints none, returns `void`.
   */
  injectEdit(
    chat: { readonly chatId: number },
    messageId: number,
    newText: string,
    from: { id: number; firstName: string; username?: string },
  ): void;
  /** All recorded outbounds for a chat, in send order (the channel oracle). */
  outbound(chat: { readonly chatId: number }): readonly RecordedOutbound[];
  /**
   * Inject a fault (FAULT-01): make the Bot-API `method` return the Telegram
   * error envelope on demand so the REAL adapter runs its fallback. Honors
   * `once` (fail the next call, then auto-clear so the retry succeeds) and
   * `matchChat` (scope to one chat). The out-of-process `POST /control/faults`
   * path; the in-process scenario calls this directly.
   */
  fail(method: string, error: TgFault, opts?: FailOpts): void;
  /** Clear ALL injected faults (the `DELETE /control/faults` path). */
  clearFaults(): void;
}

/** Parameters for the inject handler / `ControlClient.injectMessage`. */
export interface InjectMessageParams {
  /** The chat to inject into (a FIXED test chat id; never a real operator chat). */
  readonly chatId: number;
  /** The (human) sender's user id. */
  readonly fromUserId: number;
  /** The message text. */
  readonly text: string;
  /** Optional sender display name (defaults to a stable placeholder). */
  readonly fromFirstName?: string;
  /** Optional sender @username. */
  readonly fromUsername?: string;
}

/** Parameters for the inject-reaction handler / `ControlClient.injectReaction`. */
export interface InjectReactionParams {
  /** The chat the reacted-to bot reply lives in (a FIXED test chat id). */
  readonly chatId: number;
  /** The (human) reactor's user id. */
  readonly fromUserId: number;
  /**
   * The EXISTING bot reply's message id to react ON — the attribution keystone:
   * the id `recordOutboundMessage` keyed the trajectory map on (the `tg send`
   * reply-wait return), NOT the most-recent outbound.
   */
  readonly botMessageId: number;
  /** The reaction emoji (a string at this param; cast to the closed union at the boundary). */
  readonly emoji: string;
}

/**
 * Parameters for the inject-media handler / `ControlClient.injectMedia`. The
 * bytes ride as base64 in `fileBase64` (the JSON+base64 transport — no form-data
 * upload parser, AGENTS.md §2.3); the handler decodes it to a `Buffer`. The optional
 * meta fields mirror {@link MediaMeta} (the route maps `durationMs` → seconds).
 */
export interface InjectMediaParams {
  /** The chat to inject the media `message` into (a FIXED test chat id). */
  readonly chatId: number;
  /** The (human) sender's user id. */
  readonly fromUserId: number;
  /** The media kind — validated against the closed {@link MediaKind} union at the boundary. */
  readonly kind: string;
  /** The file bytes, base64-encoded (decoded to a `Buffer` in the handler). */
  readonly fileBase64: string;
  /** Optional original filename (document). */
  readonly fileName?: string;
  /** Optional MIME type (voice/document/video). */
  readonly mimeType?: string;
  /** Optional media duration in MILLISECONDS (mapped to seconds for {@link MediaMeta.duration}). */
  readonly durationMs?: number;
  /** Optional: mark the media as a spoiler (`has_media_spoiler`). */
  readonly spoiler?: boolean;
}

/**
 * Parameters for the inject-location handler / `ControlClient.injectLocation`.
 * Exactly one of a plain point (`latitude`/`longitude`[+`horizontalAccuracy`])
 * OR a `venue` object — the handler builds the discriminated {@link PlaceInput}.
 */
export interface InjectLocationParams {
  /** The chat to inject the location `message` into (a FIXED test chat id). */
  readonly chatId: number;
  /** The (human) sender's user id. */
  readonly fromUserId: number;
  /** Plain-point latitude (omit when sending a `venue`). */
  readonly latitude?: number;
  /** Plain-point longitude (omit when sending a `venue`). */
  readonly longitude?: number;
  /** Plain-point uncertainty radius in meters. */
  readonly horizontalAccuracy?: number;
  /** A named place (when set, WINS over a plain point — the mapper's `else if`). */
  readonly venue?: {
    readonly latitude: number;
    readonly longitude: number;
    readonly title: string;
    readonly address: string;
  };
}

/** Parameters for the inject-callback handler / `ControlClient.injectCallback`. */
export interface InjectCallbackParams {
  /** The chat the tapped bot reply lives in (a FIXED test chat id). */
  readonly chatId: number;
  /** The (human) tapper's user id. */
  readonly fromUserId: number;
  /** The EXISTING bot reply's message id the tap targets (the attribution keystone). */
  readonly botMessageId: number;
  /** The button payload (`callback_query.data` — a SCALAR string, IN-04 safe). */
  readonly data: string;
}

/** Parameters for the inject-edit handler / `ControlClient.injectEdit`. */
export interface InjectEditParams {
  /** The chat the edited message lives in (a FIXED test chat id). */
  readonly chatId: number;
  /** The EXISTING message id being edited. */
  readonly messageId: number;
  /** The new message text. */
  readonly newText: string;
  /** Optional editor user id (defaults to a stable placeholder editor). */
  readonly fromUserId?: number;
}

/** Parameters for the reply-wait handler / `ControlClient.waitForOutbound`. */
export interface WaitForOutboundParams {
  /** The chat whose outbound oracle to watch. */
  readonly chatId: number;
  /**
   * The watermark: return only outbounds whose message id is STRICTLY greater
   * than this. `0` means "any outbound".
   */
  readonly afterMessageId: number;
  /**
   * Block up to this many ms for a NEW outbound. On timeout, the result is the
   * empty array (honest no-reply, never a fabricated success).
   */
  readonly waitMs: number;
}

/**
 * The in-process typed control client — calls the SAME handler functions as the
 * HTTP routes, without a socket (RIG-03: in-process == HTTP). The rig's
 * `send`/`waitForReply` delegate here.
 */
export interface ControlClient {
  /**
   * Inject an inbound message (the in-process equivalent of
   * `POST /control/chats/:id/messages`).
   * @returns the minted message id.
   */
  injectMessage(params: InjectMessageParams): Promise<number>;
  /**
   * Inject an inbound reaction-ADD on an existing bot reply (the in-process
   * equivalent of `POST /control/chats/:id/reactions`). Calls the SAME
   * `handleInjectReaction` the HTTP route does (in-process == HTTP parity);
   * mints no id, resolves `void`.
   */
  injectReaction(params: InjectReactionParams): Promise<void>;
  /**
   * Inject an inbound media `message` (the in-process equivalent of
   * `POST /control/chats/:id/media`). Calls the SAME `handleInjectMedia` the HTTP
   * route does (in-proc == HTTP parity); base64-decodes `fileBase64` → `Buffer`.
   * @returns the minted `message_id`.
   */
  injectMedia(params: InjectMediaParams): Promise<number>;
  /**
   * Inject an inbound `location`/`venue` `message` (the in-process equivalent of
   * `POST /control/chats/:id/location`). Calls the SAME `handleInjectLocation`.
   * @returns the minted `message_id`.
   */
  injectLocation(params: InjectLocationParams): Promise<number>;
  /**
   * Inject an inbound `callback_query` tapping an existing bot reply (the
   * in-process equivalent of `POST /control/chats/:id/callbacks`). Calls the SAME
   * `handleInjectCallback`; mints no id, resolves `void`.
   */
  injectCallback(params: InjectCallbackParams): Promise<void>;
  /**
   * Inject an inbound `edited_message` for an existing message (the in-process
   * equivalent of `POST /control/chats/:id/edits`). Calls the SAME
   * `handleInjectEdit`; mints no id, resolves `void`.
   */
  injectEdit(params: InjectEditParams): Promise<void>;
  /**
   * Block for new outbounds after `afterMessageId` (the in-process equivalent of
   * `GET /control/chats/:id/outbound`). Returns `[]` on timeout — an honest
   * no-reply, never a fabricated success.
   */
  waitForOutbound(params: WaitForOutboundParams): Promise<RecordedOutbound[]>;
  /**
   * Convenience over {@link waitForOutbound}: the FIRST new outbound, or
   * `undefined` on timeout (honest no-reply). This is the `tg send` / TS
   * `waitForReply` shape the rig surfaces.
   */
  waitForReply(params: WaitForOutboundParams): Promise<RecordedOutbound | undefined>;
  /**
   * Inject a fault (FAULT-01) — the in-process equivalent of
   * `POST /control/faults`. Calls the SAME `handleSetFault` the HTTP route does
   * (in-proc == HTTP parity); makes the Bot-API `method` return the Telegram
   * error envelope so the REAL adapter runs its fallback.
   */
  setFault(method: string, error: TgFault, opts?: FailOpts): void;
  /**
   * Clear ALL injected faults — the in-process equivalent of
   * `DELETE /control/faults`. Calls the SAME `handleClearFaults`.
   */
  clearFaults(): void;
}

/** A short poll interval (ms) for the reply-wait. Small enough that a block-then-resolve wakes promptly. */
const POLL_INTERVAL_MS = 15;
/** Hard ceiling on `waitMs` (ms) so a malformed huge value cannot hang the handler forever (T-204-12). */
const MAX_WAIT_MS = 120_000;

/** Sleep helper (raw `setTimeout` is fine under `test/`). */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (typeof timer.unref === "function") timer.unref();
  });
}

/**
 * Parse a control request body — JSON or form-encoded (the driver/CLI may send
 * either; mirrors the emulator's dual parse). A malformed body yields `{}` (the
 * base already guarantees the server stays up — V5).
 */
function parseControlBody(body: string): Record<string, unknown> {
  if (body.length === 0) return {};
  try {
    return JSON.parse(body) as Record<string, unknown>;
  } catch {
    const out: Record<string, unknown> = {};
    for (const part of body.split("&")) {
      const eq = part.indexOf("=");
      if (eq <= 0) continue;
      const k = decodeURIComponent(part.slice(0, eq));
      const v = decodeURIComponent(part.slice(eq + 1).replace(/\+/g, " "));
      out[k] = v;
    }
    return out;
  }
}

/** Coerce an unknown body/query value to a finite number, or `undefined`. */
function toNum(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return undefined;
}

/** Coerce an unknown body value to a string, or `undefined`. */
function toStr(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/**
 * Resolve a location body into the discriminated {@link PlaceInput}, or
 * `undefined` if it is neither a valid plain point nor a valid venue (→ 400 at
 * the dispatch boundary, never a crash). A `venue` WINS over a plain point (the
 * mapper's `else if` precedence); a venue requires lat/lng/title/address, a
 * plain point requires lat/lng (`horizontalAccuracy` optional).
 */
function resolvePlaceInput(
  rawVenue: unknown,
  rawLat: unknown,
  rawLng: unknown,
  rawAccuracy: unknown,
): PlaceInput | undefined {
  if (rawVenue !== undefined && rawVenue !== null && typeof rawVenue === "object") {
    const v = rawVenue as Record<string, unknown>;
    const latitude = toNum(v["latitude"]);
    const longitude = toNum(v["longitude"]);
    const title = toStr(v["title"]);
    const address = toStr(v["address"]);
    if (latitude === undefined || longitude === undefined || title === undefined || address === undefined) {
      return undefined; // a malformed venue → 400 (never a partial push).
    }
    return { venue: { latitude, longitude, title, address } };
  }
  const latitude = toNum(rawLat);
  const longitude = toNum(rawLng);
  if (latitude === undefined || longitude === undefined) return undefined;
  const horizontalAccuracy = toNum(rawAccuracy);
  return {
    location: {
      latitude,
      longitude,
      ...(horizontalAccuracy !== undefined ? { horizontalAccuracy } : {}),
    },
  };
}

/** Bound `waitMs` into `[0, MAX_WAIT_MS]` defensively (T-204-12). */
function clampWaitMs(raw: number | undefined): number {
  if (raw === undefined || !Number.isFinite(raw) || raw <= 0) return 0;
  return Math.min(raw, MAX_WAIT_MS);
}

/** The `/control/chats/:id/messages` path → the captured chat id. */
const CHAT_MESSAGES_PATH = /^\/control\/chats\/(-?\d+)\/messages\/?$/;
/** The `/control/chats/:id/outbound` path → the captured chat id. */
const CHAT_OUTBOUND_PATH = /^\/control\/chats\/(-?\d+)\/outbound\/?$/;
/** The `/control/chats/:id/reactions` path → the captured chat id (REACT-02). */
const CHAT_REACTIONS_PATH = /^\/control\/chats\/(-?\d+)\/reactions\/?$/;
/** The `/control/chats/:id/media` path → the captured chat id (MEDIA-01/03, Phase 207). */
const CHAT_MEDIA_PATH = /^\/control\/chats\/(-?\d+)\/media\/?$/;
/** The `/control/chats/:id/location` path → the captured chat id (MEDIA-01, Phase 207). */
const CHAT_LOCATION_PATH = /^\/control\/chats\/(-?\d+)\/location\/?$/;
/** The `/control/chats/:id/callbacks` path → the captured chat id (INTERACT-01, Phase 207). */
const CHAT_CALLBACKS_PATH = /^\/control\/chats\/(-?\d+)\/callbacks\/?$/;
/** The `/control/chats/:id/edits` path → the captured chat id (INTERACT-02, Phase 207). */
const CHAT_EDITS_PATH = /^\/control\/chats\/(-?\d+)\/edits\/?$/;
/** The `/control/faults` path — POST sets a fault, DELETE clears all (FAULT-01, Phase 208). */
const FAULTS_PATH = /^\/control\/faults\/?$/;

/**
 * Register the generic `/control/*` API on the shared http-backend `backend` and
 * return the in-process typed `ControlClient`. The HTTP routes and the client
 * call the SAME handler functions (`handleInject` / `handleOutbound`), so
 * behavioral parity is structural.
 *
 * For 204 only the inject + reply-wait routes are wired; the dispatch is a route
 * map so the remaining §4.6 verbs are additive later.
 */
export function registerControlApi(backend: HttpBackend, emulator: ControlEmulator): ControlClient {
  // -------------------------------------------------------------------------
  // Shared handlers — the single source of truth for BOTH the HTTP route and
  // the in-process client.
  // -------------------------------------------------------------------------

  /** POST /control/chats/:id/messages — queue an inbound, return the minted id. */
  function handleInject(chatId: number, params: InjectMessageParams): { messageId: number } {
    const messageId = emulator.injectMessage(
      { chatId },
      {
        id: params.fromUserId,
        firstName: params.fromFirstName ?? `user_${params.fromUserId}`,
        ...(params.fromUsername !== undefined ? { username: params.fromUsername } : {}),
      },
      params.text,
    );
    return { messageId };
  }

  /**
   * POST /control/chats/:id/reactions — queue an inbound reaction-ADD on an
   * EXISTING bot reply. The ONE handler both the HTTP route and the in-proc
   * client invoke (structural parity, mirroring handleInject). The `emoji` is a
   * string at this trust boundary; it is cast to the closed grammy union exactly
   * once here (the §4.6 row: `{ fromUserId, botMessageId, emoji } → { ok }`).
   */
  function handleInjectReaction(
    chatId: number,
    params: { fromUserId: number; botMessageId: number; emoji: string },
  ): { ok: true } {
    emulator.injectReaction(
      { chatId },
      { id: params.fromUserId, firstName: `user_${params.fromUserId}` },
      params.botMessageId,
      // The single narrowing at the HTTP trust boundary (string → closed union).
      params.emoji as ReactionTypeEmoji["emoji"],
    );
    return { ok: true };
  }

  /**
   * POST /control/chats/:id/media — store the (base64-decoded) bytes + queue an
   * inbound media `message`. The ONE handler both the HTTP route and the in-proc
   * client invoke (structural parity). The bytes ride as base64 inside the JSON
   * body (decoded here to a `Buffer`) — NO form-data upload parser; it stays in
   * the existing `parseControlBody` JSON branch (AGENTS.md §2.3 stdlib-first). The
   * caller has ALREADY validated `kind` (a closed `MediaKind`) and `fileBase64`
   * (a string) at the dispatch boundary, so a bad request 400s before reaching
   * here (§4.6 row: `{ kind, fromUserId, fileBase64, … } → { ok, messageId }`).
   */
  function handleInjectMedia(
    chatId: number,
    params: {
      fromUserId: number;
      kind: MediaKind;
      fileBase64: string;
      meta?: MediaMeta;
    },
  ): { ok: true; messageId: number } {
    const bytes = Buffer.from(params.fileBase64, "base64");
    const messageId = emulator.injectMedia(
      { chatId },
      { id: params.fromUserId, firstName: `user_${params.fromUserId}` },
      params.kind,
      bytes,
      params.meta,
    );
    return { ok: true, messageId };
  }

  /**
   * POST /control/chats/:id/location — queue an inbound `location` OR `venue`
   * `message`. The ONE handler both callers invoke. The caller has resolved the
   * discriminated {@link PlaceInput} at the dispatch boundary (a body that is
   * neither a valid point nor a venue 400s before reaching here).
   */
  function handleInjectLocation(
    chatId: number,
    params: { fromUserId: number; place: PlaceInput },
  ): { ok: true; messageId: number } {
    const messageId = emulator.injectLocation(
      { chatId },
      { id: params.fromUserId, firstName: `user_${params.fromUserId}` },
      params.place,
    );
    return { ok: true, messageId };
  }

  /**
   * POST /control/chats/:id/callbacks — queue an inbound `callback_query` tapping
   * an EXISTING bot reply. The ONE handler both callers invoke; mints no id (the
   * §4.6 shape `{ ok: true }`). `data` is a SCALAR string (IN-04 safe — grammy
   * sends callbacks as JSON; the JSON parseBody branch handles it, no form parser).
   */
  function handleInjectCallback(
    chatId: number,
    params: { fromUserId: number; botMessageId: number; data: string },
  ): { ok: true } {
    emulator.injectCallback(
      { chatId },
      { id: params.fromUserId, firstName: `user_${params.fromUserId}` },
      params.botMessageId,
      params.data,
    );
    return { ok: true };
  }

  /**
   * POST /control/chats/:id/edits — queue an inbound `edited_message` for an
   * EXISTING message. The ONE handler both callers invoke; mints no id (the §4.6
   * shape `{ ok: true }`). `fromUserId` defaults to a stable placeholder editor.
   */
  function handleInjectEdit(
    chatId: number,
    params: { messageId: number; newText: string; fromUserId: number },
  ): { ok: true } {
    emulator.injectEdit(
      { chatId },
      params.messageId,
      params.newText,
      { id: params.fromUserId, firstName: `user_${params.fromUserId}` },
    );
    return { ok: true };
  }

  /**
   * POST /control/faults — inject a fault on a Bot-API method (FAULT-01). The
   * ONE handler both the HTTP route and the in-proc client invoke (structural
   * parity, mirroring handleInject). Makes `method` return the Telegram error
   * envelope so the REAL adapter runs its fallback (§4.6 row:
   * `{ method, error, opts? } → { ok }`).
   */
  function handleSetFault(method: string, error: TgFault, opts?: FailOpts): { ok: true } {
    emulator.fail(method, error, opts);
    return { ok: true };
  }

  /** DELETE /control/faults — clear ALL injected faults (FAULT-01). */
  function handleClearFaults(): { ok: true } {
    emulator.clearFaults();
    return { ok: true };
  }

  /**
   * GET /control/chats/:id/outbound — the reply-wait. Poll the emulator's
   * outbound oracle for the first entry with `messageId > afterMessageId`,
   * blocking up to `waitMs`. On TIMEOUT return `[]` (honest no-reply, NEVER a
   * fabricated success — the prime directive, I5).
   */
  async function handleOutbound(chatId: number, afterMessageId: number, waitMs: number): Promise<RecordedOutbound[]> {
    const deadline = Date.now() + clampWaitMs(waitMs);
    // Always check at least once (a waitMs of 0 → an immediate, non-blocking read).
    for (;;) {
      const newer = emulator
        .outbound({ chatId })
        .filter((o) => o.messageId > afterMessageId);
      if (newer.length > 0) return [...newer];
      if (Date.now() >= deadline) return []; // honest timeout — the empty result.
      const remaining = deadline - Date.now();
      await sleep(Math.min(POLL_INTERVAL_MS, Math.max(1, remaining)));
    }
  }

  // -------------------------------------------------------------------------
  // HTTP dispatch — a route map (scaffold) so the remaining §4.6 verbs are
  // additive later; only the two 204 routes are implemented.
  // -------------------------------------------------------------------------

  async function dispatchControl(ctx: ControlRouteContext): Promise<RouteResult> {
    // POST /control/chats/:id/messages
    const injectMatch = ctx.path.match(CHAT_MESSAGES_PATH);
    if (injectMatch && ctx.httpMethod === "POST") {
      const chatId = Number(injectMatch[1]);
      const body = parseControlBody(ctx.body);
      const fromUserId = toNum(body["fromUserId"]);
      const text = toStr(body["text"]);
      if (fromUserId === undefined || text === undefined) {
        // Bad input → 400 (defensive; never crash — T-204-12).
        return {
          status: 400,
          body: { ok: false, error: "fromUserId (number) and text (string) are required" },
        };
      }
      const params: InjectMessageParams = {
        chatId,
        fromUserId,
        text,
        ...(toStr(body["fromFirstName"]) !== undefined ? { fromFirstName: toStr(body["fromFirstName"])! } : {}),
        ...(toStr(body["fromUsername"]) !== undefined ? { fromUsername: toStr(body["fromUsername"])! } : {}),
      };
      return { status: 200, body: handleInject(chatId, params) };
    }

    // POST /control/chats/:id/reactions (the inject-reaction route — REACT-02)
    const reactMatch = ctx.path.match(CHAT_REACTIONS_PATH);
    if (reactMatch && ctx.httpMethod === "POST") {
      const chatId = Number(reactMatch[1]);
      const body = parseControlBody(ctx.body);
      const fromUserId = toNum(body["fromUserId"]);
      const botMessageId = toNum(body["botMessageId"]);
      const emoji = toStr(body["emoji"]);
      if (fromUserId === undefined || botMessageId === undefined || emoji === undefined) {
        // Bad input → 400 (defensive; never crash — T-204-12 parity).
        return {
          status: 400,
          body: {
            ok: false,
            error: "fromUserId (number), botMessageId (number) and emoji (string) are required",
          },
        };
      }
      return { status: 200, body: handleInjectReaction(chatId, { fromUserId, botMessageId, emoji }) };
    }

    // POST /control/chats/:id/media (inject media — MEDIA-01/03; base64 in JSON)
    const mediaMatch = ctx.path.match(CHAT_MEDIA_PATH);
    if (mediaMatch && ctx.httpMethod === "POST") {
      const chatId = Number(mediaMatch[1]);
      const body = parseControlBody(ctx.body);
      const fromUserId = toNum(body["fromUserId"]);
      const kind = body["kind"];
      const fileBase64 = toStr(body["fileBase64"]);
      // Validate required fields + the closed `kind` union (an unknown kind, a
      // missing/non-string fileBase64, or a bad fromUserId → 400, never a crash;
      // the bytes are never base64-decoded for a bad request — T-207-08).
      if (fromUserId === undefined || !isMediaKind(kind) || fileBase64 === undefined) {
        return {
          status: 400,
          body: {
            ok: false,
            error:
              "fromUserId (number), kind (one of photo|voice|document|video|video_note) and fileBase64 (string) are required",
          },
        };
      }
      // Map the optional meta fields (durationMs → seconds for MediaMeta.duration).
      const durationMs = toNum(body["durationMs"]);
      const meta: MediaMeta = {
        ...(toStr(body["fileName"]) !== undefined ? { fileName: toStr(body["fileName"])! } : {}),
        ...(toStr(body["mimeType"]) !== undefined ? { mimeType: toStr(body["mimeType"])! } : {}),
        ...(durationMs !== undefined ? { duration: Math.round(durationMs / 1000) } : {}),
        ...(body["spoiler"] === true || body["spoiler"] === "true" ? { spoiler: true } : {}),
      };
      const hasMeta = Object.keys(meta).length > 0;
      return {
        status: 200,
        body: handleInjectMedia(chatId, {
          fromUserId,
          kind,
          fileBase64,
          ...(hasMeta ? { meta } : {}),
        }),
      };
    }

    // POST /control/chats/:id/location (inject location/venue — MEDIA-01)
    const locationMatch = ctx.path.match(CHAT_LOCATION_PATH);
    if (locationMatch && ctx.httpMethod === "POST") {
      const chatId = Number(locationMatch[1]);
      const body = parseControlBody(ctx.body);
      const fromUserId = toNum(body["fromUserId"]);
      // Resolve the discriminated PlaceInput: a `venue` object WINS; else a plain
      // point. A body that is neither → 400 (never a crash — T-207-08).
      const place = resolvePlaceInput(body["venue"], body["latitude"], body["longitude"], body["horizontalAccuracy"]);
      if (fromUserId === undefined || place === undefined) {
        return {
          status: 400,
          body: {
            ok: false,
            error:
              "fromUserId (number) and either { latitude, longitude } or venue:{ latitude, longitude, title, address } are required",
          },
        };
      }
      return { status: 200, body: handleInjectLocation(chatId, { fromUserId, place }) };
    }

    // POST /control/chats/:id/callbacks (inject callback — INTERACT-01)
    const callbackMatch = ctx.path.match(CHAT_CALLBACKS_PATH);
    if (callbackMatch && ctx.httpMethod === "POST") {
      const chatId = Number(callbackMatch[1]);
      const body = parseControlBody(ctx.body);
      const fromUserId = toNum(body["fromUserId"]);
      const botMessageId = toNum(body["botMessageId"]);
      const data = toStr(body["data"]);
      if (fromUserId === undefined || botMessageId === undefined || data === undefined) {
        return {
          status: 400,
          body: {
            ok: false,
            error: "fromUserId (number), botMessageId (number) and data (string) are required",
          },
        };
      }
      return { status: 200, body: handleInjectCallback(chatId, { fromUserId, botMessageId, data }) };
    }

    // POST /control/chats/:id/edits (inject edit — INTERACT-02)
    const editMatch = ctx.path.match(CHAT_EDITS_PATH);
    if (editMatch && ctx.httpMethod === "POST") {
      const chatId = Number(editMatch[1]);
      const body = parseControlBody(ctx.body);
      const messageId = toNum(body["messageId"]);
      const newText = toStr(body["newText"]);
      if (messageId === undefined || newText === undefined) {
        return {
          status: 400,
          body: { ok: false, error: "messageId (number) and newText (string) are required" },
        };
      }
      // fromUserId is OPTIONAL — default to a stable placeholder editor id.
      const fromUserId = toNum(body["fromUserId"]) ?? 1;
      return { status: 200, body: handleInjectEdit(chatId, { messageId, newText, fromUserId }) };
    }

    // POST /control/faults (inject a fault — FAULT-01) / DELETE (clear all)
    const faultsMatch = ctx.path.match(FAULTS_PATH);
    if (faultsMatch && ctx.httpMethod === "POST") {
      const body = parseControlBody(ctx.body);
      const method = toStr(body["method"]);
      // The error envelope is a nested object { error_code, description, parameters? }.
      const rawError = body["error"];
      const error =
        rawError !== undefined && rawError !== null && typeof rawError === "object"
          ? (rawError as Record<string, unknown>)
          : undefined;
      const errorCode = error !== undefined ? toNum(error["error_code"]) : undefined;
      const description = error !== undefined ? toStr(error["description"]) : undefined;
      if (method === undefined || error === undefined || errorCode === undefined || description === undefined) {
        // Bad input → 400 (defensive; never crash — T-204-12 parity).
        return {
          status: 400,
          body: {
            ok: false,
            error: "method (string) and error:{ error_code (number), description (string) } are required",
          },
        };
      }
      // Resolve the optional parameters + opts (matchChat / once).
      const rawParams = error["parameters"];
      const fault: TgFault = {
        error_code: errorCode,
        description,
        ...(rawParams !== undefined && rawParams !== null && typeof rawParams === "object"
          ? { parameters: rawParams as Record<string, unknown> }
          : {}),
      };
      const rawOpts =
        body["opts"] !== undefined && body["opts"] !== null && typeof body["opts"] === "object"
          ? (body["opts"] as Record<string, unknown>)
          : {};
      const once = rawOpts["once"] === true || rawOpts["once"] === "true";
      const matchChat = toNum(rawOpts["matchChat"]);
      const opts: FailOpts = {
        ...(once ? { once: true } : {}),
        ...(matchChat !== undefined ? { matchChat } : {}),
      };
      return { status: 200, body: handleSetFault(method, fault, opts) };
    }
    if (faultsMatch && ctx.httpMethod === "DELETE") {
      return { status: 200, body: handleClearFaults() };
    }

    // GET /control/chats/:id/outbound?afterMessageId&waitMs (the reply-wait)
    const outboundMatch = ctx.path.match(CHAT_OUTBOUND_PATH);
    if (outboundMatch && ctx.httpMethod === "GET") {
      const chatId = Number(outboundMatch[1]);
      const query = new URLSearchParams(ctx.query);
      const afterMessageId = toNum(query.get("afterMessageId")) ?? 0;
      const waitMs = toNum(query.get("waitMs")) ?? 0;
      const outbounds = await handleOutbound(chatId, afterMessageId, waitMs);
      // The reply-wait ALWAYS returns the RecordedOutbound[] body (possibly []);
      // a timeout is `[]` with status 200 — an honest no-reply, not an error.
      return { status: 200, body: outbounds };
    }

    // Unknown /control/* route — 404 (the full §4.6 table is Phases 205-208).
    return { status: 404, body: { ok: false, error: "unknown /control route" } };
  }

  backend.registerControlRoute(dispatchControl);

  // -------------------------------------------------------------------------
  // In-process client — calls the SAME handlers (no socket).
  // -------------------------------------------------------------------------

  const client: ControlClient = {
    injectMessage(params) {
      return Promise.resolve(handleInject(params.chatId, params).messageId);
    },
    injectReaction(params) {
      // The SAME handler the HTTP route calls (in-process == HTTP parity).
      handleInjectReaction(params.chatId, {
        fromUserId: params.fromUserId,
        botMessageId: params.botMessageId,
        emoji: params.emoji,
      });
      return Promise.resolve();
    },
    injectMedia(params) {
      // The SAME handler the HTTP route calls (in-proc == HTTP parity); the kind
      // is validated against the closed union here as the HTTP boundary does (an
      // invalid kind from a typed caller is a loud programming error, not a
      // silent push — test/ allows a raw throw).
      if (!isMediaKind(params.kind)) {
        throw new Error(`injectMedia: unknown media kind ${JSON.stringify(params.kind)}`);
      }
      const durationMs = params.durationMs;
      const meta: MediaMeta = {
        ...(params.fileName !== undefined ? { fileName: params.fileName } : {}),
        ...(params.mimeType !== undefined ? { mimeType: params.mimeType } : {}),
        ...(durationMs !== undefined ? { duration: Math.round(durationMs / 1000) } : {}),
        ...(params.spoiler === true ? { spoiler: true } : {}),
      };
      const hasMeta = Object.keys(meta).length > 0;
      const { messageId } = handleInjectMedia(params.chatId, {
        fromUserId: params.fromUserId,
        kind: params.kind,
        fileBase64: params.fileBase64,
        ...(hasMeta ? { meta } : {}),
      });
      return Promise.resolve(messageId);
    },
    injectLocation(params) {
      // The SAME handler the HTTP route calls (in-proc == HTTP parity).
      const place = resolvePlaceInput(
        params.venue,
        params.latitude,
        params.longitude,
        params.horizontalAccuracy,
      );
      if (place === undefined) {
        throw new Error("injectLocation: a valid { latitude, longitude } or venue is required");
      }
      const { messageId } = handleInjectLocation(params.chatId, { fromUserId: params.fromUserId, place });
      return Promise.resolve(messageId);
    },
    injectCallback(params) {
      // The SAME handler the HTTP route calls (in-proc == HTTP parity).
      handleInjectCallback(params.chatId, {
        fromUserId: params.fromUserId,
        botMessageId: params.botMessageId,
        data: params.data,
      });
      return Promise.resolve();
    },
    injectEdit(params) {
      // The SAME handler the HTTP route calls (in-proc == HTTP parity); fromUserId
      // is optional → the same stable placeholder editor the HTTP path defaults.
      handleInjectEdit(params.chatId, {
        messageId: params.messageId,
        newText: params.newText,
        fromUserId: params.fromUserId ?? 1,
      });
      return Promise.resolve();
    },
    waitForOutbound(params) {
      return handleOutbound(params.chatId, params.afterMessageId, params.waitMs);
    },
    async waitForReply(params) {
      const outbounds = await handleOutbound(params.chatId, params.afterMessageId, params.waitMs);
      return outbounds[0];
    },
    setFault(method, error, opts) {
      // The SAME handler the HTTP route calls (in-process == HTTP parity).
      handleSetFault(method, error, opts);
    },
    clearFaults() {
      // The SAME handler the HTTP route calls (in-process == HTTP parity).
      handleClearFaults();
    },
  };

  return client;
}
