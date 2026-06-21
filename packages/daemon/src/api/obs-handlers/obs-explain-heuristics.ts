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
 *   2. spend_exceeded (LIVE v2.28 260621) — the dollars kill-switch is an
 *      ADMINISTRATIVE pre-emption that aborts at admission, causally INDEPENDENT
 *      of tool failures (tool FAILURES return ~0 bytes / ~$0 and cannot drive
 *      cumulative spend). A live VPS incident showed a spend-killed session
 *      root-causing to the chronic breaker below — masking the acute kill that
 *      now blocks every new turn. So it sits ABOVE the breaker/degradation
 *      heuristics but BELOW #1 (the X3-frozen misclassification). Keyed on
 *      endReason "spend_exceeded" (frozen fixtures carry it not).
 *   3. breaker_opened_repeated_failure — the 503 root cause: a real transport
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
 *   6. prompt_timeout (LAT-04, Phase 177) / spend_exceeded (WR-4, 177-obs-loop) —
 *      the NAMED terminal latency + SPEND causes, keyed on endReason "timeout" /
 *      "spend_exceeded". Same terminal band as #5 (the endReason keys are mutually
 *      exclusive); every tool-failure cause out-ranks them. prompt_timeout is
 *      numbers-backed from the enriched signal when present; spend_exceeded lives
 *      in the sibling obs-explain-spend-verdict.ts. The frozen 678/503 fixtures
 *      carry neither endReason — cannot regress them.
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
// OBS-02 (Phase 201): the two BENIGN learning verdicts (sibling — subdir cap).
import { learnedSkillFailingVerdict, synthesisAbstainedVerdict, userModelRevisedVerdict } from "./obs-explain-learning-verdicts.js";
import { spendExceededVerdict } from "./obs-explain-spend-verdict.js"; // WR-4: NAMED spend verdict (sibling — subdir cap)
import { recallMissVerdict } from "./obs-explain-recall-verdict.js"; // RECALL-01 (sibling — subdir cap)

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

  // 2) spend_exceeded (LIVE v2.28 260621 — the dollars kill-switch is an
  //    ADMINISTRATIVE pre-emption at admission, NOT a downstream symptom of tool
  //    failures. Tool FAILURES return ~0 bytes / ~$0 and cannot drive cumulative
  //    spend, so the ceiling is causally INDEPENDENT of them. A live VPS incident
  //    proved the bug: a long-lived session with chronic exec failures hit the
  //    ceiling, but the verdict reported breaker_opened_repeated_failure — chronic
  //    noise masking the acute kill that now blocks EVERY new turn. So it
  //    out-ranks the breaker/dependency/timeout/degradation heuristics below, but
  //    stays BELOW #1, the X3-frozen misclassification verdict. Keyed strictly on
  //    endReason "spend_exceeded" (frozen 678/503 fixtures carry it not).
  spendExceededVerdict,

  // 3) breaker_opened_repeated_failure (503 — real transport failure cascade).
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
  //     NO tool failures (mutually exclusive with the catch-all) + the
  //     authoritative `degraded` flag (full rationale in the sibling
  //     obs-explain-recall-verdict.ts module doc).
  recallMissVerdict,

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

  // 11/12/12b) the BENIGN learning verdicts (sibling): after the acute tier, before #13
  // (specific-over-generic, yet Defer ≠ Retry — never masks an acute error).
  learnedSkillFailingVerdict,
  synthesisAbstainedVerdict,
  userModelRevisedVerdict, // OBS-02 (Phase 203): routine user-model revision; zero/absent ⇒ no verdict.

  // 13) outcome_unresolved (OBS-02, Phase 198 — LOWEST-priority, BENIGN, the
  //     generic learning catch-all). A finished trajectory the learning shadow saw
  //     but where NO signal tier resolved an outcome AND neither skill verdict
  //     fired. Defer ≠ Retry: dead-last (every acute cause + the two skill verdicts
  //     out-rank it). Absent/resolved learning block ⇒ no verdict (no 678/503
  //     fixture regression).
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

/** Run the ordered registry; first non-null `RootCause` wins, else `null` (clean session). */
export function rootCause(s: IncidentSignals): RootCause | null {
  for (const h of HEURISTICS) {
    const r = h(s);
    if (r !== null) return r;
  }
  return null;
}
