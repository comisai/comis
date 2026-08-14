// SPDX-License-Identifier: Apache-2.0
import type { IncidentSignals } from "@comis/core";

interface RootCause {
  code: string;
  detail: string;
  suggestedNextSteps: string[];
}

/** Diagnose an explicit displayed-to-activated deferred-tool mismatch. */
export function discoveredToolNotActivatedVerdict(
  signals: IncidentSignals,
): RootCause | null {
  if (signals.endReason !== "success") return null;
  const activation = signals.discoveryActivation;
  if (activation === undefined || activation.displayedCount <= activation.activatedCount) {
    return null;
  }
  return {
    code: "discovered_tool_not_activated",
    detail:
      `deferred tool activation mismatch: displayed=${String(activation.displayedCount)}, `
      + `activated=${String(activation.activatedCount)}, replaced=${String(activation.replacedCount)}, `
      + `skipped=${String(activation.skippedCount)}, failed=${String(activation.failedCount)}`,
    suggestedNextSteps: [
      "inspect the discovery activation record beside the discover_tools result",
      "verify displayed deferred tools replace placeholders in the live callable set",
      "obs.explain depth=full",
    ],
  };
}

/** Diagnose a user-visible recovery handoff that discarded grounded evidence. */
export function groundedResponseReplacementVerdict(
  signals: IncidentSignals,
): RootCause | null {
  if (signals.endReason !== "success") return null;
  const groundedBefore =
    signals.recoveries?.groundedResponseBeforeRecoveryCount ?? 0;
  const groundedPreserved =
    signals.recoveries?.groundedResponsePreservedCount ?? 0;
  if (groundedBefore <= groundedPreserved) return null;
  const outsideRoute = signals.recoveries?.successfulReceiptsOutsideRoute ?? 0;
  return {
    code: "recovery_replaced_grounded_response",
    detail:
      `${String(groundedBefore - groundedPreserved)} grounded response(s) backed by `
      + `${String(outsideRoute)} successful receipt(s) outside the selected workflow route `
      + "were replaced by request-tool recovery",
    suggestedNextSteps: [
      "inspect request-relevant tool routing and the request_tool_nudge handoff",
      "confirm the terminal response preserves the receipt-grounded pre-recovery answer",
      "obs.explain depth=full",
    ],
  };
}

/** Explain a terminal turn whose required tool-backed action or workflow
 * evidence remained incomplete. This acute execution outcome outranks
 * incidental recall misses from the same turn. */
export function toolInvocationStallVerdict(
  signals: IncidentSignals,
): RootCause | null {
  if (signals.endReason !== "tool_invocation_stall") return null;
  const tools = signals.requestRelevantToolNames?.join(", ") ?? "none recorded";
  const promptSkills =
    signals.requestRelevantPromptSkillNames?.join(", ") ?? "none recorded";
  const recoveryAttempts =
    signals.recoveries?.byReason.request_tool_nudge ?? 0;
  const completedTools = Object.entries(signals.toolStats)
    .filter(([, stats]) => stats.ok > 0)
    .map(([toolName, stats]) => `${toolName}=${String(stats.ok)}`)
    .join(", ");
  const invocationDisposition = completedTools.length === 0
    ? "no current-turn invocation completed"
    : `completed current-turn invocations [${completedTools}], but a later workflow requirement remained incomplete`;
  return {
    code: "tool_invocation_stall",
    detail:
      `the request matched tools [${tools}], selected prompt skills [${promptSkills}], `
      + `and ${invocationDisposition}; `
      + `request_tool_nudge recovery attempts=${String(recoveryAttempts)}`,
    suggestedNextSteps: completedTools.length === 0
      ? [
          "inspect requestRelevantToolNames and execution.recovery_attempted in this report",
          "verify the selected active tools cover every target named in the request",
          "replay after correcting capability selection; a same-turn recall miss is secondary evidence",
        ]
      : [
          "compare requestRelevantToolNames with toolStats and execution.recovery_attempted in this report",
          "inspect prompt-skill routing and the remaining workflow requirement before retrying",
          "preserve completed tool evidence while correcting the unmatched requirement",
        ],
  };
}
