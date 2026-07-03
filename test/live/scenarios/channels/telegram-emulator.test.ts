// SPDX-License-Identifier: Apache-2.0
/**
 * RIG-01/02 + TEST-01 + SEC-01 — the walking-skeleton scenario (THE
 * phase keystone). One text round-trips from the `TgEmulator` through the REAL
 * grammy Telegram adapter, an isolated `$0`/offline Comis daemon, back to the
 * emulator's recorded `outbound()` — with the SSRF/file-route caveat settled and
 * ZERO production code change.
 *
 * ── THE CI vs COMIS_LIVE SPLIT (the resolved highest-execution-risk decision) ──
 *
 * The reply criterion ("an AGENT-AUTHORED reply lands in outbound()") needs the
 * agent to PRODUCE a reply, which needs a reachable keyless model. CI has none,
 * and there is NO in-tree stub LLM provider (DaemonOverrides exposes no completion
 * seam; every existing full-daemon live scenario gates its real-model leg behind
 * COMIS_LIVE). So this scenario is split — and the split is the ONLY path that
 * respects the milestone's zero-product-change rule:
 *
 *   • Stage-B (ALWAYS runs, in-process, NO COMIS_LIVE, NO real network) asserts
 *     the round-trip STRUCTURE deterministically:
 *       - the TEST-01 contract / grammy-drift tripwire: the REAL bare grammy
 *         adapter (createTelegramPlugin({ apiRoot })) token-validates (getMe),
 *         registers commands (setMyCommands), long-polls (getUpdates), and an
 *         injected update round-trips to its onMessage → the adapter's
 *         sendMessage lands a RecordedOutbound in emu.outbound().
 *         This is an *adapter-authored* send via an in-memory onMessage (mirrors
 *         test/e2e/telegram-dm.test.ts) — NOT the agent (that is the ANTI-PATTERN
 *         for the agent leg; here it is the contract tripwire, which is correct).
 *       - the SEC-01 loopback verdict: both HTTP surfaces bind 127.0.0.1; the
 *         file-route caveat is settled (see the SEC-01 describe below).
 *
 *   • Stage-C (describe.skipIf(!isLive), COMIS_LIVE) is the AGENT-AUTHORED
 *     round-trip (the FULL agent-authored version): startRig boots the isolated daemon,
 *     rig.send(text) injects, rig.waitForReply() asserts a bot reply landed in
 *     emulator.outbound() (content via "a reply arrived", not exact wording — the
 *     model is non-deterministic). On no-reply the waiter returns undefined and
 *     the leg fails HONESTLY (reason-coded), NEVER green-by-fabrication.
 *     SKIPPED (skip≠fail) when COMIS_LIVE is unset — the operator path (a real
 *     ollama on localhost:11434, or live.env) is in test/live/RUNBOOK.md.
 *
 * IMPORTANT: the agent-authored half of the reply criterion is COMIS_LIVE-
 * gated BY DESIGN, NOT an unmet criterion — the CI leg never depends on a
 * model reply.
 *
 * Run:
 *   CI (Stage-B only, offline, deterministic):
 *     pnpm vitest run -c test/live/vitest.config.ts test/live/scenarios/channels/telegram-emulator.test.ts
 *   Stage-C (the agent round-trip, operator / when a keyless model is reachable):
 *     COMIS_LIVE=1 pnpm test:live
 *
 * (NB: a BARE `pnpm vitest run test/live/...` resolves under the ROOT config,
 *  whose projects exclude test/live → 0 files, exit 0 = false-green. ALWAYS pass
 *  `-c test/live/vitest.config.ts`.)
 *
 * TEST-HARNESS — lives under `test/`, never `packages`; ZERO production code
 * change (the apiRoot seam already exists end-to-end). The scenario itself
 * asserts `git status --porcelain` shows no `packages` source change.
 *
 * @module
 */

