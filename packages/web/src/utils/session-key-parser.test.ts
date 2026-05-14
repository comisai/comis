// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  parseSessionKeyString,
  formatSessionDisplayName,
  computeSessionStatus,
  type ParsedSessionKey,
} from "./session-key-parser.js";

describe("parseSessionKeyString", () => {
  // CR-01 follow-up to BC-REM-15 (Phase 38): the browser parser no longer
  // recognizes the legacy `agent:<agentId>:` prefix. The daemon parser
  // dropped it in BC-REM-15, and the daemon emitter dropped it in the
  // CR-01 follow-up. This parser mirrors the daemon.

  it("parses a basic 3-part key", () => {
    const result = parseSessionKeyString("myTenant:user123:discord");
    expect(result).toEqual({
      tenantId: "myTenant",
      userId: "user123",
      channelId: "discord",
    });
  });

  it("parses a key with optional peer segment", () => {
    const result = parseSessionKeyString("myTenant:user123:telegram:peer:chat456");
    expect(result).toEqual({
      tenantId: "myTenant",
      userId: "user123",
      channelId: "telegram",
      peerId: "chat456",
    });
  });

  it("parses a key with optional guild segment", () => {
    const result = parseSessionKeyString("myTenant:user123:discord:guild:server789");
    expect(result).toEqual({
      tenantId: "myTenant",
      userId: "user123",
      channelId: "discord",
      guildId: "server789",
    });
  });

  it("parses a key with optional thread segment", () => {
    const result = parseSessionKeyString("myTenant:user123:slack:thread:t001");
    expect(result).toEqual({
      tenantId: "myTenant",
      userId: "user123",
      channelId: "slack",
      threadId: "t001",
    });
  });

  it("parses a key with all optional segments (no agent prefix)", () => {
    const result = parseSessionKeyString(
      "myTenant:user123:telegram:peer:chat456:guild:g789:thread:t001",
    );
    expect(result).toEqual({
      tenantId: "myTenant",
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

  it("returns undefined for invalid input (too few parts)", () => {
    expect(parseSessionKeyString("only:two")).toBeUndefined();
  });

  it("returns undefined for non-string input", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(parseSessionKeyString(null as any)).toBeUndefined();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(parseSessionKeyString(undefined as any)).toBeUndefined();
  });

  // Deleted (Phase 38 CR-01 follow-up to BC-REM-15): "parses a full session
  // key with agent prefix", "handles agent prefix with exactly 5 parts",
  // "falls through to non-agent parsing when agent prefix has < 5 parts" —
  // the `agent:` prefix is no longer recognized by either parser.

  it("treats a stray `agent:` prefix as ordinary tenant/user/channel parts (post-CR-01)", () => {
    // `agent:bot:ten:usr:ch` was previously parsed as agentId="bot",
    // tenantId="ten", userId="usr", channelId="ch". Post-CR-01 the prefix
    // is no longer special-cased — the parser simply consumes the first
    // three colon-separated parts as tenantId / userId / channelId.
    const result = parseSessionKeyString("agent:bot:ten:usr:ch");
    expect(result).toEqual({
      tenantId: "agent",
      userId: "bot",
      channelId: "ten",
    });
  });
});

describe("formatSessionDisplayName", () => {
  it("returns userId directly when 16 chars or less", () => {
    const key: ParsedSessionKey = { tenantId: "t", userId: "short_user", channelId: "ch" };
    expect(formatSessionDisplayName(key)).toBe("short_user");
  });

  it("returns userId directly when exactly 16 chars", () => {
    const key: ParsedSessionKey = { tenantId: "t", userId: "1234567890123456", channelId: "ch" };
    expect(formatSessionDisplayName(key)).toBe("1234567890123456");
  });

  it("truncates userId to 14 chars + '...' when longer than 16", () => {
    const key: ParsedSessionKey = { tenantId: "t", userId: "12345678901234567", channelId: "ch" };
    expect(formatSessionDisplayName(key)).toBe("12345678901234...");
  });

  it("truncates very long userId", () => {
    const key: ParsedSessionKey = { tenantId: "t", userId: "a".repeat(50), channelId: "ch" };
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
