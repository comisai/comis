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
import type { Chat, Message, MessageEntity, ReactionTypeEmoji, Update, User } from "grammy/types";
import {
  createHttpBackend,
  type HttpBackend,
  type RouteResult,
} from "../../harness/backends/http-backend.js";
import type { ChannelCaps, ChannelEmulator } from "../../harness/channel-emulator.js";
import type { RecordedOutbound as AgnosticRecordedOutbound } from "../../harness/recorded-outbound.js";
import {
  makeBotMessage,
  makeBotUser,
  makeCallbackUpdate,
  makeEditUpdate,
  makeGroupChat,
  makeLocationUpdate,
  makeMediaUpdate,
  makeMessageUpdate,
  makeReactionUpdate,
  makeServiceMessageUpdate,
  makeUser,
  nextUpdateId,
  type ForumServiceKind,
  type LocationInput,
  type MediaKind,
  type VenueInput,
} from "./tg-payloads.js";
import { tgCaps } from "./tg-caps.js";

/**
 * The Telegram webhook secret-token header (AUTO-05, Phase 208). When a bot is
 * registered with a `secret_token`, Telegram stamps every delivered Update with
 * this header; the host's ingestion route is expected to reject a POST whose
 * header is wrong/absent. The emulator's webhook-POST mode
 * ({@link TgEmulator.postWebhookMessage}) carries it; the harness-side receiver
 * (`webhook-receiver.ts`) enforces it. Exported so the gate's header name is a
 * single source of truth shared by the POST side and the receiver side.
 *
 * ⚠ The PRODUCT does NOT check this header at HEAD — there is no Telegram
 * webhook ingestion route (the AUTO-05 finding); the gate proven here is the
 * HARNESS-side one. See `webhook-receiver.ts` for the full honest-gap note.
 */
export const TELEGRAM_WEBHOOK_SECRET_TOKEN_HEADER = "X-Telegram-Bot-Api-Secret-Token";

/**
 * The harness-side webhook secret-token gate (AUTO-05) as a pure predicate.
 *
 * Returns `true` IFF the presented `X-Telegram-Bot-Api-Secret-Token` header is
 * present AND exactly equals the configured `expected` token. A `undefined`
 * (absent header) or any mismatch returns `false` — a forged Update without the
 * shared secret is untrusted. Pure + side-effect-free so the gate decision is
 * trivially unit-testable in isolation (the receiver wraps it with the loopback
 * 200/401 response).
 *
 * This mirrors the discipline a REAL ingestion route must enforce; the product
 * has no such route at HEAD (the AUTO-05 finding), so this gate lives on the
 * harness side. NOT a timing-safe compare — a test fixture, not production auth
 * (the real grammy `webhookCallback({ secretToken })` owns the production check
 * IF a route is ever added).
 */
export function checkWebhookSecretToken(expected: string, presented: string | undefined): boolean {
  if (presented === undefined) return false;
  return presented === expected;
}

/**
 * A `RecordedOutbound` — the full option set captured for every outbound the
 * agent pushes to the channel (design §4.4). Later phases assert on the FULL
 * set; the 204 round-trip only needs `text` + `messageId`, but recording
 * everything now avoids a later refactor.
 *
 * This is the telegram-specific SUPERSET of the channel-agnostic
 * {@link AgnosticRecordedOutbound} lifted to `harness/recorded-outbound.ts`
 * (the foundation-fix, CHAN2-02). It `extends` the lifted subset so the
 * superset relationship is a compile-time guarantee: the channel-neutral
 * `method`/`messageId`/`text?` come from the base; the telegram-specific extras
 * below are additive. The generic `control-api` + the dual oracle consume only
 * the lifted subset, so they have no edge on these telegram-specific fields.
 */
