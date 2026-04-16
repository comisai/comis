import { TypedEventBus } from "@comis/core";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  createChannelActivityTracker,
  type ChannelActivityTracker,
} from "./channel-activity-tracker.js";

describe("createChannelActivityTracker", () => {
  let bus: TypedEventBus;
  let tracker: ChannelActivityTracker;

  beforeEach(() => {
    bus = new TypedEventBus();
    tracker = createChannelActivityTracker({ eventBus: bus });
  });

  afterEach(() => {
    tracker.dispose();
    vi.useRealTimers();
  });

  it("tracks activity from message:received events", () => {
    bus.emit("message:received", {
      message: {
        id: "00000000-0000-0000-0000-000000000001",
        channelId: "ch-1",
        channelType: "telegram",
        senderId: "user-1",
        text: "hello",
        timestamp: Date.now(),
        attachments: [],
        metadata: {},
      },
      sessionKey: { tenantId: "default", userId: "user-1", channelId: "ch-1" },
    });

    const activity = tracker.get("ch-1");
    expect(activity).toBeDefined();
    expect(activity!.channelId).toBe("ch-1");
    expect(activity!.channelType).toBe("telegram");
    expect(activity!.messagesReceived).toBe(1);
    expect(activity!.messagesSent).toBe(0);
    expect(activity!.lastActiveAt).toBeGreaterThan(0);
  });

  it("tracks activity from message:sent events", () => {
    bus.emit("message:sent", {
      channelId: "ch-2",
      messageId: "msg-1",
      content: "response",
    });

    const activity = tracker.get("ch-2");
    expect(activity).toBeDefined();
    expect(activity!.channelId).toBe("ch-2");
    expect(activity!.messagesSent).toBe(1);
    expect(activity!.messagesReceived).toBe(0);
    // No channelType in message:sent payload, defaults to "unknown"
    expect(activity!.channelType).toBe("unknown");
  });

  it("updates lastActiveAt on every event", () => {
    const now = Date.now();
    vi.useFakeTimers({ now });

    bus.emit("message:received", {
      message: {
        id: "00000000-0000-0000-0000-000000000001",
        channelId: "ch-1",
        channelType: "telegram",
        senderId: "user-1",
        text: "first",
        timestamp: now,
        attachments: [],
        metadata: {},
      },
      sessionKey: { tenantId: "default", userId: "user-1", channelId: "ch-1" },
    });

    const firstActive = tracker.get("ch-1")!.lastActiveAt;

    // Advance time
    vi.advanceTimersByTime(5_000);

    bus.emit("message:received", {
      message: {
        id: "00000000-0000-0000-0000-000000000002",
        channelId: "ch-1",
        channelType: "telegram",
        senderId: "user-1",
        text: "second",
        timestamp: now + 5_000,
        attachments: [],
        metadata: {},
      },
      sessionKey: { tenantId: "default", userId: "user-1", channelId: "ch-1" },
    });

    const secondActive = tracker.get("ch-1")!.lastActiveAt;
    expect(secondActive).toBeGreaterThan(firstActive);
    expect(secondActive - firstActive).toBe(5_000);
  });

  it("getAll returns all tracked channels", () => {
    // Emit events for 3 different channels
    bus.emit("message:received", {
      message: {
        id: "00000000-0000-0000-0000-000000000001",
        channelId: "ch-1",
        channelType: "telegram",
        senderId: "user-1",
        text: "hello",
        timestamp: Date.now(),
        attachments: [],
        metadata: {},
      },
      sessionKey: { tenantId: "default", userId: "user-1", channelId: "ch-1" },
    });

    bus.emit("message:sent", {
      channelId: "ch-2",
      messageId: "msg-1",
      content: "response",
    });

    bus.emit("message:received", {
      message: {
        id: "00000000-0000-0000-0000-000000000002",
        channelId: "ch-3",
        channelType: "discord",
        senderId: "user-2",
        text: "hey",
        timestamp: Date.now(),
        attachments: [],
        metadata: {},
      },
      sessionKey: { tenantId: "default", userId: "user-2", channelId: "ch-3" },
    });

    const all = tracker.getAll();
    expect(all).toHaveLength(3);
    const ids = all.map((a) => a.channelId).sort();
    expect(ids).toEqual(["ch-1", "ch-2", "ch-3"]);
  });

  it("get returns undefined for unknown channel", () => {
    expect(tracker.get("nonexistent")).toBeUndefined();
  });

  it("getStale returns channels inactive beyond threshold", () => {
    const now = Date.now();
    vi.useFakeTimers({ now });

    // Channel 1: active right now
    bus.emit("message:received", {
      message: {
        id: "00000000-0000-0000-0000-000000000001",
        channelId: "ch-active",
        channelType: "telegram",
        senderId: "user-1",
        text: "recent",
        timestamp: now,
        attachments: [],
        metadata: {},
      },
      sessionKey: { tenantId: "default", userId: "user-1", channelId: "ch-active" },
    });

    // Advance 60 seconds
    vi.advanceTimersByTime(60_000);

    // Channel 2: active at now+60s
    bus.emit("message:received", {
      message: {
        id: "00000000-0000-0000-0000-000000000002",
        channelId: "ch-recent",
        channelType: "discord",
        senderId: "user-2",
        text: "newer",
        timestamp: now + 60_000,
        attachments: [],
        metadata: {},
      },
      sessionKey: { tenantId: "default", userId: "user-2", channelId: "ch-recent" },
    });

    // Advance 30 more seconds (now = original + 90s)
    vi.advanceTimersByTime(30_000);

    // ch-active was last active at "now" (90s ago)
    // ch-recent was last active at "now+60s" (30s ago)
    // Threshold: 45 seconds -- ch-active should be stale, ch-recent should not
    const stale = tracker.getStale(45_000);
    expect(stale).toHaveLength(1);
    expect(stale[0]!.channelId).toBe("ch-active");
  });

  it("getStale returns empty when all channels are active", () => {
    const now = Date.now();
    vi.useFakeTimers({ now });

    bus.emit("message:received", {
      message: {
        id: "00000000-0000-0000-0000-000000000001",
        channelId: "ch-1",
        channelType: "telegram",
        senderId: "user-1",
        text: "active",
        timestamp: now,
        attachments: [],
        metadata: {},
      },
      sessionKey: { tenantId: "default", userId: "user-1", channelId: "ch-1" },
    });

    bus.emit("message:sent", {
      channelId: "ch-2",
      messageId: "msg-1",
      content: "also active",
    });

    // With threshold of 60s and no time elapsed, all channels are recent
    const stale = tracker.getStale(60_000);
    expect(stale).toEqual([]);
  });

  it("recordActivity works for manual recording", () => {
    tracker.recordActivity("ch-manual", "slack", "received");
    tracker.recordActivity("ch-manual", "slack", "received");
    tracker.recordActivity("ch-manual", "slack", "sent");

    const activity = tracker.get("ch-manual");
    expect(activity).toBeDefined();
    expect(activity!.channelId).toBe("ch-manual");
    expect(activity!.channelType).toBe("slack");
    expect(activity!.messagesReceived).toBe(2);
    expect(activity!.messagesSent).toBe(1);
    expect(activity!.lastActiveAt).toBeGreaterThan(0);
  });

  it("reset clears all tracked activity", () => {
    bus.emit("message:received", {
      message: {
        id: "00000000-0000-0000-0000-000000000001",
        channelId: "ch-1",
        channelType: "telegram",
        senderId: "user-1",
        text: "hello",
        timestamp: Date.now(),
        attachments: [],
        metadata: {},
      },
      sessionKey: { tenantId: "default", userId: "user-1", channelId: "ch-1" },
    });

    bus.emit("message:sent", {
      channelId: "ch-2",
      messageId: "msg-1",
      content: "world",
    });

    expect(tracker.getAll()).toHaveLength(2);

    tracker.reset();

    expect(tracker.getAll()).toHaveLength(0);
    expect(tracker.get("ch-1")).toBeUndefined();
    expect(tracker.get("ch-2")).toBeUndefined();
  });

  it("dispose stops collecting events", () => {
    bus.emit("message:received", {
      message: {
        id: "00000000-0000-0000-0000-000000000001",
        channelId: "ch-1",
        channelType: "telegram",
        senderId: "user-1",
        text: "before",
        timestamp: Date.now(),
        attachments: [],
        metadata: {},
      },
      sessionKey: { tenantId: "default", userId: "user-1", channelId: "ch-1" },
    });

    expect(tracker.getAll()).toHaveLength(1);

    tracker.dispose();

    // Events after dispose should NOT be collected
    bus.emit("message:received", {
      message: {
        id: "00000000-0000-0000-0000-000000000002",
        channelId: "ch-new",
        channelType: "discord",
        senderId: "user-2",
        text: "after",
        timestamp: Date.now(),
        attachments: [],
        metadata: {},
      },
      sessionKey: { tenantId: "default", userId: "user-2", channelId: "ch-new" },
    });

    bus.emit("message:sent", {
      channelId: "ch-3",
      messageId: "msg-2",
      content: "also after",
    });

    // Still only 1 channel from before dispose
    expect(tracker.getAll()).toHaveLength(1);
    expect(tracker.get("ch-1")).toBeDefined();
    expect(tracker.get("ch-new")).toBeUndefined();
    expect(tracker.get("ch-3")).toBeUndefined();
  });
});
