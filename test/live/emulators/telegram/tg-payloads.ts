// SPDX-License-Identifier: Apache-2.0
/**
 * grammy-typed Telegram `Update` / `Message` builders (TEST-01 / invariant I4,
 * Phase 204).
 *
 * The emulator's `getUpdates` (Plan 03) serves these builder-produced `Update`
 * values, and the scenario contract test (Plan 05) round-trips them through the
 * REAL production Telegram adapter (`mapGrammyToNormalized`). Because the
 * builders import grammy 1.43's OWN exported `Update` / `Message` / `User`
 * types and return-annotate against them, every emitted payload is *guaranteed*
 * to be exactly the shape the adapter parses — a grammy shape drift becomes a
 * COMPILE error here, not a silent runtime mismatch. That is the whole point:
 * it forecloses the hand-rolled Go-emulator drift problem this milestone exists
 * to avoid (design §1.3, threat T-204-04).
 *
 * Analog (the untyped literal this replaces): `injectInboundMessage` in
 * `test/e2e/mocks/telegram/mock-telegram-server.ts:227-245`. Same runtime
 * shape — now grammy-typed.
 *
 * Scope (Phase 207): the `message` Update (the DM text round-trip, Phase 204),
 * the `message_reaction` ADD Update (REACT-01, Phase 206), the inbound MEDIA
 * `message` (MEDIA-03 — `makeMediaUpdate`/`makeLocationUpdate`, mirroring
 * `buildAttachments`/`message-mapper`), the `callback_query` Update (INTERACT-01
 * — `makeCallbackUpdate`, the `telegram-inbound.ts:165` handler) AND the
 * `edited_message` Update (INTERACT-02 — `makeEditUpdate`, the
 * `telegram-inbound.ts:117` handler). The §4.2 scope guard now PERMITS those
 * kinds and still forbids the Out-of-Scope kinds (channel-post / inline-query /
 * poll-answer / chat-member updates) — the harness must not mint an update kind
 * the adapter does not handle (T-207-03).
 *
 * TEST-HARNESS — lives under `test/`, never `packages`; ZERO production code
 * change. `test/` is outside every `packages` source-tree ESLint/architecture rule.
 *
 * @module
 */

import type {
  CallbackQuery,
  Document,
  Location,
  Message,
  PhotoSize,
  ReactionTypeEmoji,
  Update,
  User,
  Venue,
  Video,
  VideoNote,
  Voice,
} from "grammy/types";

/**
 * Options for {@link makeUser} / {@link makeBotUser}.
 */
export interface MakeUserOptions {
  /** Telegram user id (numeric). */
  readonly id: number;
  /** Display first name. */
  readonly firstName: string;
  /** Optional @username (without the leading `@`). */
  readonly username?: string;
}

/**
 * Build a grammy `User` for a HUMAN sender (`is_bot: false`).
 *
 * The return type is grammy's own `User` — a shape drift is a compile error
 * (I4). `username` is included only when supplied (exact-optional-safe).
 */
export function makeUser(opts: MakeUserOptions): User {
  const user: User = {
    id: opts.id,
    is_bot: false,
    first_name: opts.firstName,
  };
  return opts.username === undefined ? user : { ...user, username: opts.username };
}

/**
 * Build a grammy `User` for the BOT (`is_bot: true`) — used where a bot-sender
 * is needed (e.g. echoing an outbound author). Same I4 typing guarantee.
 */
export function makeBotUser(opts: MakeUserOptions): User {
  const user: User = {
    id: opts.id,
    is_bot: true,
    first_name: opts.firstName,
  };
  return opts.username === undefined ? user : { ...user, username: opts.username };
}

/**
 * Options for {@link makeMessageUpdate}.
 */
export interface MakeMessageUpdateOptions {
  /** The Update's unique, monotonically-increasing id (the caller owns the counter; see {@link nextUpdateId}). */
  readonly updateId: number;
  /** The message's id inside the chat. */
  readonly messageId: number;
  /** The (human) sender — built via {@link makeUser}. */
  readonly from: User;
  /** The private-chat id this DM belongs to. */
  readonly chatId: number;
  /** The message text. */
  readonly text: string;
}