export interface RecordedOutbound extends AgnosticRecordedOutbound {
  // method: string;     — inherited from AgnosticRecordedOutbound (the Bot-API
  //                       method, e.g. "sendMessage" | "setMessageReaction").
  // messageId: number;  — inherited (the minted bot message id on sendMessage;
  //                       the reacted-to id for reactions).
  // text?: string;      — inherited (message text on sendMessage).
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
 * The Telegram error envelope a fault returns (FAULT-01). Mirrors the real Bot
 * API's failure shape `{ ok:false, error_code, description, parameters? }` —
 * NOT `okEnvelope`'s `{ ok:true, result }`. The real grammy adapter turns this
 * into a thrown `GrammyError` (`.error_code`/`.description`/`.parameters`
 * structural; `.message` = `Call to '<method>' failed! (<code>: <desc>)`), which
 * the four adapter fallbacks + `classifyTelegramError` key on.
 */
export interface TgFault {
  /** The Telegram error code (e.g. 400/403/429). */
  readonly error_code: number;
  /** The error description — the fallbacks match substrings of this (e.g. "VOICE_MESSAGES_FORBIDDEN"). */
  readonly description: string;
  /** Optional Telegram parameters (e.g. `{ retry_after }` for a 429 → @grammyjs/auto-retry). */
  readonly parameters?: Record<string, unknown>;
}

/**
 * Options for {@link TgEmulator.fail} (FAULT-01).
 *   - `once`     — fail only the NEXT matching call, then auto-clear so the
 *                  adapter's RETRY (the second call) succeeds; the recorded
 *                  retry outbound is what a fallback assertion reads.
 *   - `matchChat`— scope the fault to one chat id (read from the request
 *                  `chat_id`); calls to other chats are unaffected. Unset → the
 *                  fault applies to every call of the method.
 */
export interface FailOpts {
  /** Fail only the next matching call (then auto-clear) — lets the retry succeed. */
  readonly once?: boolean;
  /** Restrict the fault to this chat id (unset → all chats). */
  readonly matchChat?: number;
}

/**
 * A group member / sender shape (GROUP-01). The same loose `{ id, firstName,
 * username? }` the inject verbs accept — `createGroupChat` records the member
 * set + the admin subset so COVER-01's `getChatAdministrators` (Plan 03) can
 * report the seed and the rig can drive multi-user cross-talk.
 */
export interface GroupMember {
  readonly id: number;
  readonly firstName: string;
  readonly username?: string;
}

/**
 * Options for {@link TgEmulator.createGroupChat} (GROUP-01). `supergroup`
 * upgrades the chat to a supergroup; `forum: true` (always a supergroup) sets
 * the `is_forum` flag the mapper reads. `admins` seeds the admin subset
 * (recorded for a Plan-03 `getChatAdministrators`); `chatId` pins a specific
 * NEGATIVE id (else one is minted).
 */
export interface CreateGroupChatOptions {
  /** The chat members (distinct senders for group cross-talk). */
  readonly members: readonly GroupMember[];
  /** The bot identity (recorded; the mention/command builders address `@<bot.username>`). */
  readonly bot?: GroupMember;
  /** Upgrade to a supergroup (the modern form; forums are always supergroups). */
  readonly supergroup?: boolean;
  /** Mark as a forum (sets `is_forum`; implies supergroup). */
  readonly forum?: boolean;
  /** The admin subset (recorded for the Plan-03 `getChatAdministrators` seed). */
  readonly admins?: readonly GroupMember[];
  /** Pin a specific NEGATIVE chat id (else one is minted in the `-100…` form). */
  readonly chatId?: number;
}

/**
 * A reference to a forum topic (GROUP-01) — the `message_thread_id` an
 * {@link TgEmulator.injectMessage} `thread` opt routes to.
 */
export interface ThreadRef {
  /** The chat the topic lives in. */
  readonly chatId: number;
  /** The forum topic's `message_thread_id`. */
  readonly threadId: number;
  /** The topic name (`createForumTopic(chat, name)`). */
  readonly name: string;
}

/**
 * Addressing/threading options for {@link TgEmulator.injectMessage} (GROUP-02).
 * Every field is OPTIONAL — an empty/absent `InjectOpts` is byte-identical to the
 * pre-208 single-arg DM call. Mutually composable.
 */
export interface InjectOpts {
  /** Add a `mention` entity over `@<bot.username>` (→ `isBotMentioned`). */
  readonly mention?: boolean;
  /** Add a `bot_command` entity over the leading `/cmd[@bot]` token (→ `isBotCommand`). */
  readonly command?: boolean;
  /** Set `reply_to_message` to a bot-authored message with this id (→ `replyToBot`). */
  readonly replyTo?: number;
  /** Set `reply_to_message` to a message authored by this NON-bot user id (a reply to another member, NOT the bot). */
  readonly replyToUser?: number;
  /** Set `message_thread_id` (the forum topic the thread resolver reads). */
  readonly thread?: number;
  /** Mark the message text as a spoiler (the inbound spoiler flag). */
  readonly spoiler?: boolean;
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
   * Create a group/supergroup/forum chat (GROUP-01) — records the member set +
   * the admin subset (for a Plan-03 `getChatAdministrators` seed) + the
   * forum/bot metadata, and returns a {@link ChatRef} carrying a NEGATIVE chat
   * id (the `-100…` supergroup form). The recorded chat shape is what
   * {@link injectMessage} stamps onto group message updates.
   */
  createGroupChat(opts: CreateGroupChatOptions): ChatRef;
  /**
   * Create a forum topic in a (forum) supergroup (GROUP-01) — mints a
   * `message_thread_id` and returns a {@link ThreadRef} the
   * {@link injectMessage} `thread` opt routes to.
   */
  createForumTopic(chat: ChatRef, name: string): ThreadRef;
  /**
   * Queue an inbound text message from `from` in `chat` for the next
   * `getUpdates` long-poll (builds a grammy-typed `Update` via `tg-payloads`).
   *
   * With no `opts` (or an empty one) this is the pre-208 DM call — the chat is
   * the `private` literal and no addressing fields are set (back-compat). When
   * `chat` is a group created via {@link createGroupChat}, the recorded group/
   * forum chat shape is stamped on; `opts` threads the addressing entities
   * (mention/command), the `reply_to_message` (replyTo/replyToUser), and the
   * `message_thread_id` (thread) the mapper's addressing + thread resolvers read.
   * @returns the minted `message_id` of the injected update.
   */
  injectMessage(
    chat: ChatRef,
    from: { id: number; firstName: string; username?: string },
    text: string,
    opts?: InjectOpts,
  ): number;
  /**
   * The webhook-POST mode (AUTO-05): instead of queuing the inbound for the next
   * `getUpdates` long-poll (the default polling path of {@link injectMessage}),
   * POST the SAME grammy `message` `Update` (built by the SAME `tg-payloads`
   * builders, so its shape is identical to the polled one) to the emulator's
   * configured `webhook.url`, carrying the `X-Telegram-Bot-Api-Secret-Token:
   * <webhook.secret>` header. Returns the HTTP status the webhook target
   * responded with (200 if the harness-side gate accepted the configured token;
   * 401 if the gate rejected a wrong/absent token), so a scenario can assert the
   * secret-token gate WITHOUT a product ingestion route.
   *
   * ⚠ This requires the emulator to be constructed with a `webhook` option (the
   * URL of a {@link createWebhookReceiver}-style target). Calling it without one
   * throws — the webhook-POST mode is opt-in; the default inject path is
   * unchanged. The PRODUCT has no webhook ingestion route at HEAD (the AUTO-05
   * finding) — this drives the harness-side gate, never a real agent delivery.
   *
   * @param secretOverride when set, POST this token in the header INSTEAD of the
   *   configured `webhook.secret` — so a scenario can drive the WRONG-token and
   *   ABSENT-token (empty string) reject cases against the same receiver.
   * @returns the webhook target's HTTP status code.
   */
  postWebhookMessage(
    chat: ChatRef,
    from: { id: number; firstName: string; username?: string },
    text: string,
    secretOverride?: string,
  ): Promise<number>;
  /**
   * Queue an inbound forum-service `message` update of `kind` (COVER-02) for the
   * next `getUpdates` long-poll (builds it via {@link makeServiceMessageUpdate}).
   * The adapter's message handler FILTERS these six kinds at
   * `telegram-inbound.ts:50-58` — so the negative scenario proves the service
   * message is NEVER dispatched to the agent. `chat` should be a (forum)
   * supergroup created via {@link createGroupChat}; the builder rides a
   * supergroup chat regardless (forum service messages occur in supergroups).
   * Mints a `message_id` (the service message IS a message), like
   * {@link injectMessage}.
   * @returns the minted `message_id`.
   */
  injectServiceMessage(chat: ChatRef, kind: ForumServiceKind): number;
  /**
   * The Bot-API method names a UC called that are NOT implemented on demand —
   * each routed through the honest unimplemented-log fallback (COVER-01, HARD
   * constraint 3). A Tier-3 method the harness has not wired logs
   * `[tg-emulator] unimplemented Bot-API method: <name>` AND is appended here, so
   * a scenario can DETECT it instead of a silent no-op falsely reporting coverage
   * (the no-false-success principle — T-208-10). Names appear in call order, with
   * duplicates (one entry per call).
   */
  unimplementedCalls(): readonly string[];
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
  /**
   * Inject a fault (FAULT-01): make the Bot-API `method` return the Telegram
   * error envelope `{ ok:false, error_code, description, parameters? }` instead
   * of its normal `okEnvelope`, so the REAL adapter hits the error and runs its
   * fallback (parse_mode retry / thread-not-found retry / voice→document /
   * reaction safe-emoji chain). Honors `once` (fail the next call, then
   * auto-clear so the retry succeeds) and `matchChat` (scope to one chat).
   * Setting a fault for a method REPLACES any prior fault for that method.
   */
  fail(method: string, error: TgFault, opts?: FailOpts): void;
  /** Clear ALL injected faults (called between cases, like {@link resetChat}). */
  clearFaults(): void;
}

/**
 * The webhook-POST configuration (AUTO-05). When set, {@link TgEmulator.postWebhookMessage}
 * POSTs the built Update to `url` carrying the `X-Telegram-Bot-Api-Secret-Token:
 * <secret>` header (instead of queuing for `getUpdates`). The `url` is a
 * harness-side receiver (`createWebhookReceiver`), NOT a product ingestion route
 * — Comis has none at HEAD (the AUTO-05 finding).
 */
export interface WebhookConfig {
  /** The loopback webhook target the POST mode delivers to (a `createWebhookReceiver` URL). */
  readonly url: string;
  /** The configured `secret_token` stamped into the `X-Telegram-Bot-Api-Secret-Token` header. */
  readonly secret: string;
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
  /**
   * Opt-in webhook-POST mode config (AUTO-05). When present,
   * {@link TgEmulator.postWebhookMessage} POSTs Updates to `url` with the
   * secret-token header instead of queuing for `getUpdates`. Absent (the
   * default) → the emulator is polling-only and `postWebhookMessage` throws.
   */
  readonly webhook?: WebhookConfig;
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
 * Extract the simple (non-file) text fields from a multipart/form-data body.
 * grammy sends file methods (`sendVoice`/`sendDocument`/…) as multipart: each
 * `name="<field>"` part carries either a scalar value (e.g. `chat_id`,
 * `caption`) or an `attach://…` reference / the file bytes. We read ONLY the
 * scalar text fields (the ones the oracle records — `chat_id`, `caption`) and
 * skip the binary file part (FAULT-01 (c): the voice→document fallback's caption
 * "Voice message (sent as file)" rides as a `caption` field). A field whose
 * value is an `attach://…` reference is a file pointer, not a scalar — skipped.
 */
function parseMultipart(body: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  // Split on the part separator (grammy uses `------------<rand>` boundaries);
  // each part starts with a `content-disposition` line naming the field.
  const partRe = /content-disposition:\s*form-data;\s*name="([^"]+)"([^]*?)(?=\r?\n--|\s*--\s*$)/gi;
  let m: RegExpExecArray | null;
  while ((m = partRe.exec(body)) !== null) {
    const name = m[1];
    if (name === undefined) continue;
    // A part carrying `filename=` or a `content-type` header is the file body —
    // skip it (we only record the scalar fields). The value follows the blank
    // line after the header(s).
    const rest = m[2] ?? "";
    if (/filename=|content-type:/i.test(rest.split(/\r?\n\r?\n/)[0] ?? "")) continue;
    const blank = rest.search(/\r?\n\r?\n/);
    if (blank < 0) continue;
    const value = rest.slice(blank).replace(/^\r?\n\r?\n/, "").replace(/\r?\n$/, "").trim();
    // `attach://…` is grammy's file-pointer placeholder, not a scalar value.
    if (value.startsWith("attach://")) continue;
    out[name] = value;
  }
  return out;
}

