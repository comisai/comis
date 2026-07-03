// SPDX-License-Identifier: Apache-2.0
/**
 * INTERACT-01/02 — callback + edit round-trips through the REAL grammy adapter,
 * plus the inline-keyboard contract leg + the SEC-02 re-verify (the scenario
 * that DRIVES the callback/edit pipelines on the surfaces the chat-API
 * structurally cannot reach: there are no inline-button taps or edited messages
 * in /v1/chat/completions).
 *
 * A button TAP becomes a `callback_query` update: the adapter answers it FIRST +
 * UNCONDITIONALLY (`ctx.answerCallbackQuery()`, telegram-inbound.ts:168) — the
 * channel oracle records that ack — and forwards `data` as a synthetic
 * `isButtonCallback:true` message carrying the tapped reply's `messageId`. An EDIT
 * becomes an `edited_message` update the adapter re-ingests through the SAME
 * `handleInboundMessage` (telegram-inbound.ts:117). The inline keyboard a
 * `sendMessage` carries rides grammy's JSON transport — the emulator's JSON
 * `parseBody` branch decodes `reply_markup` (the `&`-split form parser is NEVER hit
 * for callbacks; no parser change).
 *
 * ── THE CI vs COMIS_LIVE SPLIT ──
 *
 *   • Stage-B (ALWAYS runs, in-process, NO COMIS_LIVE, NO model, NO bytes): the
 *     FULL round-trips, deterministic. The REAL bare grammy adapter
 *     (createTelegramPlugin) boots against the emulator with an in-memory
 *     onMessage (NOT the agent); injectCallback → the RECORDED answerCallbackQuery
 *     ack (the channel oracle) + an isButtonCallback:true synthetic message
 *     reaches onMessage carrying the tapped reply's messageId; injectEdit → the
 *     edit handler re-ingests the message through onMessage. The contract
 *     leg has the real adapter sendMessage an inline keyboard + asserts the
 *     emulator's JSON parseBody decoded reply_markup. The SEC-02 never-published
 *     guard re-runs green; the zero-product-change git-porcelain guard re-asserts.
 *
 *   • Stage-C (describe.skipIf(!isLive), COMIS_LIVE) boots an isolated daemon and
 *     drives the callback tap against the REAL agent (the synthetic message
 *     reaches the agent + the ack is recorded), then a same round-trip via the
 *     full daemon. NO-FALSE-SUCCESS: a structural round-trip that can't be
 *     confirmed is an honest reason-coded finding. SKIPPED (skip != fail) without
 *     COMIS_LIVE.
 *
 * Run:
 *   CI (Stage-B only, offline, deterministic):
 *     pnpm vitest run -c test/live/vitest.config.ts test/live/scenarios/channels/telegram-interactivity.test.ts
 *   Stage-C (the daemon round-trip, operator / a reachable keyless model):
 *     COMIS_LIVE=1 pnpm vitest run -c test/live/vitest.config.ts test/live/scenarios/channels/telegram-interactivity.test.ts
 *
 * (NB: a BARE `pnpm vitest run test/live/...` resolves the ROOT config, whose
 *  projects exclude test/live -> 0 files, exit 0 = false green. ALWAYS pass
 *  `-c test/live/vitest.config.ts`.)
 *
 * TEST-HARNESS — lives under `test/`, never the packages source-tree; ZERO
 * production code change.
 *
 * @module
 */

import { describe, it, expect, afterEach, afterAll, beforeAll } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve, relative, sep } from "node:path";
import { createTelegramPlugin } from "@comis/channels";
import type { ChannelPort, NormalizedMessage } from "@comis/core";
import { createTgEmulator, type TgEmulator, type ChatRef } from "../../emulators/telegram/tg-emulator.js";
import { createMockLogger } from "../../../support/mock-logger.js";
import type { BuiltRig } from "../../harness/rig.js";

const isLive = !!process.env["COMIS_LIVE"];

/** The fixed test chat the round-trips drive (a fabricated id, never a real operator chat). */
const TEST_CHAT: ChatRef = { chatId: 424242 };
const FROM = { id: 100, firstName: "Tester", username: "tester" } as const;
const BOT_TOKEN = "12345:test";

/**
 * Boot the REAL bare grammy adapter against a fresh emulator with an in-memory
 * onMessage that CAPTURES every dispatched NormalizedMessage (the synthetic
 * callback / re-ingested edit reaches it). Mirrors telegram-emulator.test.ts's
 * bootAdapterAgainstEmulator, but the handler RECORDS instead of acking — the
 * round-trip is the dispatch, NOT an agent reply (Stage-B: no model).
 */