/**
 * Build a well-formed grammy `message` `Update` for the 204 DM round-trip.
 *
 * The return annotation IS grammy's `Update` (I4 tripwire). The literal
 * satisfies `Update.message: Message & Update.NonChannel` — a `private` chat
 * (`Chat.PrivateChat`) and a mandatory `from` `User`, which is exactly what the
 * adapter's `mapGrammyToNormalized` reads.
 *
 * `date` is `Math.floor(Date.now() / 1000)` — Telegram unix SECONDS, not
 * milliseconds; the adapter's message-mapper multiplies ×1000 to recover the
 * timestamp (message-mapper.ts:207, design §4.2). Emitting ms here would make
 * the mapped timestamp ~1000× too large.
 *
 * Only the `message` kind is populated by THIS builder — the other in-scope
 * kinds (reaction / media / callback / edit) each have their own builder; the
 * §4.2-Out-of-Scope kinds (channel-post / inline-query / poll-answer) are minted
 * by NO builder. The source-grep AC strips comment lines, so a doc-comment
 * naming a kind is not a false hit.
 */
export function makeMessageUpdate(opts: MakeMessageUpdateOptions): Update {
  return {
    update_id: opts.updateId,
    message: {
      message_id: opts.messageId,
      from: opts.from,
      // grammy's `Chat.PrivateChat` REQUIRES `first_name` (the other party in a
      // DM). In a private chat the chat IS the sender, so it mirrors `from`.
      // (The untyped mock omits this and compiles by accident — exactly the
      // drift the `: Update` annotation surfaces; I4.)
      chat: { id: opts.chatId, type: "private", first_name: opts.from.first_name },
      // Telegram unix SECONDS (NOT ms) — the mapper multiplies ×1000 (§4.2).
      date: Math.floor(Date.now() / 1000),
      text: opts.text,
    },
  };
}

/**
 * The closed set of inbound media kinds the harness mints — exactly the kinds
 * `buildAttachments` extracts (`media-handler.ts:84-108`). A `kind` outside this
 * union is a COMPILE error, so the emulator can never inject a media shape the
 * production extractor does not read.
 */
export type MediaKind = "photo" | "voice" | "document" | "video" | "video_note";

/**
 * Options for {@link makeMediaUpdate}.
 *
 * One discriminated `kind` per call. Only the field for that `kind` is set on
 * the emitted `message` — a `voice` update carries no `photo`/`document`/… (a
 * Telegram message holds at most one media type; `buildAttachments` checks each
 * independently). Every kind carries the caller-supplied `fileId`/`fileUniqueId`
 * — the SAME `file_id` `injectMedia` stores, so the emulator's file route and
 * the adapter's `tg-file://{file_id}` resolution agree.
 */
export interface MakeMediaUpdateOptions {
  /** The Update's unique, monotonically-increasing id (see {@link nextUpdateId}). */
  readonly updateId: number;
  /** The message's id inside the chat (a freshly-minted inbound id; `injectMedia` mints it). */
  readonly messageId: number;
  /** The private-chat id this media DM belongs to. */
  readonly chatId: number;
  /** The (human) sender — built via {@link makeUser}. */
  readonly from: User;
  /** Which single media kind to populate (a closed union — an off-union kind is a compile error). */
  readonly kind: MediaKind;
  /** The file id `buildAttachments` reads (`msg.<kind>.file_id`) and the emulator stores. */
  readonly fileId: string;
  /** The Telegram file_unique_id (grammy requires it on every media object). */
  readonly fileUniqueId: string;
  /** Media duration in seconds (voice/video/video_note — the mapper ×1000 → ms downstream). */
  readonly duration?: number;
  /** MIME type (voice/document/video — `extractVoice` falls back to `audio/ogg` when absent). */
  readonly mimeType?: string;
  /** Pixel width (photo/video — grammy's `PhotoSize`/`Video` require it). */
  readonly width?: number;
  /** Pixel height (photo/video — grammy's `PhotoSize`/`Video` require it). */
  readonly height?: number;
  /** Diameter (video_note — grammy's `VideoNote.length` is required). */
  readonly length?: number;
  /** File size in bytes (photo/document — optional, echoed when supplied). */
  readonly fileSize?: number;
  /** Original filename (document — optional, echoed when supplied). */
  readonly fileName?: string;
  /** When true, set `message.has_media_spoiler` (message-mapper.ts:142 → `metadata.hasSpoiler`). Omitted otherwise (exactOptionalPropertyTypes). */
  readonly spoiler?: boolean;
}

