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
 *   - getFile       — file descriptor from the REAL file_id store (file_size =
 *                     bytes.length, file_path = the stored key) + a
 *                     `GET /file/bot<token>/<file_path>` route that serves the
 *                     stored RAW bytes; a miss / `../`-laden path → 404, never a
 *                     disk read (MEDIA-01/02, Phase 207 — was the EMU-05 stub).
 *
 * TEST-HARNESS — lives under `test/`, never `packages`; ZERO production code
 * change. `test/` is outside every `packages` source-tree ESLint/architecture
 * rule, so `setTimeout`/raw `throw`/`Date.now` are fine here.
 *
 * @module
 */

import { randomBytes, randomUUID } from "node:crypto";
import type { ReactionTypeEmoji, Update, User } from "grammy/types";
import {
  createHttpBackend,
  type HttpBackend,
  type RouteResult,
} from "../../harness/backends/http-backend.js";
import type { ChannelCaps, ChannelEmulator } from "../../harness/channel-emulator.js";
import {
  makeBotMessage,
  makeBotUser,
  makeCallbackUpdate,
  makeEditUpdate,
  makeLocationUpdate,
  makeMediaUpdate,
  makeMessageUpdate,
  makeReactionUpdate,
  makeUser,
  nextUpdateId,
  type LocationInput,
  type MediaKind,
  type VenueInput,
} from "./tg-payloads.js";
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
 * Optional per-file metadata carried alongside the stored bytes (MEDIA-01).
 * Mirrors the subset of grammy media fields the builders echo + the resolver
 * may read; all optional (the test author supplies what a scenario needs).
 */
export interface MediaMeta {
  /** Original filename (document). */
  readonly fileName?: string;
  /** MIME type (voice/document/video) — also seeds the file-route content-type when present. */
  readonly mimeType?: string;
  /** Media duration in seconds (voice/video/video_note). */
  readonly duration?: number;
  /** Pixel width (photo/video). */
  readonly width?: number;
  /** Pixel height (photo/video). */
  readonly height?: number;
  /** Diameter (video_note). */
  readonly length?: number;
  /** When true, the media `message` carries `has_media_spoiler` (message-mapper.ts:142). */
  readonly spoiler?: boolean;
}

/**
 * The {@link TgEmulator.injectLocation} argument — exactly one of `location` /
 * `venue` (a discriminated either, matching the mapper's venue-WINS `else if`).
 * `LocationInput`/`VenueInput` are the Plan-01 builder input shapes reused here.
 */
export type PlaceInput =
  | { readonly location: LocationInput; readonly venue?: never }
  | { readonly venue: VenueInput; readonly location?: never };

/**
 * A file held in the bot-global store (MEDIA-01, Pattern 1). `getFile` is keyed
 * by `fileId` (the request body); the file route is keyed by `filePath` (the
 * URL segment) — Pitfall 3: BOTH indexes point at the SAME `StoredFile`, so the
 * size getFile reports and the bytes the route serves can never diverge.
 */
export interface StoredFile {
  /** The Telegram file_id `buildAttachments` reads + getFile echoes. */
  readonly fileId: string;
  /** The Telegram file_unique_id. */
  readonly fileUniqueId: string;
  /** The per-kind file_path (the `/file/bot<token>/<file_path>` URL segment + the route lookup key). */
  readonly filePath: string;
  /** The raw bytes the route serves verbatim; `getFile` reports `bytes.length` as `file_size`. */
  readonly bytes: Buffer;
  /** The kind that minted the file_path/content-type (photo/voice/document/video/video_note). */
  readonly kind: MediaKind;
  /** Optional per-file metadata. */
  readonly meta?: MediaMeta;
}

/**
 * The handle {@link TgEmulator.storeFile} returns — the minted ids + path the
 * caller (a Task-1 test, or {@link TgEmulator.injectMedia}) threads into a media
 * `Update` (the `file_id` the agent later resolves via `getFile`).
 */
