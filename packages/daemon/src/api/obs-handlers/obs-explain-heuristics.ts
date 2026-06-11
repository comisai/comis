// SPDX-License-Identifier: Apache-2.0
/**
 * `obs-explain-heuristics` — the deterministic root-cause heuristic registry
 * (Phase 153 centerpiece, X3).
 *
 * An ordered, first-match-wins `ReadonlyArray<(IncidentSignals) => RootCause |
 * null>`. PURE: no LLM, no I/O, no globals — a post-mortem reproduces the same
 * `likelyRootCause` from the same log evidence forever. The registry keys ONLY
 * on the derived booleans/strings `toIncidentSignals` already computed from log
 * evidence (the 678 fixture has ZERO Phase-150 provenance fields, so the
 * misclassification signal is derived from `success:true` + repeated
 * `"Tool execution failed"` + a status/200/403 token in a failure body — never
 * from `classifiedFailureBy`).
 *
 * ORDERING (load-bearing — pins BOTH frozen fixtures):
 *   1. content_heuristic_misclassification — the 678 ROOT cause. The breaker
 *      tripped on the MISCLASSIFIED successes ("DO NOT retry" is present too),
 *      so the misclassification must out-rank the breaker: it is upstream, the
 *      breaker is the downstream symptom.
 *   2. breaker_opened_repeated_failure — the 503 root cause: a real transport
 *      failure (HTTP 503 → "overloaded") repeated until the per-tool breaker
 *      opened. The 503 has NO misclassification signal, so it falls through to
 *      here.
 *   3. tool_schema_unsupported (GBNF-02, Phase 175) — an acute, deterministic
 *      provider-schema rejection: upstream of any terminal state (out-ranks
 *      context_exhausted/output_starved) but downstream of the two X3-mandated
 *      codes, whose frozen fixtures carry no schema-rejection records (cannot
 *      regress them). Fires only when the one-shot strip-retry did NOT
 *      recover — a recovered repair is evidence, not a verdict.
 *   4. context_bloat / exec_dependency / provider_timeout — three low-risk
 *      "insurance" codes that broaden 156/G1 corpus coverage. They never fire on
 *      the two X3 fixtures (the two above match first), so they cannot regress
 *      the phase-done gate.
 *   5. context_exhausted / output_starved (QT2/QT3 — the Glass Box degradation
 *      detectors) — the two NAMED terminal-state causes. They key on the
 *      metadata-derived `endReason` (threaded onto the signals by the handler),
 *      NOT a tool failure, so they sit LAST: a tool-failure cause is upstream of
 *      the terminal state and out-ranks them. They fire only when the run's
 *      mapped endReason IS the cause, and never on a clean session.
 *
 * The two X3-mandated codes are #1 and #2; phase-done gates ONLY on X1/X2/X3.
 *
 * @module
 */

import type { IncidentSignals } from "@comis/core";

// ---------------------------------------------------------------------------
// Tunable thresholds (module-top constants per the naming contract).
// ---------------------------------------------------------------------------

/**
 * Minimum same-tool failures for the repeated-failure breaker path to fire when
 * no explicit breaker event / "DO NOT retry" line is present. Re-exported from
 * the signals module's `BREAKER_N` intent (kept literal here so the registry has
 * no runtime import cycle with the normalizer).
 */
const BREAKER_N = 5;

/** Minimum disk offloads for the context-bloat insurance signal. */
const CONTEXT_BLOAT_MIN_OFFLOADS = 3;

/**
 * A single large-result offload (chars) that, on its own, marks a token spike
 * for the context-bloat heuristic — one ~50 KB body offloaded is already a
 * working-set spike.
 */
const TOKEN_SPIKE_CHARS = 32_000;

/** Substrings that mark a missing-dependency exec failure (insurance code). */
const MODULE_NOT_FOUND_MARKERS: readonly string[] = [
  "ModuleNotFoundError",
  "Cannot find module",
];

// ---------------------------------------------------------------------------
// Public shape: matches IncidentReport.likelyRootCause 1:1 (Plan 01).
// ---------------------------------------------------------------------------

/**
 * A deterministic root-cause verdict. Shape-identical to
 * `IncidentReport.likelyRootCause` so the handler can assign it directly.
 */
