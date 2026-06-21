// SPDX-License-Identifier: Apache-2.0
/**
 * Stage-A unit tests for the grammy-typed Telegram payload builders
 * (`tg-payloads.ts`, TEST-01 / invariant I4, Phase 204).
 *
 * Pure type/structural tests — no daemon, no key, no network, fast. These
 * builders are the ones the emulator's `getUpdates` serves (Plan 03) and the
 * scenario contract test round-trips (Plan 05). They import grammy 1.43's OWN
 * exported `Update`/`Message` types, so a shape drift becomes a COMPILE error,
 * not a silent runtime mismatch (the Go-emulator drift problem the milestone
 * exists to avoid, design §1.3). These tests assert:
 *   - `makeMessageUpdate(...)` returns a value whose STATIC type is grammy's
 *     `Update` (the function's return annotation IS the grammy type — the I4
 *     drift tripwire: a grammy shape change fails to compile here).
 *   - the runtime shape matches what the adapter's `mapGrammyToNormalized`
 *     parses (`update_id`, `message.{message_id,from,chat,date,text}`).
 *   - `message.date` is integer UNIX SECONDS (`Math.floor(now/1000)`), NOT
 *     milliseconds — the mapper multiplies ×1000 (message-mapper.ts, §4.2).
 *   - the builder emits ONLY the `message` update kind 204 consumes (no
 *     `channel_post`/`inline_query`/… literal appears — §4.2 scope guard).
 *   - `nextUpdateId()` is strictly monotonic (the emulator relies on it for
 *     offset/ack, Plan 03).
 *
 * @module
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, it, expect } from "vitest";
import type { CallbackQuery, Chat, Message, MessageReactionUpdated, Update } from "grammy/types";
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
  makeUser,
  nextUpdateId,
} from "./tg-payloads.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PAYLOADS_SOURCE = resolve(HERE, "tg-payloads.ts");

// ---------------------------------------------------------------------------
// makeMessageUpdate — runtime shape the adapter parses
// ---------------------------------------------------------------------------

describe("makeMessageUpdate runtime shape", () => {
  it("builds a well-formed grammy `message` Update from the passed fields", () => {
    const from = makeUser({ id: 200, firstName: "alice", username: "alice" });
    const update = makeMessageUpdate({
      updateId: 1,
      messageId: 100,
      from,
      chatId: 555,
      text: "hi",
    });

    expect(update.update_id).toBe(1);
    // `message` is the only populated update kind (the 204 round-trip).
    const message = update.message;
    expect(message).toBeDefined();
    expect(message?.message_id).toBe(100);
    expect(message?.chat.id).toBe(555);
    expect(message?.chat.type).toBe("private");
    expect(message?.text).toBe("hi");
    // The human sender — never a bot (design §4.2: from.is_bot === false).
    expect(message?.from?.is_bot).toBe(false);
    expect(message?.from?.id).toBe(200);
    expect(message?.from?.first_name).toBe("alice");
  });

  it("echoes the caller-supplied updateId/messageId (the emulator owns the counter)", () => {
    const from = makeUser({ id: 7, firstName: "bob" });
    const update = makeMessageUpdate({
      updateId: 42,
      messageId: 9001,
      from,
      chatId: 12,
      text: "echo",
    });
    expect(update.update_id).toBe(42);
    expect(update.message?.message_id).toBe(9001);
  });

  it("emits ONLY the `message` kind — no other update kind is populated (§4.2 scope guard)", () => {
    const from = makeUser({ id: 1, firstName: "c" });
    const update = makeMessageUpdate({
      updateId: 1,
      messageId: 1,
      from,
      chatId: 1,
      text: "x",
    });
    // Exactly the two keys the message round-trip needs — nothing else.
    expect(Object.keys(update).sort()).toEqual(["message", "update_id"]);
    // None of the deferred/unhandled kinds are present at runtime.
    const u = update as unknown as Record<string, unknown>;
    expect(u["channel_post"]).toBeUndefined();
    expect(u["edited_message"]).toBeUndefined();
    expect(u["callback_query"]).toBeUndefined();
    expect(u["message_reaction"]).toBeUndefined();
    expect(u["inline_query"]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// date semantics — UNIX SECONDS, not milliseconds (design §4.2)
// ---------------------------------------------------------------------------

describe("makeMessageUpdate date is unix seconds (not milliseconds)", () => {
  it("sets message.date to an integer ≈ Math.floor(Date.now()/1000)", () => {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const from = makeUser({ id: 1, firstName: "c" });
    const update = makeMessageUpdate({
      updateId: 1,
      messageId: 1,
      from,
      chatId: 1,
      text: "x",
    });
    const date = update.message!.date;
    // Integer (Telegram unix-seconds), never a float.
    expect(Number.isInteger(date)).toBe(true);
    // Within a few seconds of now/1000 — i.e. SECONDS, not the ~1000× larger ms.
    expect(Math.abs(date - nowSeconds)).toBeLessThanOrEqual(5);
    // Sanity tripwire: a ms value would be ≥ 1e12; seconds are ~1.7e9.
    expect(date).toBeLessThan(1e12);
  });
});

// ---------------------------------------------------------------------------
// grammy-type fidelity (I4) — the drift tripwire
// ---------------------------------------------------------------------------

describe("grammy-type fidelity (I4 — compile-level drift tripwire)", () => {
  it("the builder return is assignable to grammy `Update` and `Message`", () => {
    const from = makeUser({ id: 5, firstName: "d", username: "d" });
    // These two annotations are the I4 tripwire: if grammy's Update/Message
    // shape drifts, THIS file fails to COMPILE (not at runtime).
    const u: Update = makeMessageUpdate({
      updateId: 3,
      messageId: 30,
      from,
      chatId: 300,
      text: "typed",
    });
    const m: Message = u.message!;
    expect(u.update_id).toBe(3);
    expect(m.message_id).toBe(30);
    expect(m.text).toBe("typed");
  });

  it("makeUser/makeBotUser return grammy `User` values (is_bot flag distinguishes them)", () => {
    const human = makeUser({ id: 11, firstName: "human", username: "human" });
    const bot = makeBotUser({ id: 99, firstName: "comisbot", username: "comisbot" });
    expect(human.is_bot).toBe(false);
    expect(bot.is_bot).toBe(true);
    expect(human.id).toBe(11);
    expect(bot.id).toBe(99);
    expect(bot.first_name).toBe("comisbot");
  });
});

// ---------------------------------------------------------------------------
// nextUpdateId — strict monotonicity (the emulator's offset/ack primitive)
// ---------------------------------------------------------------------------

describe("nextUpdateId monotonic counter", () => {
  it("produces strictly increasing update_id values", () => {
    const a = nextUpdateId();
    const b = nextUpdateId();
    const c = nextUpdateId();
    expect(b).toBeGreaterThan(a);
    expect(c).toBeGreaterThan(b);
  });

  it("can drive a sequence of builder calls with increasing update_id", () => {
    const from = makeUser({ id: 1, firstName: "seq" });
    const u1 = makeMessageUpdate({ updateId: nextUpdateId(), messageId: 1, from, chatId: 1, text: "1" });
    const u2 = makeMessageUpdate({ updateId: nextUpdateId(), messageId: 2, from, chatId: 1, text: "2" });
    expect(u2.update_id).toBeGreaterThan(u1.update_id);
  });
});

// ---------------------------------------------------------------------------
// makeReactionUpdate — runtime shape the message_reaction adapter handler parses
// (REACT-01: the inbound half of reactions; the outbound setMessageReaction
// landed in 204. The adapter handler at telegram-inbound.ts:266 is ALREADY
// wired — these tests pin the builder produces exactly the ADD it consumes.)
// ---------------------------------------------------------------------------

describe("makeReactionUpdate runtime shape", () => {
  it("builds a well-formed grammy `message_reaction` ADD Update from the passed fields", () => {
    const user = makeUser({ id: 200, firstName: "alice", username: "alice" });
    const update = makeReactionUpdate({
      updateId: 1,
      messageId: 100,
      chatId: 555,
      user,
      emoji: "👍",
    });

    expect(update.update_id).toBe(1);
    // `message_reaction` is the only populated update kind (the REACT-01 ADD).
    const mr = update.message_reaction;
    expect(mr).toBeDefined();
    expect(mr?.message_id).toBe(100);
    expect(mr?.chat.id).toBe(555);
    expect(mr?.chat.type).toBe("private");
    // The reactor — never the bot (so the adapter's :270 own-filter keeps it).
    expect(mr?.user).toBe(user);
    expect(mr?.user?.is_bot).toBe(false);
    expect(mr?.user?.id).toBe(200);
    // A FRESH ADD: old_reaction empty → new_reaction carries the single emoji.
    expect(mr?.old_reaction).toEqual([]);
    expect(mr?.new_reaction).toEqual([{ type: "emoji", emoji: "👍" }]);
  });

  it("echoes the caller-supplied updateId/messageId (the emulator owns the counter; the messageId is the EXISTING bot reply)", () => {
    const user = makeUser({ id: 7, firstName: "bob" });
    const update = makeReactionUpdate({
      updateId: 42,
      messageId: 9001,
      chatId: 12,
      user,
      emoji: "👎",
    });
    expect(update.update_id).toBe(42);
    expect(update.message_reaction?.message_id).toBe(9001);
  });
});

// ---------------------------------------------------------------------------
// date semantics — UNIX SECONDS, not milliseconds (mirrors makeMessageUpdate)
// ---------------------------------------------------------------------------

describe("makeReactionUpdate date is unix seconds (not milliseconds)", () => {
  it("sets message_reaction.date to an integer ≈ Math.floor(Date.now()/1000)", () => {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const user = makeUser({ id: 1, firstName: "c" });
    const update = makeReactionUpdate({
      updateId: 1,
      messageId: 1,
      chatId: 1,
      user,
      emoji: "👍",
    });
    const date = update.message_reaction!.date;
    // Integer (Telegram unix-seconds), never a float.
    expect(Number.isInteger(date)).toBe(true);
    // Within a few seconds of now/1000 — i.e. SECONDS, not the ~1000× larger ms.
    expect(Math.abs(date - nowSeconds)).toBeLessThanOrEqual(5);
    // Sanity tripwire: a ms value would be ≥ 1e12; seconds are ~1.7e9.
    expect(date).toBeLessThan(1e12);
  });
});

// ---------------------------------------------------------------------------
// The ADD-detection contract — what the adapter's :272-273 diff needs
// ---------------------------------------------------------------------------

describe("makeReactionUpdate produces the ADD the adapter detects (telegram-inbound.ts:272-273)", () => {
  it("the set-difference new\\old of emoji reactions is exactly the injected emoji", () => {
    const user = makeUser({ id: 3, firstName: "d" });
    const mr = makeReactionUpdate({
      updateId: 1,
      messageId: 10,
      chatId: 100,
      user,
      emoji: "👍",
    }).message_reaction!;

    // Mirror emojiNames (telegram-inbound.ts:304): keep only type==="emoji".
    const emojiNames = (rs: typeof mr.new_reaction): string[] =>
      rs.flatMap((r) => (r.type === "emoji" ? [r.emoji] : []));
    const oldEmojis = new Set(emojiNames(mr.old_reaction));
    const added = emojiNames(mr.new_reaction).filter((e) => !oldEmojis.has(e));
    // Exactly an ADD of "👍" — what the handler dispatches (added.length > 0).
    expect(added).toEqual(["👍"]);
  });
});

// ---------------------------------------------------------------------------
// grammy-type fidelity (I4) — the drift tripwire for the reaction builder
// ---------------------------------------------------------------------------

describe("makeReactionUpdate grammy-type fidelity (I4 — compile-level drift tripwire)", () => {
  it("the builder return is assignable to grammy `Update` and `MessageReactionUpdated`", () => {
    const user = makeUser({ id: 5, firstName: "e", username: "e" });
    // These two annotations are the I4 tripwire: if grammy's
    // Update/MessageReactionUpdated shape drifts, THIS file fails to COMPILE.
    const u: Update = makeReactionUpdate({
      updateId: 3,
      messageId: 30,
      chatId: 300,
      user,
      emoji: "👍",
    });
    const mr: MessageReactionUpdated = u.message_reaction!;
    expect(u.update_id).toBe(3);
    expect(mr.message_id).toBe(30);
    expect(mr.new_reaction[0]).toEqual({ type: "emoji", emoji: "👍" });
  });
});

// ---------------------------------------------------------------------------
// makeMediaUpdate — runtime shape buildAttachments parses (MEDIA-03, Phase 207)
// (the inbound media half: a `message` Update carrying exactly the per-kind
// grammy field buildAttachments reads (media-handler.ts:84-108), each via a
// caller-supplied file_id. The keyless handler short-circuits BEFORE download,
// so these Stage-B units pin the SHAPE the adapter parses, not a transcript.)
// ---------------------------------------------------------------------------

describe("makeMediaUpdate runtime shape (per-kind, mirrors buildAttachments)", () => {
  it("kind:'voice' → message.voice = { file_id, file_unique_id, duration, mime_type }", () => {
    const from = makeUser({ id: 200, firstName: "alice", username: "alice" });
    const update = makeMediaUpdate({
      updateId: 1,
      messageId: 100,
      chatId: 555,
      from,
      kind: "voice",
      fileId: "file_voice_1",
      fileUniqueId: "uniq_voice_1",
      duration: 7,
      mimeType: "audio/ogg",
    });
    expect(update.update_id).toBe(1);
    const message = update.message;
    expect(message?.message_id).toBe(100);
    expect(message?.chat.id).toBe(555);
    expect(message?.chat.type).toBe("private");
    // buildAttachments reads msg.voice.file_id (media-handler.ts:95,extractVoice:41).
    expect(message?.voice?.file_id).toBe("file_voice_1");
    expect(message?.voice?.file_unique_id).toBe("uniq_voice_1");
    expect(message?.voice?.duration).toBe(7);
    expect(message?.voice?.mime_type).toBe("audio/ogg");
    // ONLY the requested kind is set — a voice update carries no photo/document/…
    expect(message?.photo).toBeUndefined();
    expect(message?.document).toBeUndefined();
    expect(message?.video).toBeUndefined();
    expect(message?.video_note).toBeUndefined();
  });

  it("kind:'photo' → message.photo = [{ file_id, file_unique_id, width, height, file_size }] (a PhotoSize[])", () => {
    const from = makeUser({ id: 1, firstName: "p" });
    const update = makeMediaUpdate({
      updateId: 2,
      messageId: 101,
      chatId: 7,
      from,
      kind: "photo",
      fileId: "file_photo_1",
      fileUniqueId: "uniq_photo_1",
      width: 640,
      height: 480,
      fileSize: 2048,
    });
    const photo = update.message?.photo;
    // buildAttachments takes the LARGEST = photos[len-1] (media-handler.ts:18).
    expect(Array.isArray(photo)).toBe(true);
    expect(photo).toHaveLength(1);
    expect(photo?.[photo.length - 1]?.file_id).toBe("file_photo_1");
    expect(photo?.[0]?.file_unique_id).toBe("uniq_photo_1");
    expect(photo?.[0]?.width).toBe(640);
    expect(photo?.[0]?.height).toBe(480);
    expect(photo?.[0]?.file_size).toBe(2048);
    expect(update.message?.voice).toBeUndefined();
  });

  it("kind:'document' → message.document = { file_id, file_unique_id, file_name?, mime_type?, file_size? }", () => {
    const from = makeUser({ id: 1, firstName: "d" });
    const update = makeMediaUpdate({
      updateId: 3,
      messageId: 102,
      chatId: 7,
      from,
      kind: "document",
      fileId: "file_doc_1",
      fileUniqueId: "uniq_doc_1",
      fileName: "report.pdf",
      mimeType: "application/pdf",
      fileSize: 4096,
    });
    const doc = update.message?.document;
    // buildAttachments reads file_id (+ optional mime_type/file_name/file_size); extractDocument:28.
    expect(doc?.file_id).toBe("file_doc_1");
    expect(doc?.file_unique_id).toBe("uniq_doc_1");
    expect(doc?.file_name).toBe("report.pdf");
    expect(doc?.mime_type).toBe("application/pdf");
    expect(doc?.file_size).toBe(4096);
  });

  it("kind:'video' → message.video = { file_id, file_unique_id, width, height, duration }", () => {
    const from = makeUser({ id: 1, firstName: "v" });
    const update = makeMediaUpdate({
      updateId: 4,
      messageId: 103,
      chatId: 7,
      from,
      kind: "video",
      fileId: "file_video_1",
      fileUniqueId: "uniq_video_1",
      width: 1280,
      height: 720,
      duration: 12,
    });
    const video = update.message?.video;
    expect(video?.file_id).toBe("file_video_1"); // extractVideo:53
    expect(video?.file_unique_id).toBe("uniq_video_1");
    expect(video?.width).toBe(1280);
    expect(video?.height).toBe(720);
    expect(video?.duration).toBe(12);
  });

  it("kind:'video_note' → message.video_note = { file_id, file_unique_id, length, duration }", () => {
    const from = makeUser({ id: 1, firstName: "vn" });
    const update = makeMediaUpdate({
      updateId: 5,
      messageId: 104,
      chatId: 7,
      from,
      kind: "video_note",
      fileId: "file_vn_1",
      fileUniqueId: "uniq_vn_1",
      length: 240,
      duration: 5,
    });
    const vn = update.message?.video_note;
    expect(vn?.file_id).toBe("file_vn_1"); // extractVideoNote:64 (duration → ms downstream)
    expect(vn?.file_unique_id).toBe("uniq_vn_1");
    expect(vn?.length).toBe(240);
    expect(vn?.duration).toBe(5);
  });

  it("the SAME file_id the caller passes is echoed verbatim (the id injectMedia stores)", () => {
    const from = makeUser({ id: 1, firstName: "x" });
    const update = makeMediaUpdate({
      updateId: 6,
      messageId: 105,
      chatId: 7,
      from,
      kind: "voice",
      fileId: "the-exact-file-id",
      fileUniqueId: "uniq",
      duration: 1,
    });
    expect(update.message?.voice?.file_id).toBe("the-exact-file-id");
  });

  it("spoiler:true → message.has_media_spoiler = true (message-mapper.ts:142 → metadata.hasSpoiler)", () => {
    const from = makeUser({ id: 1, firstName: "s" });
    const update = makeMediaUpdate({
      updateId: 7,
      messageId: 106,
      chatId: 7,
      from,
      kind: "photo",
      fileId: "f",
      fileUniqueId: "u",
      width: 1,
      height: 1,
      spoiler: true,
    });
    expect(update.message?.has_media_spoiler).toBe(true);
  });

  it("spoiler omitted → has_media_spoiler is absent (exactOptionalPropertyTypes — never `: undefined`)", () => {
    const from = makeUser({ id: 1, firstName: "s" });
    const update = makeMediaUpdate({
      updateId: 8,
      messageId: 107,
      chatId: 7,
      from,
      kind: "photo",
      fileId: "f",
      fileUniqueId: "u",
      width: 1,
      height: 1,
    });
    // The field is OMITTED, not set to undefined (a falsy-read short-circuit + a
    // clean `"has_media_spoiler" in msg` check both stay correct).
    expect("has_media_spoiler" in (update.message as object)).toBe(false);
  });

  it("date is unix SECONDS (≈ Math.floor(now/1000), <1e12), not milliseconds", () => {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const from = makeUser({ id: 1, firstName: "c" });
    const date = makeMediaUpdate({
      updateId: 9,
      messageId: 1,
      chatId: 1,
      from,
      kind: "voice",
      fileId: "f",
      fileUniqueId: "u",
      duration: 1,
    }).message!.date;
    expect(Number.isInteger(date)).toBe(true);
    expect(Math.abs(date - nowSeconds)).toBeLessThanOrEqual(5);
    expect(date).toBeLessThan(1e12);
  });

  it("the builder return is assignable to grammy `Update`/`Message` (I4 drift tripwire)", () => {
    const from = makeUser({ id: 5, firstName: "d" });
    const u: Update = makeMediaUpdate({
      updateId: 3,
      messageId: 30,
      chatId: 300,
      from,
      kind: "document",
      fileId: "f",
      fileUniqueId: "u",
    });
    const m: Message = u.message!;
    expect(m.document?.file_id).toBe("f");
  });
});

// ---------------------------------------------------------------------------
// makeLocationUpdate — message-mapper.ts:175-189 reads venue (WINS) then location
// (a `message` Update; no file store). venue → metadata.location via the venue
// branch, plain location via the else-if. Asserted structurally here; the
// metadata.location mapping is corroborated in the Stage-B scenario.
// ---------------------------------------------------------------------------

describe("makeLocationUpdate runtime shape (mirrors message-mapper.ts location/venue)", () => {
  it("location → message.location = { latitude, longitude, horizontal_accuracy? }", () => {
    const from = makeUser({ id: 1, firstName: "l" });
    const update = makeLocationUpdate({
      updateId: 1,
      messageId: 200,
      chatId: 9,
      from,
      location: { latitude: 51.5, longitude: -0.12, horizontalAccuracy: 10 },
    });
    const loc = update.message?.location;
    expect(loc?.latitude).toBe(51.5); // message-mapper.ts:184
    expect(loc?.longitude).toBe(-0.12);
    expect(loc?.horizontal_accuracy).toBe(10); // :187
    // A plain location update has NO venue (the mapper's else-if precedence).
    expect(update.message?.venue).toBeUndefined();
  });

  it("location without accuracy → horizontal_accuracy is absent (exactOptional)", () => {
    const from = makeUser({ id: 1, firstName: "l" });
    const update = makeLocationUpdate({
      updateId: 2,
      messageId: 201,
      chatId: 9,
      from,
      location: { latitude: 1, longitude: 2 },
    });
    expect("horizontal_accuracy" in (update.message?.location as object)).toBe(false);
  });

  it("venue → message.venue = { location:{latitude,longitude}, title, address } (venue WINS, :175)", () => {
    const from = makeUser({ id: 1, firstName: "v" });
    const update = makeLocationUpdate({
      updateId: 3,
      messageId: 202,
      chatId: 9,
      from,
      venue: { latitude: 40.7, longitude: -74.0, title: "Statue", address: "Liberty Island" },
    });
    const venue = update.message?.venue;
    expect(venue?.location.latitude).toBe(40.7); // message-mapper.ts:177
    expect(venue?.location.longitude).toBe(-74.0); // :178
    expect(venue?.title).toBe("Statue"); // :179
    expect(venue?.address).toBe("Liberty Island"); // :179
    // venue is mutually exclusive with location in the builder (the mapper's else-if).
    expect(update.message?.location).toBeUndefined();
  });

  it("the builder return is assignable to grammy `Update` (I4 drift tripwire)", () => {
    const from = makeUser({ id: 5, firstName: "d" });
    const u: Update = makeLocationUpdate({
      updateId: 3,
      messageId: 30,
      chatId: 300,
      from,
      location: { latitude: 1, longitude: 2 },
    });
    expect(u.message?.location?.latitude).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// makeCallbackUpdate — the callback_query Update the adapter handler consumes
// (INTERACT-01, Phase 207). telegram-inbound.ts:165 reads
// ctx.callbackQuery.{message?.chat.id, data}, ctx.from.id,
// ctx.callbackQuery.message.message_id — the synthetic isButtonCallback message.
// ---------------------------------------------------------------------------

describe("makeBotMessage runtime shape (the bot reply a callback taps)", () => {
  it("builds a grammy Message authored BY the bot (is_bot:true) carrying message_id + chat.id", () => {
    const botUser = makeBotUser({ id: 999, firstName: "comisbot", username: "comisbot" });
    const msg = makeBotMessage({ messageId: 77, chatId: 42, botUser, text: "pick one" });
    expect(msg.message_id).toBe(77);
    expect(msg.chat.id).toBe(42);
    expect(msg.chat.type).toBe("private");
    expect(msg.from?.is_bot).toBe(true);
    expect(msg.from?.id).toBe(999);
    expect(msg.text).toBe("pick one");
    expect(Number.isInteger(msg.date)).toBe(true);
  });

  it("omits text when not supplied (exactOptionalPropertyTypes)", () => {
    const botUser = makeBotUser({ id: 999, firstName: "comisbot" });
    const msg = makeBotMessage({ messageId: 1, chatId: 1, botUser });
    expect("text" in (msg as object)).toBe(false);
  });
});

describe("makeCallbackUpdate runtime shape (mirrors telegram-inbound.ts:165)", () => {
  it("builds a callback_query Update with { id, from, message, chat_instance, data }", () => {
    const botUser = makeBotUser({ id: 999, firstName: "comisbot" });
    const botMessage = makeBotMessage({ messageId: 50, chatId: 42, botUser, text: "menu" });
    const tapper = makeUser({ id: 200, firstName: "alice", username: "alice" });
    const update = makeCallbackUpdate({
      updateId: 1,
      id: "cbq_abc123",
      from: tapper,
      botMessage,
      chatInstance: "chat-inst-1",
      data: "approve",
    });
    expect(update.update_id).toBe(1);
    const cbq = update.callback_query;
    expect(cbq?.id).toBe("cbq_abc123");
    // The handler reads ctx.from.id (the tapper, NOT the bot).
    expect(cbq?.from.id).toBe(200);
    expect(cbq?.from.is_bot).toBe(false);
    // ctx.callbackQuery.data — the button payload, a scalar string (IN-04 safe).
    expect(cbq?.data).toBe("approve");
    // ctx.callbackQuery.message?.chat.id + .message_id (the existing bot reply).
    expect(cbq?.message?.chat.id).toBe(42);
    expect(cbq?.message?.message_id).toBe(50);
    // grammy's CallbackQuery REQUIRES chat_instance.
    expect(cbq?.chat_instance).toBe("chat-inst-1");
    // No other update kind is populated.
    expect(update.message).toBeUndefined();
    expect(update.edited_message).toBeUndefined();
  });

  it("the message a callback taps is the BOT's (is_bot:true) — never the tapper", () => {
    const botUser = makeBotUser({ id: 999, firstName: "comisbot" });
    const botMessage = makeBotMessage({ messageId: 5, chatId: 7, botUser });
    const tapper = makeUser({ id: 3, firstName: "human" });
    const cbq = makeCallbackUpdate({
      updateId: 2,
      id: "q",
      from: tapper,
      botMessage,
      chatInstance: "ci",
      data: "x",
    }).callback_query!;
    expect(cbq.message?.from?.is_bot).toBe(true);
    expect(cbq.from.is_bot).toBe(false);
  });

  it("the builder return is assignable to grammy `Update`/`CallbackQuery` (I4 drift tripwire)", () => {
    const botUser = makeBotUser({ id: 999, firstName: "b" });
    const botMessage = makeBotMessage({ messageId: 30, chatId: 300, botUser });
    const u: Update = makeCallbackUpdate({
      updateId: 3,
      id: "qid",
      from: makeUser({ id: 5, firstName: "d" }),
      botMessage,
      chatInstance: "ci",
      data: "typed",
    });
    const cbq: CallbackQuery = u.callback_query!;
    expect(cbq.data).toBe("typed");
  });
});

// ---------------------------------------------------------------------------
// makeEditUpdate — the edited_message Update the adapter routes through
// handleInboundMessage (INTERACT-02, telegram-inbound.ts:117). Same inner shape
// as makeMessageUpdate's `message`, under `edited_message`, plus edit_date.
// ---------------------------------------------------------------------------

describe("makeEditUpdate runtime shape (mirrors telegram-inbound.ts:117)", () => {
  it("builds an edited_message Update with { message_id, from, chat, date, edit_date, text }", () => {
    const from = makeUser({ id: 200, firstName: "alice", username: "alice" });
    const update = makeEditUpdate({
      updateId: 1,
      messageId: 100,
      chatId: 555,
      from,
      newText: "edited text",
    });
    expect(update.update_id).toBe(1);
    const edited = update.edited_message;
    expect(edited?.message_id).toBe(100);
    expect(edited?.chat.id).toBe(555);
    expect(edited?.chat.type).toBe("private");
    expect(edited?.text).toBe("edited text");
    expect(edited?.from?.id).toBe(200);
    expect(edited?.from?.is_bot).toBe(false);
    // edited_message carries edit_date (what distinguishes it from a fresh message).
    expect(Number.isInteger(edited?.edit_date)).toBe(true);
    // Only the edited_message kind is populated.
    expect(update.message).toBeUndefined();
    expect(update.callback_query).toBeUndefined();
  });

  it("date AND edit_date are unix SECONDS (≈ now/1000, <1e12), not milliseconds", () => {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const from = makeUser({ id: 1, firstName: "c" });
    const edited = makeEditUpdate({
      updateId: 1,
      messageId: 1,
      chatId: 1,
      from,
      newText: "x",
    }).edited_message!;
    expect(Number.isInteger(edited.date)).toBe(true);
    expect(Math.abs(edited.date - nowSeconds)).toBeLessThanOrEqual(5);
    expect(edited.date).toBeLessThan(1e12);
    expect(edited.edit_date).toBeDefined();
    expect(Math.abs(edited.edit_date! - nowSeconds)).toBeLessThanOrEqual(5);
    expect(edited.edit_date!).toBeLessThan(1e12);
  });

  it("the builder return is assignable to grammy `Update`/`Message` (I4 drift tripwire)", () => {
    const u: Update = makeEditUpdate({
      updateId: 3,
      messageId: 30,
      chatId: 300,
      from: makeUser({ id: 5, firstName: "d" }),
      newText: "typed",
    });
    const m: Message = u.edited_message!;
    expect(m.text).toBe("typed");
  });
});

// ---------------------------------------------------------------------------
// Scope guard — `message` + `message_reaction` + `callback_query` +
// `edited_message` are IN-SCOPE (the last two LIFTED by INTERACT-01/02,
// Phase 207); the §4.2 Out-of-Scope kinds (channel_post / inline_query /
// poll_answer / my_chat_member / chat_join_request) stay forbidden.
// ---------------------------------------------------------------------------

describe("tg-payloads.ts scope guard (message/reaction/callback/edit in scope; §4.2 out-of-scope kinds forbidden)", () => {
  it("makeReactionUpdate populates only `message_reaction` — no callback/edit/inline kind", () => {
    const user = makeUser({ id: 1, firstName: "c" });
    const update = makeReactionUpdate({
      updateId: 1,
      messageId: 1,
      chatId: 1,
      user,
      emoji: "👍",
    });
    // Exactly the two keys the reaction ADD needs — nothing else.
    expect(Object.keys(update).sort()).toEqual(["message_reaction", "update_id"]);
    // None of the still-deferred (207) kinds are present at runtime.
    const u = update as unknown as Record<string, unknown>;
    expect(u["channel_post"]).toBeUndefined();
    expect(u["edited_message"]).toBeUndefined();
    expect(u["callback_query"]).toBeUndefined();
    expect(u["inline_query"]).toBeUndefined();
  });

  it("makeCallbackUpdate populates only `callback_query`; makeEditUpdate only `edited_message` — no out-of-scope kind", () => {
    const botUser = makeBotUser({ id: 999, firstName: "b" });
    const botMessage = makeBotMessage({ messageId: 1, chatId: 1, botUser });
    const cb = makeCallbackUpdate({
      updateId: 1,
      id: "q",
      from: makeUser({ id: 2, firstName: "u" }),
      botMessage,
      chatInstance: "ci",
      data: "x",
    });
    expect(Object.keys(cb).sort()).toEqual(["callback_query", "update_id"]);
    const cbu = cb as unknown as Record<string, unknown>;
    expect(cbu["message"]).toBeUndefined();
    expect(cbu["edited_message"]).toBeUndefined();
    expect(cbu["channel_post"]).toBeUndefined();

    const ed = makeEditUpdate({ updateId: 2, messageId: 1, chatId: 1, from: makeUser({ id: 3, firstName: "e" }), newText: "x" });
    expect(Object.keys(ed).sort()).toEqual(["edited_message", "update_id"]);
    const edu = ed as unknown as Record<string, unknown>;
    expect(edu["message"]).toBeUndefined();
    expect(edu["callback_query"]).toBeUndefined();
  });

  it("imports grammy's OWN types (I4); callback_query/edited_message are now IN scope; §4.2 out-of-scope kinds stay forbidden", () => {
    const src = readFileSync(PAYLOADS_SOURCE, "utf8");
    // I4: the builders import grammy's exported Update/Message types.
    expect(src).toMatch(/import type \{[^}]*Update[^}]*\} from ["']grammy\/types["']/);
    // date = unix seconds (design §4.2).
    expect(src).toMatch(/Math\.floor\(Date\.now\(\)\s*\/\s*1000\)/);
    // Strip comment lines so a doc-comment naming a kind is not a false hit.
    const code = src
      .split("\n")
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .join("\n");
    // REACT-01 lifted `message_reaction` into scope; INTERACT-01/02 (Phase 207)
    // now lift `callback_query` + `edited_message` — assert all three ARE code
    // literals (the builders write them), proving the §4.2 guard was lifted on
    // purpose for exactly these kinds.
    expect(code).toMatch(/message_reaction/);
    expect(code).toMatch(/callback_query/);
    expect(code).toMatch(/edited_message/);
    // The §4.2 Out-of-Scope kinds stay blocklisted (the harness must not mint an
    // update kind the adapter does not handle — T-207-03).
    expect(code).not.toMatch(/channel_post/);
    expect(code).not.toMatch(/inline_query/);
    expect(code).not.toMatch(/poll_answer/);
    expect(code).not.toMatch(/my_chat_member/);
    expect(code).not.toMatch(/chat_join_request/);
  });
});

// ---------------------------------------------------------------------------
// makeGroupChat — a grammy Chat of type group/supergroup (+is_forum) — GROUP-01
// (Phase 208). The group/supergroup/forum chat shape the mapper derives
// chatType + the thread context from (message-mapper.ts:147-148,194). Every
// prior builder hardcoded `type: "private"`; makeGroupChat is the group seed.
// ---------------------------------------------------------------------------

describe("makeGroupChat runtime shape (the group/supergroup/forum chat seed, GROUP-01)", () => {
  it("type:'group' → a grammy GroupChat (no is_forum)", () => {
    const chat = makeGroupChat({ id: -100123, type: "group" });
    expect(chat.id).toBe(-100123);
    expect(chat.type).toBe("group");
    // A plain group is NOT a forum.
    expect("is_forum" in chat ? (chat as { is_forum?: boolean }).is_forum : undefined).toBeUndefined();
  });

  it("type:'supergroup', isForum:true → a SupergroupChat with is_forum:true (the forum flag the mapper reads)", () => {
    const chat = makeGroupChat({ id: -100456, type: "supergroup", isForum: true });
    expect(chat.id).toBe(-100456);
    expect(chat.type).toBe("supergroup");
    // is_forum:true is what message-mapper.ts:147 reads to derive chatType "forum".
    expect((chat as { is_forum?: boolean }).is_forum).toBe(true);
  });

  it("type:'supergroup' without isForum → no is_forum flag (a non-forum supergroup)", () => {
    const chat = makeGroupChat({ id: -100789, type: "supergroup" });
    expect(chat.type).toBe("supergroup");
    expect((chat as { is_forum?: boolean }).is_forum).toBeUndefined();
  });

  it("the builder return is assignable to grammy `Chat` (I4 drift tripwire)", () => {
    const chat: Chat = makeGroupChat({ id: -100, type: "supergroup", isForum: true });
    expect(chat.type).toBe("supergroup");
  });
});

// ---------------------------------------------------------------------------
// makeMessageUpdate addressing extensions — chat / entities / replyToMessage /
// messageThreadId (GROUP-01/02). The DM literal stays the default (back-compat);
// a passed group `chat` + a mention/bot_command entity + a reply_to_message +
// a message_thread_id are exactly what detectBotAddressing + the thread
// resolver read (message-mapper.ts:40-104,147-150).
// ---------------------------------------------------------------------------

describe("makeMessageUpdate addressing extensions (chat/entities/replyToMessage/messageThreadId, GROUP-01/02)", () => {
  it("with no chat override the DM `private` literal is preserved (back-compat — the DM path is unbroken)", () => {
    const from = makeUser({ id: 1, firstName: "dm" });
    const update = makeMessageUpdate({ updateId: 1, messageId: 1, from, chatId: 424242, text: "hi" });
    // The default chat is the private literal — exactly the pre-208 behaviour.
    expect(update.message?.chat.type).toBe("private");
    expect(update.message?.chat.id).toBe(424242);
    // No entities/reply/thread when not supplied (exactOptional — never `: undefined`).
    expect("entities" in (update.message as object)).toBe(false);
    expect("reply_to_message" in (update.message as object)).toBe(false);
    expect("message_thread_id" in (update.message as object)).toBe(false);
  });

  it("a group `chat` override → the message carries that chat (the group/forum shape, not the private literal)", () => {
    const from = makeUser({ id: 2, firstName: "alice", username: "alice" });
    const groupChat = makeGroupChat({ id: -100111, type: "supergroup", isForum: true });
    const update = makeMessageUpdate({
      updateId: 2,
      messageId: 50,
      from,
      chatId: -100111,
      text: "hello group",
      chat: groupChat,
    });
    expect(update.message?.chat.type).toBe("supergroup");
    expect(update.message?.chat.id).toBe(-100111);
    expect((update.message?.chat as { is_forum?: boolean }).is_forum).toBe(true);
  });

  it("a `mention` entity → message.entities carries it (detectBotAddressing reads mention/text_mention/bot_command)", () => {
    const from = makeUser({ id: 3, firstName: "bob" });
    const text = "@test_bot help";
    const update = makeMessageUpdate({
      updateId: 3,
      messageId: 51,
      from,
      chatId: -100111,
      text,
      entities: [{ type: "mention", offset: 0, length: "@test_bot".length }],
    });
    const entities = update.message?.entities;
    expect(Array.isArray(entities)).toBe(true);
    expect(entities?.[0]?.type).toBe("mention");
    expect(entities?.[0]?.offset).toBe(0);
    expect(entities?.[0]?.length).toBe("@test_bot".length);
  });

  it("a `bot_command` entity → message.entities carries it (the /cmd@bot addressing path)", () => {
    const from = makeUser({ id: 4, firstName: "carol" });
    const update = makeMessageUpdate({
      updateId: 4,
      messageId: 52,
      from,
      chatId: -100111,
      text: "/reset@test_bot",
      entities: [{ type: "bot_command", offset: 0, length: "/reset@test_bot".length }],
    });
    expect(update.message?.entities?.[0]?.type).toBe("bot_command");
  });

  it("a `replyToMessage` → message.reply_to_message is set (detectBotAddressing reads reply_to_message.from.id)", () => {
    const from = makeUser({ id: 5, firstName: "dave" });
    const botUser = makeBotUser({ id: 12345, firstName: "TestBot", username: "test_bot" });
    const botReply = makeBotMessage({ messageId: 40, chatId: -100111, botUser, text: "earlier bot reply" });
    const update = makeMessageUpdate({
      updateId: 5,
      messageId: 53,
      from,
      chatId: -100111,
      text: "thanks",
      replyToMessage: botReply,
    });
    const replyTo = update.message?.reply_to_message;
    expect(replyTo?.message_id).toBe(40);
    expect(replyTo?.from?.id).toBe(12345);
    expect(replyTo?.from?.is_bot).toBe(true);
  });

  it("a `messageThreadId` → message.message_thread_id is set (the forum topic id the thread resolver reads)", () => {
    const from = makeUser({ id: 6, firstName: "erin" });
    const update = makeMessageUpdate({
      updateId: 6,
      messageId: 54,
      from,
      chatId: -100111,
      text: "in a topic",
      chat: makeGroupChat({ id: -100111, type: "supergroup", isForum: true }),
      messageThreadId: 7,
    });
    expect(update.message?.message_thread_id).toBe(7);
  });

  it("imports grammy's OWN Chat/MessageEntity types (I4) — drift fails the compile", () => {
    const src = readFileSync(PAYLOADS_SOURCE, "utf8");
    // The addressing extensions reference grammy's Chat + MessageEntity types.
    expect(src).toMatch(/import type \{[^}]*Chat[^}]*\} from ["']grammy\/types["']/);
    expect(src).toMatch(/import type \{[^}]*MessageEntity[^}]*\} from ["']grammy\/types["']/);
  });
});
