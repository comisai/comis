// SPDX-License-Identifier: Apache-2.0
/**
 * Lit ReactiveController for SSE event subscriptions.
 *
 * Manages the lifecycle of SSE event listeners, automatically subscribing
 * on host connect and unsubscribing on host disconnect. This prevents
 * memory leaks and ensures clean component teardown.
 *
 * Child views consume events via `document.addEventListener(type, ...)`
 * because `EventDispatcher.deliver()` re-dispatches every SSE event as a
 * document CustomEvent (see EventDispatcher channel 2). Listening on
 * `document` is also what makes test event injection
 * (`document.dispatchEvent(new CustomEvent(...))`) work end-to-end without
 * needing access to the dispatcher instance.
 */

import type { ReactiveController, ReactiveControllerHost } from "lit";
import type { EventDispatcher } from "./event-dispatcher.js";

/**
 * ReactiveController that bridges SSE events to a Lit host component's
 * lifecycle by listening on `document` (the EventDispatcher's second
 * delivery channel). The `eventDispatcher` parameter is retained for API
 * compatibility; it is unused inside this controller because the
 * dispatcher already re-fires every event on `document`.
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
  // Kept for API stability with existing call sites; not used internally.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  private readonly _eventDispatcher: EventDispatcher;
  private readonly _events: Record<string, (data: unknown) => void>;
  private readonly _docHandlers: Array<{ type: string; handler: (e: Event) => void }> = [];

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
      const docHandler = (e: Event): void => {
        // CustomEvent carries the event payload on .detail; non-custom
        // listeners receive {} so handlers stay defensive.
        const detail = (e as CustomEvent).detail;
        handler(detail);
      };
      document.addEventListener(type, docHandler);
      this._docHandlers.push({ type, handler: docHandler });
    }
  }

  hostDisconnected(): void {
    for (const { type, handler } of this._docHandlers) {
      document.removeEventListener(type, handler);
    }
    this._docHandlers.length = 0;
  }
}
