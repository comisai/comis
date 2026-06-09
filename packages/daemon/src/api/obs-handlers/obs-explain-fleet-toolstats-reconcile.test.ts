// SPDX-License-Identifier: Apache-2.0
/**
 * QT1 — the load-bearing toolStats-reconciliation invariant.
 *
 * `obs.explain` and `obs.fleet.health` must NEVER report contradicting per-tool
 * {ok,failed} for the SAME session. A lens that contradicts itself is the bug
 * this test exists to forbid.
 *
 * The two lenses read DIFFERENT, structurally-fixed sources:
 *   - `obs.explain` headline `toolStats` = the WHOLE-session trajectory union
 *     (`signals.toolStats`, derived from every `tool.result` event APPENDED to
 *     the session's `.trajectory.jsonl` across every execution/turn). COMPLETE.
 *   - `obs.fleet.health` `toolStats` = the per-session rollup, LATEST-execution-
 *     wins (`aggregateSessionsInWindow` collapses a session's many
 *     `session_summary` rows to `MAX(id)`, then `reduceFleetWindow` sums across
 *     sessions). The rollup is built PER-EXECUTION (`buildSessionHealthRollup`)
 *     and the `_session-metadata.json` `sessionEnd` is OVERWRITTEN per execution.
 *
 * So for a MULTI-EXECUTION session the rollup is a STRICT SUBSET of the
 * trajectory: `rollup.{ok,failed} ≤ trajectory.{ok,failed}` per tool. The two may
 * differ ONLY because the rollup is the last execution while the trajectory is
 * the whole session — NEVER because they contradict (the rollup must never
 * OVERcount the trajectory).
 *
 * THE CONTRACT this test pins (RED on pre-patch code — `coverage.toolStats` does
 * not exist on the schema or the assembler output, so the assembler silently
 * presents the trajectory numbers with NO transparent note that fleet's rollup
 * differs):
 *
 *   1. The IncidentReport carries a TRANSPARENT, bounded `coverage.toolStats`
 *      reconciliation block: `reconciled` (the directional invariant held),
 *      `rollupSource: "last-execution"`, and a bounded `divergentTools[]` naming
 *      each tool where the persisted rollup (= fleet's number) differs from the
 *      trajectory, with BOTH count pairs — so a consumer cross-referencing
 *      `comis explain` vs `comis fleet` understands WHY the numbers differ
 *      instead of seeing a silent contradiction.
 *   2. The directional INVARIANT: rollup ⊆ trajectory per tool. When the rollup
 *      OVERcounts (a genuine accounting bug — the rollup counted something the
 *      trajectory never recorded), `reconciled` is `false` and the offending tool
 *      is surfaced, NOT hidden behind the silent override.
 *   3. End-to-end: feed ONE seeded session into BOTH `assembleIncidentReport`
 *      (explain) AND `reduceFleetWindow` (fleet) and assert the two lenses
 *      reconcile under the documented bounded rule.
 *
 * @module
 */

import { describe, it, expect } from "vitest";
import type { IncidentSignals } from "@comis/core";
import { reduceFleetWindow } from "@comis/memory";
import type { SessionSummaryRollup } from "@comis/memory";
import { assembleIncidentReport } from "./obs-explain-assemble.js";

const SESSION_KEY = "default:tenant_a:tenant_a:peer:peer_a";
const READ_COUNT = 7;

/** Build the explain-side signals (trajectory union) with explicit toolStats. */
function makeSignals(
  toolStats: IncidentSignals["toolStats"],
): IncidentSignals {
  return {
    sessionKey: SESSION_KEY,
    toolStats,
    failures: [],
    breakerEvents: [],
    offloads: [],
    hasDoNotRetrySignal: false,
    repeatedFailureCount: {},
    hasMisclassificationSignal: false,
  };
}

/**
 * Build the F1 `_session-metadata.json` (PRIMARY) carrying the LATEST-execution
 * rollup `toolStats` — the SAME toolStats the persisted `session_summary` row
 * (fleet's source) carries, because both are spread from the one
 * `SessionHealthRollup` at the post-execution chokepoint.
 */
