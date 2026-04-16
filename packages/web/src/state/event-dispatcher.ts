/**
 * SSE event dispatcher with dual delivery model.
 *
 * Connects to the daemon's SSE endpoint and bridges events to two
 * consumption channels:
 *
 * 1. **Callback subscribers** via addEventListener() -- for wiring
 *    specific events to globalState.
 *
 * 2. **Document CustomEvents** via document.dispatchEvent() -- for
 *    child views in phases 304-312 to listen without needing a
 *    reference to the EventDispatcher instance.
 *
 * This provides dual event delivery to both callback handlers and document CustomEvents.
 *
 * Auto-reconnect is handled natively by the EventSource spec.
 */

import { SSE_EVENT_TYPES } from "../api/types/index.js";

/**
 * SSE event dispatcher interface.
 *
 * Wraps EventSource for typed SSE event consumption with dual
 * delivery to callback handlers and document CustomEvents.
 */
export interface EventDispatcher {
  /** Start the SSE connection to the daemon. */
  start(baseUrl: string, token: string): void;
  /** Stop the SSE connection and clear all callback handlers. */
  stop(): void;
  /** Register a callback for a specific event type. Returns an unsubscribe function. */
  addEventListener(type: string, handler: (data: unknown) => void): () => void;
  /** Whether the SSE connection is currently open. */
  readonly connected: boolean;
}

/**
 * Create an SSE event dispatcher with dual delivery.
 *
 * @returns An EventDispatcher instance
 */
export function createEventDispatcher(): EventDispatcher {
  let source: EventSource | null = null;
  let _connected = false;

  // Callback handlers: event type -> set of handlers
  const handlers = new Map<string, Set<(data: unknown) => void>>();

  /**
   * Parse SSE event data as JSON, falling back to raw string.
   */
  function parseData(raw: string): unknown {
    if (!raw) return {};
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  }

  /**
   * Deliver an event through both channels:
   * 1. Registered callback handlers
   * 2. Document CustomEvent dispatch
   */
  function deliver(eventType: string, data: unknown): void {
    // Channel 1: Callback handlers
    const typeHandlers = handlers.get(eventType);
    if (typeHandlers) {
      for (const handler of typeHandlers) {
        handler(data);
      }
    }

    // Channel 2: Document CustomEvent
    document.dispatchEvent(new CustomEvent(eventType, { detail: data }));
  }

  return {
    get connected(): boolean {
      return _connected;
    },

    start(baseUrl: string, token: string): void {
      // Close existing connection if any
      if (source !== null) {
        source.close();
      }

      const url = `${baseUrl}/api/events?token=${encodeURIComponent(token)}`;
      source = new EventSource(url);

      source.onopen = () => {
        _connected = true;
      };

      source.onerror = () => {
        _connected = false;
      };

      // Register listeners for all known SSE event types
      for (const eventType of SSE_EVENT_TYPES) {
        source.addEventListener(eventType, ((ev: MessageEvent) => {
          const data = parseData(ev.data as string);
          deliver(eventType, data);
        }) as EventListener);
      }

      // Also handle generic messages
      source.onmessage = (ev: MessageEvent) => {
        const data = parseData(ev.data as string);
        deliver("message", data);
      };
    },

    stop(): void {
      if (source !== null) {
        source.close();
        source = null;
      }
      _connected = false;
      handlers.clear();
    },

    addEventListener(type: string, handler: (data: unknown) => void): () => void {
      if (!handlers.has(type)) {
        handlers.set(type, new Set());
      }
      handlers.get(type)!.add(handler);

      return () => {
        const typeHandlers = handlers.get(type);
        if (typeHandlers) {
          typeHandlers.delete(handler);
          if (typeHandlers.size === 0) {
            handlers.delete(type);
          }
        }
      };
    },
  };
}
