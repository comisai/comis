// SPDX-License-Identifier: Apache-2.0
/** Pure incident verdict for completion claims rejected by failed-tool evidence. */

import type { IncidentReport } from "@comis/core";

const COMPLETION_EVIDENCE_GUARD_ACTION =
  "response.completion_evidence_guard";
const OUTBOUND_COMPLETION_EVIDENCE_GUARD_ACTION =
  "response.outbound_completion_evidence_guard";
const OUTBOUND_AUDIO_EVIDENCE_GUARD_ACTION =
  "response.outbound_audio_evidence_guard";
const OUTBOUND_IMAGE_EVIDENCE_GUARD_ACTION =
  "response.outbound_image_evidence_guard";
const OUTBOUND_DELIVERY_STATUS_EVIDENCE_GUARD_ACTION =
  "response.outbound_delivery_status_evidence_guard";

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

/** Name a completion claim rejected before its outbound delivery side effect. */
export function outboundCompletionEvidenceGuardVerdict(
  rows: ReadonlyArray<Record<string, unknown>>,
  traceId: string,
): IncidentReport["likelyRootCause"] {
  if (
    traceId.length === 0
    || !rows.some(
      (row) =>
        row.traceId === traceId
        && row.action === OUTBOUND_COMPLETION_EVIDENCE_GUARD_ACTION
        && row.outcome === "denied",
    )
  ) {
    return null;
  }

  return {
    code: "outbound_completion_evidence_missing",
    detail:
      "the pre-send response honesty guard blocked a completion claim because the "
      + "current mutation request had no successful matching mutation receipt",
    suggestedNextSteps: [
      "inspect the blocked message tool record and request-matched mutation tools",
      "complete and verify the mutation before retrying user-visible delivery",
    ],
  };
}

/** Name an audio-delivery claim rejected without synthesis or relay proof. */
export function outboundAudioEvidenceGuardVerdict(
  rows: ReadonlyArray<Record<string, unknown>>,
  traceId: string,
): IncidentReport["likelyRootCause"] {
  if (
    traceId.length === 0
    || !rows.some(
      (row) =>
        row.traceId === traceId
        && row.action === OUTBOUND_AUDIO_EVIDENCE_GUARD_ACTION
        && row.outcome === "denied",
    )
  ) {
    return null;
  }
  return {
    code: "outbound_audio_evidence_missing",
    detail:
      "the response honesty guard replaced an audio-delivery claim because this "
      + "execution had no successful current-turn synthesis or trusted completion receipt",
    suggestedNextSteps: [
      "inspect tts_synthesize admission and tool results for this turn",
      "if work was delegated, verify the background completion relay delivered the audio",
      "retry only after the outbound audio capability can produce a delivery receipt",
    ],
  };
}

/** Name an image-creation claim rejected without generation or relay proof. */
export function outboundImageEvidenceGuardVerdict(
  rows: ReadonlyArray<Record<string, unknown>>,
  traceId: string,
): IncidentReport["likelyRootCause"] {
  if (
    traceId.length === 0
    || !rows.some(
      (row) =>
        row.traceId === traceId
        && row.action === OUTBOUND_IMAGE_EVIDENCE_GUARD_ACTION
        && row.outcome === "denied",
    )
  ) {
    return null;
  }
  return {
    code: "outbound_image_evidence_missing",
    detail:
      "the response honesty guard replaced an image-creation claim because this "
      + "execution had no successful current-turn generation or trusted completion receipt",
    suggestedNextSteps: [
      "inspect image_generate admission and tool results for this turn",
      "if work was delegated, verify the background completion relay delivered the image",
      "retry only after the image-generation capability can produce a delivery receipt",
    ],
  };
}

/** Name an affirmative elliptical status answer rejected without current proof. */
export function outboundDeliveryStatusEvidenceGuardVerdict(
  rows: ReadonlyArray<Record<string, unknown>>,
  traceId: string,
): IncidentReport["likelyRootCause"] {
  if (
    traceId.length === 0
    || !rows.some(
      (row) =>
        row.traceId === traceId
        && row.action === OUTBOUND_DELIVERY_STATUS_EVIDENCE_GUARD_ACTION
        && row.outcome === "denied",
    )
  ) return null;
  return {
    code: "outbound_delivery_status_evidence_missing",
    detail:
      "the response honesty guard replaced an affirmative delivery-status answer because "
      + "the elliptical follow-up had no current delivery or observability receipt",
    suggestedNextSteps: [
      "inspect current obs_query and self-delivering media tool results for this turn",
      "resolve which prior outbound item the follow-up refers to before confirming delivery",
      "retry status verification instead of relying on historical assistant prose",
    ],
  };
}
