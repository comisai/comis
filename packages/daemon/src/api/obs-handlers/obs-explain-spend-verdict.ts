// SPDX-License-Identifier: Apache-2.0
/**
 * WR-4 (177-obs-loop): the NAMED terminal SPEND root-cause verdict spliced into
 * the `obs-explain-heuristics` registry — `spend_exceeded`.
 *
 * Extracted into this sibling (the `obs-explain-learning-verdicts.ts` discipline)
 * to keep `obs-explain-heuristics.ts` under the 500-line `obs-handlers/*` subdir
 * cap. PURE: no LLM, no I/O, no globals — same signals ⇒ same verdict forever
 * (the Glass Box determinism invariant).
 *
 * Ordering contract (registry position #2 — LIVE v2.28 260621): the dollars
 * kill-switch is an ADMINISTRATIVE pre-emption that aborts at admission, causally
 * INDEPENDENT of tool failures (a failed tool returns ~0 bytes / ~$0 and cannot
 * drive cumulative spend). It is therefore NOT a downstream terminal label like
 * context_exhausted / output_starved / prompt_timeout (which a runaway tool CAN
 * cause) — it out-ranks the breaker/dependency/timeout/degradation heuristics and
 * sits directly below the single X3-frozen content_heuristic_misclassification
 * verdict (the one specific Comis-defect indicator). It was originally spliced
 * into the terminal band below every tool-failure cause; a live VPS incident
 * proved that masked the kill-switch behind chronic breaker noise — a spend-killed
 * session root-caused to breaker_opened_repeated_failure while the operator's
 * turns were all blocked by the ceiling. Before the verdict existed at all a
 * spend-killed session root-caused to NOTHING (the security-review WR-4 finding);
 * both gaps directly violated this milestone's thesis + CLAUDE.md's troubleshooting
 * feedback loop ("verdict ranked chronic noise over the acute event").
 *
 * Keys on the metadata-derived endReason (END_REASON_MAP spend_exceeded →
 * "spend_exceeded", WR-2). The frozen 678/503 fixtures carry no endReason
 * "spend_exceeded" ⇒ cannot regress them. The detail NAMES the config key family
 * the operator turns (the §2.7 "name the knob" doctrine); the exact breached
 * scope + per-scope $ amounts live on the content-free spend.exceeded trajectory
 * record (WR-4), pointed to by the suggested step. The return type is structurally
 * identical to the registry's `RootCause` (no cross-module type import ⇒ no cycle).
 *
 * @module
 */

import type { IncidentSignals } from "@comis/core";

/** Structural twin of `obs-explain-heuristics.RootCause` (kept local — no import cycle). */
type SpendVerdict = { code: string; detail: string; suggestedNextSteps: string[] };

/**
 * `spend_exceeded` (the NAMED terminal SPEND cause). Fires only when the run's
 * mapped endReason IS "spend_exceeded"; returns `null` otherwise (so a clean
 * session, and every other terminal band, names no spend cause).
 */
export const spendExceededVerdict = (s: IncidentSignals): SpendVerdict | null => {
  if (s.endReason !== "spend_exceeded") return null;

  // OBS-3 (openclaw-usecases 2026-06-25): a per-ROOT `autonomy.budget` abort (the
  // token / wall-clock / aggregateUsd limb) is a DIFFERENT knob tree than the priced
  // `observability.spend` ceiling — pointing the operator at observability.spend.*
  // misdirects them (the SPEND-ABORT-OBS class — already fixed in the WARN; this is
  // the same fix at the `explain` VERDICT layer). When the terminal abort carried the
  // per-root limb, name `autonomy.budget.<limb>` + the numbers in their own unit so
  // the verdict answers "which limb, by how much, which knob" in one call.
  const prb = s.perRootBudget;
  if (prb !== undefined) {
    return {
      code: "spend_exceeded",
      detail:
        `per-root autonomy.budget exhausted — the ${prb.limb} limb tripped ` +
        `(${prb.spent}/${prb.cap} ${prb.unit}), aborting the run's spawn tree. This is the ` +
        `per-ROOT autonomy.budget meter, NOT the observability.spend $-ceiling.`,
      suggestedNextSteps: [
        `raise this agent's autonomy.budget.${prb.limb} (currently ${prb.cap} ${prb.unit}) for heavier/longer turns — NOT observability.spend.*`,
        "note the token limb counts cache-read tokens, so a cache-heavy multi-tool turn hits it fast at trivial actual $ (BUDGET-02); the wall-clock limb is the stuck-tree backstop",
      ],
    };
  }

  return {
    code: "spend_exceeded",
    detail:
      "spend ceiling exceeded — the dollars kill-switch aborted the run (observability.spend.*): " +
      "a per-(tenant,agent), per-tenant, or daemon-global cumulative-cost ceiling was reached",
    suggestedNextSteps: [
      'raise the breached ceiling (observability.spend.perAgentUsd / perTenantUsd / daemonGlobalUsd), or set observability.spend.action: "warn" to stop enforcing',
      "for the exact scope + the per-scope $ amounts that breached, read the spend.exceeded record on the session trajectory (obs.explain depth=full)",
    ],
  };
};
