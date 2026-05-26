// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for buildActivityRenderers (WIRE-02, §17.7).
 *
 * The helper routes each registered channel's declared ChannelCapability to a
 * rendering strategy via selectStrategy(caps, channelType) and constructs the
 * matching renderer. In Phase 70 only Echo→TestSink is live end-to-end (TestSink
 * needs no platform ActivityRenderActions); the other strategies are selected but
 * not constructed (their per-channel adapters land in Phases 71-72). These tests
 * assert: the live TestSink mapping, deferred non-TestSink strategies absent from
 * the map, and no-capability channels skipped.
 *
 * @module
 */
import { describe, it, expect, vi } from "vitest";
import type { ChannelPort, ChannelPluginPort, ChannelCapability } from "@comis/core";
import type { ComisLogger } from "@comis/infra";
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

describe("buildActivityRenderers (WIRE-02)", () => {
  it("constructs a live TestSink renderer for the Echo channel and exposes it keyed by channelType", () => {
    const adapters = new Map<string, ChannelPort>([["echo", makeStubAdapter("echo")]]);
    const plugins = new Map<string, ChannelPluginPort>([["echo", makeStubPlugin("echo", makeCaps())]]);

    const renderers = buildActivityRenderers(adapters, plugins, makeLogger());

    const echo = renderers.get("echo");
    expect(echo).toBeDefined();
    // The TestSink recorder identity (Echo terminus) — apply/finalize are present.
    expect(echo?.strategy).toBe("TestSink");
    expect(typeof echo?.apply).toBe("function");
    expect(typeof echo?.finalize).toBe("function");
  });

  it("omits a non-TestSink strategy (EditPlace) from the live map until its Phase 71-72 adapter lands", () => {
    // editMessages → EditPlace; that strategy needs a per-channel
    // ActivityRenderActions adapter (Phase 71-72), so it is selected but not
    // constructed in Phase 70.
    const adapters = new Map<string, ChannelPort>([["telegram", makeStubAdapter("telegram")]]);
    const plugins = new Map<string, ChannelPluginPort>([
      ["telegram", makeStubPlugin("telegram", makeCaps({ editMessages: true }))],
    ]);

    const renderers = buildActivityRenderers(adapters, plugins, makeLogger());

    expect(renderers.has("telegram")).toBe(false);
    expect(renderers.size).toBe(0);
  });

  it("skips an adapter whose plugin declares no capabilities and logs no renderer for it", () => {
    const adapters = new Map<string, ChannelPort>([["ghost", makeStubAdapter("ghost")]]);
    // Plugin present but no capabilities field.
    const plugins = new Map<string, ChannelPluginPort>([
      ["ghost", { ...makeStubPlugin("ghost", makeCaps()), capabilities: undefined as unknown as ChannelCapability }],
    ]);

    const renderers = buildActivityRenderers(adapters, plugins, makeLogger());

    expect(renderers.has("ghost")).toBe(false);
    expect(renderers.size).toBe(0);
  });

  it("builds renderers only for the Echo channel when a mixed adapter set is registered", () => {
    const adapters = new Map<string, ChannelPort>([
      ["echo", makeStubAdapter("echo")],
      ["telegram", makeStubAdapter("telegram")],
    ]);
    const plugins = new Map<string, ChannelPluginPort>([
      ["echo", makeStubPlugin("echo", makeCaps())],
      ["telegram", makeStubPlugin("telegram", makeCaps({ editMessages: true }))],
    ]);

    const renderers = buildActivityRenderers(adapters, plugins, makeLogger());

    expect(renderers.size).toBe(1);
    expect(renderers.get("echo")?.strategy).toBe("TestSink");
  });
});
