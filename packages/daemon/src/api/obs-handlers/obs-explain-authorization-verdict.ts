// SPDX-License-Identifier: Apache-2.0
/** Deterministic verdict for a tool boundary's terminal authorization denial. */

import type { IncidentSignals } from "@comis/core";

export function toolAuthorizationDeniedVerdict(
  signals: IncidentSignals,
) {
  const failure = signals.failures.find(
    (candidate) =>
      candidate.failureCode === "permission_denied"
      && candidate.errorKind === "auth",
  );
  if (failure === undefined) return null;

  return {
    code: "tool_authorization_denied",
    detail:
      `${failure.toolName} rejected the current caller's authorization; `
      + "the requested operation did not run and no mutation was applied",
    suggestedNextSteps: [
      "inspect the full failure for the required trust or approval boundary",
      "use an authorized sender or obtain the required approval before trying again; repeating from the same authority cannot change policy",
      "obs.explain depth=full",
    ],
  };
}
