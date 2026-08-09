// SPDX-License-Identifier: Apache-2.0
/**
 * The terminal-execution-failure and `recall_miss` root-cause verdict predicates
 * spliced into the `obs-explain-heuristics` registry.
 *
 * Extracted into this sibling (the `obs-explain-learning-verdicts.ts` /
 * `obs-explain-spend-verdict.ts` discipline) to keep `obs-explain-heuristics.ts`
 * under the 500-line `obs-handlers/*` subdir cap. PURE: no LLM, no I/O, no globals
 * — same signals ⇒ same verdict forever.
 *
 * `recall_miss` fires on a DEGRADED session whose memory recalls ALL returned zero
 * injected memories AND that matched no tool/context/breaker cause above — the agent
 * ran with no memory context. Low-noise by construction: requires EVERY recall to
 * have missed (zeroHits === recalls), NO tool failures (so it never steals from the
 * catch-all, which REQUIRES failures — the two are mutually exclusive), and the
 * authoritative `degraded` flag (a zero-hit recall on a healthy turn is benign — the
 * agent simply didn't need memory — and never fires). Grounded in live Hebrew-language
 * runs where recall silently missed and `comis explain` root-caused nothing, so the
 * lane/scope gap had to be hand-queried from memory_fts.
 *
 * A zero-hit recall is ALSO the ordinary state of an empty memory store, so on a
 * session that died in the execution lifecycle the recall evidence is incidental and
 * must never become the verdict. That boundary is shared, not per-errorKind: the
 * terminal-failure predicates below derive ONE `terminalFailureKind` (an
 * `endReason: "error"` session with no tool failures whose activity surface finalized
 * as a failure), `auth` and `dependency` get their own named codes and levers, EVERY
 * other kind still names the terminal failure generically, and `recallMissVerdict`
 * itself refuses to fire on a failed finalize. Patching only the kinds seen so far
 * left `internal` (session_reset / narration_stall), `validation` (input_too_large)
 * and the rejection-classifier fallbacks still root-caused as "the turn ran with no
 * memory context". The return type is structurally identical to the registry's
 * `RootCause` (no cross-module type import ⇒ no cycle).
 *
 * @module
 */

import type { IncidentSignals } from "@comis/core";

/** Structural twin of `obs-explain-heuristics.RootCause` (kept local — no import cycle). */
type RecallVerdict = { code: string; detail: string; suggestedNextSteps: string[] };

/**
 * The terminal execution ErrorKind of a session that produced NO tool failure to
 * attribute its death to, or `undefined` when the session carries no such evidence.
 * `auth` also keys on the early session-summary tally, which can carry the kind when
 * the activity surface never finalized with one. A failed finalize with no recorded
 * kind still counts — the failure is real evidence even when unclassified.
 */
const terminalFailureKind = (s: IncidentSignals): string | undefined => {
  if (s.endReason !== "error" || s.failures.length > 0) return undefined;
  if ((s.summaryTopErrorKinds?.auth ?? 0) > 0 || s.turnFinalized?.errorKind === "auth") return "auth";
  if (s.turnFinalized?.outcome !== "failure") return undefined;
  return s.turnFinalized.errorKind ?? "unclassified";
};

/** A terminal authentication failure is upstream of any incidental zero-hit recall. */
export const executionAuthFailureVerdict = (s: IncidentSignals): RecallVerdict | null => {
  if (terminalFailureKind(s) !== "auth") return null;
  const authFailures = Math.max(
    s.summaryTopErrorKinds?.auth ?? 0,
    s.turnFinalized?.errorKind === "auth" ? 1 : 0,
  );
  return {
    code: "execution_auth_failure",
    detail:
      `the execution ended with ${authFailures} authentication failure(s) before a usable `
      + "model response or tool result was produced",
    suggestedNextSteps: [
      "verify the configured provider profile has a valid credential in the selected Comis data root",
      "confirm the configured provider and model match that credential, then retry the request",
      "use comis secrets list to verify credential metadata without displaying secret values",
    ],
  };
};

/** A terminal model-provider dependency failure is upstream of an incidental zero-hit recall. */
export const executionDependencyFailureVerdict = (s: IncidentSignals): RecallVerdict | null => {
  if (terminalFailureKind(s) !== "dependency") return null;
  return {
    code: "execution_dependency_failure",
    detail:
      "the execution ended with a model-provider dependency failure before a usable "
      + "model response or tool result was produced",
    suggestedNextSteps: [
      "run comis system-health --since 1 and inspect the provider degradation and circuit-breaker signals",
      "verify agents.<id>.model and the selected providers.entries.<name> endpoint and credential metadata",
      "retry after the provider recovers or its configured circuit-breaker cooldown expires",
    ],
  };
};

/**
 * Every REMAINING terminal execution failure kind. Ranked below the specific
 * terminal causes (drive/orchestrate) so specific-over-generic holds, and above the
 * tool-failure catch-all — which requires failures anyway, so the two never compete.
 */
export const executionTerminalFailureVerdict = (s: IncidentSignals): RecallVerdict | null => {
  const kind = terminalFailureKind(s);
  if (kind === undefined || kind === "auth" || kind === "dependency") return null;
  const reason = s.turnFinalized?.reason;
  const reasonClause = reason !== undefined && reason.length > 0 ? ` (${reason})` : "";
  return {
    code: "execution_terminal_failure",
    detail:
      `the turn finalized as a terminal ${kind} failure${reasonClause} — the execution died `
      + "with no tool failure to attribute it to",
    suggestedNextSteps: [
      `obs.explain depth=full for the terminal execution records behind the ${kind} failure`,
      "run comis system-health --since 1 to see whether the same errorKind recurs across sessions",
    ],
  };
};

/** `recall_miss` — fires only on an all-missed, degraded, no-tool-failure session. */
export const recallMissVerdict = (s: IncidentSignals): RecallVerdict | null => {
  if (s.recall === undefined) return null;
  if (s.recall.recalls === 0 || s.recall.zeroHits < s.recall.recalls) return null;
  if (s.failures.length > 0) return null;
  if (s.degraded !== true) return null;
  // A terminal failure pill is the cause; the zero-hit recall beside it is incidental.
  if (s.turnFinalized?.outcome === "failure") return null;
  return {
    code: "recall_miss",
    detail:
      `recall miss — all ${s.recall.recalls} recall query(ies) returned zero injected ` +
      `memories (terminal lanes=${s.recall.lastLanes}, reranker ` +
      `${s.recall.rerankerAvailable ? "available" : "absent"}); the turn ran with no memory ` +
      "context and no tool/context/breaker cause matched",
    suggestedNextSteps: [
      "verify the recall SCOPE (agent- vs user-scoped) matches where the memory was written",
      "for non-Latin queries confirm the trigram-twin lanes fired (comis system-health → health_signal); for weak semantic recall check comis system-health config_posture for the embedder",
      "obs.explain depth=full for the per-recall lane/candidate counts",
    ],
  };
};