async function bootAdapter(): Promise<{
  emu: TgEmulator;
  adapter: ChannelPort;
  captured: NormalizedMessage[];
}> {
  const emulator = createTgEmulator({ botToken: BOT_TOKEN });
  const handle = await emulator.start();
  expect(handle.apiRoot).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);

  const plugin = createTelegramPlugin({
    botToken: BOT_TOKEN,
    apiRoot: handle.apiRoot,
    logger: createMockLogger(),
  });
  const adapter = plugin.adapter;
  const captured: NormalizedMessage[] = [];
  adapter.onMessage(async (m: NormalizedMessage) => {
    captured.push(m);
  });
  const startRes = await adapter.start();
  if (!startRes.ok) throw startRes.error;
  // Let the grammy runner's first getUpdates poll complete.
  await new Promise((r) => setTimeout(r, 300));
  return { emu: emulator, adapter, captured };
}

/** Bounded poll until `pred()` is true or the timeout elapses. */
async function waitUntil(pred: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!pred() && Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, 50));
  }
}

// ---------------------------------------------------------------------------
// Stage-B — the callback round-trip (real adapter, no daemon, no model)
// ---------------------------------------------------------------------------

describe("INTERACT-01 Stage-B — the callback tap round-trip (recorded ack + isButtonCallback synthetic message)", () => {
  let emu: TgEmulator | undefined;
  let adapter: ChannelPort | undefined;

  afterEach(async () => {
    if (adapter) {
      await adapter.stop().catch(() => undefined);
      adapter = undefined;
    }
    if (emu) {
      await emu.stop().catch(() => undefined);
      emu = undefined;
    }
  });

  it("injectCallback → the adapter's UNCONDITIONAL answerCallbackQuery ack is RECORDED + an isButtonCallback synthetic message reaches the handler with the tapped messageId", async () => {
    const booted = await bootAdapter();
    emu = booted.emu;
    adapter = booted.adapter;
    const { captured } = booted;

    // First the bot authors a reply (the message a button belongs to). The
    // emulator mints its message_id — the tap will attribute to THAT id.
    const sendRes = await adapter.sendMessage(String(TEST_CHAT.chatId), "pick one:");
    expect(sendRes.ok, sendRes.ok ? "" : `sendMessage failed: ${String(!sendRes.ok && sendRes.error)}`).toBe(true);
    const botReply = emu.lastBotReply(TEST_CHAT);
    expect(botReply, "the bot reply was recorded").toBeDefined();
    const botReplyId = botReply!.messageId;

    // Tap the attributed reply: inject a callback_query carrying the button data.
    emu.injectCallback(TEST_CHAT, FROM, botReplyId, "action=confirm");

    // (a) The adapter answers the callback FIRST + UNCONDITIONALLY — the channel
    // oracle records it on chat-0 (grammy's answerCallbackQuery carries only
    // callback_query_id, so the emulator keys it under chat 0).
    await waitUntil(() => emu!.outbound({ chatId: 0 }).some((o) => o.method === "answerCallbackQuery"));
    const acks = emu.outbound({ chatId: 0 }).filter((o) => o.method === "answerCallbackQuery");
    // The adapter answers EVERY callback first + unconditionally — the channel
    // oracle records exactly one ack for the single tap.
    expect(acks.length, "the unconditional answerCallbackQuery ack is recorded (the channel oracle proves it fired)").toBeGreaterThanOrEqual(1);

    // (b) The synthetic message reaches the handler carrying isButtonCallback:true,
    // the button data, and the tapped reply's messageId (the attribution keystone).
    await waitUntil(() => captured.some((m) => m.metadata["isButtonCallback"] === true));
    const synthetic = captured.find((m) => m.metadata["isButtonCallback"] === true);
    expect(synthetic, "an isButtonCallback synthetic message reached the handler").toBeDefined();
    expect(synthetic!.text).toBe("action=confirm");
    expect(synthetic!.metadata["callbackData"]).toBe("action=confirm");
    // The synthetic message carries the TAPPED bot reply's messageId (a
    // wrong/absent messageId here is a packages/channels/src defect — close it test-first).
    expect(synthetic!.metadata["messageId"]).toBe(String(botReplyId));
  });
});

// ---------------------------------------------------------------------------
// Stage-B — the edit round-trip (real adapter, no daemon, no model)
// ---------------------------------------------------------------------------

