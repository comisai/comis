// SPDX-License-Identifier: Apache-2.0
/**
 * `TgEmulator` — the Tier-1 Telegram Bot API wire backend (EMU-01..05 + SEC-01,
 * Phase 204), built ON the Plan-01 `http-backend` base and `extends
 * ChannelEmulator` (foundation-real-from-day-one, design §3A.7).
 *
 * This is the fake `api.telegram.org` the REAL production grammy adapter hits
 * over loopback HTTP. The rig (Plan 05) boots an isolated Comis daemon pointed
 * at this emulator via `channels.telegram.apiRoot`; an injected inbound message
 * round-trips through the daemon and the bot's reply lands in `outbound()`.
 *
 * It composes the shared loopback server (`createHttpBackend()`) and registers
 * its Bot-API method table on the base's native-route dispatch — it does NOT
 * spin up its own `node:http` server (SEC-02 success-criterion #5: built ON the
 * base, not a bespoke server). The base owns the loopback bind (127.0.0.1 only,
 * SEC-01), the raw-body read, and the 404-on-unmatched hardening.
 *
 * The genuinely new mechanic over the proven `mock-telegram-server.ts` is the
 * §9 "trickiest bit": a TRUE long-poll `getUpdates` (offset/limit/timeout/ack
 * with a blocking waiter and NO dropped or duplicated updates) — NOT the mock's
 * empty-the-queue-on-every-poll shortcut (the anti-pattern this emulator
 * deliberately avoids).
 *
 * Method table (every method returns the Telegram envelope `{ ok, result }`):
 *   - getMe         — boot identity; AWAITED by the adapter, blocks boot
 *                     (credential-validator.ts getMe).
 *   - setMyCommands — fire-and-forget; the adapter only `.catch()`-warns
 *                     (telegram-lifecycle.ts).
 *   - sendMessage   — mints a monotonic `message_id`, records a full
 *                     `RecordedOutbound` to the chat oracle (EMU-03).
 *   - getUpdates    — the TRUE long-poll (EMU-02 — see `serveGetUpdates`).
 *   - setMessageReaction — set (non-empty) / clear (empty), recorded (EMU-04).
 *   - getFile       — file descriptor + a `GET /file/bot<token>/<path>` route
 *                     SHAPE (HTTP 200, no real bytes — byte serving is Phase
 *                     207) (EMU-05).
 *
 * TEST-HARNESS — lives under `test/`, never `packages`; ZERO production code
 * change. `test/` is outside every `packages` source-tree ESLint/architecture
 * rule, so `setTimeout`/raw `throw`/`Date.now` are fine here.
 *
 * @module
 */

import type { Update, User } from "grammy/types";
import {
  createHttpBackend,
  type HttpBackend,
  type RouteResult,
} from "../../harness/backends/http-backend.js";
import type { ChannelCaps, ChannelEmulator } from "../../harness/channel-emulator.js";
import { makeMessageUpdate, makeUser, nextUpdateId } from "./tg-payloads.js";
import { tgCaps } from "./tg-caps.js";

/**
 * A `RecordedOutbound` — the full option set captured for every outbound the
 * agent pushes to the channel (design §4.4). Later phases assert on the FULL
 * set; the 204 round-trip only needs `text` + `messageId`, but recording
 * everything now avoids a later refactor.
 */
export interface RecordedOutbound {
  /** The Bot-API method, e.g. `"sendMessage"` | `"setMessageReaction"`. */
  method: string;
  /** The minted bot message id (on `sendMessage`); the reacted-to id for reactions. */
  messageId: number;
  /** Message text (sendMessage). */
  text?: string;
  /** The adapter sends `parse_mode:"HTML"` (telegram-outbound.ts). */
  parseMode?: string;
  /** Inline buttons + callback_data. */
  replyMarkup?: unknown;
  /** Media kind, when an attachment is sent (Phase 207). */
  mediaKind?: string;
  /** Attachment caption. */
  caption?: string;
  /** `reply_to_message_id`. */
  replyToMessageId?: number;
  /** `message_thread_id` (forum topics). */
  messageThreadId?: number;
  /** `disable_notification`. */
  disableNotification?: boolean;
  /** Link-preview suppression. */
  linkPreviewDisabled?: boolean;
  /** For `setMessageReaction` — the emoji set (empty = cleared). */
  reactions?: string[];
  /** The full parsed request body (the source of truth for any later assertion). */
  raw: unknown;
}

