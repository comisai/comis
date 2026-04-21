// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createEventDispatcher, type EventDispatcher } from "./event-dispatcher.js";
import { SSE_EVENT_TYPES } from "../api/types/index.js";

// -- Mock EventSource --

class MockEventSource {
  url: string;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  close = vi.fn();
  private listeners = new Map<string, EventListener>();

  addEventListener(type: string, listener: EventListener): void {
    this.listeners.set(type, listener);
  }

  /** Test helper: simulate a typed SSE event */
  simulateEvent(type: string, data: string): void {
    const listener = this.listeners.get(type);
    if (listener) {
      listener({ data } as unknown as Event);
    }
  }

  constructor(url: string) {
    this.url = url;
    MockEventSource.lastInstance = this;
  }
  static lastInstance: MockEventSource | null = null;
}
vi.stubGlobal("EventSource", MockEventSource);

// -- Tests --

const BASE_URL = "http://localhost:3000";
const TOKEN = "test-event-token";

describe("createEventDispatcher", () => {
  let dispatcher: EventDispatcher;

  beforeEach(() => {
    MockEventSource.lastInstance = null;
    dispatcher = createEventDispatcher();
  });

  afterEach(() => {
    dispatcher.stop();
    vi.restoreAllMocks();
    vi.stubGlobal("EventSource", MockEventSource);
  });

  it("returns object with start, stop, addEventListener, connected", () => {
    expect(typeof dispatcher.start).toBe("function");
    expect(typeof dispatcher.stop).toBe("function");
    expect(typeof dispatcher.addEventListener).toBe("function");
    expect(dispatcher.connected).toBeDefined();
  });

  it("start creates EventSource with correct URL including token", () => {
    dispatcher.start(BASE_URL, TOKEN);

    expect(MockEventSource.lastInstance).not.toBeNull();
    expect(MockEventSource.lastInstance!.url).toBe(
      `${BASE_URL}/api/events?token=${encodeURIComponent(TOKEN)}`,
    );
  });

  it("connected becomes true on EventSource onopen", () => {
    expect(dispatcher.connected).toBe(false);

    dispatcher.start(BASE_URL, TOKEN);
    MockEventSource.lastInstance!.onopen!();

    expect(dispatcher.connected).toBe(true);
  });

  it("connected becomes false on EventSource onerror", () => {
    dispatcher.start(BASE_URL, TOKEN);
    MockEventSource.lastInstance!.onopen!();
    expect(dispatcher.connected).toBe(true);

    MockEventSource.lastInstance!.onerror!();
    expect(dispatcher.connected).toBe(false);
  });

  it("addEventListener registers callback for event type", () => {
    const handler = vi.fn();
    dispatcher.addEventListener("message:received", handler);

    dispatcher.start(BASE_URL, TOKEN);
    MockEventSource.lastInstance!.onopen!();

    // Simulate an SSE event
    MockEventSource.lastInstance!.simulateEvent(
      "message:received",
      JSON.stringify({ userId: "u1", text: "hello" }),
    );

    expect(handler).toHaveBeenCalledWith({ userId: "u1", text: "hello" });
  });

  it("addEventListener returns unsubscribe function", () => {
    const handler = vi.fn();
    const unsubscribe = dispatcher.addEventListener("approval:requested", handler);

    expect(typeof unsubscribe).toBe("function");

    unsubscribe();

    dispatcher.start(BASE_URL, TOKEN);
    MockEventSource.lastInstance!.simulateEvent(
      "approval:requested",
      JSON.stringify({ id: 1 }),
    );

    expect(handler).not.toHaveBeenCalled();
  });

  it("callback handlers receive parsed JSON data from SSE events", () => {
    const handler = vi.fn();
    dispatcher.addEventListener("system:error", handler);

    dispatcher.start(BASE_URL, TOKEN);

    const payload = { code: "ERR_01", message: "Something failed" };
    MockEventSource.lastInstance!.simulateEvent(
      "system:error",
      JSON.stringify(payload),
    );

    expect(handler).toHaveBeenCalledWith(payload);
  });

  it("dispatches CustomEvent on document for each received SSE event", () => {
    const received: CustomEvent[] = [];
    const listener = (ev: Event) => received.push(ev as CustomEvent);
    document.addEventListener("message:received", listener);

    dispatcher.start(BASE_URL, TOKEN);

    const payload = { userId: "u2", text: "world" };
    MockEventSource.lastInstance!.simulateEvent(
      "message:received",
      JSON.stringify(payload),
    );

    expect(received).toHaveLength(1);
    expect(received[0].detail).toEqual(payload);

    document.removeEventListener("message:received", listener);
  });

  it("CustomEvent detail contains parsed SSE data", () => {
    const received: CustomEvent[] = [];
    const listener = (ev: Event) => received.push(ev as CustomEvent);
    document.addEventListener("approval:requested", listener);

    dispatcher.start(BASE_URL, TOKEN);

    const data = { approvalId: "ap-123", action: "tool_exec" };
    MockEventSource.lastInstance!.simulateEvent(
      "approval:requested",
      JSON.stringify(data),
    );

    expect(received).toHaveLength(1);
    expect(received[0].detail).toEqual(data);

    document.removeEventListener("approval:requested", listener);
  });

  it("stop closes EventSource", () => {
    dispatcher.start(BASE_URL, TOKEN);
    const source = MockEventSource.lastInstance!;

    dispatcher.stop();

    expect(source.close).toHaveBeenCalledTimes(1);
  });

  it("stop clears all callback handlers", () => {
    const handler = vi.fn();
    dispatcher.addEventListener("message:sent", handler);

    dispatcher.start(BASE_URL, TOKEN);
    dispatcher.stop();

    // Restart and simulate event -- handler should not fire
    dispatcher.start(BASE_URL, TOKEN);
    MockEventSource.lastInstance!.simulateEvent(
      "message:sent",
      JSON.stringify({ text: "hi" }),
    );

    expect(handler).not.toHaveBeenCalled();
  });

  it("registers listeners for all expected SSE event types", () => {
    dispatcher.start(BASE_URL, TOKEN);
    const source = MockEventSource.lastInstance!;

    // Verify all SSE_EVENT_TYPES are registered by checking document receives each
    for (const eventType of SSE_EVENT_TYPES) {
      const received: CustomEvent[] = [];
      const listener = (ev: Event) => received.push(ev as CustomEvent);
      document.addEventListener(eventType, listener);

      source.simulateEvent(eventType, JSON.stringify({ type: eventType }));

      expect(received).toHaveLength(1);
      expect(received[0].type).toBe(eventType);

      document.removeEventListener(eventType, listener);
    }
  });

  it("handles non-JSON SSE data gracefully", () => {
    const handler = vi.fn();
    dispatcher.addEventListener("ping", handler);

    dispatcher.start(BASE_URL, TOKEN);
    MockEventSource.lastInstance!.simulateEvent("ping", "not json");

    expect(handler).toHaveBeenCalledWith("not json");
  });

  it("handles empty SSE data as empty object", () => {
    const handler = vi.fn();
    dispatcher.addEventListener("ping", handler);

    dispatcher.start(BASE_URL, TOKEN);
    MockEventSource.lastInstance!.simulateEvent("ping", "");

    expect(handler).toHaveBeenCalledWith({});
  });

  it("multiple handlers for the same event type all receive the event", () => {
    const handler1 = vi.fn();
    const handler2 = vi.fn();

    dispatcher.addEventListener("message:received", handler1);
    dispatcher.addEventListener("message:received", handler2);

    dispatcher.start(BASE_URL, TOKEN);
    MockEventSource.lastInstance!.simulateEvent(
      "message:received",
      JSON.stringify({ text: "test" }),
    );

    expect(handler1).toHaveBeenCalledWith({ text: "test" });
    expect(handler2).toHaveBeenCalledWith({ text: "test" });
  });

  it("stop sets connected to false", () => {
    dispatcher.start(BASE_URL, TOKEN);
    MockEventSource.lastInstance!.onopen!();
    expect(dispatcher.connected).toBe(true);

    dispatcher.stop();
    expect(dispatcher.connected).toBe(false);
  });
});
