// SPDX-License-Identifier: Apache-2.0
/**
 * COVER-01/02 — the Tier-3 group-admin platformAction round-trips + slash-command
 * session control + the forum-service NEGATIVE test (Phase 208, Plan 03 — the
 * surfaces the chat API structurally cannot reach: there are no group-admin
 * actions, no /command bot_command entities, and no forum service messages in
 * /v1/chat/completions).
 *
 * The Tier-3 platformAction switch (pin/poll/sticker/getChat/get_admins/
 * sendTyping/ban/promote/forum-topic CRUD), the TELEGRAM_BOT_COMMANDS slash list,
 * and the forum-service filter are ALL already wired in packages/*\/src; this
 * scenario DRIVES + ASSERTS them through the REAL bare grammy adapter against
 * emulator-built wire shapes — it never re-implements them.
 *
 * ── COVER honest-coverage contract (HARD constraint 3) ──
 *   A Tier-3 method the emulator has NOT implemented on demand LOGS an honest
 *   `[tg-emulator] unimplemented Bot-API method: <name>` line + is surfaced via
 *   emu.unimplementedCalls() — NEVER a silent no-op that would FALSELY report
 *   coverage (the no-false-success principle, T-208-10). The COVER-01 leg drives
 *   an unimplemented Tier-3 action and asserts the honest log fired.
 *
 * ── THE CI vs COMIS_LIVE SPLIT (the 204/205/206 pattern — copied VERBATIM) ──
 *
 *   • Stage-B (ALWAYS runs, in-process, NO COMIS_LIVE, NO model): the WIRING
 *     proofs, deterministic. The REAL bare grammy adapter (createTelegramPlugin)
 *     boots against the emulator with an in-memory onMessage that CAPTURES every
 *     dispatched NormalizedMessage.
 *       - COVER-01: adapter.platformAction("get_admins") against a seeded group ->
 *         the seeded admins round-trip; "pin"/"sendTyping" record; an
 *         unimplemented Tier-3 action ("ban") fires the honest log.
 *       - COVER-02 slash: a /reset bot_command entity -> the command is RECOGNIZED
 *         (metadata.isBotCommand / isBotMentioned), not echoed as plain chat text.
 *       - COVER-02 forum-service NEGATIVE: injectServiceMessage(chat,
 *         "forum_topic_created") -> the captured onMessage array does NOT contain
 *         the service message (the adapter filtered it at telegram-inbound.ts:50).
 *       - the git-porcelain zero-product-change guard + the SEC-02 re-verify.
 *
 *   • Stage-C (describe.skipIf(!isLive), COMIS_LIVE): buildRig(keyless) -> a /reset
 *     slash drives real session control through the full daemon (the command is
 *     handled, NOT replied to as chat). NO-FALSE-SUCCESS (I5): a non-closing leg
 *     emits a reason-coded finding, NEVER a faked green. SKIPPED (skip != fail)
 *     without COMIS_LIVE + a reachable model.
 *
 * Run:
 *   CI (Stage-B only, offline, deterministic):
 *     pnpm vitest run -c test/live/vitest.config.ts test/live/scenarios/channels/telegram-coverage.test.ts
 *   Stage-C (the slash session-control leg, operator / a reachable keyless model):
 *     COMIS_LIVE=1 pnpm vitest run -c test/live/vitest.config.ts test/live/scenarios/channels/telegram-coverage.test.ts
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

/** The fixed DM test chat (a fabricated id, never a real operator chat). */
const DM_CHAT: ChatRef = { chatId: 424242 };
const FROM = { id: 100, firstName: "Tester", username: "tester" } as const;
const BOT_TOKEN = "12345:test";
const BOT_USERNAME = "test_bot";
const BOT_ID = 12345;
// The seeded group admins (the createGroupChat admins[] seed COVER-01 reports).
const OWNER = { id: 111, firstName: "owner", username: "owner" } as const;
const MOD = { id: 222, firstName: "mod", username: "mod" } as const;

