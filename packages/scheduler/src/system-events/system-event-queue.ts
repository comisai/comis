import type { SchedulerLogger } from "../shared-types.js";
import type { SystemEventEntry } from "./system-event-types.js";

/** Session-scoped in-memory event queue for inter-subsystem communication. */
export interface SystemEventQueue {
  /** Buffer an event for the given session. */
  enqueue(text: string, opts: { contextKey: string; sessionKey: string }): void;
  /** Non-destructive read of all pending entries for a session. Returns a frozen copy. */
  peek(sessionKey: string): readonly SystemEventEntry[];
  /** Consume and remove all pending entries for a session. */
  drain(sessionKey: string): SystemEventEntry[];
  /** Remove all entries for a session without returning them. */
  clear(sessionKey: string): void;
  /** Remove all entries for all sessions (daemon shutdown / test cleanup). */
  clearAll(): void;
  /** Count of pending entries for a session. */
  size(sessionKey: string): number;
}

/** Dependencies for the system event queue factory. */
export interface SystemEventQueueDeps {
  logger: SchedulerLogger;
  /** Maximum entries per session queue before oldest is evicted. Default: 20. */
  maxCapacity?: number;
  /** Injectable clock for deterministic testing. Default: Date.now. */
  nowMs?: () => number;
}

/**
 * Create a session-scoped in-memory event queue.
 * Events are buffered here by producers (cron, exec) and consumed by the heartbeat cycle.
 */
export function createSystemEventQueue(deps: SystemEventQueueDeps): SystemEventQueue {
  const { logger } = deps;
  const maxCapacity = deps.maxCapacity ?? 20;
  const getNow = deps.nowMs ?? Date.now;
  const queues = new Map<string, SystemEventEntry[]>();

  return {
    enqueue(text, { contextKey, sessionKey }) {
      let queue = queues.get(sessionKey);
      if (!queue) {
        queue = [];
        queues.set(sessionKey, queue);
      }

      // Consecutive duplicate text deduplication
      if (queue.length > 0 && queue[queue.length - 1]!.text === text) {
        logger.debug({ sessionKey, contextKey, text }, "Consecutive duplicate collapsed");
        return;
      }

      // Enforce max capacity, drop oldest
      if (queue.length >= maxCapacity) {
        const dropped = queue.shift()!;
        logger.warn(
          {
            sessionKey,
            contextKey,
            droppedText: dropped.text,
            hint: "System events queue full; oldest event dropped. Consider increasing maxCapacity or investigating drain frequency",
            errorKind: "resource" as const,
          },
          "System event dropped (capacity overflow)",
        );
      }

      const entry: SystemEventEntry = {
        text,
        contextKey,
        enqueuedAt: getNow(),
      };
      queue.push(entry);

      // Structured logging at DEBUG
      logger.debug({ sessionKey, contextKey, text, queueSize: queue.length }, "System event enqueued");
    },

    peek(sessionKey) {
      return Object.freeze([...(queues.get(sessionKey) ?? [])]);
    },

    drain(sessionKey) {
      const entries = queues.get(sessionKey) ?? [];
      queues.delete(sessionKey);
      if (entries.length > 0) {
        logger.debug({ sessionKey, count: entries.length }, "System events drained");
      }
      return entries;
    },

    clear(sessionKey) {
      queues.delete(sessionKey);
    },

    clearAll() {
      queues.clear();
    },

    size(sessionKey) {
      return queues.get(sessionKey)?.length ?? 0;
    },
  };
}
