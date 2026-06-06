// SPDX-License-Identifier: Apache-2.0
/**
 * CHAN-01 — Echo golden round-trip + per-adapter credential-validation breadth.
 *
 * Stage-B (always runs, in-process, keyless, deterministic — no daemon, no network):
 *   - Echo golden round-trip via the REAL channel registry + echo plugin + event bus:
 *     register → getAdapter/getCapabilities + `channel:registered` event;
 *     activate → isRunning; injectMessage → reply in getSentMessages; unregister →
 *     `channel:deregistered`. The REAL event is `channel:registered` (NOT
 *     `channel:connected`, which does not exist).
 *   - Credential-validation breadth across the 9 real channel adapters: each exported
 *     validator rejects an empty/blank credential with its product `err` BEFORE any
 *     network call. Plus the fully-deterministic Telegram webhook-secret branches and
 *     the Slack socket/http deterministic branches; iMessage rejects a bogus binary
 *     path locally; email's reject path needs a network IMAP attempt so only its
 *     export is checked at Stage-B.
 *
 * Stage-C (describe.skipIf(!isLive) + it.skip, COMIS_LIVE + a real account/network):
 *   - real-account positive validation (real token / e2e-mock apiRoot seam) + the
 *     real send→agent→reply round-trip per channel. No account in the sandbox ⇒
 *     SKIPPED(no-account); the manual procedure lives in test/live/RUNBOOK.md. skip≠fail.
 *
 * @module
 */

import { describe, it, expect } from "vitest";
import {
  createChannelRegistry,
  createEchoPlugin,
  EchoChannelAdapter,
  validateDiscordToken,
  validateBotToken,
  validateWebhookSecret,
  validateSlackCredentials,
  validateSignalConnection,
  validateIrcConnection,
  validateLineCredentials,
  validateWhatsAppAuth,
  validateEmailCredentials,
  validateIMessageConnection,
} from "@comis/channels";
import { createPluginRegistry, TypedEventBus } from "@comis/core";
import type { NormalizedMessage } from "@comis/core";

const isLive = !!process.env["COMIS_LIVE"];

