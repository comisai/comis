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
  const failures = [
    makeFailure({ seq: 1 }),
    makeFailure({ seq: 2 }),
    makeFailure({ seq: 3 }),
  ];
  return {
    sessionKey: SESSION_KEY,
    toolStats: { web_fetch: { ok: 2, failed: 8, topErrorKind: "dependency" } },
    failures,
    failureHistory: overrides.failureHistory ?? overrides.failures ?? failures,
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

describe("assembleIncidentReport — request-relevant tool selection", () => {
  it("surfaces current attachment size rejections on the one-call report", () => {
    const mediaAttachmentRejections = [{
      attachmentIndex: 0,
      reason: "size_exceeded" as const,
      sizeBytes: 57_671_680,
      maxBytes: 26_214_400,
      configKey: "integrations.media.infrastructure.maxRemoteFetchBytes" as const,
    }];
    const report = assembleIncidentReport(
      makeSignals({ mediaAttachmentRejections }),
      makeMetadata(),
      null,
      SESSION_KEY,
      READ_COUNT,
    );

    expect(report.mediaAttachmentRejections).toEqual(mediaAttachmentRejections);
    expect(IncidentReportSchema.parse(report).mediaAttachmentRejections)
      .toEqual(mediaAttachmentRejections);
  });

  it("surfaces selected tools when a turn completed without invoking one", () => {
    const selected = ["mcp_manage", "gateway"];
    const signals = makeSignals({
      requestRelevantToolNames: selected,
    } as unknown as Partial<IncidentSignals>);

    const report = assembleIncidentReport(
      signals,
      makeMetadata(),
      null,
      SESSION_KEY,
      READ_COUNT,
    );

    expect(
      (report as unknown as { requestRelevantToolNames?: string[] })
        .requestRelevantToolNames,
    ).toEqual(selected);
    expect(
      (IncidentReportSchema.parse(report) as unknown as {
        requestRelevantToolNames?: string[];
      }).requestRelevantToolNames,
    ).toEqual(selected);
  });

  it("surfaces operator-policy tool projection evidence on the one-call report", () => {
    const projection = [{
      toolName: "mcp_manage",
      sectionId: "workspace:tools",
      contentHash: "a".repeat(64),
      projectedChars: 318,
    }];
    const report = assembleIncidentReport(
      makeSignals({ operatorPolicyToolProjections: projection }),
      makeMetadata(),
      null,
      SESSION_KEY,
      READ_COUNT,
    );

    expect(report.operatorPolicyToolProjections).toEqual(projection);
    expect(IncidentReportSchema.parse(report).operatorPolicyToolProjections)
      .toEqual(projection);
  });

  it("surfaces request relevance history saturation on the one-call report", () => {
    const evidence = { turnCount: 8, charCount: 147, saturated: true };
    const report = assembleIncidentReport(
      makeSignals({ requestRelevanceHistory: evidence } as unknown as Partial<IncidentSignals>),
      makeMetadata(),
      null,
      SESSION_KEY,
      READ_COUNT,
    );

    expect(
      (report as unknown as { requestRelevanceHistory?: typeof evidence })
        .requestRelevanceHistory,
    ).toEqual(evidence);
    expect(
      (IncidentReportSchema.parse(report) as unknown as {
        requestRelevanceHistory?: typeof evidence;
      }).requestRelevanceHistory,
    ).toEqual(evidence);
  });

  it("surfaces a content-free request clarification on the one-call report", () => {
    const requestClarification = {
      reason: "opaque_payload_missing_instruction" as const,
      inputChars: 43_000,
    };
    const report = assembleIncidentReport(
      makeSignals({ requestClarification } as unknown as Partial<IncidentSignals>),
      makeMetadata(),
      null,
      SESSION_KEY,
      READ_COUNT,
    );

    expect(
      (report as unknown as { requestClarification?: typeof requestClarification })
        .requestClarification,
    ).toEqual(requestClarification);
  });
});

describe("assembleIncidentReport — queue disposition timeline", () => {
  it("surfaces queue and steering decisions on the one-call explain report", () => {
    const queueTimeline = [
      {
        seq: 3,
        event: "steer_injected" as const,
        channelType: "telegram",
      },
      {
        seq: 2,
        event: "coalesced" as const,
        channelType: "telegram",
        messageCount: 2,
      },
    ];
    const signals = makeSignals({
      queueTimeline,
    } as unknown as Partial<IncidentSignals>);

    const report = assembleIncidentReport(
      signals,
      makeMetadata(),
      null,
      SESSION_KEY,
      READ_COUNT,
    );

    expect(
      (report as unknown as { queueTimeline?: unknown[] }).queueTimeline,
    ).toEqual(queueTimeline);
  });
});

describe("assembleIncidentReport — response locale decision", () => {
  it("surfaces the content-free locale decision on the explain report", () => {
    const signals = makeSignals({
      responseLocale: {
        locale: "und-Latn",
        source: "request",
        enforced: true,
      },
    } as unknown as Partial<IncidentSignals>);

    const report = assembleIncidentReport(
      signals,
      makeMetadata(),
      null,
      SESSION_KEY,
      READ_COUNT,
    );

    expect(report).toMatchObject({
      responseLocale: {
        locale: "und-Latn",
        source: "request",
        enforced: true,
      },
    });
    expect(IncidentReportSchema.parse(report)).toMatchObject({
      responseLocale: {
        locale: "und-Latn",
        source: "request",
        enforced: true,
      },
    });
  });

  it("surfaces why locale repair was skipped without response content", () => {
    const responseLocaleRepairSkipped = {
      reason: "unrecovered_tool_failure" as const,
      expectedScript: "Latn",
      actualScript: "Hebr",
      unrecoveredToolFailureCount: 1,
    };
    const signals = makeSignals({
      responseLocaleRepairSkipped,
    } as unknown as Partial<IncidentSignals>);

    const report = assembleIncidentReport(
      signals,
      makeMetadata(),
      null,
      SESSION_KEY,
      READ_COUNT,
    );

    expect(report).toMatchObject({ responseLocaleRepairSkipped });
    expect(IncidentReportSchema.parse(report)).toMatchObject({
      responseLocaleRepairSkipped,
    });
  });
});

describe("assembleIncidentReport — group history receipt", () => {
  it("surfaces the content-free injected-message counts on explain", () => {
    const signals = makeSignals({
      groupHistory: {
        messageCount: 2,
        charCount: 73,
      },
    } as unknown as Partial<IncidentSignals>);

    const report = assembleIncidentReport(
      signals,
      makeMetadata(),
      null,
      SESSION_KEY,
      READ_COUNT,
    );

    expect(report).toMatchObject({
      groupHistory: {
        messageCount: 2,
        charCount: 73,
      },
    });
    expect(IncidentReportSchema.parse(report)).toMatchObject({
      groupHistory: {
        messageCount: 2,
        charCount: 73,
      },
    });
  });
});

describe("assembleIncidentReport — inbound message kind", () => {
  it("surfaces the content-free edit kind on the explain report", () => {
    const signals = makeSignals({
      inboundEdit: true,
    } as unknown as Partial<IncidentSignals>);

    const report = assembleIncidentReport(
      signals,
      makeMetadata(),
      null,
      SESSION_KEY,
      READ_COUNT,
    );

    expect(
      (report as unknown as { inboundEdit?: boolean }).inboundEdit,
    ).toBe(true);
    expect(
      (IncidentReportSchema.parse(report) as unknown as { inboundEdit?: boolean }).inboundEdit,
    ).toBe(true);
  });
});

describe("assembleIncidentReport — channel health outcome", () => {
  const cleanSignals = (recovered: boolean): IncidentSignals => makeSignals({
    toolStats: {},
    failures: [],
    repeatedFailureCount: {},
    hasMisclassificationSignal: false,
    misclassifiedTool: undefined,
    misclassifiedToken: undefined,
    channelHealth: {
      channelType: "telegram",
      connectionMode: "polling",
      degradedTransitions: 1,
      currentState: recovered ? "healthy" : "disconnected",
      latestProblemState: "disconnected",
      recovered,
    },
  });

  const cleanMetadata = (): Record<string, unknown> => makeMetadata({
    sessionEnd: {
      endReason: "success",
      degraded: false,
      durationMs: 10,
      totalTokens: 20,
      costUsd: 0,
      toolStats: {},
    },
  });

  it("marks a clean agent turn degraded while its channel remains disconnected", () => {
    const report = assembleIncidentReport(
      cleanSignals(false),
      cleanMetadata(),
      null,
      SESSION_KEY,
      READ_COUNT,
    );

    expect(report.outcome).toEqual({
      endReason: "success",
      degraded: true,
      severity: "degraded",
    });
  });

  it("keeps a clean agent turn healthy after the channel recovery transition", () => {
    const report = assembleIncidentReport(
      cleanSignals(true),
      cleanMetadata(),
      null,
      SESSION_KEY,
      READ_COUNT,
    );

    expect(report.outcome).toEqual({
      endReason: "success",
      degraded: false,
      severity: "ok",
    });
  });
});

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
  it("marks an otherwise successful parent degraded when a direct child failed", () => {
    const signals = makeSignals({
      toolStats: {},
      failures: [],
      hasMisclassificationSignal: false,
      repeatedFailureCount: {},
    }) as IncidentSignals & {
      subagentCompletions: {
        completed: number;
        failed: number;
        lastFailedRunId: string;
      };
    };
    signals.subagentCompletions = {
      completed: 1,
      failed: 1,
      lastFailedRunId: "run-child",
    };

    const report = assembleIncidentReport(
      signals,
      makeMetadata({
        sessionEnd: {
          endReason: "success",
          degraded: false,
        },
      }),
      null,
      SESSION_KEY,
      READ_COUNT,
    );

    expect(report.outcome).toEqual({
      endReason: "success",
      degraded: true,
      severity: "degraded",
    });
  });

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

  it("treats a tool invocation stall as a hard failure even without a persisted degraded flag", () => {
    const report = assembleIncidentReport(
      makeSignals({ failures: [] }),
      makeMetadata({ sessionEnd: { endReason: "tool_invocation_stall", degraded: false } }),
      null,
      SESSION_KEY,
      READ_COUNT,
    );

    expect(report.outcome).toEqual({
      endReason: "tool_invocation_stall",
      degraded: true,
      severity: "failed",
    });
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
  it("prefers a terminal max-steps abort over a generic metadata error", () => {
    const records: Array<Record<string, unknown>> = [
      {
        traceSchema: "comis-trajectory",
        type: "execution.aborted",
        seq: 20,
        agentId: "default",
        traceId: "t-abort",
        data: { reason: "max_steps" },
      },
    ];
    const report = assembleIncidentReport(
      toIncidentSignals(records),
      makeMetadata({
        sessionEnd: {
          type: "session_end",
          endReason: "error",
          degraded: true,
        },
      }),
      null,
      SESSION_KEY,
      records.length,
    );

    expect(report.outcome.endReason).toBe("max_steps");
  });

  it("prefers an attributed sub-agent kill over a generic metadata error", () => {
    const records: Array<Record<string, unknown>> = [
      {
        traceSchema: "comis-trajectory",
        type: "subagent.killed",
        seq: 20,
        agentId: "default",
        traceId: "t-killed",
        data: { runId: "run_a", killedBy: "parent", runtimeMs: 4_000 },
      },
    ];
    const report = assembleIncidentReport(
      toIncidentSignals(records),
      makeMetadata({
        sessionEnd: {
          type: "session_end",
          endReason: "error",
          degraded: true,
        },
      }),
      null,
      SESSION_KEY,
      records.length,
    );

    expect(report.outcome).toEqual({
      endReason: "killed",
      degraded: true,
      severity: "degraded",
    });
  });

  it("folds exact step-limit values from the terminal abort", () => {
    const signals = toIncidentSignals([
      {
        traceSchema: "comis-trajectory",
        type: "execution.aborted",
        seq: 20,
        agentId: "default",
        traceId: "t-step-limit",
        data: {
          reason: "max_steps",
          stepLimit: {
            bindingKnob: "agents.default.maxSteps",
            stepsExecuted: 4,
            cap: 4,
          },
        },
      },
    ]);

    expect((signals as unknown as { stepLimit?: unknown }).stepLimit).toEqual({
      bindingKnob: "agents.default.maxSteps",
      stepsExecuted: 4,
      cap: 4,
    });
  });

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
          perRootBudget: { limb: "tokens", spent: 139397, attempted: 24561, cap: 150000, unit: "tokens" },
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
    expect(report.perRootBudget).toEqual({
      limb: "tokens",
      spent: 139397,
      attempted: 24561,
      cap: 150000,
      unit: "tokens",
    });
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
  it("keeps session failure drill-down when verdict evidence is scoped to the latest turn", () => {
    const historicalFailure = makeFailure({
      seq: 2,
      toolName: "agents_manage",
      errorPreview: "old turn failure",
    });
    const signals = makeSignals({
      failures: [],
      toolStats: {
        agents_manage: { ok: 0, failed: 1, topErrorKind: "validation" },
      },
      failureHistory: [historicalFailure],
    } as unknown as Partial<IncidentSignals>);

    const report = assembleIncidentReport(
      signals,
      makeMetadata(),
      null,
      SESSION_KEY,
      READ_COUNT,
    );

    expect(report.failures).toEqual([historicalFailure]);
  });

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

  it("surfaces aggregated automatic link-prefetch evidence", () => {
    const linkPrefetch = {
      attempts: 3,
      detected: 4,
      attempted: 4,
      fetched: 2,
      failed: 2,
      validationRejected: 2,
      invalid: 0,
      duplicates: 0,
      capped: 0,
      durationMs: 41,
    };
    const report = assembleIncidentReport(
      makeSignals({ linkPrefetch }),
      makeMetadata(),
      null,
      SESSION_KEY,
      READ_COUNT,
    );

    expect(report.linkPrefetch).toEqual(linkPrefetch);
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

  it("counts failed tool invocations from the reported tool statistics", () => {
    const report = assembleIncidentReport(
      makeSignals({
        toolStats: { read: { ok: 0, failed: 1, topErrorKind: "validation" } },
        failures: [],
      }),
      makeMetadata({
        sessionEnd: {
          endReason: "completed_with_tool_errors",
          toolStats: { read: { ok: 0, failed: 1 } },
        },
      }),
      null,
      SESSION_KEY,
      READ_COUNT,
    );

    expect(report.summary).toBe(
      "1 tool failures across 1 turns; endReason=completed_with_tool_errors",
    );
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

describe("assembleIncidentReport — rehydration threading", () => {
  it("carries signals.rehydration into the report verbatim", () => {
    const rehydration = {
      seq: 11,
      currentTurn: true,
      sectionsInjected: 1,
      filesInjected: 0,
      skillsInjected: 1,
      overflowStripped: false,
    };
    const report = assembleIncidentReport(
      makeSignals({ rehydration }),
      makeMetadata(),
      null,
      SESSION_KEY,
      READ_COUNT,
    );

    expect(IncidentReportSchema.parse(report).rehydration).toEqual(rehydration);
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
      { traceSchema: "comis-trajectory", type: "execution.recovery_attempted", seq: 4, sessionKey: SESSION_KEY, data: { reason: "sender_authority_grounding", succeeded: true } },
    ]);
    const report = assembleIncidentReport(signals, makeMetadata(), null, SESSION_KEY, 4);
    expect(report.recoveries).toEqual({
      total: 4,
      succeeded: 3,
      byReason: { silent_retry: 2, lkw_fallback: 1, sender_authority_grounding: 1 },
    });
  });

  it("includes successful signed replay recovery in the report", () => {
    const signals = toIncidentSignals([
      { traceSchema: "comis-trajectory", type: "execution.recovery_attempted", seq: 1, sessionKey: SESSION_KEY, data: { reason: "continuation_nudge", succeeded: false } },
      { traceSchema: "comis-trajectory", type: "execution.replay_recovered", seq: 2, sessionKey: SESSION_KEY, data: { blocksRemoved: 6, thoughtSignaturesStripped: 0, succeeded: true } },
    ]);
    const report = assembleIncidentReport(signals, makeMetadata(), null, SESSION_KEY, 2);

    expect(report.recoveries).toEqual({
      total: 2,
      succeeded: 1,
      byReason: { continuation_nudge: 1, signed_replay: 1 },
    });
  });

  it("omits recoveries when the trajectory carries none", () => {
    const report = assembleIncidentReport(toIncidentSignals([]), makeMetadata(), null, SESSION_KEY, 0);
    expect(report.recoveries).toBeUndefined();
  });

  it("diagnoses a clean recovery that replaced a grounded response from tools outside its route", async () => {
    const baseReader = makeAuditReader([], [
      {
        traceSchema: "comis-trajectory",
        type: "execution.recovery_attempted",
        seq: 1,
        sessionKey: SESSION_KEY,
        data: {
          reason: "request_tool_nudge",
          succeeded: true,
          groundedResponseBeforeRecovery: true,
          groundedResponsePreserved: false,
          successfulReceiptsOutsideRoute: 1,
        },
      },
    ]);
    const reader: IncidentSourceReader = {
      ...baseReader,
      async readSessionMetadata() {
        return makeMetadata({
          sessionEnd: {
            type: "session_end",
            timestamp: "2026-08-13T14:04:00.000Z",
            endReason: "success",
            durationMs: 650_000,
            totalTokens: 1_950_000,
            degraded: false,
            costUsd: 2.23,
            toolStats: {
              "mcp__records--summary": { ok: 1, failed: 0 },
            },
            breakerTripCount: 0,
            topErrorKinds: {},
          },
        });
      },
    };

    const report = await assembleIncidentReportFromSources(
      reader,
      "/fake/.comis",
      { sessionKey: SESSION_KEY, depth: "summary" },
    );

    expect(report.outcome).toMatchObject({
      endReason: "success",
      degraded: false,
      severity: "ok",
    });
    expect(report.recoveries as Record<string, unknown>).toMatchObject({
      total: 1,
      succeeded: 1,
      byReason: { request_tool_nudge: 1 },
      groundedResponseBeforeRecoveryCount: 1,
      groundedResponsePreservedCount: 0,
      successfulReceiptsOutsideRoute: 1,
    });
    expect(report.likelyRootCause?.code).toBe(
      "recovery_replaced_grounded_response",
    );
    expect(report.likelyRootCause?.detail).toMatch(
      /grounded response.*outside.*route.*replaced/iu,
    );
  });

  it("does not diagnose replacement when recovery preserved the grounded response", async () => {
    const reader = makeAuditReader([], [
      {
        traceSchema: "comis-trajectory",
        type: "execution.recovery_attempted",
        seq: 1,
        sessionKey: SESSION_KEY,
        data: {
          reason: "request_tool_nudge",
          succeeded: true,
          groundedResponseBeforeRecovery: true,
          groundedResponsePreserved: true,
          successfulReceiptsOutsideRoute: 1,
        },
      },
    ]);

    const report = await assembleIncidentReportFromSources(
      reader,
      "/fake/.comis",
      { sessionKey: SESSION_KEY, depth: "summary" },
    );

    expect(report.recoveries).toMatchObject({
      groundedResponseBeforeRecoveryCount: 1,
      groundedResponsePreservedCount: 1,
      successfulReceiptsOutsideRoute: 1,
    });
    expect(report.likelyRootCause).toBeNull();
  });
});

describe("assembleIncidentReport — discovery activation", () => {
  it("surfaces content-free activation counts on the incident report", () => {
    const signals = toIncidentSignals([{
      traceSchema: "comis-trajectory",
      type: "tool.discovery_activation",
      seq: 1,
      sessionKey: SESSION_KEY,
      data: {
        displayedCount: 4,
        activatedCount: 2,
        replacedCount: 1,
        skippedCount: 1,
        failedCount: 2,
      },
    }]);
    const report = assembleIncidentReport(signals, makeMetadata(), null, SESSION_KEY, 1);

    expect((report as unknown as { discoveryActivation?: Record<string, number> }).discoveryActivation)
      .toEqual({
        displayedCount: 4,
        activatedCount: 2,
        replacedCount: 1,
        skippedCount: 1,
        failedCount: 2,
      });
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

  it("marks a successful delivery as degraded when final activity rendering failed", () => {
    const signals = toIncidentSignals([
      {
        traceSchema: "comis-trajectory",
        type: "activity.turn_finalized",
        seq: 1,
        sessionKey: SESSION_KEY,
        data: {
          strategy: "EditPlace",
          outcome: "success",
          renderErrorKind: "not_supported",
          reclassified: false,
          failedEventCount: 0,
        },
      },
    ]);

    const report = assembleIncidentReport(
      signals,
      makeMetadata({ sessionEnd: { endReason: "success", degraded: false } }),
      null,
      SESSION_KEY,
      1,
    );

    expect(report.activityFinalize).toMatchObject({
      outcome: "success",
      renderErrorKind: "not_supported",
    });
    expect(report.outcome).toMatchObject({ degraded: true, severity: "degraded" });
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

  it("tallies pending-background cleanup when a completion re-entry becomes the last snapshot", () => {
    const signals = toIncidentSignals([
      {
        traceSchema: "comis-trajectory",
        type: "activity.turn_finalized",
        seq: 1,
        sessionKey: SESSION_KEY,
        data: {
          strategy: "EditPlace",
          outcome: "silent",
          reason: "BACKGROUND_PENDING",
          reclassified: false,
          failedEventCount: 0,
        },
      },
      {
        traceSchema: "comis-trajectory",
        type: "activity.turn_finalized",
        seq: 2,
        sessionKey: SESSION_KEY,
        data: {
          strategy: "EditPlace",
          outcome: "silent",
          reason: "NO_REPLY",
          reclassified: false,
          failedEventCount: 0,
        },
      },
    ]);

    const report = assembleIncidentReport(signals, makeMetadata(), null, SESSION_KEY, 2);
    expect(report.activityFinalize).toMatchObject({
      outcome: "silent",
      reason: "NO_REPLY",
      backgroundPendingCleanupCount: 1,
    });
  });

  it("omits both sections when the trajectory carries no such records (undefined, never empty objects)", () => {
    const signals = toIncidentSignals([]);
    const report = assembleIncidentReport(signals, makeMetadata(), null, SESSION_KEY, 0);
    expect(report.activityFinalize).toBeUndefined();
    expect(report.deliverySkipped).toBeUndefined();
  });

  it("degrades a clean child rollup when its completion had no delivery route", () => {
    const signals = toIncidentSignals([
      {
        traceSchema: "comis-trajectory",
        type: "subagent.delivery_skipped",
        seq: 1,
        sessionKey: SESSION_KEY,
        data: {
          runId: "run-route-lost",
          reason: "no_origin",
        },
      },
    ]);
    const report = assembleIncidentReport(
      signals,
      makeMetadata({
        sessionEnd: {
          endReason: "success",
          degraded: false,
          toolStats: {},
        },
      }),
      null,
      SESSION_KEY,
      1,
    );
    const delivery = (report as unknown as {
      subagentDeliverySkipped?: {
        count: number;
        lastRunId: string;
        lastReason: string;
      };
    }).subagentDeliverySkipped;

    expect(delivery).toEqual({
      count: 1,
      lastRunId: "run-route-lost",
      lastReason: "no_origin",
    });
    expect(report.outcome).toEqual({
      endReason: "success",
      degraded: true,
      severity: "degraded",
    });
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
      { reason: "system_changed", count: 2, estCostUsd: 0.01, tokenDrop: 0 },
      { reason: "tools_changed", count: 1, estCostUsd: 0, tokenDrop: 0 },
    ]);
  });

  it("OMITS cacheBreaks entirely when the trajectory carries no cache.break records (undefined, not [])", () => {
    const signals = toIncidentSignals([]);
    const report = assembleIncidentReport(signals, makeMetadata(), null, SESSION_KEY, 0);
    expect(report.cacheBreaks).toBeUndefined();
  });

  it("never carries the changed tool NAMES — only counts + reason + est-$ (content-free)", () => {
    const signals = toIncidentSignals([cacheBreakRecord({ reason: "tools_changed", estCostUsd: 0.02, tokenDrop: 1234 }, 1)]);
    const report = assembleIncidentReport(signals, makeMetadata(), null, SESSION_KEY, 1);
    const serialized = JSON.stringify(report.cacheBreaks);
    expect(serialized).not.toMatch(/toolsAdded|toolsRemoved|changedDimsDigest|secret/);
    // tokenDrop rides the report so the MAGNITUDE is visible. `estCostUsd` is only the forgone
    // cache-READ saving (drop x read-rate); the real cost of a break is re-WRITING the prefix at the
    // write rate. Live, that made a $30.64 incident read as $0.46 of waste, while the dropped-token
    // count (920,026) told the true story. Reporting drop alongside cost stops the small number from
    // being mistaken for the whole picture.
    expect(report.cacheBreaks?.[0]).toEqual({ reason: "tools_changed", count: 1, estCostUsd: 0.02, tokenDrop: 1234 });
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

/** A fixture reader: the given trajectory and audit rows, with no cache records. */
function makeAuditReader(
  auditRows: Array<Record<string, unknown>>,
  sessionRecords: Array<Record<string, unknown>> = [],
): IncidentSourceReader {
  return {
    async readSessionRecords() {
      return sessionRecords;
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
  it("reports a grounded vision fallback instead of chronic breaker noise", async () => {
    const reader = makeAuditReader([
      auditRow("audit", TRACE_ID, {
        action: "response.vision_fallback_grounded",
        outcome: "success",
      }),
    ]);
    const report = await assembleIncidentReportFromSources(reader, "/fake/.comis", {
      sessionKey: SESSION_KEY,
      depth: "summary",
    });

    expect(report.likelyRootCause).toEqual({
      code: "vision_fallback_grounded",
      detail:
        "configured image analysis was unavailable, but a later tool used the same image "
        + "and produced evidence that grounded the delivered response",
      suggestedNextSteps: [
        "no user retry is required; the fallback recovered this turn",
        "configure a vision-capable model or vision provider to avoid the fallback path",
      ],
    });
  });

  it("ranks a delegation-evidence correction above generic session noise", async () => {
    const reader = makeAuditReader([
      auditRow("audit", TRACE_ID, {
        action: "response.delegation_evidence_guard",
        outcome: "denied",
      }),
    ]);
    const report = await assembleIncidentReportFromSources(reader, "/fake/.comis", {
      sessionKey: SESSION_KEY,
      depth: "summary",
    });

    expect(report.likelyRootCause).toEqual({
      code: "delegation_evidence_missing",
      detail:
        "the response honesty guard replaced an unsupported delegation claim "
        + "because this execution had no successful current-turn sessions_spawn receipt",
      suggestedNextSteps: [
        "inspect sessions_spawn admission and the tool inventory for this turn",
        "if a spawn was refused, inspect the bound-naming tool failure in this report",
        "retry the request after correcting the spawn precondition",
      ],
    });
  });

  it("reports response drift after a successful delegation receipt", async () => {
    const reader = makeAuditReader([
      auditRow("audit", TRACE_ID, {
        action: "response.delegation_response_grounding_guard",
        outcome: "denied",
      }),
    ]);
    const report = await assembleIncidentReportFromSources(reader, "/fake/.comis", {
      sessionKey: SESSION_KEY,
      depth: "summary",
    });

    expect(report.likelyRootCause).toEqual({
      code: "delegation_response_ungrounded",
      detail:
        "sessions_spawn succeeded, but the final response did not describe the current delegation; "
        + "the response honesty guard replaced it with a receipt-backed status",
      suggestedNextSteps: [
        "inspect the model turn after the successful sessions_spawn receipt",
        "check recalled context and prompt-skill use for stale task influence",
        "no spawn retry is required unless the delegated result is still needed",
      ],
    });
  });

  it("ranks a rejected completion route above earlier delegation response drift", async () => {
    const reader = makeAuditReader(
      [
        auditRow("audit", TRACE_ID, {
          action: "response.delegation_response_grounding_guard",
          outcome: "denied",
        }),
      ],
      [
        {
          traceSchema: "comis-trajectory",
          type: "subagent.delivery_skipped",
          seq: 2,
          traceId: TRACE_ID,
          data: {
            runId: "run-route-rejected",
            reason: "route_validation_failed",
          },
        },
      ],
    );
    const report = await assembleIncidentReportFromSources(reader, "/fake/.comis", {
      sessionKey: SESSION_KEY,
      depth: "summary",
    });

    expect(report.likelyRootCause?.code).toBe("subagent_delivery_skipped");
    expect(report.likelyRootCause?.detail).toMatch(/route validation failed/i);
  });

  it("names a persistent-action evidence correction as the acute cause", async () => {
    const reader = makeAuditReader([
      auditRow("audit", TRACE_ID, {
        action: "response.persistent_action_evidence_guard",
        outcome: "denied",
      }),
    ]);
    const report = await assembleIncidentReportFromSources(reader, "/fake/.comis", {
      sessionKey: SESSION_KEY,
      depth: "summary",
    });

    expect(report.likelyRootCause).toEqual({
      code: "persistent_action_evidence_missing",
      detail:
        "the response honesty guard replaced a terminal result because the request "
        + "required repeated current-turn action but this execution had no successful tool receipt",
      suggestedNextSteps: [
        "inspect the current tool inventory and action admission for this turn",
        "retry after the required capability can produce current-turn evidence",
      ],
    });
  });

  it("names a missing outbound-audio receipt as the acute cause", async () => {
    const reader = makeAuditReader([
      auditRow("audit", TRACE_ID, {
        action: "response.outbound_audio_evidence_guard",
        outcome: "denied",
      }),
    ]);
    const report = await assembleIncidentReportFromSources(reader, "/fake/.comis", {
      sessionKey: SESSION_KEY,
      depth: "summary",
    });

    expect(report.likelyRootCause).toEqual({
      code: "outbound_audio_evidence_missing",
      detail:
        "the response honesty guard replaced an audio-delivery claim because this "
        + "execution had no successful current-turn synthesis or trusted completion receipt",
      suggestedNextSteps: [
        "inspect tts_synthesize admission and tool results for this turn",
        "if work was delegated, verify the background completion relay delivered the audio",
        "retry only after the outbound audio capability can produce a delivery receipt",
      ],
    });
  });

  it("names a missing outbound-image receipt as the acute cause", async () => {
    const reader = makeAuditReader([
      auditRow("audit", TRACE_ID, {
        action: "response.outbound_image_evidence_guard",
        outcome: "denied",
      }),
    ]);
    const report = await assembleIncidentReportFromSources(reader, "/fake/.comis", {
      sessionKey: SESSION_KEY,
      depth: "summary",
    });

    expect(report.likelyRootCause).toEqual({
      code: "outbound_image_evidence_missing",
      detail:
        "the response honesty guard replaced an image-creation claim because this "
        + "execution had no successful current-turn generation or trusted completion receipt",
      suggestedNextSteps: [
        "inspect image_generate admission and tool results for this turn",
        "if work was delegated, verify the background completion relay delivered the image",
        "retry only after the image-generation capability can produce a delivery receipt",
      ],
    });
  });

  it("names an unverified outbound-delivery status answer as the acute cause", async () => {
    const reader = makeAuditReader([
      auditRow("audit", TRACE_ID, {
        action: "response.outbound_delivery_status_evidence_guard",
        outcome: "denied",
      }),
    ]);
    const report = await assembleIncidentReportFromSources(reader, "/fake/.comis", {
      sessionKey: SESSION_KEY,
      depth: "summary",
    });

    expect(report.likelyRootCause).toEqual({
      code: "outbound_delivery_status_evidence_missing",
      detail:
        "the response honesty guard replaced an affirmative delivery-status answer because "
        + "the elliptical follow-up had no current delivery or observability receipt",
      suggestedNextSteps: [
        "inspect current obs_query and self-delivering media tool results for this turn",
        "resolve which prior outbound item the follow-up refers to before confirming delivery",
        "retry status verification instead of relying on historical assistant prose",
      ],
    });
  });

  it("keeps a concrete MCP credential failure above the response-honesty symptom", async () => {
    const reader = makeAuditReader(
      [
        auditRow("audit", TRACE_ID, {
          action: "response.persistent_action_evidence_guard",
          outcome: "denied",
        }),
      ],
      [
        {
          traceSchema: "comis-trajectory",
          schemaVersion: 1,
          type: "tool.result",
          seq: 144,
          traceId: TRACE_ID,
          sessionKey: SESSION_KEY,
          data: {
            toolName: "mcp__test-service--account_summary",
            success: false,
            errorKind: "dependency",
            classifiedFailureBy: "mcp_classifier",
            transportOk: false,
            failureCode: "credential_invalid",
            resultBytes: 905,
            resultDigest: "679076382916",
          },
        },
      ],
    );

    const report = await assembleIncidentReportFromSources(reader, "/fake/.comis", {
      sessionKey: SESSION_KEY,
      depth: "summary",
    });

    expect(report.failures[0]?.failureCode).toBe("credential_invalid");
    expect(report.likelyRootCause?.code).toBe("mcp_credential_invalid");
  });

  it("names a corrected destructive no-effect claim as the acute cause", async () => {
    const reader = makeAuditReader([
      auditRow("audit", TRACE_ID, {
        action: "response.destructive_action_evidence_guard",
        outcome: "denied",
      }),
    ]);
    const report = await assembleIncidentReportFromSources(reader, "/fake/.comis", {
      sessionKey: SESSION_KEY,
      depth: "summary",
    });

    expect(report.likelyRootCause).toEqual({
      code: "destructive_action_no_effect",
      detail:
        "the response honesty guard replaced a completion claim because the destructive "
        + "exec command reported no observable filesystem effect",
      suggestedNextSteps: [
        "inspect the failed exec record and its bound approval request",
        "confirm the intended target exists inside the configured workspace or write fence",
        "retry only after correcting the target; do not treat an exit-zero no-op as success",
      ],
    });
  });

  it("names an unverified completion claim as the acute cause", async () => {
    const reader = makeAuditReader([
      auditRow("audit", TRACE_ID, {
        action: "response.completion_evidence_guard",
        outcome: "denied",
      }),
    ]);
    const report = await assembleIncidentReportFromSources(reader, "/fake/.comis", {
      sessionKey: SESSION_KEY,
      depth: "summary",
    });

    expect(report.likelyRootCause).toEqual({
      code: "unverified_completion_claim",
      detail:
        "the response honesty guard replaced a completion claim because one or more "
        + "tool steps still had an unrecovered failure",
      suggestedNextSteps: [
        "inspect the failed tool records in this report and correct the failing step",
        "retry verification before treating the requested result as complete",
      ],
    });
  });

  it("preserves a terminal route stall above its downstream completion correction", async () => {
    const records = [
      {
        traceSchema: "comis-trajectory",
        type: "prompt.submitted",
        seq: 1,
        traceId: TRACE_ID,
        sessionKey: SESSION_KEY,
        data: {
          requestRelevantToolNames: ["read", "web_search", "web_fetch"],
          requestRelevantPromptSkillNames: ["deep-research"],
          responseLocaleSource: "unset",
          responseLocaleEnforced: false,
        },
      },
      {
        traceSchema: "comis-trajectory",
        type: "tool.result",
        seq: 2,
        traceId: TRACE_ID,
        sessionKey: SESSION_KEY,
        data: { toolName: "mcp__records--summary", success: true },
      },
      {
        traceSchema: "comis-trajectory",
        type: "execution.recovery_attempted",
        seq: 3,
        traceId: TRACE_ID,
        sessionKey: SESSION_KEY,
        data: {
          reason: "request_tool_nudge",
          succeeded: true,
          groundedResponseBeforeRecovery: true,
          groundedResponsePreserved: true,
          successfulReceiptsOutsideRoute: 17,
        },
      },
      {
        traceSchema: "comis-trajectory",
        type: "execution.recovery_attempted",
        seq: 4,
        traceId: TRACE_ID,
        sessionKey: SESSION_KEY,
        data: {
          reason: "unrecovered_tool_failure_completion_claim",
          succeeded: true,
        },
      },
    ];
    const baseReader = makeAuditReader([
      auditRow("audit", TRACE_ID, {
        action: "response.completion_evidence_guard",
        outcome: "denied",
      }),
    ], records);
    const reader: IncidentSourceReader = {
      ...baseReader,
      async readSessionMetadata() {
        return makeMetadata({
          sessionEnd: {
            type: "session_end",
            timestamp: "2026-08-13T14:04:00.000Z",
            endReason: "tool_invocation_stall",
            durationMs: 650_000,
            totalTokens: 1_950_000,
            degraded: true,
            costUsd: 2.23,
            toolStats: { "mcp__records--summary": { ok: 1, failed: 0 } },
            breakerTripCount: 0,
            topErrorKinds: {},
          },
        });
      },
    };

    const report = await assembleIncidentReportFromSources(reader, "/fake/.comis", {
      sessionKey: SESSION_KEY,
      depth: "summary",
    });

    expect(report).toMatchObject({
      outcome: { endReason: "tool_invocation_stall", degraded: true },
      requestRelevantToolNames: ["read", "web_search", "web_fetch"],
      requestRelevantPromptSkillNames: ["deep-research"],
      toolStats: { "mcp__records--summary": { ok: 1, failed: 0 } },
      recoveries: {
        total: 2,
        byReason: {
          request_tool_nudge: 1,
          unrecovered_tool_failure_completion_claim: 1,
        },
        groundedResponseBeforeRecoveryCount: 1,
        groundedResponsePreservedCount: 1,
        successfulReceiptsOutsideRoute: 17,
      },
    });
    expect(report.likelyRootCause?.code).toBe("tool_invocation_stall");
    expect(report.likelyRootCause?.detail).toContain(
      "selected prompt skills [deep-research]",
    );
    expect(
      IncidentReportSchema.parse(report).requestRelevantPromptSkillNames,
    ).toEqual(["deep-research"]);
    expect(report.likelyRootCause?.detail).toMatch(
      /completed current-turn invocations.*later workflow requirement remained incomplete/iu,
    );
  });

  it("names a pre-send completion-evidence block as the acute cause", async () => {
    const reader = makeAuditReader([
      auditRow("audit", TRACE_ID, {
        action: "response.outbound_completion_evidence_guard",
        outcome: "denied",
      }),
    ]);
    const report = await assembleIncidentReportFromSources(reader, "/fake/.comis", {
      sessionKey: SESSION_KEY,
      depth: "summary",
    });

    expect(report.likelyRootCause).toEqual({
      code: "outbound_completion_evidence_missing",
      detail:
        "the pre-send response honesty guard blocked a completion claim because the "
        + "current mutation request had no successful matching mutation receipt",
      suggestedNextSteps: [
        "inspect the blocked message tool record and request-matched mutation tools",
        "complete and verify the mutation before retrying user-visible delivery",
      ],
    });
  });

  it("keeps an acute spawn ceiling refusal above its downstream delegation correction", async () => {
    const reader: IncidentSourceReader = {
      ...makeAuditReader([
        auditRow("audit", TRACE_ID, {
          action: "response.delegation_evidence_guard",
          outcome: "denied",
        }),
      ]),
      async readSessionRecords() {
        return [
          {
            traceSchema: "comis-trajectory",
            schemaVersion: 1,
            source: "runtime",
            type: "tool.result",
            ts: "2026-07-29T19:38:25.732Z",
            seq: 6,
            agentId: "default",
            sessionId: SESSION_KEY,
            traceId: TRACE_ID,
            sessionKey: SESSION_KEY,
            data: {
              toolName: "sessions_spawn",
              durationMs: 6,
              success: false,
              errorKind: "resource",
              errorMessage:
                '{"content":[{"type":"text","text":"[spawn_ceiling] Sub-agent spawn rejected: autonomy.spawn.maxSpawnDepth=1; current=1; reason=depth. Increase autonomy.spawn.maxSpawnDepth in the config file and restart the daemon, or continue without another nested spawn; waiting for running work cannot change this call\'s depth."}],"details":{}}',
              classifiedFailureBy: "runtime_guard",
              transportOk: false,
              matchedRule: "spawn_ceiling",
              resultBytes: 331,
              resultDigest: "6c0d7b2dd66c",
            },
          },
        ];
      },
    };
    const report = await assembleIncidentReportFromSources(reader, "/fake/.comis", {
      sessionKey: SESSION_KEY,
      depth: "summary",
    });

    expect(report.likelyRootCause?.code).toBe("spawn_ceiling");
    expect(report.likelyRootCause?.detail).toContain(
      "autonomy.spawn.maxSpawnDepth=1; current=1",
    );
    expect(report.likelyRootCause?.suggestedNextSteps.join(" ")).toContain(
      "restart the daemon",
    );
  });

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
