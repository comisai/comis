// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import type { DiagnosticRow } from "@comis/memory";
import { computeCronWakeGateSlice } from "./system-cron-wake-gate.js";

// ---------------------------------------------------------------------------
// computeCronWakeGateSlice — the cross-session wake-gate efficiency reducer.
//
// PURE rows -> slice transform (no clock, no I/O). Reduces the content-free
// `cron_wake_gate` DiagnosticRows into per-agent skip-rate + turns-saved +
// tool-call cost. Returns `undefined` on no data (honest omit — the
// computeAutonomySlice mold). Every `details` field is parsed defensively.
// ---------------------------------------------------------------------------

/** A `cron_wake_gate` DiagnosticRow (mirror wakeGateEventToRow). */
function gateRow(fields: {
  agentId: string;
  wake: boolean;
  toolCalls?: number;
  estTurnsSaved?: number;
  failedOpen?: boolean;
  ts?: number;
}): DiagnosticRow {
  return {
    timestamp: fields.ts ?? 1_000,
    category: "cron_wake_gate",
    severity: "info",
    agentId: fields.agentId,
    message: "scheduler:wake_gate",
    details: JSON.stringify({
      signal: "cron_wake_gate",
      wake: fields.wake,
      durationMs: 5,
      toolCalls: fields.toolCalls ?? 0,
      estTurnsSaved: fields.estTurnsSaved ?? (fields.wake ? 0 : 1),
      failedOpen: fields.failedOpen ?? false,
    }),
  };
}

