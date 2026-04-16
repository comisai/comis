/**
 * EventAwaiter: Converts TypedEventBus events into awaitable promises.
 *
 * Provides composable, typed, timeout-safe event assertions for
 * integration tests. Eliminates ad-hoc setTimeout-based event waiting.
 *
 * @example
 * ```ts
 * const awaiter = createEventAwaiter(bus);
 * const payload = await awaiter.waitFor("session:created");
 * awaiter.dispose();
 * ```
 *
 * @module
 */

import type { TypedEventBus, EventMap, EventHandler } from "@comis/core";
import { EVENT_WAIT_MS } from "./timeouts.js";

/**
 * Options for creating an EventAwaiter instance.
 */
export interface EventAwaiterOptions {
  /** Default timeout in ms for all wait operations. Defaults to EVENT_WAIT_MS. */
  defaultTimeoutMs?: number;
}

/**
 * EventAwaiter interface: typed, composable event waiting for tests.
 */
export interface EventAwaiter {
  /**
   * Wait for a single event of the given type.
   * Resolves with the event payload. Rejects on timeout.
   */
  waitFor<K extends keyof EventMap>(
    event: K,
    options?: { timeoutMs?: number; filter?: (payload: EventMap[K]) => boolean },
  ): Promise<EventMap[K]>;

  /**
   * Wait for N events of the given type.
   * Resolves with an array of payloads once N events have been received.
   * Rejects on timeout.
   */
  waitForAll<K extends keyof EventMap>(
    event: K,
    count: number,
    options?: { timeoutMs?: number },
  ): Promise<EventMap[K][]>;

  /**
   * Wait for a sequence of events in order.
   * Each event name in the array must fire in order.
   * Resolves with array of payloads. Rejects on timeout.
   */
  waitForSequence<K extends keyof EventMap>(
    events: K[],
    options?: { timeoutMs?: number },
  ): Promise<EventMap[K][]>;

  /**
   * Capture all events of the given type emitted during an operation.
   * Registers listener before calling the operation, then removes listener
   * after the operation completes and returns all captured payloads.
   */
  collectDuring<K extends keyof EventMap>(
    event: K,
    operation: () => Promise<void>,
  ): Promise<EventMap[K][]>;

  /**
   * Remove all active listeners registered by this awaiter.
   * Safe to call multiple times. Should be called in afterEach().
   */
  dispose(): void;
}

/**
 * Create an EventAwaiter instance bound to the given TypedEventBus.
 *
 * @param bus - The TypedEventBus to listen on
 * @param options - Optional configuration (default timeout, etc.)
 * @returns An EventAwaiter with waitFor, waitForAll, waitForSequence, collectDuring, and dispose methods
 */
