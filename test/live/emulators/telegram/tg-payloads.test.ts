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
import type { Message, Update } from "grammy/types";
import {
  makeBotUser,
  makeMessageUpdate,
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
    const u = update as Record<string, unknown>;
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
// Scope guard — only `message` updates in the source (§4.2)
// ---------------------------------------------------------------------------

describe("tg-payloads.ts scope guard (only `message` updates for 204)", () => {
  it("imports grammy's OWN types (I4) and emits no unhandled update kind", () => {
    const src = readFileSync(PAYLOADS_SOURCE, "utf8");
    // I4: the builders import grammy's exported Update/Message types.
    expect(src).toMatch(/import type \{[^}]*Update[^}]*\} from ["']grammy\/types["']/);
    // date = unix seconds (design §4.2).
    expect(src).toMatch(/Math\.floor\(Date\.now\(\)\s*\/\s*1000\)/);
    // Strip comment lines so a doc-comment naming a deferred kind is not a false hit.
    const code = src
      .split("\n")
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .join("\n");
    // No unhandled update-kind LITERAL in the code (§4.2 scope guard).
    expect(code).not.toMatch(/channel_post/);
    expect(code).not.toMatch(/inline_query/);
    expect(code).not.toMatch(/poll_answer/);
    expect(code).not.toMatch(/my_chat_member/);
    expect(code).not.toMatch(/chat_join_request/);
  });
});