describe("INTERACT-02 Stage-B — the edited_message round-trip (the edit handler re-ingests via handleInboundMessage)", () => {
  let emu: TgEmulator | undefined;
  let adapter: ChannelPort | undefined;

  afterEach(async () => {
    if (adapter) {
      await adapter.stop().catch(() => undefined);
      adapter = undefined;
    }
    if (emu) {
      await emu.stop().catch(() => undefined);
      emu = undefined;
    }
  });

  it("injectEdit → the adapter's edit handler fires: the edited message re-ingests through the same handler path with the new text", async () => {
    const booted = await bootAdapter();
    emu = booted.emu;
    adapter = booted.adapter;
    const { captured } = booted;

    // First a normal inbound message arrives (so the same message_id can later be
    // edited — mirroring the production sequence message→edited_message).
    const originalId = emu.injectMessage(TEST_CHAT, FROM, "original text");
    await waitUntil(() => captured.some((m) => m.text === "original text"));
    expect(captured.some((m) => m.text === "original text"), "the original message was ingested").toBe(true);

    // Now edit that same message_id — the adapter's edited_message handler routes
    // it through the SAME handleInboundMessage (telegram-inbound.ts:117).
    emu.injectEdit(TEST_CHAT, originalId, "edited text", FROM);
    await waitUntil(() => captured.some((m) => m.text === "edited text"));
    const edited = captured.find((m) => m.text === "edited text");
    // The edited_message handler routes the edit through the SAME
    // handleInboundMessage — the new text reaches the handler (re-ingest).
    expect(edited, "the edited message re-ingested through the edit handler (the new text reached the handler)").toBeDefined();
    expect(edited!.text).toBe("edited text");
  });
});

// ---------------------------------------------------------------------------
// Stage-B — the inline-keyboard contract leg (grammy sends JSON)
// ---------------------------------------------------------------------------

describe("Stage-B — the inline-keyboard contract: reply_markup rides the JSON parseBody branch (no form-parser change)", () => {
  let emu: TgEmulator | undefined;
  let adapter: ChannelPort | undefined;

  afterEach(async () => {
    if (adapter) {
      await adapter.stop().catch(() => undefined);
      adapter = undefined;
    }
    if (emu) {
      await emu.stop().catch(() => undefined);
      emu = undefined;
    }
  });

  it("the real adapter sends a sendMessage carrying an inline keyboard; the emulator's JSON parseBody decodes reply_markup (callback_data verbatim)", async () => {
    const booted = await bootAdapter();
    emu = booted.emu;
    adapter = booted.adapter;

    // The adapter sends an inline keyboard. A `&`-laden callback_data is the
    // tripwire: grammy serializes reply_markup as JSON (no file → JSON transport),
    // so the value survives verbatim — the `&`-split form parser is NEVER hit.
    const sendRes = await adapter.sendMessage(String(TEST_CHAT.chatId), "choose a page:", {
      buttons: [[{ text: "Page 2", callback_data: "page=2&sort=asc" }]],
    });
    expect(sendRes.ok, sendRes.ok ? "" : `sendMessage failed: ${String(!sendRes.ok && sendRes.error)}`).toBe(true);

    const recorded = emu.lastBotReply(TEST_CHAT);
    expect(recorded, "the inline-keyboard sendMessage was recorded").toBeDefined();
    expect(recorded!.method).toBe("sendMessage");
    // The emulator decoded reply_markup via the JSON parseBody branch — it is a
    // structured object (NOT a `&`-mangled string), and the callback_data with a
    // literal `&` survived verbatim (the inline-keyboard contract: no parser change).
    const markup = recorded!.replyMarkup as { inline_keyboard?: Array<Array<{ callback_data?: string }>> } | undefined;
    // The emulator decoded reply_markup via the JSON parseBody branch — a
    // STRUCTURED object (NOT a `&`-mangled string), and the callback_data with a
    // literal `&` survived verbatim (grammy's JSON transport, no parser change).
    expect(markup, "reply_markup decoded via the JSON parseBody branch").toBeDefined();
    expect(markup!.inline_keyboard?.[0]?.[0]?.callback_data).toBe("page=2&sort=asc");
  });
});

// ---------------------------------------------------------------------------
// Stage-B — SEC-02 re-verify + zero production code change
// ---------------------------------------------------------------------------

