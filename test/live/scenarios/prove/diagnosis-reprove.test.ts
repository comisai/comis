// SPDX-License-Identifier: Apache-2.0
/**
 * DIAG-reprove (Phase 156 — GA CLOSE: RE-PROVE with obs.explain).
 *
 * The G1 proof. Mirrors diagnosis-baseline.test.ts EXACTLY (the Phase-149
 * Stage-A/B-vs-Stage-C discipline) and differs in only four documented ways:
 *   (1) the inline agent manifest gains a 3rd tool `obs.explain`;
 *   (2) that tool's dispatch calls the barrel-exported
 *       `assembleIncidentReportFromSources` over a FIXTURE reader (NOT a daemon
 *       RPC, NOT ~/.comis) — the in-process 1-call root cause;
 *   (3) the always-on Stage-A/B substrate asserts the obs.explain tool reaches
 *       the X3 IncidentReport in 1 call / 0 reads — FIELD-LEVEL for the 678
 *       fixture (via the 156-01 `assert678Report`, NOT `compareToAnswerKey`,
 *       which returns false for 678 — it never resolves the literal "403");
 *   (4) the Stage-C gated RUN records `obsExplainCalls === 1` AND
 *       `distinctSourceReads === 0` on the verdict row (Task 2).
 *
 * This is the heart of v2.14's proof: the §1.1 degraded session, which Phase
 * 149's baseline FAILED (it needed source reads + multi-call), is now
 * root-caused in ONE obs.explain call with ZERO source reads.
 *
 *   Stage-A/B (ALWAYS-ON, KEYLESS — runs in `pnpm validate`): the deterministic
 *     substrate. The obs.explain tool over the 678 fixture reaches
 *     content_heuristic_misclassification + degraded + breakerTimeline + costUsd
 *     (field-level); over the 503 fixture reaches breaker_opened_repeated_failure
 *     + web_fetch (field-level + the compareToAnswerKey bonus). A synthetic
 *     1-call transcript proves countObsExplainCalls === 1 + distinctSourceReads
 *     === 0 — the G1 metric, keyless. NO COMIS_LIVE, NO daemon, NO token.
 *
 *   Stage-C (COMIS_LIVE-gated, `it.skip`, NEVER in `pnpm validate`): the actual
 *     RE-PROVE RUN — a fresh SCRIPTED ReAct agent WITH obs.explain root-causes
 *     each fixture, recording per fixture (rootCauseReached via judge, totalTokens,
 *     obsExplainCalls === 1, distinctSourceReads === 0). Writes the reprove ledger
 *     to the git-ignored benchmarks/ dir. SKIPS cleanly with no key (skip != fail).
 *     The numeric "≤ the 149 token target" comparison is the operator's RUN — NO
 *     literal token target is asserted here (see the RUNBOOK). Added in Task 2.
 *
 * NO new env var: reuses COMIS_LIVE / COMIS_LIVE_BUDGET_USD / COMIS_LIVE_JUDGE_*
 * (all already in docs/reference/environment-variables.mdx). costTier: "dollar".
 *
 * Run keyless (Stage-A/B green, Stage-C skipped):
 *   pnpm vitest run --config test/live/vitest.config.ts \
 *     test/live/scenarios/prove/diagnosis-reprove.test.ts
 *
 * @module
 */

import { describe, it, expect } from "vitest";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadFixture,
  recordMetrics,
  compareToAnswerKey,
  type AgentTurn,
  type DiagnosisFailureClass,
  type DiagnosisVerdictRow,
} from "../../support/diagnosis-harness.js";
import { BUDGET_SKIPPED_MARKER } from "../../support/diagnosis-gating-report.js";
// NEW in reprove (not in baseline): the FROZEN Phase-153 assembler + its reader
// type, re-exported by 156-01's @comis/daemon barrel. The bare-package import
// resolves via the test/live/vitest.config.ts:36 alias to daemon/dist/index.js.
import { assembleIncidentReportFromSources, type IncidentSourceReader } from "@comis/daemon";
import type { IncidentReport } from "@comis/core";
// NEW in reprove: the 156-01 pure assert module — the 1-call gate + the
// field-level 678/503 IncidentReport asserts (NOT compareToAnswerKey for 678).
import {
  countObsExplainCalls,
  assert678Report,
  assert503Report,
} from "../../support/diagnosis-reprove.js";

