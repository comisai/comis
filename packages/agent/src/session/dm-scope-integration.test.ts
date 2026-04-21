// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import type { NormalizedMessage } from "@comis/core";
import { formatSessionKey, parseFormattedSessionKey } from "@comis/core";
import { buildScopedSessionKey, extractThreadId } from "./session-key-builder.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDmMessage(overrides?: Partial<NormalizedMessage>): NormalizedMessage {
  return {
    id: "00000000-0000-0000-0000-000000000001",
    channelType: "telegram",
    channelId: "chat-456",
    senderId: "user-123",
    text: "hello",
    timestamp: Date.now(),
    attachments: [],
    metadata: {},
    ...overrides,
  };
}

function makeGroupMessage(overrides?: Partial<NormalizedMessage>): NormalizedMessage {
  return {
    id: "00000000-0000-0000-0000-000000000002",
    channelType: "discord",
    channelId: "channel-789",
    senderId: "user-123",
    text: "hello group",
    timestamp: Date.now(),
    attachments: [],
    metadata: { guildId: "guild-abc" },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// DM Scope Integration Tests
// ---------------------------------------------------------------------------

describe("DM Scope Integration", () => {
  // Test 1: Default parameters
  it("default params produce standard session key format", () => {
    const msg = makeDmMessage();
    const key = buildScopedSessionKey({
      msg,
      agentId: "agent-1",
      adapterChannelId: "bot-1",
    });
    const formatted = formatSessionKey(key);
    expect(formatted).toBe("default:user-123:chat-456:peer:user-123");
  });

  // Test 2: main mode
  it("main mode: single shared session for all DMs", () => {
    const msg = makeDmMessage();
    const key = buildScopedSessionKey({
      msg,
      agentId: "agent-1",
      adapterChannelId: "bot-1",
      dmScopeMode: "main",
    });
    const formatted = formatSessionKey(key);
    expect(formatted).toBe("default:main:dm");
  });

  // Test 3: per-peer mode
  it("per-peer mode: per-peer sessions across all channels", () => {
    const msg = makeDmMessage();
    const key = buildScopedSessionKey({
      msg,
      agentId: "agent-1",
      adapterChannelId: "bot-1",
      dmScopeMode: "per-peer",
    });
    const formatted = formatSessionKey(key);
    expect(formatted).toBe("default:user-123:dm:peer:user-123");
  });

  // Test 4: per-channel-peer mode
  it("per-channel-peer mode: per-channel per-peer sessions", () => {
    const msg = makeDmMessage();
    const key = buildScopedSessionKey({
      msg,
      agentId: "agent-1",
      adapterChannelId: "bot-1",
      dmScopeMode: "per-channel-peer",
    });
    const formatted = formatSessionKey(key);
    expect(formatted).toBe("default:user-123:chat-456:peer:user-123");
  });

  // Test 5: per-account-channel-peer mode
  it("per-account-channel-peer mode: includes adapter channel ID", () => {
    const msg = makeDmMessage();
    const key = buildScopedSessionKey({
      msg,
      agentId: "agent-1",
      adapterChannelId: "bot-1",
      dmScopeMode: "per-account-channel-peer",
    });
    const formatted = formatSessionKey(key);
    expect(formatted).toBe("default:user-123:bot-1:chat-456:peer:user-123");
  });

  // Test 6: Group bypass
  it("group messages always use per-channel-peer regardless of scope mode", () => {
    const msg = makeGroupMessage();
    const key = buildScopedSessionKey({
      msg,
      agentId: "agent-1",
      adapterChannelId: "bot-1",
      dmScopeMode: "main", // "main" should be ignored for groups
    });
    const formatted = formatSessionKey(key);
    expect(formatted).toBe("default:user-123:channel-789:peer:user-123:guild:guild-abc");
  });

  // Test 7: Agent prefix roundtrip
  it("agent prefix roundtrip: format and parse recovers agentId", () => {
    const msg = makeDmMessage();
    const key = buildScopedSessionKey({
      msg,
      agentId: "dash",
      adapterChannelId: "bot-1",
      agentPrefixEnabled: true,
    });
    const formatted = formatSessionKey(key);
    expect(formatted).toMatch(/^agent:dash:/);

    const parsed = parseFormattedSessionKey(formatted);
    expect(parsed).toBeDefined();
    expect(parsed!.agentId).toBe("dash");
    expect(parsed!.tenantId).toBe("default");
    expect(parsed!.userId).toBe("user-123");
  });

  // Test 8: Thread isolation roundtrip
  it("thread isolation roundtrip: format and parse recovers threadId", () => {
    const msg = makeDmMessage();
    const key = buildScopedSessionKey({
      msg,
      agentId: "agent-1",
      adapterChannelId: "bot-1",
      threadId: "thread-789",
    });
    const formatted = formatSessionKey(key);
    expect(formatted).toContain(":thread:thread-789");

    const parsed = parseFormattedSessionKey(formatted);
    expect(parsed).toBeDefined();
    expect(parsed!.threadId).toBe("thread-789");
  });

  // Test 9: Full roundtrip (agent prefix + peer + guild + thread)
  it("full roundtrip: agent prefix + guild + thread all recovered", () => {
    const msg = makeGroupMessage();
    const key = buildScopedSessionKey({
      msg,
      agentId: "dash",
      adapterChannelId: "bot-1",
      agentPrefixEnabled: true,
      threadId: "thread-999",
    });
    const formatted = formatSessionKey(key);
    const parsed = parseFormattedSessionKey(formatted);

    expect(parsed).toBeDefined();
    expect(parsed!.agentId).toBe("dash");
    expect(parsed!.tenantId).toBe("default");
    expect(parsed!.userId).toBe("user-123");
    expect(parsed!.channelId).toBe("channel-789");
    expect(parsed!.peerId).toBe("user-123");
    expect(parsed!.guildId).toBe("guild-abc");
    expect(parsed!.threadId).toBe("thread-999");
  });

  // Test 10: extractThreadId - Discord
  it("extractThreadId returns channelId for Discord threads (parentChannelId set)", () => {
    const msg = makeDmMessage({
      channelType: "discord",
      channelId: "thread-channel-123",
      metadata: { parentChannelId: "parent-456" },
    });
    expect(extractThreadId(msg)).toBe("thread-channel-123");
  });

  // Test 11: extractThreadId - Slack
  it("extractThreadId returns slackThreadTs as string", () => {
    const msg = makeDmMessage({
      channelType: "slack",
      metadata: { slackThreadTs: "1706789012.123456" },
    });
    expect(extractThreadId(msg)).toBe("1706789012.123456");
  });

  // Test 12: extractThreadId - Telegram
  it("extractThreadId returns telegramThreadId as string", () => {
    const msg = makeDmMessage({
      channelType: "telegram",
      metadata: { telegramThreadId: 42 },
    });
    expect(extractThreadId(msg)).toBe("42");
  });

  // Test 13: extractThreadId - no thread
  it("extractThreadId returns undefined when no thread metadata present", () => {
    const msg = makeDmMessage({ metadata: {} });
    expect(extractThreadId(msg)).toBeUndefined();
  });

  // Test 14: Identity linking simulation
  it("identity linking: canonical ID used as userId in session key", () => {
    // Simulate what channel-manager does: replace senderId with canonical ID
    const msg = makeDmMessage({ senderId: "canonical-uuid-abc" });
    const key = buildScopedSessionKey({
      msg,
      agentId: "agent-1",
      adapterChannelId: "bot-1",
    });
    const formatted = formatSessionKey(key);
    expect(formatted).toBe("default:canonical-uuid-abc:chat-456:peer:canonical-uuid-abc");
  });
});