/**
 * Boot the REAL bare grammy adapter against a fresh emulator with an in-memory
 * onMessage that CAPTURES every dispatched NormalizedMessage. The adapter
 * populates its botIdentity from the emulator's getMe (id 12345 / @test_bot)
 * after start(), so the addressing detector flips isBotCommand/isBotMentioned.
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
// Stage-B COVER-01 — the Tier-3 group-admin platformAction round-trips
// (the REAL adapter platformAction path against a seeded group, no model)
// ---------------------------------------------------------------------------

describe("COVER-01 Stage-B — Tier-3 platformAction round-trips against a seeded group (the real adapter platformAction path)", () => {
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

  /** Seed a supergroup with an admin set and return its negative chat id. */
  function seedGroup(em: TgEmulator): number {
    const ref = em.createGroupChat({
      members: [OWNER, MOD],
      admins: [OWNER, MOD],
      bot: { id: BOT_ID, firstName: "TestBot", username: BOT_USERNAME },
      supergroup: true,
    });
    return ref.chatId;
  }

  it("platformAction('get_admins') returns the seeded admins (the createGroupChat admins[] seed round-trips through getChatAdministrators)", async () => {
    const booted = await bootAdapter();
    emu = booted.emu;
    adapter = booted.adapter;
    const chatId = seedGroup(emu);

    const result = await adapter.platformAction("get_admins", { chat_id: String(chatId) });
    expect(result.ok, result.ok ? "" : `get_admins failed: ${String(!result.ok && result.error)}`).toBe(true);
    if (!result.ok) return;
    const value = result.value as { admins: Array<{ userId: number; firstName: string; isBot: boolean; status: string }> };
    // The adapter maps getChatAdministrators -> { admins: [{userId, firstName, isBot, status}] }.
    const ids = value.admins.map((a) => a.userId).sort((a, b) => a - b);
    // RED-first: the deliberately-WRONG assertion (an empty set) — flips to the
    // seeded [111, 222] at GREEN.
    expect(ids).toEqual([]);
  });

  it("platformAction('pin') records the pin (a Tier-3 mutation round-trip)", async () => {
    const booted = await bootAdapter();
    emu = booted.emu;
    adapter = booted.adapter;
    const chatId = seedGroup(emu);

    const result = await adapter.platformAction("pin", { chat_id: String(chatId), message_id: "55" });
    expect(result.ok, result.ok ? "" : `pin failed: ${String(!result.ok && result.error)}`).toBe(true);
    if (result.ok) expect(result.value).toEqual({ pinned: true });
    // The pin is recorded on the emulator's chat oracle (provable round-trip).
    const recorded = emu.outbound({ chatId }).filter((o) => o.method === "pinChatMessage");
    expect(recorded.length).toBe(1);
    expect(recorded[0]!.messageId).toBe(55);
  });

  it("platformAction('sendTyping', threadId:1) carries message_thread_id=1 to sendChatAction (the General-Topic typing asymmetry, the side sendMessage omits)", async () => {
    const booted = await bootAdapter();
    emu = booted.emu;
    adapter = booted.adapter;
    const chatId = seedGroup(emu);

    const result = await adapter.platformAction("sendTyping", { chatId: String(chatId), threadId: "1" });
    expect(result.ok, result.ok ? "" : `sendTyping failed: ${String(!result.ok && result.error)}`).toBe(true);
    const recorded = emu.outbound({ chatId }).filter((o) => o.method === "sendChatAction");
    expect(recorded.length).toBe(1);
    // TYPING INCLUDES message_thread_id=1 (the asymmetric counterpart to SEND
    // OMITS id=1; buildTypingThreadParams(1) === { message_thread_id: 1 }).
    expect(recorded[0]!.messageThreadId).toBe(1);
  });

  it("an UNIMPLEMENTED Tier-3 action fires the honest unimplemented-log — NOT a silent pass (the COVER honest-coverage contract, T-208-10)", async () => {
    const booted = await bootAdapter();
    emu = booted.emu;
    adapter = booted.adapter;
    const chatId = seedGroup(emu);

    // platformAction("ban") -> grammy calls banChatMember, a Tier-3 method NOT
    // implemented on demand. The emulator MUST log it honestly + surface it via
    // unimplementedCalls() — a silent okEnvelope would FALSELY report coverage.
    const before = emu.unimplementedCalls().length;
    const result = await adapter.platformAction("ban", { chat_id: String(chatId), user_id: String(MOD.id) });
    // The adapter still resolves ok (the wire didn't fail) — the honest signal is
    // the LOG + the ledger entry, not a transport failure.
    expect(result.ok).toBe(true);
    const calls = emu.unimplementedCalls();
    // RED-first: the deliberately-WRONG assertion (no honest log recorded) — flips
    // to `banChatMember` surfaced at GREEN.
    expect(calls.length).toBe(before);
    expect(calls).not.toContain("banChatMember");
  });
});

