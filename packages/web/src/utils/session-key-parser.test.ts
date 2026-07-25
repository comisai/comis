// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  parseSessionKeyString,
  formatSessionDisplayName,
  computeSessionStatus,
  type ParsedSessionKey,
} from "./session-key-parser.js";

describe("parseSessionKeyString", () => {
  it("parses the current agent-scoped key", () => {
    const result = parseSessionKeyString("myTenant:agent:bot-a:user123:discord");
    expect(result).toEqual({
      tenantId: "myTenant",
      agentId: "bot-a",
      userId: "user123",
      channelId: "discord",
    });
  });

  it("parses a key with optional peer segment", () => {
    const result = parseSessionKeyString("myTenant:agent:bot-a:user123:telegram:peer:chat456");
    expect(result).toEqual({
      tenantId: "myTenant",
      agentId: "bot-a",
      userId: "user123",
      channelId: "telegram",
      peerId: "chat456",
    });
  });

  it("parses a key with optional guild segment", () => {
    const result = parseSessionKeyString("myTenant:agent:bot-a:user123:discord:guild:server789");
    expect(result).toEqual({
      tenantId: "myTenant",
      agentId: "bot-a",
      userId: "user123",
      channelId: "discord",
      guildId: "server789",
    });
  });

  it("parses a key with optional thread segment", () => {
    const result = parseSessionKeyString("myTenant:agent:bot-a:user123:slack:thread:t001");
    expect(result).toEqual({
      tenantId: "myTenant",
      agentId: "bot-a",
      userId: "user123",
      channelId: "slack",
      threadId: "t001",
    });
  });

  it("parses a key with all optional segments", () => {
    const result = parseSessionKeyString(
      "myTenant:agent:bot-a:user123:telegram:peer:chat456:guild:g789:thread:t001",
    );
    expect(result).toEqual({
      tenantId: "myTenant",
      agentId: "bot-a",
      userId: "user123",
      channelId: "telegram",
      peerId: "chat456",
      guildId: "g789",
      threadId: "t001",
    });
  });

  it("returns undefined for empty string", () => {
    expect(parseSessionKeyString("")).toBeUndefined();
  });

  it("returns undefined for invalid input with too few parts", () => {
    expect(parseSessionKeyString("only:two")).toBeUndefined();
  });

  it("returns undefined for non-string input", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(parseSessionKeyString(null as any)).toBeUndefined();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(parseSessionKeyString(undefined as any)).toBeUndefined();
  });

  it("preserves colon-bearing channel and suffix values", () => {
    expect(parseSessionKeyString(
      "tenant:agent:bot:user:channel:region:peer:p:part:guild:g:part:thread:t:part",
    )).toEqual({
      tenantId: "tenant",
      agentId: "bot",
      userId: "user",
      channelId: "channel:region",
      peerId: "p:part",
      guildId: "g:part",
      threadId: "t:part",
    });
  });

  it("rejects missing markers and unordered suffixes", () => {
    expect(parseSessionKeyString("tenant:user:channel")).toBeUndefined();
    expect(parseSessionKeyString("tenant:agent:bot:user:channel:thread:t:peer:p"))
      .toBeUndefined();
    expect(parseSessionKeyString("tenant:agent:bot:user:peer:p")).toBeUndefined();
  });
});

describe("formatSessionDisplayName", () => {
  it("returns userId directly when 16 chars or less", () => {
    const key: ParsedSessionKey = { tenantId: "t", agentId: "a", userId: "short_user", channelId: "ch" };
    expect(formatSessionDisplayName(key)).toBe("short_user");
  });

  it("returns userId directly when exactly 16 chars", () => {
    const key: ParsedSessionKey = { tenantId: "t", agentId: "a", userId: "1234567890123456", channelId: "ch" };
    expect(formatSessionDisplayName(key)).toBe("1234567890123456");
  });

  it("truncates userId to 14 chars + '...' when longer than 16", () => {
    const key: ParsedSessionKey = { tenantId: "t", agentId: "a", userId: "12345678901234567", channelId: "ch" };
    expect(formatSessionDisplayName(key)).toBe("12345678901234...");
  });

  it("truncates very long userId", () => {
    const key: ParsedSessionKey = { tenantId: "t", agentId: "a", userId: "a".repeat(50), channelId: "ch" };
    const result = formatSessionDisplayName(key);
    expect(result).toBe("a".repeat(14) + "...");
    expect(result.length).toBe(17);
  });
});

describe("computeSessionStatus", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns 'active' when last active less than 5 minutes ago", () => {
    const now = Date.now();
    // 2 minutes ago
    expect(computeSessionStatus(now - 2 * 60 * 1000)).toBe("active");
  });

  it("returns 'active' when last active exactly now", () => {
    expect(computeSessionStatus(Date.now())).toBe("active");
  });

  it("returns 'idle' when last active between 5 minutes and 1 hour ago", () => {
    const now = Date.now();
    // 30 minutes ago
    expect(computeSessionStatus(now - 30 * 60 * 1000)).toBe("idle");
  });

  it("returns 'idle' at exactly 5 minutes boundary", () => {
    const now = Date.now();
    // Exactly 5 minutes ago -- 5*60*1000 elapsed is not < threshold, so idle
    expect(computeSessionStatus(now - 5 * 60 * 1000)).toBe("idle");
  });

  it("returns 'expired' when last active 1 hour or more ago", () => {
    const now = Date.now();
    // 2 hours ago
    expect(computeSessionStatus(now - 2 * 60 * 60 * 1000)).toBe("expired");
  });

  it("returns 'expired' at exactly 1 hour boundary", () => {
    const now = Date.now();
    // Exactly 1 hour ago -- 60*60*1000 elapsed is not < threshold, so expired
    expect(computeSessionStatus(now - 60 * 60 * 1000)).toBe("expired");
  });

  it("returns 'idle' just under 1 hour", () => {
    const now = Date.now();
    // 59 minutes 59 seconds ago
    expect(computeSessionStatus(now - (60 * 60 * 1000 - 1000))).toBe("idle");
  });
});
