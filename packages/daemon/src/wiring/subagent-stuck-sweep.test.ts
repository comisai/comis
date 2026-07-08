// SPDX-License-Identifier: Apache-2.0
/**
 * Stuck sub-agent sweep — idle-based detection.
 *
 * Regression anchor (live incident): a healthy research sub-agent doing
 * continuous tool/LLM work was force-killed at 186.6s against the 180s
 * threshold WHILE STREAMING ITS FINAL ANSWER (the last model call aborted at
 * 3 output tokens). "Stuck" must mean NO OBSERVED PROGRESS for the threshold
 * window — not "the run is old". A run whose last activity is recent must
 * survive regardless of total runtime.
 */
import { describe, it, expect, vi } from "vitest";
import { TypedEventBus } from "@comis/core";

import {
  createSubagentActivityTracker,
  sweepStuckSubAgentRuns,
} from "./subagent-stuck-sweep.js";

const CHILD_KEY = "default:sub-agent-abc:sub-agent:abc";

function runView(overrides: Partial<{
  runId: string; agentId: string; status: string; startedAt: number;
  sessionKey: string; graphId: string;
}> = {}) {
  return {
    runId: "run-1",
    agentId: "default",
    status: "running",
    startedAt: 0,
    sessionKey: CHILD_KEY,
    ...overrides,
  };
}

describe("sweepStuckSubAgentRuns", () => {
  it("does NOT kill an old run with recent activity (the false-positive incident)", () => {
    const now = 200_000; // run is 200s old — beyond the 180s threshold
    const result = sweepStuckSubAgentRuns({
      runs: [runView({ startedAt: 0 })],
      now,
      stuckKillThresholdMs: 180_000,
      graphStuckKillThresholdMs: 600_000,
      lastActivityFor: () => now - 5_000, // toolwork observed 5s ago
    });
    expect(result.kills).toEqual([]);
    expect(result.stuckSubAgentRuns).toBe(0);
    expect(result.activeSubAgentRuns).toBe(1);
  });

  it("kills a run with no observed activity past the threshold, with idle telemetry", () => {
    const now = 200_000;
    const result = sweepStuckSubAgentRuns({
      runs: [runView({ startedAt: 0 })],
      now,
      stuckKillThresholdMs: 180_000,
      graphStuckKillThresholdMs: 600_000,
      lastActivityFor: () => undefined, // no activity ever observed
    });
    expect(result.kills).toHaveLength(1);
    expect(result.kills[0]).toMatchObject({
      runId: "run-1",
      agentId: "default",
      isGraphRun: false,
      runtimeMs: 200_000,
      idleMs: 200_000, // falls back to startedAt
      thresholdMs: 180_000,
    });
    expect(result.stuckSubAgentRuns).toBe(1);
  });

  it("measures idle from last activity, not from run start", () => {
    const now = 500_000;
    const result = sweepStuckSubAgentRuns({
      runs: [runView({ startedAt: 0 })],
      now,
      stuckKillThresholdMs: 180_000,
      graphStuckKillThresholdMs: 600_000,
      lastActivityFor: () => 100_000, // last progress 400s ago
    });
    expect(result.kills).toHaveLength(1);
    expect(result.kills[0]!.idleMs).toBe(400_000);
    expect(result.kills[0]!.runtimeMs).toBe(500_000);
  });

  it("graph runs use the graph threshold", () => {
    const now = 300_000;
    const result = sweepStuckSubAgentRuns({
      runs: [runView({ graphId: "g1", startedAt: 0 })],
      now,
      stuckKillThresholdMs: 180_000,
      graphStuckKillThresholdMs: 600_000,
      lastActivityFor: () => undefined,
    });
    // 300s idle < 600s graph threshold — survives.
    expect(result.kills).toEqual([]);
  });

  it("threshold 0 disables the sweep", () => {
    const result = sweepStuckSubAgentRuns({
      runs: [runView({ startedAt: 0 })],
      now: 10_000_000,
      stuckKillThresholdMs: 0,
      graphStuckKillThresholdMs: 0,
      lastActivityFor: () => undefined,
    });
    expect(result.kills).toEqual([]);
    expect(result.stuckSubAgentRuns).toBe(0);
  });

  it("ignores non-running runs", () => {
    const result = sweepStuckSubAgentRuns({
      runs: [
        runView({ runId: "q", status: "queued", startedAt: 0 }),
        runView({ runId: "c", status: "completed", startedAt: 0 }),
        runView({ runId: "f", status: "failed", startedAt: 0 }),
      ],
      now: 10_000_000,
      stuckKillThresholdMs: 180_000,
      graphStuckKillThresholdMs: 600_000,
      lastActivityFor: () => undefined,
    });
    expect(result.activeSubAgentRuns).toBe(0);
    expect(result.kills).toEqual([]);
  });
});

describe("createSubagentActivityTracker", () => {
  it("tracks tool and model progress by sessionKey", () => {
    const bus = new TypedEventBus();
    const nowMs = vi.fn(() => 1_000);
    const tracker = createSubagentActivityTracker(bus, nowMs);

    expect(tracker.lastActivityFor(CHILD_KEY)).toBeUndefined();

    bus.emit("tool:started", {
      toolName: "exec", toolCallId: "t1", timestamp: 1, sessionKey: CHILD_KEY,
    });
    expect(tracker.lastActivityFor(CHILD_KEY)).toBe(1_000);

    nowMs.mockReturnValue(2_000);
    bus.emit("tool:executed", {
      toolName: "exec", durationMs: 5, success: true, timestamp: 2,
      toolCallId: "t1", sessionKey: CHILD_KEY,
    });
    expect(tracker.lastActivityFor(CHILD_KEY)).toBe(2_000);

    nowMs.mockReturnValue(3_000);
    bus.emit("observability:token_usage", {
      sessionKey: CHILD_KEY,
    } as never);
    expect(tracker.lastActivityFor(CHILD_KEY)).toBe(3_000);

    tracker.dispose();
  });

  it("ignores events without a sessionKey", () => {
    const bus = new TypedEventBus();
    const tracker = createSubagentActivityTracker(bus, () => 1_000);
    bus.emit("tool:started", { toolName: "exec", toolCallId: "t1", timestamp: 1 });
    expect(tracker.lastActivityFor(CHILD_KEY)).toBeUndefined();
    tracker.dispose();
  });

  it("prune drops keys not in the active set (no unbounded growth)", () => {
    const bus = new TypedEventBus();
    const tracker = createSubagentActivityTracker(bus, () => 1_000);
    bus.emit("tool:started", { toolName: "x", toolCallId: "1", timestamp: 1, sessionKey: "a" });
    bus.emit("tool:started", { toolName: "x", toolCallId: "2", timestamp: 1, sessionKey: "b" });
    tracker.prune(new Set(["b"]));
    expect(tracker.lastActivityFor("a")).toBeUndefined();
    expect(tracker.lastActivityFor("b")).toBe(1_000);
    tracker.dispose();
  });

  it("dispose unsubscribes from the bus", () => {
    const bus = new TypedEventBus();
    const tracker = createSubagentActivityTracker(bus, () => 1_000);
    tracker.dispose();
    bus.emit("tool:started", { toolName: "x", toolCallId: "1", timestamp: 1, sessionKey: "a" });
    expect(tracker.lastActivityFor("a")).toBeUndefined();
  });
});
