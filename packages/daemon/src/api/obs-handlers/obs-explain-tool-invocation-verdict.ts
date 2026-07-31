// SPDX-License-Identifier: Apache-2.0
import type { IncidentSignals } from "@comis/core";

interface RootCause {
  code: string;
  detail: string;
  suggestedNextSteps: string[];
}

/** Explain a terminal turn that matched a capability but never completed a
 * tool invocation. This acute execution outcome outranks incidental recall
 * misses from the same turn. */
export function toolInvocationStallVerdict(
  signals: IncidentSignals,
): RootCause | null {
  if (signals.endReason !== "tool_invocation_stall") return null;
  const tools = signals.requestRelevantToolNames?.join(", ") ?? "none recorded";
  const recoveryAttempts =
    signals.recoveries?.byReason.request_tool_nudge ?? 0;
  return {
    code: "tool_invocation_stall",
    detail:
      `the request matched tools [${tools}], but no current-turn invocation completed; `
      + `request_tool_nudge recovery attempts=${String(recoveryAttempts)}`,
    suggestedNextSteps: [
      "inspect requestRelevantToolNames and execution.recovery_attempted in this report",
      "verify the selected active tools cover every target named in the request",
      "replay after correcting capability selection; a same-turn recall miss is secondary evidence",
    ],
  };
}
