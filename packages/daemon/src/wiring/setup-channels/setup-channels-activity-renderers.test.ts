// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for buildActivityRenderers (§17.7).
 *
 * The helper routes each registered channel's declared ChannelCapability to a
 * rendering strategy via selectStrategy(caps, channelType) and constructs the
 * matching renderer as a per-channelId factory `(channelId) => renderer`. The
 * channelId is unknown at boot (the same channelType serves many channelIds),
 * so the EditPlace branch defers the render-actions channelId binding to turn
 * time. Echo→TestSink also goes through the factory (it ignores channelId).
 *
 * This suite flips the earlier assertion: the four EditPlace
 * channels (Telegram/Discord/Slack/WhatsApp) are now CONSTRUCTIBLE — their
 * per-channel render-actions adapters have landed and the factories
 * are barrel-exported. These tests assert: the live TestSink factory
 * for Echo, an EditPlace factory PRESENT for an edit-capable channel, and
 * no-capability channels skipped.
 *
 * @module
 */
import { describe, it, expect, vi } from "vitest";
import type { ChannelPort, ChannelPluginPort, ChannelCapability, TurnOutcome, ActivityStatusMarkers } from "@comis/core";
import { themeForName } from "@comis/core";
import type { ComisLogger } from "@comis/infra";
import { createFakeTimers } from "../../../../../test/support/fake-timers.js";
import { createFakeClock } from "../../../../../test/support/fake-clock.js";
import { buildActivityRenderers } from "./setup-channels-activity-renderers.js";

function makeCaps(overrides: Partial<ChannelCapability["features"]> = {}, maxMessageChars = 4096): ChannelCapability {
  return {
    features: {
      reactions: false,
      editMessages: false,
      deleteMessages: false,
      fetchHistory: false,
      attachments: false,
      ...overrides,
    },
    limits: { maxMessageChars },
  } as ChannelCapability;
}

function makeStubAdapter(channelType: string): ChannelPort {
  return {
    channelId: `${channelType}-stub`,
    channelType,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- stub
    start: (async () => ({ ok: true, value: undefined })) as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- stub
    stop: (async () => ({ ok: true, value: undefined })) as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- stub
    sendMessage: (async () => ({ ok: true, value: "stub-id" })) as any,
    onMessage: () => {},
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- stub
    platformAction: (async () => ({ ok: true, value: undefined })) as any,
  };
}

function makeStubPlugin(channelType: string, capabilities: ChannelCapability): ChannelPluginPort {
  return {
    id: `channel-${channelType}`,
    name: `${channelType} plugin`,
    version: "1.0.0",
    channelType,
    capabilities,
    adapter: makeStubAdapter(channelType),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- stub
    register: (() => ({ ok: true, value: undefined })) as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- stub
    activate: (async () => ({ ok: true, value: undefined })) as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- stub
    deactivate: (async () => ({ ok: true, value: undefined })) as any,
  };
}

function makeLogger(): ComisLogger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn() } as unknown as ComisLogger;
}

/** Fresh injected TimerPort + ClockPort for each buildActivityRenderers call
 *  (the EditPlace branch threads them into createEditPlaceRenderer). */
function makeTime(): { timer: ReturnType<typeof createFakeTimers>; clock: ReturnType<typeof createFakeClock> } {
  return { timer: createFakeTimers(), clock: createFakeClock(0) };
}