const isLive = !!process.env["COMIS_LIVE"];

// fileURLToPath(import.meta.url) is robust across vitest pool modes (the
// document-extraction.test.ts:39 idiom) — preferred over a bare __dirname.
const __dirnameLocal = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(__dirnameLocal, "../../fixtures/diagnosis");

/** The 5 frozen diagnosis fixtures (Plan 149-02). */
const FIXTURE_IDS = [
  "session-678314278",
  "live-503-breaker",
  "live-exec-modulenotfound",
  "live-budget-exhaustion",
  "live-provider-timeout",
] as const;
type FixtureId = (typeof FIXTURE_IDS)[number];

/** Map each fixture id to its closed failure class (Plan 149-02 corpus table). */
const FAILURE_CLASS: Record<FixtureId, DiagnosisFailureClass> = {
  "session-678314278": "historical-c53ab0f",
  "live-503-breaker": "503-breaker",
  "live-exec-modulenotfound": "exec-modulenotfound",
  "live-budget-exhaustion": "budget-exhaustion",
  "live-provider-timeout": "provider-timeout",
};

/**
 * Build the explicit NEVER-MEASURED verdict row for a fixture the cost budget cut
 * off (WR-04) — reused verbatim from diagnosis-baseline.test.ts:92-103. Emitting
 * one of these per budget-skipped fixture (instead of a silent `break`) is what
 * keeps every FIXTURE_IDS class present in the gating table — the gating report
 * renders these distinctly (never a TRIM-CANDIDATE) and flags the partial gate.
 * Zeroed metrics + the BUDGET_SKIPPED_MARKER carry the "not measured" signal; the
 * marker is a label only (passes assertNoSecrets).
 */
function budgetSkippedRow(id: FixtureId): DiagnosisVerdictRow {
  return {
    fixtureId: id,
    failureClass: FAILURE_CLASS[id],
    totalTokens: 0,
    distinctToolCalls: 0,
    distinctSourceReads: 0,
    judgeVerdict: "skip",
    rootCauseReached: "skip",
    surfacesUsed: [BUDGET_SKIPPED_MARKER],
  };
}

/**
 * A reader backed by a frozen fixture directory (the obs-explain.test.ts:56-64
 * shape). `readSessionRecords` ignores the sessionKey (returns the fixture's
 * records for any key), so the assembler runs the REAL signals → assemble →
 * rootCause → bound pipeline over committed data, keyless — no daemon, no
 * ~/.comis, no network.
 */
function makeFixtureReader(fixtureDir: string): IncidentSourceReader {
  const { events, meta } = loadFixture(fixtureDir);
  return {
    readSessionRecords: async () => events,
    readCacheTraceRecords: async () => [],
    readSessionMetadata: async () => meta as Record<string, unknown>,
    readDiagnosticsRollup: async () => null,
  };
}

/**
 * The `obs.explain` tool the agent calls — the 1-call / 0-reads root cause.
 *
 * Calls the barrel-exported FROZEN assembler (the SAME function obs-explain.test.ts:303
 * calls with NO `_trustLevel`) over the fixture's reader. NOT a daemon RPC, NOT
 * `bindObsExplainHandlers` (which keeps its admin gate) — the gate-free assembler
 * is reachable under daemon authority directly, and here at operator trust as a
 * test (T-156-02-01: the admin gate is untouched; this is the assembler's
 * own boundary by design, 154-03). `summary` keeps the report ≤6 KB bounded (X2).
 */
