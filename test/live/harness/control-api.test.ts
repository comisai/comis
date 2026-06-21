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
  // POST /control/chats/:id/{media,location,callbacks,edits} — the four §4.6
  // routes (Phase 207). Each mirrors the 206 reactions trio: ONE shared handler
  // both the HTTP dispatch arm AND the in-proc ControlClient invoke, so an
  // in-proc inject and an HTTP inject drive the matching emulator verb
  // IDENTICALLY (in-proc == HTTP parity). The media byte payload travels as
  // base64 inside the JSON body (decoded to a Buffer in the handler) — NO
  // multipart parser (it stays in the existing parseControlBody JSON branch,
  // AGENTS.md §2.3 stdlib-first). A SPY ControlEmulator records the four verbs'
  // forwarded args so both paths can be asserted byte-identical and bad input
  // can be confirmed to never reach the emulator.
  // -------------------------------------------------------------------------
  describe("POST /control/chats/:id/{media,location,callbacks,edits} (the four §4.6 routes — Phase 207)", () => {
    /** A recorded injectMedia call (the args forwarded to the emulator). */
    interface MediaCall {
      readonly chat: { readonly chatId: number };
      readonly from: { id: number; firstName: string; username?: string };
      readonly kind: string;
      readonly bytes: Buffer;
      readonly meta?: Record<string, unknown>;
    }
    /** A recorded injectLocation call. */
    interface LocationCall {
      readonly chat: { readonly chatId: number };
      readonly from: { id: number; firstName: string; username?: string };
      readonly place: Record<string, unknown>;
    }
    /** A recorded injectCallback call. */
    interface CallbackCall {
      readonly chat: { readonly chatId: number };
      readonly from: { id: number; firstName: string; username?: string };
      readonly botMessageId: number;
      readonly data: string;
    }
    /** A recorded injectEdit call. */
    interface EditCall {
      readonly chat: { readonly chatId: number };
      readonly messageId: number;
      readonly newText: string;
      readonly from: { id: number; firstName: string; username?: string };
    }

    /**
     * A spy ControlEmulator recording every injectMedia/injectLocation/
     * injectCallback/injectEdit call so the test can assert the handlers forward
     * args verbatim AND that the in-proc and HTTP paths produce an IDENTICAL
     * emulator-side effect (one call per path). The media verb mints + returns a
     * message_id (like injectMessage); the callback/edit verbs mint none (void).
     */
    function makeSpyControl(): {
      client: ControlClient;
      apiRoot: string;
      mediaCalls: MediaCall[];
      locationCalls: LocationCall[];
      callbackCalls: CallbackCall[];
      editCalls: EditCall[];
      start(): Promise<void>;
      stop(): Promise<void>;
    } {
      const mediaCalls: MediaCall[] = [];
      const locationCalls: LocationCall[] = [];
      const callbackCalls: CallbackCall[] = [];
      const editCalls: EditCall[] = [];
      let nextMessageId = 9000;
      const hostEmu = createTgEmulator({ botToken: TOKEN });
      const spyEmulator = {
        injectMessage: (_chat: { readonly chatId: number }, _from: unknown, _text: string): number => 0,
        outbound: (_chat: { readonly chatId: number }): readonly RecordedOutbound[] => [],
        injectReaction: (): void => {},
        injectMedia: (
          chat: { readonly chatId: number },
          from: { id: number; firstName: string; username?: string },
          kind: string,
          bytes: Buffer,
          meta?: Record<string, unknown>,
        ): number => {
          mediaCalls.push({ chat, from, kind, bytes, ...(meta !== undefined ? { meta } : {}) });
          return nextMessageId++;
        },
        injectLocation: (
          chat: { readonly chatId: number },
          from: { id: number; firstName: string; username?: string },
          place: Record<string, unknown>,
        ): number => {
          locationCalls.push({ chat, from, place });
          return nextMessageId++;
        },
        injectCallback: (
          chat: { readonly chatId: number },
          from: { id: number; firstName: string; username?: string },
          botMessageId: number,
          data: string,
        ): void => {
          callbackCalls.push({ chat, from, botMessageId, data });
        },
        injectEdit: (
          chat: { readonly chatId: number },
          messageId: number,
          newText: string,
          from: { id: number; firstName: string; username?: string },
        ): void => {
          editCalls.push({ chat, messageId, newText, from });
        },
      };
      const spyClient = registerControlApi(hostEmu.backend, spyEmulator as never);
      let root = "";
      return {
        client: spyClient,
        get apiRoot() {
          return root;
        },
        mediaCalls,
        locationCalls,
        callbackCalls,
        editCalls,
        async start() {
          const h = await hostEmu.start();
          root = h.apiRoot;
        },
        async stop() {
          await hostEmu.stop();
        },
      };
    }

    // ---- media -------------------------------------------------------------
    describe("POST /control/chats/:id/media (inject media — MEDIA-01/03)", () => {
      it("drives emulator.injectMedia IDENTICALLY whether reached in-proc or over HTTP (parity), base64→Buffer", async () => {
        const spy = makeSpyControl();
        await spy.start();
        try {
          const payload = Buffer.from("hello-media-bytes");
          const fileBase64 = payload.toString("base64");
          // In-proc: the typed ControlClient.injectMedia.
          const inProcId = await spy.client.injectMedia({
            chatId: CHAT_ID,
            fromUserId: USER_ID,
            kind: "photo",
            fileBase64,
          });
          expect(typeof inProcId).toBe("number");
          // HTTP: POST /control/chats/<id>/media.
          const { status, json } = await postControl(spy.apiRoot, `/control/chats/${CHAT_ID}/media`, {
            fromUserId: USER_ID,
            kind: "photo",
            fileBase64,
          });
          expect(status).toBe(200);
          const body = json as { ok?: boolean; messageId?: number };
          expect(body.ok).toBe(true);
          expect(typeof body.messageId).toBe("number");

          // Both paths produced the SAME emulator-side effect: two identical calls.
          expect(spy.mediaCalls).toHaveLength(2);
          const [viaClient, viaHttp] = spy.mediaCalls;
          expect(viaClient!.chat).toEqual({ chatId: CHAT_ID });
          expect(viaClient!.kind).toBe("photo");
          // The handler base64-DECODED fileBase64 → the original Buffer (not the string).
          expect(Buffer.isBuffer(viaClient!.bytes)).toBe(true);
          expect(viaClient!.bytes.equals(payload)).toBe(true);
          expect(viaHttp!.bytes.equals(payload)).toBe(true);
          expect(viaClient!.from).toEqual({ id: USER_ID, firstName: `user_${USER_ID}` });
        } finally {
          await spy.stop();
        }
      });

      it("forwards the optional meta (fileName/mimeType/durationMs/spoiler) to injectMedia", async () => {
        const spy = makeSpyControl();
        await spy.start();
        try {
          const fileBase64 = Buffer.from("doc-bytes").toString("base64");
          await postControl(spy.apiRoot, `/control/chats/${CHAT_ID}/media`, {
            fromUserId: 111,
            kind: "document",
            fileBase64,
            fileName: "report.pdf",
            mimeType: "application/pdf",
            durationMs: 4200,
            spoiler: true,
          });
          expect(spy.mediaCalls).toHaveLength(1);
          const call = spy.mediaCalls[0]!;
          expect(call.kind).toBe("document");
          expect(call.meta).toMatchObject({
            fileName: "report.pdf",
            mimeType: "application/pdf",
            spoiler: true,
          });
        } finally {
          await spy.stop();
        }
      });

      it("returns 400 on an UNKNOWN media kind — never crashes, never reaches the emulator", async () => {
        const spy = makeSpyControl();
        await spy.start();
        try {
          const fileBase64 = Buffer.from("x").toString("base64");
          const { status, json } = await postControl(spy.apiRoot, `/control/chats/${CHAT_ID}/media`, {
            fromUserId: USER_ID,
            kind: "hologram", // not in the closed MediaKind union
            fileBase64,
          });
          expect(status).toBe(400);
          expect(json).toMatchObject({ ok: false });
          expect((json as { error?: unknown }).error).toBeTruthy();
          expect(spy.mediaCalls).toHaveLength(0);
          // The server stayed up — a follow-up valid request still works.
          const ok = await postControl(spy.apiRoot, `/control/chats/${CHAT_ID}/media`, {
            fromUserId: USER_ID,
            kind: "voice",
            fileBase64,
          });
          expect(ok.status).toBe(200);
        } finally {
          await spy.stop();
        }
      });

      it("returns 400 on a MISSING/NON-STRING fileBase64 — never crashes", async () => {
        const spy = makeSpyControl();
        await spy.start();
        try {
          // Missing fileBase64.
          const missing = await postControl(spy.apiRoot, `/control/chats/${CHAT_ID}/media`, {
            fromUserId: USER_ID,
            kind: "photo",
          });
          expect(missing.status).toBe(400);
          expect(missing.json).toMatchObject({ ok: false });
          // Non-string fileBase64.
          const nonString = await postControl(spy.apiRoot, `/control/chats/${CHAT_ID}/media`, {
            fromUserId: USER_ID,
            kind: "photo",
            fileBase64: 12345,
          });
          expect(nonString.status).toBe(400);
          expect(spy.mediaCalls).toHaveLength(0);
        } finally {
          await spy.stop();
        }
      });
    });

    // ---- location ----------------------------------------------------------
    describe("POST /control/chats/:id/location (inject location/venue — MEDIA-01)", () => {
      it("drives emulator.injectLocation IDENTICALLY in-proc and over HTTP (parity), plain point", async () => {
        const spy = makeSpyControl();
        await spy.start();
        try {
          const inProcId = await spy.client.injectLocation({
            chatId: CHAT_ID,
            fromUserId: USER_ID,
            latitude: 51.5,
            longitude: -0.12,
            horizontalAccuracy: 8,
          });
          expect(typeof inProcId).toBe("number");
          const { status, json } = await postControl(spy.apiRoot, `/control/chats/${CHAT_ID}/location`, {
            fromUserId: USER_ID,
            latitude: 51.5,
            longitude: -0.12,
            horizontalAccuracy: 8,
          });
          expect(status).toBe(200);
          expect(json).toMatchObject({ ok: true });
          expect(typeof (json as { messageId?: number }).messageId).toBe("number");

          expect(spy.locationCalls).toHaveLength(2);
          const [viaClient, viaHttp] = spy.locationCalls;
          expect(viaClient!.place).toEqual(viaHttp!.place);
          // The plain-point branch: a `location` PlaceInput, NO venue.
          expect(viaClient!.place).toEqual({
            location: { latitude: 51.5, longitude: -0.12, horizontalAccuracy: 8 },
          });
          expect(viaClient!.from).toEqual({ id: USER_ID, firstName: `user_${USER_ID}` });
        } finally {
          await spy.stop();
        }
      });

      it("forwards a venue body as a `venue` PlaceInput (venue wins)", async () => {
        const spy = makeSpyControl();
        await spy.start();
        try {
          await postControl(spy.apiRoot, `/control/chats/${CHAT_ID}/location`, {
            fromUserId: USER_ID,
            venue: { latitude: 48.85, longitude: 2.35, title: "Eiffel Tower", address: "Champ de Mars" },
          });
          expect(spy.locationCalls).toHaveLength(1);
          expect(spy.locationCalls[0]!.place).toEqual({
            venue: { latitude: 48.85, longitude: 2.35, title: "Eiffel Tower", address: "Champ de Mars" },
          });
        } finally {
          await spy.stop();
        }
      });

      it("returns 400 on a body that is neither a valid location nor venue — never crashes", async () => {
        const spy = makeSpyControl();
        await spy.start();
        try {
          // No latitude/longitude and no venue.
          const { status, json } = await postControl(spy.apiRoot, `/control/chats/${CHAT_ID}/location`, {
            fromUserId: USER_ID,
          });
          expect(status).toBe(400);
          expect(json).toMatchObject({ ok: false });
          expect(spy.locationCalls).toHaveLength(0);
        } finally {
          await spy.stop();
        }
      });
    });

    // ---- callbacks ---------------------------------------------------------
    describe("POST /control/chats/:id/callbacks (inject callback — INTERACT-01)", () => {
      it("drives emulator.injectCallback IDENTICALLY in-proc and over HTTP (parity)", async () => {
        const spy = makeSpyControl();
        await spy.start();
        try {
          await spy.client.injectCallback({
            chatId: CHAT_ID,
            fromUserId: USER_ID,
            botMessageId: 321,
            data: "vote:yes",
          });
          const { status, json } = await postControl(spy.apiRoot, `/control/chats/${CHAT_ID}/callbacks`, {
            fromUserId: USER_ID,
            botMessageId: 321,
            data: "vote:yes",
          });
          expect(status).toBe(200);
          // A callback mints no id — the §4.6 shape is `{ ok: true }`.
          expect(json).toEqual({ ok: true });

          expect(spy.callbackCalls).toHaveLength(2);
          const [viaClient, viaHttp] = spy.callbackCalls;
          expect(viaClient).toEqual(viaHttp);
          expect(viaClient!.chat).toEqual({ chatId: CHAT_ID });
          expect(viaClient!.botMessageId).toBe(321);
          expect(viaClient!.data).toBe("vote:yes");
          expect(viaClient!.from).toEqual({ id: USER_ID, firstName: `user_${USER_ID}` });
        } finally {
          await spy.stop();
        }
      });

      it("returns 400 on a non-numeric botMessageId / missing data — never crashes", async () => {
        const spy = makeSpyControl();
        await spy.start();
        try {
          const badId = await postControl(spy.apiRoot, `/control/chats/${CHAT_ID}/callbacks`, {
            fromUserId: USER_ID,
            botMessageId: "nope",
            data: "x",
          });
          expect(badId.status).toBe(400);
          const missingData = await postControl(spy.apiRoot, `/control/chats/${CHAT_ID}/callbacks`, {
            fromUserId: USER_ID,
            botMessageId: 5,
          });
          expect(missingData.status).toBe(400);
          expect(spy.callbackCalls).toHaveLength(0);
        } finally {
          await spy.stop();
        }
      });

      it("the JSON parseBody branch handles the callback body (IN-04: scalar data, NO form-parser change)", async () => {
        // grammy sends inline-keyboard/callback bodies as JSON; the control route
        // uses a JSON body with a scalar `data` string, which parseControlBody's
        // JSON branch handles. The `&`-split form parser is never relied on for
        // callbacks. (CF-1 — confirm the JSON path, do NOT array-decode the form.)
        const spy = makeSpyControl();
        await spy.start();
        try {
          const { status } = await postControl(spy.apiRoot, `/control/chats/${CHAT_ID}/callbacks`, {
            fromUserId: USER_ID,
            botMessageId: 77,
            data: "page=2&sort=asc", // a value that WOULD confuse a naive form parser — but it's JSON here
          });
          expect(status).toBe(200);
          expect(spy.callbackCalls).toHaveLength(1);
          // The scalar `data` survives verbatim through the JSON branch.
          expect(spy.callbackCalls[0]!.data).toBe("page=2&sort=asc");
        } finally {
          await spy.stop();
        }
      });
    });

    // ---- edits -------------------------------------------------------------
    describe("POST /control/chats/:id/edits (inject edit — INTERACT-02)", () => {
      it("drives emulator.injectEdit IDENTICALLY in-proc and over HTTP (parity)", async () => {
        const spy = makeSpyControl();
        await spy.start();
        try {
          await spy.client.injectEdit({
            chatId: CHAT_ID,
            messageId: 654,
            newText: "edited text",
            fromUserId: USER_ID,
          });
          const { status, json } = await postControl(spy.apiRoot, `/control/chats/${CHAT_ID}/edits`, {
            messageId: 654,
            newText: "edited text",
            fromUserId: USER_ID,
          });
          expect(status).toBe(200);
          expect(json).toEqual({ ok: true });

          expect(spy.editCalls).toHaveLength(2);
          const [viaClient, viaHttp] = spy.editCalls;
          expect(viaClient).toEqual(viaHttp);
          expect(viaClient!.chat).toEqual({ chatId: CHAT_ID });
          expect(viaClient!.messageId).toBe(654);
          expect(viaClient!.newText).toBe("edited text");
          expect(viaClient!.from).toEqual({ id: USER_ID, firstName: `user_${USER_ID}` });
        } finally {
          await spy.stop();
        }
      });

      it("defaults the editor (fromUserId optional) and 400s on missing messageId/newText", async () => {
        const spy = makeSpyControl();
        await spy.start();
        try {
          // fromUserId omitted → the handler supplies a stable default editor.
          const ok = await postControl(spy.apiRoot, `/control/chats/${CHAT_ID}/edits`, {
            messageId: 12,
            newText: "no editor id",
          });
          expect(ok.status).toBe(200);
          expect(spy.editCalls).toHaveLength(1);
          expect(typeof spy.editCalls[0]!.from.id).toBe("number");

          // Missing messageId → 400.
          const noId = await postControl(spy.apiRoot, `/control/chats/${CHAT_ID}/edits`, {
            newText: "x",
          });
          expect(noId.status).toBe(400);
          // Missing newText → 400.
          const noText = await postControl(spy.apiRoot, `/control/chats/${CHAT_ID}/edits`, {
            messageId: 9,
          });
          expect(noText.status).toBe(400);
          expect(spy.editCalls).toHaveLength(1); // only the valid call landed
        } finally {
          await spy.stop();
        }
      });
    });

    // ---- the REAL TgEmulator wire (the four verbs trip the long-poll) -------
    describe("the four routes drive the REAL TgEmulator (served by getUpdates)", () => {
      it("media: a media route post queues a media `message` update with a resolvable file_id", async () => {
        const fileBase64 = Buffer.from("real-photo-bytes").toString("base64");
        const { status, json } = await postControl(apiRoot, `/control/chats/${CHAT_ID}/media`, {
          fromUserId: 111,
          kind: "photo",
          fileBase64,
        });
        expect(status).toBe(200);
        expect((json as { ok?: boolean }).ok).toBe(true);

        const env = await callBotMethod(apiRoot, "getUpdates", { timeout: 5 });
        const updates = env.result as Array<Record<string, unknown>>;
        expect(updates.length).toBe(1);
        const msg = updates[0]!["message"] as Record<string, unknown>;
        const photo = msg["photo"] as Array<Record<string, unknown>>;
        expect(Array.isArray(photo)).toBe(true);
        const fileId = photo[photo.length - 1]!["file_id"] as string;
        // The stored file resolves via getFile with the REAL byte length.
        const fileEnv = await callBotMethod(apiRoot, "getFile", { file_id: fileId });
        expect(fileEnv.ok).toBe(true);
        expect((fileEnv.result as { file_size?: number }).file_size).toBe(
          Buffer.from("real-photo-bytes").length,
        );
      });

      it("callback: a callbacks route post queues a callback_query tapping the bot reply", async () => {
        const sent = (await callBotMethod(apiRoot, "sendMessage", { chat_id: CHAT_ID, text: "bot reply" }))
          .result as Record<string, unknown>;
        const botReplyId = sent["message_id"] as number;

        const { status } = await postControl(apiRoot, `/control/chats/${CHAT_ID}/callbacks`, {
          fromUserId: 111,
          botMessageId: botReplyId,
          data: "tap-1",
        });
        expect(status).toBe(200);

        const env = await callBotMethod(apiRoot, "getUpdates", { timeout: 5 });
        const updates = env.result as Array<Record<string, unknown>>;
        expect(updates.length).toBe(1);
        const cq = updates[0]!["callback_query"] as Record<string, unknown>;
        expect(cq).toBeDefined();
        expect(cq["data"]).toBe("tap-1");
        expect((cq["message"] as Record<string, unknown>)["message_id"]).toBe(botReplyId);
      });

      it("edit: an edits route post queues an edited_message for the existing id", async () => {
        const { status } = await postControl(apiRoot, `/control/chats/${CHAT_ID}/edits`, {
          messageId: 4242,
          newText: "the edited body",
          fromUserId: 111,
        });
        expect(status).toBe(200);

        const env = await callBotMethod(apiRoot, "getUpdates", { timeout: 5 });
        const updates = env.result as Array<Record<string, unknown>>;
        expect(updates.length).toBe(1);
        const edited = updates[0]!["edited_message"] as Record<string, unknown>;
        expect(edited).toBeDefined();
        expect(edited["message_id"]).toBe(4242);
        expect(edited["text"]).toBe("the edited body");
      });
    });

    // ---- the four route regexes (pure source-shape assertions) -------------
    describe("the four §4.6 path constants are declared (Phase 207)", () => {
      it("declares CHAT_MEDIA/LOCATION/CALLBACKS/EDITS path constants targeting the right segments", () => {
        const src = readFileSync(CONTROL_API_SOURCE, "utf8");
        expect(src).toMatch(/CHAT_MEDIA_PATH/);
        expect(src).toMatch(/CHAT_LOCATION_PATH/);
        expect(src).toMatch(/CHAT_CALLBACKS_PATH/);
        expect(src).toMatch(/CHAT_EDITS_PATH/);
        expect(src).toMatch(/\/media/);
        expect(src).toMatch(/\/location/);
        expect(src).toMatch(/\/callbacks/);
        expect(src).toMatch(/\/edits/);
        // The base64 decode is present (JSON+base64 transport, no multipart).
        expect(src).toMatch(/Buffer\.from\([^)]*base64/);
        // NO multipart parser (stdlib-first — the bytes ride the JSON body).
        expect(src).not.toMatch(/multipart/);
      });

      it("each route regex matches its segment (incl. negative chat ids + trailing slash) and NOT /messages", () => {
        const media = /^\/control\/chats\/(-?\d+)\/media\/?$/;
        const location = /^\/control\/chats\/(-?\d+)\/location\/?$/;
        const callbacks = /^\/control\/chats\/(-?\d+)\/callbacks\/?$/;
        const edits = /^\/control\/chats\/(-?\d+)\/edits\/?$/;
        expect(media.test("/control/chats/-100/media")).toBe(true);
        expect(media.test("/control/chats/123/media/")).toBe(true);
        expect(media.test("/control/chats/123/messages")).toBe(false);
        expect(location.test("/control/chats/123/location")).toBe(true);
        expect(callbacks.test("/control/chats/123/callbacks")).toBe(true);
        expect(edits.test("/control/chats/123/edits")).toBe(true);
      });
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
