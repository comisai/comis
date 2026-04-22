// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  buildIdentitySection,
  buildSafetySection,
  buildLanguageSection,
  buildDateTimeSection,
  buildRuntimeMetadataSection,
  buildInboundMetadataSection,
  buildReasoningSection,
} from "./core-sections.js";
import type { RuntimeInfo, InboundMetadata } from "../types.js";

// ---------------------------------------------------------------------------
// buildIdentitySection
// ---------------------------------------------------------------------------

describe("buildIdentitySection", () => {
  it("returns array containing agent name in identity line", () => {
    const result = buildIdentitySection("TestBot");
    expect(result.length).toBeGreaterThan(0);
    expect(result[0]).toContain("TestBot");
    expect(result[0]).toContain("personal AI assistant");
  });

  it("uses custom agent name", () => {
    const result = buildIdentitySection("Sentinel");
    expect(result[0]).toContain("Sentinel");
  });
});

// ---------------------------------------------------------------------------
// buildSafetySection
// ---------------------------------------------------------------------------

describe("buildSafetySection", () => {
  it("returns empty array for minimal mode", () => {
    expect(buildSafetySection(true)).toEqual([]);
  });

  it("returns safety content for full mode", () => {
    const result = buildSafetySection(false);
    expect(result.length).toBeGreaterThan(0);
    const joined = result.join("\n");
    expect(joined).toContain("Constitutional Principles");
    expect(joined).toContain("Operational Safety");
  });
});

// ---------------------------------------------------------------------------
// buildLanguageSection
// ---------------------------------------------------------------------------