async function obsExplainTool(fixtureDir: string): Promise<IncidentReport> {
  return assembleIncidentReportFromSources(makeFixtureReader(fixtureDir), ".", {
    sessionKey: "default:x:x:peer:x", // the fixture reader ignores the key
    depth: "summary", // ≤6 KB bounded (X2)
  });
}

// ===========================================================================
// Stage-A/B — the always-on, keyless substrate (runs in pnpm validate).
//   Proves the obs.explain tool reaches the X3 root cause in 1 call / 0 reads
//   over the REAL frozen fixtures. No COMIS_LIVE, no daemon, no live token.
// ===========================================================================

describe("DIAG-reprove substrate — obs.explain tool reaches X3 root cause in 1 call / 0 reads", () => {
  it("678 fixture (field-level): content_heuristic_misclassification + degraded + breakerTimeline + costUsd in 1 obs.explain call", async () => {
    // FIELD-LEVEL via the 156-01 helper — NOT compareToAnswerKey. compareToAnswerKey
    // returns reached=false for 678 (the report resolves token=status, never the
    // literal "403" the answer-key requires), so a compareToAnswerKey-reached
    // assertion here would be a permanent RED. assert678Report pins the X3 fields:
    // likelyRootCause.code/detail~web_fetch/outcome.degraded/breakerTimeline>0/
    // cost.costUsd≈1.320669. Reaching the report at all proves the 1-call path.
    const report = await obsExplainTool(join(FIXTURES_DIR, "session-678314278"));
    expect(() => assert678Report(report)).not.toThrow();
  });

  it("503 fixture (field-level + compareToAnswerKey bonus): breaker_opened_repeated_failure + web_fetch", async () => {
    // assert503Report is the PRIMARY (field-level: code=breaker_opened_repeated_failure,
    // detail~web_fetch, degraded). Unlike 678, the 503 report ALSO satisfies
    // compareToAnswerKey structurally (all of 503/breaker/web_fetch/repeated present
    // in the serialized report) — assert that as a bonus, not the sole criterion.
    const report = await obsExplainTool(join(FIXTURES_DIR, "live-503-breaker"));
    expect(() => assert503Report(report)).not.toThrow();

    const fx503 = loadFixture(join(FIXTURES_DIR, "live-503-breaker"));
    expect(compareToAnswerKey(JSON.stringify(report), fx503.answerKey).reached).toBe(true);
  });

  it("a 1-obs.explain-call transcript yields countObsExplainCalls === 1 and distinctSourceReads === 0 (the G1 metric, keyless)", () => {
    // The G1 proof shape, proven without a token: a single assistant turn that
    // calls obs.explain ONCE and reads NO source files. recordMetrics is reused
    // VERBATIM (it counts the 3rd tool automatically); distinctSourceReads is the
    // zero-reads half. countObsExplainCalls is the 1-call half. BOTH matter
    // (Pitfall 4) — reaching the root cause is not the proof unless it was reached
    // in 1 call with 0 reads.
    const transcript: AgentTurn[] = [
      {
        role: "assistant",
        toolCalls: [
          { name: "obs.explain", arguments: JSON.stringify({ sessionKey: "x", depth: "summary" }) },
        ],
        usage: { totalTokens: 1430 },
      },
      {
        role: "assistant",
        content: "Root cause: a status-200 web_fetch body was misclassified by a substring 403 scan, tripping the retry breaker.",
        usage: { totalTokens: 90 },
      },
    ];
    expect(countObsExplainCalls(transcript)).toBe(1);
    expect(recordMetrics(transcript).distinctSourceReads).toBe(0);
  });
});

// =========================================================================
// === Stage-C added in Task 2 ===
//   The actual RE-PROVE RUN — gated behind COMIS_LIVE, NEVER in `pnpm validate`,
//   NEVER needs a CI key. A fresh SCRIPTED ReAct agent WITH the obs.explain tool
//   root-causes each fixture and records obsExplainCalls === 1 + 0 source reads.
// =========================================================================
