import { describe, it, expect, vi } from "vitest";
import type { EventMap } from "./events.js";
import type { MessagingEvents } from "./events-messaging.js";
import type { AgentEvents } from "./events-agent.js";
import type { ChannelEvents } from "./events-channel.js";
import type { InfraEvents } from "./events-infra.js";
import { TypedEventBus } from "./bus.js";

/**
 * Compile-time type assertion helpers.
 * These produce no runtime code but enforce structural relationships.
 */
type Expect<T extends true> = T;
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
  ? true
  : false;

describe("EventMap composition", () => {
  it("EventMap extends all 4 sub-interfaces", () => {
    // Compile-time proof: EventMap is assignable from each sub-interface's keys.
    // If any sub-interface is missing from the extends clause, these would fail.
    type _MessagingKeys = Expect<Equal<
      keyof MessagingEvents extends keyof EventMap ? true : false,
      true
    >>;
    type _AgentKeys = Expect<Equal<
      keyof AgentEvents extends keyof EventMap ? true : false,
      true
    >>;
    type _ChannelKeys = Expect<Equal<
      keyof ChannelEvents extends keyof EventMap ? true : false,
      true
    >>;
    type _InfraKeys = Expect<Equal<
      keyof InfraEvents extends keyof EventMap ? true : false,
      true
    >>;

    // Runtime: verify representative keys exist
    const bus = new TypedEventBus();
    const keys: (keyof EventMap)[] = [
      "message:received",
      "skill:loaded",
      "channel:registered",
      "config:patched",
      "graph:started",
    ];
    expect(keys).toHaveLength(5);
  });

  it("round-trips one event from each domain group through TypedEventBus", () => {
    const bus = new TypedEventBus();

    // MessagingEvents: message:received
    const msgHandler = vi.fn();
    const sessionKey = { tenantId: "t1", userId: "u1", channelId: "c1" };
    const message = {
      id: "550e8400-e29b-41d4-a716-446655440000",
      channelId: "c1",
      channelType: "telegram" as const,
      senderId: "u1",
      text: "hello",
      timestamp: Date.now(),
      attachments: [],
      metadata: {},
    };
    bus.on("message:received", msgHandler);
    bus.emit("message:received", { message, sessionKey });
    expect(msgHandler).toHaveBeenCalledOnce();
    expect(msgHandler.mock.calls[0]![0].message.text).toBe("hello");
    expect(msgHandler.mock.calls[0]![0].sessionKey.tenantId).toBe("t1");

    // AgentEvents: skill:loaded
    const skillHandler = vi.fn();
    const skillPayload = { skillName: "greet", source: "/skills/greet.md", timestamp: Date.now() };
    bus.on("skill:loaded", skillHandler);
    bus.emit("skill:loaded", skillPayload);
    expect(skillHandler).toHaveBeenCalledWith(skillPayload);

    // ChannelEvents: channel:registered
    const chanHandler = vi.fn();
    const chanPayload: EventMap["channel:registered"] = {
      channelType: "discord",
      pluginId: "discord-01",
      capabilities: {
        chatTypes: ["dm", "group"],
        features: {
          reactions: true,
          editMessages: true,
          deleteMessages: true,
          fetchHistory: false,
          attachments: true,
          threads: false,
          mentions: true,
          formatting: ["markdown"],
          buttons: false,
          cards: false,
          effects: false,
        },
        limits: { maxMessageChars: 2000 },
        streaming: { supported: false, throttleMs: 300, method: "none" },
        threading: { supported: false, threadType: "none" },
      },
      timestamp: Date.now(),
    };
    bus.on("channel:registered", chanHandler);
    bus.emit("channel:registered", chanPayload);
    expect(chanHandler).toHaveBeenCalledWith(chanPayload);

    // InfraEvents: config:patched
    const cfgHandler = vi.fn();
    const cfgPayload = { section: "agent", key: "model", patchedBy: "admin", timestamp: Date.now() };
    bus.on("config:patched", cfgHandler);
    bus.emit("config:patched", cfgPayload);
    expect(cfgHandler).toHaveBeenCalledWith(cfgPayload);
  });

  it("keyof EventMap includes events from all 4 sub-interfaces", () => {
    // Type-level: satisfies checks that specific event names are valid EventMap keys
    const _msgKey: keyof EventMap = "message:received" satisfies keyof MessagingEvents;
    const _agentKey: keyof EventMap = "tool:executed" satisfies keyof AgentEvents;
    const _chanKey: keyof EventMap = "queue:enqueued" satisfies keyof ChannelEvents;
    const _infraKey: keyof EventMap = "system:shutdown" satisfies keyof InfraEvents;

    expect(true).toBe(true); // type-level test passes if it compiles
  });

  it("type safety: @ts-expect-error for nonexistent event names on EventMap-typed bus", () => {
    const bus = new TypedEventBus();

    // @ts-expect-error - nonexistent event name
    bus.on("does:not:exist", vi.fn());

    // @ts-expect-error - close but wrong event name
    bus.on("message:receivd", vi.fn());
  });
});