function makeMetadata(
  rollupToolStats: Record<string, { ok: number; failed: number }>,
): Record<string, unknown> {
  return {
    sessionKey: SESSION_KEY,
    agentId: "default",
    channel: { type: "peer", id: "peer_a" },
    sessionEnd: {
      type: "session_end",
      endReason: "completed_with_tool_errors",
      durationMs: 9_000,
      totalTokens: 100,
      degraded: true,
      costUsd: 0.1,
      toolStats: rollupToolStats,
      breakerTripCount: 0,
      topErrorKinds: { dependency: 1 },
    },
  };
}

/** Build the fleet-side per-session rollup row carrying the SAME rollup toolStats. */
function makeFleetRow(
  rollupToolStats: Record<string, { ok: number; failed: number }>,
): SessionSummaryRollup {
  return {
    sessionKey: SESSION_KEY,
    lastTs: 1_700_000_000_000,
    degraded: true,
    costUsd: 0.1,
    toolStats: rollupToolStats,
    breakerTripCount: 0,
    turnCount: 1,
    topErrorKinds: { dependency: 1 },
    source: "runtime",
  };
}

describe("obs.explain ↔ obs.fleet.health toolStats reconciliation (QT1)", () => {
  it("surfaces a transparent coverage.toolStats note when the latest-execution rollup is a SUBSET of the whole-session trajectory (multi-execution)", () => {
    // The whole-session trajectory union: web_fetch ran across 3 turns → 6 ok / 9
    // failed total. The persisted rollup (= fleet's number) reflects only the
    // LAST execution → 2 ok / 3 failed. This is the dominant production case and
    // the pre-patch assembler hid it: explain showed 6/9, fleet showed 2/3, with
    // NO note explaining the gap — a self-contradiction.
    const trajectory = { web_fetch: { ok: 6, failed: 9, topErrorKind: "dependency" } };
    const rollup = { web_fetch: { ok: 2, failed: 3 } };

    const report = assembleIncidentReport(
      makeSignals(trajectory),
      makeMetadata(rollup),
      null,
      SESSION_KEY,
      READ_COUNT,
    );

    // Headline toolStats stays the COMPLETE trajectory view (explain reads the
    // whole session — that is its job and its advantage over fleet).
    expect(report.toolStats.web_fetch).toMatchObject({ ok: 6, failed: 9 });

    // The reconciliation block exists and is TRANSPARENT about the divergence.
    expect(report.coverage!.toolStats).toBeDefined();
    expect(report.coverage!.toolStats!.rollupSource).toBe("last-execution");
    // The directional invariant HELD (rollup ⊆ trajectory) — the two lenses do
    // not contradict; they differ by a documented trajectory-only extra.
    expect(report.coverage!.toolStats!.reconciled).toBe(true);

    // The divergent tool is named with BOTH count pairs so a consumer cross-
    // referencing `comis explain` (trajectory) vs `comis fleet` (rollup) sees
    // exactly why the numbers differ.
    const divergent = report.coverage!.toolStats!.divergentTools;
    expect(divergent).toHaveLength(1);
    expect(divergent[0]).toEqual({
      tool: "web_fetch",
      rollup: { ok: 2, failed: 3 },
      trajectory: { ok: 6, failed: 9 },
    });
  });

  it("reports reconciled=true and NO divergent tools when the rollup and the trajectory agree exactly (single-execution session)", () => {
    // A single-turn session: the last-execution rollup IS the whole trajectory.
    const stats = { Read: { ok: 3, failed: 0, topErrorKind: undefined } };
    const rollup = { Read: { ok: 3, failed: 0 } };

    const report = assembleIncidentReport(
      makeSignals(stats),
      makeMetadata(rollup),
      null,
      SESSION_KEY,
      READ_COUNT,
    );

    expect(report.coverage!.toolStats!.reconciled).toBe(true);
    expect(report.coverage!.toolStats!.divergentTools).toEqual([]);
  });

  it("flags reconciled=false and surfaces the offending tool when the rollup OVERcounts the trajectory (the accounting-bug case, never hidden)", () => {
    // The rollup claims MORE failures than the trajectory recorded — the
    // forbidden direction (rollup ⊄ trajectory). This is a genuine accounting
    // bug; the report must SURFACE it (reconciled:false) rather than bury it
    // behind the silent signal-override.
    const trajectory = { exec: { ok: 1, failed: 1, topErrorKind: "dependency" } };
    const rollup = { exec: { ok: 1, failed: 4 } }; // 4 > 1 trajectory failures

    const report = assembleIncidentReport(
      makeSignals(trajectory),
      makeMetadata(rollup),
      null,
      SESSION_KEY,
      READ_COUNT,
    );

    expect(report.coverage!.toolStats!.reconciled).toBe(false);
    const divergent = report.coverage!.toolStats!.divergentTools;
    expect(divergent.some((d) => d.tool === "exec")).toBe(true);
  });

  it("treats a rollup-only tool (in the rollup, absent from the trajectory) as an OVERcount — reconciled=false", () => {
    // The persisted rollup names a tool the trajectory never recorded. That is
    // the rollup over-counting (trajectory ok=0/failed=0 for that tool) and must
    // not reconcile — explain would otherwise show the tool with no trajectory
    // backing while fleet counts it.
    const trajectory = { Read: { ok: 2, failed: 0, topErrorKind: undefined } };
    const rollup = { Read: { ok: 2, failed: 0 }, ghost_tool: { ok: 0, failed: 1 } };

    const report = assembleIncidentReport(
      makeSignals(trajectory),
      makeMetadata(rollup),
      null,
      SESSION_KEY,
      READ_COUNT,
    );

    expect(report.coverage!.toolStats!.reconciled).toBe(false);
    expect(report.coverage!.toolStats!.divergentTools.some((d) => d.tool === "ghost_tool")).toBe(true);
  });

  it("end-to-end: ONE seeded session feeds BOTH lenses and they reconcile under the bounded rule (rollup ⊆ trajectory, never contradicting)", () => {
    // The single source of truth for fleet: the per-session rollup row. Its
    // toolStats is the SAME object the explain-side metadata sessionEnd carries
    // (both spread from one SessionHealthRollup at the chokepoint).
    const rollupToolStats = { web_fetch: { ok: 2, failed: 3 }, Read: { ok: 4, failed: 0 } };
    // The explain-side trajectory union is a SUPERSET (more turns appended).
    const trajectoryToolStats = {
      web_fetch: { ok: 6, failed: 9, topErrorKind: "dependency" },
      Read: { ok: 4, failed: 0, topErrorKind: undefined },
    };

    // FLEET lens: reduce the window over the one session.
    const fleet = reduceFleetWindow([makeFleetRow(rollupToolStats)], { excludeSynthetic: true });

    // EXPLAIN lens: assemble the incident report from the same session.
    const report = assembleIncidentReport(
      makeSignals(trajectoryToolStats),
      makeMetadata(rollupToolStats),
      null,
      SESSION_KEY,
      READ_COUNT,
    );

    // The two lenses are RECONCILED: for every tool fleet reports, the count is
    // ≤ the trajectory count explain reports (rollup ⊆ trajectory — bounded, NOT
    // contradicting), and the explain report says so transparently.
    expect(report.coverage!.toolStats!.reconciled).toBe(true);
    for (const [tool, fleetStat] of Object.entries(fleet.toolStats)) {
      const trajStat = report.toolStats[tool]!;
      expect(fleetStat.ok).toBeLessThanOrEqual(trajStat.ok);
      expect(fleetStat.failed).toBeLessThanOrEqual(trajStat.failed);
    }

    // And the divergence (web_fetch: fleet 2/3 vs explain 6/9) is explicitly
    // recorded so the operator who runs BOTH commands is never left guessing.
    const wf = report.coverage!.toolStats!.divergentTools.find((d) => d.tool === "web_fetch");
    expect(wf).toEqual({
      tool: "web_fetch",
      rollup: { ok: 2, failed: 3 },
      trajectory: { ok: 6, failed: 9 },
    });
  });
});