import { describe, it, expect, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { createTelegramPlugin } from "@comis/channels";
import type { ChannelPort, NormalizedMessage } from "@comis/core";
import { createTgEmulator, type TgEmulator, type ChatRef } from "../../emulators/telegram/tg-emulator.js";
import { createMockLogger } from "../../../support/mock-logger.js";
import { startRig, type RigHandle } from "../../harness/rig.js";

const isLive = !!process.env["COMIS_LIVE"];

/** The fixed test chat the round-trip drives (a fabricated id, never a real operator chat). */
const TEST_CHAT: ChatRef = { chatId: 424242 };

// ---------------------------------------------------------------------------
// Stage-B — TEST-01 contract / grammy-drift tripwire (in-process, deterministic)
// ---------------------------------------------------------------------------

describe("RIG/TEST-01 Stage-B — real grammy adapter ↔ TgEmulator contract round-trip (no COMIS_LIVE, in-process)", () => {
  let emu: TgEmulator | undefined;
  let adapter: ChannelPort | undefined;

  afterEach(async () => {
    // Stop the adapter FIRST (it polls the emulator), then the emulator.
    if (adapter) {
      await adapter.stop().catch(() => undefined);
      adapter = undefined;
    }
    if (emu) {
      await emu.stop().catch(() => undefined);
      emu = undefined;
    }
  });

  /**
   * Boot the REAL bare grammy adapter against a fresh emulator, with an in-memory
   * onMessage that ACKs every inbound via adapter.sendMessage (the Stage-B
   * adapter-authored reply — the contract tripwire, NOT the agent). Mirrors
   * test/e2e/telegram-dm.test.ts but asserts on the emulator's outbound() oracle.
   */
  async function bootAdapterAgainstEmulator(): Promise<{ emu: TgEmulator; adapter: ChannelPort }> {
    const emulator = createTgEmulator({ botToken: "12345:test" });
    const handle = await emulator.start();
    // SEC-01: the emulator binds loopback and hands back a 127.0.0.1 apiRoot.
    expect(handle.apiRoot).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);

    const plugin = createTelegramPlugin({
      botToken: "12345:test",
      apiRoot: handle.apiRoot,
      logger: createMockLogger(),
    });
    const a = plugin.adapter;
    // The Stage-B in-memory reply: the adapter ACKs the inbound. This is the
    // CONTRACT tripwire (adapter-authored), explicitly NOT the agent.
    a.onMessage(async (m: NormalizedMessage) => {
      await a.sendMessage(m.channelId, `ack: ${m.text}`);
    });
    const startRes = await a.start(); // exercises getMe + setMyCommands + run() vs the emulator
    if (!startRes.ok) throw startRes.error;
    // Let the grammy runner's first getUpdates poll complete.
    await new Promise((r) => setTimeout(r, 300));
    return { emu: emulator, adapter: a };
  }

  it("token-validates via getMe + records setMyCommands + round-trips an injected update to a recorded outbound (the drift tripwire)", async () => {
    const booted = await bootAdapterAgainstEmulator();
    emu = booted.emu;
    adapter = booted.adapter;

    // getMe was AWAITED at boot (credential validation) → the adapter would have
    // failed start() if the emulator had not answered it. setMyCommands is
    // fire-and-forget; the emulator records it as an outbound on the bot's own
    // chat — but the load-bearing contract is the inbound→onMessage→sendMessage
    // round-trip below.

    // Inject an inbound DM → the grammy runner long-polls getUpdates → onMessage
    // fires → the adapter sendMessage lands a RecordedOutbound in outbound().
    const injectedId = emu.injectMessage(
      TEST_CHAT,
      { id: 100, firstName: "Tester", username: "tester" },
      "hello from the emulator",
    );
    expect(injectedId).toBeGreaterThan(0);

    // Wait for the next poll cycle to deliver + the ack to be sent (bounded).
    const start = Date.now();
    while (emu.outbound(TEST_CHAT).length === 0 && Date.now() - start < 5000) {
      await new Promise((r) => setTimeout(r, 50));
    }

    const out = emu.outbound(TEST_CHAT);
    // The round-trip lands a recorded outbound (sendMessage)
    // on the channel oracle — the grammy-drift tripwire (if grammy's wire shape
    // drifted, getMe/getUpdates/sendMessage would not round-trip and this fails).
    const sent = out.find((o) => o.method === "sendMessage");
    expect(sent, "the adapter's ack should land in emu.outbound()").toBeDefined();
    expect(sent!.text).toContain("ack: hello from the emulator");
    expect(sent!.messageId).toBeGreaterThan(0);
    // parse_mode:"HTML" is the adapter's wire default (telegram-outbound.ts).
    expect(sent!.parseMode).toBe("HTML");
  });
});

// ---------------------------------------------------------------------------
// Stage-B — SEC-01 loopback + file-route verdict (in-process)
// ---------------------------------------------------------------------------

