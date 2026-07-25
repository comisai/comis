// SPDX-License-Identifier: Apache-2.0
import type { TypedEventBus, EventMap, EventHandler } from "@comis/core";
import { systemNowMs } from "@comis/core";
import type { HandlerRef } from "./index.js";

/**
 * Per-channel activity snapshot: timestamps, message counters, and channel type.
 */
export interface ChannelActivity {
  channelId: string;
  channelType: string;
  lastActiveAt: number;
  messagesSent: number;
  messagesReceived: number;
}

/**
 * ChannelActivityTracker: records per-channel last-active timestamps
 * from EventBus message events for stale connection detection.
 */
export interface ChannelActivityTracker {
  /** Get all tracked channels. */
  getAll(): ChannelActivity[];

  /** Get a specific channel by its platform type and platform-local ID. */
  get(channelType: string, channelId: string): ChannelActivity | undefined;

  /** Get channels inactive beyond thresholdMs. */
  getStale(thresholdMs: number): ChannelActivity[];

  /** Manually record activity for a channel. */
  recordActivity(channelId: string, channelType: string, direction: "sent" | "received"): void;

  /** Clear all tracked activity. */
  reset(): void;

  /** Unsubscribe all EventBus listeners. */
  dispose(): void;
}

interface InternalEntry {
  channelId: string;
  channelType: string;
  lastActiveAt: number;
  sent: number;
  received: number;
}

/**
 * Create a ChannelActivityTracker that subscribes to message:received
 * and message:sent events, maintaining per-channel timestamps and counters.
 */
export function createChannelActivityTracker(deps: {
  eventBus: TypedEventBus;
}): ChannelActivityTracker {
  const { eventBus } = deps;
  const channels = new Map<string, InternalEntry>();
  const handlers: HandlerRef[] = [];

  function channelKey(channelType: string, channelId: string): string {
    return JSON.stringify([channelType, channelId]);
  }

  function recordActivity(channelId: string, channelType: string, direction: "sent" | "received"): void {
    const key = channelKey(channelType, channelId);
    const existing = channels.get(key);
    if (existing) {
      existing.lastActiveAt = systemNowMs();
      if (direction === "sent") {
        existing.sent++;
      } else {
        existing.received++;
      }
    } else {
      channels.set(key, {
        channelId,
        channelType,
        lastActiveAt: systemNowMs(),
        sent: direction === "sent" ? 1 : 0,
        received: direction === "received" ? 1 : 0,
      });
    }
  }

  function toActivity(entry: InternalEntry): ChannelActivity {
    return {
      channelId: entry.channelId,
      channelType: entry.channelType,
      lastActiveAt: entry.lastActiveAt,
      messagesSent: entry.sent,
      messagesReceived: entry.received,
    };
  }

  // Subscribe to message:received -- extract channelId and channelType from NormalizedMessage
  const receivedHandler = ((payload: EventMap["message:received"]) => {
    const { message } = payload;
    recordActivity(
      message.channelId,
      message.channelType,
      "received",
    );
  }) as EventHandler<"message:received">;

  eventBus.on("message:received", receivedHandler);
  handlers.push({
    event: "message:received",
    handler: receivedHandler as EventHandler<keyof EventMap>,
  });

  // Subscribe to message:sent using its complete channel identity.
  const sentHandler = ((payload: EventMap["message:sent"]) => {
    recordActivity(payload.channelId, payload.channelType, "sent");
  }) as EventHandler<"message:sent">;

  eventBus.on("message:sent", sentHandler);
  handlers.push({
    event: "message:sent",
    handler: sentHandler as EventHandler<keyof EventMap>,
  });

  return {
    getAll(): ChannelActivity[] {
      const result: ChannelActivity[] = [];
      for (const entry of channels.values()) {
        result.push(toActivity(entry));
      }
      return result;
    },

    get(channelType: string, channelId: string): ChannelActivity | undefined {
      const entry = channels.get(channelKey(channelType, channelId));
      if (!entry) return undefined;
      return toActivity(entry);
    },

    getStale(thresholdMs: number): ChannelActivity[] {
      const cutoff = systemNowMs() - thresholdMs;
      const result: ChannelActivity[] = [];
      for (const entry of channels.values()) {
        if (entry.lastActiveAt < cutoff) {
          result.push(toActivity(entry));
        }
      }
      return result;
    },

    recordActivity,

    reset(): void {
      channels.clear();
    },

    dispose(): void {
      for (const ref of handlers) {
        eventBus.off(ref.event, ref.handler);
      }
      handlers.length = 0;
    },
  };
}
