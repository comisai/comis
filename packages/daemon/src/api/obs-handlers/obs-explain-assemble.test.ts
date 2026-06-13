// SPDX-License-Identifier: Apache-2.0
/**
 * RED → GREEN for the pure `assembleIncidentReport` (Plan 03, Wave 3).
 *
 * `assembleIncidentReport(signals, metadata, rollup, sessionKey, recordCount)`
 * merges the normalized {@link IncidentSignals} (Plan 02) + the F1
 * `_session-metadata.json` rollup (PRIMARY, per OQ3) + the F2 `obs_diagnostics`
 * rollup row (FALLBACK) into a §6.3 {@link IncidentReport} — a PURE function
 * with no I/O and no LLM. `recordCount` is the number of trajectory records the
 * reader READ (the meta-observability signal behind `coverage.trajectory`).
 *
 * These tests pin the contract per field group BEFORE the module exists:
 *   - **cost** comes from the F1 metadata rollup (`sessionEnd.costUsd`) with a
 *     fallback chain: `sessionEnd.costUsd` → top-level `sessionCostUsd` →
 *     F2 `rollup.costUsd` → `0`. For the 678 fixture this is `1.320669`.
 *   - **outcome.degraded** is `rollup.degraded ?? (endReason ∈ DEGRADED_SET)`;
 *     **severity** is `"failed"` for a hard-failure endReason, else `"degraded"`
 *     when degraded, else `"ok"`.
 *   - **toolStats** merges the signal per-tool counts with the rollup toolStats;
 *     **failures[]** is newest-first (seq descending); **breakerTimeline[]** /
 *     **offloads[]** are copied straight from the signals.
 *   - **likelyRootCause** stays `null` (Plan 05 owns it); **truncations** is `[]`
 *     (Plan 04 owns it); **schemaVersion** is `1`; ids echo from metadata/signals
 *     and NEVER throw on absent fields.
 *
 * The assembler copies the ALREADY-bounded `errorPreview` (≤200, redacted by
 * Plan 02) and the ALREADY-relativized offload pointers — it introduces no raw
 * body (threat T-153-08).
 *
 * @module
 */

import { describe, it, expect } from "vitest";
import type { IncidentFailure, IncidentSignals } from "@comis/core";
import { assembleIncidentReport } from "./obs-explain-assemble.js";
import { boundIncidentReport } from "./obs-explain-bound.js";

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
    hasDoNotRetrySignal: false,
    repeatedFailureCount: { web_fetch: 8 },
    hasMisclassificationSignal: true,
    misclassifiedTool: "web_fetch",
    misclassifiedToken: "status",
    ...overrides,
  };
}

/**
 * Build an F1 metadata object. `sessionEnd` is the nested Phase-152 rollup;
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
// cost — the F1-primary fallback chain (the X3 1.320669 invariant).
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
// outcome — degraded / severity derivation (design D5).
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

  it("leaves likelyRootCause null — Plan 05 owns it", () => {
    const report = assembleIncidentReport(makeSignals(), makeMetadata(), null, SESSION_KEY, READ_COUNT);
    expect(report.likelyRootCause).toBeNull();
  });

  it("starts truncations and suggestedNextSteps empty — Plan 04/05 own them", () => {
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

  it("reads cacheReadRatio from the metadata TOP LEVEL when there is no sessionEnd (flat 678-style shape) — WR-02", () => {
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

  it("preserves coverage unchanged through boundIncidentReport at BOTH summary and full depth (STEP D)", () => {
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
// W3 (obs-llm-troubleshooting): the report carries the signals contextBudget.
// ---------------------------------------------------------------------------

describe("assembleIncidentReport — contextBudget threading (W3)", () => {
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

  it("omits contextBudget when the signals carry none (pre-W2 session)", () => {
    const report = assembleIncidentReport(makeSignals(), makeMetadata(), null, SESSION_KEY, READ_COUNT);
    expect(report.contextBudget).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// W8 (obs-llm-troubleshooting): the report falls back to signals-derived
// agentId/channel when the metadata rollup lacks them (the live rollup carries
// neither — the report printed empty strings for a real session).
// ---------------------------------------------------------------------------

describe("assembleIncidentReport — agentId/channel fallback (W8)", () => {
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

describe("assembleIncidentReport — RECALL-01 recall section", () => {
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

  it("omits the recall section when the signals carry no recall data (pre-RECALL-01 / no-recall session)", () => {
    const report = assembleIncidentReport(makeSignals(), makeMetadata(), null, SESSION_KEY, READ_COUNT);
    expect(report.recall).toBeUndefined();
  });
});
