// SPDX-License-Identifier: Apache-2.0
import type { ManagedRunReportIndex } from "./managed-run-content.js";
import type { ManagedRunStatus, ManagedRunStatusReason } from "./managed-run.js";

export type ManagedRunEvidenceHealth =
  | "available"
  | "conflicting"
  | "malformed"
  | "stale"
  | "unavailable";

export interface ManagedRunReductionInput {
  readonly currentStatus: ManagedRunStatus;
  readonly currentStatusReason: ManagedRunStatusReason;
  readonly openAttentionCount: number;
  readonly reports: readonly ManagedRunReportIndex[];
  readonly throughReportSequence: number;
  readonly lastHeartbeatAtMs?: number;
  readonly heartbeatMaxAgeMs: number;
  readonly heartbeatRequired: boolean;
  readonly evidenceHealth: ManagedRunEvidenceHealth;
  readonly verifiedOutcome: "none" | "succeeded" | "failed";
  readonly deliveryState: "not_required" | "verified" | "missing" | "unavailable";
  readonly nowMs: number;
}

export interface ManagedRunReduction {
  readonly status: ManagedRunStatus;
  readonly statusReason: ManagedRunStatusReason;
  readonly terminalOutcomeKind?: "succeeded" | "failed" | "cancelled";
  readonly actionable: boolean;
}

function reduced(
  input: ManagedRunReductionInput,
  status: ManagedRunStatus,
  statusReason: ManagedRunStatusReason,
  terminalOutcomeKind?: ManagedRunReduction["terminalOutcomeKind"],
): ManagedRunReduction {
  return {
    status,
    statusReason,
    ...(terminalOutcomeKind === undefined ? {} : { terminalOutcomeKind }),
    actionable: input.reports.length > 0 || terminalOutcomeKind !== undefined,
  };
}

function reportsAreContinuous(input: ManagedRunReductionInput): boolean {
  if (input.reports.length === 0) return input.throughReportSequence === 0;
  const first = input.reports[0];
  const last = input.reports[input.reports.length - 1];
  if (first === undefined || last === undefined || last.sequence !== input.throughReportSequence) return false;
  return input.reports.every((report, index) => {
    if (report.managedRunId !== first.managedRunId || report.serviceInstanceId !== first.serviceInstanceId) return false;
    return index === 0 || report.sequence === (input.reports[index - 1]?.sequence ?? 0) + 1;
  });
}

function evidenceFailureReason(input: ManagedRunReductionInput): ManagedRunStatusReason | undefined {
  if (!Number.isInteger(input.nowMs) || input.nowMs < 0) return "required_evidence_invalid";
  if (!Number.isInteger(input.heartbeatMaxAgeMs) || input.heartbeatMaxAgeMs < 0) {
    return "required_evidence_invalid";
  }
  if (!reportsAreContinuous(input)) return "required_evidence_invalid";

  switch (input.evidenceHealth) {
    case "available":
      break;
    case "conflicting":
    case "malformed":
      return "required_evidence_invalid";
    case "stale":
      return "required_evidence_stale";
    case "unavailable":
      return "service_state_unavailable";
    default: {
      const _exhaustive: never = input.evidenceHealth;
      return _exhaustive;
    }
  }

  if (!input.heartbeatRequired) return undefined;
  if (input.lastHeartbeatAtMs === undefined) return "service_state_unavailable";
  if (!Number.isInteger(input.lastHeartbeatAtMs) || input.lastHeartbeatAtMs > input.nowMs) {
    return "required_evidence_invalid";
  }
  return input.nowMs - input.lastHeartbeatAtMs > input.heartbeatMaxAgeMs
    ? "required_evidence_stale"
    : undefined;
}

/** Fold authenticated report indexes and host evidence into one deterministic state. */
export function reduceManagedRunState(input: ManagedRunReductionInput): ManagedRunReduction {
  if (input.currentStatus === "cancelled") {
    return reduced(input, "cancelled", input.currentStatusReason, "cancelled");
  }
  if (input.verifiedOutcome === "failed") {
    return reduced(input, "failed", "failure_verified", "failed");
  }

  const evidenceFailure = evidenceFailureReason(input);
  if (evidenceFailure !== undefined) return reduced(input, "unknown", evidenceFailure);

  if (input.openAttentionCount > 0) return reduced(input, "waiting", "attention_pending");

  const latest = input.reports[input.reports.length - 1];
  if (latest?.kind === "paused") return reduced(input, "paused", "service_paused");
  if (latest?.kind === "progress" || latest?.kind === "resolution") {
    return reduced(input, "active", "report_activity");
  }
  if (latest?.kind === "candidate_complete" && input.verifiedOutcome === "none") {
    return reduced(input, "candidate_complete", "verification_pending");
  }
  if (
    input.verifiedOutcome === "succeeded"
    && (input.deliveryState === "not_required" || input.deliveryState === "verified")
  ) {
    return reduced(input, "succeeded", "outcome_verified", "succeeded");
  }
  return reduced(input, "unknown", "service_state_unavailable");
}
