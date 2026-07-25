// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for the pure `assembleIncidentReport`.
 *
 * `assembleIncidentReport(signals, metadata, rollup, sessionKey, recordCount)`
 * merges the normalized {@link IncidentSignals} + the F1
 * `_session-metadata.json` rollup (PRIMARY) + the F2 `obs_diagnostics`
 * rollup row (FALLBACK) into an {@link IncidentReport} — a PURE function
 * with no I/O and no LLM. `recordCount` is the number of trajectory records the
 * reader READ (the meta-observability signal behind `coverage.trajectory`).
 *
 * These tests pin the contract per field group:
 *   - **cost** comes from the F1 metadata rollup (`sessionEnd.costUsd`) with a
 *     fallback chain: `sessionEnd.costUsd` → top-level `sessionCostUsd` →
 *     F2 `rollup.costUsd` → `0`. For the 678 fixture this is `1.320669`.
 *   - **outcome.degraded** is `rollup.degraded ?? (endReason ∈ DEGRADED_SET)`;
 *     **severity** is `"failed"` for a hard-failure endReason, else `"degraded"`
 *     when degraded, else `"ok"`.
 *   - **toolStats** merges the signal per-tool counts with the rollup toolStats;
 *     **failures[]** is newest-first (seq descending); **breakerTimeline[]** /
 *     **offloads[]** are copied straight from the signals.
 *   - **likelyRootCause** stays `null` (the heuristics pass owns it);
 *     **truncations** is `[]` (the bounding pass owns it); **schemaVersion** is
 *     `1`; ids echo from metadata/signals and NEVER throw on absent fields.
 *
 * The assembler copies the ALREADY-bounded `errorPreview` (≤200, redacted by
 * the normalizer) and the ALREADY-relativized offload pointers — it introduces
 * no raw body.
 *
 * @module
 */

import { describe, it, expect } from "vitest";
import type { IncidentFailure, IncidentSignals } from "@comis/core";
import { IncidentReportSchema } from "@comis/core";
import { assembleIncidentReport } from "./obs-explain-assemble.js";
import { boundIncidentReport } from "./obs-explain-bound.js";
// The cacheBreaks? fold rides toIncidentSignals;
// the audit? fold rides assembleIncidentReportFromSources (reader-sourced).
import { toIncidentSignals } from "./obs-explain-signals.js";
import { spendExceededVerdict } from "./obs-explain-spend-verdict.js";
import { assembleIncidentReportFromSources } from "./obs-explain.js";
import type { IncidentSourceReader } from "./obs-explain-readers.js";

// ---------------------------------------------------------------------------
// Local factories — synthetic signals/metadata (NO real session data, NO disk).
// ---------------------------------------------------------------------------

const SESSION_KEY = "default:678314278:678314278:peer:678314278";

// A representative non-zero "the reader READ N trajectory records" count for the
// field-group tests below (none of which assert on `coverage` — they pin
// cost/outcome/timing/toolStats/failures, for which the read count is immaterial).
// The dedicated `coverage` tests at the bottom pass explicit per-case counts.
const READ_COUNT = 2;

function makeFailure(overrides: Partial<IncidentFailure> = {}): IncidentFailure {
  return {
    seq: 1,
    toolName: "web_fetch",
    classifiedFailureBy: "",
    transportOk: false,
    httpStatus: 200,
    errorKind: "dependency",
    resultDigest: "abc123def456",
    resultBytes: 128,
    errorPreview: "web_fetch failed (status 200)",
    ...overrides,
  };
}

function makeSignals(overrides: Partial<IncidentSignals> = {}): IncidentSignals {
  return {
    sessionKey: SESSION_KEY,
    toolStats: { web_fetch: { ok: 2, failed: 8, topErrorKind: "dependency" } },
    failures: [makeFailure({ seq: 1 }), makeFailure({ seq: 2 }), makeFailure({ seq: 3 })],
    breakerEvents: [],
    offloads: [],
    nodeBudgetBreaches: [],
    hasDoNotRetrySignal: false,
    repeatedFailureCount: { web_fetch: 8 },
    hasMisclassificationSignal: true,
    misclassifiedTool: "web_fetch",
    misclassifiedToken: "status",
    ...overrides,
  };
}

/**
 * Build an F1 metadata object. `sessionEnd` is the nested end-of-session rollup;
 * top-level fields (traceId, agentId, channel, sessionCostUsd) sit beside it.
 */