describe("buildActivityRenderers", () => {
  it("constructs a live TestSink renderer factory for the Echo channel, keyed by channelType", () => {
    const adapters = new Map<string, ChannelPort>([["echo", makeStubAdapter("echo")]]);
    const plugins = new Map<string, ChannelPluginPort>([["echo", makeStubPlugin("echo", makeCaps())]]);

    const { timer, clock } = makeTime();
    const renderers = buildActivityRenderers(adapters, plugins, makeLogger(), { timer, clock });

    const echoFactory = renderers.get("echo");
    expect(echoFactory).toBeDefined();
    // The map value is a per-channelId factory; invoke it with a test channelId.
    const echo = echoFactory!("echo-chan");
    // The TestSink recorder identity (Echo terminus) — apply/finalize are present.
    expect(echo.strategy).toBe("TestSink");
    expect(typeof echo.apply).toBe("function");
    expect(typeof echo.finalize).toBe("function");
  });

  it("constructs an EditPlace renderer factory for an edit-capable channel (Telegram)", () => {
    // editMessages → EditPlace. Its per-channel ActivityRenderActions adapter
    // has landed and the factory is barrel-exported, so the
    // EditPlace branch now PRODUCES a per-channelId factory (this inverts the
    // earlier "omits EditPlace until its adapter lands" assertion).
    const adapters = new Map<string, ChannelPort>([["telegram", makeStubAdapter("telegram")]]);
    const plugins = new Map<string, ChannelPluginPort>([
      ["telegram", makeStubPlugin("telegram", makeCaps({ editMessages: true }))],
    ]);

    const { timer, clock } = makeTime();
    const renderers = buildActivityRenderers(adapters, plugins, makeLogger(), { timer, clock });

    const telegramFactory = renderers.get("telegram");
    expect(telegramFactory).toBeDefined();
    expect(renderers.size).toBe(1);
    // The factory binds the per-turn channelId and constructs the EditPlace renderer.
    const renderer = telegramFactory!("chat-1");
    expect(renderer.strategy).toBe("EditPlace");
    expect(typeof renderer.apply).toBe("function");
    expect(typeof renderer.finalize).toBe("function");
  });

  it("dispatches each edit-capable channelType to its own EditPlace factory", () => {
    // Closed dispatch on channelType: telegram/discord/slack/whatsapp each map
    // to their own create<Ch>ActivityRenderer.
    const editChannels = ["telegram", "discord", "slack", "whatsapp"] as const;
    const adapters = new Map<string, ChannelPort>(editChannels.map((c) => [c, makeStubAdapter(c)]));
    const plugins = new Map<string, ChannelPluginPort>(
      editChannels.map((c) => [c, makeStubPlugin(c, makeCaps({ editMessages: true }))]),
    );

    const { timer, clock } = makeTime();
    const renderers = buildActivityRenderers(adapters, plugins, makeLogger(), { timer, clock });

    expect(renderers.size).toBe(4);
    for (const c of editChannels) {
      const factory = renderers.get(c);
      expect(factory, `factory for ${c}`).toBeDefined();
      expect(factory!("chan-1").strategy, `strategy for ${c}`).toBe("EditPlace");
    }
  });

  it("skips an adapter whose plugin declares no capabilities and logs no renderer for it", () => {
    const adapters = new Map<string, ChannelPort>([["ghost", makeStubAdapter("ghost")]]);
    // Plugin present but no capabilities field.
    const plugins = new Map<string, ChannelPluginPort>([
      ["ghost", { ...makeStubPlugin("ghost", makeCaps()), capabilities: undefined as unknown as ChannelCapability }],
    ]);

    const { timer, clock } = makeTime();
    const renderers = buildActivityRenderers(adapters, plugins, makeLogger(), { timer, clock });

    expect(renderers.has("ghost")).toBe(false);
    expect(renderers.size).toBe(0);
  });

  it("builds both the Echo TestSink factory and the Telegram EditPlace factory for a mixed adapter set", () => {
    const adapters = new Map<string, ChannelPort>([
      ["echo", makeStubAdapter("echo")],
      ["telegram", makeStubAdapter("telegram")],
    ]);
    const plugins = new Map<string, ChannelPluginPort>([
      ["echo", makeStubPlugin("echo", makeCaps())],
      ["telegram", makeStubPlugin("telegram", makeCaps({ editMessages: true }))],
    ]);

    const { timer, clock } = makeTime();
    const renderers = buildActivityRenderers(adapters, plugins, makeLogger(), { timer, clock });

    expect(renderers.size).toBe(2);
    expect(renderers.get("echo")!("echo-chan").strategy).toBe("TestSink");
    expect(renderers.get("telegram")!("chat-1").strategy).toBe("EditPlace");
  });
});

