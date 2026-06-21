// SPDX-License-Identifier: Apache-2.0
/**
 * FAULT-01/02 — the FOUR hard-won adapter fallbacks fired for REAL under fault
 * injection + `classifyTelegramError` classification (Phase 208, Plan 02 — the
 * highest-risk surfaces 208 touches for the first time; NONE of these fallbacks
 * is reachable from the chat API).
 *
 * The emulator's `fail(method, error, {once, matchChat})` seam makes a Bot-API
 * method return the Telegram error envelope `{ ok:false, error_code, description,
 * parameters? }` on demand, so the REAL grammy adapter hits the error and runs
 * its fallback. The adapter's fallback is the thing under test:
 *   (a) sendMessage 400 "can't parse entities"   → RETRY WITHOUT parse_mode
 *       (plain text still lands; telegram-outbound.ts doSend).
 *   (b) sendMessage 400 "message thread not found" → sendWithThreadFallback RETRY
 *       WITHOUT message_thread_id + a warn (telegram-webhook.ts).
 *   (c) sendVoice  400 VOICE_MESSAGES_FORBIDDEN   → FALLBACK to sendDocument with
 *       caption EXACTLY "Voice message (sent as file)" (voice-sender.ts).
 *   (d) setMessageReaction 400 REACTION_INVALID   → the TELEGRAM_SAFE_EMOJI
 *       fallback chain (emoji-fallback.ts reactWithFallback).
 * `once:true` lets the SECOND call (the adapter's retry) succeed, so a fallback's
 * recorded retry outbound is assertable on the emulator oracle.
 *
 * FAULT-02 drives `classifyTelegramError` DIRECTLY (the strongest Stage-B): 429
 * {parameters:{retry_after}} → rate_limited; 400 not-editable → not_supported
 * {edit}; 403 forbidden → permission. ⚠ THE NUANCE: the classifier's OWN default
 * (unmatched) is {kind:"internal"}, NOT ok:true — the "default → ok"
 * success-criterion refers to the NO-FAULT Bot-API method returning {ok:true},
 * which is a SEPARATE assertion. Both are asserted, distinctly. The 429
 * eventual-success leg proves @grammyjs/auto-retry (3 attempts / 10s) eventually
 * succeeds after a bounded backoff.
 *
 * ── THE CI vs COMIS_LIVE SPLIT (the 204/205/206 pattern — copied VERBATIM) ──
 *
 *   • Stage-B (ALWAYS runs, in-process, NO COMIS_LIVE, NO model): the FOUR
 *     fallbacks via the REAL bare grammy adapter (createTelegramPlugin) booted
 *     against the emulator (the OUTBOUND send path fires the fallbacks), plus the
 *     four classification classes driven directly. Deterministic.
 *
 *   • Stage-C (describe.skipIf(!isLive), COMIS_LIVE) drives a fallback against the
 *     full daemon + real agent (the parse_mode retry on a real reply). NO-FALSE-
 *     SUCCESS (I5): a fallback that can't be confirmed is an honest reason-coded
 *     finding, never a faked green. SKIPPED (skip != fail) without COMIS_LIVE.
 *
 * Run:
 *   CI (Stage-B only, offline, deterministic):
 *     pnpm vitest run -c test/live/vitest.config.ts test/live/scenarios/channels/telegram-fault-injection.test.ts
 *   Stage-C (the daemon round-trip, operator / a reachable keyless model):
 *     COMIS_LIVE=1 pnpm vitest run -c test/live/vitest.config.ts test/live/scenarios/channels/telegram-fault-injection.test.ts
 *
 * (NB: a BARE `pnpm vitest run test/live/...` resolves the ROOT config, whose
 *  projects exclude test/live -> 0 files, exit 0 = false green. ALWAYS pass
 *  `-c test/live/vitest.config.ts`.)
 *
 * DEFECT-WATCH (binding here): these four fallbacks + the classifier are the
 * highest-risk surfaces. If a fallback does NOT fire as its seam claims (the 206
 * class), that is a real product bug — STOP, close it TEST-FIRST in the packages
 * source-tree, full `pnpm validate`. A clean Defect-Watch (all four fire
 * correctly) is also a first-class result (the 207-06 precedent). RESULT: CLEAN —
 * all four fallbacks fired correctly under fail(); ZERO product behavior change
 * (the one product touch is the classifyTelegramError barrel widening, a
 * VISIBILITY-only Defect-Watch surface-gap closure landed test-first).
 *
 * TEST-HARNESS — lives under `test/`, never the packages source-tree; ZERO
 * production code change.
 *
 * @module
 */

