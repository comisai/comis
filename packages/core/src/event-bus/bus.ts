// SPDX-License-Identifier: Apache-2.0
import { EventEmitter } from "node:events";
import type { EventMap } from "./events.js";

/**
 * Handler function type for a specific event.
 */
export type EventHandler<K extends keyof EventMap> = (payload: EventMap[K]) => void;

/**
 * TypedEventBus: Type-safe wrapper around Node.js EventEmitter.
 *
 * All event names and payloads are constrained by the EventMap interface.
 * This provides compile-time safety: emitting "message:received" with a
 * wrong payload shape is a type error, and subscribing to a nonexistent
 * event name is also a type error.
 *
 * Internally delegates to a standard EventEmitter for battle-tested
 * performance and memory leak detection (maxListeners warning).
 */
export class TypedEventBus {
  private readonly emitter = new EventEmitter();

  /**
   * Emit an event with the corresponding typed payload.
   * Returns true if there were listeners, false otherwise.
   */
  emit<K extends keyof EventMap>(event: K, payload: EventMap[K]): boolean {
    return this.emitter.emit(event, payload);
  }

  /**
   * Subscribe to an event. Handler is called every time the event fires.
   */
  on<K extends keyof EventMap>(event: K, handler: EventHandler<K>): this {
    this.emitter.on(event, handler);
    return this;
  }

  /**
   * Unsubscribe a specific handler from an event.
   */
  off<K extends keyof EventMap>(event: K, handler: EventHandler<K>): this {
    this.emitter.off(event, handler);
    return this;
  }

  /**
   * Subscribe to an event for a single firing only.
   * The handler is automatically removed after the first call.
   */
  once<K extends keyof EventMap>(event: K, handler: EventHandler<K>): this {
    this.emitter.once(event, handler);
    return this;
  }

  /**
   * Remove all listeners for a specific event, or all events if none specified.
   */
  removeAllListeners<K extends keyof EventMap>(event?: K): this {
    if (event !== undefined) {
      this.emitter.removeAllListeners(event);
    } else {
      this.emitter.removeAllListeners();
    }
    return this;
  }

  /**
   * Return the number of listeners subscribed to a specific event.
   */
  listenerCount<K extends keyof EventMap>(event: K): number {
    return this.emitter.listenerCount(event);
  }

  /**
   * Set the maximum number of listeners per event before Node.js
   * emits a memory leak warning. Default is 10.
   */
  setMaxListeners(n: number): this {
    this.emitter.setMaxListeners(n);
    return this;
  }
}
