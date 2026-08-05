// SPDX-License-Identifier: Apache-2.0
/** Pure incident verdict for completion claims rejected by failed-tool evidence. */

import type { IncidentReport } from "@comis/core";

const COMPLETION_EVIDENCE_GUARD_ACTION =
  "response.completion_evidence_guard";

/** Name the response correction while preserving failed-tool details in the report. */
export function completionEvidenceGuardVerdict(
  rows: ReadonlyArray<Record<string, unknown>>,
  traceId: string,
): IncidentReport["likelyRootCause"] {
  if (
    traceId.length === 0
    || !rows.some(
      (row) =>
        row.traceId === traceId
        && row.action === COMPLETION_EVIDENCE_GUARD_ACTION
        && row.outcome === "denied",
    )
  ) {
    return null;
  }

  return {
    code: "unverified_completion_claim",
    detail:
      "the response honesty guard replaced a completion claim because one or more "
      + "tool steps still had an unrecovered failure",
    suggestedNextSteps: [
      "inspect the failed tool records in this report and correct the failing step",
      "retry verification before treating the requested result as complete",
    ],
  };
}
