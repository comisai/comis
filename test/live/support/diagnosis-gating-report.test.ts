// SPDX-License-Identifier: Apache-2.0
/**
 * RED-first unit tests for the per-failure-class gating-report builder
 * (Phase 149 — PROVE: LLM-diagnosis baseline, success criterion #3).
 *
 * This is the metric-bearing analysis that GATES phases 150-155 (the reorder/trim
 * signal), so it is RED→GREEN unit-tested BEFORE the Stage-C run consumes it —
 * the `--selftest` discipline (scripts/bench-small-model/run.mjs:120-182).
 *
 * Stage-A (always-on, keyless): runs in `pnpm validate`. NO COMIS_LIVE gate.
 *
 * NOTE on the run command: these `support/*.test.ts` files are NOT in the ROOT
 * vitest workspace (`projects: ["packages/*", …]`), so a bare `pnpm vitest run`
 * resolves the root config and runs NOTHING (a false-RED). Verify under the LIVE
 * config: `pnpm vitest run --config test/live/vitest.config.ts <file>` (the same
 * path test/live/support tests actually run under — 149-01-SUMMARY decision #5).
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
