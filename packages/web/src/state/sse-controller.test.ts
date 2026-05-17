// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for SseController.
 *
 * Covers the Lit ReactiveController lifecycle bridging SSE events from an
 * EventDispatcher to a host element. hostConnected subscribes for every
 * registered event type; hostDisconnected runs each unsubscribe and clears
 * the internal list. No timers — purely subscription bookkeeping.
 *
 * @module
 */

import { describe, it, expect, vi } from "vitest";
import type { ReactiveControllerHost } from "lit";
import type { EventDispatcher } from "./event-dispatcher.js";
import { SseController } from "./sse-controller.js";

// -- Helpers --

function makeHost(): {
  host: ReactiveControllerHost;
  controllers: unknown[];
} {
  const controllers: unknown[] = [];
  const host: ReactiveControllerHost = {
    addController(c: unknown): void {
      controllers.push(c);
    },
    removeController: vi.fn(),
    requestUpdate: vi.fn(),
    updateComplete: Promise.resolve(true),
  };
  return { host, controllers };
}

function makeDispatcher(): {
  dispatcher: EventDispatcher;
  registered: Array<{ type: string; handler: (data: unknown) => void }>;
  unsubs: ReturnType<typeof vi.fn>[];
} {
  const registered: Array<{ type: string; handler: (data: unknown) => void }> = [];
  const unsubs: ReturnType<typeof vi.fn>[] = [];
  const dispatcher = {
    addEventListener(type: string, handler: (data: unknown) => void): () => void {
      registered.push({ type, handler });
      const unsub = vi.fn();
      unsubs.push(unsub);
      return unsub;
    },
    start: vi.fn(),
    stop: vi.fn(),
    connected: false,
  } as unknown as EventDispatcher;
  return { dispatcher, registered, unsubs };
}

describe("SseController", () => {
  it("registers itself with the host element via addController on construction", () => {
    const { host, controllers } = makeHost();
    const { dispatcher } = makeDispatcher();
    const ctrl = new SseController(host, dispatcher, {});
    expect(controllers).toContain(ctrl);
  });

  it("subscribes to every event type in the events map on hostConnected lifecycle hook", () => {
    const { host } = makeHost();
    const { dispatcher, registered } = makeDispatcher();
    const onAgentStatus = vi.fn();
    const onSystemError = vi.fn();
    const ctrl = new SseController(host, dispatcher, {
      "agent:status": onAgentStatus,
      "system:error": onSystemError,
    });
    ctrl.hostConnected();
    expect(registered).toHaveLength(2);
    const types = registered.map((r) => r.type).sort();
    expect(types).toEqual(["agent:status", "system:error"]);
  });

  it("forwards the original handler reference to dispatcher.addEventListener for each event type", () => {
    const { host } = makeHost();
    const { dispatcher, registered } = makeDispatcher();
    const handler = vi.fn();
    new SseController(host, dispatcher, { "agent:status": handler }).hostConnected();
    expect(registered[0]?.handler).toBe(handler);
  });

  it("invokes every captured unsubscribe function on hostDisconnected lifecycle hook", () => {
    const { host } = makeHost();
    const { dispatcher, unsubs } = makeDispatcher();
    const ctrl = new SseController(host, dispatcher, {
      "agent:status": vi.fn(),
      "system:error": vi.fn(),
    });
    ctrl.hostConnected();
    ctrl.hostDisconnected();
    expect(unsubs[0]).toHaveBeenCalledTimes(1);
    expect(unsubs[1]).toHaveBeenCalledTimes(1);
  });

  it("clears the internal unsubs array on hostDisconnected so a re-connect re-subscribes cleanly", () => {
    const { host } = makeHost();
    const { dispatcher, registered, unsubs } = makeDispatcher();
    const ctrl = new SseController(host, dispatcher, {
      "agent:status": vi.fn(),
    });
    ctrl.hostConnected();
    ctrl.hostDisconnected();
    // Re-connect to assert it does not re-trigger the prior unsub captures.
    ctrl.hostConnected();
    expect(registered).toHaveLength(2);
    expect(unsubs).toHaveLength(2);
    expect(unsubs[0]).toHaveBeenCalledTimes(1); // first cycle's unsub ran once
  });

  it("subscribes nothing when constructed with an empty events map (no-op host lifecycle)", () => {
    const { host } = makeHost();
    const { dispatcher, registered } = makeDispatcher();
    const ctrl = new SseController(host, dispatcher, {});
    ctrl.hostConnected();
    expect(registered).toHaveLength(0);
    // hostDisconnected on an empty controller is safe and clears nothing.
    expect(() => ctrl.hostDisconnected()).not.toThrow();
  });
});
