// SPDX-License-Identifier: Apache-2.0
/**
 * Stage-A unit tests for the generic `/control/*` surface + the in-process
 * typed control client + the reply-wait primitive (`control-api.ts`, RIG-03 +
 * SEC-01, Phase 204).
 *
 * Pure in-process HTTP/typed-verb tests — no daemon, no key, no real network
 * (the only "network" is loopback `fetch` against the emulator's own
 * `127.0.0.1:<port>`). The control API is the canonical driver surface; the rig
 * (Plan 05) and the round-trip scenario inject a message + await the reply
 * through this ONE mechanism, and Phase 205's `chan`/`tg` CLI is a thin HTTP
 * client over the same handlers.
 *
 * These tests assert the MINIMAL 204 route set on the SHARED http-backend base
 * (one loopback port shared with the Bot API):
 *   - POST /control/chats/:id/messages → { messageId } + queues an inbound the
 *     emulator's getUpdates serves (the inject route).
 *   - GET  /control/chats/:id/outbound?afterMessageId&waitMs → the reply-wait:
 *     immediate when an outbound already exists; block-then-resolve when one is
 *     recorded mid-wait; and — the PRIME DIRECTIVE (I5) — `[]` on timeout (an
 *     honest "no reply within Nms", NEVER a fabricated success).
 *   - in-process == HTTP parity: the typed `ControlClient` calls the SAME
 *     handlers without a socket and returns the SAME results.
 *   - SEC-01: `/control/*` is namespaced (never confused with `/bot<token>/*`)
 *     and binds loopback only (no wildcard host in the source).
 *
 * Run under the LIVE vitest config (the bare root config excludes `test/live`,
 * collecting 0 files → false green):
 *   pnpm vitest run -c test/live/vitest.config.ts \
 *     test/live/harness/control-api.test.ts
 *
 * @module
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTgEmulator, type RecordedOutbound, type TgEmulator } from "../emulators/telegram/tg-emulator.js";
import { resetUpdateIdCounter } from "../emulators/telegram/tg-payloads.js";
import { registerControlApi, type ControlClient } from "./control-api.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const CONTROL_API_SOURCE = resolve(HERE, "control-api.ts");

// A stub bot token of the `<id>:<secret>` shape grammy builds paths from. No
// real credential — loopback only.
const TOKEN = "12345:test";
// A FIXED test chat id chosen so it can never collide with a real operator
// chat (the control surface keys per-chat state on it).
const CHAT_ID = 424242;
const USER_ID = 777;

/** Build the Bot-API URL for a method against the running emulator. */
function botUrl(apiRoot: string, method: string): string {
  return `${apiRoot}/bot${TOKEN}/${method}`;
}

