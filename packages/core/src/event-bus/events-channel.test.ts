import { describe, it, expect, vi } from "vitest";
import type { EventMap } from "./events.js";
import { TypedEventBus } from "./bus.js";

const testSessionKey = { tenantId: "t1", userId: "u1", channelId: "c1" };

describe("ChannelEvents payload structure", () => {
  it("channel:registered delivers channelType, pluginId, capabilities", () => {
    const bus = new TypedEventBus();
    const handler = vi.fn();
    const payload: EventMap["channel:registered"] = {
      channelType: "telegram",
      pluginId: "telegram-01",
      capabilities: {
        chatTypes: ["dm", "group"],
        features: {
          reactions: true,
          editMessages: true,
          deleteMessages: true,
          fetchHistory: false,
          attachments: true,
          threads: false,
          mentions: false,
          formatting: ["markdown", "html"],
          buttons: true,
          cards: false,
          effects: true,
        },
        limits: { maxMessageChars: 4096 },
        streaming: { supported: true, throttleMs: 300, method: "edit" },
        threading: { supported: false, threadType: "none" },
      },
      timestamp: Date.now(),
    };

    bus.on("channel:registered", handler);
    bus.emit("channel:registered", payload);

    expect(handler).toHaveBeenCalledWith(payload);
    const received = handler.mock.calls[0]![0] as EventMap["channel:registered"];
    expect(received.channelType).toBe("telegram");
    expect(received.pluginId).toBe("telegram-01");
    expect(received.capabilities.chatTypes).toContain("dm");
    expect(received.capabilities.limits.maxMessageChars).toBe(4096);
    expect(received.capabilities.features.buttons).toBe(true);
  });

  it("queue:enqueued delivers sessionKey, queueDepth, mode", () => {
    const bus = new TypedEventBus();
    const handler = vi.fn();
    const payload: EventMap["queue:enqueued"] = {
      sessionKey: testSessionKey,
      channelType: "discord",
      queueDepth: 3,
      mode: "queue",
      timestamp: Date.now(),
    };

    bus.on("queue:enqueued", handler);
    bus.emit("queue:enqueued", payload);

    expect(handler).toHaveBeenCalledWith(payload);
    const received = handler.mock.calls[0]![0] as EventMap["queue:enqueued"];
    expect(received.sessionKey).toEqual(testSessionKey);
    expect(received.queueDepth).toBe(3);
    expect(received.mode).toBe("queue");
  });

  it("queue:overflow delivers policy and droppedCount", () => {
    const bus = new TypedEventBus();
    const handler = vi.fn();
    const payload: EventMap["queue:overflow"] = {
      sessionKey: testSessionKey,
      channelType: "telegram",
      policy: "drop-oldest",
      droppedCount: 2,
      timestamp: Date.now(),
    };

    bus.on("queue:overflow", handler);
    bus.emit("queue:overflow", payload);

    expect(handler).toHaveBeenCalledWith(payload);
    const received = handler.mock.calls[0]![0] as EventMap["queue:overflow"];
    expect(received.policy).toBe("drop-oldest");
    expect(received.droppedCount).toBe(2);
  });

  it("streaming:block_sent delivers blockIndex, totalBlocks, charCount", () => {
    const bus = new TypedEventBus();
    const handler = vi.fn();
    const payload: EventMap["streaming:block_sent"] = {
      channelId: "c1",
      chatId: "chat-1",
      blockIndex: 2,
      totalBlocks: 5,
      charCount: 150,
      timestamp: Date.now(),
    };

    bus.on("streaming:block_sent", handler);
    bus.emit("streaming:block_sent", payload);

    expect(handler).toHaveBeenCalledWith(payload);
    const received = handler.mock.calls[0]![0] as EventMap["streaming:block_sent"];
    expect(received.blockIndex).toBe(2);
    expect(received.totalBlocks).toBe(5);
    expect(received.charCount).toBe(150);
  });

  it("typing:started delivers channelId, chatId, mode", () => {
    const bus = new TypedEventBus();
    const handler = vi.fn();
    const payload: EventMap["typing:started"] = {
      channelId: "c1",
      chatId: "chat-1",
      mode: "continuous",
      timestamp: Date.now(),
    };

    bus.on("typing:started", handler);
    bus.emit("typing:started", payload);

    expect(handler).toHaveBeenCalledWith(payload);
    const received = handler.mock.calls[0]![0] as EventMap["typing:started"];
    expect(received.channelId).toBe("c1");
    expect(received.mode).toBe("continuous");
  });

  it("autoreply:activated delivers activationMode and reason", () => {
    const bus = new TypedEventBus();
    const handler = vi.fn();
    const payload: EventMap["autoreply:activated"] = {
      channelId: "c1",
      senderId: "user-1",
      activationMode: "mention",
      reason: "Bot was mentioned in group",
      timestamp: Date.now(),
    };

    bus.on("autoreply:activated", handler);
    bus.emit("autoreply:activated", payload);

    expect(handler).toHaveBeenCalledWith(payload);
    const received = handler.mock.calls[0]![0] as EventMap["autoreply:activated"];
    expect(received.activationMode).toBe("mention");
    expect(received.reason).toBe("Bot was mentioned in group");
  });

  it("sendpolicy:denied delivers channelType, optional chatType, reason", () => {
    const bus = new TypedEventBus();
    const handler = vi.fn();

    // With optional chatType
    const payload: EventMap["sendpolicy:denied"] = {
      channelId: "c1",
      channelType: "telegram",
      chatType: "group",
      reason: "Send policy disallows group messages",
      timestamp: Date.now(),
    };

    bus.on("sendpolicy:denied", handler);
    bus.emit("sendpolicy:denied", payload);

    expect(handler).toHaveBeenCalledWith(payload);
    const received = handler.mock.calls[0]![0] as EventMap["sendpolicy:denied"];
    expect(received.channelType).toBe("telegram");
    expect(received.chatType).toBe("group");
    expect(received.reason).toBe("Send policy disallows group messages");

    // Without optional chatType
    const minPayload: EventMap["sendpolicy:denied"] = {
      channelId: "c2",
      channelType: "discord",
      reason: "Channel blocked",
      timestamp: Date.now(),
    };
    bus.emit("sendpolicy:denied", minPayload);
    expect(handler.mock.calls[1]![0].chatType).toBeUndefined();
  });

  it("debounce:buffered delivers windowMs and bufferedCount", () => {
    const bus = new TypedEventBus();
    const handler = vi.fn();
    const payload: EventMap["debounce:buffered"] = {
      sessionKey: testSessionKey,
      channelType: "telegram",
      bufferedCount: 4,
      windowMs: 2000,
      timestamp: Date.now(),
    };

    bus.on("debounce:buffered", handler);
    bus.emit("debounce:buffered", payload);

    expect(handler).toHaveBeenCalledWith(payload);
    const received = handler.mock.calls[0]![0] as EventMap["debounce:buffered"];
    expect(received.windowMs).toBe(2000);
    expect(received.bufferedCount).toBe(4);
  });

  it("retry:attempted delivers attempt, maxAttempts, delayMs, error", () => {
    const bus = new TypedEventBus();
    const handler = vi.fn();
    const payload: EventMap["retry:attempted"] = {
      channelId: "c1",
      chatId: "chat-1",
      attempt: 2,
      maxAttempts: 3,
      delayMs: 1000,
      error: "Connection timeout",
      timestamp: Date.now(),
    };

    bus.on("retry:attempted", handler);
    bus.emit("retry:attempted", payload);

    expect(handler).toHaveBeenCalledWith(payload);
    const received = handler.mock.calls[0]![0] as EventMap["retry:attempted"];
    expect(received.attempt).toBe(2);
    expect(received.maxAttempts).toBe(3);
    expect(received.delayMs).toBe(1000);
    expect(received.error).toBe("Connection timeout");
  });

  it("steer:injected delivers sessionKey, channelType, agentId", () => {
    const bus = new TypedEventBus();
    const handler = vi.fn();
    const payload: EventMap["steer:injected"] = {
      sessionKey: testSessionKey,
      channelType: "discord",
      agentId: "agent-1",
      timestamp: Date.now(),
    };

    bus.on("steer:injected", handler);
    bus.emit("steer:injected", payload);

    expect(handler).toHaveBeenCalledWith(payload);
    const received = handler.mock.calls[0]![0] as EventMap["steer:injected"];
    expect(received.sessionKey).toEqual(testSessionKey);
    expect(received.agentId).toBe("agent-1");
  });

  it("steer:rejected delivers reason union", () => {
    const bus = new TypedEventBus();
    const handler = vi.fn();

    for (const reason of ["not_streaming", "compacting", "no_active_run"] as const) {
      const payload: EventMap["steer:rejected"] = {
        sessionKey: testSessionKey,
        channelType: "telegram",
        agentId: "agent-1",
        reason,
        timestamp: Date.now(),
      };
      bus.on("steer:rejected", handler);
      bus.emit("steer:rejected", payload);
      bus.removeAllListeners("steer:rejected");
    }

    expect(handler).toHaveBeenCalledTimes(3);
    expect(handler.mock.calls[0]![0].reason).toBe("not_streaming");
    expect(handler.mock.calls[1]![0].reason).toBe("compacting");
    expect(handler.mock.calls[2]![0].reason).toBe("no_active_run");
  });

  it("sender:blocked delivers channelType, senderId, channelId", () => {
    const bus = new TypedEventBus();
    const handler = vi.fn();
    const payload: EventMap["sender:blocked"] = {
      channelType: "telegram",
      senderId: "user-123",
      channelId: "chat-456",
      timestamp: Date.now(),
    };
    bus.on("sender:blocked", handler);
    bus.emit("sender:blocked", payload);
    expect(handler).toHaveBeenCalledWith(payload);
    const received = handler.mock.calls[0]![0] as EventMap["sender:blocked"];
    expect(received.channelType).toBe("telegram");
    expect(received.senderId).toBe("user-123");
    expect(received.channelId).toBe("chat-456");
  });

  it("type safety: @ts-expect-error for missing required fields", () => {
    const bus = new TypedEventBus();

    // @ts-expect-error - missing capabilities in channel:registered
    bus.emit("channel:registered", { channelType: "x", pluginId: "y", timestamp: 1 });

    // @ts-expect-error - missing queueDepth in queue:enqueued
    bus.emit("queue:enqueued", {
      sessionKey: testSessionKey, channelType: "x", mode: "queue", timestamp: 1,
    });
  });
});