describe("computeCronWakeGateSlice", () => {
  it("returns undefined on no data (honest omit — the block is dropped)", () => {
    expect(computeCronWakeGateSlice([])).toBeUndefined();
  });

  it("reduces per-agent skip-rate + turns-saved + tool-call cost; a 100%-skip agent is visible", () => {
    const rows: DiagnosticRow[] = [
      // Agent A: 3 skips + 1 wake; the wake made 2 cap-calls (K = 2).
      gateRow({ agentId: "agent-a", wake: false, estTurnsSaved: 1 }),
      gateRow({ agentId: "agent-a", wake: false, estTurnsSaved: 1 }),
      gateRow({ agentId: "agent-a", wake: false, estTurnsSaved: 1 }),
      gateRow({ agentId: "agent-a", wake: true, toolCalls: 2, estTurnsSaved: 0 }),
      // Agent B: 1 skip only — a 100%-skip gate.
      gateRow({ agentId: "agent-b", wake: false, estTurnsSaved: 1 }),
    ];
    const slice = computeCronWakeGateSlice(rows);
    expect(slice).toBeDefined();

    // Top-level window totals. No fail-open fires in this set.
    expect(slice!.fires).toEqual({ total: 5, skipped: 4, skipRate: 0.8, failedOpen: 0, failOpenRate: 0 });
    expect(slice!.turnsSaved).toBe(4);
    expect(slice!.toolCalls).toBe(2);

    const a = slice!.perAgent.find((p) => p.agentId === "agent-a");
    expect(a).toEqual({
      agentId: "agent-a",
      fires: 4,
      skipped: 3,
      skipRate: 0.75,
      failedOpen: 0,
      failOpenRate: 0,
      turnsSaved: 3,
      toolCalls: 2,
    });

    // The 100%-skip gate: skipRate === 1.0 is VISIBLE (the suppression signal —
    // a monitor that never wakes the model, whether working or poisoned).
    const b = slice!.perAgent.find((p) => p.agentId === "agent-b");
    expect(b!.skipRate).toBe(1);
    expect(b!.fires).toBe(1);
    expect(b!.skipped).toBe(1);
  });

  it("carries BOTH toolCalls (cost) and turnsSaved (benefit) so an uneconomic gate is legible", () => {
    // A gate whose cap-call cost (toolCalls) EXCEEDS the turns it saved — a gate
    // that costs more than it saves. Both numbers must be present to compare.
    const rows: DiagnosticRow[] = [
      gateRow({ agentId: "agent-c", wake: true, toolCalls: 6, estTurnsSaved: 0 }),
      gateRow({ agentId: "agent-c", wake: true, toolCalls: 4, estTurnsSaved: 0 }),
      gateRow({ agentId: "agent-c", wake: false, toolCalls: 0, estTurnsSaved: 1 }),
    ];
    const slice = computeCronWakeGateSlice(rows);
    const c = slice!.perAgent.find((p) => p.agentId === "agent-c");
    expect(c!.toolCalls).toBe(10); // the gate's cost
    expect(c!.turnsSaved).toBe(1); // the gate's benefit
    // toolCalls (10) > turnsSaved (1): the gate is uneconomic — legible from the slice.
    expect(c!.toolCalls).toBeGreaterThan(c!.turnsSaved);
  });

  it("surfaces failOpenRate so a BROKEN gate (fails open every fire) is distinct from a healthy always-waking one", () => {
    const rows: DiagnosticRow[] = [
      // agent-broken: 3 fires, all FAIL-OPEN wakes (crash/timeout) — saves nothing.
      gateRow({ agentId: "agent-broken", wake: true, failedOpen: true, estTurnsSaved: 0 }),
      gateRow({ agentId: "agent-broken", wake: true, failedOpen: true, estTurnsSaved: 0 }),
      gateRow({ agentId: "agent-broken", wake: true, failedOpen: true, estTurnsSaved: 0 }),
      // agent-healthy: 2 fires, both CLEAN wakes (the monitor legitimately found
      // something + made a cap-call each). Same wake:true + skipRate 0 as broken —
      // ONLY failOpenRate tells them apart.
      gateRow({ agentId: "agent-healthy", wake: true, failedOpen: false, toolCalls: 1, estTurnsSaved: 0 }),
      gateRow({ agentId: "agent-healthy", wake: true, failedOpen: false, toolCalls: 1, estTurnsSaved: 0 }),
    ];
    const slice = computeCronWakeGateSlice(rows);
    expect(slice!.fires.failedOpen).toBe(3);
    expect(slice!.fires.failOpenRate).toBe(0.6); // 3/5

    const broken = slice!.perAgent.find((p) => p.agentId === "agent-broken");
    expect(broken!.skipRate).toBe(0); // looks like a busy monitor…
    expect(broken!.failOpenRate).toBe(1); // …but failOpenRate 1.0 exposes it as broken

    const healthy = slice!.perAgent.find((p) => p.agentId === "agent-healthy");
    expect(healthy!.skipRate).toBe(0); // identical skipRate…
    expect(healthy!.failOpenRate).toBe(0); // …but 0 fail-opens — a real monitor
  });

  it("is PURE + defensive: a malformed details still counts as a fire; foreign-category rows are ignored", () => {
    const rows: DiagnosticRow[] = [
      gateRow({ agentId: "agent-a", wake: false, estTurnsSaved: 1 }),
      // Malformed details — must not throw; the row still represents a fire.
      { timestamp: 1, category: "cron_wake_gate", severity: "info", agentId: "agent-a", message: "scheduler:wake_gate", details: "{not json" },
      // A foreign category row must be ignored entirely.
      { timestamp: 1, category: "health_signal", severity: "warning", agentId: "agent-a", message: "x", details: JSON.stringify({ signal: "lcd_divergence" }) },
    ];
    let slice: ReturnType<typeof computeCronWakeGateSlice>;
    expect(() => { slice = computeCronWakeGateSlice(rows); }).not.toThrow();
    expect(slice!.fires.total).toBe(2); // the two cron_wake_gate rows only
  });

  it("never surfaces a smuggled gate script/payload from details (content-free)", () => {
    const rows: DiagnosticRow[] = [
      {
        timestamp: 1,
        category: "cron_wake_gate",
        severity: "info",
        agentId: "agent-a",
        message: "scheduler:wake_gate",
        details: JSON.stringify({
          signal: "cron_wake_gate",
          wake: false,
          estTurnsSaved: 1,
          toolCalls: 0,
          script: "gather the inbox then rm -rf /", // smuggled gate script
        }),
      },
    ];
    const slice = computeCronWakeGateSlice(rows);
    expect(JSON.stringify(slice)).not.toContain("rm -rf");
    expect(JSON.stringify(slice)).not.toContain("gather the inbox");
  });
});