describe("buildActivityRenderers — non-EditPlace strategies (§18.3 matrix)", () => {
  it("constructs a DeleteAndRepost factory for Signal (deleteMessages, no edit)", () => {
    // deleteMessages without editMessages → DeleteAndRepost (selectStrategy).
    const adapters = new Map<string, ChannelPort>([["signal", makeStubAdapter("signal")]]);
    const plugins = new Map<string, ChannelPluginPort>([
      ["signal", makeStubPlugin("signal", makeCaps({ deleteMessages: true }))],
    ]);

    const { timer, clock } = makeTime();
    const renderers = buildActivityRenderers(adapters, plugins, makeLogger(), { timer, clock });

    const factory = renderers.get("signal");
    expect(factory).toBeDefined();
    expect(renderers.size).toBe(1);
    expect(factory!("chat-1").strategy).toBe("DeleteAndRepost");
  });

  it("constructs an AppendOnly factory for BOTH iMessage and LINE (one strategy, two channelTypes)", () => {
    // No edit/delete + attachments + mid-range cap → AppendOnly. The strategy
    // serves TWO channelTypes: the dispatch map is keyed by both.
    const appendChannels = ["imessage", "line"] as const;
    const adapters = new Map<string, ChannelPort>(appendChannels.map((c) => [c, makeStubAdapter(c)]));
    const plugins = new Map<string, ChannelPluginPort>(
      appendChannels.map((c) => [c, makeStubPlugin(c, makeCaps({ attachments: true }, 20_000))]),
    );

    const { timer, clock } = makeTime();
    const renderers = buildActivityRenderers(adapters, plugins, makeLogger(), { timer, clock });

    expect(renderers.size).toBe(2);
    for (const c of appendChannels) {
      const factory = renderers.get(c);
      expect(factory, `factory for ${c}`).toBeDefined();
      expect(factory!("chan-1").strategy, `strategy for ${c}`).toBe("AppendOnly");
    }
  });

  it("constructs a LinePerEvent factory for IRC (maxMessageChars <= 512)", () => {
    // 512-char cap, no edit/delete → LinePerEvent.
    const adapters = new Map<string, ChannelPort>([["irc", makeStubAdapter("irc")]]);
    const plugins = new Map<string, ChannelPluginPort>([
      ["irc", makeStubPlugin("irc", makeCaps({}, 512))],
    ]);

    const { timer, clock } = makeTime();
    const renderers = buildActivityRenderers(adapters, plugins, makeLogger(), { timer, clock });

    const factory = renderers.get("irc");
    expect(factory).toBeDefined();
    expect(renderers.size).toBe(1);
    expect(factory!("#room").strategy).toBe("LinePerEvent");
  });

  it("constructs a DigestOnly factory for Email (largest cap)", () => {
    // >= the digest min cap, no edit/delete → DigestOnly.
    const adapters = new Map<string, ChannelPort>([["email", makeStubAdapter("email")]]);
    const plugins = new Map<string, ChannelPluginPort>([
      ["email", makeStubPlugin("email", makeCaps({}, 100_000))],
    ]);

    const { timer, clock } = makeTime();
    const renderers = buildActivityRenderers(adapters, plugins, makeLogger(), { timer, clock });

    const factory = renderers.get("email");
    expect(factory).toBeDefined();
    expect(renderers.size).toBe(1);
    expect(factory!("user@example.com").strategy).toBe("DigestOnly");
  });

  it("threads PER-CALL markers (not just the boot-time default) into the renderer it builds", async () => {
    // Previously, markers were baked once from the DEFAULT agent's theme and shared
    // across every per-turn renderer, so a non-default agent rendered with the
    // wrong theme. The factory must accept per-call markers (resolved per-agent in
    // the coordinatorFactory) that OVERRIDE the boot-time default. Drive an IRC
    // (LinePerEvent) closing line and assert it follows the per-call theme glyph.
    const sentLines: string[] = [];
    const recordingAdapter: ChannelPort = {
      ...makeStubAdapter("irc"),
      sendMessage: (async (_channelId: string, text: string) => {
        sentLines.push(text);
        return { ok: true, value: "msg-id" };
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- stub signature
      }) as any,
    };
    const adapters = new Map<string, ChannelPort>([["irc", recordingAdapter]]);
    const plugins = new Map<string, ChannelPluginPort>([
      ["irc", makeStubPlugin("irc", makeCaps({}, 512))],
    ]);

    const bootMarkers: ActivityStatusMarkers = themeForName("default").markers; // success "✓"
    const perCallMarkers: ActivityStatusMarkers = themeForName("ascii").markers; // success "[OK]"
    expect(bootMarkers.success).not.toBe(perCallMarkers.success);

    const { timer, clock } = makeTime();
    const renderers = buildActivityRenderers(adapters, plugins, makeLogger(), { timer, clock, markers: bootMarkers });
    const factory = renderers.get("irc");
    expect(factory).toBeDefined();

    // Build the renderer the way a NON-default-agent turn would: with per-call markers.
    const renderer = factory!("#room", perCallMarkers);
    const success: TurnOutcome = {
      kind: "success",
      trivial: false,
      delivery: { ok: true, deliveredChunks: 1, lastChunkMessageId: "m1", deliveredAtMs: 1 },
    };
    const result = await renderer.finalize(success);
    expect(result.ok).toBe(true);

    // The closing line must follow the PER-CALL ascii theme ("[OK] done"), NOT the
    // boot-time default ("✓ done"). Pre-fix, the factory ignored the second arg and
    // baked bootMarkers → this asserts RED on the default-only behavior.
    expect(sentLines.some((l) => l.startsWith(`${perCallMarkers.success} done`))).toBe(true);
    expect(sentLines.some((l) => l.startsWith(`${bootMarkers.success} done`))).toBe(false);
  });

  it("constructs all six live strategies for a full mixed adapter set", () => {
    // The complete §18.3 matrix: every channelType routes to a live factory.
    const adapters = new Map<string, ChannelPort>([
      ["echo", makeStubAdapter("echo")],
      ["telegram", makeStubAdapter("telegram")],
      ["signal", makeStubAdapter("signal")],
      ["imessage", makeStubAdapter("imessage")],
      ["line", makeStubAdapter("line")],
      ["irc", makeStubAdapter("irc")],
      ["email", makeStubAdapter("email")],
    ]);
    const plugins = new Map<string, ChannelPluginPort>([
      ["echo", makeStubPlugin("echo", makeCaps())],
      ["telegram", makeStubPlugin("telegram", makeCaps({ editMessages: true }))],
      ["signal", makeStubPlugin("signal", makeCaps({ deleteMessages: true }))],
      ["imessage", makeStubPlugin("imessage", makeCaps({ attachments: true }, 20_000))],
      ["line", makeStubPlugin("line", makeCaps({ attachments: true }, 20_000))],
      ["irc", makeStubPlugin("irc", makeCaps({}, 512))],
      ["email", makeStubPlugin("email", makeCaps({}, 100_000))],
    ]);

    const { timer, clock } = makeTime();
    const renderers = buildActivityRenderers(adapters, plugins, makeLogger(), { timer, clock });

    expect(renderers.size).toBe(7);
    expect(renderers.get("echo")!("c").strategy).toBe("TestSink");
    expect(renderers.get("telegram")!("c").strategy).toBe("EditPlace");
    expect(renderers.get("signal")!("c").strategy).toBe("DeleteAndRepost");
    expect(renderers.get("imessage")!("c").strategy).toBe("AppendOnly");
    expect(renderers.get("line")!("c").strategy).toBe("AppendOnly");
    expect(renderers.get("irc")!("c").strategy).toBe("LinePerEvent");
    expect(renderers.get("email")!("c").strategy).toBe("DigestOnly");
  });
});
