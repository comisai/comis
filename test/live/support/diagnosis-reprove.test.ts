// SPDX-License-Identifier: Apache-2.0
/**
 * RED-first self-test for the Phase-156 RE-PROVE substrate (G1 FOUNDATION).
 *
 * Two seams, both Tests-First:
 *
 *   1. The `@comis/daemon` barrel re-export of the FROZEN Phase-153 assembler
 *      (`assembleIncidentReportFromSources` + `makeRealReader` + the
 *      `IncidentSourceReader` type). The import below is the RED for the daemon
 *      export — it resolves to `daemon/dist/index.js` (the
 *      `test/live/vitest.config.ts:36` alias), which does NOT carry the symbol
 *      until the 3-line export + `pnpm build` turn it GREEN. NEVER a deep
 *      `daemon/dist/...` path.
 *
 *   2. The pure RE-PROVE assert module `diagnosis-reprove.ts`
 *      (`countObsExplainCalls` + the field-level 678/503 IncidentReport
 *      asserts). The imports from `./diagnosis-reprove.js` are RED until the
 *      module is created.
 *
 * Runs KEYLESS in `pnpm validate` — no COMIS_LIVE, no daemon, no token: the
 * field-level asserts call the assembler over a local fixture reader (the
 * `obs-explain.test.ts:56-64` shape) over the two committed fixtures.
 *
 * @module
 */

import { describe, it, expect } from "vitest";
import { resolve } from "node:path";
// The barrel re-export (Task 1 GREEN). This bare-package import via the
// test/live alias is the RED for the daemon export.
import {
  assembleIncidentReportFromSources,
  makeRealReader,
  type IncidentSourceReader,
} from "@comis/daemon";
import type { IncidentReport } from "@comis/core";
// The pure assert module under test (Task 2 GREEN).
import {
  countObsExplainCalls,
  assert678Report,
  assert503Report,
  OBS_EXPLAIN_TOOL_NAME,
} from "./diagnosis-reprove.js";
import { loadFixture, recordMetrics, type AgentTurn } from "./diagnosis-harness.js";

// 2 levels up from test/live/support → repo root, then the frozen fixtures.
const FIXTURES = resolve(__dirname, "../fixtures/diagnosis");

/**
 * A reader backed by a frozen fixture directory (the obs-explain.test.ts:56-64
 * shape). `readSessionRecords` ignores the sessionKey (returns the fixture's
 * records for any key), so the assembler runs the REAL signals → assemble →
 * rootCause → bound pipeline over committed data, keyless.
 */
function makeFixtureReader(fixtureName: string): IncidentSourceReader {
  const { events, meta } = loadFixture(resolve(FIXTURES, fixtureName));
  return {
    readSessionRecords: async () => events,
    readCacheTraceRecords: async () => [],
    readSessionMetadata: async () => meta as Record<string, unknown>,
    readDiagnosticsRollup: async () => null,
  };
}

/** Call the FROZEN assembler over a fixture's reader (the 1-call/0-reads tool). */
async function obsExplainOverFixture(fixtureName: string): Promise<IncidentReport> {
  return assembleIncidentReportFromSources(makeFixtureReader(fixtureName), ".", {
    sessionKey: "default:x:x:peer:x", // the fixture reader ignores the key
    depth: "summary", // ≤6 KB bounded (X2)
  });
}

describe("DIAG-reprove substrate — @comis/daemon re-exports the obs-explain assembler (Task 1)", () => {
  it("the barrel exposes the gate-free assembler + reader seam as callable values", () => {
    expect(typeof assembleIncidentReportFromSources).toBe("function");
    expect(typeof makeRealReader).toBe("function");
  });
});

describe("DIAG-reprove substrate — countObsExplainCalls + recordMetrics over a synthetic transcript (Task 2)", () => {
  it("counts exactly 1 obs_explain call and 0 source reads over a 1-call/0-reads transcript", () => {
    // A synthetic transcript: a single assistant turn that calls obs_explain
    // ONCE and reads NO source files (the G1 proof shape). Uses the wire-safe
    // OBS_EXPLAIN_TOOL_NAME — the SAME string the live manifest ships (CR-01).
    const transcript: AgentTurn[] = [
      {
        role: "assistant",
        toolCalls: [
          { name: OBS_EXPLAIN_TOOL_NAME, arguments: JSON.stringify({ sessionKey: "x", depth: "summary" }) },
        ],
        usage: { totalTokens: 1430 },
      },
      {
        role: "assistant",
        content: "Root cause: the web_fetch content heuristic misclassified a 200 as a failure.",
        usage: { totalTokens: 90 },
      },
    ];
    expect(countObsExplainCalls(transcript)).toBe(1);
    // recordMetrics is reused VERBATIM — distinctSourceReads is the G1 zero-reads proof.
    expect(recordMetrics(transcript).distinctSourceReads).toBe(0);
  });

  it("a nameless tool call is not counted as an obs_explain invocation", () => {
    const transcript: AgentTurn[] = [
      { role: "assistant", toolCalls: [{ name: "", arguments: "{}" }] },
      {
        role: "assistant",
        toolCalls: [{ name: OBS_EXPLAIN_TOOL_NAME, arguments: JSON.stringify({ sessionKey: "y" }) }],
      },
    ];
    expect(countObsExplainCalls(transcript)).toBe(1);
  });
});

describe("DIAG-reprove substrate — field-level IncidentReport asserts over the real fixtures (Task 2)", () => {
  it("678 fixture: assert678Report passes (content_heuristic_misclassification + degraded + breakerTimeline + costUsd) via the barrel assembler", async () => {
    const report = await obsExplainOverFixture("session-678314278");
    // FIELD-LEVEL (NOT compareToAnswerKey — the 678 report resolves token=status,
    // never the literal "403" the answer-key requires).
    expect(() => assert678Report(report)).not.toThrow();
  });

  it("503 fixture: assert503Report passes (breaker_opened_repeated_failure + web_fetch + degraded) via the barrel assembler", async () => {
    const report = await obsExplainOverFixture("live-503-breaker");
    expect(() => assert503Report(report)).not.toThrow();
  });

  it("assert678Report throws field-name-only (no report body) on a non-678 report", async () => {
    const report503 = await obsExplainOverFixture("live-503-breaker");
    // The 503 report has a different likelyRootCause.code → 678 assert must fail.
    expect(() => assert678Report(report503)).toThrow(/678 report/);
    // Residency: the throw must NOT echo the report body (only a field name).
    try {
      assert678Report(report503);
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).not.toContain("breaker_opened_repeated_failure");
      expect(msg).not.toContain("web_fetch");
    }
  });
});
