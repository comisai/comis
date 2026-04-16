import { describe, it, expect, vi } from "vitest";
import type { EventMap } from "./events.js";
import { TypedEventBus } from "./bus.js";

describe("TypedEventBus", () => {
  it("emit triggers on handler with correct payload", () => {
    const bus = new TypedEventBus();
    const handler = vi.fn();

    bus.on("system:shutdown", handler);
    bus.emit("system:shutdown", { reason: "test", graceful: true });

    expect(handler).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledWith({ reason: "test", graceful: true });
  });

  it("once fires only once", () => {
    const bus = new TypedEventBus();
    const handler = vi.fn();

    bus.once("system:shutdown", handler);
    bus.emit("system:shutdown", { reason: "first", graceful: true });
    bus.emit("system:shutdown", { reason: "second", graceful: false });

    expect(handler).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledWith({ reason: "first", graceful: true });
  });

  it("off removes handler", () => {
    const bus = new TypedEventBus();
    const handler = vi.fn();

    bus.on("config:patched", handler);
    bus.off("config:patched", handler);
    bus.emit("config:patched", { section: "test", patchedBy: "admin", timestamp: Date.now() });

    expect(handler).not.toHaveBeenCalled();
  });

  it("removeAllListeners works for specific event", () => {
    const bus = new TypedEventBus();
    const handler1 = vi.fn();
    const handler2 = vi.fn();
    const otherHandler = vi.fn();

    bus.on("system:shutdown", handler1);
    bus.on("system:shutdown", handler2);
    bus.on("system:error", otherHandler);

    bus.removeAllListeners("system:shutdown");

    bus.emit("system:shutdown", { reason: "test", graceful: true });
    bus.emit("system:error", { error: new Error("test"), source: "unit-test" });

    expect(handler1).not.toHaveBeenCalled();
    expect(handler2).not.toHaveBeenCalled();
    expect(otherHandler).toHaveBeenCalledOnce();
  });

  it("removeAllListeners without argument removes all", () => {
    const bus = new TypedEventBus();
    const handler1 = vi.fn();
    const handler2 = vi.fn();

    bus.on("system:shutdown", handler1);
    bus.on("system:error", handler2);

    bus.removeAllListeners();

    bus.emit("system:shutdown", { reason: "test", graceful: true });
    bus.emit("system:error", { error: new Error("test"), source: "unit-test" });

    expect(handler1).not.toHaveBeenCalled();
    expect(handler2).not.toHaveBeenCalled();
  });

  it("listenerCount returns correct count", () => {
    const bus = new TypedEventBus();

    expect(bus.listenerCount("session:created")).toBe(0);

    const h1 = vi.fn();
    const h2 = vi.fn();
    const h3 = vi.fn();

    bus.on("session:created", h1);
    expect(bus.listenerCount("session:created")).toBe(1);

    bus.on("session:created", h2);
    bus.on("session:created", h3);
    expect(bus.listenerCount("session:created")).toBe(3);

    bus.off("session:created", h2);
    expect(bus.listenerCount("session:created")).toBe(2);
  });

  it("multiple handlers all fire for same event", () => {
    const bus = new TypedEventBus();
    const handler1 = vi.fn();
    const handler2 = vi.fn();
    const handler3 = vi.fn();

    bus.on("system:shutdown", handler1);
    bus.on("system:shutdown", handler2);
    bus.on("system:shutdown", handler3);

    bus.emit("system:shutdown", { reason: "multi", graceful: false });

    expect(handler1).toHaveBeenCalledOnce();
    expect(handler2).toHaveBeenCalledOnce();
    expect(handler3).toHaveBeenCalledOnce();
  });

  it("handler receives correct typed payload for message:received", () => {
    const bus = new TypedEventBus();
    const handler = vi.fn();
    const sessionKey = {
      tenantId: "tenant-1",
      userId: "user-1",
      channelId: "chan-1",
    };
    const message = {
      id: "550e8400-e29b-41d4-a716-446655440000",
      channelId: "chan-1",
      channelType: "telegram" as const,
      senderId: "user-1",
      text: "Hello, world!",
      timestamp: Date.now(),
      attachments: [],
      metadata: {},
    };

    bus.on("message:received", handler);
    bus.emit("message:received", { message, sessionKey });

    expect(handler).toHaveBeenCalledWith({ message, sessionKey });
    const received = handler.mock.calls[0]![0] as EventMap["message:received"];
    expect(received.message.text).toBe("Hello, world!");
    expect(received.sessionKey.tenantId).toBe("tenant-1");
  });

  it("handler receives correct typed payload for audit:event", () => {
    const bus = new TypedEventBus();
    const handler = vi.fn();
    const auditPayload: EventMap["audit:event"] = {
      timestamp: Date.now(),
      agentId: "agent-1",
      tenantId: "tenant-1",
      actionType: "tool:execute",
      classification: "high-risk",
      outcome: "denied",
      metadata: { tool: "shell:exec", reason: "sandbox violation" },
    };

    bus.on("audit:event", handler);
    bus.emit("audit:event", auditPayload);

    expect(handler).toHaveBeenCalledWith(auditPayload);
    const received = handler.mock.calls[0]![0] as EventMap["audit:event"];
    expect(received.outcome).toBe("denied");
    expect(received.metadata?.tool).toBe("shell:exec");
  });

  it("type safety: @ts-expect-error for wrong payload types", () => {
    const bus = new TypedEventBus();

    // Correct usage compiles fine
    bus.emit("system:shutdown", { reason: "ok", graceful: true });

    // @ts-expect-error - missing required "graceful" field
    bus.emit("system:shutdown", { reason: "missing-field" });

    // @ts-expect-error - wrong type for "graceful" (string instead of boolean)
    bus.emit("system:shutdown", { reason: "wrong-type", graceful: "yes" });

    // @ts-expect-error - nonexistent event name
    bus.emit("nonexistent:event", { foo: "bar" });
  });

  it("methods return this for chaining", () => {
    const bus = new TypedEventBus();
    const handler = vi.fn();

    const result = bus.on("system:shutdown", handler);
    expect(result).toBe(bus);

    const result2 = bus.off("system:shutdown", handler);
    expect(result2).toBe(bus);

    const result3 = bus.once("system:shutdown", handler);
    expect(result3).toBe(bus);

    const result4 = bus.removeAllListeners("system:shutdown");
    expect(result4).toBe(bus);

    const result5 = bus.setMaxListeners(20);
    expect(result5).toBe(bus);
  });
});