export interface StoredFileHandle {
  /** The minted file_id (the getFile lookup key). */
  readonly fileId: string;
  /** The minted file_unique_id. */
  readonly fileUniqueId: string;
  /** The minted file_path (the route lookup key). */
  readonly filePath: string;
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
  /**
   * Queue an inbound reaction-ADD on an EXISTING bot reply (`botMessageId`) for
   * the next `getUpdates` long-poll (builds a grammy-typed `message_reaction`
   * `Update` via `tg-payloads`). Unlike {@link injectMessage} it mints NO
   * `message_id` — the reacted-to message already exists — and returns `void`.
   * The emitted Update trips the already-wired adapter handler
   * (telegram-inbound.ts:266): the reactor is ≠ bot and the emoji is in
   * `new_reaction` but absent from `old_reaction` (an ADD).
   */
  injectReaction(
    chat: ChatRef,
    from: { id: number; firstName: string; username?: string },
    botMessageId: number,
    emoji: ReactionTypeEmoji["emoji"],
  ): void;
  /**
   * Store `bytes` (MEDIA-01) and queue an inbound media `message` update of
   * `kind` carrying the minted `file_id` for the next `getUpdates` poll (builds
   * a grammy-typed `Update` via `makeMediaUpdate`). Mints a `message_id` like
   * {@link injectMessage} — a media message IS a new message.
   * @returns the minted `message_id`.
   */
  injectMedia(
    chat: ChatRef,
    from: { id: number; firstName: string; username?: string },
    kind: MediaKind,
    bytes: Buffer,
    meta?: MediaMeta,
  ): number;
  /**
   * Queue an inbound `location` OR `venue` `message` update (no file store;
   * `makeLocationUpdate`). Mints a `message_id` like {@link injectMessage}.
   * @returns the minted `message_id`.
   */
  injectLocation(
    chat: ChatRef,
    from: { id: number; firstName: string; username?: string },
    place: PlaceInput,
  ): number;
  /**
   * Queue an inbound `callback_query` update tapping the EXISTING bot reply
   * `botMessageId` (the adapter answers it FIRST + UNCONDITIONALLY,
   * telegram-inbound.ts:168, then forwards `data` as a synthetic
   * `isButtonCallback` message). Mints NO `message_id` — the tapped reply
   * already exists (like {@link injectReaction}).
   */
  injectCallback(
    chat: ChatRef,
    from: { id: number; firstName: string; username?: string },
    botMessageId: number,
    data: string,
  ): void;
  /**
   * Queue an inbound `edited_message` update for the EXISTING `messageId` (the
   * adapter routes it through the SAME `handleInboundMessage`,
   * telegram-inbound.ts:117). References the passed id — mints none.
   */
  injectEdit(
    chat: ChatRef,
    messageId: number,
    newText: string,
    from: { id: number; firstName: string; username?: string },
  ): void;
  /** All recorded outbounds for a chat, in send order (the channel oracle). */
  outbound(chat: ChatRef): readonly RecordedOutbound[];
  /** The most-recent recorded outbound for a chat, or `undefined`. */
  lastBotReply(chat: ChatRef): RecordedOutbound | undefined;
  /** The emoji currently reacted onto a given bot message in a chat. */
  reactionsOn(chat: ChatRef, messageId: number): readonly string[];
  /** Clear a chat's recorded state: its oracle (outbounds + reactions) and its pending updates in the bot-global queue. */
  resetChat(chat: ChatRef): void;
  /**
   * Store `bytes` in the bot-global file store under a freshly-minted
   * `file_id`/`file_unique_id`/`file_path` (MEDIA-01). Indexes the file under
   * BOTH `filesById` (the getFile key) and `filesByPath` (the route key). The
   * returned handle carries the ids/path so the caller can thread the `file_id`
   * into a media `Update` (a Task-1 test seeds the store directly; Task-2's
   * {@link injectMedia} calls this before building the media update).
   * @returns the minted `{ fileId, fileUniqueId, filePath }`.
   */
  storeFile(kind: MediaKind, bytes: Buffer, meta?: MediaMeta): StoredFileHandle;
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
 * The per-kind `file_path` segment + default content-type (MEDIA-01). The path
 * is what Telegram's `getFile` returns and the route is keyed on; the
 * content-type is what the binary file route serves (overridable by an explicit
 * `meta.mimeType`). One directory + extension per {@link MediaKind} (a closed
 * switch — an off-union kind is a compile error).
 */
function fileRouteForKind(kind: MediaKind, id: string): { filePath: string; contentType: string } {
  switch (kind) {
    case "photo":
      return { filePath: `photos/${id}.jpg`, contentType: "image/jpeg" };
    case "voice":
      return { filePath: `voice/${id}.ogg`, contentType: "audio/ogg" };
    case "document":
      return { filePath: `documents/${id}.bin`, contentType: "application/octet-stream" };
    case "video":
      return { filePath: `videos/${id}.mp4`, contentType: "video/mp4" };
    case "video_note":
      return { filePath: `video_notes/${id}.mp4`, contentType: "video/mp4" };
  }
}

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
  // BOT-GLOBAL file store (MEDIA-01, Pattern 1). `getFile` is keyed by file_id
  // (the request body); the file route is keyed by file_path (the URL segment)
  // — Pitfall 3: keep BOTH lookups so the size getFile reports and the bytes the
  // route serves can never diverge. A `../`-laden / unknown path is a Map miss
  // → 404 (the route NEVER touches the filesystem; T-207-04 / V12).
  const filesById = new Map<string, StoredFile>();
  const filesByPath = new Map<string, StoredFile>();
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