describe("buildLanguageSection", () => {
  it("includes language matching instruction without userLanguage", () => {
    const result = buildLanguageSection();
    const joined = result.join("\n");
    expect(joined).toContain("## Language");
    expect(joined).toContain("same language the user writes in");
    expect(joined).toContain("switches languages");
    expect(joined).not.toContain("default to");
  });

  it("includes default language hint when userLanguage is provided", () => {
    const result = buildLanguageSection("Hebrew");
    const joined = result.join("\n");
    expect(joined).toContain("default to Hebrew");
  });

  it("always returns content (never skipped)", () => {
    expect(buildLanguageSection().length).toBeGreaterThan(0);
    expect(buildLanguageSection("ar").length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// buildDateTimeSection
// ---------------------------------------------------------------------------

describe("buildDateTimeSection", () => {
  it("returns array containing date/time heading and ISO timestamp", () => {
    const result = buildDateTimeSection();
    expect(result.length).toBe(2);
    expect(result[0]).toBe("## Current Date & Time");
    // Verify second element contains an ISO-like timestamp
    expect(result[1]).toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });
});

// ---------------------------------------------------------------------------
// buildRuntimeMetadataSection
// ---------------------------------------------------------------------------

describe("buildRuntimeMetadataSection", () => {
  it("returns empty array when no info fields are populated", () => {
    expect(buildRuntimeMetadataSection({}, false)).toEqual([]);
  });

  it("returns Runtime heading with pipe-separated key=value for populated fields", () => {
    const info: RuntimeInfo = { agentId: "agent-1", host: "myhost" };
    const result = buildRuntimeMetadataSection(info, false);
    expect(result[0]).toBe("## Runtime");
    expect(result[1]).toContain("agent=agent-1");
    expect(result[1]).toContain("host=myhost");
    expect(result[1]).toContain(" | ");
  });

  it("includes os with arch combo", () => {
    const info: RuntimeInfo = { os: "linux", arch: "x64" };
    const result = buildRuntimeMetadataSection(info, false);
    expect(result[1]).toContain("os=linux (x64)");
  });

  it("includes os without arch when arch is absent", () => {
    const info: RuntimeInfo = { os: "linux" };
    const result = buildRuntimeMetadataSection(info, false);
    expect(result[1]).toContain("os=linux");
    expect(result[1]).not.toContain("(");
  });

  it("includes model field", () => {
    const info: RuntimeInfo = { model: "claude-3-opus" };
    const result = buildRuntimeMetadataSection(info, false);
    expect(result[1]).toContain("model=claude-3-opus");
  });

  it("includes thinkingLevel field", () => {
    const info: RuntimeInfo = { thinkingLevel: "high" };
    const result = buildRuntimeMetadataSection(info, false);
    expect(result[1]).toContain("thinking=high");
  });

  it("includes nodeVersion field", () => {
    const info: RuntimeInfo = { nodeVersion: "20.11.0" };
    const result = buildRuntimeMetadataSection(info, false);
    expect(result[1]).toContain("node=20.11.0");
  });

  it("includes shell field", () => {
    const info: RuntimeInfo = { shell: "/bin/zsh" };
    const result = buildRuntimeMetadataSection(info, false);
    expect(result[1]).toContain("shell=/bin/zsh");
  });

  it("includes defaultModel field", () => {
    const info: RuntimeInfo = { defaultModel: "gpt-4" };
    const result = buildRuntimeMetadataSection(info, false);
    expect(result[1]).toContain("default_model=gpt-4");
  });

  it("excludes channel field (relocated to dynamic preamble)", () => {
    // channel-only info should produce empty result since channel is no longer rendered
    const info: RuntimeInfo = { channel: "telegram" };
    const result = buildRuntimeMetadataSection(info, false);
    expect(result).toEqual([]);
    // With other fields present, channel= should still not appear
    const infoWithHost: RuntimeInfo = { channel: "telegram", host: "myhost" };
    const result2 = buildRuntimeMetadataSection(infoWithHost, false);
    expect(result2[1]).not.toContain("channel=");
    expect(result2[1]).toContain("host=myhost");
  });

  it("includes channelCapabilities field", () => {
    const info: RuntimeInfo = { channelCapabilities: "reactions, threads" };
    const result = buildRuntimeMetadataSection(info, false);
    expect(result[1]).toContain("capabilities=reactions, threads");
  });

  it("still renders in minimal mode (isMinimal is unused)", () => {
    const info: RuntimeInfo = { agentId: "agent-2" };
    const result = buildRuntimeMetadataSection(info, true);
    expect(result.length).toBeGreaterThan(0);
    expect(result[1]).toContain("agent=agent-2");
  });
});

// ---------------------------------------------------------------------------
// buildInboundMetadataSection
// ---------------------------------------------------------------------------

describe("buildInboundMetadataSection", () => {
  it("returns empty array for undefined meta", () => {
    expect(buildInboundMetadataSection(undefined, false)).toEqual([]);
  });

  it("returns JSON block with message_id, sender_id, chat_id, channel, chat_type", () => {
    const meta: InboundMetadata = {
      messageId: "msg-1",
      senderId: "user-1",
      chatId: "chat-1",
      channel: "telegram",
      chatType: "dm",
      flags: {},
    };
    const result = buildInboundMetadataSection(meta, false);
    const joined = result.join("\n");
    expect(joined).toContain("## Current Message Context");
    expect(joined).toContain('"message_id": "msg-1"');
    expect(joined).toContain('"sender_id": "user-1"');
    expect(joined).toContain('"chat_id": "chat-1"');
    expect(joined).toContain('"channel": "telegram"');
    expect(joined).toContain('"chat_type": "dm"');
  });

  it("omits flags key when flags object is empty", () => {
    const meta: InboundMetadata = {
      messageId: "msg-1",
      senderId: "user-1",
      chatId: "chat-1",
      channel: "discord",
      chatType: "group",
      flags: {},
    };
    const result = buildInboundMetadataSection(meta, false);
    const joined = result.join("\n");
    expect(joined).not.toContain('"flags"');
  });

  it("includes flags when populated", () => {
    const meta: InboundMetadata = {
      messageId: "msg-1",
      senderId: "user-1",
      chatId: "chat-1",
      channel: "discord",
      chatType: "group",
      flags: { isGroup: true, hasAttachments: true },
    };
    const result = buildInboundMetadataSection(meta, false);
    const joined = result.join("\n");
    expect(joined).toContain('"flags"');
    expect(joined).toContain('"isGroup": true');
    expect(joined).toContain('"hasAttachments": true');
  });

  it("includes SCHEDULED REMINDER block when flags.isScheduled is true", () => {
    const meta: InboundMetadata = {
      messageId: "msg-1",
      senderId: "user-1",
      chatId: "chat-1",
      channel: "telegram",
      chatType: "dm",
      flags: { isScheduled: true },
    };
    const result = buildInboundMetadataSection(meta, false);
    const joined = result.join("\n");
    expect(joined).toContain("SCHEDULED REMINDER");
    expect(joined).toContain("scheduled reminder delivery");
  });

  it("includes CRON AGENT TURN block when flags.isCronAgentTurn is true", () => {
    const meta: InboundMetadata = {
      messageId: "msg-1",
      senderId: "user-1",
      chatId: "chat-1",
      channel: "telegram",
      chatType: "dm",
      flags: { isCronAgentTurn: true },
    };
    const result = buildInboundMetadataSection(meta, false);
    const joined = result.join("\n");
    expect(joined).toContain("CRON AGENT TURN");
    expect(joined).toContain("NO_REPLY");
    expect(joined).not.toContain("SCHEDULED REMINDER");
  });

  it("does NOT include CRON AGENT TURN block when only isScheduled is set", () => {
    const meta: InboundMetadata = {
      messageId: "msg-1",
      senderId: "user-1",
      chatId: "chat-1",
      channel: "telegram",
      chatType: "dm",
      flags: { isScheduled: true },
    };
    const result = buildInboundMetadataSection(meta, false);
    const joined = result.join("\n");
    expect(joined).toContain("SCHEDULED REMINDER");
    expect(joined).not.toContain("CRON AGENT TURN");
  });

  it("isCronAgentTurn takes precedence over isScheduled if both set", () => {
    const meta: InboundMetadata = {
      messageId: "msg-1",
      senderId: "user-1",
      chatId: "chat-1",
      channel: "telegram",
      chatType: "dm",
      flags: { isCronAgentTurn: true, isScheduled: true },
    };
    const result = buildInboundMetadataSection(meta, false);
    const joined = result.join("\n");
    expect(joined).toContain("CRON AGENT TURN");
    expect(joined).not.toContain("SCHEDULED REMINDER");
  });

  it("does NOT include SCHEDULED REMINDER block when isScheduled is absent", () => {
    const meta: InboundMetadata = {
      messageId: "msg-1",
      senderId: "user-1",
      chatId: "chat-1",
      channel: "telegram",
      chatType: "dm",
      flags: {},
    };
    const result = buildInboundMetadataSection(meta, false);
    const joined = result.join("\n");
    expect(joined).not.toContain("SCHEDULED REMINDER");
  });

  it("works in minimal mode (isMinimal is unused)", () => {
    const meta: InboundMetadata = {
      messageId: "msg-1",
      senderId: "user-1",
      chatId: "chat-1",
      channel: "slack",
      chatType: "thread",
      flags: {},
    };
    const result = buildInboundMetadataSection(meta, true);
    expect(result.length).toBeGreaterThan(0);
  });

  it("includes sender_trust when senderTrust is set in metadata", () => {
    const meta: InboundMetadata = {
      messageId: "msg-1",
      senderId: "user-1",
      chatId: "chat-1",
      channel: "telegram",
      chatType: "dm",
      flags: {},
      senderTrust: "admin",
    };
    const result = buildInboundMetadataSection(meta, false);
    const joined = result.join("\n");
    expect(joined).toContain('"sender_trust": "admin"');
  });

  it("omits sender_trust when senderTrust is undefined", () => {
    const meta: InboundMetadata = {
      messageId: "msg-1",
      senderId: "user-1",
      chatId: "chat-1",
      channel: "telegram",
      chatType: "dm",
      flags: {},
    };
    const result = buildInboundMetadataSection(meta, false);
    const joined = result.join("\n");
    expect(joined).not.toContain("sender_trust");
  });
});

// ---------------------------------------------------------------------------
// buildReasoningSection
// ---------------------------------------------------------------------------

describe("buildReasoningSection", () => {
  it("returns empty for minimal mode", () => {
    expect(buildReasoningSection(true, true, false)).toEqual([]);
  });

  it("returns empty when not enabled and no tagHint", () => {
    expect(buildReasoningSection(false, false, false)).toEqual([]);
  });

  it("returns Extended Thinking content when enabled without tagHint", () => {
    const result = buildReasoningSection(true, false, false);
    const joined = result.join("\n");
    expect(joined).toContain("Extended Thinking");
    expect(joined).toContain("extended thinking enabled");
  });

  it("returns Reasoning Format with think/final tags when tagHint is true (regardless of enabled)", () => {
    const result = buildReasoningSection(false, false, true);
    const joined = result.join("\n");
    expect(joined).toContain("Reasoning Format");
    expect(joined).toContain("<think>");
    expect(joined).toContain("<final>");
  });

  it("returns Reasoning Format with tags even when enabled is true and tagHint is true", () => {
    const result = buildReasoningSection(true, false, true);
    const joined = result.join("\n");
    expect(joined).toContain("Reasoning Format");
    expect(joined).toContain("<think>");
  });

  it("returns empty for minimal mode even with tagHint", () => {
    expect(buildReasoningSection(true, true, true)).toEqual([]);
  });
});
