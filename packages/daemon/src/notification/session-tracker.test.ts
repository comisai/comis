// SPDX-License-Identifier: Apache-2.0
/**
 * Session tracker tests: in-memory last-active session tracking per agent per platform.
 * Channel resolution fallback chain support.
 */
import { describe, it, expect } from "vitest";
import { createSessionTracker } from "./session-tracker.js";

describe("SessionTracker", () => {
  it("recordActivity stores the entry and getRecentForPlatform returns channelId", () => {
    let clock = 1000;
    const tracker = createSessionTracker({ nowMs: () => clock });

    tracker.recordActivity("agent-1", "telegram", "chat-123");

    expect(tracker.getRecentForPlatform("agent-1", "telegram")).toBe("chat-123");
  });

  it("getRecentForPlatform returns undefined for unknown platform", () => {
    let clock = 1000;
    const tracker = createSessionTracker({ nowMs: () => clock });

    tracker.recordActivity("agent-1", "telegram", "chat-123");

    expect(tracker.getRecentForPlatform("agent-1", "unknown")).toBeUndefined();
  });

  it("getMostRecent returns the most recently recorded entry (latest timestamp)", () => {
    let clock = 1000;
    const tracker = createSessionTracker({ nowMs: () => clock });

    tracker.recordActivity("agent-1", "telegram", "tg-chat");
    clock = 2000;
    tracker.recordActivity("agent-1", "discord", "dc-channel");
    clock = 3000;
    tracker.recordActivity("agent-1", "slack", "slack-channel");

    const recent = tracker.getMostRecent("agent-1");
    expect(recent).toEqual({ channelType: "slack", channelId: "slack-channel" });
  });

  it("getMostRecent returns undefined for unknown agent", () => {
    const tracker = createSessionTracker();

    expect(tracker.getMostRecent("unknown-agent")).toBeUndefined();
  });

  it("multiple agents have independent tracking", () => {
    let clock = 1000;
    const tracker = createSessionTracker({ nowMs: () => clock });

    tracker.recordActivity("agent-1", "telegram", "tg-a1");
    clock = 2000;
    tracker.recordActivity("agent-2", "discord", "dc-a2");

    expect(tracker.getRecentForPlatform("agent-1", "telegram")).toBe("tg-a1");
    expect(tracker.getRecentForPlatform("agent-2", "discord")).toBe("dc-a2");
    expect(tracker.getRecentForPlatform("agent-1", "discord")).toBeUndefined();
    expect(tracker.getRecentForPlatform("agent-2", "telegram")).toBeUndefined();
  });

  it("multiple platforms for same agent tracked independently", () => {
    let clock = 1000;
    const tracker = createSessionTracker({ nowMs: () => clock });

    tracker.recordActivity("agent-1", "telegram", "tg-chat");
    clock = 2000;
    tracker.recordActivity("agent-1", "discord", "dc-channel");

    expect(tracker.getRecentForPlatform("agent-1", "telegram")).toBe("tg-chat");
    expect(tracker.getRecentForPlatform("agent-1", "discord")).toBe("dc-channel");
  });

  it("getMostRecent returns latest across platforms based on timestamp", () => {
    let clock = 1000;
    const tracker = createSessionTracker({ nowMs: () => clock });

    clock = 3000;
    tracker.recordActivity("agent-1", "telegram", "tg-chat");
    clock = 1000;
    tracker.recordActivity("agent-1", "discord", "dc-channel");

    // Telegram was recorded at clock=3000, discord at clock=1000
    const recent = tracker.getMostRecent("agent-1");
    expect(recent).toEqual({ channelType: "telegram", channelId: "tg-chat" });
  });
});
