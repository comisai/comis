// SPDX-License-Identifier: Apache-2.0
import { EventEmitter } from "node:events";
import { fromPromise, tryCatch } from "@comis/shared";
import type { EventMap } from "./events.js";
import { createImmutableEventSnapshot } from "./immutable-event-snapshot.js";

/**
 * Handler function type for a specific event.
 */
export type EventHandler<K extends keyof EventMap> = (payload: EventMap[K]) => void;

/** One subscriber failure captured during isolated observational fan-out. */
export interface EventSubscriberFailure {
  readonly listenerIndex: number;
  readonly error: Error;
}

/** Result of an isolated observational event fan-out. */
export interface SafeEventEmission {
  readonly hadListeners: boolean;
  /** Subscriber failures raised before the listener returned. */
  readonly failures: readonly EventSubscriberFailure[];
  /** Rejections from listeners that returned a promise; always resolves. */
  readonly pendingFailures: Promise<readonly EventSubscriberFailure[]>;
}

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
   * Emit an observational event without allowing one subscriber to starve later
   * subscribers or alter the publisher's already-completed side effect.
   *
   * Ordinary `emit()` deliberately preserves Node's surfaced-failure semantics.
   * Callers use this method only after an irreversible boundary action (for
   * example, a platform message send), then log every returned failure with an
   * operator-actionable hint. Raw listeners are invoked so `once()` removal and
   * registration order remain identical to `EventEmitter.emit()`. Listeners
   * that return promises are not awaited by the publisher; their rejections
   * are contained and reported through `pendingFailures`.
   */
  emitSafely<K extends keyof EventMap>(event: K, payload: EventMap[K]): SafeEventEmission {
    const listeners = this.emitter.rawListeners(event) as Array<(
      this: EventEmitter,
      payload: EventMap[K],
    ) => unknown>;
    const failures: EventSubscriberFailure[] = [];
    const pending: Array<Promise<EventSubscriberFailure | undefined>> = [];

    if (listeners.length === 0) {
      return { hadListeners: false, failures, pendingFailures: Promise.resolve([]) };
    }
    const snapshot = createImmutableEventSnapshot(payload);
    if (!snapshot.ok) {
      failures.push({ listenerIndex: -1, error: snapshot.error });
      return { hadListeners: true, failures, pendingFailures: Promise.resolve([]) };
    }

    for (const [listenerIndex, listener] of listeners.entries()) {
      const invoked = tryCatch(() => listener.call(this.emitter, snapshot.value));
      if (!invoked.ok) {
        failures.push({ listenerIndex, error: invoked.error });
        continue;
      }
      pending.push(fromPromise(Promise.resolve(invoked.value)).then((settled) =>
        settled.ok ? undefined : { listenerIndex, error: settled.error },
      ));
    }

    const pendingFailures = Promise.all(pending).then((settled) =>
      settled.filter((failure): failure is EventSubscriberFailure => failure !== undefined),
    );
    return { hadListeners: listeners.length > 0, failures, pendingFailures };
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