/**
 * A chat reference. For the 204 DM round-trip a chat is identified by its
 * numeric `chatId`; the emulator keys its per-chat ORACLE state (outbound log +
 * reactions) on it. The long-poll pending queue is bot-global, not per-chat
 * (see {@link ChatOracle}).
 */
export interface ChatRef {
  /** The Telegram chat id. */
  readonly chatId: number;
}

/**
 * `TgEmulator` — `ChannelEmulator` + the Telegram-specific inject/read verbs
 * the rig and scenario tests drive. `start()`/`stop()` (from `ChannelEmulator`)
 * delegate to the http-backend base.
 */
export interface TgEmulator extends ChannelEmulator {
  /**
   * The SHARED loopback http-backend base this emulator composes. Exposed so the
   * control API (Plan 04, `registerControlApi(emulator.backend, emulator)`) can
   * register its `/control/*` routes on the SAME loopback port as the Bot API
   * (SEC-01: one port, namespaced). The emulator still owns the base's
   * lifecycle — `start()`/`stop()` delegate to it; callers MUST NOT call
   * `backend.start()`/`stop()` directly.
   */
  readonly backend: HttpBackend;
  /**
   * Queue an inbound text message from `from` in `chat` for the next
   * `getUpdates` long-poll (builds a grammy-typed `Update` via `tg-payloads`).
   * @returns the minted `message_id` of the injected update.
   */
  injectMessage(chat: ChatRef, from: { id: number; firstName: string; username?: string }, text: string): number;
  /** All recorded outbounds for a chat, in send order (the channel oracle). */
  outbound(chat: ChatRef): readonly RecordedOutbound[];
  /** The most-recent recorded outbound for a chat, or `undefined`. */
  lastBotReply(chat: ChatRef): RecordedOutbound | undefined;
  /** The emoji currently reacted onto a given bot message in a chat. */
  reactionsOn(chat: ChatRef, messageId: number): readonly string[];
  /** Clear a chat's recorded state: its oracle (outbounds + reactions) and its pending updates in the bot-global queue. */
  resetChat(chat: ChatRef): void;
}

/** Options for {@link createTgEmulator}. */
export interface CreateTgEmulatorOptions {
  /** The bot token grammy builds `/bot<token>/<method>` paths from (loopback stub). */
  readonly botToken: string;
  /**
   * Emulator-side cap on the long-poll block (ms). Defaults to 10s; the
   * scenario's request `timeout` (seconds) is honored but never exceeds this
   * cap, keeping tests deterministic regardless of the runner's request
   * timeout (RESEARCH A1/A3).
   */
  readonly maxPollMs?: number;
}

/** A pending waiter blocked inside a long-poll, awaiting an injected update. */
interface PollWaiter {
  /** Resolve the blocked `getUpdates` with the updates now available. */
  resolve: (updates: Update[]) => void;
  /** The runner's requested `limit` (cap on how many to return). */
  limit: number;
  /** The ack offset this waiter must respect (serve `update_id >= offset`). */
  offset: number | undefined;
}

/**
 * Per-chat ORACLE state (outbound log + reactions only). The long-poll pending
 * queue is BOT-GLOBAL (see {@link createTgEmulator}) because grammy's runner
 * polls `getUpdates` once per bot with a SINGLE offset — it is not chat-scoped.
 * The `update_id` is globally monotonic (`nextUpdateId`), so a single
 * bot-global pending queue is naturally ordered. The ack is not retained state:
 * each poll's `offset` is applied at serve time, so the per-(bot,chat) ack the
 * plan describes is just the bot-global serve filter for the spike's single DM.
 */
interface ChatOracle {
  /** Recorded outbounds, in send order. */
  outbound: RecordedOutbound[];
  /** messageId → current emoji reactions (set/cleared via setMessageReaction). */
  reactions: Map<number, string[]>;
}

