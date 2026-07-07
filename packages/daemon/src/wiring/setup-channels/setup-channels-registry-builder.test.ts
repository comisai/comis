// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for buildReadOnlyChannelRegistry.
 *
 * The helper builds a lightweight read-only ChannelRegistry over the
 * bootstrapped `channelPlugins` Map; the orchestrator uses it as the
 * single-source replyToMetaKey lookup after the REPLY_TO_META_KEY
 * hardcoded Record was deleted. These tests assert:
 *   - `getCapabilities` returns the plugin's capabilities (replyToMetaKey
 *     extraction is the load-bearing read path).
 *   - `getAdapter` returns the plugin's adapter.
 *   - Lifecycle methods (registerChannel / unregisterChannel) return an
 *     explicit `err()` so a caller that bypasses the canonical
 *     setup-channels-adapters bootstrap path fails loudly.
 */

import { describe, it, expect } from "vitest";
import type { ChannelPluginPort, ChannelCapability, ChannelPort } from "@comis/core";
import { buildChannelCredentialMap, buildReadOnlyChannelRegistry } from "./setup-channels-registry-builder.js";

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

describe("buildReadOnlyChannelRegistry", () => {
  it("getCapabilities returns the plugin capabilities (replyToMetaKey path)", () => {
    const caps: ChannelCapability = {
      features: {
        reactions: true,
        editMessages: false,
        deleteMessages: false,
        fetchHistory: false,
        attachments: false,
      },
      limits: { maxMessageChars: 4096 },
      replyToMetaKey: "telegramMessageId",
    };
    const plugins = new Map<string, ChannelPluginPort>([
      ["telegram", makeStubPlugin("telegram", caps)],
    ]);
    const registry = buildReadOnlyChannelRegistry(plugins);
    expect(registry.getCapabilities("telegram")).toBe(caps);
    expect(registry.getCapabilities("telegram")?.replyToMetaKey).toBe("telegramMessageId");
  });

  it("getCapabilities returns undefined for unknown channels", () => {
    const plugins = new Map<string, ChannelPluginPort>();
    const registry = buildReadOnlyChannelRegistry(plugins);
    expect(registry.getCapabilities("unknown")).toBeUndefined();
  });

  it("getAdapter returns the plugin adapter for the channel type", () => {
    const caps: ChannelCapability = {
      features: { reactions: false, editMessages: false, deleteMessages: false, fetchHistory: false, attachments: false },
      limits: { maxMessageChars: 4096 },
    };
    const plugin = makeStubPlugin("discord", caps);
    const plugins = new Map([["discord", plugin]]);
    const registry = buildReadOnlyChannelRegistry(plugins);
    expect(registry.getAdapter("discord")).toBe(plugin.adapter);
    expect(registry.getAdapter("unknown")).toBeUndefined();
  });

  it("getChannelTypes returns the keys of the channelPlugins Map", () => {
    const caps: ChannelCapability = {
      features: { reactions: false, editMessages: false, deleteMessages: false, fetchHistory: false, attachments: false },
      limits: { maxMessageChars: 4096 },
    };
    const plugins = new Map([
      ["telegram", makeStubPlugin("telegram", caps)],
      ["discord", makeStubPlugin("discord", caps)],
    ]);
    const registry = buildReadOnlyChannelRegistry(plugins);
    expect(new Set(registry.getChannelTypes())).toEqual(new Set(["telegram", "discord"]));
  });

  it("getChannelPlugins returns the values of the channelPlugins Map", () => {
    const caps: ChannelCapability = {
      features: { reactions: false, editMessages: false, deleteMessages: false, fetchHistory: false, attachments: false },
      limits: { maxMessageChars: 4096 },
    };
    const p1 = makeStubPlugin("telegram", caps);
    const p2 = makeStubPlugin("discord", caps);
    const plugins = new Map([["telegram", p1], ["discord", p2]]);
    const registry = buildReadOnlyChannelRegistry(plugins);
    expect(new Set(registry.getChannelPlugins())).toEqual(new Set([p1, p2]));
  });

  it("registerChannel returns err to prevent silent mutation at the read-only seam", () => {
    const registry = buildReadOnlyChannelRegistry(new Map());
    const caps: ChannelCapability = {
      features: { reactions: false, editMessages: false, deleteMessages: false, fetchHistory: false, attachments: false },
      limits: { maxMessageChars: 4096 },
    };
    const result = registry.registerChannel(makeStubPlugin("echo", caps));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toMatch(/read-only/);
    }
  });

  it("unregisterChannel returns err to prevent silent mutation at the read-only seam", () => {
    const registry = buildReadOnlyChannelRegistry(new Map());
    const result = registry.unregisterChannel("echo");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toMatch(/read-only/);
    }
  });
});

describe("buildChannelCredentialMap", () => {
  it("maps MSTEAMS_APP_PASSWORD to msteams when the msteams channel is enabled", () => {
    // Enables targeted reconnect when the Teams app-password secret changes.
    const m = buildChannelCredentialMap({ msteams: { enabled: true } });
    expect(m.get("MSTEAMS_APP_PASSWORD")).toBe("msteams");
  });

  it("omits the msteams credential entry when msteams is disabled or absent", () => {
    expect(buildChannelCredentialMap({ msteams: { enabled: false } }).has("MSTEAMS_APP_PASSWORD")).toBe(false);
    expect(buildChannelCredentialMap({}).has("MSTEAMS_APP_PASSWORD")).toBe(false);
  });

  it("maps GOOGLECHAT_SA_KEY to googlechat when the googlechat channel is enabled", () => {
    // The adapter reads the service-account key once at setup and mints JWTs
    // from it in memory — without this entry a rotated key never triggers the
    // targeted reconnect, and the adapter keeps signing with the stale key
    // until a manual daemon restart.
    const m = buildChannelCredentialMap({ googlechat: { enabled: true } });
    expect(m.get("GOOGLECHAT_SA_KEY")).toBe("googlechat");
  });

  it("omits the googlechat credential entry when googlechat is disabled or absent", () => {
    expect(buildChannelCredentialMap({ googlechat: { enabled: false } }).has("GOOGLECHAT_SA_KEY")).toBe(false);
    expect(buildChannelCredentialMap({}).has("GOOGLECHAT_SA_KEY")).toBe(false);
  });
});