/**
 * Parse a Bot-API request body. grammy's HTTP client sends method args as a
 * JSON body, form-encoded, OR (for file methods) multipart/form-data; read
 * defensively from all three (mock-telegram-server dual parse + the multipart
 * extension for FAULT-01 (c)). A malformed body yields `{}` (the base already
 * guarantees the server stays up).
 */
function parseBody(body: string): Record<string, unknown> {
  if (body.length === 0) return {};
  // multipart/form-data (file sends): extract the scalar fields (chat_id/caption).
  if (/content-disposition:\s*form-data/i.test(body)) {
    return parseMultipart(body);
  }
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
 * The COMPLETE Tier-3 group-admin Bot-API method set (design Appendix-A). The
 * emulator implements the ones the COVER-01 UC drives on demand (see the
 * `dispatch` switch); EVERY other name in this set, when a UC calls it, routes
 * through the honest unimplemented-log fallback (`[tg-emulator] unimplemented
 * Bot-API method: <name>` + an `unimplementedCalls()` record) — NEVER a silent
 * `okEnvelope({})` (HARD constraint 3, T-208-10). A method NOT in this set (e.g.
 * an unrelated boot call like `deleteWebhook`) stays the benign generic default
 * so it does not pollute the coverage ledger or break boot.
 */
const TIER3_METHODS: ReadonlySet<string> = new Set([
  "pinChatMessage",
  "unpinChatMessage",
  "sendPoll",
  "sendSticker",
  "getChat",
  "getChatMemberCount",
  "getChatAdministrators",
  "setChatTitle",
  "setChatDescription",
  "banChatMember",
  "unbanChatMember",
  "promoteChatMember",
  "createForumTopic",
  "editForumTopic",
  "closeForumTopic",
  "reopenForumTopic",
  "sendChatAction",
]);

/**
 * The emulator's stable bot identity (matches the `getMe` envelope below). Used
 * to author the `reply_to_message` a `replyTo` opt points at, so the mapper's
 * `detectBotAddressing` flips `replyToBot` (it compares `reply_to_message.from.id`
 * to the bot id).
 */
const EMULATOR_BOT_IDENTITY = { id: 12345, firstName: "TestBot", username: "test_bot" } as const;

/**
 * Build the GROUP-02 addressing fields (`entities` + `reply_to_message`) for an
 * injected group message from its {@link InjectOpts}. Mirrors exactly what the
 * REAL adapter's `detectBotAddressing` reads (message-mapper.ts:40-104):
 *  - `mention`     → a `mention` entity spanning `@<bot.username>` in the text.
 *  - `command`     → a `bot_command` entity spanning the leading `/cmd[@bot]` token.
 *  - `replyTo`     → a `reply_to_message` authored BY the bot (→ replyToBot).
 *  - `replyToUser` → a `reply_to_message` authored by a NON-bot member (NOT the bot).
 *
 * Returns only the fields that apply (undefined → the builder omits them,
 * keeping the exactOptionalPropertyTypes discipline). `bot` defaults to the
 * emulator's identity so a mention/command addresses `@test_bot` even when the
 * caller did not pass a bot to `createGroupChat`.
 */
function buildInjectAddressing(
  text: string,
  opts: InjectOpts | undefined,
  bot: GroupMember | undefined,
): { entities?: MessageEntity[]; replyToMessage?: Message } {
  if (opts === undefined) return {};
  const botUsername = bot?.username ?? EMULATOR_BOT_IDENTITY.username;
  const entities: MessageEntity[] = [];

  if (opts.mention === true) {
    // Locate `@<botUsername>` in the text; default to offset 0 / the handle
    // length when it is not literally present (the caller is responsible for
    // including it, like a real client, but a missing handle still yields a
    // well-formed entity the detector compares against).
    const handle = `@${botUsername}`;
    const idx = text.indexOf(handle);
    const offset = idx >= 0 ? idx : 0;
    const length = idx >= 0 ? handle.length : handle.length;
    entities.push({ type: "mention", offset, length });
  }

  if (opts.command === true) {
    // The leading `/cmd` or `/cmd@bot` token — a bot_command entity from offset 0
    // spanning the first whitespace-delimited token.
    const firstToken = text.split(/\s/)[0] ?? text;
    entities.push({ type: "bot_command", offset: 0, length: firstToken.length });
  }

  const result: { entities?: MessageEntity[]; replyToMessage?: Message } = {};
  if (entities.length > 0) result.entities = entities;

  // reply_to_message: replyTo → a bot-authored message (the mapper's
  // detectBotAddressing flips replyToBot because reply_to_message.from.id === bot
  // id). The nested chat id is immaterial — only `from.id` is read — so a 0 chat
  // is fine. replyToUser → a reply to ANOTHER member (a non-bot author), which
  // must NOT flip replyToBot.
  if (opts.replyTo !== undefined) {
    result.replyToMessage = makeBotMessage({
      messageId: opts.replyTo,
      chatId: 0,
      botUser: makeBotUser({
        id: EMULATOR_BOT_IDENTITY.id,
        firstName: EMULATOR_BOT_IDENTITY.firstName,
        username: EMULATOR_BOT_IDENTITY.username,
      }),
    });
  } else if (opts.replyToUser !== undefined) {
    const replyUser: User = makeUser({ id: opts.replyToUser, firstName: `user_${opts.replyToUser}` });
    result.replyToMessage = {
      message_id: 0,
      from: replyUser,
      chat: { id: 0, type: "private", first_name: replyUser.first_name },
      date: Math.floor(Date.now() / 1000),
    };
  }

  return result;
}

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
  // AUTO-05: the opt-in webhook-POST target (URL + secret). Absent → the
  // emulator is polling-only and `postWebhookMessage` throws (the default inject
  // path is unchanged). When present, `postWebhookMessage` POSTs the built
  // Update to `webhook.url` with the `X-Telegram-Bot-Api-Secret-Token` header.
  const webhook = opts.webhook;

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
  // GROUP-01: per-chat group metadata (the recorded chat shape + members +
  // admins + bot identity). `injectMessage` stamps the recorded `Chat` onto a
  // group message so the mapper derives chatType group|forum + reads is_forum;
  // a chat with no group record is a DM (the `private` literal — back-compat).
  const groupChats = new Map<
    number,
    { chat: Chat.GroupChat | Chat.SupergroupChat; members: GroupMember[]; admins: GroupMember[]; bot?: GroupMember }
  >();
  // Forum topic id source — strictly above the General Topic (id=1), so a minted
  // custom topic never collides with the implicit General topic the mapper
  // defaults to (thread-context.ts:17,71).
  let nextThreadId = 2;
  // Group chat id source (the NEGATIVE `-100…` Telegram supergroup form) when a
  // caller does not pin one. Decrements so successive groups get distinct ids.
  let nextGroupChatSeq = 1;
  // FAULT-01: per-method fault map. Before a Bot-API method returns its
  // okEnvelope, `maybeFault` consults this map; a matching fault (honoring
  // once/matchChat) returns the Telegram error envelope instead so the REAL
  // adapter runs its fallback. An empty map (the default) leaves every method
  // unchanged — existing scenarios are unaffected.
  const faults = new Map<string, { error: TgFault; once?: boolean; matchChat?: number }>();
  // COVER-01 (HARD constraint 3): the ordered list of Tier-3 Bot-API methods a
  // UC drove that are NOT implemented on demand. Each such call routes through
  // `logUnimplemented` (an honest `[tg-emulator] unimplemented Bot-API method:
  // <name>` log) and is appended here so a scenario can DETECT it — a silent
  // no-op would FALSELY report coverage (the no-false-success principle,
  // T-208-10). Surfaced via `unimplementedCalls()`.
  const unimplemented: string[] = [];
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

  /**
   * FAULT-01 — if a fault is set for `method` and it applies to this call
   * (`matchChat` unset OR equal to the request `chat_id`), return the Telegram
   * error envelope `{ ok:false, error_code, description, parameters? }` and, when
   * `once`, delete the entry so the NEXT call (the adapter's retry) succeeds.
   * Returns `undefined` when no fault applies (the method proceeds normally).
   */
  function maybeFault(method: string, body: Record<string, unknown>): RouteResult | undefined {
    const fault = faults.get(method);
    if (fault === undefined) return undefined;
    if (fault.matchChat !== undefined) {
      const chatId = Number(body["chat_id"] ?? NaN);
      if (chatId !== fault.matchChat) return undefined;
    }
    if (fault.once) faults.delete(method);
    return {
      status: 200,
      body: {
        ok: false,
        error_code: fault.error.error_code,
        description: fault.error.description,
        ...(fault.error.parameters !== undefined ? { parameters: fault.error.parameters } : {}),
      },
    };
  }

  function dispatch(method: string, ctx: { body: string; query: string }): RouteResult | Promise<RouteResult> {
    const body = parseBody(ctx.body);
    const query = new URLSearchParams(ctx.query);

    // FAULT-01: consult the fault map BEFORE the method runs. A matching fault
    // returns the Telegram error envelope so the REAL adapter hits the error and
    // runs its fallback; no fault → the method proceeds to its okEnvelope.
    const faulted = maybeFault(method, body);
    if (faulted !== undefined) return faulted;

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

      case "sendPhoto":
      case "sendAudio":
      case "sendVideo":
      case "sendVoice":
      case "sendDocument":
        // Media OUTBOUND delivery. The real grammy adapter (telegram-outbound.ts)
        // calls sendPhoto (image-gen), sendAudio (TTS/music), sendVideo (video-gen),
        // sendVoice (voice note), sendDocument (file / the FAULT-01 (c) voice→document
        // fallback). RECORD all so media delivery is assertable on the chat oracle —
        // grammy sends these as multipart; `parseBody` extracted the scalar
        // caption/chat_id fields.
        // (openclaw-usecases 2026-06-25: image-gen produced a real 1536×1024 PNG and
        // TTS a real MP3, but delivery was UNOBSERVABLE — sendPhoto/sendAudio fell to
        // the default `okEnvelope({})` → no message_id minted (`messageId:"undefined"`
        // in the adapter log) and nothing recorded, so the channel oracle showed 0
        // media sends. Routing them through sendMediaMethod mints the id + records.)
        return sendMediaMethod(method, body);

      // COVER-01 — the Tier-3 group-admin methods implemented ON DEMAND (the set
      // the COVER UC drives). `getChatAdministrators` reports the createGroupChat
      // admins[] seed; `pinChatMessage`/`sendChatAction` record the round-trip;
      // `getChat`/`getChatMemberCount` are the read round-trips. Every OTHER
      // Tier-3 method (TIER3_METHODS) falls to `default` → the honest log.
      case "getChatAdministrators":
        return getChatAdministrators(body);

      case "pinChatMessage":
        return pinChatMessage(body);

      case "sendChatAction":
        return sendChatAction(body);

      case "getChat":
        return getChatInfo(body);

      case "getChatMemberCount":
        return getChatMemberCount(body);

      default: {
        // HARD constraint 3 (T-208-10): a Tier-3 method NOT implemented on demand
        // must LOG honestly + be surfaced via unimplementedCalls() — NEVER a
        // silent okEnvelope. An unrelated boot call (not in TIER3_METHODS) stays
        // the benign accept-and-record so it does not fail boot or pollute the
        // coverage ledger.
        if (TIER3_METHODS.has(method)) return logUnimplemented(method, body);
        return okEnvelope({});
      }
    }
  }

  /**
   * The honest unimplemented-Tier-3 fallback (HARD constraint 3). Logs
   * `[tg-emulator] unimplemented Bot-API method: <name>` and appends the method
   * to `unimplemented` (surfaced via {@link TgEmulator.unimplementedCalls}) so a
   * scenario can DETECT the gap — a silent no-op would falsely report coverage.
   * Still records the call on the chat oracle (when a `chat_id` is present) so
   * the call is provable, then returns a benign `okEnvelope({})` so grammy does
   * not throw and the adapter's `platformAction` still resolves `ok` (the honest
   * signal is the LOG + the ledger entry, not a transport failure).
   * `console.warn` is fine in `test/` (outside the packages source rules).
   */
  function logUnimplemented(method: string, body: Record<string, unknown>): RouteResult {
    unimplemented.push(method);
    console.warn(`[tg-emulator] unimplemented Bot-API method: ${method}`);
    const chatId = Number(body["chat_id"] ?? NaN);
    if (!Number.isNaN(chatId)) {
      record(chatId, { method, messageId: 0, raw: body });
    }
    return okEnvelope({});
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

  function sendMediaMethod(method: string, body: Record<string, unknown>): RouteResult {
    // FAULT-01 (c) — sendVoice / sendDocument. Mint a message_id + RECORD the
    // outbound (method + caption) so the voice→document fallback's recorded
    // sendDocument (caption "Voice message (sent as file)") is assertable on the
    // chat oracle. The bytes themselves are not stored (the fallback only needs
    // the recorded method + caption); chat_id/caption came from the multipart
    // scalar fields `parseBody` extracted.
    const chatId = Number(body["chat_id"] ?? 0) || 0;
    const messageId = nextMessageId++;
    const ro: RecordedOutbound = {
      method,
      messageId,
      raw: body,
    };
    // Map the Bot API method → the RecordedOutbound.mediaKind the channel oracle
    // asserts on (so a test can read `mediaKind === "photo"` not just `method`).
    const mediaKindByMethod: Record<string, string> = {
      sendPhoto: "photo",
      sendAudio: "audio",
      sendVoice: "voice",
      sendVideo: "video",
      sendDocument: "document",
    };
    const mk = mediaKindByMethod[method];
    if (mk !== undefined) ro.mediaKind = mk;
    if (typeof body["caption"] === "string") ro.caption = body["caption"];
    record(chatId, ro);
    return okEnvelope({
      message_id: messageId,
      date: Math.floor(Date.now() / 1000),
      chat: { id: chatId, type: "private" },
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

  function getChatAdministrators(body: Record<string, unknown>): RouteResult {
    // COVER-01 keystone — report the createGroupChat admins[] seed for this
    // chat_id. grammy's getChatAdministrators returns an array of
    // ChatMemberOwner|ChatMemberAdministrator; the production platformAction
    // reads a.user.{id,first_name,is_bot} + a.status. The FIRST seeded admin is
    // the owner (status "creator"); the rest are administrators. A chat with no
    // group record (or no seed) returns [] — no phantom admins.
    const chatId = Number(body["chat_id"] ?? NaN);
    const group = Number.isNaN(chatId) ? undefined : groupChats.get(chatId);
    const admins = group?.admins ?? [];
    const result = admins.map((m, idx) => {
      const user: User = makeUser({
        id: m.id,
        firstName: m.firstName,
        ...(m.username !== undefined ? { username: m.username } : {}),
      });
      // The first seeded admin is the creator; the rest are administrators. Only
      // the fields the platformAction reads must be exact; the privilege flags
      // are realistic defaults (grammy's client does not deep-validate `result`).
      return idx === 0
        ? { status: "creator" as const, user, is_anonymous: false }
        : {
            status: "administrator" as const,
            user,
            can_be_edited: false,
            is_anonymous: false,
            can_manage_chat: true,
            can_delete_messages: true,
            can_manage_video_chats: true,
            can_restrict_members: true,
            can_promote_members: false,
            can_change_info: true,
            can_invite_users: true,
            can_post_stories: false,
            can_edit_stories: false,
            can_delete_stories: false,
          };
    });
    return okEnvelope(result);
  }

  function pinChatMessage(body: Record<string, unknown>): RouteResult {
    // COVER-01 — a Tier-3 mutation round-trip. RECORD the pin on the chat oracle
    // (provable) + return `true` (grammy expects a boolean result; the adapter's
    // `pin` action maps it to `{ pinned: true }`).
    const chatId = Number(body["chat_id"] ?? 0) || 0;
    const messageId = Number(body["message_id"] ?? 0) || 0;
    record(chatId, { method: "pinChatMessage", messageId, raw: body });
    return okEnvelope(true);
  }

  function sendChatAction(body: Record<string, unknown>): RouteResult {
    // COVER-01 — the typing side of the General-Topic id=1 asymmetry. RECORD the
    // action + its message_thread_id VERBATIM (including id=1, which sendMessage
    // omits) so the asymmetry's typing half is assertable on the oracle.
    const chatId = Number(body["chat_id"] ?? 0) || 0;
    const messageId = 0;
    const ro: RecordedOutbound = { method: "sendChatAction", messageId, raw: body };
    if (body["message_thread_id"] !== undefined) ro.messageThreadId = Number(body["message_thread_id"]);
    record(chatId, ro);
    return okEnvelope(true);
  }

  function getChatInfo(body: Record<string, unknown>): RouteResult {
    // COVER-01 — a Tier-3 read round-trip. Echo the recorded group chat shape (a
    // ChatFullInfo-shaped descriptor: id + type [+ title/is_forum]); the
    // production `chat_info` action returns the chat verbatim. An unseeded chat
    // returns a minimal private descriptor (no group record).
    const chatId = Number(body["chat_id"] ?? 0) || 0;
    const group = groupChats.get(chatId);
    if (group !== undefined) {
      return okEnvelope({ ...group.chat });
    }
    return okEnvelope({ id: chatId, type: "private" });
  }

  function getChatMemberCount(body: Record<string, unknown>): RouteResult {
    // COVER-01 — a Tier-3 read round-trip. Return the recorded member count + the
    // bot (the seeded members plus the bot identity), like Telegram counts the
    // bot itself. grammy expects a number; the adapter maps it to `{ count }`.
    const chatId = Number(body["chat_id"] ?? 0) || 0;
    const group = groupChats.get(chatId);
    const count = group === undefined ? 0 : group.members.length + (group.bot !== undefined ? 1 : 0);
    return okEnvelope(count);
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

    injectMessage(chat, from, text, opts) {
      const messageId = nextMessageId++;
      const user: User = makeUser({
        id: from.id,
        firstName: from.firstName,
        ...(from.username !== undefined ? { username: from.username } : {}),
      });
      // GROUP-01: if this chat was created via createGroupChat, stamp the recorded
      // group/forum `Chat` so the mapper derives chatType group|forum + reads
      // is_forum. A chat with no group record is a DM (the builder's `private`
      // literal default — back-compat).
      const group = groupChats.get(chat.chatId);
      // GROUP-02 addressing: build the entities / reply_to_message the mapper's
      // detectBotAddressing reads, from the InjectOpts.
      const addressing = buildInjectAddressing(text, opts, group?.bot);
      const update = makeMessageUpdate({
        updateId: nextUpdateId(),
        messageId,
        from: user,
        chatId: chat.chatId,
        text,
        ...(group !== undefined ? { chat: group.chat } : {}),
        ...(addressing.entities !== undefined ? { entities: addressing.entities } : {}),
        ...(addressing.replyToMessage !== undefined ? { replyToMessage: addressing.replyToMessage } : {}),
        ...(opts?.thread !== undefined ? { messageThreadId: opts.thread } : {}),
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

    async postWebhookMessage(chat, from, text, secretOverride) {
      // AUTO-05 — the webhook-POST mode. Requires the opt-in `webhook` config;
      // the default (polling) emulator has none → throw (this mode is opt-in,
      // the polling inject path is untouched).
      if (webhook === undefined) {
        throw new Error(
          "postWebhookMessage requires the emulator to be constructed with a `webhook` option (AUTO-05 webhook-POST mode)",
        );
      }
      const messageId = nextMessageId++;
      const user: User = makeUser({
        id: from.id,
        firstName: from.firstName,
        ...(from.username !== undefined ? { username: from.username } : {}),
      });
      // Build the SAME grammy `message` Update the polling path would queue
      // (identical shape — a webhook-delivered message Update is the same shape
      // as a polled one; §4.2 scope guard: no new update kind). The recorded
      // group chat (if any) is stamped on, like injectMessage.
      const group = groupChats.get(chat.chatId);
      const update = makeMessageUpdate({
        updateId: nextUpdateId(),
        messageId,
        from: user,
        chatId: chat.chatId,
        text,
        ...(group !== undefined ? { chat: group.chat } : {}),
      });
      // POST the Update to the configured webhook target carrying the
      // X-Telegram-Bot-Api-Secret-Token header. `secretOverride` lets a scenario
      // drive the WRONG-token / ABSENT-token (empty string) reject cases against
      // the same receiver; absent → the configured secret (the accept case).
      const token = secretOverride ?? webhook.secret;
      const res = await fetch(webhook.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [TELEGRAM_WEBHOOK_SECRET_TOKEN_HEADER]: token,
        },
        body: JSON.stringify(update),
      });
      // Drain the body so the socket frees (the receiver always responds JSON).
      await res.text().catch(() => undefined);
      // Return the HTTP status the gate produced (200 accept / 401 reject) — the
      // scenario asserts the secret-token gate on the harness side. NB: outbound
      // (sendMessage) is UNCHANGED — still the emulator's Bot API; only the
      // INBOUND delivery transport differs here.
      return res.status;
    },

    createGroupChat(opts) {
      // Mint a NEGATIVE supergroup-form id (`-100…`) unless the caller pins one.
      const chatId = opts.chatId ?? -(1_000_000_000_000 + nextGroupChatSeq++);
      const type: "group" | "supergroup" = opts.supergroup || opts.forum ? "supergroup" : "group";
      const chat = makeGroupChat({ id: chatId, type, ...(opts.forum === true ? { isForum: true } : {}) });
      groupChats.set(chatId, {
        chat,
        members: [...opts.members],
        admins: opts.admins !== undefined ? [...opts.admins] : [],
        ...(opts.bot !== undefined ? { bot: opts.bot } : {}),
      });
      // Ensure the oracle exists so outbound()/resetChat() are never silent.
      chatOracle(chatId);
      return { chatId };
    },

    createForumTopic(chat, name) {
      // A custom forum topic gets a fresh message_thread_id strictly above the
      // implicit General topic (id=1).
      const threadId = nextThreadId++;
      return { chatId: chat.chatId, threadId, name };
    },

    injectServiceMessage(chat, kind) {
      // COVER-02 — queue a forum-service `message` update the adapter FILTERS
      // (telegram-inbound.ts:50-58). Mints a message_id (the service message IS a
      // message), like injectMessage; the negative scenario asserts it never
      // reaches the captured onMessage.
      const messageId = nextMessageId++;
      const update = makeServiceMessageUpdate(kind, {
        updateId: nextUpdateId(),
        messageId,
        chatId: chat.chatId,
      });
      // Ensure the oracle exists for this chat (mirrors injectMessage).
      chatOracle(chat.chatId);
      pending.push(update);
      // Keep the bot-global queue strictly ascending by update_id (monotonic).
      pending.sort((a, b) => a.update_id - b.update_id);
      // Wake a blocked long-poll, if any, so the SAME call resolves.
      wakeWaiters();
      return messageId;
    },

    unimplementedCalls() {
      // A defensive copy — the caller cannot mutate the internal ledger.
      return [...unimplemented];
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

    fail(method, error, opts) {
      // Replace any prior fault for this method (last-writer-wins). The map is
      // consulted by `maybeFault` before the method's okEnvelope.
      faults.set(method, {
        error,
        ...(opts?.once !== undefined ? { once: opts.once } : {}),
        ...(opts?.matchChat !== undefined ? { matchChat: opts.matchChat } : {}),
      });
    },

    clearFaults() {
      faults.clear();
    },
  };

  return emulator;
}