export interface RootCause {
  code: string;
  detail: string;
  suggestedNextSteps: string[];
}

// ---------------------------------------------------------------------------
// Rule helpers.
// ---------------------------------------------------------------------------

/**
 * The tool the breaker most plausibly opened on: the explicit breaker-opened
 * tool, else the most-failed tool, else the first tool with a repeated-failure
 * count. Returns `undefined` when no tool can be named.
 */
function breakerTool(s: IncidentSignals): string | undefined {
  if (s.breakerOpenedTool !== undefined) return s.breakerOpenedTool;
  if (s.mostFailedTool !== undefined) return s.mostFailedTool;
  for (const tool of Object.keys(s.repeatedFailureCount)) return tool;
  return undefined;
}

/** Does any failure body carry a known module-not-found marker? */
function hasModuleNotFound(s: IncidentSignals): boolean {
  return s.failures.some(
    (f) =>
      f.errorKind === "dependency" &&
      MODULE_NOT_FOUND_MARKERS.some((marker) => f.errorPreview.includes(marker)),
  );
}

// ---------------------------------------------------------------------------
// The ordered registry (first non-null wins).
// ---------------------------------------------------------------------------

/**
 * The ordered root-cause registry. First predicate to return a non-null
 * `RootCause` wins. Order is the X3 contract — see the module doc.
 */
