// SPDX-License-Identifier: Apache-2.0
/**
 * `subagent_stuck_killed` verdict tests.
 *
 * The failure mode this verdict makes visible (live incident): the daemon
 * health monitor force-killed a sub-agent mid-final-answer; the child's own
 * rollup still recorded a clean end (the kill raced completion), the parent
 * saw a misattributed "Killed by parent agent" status, and `comis explain`
 * on the child returned no kill-shaped verdict — the operator had to grep
 * the daemon log for the health-handler WARN. Keyed on the bridged
 * `subagentKilled` signal (folded from the `subagent.killed` trajectory
 * record); a parent/operator kill is deliberate orchestration and must NOT
 * read as a root cause.
 */
import { describe, it, expect } from "vitest";

import { toIncidentSignals } from "./obs-explain-signals.js";
import { subagentStuckKilledVerdict } from "./obs-explain-subagent-killed-verdict.js";

function killedSignals(data: Record<string, unknown>) {
  return toIncidentSignals([
    { traceSchema: "comis-trajectory", schemaVersion: 1, type: "subagent.killed", seq: 1, data },
  ]);
}

describe("subagentStuckKilledVerdict", () => {
  it("fires on a health-monitor kill, naming the knob + the idle/threshold numbers", () => {
    const v = subagentStuckKilledVerdict(killedSignals({
      runId: "r", killedBy: "health_monitor",
      runtimeMs: 186_592, idleMs: 186_592, thresholdMs: 180_000,
    }));
    expect(v).not.toBeNull();
    expect(v!.code).toBe("subagent_stuck_killed");
    expect(v!.detail).toMatch(/health monitor/);
    expect(v!.detail).toMatch(/186592ms/);
    expect(v!.detail).toMatch(/180000/);
    // The rollup may still read success — the kill races completion; the
    // verdict must warn the reader not to trust a clean rollup over the kill.
    expect(v!.detail).toMatch(/rollup|success/i);
    expect(v!.suggestedNextSteps.join(" ")).toMatch(/stuckKillThresholdMs/);
  });

  it("does NOT fire on a parent kill (deliberate orchestration)", () => {
    const v = subagentStuckKilledVerdict(killedSignals({
      runId: "r", killedBy: "parent", runtimeMs: 5_000,
    }));
    expect(v).toBeNull();
  });

  it("does NOT fire when no kill signal exists", () => {
    const v = subagentStuckKilledVerdict(toIncidentSignals([]));
    expect(v).toBeNull();
  });
});