/** POST a JSON body to a Bot-API method (drives the emulator's outbound oracle). */
async function callBotMethod(
  apiRoot: string,
  method: string,
  body: Record<string, unknown>,
): Promise<{ ok: boolean; result?: unknown }> {
  const res = await fetch(botUrl(apiRoot, method), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return (await res.json()) as { ok: boolean; result?: unknown };
}

/** POST a JSON body to a `/control/*` route and return status + parsed body. */
async function postControl(
  apiRoot: string,
  path: string,
  body: Record<string, unknown>,
): Promise<{ status: number; json: unknown }> {
  const res = await fetch(`${apiRoot}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

/** GET a `/control/*` route and return status + parsed body. */
async function getControl(apiRoot: string, path: string): Promise<{ status: number; json: unknown }> {
  const res = await fetch(`${apiRoot}${path}`, { method: "GET" });
  return { status: res.status, json: await res.json() };
}

describe("control-api — generic /control/* surface + in-proc client + reply-wait (RIG-03)", () => {
  let emu: TgEmulator;
  let client: ControlClient;
  let apiRoot: string;

  beforeEach(async () => {
    resetUpdateIdCounter();
    emu = createTgEmulator({ botToken: TOKEN });
    // Register /control/* on the emulator's SHARED http-backend base (ONE
    // loopback port shared with the Bot API). Returns the in-proc typed client.
    client = registerControlApi(emu.backend, emu);
    const handle = await emu.start();
    apiRoot = handle.apiRoot;
  });

  afterEach(async () => {
    await emu.stop();
  });

  // -------------------------------------------------------------------------
  // POST /control/chats/:id/messages — the inject route
  // -------------------------------------------------------------------------
  describe("POST /control/chats/:id/messages (inject)", () => {
    it("returns { messageId } and queues an inbound update the emulator serves", async () => {
      const { status, json } = await postControl(apiRoot, `/control/chats/${CHAT_ID}/messages`, {
        fromUserId: USER_ID,
        text: "ping from the driver",
      });
      expect(status).toBe(200);
      const body = json as { messageId?: number };
      expect(typeof body.messageId).toBe("number");

      // The injected message is served by the emulator's getUpdates long-poll.
      const env = await callBotMethod(apiRoot, "getUpdates", { timeout: 5 });
      expect(env.ok).toBe(true);
      const updates = env.result as Array<Record<string, unknown>>;
      expect(updates.length).toBe(1);
      expect((updates[0]!["message"] as Record<string, unknown>)["text"]).toBe("ping from the driver");
    });

    it("accepts a form-encoded body as well as JSON (dual parse)", async () => {
      const res = await fetch(`${apiRoot}/control/chats/${CHAT_ID}/messages`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: `fromUserId=${USER_ID}&text=${encodeURIComponent("form ping")}`,
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { messageId?: number };
      expect(typeof body.messageId).toBe("number");

      const env = await callBotMethod(apiRoot, "getUpdates", { timeout: 5 });
      const updates = env.result as Array<Record<string, unknown>>;
      expect((updates[0]!["message"] as Record<string, unknown>)["text"]).toBe("form ping");
    });
  });

  // -------------------------------------------------------------------------
  // GET /control/chats/:id/outbound — the reply-wait primitive
  // -------------------------------------------------------------------------
  describe("GET /control/chats/:id/outbound (reply-wait primitive)", () => {
    it("IMMEDIATE: with an outbound already recorded after afterMessageId, returns it at once", async () => {
      // Record an outbound (the agent's reply) BEFORE the wait.
      const sent = (await callBotMethod(apiRoot, "sendMessage", { chat_id: CHAT_ID, text: "the reply" }))
        .result as Record<string, unknown>;
      const sentId = sent["message_id"] as number;

      const { status, json } = await getControl(
        apiRoot,
        `/control/chats/${CHAT_ID}/outbound?afterMessageId=${sentId - 1}&waitMs=1000`,
      );
      expect(status).toBe(200);
      const outbounds = json as RecordedOutbound[];
      expect(outbounds.length).toBe(1);
      expect(outbounds[0]!.text).toBe("the reply");
      expect(outbounds[0]!.messageId).toBe(sentId);
    });

    it("BLOCK-then-resolve: an empty-outbound wait blocks, then a recorded outbound resolves the SAME call", async () => {
      // Fire the reply-wait while there is no new outbound — it must NOT return
      // immediately.
      const waitPromise = getControl(apiRoot, `/control/chats/${CHAT_ID}/outbound?afterMessageId=0&waitMs=3000`);
      let resolvedEarly = false;
      void waitPromise.then(() => {
        resolvedEarly = true;
      });
      await new Promise((r) => setTimeout(r, 150));
      expect(resolvedEarly).toBe(false);

      // Now record an outbound (the agent replies) — the blocked wait resolves.
      await callBotMethod(apiRoot, "sendMessage", { chat_id: CHAT_ID, text: "late reply" });
      const { status, json } = await waitPromise;
      expect(status).toBe(200);
      const outbounds = json as RecordedOutbound[];
      expect(outbounds.length).toBeGreaterThanOrEqual(1);
      expect(outbounds[0]!.text).toBe("late reply");
    });

    it("TIMEOUT returns [] (honest no-reply, NEVER a fabricated success) after ~waitMs", async () => {
      const start = Date.now();
      const { status, json } = await getControl(
        apiRoot,
        `/control/chats/${CHAT_ID}/outbound?afterMessageId=0&waitMs=200`,
      );
      const elapsed = Date.now() - start;
      expect(status).toBe(200);
      // The caller can distinguish "no reply" from "a reply": [] (NOT an error,
      // NOT a synthesized outbound).
      expect(json).toEqual([]);
      // Honored the wait (returned only after ~waitMs, not instantly), but did
      // not hang forever.
      expect(elapsed).toBeGreaterThanOrEqual(150);
      expect(elapsed).toBeLessThan(2000);
    });

    it("only returns outbounds STRICTLY after afterMessageId (an older outbound is not a reply)", async () => {
      const sent = (await callBotMethod(apiRoot, "sendMessage", { chat_id: CHAT_ID, text: "old" }))
        .result as Record<string, unknown>;
      const sentId = sent["message_id"] as number;
      // Watermark AT the existing outbound's id → nothing strictly newer → [].
      const { json } = await getControl(
        apiRoot,
        `/control/chats/${CHAT_ID}/outbound?afterMessageId=${sentId}&waitMs=200`,
      );
      expect(json).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // in-process == HTTP parity (the typed ControlClient calls the SAME handlers)
  // -------------------------------------------------------------------------
  describe("in-process ControlClient == HTTP path (behavioral parity)", () => {
    it("injectMessage via the client queues the same inbound as the HTTP route", async () => {
      const messageId = await client.injectMessage({ chatId: CHAT_ID, fromUserId: USER_ID, text: "in-proc ping" });
      expect(typeof messageId).toBe("number");

      const env = await callBotMethod(apiRoot, "getUpdates", { timeout: 5 });
      const updates = env.result as Array<Record<string, unknown>>;
      expect(updates.length).toBe(1);
      expect((updates[0]!["message"] as Record<string, unknown>)["text"]).toBe("in-proc ping");
    });

    it("waitForOutbound via the client returns the SAME result as the HTTP route for the same inputs", async () => {
      await callBotMethod(apiRoot, "sendMessage", { chat_id: CHAT_ID, text: "parity reply" });

      const viaClient = await client.waitForOutbound({ chatId: CHAT_ID, afterMessageId: 0, waitMs: 1000 });
      const viaHttp = (await getControl(apiRoot, `/control/chats/${CHAT_ID}/outbound?afterMessageId=0&waitMs=1000`))
        .json as RecordedOutbound[];

      expect(viaClient.map((o) => o.text)).toEqual(["parity reply"]);
      // Same handler, same inputs → byte-identical result shape.
      expect(viaClient.map((o) => ({ messageId: o.messageId, text: o.text }))).toEqual(
        viaHttp.map((o) => ({ messageId: o.messageId, text: o.text })),
      );
    });

    it("waitForOutbound times out into [] in-process exactly as the HTTP path does (no false success)", async () => {
      const viaClient = await client.waitForOutbound({ chatId: CHAT_ID, afterMessageId: 0, waitMs: 200 });
      expect(viaClient).toEqual([]);
    });

    it("waitForReply returns the first new outbound, or undefined on timeout (honest)", async () => {
      const none = await client.waitForReply({ chatId: CHAT_ID, afterMessageId: 0, waitMs: 200 });
      expect(none).toBeUndefined();

      await callBotMethod(apiRoot, "sendMessage", { chat_id: CHAT_ID, text: "first reply" });
      const reply = await client.waitForReply({ chatId: CHAT_ID, afterMessageId: 0, waitMs: 1000 });
      expect(reply?.text).toBe("first reply");
    });

    it("an in-process inject + reply-wait round-trips identically to the HTTP path", async () => {
      // Full round-trip via the client only (no socket): inject, the bot replies
      // over the Bot API, the client's reply-wait sees it.
      await client.injectMessage({ chatId: CHAT_ID, fromUserId: USER_ID, text: "round-trip" });
      await callBotMethod(apiRoot, "sendMessage", { chat_id: CHAT_ID, text: "round-trip reply" });
      const reply = await client.waitForReply({ chatId: CHAT_ID, afterMessageId: 0, waitMs: 1000 });
      expect(reply?.text).toBe("round-trip reply");
    });
  });

  // -------------------------------------------------------------------------
  // POST /control/chats/:id/reactions — the inject-reaction route (REACT-02)
  //
  // The load-bearing structural assertion: ONE handler (handleInjectReaction)
  // serves BOTH the HTTP dispatch arm AND the in-proc ControlClient, so an
  // in-proc inject and an HTTP inject drive emulator.injectReaction IDENTICALLY
  // (in-proc == HTTP parity, mirroring the inject-route round-trip above). A
  // SPY ControlEmulator records the forwarded `injectReaction(chat, from,
  // botMessageId, emoji)` call so both paths can be asserted byte-identical.
  // -------------------------------------------------------------------------
  describe("POST /control/chats/:id/reactions (inject reaction — REACT-02)", () => {
    /** A recorded injectReaction call (the args forwarded to the emulator). */
    interface ReactionCall {
      readonly chat: { readonly chatId: number };
      readonly from: { id: number; firstName: string; username?: string };
      readonly botMessageId: number;
      readonly emoji: string;
    }

    /**
     * A spy ControlEmulator that records every injectReaction call so the test
     * can assert the handler forwards args verbatim AND that the in-proc and
     * HTTP paths produce an IDENTICAL emulator-side effect (one call per path).
     * It satisfies the minimal channel-agnostic ControlEmulator shape; the
     * unused inject/outbound members return harmless defaults.
     */
    function makeSpyControl(): {
      backend: ReturnType<typeof createTgEmulator>["backend"];
      client: ControlClient;
      apiRoot: string;
      reactionCalls: ReactionCall[];
      start(): Promise<void>;
      stop(): Promise<void>;
    } {
      const reactionCalls: ReactionCall[] = [];
      // Reuse a real emulator's http-backend base (one loopback port) but pass a
      // SPY emulator to registerControlApi so injectReaction is observable.
      const hostEmu = createTgEmulator({ botToken: TOKEN });
      const spyEmulator = {
        injectMessage: (_chat: { readonly chatId: number }, _from: unknown, _text: string): number => 0,
        outbound: (_chat: { readonly chatId: number }): readonly RecordedOutbound[] => [],
        injectReaction: (
          chat: { readonly chatId: number },
          from: { id: number; firstName: string; username?: string },
          botMessageId: number,
          emoji: string,
        ): void => {
          reactionCalls.push({ chat, from, botMessageId, emoji });
        },
      };
      const spyClient = registerControlApi(hostEmu.backend, spyEmulator as never);
      let root = "";
      return {
        backend: hostEmu.backend,
        client: spyClient,
        get apiRoot() {
          return root;
        },
        reactionCalls,
        async start() {
          const h = await hostEmu.start();
          root = h.apiRoot;
        },
        async stop() {
          await hostEmu.stop();
        },
      };
    }

    it("drives emulator.injectReaction IDENTICALLY whether reached in-proc or over HTTP (parity)", async () => {
      const spy = makeSpyControl();
      await spy.start();
      try {
        // In-proc: the typed ControlClient.injectReaction.
        await spy.client.injectReaction({ chatId: CHAT_ID, fromUserId: USER_ID, botMessageId: 555, emoji: "👍" });
        // HTTP: POST /control/chats/<id>/reactions.
        const { status, json } = await postControl(spy.apiRoot, `/control/chats/${CHAT_ID}/reactions`, {
          fromUserId: USER_ID,
          botMessageId: 555,
          emoji: "👍",
        });
        expect(status).toBe(200);
        expect(json).toEqual({ ok: true });

        // Both paths produced the SAME emulator-side effect: two identical calls.
        expect(spy.reactionCalls).toHaveLength(2);
        const [viaClient, viaHttp] = spy.reactionCalls;
        expect(viaClient).toEqual(viaHttp);
        expect(viaClient!.chat).toEqual({ chatId: CHAT_ID });
        expect(viaClient!.botMessageId).toBe(555);
        expect(viaClient!.emoji).toBe("👍");
      } finally {
        await spy.stop();
      }
    });

    it("forwards chatId, a {id, firstName:`user_<id>`} from, botMessageId, and emoji VERBATIM to injectReaction", async () => {
      const spy = makeSpyControl();
      await spy.start();
      try {
        await postControl(spy.apiRoot, `/control/chats/${CHAT_ID}/reactions`, {
          fromUserId: 111,
          botMessageId: 909,
          emoji: "🔥",
        });
        expect(spy.reactionCalls).toHaveLength(1);
        const call = spy.reactionCalls[0]!;
        expect(call.chat).toEqual({ chatId: CHAT_ID });
        // The handler derives a stable `user_<id>` firstName at the boundary.
        expect(call.from).toEqual({ id: 111, firstName: "user_111" });
        expect(call.botMessageId).toBe(909);
        expect(call.emoji).toBe("🔥");
      } finally {
        await spy.stop();
      }
    });

    it("returns 400 (honest no-crash) on a non-numeric botMessageId — never crashes (T-204-12)", async () => {
      const spy = makeSpyControl();
      await spy.start();
      try {
        const { status, json } = await postControl(spy.apiRoot, `/control/chats/${CHAT_ID}/reactions`, {
          fromUserId: USER_ID,
          botMessageId: "not-a-number",
          emoji: "👍",
        });
        expect(status).toBe(400);
        expect(json).toMatchObject({ ok: false });
        expect((json as { error?: unknown }).error).toBeTruthy();
        // The bad request never reached the emulator.
        expect(spy.reactionCalls).toHaveLength(0);
        // The server stayed up — a follow-up valid request still works.
        const ok = await postControl(spy.apiRoot, `/control/chats/${CHAT_ID}/reactions`, {
          fromUserId: USER_ID,
          botMessageId: 1,
          emoji: "👍",
        });
        expect(ok.status).toBe(200);
      } finally {
        await spy.stop();
      }
    });

    it("returns 400 on a MISSING emoji — never crashes", async () => {
      const spy = makeSpyControl();
      await spy.start();
      try {
        const { status, json } = await postControl(spy.apiRoot, `/control/chats/${CHAT_ID}/reactions`, {
          fromUserId: USER_ID,
          botMessageId: 7,
        });
        expect(status).toBe(400);
        expect(json).toMatchObject({ ok: false });
        expect(spy.reactionCalls).toHaveLength(0);
      } finally {
        await spy.stop();
      }
    });

    it("drives the REAL TgEmulator: a reaction on a bot reply trips the wire, served by getUpdates", async () => {
      // The control API registered in beforeEach drives the REAL emulator. POST a
      // reaction on an existing bot reply id; the emulator queues a
      // message_reaction Update the long-poll then serves (the full inbound half).
      const sent = (await callBotMethod(apiRoot, "sendMessage", { chat_id: CHAT_ID, text: "bot reply" }))
        .result as Record<string, unknown>;
      const botReplyId = sent["message_id"] as number;

      const { status, json } = await postControl(apiRoot, `/control/chats/${CHAT_ID}/reactions`, {
        fromUserId: 111,
        botMessageId: botReplyId,
        emoji: "👍",
      });
      expect(status).toBe(200);
      expect(json).toEqual({ ok: true });

      const env = await callBotMethod(apiRoot, "getUpdates", { timeout: 5 });
      const updates = env.result as Array<Record<string, unknown>>;
      expect(updates.length).toBe(1);
      const reaction = updates[0]!["message_reaction"] as Record<string, unknown>;
      expect(reaction).toBeDefined();
      expect(reaction["message_id"]).toBe(botReplyId);
      const newReaction = reaction["new_reaction"] as Array<Record<string, unknown>>;
      expect(newReaction[0]).toEqual({ type: "emoji", emoji: "👍" });
    });
  });

  // -------------------------------------------------------------------------
  // The reaction route regex (REACT-02) — a pure source-shape assertion.
  // -------------------------------------------------------------------------
  describe("the /control/chats/:id/reactions path constant (REACT-02)", () => {
    it("matches /reactions (incl. negative chat ids + trailing slash) and NOT /messages", () => {
      // Re-derive the design path regex; assert the source declares the same.
      const re = /^\/control\/chats\/(-?\d+)\/reactions\/?$/;
      expect(re.test("/control/chats/123/reactions")).toBe(true);
      expect(re.test("/control/chats/-100/reactions")).toBe(true); // supergroup
      expect(re.test("/control/chats/123/reactions/")).toBe(true); // trailing slash
      expect(re.test("/control/chats/123/messages")).toBe(false); // not the inject route
      const src = readFileSync(CONTROL_API_SOURCE, "utf8");
      // The source declares a named reactions path constant targeting /reactions
      // (the route is wired, mirroring CHAT_MESSAGES_PATH).
      expect(src).toMatch(/CHAT_REACTIONS_PATH/);
      expect(src).toMatch(/\/reactions/);
    });
  });

  // -------------------------------------------------------------------------
  // SEC-01 — namespace + loopback bind
  // -------------------------------------------------------------------------
  describe("SEC-01 — /control/* namespaced + loopback only", () => {
    it("dispatches /control/* AND /bot<token>/* on the SAME port without confusion", async () => {
      // The Bot API works on this port.
      const me = await callBotMethod(apiRoot, "getMe", {});
      expect(me.ok).toBe(true);

      // /control/* works on the SAME port and is NOT matched by the Bot-API matcher.
      const { status } = await postControl(apiRoot, `/control/chats/${CHAT_ID}/messages`, {
        fromUserId: USER_ID,
        text: "namespaced",
      });
      expect(status).toBe(200);

      // apiRoot is loopback.
      expect(apiRoot).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    });

    it("control-api.ts binds loopback only — the source contains no wildcard host and uses the shared base", () => {
      const src = readFileSync(CONTROL_API_SOURCE, "utf8");
      // No wildcard bind host anywhere in the source (defense-in-depth tripwire).
      expect(src).not.toMatch(/0\.0\.0\.0/);
      // It registers on the shared http-backend base (not a bespoke server).
      expect(src).toMatch(/registerControlRoute/);
      expect(src).not.toMatch(/createServer/);
      // The reply-wait primitive params are present.
      expect(src).toMatch(/afterMessageId/);
      expect(src).toMatch(/waitMs/);
    });
  });
});