  /**
   * Store `bytes` under a freshly-minted file_id/file_unique_id/file_path
   * (MEDIA-01). The ids are minted the same way the production adapter mints its
   * ids (`randomUUID`/`randomBytes`, telegram-inbound.ts), so the store's ids are
   * shaped like real Telegram ids. The file is indexed under BOTH `filesById`
   * (the getFile key) and `filesByPath` (the route key) so the two lookups can
   * never disagree (Pitfall 3). Internal closure — exposed on the interface as
   * {@link TgEmulator.storeFile}; Task-2's `injectMedia` calls it before building
   * the media `Update`.
   */
  function storeFile(kind: MediaKind, bytes: Buffer, meta?: MediaMeta): StoredFileHandle {
    const fileId = `file_${randomUUID()}`;
    const fileUniqueId = `uniq_${randomBytes(8).toString("hex")}`;
    const { filePath } = fileRouteForKind(kind, fileUniqueId);
    const stored: StoredFile = {
      fileId,
      fileUniqueId,
      filePath,
      bytes,
      kind,
      ...(meta !== undefined ? { meta } : {}),
    };
    filesById.set(fileId, stored);
    filesByPath.set(filePath, stored);
    return { fileId, fileUniqueId, filePath };
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

      case "answerCallbackQuery":
        // INTERACT-01 — the adapter answers EVERY callback FIRST +
        // UNCONDITIONALLY (telegram-inbound.ts:168). RECORD it (Pattern 5) so the
        // ack is provable on the oracle, then return result:true (A5).
        return answerCallbackQuery(body);

      case "editMessageText":
        // INTERACT-02 outbound — RECORD the edit + echo a Message (grammy's
        // return type is Message-or-true).
        return editMessageText(body);

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

  function answerCallbackQuery(body: Record<string, unknown>): RouteResult {
    // INTERACT-01 — the adapter calls ctx.answerCallbackQuery() FIRST +
    // UNCONDITIONALLY (telegram-inbound.ts:168). grammy sends ONLY
    // `callback_query_id` (no chat_id/message_id), so this records on the chat-0
    // oracle with messageId 0 — but it RECORDS (Pattern 5), so the unconditional
    // ack is provable on the oracle instead of vanishing into the `default:`.
    // Tolerates a missing field (the setMessageReaction precedent).
    record(0, {
      method: "answerCallbackQuery",
      messageId: 0,
      raw: body,
    });
    // The adapter awaits the call and grammy expects `result: true` (A5).
    return okEnvelope(true);
  }

  function editMessageText(body: Record<string, unknown>): RouteResult {
    // INTERACT-02 outbound — RECORD the edit, then echo a realistic Message
    // (grammy's editMessageText return type is Message-or-true). grammy sends
    // chat_id/message_id positionally as a JSON body.
    const chatId = Number(body["chat_id"] ?? 0) || 0;
    const messageId = Number(body["message_id"] ?? 0) || 0;
    const text = typeof body["text"] === "string" ? body["text"] : undefined;

    const ro: RecordedOutbound = {
      method: "editMessageText",
      messageId,
      raw: body,
    };
    if (text !== undefined) ro.text = text;
    if (typeof body["parse_mode"] === "string") ro.parseMode = body["parse_mode"];
    record(chatId, ro);

    return okEnvelope({
      message_id: messageId,
      date: Math.floor(Date.now() / 1000),
      chat: { id: chatId, type: "private" },
      ...(text !== undefined ? { text } : {}),
    });
  }

  function getFile(body: Record<string, unknown>): RouteResult {
    // MEDIA-01 — descriptor from the REAL store (file_size = bytes.length,
    // file_path = the stored route key). A file_id the store has never seen is a
    // Telegram-shaped not-found (the resolver tolerates `!file.file_path`).
    const fileId = typeof body["file_id"] === "string" ? body["file_id"] : "";
    const rec = filesById.get(fileId);
    if (rec === undefined) {
      return { status: 200, body: { ok: false, error_code: 400, description: "file not found" } };
    }
    return okEnvelope({
      file_id: rec.fileId,
      file_unique_id: rec.fileUniqueId,
      file_size: rec.bytes.length,
      file_path: rec.filePath,
    });
  }

  // MEDIA-02 file route — serve the stored RAW bytes by `file_path`. A hit
  // returns a Buffer body (the http-backend binary path writes it verbatim with
  // the per-kind content-type, overridable by `meta.mimeType`); a miss — an
  // unknown OR a `../`-laden path — is a Map lookup that returns nothing → a 404
  // envelope. The route NEVER touches the filesystem (T-207-04 / V12): the
  // crafted path can only ever be a key the store does not hold.
  backend.registerFileRoute((ctx) => {
    const rec = filesByPath.get(ctx.filePath);
    if (rec === undefined) {
      return { status: 404, body: { ok: false, error_code: 404, description: "file not found" } };
    }
    const contentType = rec.meta?.mimeType ?? fileRouteForKind(rec.kind, rec.fileUniqueId).contentType;
    return { status: 200, body: rec.bytes, contentType };
  });

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

    injectReaction(chat, from, botMessageId, emoji) {
      const user: User = makeUser({
        id: from.id,
        firstName: from.firstName,
        ...(from.username !== undefined ? { username: from.username } : {}),
      });
      // NO nextMessageId++ — `botMessageId` is an EXISTING bot reply (the id
      // recordOutboundMessage keyed the trajectory on); the reaction does not
      // create a message. The builder emits a fresh ADD ([] → [{emoji}]).
      const update = makeReactionUpdate({
        updateId: nextUpdateId(),
        messageId: botMessageId,
        chatId: chat.chatId,
        user,
        emoji,
      });
      // Ensure the oracle exists for this chat (mirrors injectMessage).
      chatOracle(chat.chatId);
      pending.push(update);
      // Keep the bot-global queue strictly ascending by update_id (monotonic).
      pending.sort((a, b) => a.update_id - b.update_id);
      // Wake a blocked long-poll, if any, so the SAME call resolves.
      wakeWaiters();
      // No message_id minted — the reacted-to message already exists (void).
    },

    injectMedia(chat, from, kind, bytes, meta) {
      // MEDIA-01 — store the bytes FIRST so the emitted update's file_id resolves
      // to real bytes via getFile + the route, then mint a message_id (a media
      // message IS a new message, like injectMessage — NOT like injectReaction).
      const handle = storeFile(kind, bytes, meta);
      const messageId = nextMessageId++;
      const user = makeUser({
        id: from.id,
        firstName: from.firstName,
        ...(from.username !== undefined ? { username: from.username } : {}),
      });
      const update = makeMediaUpdate({
        updateId: nextUpdateId(),
        messageId,
        chatId: chat.chatId,
        from: user,
        kind,
        fileId: handle.fileId,
        fileUniqueId: handle.fileUniqueId,
        // Echo the meta fields the per-kind grammy object carries (each spread
        // only when defined — the builder is exact-optional-safe).
        ...(meta?.mimeType !== undefined ? { mimeType: meta.mimeType } : {}),
        ...(meta?.duration !== undefined ? { duration: meta.duration } : {}),
        ...(meta?.width !== undefined ? { width: meta.width } : {}),
        ...(meta?.height !== undefined ? { height: meta.height } : {}),
        ...(meta?.length !== undefined ? { length: meta.length } : {}),
        ...(meta?.fileName !== undefined ? { fileName: meta.fileName } : {}),
        ...(meta?.spoiler !== undefined ? { spoiler: meta.spoiler } : {}),
      });
      chatOracle(chat.chatId);
      pending.push(update);
      pending.sort((a, b) => a.update_id - b.update_id);
      wakeWaiters();
      return messageId;
    },

    injectLocation(chat, from, place) {
      // MEDIA-01 — a location/venue is a `message` update (no file store); mint a
      // message_id like injectMessage and return it.
      const messageId = nextMessageId++;
      const user = makeUser({
        id: from.id,
        firstName: from.firstName,
        ...(from.username !== undefined ? { username: from.username } : {}),
      });
      // The discriminated `place` flows straight into the builder's either-type
      // (venue WINS; the builder physically cannot set both).
      const update = makeLocationUpdate(
        "venue" in place
          ? { updateId: nextUpdateId(), messageId, chatId: chat.chatId, from: user, venue: place.venue }
          : { updateId: nextUpdateId(), messageId, chatId: chat.chatId, from: user, location: place.location },
      );
      chatOracle(chat.chatId);
      pending.push(update);
      pending.sort((a, b) => a.update_id - b.update_id);
      wakeWaiters();
      return messageId;
    },

    injectCallback(chat, from, botMessageId, data) {
      // INTERACT-01 — a callback taps an EXISTING bot reply: reconstruct that
      // bot Message (chat.id + message_id) and emit a callback_query. Mints NO
      // message_id (like injectReaction — the tapped reply already exists).
      const user = makeUser({
        id: from.id,
        firstName: from.firstName,
        ...(from.username !== undefined ? { username: from.username } : {}),
      });
      const botMessage = makeBotMessage({
        messageId: botMessageId,
        chatId: chat.chatId,
        botUser: makeBotUser({ id: 12345, firstName: "TestBot", username: "test_bot" }),
      });
      const update = makeCallbackUpdate({
        updateId: nextUpdateId(),
        // The query id — randomBytes hex, like a real Telegram callback id.
        id: randomBytes(8).toString("hex"),
        from: user,
        botMessage,
        // grammy's CallbackQuery requires a stable per-chat chat_instance string.
        chatInstance: `ci_${chat.chatId}`,
        data,
      });
      chatOracle(chat.chatId);
      pending.push(update);
      pending.sort((a, b) => a.update_id - b.update_id);
      wakeWaiters();
      // No message_id minted — the tapped reply already exists (void).
    },

    injectEdit(chat, messageId, newText, from) {
      // INTERACT-02 — an edit references the EXISTING messageId (the adapter
      // routes edited_message through the same handleInboundMessage). No mint.
      const user = makeUser({
        id: from.id,
        firstName: from.firstName,
        ...(from.username !== undefined ? { username: from.username } : {}),
      });
      const update = makeEditUpdate({
        updateId: nextUpdateId(),
        messageId,
        chatId: chat.chatId,
        from: user,
        newText,
      });
      chatOracle(chat.chatId);
      pending.push(update);
      pending.sort((a, b) => a.update_id - b.update_id);
      wakeWaiters();
      // References the passed messageId — mints none (void).
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
      // WR-02 (206-05 review fix, EXTENDED for the Phase-207 inbound kinds): the
      // filter must clear EVERY update kind keyed to the reset chat —
      //   - `message`         (text / media / location — `u.message.chat.id`)
      //   - `message_reaction` (injectReaction — `u.message_reaction.chat.id`)
      //   - `edited_message`   (injectEdit — `u.edited_message.chat.id`)
      //   - `callback_query`   (injectCallback — the tapped reply's
      //                         `u.callback_query.message.chat.id`)
      // The prior predicate keyed only on `u.message`/`u.message_reaction`, so a
      // queued edit or callback for the reset chat fell to the `: true` tail and
      // SURVIVED — bleeding into a later test that reuses resetChat (the 207/208
      // interactivity scenarios). A bot-global update with no resolvable chat is
      // still KEPT by the `: true` tail.
      pending = pending.filter((u) => {
        if (u.message) return u.message.chat.id !== chat.chatId;
        if (u.message_reaction) return u.message_reaction.chat.id !== chat.chatId;
        if (u.edited_message) return u.edited_message.chat.id !== chat.chatId;
        // A callback_query's message is MaybeInaccessibleMessage — both variants
        // carry `chat`, so `.message?.chat.id` resolves the tapped chat.
        if (u.callback_query) return u.callback_query.message?.chat.id !== chat.chatId;
        return true;
      });
    },

    storeFile(kind, bytes, meta) {
      return storeFile(kind, bytes, meta);
    },
  };

  return emulator;
}
