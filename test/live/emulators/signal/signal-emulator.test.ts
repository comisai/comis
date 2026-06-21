// SPDX-License-Identifier: Apache-2.0
/**
 * Stage-A unit tests for the Signal wire backend `SignalEmulator`
 * (`signal-emulator.ts`, CHAN2-01, Phase 209).
 *
 * Pure in-process HTTP/SSE/typed-verb tests — no daemon, no key, no real
 * network (the only "network" is loopback `fetch` against the emulator's own
 * `127.0.0.1:<port>`). The `SignalEmulator` is the fake signal-cli daemon the
 * REAL production Signal adapter hits over loopback HTTP; the rig (Plan 05/06)
 * boots the daemon pointed at it via `channels.signal.baseUrl`. These tests
 * assert the signal-cli wire surface the adapter consumes:
 *
 *   - GET  /api/v1/check  — the boot health-check the adapter AWAITS
 *     (`signalHealthCheck` → blocks `start()`).
 *   - POST /api/v1/rpc    — JSON-RPC 2.0: `send` (records the `{method,
 *     messageId,text}` oracle + returns `{ result:{ timestamp } }` the adapter
 *     reads as `messageId`), `sendReaction` (records the outbound reaction),
 *     `listAccounts` (the boot account list).
 *   - GET  /api/v1/events — the SSE inbound stream (Task 2 — the Signal analog
 *     of Telegram's getUpdates long-poll).
 *
 * The structural twin of `tg-emulator.test.ts`: where Telegram mints a
 * `message_id` on `sendMessage` and queues an `Update` for `getUpdates`, Signal
 * mints a `timestamp` on `send` and emits a `SignalEnvelope` on the SSE stream.
 *
 * `@comis/channels` resolves from `dist/` via the live vitest alias, so the
 * `mapSignalToNormalized` import + the `SignalEnvelope` type both read the REAL
 * built adapter (run `pnpm build` first if stale).
 *
 * Run under the LIVE vitest config (the bare root config excludes `test/live`,
 * collecting 0 files → false green):
 *   pnpm vitest run -c test/live/vitest.config.ts \
 *     test/live/emulators/signal/signal-emulator.test.ts
 *
 * @module
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mapSignalToNormalized } from "@comis/channels";
import type { SignalEnvelope } from "@comis/channels";
import { createSignalEmulator, type SignalEmulator } from "./signal-emulator.js";
import { resetSignalTimestampCounter } from "./signal-payloads.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const EMULATOR_SOURCE = resolve(HERE, "signal-emulator.ts");

// A DM chat id — the signal adapter's `parseTarget` wraps a bare recipient as
// `recipient: [chatId]` (signal-adapter.ts:75). A `group:<id>` chat id routes to
// `groupId` instead.
const CHAT = "+15555550100";
const GROUP_CHAT = "group:test-group-id";

// A loopback base URL passed to `mapSignalToNormalized` — it only uses it to
// build attachment download URLs; the text/reaction round-trips do not touch it.
const BASE_URL = "http://127.0.0.1:8080";

/** GET a path against the running emulator and return the parsed JSON body. */
async function getJson(apiRoot: string, path: string): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${apiRoot}${path}`, { method: "GET" });
  return { status: res.status, body: await res.json() };
}

/**
 * POST a JSON-RPC 2.0 request to `/api/v1/rpc` and return the parsed response.
 * Mirrors what the real `signalRpcRequest` sends (signal-client.ts:136-153): a
 * `{ jsonrpc, method, params, id }` body to `/api/v1/rpc`.
 */
async function rpc(
  apiRoot: string,
  method: string,
  params: Record<string, unknown>,
  id: number = 1,
): Promise<{ jsonrpc?: string; id?: number; result?: unknown; error?: unknown }> {
  const res = await fetch(`${apiRoot}/api/v1/rpc`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", method, params, id }),
  });
  return (await res.json()) as { jsonrpc?: string; id?: number; result?: unknown; error?: unknown };
}

describe("SignalEmulator — signal-cli wire surface on the http-backend base (CHAN2-01)", () => {
  let emu: SignalEmulator;
  let apiRoot: string;

  beforeEach(async () => {
    resetSignalTimestampCounter();
    emu = createSignalEmulator();
    const handle = await emu.start();
    apiRoot = handle.apiRoot;
  });

  afterEach(async () => {
    await emu.stop();
  });

  // -------------------------------------------------------------------------
  // FOUNDATION wiring — extends ChannelEmulator, loopback bind (SEC-01)
  // -------------------------------------------------------------------------
  describe("foundation wiring (extends ChannelEmulator, loopback bind)", () => {
    it("start() returns the loopback apiRoot the rig writes into channels.signal.baseUrl", async () => {
      // SEC-01: the base owns the bind — 127.0.0.1 ONLY, kernel-allocated port.
      expect(apiRoot).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    });

    it("publishes the signalCaps descriptor (channel signal over http, buttons:false)", () => {
      expect(emu.caps.channel).toBe("signal");
      expect(emu.caps.protocol).toBe("http");
      // The honest-degrade trigger — Signal has no inline buttons.
      expect(emu.caps.outbound.buttons).toBe(false);
      // The WS1-relevant verb Signal DOES support.
      expect(emu.caps.outbound.reactions).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // GET /api/v1/check — the boot health-check the adapter awaits
  // -------------------------------------------------------------------------
  describe("GET /api/v1/check (the boot health probe)", () => {
    it("returns 200 { ok: true } — the health-check signalHealthCheck blocks boot on", async () => {
      const { status, body } = await getJson(apiRoot, "/api/v1/check");
      expect(status).toBe(200);
      expect(body).toEqual({ ok: true });
    });

    it("also answers /api/v1/check with a query string (the adapter may append one)", async () => {
      const { status, body } = await getJson(apiRoot, "/api/v1/check?account=%2B15555550100");
      expect(status).toBe(200);
      expect(body).toEqual({ ok: true });
    });
  });

  // -------------------------------------------------------------------------
  // POST /api/v1/rpc — send (the outbound oracle the dual oracle keys on)
  // -------------------------------------------------------------------------
  describe("POST /api/v1/rpc — send (mint timestamp + RecordedOutbound oracle)", () => {
    it("returns { jsonrpc, id, result:{ timestamp } } the adapter reads as messageId", async () => {
      const res = await rpc(apiRoot, "send", { recipient: [CHAT], message: "hi" }, 7);
      expect(res.jsonrpc).toBe("2.0");
      expect(res.id).toBe(7);
      const result = res.result as { timestamp?: number };
      expect(typeof result.timestamp).toBe("number");
    });

    it("records a RecordedOutbound { method:'send', messageId:<timestamp>, text } surfaced via lastBotReply/outbound", async () => {
      const res = await rpc(apiRoot, "send", { recipient: [CHAT], message: "hello from the agent" });
      const timestamp = (res.result as { timestamp: number }).timestamp;

      // outbound(chat) — the full per-chat log the driver reads.
      const recorded = emu.outbound(CHAT);
      expect(recorded.length).toBe(1);
      const ro = recorded[0]!;
      expect(ro.method).toBe("send");
      // The Signal adapter reads `messageId = String(result.timestamp)`
      // (signal-adapter.ts:256-257); the oracle records the numeric timestamp.
      expect(ro.messageId).toBe(timestamp);
      // The text the dual oracle compares to delivery_mirror.text.
      expect(ro.text).toBe("hello from the agent");

      // lastBotReply(chat) — the structural subset the channel-trace dual oracle reads.
      const last = emu.lastBotReply(CHAT);
      expect(last?.text).toBe("hello from the agent");
    });

    it("mints strictly-increasing timestamps across sends (the Signal messageId source)", async () => {
      const a = (await rpc(apiRoot, "send", { recipient: [CHAT], message: "a" })).result as { timestamp: number };
      const b = (await rpc(apiRoot, "send", { recipient: [CHAT], message: "b" })).result as { timestamp: number };
      expect(b.timestamp > a.timestamp).toBe(true);
    });

    it("keys the oracle on a group:<id> recipient (the groupId target shape)", async () => {
      // signal-adapter.ts:72-74 — a `group:<id>` chat routes to `{ groupId }`,
      // NOT `{ recipient }`. The oracle keys on the same group:<id> chat string.
      await rpc(apiRoot, "send", { groupId: "test-group-id", message: "group hi" });
      const last = emu.lastBotReply(GROUP_CHAT);
      expect(last?.text).toBe("group hi");
      // A DM with no send recorded is an honest empty (not a silent cross-chat leak).
      expect(emu.outbound(CHAT).length).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // POST /api/v1/rpc — sendReaction / listAccounts (the rest of the table)
  // -------------------------------------------------------------------------
  describe("POST /api/v1/rpc — sendReaction + listAccounts", () => {
    it("sendReaction returns result:{} and records the outbound reaction on the oracle", async () => {
      // signal-adapter.ts:269-294 — reactToMessage sends sendReaction with
      // `{ recipient, emoji, targetTimestamp }`. The emulator records it so the
      // react FLOW is provable via the oracle (mirrors Telegram's reaction record).
      const res = await rpc(apiRoot, "sendReaction", {
        recipient: [CHAT],
        emoji: "👍",
        targetTimestamp: 1_700_000_000_500,
      });
      expect(res.jsonrpc).toBe("2.0");
      expect(res.result).toEqual({});

      const recorded = emu.outbound(CHAT);
      expect(recorded.length).toBe(1);
      const ro = recorded[0]!;
      expect(ro.method).toBe("sendReaction");
      // A reaction outbound carries no text (the dual oracle's text is absent here).
      expect(ro.text).toBeUndefined();
    });

    it("listAccounts returns result:[{ account }] (the boot account list)", async () => {
      const res = await rpc(apiRoot, "listAccounts", {});
      expect(res.jsonrpc).toBe("2.0");
      const accounts = res.result as Array<{ account: string }>;
      expect(Array.isArray(accounts)).toBe(true);
      expect(accounts[0]!.account).toBe("+15555550100");
    });

    it("an unknown rpc method returns the generic result:{} envelope (never crashes)", async () => {
      const res = await rpc(apiRoot, "sendTyping", { recipient: [CHAT] });
      expect(res.jsonrpc).toBe("2.0");
      expect(res.result).toEqual({});
    });
  });

  // -------------------------------------------------------------------------
  // resetChat — per-chat oracle isolation
  // -------------------------------------------------------------------------
  describe("resetChat (per-chat oracle isolation)", () => {
    it("clears a chat's recorded outbound so a later reuse starts clean", async () => {
      await rpc(apiRoot, "send", { recipient: [CHAT], message: "before reset" });
      expect(emu.outbound(CHAT).length).toBe(1);
      emu.resetChat(CHAT);
      expect(emu.outbound(CHAT).length).toBe(0);
      expect(emu.lastBotReply(CHAT)).toBeUndefined();
    });
  });
});

// ---------------------------------------------------------------------------
// SEC-01 / FOUNDATION — built ON the http-backend base, no bespoke server
// (source-grep — a static contract that needs no running server)
// ---------------------------------------------------------------------------
describe("SignalEmulator — built ON the http-backend base (SEC-01 source contract)", () => {
  it("imports the shared http-backend base and spins up NO bespoke node:http server", () => {
    const src = readFileSync(EMULATOR_SOURCE, "utf8");
    // Built ON the base (success-criterion #5: composes createHttpBackend, not a
    // bespoke server).
    expect(src).toMatch(/backends\/http-backend/);
    expect(src).not.toMatch(/createServer/);
  });

  it("binds loopback only — never a wildcard host (SEC-01)", () => {
    const src = readFileSync(EMULATOR_SOURCE, "utf8");
    // The base owns the 127.0.0.1 bind; the emulator never widens it.
    expect(src).not.toMatch(/0\.0\.0\.0/);
  });

  it("declares `extends ChannelEmulator` (the foundation-real contract)", () => {
    const src = readFileSync(EMULATOR_SOURCE, "utf8");
    expect(src).toMatch(/extends ChannelEmulator/);
  });
});

// ---------------------------------------------------------------------------
// Task 2 — the SSE inbound (/api/v1/events) + injectMessage/injectReaction.
//
// The Signal analog of Telegram's getUpdates long-poll: the adapter pulls
// inbound autonomously via a kept-open `GET /api/v1/events` SSE stream
// (createSignalEventStream, signal-client.ts:240). `injectMessage` emits a
// `SignalEnvelope` on that stream (queue-or-emit) — the structural twin of
// `tgEmulator.injectMessage` queuing an Update.
// ---------------------------------------------------------------------------

/** Read one SSE frame (`event:`/`data:` lines up to a blank line) from a stream reader. */
async function readSseFrame(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  decoder: TextDecoder,
  pending: { buf: string },
): Promise<{ event?: string; data?: string }> {
  while (!pending.buf.includes("\n\n")) {
    const { value, done } = await reader.read();
    if (done) break;
    pending.buf += decoder.decode(value, { stream: true });
  }
  const idx = pending.buf.indexOf("\n\n");
  const raw = idx >= 0 ? pending.buf.slice(0, idx) : pending.buf;
  pending.buf = idx >= 0 ? pending.buf.slice(idx + 2) : "";
  const frame: { event?: string; data?: string } = {};
  for (const line of raw.split("\n")) {
    if (line.startsWith("event:")) frame.event = line.slice("event:".length).trim();
    else if (line.startsWith("data:")) frame.data = line.slice("data:".length).trim();
  }
  return frame;
}

/** Open the SSE inbound stream and return a reader + the running decode buffer. */
async function openEvents(
  apiRoot: string,
  controller: AbortController,
): Promise<{ reader: ReadableStreamDefaultReader<Uint8Array>; decoder: TextDecoder; pending: { buf: string } }> {
  const res = await fetch(`${apiRoot}/api/v1/events`, {
    method: "GET",
    headers: { Accept: "text/event-stream" },
    signal: controller.signal,
  });
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toBe("text/event-stream");
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const pending = { buf: "" };
  // Drain the initial flush so the connection is fully established before an inject.
  await reader.read();
  return { reader, decoder, pending };
}

describe("SignalEmulator — SSE inbound /api/v1/events + injectMessage (CHAN2-01 Task 2)", () => {
  let emu: SignalEmulator;
  let apiRoot: string;

  beforeEach(async () => {
    resetSignalTimestampCounter();
    emu = createSignalEmulator();
    apiRoot = (await emu.start()).apiRoot;
  });

  afterEach(async () => {
    await emu.stop();
  });

  it("GET /api/v1/events stays OPEN; injectMessage emits a `receive` frame a connected client reads", async () => {
    const controller = new AbortController();
    const { reader, decoder, pending } = await openEvents(apiRoot, controller);

    // Inject AFTER a client connected → the envelope is emitted on the open stream.
    emu.injectMessage(CHAT, CHAT, "hi");
    const frame = await readSseFrame(reader, decoder, pending);
    expect(frame.event).toBe("receive");
    const envelope = JSON.parse(frame.data ?? "{}") as SignalEnvelope;
    expect(envelope.dataMessage?.message).toBe("hi");
    expect(envelope.source).toBe(CHAT);

    // The strongest fidelity proof: the emitted envelope is EXACTLY what the
    // REAL production mapper parses (the adapter's createSignalEventStream →
    // JSON.parse → mapSignalToNormalized path).
    const normalized = mapSignalToNormalized(envelope, BASE_URL);
    expect(normalized?.text).toBe("hi");
    expect(normalized?.channelType).toBe("signal");
    expect(normalized?.chatType).toBe("dm");
    expect(normalized?.channelId).toBe(CHAT);

    await reader.cancel();
    controller.abort();
  });

  it("emits a SECOND frame over the SAME open connection (the stream is not ended per inject)", async () => {
    const controller = new AbortController();
    const { reader, decoder, pending } = await openEvents(apiRoot, controller);

    emu.injectMessage(CHAT, CHAT, "first");
    const f1 = await readSseFrame(reader, decoder, pending);
    expect((JSON.parse(f1.data ?? "{}") as SignalEnvelope).dataMessage?.message).toBe("first");

    emu.injectMessage(CHAT, CHAT, "second");
    const f2 = await readSseFrame(reader, decoder, pending);
    expect((JSON.parse(f2.data ?? "{}") as SignalEnvelope).dataMessage?.message).toBe("second");

    await reader.cancel();
    controller.abort();
  });

  it("a group:<id> inject carries dataMessage.groupInfo.groupId (the group inbound path)", async () => {
    const controller = new AbortController();
    const { reader, decoder, pending } = await openEvents(apiRoot, controller);

    emu.injectMessage(GROUP_CHAT, "+15555550111", "group ping");
    const frame = await readSseFrame(reader, decoder, pending);
    const envelope = JSON.parse(frame.data ?? "{}") as SignalEnvelope;
    expect(envelope.dataMessage?.groupInfo?.groupId).toBe("test-group-id");
    // The REAL mapper derives a group chatType + the group:<id> channelId.
    const normalized = mapSignalToNormalized(envelope, BASE_URL);
    expect(normalized?.chatType).toBe("group");
    expect(normalized?.channelId).toBe(GROUP_CHAT);

    await reader.cancel();
    controller.abort();
  });

  it("QUEUE-then-drain: an inject with NO client connected is queued and drained on the next connect", async () => {
    // No SSE client connected yet — the inject must be queued, not lost.
    emu.injectMessage(CHAT, CHAT, "queued before connect");

    const controller = new AbortController();
    const { reader, decoder, pending } = await openEvents(apiRoot, controller);

    // The queued envelope drains on connect (the queue-or-emit discipline).
    const frame = await readSseFrame(reader, decoder, pending);
    expect(frame.event).toBe("receive");
    expect((JSON.parse(frame.data ?? "{}") as SignalEnvelope).dataMessage?.message).toBe(
      "queued before connect",
    );

    await reader.cancel();
    controller.abort();
  });

  it("injectReaction emits a SignalEnvelope with dataMessage.reaction { emoji, targetSentTimestamp }", async () => {
    const controller = new AbortController();
    const { reader, decoder, pending } = await openEvents(apiRoot, controller);

    const targetTs = 1_700_000_000_500;
    emu.injectReaction(CHAT, CHAT, targetTs, "👍");
    const frame = await readSseFrame(reader, decoder, pending);
    const envelope = JSON.parse(frame.data ?? "{}") as SignalEnvelope;
    expect(envelope.dataMessage?.reaction?.emoji).toBe("👍");
    expect(envelope.dataMessage?.reaction?.targetSentTimestamp).toBe(targetTs);

    // The REAL mapper classifies it as a reaction (the WS1-relevant react FLOW).
    const normalized = mapSignalToNormalized(envelope, BASE_URL);
    expect(normalized?.metadata.signalReaction).toBe(true);
    expect(normalized?.metadata.signalReactionEmoji).toBe("👍");
    expect(normalized?.metadata.signalReactionTarget).toBe(targetTs);

    await reader.cancel();
    controller.abort();
  });

  it("injectMessage returns the Signal-shaped id (the envelope timestamp) consistent with the oracle source", async () => {
    const controller = new AbortController();
    const { reader, decoder, pending } = await openEvents(apiRoot, controller);

    const id = emu.injectMessage(CHAT, CHAT, "with id");
    expect(typeof id).toBe("number");
    const frame = await readSseFrame(reader, decoder, pending);
    const envelope = JSON.parse(frame.data ?? "{}") as SignalEnvelope;
    // The returned id IS the emitted envelope's timestamp (the Signal message id).
    expect(envelope.timestamp).toBe(id);

    await reader.cancel();
    controller.abort();
  });
});

describe("SignalEmulator — stop() drains the SSE stream (CHAN2-01 / T-209-09)", () => {
  it("stop() ends an open /api/v1/events client so stop() resolves and does not hang", async () => {
    const emu = createSignalEmulator();
    const { apiRoot } = await emu.start();

    // Open an SSE connection and leave it open (no abort).
    const res = await fetch(`${apiRoot}/api/v1/events`, { method: "GET" });
    const reader = res.body!.getReader();
    await reader.read(); // initial flush — the connection is now established + open.

    // stop() MUST drain the kept-open stream — assert it resolves under a race.
    await expect(
      Promise.race([
        emu.stop(),
        new Promise((_resolve, reject) => setTimeout(() => reject(new Error("stop() hung")), 5_000)),
      ]),
    ).resolves.toBeUndefined();

    await reader.cancel().catch(() => {
      /* server already closed the stream */
    });
  });
});

// A compile-time use of the imported `SignalEnvelope` type + the mapper so the
// I4 wire-type import is exercised at the module top (the SSE tests above also
// consume both at runtime).
const _typeWitness: (e: SignalEnvelope) => ReturnType<typeof mapSignalToNormalized> = (e) =>
  mapSignalToNormalized(e, BASE_URL);
void _typeWitness;