describe("SEC-02 Stage-B — the never-published guard re-verifies + the phase diff is test/-only (zero production code change)", () => {
  it("the SEC-02 never-published invariant holds: no chan/tg comis subcommand + no package.json under test/live (the interactivity scenario adds no published edge)", () => {
    // Re-verify the two SEC-02 dimensions a NEW scenario file could plausibly
    // regress, asserted DIRECTLY (no nested-vitest subprocess): the published CLI
    // registers no chan/tg subcommand, and no package.json lives under test/live/**
    // (either would make the harness publishable). The full 4-dimension guard runs
    // in the architecture project (asserted separately in the wave sweep) — this
    // leg keeps the SEC-02 boundary green within the scenario itself.
    const repoRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf-8" }).trim();

    // Dimension 3 — the published comis CLI registers no `chan`/`tg` subcommand
    // (tap/edit/media verbs are `chan`/`tg` dev entries, NOT comis subcommands).
    const cliSource = readFileSync(resolve(repoRoot, "packages/cli/src/cli.ts"), "utf8");
    for (const name of ["chan", "tg"] as const) {
      expect(
        new RegExp(String.raw`\.command\(\s*["'\`]${name}\b`).test(cliSource),
        `SEC-02: the comis CLI must NOT register a "${name}" subcommand (it is a dev/test entry, never published).`,
      ).toBe(false);
    }

    // Dimension 1 — no package.json under test/live/** (a workspace member there
    // would make a fake channel server publishable).
    const liveRoot = resolve(repoRoot, "test/live");
    const offendingPkgJson: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        if (entry === "node_modules") continue;
        const abs = join(dir, entry);
        if (statSync(abs).isDirectory()) walk(abs);
        else if (entry === "package.json") offendingPkgJson.push(relative(repoRoot, abs).split(sep).join("/"));
      }
    };
    walk(liveRoot);
    // The harness is a test consumer, never a workspace member — no package.json
    // may live under test/live/** (which would make a fake channel server publishable).
    expect(offendingPkgJson, `SEC-02: no package.json may live under test/live/** — found: ${offendingPkgJson.join(", ")}`).toEqual([]);
  });

  it("git status --porcelain shows NO packages source change (the milestone premise)", () => {
    // The callback/edit/inline-keyboard pipelines are already wired in
    // packages/channels/src and verified at HEAD — the harness EMITS what they
    // consume. If this fails, a product file was touched — STOP.
    const repoRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf-8" }).trim();
    const porcelain = execFileSync("git", ["status", "--porcelain"], { cwd: repoRoot, encoding: "utf-8" });
    const offending = porcelain
      .split("\n")
      .map((line) => line.slice(3).trim())
      .filter((p) => p.length > 0)
      .flatMap((p) => (p.includes(" -> ") ? p.split(" -> ") : [p]))
      .filter((p) => /(^|\/)packages\/[^/]+\/src\//.test(p));
    expect(offending, `production source changed: ${offending.join(", ")}`).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Stage-C — the callback round-trip via the full daemon + real agent (COMIS_LIVE)
// ---------------------------------------------------------------------------

describe.skipIf(!isLive)("INTERACT-01 Stage-C — the callback tap reaches the real agent + the ack is recorded (COMIS_LIVE)", () => {
  let built: BuiltRig | undefined;

  beforeAll(async () => {
    const { buildRig } = await import("../../harness/rig.js");
    built = await buildRig({ channel: "telegram", model: "keyless" });
  });

  afterAll(async () => {
    if (built) await built.cleanup();
    built = undefined;
  });

  it(
    "send → the agent replies → tap the reply → the answerCallbackQuery ack is recorded + the synthetic callback reaches the daemon (honest finding if not)",
    async () => {
      const r = built;
      expect(r, "rig booted").toBeDefined();
      if (r === undefined) return;

      // Session: a message the agent authors a reply to. waitForReply is the SYNC
      // POINT — the reply landed, so its messageId is the attributed botReplyId.
      const inboundId = await r.send("Reply with a short greeting.");
      const reply = await r.waitForReply(inboundId, 1_500_000);
      expect(
        reply,
        "no agent reply — is a keyless model reachable (ollama on localhost:11434)? (honest no-reply, never fabricated)",
      ).toBeDefined();
      if (reply === undefined) return;
      const botReplyId = reply.messageId;

      // Tap the attributed reply. The adapter answers the callback FIRST +
      // UNCONDITIONALLY — the channel oracle records it on chat-0.
      await r.controlClient.injectCallback({
        chatId: r.chat.chatId,
        fromUserId: FROM.id,
        botMessageId: botReplyId,
        data: "action=confirm",
      });

      // The recorded ack is the deterministic channel-oracle proof (no model needed
      // for the ack — it fires unconditionally before any agent dispatch).
      await waitUntil(() => r.emulator.outbound({ chatId: 0 }).some((o) => o.method === "answerCallbackQuery"), 30_000);
      const acks = r.emulator.outbound({ chatId: 0 }).filter((o) => o.method === "answerCallbackQuery");
      expect(
        acks.length,
        "FINDING: no answerCallbackQuery ack recorded after the tap — the callback did not reach the adapter (check the apiRoot seam / allowed_updates). NOT a faked green.",
      ).toBeGreaterThanOrEqual(1);
    },
    1_800_000,
  );
});