describe("SEC-01 Stage-B — loopback bind + the file-route verdict (no COMIS_LIVE)", () => {
  let emu: TgEmulator | undefined;

  afterEach(async () => {
    if (emu) {
      await emu.stop().catch(() => undefined);
      emu = undefined;
    }
  });

  it("both HTTP surfaces bind 127.0.0.1 and the getFile route SHAPE is reachable (not a 404 at boot)", async () => {
    emu = createTgEmulator({ botToken: "12345:test" });
    const { apiRoot } = await emu.start();

    // SEC-01: the loopback bind — both the Bot API and /control/* ride
    // this ONE 127.0.0.1 server. Never a wildcard host.
    expect(apiRoot).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);

    // File-route verdict:
    //   getFile is a plain `bot.api.getFile()` call (telegram-resolver.ts:75) —
    //   SEAM-ROUTED with NO SSRF guard — so it reaches the loopback apiRoot fine.
    //   The byte-DOWNLOAD URL is HARDCODED to https://api.telegram.org/file/...
    //   (telegram-resolver.ts:95) and routed through an SSRF-guarded fetcher that
    //   BLOCKS loopback — but that byte download is MEDIA-02, not this scenario.
    //   Here we need only the getFile method + the GET /file/bot<token>/<path>
    //   route SHAPE (no 404 at boot). The inverse-SSRF primitive
    //   validateLocalServerUrl (ssrf-guard.ts:198) already exists for the
    //   test-only host allowance — it never relaxes production validateUrl.
    // NOTE: getFile now resolves against the REAL file store;
    // an UNSTORED file_id is a Telegram-shaped not-found (`ok:false`, error_code 400)
    // — so seed a file first, then assert getFile answers a well-formed descriptor
    // for a KNOWN id over loopback (the boot-reachability intent, store-aware).
    const seeded = emu.storeFile("document", Buffer.from("getfile-shape-probe", "utf8"));
    const getFileRes = await fetch(`${apiRoot}/bot12345:test/getFile`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ file_id: seeded.fileId }),
    });
    expect(getFileRes.status).toBe(200);
    const getFileJson = (await getFileRes.json()) as { ok: boolean; result?: { file_path?: string } };
    expect(getFileJson.ok).toBe(true);
    expect(typeof getFileJson.result?.file_path).toBe("string");

    // Assert the GET /file/bot<token>/<path> route SHAPE exists (not a 404).
    const fileRouteRes = await fetch(`${apiRoot}/file/bot12345:test/${getFileJson.result?.file_path ?? "documents/x.bin"}`);
    expect(fileRouteRes.status).not.toBe(404);
    expect(fileRouteRes.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Stage-B — zero production code change (the milestone's load-bearing proof)
// ---------------------------------------------------------------------------

describe("Stage-B — the whole phase diff is test/-only (zero production code change)", () => {
  it("git status --porcelain shows NO packages source change (the milestone premise)", () => {
    // The walking skeleton is the milestone's load-bearing proof: the apiRoot
    // seam already exists end-to-end, so the WHOLE integration is wired with no
    // `packages` source edit. If this fails, a product file was touched — STOP.
    const repoRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf-8" }).trim();
    const porcelain = execFileSync("git", ["status", "--porcelain"], {
      cwd: repoRoot,
      encoding: "utf-8",
    });
    // Lines look like " M packages/...", "?? test/...", "A  test/..." — strip the
    // 3-char XY+space status prefix and check no path is under packages/<pkg>/src/.
    const offending = porcelain
      .split("\n")
      .map((line) => line.slice(3).trim())
      .filter((p) => p.length > 0)
      // A rename shows "old -> new"; check the destination too.
      .flatMap((p) => (p.includes(" -> ") ? p.split(" -> ") : [p]))
      .filter((p) => /(^|\/)packages\/[^/]+\/src\//.test(p));
    expect(offending, `production source changed: ${offending.join(", ")}`).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Stage-C — the AGENT-AUTHORED round-trip via the full daemon (COMIS_LIVE)
// ---------------------------------------------------------------------------

describe.skipIf(!isLive)("RIG Stage-C — agent-authored round-trip via startRig (COMIS_LIVE)", () => {
  let rig: RigHandle | undefined;

  afterEach(async () => {
    if (rig) {
      await rig.cleanup();
      rig = undefined;
    }
  });

  it(
    "startRig boots an isolated daemon (apiRoot seam, /health green) and an agent reply lands in outbound() — or fails honestly (no fabrication)",
    async () => {
      // startRig boots green. startTestDaemon already awaited
      // the gateway /health (10×500ms) and the real grammy adapter token-validated
      // (getMe) + registered commands (setMyCommands) + began long-polling
      // (getUpdates) against the emulator — boot would have thrown otherwise.
      rig = await startRig({ channel: "telegram", model: "keyless" });
      expect(rig.gatewayUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      expect(rig.authToken.length).toBeGreaterThanOrEqual(32);

      // Confirm the gateway is actually reachable (a second, explicit /health).
      const health = await fetch(`${rig.gatewayUrl}/health`);
      expect(health.ok).toBe(true);

      // The FULL agent-authored round-trip: inject a DM → the daemon's agent
      // authors a reply → it lands in the emulator's outbound() oracle.
      const inboundId = await rig.send("hello from the emulator");
      const reply = await rig.waitForReply(inboundId, 45_000);

      // HONEST on no-reply: undefined means the keyless model produced nothing
      // within the window (reason-coded), NEVER a fabricated success. When a
      // keyless model IS reachable the reply lands; the assertion is STRUCTURAL
      // ("a reply arrived"), not exact wording (the model is non-deterministic).
      expect(
        reply,
        "no agent reply within 45s — is a keyless model reachable (ollama on localhost:11434 / live.env)? See test/live/RUNBOOK.md. (honest no-reply, never fabricated)",
      ).toBeDefined();
      expect(reply!.method).toBe("sendMessage");
      expect(typeof reply!.text).toBe("string");
      expect(reply!.text!.length).toBeGreaterThan(0);

      // The reply is also visible on the channel oracle (the dual-oracle anchor).
      const out = rig.emulator.outbound(rig.chat);
      expect(out.some((o) => o.messageId === reply!.messageId)).toBe(true);
    },
  );
});