/**
 * Build the grammy-typed media object for a single {@link MediaKind}, carrying
 * exactly the fields `buildAttachments`'s per-kind `extract*` helper reads.
 *
 * Each branch return-annotates the grammy type (`PhotoSize[]`/`Voice`/…), so a
 * grammy field drift is a COMPILE error here (I4). Optional fields are spread
 * only when defined (`exactOptionalPropertyTypes` — an absent optional is NOT
 * `: undefined`).
 */
function buildMediaFields(
  opts: MakeMediaUpdateOptions,
): Partial<Pick<Message, "photo" | "voice" | "document" | "video" | "video_note">> {
  switch (opts.kind) {
    case "photo": {
      // A single-element PhotoSize[] is fine — buildAttachments takes the
      // largest = photos[len-1] (media-handler.ts:18). width/height are required
      // by grammy's PhotoSize; default to 1 when the caller omits them.
      const size: PhotoSize = {
        file_id: opts.fileId,
        file_unique_id: opts.fileUniqueId,
        width: opts.width ?? 1,
        height: opts.height ?? 1,
        ...(opts.fileSize !== undefined ? { file_size: opts.fileSize } : {}),
      };
      return { photo: [size] };
    }
    case "voice": {
      // extractVoice (media-handler.ts:41) reads file_id + mime_type (?? audio/ogg).
      const voice: Voice = {
        file_id: opts.fileId,
        file_unique_id: opts.fileUniqueId,
        duration: opts.duration ?? 0,
        ...(opts.mimeType !== undefined ? { mime_type: opts.mimeType } : {}),
        ...(opts.fileSize !== undefined ? { file_size: opts.fileSize } : {}),
      };
      return { voice };
    }
    case "document": {
      // extractDocument (media-handler.ts:28) reads file_id (+ optional mime/name/size).
      const document: Document = {
        file_id: opts.fileId,
        file_unique_id: opts.fileUniqueId,
        ...(opts.fileName !== undefined ? { file_name: opts.fileName } : {}),
        ...(opts.mimeType !== undefined ? { mime_type: opts.mimeType } : {}),
        ...(opts.fileSize !== undefined ? { file_size: opts.fileSize } : {}),
      };
      return { document };
    }
    case "video": {
      // extractVideo (media-handler.ts:53) reads file_id (+ optional mime_type).
      const video: Video = {
        file_id: opts.fileId,
        file_unique_id: opts.fileUniqueId,
        width: opts.width ?? 1,
        height: opts.height ?? 1,
        duration: opts.duration ?? 0,
        ...(opts.mimeType !== undefined ? { mime_type: opts.mimeType } : {}),
      };
      return { video };
    }
    case "video_note": {
      // extractVideoNote (media-handler.ts:64) reads file_id + duration (→ ms).
      const videoNote: VideoNote = {
        file_id: opts.fileId,
        file_unique_id: opts.fileUniqueId,
        length: opts.length ?? 1,
        duration: opts.duration ?? 0,
      };
      return { video_note: videoNote };
    }
  }
}

/**
 * Build a well-formed grammy `message` `Update` carrying ONE inbound media kind.
 *
 * The return annotation IS grammy's `Update` (I4 tripwire). The inner `message`
 * mirrors {@link makeMessageUpdate}'s literal (a `private` chat + a mandatory
 * `from`) plus exactly the per-`kind` media field `buildAttachments` extracts —
 * NOTHING the extractor does not read (MEDIA-03 / zero product change: the
 * builder emits only what production consumes). `has_media_spoiler` is set only
 * when `spoiler` is true (message-mapper.ts:142 → `metadata.hasSpoiler`); it is
 * OMITTED otherwise (exactOptionalPropertyTypes).
 *
 * `date` is `Math.floor(Date.now() / 1000)` — Telegram unix SECONDS (the mapper
 * ×1000 → ms; the 204/206 discipline).
 */