const DEFAULT_MAX_POLL_MS = 10_000;

/**
 * Parse a Bot-API request body. grammy's HTTP client sends method args as a
 * JSON body OR form-encoded; read defensively from both (mock-telegram-server
 * dual parse). A malformed body yields `{}` (the base already guarantees the
 * server stays up).
 */
function parseBody(body: string): Record<string, unknown> {
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

/** Read a numeric field from body OR query (grammy transport varies). */
function readNum(
  body: Record<string, unknown>,
  query: URLSearchParams,
  key: string,
): number | undefined {
  const fromBody = body[key];
  if (typeof fromBody === "number") return fromBody;
  if (typeof fromBody === "string" && fromBody.trim() !== "" && !Number.isNaN(Number(fromBody))) {
    return Number(fromBody);
  }
  const fromQuery = query.get(key);
  if (fromQuery !== null && fromQuery.trim() !== "" && !Number.isNaN(Number(fromQuery))) {
    return Number(fromQuery);
  }
  return undefined;
}

const okEnvelope = (result: unknown): RouteResult => ({ status: 200, body: { ok: true, result } });

/**
 * Create the Telegram emulator. COMPOSES the loopback http-backend base and
 * registers its Bot-API method table — it never spins up its own loopback
 * listener (that lives in the http-backend base; SEC-02 success-criterion #5).
 */
export function createTgEmulator(opts: CreateTgEmulatorOptions): TgEmulator {
  const backend: HttpBackend = createHttpBackend();
  const maxPollMs = opts.maxPollMs ?? DEFAULT_MAX_POLL_MS;

  // Per-chat ORACLE state only (outbound log + reactions).
  const chats = new Map<number, ChatOracle>();
  // BOT-GLOBAL long-poll state. grammy's runner polls `getUpdates` once per bot
  // with a SINGLE offset (not chat-scoped), so the pending queue + blocked
  // waiters are bot-global. `update_id` is globally monotonic, so the single
  // queue stays ordered. There is NO retained ack pointer: the ack is applied
  // at serve time per poll — `takeDeliverable` serves `update_id >= offset` and
  // removes exactly the delivered updates — so the per-(bot,chat) ack the plan
  // describes is just the bot-global serve filter for the spike's single DM.
  let pending: Update[] = [];
  const waiters: PollWaiter[] = [];
  let nextMessageId = 100;
  // De-risk (RESEARCH A1/A2): optionally log the FIRST getUpdates request once
  // to confirm the offset transport + the runner's timeout by observation. Off
  // by default — only prints when `COMIS_EMULATOR_DEBUG` is set (see
  // serveGetUpdates) — and guarded so it fires at most once per emulator.
  let loggedFirstPoll = false;

  function chatOracle(chatId: number): ChatOracle {
    let st = chats.get(chatId);
    if (st === undefined) {
      st = { outbound: [], reactions: new Map() };
      chats.set(chatId, st);
    }
    return st;
  }

  /** Append an outbound record to a chat's oracle. */
  function record(chatId: number, ro: RecordedOutbound): void {
    chatOracle(chatId).outbound.push(ro);
  }

  // -------------------------------------------------------------------------
  // EMU-02 — the TRUE long-poll core (bot-global)
  // -------------------------------------------------------------------------

  /**
   * Select the updates a SINGLE poll/waiter is entitled to — those with
   * `update_id >= offset` (the Bot-API ack semantics: an `offset` confirms
   * receipt of everything below it and requests everything at/above it),
   * ascending, capped at `limit` — and remove EXACTLY those delivered updates
   * from the shared `pending` queue.
   *
   * Crucially, this NEVER mutates the queue on behalf of a waiter that is not
   * actually consuming an update: updates with `update_id < offset` are left in
   * place (a concurrently-blocked waiter carrying a lower/undefined offset may
   * still be entitled to them). That is what makes the bot-global queue safe
   * when ≥2 waiters carry DIVERGENT offsets — the per-waiter ack of one waiter
   * can no longer drop/starve another (WR-01). In the live single-consumer
   * grammy path the runner sends `offset = max(update_id) + 1`, so everything
   * below was already delivered+removed by the prior poll and this degrades to
   * the previous "ack-then-serve" behavior with no observable difference.
   *
   * No dup / no drop: a delivered update is removed by its `update_id`, so it
   * is handed to exactly one waiter and never re-served.
   */
  function takeDeliverable(offset: number | undefined, limit: number): Update[] {
    const floor = offset ?? 0;
    const cap = Math.max(0, limit);
    if (cap === 0) return [];
    // `pending` is kept ascending by `update_id` (injectMessage sorts on push).
    const deliverable = pending.filter((u) => u.update_id >= floor).slice(0, cap);
    if (deliverable.length === 0) return [];
    const deliveredIds = new Set(deliverable.map((u) => u.update_id));
    // Remove ONLY the delivered ids (not a prefix slice) so a non-contiguous
    // selection — e.g. a gap below `offset` left for another waiter — stays put.
    pending = pending.filter((u) => !deliveredIds.has(u.update_id));
    return deliverable;
  }

  function serveGetUpdates(body: Record<string, unknown>, query: URLSearchParams): Promise<RouteResult> {
    const offset = readNum(body, query, "offset");
    const limitRaw = readNum(body, query, "limit");
    const limit = limitRaw === undefined || limitRaw <= 0 ? 100 : limitRaw;
    const timeoutSec = readNum(body, query, "timeout") ?? 0;

    // One-shot observation of the offset transport + runner timeout (A1/A2) so
    // the REAL grammy runner's transport/timeout can be confirmed by
    // observation when de-risking. GATED behind `COMIS_EMULATOR_DEBUG`: Node's
    // `console.debug` is NOT suppressed at the default level (it writes to
    // stderr like `console.log`; only the browser console hides `debug`), so an
    // ungated print would pollute every CI run. Opt in explicitly to see it.
    // `console`/`process.env` are fine in `test/` (outside the packages rules).
    if (!loggedFirstPoll && process.env["COMIS_EMULATOR_DEBUG"]) {
      loggedFirstPoll = true;
      const transport = body["offset"] !== undefined ? "body" : query.has("offset") ? "query" : "none";
      console.debug(
        `[tg-emulator] first getUpdates: offset=${String(offset)} (transport=${transport}) timeout=${String(timeoutSec)}s limit=${String(limit)}`,
      );
    }

    // Serve the updates THIS poll is entitled to (`update_id >= offset`),
    // removing only those delivered. The ack of confirmed (`< offset`) updates
    // is implicit: they were delivered+removed on a prior poll, and any still
    // queued belong to a lower-offset waiter and must not be dropped here.
    const ready = takeDeliverable(offset, limit);
    if (ready.length > 0) {
      return Promise.resolve(okEnvelope(ready));
    }

    // Empty queue → block until an update is injected OR ~timeout elapses.
    // Cap the emulator-side wait small for determinism (RESEARCH A1/A3).
    const waitMs = Math.min(maxPollMs, Math.max(0, timeoutSec * 1000));
    if (waitMs === 0) {
      return Promise.resolve(okEnvelope([]));
    }

    return new Promise<RouteResult>((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        // Timeout: remove this waiter (if still pending) and return [].
        const idx = waiters.indexOf(waiter);
        if (idx >= 0) waiters.splice(idx, 1);
        if (!settled) {
          settled = true;
          resolve(okEnvelope([]));
        }
      }, waitMs);
      // Ensure the timer never blocks process exit (test hygiene).
      if (typeof timer.unref === "function") timer.unref();

      const waiter: PollWaiter = {
        limit,
        offset,
        resolve: (updates) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(okEnvelope(updates));
        },
      };
      waiters.push(waiter);
    });
  }

  /**
   * Wake blocked waiters (FIFO), handing each ONLY the pending updates it is
   * entitled to (`update_id >= its offset`, capped at its limit). Called after
   * an injection.
   *
   * Walk the waiter list rather than draining from the head: a waiter that has
   * nothing deliverable (e.g. its offset is past everything pending) is SKIPPED
   * (`continue`) — never `break` — so it cannot starve a later waiter that IS
   * entitled to the pending updates (WR-01). And selection goes through
   * {@link takeDeliverable}, which removes only the updates actually delivered
   * to this waiter, so one waiter's per-waiter ack can never drop the updates a
   * concurrently-blocked waiter (with a lower/undefined offset) is owed. No dup
   * / no drop holds across divergent-offset waiters.
   *
   * On the live grammy path `waiters.length` is ≤ 1, so this is just a FIFO
   * single-waiter resolve; the walk matters only for the manual concurrent
   * `getUpdates` the foundation (and Phase 209) invites.
   */
  function wakeWaiters(): void {
    if (pending.length === 0 || waiters.length === 0) return;
    const stillBlocked: PollWaiter[] = [];
    const toResolve: Array<{ waiter: PollWaiter; updates: Update[] }> = [];
    // Drain the current waiter set in FIFO order. `takeDeliverable` mutates the
    // shared `pending`, so each waiter sees only what earlier waiters left.
    for (const waiter of waiters.splice(0)) {
      const updates = pending.length > 0 ? takeDeliverable(waiter.offset, waiter.limit) : [];
      // Nothing deliverable → re-queue this waiter (skip, do NOT starve the
      // rest); deliverable → mark it for resolution after the walk.
      if (updates.length === 0) stillBlocked.push(waiter);
      else toResolve.push({ waiter, updates });
    }
    // Re-instate the waiters that got nothing, preserving FIFO order.
    waiters.push(...stillBlocked);
    for (const { waiter, updates } of toResolve) waiter.resolve(updates);
  }

  // -------------------------------------------------------------------------
  // Bot-API method table (registered on the http-backend native dispatch)
  // -------------------------------------------------------------------------

  function dispatch(method: string, ctx: { body: string; query: string }): RouteResult | Promise<RouteResult> {
    const body = parseBody(ctx.body);
    const query = new URLSearchParams(ctx.query);

    switch (method) {
      case "getMe":
        // EMU-01 — AWAITED, blocks boot. Shape from mock-telegram-server.
        return okEnvelope({
          id: 12345,
          is_bot: true,
          first_name: "TestBot",
          username: "test_bot",
          can_join_groups: true,
          can_read_all_group_messages: false,
          supports_inline_queries: false,
        });

      case "setMyCommands":
        // EMU-01 — fire-and-forget; answer so grammy does not warn.
        return okEnvelope(true);

      case "getUpdates":
        // EMU-02 — the TRUE long-poll (bot-global: one pending queue, one
        // waiter set, ack applied per-poll at serve time — as grammy's runner
        // polls per-bot with a single offset).
        return serveGetUpdates(body, query);

      case "sendMessage":
        return sendMessage(body);

      case "setMessageReaction":
        return setMessageReaction(body);

      case "getFile":
        return getFile(body);

      default:
        // Unknown method — accept-and-record so an unrelated adapter call does
        // not fail the boot (mirrors the mock's generic fallback).
        return okEnvelope({});
    }
  }

  function sendMessage(body: Record<string, unknown>): RouteResult {
    // EMU-03 — mint a message_id, record the FULL option set, return the echo.
    const chatId = Number(body["chat_id"] ?? 0) || 0;
    const text = typeof body["text"] === "string" ? body["text"] : undefined;
    const messageId = nextMessageId++;

    const ro: RecordedOutbound = {
      method: "sendMessage",
      messageId,
      raw: body,
    };
    if (text !== undefined) ro.text = text;
    if (typeof body["parse_mode"] === "string") ro.parseMode = body["parse_mode"];
    if (body["reply_markup"] !== undefined) ro.replyMarkup = body["reply_markup"];
    if (typeof body["caption"] === "string") ro.caption = body["caption"];
    if (body["reply_to_message_id"] !== undefined) ro.replyToMessageId = Number(body["reply_to_message_id"]);
    if (body["message_thread_id"] !== undefined) ro.messageThreadId = Number(body["message_thread_id"]);
    if (typeof body["disable_notification"] === "boolean") ro.disableNotification = body["disable_notification"];
    record(chatId, ro);

    return okEnvelope({
      message_id: messageId,
      date: Math.floor(Date.now() / 1000),
      chat: { id: chatId, type: "private" },
      ...(text !== undefined ? { text } : {}),
    });
  }

  function setMessageReaction(body: Record<string, unknown>): RouteResult {
    // EMU-04 — set (non-empty) / clear (empty) a reaction, record it.
    const chatId = Number(body["chat_id"] ?? 0) || 0;
    const messageId = Number(body["message_id"] ?? 0) || 0;
    const reactionArr = Array.isArray(body["reaction"]) ? (body["reaction"] as unknown[]) : [];
    const emojis: string[] = reactionArr
      .map((r) => (r && typeof r === "object" ? (r as Record<string, unknown>)["emoji"] : undefined))
      .filter((e): e is string => typeof e === "string");

    const st = chatOracle(chatId);
    if (emojis.length > 0) st.reactions.set(messageId, emojis);
    else st.reactions.delete(messageId);

    record(chatId, {
      method: "setMessageReaction",
      messageId,
      reactions: emojis,
      raw: body,
    });
    return okEnvelope(true);
  }

  function getFile(body: Record<string, unknown>): RouteResult {
    // EMU-05 — descriptor only; byte serving is Phase 207.
    const fileId = typeof body["file_id"] === "string" ? body["file_id"] : "file_unknown";
    return okEnvelope({
      file_id: fileId,
      file_unique_id: `uniq_${fileId}`,
      file_size: 1024,
      file_path: `documents/${fileId}.bin`,
    });
  }

  // EMU-05 file route SHAPE — a 200 placeholder (no real bytes in 204).
  backend.registerFileRoute(() => ({
    status: 200,
    body: { ok: true, note: "file-route-shape-only (byte serving is Phase 207)" },
  }));

  backend.registerNativeRoute((method, routeCtx) =>
    dispatch(method, { body: routeCtx.body, query: routeCtx.query }),
  );

  const emulator: TgEmulator = {
    caps: tgCaps satisfies ChannelCaps,
    // The shared base — the control API (Plan 04) registers /control/* on it so
    // the control surface and the Bot API share ONE loopback port (SEC-01).
    backend,

    start() {
      return backend.start();
    },

    stop() {
      // Resolve any still-blocked waiters with [] so a stop never hangs.
      while (waiters.length > 0) {
        const w = waiters.shift()!;
        w.resolve([]);
      }
      return backend.stop();
    },

    injectMessage(chat, from, text) {
      const messageId = nextMessageId++;
      const user: User = makeUser({
        id: from.id,
        firstName: from.firstName,
        ...(from.username !== undefined ? { username: from.username } : {}),
      });
      const update = makeMessageUpdate({
        updateId: nextUpdateId(),
        messageId,
        from: user,
        chatId: chat.chatId,
        text,
      });
      // Ensure the oracle exists for this chat so `outbound()` is never a silent
      // empty for a chat the driver has injected into.
      chatOracle(chat.chatId);
      pending.push(update);
      // Keep the bot-global queue strictly ascending by update_id (monotonic).
      pending.sort((a, b) => a.update_id - b.update_id);
      // Wake a blocked long-poll, if any, so the SAME call resolves.
      wakeWaiters();
      return messageId;
    },

    outbound(chat) {
      return chats.get(chat.chatId)?.outbound ?? [];
    },

    lastBotReply(chat) {
      const log = chats.get(chat.chatId)?.outbound;
      return log && log.length > 0 ? log[log.length - 1] : undefined;
    },

    reactionsOn(chat, messageId) {
      return chats.get(chat.chatId)?.reactions.get(messageId) ?? [];
    },

    resetChat(chat) {
      chats.delete(chat.chatId);
      // Also drop this chat's pending updates from the bot-global queue.
      pending = pending.filter((u) => (u.message ? u.message.chat.id !== chat.chatId : true));
    },
  };

  return emulator;
}
