// SPDX-License-Identifier: Apache-2.0
/**
 * INTEGRATION: orchestrator session-key — DM scope + thread isolation.
 *
 * Phase 40 Plan 40-16 (COV-04 gap closure): lifts integration-tier coverage
 * for `@comis/orchestrator` (currently 47.69% — needs ~32pp). Exercises
 * the production session-key builder + thread-id extractor against
 * realistic NormalizedMessage fixtures.
 *
 * @module
 */

import { describe, it, expect } from "vitest";
import {
  buildScopedSessionKey,
  extractThreadId,
} from "@comis/orchestrator";
import type { NormalizedMessage } from "@comis/core";

function makeMessage(overrides: Partial<NormalizedMessage> = {}): NormalizedMessage {
  return {
    id: overrides.id ?? "msg-1",
    text: overrides.text ?? "test message",
    senderId: overrides.senderId ?? "user-42",
    channelId: overrides.channelId ?? "channel-1",
    channelType: overrides.channelType ?? "echo",
    timestamp: overrides.timestamp ?? Date.now(),
    metadata: overrides.metadata ?? {},
    attachments: overrides.attachments ?? [],
    isDM: overrides.isDM ?? false,
  } as NormalizedMessage;
}

describe("INTEGRATION: orchestrator session-key — DM scope + thread isolation", () => {
  it("buildScopedSessionKey returns SessionKey with tenantId/userId/channelId for non-DM message", () => {
    const msg = makeMessage({
      channelId: "channel-general",
      senderId: "user-42",
      isDM: false,
    });
    const key = buildScopedSessionKey({
      msg,
      agentId: "test-agent",
      adapterChannelId: "bot-account",
      tenantId: "test-tenant",
    });
    expect(key).toBeDefined();
    expect(key.tenantId).toBe("test-tenant");
    expect(typeof key.userId).toBe("string");
    expect(typeof key.channelId).toBe("string");
  });

  it("buildScopedSessionKey defaults tenantId to 'default' when not provided", () => {
    const msg = makeMessage();
    const key = buildScopedSessionKey({
      msg,
      agentId: "test-agent",
      adapterChannelId: "bot-account",
    });
    expect(key.tenantId).toBe("default");
  });

  it("buildScopedSessionKey isolates DM threads via dmScopeMode 'per-thread'", () => {
    const msg = makeMessage({ isDM: true });
    const key = buildScopedSessionKey({
      msg,
      agentId: "test-agent",
      adapterChannelId: "bot-account",
      dmScopeMode: "per-thread",
      threadId: "thread-abc",
    });
    expect(key).toBeDefined();
    // per-thread mode incorporates the threadId into the session key.
    expect(JSON.stringify(key)).toContain("thread-abc");
  });

  it("buildScopedSessionKey supports per-channel-peer DM scope (default)", () => {
    const msg = makeMessage({ isDM: true, senderId: "user-dm-peer" });
    const key = buildScopedSessionKey({
      msg,
      agentId: "test-agent",
      adapterChannelId: "bot-account",
    });
    expect(key).toBeDefined();
    expect(typeof key.channelId).toBe("string");
  });

  it("extractThreadId returns slackThreadTs when present", () => {
    const msg = makeMessage({
      metadata: { slackThreadTs: "1234567890.123456" },
    });
    const result = extractThreadId(msg);
    expect(result).toBe("1234567890.123456");
  });

  it("extractThreadId returns telegramThreadId when present", () => {
    const msg = makeMessage({
      metadata: { telegramThreadId: 42 },
    });
    const result = extractThreadId(msg);
    expect(result).toBe("42");
  });

  it("extractThreadId returns msg.channelId when parentChannelId is set (Discord thread)", () => {
    const msg = makeMessage({
      channelId: "thread-channel-id",
      metadata: { parentChannelId: "parent-channel-id" },
    });
    const result = extractThreadId(msg);
    expect(result).toBe("thread-channel-id");
  });

  it("extractThreadId returns undefined when no thread metadata present", () => {
    const msg = makeMessage({ metadata: {} });
    const result = extractThreadId(msg);
    expect(result).toBeUndefined();
  });
});
