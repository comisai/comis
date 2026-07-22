// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import type { SystemEventEntry } from "../system-events/system-event-types.js";
import { createHeartbeatWakeEventQueue } from "./wake-event-queue.js";

function event(contextKey: string, text = "inspect scheduler state"): SystemEventEntry {
  return { contextKey, text, trigger: "wake", enqueuedAt: 1_000 };
}

describe("heartbeat wake event queue", () => {
  it("seals claims rebinds and consumes only the owned correlation", () => {
    const queue = createHeartbeatWakeEventQueue();
    expect(queue.admit("agent-a", "correlation-a", event("event-a"))).toEqual({ status: "accepted" });
    expect(queue.admit("agent-a", "correlation-b", event("event-b"))).toEqual({ status: "accepted" });
    expect(queue.claim("agent-a", "correlation-a")).toEqual([]);

    queue.seal("agent-a", "correlation-a");
    expect(queue.claim("agent-a", "correlation-a")).toEqual([event("event-a")]);
    expect(queue.claim("agent-a", "correlation-a")).toEqual([]);
    expect(queue.rebindClaimed("agent-a", "correlation-a", "correlation-c")).toBe(1);
    queue.seal("agent-a", "correlation-c");
    expect(queue.claim("agent-a", "correlation-c")).toEqual([event("event-a")]);
    expect(queue.consume("agent-a", "correlation-c")).toBe(1);

    queue.seal("agent-a", "correlation-b");
    expect(queue.claim("agent-a", "correlation-b")).toEqual([event("event-b")]);
    expect(queue.consume("agent-a", "correlation-b")).toBe(1);
    expect(queue.consume("agent-a", "missing-correlation")).toBe(0);
  });

  it("deduplicates pending context keys without hiding sealed events", () => {
    const queue = createHeartbeatWakeEventQueue();
    expect(queue.admit("agent-a", "correlation-a", event("same-key"))).toEqual({ status: "accepted" });
    expect(queue.admit("agent-a", "correlation-b", event("same-key"))).toEqual({ status: "duplicate" });

    queue.seal("agent-a", "correlation-a");
    expect(queue.admit("agent-a", "correlation-b", event("same-key"))).toEqual({ status: "accepted" });
  });

  it("evicts the oldest pending event owned by the admitting correlation", () => {
    const queue = createHeartbeatWakeEventQueue();
    for (let index = 0; index < 20; index += 1) {
      expect(queue.admit("agent-a", "correlation-a", event(`event-${index}`))).toEqual({ status: "accepted" });
    }

    expect(queue.admit("agent-a", "correlation-a", event("event-20")))
      .toEqual({ status: "accepted_oldest_dropped" });
    queue.seal("agent-a", "correlation-a");
    const claimed = queue.claim("agent-a", "correlation-a");
    expect(claimed).toHaveLength(20);
    expect(claimed.map((entry) => entry.contextKey)).not.toContain("event-0");
    expect(claimed.map((entry) => entry.contextKey)).toContain("event-20");
  });

  it("rejects admission when bounded capacity has no evictable owner event", () => {
    const queue = createHeartbeatWakeEventQueue();
    for (let index = 0; index < 20; index += 1) {
      queue.admit("agent-a", "correlation-a", event(`event-${index}`));
    }
    queue.seal("agent-a", "correlation-a");

    expect(queue.admit("agent-a", "correlation-b", event("event-b"))).toEqual({ status: "queue_full" });
    expect(queue.admit("agent-b", "correlation-b", event("oversize", "x".repeat(257 * 1_024))))
      .toEqual({ status: "queue_full" });
  });

  it("cancels only pending events and preserves sealed ownership", () => {
    const queue = createHeartbeatWakeEventQueue();
    queue.admit("agent-a", "correlation-a", event("pending-a"));
    queue.admit("agent-a", "correlation-a", event("sealed-a"));
    queue.seal("agent-a", "correlation-a");
    queue.admit("agent-a", "correlation-a", event("pending-b"));

    expect(queue.cancelPending("agent-a", "correlation-a")).toBe(1);
    expect(queue.cancelPending("agent-a", "correlation-a")).toBe(0);
    expect(queue.claim("agent-a", "correlation-a").map((entry) => entry.contextKey))
      .toEqual(["pending-a", "sealed-a"]);
    expect(queue.rebindClaimed("agent-a", "missing", "other")).toBe(0);
  });
});