export function makeMediaUpdate(opts: MakeMediaUpdateOptions): Update {
  return {
    update_id: opts.updateId,
    message: {
      message_id: opts.messageId,
      from: opts.from,
      // PrivateChat requires first_name; in a DM the chat IS the sender.
      chat: { id: opts.chatId, type: "private", first_name: opts.from.first_name },
      // Telegram unix SECONDS (NOT ms) — the mapper multiplies ×1000.
      date: Math.floor(Date.now() / 1000),
      ...buildMediaFields(opts),
      ...(opts.spoiler === true ? { has_media_spoiler: true } : {}),
    },
  };
}

/**
 * A plain GPS point (the `location` branch of {@link MakeLocationUpdateOptions}).
 * Mirrors the fields `message-mapper.ts:184-187` reads.
 */
export interface LocationInput {
  /** Latitude (message-mapper.ts:184). */
  readonly latitude: number;
  /** Longitude (message-mapper.ts:185). */
  readonly longitude: number;
  /** Uncertainty radius in meters (message-mapper.ts:187 → `normalizeLocation` accuracy). */
  readonly horizontalAccuracy?: number;
}

/**
 * A named place (the `venue` branch). Mirrors `message-mapper.ts:175-181`
 * (`venue.location.{latitude,longitude}` + `venue.{title,address}`).
 */
export interface VenueInput {
  /** Venue latitude (message-mapper.ts:177). */
  readonly latitude: number;
  /** Venue longitude (message-mapper.ts:178). */
  readonly longitude: number;
  /** Venue name (message-mapper.ts:179 → `normalizeLocation` name). */
  readonly title: string;
  /** Venue address (message-mapper.ts:179 → `normalizeLocation` address). */
  readonly address: string;
}

/**
 * Options for {@link makeLocationUpdate}. Exactly one of `location` / `venue`
 * (a discriminated either — the mapper's `if (venue) … else if (location)`
 * precedence: a `venue` WINS, so the builder sets at most one).
 */
export type MakeLocationUpdateOptions = {
  readonly updateId: number;
  readonly messageId: number;
  readonly chatId: number;
  readonly from: User;
} & ({ readonly location: LocationInput; readonly venue?: never } | { readonly venue: VenueInput; readonly location?: never });

/**
 * Build a grammy `message` `Update` carrying a `location` OR a `venue`.
 *
 * No file store (a `message` update). The return annotation IS grammy's `Update`
 * (I4). For `venue`, the builder sets `message.venue` (and NOT `message.location`)
 * — matching the mapper's `else if` precedence (venue wins, message-mapper.ts:175);
 * for a plain point it sets `message.location`. `horizontal_accuracy` is omitted
 * when absent (exactOptionalPropertyTypes).
 */
export function makeLocationUpdate(opts: MakeLocationUpdateOptions): Update {
  const placeFields: Partial<Pick<Message, "location" | "venue">> = "venue" in opts && opts.venue !== undefined
    ? {
        venue: {
          location: { latitude: opts.venue.latitude, longitude: opts.venue.longitude },
          title: opts.venue.title,
          address: opts.venue.address,
        } satisfies Venue,
      }
    : {
        location: {
          latitude: opts.location.latitude,
          longitude: opts.location.longitude,
          ...(opts.location.horizontalAccuracy !== undefined
            ? { horizontal_accuracy: opts.location.horizontalAccuracy }
            : {}),
        } satisfies Location,
      };
  return {
    update_id: opts.updateId,
    message: {
      message_id: opts.messageId,
      from: opts.from,
      chat: { id: opts.chatId, type: "private", first_name: opts.from.first_name },
      date: Math.floor(Date.now() / 1000),
      ...placeFields,
    },
  };
}

/**
 * Options for {@link makeReactionUpdate}.
 */
export interface MakeReactionUpdateOptions {
  /** The Update's unique, monotonically-increasing id (the caller owns the counter; see {@link nextUpdateId}). */
  readonly updateId: number;
  /** The EXISTING bot reply's `message_id` — what `recordOutboundMessage` keyed the trajectory on (NOT a freshly-minted id; REACT-01 reacts to an already-sent message). */
  readonly messageId: number;
  /** The private-chat id this reaction belongs to. */
  readonly chatId: number;
  /** The reactor — built via {@link makeUser}. Must be ≠ the bot id, or the adapter's own-reaction filter drops it (telegram-inbound.ts:270). */
  readonly user: User;
  /**
   * The reaction emoji, typed as grammy's CLOSED `ReactionTypeEmoji["emoji"]`
   * union (message.d.ts:1446). The union contains `👍`/`👎`/`❌`/… but NOT `✅`
   * — even though the PRODUCT `DEFAULT_REACTION_MAP.success` lists `✅`, passing
   * it here is a COMPILE error (GOTCHA A). Use `👍` for the success path.
   */
  readonly emoji: ReactionTypeEmoji["emoji"];
}

