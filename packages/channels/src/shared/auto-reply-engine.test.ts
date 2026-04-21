// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import type { NormalizedMessage } from "@comis/core";
import type { AutoReplyEngineConfig } from "@comis/core";
import {
  evaluateAutoReply,
  isGroupMessage,
  isBotMentioned,
} from "./auto-reply-engine.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Build a minimal NormalizedMessage with optional metadata overrides. */
function buildMsg(
  overrides: Partial<NormalizedMessage> = {},
): NormalizedMessage {
  return {
    id: "00000000-0000-0000-0000-000000000001",
    channelId: "ch-1",
    channelType: "telegram",
    senderId: "user-1",
    text: "hello",
    timestamp: Date.now(),
    attachments: [],
    metadata: {},
    ...overrides,
  };
}

/** Build a default AutoReplyEngineConfig with overrides. */
function buildConfig(
  overrides: Partial<AutoReplyEngineConfig> = {},
): AutoReplyEngineConfig {
  return {
    enabled: true,
    groupActivation: "mention-gated",
    customPatterns: [],
    historyInjection: true,
    maxHistoryInjections: 50,
    maxGroupHistoryMessages: 20,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// isGroupMessage
// ---------------------------------------------------------------------------

describe("isGroupMessage", () => {
  it("Telegram group (telegramChatType: 'group') -> true", () => {
    const msg = buildMsg({ metadata: { telegramChatType: "group" } });
    expect(isGroupMessage(msg)).toBe(true);
  });

  it("Telegram supergroup (telegramChatType: 'supergroup') -> true", () => {
    const msg = buildMsg({ metadata: { telegramChatType: "supergroup" } });
    expect(isGroupMessage(msg)).toBe(true);
  });

  it("Telegram private (telegramChatType: 'private') -> false", () => {
    const msg = buildMsg({ metadata: { telegramChatType: "private" } });
    expect(isGroupMessage(msg)).toBe(false);
  });

  it("Discord guild (guildId: '123') -> true", () => {
    const msg = buildMsg({ metadata: { guildId: "123" } });
    expect(isGroupMessage(msg)).toBe(true);
  });

  it("Discord DM (no guildId) -> false", () => {
    const msg = buildMsg({
      channelType: "discord",
      metadata: {},
    });
    expect(isGroupMessage(msg)).toBe(false);
  });

  it("WhatsApp group (isGroup: true) -> true", () => {
    const msg = buildMsg({ metadata: { isGroup: true } });
    expect(isGroupMessage(msg)).toBe(true);
  });

  it("WhatsApp DM (isGroup: false) -> false", () => {
    const msg = buildMsg({ metadata: { isGroup: false } });
    expect(isGroupMessage(msg)).toBe(false);
  });

  it("WhatsApp DM (isGroup: undefined) -> false", () => {
    const msg = buildMsg({
      channelType: "whatsapp",
      metadata: {},
    });
    expect(isGroupMessage(msg)).toBe(false);
  });

  it("No metadata -> false (default to DM)", () => {
    const msg = buildMsg({ metadata: undefined });
    expect(isGroupMessage(msg)).toBe(false);
  });

  it("Empty metadata object -> false", () => {
    const msg = buildMsg({ metadata: {} });
    expect(isGroupMessage(msg)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isBotMentioned
// ---------------------------------------------------------------------------

describe("isBotMentioned", () => {
  it("metadata.isMentioned === true -> true", () => {
    const msg = buildMsg({ metadata: { isMentioned: true } });
    expect(isBotMentioned(msg)).toBe(true);
  });

  it("metadata.isBotMentioned === true -> true", () => {
    const msg = buildMsg({ metadata: { isBotMentioned: true } });
    expect(isBotMentioned(msg)).toBe(true);
  });

  it("metadata.replyToBot === true -> true", () => {
    const msg = buildMsg({ metadata: { replyToBot: true } });
    expect(isBotMentioned(msg)).toBe(true);
  });

  it("no mention flags -> false", () => {
    const msg = buildMsg({ metadata: { someOther: "data" } });
    expect(isBotMentioned(msg)).toBe(false);
  });

  it("no metadata -> false", () => {
    const msg = buildMsg({ metadata: undefined });
    expect(isBotMentioned(msg)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// evaluateAutoReply
// ---------------------------------------------------------------------------

describe("evaluateAutoReply", () => {
  it("DM message always returns 'activate' regardless of config mode", () => {
    const msg = buildMsg();
    const config = buildConfig({ groupActivation: "mention-gated" });
    const result = evaluateAutoReply(msg, config, false);
    expect(result.action).toBe("activate");
    expect(result.reason).toBe("dm");
  });

  it("DM + always mode still returns 'activate' with dm reason", () => {
    const msg = buildMsg();
    const config = buildConfig({ groupActivation: "always" });
    const result = evaluateAutoReply(msg, config, false);
    expect(result.action).toBe("activate");
    expect(result.reason).toBe("dm");
  });

  it("DM + custom mode still returns 'activate' with dm reason", () => {
    const msg = buildMsg();
    const config = buildConfig({
      groupActivation: "custom",
      customPatterns: ["^never-match$"],
    });
    const result = evaluateAutoReply(msg, config, false);
    expect(result.action).toBe("activate");
    expect(result.reason).toBe("dm");
  });

  it("Group + always mode returns 'activate'", () => {
    const msg = buildMsg();
    const config = buildConfig({ groupActivation: "always" });
    const result = evaluateAutoReply(msg, config, true);
    expect(result.action).toBe("activate");
    expect(result.reason).toBe("always-mode");
  });

  it("Group + mention-gated + bot mentioned returns 'activate'", () => {
    const msg = buildMsg({ metadata: { isMentioned: true } });
    const config = buildConfig({ groupActivation: "mention-gated" });
    const result = evaluateAutoReply(msg, config, true);
    expect(result.action).toBe("activate");
    expect(result.reason).toBe("mention-detected");
  });

  it("Group + mention-gated + not mentioned + historyInjection=true returns 'inject-history'", () => {
    const msg = buildMsg({ metadata: {} });
    const config = buildConfig({
      groupActivation: "mention-gated",
      historyInjection: true,
    });
    const result = evaluateAutoReply(msg, config, true);
    expect(result.action).toBe("inject-history");
    expect(result.reason).toBe("group-not-mentioned");
  });

  it("Group + mention-gated + not mentioned + historyInjection=false returns 'ignore'", () => {
    const msg = buildMsg({ metadata: {} });
    const config = buildConfig({
      groupActivation: "mention-gated",
      historyInjection: false,
    });
    const result = evaluateAutoReply(msg, config, true);
    expect(result.action).toBe("ignore");
    expect(result.reason).toBe("group-not-mentioned");
  });

  it("Group + custom mode + pattern matches returns 'activate'", () => {
    const msg = buildMsg({ text: "!bot help me" });
    const config = buildConfig({
      groupActivation: "custom",
      customPatterns: ["^!bot"],
    });
    const result = evaluateAutoReply(msg, config, true);
    expect(result.action).toBe("activate");
    expect(result.reason).toBe("custom-pattern-matched");
  });

  it("Group + custom mode + no match + historyInjection=true returns 'inject-history'", () => {
    const msg = buildMsg({ text: "just chatting" });
    const config = buildConfig({
      groupActivation: "custom",
      customPatterns: ["^!bot"],
      historyInjection: true,
    });
    const result = evaluateAutoReply(msg, config, true);
    expect(result.action).toBe("inject-history");
    expect(result.reason).toBe("group-no-pattern-match");
  });

  it("Group + custom mode + no match + historyInjection=false returns 'ignore'", () => {
    const msg = buildMsg({ text: "just chatting" });
    const config = buildConfig({
      groupActivation: "custom",
      customPatterns: ["^!bot"],
      historyInjection: false,
    });
    const result = evaluateAutoReply(msg, config, true);
    expect(result.action).toBe("ignore");
    expect(result.reason).toBe("group-no-pattern-match");
  });

  it("Custom mode with invalid regex pattern does not throw", () => {
    const msg = buildMsg({ text: "hello" });
    const config = buildConfig({
      groupActivation: "custom",
      customPatterns: ["[invalid(regex", "^hello"],
    });
    // Should not throw -- invalid patterns skipped, valid "^hello" matches
    const result = evaluateAutoReply(msg, config, true);
    expect(result.action).toBe("activate");
    expect(result.reason).toBe("custom-pattern-matched");
  });

  it("Custom mode with only invalid regex patterns falls through safely", () => {
    const msg = buildMsg({ text: "hello" });
    const config = buildConfig({
      groupActivation: "custom",
      customPatterns: ["[invalid(regex", "++bad++"],
      historyInjection: false,
    });
    const result = evaluateAutoReply(msg, config, true);
    expect(result.action).toBe("ignore");
    expect(result.reason).toBe("group-no-pattern-match");
  });

  it("Custom mode skips ReDoS-prone regex pattern (a+)+$", () => {
    const msg = buildMsg({ text: "aaaaaaaaaaaaaaaa" });
    const config = buildConfig({
      groupActivation: "custom",
      customPatterns: ["(a+)+$"],
      historyInjection: false,
    });
    const result = evaluateAutoReply(msg, config, true);
    // ReDoS pattern is skipped by the guard, so no match
    expect(result.action).toBe("ignore");
    expect(result.reason).toBe("group-no-pattern-match");
  });

  it("Custom mode skips pattern exceeding 200 characters", () => {
    const msg = buildMsg({ text: "hello" });
    const longPattern = "a".repeat(201);
    const config = buildConfig({
      groupActivation: "custom",
      customPatterns: [longPattern],
      historyInjection: false,
    });
    const result = evaluateAutoReply(msg, config, true);
    expect(result.action).toBe("ignore");
    expect(result.reason).toBe("group-no-pattern-match");
  });

  it("Custom mode still works with normal patterns like 'hello|hi'", () => {
    const msg = buildMsg({ text: "hi there" });
    const config = buildConfig({
      groupActivation: "custom",
      customPatterns: ["hello|hi"],
    });
    const result = evaluateAutoReply(msg, config, true);
    expect(result.action).toBe("activate");
    expect(result.reason).toBe("custom-pattern-matched");
  });

  it("Reason strings are descriptive and non-empty", () => {
    const msg = buildMsg();
    const config = buildConfig();

    // DM
    const dm = evaluateAutoReply(msg, config, false);
    expect(dm.reason.length).toBeGreaterThan(0);

    // Group always
    const always = evaluateAutoReply(
      msg,
      buildConfig({ groupActivation: "always" }),
      true,
    );
    expect(always.reason.length).toBeGreaterThan(0);

    // Group mention-gated not mentioned
    const gated = evaluateAutoReply(msg, config, true);
    expect(gated.reason.length).toBeGreaterThan(0);
  });
});
