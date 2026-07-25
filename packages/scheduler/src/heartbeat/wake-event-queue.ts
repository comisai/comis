// SPDX-License-Identifier: Apache-2.0
/** Bounded event ownership records protected by the heartbeat coordinator serializer. */
import type { SystemEventEntry } from "../system-events/system-event-types.js";

const MAX_EVENT_QUEUE_BYTES = 256 * 1024;
const MAX_EVENT_QUEUE_ENTRIES = 20;

interface InternalEvent {
  entry: SystemEventEntry;
  correlationId: string;
  state: "pending" | "sealed" | "claimed";
}

export type WakeEventAdmission =
  | { readonly status: "accepted" | "accepted_oldest_dropped" | "duplicate" }
  | { readonly status: "queue_full" };

export interface HeartbeatWakeEventQueue {
  admit(key: string, correlationId: string, entry: SystemEventEntry): WakeEventAdmission;
  seal(key: string, correlationId: string): void;
  claim(key: string, correlationId: string): SystemEventEntry[];
  consume(key: string, correlationId: string): number;
  cancelPending(key: string, correlationId: string): number;
  rebindClaimed(key: string, sourceCorrelationId: string, destinationCorrelationId: string): number;
}

export function createHeartbeatWakeEventQueue(): HeartbeatWakeEventQueue {
  const events = new Map<string, InternalEvent[]>();

  function eventBytes(event: InternalEvent): number {
    return Buffer.byteLength(JSON.stringify({
      ...event.entry,
      correlationId: event.correlationId,
    }), "utf8");
  }

  function admit(key: string, correlationId: string, entry: SystemEventEntry): WakeEventAdmission {
    let queue = events.get(key);
    if (queue === undefined) {
      queue = [];
      events.set(key, queue);
    }
    const duplicate = queue.find((candidate) =>
      candidate.state === "pending" && candidate.entry.contextKey === entry.contextKey);
    if (duplicate !== undefined) return { status: "duplicate" };

    const candidate: InternalEvent = { entry, correlationId, state: "pending" };
    let totalBytes = queue.reduce((sum, item) => sum + eventBytes(item), 0);
    let status: "accepted" | "accepted_oldest_dropped" = "accepted";
    while (
      queue.length + 1 > MAX_EVENT_QUEUE_ENTRIES
      || totalBytes + eventBytes(candidate) > MAX_EVENT_QUEUE_BYTES
    ) {
      const evictIndex = queue.findIndex((item) =>
        item.state === "pending" && item.correlationId === correlationId);
      if (evictIndex < 0) return { status: "queue_full" };
      const evicted = queue.splice(evictIndex, 1)[0]!;
      totalBytes -= eventBytes(evicted);
      status = "accepted_oldest_dropped";
    }
    queue.push(candidate);
    return { status };
  }

  function seal(key: string, correlationId: string): void {
    for (const event of events.get(key) ?? []) {
      if (event.correlationId === correlationId && event.state === "pending") event.state = "sealed";
    }
  }

  function claim(key: string, correlationId: string): SystemEventEntry[] {
    const claimed: SystemEventEntry[] = [];
    for (const event of events.get(key) ?? []) {
      if (event.correlationId === correlationId && event.state === "sealed") {
        event.state = "claimed";
        claimed.push(event.entry);
      }
    }
    return claimed;
  }

  function consume(key: string, correlationId: string): number {
    const queue = events.get(key) ?? [];
    const retained = queue.filter((event) => event.correlationId !== correlationId);
    const count = queue.length - retained.length;
    if (retained.length === 0) events.delete(key);
    else events.set(key, retained);
    return count;
  }

  function cancelPending(key: string, correlationId: string): number {
    const queue = events.get(key) ?? [];
    const retained = queue.filter((event) =>
      event.correlationId !== correlationId || event.state !== "pending");
    const count = queue.length - retained.length;
    if (retained.length === 0) events.delete(key);
    else events.set(key, retained);
    return count;
  }

  function rebindClaimed(
    key: string,
    sourceCorrelationId: string,
    destinationCorrelationId: string,
  ): number {
    let rebound = 0;
    for (const event of events.get(key) ?? []) {
      if (event.correlationId === sourceCorrelationId && event.state === "claimed") {
        event.correlationId = destinationCorrelationId;
        event.state = "pending";
        rebound++;
      }
    }
    return rebound;
  }

  return { admit, seal, claim, consume, cancelPending, rebindClaimed };
}
