// SPDX-License-Identifier: Apache-2.0
/**
 * Co-located unit coverage for `orchestrateFailedVerdict` in
 * `obs-explain-orchestrate-verdict.ts` — the deterministic `orchestrate_failed`
 * root-cause verdict.
 *
 * It fires when an `orchestrate` PTC run exited non-zero (`outcome:"failure"`) OR
 * carried an in-jail `tool.invoke` denial (`decision:"deny"`), and returns `null`
 * on a clean/absent section. PURE: same signals ⇒ same verdict (asserted with an
 * idempotence check). The registry block proves the acute-tier insert leaves the
 * established cost and breaker fixtures' verdicts unchanged (first-match-wins ordering).
 *
 * @module
 */
import { describe, it, expect } from "vitest";
import type { IncidentSignals } from "@comis/core";
import { orchestrateFailedVerdict } from "./obs-explain-orchestrate-verdict.js";
import { rootCause } from "./obs-explain-heuristics.js";

/** The OrchestrateRun element type, derived from the signal (no separate import). */
type OrchestrateRun = NonNullable<IncidentSignals["orchestrate"]>[number];

/** A minimal clean orchestrate run; overrides steer outcome / toolCalls / failureClass. */
function makeRun(overrides: Partial<OrchestrateRun> = {}): OrchestrateRun {
  return {
    runId: "run-1",
    outcome: "success",
    durationMs: 500,
    exitCode: 0,
    toolCalls: [],
    resultRefs: { count: 0, bytes: 0 },
    ...overrides,
  };
}

/** Wrap runs into a minimal IncidentSignals (only s.orchestrate matters for the verdict). */
function withOrchestrate(runs: OrchestrateRun[] | undefined): IncidentSignals {
  return { orchestrate: runs } as IncidentSignals;
}

/** Full IncidentSignals factory for the registry / no-reorder integration block. */
function makeSignals(overrides?: Partial<IncidentSignals>): IncidentSignals {
  return {
    sessionKey: "test-session",
    toolStats: {},
    failures: [],
    breakerEvents: [],
    offloads: [],
    hasDoNotRetrySignal: false,
    repeatedFailureCount: {},
    hasMisclassificationSignal: false,
    ...overrides,
  } as IncidentSignals;
}

describe("orchestrateFailedVerdict (deterministic orchestrate_failed verdict)", () => {
  it("fires code 'orchestrate_failed' naming the failureClass + exitCode on a non-zero-exit run", () => {
    const v = orchestrateFailedVerdict(
      withOrchestrate([makeRun({ outcome: "failure", exitCode: 1, failureClass: "nonzero_exit" })]),
    );
    expect(v).not.toBeNull();
    expect(v!.code).toBe("orchestrate_failed");
    expect(v!.detail).toMatch(/nonzero_exit/); // names the closed failureClass
    expect(v!.detail).toMatch(/\b1\b/); // names the numeric exitCode
    expect(v!.suggestedNextSteps.length).toBeGreaterThan(0);
  });

  it("fires on a successful run that carried an in-jail capability denial (a deny is a failure signal)", () => {
    const v = orchestrateFailedVerdict(
      withOrchestrate([
        makeRun({
          outcome: "success",
          exitCode: 0,
          toolCalls: [{ tool: "web_fetch", capability: "orch:web", decision: "deny", count: 1 }],
        }),
      ]),
    );
    expect(v).not.toBeNull();
    expect(v!.code).toBe("orchestrate_failed");
    expect(v!.detail).toMatch(/orch:web/); // names the denied capability id (content-free)
  });

  it("returns null on a clean successful-only run (allow-decision tool calls, exit 0)", () => {
    const v = orchestrateFailedVerdict(
      withOrchestrate([
        makeRun({
          outcome: "success",
          exitCode: 0,
          toolCalls: [{ tool: "web_fetch", capability: "orch:web", decision: "allow", count: 2 }],
        }),
      ]),
    );
    expect(v).toBeNull();
  });

  it("returns null when s.orchestrate is undefined (no section → cannot regress the frozen fixtures)", () => {
    expect(orchestrateFailedVerdict(withOrchestrate(undefined))).toBeNull();
    expect(orchestrateFailedVerdict({} as IncidentSignals)).toBeNull();
  });

  it("returns null on an empty orchestrate array (the section present but carrying no runs)", () => {
    expect(orchestrateFailedVerdict(withOrchestrate([]))).toBeNull();
  });

  it("is DETERMINISTIC — two calls on identical signals return deep-equal verdicts (no LLM, no clock)", () => {
    const s = withOrchestrate([
      makeRun({ outcome: "failure", exitCode: 2, failureClass: "timeout" }),
      makeRun({
        runId: "run-2",
        outcome: "success",
        toolCalls: [{ tool: "shell", capability: "orch:exec", decision: "deny", count: 3 }],
      }),
    ]);
    expect(orchestrateFailedVerdict(s)).toEqual(orchestrateFailedVerdict(s));
  });

  it("detail is content-free — names the failed-of-total run count + failureClass, never a body/stderr", () => {
    const v = orchestrateFailedVerdict(
      withOrchestrate([
        makeRun({ outcome: "failure", exitCode: 137, failureClass: "stdout_cap" }),
        makeRun({ runId: "run-2", outcome: "success" }),
      ]),
    );
    expect(v!.detail).toMatch(/1 of 2/); // failed-of-total count
    expect(v!.detail).toMatch(/stdout_cap/);
  });
});