/** Minimal valid NormalizedMessage (mirrors echo-inbound.test.ts makeEchoMsg). */
function makeEchoMsg(overrides?: Partial<NormalizedMessage>): NormalizedMessage {
  return {
    id: "00000000-0000-0000-0000-000000000144",
    channelId: "echo-test",
    channelType: "echo",
    senderId: "user-1",
    text: "ping",
    timestamp: Date.now(),
    attachments: [],
    metadata: {},
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Stage-B — echo golden round-trip (in-process, deterministic)
// ---------------------------------------------------------------------------

describe("CHAN-01 Stage-B — echo golden round-trip (no COMIS_LIVE, in-process)", () => {
  function setup(): {
    registry: ReturnType<typeof createChannelRegistry>;
    plugin: ReturnType<typeof createEchoPlugin>;
    events: Array<{ name: string; payload: { channelType?: string; pluginId?: string } }>;
  } {
    const bus = new TypedEventBus();
    const events: Array<{ name: string; payload: { channelType?: string; pluginId?: string } }> = [];
    bus.on("channel:registered", (p) => events.push({ name: "channel:registered", payload: p }));
    bus.on("channel:deregistered", (p) => events.push({ name: "channel:deregistered", payload: p }));
    const registry = createChannelRegistry({ pluginRegistry: createPluginRegistry(), eventBus: bus });
    const plugin = createEchoPlugin();
    return { registry, plugin, events };
  }

  it("registerChannel(createEchoPlugin()) succeeds and exposes the echo adapter + capabilities", () => {
    const { registry, plugin } = setup();
    const reg = registry.registerChannel(plugin);
    expect(reg.ok).toBe(true);
    expect(registry.getAdapter("echo")).toBeInstanceOf(EchoChannelAdapter);
    expect(registry.getCapabilities("echo")).toEqual(plugin.capabilities);
    expect(registry.getChannelTypes()).toContain("echo");
  });

  it("registration emits a channel:registered event with the echo identity (NOT channel:connected)", () => {
    const { registry, plugin, events } = setup();
    registry.registerChannel(plugin);
    const evt = events.find((e) => e.name === "channel:registered");
    expect(evt).toBeDefined();
    expect(evt?.payload).toMatchObject({ channelType: "echo", pluginId: "channel-echo" });
  });

  it("activate → isRunning; injectMessage round-trips a reply through getSentMessages (send→handler→reply)", async () => {
    const { registry, plugin } = setup();
    registry.registerChannel(plugin);
    await plugin.activate();
    const adapter = registry.getAdapter("echo") as EchoChannelAdapter;
    expect(adapter.isRunning()).toBe(true);

    adapter.onMessage(async (m) => {
      await adapter.sendMessage(m.channelId, `reply: ${m.text}`);
    });
    await adapter.injectMessage(makeEchoMsg({ text: "ping" }));

    expect(adapter.getSentMessages().some((s) => s.text === "reply: ping")).toBe(true);
  });

  it("unregisterChannel emits channel:deregistered", () => {
    const { registry, plugin, events } = setup();
    registry.registerChannel(plugin);
    const unreg = registry.unregisterChannel("echo");
    expect(unreg.ok).toBe(true);
    expect(events.some((e) => e.name === "channel:deregistered")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Stage-B — per-adapter credential-validation breadth (no network)
// ---------------------------------------------------------------------------

/**
 * The 8 deterministic empty/blank-input cases — each validator returns an err
 * BEFORE any platform network call. VERIFIED at runtime against the built adapters.
 */
const EMPTY_INPUT_CASES: ReadonlyArray<{
  name: string;
  run: () => Promise<{ ok: boolean; error?: Error }>;
  msg: string;
}> = [
  { name: "discord", run: () => validateDiscordToken(""), msg: "token must not be empty" },
  { name: "telegram", run: () => validateBotToken(""), msg: "token must not be empty" },
  { name: "slack", run: () => validateSlackCredentials({ botToken: "" }), msg: "botToken must not be empty" },
  { name: "signal", run: () => validateSignalConnection({ baseUrl: "" }), msg: "baseUrl must not be empty" },
  { name: "irc-host", run: () => validateIrcConnection({ host: "", nick: "n" }), msg: "host must not be empty" },
  { name: "irc-nick", run: () => validateIrcConnection({ host: "h", nick: "" }), msg: "nick must not be empty" },
  { name: "line", run: () => validateLineCredentials({ channelAccessToken: "", channelSecret: "s" }), msg: "channel access token must not be empty" },
  { name: "whatsapp", run: () => validateWhatsAppAuth({ authDir: "" }), msg: "auth directory must not be empty" },
];

describe("CHAN-01 Stage-B — per-adapter credential-validation breadth (no COMIS_LIVE, no network)", () => {
  it.each(EMPTY_INPUT_CASES)(
    "$name validator rejects an empty credential with its product error (deterministic, no network)",
    async ({ run, msg }) => {
      const result = await run();
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error?.message).toContain(msg);
      }
    },
  );

  it("telegram validateWebhookSecret is fully deterministic (empty / >256 / non-ASCII all reject)", () => {
    const empty = validateWebhookSecret("");
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(empty.error.message).toContain("must not be empty");

    const tooLong = validateWebhookSecret("a".repeat(300));
    expect(tooLong.ok).toBe(false);
    if (!tooLong.ok) expect(tooLong.error.message).toContain("must be 1-256");

    const nonAscii = validateWebhookSecret("héllo");
    expect(nonAscii.ok).toBe(false);
    if (!nonAscii.ok) expect(nonAscii.error.message).toContain("only ASCII");
  });

  it("slack socket mode without appToken and http mode without signingSecret reject deterministically", async () => {
    const socket = await validateSlackCredentials({ botToken: "x", mode: "socket" });
    expect(socket.ok).toBe(false);
    if (!socket.ok) expect(socket.error.message).toContain("Socket Mode requires appToken");

    const http = await validateSlackCredentials({ botToken: "x", mode: "http" });
    expect(http.ok).toBe(false);
    if (!http.ok) expect(http.error.message).toContain("HTTP Mode requires signingSecret");
  });

  it("imessage rejects a bogus binary path locally (no network)", async () => {
    const result = await validateIMessageConnection({ binaryPath: "/nonexistent/imsg-bogus-144" });
    // On darwin the local `which` lookup fails → err; on non-darwin the macOS guard → err.
    // Either way: a clean err, never a throw or a network hang (skip≠fail posture).
    expect(result.ok).toBe(false);
  });

  it("email credential validator is exported (its reject path needs a live IMAP attempt → Stage-C)", () => {
    expect(typeof validateEmailCredentials).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// Stage-C — real-account positive validation + send→agent→reply (operator-run)
// ---------------------------------------------------------------------------

describe.skipIf(!isLive)("CHAN-01 Stage-C — real-account round-trip (COMIS_LIVE)", () => {
  it.skip(
    "real token → ok({botInfo}) + real send→agent→reply per launch-set channel (deferred to operator; no account in sandbox; skip≠fail; see test/live/RUNBOOK.md)",
    () => {
      // Operator (COMIS_LIVE + a real channel account, or the apiRoot=http://127.0.0.1:<e2e-mock> seam):
      //   - validateDiscordToken(<real token>) / validateSlackCredentials({botToken:<real>, …}) → ok({botInfo});
      //   - send a real message from the channel client → confirm the agent replies (RUNBOOK.md procedure);
      //   - creds.getSkipVerdict(...) gates each channel skip-not-fail when its account is absent.
    },
  );
});