export const HEURISTICS: ReadonlyArray<(s: IncidentSignals) => RootCause | null> = [
  // 1) content_heuristic_misclassification (678 — ROOT over the breaker symptom).
  //    Derived from log evidence ONLY (no classifiedFailureBy in the fixture).
  (s) => {
    if (!s.hasMisclassificationSignal) return null;
    const tool = s.misclassifiedTool ?? "the tool";
    const token = s.misclassifiedToken ?? "a status token";
    return {
      code: "content_heuristic_misclassification",
      detail:
        "content-heuristic misclassification (tool=" +
        tool +
        ", token=" +
        token +
        "): a substring match in a large tool body flipped status-200 successes to failures",
      suggestedNextSteps: [
        "audit the " + tool + " failureDetector rule for the matched token '" + token + "'",
        "narrow the substring scan to a structured status field instead of the raw body",
        "obs.explain depth=full",
      ],
    };
  },

  // 2) breaker_opened_repeated_failure (503 — real transport failure cascade).
  (s) => {
    const trippedByEvent = s.breakerOpenedTool !== undefined || s.hasDoNotRetrySignal;
    const tool = breakerTool(s);
    if (tool === undefined) return null;
    const repeated = s.repeatedFailureCount[tool] ?? 0;
    const trippedByCount = repeated >= BREAKER_N;
    if (!trippedByEvent && !trippedByCount) return null;
    return {
      code: "breaker_opened_repeated_failure",
      detail:
        "breaker opened on repeated " +
        tool +
        " failures (" +
        String(repeated) +
        " same-tool failures); the per-tool retry breaker told the model DO NOT retry",
      suggestedNextSteps: [
        "inspect the upstream provider/transport for " + tool,
        "confirm the breaker threshold and cooldown for " + tool,
        "obs.explain depth=full",
      ],
    };
  },

  // 3) tool_schema_unsupported (GBNF-02 — acute provider-schema rejection at
  //    grammar-compile/unmarshal time). Fires ONLY on an UNRECOVERED one-shot
  //    strip-retry: a recovered repair is evidence, not a verdict (T-175-19).
  //    Detail is assembled solely from Comis-registry tool names + the closed
  //    keyword names — the signal carries no body fields by construction
  //    (T-175-17). The WR-05 reason discriminator branches the wording: the
  //    gate-closed terminal previously emitted the same payload as
  //    nothing-to-strip, so a session that healed once and then hit the gate
  //    produced a verdict claiming "nothing strippable" when stripping WAS
  //    performed earlier — the exact wrong-way pointer the troubleshooting
  //    doctrine forbids. Absent reason (pre-WR-05 records) falls back to the
  //    retried-based wording.
  (s) => {
    if (!s.toolSchemaUnsupported || s.toolSchemaUnsupported.succeeded) return null;
    const { toolNames, strippedKeywords, retried, reason } = s.toolSchemaUnsupported;
    const branch =
      reason === "gate_closed"
        ? ", a strip-pattern/format-retry was already attempted earlier this session (once-per-session gate closed)"
        : reason === "nothing_to_strip"
          ? ", nothing strippable so no retry was attempted"
          : retried
            ? `, one strip-${strippedKeywords.join("/")}-retry already attempted`
            : ", nothing strippable so no retry was attempted";
    return {
      code: "tool_schema_unsupported",
      detail: `provider rejected the tool JSON Schema at grammar-compile (GBNF) — tool(s) [${toolNames.join(", ") || "unknown"}]${branch}, still failing`,
      suggestedNextSteps: [
        'set providers.entries.<provider>.models[].comisCompat.toolSchemaProfile: "gbnf" (auto-enabled only for provider type "ollama"; LM Studio/llama.cpp/vLLM need the explicit value)',
        "obs.explain depth=full for the raw failure rows",
      ],
    };
  },

  // 4) context_bloat (insurance — large-result offloads + a token spike).
  (s) => {
    if (s.offloads.length < CONTEXT_BLOAT_MIN_OFFLOADS) return null;
    const spike = s.offloads.some((o) => o.originalChars >= TOKEN_SPIKE_CHARS);
    if (!spike) return null;
    const biggest = s.offloads.reduce((a, b) => (b.originalChars > a.originalChars ? b : a));
    return {
      code: "context_bloat",
      detail:
        "context bloat: " +
        String(s.offloads.length) +
        " large-result offloads (largest " +
        String(biggest.originalChars) +
        " chars from " +
        biggest.toolName +
        ") spiked the working set",
      suggestedNextSteps: [
        "lower the offload threshold or summarize " + biggest.toolName + " results before injection",
        "check the context budget for the spiking tool",
        "obs.explain depth=full",
      ],
    };
  },

  // 5) exec_dependency (insurance — ModuleNotFound-class exec failure).
  (s) => {
    if (!hasModuleNotFound(s)) return null;
    const failure = s.failures.find(
      (f) =>
        f.errorKind === "dependency" &&
        MODULE_NOT_FOUND_MARKERS.some((marker) => f.errorPreview.includes(marker)),
    );
    const tool = failure?.toolName ?? "the exec tool";
    return {
      code: "exec_dependency",
      detail:
        "missing runtime dependency in " +
        tool +
        ": a module/package the code imports is not installed",
      suggestedNextSteps: [
        "install the missing dependency for " + tool + " or pin it in the exec environment",
        "verify the exec sandbox provisions the required runtime",
        "obs.explain depth=full",
      ],
    };
  },

  // 6) provider_timeout (insurance — any timeout-kind failure).
  (s) => {
    const failure = s.failures.find((f) => f.errorKind === "timeout");
    if (failure === undefined) return null;
    return {
      code: "provider_timeout",
      detail:
        "provider timeout: " +
        failure.toolName +
        " exceeded its deadline (errorKind=timeout)",
      suggestedNextSteps: [
        "raise the per-call timeout or reduce the request size for " + failure.toolName,
        "check provider latency / rate-limit headroom",
        "obs.explain depth=full",
      ],
    };
  },

  // 7) context_exhausted (QT2 — the NAMED terminal degradation cause). Keyed on
  //    the metadata-derived endReason, NOT a tool failure — so it sits BELOW the
  //    tool-failure rules above (a misclassification/breaker/dependency/timeout
  //    cause is upstream of, and out-ranks, the terminal state). Fires only when
  //    the run's mapped endReason IS the context-exhaustion cause.
  //
  //    W3 (obs-llm-troubleshooting): when the trajectory carries the per-call
  //    budget equation (`signals.contextBudget`, from the W2 context.budget
  //    event), the verdict is NUMBERS-BACKED — assembled vs window, the exact
  //    contextEngine.budget.* knob that clamped the window, the system+tools
  //    share, and the kept-history count. The old static text speculated about
  //    the summarizer/compaction and pointed at summarizerSpend, which actively
  //    misdirected the live qwen3.6 incident (the real cause was the small-class
  //    32K cap + 83 tool schemas at 80% of the window). The generic text remains
  //    ONLY as the fallback for pre-W2 sessions with no budget evidence.
  (s) => {
    if (s.endReason !== "context_exhausted") return null;
    const b = s.contextBudget;
    if (b !== undefined) {
      const capped = b.windowCapSource !== "none";
      const systemSharePct =
        b.windowTokens > 0 ? Math.round((b.systemTokens / b.windowTokens) * 100) : 0;
      // KNOB-02 (Phase 176): "served" is NOT a contextEngine.budget.* knob —
      // templating it would render a nonsense config key (the union member name
      // suffixed onto the knob prefix) and misdirect the operator. The served
      // branch names the failure class (Ollama served a smaller window than
      // configured); the real knobs are in the suggested step below. The cap
      // branch stays byte-identical.
      const capClause = capped
        ? (b.windowCapSource === "served"
            ? ` (model contextWindow ${String(b.rawContextWindowTokens)} but Ollama served a smaller window)`
            : ` (model contextWindow ${String(b.rawContextWindowTokens)} capped by contextEngine.budget.${b.windowCapSource})`)
        : "";
      return {
        code: "context_exhausted",
        detail:
          "context exhausted — the pre-flight guard aborted before the model could run: assembled " +
          `${String(b.assembledInputTokens)} tokens of effective window ${String(b.windowTokens)}${capClause}; ` +
          `system prompt + tool schemas = ${String(b.systemTokens)} tokens (${String(systemSharePct)}% of the window); ` +
          `history kept: ${String(b.keptCount)}`,
        suggestedNextSteps: [
          ...(capped
            ? [
                b.windowCapSource === "served"
                  ? `set OLLAMA_CONTEXT_LENGTH=${String(b.rawContextWindowTokens)} (ollama serve) or Modelfile 'PARAMETER num_ctx ${String(b.rawContextWindowTokens)}' — the model is configured for ${String(b.rawContextWindowTokens)} but Ollama serves less`
                  : `raise contextEngine.budget.${b.windowCapSource} (0 = uncapped) — the model declares ` +
                    `${String(b.rawContextWindowTokens)} tokens but the effective window was ${String(b.windowTokens)}`,
              ]
            : []),
          systemSharePct >= 50
            ? "reduce the active tool surface (disable unused builtin tool groups / MCP servers) — tool schemas dominate the window"
            : "check the agent's context window vs. its working-set size (long tool outputs / large history)",
          "obs.explain depth=full",
        ],
      };
    }
    return {
      code: "context_exhausted",
      detail:
        "context exhausted — the context-window guard aborted the run (the summarizer hit its token cap, or compaction floored to truncation-only), so the model could not continue",
      suggestedNextSteps: [
        "raise contextEngine.summarizerSpend so compaction can summarize instead of flooring to truncation",
        "check the agent's context window vs. its working-set size (long tool outputs / large history)",
        "obs.explain depth=full",
      ],
    };
  },

  // 8) output_starved (QT3 — the NAMED terminal output-truncation cause). Same
  //    lowest-priority placement as context_exhausted: it explains the terminal
  //    state, so any tool-failure cause out-ranks it. Fires only when the mapped
  //    endReason IS the output-starvation cause (a terminal output-cap truncation
  //    on an otherwise-clean run — see promoteOutputStarved in the agent).
  (s) => {
    if (s.endReason !== "output_starved") return null;
    return {
      code: "output_starved",
      detail:
        "output starved — the final response was truncated at the model's max output tokens (the terminal turn stopped at the output cap with nothing after it)",
      suggestedNextSteps: [
        "raise the agent's maxTokens, or enable contextEngine.outputEscalation so a capped turn retries with a larger output budget",
        "if the answer is legitimately long, split the request or ask the agent to continue",
        "obs.explain depth=full",
      ],
    };
  },
];

/**
 * Run the ordered registry; return the first non-null `RootCause`, or `null`
 * when nothing matched (a clean session).
 */
export function rootCause(s: IncidentSignals): RootCause | null {
  for (const h of HEURISTICS) {
    const r = h(s);
    if (r !== null) return r;
  }
  return null;
}
