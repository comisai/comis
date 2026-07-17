// SPDX-License-Identifier: Apache-2.0
/**
 * Authenticated SSE event dispatcher with dual delivery.
 *
 * The native EventSource API cannot attach an Authorization header, so the
 * dispatcher consumes the event stream with fetch. Parsed events are delivered
 * both to callback subscribers and as document CustomEvents.
 */

import {
  cancelBrowserTimeout,
  scheduleBrowserTimeout,
  type BrowserTimeoutHandle,
} from "../api/browser-timers.js";

/** Maximum undecoded SSE event size retained in memory. */
const MAX_EVENT_BUFFER_CHARS = 262_144;

/** Exponential reconnect delay bounds. */
const INITIAL_RECONNECT_MS = 1_000;
const MAX_RECONNECT_MS = 30_000;
const MAX_BROWSER_TIMEOUT_MS = 2_147_483_647;

interface ParsedSseEvent {
  readonly type: string;
  readonly data: string;
}

interface ParsedSseBlock {
  readonly event?: ParsedSseEvent;
  readonly retryMs?: number;
}

interface EventBoundary {
  readonly index: number;
  readonly length: number;
}

type EventHandler = (data: unknown) => void | PromiseLike<void>;

function findEventBoundary(buffer: string): EventBoundary | undefined {
  const index = buffer.indexOf("\n\n");
  if (index === -1) {
    return undefined;
  }
  return { index, length: 2 };
}

function parseRetryDirective(value: string): number | undefined {
  if (!/^\d+$/.test(value)) return undefined;
  const retryMs = Number(value);
  if (!Number.isSafeInteger(retryMs)) return undefined;
  return Math.min(retryMs, MAX_BROWSER_TIMEOUT_MS);
}

/** Parse one complete SSE field block. */
function parseEventBlock(block: string): ParsedSseBlock {
  let type = "message";
  const dataLines: string[] = [];
  let retryMs: number | undefined;

  for (const line of block.split("\n")) {
    if (line.startsWith(":")) {
      continue;
    }

    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) {
      value = value.slice(1);
    }

    if (field === "event") {
      type = value || "message";
    } else if (field === "data") {
      dataLines.push(value);
    } else if (field === "retry") {
      retryMs = parseRetryDirective(value) ?? retryMs;
    }
  }

  if (dataLines.length === 0) {
    return retryMs === undefined ? {} : { retryMs };
  }
  return {
    event: { type, data: dataLines.join("\n") },
    ...(retryMs === undefined ? {} : { retryMs }),
  };
}

