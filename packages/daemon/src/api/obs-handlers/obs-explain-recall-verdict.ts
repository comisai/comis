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
 * terminal-failure predicates below derive ONE `terminalFailureKind` from the SAME
 * evidence the suppression keys on (a degraded, no-tool-failure session whose activity
 * surface finalized as a failure, or the generic `error` end reason), `auth` and
 * `dependency` get their own named codes and levers, EVERY other kind still names the
 * terminal failure generically, and `recallMissVerdict` itself refuses to fire on a
 * failed finalize. Patching only the kinds seen so far left `internal` (session_reset /
 * narration_stall), `validation` (input_too_large) and the rejection-classifier
 * fallbacks still root-caused as "the turn ran with no memory context"; keying the gate
 * on the literal `error` end reason left the NAMED causes that carry the same failed
 * finalize (`provider_degraded`, `narration_stall`, …) suppressed AND unnamed. The
 * return type is structurally identical to the registry's `RootCause` (no cross-module
 * type import ⇒ no cycle).
 *
 * @module
 */

import type { IncidentSignals } from "@comis/core";

/** Structural twin of `obs-explain-heuristics.RootCause` (kept local — no import cycle). */
type RecallVerdict = { code: string; detail: string; suggestedNextSteps: string[] };

/**
 * End states that can never BE a terminal execution failure, so the predicates below
 * must not claim them: an authoritative successful outcome, and a foreground turn whose
 * terminal outcome belongs to promoted background work (named by its own verdict, which
 * out-ranks these). Every other non-clean end reason is in scope — `error` is only the
 * GENERIC one, and the named causes (`provider_degraded`, `narration_stall`,
 * `session_reset` → `error`, …) carry the identical failed-finalize evidence.
 */
const NON_TERMINAL_FAILURE_END_REASONS: ReadonlySet<string> = new Set([
  "success",
  "background_pending",
]);

/**
 * Whether the session died in the execution lifecycle with NO tool failure to attribute
 * its death to. Keyed on the same failed-finalize evidence `recallMissVerdict` defers
 * to, so no end reason can be silenced there without one of the verdicts below naming
 * it; the generic `error` end reason also qualifies on its own, since a hard abort can
 * skip the activity finalize entirely.
 */
const endedInTerminalExecutionFailure = (s: IncidentSignals): boolean => {
  if (s.failures.length > 0 || s.degraded === false) return false;
  const endReason = s.endReason;
  if (endReason !== undefined && NON_TERMINAL_FAILURE_END_REASONS.has(endReason)) return false;
  return endReason === "error" || s.turnFinalized?.outcome === "failure";
};

/**
 * The terminal execution ErrorKind of a session that produced NO tool failure to
 * attribute its death to, or `undefined` when the session carries no such evidence.
 * The TERMINAL finalize's kind wins whenever it recorded one: `summaryTopErrorKinds` is
 * a session-WIDE running tally, so an `auth` entry from an earlier, since-repaired turn
 * must never mask the kind the session actually died of. The tally is consulted only as
 * the fallback for a terminal surface that finalized without a kind (or never finalized
 * at all). A failed finalize with no recorded kind anywhere still counts — the failure
 * is real evidence even when unclassified.
 */
const terminalFailureKind = (s: IncidentSignals): string | undefined => {
  if (!endedInTerminalExecutionFailure(s)) return undefined;
  const finalizedKind =
    s.turnFinalized?.outcome === "failure" ? s.turnFinalized.errorKind : undefined;
  if (finalizedKind !== undefined) return finalizedKind;
  if ((s.summaryTopErrorKinds?.auth ?? 0) > 0 || s.turnFinalized?.errorKind === "auth") return "auth";
  return "unclassified";
};