/**
 * Build a well-formed grammy `message_reaction` ADD `Update` for REACT-01.
 *
 * The return annotation IS grammy's `Update` (I4 tripwire) and the inner literal
 * satisfies `MessageReactionUpdated` (message.d.ts:1468). It models a FRESH ADD:
 * `old_reaction: []` → `new_reaction: [{ type: "emoji", emoji }]`, which is
 * exactly the diff the already-wired adapter handler detects
 * (telegram-inbound.ts:272-273 — an emoji in `new_reaction` absent from
 * `old_reaction`). `user` is the reactor (≠ bot), so the handler's own-reaction
 * filter (:270) keeps it; `emojiNames` (:304) narrows on `type === "emoji"`.
 *
 * `date` is `Math.floor(Date.now() / 1000)` — Telegram unix SECONDS (same rule
 * as {@link makeMessageUpdate}); emitting ms would make the mapped timestamp
 * ~1000× too large.
 *
 * Only the `message_reaction` kind is populated by THIS builder (the callback /
 * edited-message kinds have their own Phase-207 builders; §4.2 scope guard).
 */
export function makeReactionUpdate(opts: MakeReactionUpdateOptions): Update {
  return {
    update_id: opts.updateId,
    message_reaction: {
      // grammy's `Chat.PrivateChat` REQUIRES `first_name`; in a DM the chat IS
      // the reactor, so it mirrors `user.first_name` (matches makeMessageUpdate).
      chat: { id: opts.chatId, type: "private", first_name: opts.user.first_name },
      message_id: opts.messageId,
      user: opts.user,
      // Telegram unix SECONDS (NOT ms), like makeMessageUpdate.
      date: Math.floor(Date.now() / 1000),
      // A fresh ADD: [] → [{ emoji }]. The empty old_reaction + single-emoji
      // new_reaction is exactly an ADD the adapter dispatches.
      old_reaction: [],
      new_reaction: [{ type: "emoji", emoji: opts.emoji }],
    },
  };
}

/**
 * Options for {@link makeBotMessage}.
 */
export interface MakeBotMessageOptions {
  /** The message's id inside the chat (the EXISTING bot reply id a callback taps). */
  readonly messageId: number;
  /** The private-chat id the bot reply lives in. */
  readonly chatId: number;
  /** The bot sender — built via {@link makeBotUser} (`is_bot: true`). */
  readonly botUser: User;
  /** Optional reply text (the bot's message body). Omitted when absent (exactOptional). */
  readonly text?: string;
}

/**
 * Build a grammy `Message` authored BY the bot — the EXISTING reply a
 * `callback_query` taps (it carries the `chat.id` + `message_id` the adapter
 * reads at `telegram-inbound.ts:173,181`). `from` is the bot (`is_bot: true`),
 * distinguishing it from an inbound human message. Return-annotated `: Message`
 * so a grammy drift is a compile error (I4).
 */
export function makeBotMessage(opts: MakeBotMessageOptions): Message {
  return {
    message_id: opts.messageId,
    from: opts.botUser,
    // PrivateChat requires first_name; in a DM the chat mirrors the other party.
    chat: { id: opts.chatId, type: "private", first_name: opts.botUser.first_name },
    date: Math.floor(Date.now() / 1000),
    ...(opts.text !== undefined ? { text: opts.text } : {}),
  };
}

/**
 * Options for {@link makeCallbackUpdate}.
 */
export interface MakeCallbackUpdateOptions {
  /** The Update's unique, monotonically-increasing id (see {@link nextUpdateId}). */
  readonly updateId: number;
  /** The callback query's unique id (`randomBytes` hex in practice). */
  readonly id: string;
  /** The TAPPING user — built via {@link makeUser} (≠ the bot; the handler reads `ctx.from.id`). */
  readonly from: User;
  /** The EXISTING bot reply the button belongs to — built via {@link makeBotMessage}. Carries `chat.id` + `message_id`. */
  readonly botMessage: Message;
  /** grammy's `CallbackQuery` REQUIRES `chat_instance` — a stable per-chat string. */
  readonly chatInstance: string;
  /** The button payload (`ctx.callbackQuery.data`) — a SCALAR string (IN-04 safe). */
  readonly data: string;
}

