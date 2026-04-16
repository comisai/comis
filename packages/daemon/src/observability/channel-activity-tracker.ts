import type { TypedEventBus, EventMap, EventHandler } from "@comis/core";
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

  /** Get a specific channel by ID. */
  get(channelId: string): ChannelActivity | undefined;

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

  function recordActivity(channelId: string, channelType: string, direction: "sent" | "received"): void {
    const existing = channels.get(channelId);
    if (existing) {
      existing.lastActiveAt = Date.now();
      if (channelType !== "unknown") {
        existing.channelType = channelType;
      }
      if (direction === "sent") {
        existing.sent++;
      } else {
        existing.received++;
      }
    } else {
      channels.set(channelId, {
        channelType,
        lastActiveAt: Date.now(),
        sent: direction === "sent" ? 1 : 0,
        received: direction === "received" ? 1 : 0,
      });
    }
  }

  function toActivity(channelId: string, entry: InternalEntry): ChannelActivity {
    return {
      channelId,
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
      message.channelType ?? "unknown",
      "received",
    );
  }) as EventHandler<"message:received">;

  eventBus.on("message:received", receivedHandler);
  handlers.push({
    event: "message:received",
    handler: receivedHandler as EventHandler<keyof EventMap>,
  });

  // Subscribe to message:sent -- channelType is not in the sent event payload
  const sentHandler = ((payload: EventMap["message:sent"]) => {
    const existing = channels.get(payload.channelId);
    const channelType = existing?.channelType ?? "unknown";
    recordActivity(payload.channelId, channelType, "sent");
  }) as EventHandler<"message:sent">;

  eventBus.on("message:sent", sentHandler);
  handlers.push({
    event: "message:sent",
    handler: sentHandler as EventHandler<keyof EventMap>,
  });

  return {
    getAll(): ChannelActivity[] {
      const result: ChannelActivity[] = [];
      for (const [channelId, entry] of channels) {
        result.push(toActivity(channelId, entry));
      }
      return result;
    },

    get(channelId: string): ChannelActivity | undefined {
      const entry = channels.get(channelId);
      if (!entry) return undefined;
      return toActivity(channelId, entry);
    },

    getStale(thresholdMs: number): ChannelActivity[] {
      const cutoff = Date.now() - thresholdMs;
      const result: ChannelActivity[] = [];
      for (const [channelId, entry] of channels) {
        if (entry.lastActiveAt < cutoff) {
          result.push(toActivity(channelId, entry));
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
