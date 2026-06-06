// SPDX-License-Identifier: Apache-2.0
/**
 * Stage-A unit tests for graph-trace.ts.
 *
 * All tests are fixture-driven — no daemon, no network, no COMIS_LIVE required.
 * Uses synthetic event arrays with graph:node_updated / graph:started / graph:completed
 * event names (per packages/core/src/event-bus/events-agent.ts).
 *
 * @module
 */

import { describe, it, expect } from "vitest";
import {
  assertDependencyOrder,
  assertConcurrencyCapHolds,
  assertFailureCascade,
  assertGraphCompleted,
} from "./graph-trace.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type NodeStatus = "running" | "completed" | "failed" | "skipped";

function makeNodeEvent(
  nodeId: string,
  status: NodeStatus,
  graphId = "g1",
  tsOffset = 0,
): { name: string; payload: unknown } {
  return {
    name: "graph:node_updated",
    payload: {
      graphId,
      nodeId,
      status,
      timestamp: Date.now() + tsOffset,
    },
  };
}

function makeCompletedEvent(
  graphId = "g1",
  overrides?: Partial<{
    status: "completed" | "failed" | "cancelled";
    durationMs: number;
    nodeCount: number;
    nodesCompleted: number;
    nodesFailed: number;
    nodesSkipped: number;
  }>,
): { name: string; payload: unknown } {
  return {
    name: "graph:completed",
    payload: {
      graphId,
      status: "completed",
      durationMs: 100,
      nodeCount: 3,
      nodesCompleted: 3,
      nodesFailed: 0,
      nodesSkipped: 0,
      timestamp: Date.now(),
      ...overrides,
    },
  };
}

// ---------------------------------------------------------------------------
// assertDependencyOrder
// ---------------------------------------------------------------------------

describe("assertDependencyOrder — VIOLATION: C runs before A completes", () => {
  it("throws assertDependencyOrder when C starts before A in the event stream", () => {
    // C runs first, then A — violates [A, C] dependency order
    const events = [
      makeNodeEvent("C", "running", "g1", 0),
      makeNodeEvent("C", "completed", "g1", 10),
      makeNodeEvent("A", "running", "g1", 20),
      makeNodeEvent("A", "completed", "g1", 30),
    ];

    expect(() => assertDependencyOrder(events, ["A", "C"])).toThrow(/assertDependencyOrder/);
  });
});

describe("assertDependencyOrder — PASS: events in correct order [A, C]", () => {
  it("does not throw when A running appears before C running", () => {
    const events = [
      makeNodeEvent("A", "running", "g1", 0),
      makeNodeEvent("A", "completed", "g1", 10),
      makeNodeEvent("C", "running", "g1", 20),
      makeNodeEvent("C", "completed", "g1", 30),
    ];

    expect(() => assertDependencyOrder(events, ["A", "C"])).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// assertConcurrencyCapHolds
// ---------------------------------------------------------------------------

describe("assertConcurrencyCapHolds — VIOLATION: 3 nodes running simultaneously with cap=2", () => {
  it("throws when concurrent running nodes exceed cap=2", () => {
    const events = [
      makeNodeEvent("A", "running", "g1", 0),
      makeNodeEvent("B", "running", "g1", 1),
      makeNodeEvent("C", "running", "g1", 2), // 3 concurrent — exceeds cap=2
      makeNodeEvent("A", "completed", "g1", 10),
      makeNodeEvent("B", "completed", "g1", 11),
      makeNodeEvent("C", "completed", "g1", 12),
    ];

    expect(() => assertConcurrencyCapHolds(events, 2)).toThrow(/assertConcurrencyCapHolds/);
  });
});

describe("assertConcurrencyCapHolds — PASS: max 2 running at any time with cap=2", () => {
  it("does not throw when at most 2 nodes run concurrently", () => {
    const events = [
      makeNodeEvent("A", "running", "g1", 0),
      makeNodeEvent("B", "running", "g1", 1),   // 2 concurrent — exactly at cap
      makeNodeEvent("A", "completed", "g1", 5),
      makeNodeEvent("C", "running", "g1", 6),   // 2 concurrent again — still at cap
      makeNodeEvent("B", "completed", "g1", 10),
      makeNodeEvent("C", "completed", "g1", 11),
    ];

    expect(() => assertConcurrencyCapHolds(events, 2)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// assertFailureCascade
// ---------------------------------------------------------------------------

describe("assertFailureCascade — VIOLATION: B (depends on failed A) not in events", () => {
  it("throws when expected downstream node B is absent from events", () => {
    // A is failed, but B is nowhere in the event stream
    const events = [
      makeNodeEvent("A", "running", "g1", 0),
      makeNodeEvent("A", "failed", "g1", 10),
    ];

    expect(() => assertFailureCascade(events, "A", ["B"])).toThrow(/assertFailureCascade/);
  });
});

describe("assertFailureCascade — PASS: A is failed, B appears as skipped", () => {
  it("does not throw when A is failed and B appears as skipped", () => {
    const events = [
      makeNodeEvent("A", "running", "g1", 0),
      makeNodeEvent("A", "failed", "g1", 10),
      makeNodeEvent("B", "skipped", "g1", 11),
    ];

    expect(() => assertFailureCascade(events, "A", ["B"])).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// assertGraphCompleted
// ---------------------------------------------------------------------------

describe("assertGraphCompleted — VIOLATION: no graph:completed event for graphId g1", () => {
  it("throws when events has no graph:completed for g1", () => {
    const events = [
      makeNodeEvent("A", "completed", "g1"),
    ];

    expect(() => assertGraphCompleted(events, "g1")).toThrow(/assertGraphCompleted/);
  });
});

describe("assertGraphCompleted — PASS: event present, returns payload with graphId g1", () => {
  it("returns the graph:completed payload when the event exists", () => {
    const events = [
      makeNodeEvent("A", "completed", "g1"),
      makeCompletedEvent("g1"),
    ];

    const payload = assertGraphCompleted(events, "g1") as { graphId: string };
    expect(payload).toBeDefined();
    expect(payload.graphId).toBe("g1");
  });
});
