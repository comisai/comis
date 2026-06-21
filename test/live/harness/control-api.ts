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
import type { RecordedOutbound } from "../emulators/telegram/tg-emulator.js";

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
  /** All recorded outbounds for a chat, in send order (the channel oracle). */
  outbound(chat: { readonly chatId: number }): readonly RecordedOutbound[];
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
    waitForOutbound(params) {
      return handleOutbound(params.chatId, params.afterMessageId, params.waitMs);
    },
    async waitForReply(params) {
      const outbounds = await handleOutbound(params.chatId, params.afterMessageId, params.waitMs);
      return outbounds[0];
    },
  };

  return client;
}
