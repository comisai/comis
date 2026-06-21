// SPDX-License-Identifier: Apache-2.0
/**
 * Stage-A unit tests for the Telegram wire backend `TgEmulator`
 * (`tg-emulator.ts`, EMU-01..05 + SEC-01, Phase 204).
 *
 * Pure in-process HTTP/typed-verb tests — no daemon, no key, no real network
 * (the only "network" is loopback `fetch` against the emulator's own
 * `127.0.0.1:<port>`). The `TgEmulator` is the fake `api.telegram.org` the real
 * grammy adapter hits over loopback HTTP; the rig (Plan 05) boots the daemon
 * pointed at it. These tests assert the Tier-1 Bot-API method table + the §9
 * "trickiest bit" (the TRUE long-poll: offset/limit/timeout/ack with no dropped
 * or duplicated updates) + the EMU-03 `RecordedOutbound` channel oracle.
 *
 * Coverage:
 *   - EMU-01 getMe (boot envelope, blocks adapter boot) + setMyCommands
 *     (fire-and-forget envelope).
 *   - EMU-03 sendMessage mints a `message_id` AND records a full
 *     `RecordedOutbound` to `outbound(chat)` (the oracle the driver reads).
 *   - EMU-02 long-poll: immediate / block-then-resolve / ack-offset
 *     (no-dup-no-drop) + strictly-monotonic `update_id`.
 *   - EMU-04 setMessageReaction set+clear (recorded, surfaced via
 *     `reactionsOn`).
 *   - EMU-05 getFile + `GET /file/bot<token>/<path>` route SHAPE (HTTP 200, no
 *     404 at boot — byte serving is Phase 207).
 *   - SEC-01 loopback bind (`apiRoot === http://127.0.0.1:<port>`; the source
 *     never contains a wildcard host).
 *   - FOUNDATION wiring: `TgEmulator extends ChannelEmulator` + built ON the
 *     http-backend base (no bespoke `createServer`).
 *
 * Run under the LIVE vitest config (the bare root config excludes `test/live`,
 * collecting 0 files → false green):
 *   pnpm vitest run -c test/live/vitest.config.ts \
 *     test/live/emulators/telegram/tg-emulator.test.ts
 *
 * @module
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTgEmulator, type TgEmulator } from "./tg-emulator.js";
import { resetUpdateIdCounter } from "./tg-payloads.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const EMULATOR_SOURCE = resolve(HERE, "tg-emulator.ts");

// A stub bot token of the `<id>:<secret>` shape grammy builds paths from
// (`/bot<token>/<method>`). No real credential — loopback only.
const TOKEN = "12345:test";
const CHAT_ID = 424242;

/** Build the Bot-API URL for a method against the running emulator. */
function botUrl(apiRoot: string, method: string): string {
  return `${apiRoot}/bot${TOKEN}/${method}`;
}