/**
 * Build a `callback_query` `Update` the adapter's button handler consumes
 * (`telegram-inbound.ts:165` — `answerCallbackQuery()` is the first statement,
 * then it reads `ctx.callbackQuery.message?.chat.id`, `ctx.from.id`,
 * `ctx.callbackQuery.data`, `ctx.callbackQuery.message.message_id`).
 *
 * The return annotation IS grammy's `Update` (I4). `message` is the EXISTING bot
 * `Message` (a regular accessible message — assignable to grammy's
 * `MaybeInaccessibleMessage`), `data` is a scalar string, `from` is the tapper.
 * Only the `callback_query` kind is populated (the §4.2 guard now PERMITS it —
 * lifted by INTERACT-01, Phase 207).
 */
export function makeCallbackUpdate(opts: MakeCallbackUpdateOptions): Update {
  const callbackQuery: CallbackQuery = {
    id: opts.id,
    from: opts.from,
    message: opts.botMessage,
    chat_instance: opts.chatInstance,
    data: opts.data,
  };
  return {
    update_id: opts.updateId,
    callback_query: callbackQuery,
  };
}

/**
 * Options for {@link makeEditUpdate}.
 */
export interface MakeEditUpdateOptions {
  /** The Update's unique, monotonically-increasing id (see {@link nextUpdateId}). */
  readonly updateId: number;
  /** The id of the message being edited (the same id arrived earlier as a `message`). */
  readonly messageId: number;
  /** The private-chat id the edited message lives in. */
  readonly chatId: number;
  /** The (human) sender — built via {@link makeUser}. */
  readonly from: User;
  /** The new (post-edit) message text. */
  readonly newText: string;
}

/**
 * Build an `edited_message` `Update` the adapter routes through the SAME
 * `handleInboundMessage` (`telegram-inbound.ts:117` — `ctx.editedMessage` →
 * `handleInboundMessage(state, deps, ctx.editedMessage, ctx.editedMessage.chat.id)`).
 *
 * The inner shape is exactly {@link makeMessageUpdate}'s `message` (a `private`
 * chat + a mandatory `from`), under the `edited_message` key, PLUS `edit_date`
 * (what distinguishes an edit from a fresh message). The return annotation IS
 * grammy's `Update` (I4); `date`/`edit_date` are unix SECONDS. Only the
 * `edited_message` kind is populated (the §4.2 guard now PERMITS it — lifted by
 * INTERACT-02, Phase 207).
 */
export function makeEditUpdate(opts: MakeEditUpdateOptions): Update {
  const nowSeconds = Math.floor(Date.now() / 1000);
  return {
    update_id: opts.updateId,
    edited_message: {
      message_id: opts.messageId,
      from: opts.from,
      // PrivateChat requires first_name; in a DM the chat IS the sender.
      chat: { id: opts.chatId, type: "private", first_name: opts.from.first_name },
      date: nowSeconds,
      edit_date: nowSeconds,
      text: opts.newText,
    },
  };
}

/**
 * Module-level strictly-monotonic update-id source.
 *
 * The emulator (Plan 03) relies on strictly-increasing `update_id`s for its
 * long-poll offset/ack (drop pending `update_id < offset`). Starting at 1
 * mirrors the proven mock (`mock-telegram-server.ts:231,250`). Callers pass the
 * value into {@link makeMessageUpdate} (the builder echoes it verbatim) so the
 * counter lives in one place.
 */
let updateIdCounter = 0;

/**
 * Return the next strictly-increasing `update_id` (1, 2, 3, …).
 */
export function nextUpdateId(): number {
  updateIdCounter += 1;
  return updateIdCounter;
}

/**
 * Reset the {@link nextUpdateId} counter to its initial state (so it returns 1
 * next). For per-test isolation if a suite needs a deterministic sequence.
 */
export function resetUpdateIdCounter(): void {
  updateIdCounter = 0;
}
