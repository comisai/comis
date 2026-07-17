// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from "vitest";
import type { EventMap } from "./events.js";
import { TypedEventBus } from "./bus.js";

// This file uses "system:error" as its canonical sample event for bus-API
// coverage when a typed payload is required, plus "config:patched" /
// "session:created" / "audit:event" for tests that already used a
// different event.

describe("TypedEventBus", () => {
  it("emit triggers on handler with correct payload", () => {
    const bus = new TypedEventBus();
    const handler = vi.fn();

    bus.on("system:error", handler);
    const payload = { error: new Error("test"), source: "unit-test" };
    bus.emit("system:error", payload);

    expect(handler).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledWith(payload);
  });

  it("once fires only once", () => {
    const bus = new TypedEventBus();
    const handler = vi.fn();

    bus.once("system:error", handler);
    const firstPayload = { error: new Error("first"), source: "unit-test" };
    const secondPayload = { error: new Error("second"), source: "unit-test" };
    bus.emit("system:error", firstPayload);
    bus.emit("system:error", secondPayload);

    expect(handler).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledWith(firstPayload);
  });

  it("off removes the registered handler so subsequent emits do not invoke it", () => {
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

    bus.on("system:error", handler1);
    bus.on("system:error", handler2);
    bus.on("background_task:cancelled", otherHandler);

    bus.removeAllListeners("system:error");

    bus.emit("system:error", { error: new Error("test"), source: "unit-test" });
    bus.emit("background_task:cancelled", { agentId: "a", taskId: "t", toolName: "tool", timestamp: Date.now() });

    expect(handler1).not.toHaveBeenCalled();
    expect(handler2).not.toHaveBeenCalled();
    expect(otherHandler).toHaveBeenCalledOnce();
  });

  it("removeAllListeners without argument removes all", () => {
    const bus = new TypedEventBus();
    const handler1 = vi.fn();
    const handler2 = vi.fn();

    bus.on("system:error", handler1);
    bus.on("background_task:cancelled", handler2);

    bus.removeAllListeners();

    bus.emit("system:error", { error: new Error("test"), source: "unit-test" });
    bus.emit("background_task:cancelled", { agentId: "a", taskId: "t", toolName: "tool", timestamp: Date.now() });

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

    bus.on("system:error", handler1);
    bus.on("system:error", handler2);
    bus.on("system:error", handler3);

    bus.emit("system:error", { error: new Error("multi"), source: "unit-test" });

    expect(handler1).toHaveBeenCalledOnce();
    expect(handler2).toHaveBeenCalledOnce();
    expect(handler3).toHaveBeenCalledOnce();
  });

  it("safe emission reaches later listeners and reports each subscriber failure", () => {
    const bus = new TypedEventBus();
    const firstFailure = new Error("first subscriber failed");
    const thirdFailure = new Error("third subscriber failed");
    const laterHandler = vi.fn();
    const payload = { error: new Error("sample"), source: "unit-test" };

    bus.on("system:error", () => {
      throw firstFailure;
    });
    bus.on("system:error", laterHandler);
    bus.on("system:error", () => {
      throw thirdFailure;
    });

    const result = bus.emitSafely("system:error", payload);

    expect(result.hadListeners).toBe(true);
    expect(result.failures).toEqual([
      { listenerIndex: 0, error: firstFailure },
      { listenerIndex: 2, error: thirdFailure },
    ]);
    expect(laterHandler).toHaveBeenCalledOnce();
    expect(laterHandler).toHaveBeenCalledWith(payload);
  });

  it("safe emission preserves once-listener removal after a subscriber throws", () => {
    const bus = new TypedEventBus();
    const onceHandler = vi.fn(() => {
      throw new Error("one-time subscriber failed");
    });
    const payload = { error: new Error("sample"), source: "unit-test" };

    bus.once("system:error", onceHandler);

    expect(bus.emitSafely("system:error", payload).failures).toHaveLength(1);
    expect(bus.emitSafely("system:error", payload).failures).toHaveLength(0);
    expect(onceHandler).toHaveBeenCalledOnce();
    expect(bus.listenerCount("system:error")).toBe(0);
  });

  it("safe emission contains rejected async listeners and reports them in registration order", async () => {
    const bus = new TypedEventBus();
    const firstFailure = new Error("async subscriber failed");
    const laterHandler = vi.fn();
    const payload = { error: new Error("sample"), source: "unit-test" };

    bus.on("system:error", async () => {
      await Promise.resolve();
      throw firstFailure;
    });
    bus.on("system:error", laterHandler);

    const result = bus.emitSafely("system:error", payload);

    expect(result.failures).toEqual([]);
    expect(laterHandler).toHaveBeenCalledOnce();
    await expect(result.pendingFailures).resolves.toEqual([
      { listenerIndex: 0, error: firstFailure },
    ]);
  });

  it("safe emission gives every observer one detached deeply immutable cyclic snapshot", () => {
    const bus = new TypedEventBus();
    const metadata: Record<string, unknown> = {
      nested: { principal: "guest" },
      roles: ["guest"],
      lookup: new Map<string, unknown>([["principal", { name: "guest" }]]),
      tags: new Set<string>(["guest"]),
      observedAt: new Date(1_700_000_000_000),
    };
    metadata.self = metadata;
    const payload: EventMap["audit:event"] = {
      timestamp: 1_700_000_000_000,
      agentId: "agent_a",
      tenantId: "tenant_a",
      actionType: "test",
      outcome: "success",
      metadata,
    };
    const laterObserver = vi.fn();

    bus.on("audit:event", (observed) => {
      const snapshot = observed.metadata!;
      expect(snapshot).not.toBe(metadata);
      expect(snapshot.self).toBe(snapshot);
      expect(() => {
        (snapshot.nested as { principal: string }).principal = "admin";
      }).toThrow();
      expect(() => {
        (snapshot.roles as string[]).push("admin");
      }).toThrow();
      expect(() => {
        (snapshot.lookup as Map<string, unknown>).set("principal", { name: "admin" });
      }).toThrow();
      expect(() => {
        (snapshot.tags as Set<string>).add("admin");
      }).toThrow();
      expect(() => {
        (snapshot.observedAt as Date).setUTCFullYear(2030);
      }).toThrow();
    });
    bus.on("audit:event", laterObserver);

    const result = bus.emitSafely("audit:event", payload);

    expect(result.failures).toEqual([]);
    expect(laterObserver).toHaveBeenCalledOnce();
    const later = laterObserver.mock.calls[0]![0] as EventMap["audit:event"];
    expect((later.metadata!.nested as { principal: string }).principal).toBe("guest");
    expect(later.metadata!.roles).toEqual(["guest"]);
    expect((later.metadata!.lookup as Map<string, { name: string }>).get("principal")).toEqual({ name: "guest" });
    expect(Array.from(later.metadata!.tags as Set<string>)).toEqual(["guest"]);
    expect((later.metadata!.observedAt as Date).getUTCFullYear()).toBe(2023);
    expect((metadata.nested as { principal: string }).principal).toBe("guest");
    expect(metadata.roles).toEqual(["guest"]);
    expect((metadata.lookup as Map<string, { name: string }>).get("principal")).toEqual({ name: "guest" });
    expect(Array.from(metadata.tags as Set<string>)).toEqual(["guest"]);
    expect((metadata.observedAt as Date).getUTCFullYear()).toBe(2023);
  });

  it("safe emission clones and freezes Error name message stack cause and cyclic references", () => {
    const bus = new TypedEventBus();
    const cause = new Error("authoritative cause");
    const error = new TypeError("authoritative error", { cause });
    cause.cause = error;
    const laterObserver = vi.fn();

    bus.on("system:error", (observed) => {
      expect(observed.error).not.toBe(error);
      expect(observed.error).toBeInstanceOf(TypeError);
      expect(observed.error.name).toBe("TypeError");
      expect(observed.error.message).toBe("authoritative error");
      expect(observed.error.stack).toBe(error.stack);
      expect(observed.error.cause).toBeInstanceOf(Error);
      expect((observed.error.cause as Error).cause).toBe(observed.error);
      expect(() => {
        observed.error.message = "subscriber rewrite";
      }).toThrow();
      expect(() => {
        (observed.error.cause as Error).message = "subscriber cause rewrite";
      }).toThrow();
    });
    bus.on("system:error", laterObserver);

    const result = bus.emitSafely("system:error", { error, source: "unit-test" });

    expect(result.failures).toEqual([]);
    const later = (laterObserver.mock.calls[0]![0] as EventMap["system:error"]).error;
    expect(later.message).toBe("authoritative error");
    expect((later.cause as Error).message).toBe("authoritative cause");
    expect(error.message).toBe("authoritative error");
    expect(cause.message).toBe("authoritative cause");
  });

  it("safe emission detaches shared buffers and blocks mutable buffer escape hatches", async () => {
    const bus = new TypedEventBus();
    const shared = new SharedArrayBuffer(4);
    const sharedView = new Uint8Array(shared);
    sharedView.set([7, 8, 9, 10]);
    const buffer = new ArrayBuffer(2);
    new Uint8Array(buffer).set([3, 4]);
    const dataView = new DataView(buffer);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    bus.on("audit:event", async (observed) => {
      await gate;
      const metadata = observed.metadata!;
      const observedShared = metadata.shared as SharedArrayBuffer;
      const observedTyped = metadata.sharedView as Uint8Array;
      const observedBuffer = metadata.buffer as ArrayBuffer;
      const observedDataView = metadata.dataView as DataView;
      expect(Array.from(new Uint8Array(observedShared.slice(0)))).toEqual([7, 8, 9, 10]);
      expect(Array.from(observedTyped)).toEqual([7, 8, 9, 10]);
      expect(Array.from(new Uint8Array(observedBuffer.slice(0)))).toEqual([3, 4]);
      expect(observedBuffer.valueOf()).toBe(observedBuffer);
      expect(observedDataView.valueOf()).toBe(observedDataView);
      expect(() => observedBuffer.transfer()).toThrow();
      expect(() => observedDataView.setUint8(0, 99)).toThrow();
      expect(() => observedTyped.fill(99)).toThrow();
    });

    const emission = bus.emitSafely("audit:event", {
      timestamp: 1,
      agentId: "agent_a",
      tenantId: "tenant_a",
      actionType: "test",
      outcome: "success",
      metadata: { shared, sharedView, buffer, dataView },
    });
    sharedView.fill(99);
    new Uint8Array(buffer).fill(88);
    release();

    await expect(emission.pendingFailures).resolves.toEqual([]);
  });

  it("safe emission reports snapshot failures without exposing the mutable publisher payload", async () => {
    const bus = new TypedEventBus();
    const observer = vi.fn();
    const metadata = { unsupported: () => "not cloneable" };
    bus.on("audit:event", observer);

    const result = bus.emitSafely("audit:event", {
      timestamp: 1,
      agentId: "agent_a",
      tenantId: "tenant_a",
      actionType: "test",
      outcome: "success",
      metadata,
    });

    expect(result.hadListeners).toBe(true);
    expect(result.failures).toEqual([
      { listenerIndex: -1, error: expect.any(Error) },
    ]);
    await expect(result.pendingFailures).resolves.toEqual([]);
    expect(observer).not.toHaveBeenCalled();
    expect(metadata.unsupported()).toBe("not cloneable");
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
    bus.emit("system:error", { error: new Error("ok"), source: "unit-test" });

    // @ts-expect-error - missing required "source" field
    bus.emit("system:error", { error: new Error("missing-field") });

    // @ts-expect-error - wrong type for "error" (string instead of Error)
    bus.emit("system:error", { error: "not-an-error-instance", source: "unit-test" });

    // @ts-expect-error - nonexistent event name
    bus.emit("nonexistent:event", { foo: "bar" });
  });

  it("methods return this for chaining", () => {
    const bus = new TypedEventBus();
    const handler = vi.fn();

    const result = bus.on("system:error", handler);
    expect(result).toBe(bus);

    const result2 = bus.off("system:error", handler);
    expect(result2).toBe(bus);

    const result3 = bus.once("system:error", handler);
    expect(result3).toBe(bus);

    const result4 = bus.removeAllListeners("system:error");
    expect(result4).toBe(bus);

    const result5 = bus.setMaxListeners(20);
    expect(result5).toBe(bus);
  });
});