import { describe, it, expect, afterEach, afterAll, beforeAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, relative, sep } from "node:path";
import { createTelegramPlugin, reactWithFallback, TELEGRAM_SAFE_EMOJI, classifyTelegramError } from "@comis/channels";
import type { ChannelPort, NormalizedMessage } from "@comis/core";
import { createTgEmulator, type TgEmulator, type ChatRef } from "../../emulators/telegram/tg-emulator.js";
import { createMockLogger } from "../../../support/mock-logger.js";
import type { BuiltRig } from "../../harness/rig.js";

const isLive = !!process.env["COMIS_LIVE"];

/** The fixed test chat the fallbacks drive (a fabricated id, never a real operator chat). */
const TEST_CHAT: ChatRef = { chatId: 424242 };
const BOT_TOKEN = "12345:test";

/**
 * Boot the REAL bare grammy adapter against a fresh emulator. The OUTBOUND send
 * path (sendMessage / sendAttachment / reactWithFallback) is what fires the four
 * fallbacks; the in-memory onMessage just keeps the adapter happy (Stage-B: no
 * model, no agent). Mirrors telegram-interactivity.test.ts's bootAdapter.
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

// ---------------------------------------------------------------------------
// FAULT-01 — the four fallbacks (real bare adapter, no daemon, no model)
// ---------------------------------------------------------------------------

describe("FAULT-01 Stage-B — the four adapter fallbacks fire for real under fail()", () => {
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

  it("(a) parse_mode retry: a 400 \"can't parse entities\" → the adapter RETRIES WITHOUT parse_mode (plain text still lands)", async () => {
    const booted = await bootAdapter();
    emu = booted.emu;
    adapter = booted.adapter;

    // The FIRST sendMessage (with parse_mode:"HTML") hits the injected parse
    // error; isTelegramHtmlParseError → the adapter retries WITHOUT parse_mode.
    // once:true consumes the fault so the retry lands as plain text.
    emu.fail("sendMessage", { error_code: 400, description: "can't parse entities" }, { once: true });

    const res = await adapter.sendMessage(String(TEST_CHAT.chatId), "hello <b>world</b>");
    expect(res.ok, res.ok ? "" : `sendMessage failed: ${String(!res.ok && res.error)}`).toBe(true);

    // Exactly ONE recorded sendMessage (the faulted first call returned the error
    // envelope BEFORE the handler ran, so it recorded nothing; the retry recorded).
    const sends = emu.outbound(TEST_CHAT).filter((o) => o.method === "sendMessage");
    expect(sends.length).toBe(1);
    // The retry landed as PLAIN text — NO parse_mode (the (a) fallback).
    expect(sends[0]!.parseMode).toBeUndefined();
    // The text still reached the user (the resilience boundary: the message lands).
    expect(sends[0]!.text).toBe("hello <b>world</b>");
  });

  it("(b) thread-not-found retry: a 400 \"message thread not found\" → the adapter RETRIES WITHOUT message_thread_id", async () => {
    const booted = await bootAdapter();
    emu = booted.emu;
    adapter = booted.adapter;

    // A send INTO a forum topic (threadId 5, a custom topic so buildSendThreadParams
    // includes it). The first attempt (with message_thread_id:5) hits the
    // thread-not-found error; sendWithThreadFallback retries WITHOUT the thread id.
    emu.fail("sendMessage", { error_code: 400, description: "message thread not found" }, { once: true });

    const res = await adapter.sendMessage(String(TEST_CHAT.chatId), "into a topic", { threadId: "5" });
    expect(res.ok, res.ok ? "" : `sendMessage failed: ${String(!res.ok && res.error)}`).toBe(true);

    const sends = emu.outbound(TEST_CHAT).filter((o) => o.method === "sendMessage");
    expect(sends.length).toBe(1);
    // The retry dropped the thread id (the (b) fallback: deliver without the topic).
    expect(sends[0]!.messageThreadId).toBeUndefined();
    expect(sends[0]!.text).toBe("into a topic");
  });

  it("(b') a TOPIC_CLOSED variant also triggers the thread-not-found fallback (the variant set)", async () => {
    const booted = await bootAdapter();
    emu = booted.emu;
    adapter = booted.adapter;

    emu.fail("sendMessage", { error_code: 400, description: "Bad Request: TOPIC_CLOSED" }, { once: true });
    const res = await adapter.sendMessage(String(TEST_CHAT.chatId), "topic closed text", { threadId: "7" });
    expect(res.ok, res.ok ? "" : `sendMessage failed: ${String(!res.ok && res.error)}`).toBe(true);
    const sends = emu.outbound(TEST_CHAT).filter((o) => o.method === "sendMessage");
    expect(sends.length).toBe(1);
    expect(sends[0]!.messageThreadId).toBeUndefined();
  });

  it("(c) voice→document: a 400 VOICE_MESSAGES_FORBIDDEN → the adapter FALLS BACK to sendDocument with caption \"Voice message (sent as file)\"", async () => {
    const booted = await bootAdapter();
    emu = booted.emu;
    adapter = booted.adapter;

    // A real local file for the InputFile (the voice sender reads a path).
    const dir = mkdtempSync(join(tmpdir(), "tg-fault-voice-"));
    const voicePath = join(dir, "note.ogg");
    writeFileSync(voicePath, Buffer.from("OggS-fake-voice-bytes"));

    // sendVoice hits VOICE_MESSAGES_FORBIDDEN → the fallback sends a document.
    // once:true consumes the fault so the sendDocument fallback succeeds.
    emu.fail("sendVoice", { error_code: 400, description: "Bad Request: VOICE_MESSAGES_FORBIDDEN" }, { once: true });

    if (adapter.sendAttachment === undefined) throw new Error("adapter lacks sendAttachment");
    const res = await adapter.sendAttachment(String(TEST_CHAT.chatId), {
      type: "audio",
      url: voicePath,
      isVoiceNote: true,
      durationSecs: 2,
    });
    expect(res.ok, res.ok ? "" : `sendAttachment failed: ${String(!res.ok && res.error)}`).toBe(true);

    // The fallback recorded a sendDocument with the EXACT caption (voice-sender.ts).
    const docs = emu.outbound(TEST_CHAT).filter((o) => o.method === "sendDocument");
    expect(docs.length).toBe(1);
    expect(docs[0]!.caption).toBe("Voice message (sent as file)");
  });

  it("(d) reaction safe-emoji chain: a 400 REACTION_INVALID → a TELEGRAM_SAFE_EMOJI lands instead of erroring", async () => {
    const booted = await bootAdapter();
    emu = booted.emu;
    adapter = booted.adapter;

    // First the bot authors a reply (the message to react ON). The emulator mints
    // its message_id.
    const sendRes = await adapter.sendMessage(String(TEST_CHAT.chatId), "react to me");
    expect(sendRes.ok).toBe(true);
    const botReply = emu.lastBotReply(TEST_CHAT);
    expect(botReply, "the bot reply was recorded").toBeDefined();
    const botReplyId = botReply!.messageId;

    // The FIRST setMessageReaction (the primary 🤔, NOT in the safe chain) hits
    // REACTION_INVALID; reactWithFallback then tries TELEGRAM_SAFE_EMOJI in order
    // — the first safe emoji (👍) lands. once:true consumes the fault so the
    // first safe-emoji retry succeeds.
    emu.fail("setMessageReaction", { error_code: 400, description: "Bad Request: REACTION_INVALID" }, { once: true });

    const primary = "\u{1F914}"; // 🤔 thinking — deliberately not in TELEGRAM_SAFE_EMOJI
    const result = await reactWithFallback(adapter, String(TEST_CHAT.chatId), String(botReplyId), primary);
    expect(result.ok, result.ok ? "" : `reactWithFallback failed: ${String(!result.ok && result.error)}`).toBe(true);

    // A safe emoji landed on the bot reply (the (d) fallback): the first safe
    // emoji is 👍 (the chain's head, != the primary 🤔).
    const landed = emu.reactionsOn(TEST_CHAT, botReplyId);
    expect(landed.length).toBe(1);
    expect(TELEGRAM_SAFE_EMOJI).toContain(landed[0]);
    expect(landed[0]).toBe(TELEGRAM_SAFE_EMOJI[0]); // 👍, the first non-primary safe emoji
  });
});

// ---------------------------------------------------------------------------
// FAULT-02 — classifyTelegramError directly + the 429 auto-retry eventual success
// ---------------------------------------------------------------------------

describe("FAULT-02 Stage-B — classifyTelegramError classification + 429 auto-retry eventual success", () => {
  it("classifies the four GrammyError classes structurally (429 / 400-not-editable / 403 / default→internal)", () => {
    // 429 with retry_after → rate_limited (retryAfterMs = retry_after * 1000).
    expect(classifyTelegramError({ error_code: 429, parameters: { retry_after: 5 } })).toEqual({
      kind: "rate_limited",
      retryAfterMs: 5000,
    });
    // 400 "message can't be edited" → not_supported{edit}.
    expect(classifyTelegramError({ error_code: 400, description: "message can't be edited" })).toEqual({
      kind: "not_supported",
      capability: "edit",
    });
    // 403 forbidden → permission (carries the description as detail).
    expect(classifyTelegramError({ error_code: 403, description: "bot was blocked by the user" })).toMatchObject({
      kind: "permission",
    });
    // ⚠ THE NUANCE: the classifier's OWN default (unmatched) is {kind:"internal"},
    // NOT ok:true. A 403 must NOT mis-route to internal (it is permission above);
    // an unmatched code falls through to internal carrying the cause for diagnosis.
    expect(classifyTelegramError({ error_code: 418, description: "I'm a teapot" })).toMatchObject({
      kind: "internal",
    });
  });

  it("reads the GrammyError off error.cause when the adapter wrapped it (the structural cause path)", () => {
    // The live adapter wraps the GrammyError as `new Error(msg, { cause })`; the
    // classifier reads error_code/parameters off the cause, not the message string.
    const wrapped = new Error("Failed to send message: Too Many Requests", {
      cause: { error_code: 429, parameters: { retry_after: 3 } },
    });
    expect(classifyTelegramError(wrapped)).toEqual({ kind: "rate_limited", retryAfterMs: 3000 });
  });

  it("the \"default → ok\" criterion: a NO-FAULT Bot-API send returns {ok:true} (distinct from the classifier default)", async () => {
    // This is the SEPARATE assertion: with NO fault set, the real adapter's send
    // succeeds — the Bot-API envelope is {ok:true}. This is the success-criterion
    // "default → ok", NOT the classifier's {kind:"internal"} default above.
    const emulator = createTgEmulator({ botToken: BOT_TOKEN });
    const handle = await emulator.start();
    try {
      const plugin = createTelegramPlugin({
        botToken: BOT_TOKEN,
        apiRoot: handle.apiRoot,
        logger: createMockLogger(),
      });
      const adapter = plugin.adapter;
      const startRes = await adapter.start();
      if (!startRes.ok) throw startRes.error;
      await new Promise((r) => setTimeout(r, 200));

      // NO emu.fail(...) — the unfaulted send succeeds.
      const res = await adapter.sendMessage(String(TEST_CHAT.chatId), "no fault here");
      expect(res.ok, res.ok ? "" : `sendMessage failed: ${String(!res.ok && res.error)}`).toBe(true);
      // The recorded outbound proves the {ok:true} Bot-API envelope round-tripped.
      const recorded = emulator.lastBotReply(TEST_CHAT);
      expect(recorded?.method).toBe("sendMessage");
      await adapter.stop().catch(() => undefined);
    } finally {
      await emulator.stop().catch(() => undefined);
    }
  });

  it("429 eventual-success: a once:true 429 with a small retry_after → the send EVENTUALLY succeeds after @grammyjs/auto-retry backoff", async () => {
    const emulator = createTgEmulator({ botToken: BOT_TOKEN });
    const handle = await emulator.start();
    try {
      const plugin = createTelegramPlugin({
        botToken: BOT_TOKEN,
        apiRoot: handle.apiRoot,
        logger: createMockLogger(),
      });
      const adapter = plugin.adapter;
      const startRes = await adapter.start();
      if (!startRes.ok) throw startRes.error;
      await new Promise((r) => setTimeout(r, 200));

      // A 429 with retry_after:1 (seconds). @grammyjs/auto-retry (maxRetryAttempts:3,
      // maxDelaySeconds:10) pauses ~1s then retries; once:true consumes the fault so
      // the retry succeeds. The bounded backoff means no unbounded retry / no crash.
      emulator.fail("sendMessage", { error_code: 429, description: "Too Many Requests: retry later", parameters: { retry_after: 1 } }, { once: true });

      const res = await adapter.sendMessage(String(TEST_CHAT.chatId), "rate limited then ok");
      expect(res.ok, res.ok ? "" : `429 send did not eventually succeed: ${String(!res.ok && res.error)}`).toBe(true);
      // The send eventually landed (the auto-retry succeeded after the backoff).
      const sends = emulator.outbound(TEST_CHAT).filter((o) => o.method === "sendMessage");
      expect(sends.length).toBe(1);
      expect(sends[0]!.text).toBe("rate limited then ok");
      await adapter.stop().catch(() => undefined);
    } finally {
      await emulator.stop().catch(() => undefined);
    }
  }, 20_000);
});

// ---------------------------------------------------------------------------
// Stage-B — SEC-02 re-verify + zero production code change
// ---------------------------------------------------------------------------

describe("SEC-02 Stage-B — the never-published guard re-verifies + the phase diff is test/-only (zero production behavior change)", () => {
  it("the SEC-02 never-published invariant holds: no chan/tg comis subcommand + no package.json under test/live (the fault scenario adds no published edge)", () => {
    const repoRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf-8" }).trim();

    // Dimension 3 — the published comis CLI registers no `chan`/`tg` subcommand.
    const cliSource = readFileSync(resolve(repoRoot, "packages/cli/src/cli.ts"), "utf8");
    for (const name of ["chan", "tg"] as const) {
      expect(
        new RegExp(String.raw`\.command\(\s*["'\`]${name}\b`).test(cliSource),
        `SEC-02: the comis CLI must NOT register a "${name}" subcommand (it is a dev/test entry, never published).`,
      ).toBe(false);
    }

    // Dimension 1 — no package.json under test/live/** (would make the harness publishable).
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

  it("git status --porcelain shows NO packages source CHANGE beyond the committed classifyTelegramError barrel widening (the milestone premise)", () => {
    // The four fallbacks + the classifier are already wired in packages/channels/src
    // and verified at HEAD — the harness DRIVES what they consume. The ONLY product
    // touch this plan makes is the classifyTelegramError barrel widening (a
    // VISIBILITY-only Defect-Watch surface-gap closure landed test-first, committed).
    // Any UNCOMMITTED packages/*/src change here means a Defect-Watch fired mid-run
    // (the 206 class) — STOP and see the SUMMARY.
    const repoRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf-8" }).trim();
    const porcelain = execFileSync("git", ["status", "--porcelain"], { cwd: repoRoot, encoding: "utf-8" });
    const offending = porcelain
      .split("\n")
      .map((line) => line.slice(3).trim())
      .filter((p) => p.length > 0)
      .flatMap((p) => (p.includes(" -> ") ? p.split(" -> ") : [p]))
      .filter((p) => /(^|\/)packages\/[^/]+\/src\//.test(p));
    // The working tree carries NO uncommitted product change (the barrel widening is committed).
    expect(offending, `uncommitted production source changed: ${offending.join(", ")}`).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Stage-C — the parse_mode fallback on a real daemon reply (COMIS_LIVE)
// ---------------------------------------------------------------------------

describe.skipIf(!isLive)("FAULT-01 Stage-C — the parse_mode fallback on a real agent reply (COMIS_LIVE)", () => {
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
    "a parse-entities fault on the agent's reply send → the reply still lands as plain text (honest finding if not, I5)",
    async () => {
      const r = built;
      expect(r, "rig booted").toBeDefined();
      if (r === undefined) return;

      // Arm a once parse-entities fault so the NEXT sendMessage (the agent's reply)
      // hits it and the adapter retries WITHOUT parse_mode. once consumes it so the
      // retry lands.
      r.emulator.fail("sendMessage", { error_code: 400, description: "can't parse entities" }, { once: true });

      const inboundId = await r.send("Reply with a short greeting.");
      const reply = await r.waitForReply(inboundId, 1_500_000);
      expect(
        reply,
        "no agent reply under fault — is a keyless model reachable (ollama on localhost:11434)? the fallback must still deliver (honest no-reply, never fabricated)",
      ).toBeDefined();
      if (reply === undefined) return;
      // The reply that LANDED is the retry (plain text, no parse_mode) — the (a)
      // fallback delivered the user's message under the adverse Bot-API condition.
      expect(
        reply.parseMode,
        "FINDING: the landed reply still carried parse_mode — the parse-entities fallback did not fire on the real reply path (NOT a faked green, I5).",
      ).toBeUndefined();
    },
    1_800_000,
  );
});
