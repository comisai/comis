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
 *   6. prompt_timeout (LAT-04, Phase 177) — the NAMED terminal latency cause,
 *      keyed on endReason "timeout" (alive since the 177-04 END_REASON_MAP
 *      `prompt_timeout → "timeout"` entry). Same terminal band as #5 (the three
 *      endReason keys are mutually exclusive); every tool-failure cause
 *      out-ranks it. Numbers-backed from the enriched execution.prompt_timeout
 *      signal when present (stall names the binding knob, makespan names
 *      stallCeilingMultiplier); pre-extension sessions degrade to a generic
 *      knob suggestion. The frozen 678/503 fixtures carry no prompt_timeout
 *      records and no endReason "timeout" — cannot regress them.
 *
 * The two X3-mandated codes are #1 and #2; phase-done gates ONLY on X1/X2/X3.
 *
 * @module
 */

import type { IncidentSignals } from "@comis/core";
import {
  BREAKER_N,
  CONTEXT_BLOAT_MIN_OFFLOADS,
  TOKEN_SPIKE_CHARS,
  MODULE_NOT_FOUND_MARKERS,
  breakerTool,
  hasModuleNotFound,
} from "./obs-explain-heuristics-helpers.js";

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
      // configured); the real knobs are in the suggested step below.
      // WR-01: "capabilityClass" is ALSO not a budget knob — the executor-side
      // DEFAULT_EFFECTIVE_CAP_BY_CLASS cap reads only the operator's
      // providers.entries.<id>.capabilities.capabilityClass pin, so the verdict
      // must name the PIN ("raise contextEngine.budget.effectiveContextCapSmall"
      // changes nothing on that branch — the dead-knob misdirection this phase
      // exists to kill). The genuine budget-knob branch stays byte-identical.
      const capClause = capped
        ? (b.windowCapSource === "served"
            ? ` (model contextWindow ${String(b.rawContextWindowTokens)} but Ollama served a smaller window)`
            : b.windowCapSource === "capabilityClass"
              ? ` (model contextWindow ${String(b.rawContextWindowTokens)} capped by the providers.entries.<id>.capabilities.capabilityClass pin)`
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
                  : b.windowCapSource === "capabilityClass"
                    ? `pin a higher providers.entries.<id>.capabilities.capabilityClass (or remove the pin) — the pinned class capped the model's declared ${String(b.rawContextWindowTokens)} tokens to ${String(b.windowTokens)}; the contextEngine.budget.* caps do not move this bind`
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

  // 9) prompt_timeout (LAT-04, Phase 177 — the NAMED terminal latency cause).
  //    Keyed on the metadata-derived endReason (END_REASON_MAP prompt_timeout →
  //    "timeout", 177-04), NOT a tool failure — sits BELOW the tool-failure
  //    rules: a session that died on a prompt timeout with CLEAN tools used to
  //    fall through to NO verdict (rule 6 provider_timeout requires a tool
  //    failure — research Critical Finding 7 point 6). Numbers-backed from the
  //    enriched execution.prompt_timeout signal when present; bindingKnob is
  //    the PRE-RENDERED config-key string from the agent-side source→knob
  //    table (never re-templated here — the KNOB-02 discipline; the only local
  //    templating is the agents.<id>.promptTimeout.* fallback, a REAL key
  //    family). Cannot regress the frozen 678/503 fixtures (no prompt_timeout
  //    records, no endReason "timeout" in them).
  (s) => {
    if (s.endReason !== "timeout") return null;
    const t = s.promptTimeout;
    if (t !== undefined) {
      if (t.limit === "makespan") {
        // Makespan kill = streaming runaway (the model kept producing past the
        // ceiling) — never framed as a stall; the lever is the multiplier.
        return {
          code: "prompt_timeout",
          detail:
            `makespan ceiling ${String(t.makespanMs ?? t.timeoutMs)}ms exceeded after ${String(t.durationMs ?? t.timeoutMs)}ms ` +
            `while still streaming — streaming runaway (stall budget ${String(t.stallBudgetMs ?? 0)} × stallCeilingMultiplier)`,
          suggestedNextSteps: [
            `raise agents.${s.agentId ?? "<id>"}.promptTimeout.stallCeilingMultiplier (ceiling ${String(t.makespanMs ?? 0)}ms) or investigate runaway model output`,
            "obs.explain depth=full",
          ],
        };
      }
      if (t.limit === undefined) {
        // Whole-turn retry kill (`limit` ABSENT): rotation/fallback/short-
        // retry prompts race the NON-resettable retryPromptTimeoutMs — never
        // framed as a stall kill, and the lever is the RETRY knob (177-REVIEW
        // WR-01; the same branch the agent-side classify hint takes). The
        // retry knob is a REAL agents.* key family, so local templating is
        // sanctioned (the KNOB-02 fallback discipline) — deliberately NOT
        // t.bindingKnob: pre-WR-01 rows on disk carry the wrong
        // promptTimeoutMs knob for exactly this class.
        return {
          code: "prompt_timeout",
          detail:
            `whole-turn retry timeout ${String(t.timeoutMs)}ms exceeded after ${String(t.durationMs ?? t.timeoutMs)}ms — ` +
            `retry/fallback prompts use the non-resettable retryPromptTimeoutMs, not the stall budget`,
          suggestedNextSteps: [
            `raise agents.${s.agentId ?? "<id>"}.promptTimeout.retryPromptTimeoutMs (currently ${String(t.timeoutMs)})`,
            "obs.explain depth=full",
          ],
        };
      }
      // Stall kill (limit === "stall") — the binding knob came pre-rendered
      // from the emit site when present.
      const knob = t.bindingKnob ?? `agents.${s.agentId ?? "<id>"}.promptTimeout.promptTimeoutMs`;
      return {
        code: "prompt_timeout",
        detail:
          `stall budget ${String(t.stallBudgetMs ?? t.timeoutMs)}ms exceeded after ${String(t.durationMs ?? t.timeoutMs)}ms ` +
          `with no stream/tool activity — binding knob: ${knob}`,
        suggestedNextSteps: [
          `raise ${knob} (currently ${String(t.stallBudgetMs ?? t.timeoutMs)}) — local prefill on consumer hardware can exceed it`,
          "obs.explain depth=full",
        ],
      };
    }
    // Pre-extension session (endReason "timeout" but no enriched record on the
    // trajectory): still name the cause, suggest the knob FAMILY, invent no numbers.
    return {
      code: "prompt_timeout",
      detail: "prompt timed out (no enriched timeout record — pre-extension session)",
      suggestedNextSteps: [
        `raise agents.${s.agentId ?? "<id>"}.promptTimeout.promptTimeoutMs`,
        "obs.explain depth=full",
      ],
    };
  },

  // 9c) recall_miss (RECALL-01). A DEGRADED session whose memory recalls ALL
  //     returned zero injected memories AND that matched no tool/context/breaker
  //     cause above — the agent ran with no memory context. Low-noise by
  //     construction: requires EVERY recall to have missed (zeroHits === recalls),
  //     NO tool failures (so it never steals from the catch-all, which REQUIRES
  //     failures — the two are mutually exclusive), and the authoritative
  //     `degraded` flag (a zero-hit recall on a healthy turn is benign — the agent
  //     simply didn't need memory — and never fires). Grounded in the v2.22 Hebrew
  //     / LM-3 runs where recall silently missed and `comis explain` root-caused
  //     nothing, so I hand-queried memory_fts to find the lane/scope gap.
  (s) => {
    if (s.recall === undefined) return null;
    if (s.recall.recalls === 0 || s.recall.zeroHits < s.recall.recalls) return null;
    if (s.failures.length > 0) return null;
    if (s.degraded !== true) return null;
    return {
      code: "recall_miss",
      detail:
        `recall miss — all ${s.recall.recalls} recall query(ies) returned zero injected ` +
        `memories (terminal lanes=${s.recall.lastLanes}, reranker ` +
        `${s.recall.rerankerAvailable ? "available" : "absent"}); the turn ran with no memory ` +
        "context and no tool/context/breaker cause matched",
      suggestedNextSteps: [
        "verify the recall SCOPE (agent- vs user-scoped) matches where the memory was written",
        "for non-Latin queries confirm the trigram-twin lanes fired (comis fleet → health_signal); for weak semantic recall check comis fleet config_posture for the embedder",
        "obs.explain depth=full for the per-recall lane/candidate counts",
      ],
    };
  },

  // 10) completed_with_tool_errors (the CATCH-ALL ACUTE cause — last of the acute
  //     tier, above the BENIGN learning verdicts #11-13 below). A
  //     degraded session whose tool failures matched none of the named rules
  //     above (not misclassification, breaker, schema-strip, context-bloat,
  //     module-not-found, or timeout) used to fall through to a NULL verdict —
  //     comis explain captured the per-tool {ok,failed} but root-caused nothing
  //     (live C13 finding, 2026-06-12: memory_get + image_analyze both failed
  //     with errorKind=dependency on bad input). Keys on ACTUAL failures, never
  //     the endReason label alone, so a `completed_with_tool_errors` end state
  //     with no failure records (a degenerate/contradictory signal) still names
  //     nothing — and a clean session (zero failures) never fires.
  (s) => {
    if (s.failures.length === 0) return null;
    const failedTools = [...new Set(s.failures.map((f) => f.toolName))];
    const kinds = [...new Set(s.failures.map((f) => f.errorKind))].filter(Boolean);
    const kindStr = kinds.length > 0 ? ` (errorKind: ${kinds.join(", ")})` : "";
    return {
      code: "completed_with_tool_errors",
      detail:
        `${s.failures.length} tool failure(s) across ${failedTools.join(", ")}${kindStr} — ` +
        "the turn finished but one or more tools errored; no upstream named cause matched",
      suggestedNextSteps: [
        `inspect the failing tool(s): ${failedTools.join(", ")}`,
        "obs.explain depth=full for the per-failure errorPreview and resultDigest",
      ],
    };
  },

  // 11) learned_skill_failing (OBS-02, Phase 201 — LOW-priority, BENIGN). A
  //     learned procedure was USED in a failed/corrected trajectory (skillFailures
  //     non-empty). Ranks BELOW every acute tool-failure cause (incl. the catch-all
  //     completed_with_tool_errors at #10) — it explains the LEARNING dimension,
  //     never masks an acute error — but ABOVE the generic outcome_unresolved (a
  //     named skill failure is more specific than "no outcome resolved"). Absent
  //     learning block ⇒ no verdict; an empty skillFailures ⇒ no verdict — so it
  //     cannot regress the 678/503 fixtures (they carry no learning block).
  (s) => {
    if (s.learning === undefined || s.learning.skillFailures.length === 0) return null;
    return {
      code: "learned_skill_failing",
      detail:
        `a learned procedure was used in failed/corrected trajectories ` +
        `(${s.learning.skillFailures.length} skill(s): ${s.learning.skillFailures.join(", ")})`,
      suggestedNextSteps: [
        "inspect via comis memory skills; the procedure will demote on continued failure (Phase 202)",
        "obs.explain depth=full",
      ],
    };
  },

  // 12) synthesis_abstained_low_capability (OBS-02, Phase 201 — BENIGN). The
  //     skill-synthesis cron abstained because the agent's model tier is below the
  //     capability gate (small/nano without a capable override). Defer ≠ Retry:
  //     NOT a failure — every acute cause out-ranks it; it ranks ABOVE the generic
  //     outcome_unresolved because the abstain is the SPECIFIC, named reason the
  //     learning outcome stayed unresolved (specific-over-generic). Absent learning
  //     block / a non-abstained run ⇒ no verdict (no fixture regression).
  (s) => {
    if (s.learning === undefined || !s.learning.synthesisAbstained) return null;
    return {
      code: "synthesis_abstained_low_capability",
      detail:
        "synthesis abstained — the agent's model tier is below the capability gate " +
        "(small/nano without a capable override); this is BENIGN (Defer != Retry), not a failure",
      suggestedNextSteps: [
        "set a capable skillSynthesis tier override or raise the agent model tier",
        "obs.explain depth=full",
      ],
    };
  },

  // 13) outcome_unresolved (OBS-02, Phase 198 — LOWEST-priority, BENIGN, the
  //     generic learning catch-all). A finished trajectory whose learning shadow
  //     saw the turn but where NO signal tier resolved an outcome (outcomeResolved
  //     === false) AND neither named skill verdict above fired. Defer ≠ Retry: NOT
  //     a failure — dead-last, so every acute cause (and the catch-all tool-failure
  //     rule, and the two specific skill verdicts) out-ranks it. Distinct from an
  //     explicit `unknown` OUTCOME (which IS a resolution): this is "never
  //     resolvable", the shadow-mode default with no deterministic tool/pipeline
  //     signal + judge off. Absent learning block ⇒ no verdict; a resolved one ⇒ no
  //     verdict — so it cannot regress the 678/503 fixtures (they carry none).
  (s) => {
    if (s.learning === undefined || s.learning.outcomeResolved) return null;
    return {
      code: "outcome_unresolved",
      detail:
        "outcome unresolved — the learning shadow observed this finished trajectory but no " +
        "signal tier (tool/pipeline/judge/reaction) produced a resolvable outcome",
      suggestedNextSteps: [
        "expected in shadow mode for trajectories with no deterministic tool/pipeline signal — " +
          "enable the judge source (agents.<id>.learningOutcome.judge.enabled) for fallback coverage",
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
