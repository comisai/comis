// SPDX-License-Identifier: Apache-2.0
/**
 * Session tracker tests: in-memory last-active session tracking per agent per platform.
 * Channel resolution fallback chain support.
 */
import { describe, it, expect } from "vitest";
import { createSessionTracker } from "./session-tracker.js";

function endpoint(
  channelType: string,
  conversationId: string,
  channelInstanceId = `${channelType}-account`,
) {
  return {
    channelType,
    channelInstanceId,
    conversationId,
    conversationKind: "direct" as const,
  };
}

describe("SessionTracker", () => {
  it("recordActivity stores complete endpoint authority", () => {
    let clock = 1000;
    const tracker = createSessionTracker({ nowMs: () => clock });
    const selectedEndpoint = endpoint("telegram", "chat-123");

    tracker.recordActivity("agent-1", selectedEndpoint);

    expect(tracker.getRecentForPlatform("agent-1", "telegram")).toEqual(selectedEndpoint);
  });

  it("getRecentForPlatform returns undefined for unknown platform", () => {
    let clock = 1000;
    const tracker = createSessionTracker({ nowMs: () => clock });

    tracker.recordActivity("agent-1", endpoint("telegram", "chat-123"));

    expect(tracker.getRecentForPlatform("agent-1", "unknown")).toBeUndefined();
  });

  it("getMostRecent returns the most recently recorded entry (latest timestamp)", () => {
    let clock = 1000;
    const tracker = createSessionTracker({ nowMs: () => clock });

    tracker.recordActivity("agent-1", endpoint("telegram", "tg-chat"));
    clock = 2000;
    tracker.recordActivity("agent-1", endpoint("discord", "dc-channel"));
    clock = 3000;
    tracker.recordActivity("agent-1", endpoint("slack", "slack-channel"));

    const recent = tracker.getMostRecent("agent-1");
    expect(recent).toEqual(endpoint("slack", "slack-channel"));
  });

  it("getMostRecent returns undefined for unknown agent", () => {
    const tracker = createSessionTracker();

    expect(tracker.getMostRecent("unknown-agent")).toBeUndefined();
  });

  it("multiple agents have independent tracking", () => {
    let clock = 1000;
    const tracker = createSessionTracker({ nowMs: () => clock });

    tracker.recordActivity("agent-1", endpoint("telegram", "tg-a1"));
    clock = 2000;
    tracker.recordActivity("agent-2", endpoint("discord", "dc-a2"));

    expect(tracker.getRecentForPlatform("agent-1", "telegram"))
      .toEqual(endpoint("telegram", "tg-a1"));
    expect(tracker.getRecentForPlatform("agent-2", "discord"))
      .toEqual(endpoint("discord", "dc-a2"));
    expect(tracker.getRecentForPlatform("agent-1", "discord")).toBeUndefined();
    expect(tracker.getRecentForPlatform("agent-2", "telegram")).toBeUndefined();
  });

  it("multiple platforms for same agent tracked independently", () => {
    let clock = 1000;
    const tracker = createSessionTracker({ nowMs: () => clock });

    tracker.recordActivity("agent-1", endpoint("telegram", "tg-chat"));
    clock = 2000;
    tracker.recordActivity("agent-1", endpoint("discord", "dc-channel"));

    expect(tracker.getRecentForPlatform("agent-1", "telegram"))
      .toEqual(endpoint("telegram", "tg-chat"));
    expect(tracker.getRecentForPlatform("agent-1", "discord"))
      .toEqual(endpoint("discord", "dc-channel"));
  });

  it("getMostRecent returns latest across platforms based on timestamp", () => {
    let clock = 1000;
    const tracker = createSessionTracker({ nowMs: () => clock });

    clock = 3000;
    tracker.recordActivity("agent-1", endpoint("telegram", "tg-chat"));
    clock = 1000;
    tracker.recordActivity("agent-1", endpoint("discord", "dc-channel"));

    // Telegram was recorded at clock=3000, discord at clock=1000
    const recent = tracker.getMostRecent("agent-1");
    expect(recent).toEqual(endpoint("telegram", "tg-chat"));
  });

  it("findEndpoint preserves instance thread and conversation kind", () => {
    let clock = 1000;
    const tracker = createSessionTracker({ nowMs: () => clock });
    const accountA = {
      ...endpoint("telegram", "shared-chat", "account-a"),
      threadId: "thread-a",
      conversationKind: "shared" as const,
    };
    const accountB = {
      ...endpoint("telegram", "shared-chat", "account-b"),
      threadId: "thread-b",
      conversationKind: "shared" as const,
    };
    tracker.recordActivity("agent-1", accountA);
    clock = 2000;
    tracker.recordActivity("agent-1", accountB);

    expect(tracker.findEndpoint("agent-1", "telegram", "shared-chat")).toEqual(accountB);
  });

  it("equal timestamps retain the latest complete endpoint", () => {
    const tracker = createSessionTracker({ nowMs: () => 1000 });
    const accountA = endpoint("telegram", "shared-chat", "account-a");
    const accountB = endpoint("telegram", "shared-chat", "account-b");

    tracker.recordActivity("agent-1", accountA);
    tracker.recordActivity("agent-1", accountB);

    expect(tracker.getRecentForPlatform("agent-1", "telegram")).toEqual(accountB);
    expect(tracker.getMostRecent("agent-1")).toEqual(accountB);
    expect(tracker.findEndpoint("agent-1", "telegram", "shared-chat")).toEqual(accountB);
  });
});