/** A terminal authentication failure is upstream of any incidental zero-hit recall. */
export const executionAuthFailureVerdict = (s: IncidentSignals): RecallVerdict | null => {
  if (terminalFailureKind(s) !== "auth") return null;
  const authFailures = Math.max(
    s.summaryTopErrorKinds?.auth ?? 0,
    s.turnFinalized?.errorKind === "auth" ? 1 : 0,
  );
  const agentConfigRoot = s.agentId === undefined ? "agents.<id>" : `agents.${s.agentId}`;
  const selection = s.modelSelection;
  const selectionDetail = selection === undefined
    ? ""
    : ` (${agentConfigRoot}.provider=${JSON.stringify(selection.provider)}, `
      + `${agentConfigRoot}.model=${JSON.stringify(selection.modelId)})`;
  const credentialStep = selection === undefined
    ? "verify the configured provider profile has a valid credential in the selected Comis data root"
    : `verify a valid credential for provider ${JSON.stringify(selection.provider)} exists in the selected Comis data root`;
  const selectionStep = selection === undefined
    ? "confirm the configured provider and model match that credential, then retry the request"
    : `confirm ${agentConfigRoot}.provider=${JSON.stringify(selection.provider)} and `
      + `${agentConfigRoot}.model=${JSON.stringify(selection.modelId)} select the intended credential, then retry the request`;
  return {
    code: "execution_auth_failure",
    detail:
      `the execution ended with ${authFailures} authentication failure(s) before a usable `
      + `model response or tool result was produced${selectionDetail}`,
    suggestedNextSteps: [
      credentialStep,
      selectionStep,
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

/** A detector-owned no-progress abort is acute and outranks incidental recall evidence. */
export const executionNoProgressLoopVerdict = (s: IncidentSignals): RecallVerdict | null => {
  if (s.endReason !== "loop_detected" && s.abortReason !== "loop_detected") return null;
  const evidence = s.loopEvidence;
  const detail = evidence === undefined
    ? "the execution stopped after its no-progress loop governor fired; bounded detector evidence was unavailable"
    : `${evidence.repeatedToolName ?? "a tool"} produced ${evidence.consecutiveNoProgress} consecutive no-progress steps `
      + `(${evidence.duplicateCallCount} duplicate calls, ${evidence.stagnantResultCount} stagnant results; `
      + `threshold=${evidence.threshold})`;
  return {
    code: "execution_no_progress_loop",
    detail,
    suggestedNextSteps: [
      "review the bounded loop evidence in this verdict before retrying",
      "advance the cursor, change the tool input, or choose a different capability after an unchanged result",
      "do not increase the step limit until the repeated call can make observable progress",
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
  // A death that never reached the activity surface leaves no pill to quote, so say
  // that instead of claiming a finalize that never happened — the absent finalize is
  // itself the lead: the turn died before or inside its own delivery path.
  const finalized = s.turnFinalized?.outcome === "failure";
  const detail = finalized
    ? `the turn finalized as a terminal ${kind} failure${reasonClause} — the execution died `
      + "with no tool failure to attribute it to"
    : `the turn ended with ${s.endReason ?? "a terminal failure"} and never finalized an activity `
      + "surface — the execution died with no tool failure to attribute it to";
  return {
    code: "execution_terminal_failure",
    detail,
    suggestedNextSteps: finalized
      ? [
          `obs.explain depth=full for the terminal execution records behind the ${kind} failure`,
          "run comis system-health --since 1 to see whether the same errorKind recurs across sessions",
        ]
      : [
          "inspect the response-locale repair and delivery-queue transition for this traceId — "
            + "a turn that never finalized usually died in its own delivery path",
          "obs.explain depth=full for the terminal execution records",
          "run comis system-health --since 1 to see whether the same end reason recurs across sessions",
        ],
  };
};

/** `recall_miss` — fires only on an all-missed, degraded, no-tool-failure session. */
export const recallMissVerdict = (s: IncidentSignals): RecallVerdict | null => {
  if (s.recall === undefined) return null;
  if (s.recall.recalls === 0 || s.recall.zeroHits < s.recall.recalls) return null;
  if (s.failures.length > 0) return null;
  if (s.degraded !== true) return null;
  // A session that died in the execution lifecycle is the cause; the zero-hit recall
  // beside it is incidental. Defer to the SAME predicate the terminal verdicts key on,
  // so no death can be claimed here and named there — or, as the live incident showed,
  // claimed here and named nowhere. A death that reaches the finalize surface and one
  // that never gets there are the same death.
  if (endedInTerminalExecutionFailure(s)) return null;
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
