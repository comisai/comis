// SPDX-License-Identifier: Apache-2.0
import type { ManagedRunReportKind } from "../domain/managed-run-content.js";
import type { ManagedRunStatus } from "../domain/managed-run.js";

/** Content-free managed-run binding transitions. */
export interface ManagedRunEvents {
  "managed_run:prepared": {
    managedRunId: string;
    serviceInstanceId: string;
    agentId: string;
    timestamp: number;
  };
  "managed_run:activated": {
    managedRunId: string;
    serviceInstanceId: string;
    agentId: string;
    durationMs: number;
    timestamp: number;
  };
  "managed_run:activation_rejected": {
    managedRunId?: string;
    serviceInstanceId: string;
    agentId: string;
    reasonCode: "activation_rejected" | "agent_not_allowed" | "attachment_not_allowed" | "invalid_preparation" | "preparation_expired" | "replay_conflict" | "service_unavailable" | "workspace_not_allowed";
    timestamp: number;
  };
  "managed_run:activation_unknown": {
    managedRunId: string;
    serviceInstanceId: string;
    agentId: string;
    reasonCode: "activation_outcome_unknown" | "recovery_join_missing" | "service_state_unavailable";
    timestamp: number;
  };
  "managed_run:report_accepted": {
    managedRunId: string;
    serviceInstanceId: string;
    sequence: number;
    kind: ManagedRunReportKind;
    durationMs: number;
    timestamp: number;
  };
  "managed_run:report_rejected": {
    managedRunId?: string;
    serviceInstanceId?: string;
    reasonCode: "invalid_report" | "managed_run_not_found" | "observed_time_out_of_bounds" | "replay_conflict" | "state_mismatch" | "storage_failure";
    timestamp: number;
  };
  "managed_run:continuation_completed": {
    managedRunId: string;
    serviceInstanceId: string;
    throughReportSequence: number;
    status: ManagedRunStatus;
    pendingAfterCurrent: boolean;
    durationMs: number;
    timestamp: number;
  };
  "managed_run:attention_response_bound": {
    managedRunId: string;
    attentionId: string;
    agentId: string;
    durationMs: number;
    timestamp: number;
  };
  "managed_run:recovery_quarantined": {
    managedRunId: string;
    serviceInstanceId: string;
    reason: "record_validation_failed";
    timestamp: number;
  };
  "managed_run:recovery_failed": {
    managedRunId: string;
    serviceInstanceId: string;
    reasonCode: "reconciliation_failed";
    timestamp: number;
  };
  "managed_run:recovery_completed": {
    activatedCount: number;
    cancelledCount: number;
    unknownCount: number;
    invalidCount: number;
    failedCount: number;
    durationMs: number;
    timestamp: number;
  };
}
