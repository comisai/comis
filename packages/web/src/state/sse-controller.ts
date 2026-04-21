// SPDX-License-Identifier: Apache-2.0
/**
 * Lit ReactiveController for SSE event subscriptions.
 *
 * Manages the lifecycle of SSE event listeners, automatically subscribing
 * on host connect and unsubscribing on host disconnect. This prevents
 * memory leaks and ensures clean component teardown.
 *
 * NOTE: This controller is scaffolding for future WebSocket push support.
 * It is not currently instantiated — only PollingController is used for badge counts.
 */

import type { ReactiveController, ReactiveControllerHost } from "lit";
import type { EventDispatcher } from "./event-dispatcher.js";

/**
 * ReactiveController that bridges SSE events from EventDispatcher
 * to a Lit host component's lifecycle.
 *
 * Usage:
 * ```ts
 * new SseController(this, eventDispatcher, {
 *   "agent:status": (data) => { ... },
 *   "system:error": (data) => { ... },
 * });
 * ```
 */
export class SseController implements ReactiveController {
  private readonly _host: ReactiveControllerHost;
  private readonly _eventDispatcher: EventDispatcher;
  private readonly _events: Record<string, (data: unknown) => void>;
  private _unsubs: Array<() => void> = [];

  constructor(
    host: ReactiveControllerHost,
    eventDispatcher: EventDispatcher,
    events: Record<string, (data: unknown) => void>,
  ) {
    this._host = host;
    this._eventDispatcher = eventDispatcher;
    this._events = events;
    this._host.addController(this);
  }

  hostConnected(): void {
    for (const [type, handler] of Object.entries(this._events)) {
      const unsub = this._eventDispatcher.addEventListener(type, handler);
      this._unsubs.push(unsub);
    }
  }

  hostDisconnected(): void {
    for (const unsub of this._unsubs) {
      unsub();
    }
    this._unsubs = [];
  }
}