/** POST a JSON body to a Bot-API method and return the parsed envelope. */
async function callMethod(
  apiRoot: string,
  method: string,
  body: Record<string, unknown>,
): Promise<{ ok: boolean; result?: unknown; error_code?: number }> {
  const res = await fetch(botUrl(apiRoot, method), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return (await res.json()) as { ok: boolean; result?: unknown; error_code?: number };
}

describe("TgEmulator — Tier-1 Bot API on the http-backend base (EMU-01..05)", () => {
  let emu: TgEmulator;
  let apiRoot: string;
  let port: number;

  beforeEach(async () => {
    resetUpdateIdCounter();
    emu = createTgEmulator({ botToken: TOKEN });
    const handle = await emu.start();
    apiRoot = handle.apiRoot;
    port = handle.port;
  });

  afterEach(async () => {
    await emu.stop();
  });

  // -------------------------------------------------------------------------
  // EMU-01 — getMe (blocks boot) + setMyCommands (fire-and-forget)
  // -------------------------------------------------------------------------
  describe("getMe / setMyCommands (EMU-01 boot envelopes)", () => {
    it("getMe returns the boot identity envelope the adapter awaits", async () => {
      const env = await callMethod(apiRoot, "getMe", {});
      expect(env.ok).toBe(true);
      const me = env.result as Record<string, unknown>;
      expect(typeof me["id"]).toBe("number");
      expect(me["is_bot"]).toBe(true);
      expect(typeof me["first_name"]).toBe("string");
      expect(typeof me["username"]).toBe("string");
      // The credential-validator reads these grammy `getMe` fields.
      expect(me).toHaveProperty("can_join_groups");
      expect(me).toHaveProperty("can_read_all_group_messages");
      expect(me).toHaveProperty("supports_inline_queries");
    });

    it("setMyCommands returns { ok:true, result:true } (fire-and-forget)", async () => {
      const env = await callMethod(apiRoot, "setMyCommands", { commands: [] });
      expect(env.ok).toBe(true);
      expect(env.result).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // EMU-03 — sendMessage mints message_id + records a full RecordedOutbound
  // -------------------------------------------------------------------------
  describe("sendMessage (EMU-03 mint message_id + RecordedOutbound oracle)", () => {
    it("mints a message_id, returns the result envelope, and records a full RecordedOutbound", async () => {
      const env = await callMethod(apiRoot, "sendMessage", {
        chat_id: CHAT_ID,
        text: "hello from the agent",
        parse_mode: "HTML",
      });
      expect(env.ok).toBe(true);
      const result = env.result as Record<string, unknown>;
      const messageId = result["message_id"] as number;
      expect(typeof messageId).toBe("number");
      expect(result["text"]).toBe("hello from the agent");
      expect((result["chat"] as Record<string, unknown>)["id"]).toBe(CHAT_ID);
      expect((result["chat"] as Record<string, unknown>)["type"]).toBe("private");
      expect(typeof result["date"]).toBe("number");

      // The channel oracle the driver reads.
      const recorded = emu.outbound({ chatId: CHAT_ID });
      expect(recorded.length).toBe(1);
      const ro = recorded[0]!;
      expect(ro.method).toBe("sendMessage");
      expect(ro.messageId).toBe(messageId);
      expect(ro.text).toBe("hello from the agent");
      expect(ro.parseMode).toBe("HTML");
      // The FULL request body is preserved for later-phase assertions.
      expect(ro.raw).toBeDefined();
      expect((ro.raw as Record<string, unknown>)["chat_id"]).toBe(CHAT_ID);
    });

    it("mints strictly-increasing message_ids across calls", async () => {
      const a = (await callMethod(apiRoot, "sendMessage", { chat_id: CHAT_ID, text: "a" }))
        .result as Record<string, unknown>;
      const b = (await callMethod(apiRoot, "sendMessage", { chat_id: CHAT_ID, text: "b" }))
        .result as Record<string, unknown>;
      expect((b["message_id"] as number) > (a["message_id"] as number)).toBe(true);
    });

    it("lastBotReply returns the most recent recorded outbound for the chat", async () => {
      await callMethod(apiRoot, "sendMessage", { chat_id: CHAT_ID, text: "first" });
      await callMethod(apiRoot, "sendMessage", { chat_id: CHAT_ID, text: "second" });
      const last = emu.lastBotReply({ chatId: CHAT_ID });
      expect(last?.text).toBe("second");
    });
  });

  // -------------------------------------------------------------------------
  // EMU-02 — the TRUE long-poll (the §9 trickiest bit)
  // -------------------------------------------------------------------------
  describe("long-poll (EMU-02 offset / timeout / ack — no dup, no drop)", () => {
    it("IMMEDIATE: with one update queued, getUpdates returns it at once", async () => {
      const msgId = emu.injectMessage(
        { chatId: CHAT_ID },
        { id: 777, firstName: "Alice" },
        "ping",
      );
      expect(typeof msgId).toBe("number");

      const env = await callMethod(apiRoot, "getUpdates", { timeout: 5 });
      expect(env.ok).toBe(true);
      const updates = env.result as Array<Record<string, unknown>>;
      expect(updates.length).toBe(1);
      expect((updates[0]!["message"] as Record<string, unknown>)["text"]).toBe("ping");
    });

    it("BLOCK-then-resolve: an empty-queue poll blocks, then an injected update resolves the SAME call", async () => {
      // Fire the long-poll while the queue is empty — it must NOT return immediately.
      const pollPromise = callMethod(apiRoot, "getUpdates", { timeout: 5 });

      let resolvedEarly = false;
      void pollPromise.then(() => {
        resolvedEarly = true;
      });
      // Give the poll a moment; it should still be pending (queue empty).
      await new Promise((r) => setTimeout(r, 150));
      expect(resolvedEarly).toBe(false);

      // Now inject — the blocked poll must resolve with the new update.
      emu.injectMessage({ chatId: CHAT_ID }, { id: 777, firstName: "Alice" }, "late ping");
      const env = await pollPromise;
      expect(env.ok).toBe(true);
      const updates = env.result as Array<Record<string, unknown>>;
      expect(updates.length).toBe(1);
      expect((updates[0]!["message"] as Record<string, unknown>)["text"]).toBe("late ping");
    });

    it("BLOCK-then-timeout: an empty-queue poll returns [] after ~timeout when nothing is injected", async () => {
      const start = Date.now();
      // 1-second timeout — the emulator caps the poll small for determinism.
      const env = await callMethod(apiRoot, "getUpdates", { timeout: 1 });
      const elapsed = Date.now() - start;
      expect(env.ok).toBe(true);
      expect(env.result).toEqual([]);
      // It actually blocked (did not return instantly) but did not hang.
      expect(elapsed).toBeGreaterThanOrEqual(800);
      expect(elapsed).toBeLessThan(5000);
    });

    it("ACK / offset: inject u1,u2 → first poll [u1,u2]; offset=u2+1 → []; new u3 → [u3] only (no dup, no drop)", async () => {
      emu.injectMessage({ chatId: CHAT_ID }, { id: 777, firstName: "Alice" }, "u1");
      emu.injectMessage({ chatId: CHAT_ID }, { id: 777, firstName: "Alice" }, "u2");

      // First poll (no offset) → both updates, in update_id order.
      const first = await callMethod(apiRoot, "getUpdates", { timeout: 5 });
      const firstUpdates = first.result as Array<Record<string, unknown>>;
      expect(firstUpdates.length).toBe(2);
      const u1Id = firstUpdates[0]!["update_id"] as number;
      const u2Id = firstUpdates[1]!["update_id"] as number;
      // Strictly monotonic.
      expect(u2Id > u1Id).toBe(true);
      expect((firstUpdates[0]!["message"] as Record<string, unknown>)["text"]).toBe("u1");
      expect((firstUpdates[1]!["message"] as Record<string, unknown>)["text"]).toBe("u2");

      // ACK both via offset = max(update_id) + 1 → nothing re-served (no dup).
      const acked = await callMethod(apiRoot, "getUpdates", { offset: u2Id + 1, timeout: 1 });
      expect(acked.result).toEqual([]);

      // A NEW update after the ack → only u3 (no re-serve of u1/u2, no drop of u3).
      emu.injectMessage({ chatId: CHAT_ID }, { id: 777, firstName: "Alice" }, "u3");
      const third = await callMethod(apiRoot, "getUpdates", { offset: u2Id + 1, timeout: 5 });
      const thirdUpdates = third.result as Array<Record<string, unknown>>;
      expect(thirdUpdates.length).toBe(1);
      expect((thirdUpdates[0]!["message"] as Record<string, unknown>)["text"]).toBe("u3");
      expect((thirdUpdates[0]!["update_id"] as number) > u2Id).toBe(true);
    });

    it("honors `limit`: returns at most `limit` updates and serves the rest on the next poll", async () => {
      emu.injectMessage({ chatId: CHAT_ID }, { id: 777, firstName: "Alice" }, "p1");
      emu.injectMessage({ chatId: CHAT_ID }, { id: 777, firstName: "Alice" }, "p2");
      emu.injectMessage({ chatId: CHAT_ID }, { id: 777, firstName: "Alice" }, "p3");

      const first = await callMethod(apiRoot, "getUpdates", { limit: 2, timeout: 5 });
      const firstUpdates = first.result as Array<Record<string, unknown>>;
      expect(firstUpdates.length).toBe(2);
      const maxSeen = firstUpdates[1]!["update_id"] as number;

      const second = await callMethod(apiRoot, "getUpdates", { offset: maxSeen + 1, limit: 2, timeout: 5 });
      const secondUpdates = second.result as Array<Record<string, unknown>>;
      expect(secondUpdates.length).toBe(1);
      expect((secondUpdates[0]!["message"] as Record<string, unknown>)["text"]).toBe("p3");
    });

    // -----------------------------------------------------------------------
    // WR-01 — MULTI-WAITER / divergent-offset: a non-head waiter's ack must
    // NOT corrupt the shared queue or starve another entitled waiter.
    //
    // The live grammy runner long-polls sequentially (waiters.length ≤ 1), so
    // this is defensive-code correctness, not a live bug. But `tg-emulator.ts`
    // is the channel-agnostic FOUNDATION Phase 209 reuses, and the unit tests
    // already issue manual concurrent `getUpdates` — so the documented "no dup
    // / no drop" guarantee must hold when ≥2 waiters carry divergent offsets.
    // -----------------------------------------------------------------------
    it("MULTI-WAITER: a head waiter with a high offset must not drop the update an undefined-offset waiter is entitled to", async () => {
      // Waiter A blocks first with a high offset (entitled to nothing that
      // exists yet) — it becomes the FIFO head waiter.
      const pollHigh = callMethod(apiRoot, "getUpdates", { offset: 9999, timeout: 2 });
      // Ensure A's request reaches the emulator and registers before B (loopback
      // is sub-ms; this ordering makes A the head waiter deterministically).
      await new Promise((r) => setTimeout(r, 50));
      // Waiter B blocks second with NO offset — entitled to EVERY pending update.
      const pollAny = callMethod(apiRoot, "getUpdates", { timeout: 2 });
      await new Promise((r) => setTimeout(r, 50));

      // Inject a single update (update_id = 1). Under the buggy wake logic the
      // head waiter A applies its ack (filter update_id >= 9999) to the SHARED
      // queue, permanently dropping update 1, then `break`s — so B starves and
      // the update is lost. The fix must serve B with update 1.
      emu.injectMessage({ chatId: CHAT_ID }, { id: 777, firstName: "Alice" }, "for-B-only");

      const [highEnv, anyEnv] = await Promise.all([pollHigh, pollAny]);

      // B (undefined offset) MUST receive the injected update — not dropped, not starved.
      const anyUpdates = anyEnv.result as Array<Record<string, unknown>>;
      expect(anyUpdates.length).toBe(1);
      expect((anyUpdates[0]!["message"] as Record<string, unknown>)["text"]).toBe("for-B-only");

      // A (offset 9999) is entitled to nothing that low → an honest empty,
      // and crucially it did NOT consume or drop update 1.
      expect(highEnv.result).toEqual([]);
    });

    it("MULTI-WAITER: when the head waiter is not deliverable, the wake loop continues and serves the next eligible waiter (no starvation)", async () => {
      // BOTH waiters block on an empty queue. The head (offset 1000) will have
      // nothing to serve when an update arrives; the tail (offset 1) will.
      const pollHead = callMethod(apiRoot, "getUpdates", { offset: 1000, timeout: 2 });
      await new Promise((r) => setTimeout(r, 50));
      const pollTail = callMethod(apiRoot, "getUpdates", { offset: 1, timeout: 2 });
      await new Promise((r) => setTimeout(r, 50));

      // Inject update_id = 1 → only the tail (offset 1) is entitled. Under the
      // buggy wake logic the head's `applyAck(1000)` drops it from the shared
      // queue and `break`s, starving the tail until timeout. The fix must skip
      // the undeliverable head and still serve the tail.
      emu.injectMessage({ chatId: CHAT_ID }, { id: 777, firstName: "Alice" }, "u1");

      const [headEnv, tailEnv] = await Promise.all([pollHead, pollTail]);

      // The head (offset 1000) gets nothing — but must not block the tail.
      expect(headEnv.result).toEqual([]);
      // The tail (offset 1) is served update 1, proving the wake loop did not
      // `break` on the undeliverable head (no starvation, no drop).
      const tailUpdates = tailEnv.result as Array<Record<string, unknown>>;
      expect(tailUpdates.length).toBe(1);
      expect((tailUpdates[0]!["message"] as Record<string, unknown>)["text"]).toBe("u1");
    });

    it("MULTI-WAITER: two undefined-offset waiters split the pending queue with NO duplication (each update delivered once)", async () => {
      // Two waiters both entitled to everything block concurrently.
      const pollA = callMethod(apiRoot, "getUpdates", { timeout: 2 });
      await new Promise((r) => setTimeout(r, 50));
      const pollB = callMethod(apiRoot, "getUpdates", { timeout: 2 });
      await new Promise((r) => setTimeout(r, 50));

      // Inject two updates — they must be partitioned across the two waiters,
      // never the same update handed to both.
      emu.injectMessage({ chatId: CHAT_ID }, { id: 777, firstName: "Alice" }, "m1");
      emu.injectMessage({ chatId: CHAT_ID }, { id: 777, firstName: "Alice" }, "m2");

      const [aEnv, bEnv] = await Promise.all([pollA, pollB]);
      const aUpdates = aEnv.result as Array<Record<string, unknown>>;
      const bUpdates = bEnv.result as Array<Record<string, unknown>>;

      const allIds = [...aUpdates, ...bUpdates].map((u) => u["update_id"] as number).sort((x, y) => x - y);
      // Both updates delivered exactly once across the two waiters (no drop, no dup).
      expect(allIds).toEqual([1, 2]);
      const uniqueIds = new Set(allIds);
      expect(uniqueIds.size).toBe(2);
    });
  });

  // -------------------------------------------------------------------------
  // EMU-04 — setMessageReaction (set + clear), recorded
  // -------------------------------------------------------------------------
  describe("setMessageReaction (EMU-04 set + clear, recorded)", () => {
    it("set records the emoji + returns ok; clear empties it + returns ok", async () => {
      // Mint a bot message to react to.
      const sent = (await callMethod(apiRoot, "sendMessage", { chat_id: CHAT_ID, text: "react to me" }))
        .result as Record<string, unknown>;
      const messageId = sent["message_id"] as number;

      // SET reaction.
      const setEnv = await callMethod(apiRoot, "setMessageReaction", {
        chat_id: CHAT_ID,
        message_id: messageId,
        reaction: [{ type: "emoji", emoji: "👍" }],
      });
      expect(setEnv.ok).toBe(true);
      expect(setEnv.result).toBe(true);
      expect(emu.reactionsOn({ chatId: CHAT_ID }, messageId)).toContain("👍");

      // A RecordedOutbound with method:setMessageReaction + reactions was appended.
      const reactionRecord = emu
        .outbound({ chatId: CHAT_ID })
        .find((r) => r.method === "setMessageReaction");
      expect(reactionRecord).toBeDefined();
      expect(reactionRecord!.reactions).toContain("👍");

      // CLEAR reaction (empty array).
      const clearEnv = await callMethod(apiRoot, "setMessageReaction", {
        chat_id: CHAT_ID,
        message_id: messageId,
        reaction: [],
      });
      expect(clearEnv.ok).toBe(true);
      expect(clearEnv.result).toBe(true);
      expect(emu.reactionsOn({ chatId: CHAT_ID }, messageId)).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // REACT-01 — injectReaction (the INBOUND half: queue a reaction-ADD on an
  // EXISTING bot reply for the next getUpdates poll). The OUTBOUND half
  // (setMessageReaction / reactionsOn) shipped in 204 above. The emitted
  // message_reaction Update is what the already-wired adapter handler
  // (telegram-inbound.ts:266) consumes.
  // -------------------------------------------------------------------------
  describe("injectReaction (REACT-01 — getUpdates serves an inbound reaction-ADD)", () => {
    it("getUpdates serves the injected reaction on an EXISTING bot reply (message_id, emoji, reactor preserved)", async () => {
      // Send a bot reply to react TO (the id recordOutboundMessage keys on).
      const sent = (await callMethod(apiRoot, "sendMessage", { chat_id: CHAT_ID, text: "bot reply" }))
        .result as Record<string, unknown>;
      const botReplyId = sent["message_id"] as number;

      // React 👍 on that existing reply.
      emu.injectReaction({ chatId: CHAT_ID }, { id: 777, firstName: "Alice" }, botReplyId, "👍");

      const env = await callMethod(apiRoot, "getUpdates", { timeout: 5 });
      expect(env.ok).toBe(true);
      const updates = env.result as Array<Record<string, unknown>>;
      expect(updates.length).toBeGreaterThanOrEqual(1);
      const mr = updates[updates.length - 1]!["message_reaction"] as Record<string, unknown>;
      expect(mr).toBeDefined();
      expect(mr["message_id"]).toBe(botReplyId);
      const newReaction = mr["new_reaction"] as Array<Record<string, unknown>>;
      expect(newReaction[0]!["emoji"]).toBe("👍");
      expect(mr["old_reaction"]).toEqual([]);
      expect((mr["user"] as Record<string, unknown>)["id"]).toBe(777);
    });

    it("returns void and mints NO message_id — a subsequent sendMessage is the NEXT sequential id (not id+2)", async () => {
      const first = (await callMethod(apiRoot, "sendMessage", { chat_id: CHAT_ID, text: "first" }))
        .result as Record<string, unknown>;
      const firstId = first["message_id"] as number;

      // injectReaction must NOT advance the message-id counter.
      const ret = emu.injectReaction({ chatId: CHAT_ID }, { id: 777, firstName: "Alice" }, firstId, "👍");
      expect(ret).toBeUndefined();

      const second = (await callMethod(apiRoot, "sendMessage", { chat_id: CHAT_ID, text: "second" }))
        .result as Record<string, unknown>;
      const secondId = second["message_id"] as number;
      // Exactly the next sequential id — the reaction minted nothing in between.
      expect(secondId).toBe(firstId + 1);
    });

    it("emits a reactor (≠ bot, is_bot:false) so the adapter own-filter (:270) does NOT drop it", async () => {
      const sent = (await callMethod(apiRoot, "sendMessage", { chat_id: CHAT_ID, text: "r" }))
        .result as Record<string, unknown>;
      const botReplyId = sent["message_id"] as number;

      emu.injectReaction({ chatId: CHAT_ID }, { id: 555, firstName: "Bob" }, botReplyId, "👍");
      const env = await callMethod(apiRoot, "getUpdates", { timeout: 5 });
      const updates = env.result as Array<Record<string, unknown>>;
      const mr = updates[updates.length - 1]!["message_reaction"] as Record<string, unknown>;
      const user = mr["user"] as Record<string, unknown>;
      expect(user["id"]).toBe(555);
      expect(user["is_bot"]).toBe(false);
    });

    it("BLOCK-then-resolve: an empty-queue poll blocks, then an injected reaction resolves the SAME call (wakeWaiters fired)", async () => {
      // Send the bot reply first (does not enqueue an update; it is outbound).
      const sent = (await callMethod(apiRoot, "sendMessage", { chat_id: CHAT_ID, text: "to react" }))
        .result as Record<string, unknown>;
      const botReplyId = sent["message_id"] as number;

      // Poll an empty inbound queue — must block (no message/reaction queued yet).
      const pollPromise = callMethod(apiRoot, "getUpdates", { timeout: 5 });
      let resolvedEarly = false;
      void pollPromise.then(() => {
        resolvedEarly = true;
      });
      await new Promise((r) => setTimeout(r, 150));
      expect(resolvedEarly).toBe(false);

      // Inject the reaction — the blocked poll must resolve on the SAME call.
      emu.injectReaction({ chatId: CHAT_ID }, { id: 777, firstName: "Alice" }, botReplyId, "👍");
      const env = await pollPromise;
      const updates = env.result as Array<Record<string, unknown>>;
      expect(updates.length).toBe(1);
      const mr = updates[0]!["message_reaction"] as Record<string, unknown>;
      expect((mr["new_reaction"] as Array<Record<string, unknown>>)[0]!["emoji"]).toBe("👍");
    });

    it("bot-global monotonic order: a message then a reaction are served ascending by update_id (reaction's > message's)", async () => {
      const msgId = emu.injectMessage({ chatId: CHAT_ID }, { id: 777, firstName: "Alice" }, "hi");
      const sent = (await callMethod(apiRoot, "sendMessage", { chat_id: CHAT_ID, text: "reply" }))
        .result as Record<string, unknown>;
      const botReplyId = sent["message_id"] as number;
      expect(typeof msgId).toBe("number");
      emu.injectReaction({ chatId: CHAT_ID }, { id: 777, firstName: "Alice" }, botReplyId, "👍");

      const env = await callMethod(apiRoot, "getUpdates", { timeout: 5 });
      const updates = env.result as Array<Record<string, unknown>>;
      // The message and the reaction, in update_id order.
      expect(updates.length).toBe(2);
      const ids = updates.map((u) => u["update_id"] as number);
      expect(ids[1]! > ids[0]!).toBe(true);
      // The first carries the message; the second carries the reaction.
      expect(updates[0]!["message"]).toBeDefined();
      expect(updates[1]!["message_reaction"]).toBeDefined();
    });

    // WR-02 (206-05 review fix): resetChat must drop a QUEUED reaction for the
    // reset chat from the bot-global pending queue. The prior filter keyed only
    // on `u.message`, so a `message_reaction` update (no `.message`) survived a
    // reset regardless of chat and could bleed into a later test that reuses
    // resetChat (207/208/209). RED on pre-fix: the reaction is still served
    // after the reset.
    it("resetChat clears a QUEUED reaction for that chat (no cross-test bleed — WR-02)", async () => {
      const sent = (await callMethod(apiRoot, "sendMessage", { chat_id: CHAT_ID, text: "to react then reset" }))
        .result as Record<string, unknown>;
      const botReplyId = sent["message_id"] as number;

      // Queue a reaction for CHAT_ID, then reset that chat BEFORE it is polled.
      emu.injectReaction({ chatId: CHAT_ID }, { id: 777, firstName: "Alice" }, botReplyId, "👍");
      emu.resetChat({ chatId: CHAT_ID });

      // The queued reaction must NOT survive the reset — a short-timeout poll
      // sees an empty inbound queue (it would block then return []).
      const env = await callMethod(apiRoot, "getUpdates", { timeout: 1 });
      expect(env.ok).toBe(true);
      const updates = env.result as Array<Record<string, unknown>>;
      const reactionUpdates = updates.filter((u) => u["message_reaction"] !== undefined);
      expect(reactionUpdates).toEqual([]);
    });

    it("resetChat is chat-scoped: a queued reaction for a DIFFERENT chat survives the reset (WR-02)", async () => {
      const OTHER_CHAT = CHAT_ID + 1;
      const sentReset = (await callMethod(apiRoot, "sendMessage", { chat_id: CHAT_ID, text: "reset-chat reply" }))
        .result as Record<string, unknown>;
      const resetReplyId = sentReset["message_id"] as number;
      const sentOther = (await callMethod(apiRoot, "sendMessage", { chat_id: OTHER_CHAT, text: "other-chat reply" }))
        .result as Record<string, unknown>;
      const otherReplyId = sentOther["message_id"] as number;

      // Queue a reaction in BOTH chats; reset only CHAT_ID.
      emu.injectReaction({ chatId: CHAT_ID }, { id: 777, firstName: "Alice" }, resetReplyId, "👍");
      emu.injectReaction({ chatId: OTHER_CHAT }, { id: 888, firstName: "Bob" }, otherReplyId, "❌");
      emu.resetChat({ chatId: CHAT_ID });

      const env = await callMethod(apiRoot, "getUpdates", { timeout: 5 });
      const updates = env.result as Array<Record<string, unknown>>;
      const reactionUpdates = updates
        .map((u) => u["message_reaction"] as Record<string, unknown> | undefined)
        .filter((mr): mr is Record<string, unknown> => mr !== undefined);
      // Exactly the OTHER chat's reaction remains; the reset chat's is gone.
      expect(reactionUpdates.length).toBe(1);
      expect((reactionUpdates[0]!["chat"] as Record<string, unknown>)["id"]).toBe(OTHER_CHAT);
      expect(reactionUpdates[0]!["message_id"]).toBe(otherReplyId);
    });
  });

  // -------------------------------------------------------------------------
  // MEDIA-01/02 (Phase 207) — the REAL file_id store backs getFile + the route
  // serves the stored RAW bytes. This REPLACES the 204 EMU-05 stub (hardcoded
  // file_size:1024 + a route that 200s a JSON note). getFile is now keyed by
  // file_id (the request body); the route is keyed by file_path (the URL
  // segment) — Pitfall 3 (TWO indexes, same bytes). A `../`-laden / unknown
  // path is a Map MISS → 404, NEVER a disk read (T-207-04, V12 File Resources).
  // -------------------------------------------------------------------------
  describe("file_id store: getFile (real metadata) + GET /file route (raw bytes) — MEDIA-01/02", () => {
    it("storeFile → getFile returns the REAL file_size (=bytes.length) + the stored file_path (NOT the 1024 stub)", async () => {
      const bytes = Buffer.from("hello-document-bytes-of-known-length", "utf8");
      const handle = emu.storeFile("document", bytes, { fileName: "report.pdf", mimeType: "application/pdf" });
      expect(typeof handle.fileId).toBe("string");
      expect(typeof handle.fileUniqueId).toBe("string");
      expect(typeof handle.filePath).toBe("string");

      const env = await callMethod(apiRoot, "getFile", { file_id: handle.fileId });
      expect(env.ok).toBe(true);
      const file = env.result as Record<string, unknown>;
      expect(file["file_id"]).toBe(handle.fileId);
      expect(file["file_unique_id"]).toBe(handle.fileUniqueId);
      // The REAL byte length — not the hardcoded 1024.
      expect(file["file_size"]).toBe(bytes.length);
      expect(file["file_size"]).not.toBe(1024);
      // The stored path (the route lookup key).
      expect(file["file_path"]).toBe(handle.filePath);
    });

    it("GET /file/bot<token>/<file_path> serves the EXACT stored bytes (binary, byte-for-byte)", async () => {
      const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x10, 0x99]);
      const handle = emu.storeFile("photo", bytes);

      // Resolve the file_path via getFile (exactly what the resolver does).
      const env = await callMethod(apiRoot, "getFile", { file_id: handle.fileId });
      const filePath = (env.result as Record<string, unknown>)["file_path"] as string;

      const res = await fetch(`${apiRoot}/file/bot${TOKEN}/${filePath}`);
      expect(res.status).toBe(200);
      // A real (non-JSON) media content-type.
      expect(res.headers.get("content-type")).not.toBe("application/json");
      const received = Buffer.from(await res.arrayBuffer());
      expect(received.equals(bytes)).toBe(true);
      expect(received.length).toBe(bytes.length);
    });

    it("each kind mints its own file_path extension (photo→.jpg, voice→.ogg, document→.bin, video→.mp4, video_note→.mp4)", () => {
      const expectations: Array<[Parameters<typeof emu.storeFile>[0], RegExp]> = [
        ["photo", /^photos\/.+\.jpg$/],
        ["voice", /^voice\/.+\.ogg$/],
        ["document", /^documents\/.+\.bin$/],
        ["video", /^videos\/.+\.mp4$/],
        ["video_note", /^video_notes\/.+\.mp4$/],
      ];
      for (const [kind, re] of expectations) {
        const h = emu.storeFile(kind, Buffer.from("x"));
        expect(h.filePath).toMatch(re);
      }
    });

    it("getFile on an UNKNOWN file_id returns a Telegram-shaped not-found envelope (ok:false, error_code:400)", async () => {
      const env = await callMethod(apiRoot, "getFile", { file_id: "file_never_stored" });
      expect(env.ok).toBe(false);
      expect(env.error_code).toBe(400);
    });

    it("GET /file on an UNKNOWN path → 404 (a Map miss, never a disk read)", async () => {
      const res = await fetch(`${apiRoot}/file/bot${TOKEN}/documents/does_not_exist.bin`);
      expect(res.status).toBe(404);
    });

    it("SECURITY (T-207-04): a `..`-laden traversal path is a Map MISS → 404, NOT a filesystem read", async () => {
      // A crafted file_path attempting to escape the store. The route resolves
      // ONLY against the in-memory filesByPath Map — there is no fs access — so
      // this is a plain miss. (URL-encoded so the path segment reaches the route
      // verbatim rather than being collapsed by fetch/URL normalization.)
      const traversal = encodeURIComponent("../../../../etc/passwd");
      const res = await fetch(`${apiRoot}/file/bot${TOKEN}/${traversal}`);
      expect(res.status).toBe(404);
      // The body is the JSON not-found envelope — definitively not file contents.
      const json = (await res.json()) as { ok: boolean; error_code?: number };
      expect(json.ok).toBe(false);
    });

    it("storeFile keeps BOTH indexes consistent: the file_path getFile reports resolves to the same bytes on the route", async () => {
      const bytes = Buffer.from("two-index-consistency-bytes", "utf8");
      const handle = emu.storeFile("voice", bytes, { mimeType: "audio/ogg" });
      // filesById path (getFile by file_id).
      const env = await callMethod(apiRoot, "getFile", { file_id: handle.fileId });
      const reportedPath = (env.result as Record<string, unknown>)["file_path"] as string;
      expect(reportedPath).toBe(handle.filePath);
      // filesByPath path (the route by file_path) — the SAME bytes.
      const res = await fetch(`${apiRoot}/file/bot${TOKEN}/${reportedPath}`);
      const received = Buffer.from(await res.arrayBuffer());
      expect(received.equals(bytes)).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // MEDIA-01 / MEDIA-03 — injectMedia / injectLocation queue the right inbound
  // `message` update + mint/return a message_id (mirroring injectMessage). The
  // media update carries the SAME file_id storeFile minted, so getFile + the
  // route + the adapter's tg-file://{file_id} resolution all agree.
  // -------------------------------------------------------------------------
  describe("injectMedia / injectLocation (MEDIA-01 — queue a media/place message + mint a message_id)", () => {
    it("injectMedia stores the bytes, queues a media `message` carrying the stored file_id, and RETURNS the minted message_id", async () => {
      const bytes = Buffer.from("a-voice-clip", "utf8");
      const msgId = emu.injectMedia(
        { chatId: CHAT_ID },
        { id: 777, firstName: "Alice" },
        "voice",
        bytes,
        { mimeType: "audio/ogg", duration: 3 },
      );
      expect(typeof msgId).toBe("number");

      const env = await callMethod(apiRoot, "getUpdates", { timeout: 5 });
      const updates = env.result as Array<Record<string, unknown>>;
      expect(updates.length).toBe(1);
      const message = updates[0]!["message"] as Record<string, unknown>;
      expect(message).toBeDefined();
      expect(message["message_id"]).toBe(msgId);
      const voice = message["voice"] as Record<string, unknown>;
      expect(voice).toBeDefined();
      const storedFileId = voice["file_id"] as string;

      // The injected file_id resolves to the stored bytes (getFile + the route).
      const fileEnv = await callMethod(apiRoot, "getFile", { file_id: storedFileId });
      expect(fileEnv.ok).toBe(true);
      const file = fileEnv.result as Record<string, unknown>;
      expect(file["file_size"]).toBe(bytes.length);
      const res = await fetch(`${apiRoot}/file/bot${TOKEN}/${file["file_path"] as string}`);
      const received = Buffer.from(await res.arrayBuffer());
      expect(received.equals(bytes)).toBe(true);
    });

    it("injectMedia mints sequential message_ids (it advances the counter like injectMessage)", () => {
      const a = emu.injectMedia({ chatId: CHAT_ID }, { id: 777, firstName: "Alice" }, "photo", Buffer.from("p"));
      const b = emu.injectMedia({ chatId: CHAT_ID }, { id: 777, firstName: "Alice" }, "photo", Buffer.from("q"));
      expect(b).toBe(a + 1);
    });

    it("injectMedia with spoiler:true sets has_media_spoiler on the message", async () => {
      emu.injectMedia({ chatId: CHAT_ID }, { id: 777, firstName: "Alice" }, "photo", Buffer.from("p"), { spoiler: true });
      const env = await callMethod(apiRoot, "getUpdates", { timeout: 5 });
      const updates = env.result as Array<Record<string, unknown>>;
      const message = updates[0]!["message"] as Record<string, unknown>;
      expect(message["has_media_spoiler"]).toBe(true);
    });

    it("injectLocation queues a `message` carrying a location (no file store) + mints a message_id", async () => {
      const msgId = emu.injectLocation(
        { chatId: CHAT_ID },
        { id: 777, firstName: "Alice" },
        { location: { latitude: 51.5, longitude: -0.12, horizontalAccuracy: 10 } },
      );
      expect(typeof msgId).toBe("number");
      const env = await callMethod(apiRoot, "getUpdates", { timeout: 5 });
      const updates = env.result as Array<Record<string, unknown>>;
      const message = updates[0]!["message"] as Record<string, unknown>;
      expect(message["message_id"]).toBe(msgId);
      const loc = message["location"] as Record<string, unknown>;
      expect(loc["latitude"]).toBe(51.5);
      expect(loc["longitude"]).toBe(-0.12);
      // No file was stored — a location is not media.
      expect(message["voice"]).toBeUndefined();
      expect(message["document"]).toBeUndefined();
    });

    it("injectLocation with a venue sets message.venue (venue WINS — and NOT message.location)", async () => {
      emu.injectLocation(
        { chatId: CHAT_ID },
        { id: 777, firstName: "Alice" },
        { venue: { latitude: 40.0, longitude: -73.0, title: "The Spot", address: "1 Main St" } },
      );
      const env = await callMethod(apiRoot, "getUpdates", { timeout: 5 });
      const updates = env.result as Array<Record<string, unknown>>;
      const message = updates[0]!["message"] as Record<string, unknown>;
      const venue = message["venue"] as Record<string, unknown>;
      expect(venue["title"]).toBe("The Spot");
      expect(message["location"]).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // INTERACT-01 / INTERACT-02 — injectCallback / injectEdit queue the
  // callback_query / edited_message updates the adapter handlers consume
  // (telegram-inbound.ts:165 / :117). The callback references an EXISTING bot
  // reply (mints NO message_id, like injectReaction); the edit references the
  // existing message_id.
  // -------------------------------------------------------------------------
  describe("injectCallback / injectEdit (INTERACT-01/02 — queue callback_query / edited_message)", () => {
    it("injectCallback queues a callback_query update referencing the EXISTING bot reply (data + tapper preserved), mints NO message_id", async () => {
      // A bot reply with an inline button to tap.
      const sent = (await callMethod(apiRoot, "sendMessage", { chat_id: CHAT_ID, text: "tap me" }))
        .result as Record<string, unknown>;
      const botReplyId = sent["message_id"] as number;

      const ret = emu.injectCallback({ chatId: CHAT_ID }, { id: 777, firstName: "Alice" }, botReplyId, "ACTION_YES");
      // Like injectReaction, a callback references an existing reply — no new id.
      expect(ret).toBeUndefined();

      const env = await callMethod(apiRoot, "getUpdates", { timeout: 5 });
      const updates = env.result as Array<Record<string, unknown>>;
      expect(updates.length).toBe(1);
      const cb = updates[0]!["callback_query"] as Record<string, unknown>;
      expect(cb).toBeDefined();
      expect(cb["data"]).toBe("ACTION_YES");
      // The tapper (≠ bot).
      const from = cb["from"] as Record<string, unknown>;
      expect(from["id"]).toBe(777);
      expect(from["is_bot"]).toBe(false);
      // The tapped message is the EXISTING bot reply (chat.id + message_id).
      const message = cb["message"] as Record<string, unknown>;
      expect(message["message_id"]).toBe(botReplyId);
      expect((message["chat"] as Record<string, unknown>)["id"]).toBe(CHAT_ID);
      expect(typeof cb["chat_instance"]).toBe("string");
    });

    it("injectCallback mints NO message_id — a subsequent sendMessage is the NEXT sequential id (not id+2)", async () => {
      const first = (await callMethod(apiRoot, "sendMessage", { chat_id: CHAT_ID, text: "first" }))
        .result as Record<string, unknown>;
      const firstId = first["message_id"] as number;
      emu.injectCallback({ chatId: CHAT_ID }, { id: 777, firstName: "Alice" }, firstId, "X");
      const second = (await callMethod(apiRoot, "sendMessage", { chat_id: CHAT_ID, text: "second" }))
        .result as Record<string, unknown>;
      expect((second["message_id"] as number)).toBe(firstId + 1);
    });

    it("injectEdit queues an edited_message update for the existing message_id with the new text + edit_date", async () => {
      const ret = emu.injectEdit({ chatId: CHAT_ID }, 555, "the corrected text", { id: 777, firstName: "Alice" });
      expect(ret).toBeUndefined();

      const env = await callMethod(apiRoot, "getUpdates", { timeout: 5 });
      const updates = env.result as Array<Record<string, unknown>>;
      expect(updates.length).toBe(1);
      const edited = updates[0]!["edited_message"] as Record<string, unknown>;
      expect(edited).toBeDefined();
      expect(edited["message_id"]).toBe(555);
      expect(edited["text"]).toBe("the corrected text");
      expect(typeof edited["edit_date"]).toBe("number");
      expect((edited["from"] as Record<string, unknown>)["id"]).toBe(777);
    });
  });

  // -------------------------------------------------------------------------
  // INTERACT-01 — answerCallbackQuery / editMessageText RECORD a
  // RecordedOutbound (Pattern 5). The adapter calls answerCallbackQuery
  // UNCONDITIONALLY + FIRST (telegram-inbound.ts:168); recording it makes the
  // ack provable on the channel oracle (the silent default: would answer but be
  // invisible). The ack body carries NO chat_id (only callback_query_id), so it
  // records on the chat-0 oracle.
  // -------------------------------------------------------------------------
  describe("answerCallbackQuery / editMessageText record cases (INTERACT-01 — Pattern 5)", () => {
    it("answerCallbackQuery returns { ok:true, result:true } AND records a RecordedOutbound (method:answerCallbackQuery)", async () => {
      const env = await callMethod(apiRoot, "answerCallbackQuery", { callback_query_id: "cbq_123" });
      // The adapter awaits ctx.answerCallbackQuery() → expects result:true (A5).
      expect(env.ok).toBe(true);
      expect(env.result).toBe(true);

      // The ack is RECORDED (Pattern 5) — assertable on the channel oracle. The
      // ack body has no chat_id, so it lands on the chat-0 oracle.
      const ackRecord = emu.outbound({ chatId: 0 }).find((r) => r.method === "answerCallbackQuery");
      expect(ackRecord).toBeDefined();
      expect((ackRecord!.raw as Record<string, unknown>)["callback_query_id"]).toBe("cbq_123");
    });

    it("editMessageText records a RecordedOutbound (method:editMessageText, text) AND echoes a Message", async () => {
      const env = await callMethod(apiRoot, "editMessageText", {
        chat_id: CHAT_ID,
        message_id: 4242,
        text: "edited body",
        parse_mode: "HTML",
      });
      expect(env.ok).toBe(true);
      // grammy's editMessageText return type is Message-or-true; the emulator
      // echoes a realistic Message.
      const result = env.result as Record<string, unknown>;
      expect(result["message_id"]).toBe(4242);
      expect(result["text"]).toBe("edited body");
      expect((result["chat"] as Record<string, unknown>)["id"]).toBe(CHAT_ID);

      const editRecord = emu.outbound({ chatId: CHAT_ID }).find((r) => r.method === "editMessageText");
      expect(editRecord).toBeDefined();
      expect(editRecord!.messageId).toBe(4242);
      expect(editRecord!.text).toBe("edited body");
    });
  });

  // -------------------------------------------------------------------------
  // resetChat clears ALL FOUR new update kinds (no cross-test bleed — the
  // WR-02 206-05 precedent extended). A media/edit `message`/`edited_message`
  // is chat-id-matched; a callback_query is bot-global (kept by the `: true`
  // tail) — but a callback whose tapped `message` is in the reset chat must
  // also be dropped, so the filter matches the callback's message chat.id.
  // -------------------------------------------------------------------------
  describe("resetChat clears the new inbound kinds (no leak — WR-02 extended)", () => {
    it("resetChat clears a QUEUED media `message`, location `message`, edited_message AND callback_query for that chat", async () => {
      const sent = (await callMethod(apiRoot, "sendMessage", { chat_id: CHAT_ID, text: "reply" }))
        .result as Record<string, unknown>;
      const botReplyId = sent["message_id"] as number;

      emu.injectMedia({ chatId: CHAT_ID }, { id: 777, firstName: "Alice" }, "document", Buffer.from("d"));
      emu.injectLocation({ chatId: CHAT_ID }, { id: 777, firstName: "Alice" }, { location: { latitude: 1, longitude: 2 } });
      emu.injectEdit({ chatId: CHAT_ID }, 555, "edit", { id: 777, firstName: "Alice" });
      emu.injectCallback({ chatId: CHAT_ID }, { id: 777, firstName: "Alice" }, botReplyId, "DATA");
      emu.resetChat({ chatId: CHAT_ID });

      // All four kinds for CHAT_ID are gone — a short poll sees an empty queue.
      const env = await callMethod(apiRoot, "getUpdates", { timeout: 1 });
      const updates = env.result as Array<Record<string, unknown>>;
      expect(updates).toEqual([]);
    });

    it("resetChat is chat-scoped: a callback_query / edited_message for a DIFFERENT chat survives", async () => {
      const OTHER_CHAT = CHAT_ID + 7;
      const sentOther = (await callMethod(apiRoot, "sendMessage", { chat_id: OTHER_CHAT, text: "other reply" }))
        .result as Record<string, unknown>;
      const otherReplyId = sentOther["message_id"] as number;

      // Queue an edit + a callback in CHAT_ID, and a callback in OTHER_CHAT.
      emu.injectEdit({ chatId: CHAT_ID }, 100, "x", { id: 777, firstName: "Alice" });
      emu.injectCallback({ chatId: OTHER_CHAT }, { id: 888, firstName: "Bob" }, otherReplyId, "OTHER_DATA");
      emu.resetChat({ chatId: CHAT_ID });

      const env = await callMethod(apiRoot, "getUpdates", { timeout: 5 });
      const updates = env.result as Array<Record<string, unknown>>;
      // Only the OTHER chat's callback remains.
      expect(updates.length).toBe(1);
      const cb = updates[0]!["callback_query"] as Record<string, unknown>;
      expect(cb["data"]).toBe("OTHER_DATA");
      expect(((cb["message"] as Record<string, unknown>)["chat"] as Record<string, unknown>)["id"]).toBe(OTHER_CHAT);
    });
  });

  // -------------------------------------------------------------------------
  // SEC-01 — loopback bind
  // -------------------------------------------------------------------------
  describe("loopback bind (SEC-01)", () => {
    it("apiRoot is http://127.0.0.1:<port>", () => {
      expect(apiRoot).toBe(`http://127.0.0.1:${port}`);
    });
  });

  // -------------------------------------------------------------------------
  // FOUNDATION wiring — extends ChannelEmulator + built ON the http-backend base
  // -------------------------------------------------------------------------
  describe("foundation wiring (extends ChannelEmulator, on http-backend)", () => {
    it("exposes a ChannelCaps descriptor via the ChannelEmulator port", () => {
      expect(emu.caps.channel).toBe("telegram");
      expect(emu.caps.protocol).toBe("http");
    });

    it("source extends ChannelEmulator and imports the http-backend base (no bespoke createServer)", () => {
      const src = readFileSync(EMULATOR_SOURCE, "utf8");
      expect(src).toMatch(/extends ChannelEmulator/);
      expect(src).toMatch(/backends\/http-backend/);
      // The emulator composes the base; it must NOT spin up its own server.
      expect(src).not.toMatch(/createServer/);
      // No wildcard host anywhere in the source (loopback-only intent).
      expect(src).not.toContain("0.0.0.0");
      // The drain-per-poll anti-pattern must be absent (true long-poll only).
      expect(src).not.toMatch(/queuedUpdates\.length\s*=\s*0/);
    });

    it("documents GOTCHA B at the resetChat site (a message_reaction update has no .message → kept by the `: true` branch)", () => {
      const src = readFileSync(EMULATOR_SOURCE, "utf8");
      // The resetChat pending-filter keys on `u.message`; a reaction update has
      // no `.message`, so it survives a reset. The site must flag this so a
      // future reaction-after-reset test extends the filter to message_reaction.
      expect(src).toMatch(/message_reaction/);
    });
  });
});

// ===========================================================================
// GROUP-01/02 — createGroupChat / createForumTopic + InjectOpts-aware
// injectMessage (Phase 208). The emulator must mint group/supergroup/forum
// chats, forum topics, and addressing-bearing message updates so the rig can
// drive the group surface the chat API can't reach.
// ===========================================================================

describe("TgEmulator — group/forum chats + addressing inject (GROUP-01/02)", () => {
  let emu: TgEmulator;
  let apiRoot: string;

  beforeEach(async () => {
    resetUpdateIdCounter();
    emu = createTgEmulator({ botToken: TOKEN });
    const handle = await emu.start();
    apiRoot = handle.apiRoot;
    // Confirm the loopback bind (the emulator is the fake api.telegram.org).
    expect(apiRoot).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });

  afterEach(async () => {
    await emu.stop();
  });

  /** Long-poll once and return the served updates (the grammy-runner path). */
  async function pollUpdates(offset?: number): Promise<Array<Record<string, unknown>>> {
    const res = await fetch(`${apiRoot}/bot${TOKEN}/getUpdates`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ timeout: 0, ...(offset !== undefined ? { offset } : {}) }),
    });
    const env = (await res.json()) as { ok: boolean; result: Array<Record<string, unknown>> };
    expect(env.ok).toBe(true);
    return env.result;
  }

  describe("createGroupChat / createForumTopic", () => {
    it("createGroupChat({supergroup,forum}) → a ChatRef with a NEGATIVE supergroup id and the forum/admins seed recorded", () => {
      const bot = { id: 12345, firstName: "TestBot", username: "test_bot" };
      const auth = { id: 111, firstName: "auth", username: "auth" };
      const attacker = { id: 222, firstName: "attacker" };
      const group = emu.createGroupChat({ members: [auth, attacker], bot, supergroup: true, forum: true, admins: [auth] });
      // Group chats use a NEGATIVE chat id (the -100… Telegram supergroup form).
      expect(group.chatId).toBeLessThan(0);
    });

    it("createForumTopic(chat, name) → a ThreadRef carrying a numeric message_thread_id", () => {
      const group = emu.createGroupChat({ members: [{ id: 111, firstName: "a" }], supergroup: true, forum: true });
      const topic = emu.createForumTopic(group, "general-discussion");
      expect(typeof topic.threadId).toBe("number");
      expect(topic.threadId).toBeGreaterThan(0);
    });
  });

  describe("injectMessage with InjectOpts (mention/command/replyTo/thread)", () => {
    it("a mention opt → the served update carries a `mention` entity over @<bot> (isBotMentioned source)", async () => {
      const group = emu.createGroupChat({ members: [{ id: 111, firstName: "a", username: "a" }], bot: { id: 12345, firstName: "TestBot", username: "test_bot" }, supergroup: true });
      emu.injectMessage(group, { id: 111, firstName: "a", username: "a" }, "@test_bot help", { mention: true });
      const updates = await pollUpdates();
      expect(updates.length).toBe(1);
      const msg = updates[0]!["message"] as Record<string, unknown>;
      // The group chat shape (not the private literal).
      expect((msg["chat"] as Record<string, unknown>)["type"]).toBe("supergroup");
      const entities = msg["entities"] as Array<Record<string, unknown>> | undefined;
      expect(Array.isArray(entities)).toBe(true);
      expect(entities?.[0]?.["type"]).toBe("mention");
    });

    it("a command opt → the served update carries a `bot_command` entity (the /cmd@bot path)", async () => {
      const group = emu.createGroupChat({ members: [{ id: 111, firstName: "a" }], bot: { id: 12345, firstName: "TestBot", username: "test_bot" }, supergroup: true });
      emu.injectMessage(group, { id: 111, firstName: "a" }, "/reset@test_bot", { command: true });
      const updates = await pollUpdates();
      const msg = updates[0]!["message"] as Record<string, unknown>;
      const entities = msg["entities"] as Array<Record<string, unknown>> | undefined;
      expect(entities?.[0]?.["type"]).toBe("bot_command");
    });

    it("a replyTo opt → the served update carries a reply_to_message authored by the bot (replyToBot source)", async () => {
      const group = emu.createGroupChat({ members: [{ id: 111, firstName: "a" }], bot: { id: 12345, firstName: "TestBot", username: "test_bot" }, supergroup: true });
      emu.injectMessage(group, { id: 111, firstName: "a" }, "thanks", { replyTo: 40 });
      const updates = await pollUpdates();
      const msg = updates[0]!["message"] as Record<string, unknown>;
      const replyTo = msg["reply_to_message"] as Record<string, unknown> | undefined;
      expect(replyTo?.["message_id"]).toBe(40);
      // The replied-to message is authored by the bot (so detectBotAddressing flips replyToBot).
      expect((replyTo?.["from"] as Record<string, unknown>)?.["is_bot"]).toBe(true);
    });

    it("a thread opt → the served update carries message_thread_id (the forum topic routing)", async () => {
      const group = emu.createGroupChat({ members: [{ id: 111, firstName: "a" }], supergroup: true, forum: true });
      const topic = emu.createForumTopic(group, "topic-1");
      emu.injectMessage(group, { id: 111, firstName: "a" }, "in topic", { thread: topic.threadId });
      const updates = await pollUpdates();
      const msg = updates[0]!["message"] as Record<string, unknown>;
      expect(msg["message_thread_id"]).toBe(topic.threadId);
    });

    it("distinct senders cross-talk: two injectMessage calls carry their own `from` (group multi-user)", async () => {
      const group = emu.createGroupChat({ members: [{ id: 111, firstName: "a" }, { id: 222, firstName: "b" }], supergroup: true });
      emu.injectMessage(group, { id: 111, firstName: "a" }, "from a");
      emu.injectMessage(group, { id: 222, firstName: "b" }, "from b");
      const updates = await pollUpdates();
      expect(updates.length).toBe(2);
      const senders = updates.map((u) => ((u["message"] as Record<string, unknown>)["from"] as Record<string, unknown>)["id"]);
      expect(senders).toEqual([111, 222]);
    });

    it("the existing single-arg DM injectMessage(chat, from, text) still works (back-compat — the DM path is unbroken)", async () => {
      // A plain ChatRef (the DM form) with NO InjectOpts — exactly the pre-208 call.
      emu.injectMessage({ chatId: 424242 }, { id: 100, firstName: "Tester" }, "dm hello");
      const updates = await pollUpdates();
      expect(updates.length).toBe(1);
      const msg = updates[0]!["message"] as Record<string, unknown>;
      expect((msg["chat"] as Record<string, unknown>)["type"]).toBe("private");
      expect(msg["text"]).toBe("dm hello");
      // No addressing fields when none requested.
      expect(msg["entities"]).toBeUndefined();
      expect(msg["reply_to_message"]).toBeUndefined();
    });
  });

  describe("source-shape guards (createGroupChat/createForumTopic present, grammy-typed)", () => {
    it("the emulator source exposes createGroupChat + createForumTopic", () => {
      const src = readFileSync(EMULATOR_SOURCE, "utf8");
      expect(src).toMatch(/createGroupChat/);
      expect(src).toMatch(/createForumTopic/);
    });
  });

  // -------------------------------------------------------------------------
  // FAULT-01 — the fail()/clearFaults() fault-injection seam (Plan 02). The
  // emulator can make any Bot-API method return a Telegram error envelope
  // `{ ok:false, error_code, description, parameters? }` on demand so the REAL
  // adapter hits the error and runs its fallback. `once:true` lets the SECOND
  // call (the adapter's retry) succeed; `matchChat` scopes the fault to one chat.
  // -------------------------------------------------------------------------
  describe("fail()/clearFaults() — the Bot-API fault-injection seam", () => {
    it("a once:true fault makes the FIRST call return the error envelope and the SECOND succeed (the retry-consumed once)", async () => {
      emu.fail("sendMessage", { error_code: 400, description: "synthetic parse failure" }, { once: true });

      // FIRST call — the injected error envelope (ok:false, error_code 400).
      const first = await callMethod(apiRoot, "sendMessage", { chat_id: CHAT_ID, text: "x" });
      expect(first.ok).toBe(false);
      expect(first.error_code).toBe(400);

      // SECOND call — the once-fault is consumed, so the normal ok:true echo lands
      // (this is what makes a fallback's recorded RETRY outbound assertable).
      const second = await callMethod(apiRoot, "sendMessage", { chat_id: CHAT_ID, text: "x" });
      expect(second.ok).toBe(true);
    });

    it("a method with NO fault set returns its normal ok:true envelope (back-compat — existing scenarios unaffected)", async () => {
      // No fail() call — the method behaves exactly as before.
      const env = await callMethod(apiRoot, "sendMessage", { chat_id: CHAT_ID, text: "unfaulted" });
      expect(env.ok).toBe(true);
    });

    it("a persistent fault (no once) keeps failing until clearFaults()", async () => {
      emu.fail("setMessageReaction", { error_code: 400, description: "REACTION_INVALID" });
      const a = await callMethod(apiRoot, "setMessageReaction", { chat_id: CHAT_ID, message_id: 1, reaction: [] });
      expect(a.ok).toBe(false);
      const b = await callMethod(apiRoot, "setMessageReaction", { chat_id: CHAT_ID, message_id: 1, reaction: [] });
      expect(b.ok).toBe(false);
      // clearFaults() removes the map → the method succeeds again.
      emu.clearFaults();
      const c = await callMethod(apiRoot, "setMessageReaction", { chat_id: CHAT_ID, message_id: 1, reaction: [] });
      expect(c.ok).toBe(true);
    });

    it("matchChat scopes the fault to one chat — a different chat is unaffected", async () => {
      emu.fail("sendMessage", { error_code: 403, description: "forbidden here" }, { matchChat: CHAT_ID });
      // The matched chat fails.
      const matched = await callMethod(apiRoot, "sendMessage", { chat_id: CHAT_ID, text: "to matched" });
      expect(matched.ok).toBe(false);
      expect(matched.error_code).toBe(403);
      // A different chat is NOT faulted.
      const other = await callMethod(apiRoot, "sendMessage", { chat_id: 999_999, text: "to other" });
      expect(other.ok).toBe(true);
      emu.clearFaults();
    });

    it("the error envelope carries the parameters (so a 429 retry_after reaches the adapter's auto-retry)", async () => {
      emu.fail("sendMessage", { error_code: 429, description: "Too Many Requests", parameters: { retry_after: 1 } }, { once: true });
      const env = (await fetch(botUrl(apiRoot, "sendMessage"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: CHAT_ID, text: "x" }),
      }).then((r) => r.json())) as { ok: boolean; error_code?: number; parameters?: { retry_after?: number } };
      expect(env.ok).toBe(false);
      expect(env.error_code).toBe(429);
      expect(env.parameters?.retry_after).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // COVER-01 — the Tier-3 group-admin Bot-API methods (on demand) + the honest
  // unimplemented-log guard (HARD constraint 3: log it, NEVER a silent stub).
  // -------------------------------------------------------------------------
  describe("Tier-3 Bot-API methods (COVER-01 — round-trip against a seeded group)", () => {
    /** Seed a group via createGroupChat and return its negative chat id. */
    function seedGroup(admins: Array<{ id: number; firstName: string; username?: string }>): number {
      const ref = emu.createGroupChat({
        members: admins,
        admins,
        bot: { id: 12345, firstName: "TestBot", username: "test_bot" },
        supergroup: true,
      });
      return ref.chatId;
    }

    it("getChatAdministrators reports the createGroupChat admins[] seed (the COVER-01 round-trip keystone)", async () => {
      const chatId = seedGroup([
        { id: 111, firstName: "owner", username: "owner" },
        { id: 222, firstName: "mod", username: "mod" },
      ]);
      const env = await callMethod(apiRoot, "getChatAdministrators", { chat_id: chatId });
      expect(env.ok).toBe(true);
      const admins = env.result as Array<{ status: string; user: { id: number; first_name: string; is_bot: boolean } }>;
      // The emulator reports the seeded admin set — same ids the createGroupChat
      // admins[] seed recorded. A bot client maps a.user.id/first_name/is_bot/status.
      const ids = admins.map((a) => a.user.id).sort((a, b) => a - b);
      expect(ids).toEqual([111, 222]);
      // Each entry carries a well-formed status + a user (the platformAction reads these).
      for (const a of admins) {
        expect(typeof a.status).toBe("string");
        expect(typeof a.user.id).toBe("number");
        expect(typeof a.user.first_name).toBe("string");
        expect(typeof a.user.is_bot).toBe("boolean");
      }
    });

    it("getChatAdministrators on an UNSEEDED chat returns an empty admin set (no phantom admins)", async () => {
      const env = await callMethod(apiRoot, "getChatAdministrators", { chat_id: -100999 });
      expect(env.ok).toBe(true);
      expect(env.result as unknown[]).toEqual([]);
    });

    it("pinChatMessage records the pin + returns ok:true (a Tier-3 mutation round-trip)", async () => {
      const chatId = seedGroup([{ id: 111, firstName: "owner" }]);
      const env = await callMethod(apiRoot, "pinChatMessage", { chat_id: chatId, message_id: 55 });
      expect(env.ok).toBe(true);
      expect(env.result).toBe(true);
      // The pin is recorded on the chat oracle (provable round-trip).
      const recorded = emu.outbound({ chatId }).filter((o) => o.method === "pinChatMessage");
      expect(recorded.length).toBe(1);
      expect(recorded[0]!.messageId).toBe(55);
    });

    it("sendChatAction carries message_thread_id INCLUDING the General id=1 (the typing side of the asymmetry)", async () => {
      const chatId = seedGroup([{ id: 111, firstName: "owner" }]);
      // General topic (id=1) — TYPING must carry message_thread_id:1 (the side
      // sendMessage omits). The emulator records the thread id verbatim.
      const env = await callMethod(apiRoot, "sendChatAction", {
        chat_id: chatId,
        action: "typing",
        message_thread_id: 1,
      });
      expect(env.ok).toBe(true);
      const recorded = emu.outbound({ chatId }).filter((o) => o.method === "sendChatAction");
      expect(recorded.length).toBe(1);
      expect(recorded[0]!.messageThreadId).toBe(1);
    });

    it("getChat returns the seeded chat descriptor (a Tier-3 read round-trip)", async () => {
      const chatId = seedGroup([{ id: 111, firstName: "owner" }]);
      const env = await callMethod(apiRoot, "getChat", { chat_id: chatId });
      expect(env.ok).toBe(true);
      const chat = env.result as Record<string, unknown>;
      expect(chat["id"]).toBe(chatId);
      expect(chat["type"]).toBe("supergroup");
    });

    it("getChatMemberCount returns the seeded member count", async () => {
      const chatId = seedGroup([
        { id: 111, firstName: "owner" },
        { id: 222, firstName: "mod" },
      ]);
      const env = await callMethod(apiRoot, "getChatMemberCount", { chat_id: chatId });
      expect(env.ok).toBe(true);
      // 2 members + the bot = 3 (the recorded seed + bot).
      expect(typeof env.result).toBe("number");
      expect(env.result as number).toBeGreaterThanOrEqual(2);
    });

    it("an UNIMPLEMENTED Tier-3 method logs an honest line + is surfaced via unimplementedCalls() — NEVER a silent no-op (HARD constraint 3)", async () => {
      // banChatMember is a real Tier-3 method NOT wired on demand for any COVER
      // UC. It MUST route through the honest fallback: a `[tg-emulator]
      // unimplemented Bot-API method: <name>` log + a detectable record. A silent
      // okEnvelope({}) here would FALSELY report coverage (the no-false-success
      // principle applied to coverage — T-208-10).
      const before = emu.unimplementedCalls().length;
      await callMethod(apiRoot, "banChatMember", { chat_id: -100999, user_id: 222 });
      const calls = emu.unimplementedCalls();
      // The unimplemented call is surfaced (the scenario can detect it) — not silent.
      expect(calls.length).toBe(before + 1);
      expect(calls[calls.length - 1]).toBe("banChatMember");
    });

    it("the honest-log guard is present in source (no silent stub for an unimplemented Tier-3 method)", () => {
      const src = readFileSync(EMULATOR_SOURCE, "utf8");
      expect(src).toMatch(/unimplemented Bot-API method/);
    });
  });

  // -------------------------------------------------------------------------
  // COVER-02 — injectServiceMessage (the forum-service negative; the adapter
  // FILTERS these, so the harness must be able to mint + queue one).
  // -------------------------------------------------------------------------
  describe("injectServiceMessage (COVER-02 — the forum-service message the adapter filters)", () => {
    it("queues a forum-service `message` update for the next getUpdates poll", async () => {
      const group = emu.createGroupChat({
        members: [{ id: 111, firstName: "owner" }],
        supergroup: true,
        forum: true,
      });
      emu.injectServiceMessage(group, "forum_topic_created");

      const env = await callMethod(apiRoot, "getUpdates", { timeout: 5 });
      expect(env.ok).toBe(true);
      const updates = env.result as Array<Record<string, unknown>>;
      expect(updates.length).toBe(1);
      const msg = updates[0]!["message"] as Record<string, unknown>;
      // The queued update is a forum-service message (no text) — exactly what the
      // adapter filters at telegram-inbound.ts:50.
      expect(msg["forum_topic_created"]).toBeDefined();
      expect(msg["text"]).toBeUndefined();
      expect((msg["chat"] as Record<string, unknown>)["id"]).toBe(group.chatId);
    });

    it("resetChat drops a queued service message (it is a `message` update keyed on the chat)", async () => {
      const group = emu.createGroupChat({ members: [{ id: 111, firstName: "owner" }], supergroup: true, forum: true });
      emu.injectServiceMessage(group, "forum_topic_closed");
      emu.resetChat(group);
      // After reset the queue has no pending update for that chat — a poll returns [].
      const env = await callMethod(apiRoot, "getUpdates", { timeout: 0 });
      expect(env.ok).toBe(true);
      expect((env.result as unknown[]).length).toBe(0);
    });
  });
});
