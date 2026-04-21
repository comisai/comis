// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { resolveNotificationChannel, type ChannelResolverDeps } from "./channel-resolver.js";

function makeDeps(overrides: Partial<ChannelResolverDeps> = {}): ChannelResolverDeps {
  return {
    activeAdapterTypes: overrides.activeAdapterTypes ?? new Set(["telegram", "discord"]),
    getRecentSessionChannel: overrides.getRecentSessionChannel ?? (() => undefined),
    getMostRecentSession: overrides.getMostRecentSession ?? (() => undefined),
  };
}

describe("resolveNotificationChannel", () => {
  it("level 1: explicit channelType + channelId returns them directly", () => {
    const deps = makeDeps();
    const result = resolveNotificationChannel(deps, {
      agentId: "a1",
      channelType: "telegram",
      channelId: "chat-123",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.channelType).toBe("telegram");
      expect(result.value.channelId).toBe("chat-123");
      expect(result.value.resolution).toBe("explicit");
    }
  });

  it("level 2: channelType only + matching adapter returns channelId from recent session", () => {
    const deps = makeDeps({
      getRecentSessionChannel: (agentId, channelType) =>
        agentId === "a1" && channelType === "telegram" ? "session-chat" : undefined,
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
    const deps = makeDeps();
    const result = resolveNotificationChannel(deps, {
      agentId: "a1",
      primaryChannel: { channelType: "discord", channelId: "guild-456" },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.channelType).toBe("discord");
      expect(result.value.channelId).toBe("guild-456");
      expect(result.value.resolution).toBe("primary_channel");
    }
  });

  it("level 4: no explicit, no primaryChannel, recent session exists returns session's channel", () => {
    const deps = makeDeps({
      getMostRecentSession: () => ({ channelType: "telegram", channelId: "recent-chat" }),
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
    const deps = makeDeps();
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
    const deps = makeDeps();
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
    }
  });
});
