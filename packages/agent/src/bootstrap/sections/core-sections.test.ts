// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import {
  buildSafetySection,
  buildDateTimeSection,
  buildInboundMetadataSection,
} from "./core-sections.js";
import type { InboundMetadata } from "../types.js";

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

  // A model was observed running a confirmation flow ("reply YES to
  // update") for an action it has no tool for — implying a capability it
  // lacks without ever fabricating a result. The general honesty principle did
  // not stop the *pre-affirmation*; this operational rule names the exact
  // trigger (act-on-request verbs) and the required disclosure order.
  it("instructs disclosing missing capability BEFORE affirming an action request", () => {
    const joined = buildSafetySection(false).join("\n");
    // Must name the action-request trigger and require capability-check-first.
    expect(joined).toMatch(/before (you )?(affirm|confirm|promis)/i);
    expect(joined).toMatch(/create, set, send/i);
    expect(joined).toContain("do not imply you can perform an action you cannot");
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
