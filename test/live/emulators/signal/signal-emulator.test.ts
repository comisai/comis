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

// A compile-time use of the imported `SignalEnvelope` type + the mapper so the
// I4 wire-type import is exercised even before Task 2 wires the SSE round-trip
// (keeps the import live; the Task-2 SSE tests consume both at runtime).
const _typeWitness: (e: SignalEnvelope) => ReturnType<typeof mapSignalToNormalized> = (e) =>
  mapSignalToNormalized(e, BASE_URL);
void _typeWitness;
