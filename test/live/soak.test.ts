// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for soak.ts — parseHealthLine, assessHealthTrend, and runSoak.
 * All deterministic: synthetic health lines + a stub driver, NO
 * daemon boot, NO provider.
 *
 * @module
 */

import { describe, it, expect } from "vitest";
import { parseHealthLine, assessHealthTrend, runSoak, type HealthSample } from "./soak.js";

// A synthetic "Daemon health" Pino line carrying the VERIFIED daemon.ts fields.
function healthLine(over: Partial<Record<string, unknown>> = {}): string {
  return JSON.stringify({
    level: "debug",
    msg: "Daemon health",
    rssBytes: 100_000_000,
    heapUsedBytes: 50_000_000,
    heapTotalBytes: 80_000_000,
    eventLoopP99Ms: 12.5,
    activeSubAgentRuns: 0,
    stuckSubAgentRuns: 0,
    deadLetterQueueSize: 0,
    promptTimeoutsLast5m: 0,
    degradedProviders: [],
    ...over,
  });
}

describe("parseHealthLine", () => {
  it("returns the LATEST 'Daemon health' entry mapped to the verified fields", () => {
    const lines = [
      JSON.stringify({ msg: "boot", level: "info" }),
      healthLine({ rssBytes: 111 }),
      JSON.stringify({ msg: "something else", level: "info" }),
      healthLine({ rssBytes: 222, eventLoopP99Ms: 5 }),
    ].join("\n");
    const sample = parseHealthLine(lines);
    expect(sample).toBeDefined();
    expect(sample!.rssBytes).toBe(222);
    expect(sample!.eventLoopP99Ms).toBe(5);
    expect(sample!.stuckSubAgentRuns).toBe(0);
    expect(sample!.degradedProviders).toEqual([]);
  });

  it("returns undefined when no health line is present", () => {
    const lines = [JSON.stringify({ msg: "boot" }), JSON.stringify({ msg: "tick" })].join("\n");
    expect(parseHealthLine(lines)).toBeUndefined();
  });

  it("skips malformed lines and still finds a good health line", () => {
    const lines = ["not json {{{", healthLine({ rssBytes: 333 }), "} also bad"].join("\n");
    const sample = parseHealthLine(lines);
    expect(sample).toBeDefined();
    expect(sample!.rssBytes).toBe(333);
  });
});

describe("assessHealthTrend", () => {
  it("a flat/sawtooth RSS series is STABLE", () => {
    const samples: HealthSample[] = [
      { iteration: 0, rssBytes: 100, heapUsedBytes: 50, eventLoopP99Ms: 10 },
      { iteration: 1, rssBytes: 105, heapUsedBytes: 48, eventLoopP99Ms: 11 },
      { iteration: 2, rssBytes: 98, heapUsedBytes: 51, eventLoopP99Ms: 9 },
    ];
    const r = assessHealthTrend(samples);
    expect(r.stable).toBe(true);
  });

  it("a strictly-monotonic RSS series exceeding tolerance is NOT stable", () => {
    const samples: HealthSample[] = [
      { iteration: 0, rssBytes: 100_000_000 },
      { iteration: 1, rssBytes: 160_000_000 },
      { iteration: 2, rssBytes: 240_000_000 }, // > first * 1.5
    ];
    const r = assessHealthTrend(samples);
    expect(r.stable).toBe(false);
    expect(r.reason).toMatch(/RSS|heap|growth/i);
  });

  it("a nonzero stuckSubAgentRuns sample is NOT stable", () => {
    const samples: HealthSample[] = [
      { iteration: 0, rssBytes: 100, stuckSubAgentRuns: 0 },
      { iteration: 1, rssBytes: 100, stuckSubAgentRuns: 2 },
    ];
    const r = assessHealthTrend(samples);
    expect(r.stable).toBe(false);
    expect(r.reason).toMatch(/stuck/i);
  });

  it("an eventLoopP99Ms over the cap is NOT stable", () => {
    const samples: HealthSample[] = [{ iteration: 0, rssBytes: 100, eventLoopP99Ms: 5000 }];
    const r = assessHealthTrend(samples, { eventLoopP99CapMs: 1000 });
    expect(r.stable).toBe(false);
    expect(r.reason).toMatch(/eventLoop|p99/i);
  });

  it("a non-empty degradedProviders sample is NOT stable", () => {
    const samples: HealthSample[] = [{ iteration: 0, rssBytes: 100, degradedProviders: ["anthropic"] }];
    const r = assessHealthTrend(samples);
    expect(r.stable).toBe(false);
    expect(r.reason).toMatch(/degraded/i);
  });
});

describe("runSoak (stub driver — no daemon)", () => {
  // A stub driver: sendTurn resolves; capturedLogLines returns a stable health line.
  function stubDriver(opts?: { rejectTurn?: boolean }) {
    let turns = 0;
    return {
      turns: () => turns,
      sendTurn: async (_text: string) => {
        turns++;
        if (opts?.rejectTurn) throw new Error("agent.execute RPC error: JSON-RPC method error");
        return "ok";
      },
      capturedLogLines: () => healthLine(),
    };
  }

  const tinyStory = {
    id: "__test__soak-1",
    story: "soak traffic",
    tags: ["A" as const],
    dimensions: [],
    requires: {},
    costTier: "$0" as const,
    determinism: { runs: 1, passRateThreshold: 1 },
    steps: [{ verb: "send_text" as const, text: "ping" }],
    acceptance: { outcomes: [], rubric: "x" },
    status: "active" as const,
  };

  it("runs the iterations × the traffic set and returns a healthy SoakResult on stable health", async () => {
    const driver = stubDriver();
    const result = await runSoak({ driver, iterations: 3, stories: [tinyStory] });
    expect(result.iterations).toBe(3);
    expect(result.healthy).toBe(true);
    expect(result.violations).toEqual([]);
    expect(result.samples.length).toBe(3);
    // 3 iterations × 1 story × 1 send_text step = 3 turns
    expect(driver.turns()).toBe(3);
  });

  it("NEVER throws on a tolerated turn error — the soak catches it and completes", async () => {
    const driver = stubDriver({ rejectTurn: true });
    const result = await runSoak({ driver, iterations: 2, stories: [tinyStory] });
    expect(result.iterations).toBe(2);
    // turns still attempted despite each rejecting
    expect(driver.turns()).toBe(2);
  });

  it("reports unhealthy when the health line shows instability", async () => {
    let turns = 0;
    const unstableDriver = {
      sendTurn: async (_text: string) => {
        turns++;
        return "ok";
      },
      // a health line with a nonzero deadLetterQueueSize → unstable
      capturedLogLines: () => healthLine({ deadLetterQueueSize: 5 }),
    };
    const result = await runSoak({ driver: unstableDriver, iterations: 1, stories: [tinyStory] });
    expect(result.healthy).toBe(false);
    expect(result.violations.length).toBeGreaterThan(0);
  });
});
