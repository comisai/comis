import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { NormalizedMessage } from "@comis/core";
import { buildScopedSessionKey, extractThreadId } from "./session-key-builder.js";

function makeMsg(overrides: Partial<NormalizedMessage> = {}): NormalizedMessage {
  return {
    id: randomUUID(),
    channelId: "chan-123",
    channelType: "telegram",
    senderId: "user-42",
    text: "hello",
    timestamp: Date.now(),
    attachments: [],
    metadata: {},
    ...overrides,
  };
}

describe("buildScopedSessionKey", () => {
  describe("default key format", () => {
    it("default config produces standard key format", () => {
      const msg = makeMsg();
      const key = buildScopedSessionKey({
        msg,
        agentId: "default",
        adapterChannelId: "bot-1",
      });
      // Default: { tenantId: "default", userId: senderId, channelId: channelId, peerId: senderId }
      expect(key).toEqual({
        tenantId: "default",
        userId: "user-42",
        channelId: "chan-123",
        peerId: "user-42",
      });
    });
  });

  describe("DM scope modes", () => {
    it("main mode: shared session for all DMs", () => {
      const msg = makeMsg();
      const key = buildScopedSessionKey({
        msg,
        agentId: "default",
        adapterChannelId: "bot-1",
        dmScopeMode: "main",
      });
      expect(key.userId).toBe("main");
      expect(key.channelId).toBe("dm");
      expect(key.peerId).toBeUndefined();
      expect(key.tenantId).toBe("default");
    });

    it("per-peer mode: per-peer across all channels", () => {
      const msg = makeMsg();
      const key = buildScopedSessionKey({
        msg,
        agentId: "default",
        adapterChannelId: "bot-1",
        dmScopeMode: "per-peer",
      });
      expect(key.userId).toBe("user-42");
      expect(key.channelId).toBe("dm");
      expect(key.peerId).toBe("user-42");
    });

    it("per-channel-peer mode: per-channel per-peer", () => {
      const msg = makeMsg();
      const key = buildScopedSessionKey({
        msg,
        agentId: "default",
        adapterChannelId: "bot-1",
        dmScopeMode: "per-channel-peer",
      });
      expect(key.userId).toBe("user-42");
      expect(key.channelId).toBe("chan-123");
      expect(key.peerId).toBe("user-42");
    });

    it("per-account-channel-peer mode: includes adapterChannelId in channelId", () => {
      const msg = makeMsg();
      const key = buildScopedSessionKey({
        msg,
        agentId: "default",
        adapterChannelId: "bot-999",
        dmScopeMode: "per-account-channel-peer",
      });
      expect(key.userId).toBe("user-42");
      expect(key.channelId).toBe("bot-999:chan-123");
      expect(key.peerId).toBe("user-42");
    });
  });

  describe("group message bypass", () => {
    it("group messages always use per-channel-peer regardless of scope mode", () => {
      const groupMsg = makeMsg({ metadata: { guildId: "guild-7" } });
      const modes = ["main", "per-peer", "per-channel-peer", "per-account-channel-peer"] as const;

      for (const mode of modes) {
        const key = buildScopedSessionKey({
          msg: groupMsg,
          agentId: "default",
          adapterChannelId: "bot-1",
          dmScopeMode: mode,
        });
        expect(key.userId).toBe("user-42");
        expect(key.channelId).toBe("chan-123");
        expect(key.peerId).toBe("user-42");
        expect(key.guildId).toBe("guild-7");
      }
    });

    it("detects group via isGroup metadata", () => {
      const groupMsg = makeMsg({ metadata: { isGroup: true } });
      const key = buildScopedSessionKey({
        msg: groupMsg,
        agentId: "default",
        adapterChannelId: "bot-1",
        dmScopeMode: "main",
      });
      // Should use per-channel-peer, not main
      expect(key.userId).toBe("user-42");
      expect(key.channelId).toBe("chan-123");
      expect(key.peerId).toBe("user-42");
    });

    it("detects group via telegramChatType=group", () => {
      const groupMsg = makeMsg({ metadata: { telegramChatType: "group" } });
      const key = buildScopedSessionKey({
        msg: groupMsg,
        agentId: "default",
        adapterChannelId: "bot-1",
        dmScopeMode: "main",
      });
      expect(key.userId).toBe("user-42");
      expect(key.peerId).toBe("user-42");
    });

    it("detects group via telegramChatType=supergroup", () => {
      const groupMsg = makeMsg({ metadata: { telegramChatType: "supergroup" } });
      const key = buildScopedSessionKey({
        msg: groupMsg,
        agentId: "default",
        adapterChannelId: "bot-1",
        dmScopeMode: "main",
      });
      expect(key.userId).toBe("user-42");
      expect(key.peerId).toBe("user-42");
    });
  });

  describe("agent prefix", () => {
    it("sets agentId when agentPrefixEnabled is true", () => {
      const msg = makeMsg();
      const key = buildScopedSessionKey({
        msg,
        agentId: "dash",
        adapterChannelId: "bot-1",
        agentPrefixEnabled: true,
      });
      expect(key.agentId).toBe("dash");
    });

    it("does not set agentId when agentPrefixEnabled is false (default)", () => {
      const msg = makeMsg();
      const key = buildScopedSessionKey({
        msg,
        agentId: "dash",
        adapterChannelId: "bot-1",
      });
      expect(key.agentId).toBeUndefined();
    });
  });

  describe("thread ID", () => {
    it("sets threadId when provided", () => {
      const msg = makeMsg();
      const key = buildScopedSessionKey({
        msg,
        agentId: "default",
        adapterChannelId: "bot-1",
        threadId: "thread-abc",
      });
      expect(key.threadId).toBe("thread-abc");
    });

    it("does not set threadId when not provided", () => {
      const msg = makeMsg();
      const key = buildScopedSessionKey({
        msg,
        agentId: "default",
        adapterChannelId: "bot-1",
      });
      expect(key.threadId).toBeUndefined();
    });
  });

  describe("custom tenantId", () => {
    it("uses provided tenantId", () => {
      const msg = makeMsg();
      const key = buildScopedSessionKey({
        msg,
        agentId: "default",
        adapterChannelId: "bot-1",
        tenantId: "acme",
      });
      expect(key.tenantId).toBe("acme");
    });
  });
});

describe("extractThreadId", () => {
  it("returns channelId when parentChannelId is in metadata (Discord thread)", () => {
    const msg = makeMsg({
      channelId: "thread-chan-1",
      metadata: { parentChannelId: "parent-chan-1" },
    });
    expect(extractThreadId(msg)).toBe("thread-chan-1");
  });

  it("returns slackThreadTs as string when present", () => {
    const msg = makeMsg({
      metadata: { slackThreadTs: "1234567890.123456" },
    });
    expect(extractThreadId(msg)).toBe("1234567890.123456");
  });

  it("returns telegramThreadId as string when present", () => {
    const msg = makeMsg({
      metadata: { telegramThreadId: 42 },
    });
    expect(extractThreadId(msg)).toBe("42");
  });

  it("returns undefined when no thread metadata is present", () => {
    const msg = makeMsg();
    expect(extractThreadId(msg)).toBeUndefined();
  });

  it("prioritizes Discord parentChannelId over Slack/Telegram", () => {
    const msg = makeMsg({
      channelId: "discord-thread",
      metadata: {
        parentChannelId: "parent",
        slackThreadTs: "ts",
        telegramThreadId: 99,
      },
    });
    expect(extractThreadId(msg)).toBe("discord-thread");
  });
});
