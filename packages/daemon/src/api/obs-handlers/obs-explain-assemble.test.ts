// SPDX-License-Identifier: Apache-2.0
/**
 * RED → GREEN for the pure `assembleIncidentReport` (Plan 03, Wave 3).
 *
 * `assembleIncidentReport(signals, metadata, rollup, sessionKey)` merges the
 * normalized {@link IncidentSignals} (Plan 02) + the F1 `_session-metadata.json`
 * rollup (PRIMARY, per OQ3) + the F2 `obs_diagnostics` rollup row (FALLBACK)
 * into a §6.3 {@link IncidentReport} — a PURE function with no I/O and no LLM.
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

// ---------------------------------------------------------------------------
// Local factories — synthetic signals/metadata (NO real session data, NO disk).
// ---------------------------------------------------------------------------

const SESSION_KEY = "default:678314278:678314278:peer:678314278";

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
    );
    expect(report.cost.costUsd).toBeCloseTo(1.320669, 4);
  });

  it("falls back to the F2 diagnostics rollup costUsd when both metadata sources are absent", () => {
    const report = assembleIncidentReport(
      makeSignals(),
      makeMetadata({ sessionCostUsd: undefined, sessionEnd: { endReason: "completed_with_tool_errors" } }),
      { costUsd: 0.5 },
      SESSION_KEY,
    );
    expect(report.cost.costUsd).toBe(0.5);
  });

  it("falls back to 0 when every cost source is absent", () => {
    const report = assembleIncidentReport(
      makeSignals(),
      makeMetadata({ sessionCostUsd: undefined, sessionEnd: { endReason: "success" } }),
      null,
      SESSION_KEY,
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
    );
    expect(report.cost.costUsd).toBe(0.75);
  });

  it("never throws and yields a 0 cost when metadata is null and rollup is null", () => {
    const report = assembleIncidentReport(makeSignals(), null, null, SESSION_KEY);
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
    );
    expect(report.outcome.severity).toBe("failed");
  });

  it("derives degraded from the F2 rollup degraded flag when metadata lacks it", () => {
    const report = assembleIncidentReport(
      makeSignals(),
      makeMetadata({ sessionEnd: { endReason: "success" } }),
      { degraded: true },
      SESSION_KEY,
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
    );
    expect(report.timing.durationMs).toBe(12_000);
  });

  it("reads durationMs from the metadata top level when there is no sessionEnd (real 678 shape)", () => {
    const report = assembleIncidentReport(
      makeSignals(),
      { sessionKey: SESSION_KEY, endReason: "completed_with_tool_errors", durationMs: 9_000 },
      null,
      SESSION_KEY,
    );
    expect(report.timing.durationMs).toBe(9_000);
  });

  it("derives turnCount from the signal ok+failed totals when metadata omits a turn count", () => {
    const report = assembleIncidentReport(
      makeSignals({ toolStats: { web_fetch: { ok: 2, failed: 8 } } }),
      makeMetadata({ sessionEnd: { endReason: "completed_with_tool_errors" } }),
      null,
      SESSION_KEY,
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
    );
    expect(report.failures[0]?.errorPreview).toBe("bounded preview ≤200");
  });
});

// ---------------------------------------------------------------------------
// identity / invariant fields.
// ---------------------------------------------------------------------------

describe("assembleIncidentReport — identity & invariants", () => {
  it("stamps schemaVersion 1 and echoes the sessionKey argument", () => {
    const report = assembleIncidentReport(makeSignals(), makeMetadata(), null, SESSION_KEY);
    expect(report.schemaVersion).toBe(1);
    expect(report.sessionKey).toBe(SESSION_KEY);
  });

  it("reads traceId / agentId / channel from the metadata", () => {
    const report = assembleIncidentReport(makeSignals(), makeMetadata(), null, SESSION_KEY);
    expect(report.traceId).toBe("f942d38c-0000-0000-0000-000000000000");
    expect(report.agentId).toBe("default");
    expect(report.channel).toEqual({ type: "peer", id: "678314278" });
  });

  it("defaults the ids/channel to empty strings when metadata is null (never throws)", () => {
    const report = assembleIncidentReport(makeSignals(), null, null, SESSION_KEY);
    expect(report.traceId).toBe("");
    expect(report.agentId).toBe("");
    expect(report.channel).toEqual({ type: "", id: "" });
  });

  it("leaves likelyRootCause null — Plan 05 owns it", () => {
    const report = assembleIncidentReport(makeSignals(), makeMetadata(), null, SESSION_KEY);
    expect(report.likelyRootCause).toBeNull();
  });

  it("starts truncations and suggestedNextSteps empty — Plan 04/05 own them", () => {
    const report = assembleIncidentReport(makeSignals(), makeMetadata(), null, SESSION_KEY);
    expect(report.truncations).toEqual([]);
    expect(report.suggestedNextSteps).toEqual([]);
  });

  it("emits a deterministic non-empty summary one-liner (no LLM)", () => {
    const report = assembleIncidentReport(
      makeSignals({ failures: [makeFailure({ seq: 1 }), makeFailure({ seq: 2 })] }),
      makeMetadata({ sessionEnd: { endReason: "completed_with_tool_errors" } }),
      null,
      SESSION_KEY,
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
    );
    expect(withRatio.cost.cacheReadRatio).toBeCloseTo(0.42, 4);

    const withoutRatio = assembleIncidentReport(makeSignals(), makeMetadata(), null, SESSION_KEY);
    expect(withoutRatio.cost.cacheReadRatio).toBe(0);
  });
});
