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
  });

  // -------------------------------------------------------------------------
  // EMU-05 — getFile method + file route SHAPE (no 404 at boot)
  // -------------------------------------------------------------------------
  describe("getFile + file route shape (EMU-05 — no byte serving in 204)", () => {
    it("getFile returns the file-descriptor envelope", async () => {
      const env = await callMethod(apiRoot, "getFile", { file_id: "AgADfile123" });
      expect(env.ok).toBe(true);
      const file = env.result as Record<string, unknown>;
      expect(file).toHaveProperty("file_id");
      expect(file).toHaveProperty("file_unique_id");
      expect(file).toHaveProperty("file_size");
      expect(typeof file["file_path"]).toBe("string");
    });

    it("GET /file/bot<token>/<path> returns HTTP 200 (route shape exists, NOT 404)", async () => {
      // First obtain a file_path from getFile.
      const env = await callMethod(apiRoot, "getFile", { file_id: "AgADfile123" });
      const file = env.result as Record<string, unknown>;
      const filePath = file["file_path"] as string;

      const res = await fetch(`${apiRoot}/file/bot${TOKEN}/${filePath}`);
      expect(res.status).toBe(200);
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
