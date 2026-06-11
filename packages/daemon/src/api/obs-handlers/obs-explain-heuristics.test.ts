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

// ---------------------------------------------------------------------------
// W3 (obs-llm-troubleshooting): budget-evidence-specific context_exhausted
// verdict. The generic summarizer-speculation text actively misdirected the
// live incident (the real cause was the small-class window cap + tool-schema
// dominance — summarizerSpend would have done nothing).
// ---------------------------------------------------------------------------

describe("context_exhausted with budget evidence (W3)", () => {
  const BUDGET = {
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

  it("names the assembled/window numbers, the raw window, the system share, and kept history in the detail", () => {
    const r = rootCause(makeSignals({ endReason: "context_exhausted", contextBudget: BUDGET }));
    expect(r).not.toBeNull();
    expect(r!.code).toBe("context_exhausted");
    expect(r!.detail).toContain("31572");
    expect(r!.detail).toContain("32000");
    expect(r!.detail).toContain("131072");
    expect(r!.detail).toContain("80%");
    expect(r!.detail).toContain("history kept: 0");
  });

  it("suggests raising the named cap knob and reducing the tool surface when capped and schema-dominated", () => {
    const r = rootCause(makeSignals({ endReason: "context_exhausted", contextBudget: BUDGET }));
    const steps = r!.suggestedNextSteps.join(" | ");
    expect(steps).toContain("contextEngine.budget.effectiveContextCapSmall");
    expect(steps).toContain("tool");
  });

  it("uncapped budget evidence does not point at a cap knob", () => {
    const r = rootCause(
      makeSignals({
        endReason: "context_exhausted",
        contextBudget: { ...BUDGET, rawContextWindowTokens: 32_000, windowCapSource: "none" as const },
      }),
    );
    expect(r!.code).toBe("context_exhausted");
    expect(r!.suggestedNextSteps.join(" | ")).not.toContain("effectiveContextCapSmall");
  });

  it("falls back to the generic terminal verdict when no budget evidence exists (pre-W2 session)", () => {
    const r = rootCause(makeSignals({ endReason: "context_exhausted" }));
    expect(r!.code).toBe("context_exhausted");
    expect(r!.detail).toContain("context exhausted");
    expect(r!.suggestedNextSteps.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// KNOB-02 (Phase 176): served-bound context_exhausted verdict. The cap branch
// templates `contextEngine.budget.${windowCapSource}` — for the new "served"
// member that renders the NONSENSE knob `contextEngine.budget.served` (it is
// not a config key; the real knobs are Ollama's OLLAMA_CONTEXT_LENGTH env /
// Modelfile PARAMETER num_ctx). Both template sites must branch by source.
// ---------------------------------------------------------------------------

describe("context_exhausted with served-bound budget evidence (KNOB-02)", () => {
  const SERVED_BUDGET = {
    windowTokens: 8_192,
    rawContextWindowTokens: 131_072,
    windowCapSource: "served" as const,
    systemTokens: 5_000,
    freshTailTokens: 1_000,
    budgetedHistoryTokens: 1_500,
    keptCount: 3,
    assembledInputTokens: 7_500,
    outputHeadroom: 1_792,
    verdict: "exhausted" as const,
  };

  it("KNOB-02-23: a served-bound verdict names the Ollama knobs + the configured number and NEVER renders contextEngine.budget.served", () => {
    const r = rootCause(makeSignals({ endReason: "context_exhausted", contextBudget: SERVED_BUDGET }));
    expect(r).not.toBeNull();
    expect(r!.code).toBe("context_exhausted");
    // The detail names the TRUE configured window and the served-bound class.
    expect(r!.detail).toMatch(/model contextWindow 131072 but Ollama served a smaller window/);
    // The steps name the REAL knobs with the configured number.
    const steps = r!.suggestedNextSteps.join("\n");
    expect(steps).toMatch(/OLLAMA_CONTEXT_LENGTH=131072/);
    expect(steps).toMatch(/PARAMETER num_ctx 131072/);
    // The nonsense knob must never render anywhere in the verdict.
    expect(r!.detail).not.toMatch(/contextEngine\.budget\.served/);
    expect(steps).not.toMatch(/contextEngine\.budget\.served/);
  });

  it("KNOB-02-24: the effectiveContextCapSmall verdict wording is byte-identical to pre-patch (cap branch untouched)", () => {
    // The frozen W3 fixture — pins the EXACT pre-patch strings so the served
    // branch cannot perturb the cap-knob wording.
    const CAP_BUDGET = {
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
    const r = rootCause(makeSignals({ endReason: "context_exhausted", contextBudget: CAP_BUDGET }));
    expect(r!.detail).toBe(
      "context exhausted — the pre-flight guard aborted before the model could run: assembled 31572 tokens of effective window 32000 (model contextWindow 131072 capped by contextEngine.budget.effectiveContextCapSmall); system prompt + tool schemas = 25694 tokens (80% of the window); history kept: 0",
    );
    expect(r!.suggestedNextSteps).toEqual([
      "raise contextEngine.budget.effectiveContextCapSmall (0 = uncapped) — the model declares 131072 tokens but the effective window was 32000",
      "reduce the active tool surface (disable unused builtin tool groups / MCP servers) — tool schemas dominate the window",
      "obs.explain depth=full",
    ]);
  });

  it("WR-01: a capabilityClass-bound verdict names the pin lever and NEVER the inert budget knob nor a templated contextEngine.budget.capabilityClass", () => {
    // The executor's DEFAULT_EFFECTIVE_CAP_BY_CLASS cap (from the operator's
    // providers.entries.<id>.capabilities.capabilityClass pin) bound the window
    // upstream — raising contextEngine.budget.effectiveContextCapSmall (or
    // setting 0) changes NOTHING on this branch; suggesting it is the exact
    // dead-knob misdirection this phase kills.
    const PIN_BUDGET = {
      windowTokens: 32_000,
      rawContextWindowTokens: 131_072,
      windowCapSource: "capabilityClass" as const,
      systemTokens: 25_694,
      freshTailTokens: 5_272,
      budgetedHistoryTokens: 0,
      keptCount: 0,
      assembledInputTokens: 31_572,
      outputHeadroom: 768,
      verdict: "exhausted" as const,
    };
    const r = rootCause(makeSignals({ endReason: "context_exhausted", contextBudget: PIN_BUDGET }));
    expect(r).not.toBeNull();
    expect(r!.code).toBe("context_exhausted");
    // The detail names the pin as the clamp.
    expect(r!.detail).toMatch(
      /model contextWindow 131072 capped by the providers\.entries\.<id>\.capabilities\.capabilityClass pin/,
    );
    const steps = r!.suggestedNextSteps.join("\n");
    // The step names the working lever (the pin) with both numbers.
    expect(steps).toMatch(/providers\.entries\.<id>\.capabilities\.capabilityClass/);
    expect(steps).toMatch(/131072/);
    expect(steps).toMatch(/32000/);
    // The dead/nonsense knobs must never render anywhere in the verdict.
    expect(r!.detail).not.toMatch(/contextEngine\.budget\.capabilityClass/);
    expect(steps).not.toMatch(/contextEngine\.budget\.capabilityClass/);
    expect(steps).not.toMatch(/raise contextEngine\.budget\.effectiveContextCapSmall/);
  });
});

// ---------------------------------------------------------------------------
// GBNF-02 (Phase 175): tool_schema_unsupported — an acute, deterministic
// provider-schema rejection (grammar-compile/unmarshal 400). Placement is the
// ordering contract: AFTER the two X3-mandated codes (their frozen 678/503
// fixtures carry no schema-rejection records, so they cannot regress), BEFORE
// the insurance codes, and out-ranking the terminal-state explainers. Fires
// only when the one-shot strip-retry did NOT recover — a recovered repair is
// evidence, not a verdict.
// ---------------------------------------------------------------------------

describe("tool_schema_unsupported (GBNF-02)", () => {
  const UNRECOVERED = {
    toolNames: ["schedule_task"],
    strippedKeywords: ["pattern", "format"],
    retried: true,
    succeeded: false,
  };

  it("an unrecovered strip-retry names the tool, the attempted strip-retry, and the toolSchemaProfile knob", () => {
    const r = rootCause(makeSignals({ toolSchemaUnsupported: UNRECOVERED }));
    expect(r).not.toBeNull();
    expect(r!.code).toBe("tool_schema_unsupported");
    expect(r!.detail).toContain("schedule_task");
    expect(r!.detail).toContain("strip-pattern/format-retry");
    expect(r!.suggestedNextSteps[0]).toContain("comisCompat.toolSchemaProfile");
  });

  it("a RECOVERED repair (succeeded:true) does not fire — the repair is evidence, not the session's root cause", () => {
    const r = rootCause(makeSignals({ toolSchemaUnsupported: { ...UNRECOVERED, succeeded: true } }));
    expect(r).toBeNull();
  });

  it("retried:false explains that nothing was strippable so no retry was attempted", () => {
    const r = rootCause(makeSignals({ toolSchemaUnsupported: { ...UNRECOVERED, retried: false } }));
    expect(r).not.toBeNull();
    expect(r!.code).toBe("tool_schema_unsupported");
    expect(r!.detail).toContain("nothing strippable");
  });

  // WR-05 (175-REVIEW): gate-closed and nothing-to-strip terminals used to
  // emit indistinguishable payloads — with last-record-wins, a session that
  // healed once and then hit the gate produced a verdict claiming "nothing
  // strippable so no retry was attempted" when stripping WAS performed and a
  // retry WAS attempted earlier in the session. The reason discriminator
  // branches the detail.
  it("WR-05: reason gate_closed says the strip-retry was already attempted earlier this session — never 'nothing strippable'", () => {
    const r = rootCause(
      makeSignals({
        toolSchemaUnsupported: {
          toolNames: [],
          strippedKeywords: [],
          retried: false,
          succeeded: false,
          reason: "gate_closed",
        },
      }),
    );
    expect(r).not.toBeNull();
    expect(r!.code).toBe("tool_schema_unsupported");
    expect(r!.detail).toContain("already attempted earlier this session");
    expect(r!.detail).not.toContain("nothing strippable");
  });

  it("WR-05: reason nothing_to_strip keeps the nothing-strippable explanation", () => {
    const r = rootCause(
      makeSignals({
        toolSchemaUnsupported: {
          toolNames: [],
          strippedKeywords: [],
          retried: false,
          succeeded: false,
          reason: "nothing_to_strip",
        },
      }),
    );
    expect(r).not.toBeNull();
    expect(r!.detail).toContain("nothing strippable");
  });

  it("WR-05: an absent reason (historical pre-WR-05 record) falls back to the retried-based wording", () => {
    const r = rootCause(makeSignals({ toolSchemaUnsupported: { ...UNRECOVERED, retried: false } }));
    expect(r).not.toBeNull();
    expect(r!.detail).toContain("nothing strippable");
    const retriedForm = rootCause(makeSignals({ toolSchemaUnsupported: UNRECOVERED }));
    expect(retriedForm!.detail).toContain("strip-pattern/format-retry");
  });

  it("PRIORITY: the misclassification signal out-ranks tool_schema_unsupported (below X3 code #1)", () => {
    const r = rootCause(
      makeSignals({
        toolSchemaUnsupported: UNRECOVERED,
        hasMisclassificationSignal: true,
        misclassifiedTool: "web_fetch",
        misclassifiedToken: "403",
      }),
    );
    expect(r!.code).toBe("content_heuristic_misclassification");
  });

  it("PRIORITY: the breaker rule out-ranks tool_schema_unsupported (below X3 code #2)", () => {
    const r = rootCause(
      makeSignals({
        toolSchemaUnsupported: UNRECOVERED,
        hasDoNotRetrySignal: true,
        breakerOpenedTool: "web_fetch",
        repeatedFailureCount: { web_fetch: 5 },
        mostFailedTool: "web_fetch",
      }),
    );
    expect(r!.code).toBe("breaker_opened_repeated_failure");
  });

  it("PRIORITY: tool_schema_unsupported out-ranks the terminal-state explainer (acute cause over endReason)", () => {
    const r = rootCause(
      makeSignals({ toolSchemaUnsupported: UNRECOVERED, endReason: "context_exhausted" }),
    );
    expect(r!.code).toBe("tool_schema_unsupported");
  });

  it("PRIORITY: tool_schema_unsupported out-ranks the insurance codes (sits before provider_timeout)", () => {
    const r = rootCause(
      makeSignals({
        toolSchemaUnsupported: UNRECOVERED,
        failures: [
          {
            seq: 0,
            toolName: "llm_call",
            classifiedFailureBy: "",
            transportOk: false,
            errorKind: "timeout",
            resultDigest: "d",
            resultBytes: 1,
            errorPreview: "timed out",
          },
        ],
      }),
    );
    expect(r!.code).toBe("tool_schema_unsupported");
  });

  it("empty toolNames degrades the detail to [unknown] instead of an empty bracket pair", () => {
    const r = rootCause(makeSignals({ toolSchemaUnsupported: { ...UNRECOVERED, toolNames: [] } }));
    expect(r).not.toBeNull();
    expect(r!.code).toBe("tool_schema_unsupported");
    expect(r!.detail).toContain("[unknown]");
  });
});