/** Parse JSON event data while retaining non-JSON protocol payloads. */
function parseData(raw: string): unknown {
  if (!raw) {
    return {};
  }
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/**
 * SSE event dispatcher interface.
 */
export interface EventDispatcher {
  /** Start the SSE connection to the daemon. */
  start(baseUrl: string, token: string): void;
  /** Stop the SSE connection and clear all callback handlers. */
  stop(): void;
  /** Register a callback for a specific event type. Returns an unsubscribe function. */
  addEventListener(type: string, handler: EventHandler): () => void;
  /** Whether the SSE connection is currently open. */
  readonly connected: boolean;
}

/** Create an authenticated SSE event dispatcher with dual delivery. */
export function createEventDispatcher(): EventDispatcher {
  let abortController: AbortController | null = null;
  let activeReader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  let reconnectTimer: BrowserTimeoutHandle | undefined;
  let reconnectAttempts = 0;
  let reconnectBaseMs = INITIAL_RECONNECT_MS;
  let generation = 0;
  let active = false;
  let _connected = false;

  const handlers = new Map<string, Set<EventHandler>>();

  function deliver(eventType: string, data: unknown): void {
    const typeHandlers = handlers.get(eventType);
    if (typeHandlers) {
      for (const handler of typeHandlers) {
        try {
          const completion = handler(data);
          if (completion !== undefined) {
            void Promise.resolve(completion).then(
              () => undefined,
              () => undefined,
            );
          }
        } catch {
          // One view observer must not interrupt the shared transport or later observers.
          continue;
        }
      }
    }
    document.dispatchEvent(new CustomEvent(eventType, { detail: data }));
  }

  function cancelTransport(): void {
    if (reconnectTimer !== undefined) {
      cancelBrowserTimeout(reconnectTimer);
      reconnectTimer = undefined;
    }
    abortController?.abort();
    abortController = null;
    if (activeReader) {
      // Cancellation settles a pending read immediately. Both fulfillment and
      // rejection are intentionally consumed because stop is best-effort.
      activeReader.cancel().then(
        () => undefined,
        () => undefined,
      );
      activeReader = null;
    }
    _connected = false;
  }

  async function consumeStream(
    body: ReadableStream<Uint8Array>,
    expectedGeneration: number,
  ): Promise<"closed" | "stopped" | "oversized" | "errored"> {
    const reader = body.getReader();
    activeReader = reader;
    const decoder = new TextDecoder();
    let buffer = "";
    let pendingCarriageReturn = false;

    const normalizeChunk = (chunk: string, final: boolean): string => {
      let combined = pendingCarriageReturn ? `\r${chunk}` : chunk;
      pendingCarriageReturn = false;
      if (!final && combined.endsWith("\r")) {
        combined = combined.slice(0, -1);
        pendingCarriageReturn = true;
      }
      return combined.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    };

    const drainCompleteEvents = (): boolean => {
      let boundary = findEventBoundary(buffer);
      while (boundary) {
        if (boundary.index > MAX_EVENT_BUFFER_CHARS) {
          return false;
        }
        const block = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary.length);
        const parsed = parseEventBlock(block);
        if (parsed.retryMs !== undefined) {
          reconnectBaseMs = parsed.retryMs;
        }
        if (parsed.event) {
          deliver(parsed.event.type, parseData(parsed.event.data));
        }
        boundary = findEventBoundary(buffer);
      }
      return buffer.length <= MAX_EVENT_BUFFER_CHARS;
    };

    try {
      while (active && generation === expectedGeneration) {
        const chunk = await reader.read();
        if (!active || generation !== expectedGeneration) {
          await reader.cancel().then(
            () => undefined,
            () => undefined,
          );
          return "stopped";
        }
        if (chunk.done) {
          buffer += normalizeChunk(decoder.decode(), true);
          return drainCompleteEvents() ? "closed" : "oversized";
        }

        buffer += normalizeChunk(decoder.decode(chunk.value, { stream: true }), false);
        if (!drainCompleteEvents()) {
          await reader.cancel().then(
            () => undefined,
            () => undefined,
          );
          return "oversized";
        }
      }
      await reader.cancel().then(
        () => undefined,
        () => undefined,
      );
      return "stopped";
    } catch {
      await reader.cancel().then(
        () => undefined,
        () => undefined,
      );
      return "errored";
    } finally {
      if (activeReader === reader) {
        activeReader = null;
      }
      reader.releaseLock();
    }
  }

  function scheduleReconnect(baseUrl: string, token: string, expectedGeneration: number): void {
    if (!active || generation !== expectedGeneration) {
      return;
    }

    const delayCap = Math.max(MAX_RECONNECT_MS, reconnectBaseMs);
    const exponent = Math.min(reconnectAttempts, 30);
    const delay = Math.min(reconnectBaseMs * 2 ** exponent, delayCap);
    reconnectAttempts = Math.min(reconnectAttempts + 1, 30);
    reconnectTimer = scheduleBrowserTimeout(() => {
      reconnectTimer = undefined;
      void connect(baseUrl, token, expectedGeneration);
    }, delay);
  }

  function isTransientStatus(status: number): boolean {
    return status === 408 || status === 425 || status === 429 || status >= 500;
  }

  async function connect(
    baseUrl: string,
    token: string,
    expectedGeneration: number,
  ): Promise<void> {
    if (!active || generation !== expectedGeneration) {
      return;
    }

    const currentController = new AbortController();
    abortController = currentController;
    let retry = false;

    try {
      const url = `${baseUrl.replace(/\/+$/, "")}/api/events`;
      const response = await fetch(url, {
        method: "GET",
        headers: {
          Accept: "text/event-stream",
          Authorization: `Bearer ${token}`,
        },
        signal: currentController.signal,
      });

      if (!active || generation !== expectedGeneration) {
        currentController.abort();
        return;
      }

      if (response.ok && response.body) {
        _connected = true;
        reconnectAttempts = 0;
        const exit = await consumeStream(response.body, expectedGeneration);
        if (exit === "closed") {
          retry = true;
        } else if (exit === "oversized" || exit === "errored") {
          currentController.abort();
          retry = true;
        }
      } else if (isTransientStatus(response.status) || (response.ok && response.status !== 204)) {
        currentController.abort();
        retry = true;
      } else {
        currentController.abort();
      }
    } catch {
      if (!currentController.signal.aborted) {
        currentController.abort();
        retry = true;
      }
    } finally {
      if (abortController === currentController) {
        abortController = null;
      }
      if (generation === expectedGeneration) {
        _connected = false;
      }
    }

    if (retry) {
      scheduleReconnect(baseUrl, token, expectedGeneration);
    }
  }

  return {
    get connected(): boolean {
      return _connected;
    },

    start(baseUrl: string, token: string): void {
      cancelTransport();
      generation += 1;
      active = true;
      reconnectAttempts = 0;
      reconnectBaseMs = INITIAL_RECONNECT_MS;
      void connect(baseUrl, token, generation);
    },

    stop(): void {
      active = false;
      generation += 1;
      cancelTransport();
      handlers.clear();
    },

    addEventListener(type: string, handler: EventHandler): () => void {
      let typeHandlers = handlers.get(type);
      if (!typeHandlers) {
        typeHandlers = new Set();
        handlers.set(type, typeHandlers);
      }
      typeHandlers.add(handler);

      return () => {
        const currentHandlers = handlers.get(type);
        currentHandlers?.delete(handler);
        if (currentHandlers?.size === 0) {
          handlers.delete(type);
        }
      };
    },
  };
}
