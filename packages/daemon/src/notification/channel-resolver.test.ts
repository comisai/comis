// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from "vitest";
import { resolveNotificationChannel, type ChannelResolverDeps } from "./channel-resolver.js";

function endpoint(channelType: string, conversationId: string) {
  return {
    channelType,
    channelInstanceId: `${channelType}-account`,
    conversationId,
    conversationKind: "direct" as const,
  };
}

function makeDeps(overrides: Partial<ChannelResolverDeps> = {}): ChannelResolverDeps {
  return {
    activeAdapterTypes: overrides.activeAdapterTypes ?? new Set(["telegram", "discord"]),
    getRecentSessionEndpoint: overrides.getRecentSessionEndpoint ?? (() => undefined),
    getMostRecentSessionEndpoint: overrides.getMostRecentSessionEndpoint ?? (() => undefined),
    findSessionEndpoint: overrides.findSessionEndpoint ?? (() => undefined),
  };
}

describe("resolveNotificationChannel", () => {
  it("level 1 resolves explicit coordinates from a tracked endpoint", () => {
    const selectedEndpoint = endpoint("telegram", "chat-123");
    const deps = makeDeps({ findSessionEndpoint: () => selectedEndpoint });
    const result = resolveNotificationChannel(deps, {
      agentId: "a1",
      channelType: "telegram",
      channelId: "chat-123",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.channelType).toBe("telegram");
      expect(result.value.channelId).toBe("chat-123");
      expect(result.value.endpoint).toEqual(selectedEndpoint);
      expect(result.value.resolution).toBe("explicit");
    }
  });

  it("level 2: channelType only + matching adapter returns channelId from recent session", () => {
    const deps = makeDeps({
      getRecentSessionEndpoint: (agentId, channelType) =>
        agentId === "a1" && channelType === "telegram"
          ? endpoint("telegram", "session-chat")
          : undefined,
    });
    const result = resolveNotificationChannel(deps, {
      agentId: "a1",
      channelType: "telegram",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.channelType).toBe("telegram");
      expect(result.value.channelId).toBe("session-chat");
      expect(result.value.resolution).toBe("platform_match");
    }
  });

  it("level 3: no explicit channel, primaryChannel configured returns primaryChannel", () => {
    const selectedEndpoint = endpoint("discord", "guild-456");
    const deps = makeDeps({ findSessionEndpoint: () => selectedEndpoint });
    const result = resolveNotificationChannel(deps, {
      agentId: "a1",
      primaryChannel: { channelType: "discord", channelId: "guild-456" },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.channelType).toBe("discord");
      expect(result.value.channelId).toBe("guild-456");
      expect(result.value.endpoint).toEqual(selectedEndpoint);
      expect(result.value.resolution).toBe("primary_channel");
    }
  });

  it("level 4: no explicit, no primaryChannel, recent session exists returns session's channel", () => {
    const deps = makeDeps({
      getMostRecentSessionEndpoint: () => endpoint("telegram", "recent-chat"),
    });
    const result = resolveNotificationChannel(deps, { agentId: "a1" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.channelType).toBe("telegram");
      expect(result.value.channelId).toBe("recent-chat");
      expect(result.value.resolution).toBe("recent_session");
    }
  });

  it("returns err with 'no_channel' reason when all four levels fail", () => {
    const selectedEndpoint = endpoint("telegram", "explicit-chat");
    const deps = makeDeps({ findSessionEndpoint: () => selectedEndpoint });
    const result = resolveNotificationChannel(deps, { agentId: "a1" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.reason).toBe("no_channel");
      expect(result.error.attempted).toContain("explicit");
      expect(result.error.attempted).toContain("platform_match");
      expect(result.error.attempted).toContain("primary_channel");
      expect(result.error.attempted).toContain("recent_session");
    }
  });

  it("explicit wins over primaryChannel (priority order)", () => {
    const selectedEndpoint = endpoint("telegram", "explicit-chat");
    const deps = makeDeps({ findSessionEndpoint: () => selectedEndpoint });
    const result = resolveNotificationChannel(deps, {
      agentId: "a1",
      channelType: "telegram",
      channelId: "explicit-chat",
      primaryChannel: { channelType: "discord", channelId: "primary-guild" },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.resolution).toBe("explicit");
      expect(result.value.channelType).toBe("telegram");
      expect(result.value.channelId).toBe("explicit-chat");
      expect(result.value.endpoint).toEqual(selectedEndpoint);
    }
  });

  it("rejects explicit coordinates without tracked endpoint authority", () => {
    const result = resolveNotificationChannel(makeDeps(), {
      agentId: "a1",
      channelType: "telegram",
      channelId: "chat-123",
    });

    expect(result).toEqual({
      ok: false,
      error: { reason: "no_channel", attempted: ["explicit_endpoint"] },
    });
  });

  it("resolves a caller-supplied destination from tracked endpoint authority", () => {
    const trackedEndpoint = {
      ...endpoint("telegram", "chat-123"),
      threadId: "thread-a",
      conversationKind: "shared" as const,
    };
    const findSessionEndpoint = vi.fn(() => trackedEndpoint);
    const result = resolveNotificationChannel(makeDeps({ findSessionEndpoint }), {
      agentId: "a1",
      channelType: "telegram",
      channelId: "chat-123",
      destinationEndpoint: { ...trackedEndpoint },
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.endpoint).toBe(trackedEndpoint);
    expect(findSessionEndpoint).toHaveBeenCalledWith("a1", "telegram", "chat-123");
  });

  it.each([
    ["channel instance", { channelInstanceId: "caller-minted-account" }],
    ["conversation", { conversationId: "caller-minted-chat" }],
    ["thread", { threadId: "caller-minted-thread" }],
    ["conversation kind", { conversationKind: "direct" as const }],
  ])("rejects caller-minted %s authority", (_field, override) => {
    const trackedEndpoint = {
      ...endpoint("telegram", "chat-123"),
      threadId: "thread-a",
      conversationKind: "shared" as const,
    };
    const result = resolveNotificationChannel(makeDeps({
      findSessionEndpoint: () => trackedEndpoint,
    }), {
      agentId: "a1",
      destinationEndpoint: { ...trackedEndpoint, ...override },
    });

    expect(result).toEqual({
      ok: false,
      error: { reason: "no_channel", attempted: ["destination_endpoint"] },
    });
  });
});
