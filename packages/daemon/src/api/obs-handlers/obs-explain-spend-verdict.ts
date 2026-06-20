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
 * Ordering contract (the registry splices this in the TERMINAL band alongside
 * context_exhausted / output_starved / prompt_timeout — after every tool-failure
 * cause, before the catch-all): the four endReason keys are mutually exclusive,
 * and every tool-failure cause out-ranks the terminal label. Before this fix the
 * deterministic verdict had NO spend case, so a spend-killed session root-caused
 * to NOTHING — the platform could not diagnose its own dollars kill-switch firing
 * in one `comis explain` call (the security-review WR-4 finding; directly
 * violating this milestone's thesis + CLAUDE.md's troubleshooting feedback loop).
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
