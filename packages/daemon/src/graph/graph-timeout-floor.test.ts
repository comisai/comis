// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import {
  computeGraphTimeoutFloorMs,
  DEFAULT_NODE_TIMEOUT_MS,
  MAX_GRAPH_TIMEOUT_FLOOR_MS,
} from "./graph-timeout-floor.js";

describe("computeGraphTimeoutFloorMs", () => {
  it("returns 0 for an empty graph", () => {
    expect(computeGraphTimeoutFloorMs([], 2)).toBe(0);
  });

  it("a single node floor = its timeout (1 wave)", () => {
    expect(computeGraphTimeoutFloorMs([{ nodeId: "a", timeoutMs: 120_000 }], 2)).toBe(120_000);
  });

  it("uses the per-node default when a node declares no timeout", () => {
    expect(computeGraphTimeoutFloorMs([{ nodeId: "a" }], 4)).toBe(DEFAULT_NODE_TIMEOUT_MS);
  });

  it("parallel nodes within concurrency run in ONE wave", () => {
    // 4 nodes, concurrency 4 → 1 wave → max timeout.
    const nodes = [
      { nodeId: "a", timeoutMs: 100_000 },
      { nodeId: "b", timeoutMs: 100_000 },
      { nodeId: "c", timeoutMs: 100_000 },
      { nodeId: "d", timeoutMs: 200_000 },
    ];
    expect(computeGraphTimeoutFloorMs(nodes, 4)).toBe(200_000);
  });

  it("more parallel nodes than concurrency → multiple waves", () => {
    // 4 nodes, concurrency 2 → 2 waves × max timeout.
    const nodes = [
      { nodeId: "a", timeoutMs: 300_000 },
      { nodeId: "b", timeoutMs: 300_000 },
      { nodeId: "c", timeoutMs: 300_000 },
      { nodeId: "d", timeoutMs: 300_000 },
    ];
    expect(computeGraphTimeoutFloorMs(nodes, 2)).toBe(600_000);
  });

  it("a sequential chain sums the critical path", () => {
    const nodes = [
      { nodeId: "a", timeoutMs: 100_000 },
      { nodeId: "b", timeoutMs: 100_000, dependsOn: ["a"] },
      { nodeId: "c", timeoutMs: 100_000, dependsOn: ["b"] },
    ];
    expect(computeGraphTimeoutFloorMs(nodes, 4)).toBe(300_000);
  });

  it("the live NVDA shape (4 analysts → debate → head-trader) at concurrency 2 floors at 20 min", () => {
    // This is the graph that timed out at 10 min live. Floor must EXCEED 10 min.
    const nodes = [
      { nodeId: "analyst_fundamentals", timeoutMs: 300_000 },
      { nodeId: "analyst_technicals", timeoutMs: 300_000 },
      { nodeId: "analyst_options", timeoutMs: 300_000 },
      { nodeId: "analyst_macro", timeoutMs: 300_000 },
      { nodeId: "debate", timeoutMs: 300_000, dependsOn: ["analyst_fundamentals", "analyst_technicals"] },
      { nodeId: "head_trader", timeoutMs: 300_000, dependsOn: ["debate", "analyst_options", "analyst_macro"] },
    ];
    const floor = computeGraphTimeoutFloorMs(nodes, 2);
    // Level 0: 4 analysts / 2 = 2 waves × 300k = 600k
    // Level 1: debate = 300k ; Level 2: head_trader = 300k  → 1.2M = 20 min
    expect(floor).toBe(1_200_000);
    expect(floor).toBeGreaterThan(600_000); // strictly more than the 10-min that starved it
  });

  it("the same graph at frontier concurrency 4 needs less (analysts in 1 wave)", () => {
    const nodes = [
      { nodeId: "a1", timeoutMs: 300_000 },
      { nodeId: "a2", timeoutMs: 300_000 },
      { nodeId: "a3", timeoutMs: 300_000 },
      { nodeId: "a4", timeoutMs: 300_000 },
      { nodeId: "debate", timeoutMs: 300_000, dependsOn: ["a1", "a2"] },
      { nodeId: "head", timeoutMs: 300_000, dependsOn: ["debate", "a3", "a4"] },
    ];
    // Level 0: 4/4 = 1 wave × 300k ; debate 300k ; head 300k → 900k
    expect(computeGraphTimeoutFloorMs(nodes, 4)).toBe(900_000);
  });

  it("caps a pathological graph at MAX_GRAPH_TIMEOUT_FLOOR_MS", () => {
    const nodes = Array.from({ length: 100 }, (_, i) => ({
      nodeId: `n${i}`,
      timeoutMs: 300_000,
      ...(i > 0 ? { dependsOn: [`n${i - 1}`] } : {}),
    }));
    // 100-deep chain × 300k = 30M, capped to 2h.
    expect(computeGraphTimeoutFloorMs(nodes, 1)).toBe(MAX_GRAPH_TIMEOUT_FLOOR_MS);
  });

  it("does not crash on a dependency cycle (defensive)", () => {
    const nodes = [
      { nodeId: "a", timeoutMs: 100_000, dependsOn: ["b"] },
      { nodeId: "b", timeoutMs: 100_000, dependsOn: ["a"] },
    ];
    expect(() => computeGraphTimeoutFloorMs(nodes, 2)).not.toThrow();
  });

  it("treats maxConcurrency <= 0 as 1 (no divide-by-zero)", () => {
    const nodes = [
      { nodeId: "a", timeoutMs: 100_000 },
      { nodeId: "b", timeoutMs: 100_000 },
    ];
    expect(computeGraphTimeoutFloorMs(nodes, 0)).toBe(200_000);
  });
});