function makeMetadata(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sessionKey: SESSION_KEY,
    sessionId: "678314278",
    traceId: "f942d38c-0000-0000-0000-000000000000",
    agentId: "default",
    channel: { type: "peer", id: "678314278" },
    sessionEnd: {
      type: "session_end",
      timestamp: "2026-06-07T18:00:00.000Z",
      endReason: "completed_with_tool_errors",
      durationMs: 12_000,
      totalTokens: 735_800,
      degraded: true,
      costUsd: 1.320669,
      toolStats: { web_fetch: { ok: 2, failed: 8 } },
      breakerTripCount: 1,
      topErrorKinds: { dependency: 8 },
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// The per-node budget-breach section is surfaced when the signals carry
// breaches (capSource names WHICH knob bound the node) and OMITTED when there
// are none (additive; schemaVersion stays 1).
// ---------------------------------------------------------------------------

describe("assembleIncidentReport — nodeBudgetBreaches", () => {
  it("surfaces nodeBudgetBreaches with capSource when the signals carry a breach", () => {
    const report = assembleIncidentReport(
      makeSignals({
        nodeBudgetBreaches: [{ seq: 5, nodeId: "greedy", capSource: "node", tokenBudget: 5000, tokensUsed: 17770 }],
      }),
      makeMetadata(),
      null,
      SESSION_KEY,
      READ_COUNT,
    );
    expect(report.nodeBudgetBreaches).toHaveLength(1);
    expect(report.nodeBudgetBreaches![0]).toMatchObject({ nodeId: "greedy", capSource: "node", tokenBudget: 5000, tokensUsed: 17770 });
  });

  it("OMITS nodeBudgetBreaches entirely when there are no breaches (additive — the section is absent, schemaVersion stays 1)", () => {
    const report = assembleIncidentReport(makeSignals({ nodeBudgetBreaches: [] }), makeMetadata(), null, SESSION_KEY, READ_COUNT);
    expect(report.nodeBudgetBreaches).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// The spawn-tree section is surfaced when the signals carry
// nodes (folded from capability.audited records) and OMITTED when empty
// (additive; schemaVersion stays 1) — the nodeBudgetBreaches mold.
// ---------------------------------------------------------------------------

describe("assembleIncidentReport — spawnTree", () => {
  it("surfaces spawnTree when the signals carry nodes; schemaVersion stays 1", () => {
    const report = assembleIncidentReport(
      makeSignals({
        spawnTree: [
          {
            leaseId: "L-root",
            rootRunId: "R",
            agentId: "a1",
            caps: ["orch:read"],
            toolsInvoked: ["memory_search"],
            denials: [],
          },
          {
            leaseId: "L-child",
            parentLeaseId: "L-root",
            rootRunId: "R",
            agentId: "a1",
            caps: ["orch:web"],
            toolsInvoked: ["web_fetch"],
            denials: ["orch:web"],
          },
        ],
      }),
      makeMetadata(),
      null,
      SESSION_KEY,
      READ_COUNT,
    );
    expect(report.schemaVersion).toBe(1);
    expect(report.spawnTree).toHaveLength(2);
    expect(report.spawnTree![1]).toMatchObject({
      leaseId: "L-child",
      parentLeaseId: "L-root",
      denials: ["orch:web"],
    });
  });

  it("OMITS spawnTree entirely when there are no nodes (additive — the section is absent, schemaVersion stays 1)", () => {
    const report = assembleIncidentReport(makeSignals({ spawnTree: [] }), makeMetadata(), null, SESSION_KEY, READ_COUNT);
    expect(report.spawnTree).toBeUndefined();
    expect(report.schemaVersion).toBe(1);
  });

  it("OMITS spawnTree when the signal field is absent (the common no-spawn case)", () => {
    const report = assembleIncidentReport(makeSignals(), makeMetadata(), null, SESSION_KEY, READ_COUNT);
    expect(report.spawnTree).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// The orchestrate? section — one entry per run, folded from
// orchestrate.run_summary records with per-run toolCalls joined by the child
// leaseId (EXPLAIN-04) and the labeled savings estimate (SAVE-02). Content-free +
// presence-conditional (absent when no run occurred) — the spawnTree mold.
// ---------------------------------------------------------------------------

/** An `orchestrate.run_summary` trajectory record envelope (post-translate shape). */
function runSummaryRecord(data: Record<string, unknown>, seq: number): Record<string, unknown> {
  return { traceSchema: "comis-trajectory", type: "orchestrate.run_summary", seq, data };
}

/** A `capability.audited` trajectory record scoped to a run's child leaseId. */
function capAuditRecord(data: Record<string, unknown>, seq: number): Record<string, unknown> {
  return { traceSchema: "comis-trajectory", type: "capability.audited", seq, agentId: "default", data };
}

describe("assembleIncidentReport — orchestrate section", () => {
  it("surfaces report.orchestrate for a forced non-zero-exit run with failureClass + joined toolCalls + savings", () => {
    const signals = toIncidentSignals([
      runSummaryRecord(
        {
          runId: "orch-1",
          leaseId: "lease-child-1",
          rootRunId: "root-x",
          language: "ts",
          durationMs: 4200,
          exitCode: 1,
          failureClass: "nonzero_exit",
          stdoutBytesRaw: 480,
          stdoutCharsReentered: 480,
          resultRefCount: 3,
          resultRefBytes: 120_000,
          estSavedTokens: 29_500,
          savedRatio: 0.98,
        },
        1,
      ),
      // a denied orch:web call + two allowed orch:read calls in THAT run (same leaseId)
      capAuditRecord({ leaseId: "lease-child-1", rootRunId: "root-x", tool: "web_fetch", capability: "orch:read", decision: "allow" }, 2),
      capAuditRecord({ leaseId: "lease-child-1", rootRunId: "root-x", tool: "web_fetch", capability: "orch:read", decision: "allow" }, 3),
      capAuditRecord({ leaseId: "lease-child-1", rootRunId: "root-x", tool: "web_browse", capability: "orch:web", decision: "deny" }, 4),
    ]);
    const report = assembleIncidentReport(signals, makeMetadata(), null, SESSION_KEY, 4);
    expect(report.orchestrate).toHaveLength(1);
    const run = report.orchestrate![0]!;
    expect(run).toMatchObject({ runId: "orch-1", outcome: "failure", exitCode: 1, failureClass: "nonzero_exit" });
    // SAVE-02: savings rides the section.
    expect(run.savings).toEqual({ estSavedTokens: 29_500, savedRatio: 0.98 });
    expect(run.resultRefs).toEqual({ count: 3, bytes: 120_000 });
    // EXPLAIN-04: the deny is attributed to THIS run; the allows are counted.
    expect(run.toolCalls).toContainEqual({ tool: "web_browse", capability: "orch:web", decision: "deny", count: 1 });
    expect(run.toolCalls).toContainEqual({ tool: "web_fetch", capability: "orch:read", decision: "allow", count: 2 });
    expect(report.schemaVersion).toBe(1);
    expect(() => IncidentReportSchema.parse(report)).not.toThrow();
  });

  it("OMITS report.orchestrate when the session ran no orchestrate script (undefined, not [])", () => {
    const report = assembleIncidentReport(toIncidentSignals([]), makeMetadata(), null, SESSION_KEY, 0);
    expect(report.orchestrate).toBeUndefined();
  });

  it("a clean exit-0 run surfaces outcome:success, no failureClass, empty toolCalls", () => {
    const signals = toIncidentSignals([
      runSummaryRecord({ runId: "orch-ok", leaseId: "L2", exitCode: 0, durationMs: 12, resultRefCount: 0, resultRefBytes: 0 }, 1),
    ]);
    const report = assembleIncidentReport(signals, makeMetadata(), null, SESSION_KEY, 1);
    expect(report.orchestrate![0]).toMatchObject({ runId: "orch-ok", outcome: "success" });
    expect(report.orchestrate![0]!.failureClass).toBeUndefined();
    expect(report.orchestrate![0]!.toolCalls).toEqual([]);
  });

  it("is content-free — never carries a script/stderr body even when the record smuggles one", () => {
    const signals = toIncidentSignals([
      runSummaryRecord(
        { runId: "orch-x", leaseId: "L3", exitCode: 1, durationMs: 3, failureClass: "nonzero_exit", resultRefCount: 0, resultRefBytes: 0, stderrTail: "secret-tail", script: "rm -rf /" },
        1,
      ),
    ]);
    const report = assembleIncidentReport(signals, makeMetadata(), null, SESSION_KEY, 1);
    const serialized = JSON.stringify(report.orchestrate);
    expect(serialized).not.toContain("secret-tail");
    expect(serialized).not.toContain("rm -rf");
  });
});

// ---------------------------------------------------------------------------
// The cronWakeGate section is surfaced when the signals carry the woke-fire fact
// (folded from a scheduler.wake_gate record) and OMITTED otherwise — the
// nodeBudgetBreaches/spawnTree presence-conditional mold. A SKIPPED fire opens no
// session, so its report never exists; the omit case is a non-gate / woke-less session.
// ---------------------------------------------------------------------------

describe("assembleIncidentReport — cronWakeGate (the woke-fire fact)", () => {
  const wokeFact = { jobId: "j1", wake: true, durationMs: 20, toolCalls: 2, estTurnsSaved: 0 };

  it("surfaces cronWakeGate when the signals carry it; schemaVersion stays 1", () => {
    const report = assembleIncidentReport(
      makeSignals({ cronWakeGate: wokeFact }),
      makeMetadata(),
      null,
      SESSION_KEY,
      READ_COUNT,
    );
    expect(report.schemaVersion).toBe(1);
    expect(report.cronWakeGate).toEqual(wokeFact);
  });

  it("end-to-end: a scheduler.wake_gate trajectory record reaches report.cronWakeGate (record → toIncidentSignals → assemble)", () => {
    const signals = toIncidentSignals([
      {
        traceSchema: "comis-trajectory",
        schemaVersion: 1,
        type: "scheduler.wake_gate",
        seq: 1,
        data: { jobId: "nightly", agentId: "default", wake: true, durationMs: 42, toolCalls: 3, estTurnsSaved: 0 },
      },
    ]);
    const report = assembleIncidentReport(signals, makeMetadata(), null, SESSION_KEY, READ_COUNT);
    expect(report.cronWakeGate).toEqual({ jobId: "nightly", wake: true, durationMs: 42, toolCalls: 3, estTurnsSaved: 0 });
  });

  it("OMITS cronWakeGate when the signal field is absent (a woke-less / skipped session; schemaVersion stays 1)", () => {
    const report = assembleIncidentReport(makeSignals(), makeMetadata(), null, SESSION_KEY, READ_COUNT);
    expect(report.cronWakeGate).toBeUndefined();
    expect(report.schemaVersion).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// cost — the primary fallback chain keeps the recorded 1.320669 total stable.
// ---------------------------------------------------------------------------

describe("assembleIncidentReport — cost", () => {
  it("reads costUsd 1.320669 from the F1 metadata sessionEnd rollup", () => {
    const report = assembleIncidentReport(
      makeSignals(),
      makeMetadata({ sessionEnd: { endReason: "completed_with_tool_errors", costUsd: 1.320669, totalTokens: 735_800 } }),
      null,
      SESSION_KEY,
      READ_COUNT,
    );
    expect(report.cost.costUsd).toBeCloseTo(1.320669, 4);
    expect(report.cost.totalTokens).toBe(735_800);
  });

  it("falls back to top-level sessionCostUsd when sessionEnd.costUsd is absent", () => {
    const report = assembleIncidentReport(
      makeSignals(),
      makeMetadata({
        sessionCostUsd: 1.320669,
        sessionEnd: { endReason: "completed_with_tool_errors", totalTokens: 735_800 },
      }),
      null,
      SESSION_KEY,
      READ_COUNT,
    );
    expect(report.cost.costUsd).toBeCloseTo(1.320669, 4);
  });

  it("falls back to the F2 diagnostics rollup costUsd when both metadata sources are absent", () => {
    const report = assembleIncidentReport(
      makeSignals(),
      makeMetadata({ sessionCostUsd: undefined, sessionEnd: { endReason: "completed_with_tool_errors" } }),
      { costUsd: 0.5 },
      SESSION_KEY,
      READ_COUNT,
    );
    expect(report.cost.costUsd).toBe(0.5);
  });

  it("falls back to 0 when every cost source is absent", () => {
    const report = assembleIncidentReport(
      makeSignals(),
      makeMetadata({ sessionCostUsd: undefined, sessionEnd: { endReason: "success" } }),
      null,
      SESSION_KEY,
      READ_COUNT,
    );
    expect(report.cost.costUsd).toBe(0);
  });

  it("reads the F2 costUsd from a JSON-encoded diagnostics-row details field", () => {
    // The real obs_diagnostics row carries the rollup payload in `details`
    // (a JSON string), not as a top-level field — parse it when top-level absent.
    const report = assembleIncidentReport(
      makeSignals(),
      null,
      { details: JSON.stringify({ costUsd: 0.75, degraded: true }) },
      SESSION_KEY,
      READ_COUNT,
    );
    expect(report.cost.costUsd).toBe(0.75);
  });

  it("never throws and yields a 0 cost when metadata is null and rollup is null", () => {
    const report = assembleIncidentReport(makeSignals(), null, null, SESSION_KEY, READ_COUNT);
    expect(report.cost.costUsd).toBe(0);
    expect(report.cost.totalTokens).toBe(0);
  });

  it("reads cost + totalTokens from the metadata top level (real 678 fixture, no sessionEnd)", () => {
    const report = assembleIncidentReport(
      makeSignals(),
      {
        sessionKey: SESSION_KEY,
        endReason: "completed_with_tool_errors",
        totalTokens: 735_800,
        sessionCostUsd: 1.320669,
      },
      null,
      SESSION_KEY,
      READ_COUNT,
    );
    expect(report.cost.costUsd).toBeCloseTo(1.320669, 4);
    expect(report.cost.totalTokens).toBe(735_800);
  });
});

// ---------------------------------------------------------------------------
// outcome — degraded / severity derivation.
// ---------------------------------------------------------------------------

describe("assembleIncidentReport — outcome", () => {
  it("honors an explicit degraded:true flag with a tool-error endReason as severity degraded", () => {
    const report = assembleIncidentReport(
      makeSignals(),
      makeMetadata({ sessionEnd: { endReason: "completed_with_tool_errors", degraded: true } }),
      null,
      SESSION_KEY,
      READ_COUNT,
    );
    expect(report.outcome.degraded).toBe(true);
    expect(report.outcome.severity).toBe("degraded");
    expect(report.outcome.endReason).toBe("completed_with_tool_errors");
  });

  it("derives degraded from the endReason set when the explicit flag is absent", () => {
    const report = assembleIncidentReport(
      makeSignals(),
      makeMetadata({ sessionEnd: { endReason: "completed_with_tool_errors" } }),
      null,
      SESSION_KEY,
      READ_COUNT,
    );
    expect(report.outcome.degraded).toBe(true);
    expect(report.outcome.severity).toBe("degraded");
  });

  it("classifies a hard-failure endReason (error) as severity failed", () => {
    const report = assembleIncidentReport(
      makeSignals(),
      makeMetadata({ sessionEnd: { endReason: "error" } }),
      null,
      SESSION_KEY,
      READ_COUNT,
    );
    expect(report.outcome.severity).toBe("failed");
    expect(report.outcome.degraded).toBe(true);
  });

  it("classifies a clean success with degraded:false as severity ok", () => {
    const report = assembleIncidentReport(
      makeSignals({ failures: [], toolStats: { web_fetch: { ok: 3, failed: 0 } } }),
      makeMetadata({ sessionEnd: { endReason: "success", degraded: false } }),
      null,
      SESSION_KEY,
      READ_COUNT,
    );
    expect(report.outcome.degraded).toBe(false);
    expect(report.outcome.severity).toBe("ok");
  });

  it("treats a timeout endReason as a hard failure (severity failed)", () => {
    const report = assembleIncidentReport(
      makeSignals(),
      makeMetadata({ sessionEnd: { endReason: "timeout" } }),
      null,
      SESSION_KEY,
      READ_COUNT,
    );
    expect(report.outcome.severity).toBe("failed");
  });

  it("derives degraded from the F2 rollup degraded flag when metadata lacks it", () => {
    const report = assembleIncidentReport(
      makeSignals(),
      makeMetadata({ sessionEnd: { endReason: "success" } }),
      { degraded: true },
      SESSION_KEY,
      READ_COUNT,
    );
    expect(report.outcome.degraded).toBe(true);
    expect(report.outcome.severity).toBe("degraded");
  });

  it("reads the endReason from the metadata top level when the fixture has no sessionEnd (real 678 shape)", () => {
    // The FROZEN 678 fixture's session-metadata.json carries the rollup fields
    // at the TOP LEVEL (endReason / durationMs / totalTokens / sessionCostUsd)
    // with NO nested sessionEnd — the assembler must read top-level too.
    const report = assembleIncidentReport(
      makeSignals(),
      {
        sessionKey: SESSION_KEY,
        sessionId: "678314278",
        endReason: "completed_with_tool_errors",
        traceId: "f942d38c-e372-43cc-99f1-ead4f0b8582f",
        durationMs: 9_000,
        totalTokens: 735_800,
        sessionCostUsd: 1.320669,
        toolFailureCount: 8,
      },
      null,
      SESSION_KEY,
      READ_COUNT,
    );
    expect(report.outcome.endReason).toBe("completed_with_tool_errors");
    expect(report.outcome.degraded).toBe(true);
    expect(report.outcome.severity).toBe("degraded");
  });
});

// ---------------------------------------------------------------------------
// A per-root autonomy.budget abort whose turn HARD-aborts skips the clean
// sessionEnd rollup,
// so the metadata carries no spend endReason — but the trajectory carries the
// terminal `execution.aborted` record with `reason` + `perRootBudget`. The
// assembler must derive `endReason` (and surface `perRootBudget`) from that record
// when the rollup is silent, else `explain` returns endReason:"unknown" +
// perRootBudget:null and the spend-verdict heuristic (gated on endReason==
// "spend_exceeded") never names the tripped limb (live repro: a tokens-limb abort
// returned likelyRootCause:null despite the trajectory carrying the data).
// ---------------------------------------------------------------------------

describe("assembleIncidentReport — per-root budget abort", () => {
  it("derives endReason + perRootBudget from a terminal execution.aborted when the rollup lacks a spend endReason", () => {
    const records: Array<Record<string, unknown>> = [
      // an EARLIER non-spend turn in the same (multi-turn) session
      { traceSchema: "comis-trajectory", type: "session.summary", seq: 10, agentId: "default", traceId: "t-earlier", data: {} },
      // the terminal per-root TOKEN-limb abort (the live repro shape)
      {
        traceSchema: "comis-trajectory",
        type: "execution.aborted",
        seq: 20,
        agentId: "default",
        traceId: "t-abort",
        data: {
          reason: "spend_exceeded",
          perRootBudget: { limb: "tokens", spent: 139397, cap: 150000, unit: "tokens" },
        },
      },
    ];
    const signals = toIncidentSignals(records);
    // metadata WITHOUT a spend endReason (the hard abort skipped the clean rollup)
    const report = assembleIncidentReport(
      signals,
      makeMetadata({ sessionEnd: { type: "session_end" } }),
      null,
      SESSION_KEY,
      records.length,
    );
    // The per-root abort is surfaced, not swallowed as endReason:"unknown".
    expect(report.outcome.endReason).toBe("spend_exceeded");
    expect(report.perRootBudget).toEqual({ limb: "tokens", spent: 139397, cap: 150000, unit: "tokens" });
  });

  it("the spend-verdict names the tripped limb once endReason+perRootBudget are surfaced", () => {
    // The verdict reads s.endReason (threaded from report.outcome.endReason) + s.perRootBudget.
    // Once the assembler derives them from the abort record, the verdict names the limb.
    const verdict = spendExceededVerdict({
      ...makeSignals({ failures: [], toolStats: {}, hasMisclassificationSignal: false }),
      endReason: "spend_exceeded",
      perRootBudget: { limb: "tokens", spent: 139397, cap: 150000, unit: "tokens" },
    });
    expect(verdict?.code).toBe("spend_exceeded");
    expect(verdict?.detail).toContain("tokens");
    expect(verdict?.detail).toContain("autonomy.budget");
  });
});

// ---------------------------------------------------------------------------
// Self-grade visibility: a self-graded tool failure
// (the `{graded:true,outcome:"failure"}` envelope)
// sets classifiedFailureBy:"failure_detector" + matchedRule:"self_grade" and rides
// the trajectory tool.result record (translate-payload carries both). But the
// explain failure-fold dropped `matchedRule`, so `explain.failures` showed only
// "failure_detector" — an operator couldn't tell a clean DOMAIN task-failure
// (self_grade) from an error-token heuristic match or a transport error. Thread
// matchedRule onto explain.failures (mirrors matchedToken) so the self-grade is
// visible in one call (the per-session companion to the deferred funnel count).
// ---------------------------------------------------------------------------

describe("assembleIncidentReport — failure matchedRule (self_grade visibility)", () => {
  it("surfaces matchedRule on explain.failures so a self-graded task-failure is distinguishable", () => {
    const records: Array<Record<string, unknown>> = [
      {
        traceSchema: "comis-trajectory",
        type: "tool.result",
        seq: 5,
        agentId: "default",
        traceId: "t-self-grade",
        data: {
          toolName: "mcp__cs-sim--close_quarter",
          toolCallId: "call-1",
          success: false,
          transportOk: true, // the call returned cleanly; the DOMAIN graded it a failure
          classifiedFailureBy: "failure_detector",
          matchedRule: "self_grade", // the self-grade envelope drove the failure flip
          errorKind: "validation",
        },
      },
    ];
    const signals = toIncidentSignals(records);
    const report = assembleIncidentReport(signals, makeMetadata(), null, SESSION_KEY, records.length);
    const f = report.failures.find((x) => x.toolName === "mcp__cs-sim--close_quarter");
    expect(f?.classifiedFailureBy).toBe("failure_detector");
    expect(f?.matchedRule).toBe("self_grade");
  });
});

// ---------------------------------------------------------------------------
// timing.
// ---------------------------------------------------------------------------

describe("assembleIncidentReport — timing", () => {
  it("populates durationMs from the metadata rollup", () => {
    const report = assembleIncidentReport(
      makeSignals(),
      makeMetadata({ sessionEnd: { endReason: "completed_with_tool_errors", durationMs: 12_000 } }),
      null,
      SESSION_KEY,
      READ_COUNT,
    );
    expect(report.timing.durationMs).toBe(12_000);
  });

  it("reads durationMs from the metadata top level when there is no sessionEnd (real 678 shape)", () => {
    const report = assembleIncidentReport(
      makeSignals(),
      { sessionKey: SESSION_KEY, endReason: "completed_with_tool_errors", durationMs: 9_000 },
      null,
      SESSION_KEY,
      READ_COUNT,
    );
    expect(report.timing.durationMs).toBe(9_000);
  });

  it("derives turnCount from the signal ok+failed totals when metadata omits a turn count", () => {
    const report = assembleIncidentReport(
      makeSignals({ toolStats: { web_fetch: { ok: 2, failed: 8 } } }),
      makeMetadata({ sessionEnd: { endReason: "completed_with_tool_errors" } }),
      null,
      SESSION_KEY,
      READ_COUNT,
    );
    // 2 ok + 8 failed = 10 tool invocations → turnCount ≥ 1, deterministic.
    expect(report.timing.turnCount).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// toolStats merge.
// ---------------------------------------------------------------------------

describe("assembleIncidentReport — toolStats", () => {
  it("merges the signal per-tool counts with the rollup toolStats and keeps topErrorKind", () => {
    const report = assembleIncidentReport(
      makeSignals({ toolStats: { web_fetch: { ok: 2, failed: 8, topErrorKind: "dependency" } } }),
      makeMetadata(),
      null,
      SESSION_KEY,
      READ_COUNT,
    );
    expect(report.toolStats.web_fetch?.failed).toBe(8);
    expect(report.toolStats.web_fetch?.ok).toBe(2);
    expect(report.toolStats.web_fetch?.topErrorKind).toBe("dependency");
  });

  it("includes a rollup-only tool that never appears in the signal stats", () => {
    const report = assembleIncidentReport(
      makeSignals({ toolStats: { web_fetch: { ok: 2, failed: 8 } } }),
      makeMetadata({
        sessionEnd: {
          endReason: "completed_with_tool_errors",
          toolStats: { web_search: { ok: 1, failed: 0 } },
        },
      }),
      null,
      SESSION_KEY,
      READ_COUNT,
    );
    // Signal stats win on overlap, but a rollup-only tool is still surfaced.
    expect(report.toolStats.web_fetch?.failed).toBe(8);
    expect(report.toolStats.web_search?.ok).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// failures / breakerTimeline / offloads.
// ---------------------------------------------------------------------------

describe("assembleIncidentReport — failures/breaker/offloads", () => {
  it("orders failures newest-first by descending seq", () => {
    const report = assembleIncidentReport(
      makeSignals({
        failures: [makeFailure({ seq: 1 }), makeFailure({ seq: 5 }), makeFailure({ seq: 3 })],
      }),
      makeMetadata(),
      null,
      SESSION_KEY,
      READ_COUNT,
    );
    expect(report.failures.map((f) => f.seq)).toEqual([5, 3, 1]);
  });

  it("copies the breaker timeline from the signals verbatim", () => {
    const report = assembleIncidentReport(
      makeSignals({
        breakerEvents: [{ seq: 7, event: "opened", toolName: "web_fetch", consecutiveFailures: 5 }],
      }),
      makeMetadata(),
      null,
      SESSION_KEY,
      READ_COUNT,
    );
    expect(report.breakerTimeline).toEqual([
      { seq: 7, event: "opened", toolName: "web_fetch", consecutiveFailures: 5 },
    ]);
  });

  it("copies the offload pointers from the signals verbatim (already relativized)", () => {
    const report = assembleIncidentReport(
      makeSignals({
        offloads: [{ seq: 4, toolName: "web_fetch", originalChars: 53_095, pointer: "sessions/678.offload.json" }],
      }),
      makeMetadata(),
      null,
      SESSION_KEY,
      READ_COUNT,
    );
    expect(report.offloads[0]?.pointer).toBe("sessions/678.offload.json");
    expect(report.offloads[0]?.originalChars).toBe(53_095);
  });

  it("preserves the already-bounded errorPreview without re-inlining a raw body", () => {
    const report = assembleIncidentReport(
      makeSignals({ failures: [makeFailure({ seq: 1, errorPreview: "bounded preview ≤200" })] }),
      makeMetadata(),
      null,
      SESSION_KEY,
      READ_COUNT,
    );
    expect(report.failures[0]?.errorPreview).toBe("bounded preview ≤200");
  });
});

// ---------------------------------------------------------------------------
// identity / invariant fields.
// ---------------------------------------------------------------------------

describe("assembleIncidentReport — identity & invariants", () => {
  it("stamps schemaVersion 1 and echoes the sessionKey argument", () => {
    const report = assembleIncidentReport(makeSignals(), makeMetadata(), null, SESSION_KEY, READ_COUNT);
    expect(report.schemaVersion).toBe(1);
    expect(report.sessionKey).toBe(SESSION_KEY);
  });

  it("reads traceId / agentId / channel from the metadata", () => {
    const report = assembleIncidentReport(makeSignals(), makeMetadata(), null, SESSION_KEY, READ_COUNT);
    expect(report.traceId).toBe("f942d38c-0000-0000-0000-000000000000");
    expect(report.agentId).toBe("default");
    expect(report.channel).toEqual({ type: "peer", id: "678314278" });
  });

  it("defaults the ids/channel to empty strings when metadata is null (never throws)", () => {
    const report = assembleIncidentReport(makeSignals(), null, null, SESSION_KEY, READ_COUNT);
    expect(report.traceId).toBe("");
    expect(report.agentId).toBe("");
    expect(report.channel).toEqual({ type: "", id: "" });
  });

  it("leaves likelyRootCause null — the heuristics pass owns it", () => {
    const report = assembleIncidentReport(makeSignals(), makeMetadata(), null, SESSION_KEY, READ_COUNT);
    expect(report.likelyRootCause).toBeNull();
  });

  it("starts truncations and suggestedNextSteps empty — the bounding/heuristics passes own them", () => {
    const report = assembleIncidentReport(makeSignals(), makeMetadata(), null, SESSION_KEY, READ_COUNT);
    expect(report.truncations).toEqual([]);
    expect(report.suggestedNextSteps).toEqual([]);
  });

  it("emits a deterministic non-empty summary one-liner (no LLM)", () => {
    const report = assembleIncidentReport(
      makeSignals({ failures: [makeFailure({ seq: 1 }), makeFailure({ seq: 2 })] }),
      makeMetadata({ sessionEnd: { endReason: "completed_with_tool_errors" } }),
      null,
      SESSION_KEY,
      READ_COUNT,
    );
    expect(report.summary.length).toBeGreaterThan(0);
    expect(report.summary).toContain("completed_with_tool_errors");
  });

  it("falls back to the signals.sessionKey for traceId-less metadata and echoes the arg sessionKey", () => {
    const report = assembleIncidentReport(
      makeSignals({ sessionKey: "sig-session" }),
      makeMetadata({ traceId: undefined, secondTurnTraceId: "058db0fe-1111-1111-1111-111111111111" }),
      null,
      "arg-session",
      READ_COUNT,
    );
    // The arg sessionKey is authoritative for the echoed field.
    expect(report.sessionKey).toBe("arg-session");
    // traceId falls back to the second-turn traceId when the primary is absent.
    expect(report.traceId).toBe("058db0fe-1111-1111-1111-111111111111");
  });

  it("reads cacheReadRatio from the rollup when present, else 0", () => {
    const withRatio = assembleIncidentReport(
      makeSignals(),
      makeMetadata({ sessionEnd: { endReason: "success", cacheReadRatio: 0.42 } }),
      null,
      SESSION_KEY,
      READ_COUNT,
    );
    expect(withRatio.cost.cacheReadRatio).toBeCloseTo(0.42, 4);

    const withoutRatio = assembleIncidentReport(makeSignals(), makeMetadata(), null, SESSION_KEY, READ_COUNT);
    expect(withoutRatio.cost.cacheReadRatio).toBe(0);
  });

  it("reads cacheReadRatio from the metadata TOP LEVEL when there is no sessionEnd (flat 678-style shape)", () => {
    // Every other numeric rollup field (durationMs, totalTokens, …) reads from
    // the metadata top level as a fallback because the FROZEN 678 fixture is
    // flat (no nested sessionEnd). cacheReadRatio must do the same — pre-fix it
    // passed `undefined` for topAlias and silently dropped a top-level value,
    // mis-reporting 0 despite the data being present.
    const report = assembleIncidentReport(
      makeSignals(),
      {
        sessionKey: SESSION_KEY,
        endReason: "completed_with_tool_errors",
        cacheReadRatio: 0.73,
      },
      null,
      SESSION_KEY,
      READ_COUNT,
    );
    expect(report.cost.cacheReadRatio).toBeCloseTo(0.73, 4);
  });
});

// ---------------------------------------------------------------------------
// coverage — READ-coverage meta-observability (the silent-empty-report fix).
//
// DISTINCT from truncations[] (SIZE-drops): coverage records whether the INPUTS
// were read — did the assembler locate + read the trajectory, was the rollup
// present, did every offload pointer resolve. A degraded report
// (records:0 / pointersResolved<pointersTotal) becomes self-evident instead of
// masquerading as a clean zero-activity session.
// ---------------------------------------------------------------------------

describe("assembleIncidentReport — coverage (READ-coverage)", () => {
  it("populates coverage.trajectory.records from the read count and found from records>0", () => {
    const report = assembleIncidentReport(
      makeSignals({ failures: [makeFailure({ seq: 1 })] }),
      makeMetadata(),
      null,
      SESSION_KEY,
      2,
    );
    expect(report.coverage).toBeDefined();
    expect(report.coverage!.trajectory.found).toBe(true);
    expect(report.coverage!.trajectory.records).toBe(2);
  });

  it("reports coverage.trajectory.found=false and records=0 for an empty read (silent-empty made loud)", () => {
    // recordCount 0 + empty signals + metadata null = the silent-empty case: a
    // report that on pre-fix code looked like a confident clean session. coverage
    // now makes the read-failure self-evident.
    const report = assembleIncidentReport(
      makeSignals({ failures: [], toolStats: {}, offloads: [], breakerEvents: [] }),
      null,
      null,
      SESSION_KEY,
      0,
    );
    expect(report.coverage!.trajectory.found).toBe(false);
    expect(report.coverage!.trajectory.records).toBe(0);
    expect(report.coverage!.rollup.present).toBe(false);
  });

  it("sets coverage.rollup.present=true when the F1 metadata sessionEnd rollup is present", () => {
    const report = assembleIncidentReport(
      makeSignals(),
      makeMetadata({ sessionEnd: { endReason: "completed_with_tool_errors" } }),
      null,
      SESSION_KEY,
      3,
    );
    expect(report.coverage!.rollup.present).toBe(true);
  });

  it("counts coverage.offloads.pointersResolved as pointers !== '<offloaded>' and pointersTotal as all offloads", () => {
    const report = assembleIncidentReport(
      makeSignals({
        offloads: [
          { seq: 1, toolName: "web_fetch", originalChars: 1, pointer: "tool-results/x.json" },
          { seq: 2, toolName: "web_fetch", originalChars: 1, pointer: "<offloaded>" },
        ],
      }),
      makeMetadata(),
      null,
      SESSION_KEY,
      2,
    );
    expect(report.coverage!.offloads.pointersResolved).toBe(1);
    expect(report.coverage!.offloads.pointersTotal).toBe(2);
  });

  it("surfaces coverage.sources — session=VALUES path, trajectory=PROVENANCE path — when the caller resolved real artifacts", () => {
    // The numeric/value-reconciliation pointer: a reported figure is reconciled against
    // the raw session `.jsonl` (VALUES), not the provenance-only `.trajectory.jsonl`.
    const sessionPath = "/data/workspace/sessions/default/678314278/678314278~peer~678314278.jsonl";
    const report = assembleIncidentReport(makeSignals(), makeMetadata(), null, SESSION_KEY, 2, [], sessionPath);
    expect(report.coverage!.sources).toEqual({
      session: sessionPath,
      trajectory: `${sessionPath}.trajectory.jsonl`,
    });
  });

  it("omits coverage.sources when no path was resolved (a genuine miss / a fixture reader over a non-real dataDir)", () => {
    const report = assembleIncidentReport(makeSignals(), makeMetadata(), null, SESSION_KEY, 2);
    expect(report.coverage!.sources).toBeUndefined();
  });

  it("preserves coverage unchanged through boundIncidentReport at BOTH summary and full depth", () => {
    // coverage is a fixed 4-int + 2-bool object far below every cap and is NOT a
    // REPORT_ARRAY_FIELD, so the bounding pass passes it through untouched. Pin
    // it at both depths so a future cap change cannot silently drop it.
    const report = assembleIncidentReport(
      makeSignals({
        offloads: [
          { seq: 1, toolName: "web_fetch", originalChars: 1, pointer: "tool-results/x.json" },
          { seq: 2, toolName: "web_fetch", originalChars: 1, pointer: "<offloaded>" },
        ],
      }),
      makeMetadata(),
      null,
      SESSION_KEY,
      5,
    );
    const summary = boundIncidentReport(report, "summary");
    const full = boundIncidentReport(report, "full");
    expect(summary.coverage).toBeDefined();
    expect(full.coverage).toBeDefined();
    expect(summary.coverage).toEqual(report.coverage);
    expect(full.coverage).toEqual(report.coverage);
  });
});

// ---------------------------------------------------------------------------
// The report carries the signals contextBudget.
// ---------------------------------------------------------------------------

describe("assembleIncidentReport — contextBudget threading", () => {
  it("carries signals.contextBudget into the report verbatim", () => {
    const contextBudget = {
      windowTokens: 32_000,
      rawContextWindowTokens: 131_072,
      windowCapSource: "effectiveContextCapSmall" as const,
      systemTokens: 25_694,
      freshTailTokens: 5_272,
      budgetedHistoryTokens: 0,
      keptCount: 0,
      assembledInputTokens: 31_572,
      outputHeadroom: 768,
      verdict: "exhausted" as const,
    };
    const report = assembleIncidentReport(
      makeSignals({ contextBudget }),
      makeMetadata({ sessionEnd: { endReason: "context_exhausted" } }),
      null,
      SESSION_KEY,
      READ_COUNT,
    );
    expect(report.contextBudget).toEqual(contextBudget);
  });

  it("omits contextBudget when the signals carry none (no context.budget record)", () => {
    const report = assembleIncidentReport(makeSignals(), makeMetadata(), null, SESSION_KEY, READ_COUNT);
    expect(report.contextBudget).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// The report falls back to signals-derived
// agentId/channel when the metadata rollup lacks them (the live rollup carries
// neither — without the fallback the report prints empty strings for a real session).
// ---------------------------------------------------------------------------

describe("assembleIncidentReport — agentId/channel fallback", () => {
  it("falls back to signals agentId and channel when the metadata rollup lacks them", () => {
    const report = assembleIncidentReport(
      makeSignals({ agentId: "default", channel: { type: "telegram", id: "678314278" } }),
      // The LIVE rollup shape carries neither agentId nor channel — strip the
      // fixture's convenience fields to reproduce it.
      makeMetadata({ agentId: undefined, channel: undefined }),
      null,
      SESSION_KEY,
      READ_COUNT,
    );
    expect(report.agentId).toBe("default");
    expect(report.channel).toEqual({ type: "telegram", id: "678314278" });
  });

  it("metadata agentId still wins over the signals fallback when present", () => {
    const report = assembleIncidentReport(
      makeSignals({ agentId: "from-signals" }),
      makeMetadata({ agentId: "from-metadata" }),
      null,
      SESSION_KEY,
      READ_COUNT,
    );
    expect(report.agentId).toBe("from-metadata");
  });
});

describe("assembleIncidentReport — recall section", () => {
  it("surfaces signals.recall on the report (counts/booleans only — no bodies)", () => {
    const report = assembleIncidentReport(
      makeSignals({
        recall: { recalls: 3, zeroHits: 2, lastLanes: 4, lastFinalCount: 0, rerankerAvailable: true },
      }),
      makeMetadata(),
      null,
      SESSION_KEY,
      READ_COUNT,
    );
    expect(report.recall).toEqual({
      recalls: 3,
      zeroHits: 2,
      lastLanes: 4,
      lastFinalCount: 0,
      rerankerAvailable: true,
    });
  });

  it("omits the recall section when the signals carry no recall data (no-recall session)", () => {
    const report = assembleIncidentReport(makeSignals(), makeMetadata(), null, SESSION_KEY, READ_COUNT);
    expect(report.recall).toBeUndefined();
  });
});

describe("assembleIncidentReport — learning section", () => {
  it("surfaces signals.learning on the report (counts/ids/closed-enums only — no bodies)", () => {
    const report = assembleIncidentReport(
      makeSignals({
        learning: {
          outcomeResolved: false,
          outcome: "unknown",
          sources: ["tool", "pipeline"],
          skillsUsed: [],
          skillFailures: [],
          synthesisAbstained: false,
        },
      }),
      makeMetadata(),
      null,
      SESSION_KEY,
      READ_COUNT,
    );
    expect(report.learning).toEqual({
      outcomeResolved: false,
      outcome: "unknown",
      sources: ["tool", "pipeline"],
      skillsUsed: [],
      skillFailures: [],
      synthesisAbstained: false,
    });
  });

  it("omits the learning section when the signals carry no learning data (default-off / no-outcome session)", () => {
    const report = assembleIncidentReport(makeSignals(), makeMetadata(), null, SESSION_KEY, READ_COUNT);
    expect(report.learning).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// The cacheBreaks? section — folded per-reason from the
// session's `cache.break` trajectory records, content-free + bounded.
// ---------------------------------------------------------------------------

/** A `cache.break` trajectory record envelope (post-translate-payload shape). */
function cacheBreakRecord(
  data: { reason: string; tokenDrop?: number; estCostUsd?: number },
  seq: number,
): Record<string, unknown> {
  return {
    traceSchema: "comis-trajectory",
    type: "cache.break",
    seq,
    data: {
      reason: data.reason,
      tokenDrop: data.tokenDrop ?? 0,
      tokenDropRelative: 0.5,
      estCostUsd: data.estCostUsd ?? 0,
      changedDimsDigest: { added: 1, removed: 0, schemaChanged: 0, systemCharDelta: 10 },
    },
  };
}

describe("assembleIncidentReport — failed tool-call argsPreview", () => {
  // The failing tool's INPUT is what an operator needs ("what did the edit try
  // to change?"). Previously recoverable only from a raw memory.db dive; now
  // the bounded+redacted argsPreview rides the tool.result record onto the
  // failure so `comis explain` answers it in one call.
  it("surfaces the bounded argsPreview of a failed tool call on failures[]", () => {
    const signals = toIncidentSignals([
      {
        traceSchema: "comis-trajectory",
        type: "tool.result",
        seq: 1,
        sessionKey: SESSION_KEY,
        data: {
          toolName: "edit",
          toolCallId: "tc-e",
          success: false,
          errorKind: "validation",
          errorMessage: "[text_not_found] Could not find edits[1] in IDENTITY.md.",
          argsPreview: { path: "IDENTITY.md", edits: "[244 chars]" },
        },
      },
    ]);
    const report = assembleIncidentReport(signals, makeMetadata(), null, SESSION_KEY, 1);
    const f = report.failures.find((x) => x.toolName === "edit");
    expect(f).toBeDefined();
    expect(f!.argsPreview).toEqual({ path: "IDENTITY.md", edits: "[244 chars]" });
  });

  it("omits argsPreview when the failure record carries none (backward-safe)", () => {
    const signals = toIncidentSignals([
      { traceSchema: "comis-trajectory", type: "tool.result", seq: 1, sessionKey: SESSION_KEY, data: { toolName: "web_fetch", success: false, errorKind: "dependency" } },
    ]);
    const report = assembleIncidentReport(signals, makeMetadata(), null, SESSION_KEY, 1);
    expect(report.failures.find((x) => x.toolName === "web_fetch")!.argsPreview).toBeUndefined();
  });
});

describe("assembleIncidentReport — recovery attempts", () => {
  // The strip-and-re-enter / LKW-fallback / continuation-nudge recovery paths
  // mutate a run (re-prompt, model swap) and were log-only — explain couldn't
  // say a session re-entered the model. Fold the execution.recovery_attempted
  // records into a recoveries section (counts by reason + succeeded tally).
  it("folds recovery attempts by reason with a succeeded count", () => {
    const signals = toIncidentSignals([
      { traceSchema: "comis-trajectory", type: "execution.recovery_attempted", seq: 1, sessionKey: SESSION_KEY, data: { reason: "silent_retry", succeeded: false } },
      { traceSchema: "comis-trajectory", type: "execution.recovery_attempted", seq: 2, sessionKey: SESSION_KEY, data: { reason: "silent_retry", succeeded: true } },
      { traceSchema: "comis-trajectory", type: "execution.recovery_attempted", seq: 3, sessionKey: SESSION_KEY, data: { reason: "lkw_fallback", succeeded: true } },
    ]);
    const report = assembleIncidentReport(signals, makeMetadata(), null, SESSION_KEY, 3);
    expect(report.recoveries).toEqual({
      total: 3,
      succeeded: 2,
      byReason: { silent_retry: 2, lkw_fallback: 1 },
    });
  });

  it("omits recoveries when the trajectory carries none", () => {
    const report = assembleIncidentReport(toIncidentSignals([]), makeMetadata(), null, SESSION_KEY, 0);
    expect(report.recoveries).toBeUndefined();
  });
});

describe("assembleIncidentReport — user surface (activity finalize + skipped delivery)", () => {
  // "What did the user actually see this turn?" — the terminal pill state and
  // any never-sent blocks. Observed live: explain claimed 2 dispatched
  // deliveries while the user's chat showed a stale ❌ pill and two turns of
  // silence; only a screenshot could establish the surface.
  it("surfaces the finalize outcome and skipped-delivery counts from the trajectory records", () => {
    const signals = toIncidentSignals([
      {
        traceSchema: "comis-trajectory",
        type: "delivery.aborted",
        seq: 1,
        sessionKey: SESSION_KEY,
        data: { reason: "spend_exceeded", chunksDelivered: 0, totalChunks: 2, channelType: "telegram" },
      },
      {
        traceSchema: "comis-trajectory",
        type: "activity.turn_finalized",
        seq: 2,
        sessionKey: SESSION_KEY,
        data: { strategy: "EditPlace", outcome: "failure", errorKind: "resource", reason: "stopped — spend limit reached", reclassified: false, failedEventCount: 1 },
      },
    ]);
    const report = assembleIncidentReport(signals, makeMetadata(), null, SESSION_KEY, 2);
    expect(report.activityFinalize).toEqual({
      strategy: "EditPlace",
      outcome: "failure",
      errorKind: "resource",
      reason: "stopped — spend limit reached",
      reclassified: false,
      failedTurnCount: 1,
      recoveredTurnCount: 0,
    });
    expect(report.deliverySkipped).toEqual({ events: 1, chunksNotSent: 2 });
  });

  it("tallies mid-session failure paints so a later success finalize cannot hide the pill turn (session-wide counts)", () => {
    // Live investigation friction: the last-wins activityFinalize showed the
    // final turn's success while turn 2's kept failure pill was findable only
    // by reading the raw trajectory.
    const signals = toIncidentSignals([
      {
        traceSchema: "comis-trajectory",
        type: "activity.turn_finalized",
        seq: 1,
        sessionKey: SESSION_KEY,
        data: { strategy: "EditPlace", outcome: "failure", errorKind: "validation", reclassified: false, failedEventCount: 2 },
      },
      {
        traceSchema: "comis-trajectory",
        type: "activity.turn_finalized",
        seq: 2,
        sessionKey: SESSION_KEY,
        data: { strategy: "EditPlace", outcome: "success_with_recovered_failures", reclassified: true, failedEventCount: 1 },
      },
      {
        traceSchema: "comis-trajectory",
        type: "activity.turn_finalized",
        seq: 3,
        sessionKey: SESSION_KEY,
        data: { strategy: "EditPlace", outcome: "success", reclassified: false, failedEventCount: 0 },
      },
    ]);
    const report = assembleIncidentReport(signals, makeMetadata(), null, SESSION_KEY, 3);
    // Last-wins snapshot is the final success…
    expect(report.activityFinalize?.outcome).toBe("success");
    // …but the session-wide tally still names the failure + recovered paints.
    expect(report.activityFinalize?.failedTurnCount).toBe(1);
    expect(report.activityFinalize?.recoveredTurnCount).toBe(1);
  });

  it("omits both sections when the trajectory carries no such records (undefined, never empty objects)", () => {
    const signals = toIncidentSignals([]);
    const report = assembleIncidentReport(signals, makeMetadata(), null, SESSION_KEY, 0);
    expect(report.activityFinalize).toBeUndefined();
    expect(report.deliverySkipped).toBeUndefined();
  });
});

describe("assembleIncidentReport — degraded-recall visibility (memory.recall_degraded)", () => {
  // Live incident: recall failed on EVERY turn for hours (vec dimension
  // mismatch) and `explain` showed nothing — the failure lived only in
  // daemon.log WARNs. The recall section must answer "did this session run
  // without memory?" from the report alone.
  it("folds recall_degraded records into the recall section even when NO successful recall ever ran (degraded-only session)", () => {
    const signals = toIncidentSignals([
      {
        traceSchema: "comis-trajectory",
        type: "memory.recall_degraded",
        seq: 1,
        sessionKey: SESSION_KEY,
        data: { scope: "lanes", errorKind: "internal" },
      },
      {
        traceSchema: "comis-trajectory",
        type: "memory.recall_degraded",
        seq: 2,
        sessionKey: SESSION_KEY,
        data: { scope: "vector_lane", errorKind: "config" },
      },
    ]);
    const report = assembleIncidentReport(signals, makeMetadata(), null, SESSION_KEY, 2);
    expect(report.recall).toEqual({
      recalls: 0,
      zeroHits: 0,
      lastLanes: 0,
      lastFinalCount: 0,
      rerankerAvailable: false,
      degraded: 2,
      lastDegradedScope: "vector_lane",
      lastDegradedErrorKind: "config",
    });
  });

  it("keeps the recall section absent when the session has neither recalls nor degradations", () => {
    const signals = toIncidentSignals([]);
    const report = assembleIncidentReport(signals, makeMetadata(), null, SESSION_KEY, 0);
    expect(report.recall).toBeUndefined();
  });
});

describe("assembleIncidentReport — trajectory-derived cost/cache ledger", () => {
  // A session's sessionEnd rollup is overwritten by EVERY execution, so its
  // costUsd is the LAST execution's cost only — observed live as a ~$0.50
  // session explained at $0.03. The trajectory carries the honest ledger: one
  // session.summary record per execution (costUsd each) and one
  // model.completed record per LLM call (token + cache fields). The assembler
  // must prefer those sums; the rollup stays the fallback for log-only sessions.

  const modelCompletedRecord = (
    data: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreationTokens?: number },
    seq: number,
  ): Record<string, unknown> => ({
    traceSchema: "comis-trajectory",
    type: "model.completed",
    seq,
    sessionKey: SESSION_KEY,
    data: { cacheCreationTokens: 0, ...data },
  });

  const sessionSummaryRecord = (costUsd: number, seq: number): Record<string, unknown> => ({
    traceSchema: "comis-trajectory",
    type: "session.summary",
    seq,
    sessionKey: SESSION_KEY,
    data: { degraded: false, turnCount: 1, costUsd, toolStats: {}, breakerTripCount: 0 },
  });

  it("sums the per-execution session.summary costs instead of trusting the last-write rollup costUsd", () => {
    const signals = toIncidentSignals([
      sessionSummaryRecord(0.13086, 1),
      sessionSummaryRecord(0.071879, 2),
      sessionSummaryRecord(0.265657, 3),
      sessionSummaryRecord(0.02994, 4),
    ]);
    const report = assembleIncidentReport(
      signals,
      // The rollup carries only the FINAL execution's cost (the live shape).
      makeMetadata({ sessionEnd: { endReason: "spend_exceeded", costUsd: 0.02994, totalTokens: 296_675 } }),
      null,
      SESSION_KEY,
      4,
    );
    expect(report.cost.costUsd).toBeCloseTo(0.498336, 4);
  });

  it("derives cacheReadRatio and totalTokens from the model.completed token ledger (the rollup never carries cacheReadRatio)", () => {
    const signals = toIncidentSignals([
      modelCompletedRecord({ inputTokens: 25_926, outputTokens: 41, cacheReadTokens: 0 }, 1),
      modelCompletedRecord({ inputTokens: 893, outputTokens: 120, cacheReadTokens: 25_600 }, 2),
      modelCompletedRecord({ inputTokens: 1_344, outputTokens: 75, cacheReadTokens: 27_136 }, 3),
    ]);
    const report = assembleIncidentReport(
      signals,
      makeMetadata({ sessionEnd: { endReason: "success", costUsd: 0.1, totalTokens: 1 } }),
      null,
      SESSION_KEY,
      3,
    );
    // cacheRead / (input + cacheRead) across the session's completions.
    const input = 25_926 + 893 + 1_344;
    const cacheRead = 25_600 + 27_136;
    expect(report.cost.cacheReadRatio).toBeCloseTo(cacheRead / (input + cacheRead), 4);
    // totalTokens = input + output + cacheRead + cacheCreation (the ledger sum),
    // preferred over the rollup's stale value.
    expect(report.cost.totalTokens).toBe(input + (41 + 120 + 75) + cacheRead);
  });

  it("sums timing.turnCount from the per-execution session.summary ledger (not the last-write rollup)", () => {
    // The sessionEnd rollup's turnCount is overwritten per execution, so a
    // multi-execution session reported the LAST execution's turn count — the
    // incident's 11-turn session showed timing.turnCount:1. Sum the ledger.
    const signals = toIncidentSignals([
      { traceSchema: "comis-trajectory", type: "session.summary", seq: 1, sessionKey: SESSION_KEY, data: { degraded: false, turnCount: 1, costUsd: 0.1, toolStats: {}, breakerTripCount: 0 } },
      { traceSchema: "comis-trajectory", type: "session.summary", seq: 2, sessionKey: SESSION_KEY, data: { degraded: false, turnCount: 3, costUsd: 0.1, toolStats: {}, breakerTripCount: 0 } },
      { traceSchema: "comis-trajectory", type: "session.summary", seq: 3, sessionKey: SESSION_KEY, data: { degraded: true, turnCount: 6, costUsd: 0.1, toolStats: {}, breakerTripCount: 0 } },
      { traceSchema: "comis-trajectory", type: "session.summary", seq: 4, sessionKey: SESSION_KEY, data: { degraded: true, turnCount: 1, costUsd: 0.1, toolStats: {}, breakerTripCount: 0 } },
    ]);
    const report = assembleIncidentReport(
      signals,
      // The rollup carries only the final execution's turnCount (last write).
      makeMetadata({ sessionEnd: { endReason: "spend_exceeded", costUsd: 0.1, totalTokens: 1, turnCount: 1 } }),
      null,
      SESSION_KEY,
      4,
    );
    expect(report.timing.turnCount).toBe(11);
  });

  it("keeps the rollup fallback for log-only sessions (no trajectory records)", () => {
    const report = assembleIncidentReport(
      makeSignals(),
      makeMetadata({ sessionEnd: { endReason: "success", costUsd: 0.25, totalTokens: 42_000 } }),
      null,
      SESSION_KEY,
      0,
    );
    expect(report.cost.costUsd).toBeCloseTo(0.25, 4);
    expect(report.cost.totalTokens).toBe(42_000);
    expect(report.cost.cacheReadRatio).toBe(0);
  });
});

describe("assembleIncidentReport — cacheBreaks?", () => {
  it("surfaces cacheBreaks folded per-reason from cache.break trajectory records", () => {
    const signals = toIncidentSignals([
      cacheBreakRecord({ reason: "system_changed", estCostUsd: 0.004 }, 1),
      cacheBreakRecord({ reason: "system_changed", estCostUsd: 0.006 }, 2),
      cacheBreakRecord({ reason: "tools_changed", estCostUsd: 0 }, 3),
    ]);
    const report = assembleIncidentReport(signals, makeMetadata(), null, SESSION_KEY, 3);
    expect(report.cacheBreaks).toBeDefined();
    // count desc, then reason asc (deterministic) → system_changed (2) before tools_changed (1).
    expect(report.cacheBreaks).toEqual([
      { reason: "system_changed", count: 2, estCostUsd: 0.01 },
      { reason: "tools_changed", count: 1, estCostUsd: 0 },
    ]);
  });

  it("OMITS cacheBreaks entirely when the trajectory carries no cache.break records (undefined, not [])", () => {
    const signals = toIncidentSignals([]);
    const report = assembleIncidentReport(signals, makeMetadata(), null, SESSION_KEY, 0);
    expect(report.cacheBreaks).toBeUndefined();
  });

  it("never carries the changed tool NAMES — only counts + reason + est-$ (content-free)", () => {
    const signals = toIncidentSignals([cacheBreakRecord({ reason: "tools_changed", estCostUsd: 0.02 }, 1)]);
    const report = assembleIncidentReport(signals, makeMetadata(), null, SESSION_KEY, 1);
    const serialized = JSON.stringify(report.cacheBreaks);
    expect(serialized).not.toMatch(/toolsAdded|toolsRemoved|changedDimsDigest|secret/);
    expect(report.cacheBreaks?.[0]).toEqual({ reason: "tools_changed", count: 1, estCostUsd: 0.02 });
  });

  it("caps cacheBreaks at summary depth + records a truncations[] breadcrumb (bounded output)", () => {
    // 12 distinct reasons > SUMMARY_MAX_CACHE_BREAKS (10) → the bound pass sheds the tail.
    const records = Array.from({ length: 12 }, (_, i) =>
      cacheBreakRecord({ reason: `reason_${String(i).padStart(2, "0")}`, estCostUsd: 0.001 }, i + 1),
    );
    const signals = toIncidentSignals(records);
    const report = assembleIncidentReport(signals, makeMetadata(), null, SESSION_KEY, 12);
    const bounded = boundIncidentReport(report, "summary");
    expect(bounded.cacheBreaks!.length).toBeLessThanOrEqual(10);
    expect(bounded.truncations.some((t) => t.field === "cacheBreaks")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The audit? section — counts-by-kind from the session's
// obs_audit_events (persisted via SQLite, NOT a trajectory record), read
// through the IncidentSourceReader's readAuditEvents + filtered to the resolved
// traceId, content-free.
// ---------------------------------------------------------------------------

const TRACE_ID = "f942d38c-0000-0000-0000-000000000000";

/** A fixture reader: no trajectory/cache/metadata, the given audit rows. */
function makeAuditReader(auditRows: Array<Record<string, unknown>>): IncidentSourceReader {
  return {
    async readSessionRecords() {
      return [];
    },
    async readCacheTraceRecords() {
      return [];
    },
    async readSessionMetadata() {
      // Supply the traceId so the resolved report carries it (the audit filter key).
      return { sessionKey: SESSION_KEY, traceId: TRACE_ID, agentId: "default", channel: { type: "peer", id: "u" } };
    },
    async readDiagnosticsRollup() {
      return null;
    },
    async readAuditEvents() {
      return auditRows;
    },
  };
}

/** A content-free audit row (the obs_audit_events shape) for a given traceId/kind. */
function auditRow(kind: string, traceId: string | null, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: `a-${kind}-${Math.random().toString(36).slice(2)}`,
    tenantId: "default",
    agentId: "default",
    ts: 1000,
    kind,
    classification: null,
    action: null,
    actor: null,
    outcome: "success",
    severity: "info",
    traceId,
    refs: null,
    ...extra,
  };
}

describe("assembleIncidentReportFromSources — audit?", () => {
  it("populates audit { total, byKind } from the session's audit events scoped to the resolved traceId", async () => {
    const reader = makeAuditReader([
      auditRow("secret_access", TRACE_ID),
      auditRow("secret_access", TRACE_ID),
      auditRow("injection_detected", TRACE_ID),
      // A row from a DIFFERENT session's trace must NOT be counted.
      auditRow("command_blocked", "other-trace-id"),
    ]);
    const report = await assembleIncidentReportFromSources(reader, "/fake/.comis", {
      sessionKey: SESSION_KEY,
      depth: "summary",
    });
    expect(report.audit).toBeDefined();
    expect(report.audit).toEqual({ total: 3, byKind: { secret_access: 2, injection_detected: 1 } });
  });

  it("OMITS audit when the session produced no audit events (undefined, not {})", async () => {
    const reader = makeAuditReader([auditRow("secret_access", "some-other-session")]);
    const report = await assembleIncidentReportFromSources(reader, "/fake/.comis", {
      sessionKey: SESSION_KEY,
      depth: "summary",
    });
    expect(report.audit).toBeUndefined();
  });

  it("is content-free — a planted value field on a row never reaches the audit? section", async () => {
    const reader = makeAuditReader([auditRow("secret_access", TRACE_ID, { value: "sk-leaked" })]);
    const report = await assembleIncidentReportFromSources(reader, "/fake/.comis", {
      sessionKey: SESSION_KEY,
      depth: "summary",
    });
    const serialized = JSON.stringify(report.audit);
    expect(serialized).not.toContain("sk-leaked");
    expect(serialized).not.toMatch(/"value"|"secret"|"refs"/);
    expect(report.audit).toEqual({ total: 1, byKind: { secret_access: 1 } });
  });

  it("OMITS audit when the reader has no readAuditEvents method (audit-less fixture readers unaffected)", async () => {
    const legacyReader: IncidentSourceReader = {
      async readSessionRecords() {
        return [];
      },
      async readCacheTraceRecords() {
        return [];
      },
      async readSessionMetadata() {
        return { sessionKey: SESSION_KEY, traceId: TRACE_ID };
      },
      async readDiagnosticsRollup() {
        return null;
      },
    };
    const report = await assembleIncidentReportFromSources(legacyReader, "/fake/.comis", {
      sessionKey: SESSION_KEY,
      depth: "summary",
    });
    expect(report.audit).toBeUndefined();
  });
});