describe("orchestrate_failed registry insert preserves first-match ordering", () => {
  it("rootCause() returns orchestrate_failed for a failed orchestrate run with no other signal", () => {
    const r = rootCause(
      makeSignals({
        orchestrate: [makeRun({ outcome: "failure", exitCode: 1, failureClass: "nonzero_exit" })],
      }),
    );
    expect(r).not.toBeNull();
    expect(r!.code).toBe("orchestrate_failed");
  });

  it("rootCause() returns null on a clean orchestrate-only session (no failure, no deny)", () => {
    const r = rootCause(makeSignals({ orchestrate: [makeRun({ outcome: "success" })] }));
    expect(r).toBeNull();
  });

  it("keeps the established misclassification verdict ahead of the orchestrate rule", () => {
    const misclassificationResult = rootCause(
      makeSignals({
        hasMisclassificationSignal: true,
        misclassifiedTool: "web_fetch",
        misclassifiedToken: "403",
        hasDoNotRetrySignal: true,
        breakerOpenedTool: "web_fetch",
        repeatedFailureCount: { web_fetch: 14 },
        mostFailedTool: "web_fetch",
      }),
    );
    expect(misclassificationResult!.code).toBe("content_heuristic_misclassification");
  });

  it("keeps the established breaker verdict ahead of the orchestrate rule", () => {
    const breakerResult = rootCause(
      makeSignals({
        hasMisclassificationSignal: false,
        hasDoNotRetrySignal: true,
        breakerOpenedTool: "web_fetch",
        repeatedFailureCount: { web_fetch: 5 },
        mostFailedTool: "web_fetch",
      }),
    );
    expect(breakerResult!.code).toBe("breaker_opened_repeated_failure");
  });

  it("a failed orchestrate run OUT-RANKS the completed_with_tool_errors catch-all (specific over generic)", () => {
    // A run failed AND an unrelated stray tool failure exists (errorKind that
    // matches NO earlier named rule) — the specific orchestrate verdict wins over
    // the generic tool-failure catch-all directly below it.
    const r = rootCause(
      makeSignals({
        orchestrate: [makeRun({ outcome: "failure", exitCode: 1, failureClass: "spawn_fail" })],
        failures: [
          {
            seq: 0,
            toolName: "read",
            classifiedFailureBy: "",
            transportOk: false,
            errorKind: "validation",
            resultDigest: "x",
            resultBytes: 5,
            errorPreview: "EISDIR: illegal operation on a directory, read",
          },
        ],
      }),
    );
    expect(r!.code).toBe("orchestrate_failed");
  });
});
