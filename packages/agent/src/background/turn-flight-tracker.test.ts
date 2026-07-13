// SPDX-License-Identifier: Apache-2.0
/**
 * Turn-flight tracker — the live-turn oracle for the background completion
 * dispatcher/runner. Fed by pre-existing bus lifecycle events:
 * queue:dequeued (start), session:summary / execution:aborted (end).
 * Crash-safety: marks older than staleMs read as NOT in flight.
 */
import { describe, it, expect } from "vitest";
import { TypedEventBus, formatSessionKey, type SessionKey } from "@comis/core";
import { createTurnFlightTracker } from "./turn-flight-tracker.js";

const KEY: SessionKey = {
  agentId: "default",
  channelType: "telegram",
  channelId: "678314278",
  peer: { kind: "dm", id: "678314278" },
} as unknown as SessionKey;

function formatted(): string {
  return formatSessionKey(KEY);
}

describe("createTurnFlightTracker", () => {
  it("marks in-flight on queue:dequeued and clears on session:summary", () => {
    const bus = new TypedEventBus();
    let clock = 1_000_000;
    const tracker = createTurnFlightTracker({ eventBus: bus, nowMs: () => clock });

    expect(tracker.isTurnInFlight(formatted())).toBe(false);

    bus.emit("queue:dequeued", { sessionKey: KEY, channelType: "telegram", waitTimeMs: 1, timestamp: clock });
    expect(tracker.isTurnInFlight(formatted())).toBe(true);

    clock += 5_000;
    bus.emit("session:summary", { sessionKey: formatted(), agentId: "default", traceId: "t1", degraded: false, turnCount: 1, costUsd: 0, toolStats: {}, breakerTripCount: 0, topErrorKinds: {}, source: "runtime", endReason: "success", timestamp: clock });
    expect(tracker.isTurnInFlight(formatted())).toBe(false);
    tracker.shutdown();
  });

  it("clears on execution:aborted (SessionKey object — formatted internally)", () => {
    const bus = new TypedEventBus();
    const tracker = createTurnFlightTracker({ eventBus: bus, nowMs: () => 1_000 });
    bus.emit("queue:dequeued", { sessionKey: KEY, channelType: "telegram", waitTimeMs: 1, timestamp: 1_000 });
    expect(tracker.isTurnInFlight(formatted())).toBe(true);
    bus.emit("execution:aborted", { sessionKey: KEY, agentId: "default", reason: "budget", timestamp: 1_001 } as never);
    expect(tracker.isTurnInFlight(formatted())).toBe(false);
    tracker.shutdown();
  });

  it("CRASH-SAFETY: a mark older than staleMs reads as NOT in flight (never suppresses forever)", () => {
    const bus = new TypedEventBus();
    let clock = 1_000_000;
    const tracker = createTurnFlightTracker({ eventBus: bus, nowMs: () => clock, staleMs: 60_000 });
    bus.emit("queue:dequeued", { sessionKey: KEY, channelType: "telegram", waitTimeMs: 1, timestamp: clock });
    expect(tracker.isTurnInFlight(formatted())).toBe(true);
    clock += 61_000; // the turn died without a summary (crash) — mark is stale
    expect(tracker.isTurnInFlight(formatted())).toBe(false);
    tracker.shutdown();
  });

  it("shutdown unsubscribes — later events no longer mark", () => {
    const bus = new TypedEventBus();
    const tracker = createTurnFlightTracker({ eventBus: bus, nowMs: () => 1_000 });
    tracker.shutdown();
    bus.emit("queue:dequeued", { sessionKey: KEY, channelType: "telegram", waitTimeMs: 1, timestamp: 1_000 });
    expect(tracker.isTurnInFlight(formatted())).toBe(false);
  });
});
