// SPDX-License-Identifier: Apache-2.0
/**
 * `obs-explain-heuristics` — deterministic root-cause registry tests (Plan 05,
 * Task 1).
 *
 * Pins the ORDERING that makes BOTH frozen Phase-149 fixtures pass:
 *   - 678 signals carry hasMisclassificationSignal AND hasDoNotRetrySignal AND a
 *     breakerOpenedTool (the breaker tripped on the misclassified successes) →
 *     content_heuristic_misclassification wins (it is the ROOT; the breaker is
 *     downstream).
 *   - 503 signals carry ONLY the breaker/repeated-failure signal (no
 *     misclassification — a real transport failure) → breaker_opened_repeated_failure.
 *
 * Plus the three insurance codes (exec_dependency / provider_timeout /
 * context_bloat) and the no-match null. Every RootCause is fully populated
 * (code + detail + non-empty suggestedNextSteps:string[]).
 *
 * @module
 */
import { describe, it, expect } from "vitest";
import type { IncidentSignals } from "@comis/core";
import { HEURISTICS, rootCause } from "./obs-explain-heuristics.js";

/** Build a minimal IncidentSignals with only the fields a test cares about. */
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
  };
}

describe("obs-explain-heuristics", () => {
  // ------------------------------------------------------------------------
  // The X3-mandated ordering: misclassification (root) over breaker (symptom).
  // ------------------------------------------------------------------------

  it("678: misclassification+breaker both present → content_heuristic_misclassification (root over symptom)", () => {
    const r = rootCause(
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
    expect(r).not.toBeNull();
    expect(r!.code).toBe("content_heuristic_misclassification");
    expect(r!.detail).toMatch(/web_fetch/);
    expect(r!.detail).toMatch(/403|status|token/);
    expect(Array.isArray(r!.suggestedNextSteps)).toBe(true);
    expect(r!.suggestedNextSteps.length).toBeGreaterThan(0);
  });

  it("503: breaker signal, no misclassification → breaker_opened_repeated_failure (+toolName)", () => {
    const r = rootCause(
      makeSignals({
        hasMisclassificationSignal: false,
        hasDoNotRetrySignal: true,
        breakerOpenedTool: "web_fetch",
        repeatedFailureCount: { web_fetch: 5 },
        mostFailedTool: "web_fetch",
      }),
    );
    expect(r).not.toBeNull();
    expect(r!.code).toBe("breaker_opened_repeated_failure");
    expect(r!.detail).toMatch(/web_fetch/);
    expect(r!.suggestedNextSteps.length).toBeGreaterThan(0);
  });

  it("503 via repeated-failure only (no breaker event, no DO NOT retry) → breaker_opened_repeated_failure", () => {
    const r = rootCause(
      makeSignals({
        hasMisclassificationSignal: false,
        breakerOpenedTool: undefined,
        hasDoNotRetrySignal: false,
        repeatedFailureCount: { web_fetch: 6 },
        mostFailedTool: "web_fetch",
      }),
    );
    expect(r).not.toBeNull();
    expect(r!.code).toBe("breaker_opened_repeated_failure");
    expect(r!.detail).toMatch(/web_fetch/);
  });

  it("repeated-failure BELOW BREAKER_N (and no breaker/DO-NOT-retry) does NOT trip the breaker rule", () => {
    const r = rootCause(
      makeSignals({
        hasMisclassificationSignal: false,
        breakerOpenedTool: undefined,
        hasDoNotRetrySignal: false,
        repeatedFailureCount: { web_fetch: 2 },
        mostFailedTool: "web_fetch",
      }),
    );
    // 2 < BREAKER_N(5), no breaker event, no DO NOT retry → breaker rule must not fire.
    expect(r?.code).not.toBe("breaker_opened_repeated_failure");
  });

  // ------------------------------------------------------------------------
  // Insurance codes (low-risk corpus coverage for 156/G1).
  // ------------------------------------------------------------------------

  it("insurance: exec_dependency (errorKind dependency + ModuleNotFoundError in preview)", () => {
    const r = rootCause(
      makeSignals({
        failures: [
          {
            seq: 0,
            toolName: "code_exec",
            classifiedFailureBy: "",
            transportOk: false,
            errorKind: "dependency",
            resultDigest: "abc",
            resultBytes: 10,
            errorPreview: "Traceback: ModuleNotFoundError: No module named 'numpy'",
          },
        ],
      }),
    );
    expect(r).not.toBeNull();
    expect(r!.code).toBe("exec_dependency");
    expect(r!.suggestedNextSteps.length).toBeGreaterThan(0);
  });

  it("insurance: exec_dependency also matches 'Cannot find module'", () => {
    const r = rootCause(
      makeSignals({
        failures: [
          {
            seq: 0,
            toolName: "shell",
            classifiedFailureBy: "",
            transportOk: false,
            errorKind: "dependency",
            resultDigest: "abc",
            resultBytes: 10,
            errorPreview: "Error: Cannot find module 'left-pad'",
          },
        ],
      }),
    );
    expect(r?.code).toBe("exec_dependency");
  });

  it("insurance: provider_timeout (errorKind timeout)", () => {
    const r = rootCause(
      makeSignals({
        failures: [
          {
            seq: 0,
            toolName: "llm_call",
            classifiedFailureBy: "",
            transportOk: false,
            errorKind: "timeout",
            resultDigest: "abc",
            resultBytes: 10,
            errorPreview: "request timed out after 60000ms",
          },
        ],
      }),
    );
    expect(r).not.toBeNull();
    expect(r!.code).toBe("provider_timeout");
    expect(r!.suggestedNextSteps.length).toBeGreaterThan(0);
  });

  it("insurance: context_bloat (offloads ≥ N + token spike)", () => {
    const r = rootCause(
      makeSignals({
        offloads: [
          { seq: 0, toolName: "web_fetch", originalChars: 53095, pointer: "x" },
          { seq: 1, toolName: "web_fetch", originalChars: 41000, pointer: "y" },
          { seq: 2, toolName: "read_file", originalChars: 22000, pointer: "z" },
        ],
      }),
    );
    expect(r).not.toBeNull();
    expect(r!.code).toBe("context_bloat");
    expect(r!.suggestedNextSteps.length).toBeGreaterThan(0);
  });

  // ------------------------------------------------------------------------
  // QT2/QT3 — the two NAMED degradation causes surface as likelyRootCause.
  // Keyed on the (metadata-derived) endReason, lowest priority (a tool-failure
  // cause out-ranks them — they explain the terminal state, not a tool crash).
  // ------------------------------------------------------------------------

  it("QT2: endReason=context_exhausted (no tool-failure signal) → context_exhausted root cause", () => {
    const r = rootCause(makeSignals({ endReason: "context_exhausted" }));
    expect(r).not.toBeNull();
    expect(r!.code).toBe("context_exhausted");
    // The hint names the actionable lever (summarizer spend / compaction floor).
    expect(r!.detail).toMatch(/context/i);
    expect(r!.suggestedNextSteps.length).toBeGreaterThan(0);
    expect(r!.suggestedNextSteps.some((s) => /summariz|compact|context/i.test(s))).toBe(true);
  });

  it("QT3: endReason=output_starved (no tool-failure signal) → output_starved root cause", () => {
    const r = rootCause(makeSignals({ endReason: "output_starved" }));
    expect(r).not.toBeNull();
    expect(r!.code).toBe("output_starved");
    expect(r!.detail).toMatch(/output|truncat/i);
    expect(r!.suggestedNextSteps.length).toBeGreaterThan(0);
    expect(r!.suggestedNextSteps.some((s) => /maxTokens|output|truncat/i.test(s))).toBe(true);
  });

  it("a tool-failure cause OUT-RANKS the endReason cause (the new heuristics are lowest priority)", () => {
    // A misclassified-tool session that ALSO ended context_exhausted must still
    // report the upstream tool cause — the endReason heuristic is the fallback.
    const r = rootCause(
      makeSignals({
        endReason: "context_exhausted",
        hasMisclassificationSignal: true,
        misclassifiedTool: "web_fetch",
        misclassifiedToken: "403",
      }),
    );
    expect(r!.code).toBe("content_heuristic_misclassification");
  });

  it("a clean endReason (success) does NOT trip the named-cause heuristics", () => {
    // success / end_turn / a non-cause endReason must NOT produce a verdict from
    // the QT2/QT3 rules (no false degradation cause on a healthy session).
    expect(rootCause(makeSignals({ endReason: "success" }))).toBeNull();
    expect(rootCause(makeSignals({ endReason: "completed_with_tool_errors" }))).toBeNull();
  });

  // ------------------------------------------------------------------------
  // No-match + populated-shape invariants.
  // ------------------------------------------------------------------------

  it("clean signals → rootCause returns null", () => {
    expect(rootCause(makeSignals())).toBeNull();
  });

  it("every RootCause a rule can emit is fully populated (code + detail + string[] steps)", () => {
    // Drive each rule with a signal that trips it, then assert the shape.
    const trippers: IncidentSignals[] = [
      makeSignals({ hasMisclassificationSignal: true, misclassifiedTool: "web_fetch", misclassifiedToken: "403" }),
      makeSignals({ breakerOpenedTool: "web_fetch", hasDoNotRetrySignal: true, mostFailedTool: "web_fetch", repeatedFailureCount: { web_fetch: 5 } }),
      makeSignals({ offloads: [
        { seq: 0, toolName: "t", originalChars: 53095, pointer: "p" },
        { seq: 1, toolName: "t", originalChars: 41000, pointer: "p" },
        { seq: 2, toolName: "t", originalChars: 22000, pointer: "p" },
      ] }),
      makeSignals({ failures: [{ seq: 0, toolName: "x", classifiedFailureBy: "", transportOk: false, errorKind: "dependency", resultDigest: "d", resultBytes: 1, errorPreview: "ModuleNotFoundError: nope" }] }),
      makeSignals({ failures: [{ seq: 0, toolName: "x", classifiedFailureBy: "", transportOk: false, errorKind: "timeout", resultDigest: "d", resultBytes: 1, errorPreview: "timed out" }] }),
    ];
    for (const s of trippers) {
      const r = rootCause(s);
      expect(r).not.toBeNull();
      expect(typeof r!.code).toBe("string");
      expect(r!.code.length).toBeGreaterThan(0);
      expect(typeof r!.detail).toBe("string");
      expect(r!.detail.length).toBeGreaterThan(0);
      expect(Array.isArray(r!.suggestedNextSteps)).toBe(true);
      expect(r!.suggestedNextSteps.length).toBeGreaterThan(0);
      expect(r!.suggestedNextSteps.every((x) => typeof x === "string" && x.length > 0)).toBe(true);
    }
  });

  it("HEURISTICS is a non-empty ordered ReadonlyArray of predicate functions", () => {
    expect(Array.isArray(HEURISTICS)).toBe(true);
    expect(HEURISTICS.length).toBeGreaterThanOrEqual(5);
    for (const h of HEURISTICS) expect(typeof h).toBe("function");
  });

  it("detail strings never contain a literal '${' (interpolation-bug guard)", () => {
    const r = rootCause(
      makeSignals({ breakerOpenedTool: "web_fetch", hasDoNotRetrySignal: true, mostFailedTool: "web_fetch", repeatedFailureCount: { web_fetch: 5 } }),
    );
    expect(r!.detail).not.toContain("${");
    expect(r!.suggestedNextSteps.join(" ")).not.toContain("${");
  });
});
