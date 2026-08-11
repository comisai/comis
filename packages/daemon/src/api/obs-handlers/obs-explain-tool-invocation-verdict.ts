// SPDX-License-Identifier: Apache-2.0
import type { IncidentSignals } from "@comis/core";

interface RootCause {
  code: string;
  detail: string;
  suggestedNextSteps: string[];
}

/** Explain a terminal turn whose required tool-backed action or workflow
 * evidence remained incomplete. This acute execution outcome outranks
 * incidental recall misses from the same turn. */
export function toolInvocationStallVerdict(
  signals: IncidentSignals,
): RootCause | null {
  if (signals.endReason !== "tool_invocation_stall") return null;
  const tools = signals.requestRelevantToolNames?.join(", ") ?? "none recorded";
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
      `the request matched tools [${tools}] and ${invocationDisposition}; `
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