// ---------------------------------------------------------------------------
// Stage-B COVER-02 — slash-commands drive session control (a bot_command entity)
// ---------------------------------------------------------------------------

describe("COVER-02 Stage-B — slash-commands are recognized as session-control commands (a bot_command entity, not chat text)", () => {
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

  it("a /reset@bot in a group flips metadata.isBotCommand (TELEGRAM_BOT_COMMANDS session control — recognized, not echoed as chat text)", async () => {
    const booted = await bootAdapter();
    emu = booted.emu;
    adapter = booted.adapter;
    const { captured } = booted;

    const group = emu.createGroupChat({
      members: [OWNER],
      bot: { id: BOT_ID, firstName: "TestBot", username: BOT_USERNAME },
      supergroup: true,
    });
    // /reset is a TELEGRAM_BOT_COMMANDS session-control command; the bot_command
    // entity is what the adapter recognizes (it does NOT treat it as plain text).
    emu.injectMessage(group, OWNER, `/reset@${BOT_USERNAME}`, { command: true });

    await waitUntil(() => captured.some((m) => m.text === `/reset@${BOT_USERNAME}`));
    const cmd = captured.find((m) => m.text === `/reset@${BOT_USERNAME}`);
    expect(cmd, "the /reset command was dispatched").toBeDefined();
    // RED-first: the deliberately-WRONG assertion (the command NOT recognized) —
    // flips to isBotCommand:true at GREEN.
    expect(cmd!.metadata["isBotCommand"]).toBe(false);
  });

  it("a bare /new in a DM flips metadata.isBotCommand (a DM slash command — no @bot suffix needed)", async () => {
    const booted = await bootAdapter();
    emu = booted.emu;
    adapter = booted.adapter;
    const { captured } = booted;

    // A bare /new (no @bot) in a DM — Telegram delivers it; the bot_command
    // entity flips isBotCommand (message-mapper.ts:83-86). /new is in
    // TELEGRAM_BOT_COMMANDS (session control).
    emu.injectMessage(DM_CHAT, FROM, "/new", { command: true });

    await waitUntil(() => captured.some((m) => m.text === "/new"));
    const cmd = captured.find((m) => m.text === "/new");
    expect(cmd, "the /new DM command was dispatched").toBeDefined();
    expect(cmd!.metadata["isBotCommand"]).toBe(true);
    // A bot_command for this bot is surfaced as a mention too (message-mapper.ts:99-101).
    expect(cmd!.metadata["isBotMentioned"]).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Stage-B COVER-02 — the forum-service NEGATIVE (the adapter filters it)
// ---------------------------------------------------------------------------

describe("COVER-02 Stage-B — a forum service message is NOT dispatched to the agent (the negative test, telegram-inbound.ts:50)", () => {
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

  it("injectServiceMessage('forum_topic_created') is FILTERED — the captured onMessage array does NOT contain the service message", async () => {
    const booted = await bootAdapter();
    emu = booted.emu;
    adapter = booted.adapter;
    const { captured } = booted;

    const forum = emu.createGroupChat({
      members: [OWNER],
      bot: { id: BOT_ID, firstName: "TestBot", username: BOT_USERNAME },
      supergroup: true,
      forum: true,
    });

    // First a REAL message so the poll loop is provably alive (the positive
    // control). It MUST reach onMessage.
    emu.injectMessage(forum, OWNER, "a real message", { mention: true });
    await waitUntil(() => captured.some((m) => m.text === "a real message"));
    expect(captured.some((m) => m.text === "a real message"), "the real message reached the handler (the poll loop is alive)").toBe(true);

    // Now inject a forum service message — the adapter's message handler FILTERS
    // it at telegram-inbound.ts:50 (a DEBUG "Skipped forum topic service message",
    // then return), so it must NEVER reach the captured onMessage array.
    const beforeCount = captured.length;
    emu.injectServiceMessage(forum, "forum_topic_created");
    // Give the poll loop ample time to deliver + the handler to (not) dispatch.
    await new Promise((r) => setTimeout(r, 800));

    // The captured array carries NO forum-service message. A forum-service message
    // has no text and would surface its service field; assert none arrived.
    const serviceArrived = captured.some(
      (m) =>
        m.metadata["forum_topic_created"] !== undefined ||
        (m.text === undefined && (m.metadata["telegramChatType"] === "supergroup")),
    );
    // RED-first: the deliberately-WRONG assertion (the service message DID arrive)
    // — flips to `false` (filtered, NOT dispatched) at GREEN.
    expect(serviceArrived).toBe(true);
    // The capture count did NOT grow by a dispatched service message (only the
    // real message was ever dispatched). At GREEN this proves the filter held.
    expect(captured.length).toBe(beforeCount + 1);
  });
});

// ---------------------------------------------------------------------------
// Stage-B — SEC-02 re-verify + zero production code change
// ---------------------------------------------------------------------------

describe("SEC-02 Stage-B — the never-published guard re-verifies + the phase diff is test/-only (zero production code change)", () => {
  it("the SEC-02 never-published invariant holds: no chan/tg comis subcommand + no package.json under test/live", () => {
    const repoRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf-8" }).trim();

    // Dimension 3 — the published comis CLI registers no `chan`/`tg` subcommand.
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
    expect(offendingPkgJson, `SEC-02: no package.json may live under test/live/** — found: ${offendingPkgJson.join(", ")}`).toEqual([]);
  });

  it("git status --porcelain shows NO packages source change (the milestone premise)", () => {
    // The Tier-3 platformAction switch + the slash list + the forum-service filter
    // are already wired in packages/channels/src and verified at HEAD — the harness
    // DRIVES what they consume. If this fails, a product file was touched (a
    // Defect-Watch may have fired — see the SUMMARY) — STOP.
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
// Stage-C — slash session control via the full daemon + real agent (COMIS_LIVE)
// ---------------------------------------------------------------------------

describe.skipIf(!isLive)("COVER-02 Stage-C — a /reset slash drives real session control through the daemon (COMIS_LIVE)", () => {
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
    "send a normal turn, then /reset -> the session-control command is handled (a reply or a session reset), OR an honest reason-coded finding (no-false-success I5)",
    async () => {
      const r = built;
      expect(r, "rig booted").toBeDefined();
      if (r === undefined) return;

      // A normal turn first (so a session exists to reset). waitForReply is the
      // SYNC POINT — the agent replied, proving the pipeline is live.
      const inboundId = await r.send("Reply with a short greeting.");
      const reply = await r.waitForReply(inboundId, 1_500_000);
      expect(
        reply,
        "no agent reply — is a keyless model reachable (ollama on localhost:11434)? (honest no-reply, never fabricated)",
      ).toBeDefined();
      if (reply === undefined) return;

      // Now /reset — a TELEGRAM_BOT_COMMANDS session-control command. It is
      // recognized + handled by the command pipeline (NOT dispatched as a plain
      // chat prompt). The deterministic proof is that the command produced a
      // session-control response (a reply lands acknowledging the reset).
      const resetId = await r.send("/reset");
      const resetReply = await r.waitForReply(resetId, 600_000);
      expect(
        resetReply,
        "FINDING: no response to /reset — the slash command was not handled by the session-control pipeline (check command routing). NOT a faked green (I5).",
      ).toBeDefined();
    },
    1_800_000,
  );
});
