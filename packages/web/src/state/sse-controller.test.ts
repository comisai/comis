// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for SseController.
 *
 * Covers the Lit ReactiveController lifecycle bridging SSE events from the
 * EventDispatcher's document-CustomEvent channel to a host element.
 * hostConnected registers a document listener per event type; hostDisconnected
 * removes them. The dispatcher reference is retained for API stability but
 * unused internally because EventDispatcher.deliver() re-fires every SSE
 * event as a document CustomEvent.
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

function makeDispatcher(): EventDispatcher {
  return {
    addEventListener: vi.fn(() => vi.fn()),
    start: vi.fn(),
    stop: vi.fn(),
    connected: false,
  } as unknown as EventDispatcher;
}

describe("SseController", () => {
  it("registers itself with the host element via addController on construction", () => {
    const { host, controllers } = makeHost();
    const ctrl = new SseController(host, makeDispatcher(), {});
    expect(controllers).toContain(ctrl);
  });

  it("subscribes via document.addEventListener for every event type on hostConnected", () => {
    const { host } = makeHost();
    const onAgentStatus = vi.fn();
    const onSystemError = vi.fn();
    const ctrl = new SseController(host, makeDispatcher(), {
      "agent:status": onAgentStatus,
      "system:error": onSystemError,
    });
    ctrl.hostConnected();

    document.dispatchEvent(new CustomEvent("agent:status", { detail: { agentId: "a" } }));
    document.dispatchEvent(new CustomEvent("system:error", { detail: { kind: "boom" } }));

    expect(onAgentStatus).toHaveBeenCalledWith({ agentId: "a" });
    expect(onSystemError).toHaveBeenCalledWith({ kind: "boom" });
    ctrl.hostDisconnected();
  });

  it("removes document listeners on hostDisconnected so handlers stop firing", () => {
    const { host } = makeHost();
    const handler = vi.fn();
    const ctrl = new SseController(host, makeDispatcher(), { "agent:status": handler });
    ctrl.hostConnected();
    ctrl.hostDisconnected();

    document.dispatchEvent(new CustomEvent("agent:status", { detail: { agentId: "a" } }));
    expect(handler).not.toHaveBeenCalled();
  });

  it("supports reconnect: hostDisconnected then hostConnected re-registers listeners", () => {
    const { host } = makeHost();
    const handler = vi.fn();
    const ctrl = new SseController(host, makeDispatcher(), { "agent:status": handler });
    ctrl.hostConnected();
    ctrl.hostDisconnected();
    ctrl.hostConnected();

    document.dispatchEvent(new CustomEvent("agent:status", { detail: { agentId: "b" } }));
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith({ agentId: "b" });
    ctrl.hostDisconnected();
  });

  it("subscribes nothing when constructed with an empty events map (no-op host lifecycle)", () => {
    const { host } = makeHost();
    const ctrl = new SseController(host, makeDispatcher(), {});
    ctrl.hostConnected();
    // hostDisconnected on an empty controller is safe and clears nothing.
    expect(() => ctrl.hostDisconnected()).not.toThrow();
  });
});