export function createEventAwaiter(
  bus: TypedEventBus,
  options?: EventAwaiterOptions,
): EventAwaiter {
  const defaultTimeoutMs = options?.defaultTimeoutMs ?? EVENT_WAIT_MS;
  const activeCleanups = new Set<{ cleanup: () => void; reject: (err: Error) => void }>();

  function waitFor<K extends keyof EventMap>(
    event: K,
    opts?: { timeoutMs?: number; filter?: (payload: EventMap[K]) => boolean },
  ): Promise<EventMap[K]> {
    const timeoutMs = opts?.timeoutMs ?? defaultTimeoutMs;
    const filter = opts?.filter;

    return new Promise<EventMap[K]>((resolve, reject) => {
      let settled = false;
      // eslint-disable-next-line prefer-const -- circular reference: cleanup captures entry, entry contains cleanup
      let entry: { cleanup: () => void; reject: (err: Error) => void };

      const cleanup = (): void => {
        if (!settled) {
          settled = true;
        }
        bus.off(event, handler as EventHandler<K>);
        clearTimeout(timer);
        activeCleanups.delete(entry);
      };

      entry = { cleanup, reject };

      const handler = (payload: EventMap[K]): void => {
        if (settled) return;
        if (filter && !filter(payload)) return;
        cleanup();
        resolve(payload);
      };

      const timer = setTimeout(() => {
        if (settled) return;
        cleanup();
        reject(
          new Error(
            `EventAwaiter: timeout waiting for "${String(event)}" after ${timeoutMs}ms`,
          ),
        );
      }, timeoutMs);

      activeCleanups.add(entry);
      bus.on(event, handler as EventHandler<K>);
    });
  }

  function waitForAll<K extends keyof EventMap>(
    event: K,
    count: number,
    opts?: { timeoutMs?: number },
  ): Promise<EventMap[K][]> {
    const timeoutMs = opts?.timeoutMs ?? defaultTimeoutMs;

    return new Promise<EventMap[K][]>((resolve, reject) => {
      let settled = false;
      const collected: EventMap[K][] = [];
      // eslint-disable-next-line prefer-const -- circular reference: cleanup captures entry, entry contains cleanup
      let entry: { cleanup: () => void; reject: (err: Error) => void };

      const cleanup = (): void => {
        if (!settled) {
          settled = true;
        }
        bus.off(event, handler as EventHandler<K>);
        clearTimeout(timer);
        activeCleanups.delete(entry);
      };

      entry = { cleanup, reject };

      const handler = (payload: EventMap[K]): void => {
        if (settled) return;
        collected.push(payload);
        if (collected.length === count) {
          cleanup();
          resolve(collected);
        }
      };

      const timer = setTimeout(() => {
        if (settled) return;
        cleanup();
        reject(
          new Error(
            `EventAwaiter: timeout waiting for ${count} "${String(event)}" events after ${timeoutMs}ms (collected ${collected.length}/${count})`,
          ),
        );
      }, timeoutMs);

      activeCleanups.add(entry);
      bus.on(event, handler as EventHandler<K>);
    });
  }

  function waitForSequence<K extends keyof EventMap>(
    events: K[],
    opts?: { timeoutMs?: number },
  ): Promise<EventMap[K][]> {
    const timeoutMs = opts?.timeoutMs ?? defaultTimeoutMs;

    return new Promise<EventMap[K][]>((resolve, reject) => {
      let settled = false;
      let index = 0;
      const collected: EventMap[K][] = [];
      // eslint-disable-next-line prefer-const -- circular reference: cleanup captures entry, entry contains cleanup
      let entry: { cleanup: () => void; reject: (err: Error) => void };

      // Deduplicate event names for handler registration
      const uniqueEvents = [...new Set(events)];

      const handlerMap = new Map<K, EventHandler<K>>();

      const cleanup = (): void => {
        if (!settled) {
          settled = true;
        }
        for (const [evt, h] of handlerMap) {
          bus.off(evt, h);
        }
        clearTimeout(timer);
        activeCleanups.delete(entry);
      };

      entry = { cleanup, reject };

      for (const evt of uniqueEvents) {
        const handler = ((payload: EventMap[K]): void => {
          if (settled) return;
          if (events[index] !== evt) return; // Not the expected event at this position
          collected.push(payload);
          index++;
          if (index === events.length) {
            cleanup();
            resolve(collected);
          }
        }) as EventHandler<K>;

        handlerMap.set(evt, handler);
        bus.on(evt, handler);
      }

      const timer = setTimeout(() => {
        if (settled) return;
        cleanup();
        reject(
          new Error(
            `EventAwaiter: timeout waiting for sequence at index ${index} ("${String(events[index])}") after ${timeoutMs}ms`,
          ),
        );
      }, timeoutMs);

      activeCleanups.add(entry);
    });
  }

  async function collectDuring<K extends keyof EventMap>(
    event: K,
    operation: () => Promise<void>,
  ): Promise<EventMap[K][]> {
    const collected: EventMap[K][] = [];

    const handler = ((payload: EventMap[K]): void => {
      collected.push(payload);
    }) as EventHandler<K>;

    // Register listener BEFORE operation (critical: must be active before events fire)
    bus.on(event, handler);
    try {
      await operation();
    } finally {
      // Self-cleans -- does NOT add to activeCleanups
      bus.off(event, handler);
    }

    return collected;
  }

  function dispose(): void {
    for (const entry of activeCleanups) {
      entry.cleanup();
      entry.reject(new Error("EventAwaiter: disposed while waiting"));
    }
    activeCleanups.clear();
  }

  return {
    waitFor,
    waitForAll,
    waitForSequence,
    collectDuring,
    dispose,
  };
}
