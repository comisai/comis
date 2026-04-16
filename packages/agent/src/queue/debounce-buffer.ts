/**
 * Debounce Buffer: Ingress-layer message coalescing before CommandQueue entry.
 *
 * Buffers rapid successive messages from the same user within a configurable
 * time window and coalesces them into a single agent invocation. This sits
 * BEFORE the CommandQueue in the ChannelManager pipeline, preventing duplicate
 * agent invocations when users split thoughts across multiple rapid messages.
 *
 * Key behaviors:
 * - Per-session buffering keyed by formatSessionKey(sessionKey)
 * - Optional first-message-immediate bypass (configurable)
 * - Hard cap on buffered messages with forced flush on overflow
 * - Timer-based flush using unref'd timeouts (won't keep process alive)
 * - Coalesces buffered messages via coalesceMessages() before flushing
 * - Cleanup via clear(sessionKey) or shutdown()
 *
 * @module
 */

import type { NormalizedMessage, SessionKey, TypedEventBus, DebounceBufferConfig } from "@comis/core";
import { formatSessionKey } from "@comis/core";
import { coalesceMessages } from "./coalescer.js";

/**
 * Dependencies required by createDebounceBuffer.
 */
export interface DebounceBufferDeps {
  readonly config: DebounceBufferConfig;
  readonly eventBus: TypedEventBus;
}

/**
 * DebounceBuffer interface for buffering and coalescing rapid messages.
 */
export interface DebounceBuffer {
  /** Buffer a message for the given session. Coalesced messages delivered via onFlush callback. */
  push(sessionKey: SessionKey, message: NormalizedMessage, channelType: string): void;
  /** Register the callback that receives coalesced messages after debounce window expires. */
  onFlush(cb: (sessionKey: SessionKey, messages: NormalizedMessage[], channelType: string) => void): void;
  /** Force-flush all pending buffers (for shutdown). */
  flushAll(): void;
  /** Cancel all timers, flush pending, and reject further pushes. */
  shutdown(): void;
  /** Clear (cancel + drop) buffered messages for a specific session. */
  clear(sessionKey: SessionKey): void;
}

interface BufferEntry {
  messages: NormalizedMessage[];
  timer: ReturnType<typeof setTimeout>;
  channelType: string;
  sessionKey: SessionKey;
}

/**
 * Create an ingress-layer debounce buffer.
 *
 * @param deps - Configuration and event bus
 * @returns DebounceBuffer instance
 */
export function createDebounceBuffer(deps: DebounceBufferDeps): DebounceBuffer {
  const { config, eventBus } = deps;

  const buffers = new Map<string, BufferEntry>();
  let flushCallback: ((sessionKey: SessionKey, messages: NormalizedMessage[], channelType: string) => void) | undefined;
  let isShutdown = false;

  /**
   * Flush a single buffer entry and invoke the callback with coalesced messages.
   */
  function flushEntry(key: string, trigger: "timer" | "overflow" | "shutdown"): void {
    const entry = buffers.get(key);
    if (!entry || entry.messages.length === 0) {
      // Clean up empty entries
      if (entry) {
        clearTimeout(entry.timer);
        buffers.delete(key);
      }
      return;
    }

    clearTimeout(entry.timer);
    const messages = [...entry.messages];
    const { sessionKey, channelType } = entry;
    buffers.delete(key);

    // Emit flushed event
    eventBus.emit("debounce:flushed", {
      sessionKey,
      channelType,
      messageCount: messages.length,
      trigger,
      timestamp: Date.now(),
    });

    // Coalesce messages before delivering to callback
    const coalesced = coalesceMessages(messages);
    flushCallback?.(sessionKey, [coalesced], channelType);
  }

  return {
    push(sessionKey: SessionKey, message: NormalizedMessage, channelType: string): void {
      if (isShutdown) return;

      const key = formatSessionKey(sessionKey);
      let entry = buffers.get(key);

      // First message in a new burst
      if (!entry) {
        if (config.firstMessageImmediate) {
          // Bypass debounce for first message -- deliver immediately
          flushCallback?.(sessionKey, [message], channelType);
          return;
        }

        // Create new buffer entry
        const timer = setTimeout(() => flushEntry(key, "timer"), config.windowMs);
        timer.unref();
        entry = { messages: [message], timer, channelType, sessionKey };
        buffers.set(key, entry);

        // Emit buffered event
        eventBus.emit("debounce:buffered", {
          sessionKey,
          channelType,
          bufferedCount: 1,
          windowMs: config.windowMs,
          timestamp: Date.now(),
        });
        return;
      }

      // Subsequent message in existing burst -- add to buffer
      entry.messages.push(message);

      // Reset debounce timer
      clearTimeout(entry.timer);
      const newTimer = setTimeout(() => flushEntry(key, "timer"), config.windowMs);
      newTimer.unref();
      entry.timer = newTimer;

      // Emit buffered event
      eventBus.emit("debounce:buffered", {
        sessionKey,
        channelType,
        bufferedCount: entry.messages.length,
        windowMs: config.windowMs,
        timestamp: Date.now(),
      });

      // Hard cap: force-flush on overflow
      if (entry.messages.length >= config.maxBufferedMessages) {
        flushEntry(key, "overflow");
      }
    },

    onFlush(cb: (sessionKey: SessionKey, messages: NormalizedMessage[], channelType: string) => void): void {
      flushCallback = cb;
    },

    flushAll(): void {
      const keys = [...buffers.keys()];
      for (const key of keys) {
        flushEntry(key, "shutdown");
      }
    },

    shutdown(): void {
      this.flushAll();
      isShutdown = true;
    },

    clear(sessionKey: SessionKey): void {
      const key = formatSessionKey(sessionKey);
      const entry = buffers.get(key);
      if (entry) {
        clearTimeout(entry.timer);
        buffers.delete(key);
      }
    },
  };
}
