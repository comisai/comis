// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for the recall-counters bus wiring (OBS-07).
 *
 * `wireRecallCounters(eventBus)` stands up a SINGLE in-process recall counter
 * registry and subscribes it to the three `memory:*` bus events. The
 * `memory.recall_stats` handler reads the returned `snapshot()` accessor, so a
 * memory:recalled / memory:reranked / memory:consolidated emitted on the bus
 * must be reflected in the snapshot — and the SAME snapshot accessor is
 * returned (one shared registry, not a fresh one per call).
 *
 * @module
 */

import { describe, it, expect } from "vitest";
import { TypedEventBus } from "@comis/core";
import { wireRecallCounters } from "./recall-counters-wiring.js";

describe("wireRecallCounters (OBS-07)", () => {
  it("subscribes to memory:recalled and increments recalls + laneUsage", () => {
    const bus = new TypedEventBus();
    const { snapshot } = wireRecallCounters(bus);

    bus.emit("memory:recalled", {
      agentId: "a1",
      sessionKey: "s1",
      traceId: "t1",
      lanes: 3,
      ftsCandidates: 5,
      vectorCandidates: 4,
      entityCandidates: 2,
      finalCount: 3,
      rerankerAvailable: true,
      durationMs: 10,
      timestamp: 1_000,
    });

    const snap = snapshot();
    expect(snap.recalls).toBe(1);
    // A recall that returned >0 hits also bumps recallsWithHits.
    expect(snap.recallsWithHits).toBe(1);
    // Lane usage accumulates the per-lane CANDIDATE counts (not a presence flag).
    expect(snap.laneUsage).toEqual({ fts: 5, vector: 4, entity: 2 });
  });

  it("a memory:recalled with finalCount 0 counts the recall but not a hit", () => {
    const bus = new TypedEventBus();
    const { snapshot } = wireRecallCounters(bus);

    bus.emit("memory:recalled", {
      agentId: "a1",
      traceId: "t1",
      lanes: 1,
      ftsCandidates: 2,
      vectorCandidates: 0,
      entityCandidates: 0,
      finalCount: 0,
      rerankerAvailable: false,
      durationMs: 4,
      timestamp: 1_000,
    });

    const snap = snapshot();
    expect(snap.recalls).toBe(1);
    expect(snap.recallsWithHits).toBe(0);
  });

  it("subscribes to memory:reranked and increments rerankFallbacks when fellBack", () => {
    const bus = new TypedEventBus();
    const { snapshot } = wireRecallCounters(bus);

    bus.emit("memory:reranked", {
      agentId: "a1",
      traceId: "t1",
      candidateCount: 10,
      hitCount: 5,
      rerankerAvailable: true,
      timedOut: false,
      fellBack: true,
      durationMs: 7,
      timestamp: 1_000,
    });

    const snap = snapshot();
    expect(snap.rerankRuns).toBe(1);
    expect(snap.rerankFallbacks).toBe(1);
  });

  it("a memory:reranked that timed out also counts as a fallback", () => {
    const bus = new TypedEventBus();
    const { snapshot } = wireRecallCounters(bus);

    bus.emit("memory:reranked", {
      agentId: "a1",
      traceId: "t1",
      candidateCount: 10,
      hitCount: 5,
      rerankerAvailable: true,
      timedOut: true,
      fellBack: false,
      durationMs: 7,
      timestamp: 1_000,
    });

    const snap = snapshot();
    expect(snap.rerankRuns).toBe(1);
    expect(snap.rerankFallbacks).toBe(1);
  });

  it("a clean memory:reranked counts the run but not a fallback", () => {
    const bus = new TypedEventBus();
    const { snapshot } = wireRecallCounters(bus);

    bus.emit("memory:reranked", {
      agentId: "a1",
      traceId: "t1",
      candidateCount: 10,
      hitCount: 5,
      rerankerAvailable: true,
      timedOut: false,
      fellBack: false,
      durationMs: 7,
      timestamp: 1_000,
    });

    const snap = snapshot();
    expect(snap.rerankRuns).toBe(1);
    expect(snap.rerankFallbacks).toBe(0);
  });

  it("subscribes to memory:consolidated and accumulates throughput", () => {
    const bus = new TypedEventBus();
    const { snapshot } = wireRecallCounters(bus);

    bus.emit("memory:consolidated", {
      agentId: "a1",
      clustersProcessed: 3,
      observationsCreated: 2,
      dedupHits: 1,
      durationMs: 20,
      timestamp: 1_000,
    });

    const snap = snapshot();
    expect(snap.consolidationClusters).toBe(3);
    expect(snap.observationsCreated).toBe(2);
  });

  it("returns the SAME shared registry — repeated snapshot() reflects all events", () => {
    const bus = new TypedEventBus();
    const wiring = wireRecallCounters(bus);

    bus.emit("memory:recalled", {
      agentId: "a1",
      traceId: "t1",
      lanes: 1,
      ftsCandidates: 1,
      vectorCandidates: 0,
      entityCandidates: 0,
      finalCount: 1,
      rerankerAvailable: false,
      durationMs: 1,
      timestamp: 1_000,
    });
    bus.emit("memory:recalled", {
      agentId: "a1",
      traceId: "t2",
      lanes: 1,
      ftsCandidates: 1,
      vectorCandidates: 0,
      entityCandidates: 0,
      finalCount: 1,
      rerankerAvailable: false,
      durationMs: 1,
      timestamp: 2_000,
    });

    // Two distinct snapshot() reads off the same registry both see the
    // accumulated total — proving the wiring did not create a fresh registry
    // per call (the recall_stats handler relies on this shared instance).
    expect(wiring.snapshot().recalls).toBe(2);
    expect(wiring.snapshot().recalls).toBe(2);
  });
});
