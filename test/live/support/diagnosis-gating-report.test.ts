// SPDX-License-Identifier: Apache-2.0
/**
 * RED-first unit tests for the per-failure-class gating-report builder.
 *
 * This is the metric-bearing analysis that GATES the downstream obs-surface
 * build-out (the reorder/trim signal), so it is RED→GREEN unit-tested BEFORE the
 * Stage-C run consumes it — the `--selftest` discipline.
 *
 * Stage-A (always-on, keyless): runs in `pnpm validate`. NO COMIS_LIVE gate.
 *
 * NOTE on the run command: these `support/*.test.ts` files are NOT in the ROOT
 * vitest workspace (`projects: ["packages/*", …]`), so a bare `pnpm vitest run`
 * resolves the root config and runs NOTHING (a false-RED). Verify under the LIVE
 * config: `pnpm vitest run --config test/live/vitest.config.ts <file>` (the same
 * path test/live/support tests actually run under).
 *
 * @module
 */

import { describe, it, expect } from "vitest";
import type { DiagnosisVerdictRow } from "./diagnosis-harness.js";
import { buildGatingTable, renderGatingMarkdown } from "./diagnosis-gating-report.js";

/** A minimal DiagnosisVerdictRow factory — overlay only the fields a case asserts on. */
function row(overrides: Partial<DiagnosisVerdictRow>): DiagnosisVerdictRow {
  return {
    fixtureId: "fx",
    failureClass: "503-breaker",
    rootCauseReached: false,
    totalTokens: 0,
    distinctToolCalls: 0,
    distinctSourceReads: 0,
    judgeVerdict: "skip",
    surfacesUsed: [],
    ...overrides,
  };
}

describe("buildGatingTable — per-failure-class trim/build recommendation", () => {
  it("buildGatingTable flags a 0-read 1-call reached class as a trim candidate", () => {
    const table = buildGatingTable([
      row({
        failureClass: "exec-modulenotfound",
        rootCauseReached: true,
        distinctSourceReads: 0,
        distinctToolCalls: 1,
        judgeVerdict: "pass",
      }),
    ]);
    expect(table).toHaveLength(1);
    expect(table[0]!.existingRpcSuffices).toBe(true);
    expect(table[0]!.recommendation).toMatch(/TRIM/);
    expect(table[0]!.failureClass).toBe("exec-modulenotfound");
  });

  it("buildGatingTable marks a multi-read class as build-needed", () => {
    const table = buildGatingTable([
      row({
        failureClass: "historical-c53ab0f",
        rootCauseReached: true,
        distinctSourceReads: 3,
        distinctToolCalls: 2,
        judgeVerdict: "pass",
      }),
    ]);
    expect(table[0]!.existingRpcSuffices).toBe(false);
    expect(table[0]!.recommendation).toMatch(/BUILD/);
    // The BUILD recommendation surfaces the cost it must drive to zero.
    expect(table[0]!.recommendation).toMatch(/3/);
  });

  it("buildGatingTable marks a judge-skipped class inconclusive", () => {
    const table = buildGatingTable([
      row({ failureClass: "provider-timeout", rootCauseReached: "skip", judgeVerdict: "skip" }),
    ]);
    expect(table[0]!.existingRpcSuffices).toBe(false);
    expect(table[0]!.recommendation).toMatch(/INCONCLUSIVE/);
  });

  it("buildGatingTable distinguishes a budget-skipped (never-measured) class from a judge-skip", () => {
    // A class the budget cut off before it ran is NOT measured-but-inconclusive —
    // the reader must be able to tell "never measured" from "measured, no key".
    // The scenario records the budget-skip via a `budget-skipped` surfacesUsed marker.
    const table = buildGatingTable([
      row({
        failureClass: "provider-timeout",
        rootCauseReached: "skip",
        judgeVerdict: "skip",
        surfacesUsed: ["budget-skipped"],
      }),
    ]);
    expect(table[0]!.existingRpcSuffices).toBe(false);
    // A never-measured class must be flagged distinctly (NOT a plain judge-skip),
    // and never as a TRIM-CANDIDATE.
    expect(table[0]!.recommendation).toMatch(/NOT MEASURED|BUDGET-SKIPPED/);
    expect(table[0]!.recommendation).not.toMatch(/TRIM-CANDIDATE/);
  });

  it("buildGatingTable does NOT flag a 1-call class as a trim candidate when it was NOT reached", () => {
    // existingRpcSuffices requires rootCauseReached===true — a cheap-but-wrong
    // diagnosis must NOT trim a downstream phase.
    const table = buildGatingTable([
      row({
        failureClass: "budget-exhaustion",
        rootCauseReached: false,
        distinctSourceReads: 0,
        distinctToolCalls: 1,
        judgeVerdict: "fail",
      }),
    ]);
    expect(table[0]!.existingRpcSuffices).toBe(false);
    expect(table[0]!.recommendation).toMatch(/BUILD/);
  });

  it("renderGatingMarkdown emits a row per class and a trim-candidate count", () => {
    const table = buildGatingTable([
      row({
        fixtureId: "live-exec-modulenotfound",
        failureClass: "exec-modulenotfound",
        rootCauseReached: true,
        distinctSourceReads: 0,
        distinctToolCalls: 1,
        judgeVerdict: "pass",
      }),
      row({
        fixtureId: "session-678314278",
        failureClass: "historical-c53ab0f",
        rootCauseReached: true,
        distinctSourceReads: 3,
        distinctToolCalls: 2,
        judgeVerdict: "pass",
      }),
    ]);
    const md = renderGatingMarkdown(table);
    // both failure classes appear as rows
    expect(md).toContain("exec-modulenotfound");
    expect(md).toContain("historical-c53ab0f");
    // a trim-candidate count summary (exactly 1 trim candidate here)
    expect(md).toMatch(/TRIM-CANDIDATE/);
    expect(md).toMatch(/1/);
    // markdown table structure
    expect(md).toContain("| Failure class |");
  });

  it("renderGatingMarkdown flags the budget-skipped count so a partial corpus is not read as complete", () => {
    // 1 measured class + 2 budget-skipped: the table must not present this as a
    // clean 3-class gate. The summary must surface that 2 classes were not measured.
    const table = buildGatingTable([
      row({
        fixtureId: "live-exec-modulenotfound",
        failureClass: "exec-modulenotfound",
        rootCauseReached: true,
        distinctSourceReads: 0,
        distinctToolCalls: 1,
        judgeVerdict: "pass",
      }),
      row({
        fixtureId: "live-budget-exhaustion",
        failureClass: "budget-exhaustion",
        rootCauseReached: "skip",
        judgeVerdict: "skip",
        surfacesUsed: ["budget-skipped"],
      }),
      row({
        fixtureId: "live-provider-timeout",
        failureClass: "provider-timeout",
        rootCauseReached: "skip",
        judgeVerdict: "skip",
        surfacesUsed: ["budget-skipped"],
      }),
    ]);
    const md = renderGatingMarkdown(table);
    // The summary must call out the not-measured count (2) — a reader must not
    // mistake a 33%-measured corpus for a complete gate.
    expect(md).toMatch(/2 .*not measured|not measured.*2|budget-skipped/i);
  });

  it("renderGatingMarkdown output passes the secret sweep (defense-in-depth)", async () => {
    const { assertNoSecrets } = await import("../cost.js");
    const md = renderGatingMarkdown(
      buildGatingTable([
        row({ failureClass: "503-breaker", rootCauseReached: "skip", judgeVerdict: "skip" }),
      ]),
    );
    expect(() => assertNoSecrets(md, "gating table")).not.toThrow();
  });
});
