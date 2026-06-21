// SPDX-License-Identifier: Apache-2.0
/**
 * RECALL-01: the `recall_miss` root-cause verdict predicate spliced into the
 * `obs-explain-heuristics` registry.
 *
 * Extracted into this sibling (the `obs-explain-learning-verdicts.ts` /
 * `obs-explain-spend-verdict.ts` discipline) to keep `obs-explain-heuristics.ts`
 * under the 500-line `obs-handlers/*` subdir cap. PURE: no LLM, no I/O, no globals
 * — same signals ⇒ same verdict forever.
 *
 * A DEGRADED session whose memory recalls ALL returned zero injected memories AND
 * that matched no tool/context/breaker cause above — the agent ran with no memory
 * context. Low-noise by construction: requires EVERY recall to have missed
 * (zeroHits === recalls), NO tool failures (so it never steals from the catch-all,
 * which REQUIRES failures — the two are mutually exclusive), and the authoritative
 * `degraded` flag (a zero-hit recall on a healthy turn is benign — the agent simply
 * didn't need memory — and never fires). Grounded in the v2.22 Hebrew / LM-3 runs
 * where recall silently missed and `comis explain` root-caused nothing, so the
 * lane/scope gap had to be hand-queried from memory_fts. The return type is
 * structurally identical to the registry's `RootCause` (no cross-module type import
 * ⇒ no cycle).
 *
 * @module
 */

import type { IncidentSignals } from "@comis/core";

/** Structural twin of `obs-explain-heuristics.RootCause` (kept local — no import cycle). */
type RecallVerdict = { code: string; detail: string; suggestedNextSteps: string[] };

/** `recall_miss` — fires only on an all-missed, degraded, no-tool-failure session. */
export const recallMissVerdict = (s: IncidentSignals): RecallVerdict | null => {
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
};
